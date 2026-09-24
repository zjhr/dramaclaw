"""镜头配方（ShotRecipe）端点 — Phase 1 后端切片 + 渲染切片。

一条配方 = 一份 append-only JSONL（见 ``novelvideo.freezone.shot_recipe_store``）：
建配方 → 绑定镜头级角色造型决策（只引用 CharacterIdentity）→ 追加版本
（parent_version_id / prompt_delta / model_snapshot / cost_ledger）→ 读回完整溯源。

渲染切片把 ``ready`` 版本接到真实 freezone 视频生成：canvas/node 只取自版本的
``source_refs``，任务固定 ``freezone_video_gen`` / ``freezone`` / ``video`` / episode 0，
版本行由 store 的既有 append 路径写回（父行逐字节不变）。

计费只**记录**既有链路的结果（``get_credit_quote()`` + model_credits 的
freezone 视频计费参数），不新增积分 / 扣费 / 余额 / 账本机制。
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from novelvideo.api.auth import get_api_user
from novelvideo.api.deps import ProjectResolution, resolve_project_scope
from novelvideo.freezone import shot_recipe_store as store

logger = logging.getLogger("novelvideo.api.shot_recipes")

router = APIRouter()

PRODUCT_SURFACE = "freezone"
VIDEO_FEATURE_KEY = "freezone.video_generate"
RENDER_TASK_TYPE = "freezone_video_gen"
RENDER_QUEUE_KIND = "video"


class ShotRecipeCreateRequest(BaseModel):
    title: str = Field(default="", max_length=200)
    recipe_id: str | None = Field(default=None, max_length=64)
    canvas_id: str | None = Field(default=None, max_length=128)
    node_id: str | None = Field(default=None, max_length=128)


class CharacterLookDecisionRequest(BaseModel):
    identity_id: str = Field(..., min_length=1, max_length=256)
    character_name: str = Field(default="", max_length=128)
    version_id: str | None = Field(default=None, max_length=64)
    overrides: dict[str, Any] = Field(default_factory=dict)
    source_refs: dict[str, Any] = Field(default_factory=dict)


class ShotRecipeVersionRequest(BaseModel):
    parent_version_id: str | None = Field(default=None, max_length=64)
    prompt: str = Field(default="")
    changes: dict[str, Any] = Field(default_factory=dict)
    status: str = Field(default="draft")
    model_id: str = Field(default="", max_length=256)
    video_backend: str = Field(default="", max_length=256)
    duration_seconds: float | None = None
    resolution: str | None = Field(default=None, max_length=64)
    look_decision_ids: list[str] = Field(default_factory=list)
    source_refs: dict[str, Any] = Field(default_factory=dict)


class ShotRecipeRenderRequest(BaseModel):
    """One render attempt. Only the prompt-side knobs; canvas/node come from source_refs."""

    model_id: str = Field(..., min_length=1, max_length=256)
    video_backend: str = Field(default="", max_length=256)
    prompt: str = Field(default="")
    aspect_ratio: str = Field(default="16:9", max_length=32)
    duration_seconds: float | None = None
    resolution: str | None = Field(default=None, max_length=64)
    generate_audio: bool = False
    human_review: bool = False
    scene_optimize: str = Field(default="", max_length=64)


def _state_dir(resolved: ProjectResolution) -> Path:
    return Path(resolved.state_dir)


async def _lookup_identity(
    project: str, user: dict, identity_id: str
) -> tuple[Any | None, bool]:
    """按 ``identity_id`` 在真实角色库里解析身份。

    返回 ``(identity, available)``：``available=False`` 表示角色库读取本身不可用
    （连接/初始化失败），此时调用方必须显式降级成 ``identity_known=false``，不能
    假装解析成功；``available=True`` 而 identity 为 None 则是「身份确实不存在」。
    读取路径复用 characters 路由的 store scope 与 ``_identity_by_id``，出块即关连接。
    """
    clean = str(identity_id or "").strip()
    if not clean:
        return None, True
    try:
        from novelvideo.api.routes.characters import (
            _character_project_scope,
            _identity_by_id,
        )

        async with _character_project_scope(
            project,
            user,
            required_role="editor",
            load_graph_state=False,
        ) as (_ctx, _username, _project_name, _dir, _out, character_store):
            characters = await character_store.list_characters()
    except HTTPException:
        # 权限 / 项目解析失败是真错误，不该被降级成 identity_known=false 掩盖
        raise
    except Exception:  # noqa: BLE001 - 读取不可用是一种显式降级，不是解析成功
        logger.debug("shot recipe: character library unavailable", exc_info=True)
        return None, False
    for character in characters:
        identity = _identity_by_id(character, clean)
        if identity is not None:
            return identity, True
    return None, True


async def _resolve_capabilities(
    model_id: str, *, requester_user_id: str
) -> dict[str, Any] | None:
    """Catalog entry for ``model_id``, or None when it cannot be read.

    None is a real answer: the version then freezes
    ``capabilities_known=false`` instead of pretending the model supports
    anything. The lookup reuses the freezone catalog path (scoped by the
    authenticated user in EE, CE-local catalog otherwise).
    """
    clean_model = str(model_id or "").strip()
    if not clean_model:
        return None
    try:
        from novelvideo.api.routes.freezone import (
            _find_catalog_entry,
            _scoped_media_model_catalog,
        )

        catalog = await _scoped_media_model_catalog(
            "video",
            requester_user_id=requester_user_id,
        )
    except Exception:  # noqa: BLE001 - unknown capability is a valid answer
        logger.debug("shot recipe: media model catalog unavailable", exc_info=True)
        return None
    return _find_catalog_entry(catalog, clean_model)


async def _cost_ledger(
    *,
    model_id: str,
    video_backend: str,
    duration_seconds: float | None,
    requester_user_id: str,
) -> dict[str, Any]:
    """Quote one video generation through the existing billing path.

    The quote is recorded, never charged: real charging stays with the task
    backend. When the quote is unavailable the ledger says ``quoted=false``
    rather than showing a fabricated cost.
    """
    from novelvideo.api.routes.model_credits import freezone_video_generate_task_billing
    from novelvideo.freezone.video_node import resolve_freezone_video_backend
    from novelvideo.ports import get_credit_quote

    backend = str(video_backend or "").strip()
    if not backend:
        try:
            backend = resolve_freezone_video_backend(model_id or None)
        except ValueError:
            backend = ""
    quantity = max(int(round(float(duration_seconds or 0))), 1)
    if not backend:
        return store.build_cost_ledger(
            quantity=quantity,
            reason="video backend unavailable",
        )
    billing = freezone_video_generate_task_billing(
        {
            "video_backend": backend,
            "pricing_quantity": quantity,
        }
    )
    pricing_kind = str(billing.get("pricing_kind") or "")
    pricing_model = str(billing.get("pricing_model") or "")
    pricing_params = dict(billing.get("pricing_params") or {})
    try:
        quote = await get_credit_quote().generation_credit_quote(
            kind=pricing_kind or "video",
            model=pricing_model,
            params=billing,
            quantity=quantity,
            product_surface=PRODUCT_SURFACE,
            user_id=requester_user_id,
        )
    except Exception as exc:  # noqa: BLE001 - a quote failure must not fake a cost
        logger.debug("shot recipe: credit quote unavailable", exc_info=True)
        return store.build_cost_ledger(
            pricing_kind=pricing_kind,
            pricing_model=pricing_model,
            pricing_params=pricing_params,
            quantity=quantity,
            reason=f"credit quote unavailable: {exc.__class__.__name__}",
        )
    return store.build_cost_ledger(
        quote=quote,
        pricing_kind=pricing_kind,
        pricing_model=pricing_model,
        pricing_params=pricing_params,
        quantity=quantity,
    )


def _render_version(recipe: dict[str, Any], version_id: str) -> dict[str, Any] | None:
    clean = str(version_id or "").strip()
    return next(
        (
            version
            for version in recipe["versions"]
            if str(version.get("version_id") or "") == clean
        ),
        None,
    )


def _validate_render_knobs(
    capabilities: dict[str, Any],
    body: ShotRecipeRenderRequest,
    *,
    default_duration: float | None = None,
) -> int:
    """Guard duration/resolution against the catalog entry resolved for the render.

    This endpoint submits a real generation task, unlike the version-append
    endpoint — so an out-of-range value is a 400 that names the boundary, never a
    silent clamp. The bounds come from the entry resolved for ``body.model_id``
    (the version's frozen snapshot is provenance, not the live capability).
    """
    min_duration = capabilities.get("minDuration")
    max_duration = capabilities.get("maxDuration")
    options = [str(item) for item in (capabilities.get("resolutionOptions") or [])]
    requested_resolution = str(body.resolution or "").strip()

    if body.duration_seconds is None:
        # 没给时长就沿用版本上冻结的时长（追加版本时写入的），没有才退回 5s
        requested = default_duration if default_duration is not None else 5
    else:
        requested = body.duration_seconds
    try:
        raw_duration = float(requested)
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, "duration_seconds must be a number") from exc
    if raw_duration <= 0:
        raise HTTPException(400, "duration_seconds must be > 0")
    duration = max(int(raw_duration), 1)
    if type(min_duration) is int and duration < min_duration:
        raise HTTPException(
            400, f"duration_seconds below minimum: {duration} < {min_duration}"
        )
    if type(max_duration) is int and duration > max_duration:
        raise HTTPException(
            400, f"duration_seconds above maximum: {duration} > {max_duration}"
        )
    if requested_resolution and options and requested_resolution.lower() not in [
        item.lower() for item in options
    ]:
        raise HTTPException(
            400,
            "resolution not supported: "
            f"{requested_resolution} (allowed: {', '.join(options)})",
        )
    return duration


@router.get("/projects/{project}/shot-recipes")
async def list_shot_recipes(project: str, user: dict = Depends(get_api_user)):
    """列出项目的镜头配方。"""
    resolved = await resolve_project_scope(project, user, required_role="viewer")
    return {
        "ok": True,
        "data": store.list_shot_recipes(_state_dir(resolved)),
    }


@router.post("/projects/{project}/shot-recipes")
async def create_shot_recipe(
    project: str,
    body: ShotRecipeCreateRequest,
    user: dict = Depends(get_api_user),
):
    """创建镜头配方。"""
    resolved = await resolve_project_scope(project, user, required_role="editor")
    project_dir = _state_dir(resolved)
    recipe_id = (body.recipe_id or "").strip() or store.new_recipe_id()
    try:
        if store.read_recipe(project_dir, recipe_id) is not None:
            raise HTTPException(409, f"shot recipe already exists: {recipe_id}")
        record = store.build_recipe_record(
            recipe_id=recipe_id,
            title=body.title,
            canvas_id=body.canvas_id,
            node_id=body.node_id,
        )
        store.append_recipe_record(project_dir=project_dir, record=record)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, "data": record}


@router.get("/projects/{project}/shot-recipes/{recipe_id}")
async def get_shot_recipe(
    project: str,
    recipe_id: str,
    user: dict = Depends(get_api_user),
):
    """读回一条配方：配方头 + 造型决策 + 全部版本（含各自溯源链）。"""
    resolved = await resolve_project_scope(project, user, required_role="viewer")
    try:
        recipe = store.read_recipe(_state_dir(resolved), recipe_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if recipe is None:
        raise HTTPException(404, f"shot recipe not found: {recipe_id}")
    versions = recipe["versions"]
    for version in versions:
        version["lineage"] = store.version_lineage(versions, version["version_id"])
    return {"ok": True, "data": recipe}


@router.post("/projects/{project}/shot-recipes/{recipe_id}/look-decisions")
async def bind_character_look_decision(
    project: str,
    recipe_id: str,
    body: CharacterLookDecisionRequest,
    user: dict = Depends(get_api_user),
):
    """绑定镜头级角色造型决策。

    只引用真实角色库里的 ``identity_id``（解析不到即 404，禁止静默接受任意字符串），
    并把身份基线冻结成 ``identity_snapshot`` 与 overrides 形成显式 diff；角色库读取
    不可用时显式降级为 ``identity_known=false``，角色库数据本身从不复制进配方。
    """
    resolved = await resolve_project_scope(project, user, required_role="editor")
    project_dir = _state_dir(resolved)
    try:
        if store.read_recipe(project_dir, recipe_id) is None:
            raise HTTPException(404, f"shot recipe not found: {recipe_id}")
        identity, library_available = await _lookup_identity(
            project, user, body.identity_id
        )
        if library_available and identity is None:
            raise HTTPException(
                404, f"character identity not found: {body.identity_id}"
            )
        record = store.build_look_decision_record(
            decision_id=store.new_look_decision_id(),
            identity_id=body.identity_id,
            character_name=body.character_name
            or str(getattr(identity, "character_name", "") or ""),
            overrides=body.overrides,
            identity_snapshot=store.build_identity_snapshot(
                identity=identity,
                identity_id=body.identity_id,
                reason="character library unavailable",
            ),
            version_id=body.version_id,
            source_refs=body.source_refs,
        )
        store.append_look_decision_record(
            project_dir=project_dir, recipe_id=recipe_id, record=record
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, "data": record}


@router.post("/projects/{project}/shot-recipes/{recipe_id}/versions")
async def append_shot_recipe_version(
    project: str,
    recipe_id: str,
    body: ShotRecipeVersionRequest,
    user: dict = Depends(get_api_user),
):
    """追加一个版本（失败版本也只会追加新行，父版本行永不重写）。"""
    resolved = await resolve_project_scope(project, user, required_role="editor")
    project_dir = _state_dir(resolved)
    try:
        recipe = store.read_recipe(project_dir, recipe_id)
        if recipe is None:
            raise HTTPException(404, f"shot recipe not found: {recipe_id}")
        parent_version_id = (body.parent_version_id or "").strip() or None
        if parent_version_id and not any(
            version.get("version_id") == parent_version_id
            for version in recipe["versions"]
        ):
            raise HTTPException(400, f"unknown parent_version_id: {parent_version_id}")

        capabilities = await _resolve_capabilities(
            body.model_id,
            requester_user_id=str(resolved.ctx.requester_user_id or ""),
        )
        record = store.build_version_record(
            version_id=store.next_version_id(
                project_dir=project_dir, recipe_id=recipe_id
            ),
            parent_version_id=parent_version_id,
            prompt_delta=store.build_prompt_delta(
                prompt=body.prompt,
                changes=body.changes,
                has_parent=parent_version_id is not None,
            ),
            model_snapshot=store.build_model_snapshot(
                model_id=body.model_id,
                catalog_id=str((capabilities or {}).get("catalogId") or "") or None,
                capabilities=capabilities,
            ),
            cost_ledger=await _cost_ledger(
                model_id=body.model_id,
                video_backend=body.video_backend,
                duration_seconds=body.duration_seconds,
                requester_user_id=str(resolved.ctx.requester_user_id or ""),
            ),
            status=body.status,
            source_refs=body.source_refs,
            look_decision_ids=body.look_decision_ids,
            duration_seconds=body.duration_seconds,
            resolution=body.resolution,
            model_id=body.model_id,
        )
        store.append_version_record(
            project_dir=project_dir, recipe_id=recipe_id, record=record
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, "data": record}


@router.delete("/projects/{project}/shot-recipes/{recipe_id}/versions/{version_id}")
async def delete_shot_recipe_version(
    project: str,
    recipe_id: str,
    version_id: str,
    user: dict = Depends(get_api_user),
):
    """追加式墓碑隐藏一个版本（历史行保留，保证溯源可审计）。"""
    resolved = await resolve_project_scope(project, user, required_role="editor")
    try:
        deleted = store.delete_version(
            project_dir=_state_dir(resolved),
            recipe_id=recipe_id,
            version_id=version_id,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not deleted:
        raise HTTPException(404, f"version not found: {version_id}")
    return {"ok": True, "data": {"version_id": version_id, "deleted": True}}


@router.post("/projects/{project}/shot-recipes/{recipe_id}/versions/{version_id}/render")
async def render_shot_recipe_version(
    project: str,
    recipe_id: str,
    version_id: str,
    body: ShotRecipeRenderRequest,
    user: dict = Depends(get_api_user),
):
    """把 ``ready`` 版本接到真实 freezone 视频生成。

    本端点只**构造 payload** 并调用既有任务后端：canvas/node 一律取自版本自己的
    ``source_refs``（不读画布 node data），版本行与配方头仍由 store 单一 schema owner
    构造。计费沿用既有 ``freezone_video_generate_task_billing`` + ``get_credit_quote()``
    ——只是记录，不新增任何积分/扣费机制。

    幂等口径：版本已带 ``source_refs.job_id`` 即 409（附既有 job_id）。任务层
    ``reserve_task_for_project`` 的去重只在 submitting/queued/running 生效，任务终态后
    同 job_id 仍可再入队——所以这里只承诺「版本级一次性提交」，不宣称永久幂等。
    """
    resolved = await resolve_project_scope(project, user, required_role="editor")
    project_dir = _state_dir(resolved)
    try:
        recipe = store.read_recipe(project_dir, recipe_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if recipe is None:
        raise HTTPException(404, f"shot recipe not found: {recipe_id}")
    version = _render_version(recipe, version_id)
    if version is None:
        raise HTTPException(404, f"version not found: {version_id}")
    # 幂等检查先于 ready 检查：渲染过的版本状态已是 rendering，若先报「不是 ready」
    # 就把既有 job_id 这条信息盖掉了。两者都是 409，失败路径不动任何一行。
    existing_job_id = str((version.get("source_refs") or {}).get("job_id") or "")
    if existing_job_id:
        raise HTTPException(
            409,
            f"version {version_id} already has a render job: {existing_job_id}",
        )
    if str(version.get("status") or "") != "ready":
        raise HTTPException(
            409,
            f"version {version_id} is not ready to render: "
            f"status={version.get('status')!r}",
        )

    requester_user_id = str(resolved.ctx.requester_user_id or "")
    # 能力必须按 body.model_id 现查目录：取不到就显式拒绝，不按「已支持」放行。
    capabilities = await _resolve_capabilities(
        body.model_id, requester_user_id=requester_user_id
    )
    if capabilities is None:
        raise HTTPException(
            409,
            "capabilities_known=false: media model catalog has no entry for "
            f"model_id={body.model_id!r}, refusing to render",
        )
    duration_seconds = _validate_render_knobs(
        capabilities, body, default_duration=version.get("duration_seconds")
    )

    from novelvideo.freezone.video_node import (
        resolve_freezone_video_backend,
        normalize_video_aspect_ratio,
        normalize_video_resolution_for_backend,
    )

    backend = str(body.video_backend or "").strip()
    if not backend:
        try:
            backend = resolve_freezone_video_backend(body.model_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    source_refs = dict(version.get("source_refs") or {})
    canvas_id = str(source_refs.get("canvas_id") or "")
    node_id = str(source_refs.get("node_id") or "")
    prompt = str(body.prompt or "").strip() or str(
        (version.get("prompt_delta") or {}).get("prompt") or ""
    )
    if not prompt:
        raise HTTPException(400, "prompt is required")
    resolution = normalize_video_resolution_for_backend(
        backend,
        body.resolution or version.get("resolution") or None,
        capabilities.get("resolutionOptions") or None,
    )

    from novelvideo.api.routes.model_credits import freezone_video_generate_task_billing

    billing = freezone_video_generate_task_billing(
        {
            "video_backend": backend,
            "resolution": resolution,
            "pricing_quantity": duration_seconds,
            "operation": "textToVideo",
            "generate_audio": bool(body.generate_audio),
            "video_input_present": False,
            "input_video_duration_seconds": 0.0,
            "catalog_id": str(capabilities.get("catalogId") or ""),
        }
    )
    # 报价沿用既有 get_credit_quote()（经 _cost_ledger）：报价不可用时只记
    # quoted=false + reason，不伪造成本、不预扣。真正的扣费仍由任务后端负责。
    cost_ledger = await _cost_ledger(
        model_id=body.model_id,
        video_backend=backend,
        duration_seconds=duration_seconds,
        requester_user_id=requester_user_id,
    )

    # 函数内导入（与 _cost_ledger 同一写法）：调用时才在 novelvideo.ports 上取属性，
    # 测试因此能把假后端塞进来（tests/test_api_shot_recipes.py::_use_fake_task_backend）。
    from novelvideo.ports import get_task_backend

    job_id = store.new_shot_job_id()
    payload = {
        "job_id": job_id,
        "recipe_id": recipe_id,
        "version_id": version_id,
        "canvas_id": canvas_id,
        "node_id": node_id,
        "model_id": body.model_id,
        "catalog_id": str(capabilities.get("catalogId") or ""),
        "gen_mode": "text_to_video",
        "requested_gen_mode": "text_to_video",
        "prompt": prompt,
        "reference_items": [],
        "aspect_ratio": normalize_video_aspect_ratio(body.aspect_ratio),
        "resolution": resolution,
        "duration_seconds": duration_seconds,
        "generate_audio": bool(body.generate_audio),
        "human_review": bool(body.human_review),
        "scene_optimize": body.scene_optimize,
        "backend": backend,
        "source_refs": source_refs,
        "billing": billing,
    }
    try:
        queued = await get_task_backend().enqueue_project_task(
            resolved.ctx,
            product_surface=PRODUCT_SURFACE,
            task_type=RENDER_TASK_TYPE,
            queue_kind=RENDER_QUEUE_KIND,
            episode=0,
            scope=job_id,
            payload=payload,
        )
    except RuntimeError as exc:
        raise HTTPException(503, f"failed to start render task: {exc}") from exc

    record = store.build_version_record(
        version_id=version_id,
        parent_version_id=version.get("parent_version_id") or version_id,
        prompt_delta=store.build_prompt_delta(
            prompt=prompt,
            changes={"render": {"job_id": job_id, "status": "rendering"}},
            has_parent=True,
        ),
        model_snapshot=store.build_model_snapshot(
            model_id=body.model_id,
            catalog_id=str(capabilities.get("catalogId") or "") or None,
            capabilities=capabilities,
        ),
        cost_ledger=cost_ledger,
        status="rendering",
        source_refs={**source_refs, "job_id": job_id},
        look_decision_ids=version.get("look_decision_ids") or [],
        duration_seconds=duration_seconds,
        resolution=resolution,
        model_id=body.model_id,
    )
    store.append_version_record(
        project_dir=project_dir, recipe_id=recipe_id, record=record
    )
    return {
        "ok": True,
        "data": {
            "recipe_id": recipe_id,
            "version_id": version_id,
            "job_id": job_id,
            "task_id": queued.task_state.task_id,
            "task_type": RENDER_TASK_TYPE,
            "backend": queued.backend,
            "queue": queued.queue,
            "status": record["status"],
            "parent_version_id": record["parent_version_id"],
            "cost_ledger": record["cost_ledger"],
            "source_refs": record["source_refs"],
        },
    }
