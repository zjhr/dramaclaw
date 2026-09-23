"""镜头配方（ShotRecipe）端点 — Phase 1 后端切片。

一条配方 = 一份 append-only JSONL（见 ``novelvideo.freezone.shot_recipe_store``）：
建配方 → 绑定镜头级角色造型决策（只引用 CharacterIdentity）→ 追加版本
（parent_version_id / prompt_delta / model_snapshot / cost_ledger）→ 读回完整溯源。

计费只**记录**既有链路的结果（``get_credit_quote()`` + model_credits 的
freezone 视频计费参数），不新增积分 / 扣费 / 余额 / 账本机制；本切片也不提交
任何生成任务。
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

    The quote is recorded, never charged — this slice submits no task. When the
    quote is unavailable the ledger says ``quoted=false`` rather than showing a
    fabricated cost.
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
