"""镜头配方（ShotRecipe）端点 — Phase 1 后端切片 + 渲染切片 + 预检切片 + 质量报告切片。

一条配方 = 一份 append-only JSONL（见 ``novelvideo.freezone.shot_recipe_store``）：
建配方 → 绑定镜头级角色造型决策（只引用 CharacterIdentity）→ 追加版本
（parent_version_id / prompt_delta / model_snapshot / cost_ledger）→ 读回完整溯源。

渲染切片把 ``ready`` 版本接到真实 freezone 视频生成：canvas/node 只取自版本的
``source_refs``，任务固定 ``freezone_video_gen`` / ``freezone`` / ``video`` / episode 0，
版本行由 store 的既有 append 路径写回（父行逐字节不变）。

预检切片在**入队之前**回答「这条配方能不能渲染」：四类结构化 check（模型能力 /
角色造型决策 / 参考素材 / 计费可报价）由 :func:`_run_preflight` 一次算清，report 的
schema 由 store 单一持有（``build_preflight_report``）。``POST .../preflight`` 是纯只读
的；render 端点复用同一份检查，只有 block 项才 409，warn 只进报告。读不到的事实
（目录查不到、身份读不到、素材解析不到、报价拿不到）一律报 warn，绝不报 pass。

质量报告切片回答另一个问题——「这条版本哪里可疑」：``GET .../quality`` 从 store 既有
事实算出**结构化 risks 列表**（造型连续性 / 谱系 / 模型一致性 / 渲染事实 / 计费），
schema 同样由 store 单一持有（``build_quality_report``），**没有总分/评分**。它也是纯
只读的，报告即时算出、不落盘。

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
from novelvideo.freezone.video_node import (
    normalize_video_aspect_ratio,
    normalize_video_resolution_for_backend,
)
from novelvideo.media_model_request_schema import normalize_media_model_mode

logger = logging.getLogger("novelvideo.api.shot_recipes")

router = APIRouter()

PRODUCT_SURFACE = "freezone"
VIDEO_FEATURE_KEY = "freezone.video_generate"
RENDER_TASK_TYPE = "freezone_video_gen"
RENDER_QUEUE_KIND = "video"

# 片段重拍走既有 freezone 任务类型（与 freezone.py:10147 同一个串），队列也同一条。
RESHOOT_TASK_TYPE = "freezone_video_reshoot"
RESHOOT_QUEUE_KIND = "video"
# 重拍是「首尾帧锚定重生成」这一条路径，模型必须声明该模式（同 freezone.py:10110 口径）。
RESHOOT_GEN_MODE = "firstLastFrame"

# 版本终态（store.VERSION_STATUSES 的子集）——渲染回写只会写这三个之一。
TERMINAL_VERSON_STATUSES = frozenset({"completed", "failed", "cancelled"})
# 终态强弱：同一终态重复回写不再追加行，晚到的成功覆盖 cancelled / failed。
TERMINAL_VERSION_RANK: dict[str, int] = store.TERMINAL_VERSION_RANK

# 「画布上没有可消费的上游参考」时的模式：文生视频。参考素材（画布上游节点）会把它
# 换成下面两种之一，payload 与预检的模式检查都由同一份结论决定，不再是硬编码常量。
RENDER_GEN_MODE = "text_to_video"
# 只有图片参考 / 含视频或音频参考时的模式（目录 supportedModes 用的就是这套词汇）。
IMAGE_REFERENCE_GEN_MODE = "image_to_video"
ALL_REFERENCE_GEN_MODE = "all_reference"
# 执行侧模式 → 画布请求侧模式名：freezone 端点的 ``requested_gen_mode`` 与 billing 的
# ``operation`` 都记后者，供计费/审计按用户看到的那套词汇对账。
RENDER_MODE_REQUEST_NAMES = {
    RENDER_GEN_MODE: "textToVideo",
    IMAGE_REFERENCE_GEN_MODE: "imageToVideo",
    ALL_REFERENCE_GEN_MODE: "allReference",
}

# 参考条目的 role：这是画布上游素材（不是角色库/首尾帧），渲染时能一眼看出它从哪来。
REFERENCE_ROLE = "画布参考"
# 一个上游节点只出一条主素材的优先级：视频 > 音频 > 图片。顺序照画布自己
# （VideoNode 的上游分类先判 videoUrl、再 audio、最后 image）。
REFERENCE_KIND_ORDER = ("video", "audio", "image")

# render 端点的画幅缺省值（预检复用同一缺省，避免两处口径打架）。
DEFAULT_ASPECT_RATIO = "16:9"

# 画布节点 data 里可能出现素材地址的键（与画布真实 schema 一致）→ 参考类型。只在这些
# 键上做可解析性检查与参考收集：列全 URL 字段会把「没有素材」误报成「素材丢了」。
# 键名与顺序是既有清单，值是参考类型——参考条目要区分 image|video|audio
# （ShotReference 的形状），光看 URL 分不出来。
NODE_ASSET_URL_TYPES: dict[str, str] = {
    "videoUrl": "video",
    "imageUrl": "image",
    "sourceVideoUrl": "video",
    "previewImageUrl": "image",
    "audioUrl": "audio",
    "greyboxSourceUrl": "video",
    "reshootSourceUrl": "video",
}
NODE_ASSET_URL_KEYS = tuple(NODE_ASSET_URL_TYPES)

# 「调用方还没解析目录」的哨兵：``None`` 是真实答案（目录查不到），不能拿它当缺省。
_CAPABILITIES_UNRESOLVED = object()


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


class ShotRecipePreflightRequest(BaseModel):
    """预检的候选渲染参数。

    全部可选：预检是**只读**的，用户还没决定要不要渲染、用哪个模型，也必须能拿到
    每一类检查的结论。缺省值按 render 端点同一套判定（时长回退版本冻结值再退 5s，
    画幅回退 16:9），所以预检结论与真正入队时看到的一致。
    """

    model_id: str = Field(default="", max_length=256)
    video_backend: str = Field(default="", max_length=256)
    aspect_ratio: str = Field(default=DEFAULT_ASPECT_RATIO, max_length=32)
    duration_seconds: float | None = None
    resolution: str | None = Field(default=None, max_length=64)


class ShotRecipeReshootRequest(BaseModel):
    """一次片段重拍：在源版本的成片里换掉一个秒区间。

    ``source_url`` 缺省时用源版本 ``source_refs.artifact_url``（重拍的对象就是那条
    版本自己的成片）。``model_id`` 必须是声明了 ``firstLastFrame`` 的模型——重拍只有
    这一条生成路径，端点会在入队前拒绝其余模型。
    """

    model_id: str = Field(..., min_length=1, max_length=256)
    video_backend: str = Field(default="", max_length=256)
    start_seconds: float = Field(default=0.0, ge=0.0, le=86400.0)
    end_seconds: float = Field(..., gt=0.0, le=86400.0)
    source_url: str = Field(default="", max_length=2048)
    prompt: str = Field(default="", max_length=2000)
    resolution: str = Field(default="", max_length=64)
    generate_audio: bool = False
    camera_template_id: str | None = Field(default=None, max_length=128)


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


def task_status_of(task: Any) -> str:
    """Effective task status, mirroring the task API's own reporting.

    ``progress>=1`` with a "done" message is reported as ``completed`` by
    ``api/routes/tasks.py::_effective_task_status``; a version that disagreed
    with the task center about the same task would be a bug.  The helper is
    imported lazily because that module pulls in the task router.
    """
    try:
        from novelvideo.api.routes.tasks import _effective_task_status

        return str(_effective_task_status(task) or "")
    except Exception:  # noqa: BLE001 - 状态读取失败按原样处理，不在这里编造终态
        logger.debug("shot recipe sync: effective task status unavailable", exc_info=True)
        return str(getattr(task, "status", "") or "")


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


# --------------------------------------------------------------------------
# Preflight — 「这条配方能不能渲染」的结构化结论（只读，不入队）
# --------------------------------------------------------------------------


def _preflight_model_id(body: ShotRecipePreflightRequest, version: dict[str, Any]) -> str:
    """预检要判的模型：显式给了就用它，没给就回退到版本上冻结的那个。

    预检存在的意义正是「还不能渲染时告诉用户为什么」，所以缺 model_id 不该直接
    报错——但那一路照样会得到 capabilities_known=false 的 warn，而不是假 pass。
    """
    explicit = str(body.model_id or "").strip()
    if explicit:
        return explicit
    snapshot = version.get("model_snapshot") or {}
    return str(snapshot.get("model_id") or version.get("model_id") or "").strip()


def _requested_duration_seconds(body: Any, version: dict[str, Any]) -> Any:
    """请求时长，缺省口径与 render 端点逐字一致（版本冻结值 → 5s）。"""
    if body.duration_seconds is not None:
        return body.duration_seconds
    frozen = version.get("duration_seconds")
    return frozen if frozen is not None else 5


def _check_model_capabilities(
    capabilities: dict[str, Any] | None,
    body: Any,
    *,
    version: dict[str, Any],
    model_id: str,
    gen_mode: str = RENDER_GEN_MODE,
) -> dict[str, Any]:
    """模型能力：模式 / duration / aspect_ratio / resolution 是否落在目录条目内。

    判据与 render 端点 ``_validate_render_knobs`` 同源（同一份 capabilities、同一条
    解析路径）。duration/resolution 越界在 render 上仍是更具体的 400（先跑），这里
    负责 render 没查的 mode 与 aspect_ratio——两者都会在入队之前让用户看到。
    ``gen_mode`` 是这次渲染真正会用的模式（有参考素材时不是 text_to_video），render
    端点把它算好的结论传进来，两侧对「模型必须声明哪个 mode」只有一份判断。
    """
    check_id = store.PREFLIGHT_CHECK_MODEL_CAPABILITIES
    if capabilities is None:
        return store.build_preflight_check(
            check_id=check_id,
            status="warn",
            detail=(
                f"capabilities_known=false: media model catalog has no entry for "
                f"model_id={model_id!r}"
                if model_id
                else "capabilities_known=false: no model_id to resolve"
            ),
        )

    problems: list[str] = []
    notes: list[str] = []

    mode = normalize_media_model_mode(gen_mode)
    modes = [str(item) for item in (capabilities.get("supportedModes") or [])]
    if not modes:
        notes.append("supportedModes not declared by the catalog for this model")
    elif mode not in modes:
        problems.append(f"this model does not support {mode} mode")

    try:
        raw_duration = float(_requested_duration_seconds(body, version))
    except (TypeError, ValueError):
        raw_duration = 0.0
        problems.append("duration_seconds must be a number")
    duration = max(int(raw_duration), 1)
    if raw_duration <= 0:
        problems.append("duration_seconds must be > 0")
    min_duration = capabilities.get("minDuration")
    max_duration = capabilities.get("maxDuration")
    if type(min_duration) is int and duration < min_duration:
        problems.append(f"duration_seconds below minimum: {duration} < {min_duration}")
    if type(max_duration) is int and duration > max_duration:
        problems.append(f"duration_seconds above maximum: {duration} > {max_duration}")

    ratios = [str(item) for item in (capabilities.get("ratioOptions") or [])]
    requested_ratio = normalize_video_aspect_ratio(getattr(body, "aspect_ratio", ""))
    if ratios:
        if requested_ratio.lower() not in [item.lower() for item in ratios]:
            problems.append(
                "aspect_ratio not supported: "
                f"{requested_ratio} (allowed: {', '.join(ratios)})"
            )
    else:
        notes.append("ratioOptions not declared by the catalog for this model")

    options = [str(item) for item in (capabilities.get("resolutionOptions") or [])]
    requested_resolution = str(body.resolution or "").strip()
    if (
        requested_resolution
        and options
        and requested_resolution.lower() not in [item.lower() for item in options]
    ):
        problems.append(
            "resolution not supported: "
            f"{requested_resolution} (allowed: {', '.join(options)})"
        )

    if problems:
        return store.build_preflight_check(
            check_id=check_id, status="block", detail="; ".join(problems)
        )
    declared = [
        f"mode={mode}",
        f"duration={duration}s",
        f"aspect_ratio={requested_ratio}",
    ]
    if min_duration is not None or max_duration is not None:
        declared.append(f"bounds={min_duration}-{max_duration}s")
    if options:
        declared.append(f"resolutions={','.join(options)}")
    if notes:
        return store.build_preflight_check(
            check_id=check_id, status="warn", detail="; ".join(notes)
        )
    return store.build_preflight_check(
        check_id=check_id, status="pass", detail="; ".join(declared)
    )


def _check_look_decisions(
    recipe: dict[str, Any], version: dict[str, Any]
) -> dict[str, Any]:
    """角色造型决策：版本绑定的每条决策是否还在、身份基线是否可用。

    读不到（角色库不可用 / 决策行被墓碑隐藏）一律 warn，沿用 ``identityUnknown``
    口径——绝不报 pass（那会把「读不到」渲染成「通过」）。
    """
    check_id = store.PREFLIGHT_CHECK_LOOK_DECISIONS
    ids = [str(item) for item in (version.get("look_decision_ids") or [])]
    if not ids:
        return store.build_preflight_check(
            check_id=check_id, status="pass", detail="no look decision bound to this version"
        )
    by_id = {
        str(decision.get("decision_id") or ""): decision
        for decision in recipe.get("look_decisions") or []
    }
    missing = [item for item in ids if item not in by_id]
    if missing:
        return store.build_preflight_check(
            check_id=check_id,
            status="block",
            detail="look decision not found in this recipe: " + ", ".join(missing),
        )
    unknown = [
        item for item in ids if by_id[item].get("identity_known") is not True
    ]
    if unknown:
        return store.build_preflight_check(
            check_id=check_id,
            status="warn",
            detail=(
                "identity library unavailable — baseline empty for: "
                + ", ".join(unknown)
            ),
        )
    return store.build_preflight_check(
        check_id=check_id,
        status="pass",
        detail=f"{len(ids)} look decision(s) with identity baseline available",
    )


def _asset_unresolved_reason(
    project_dir: Path, project_id: str, url: str
) -> str:
    """素材地址在当前项目里解析不到时的原因（空字符串 = 解析成功）。"""
    from novelvideo.freezone.asset_copy import parse_project_asset_url
    from novelvideo.freezone.paths import resolve_static_url_to_path

    parsed = parse_project_asset_url(url)
    if parsed is not None:
        owner, rel = parsed
        if project_id and owner != project_id:
            return f"asset belongs to another project: {owner}"
        candidate = project_dir / rel
    else:
        try:
            candidate = resolve_static_url_to_path(url, project_dir)
        except ValueError as exc:
            # 同源之外 / 越界的地址：本来就不该当成当前项目的素材
            return f"unresolvable asset url: {exc}"
    try:
        if candidate.is_file():
            return ""
    except OSError as exc:
        return f"cannot stat asset: {exc.__class__.__name__}"
    return "asset not found in this project"


def _node_asset_urls(node: dict[str, Any]) -> list[str]:
    """节点 data 上的素材地址（画布真实 schema 的键，顺序与检查口径不变）。"""
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    urls: list[str] = []
    media = data.get("media")
    if isinstance(media, list):
        for item in media:
            if isinstance(item, dict):
                url = str(item.get("url") or "").strip()
                if url:
                    urls.append(url)
    for key in NODE_ASSET_URL_KEYS:
        url = str(data.get(key) or "").strip()
        if url:
            urls.append(url)
    return urls


def _node_primary_reference(node: dict[str, Any]) -> tuple[str, str] | None:
    """节点的主参考素材 ``(type, url)``，没有就 None。

    一个节点只出一条（视频 > 音频 > 图片）：一个视频节点身上常常同时挂着预览海报，
    两者都收会把同一段内容的缩略图当成第二条参考喂给模型。
    """
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    by_kind: dict[str, str] = {}
    for key, kind in NODE_ASSET_URL_TYPES.items():
        url = str(data.get(key) or "").strip()
        if url and kind not in by_kind:
            by_kind[kind] = url
    for kind in REFERENCE_KIND_ORDER:
        if kind in by_kind:
            return kind, by_kind[kind]
    return None


def _canvas_reference_candidates(
    payload: dict[str, Any], node_id: str
) -> list[tuple[str, str, str]]:
    """绑定节点的**一跳**上游素材候选 ``(type, url, source_node_id)``。

    只走一跳，与画布自己的上游引用口径一致（VideoNode 的参考列表 / 画布内容遍历器：
    「我连了谁，就吃谁的输出」）；多跳会把用户没打算当参考的远端素材也拉进来。顺序按
    edge 在画布里的顺序，同一节点 / 同一 URL 只留第一条。
    """
    nodes = {
        str(node.get("id") or ""): node
        for node in (payload.get("nodes") or [])
        if isinstance(node, dict)
    }
    out: list[tuple[str, str, str]] = []
    seen_nodes: set[str] = set()
    seen_urls: set[str] = set()
    for edge in payload.get("edges") or []:
        if not isinstance(edge, dict):
            continue
        if str(edge.get("target") or "") != node_id:
            continue
        source_id = str(edge.get("source") or "")
        source = nodes.get(source_id)
        if source is None or not source_id or source_id in seen_nodes:
            continue
        found = _node_primary_reference(source)
        if found is None:
            continue
        kind, url = found
        if url in seen_urls:
            continue
        seen_nodes.add(source_id)
        seen_urls.add(url)
        out.append((kind, url, source_id))
    return out


def _resolve_reference_items(
    project_dir: Path, candidates: list[tuple[str, str, str]]
) -> tuple[list[dict[str, str]], list[str], list[str]]:
    """候选 → ``(reference_items, reference_node_ids, problems)``。

    URL → 项目内路径复用 freezone 既有的 ``_resolve_url_list``，再用既有
    ``ensure_existing_paths`` 确认文件真在项目里。解析不出来的候选**不进 items**，
    只进 problems：渲染侧据此 400，预检侧据此 warn，两边都不许假装素材还在。
    """
    from novelvideo.api.routes.freezone import _resolve_url_list
    from novelvideo.freezone.route_helpers import ensure_existing_paths

    items: list[dict[str, str]] = []
    node_ids: list[str] = []
    problems: list[str] = []
    for kind, url, node_id in candidates:
        try:
            paths = _resolve_url_list(project_dir, [url])
            ensure_existing_paths(paths, field_name="reference asset")
        except HTTPException as exc:
            problems.append(f"{url}: {exc.detail}")
            continue
        if not paths:
            problems.append(f"{url}: resolved to no path")
            continue
        items.append({"type": kind, "path": paths[0], "role": REFERENCE_ROLE})
        node_ids.append(node_id)
    return items, node_ids, problems


def _collect_render_references(
    project_dir: Path, version: dict[str, Any], *, capabilities: dict[str, Any] | None
) -> dict[str, Any]:
    """这条版本渲染时会吃到的画布参考素材（只读）。

    结论形状 ``{canvas_id, node_id, items, node_ids, counts, mode, problems}``：

    - ``items`` 是交给任务后端的参考条目（``type``/``path``/``role``，与 ShotReference
      一致），``node_ids`` 是这些素材来自哪些上游节点（写回 ``reference_node_ids``）；
    - ``mode`` 由**候选素材的类型**决定：无参考 text_to_video / 只有图片 image_to_video /
      含视频或音频 all_reference。与参考能否解析无关——解析不出来的进 problems，渲染侧
      因此拒绝，绝不静默退回 text_to_video；
    - ``problems`` 是解析失败与超目录上限的原因（渲染侧 400、预检侧 warn 共用一份）。

    画布没绑、读不到、或有节点没素材都不在这里报错：那是「这次渲染没有参考」，不是
    「参考丢了」。
    """
    refs = dict(version.get("source_refs") or {})
    canvas_id = str(refs.get("canvas_id") or "").strip()
    node_id = str(refs.get("node_id") or "").strip()
    result: dict[str, Any] = {
        "canvas_id": canvas_id,
        "node_id": node_id,
        "items": [],
        "node_ids": [],
        "counts": {},
        "mode": RENDER_GEN_MODE,
        "problems": [],
    }
    if not canvas_id or not node_id:
        return result
    from novelvideo.freezone import canvas_store
    from novelvideo.freezone.paths import CANVAS_ID_RE

    if not CANVAS_ID_RE.match(canvas_id):
        return result
    try:
        payload = canvas_store.read_canvas(project_dir, canvas_id)
    except Exception:  # noqa: BLE001 - 画布读不到 = 这次没有参考，不是「素材没问题」
        logger.debug("shot recipe: canvas unreadable for references", exc_info=True)
        return result
    if not isinstance(payload, dict):
        return result
    if not any(
        isinstance(node, dict) and str(node.get("id") or "") == node_id
        for node in (payload.get("nodes") or [])
    ):
        return result

    candidates = _canvas_reference_candidates(payload, node_id)
    kinds = {kind for kind, _url, _node in candidates}
    if kinds:
        result["mode"] = (
            IMAGE_REFERENCE_GEN_MODE if kinds == {"image"} else ALL_REFERENCE_GEN_MODE
        )
    items, node_ids, problems = _resolve_reference_items(project_dir, candidates)
    counts = {
        kind: sum(1 for item in items if item["type"] == kind)
        for kind in REFERENCE_KIND_ORDER
    }
    result["items"] = items
    result["node_ids"] = node_ids
    result["counts"] = {kind: count for kind, count in counts.items() if count}

    # 条数上限：目录声明的优先，没声明就用 freezone 全能参考的同一套缺省。
    from novelvideo.api.routes.freezone import _catalog_reference_limits

    limits = _catalog_reference_limits(
        capabilities,
        image_default=9,
        video_default=3,
        audio_default=3,
        file_default=0,
        link_default=0,
    )
    problems.extend(
        f"too many {kind} references: {count} > {limits[kind]}"
        for kind, count in counts.items()
        if count > limits[kind]
    )
    result["problems"] = problems
    return result


def _check_source_refs(
    project_dir: Path,
    version: dict[str, Any],
    *,
    project_id: str,
    references: dict[str, Any],
) -> dict[str, Any]:
    """参考素材：``source_refs`` 指向的画布节点、节点上的素材，以及**这次渲染真正会吃到的
    上游参考**是否可解析。

    解析路径复用既有画布读取（``canvas_store.read_canvas``）与素材解析
    （``parse_project_asset_url`` / ``resolve_static_url_to_path``）；上游参考来自
    ``_collect_render_references``（与 render 端点同一份实现，两侧口径不可能打架）。
    任何读不到、解析不出、超上限都是 warn：渲染侧会因此 400，但预检自己绝不阻止调用方
    ——用户有权在知道原因后继续。唯一不能做的是把「读不到」报成 pass。
    """
    check_id = store.PREFLIGHT_CHECK_SOURCE_REFS
    refs = dict(version.get("source_refs") or {})
    canvas_id = str(refs.get("canvas_id") or "").strip()
    node_id = str(refs.get("node_id") or "").strip()
    if not canvas_id:
        return store.build_preflight_check(
            check_id=check_id,
            status="warn",
            detail="source_refs has no canvas_id — reference assets cannot be verified",
        )
    from novelvideo.freezone import canvas_store
    from novelvideo.freezone.paths import CANVAS_ID_RE

    if not CANVAS_ID_RE.match(canvas_id):
        return store.build_preflight_check(
            check_id=check_id,
            status="warn",
            detail=f"source_refs.canvas_id is not a valid canvas id: {canvas_id!r}",
        )
    try:
        payload = canvas_store.read_canvas(project_dir, canvas_id)
    except Exception as exc:  # noqa: BLE001 - 画布读不到是 warn，不是「素材没问题」
        logger.debug("shot recipe preflight: canvas unreadable", exc_info=True)
        return store.build_preflight_check(
            check_id=check_id,
            status="warn",
            detail=f"canvas {canvas_id!r} could not be read: {exc.__class__.__name__}",
        )
    if not isinstance(payload, dict):
        return store.build_preflight_check(
            check_id=check_id,
            status="warn",
            detail=f"canvas {canvas_id!r} not found in this project",
        )
    if not node_id:
        return store.build_preflight_check(
            check_id=check_id,
            status="warn",
            detail=f"source_refs has no node_id (canvas {canvas_id!r} readable)",
        )
    nodes = [node for node in (payload.get("nodes") or []) if isinstance(node, dict)]
    node = next((item for item in nodes if str(item.get("id") or "") == node_id), None)
    if node is None:
        return store.build_preflight_check(
            check_id=check_id,
            status="warn",
            detail=f"canvas node {node_id!r} not found in canvas {canvas_id!r}",
        )
    urls = _node_asset_urls(node)
    broken = [
        (url, reason)
        for url in dict.fromkeys(urls)
        if (reason := _asset_unresolved_reason(project_dir, project_id, url))
    ]
    if broken:
        return store.build_preflight_check(
            check_id=check_id,
            status="warn",
            detail="; ".join(f"{url}: {reason}" for url, reason in broken),
        )

    info = references
    if info.get("problems"):
        return store.build_preflight_check(
            check_id=check_id,
            status="warn",
            detail="; ".join(str(problem) for problem in info["problems"]),
        )
    if info.get("items"):
        counts = ", ".join(
            f"{count} {kind}" for kind, count in (info.get("counts") or {}).items()
        )
        return store.build_preflight_check(
            check_id=check_id,
            status="pass",
            detail=(
                f"canvas node {node_id!r} resolves {len(info['items'])} upstream "
                f"reference asset(s) ({counts}) from node(s) "
                f"{', '.join(str(item) for item in info.get('node_ids') or [])}; "
                f"gen_mode={info.get('mode')}"
            ),
        )
    if urls:
        return store.build_preflight_check(
            check_id=check_id,
            status="pass",
            detail=(
                f"canvas node {node_id!r} resolved with "
                f"{len(dict.fromkeys(urls))} reachable asset url(s); no upstream "
                f"reference asset linked — render will send {RENDER_GEN_MODE}"
            ),
        )
    return store.build_preflight_check(
        check_id=check_id,
        status="warn",
        detail=f"canvas node {node_id!r} carries no resolvable asset url",
    )


async def _check_billing(
    *,
    model_id: str,
    video_backend: str,
    duration_seconds: Any,
    requester_user_id: str,
) -> dict[str, Any]:
    """计费可报价：复用 ``_cost_ledger``（= 既有 ``get_credit_quote()``）。

    拿不到报价只记 warn 并沿用 ``costUnavailable`` 口径（reason 原样带上），
    **绝不编造数字**，也不预扣：真正的扣费仍由任务后端负责。
    """
    check_id = store.PREFLIGHT_CHECK_BILLING
    try:
        quantity = max(int(round(float(duration_seconds or 0))), 1)
    except (TypeError, ValueError):
        quantity = 1
    ledger = await _cost_ledger(
        model_id=model_id,
        video_backend=video_backend,
        duration_seconds=duration_seconds,
        requester_user_id=requester_user_id,
    )
    if ledger.get("quoted") is not True:
        return store.build_preflight_check(
            check_id=check_id,
            status="warn",
            detail=str(ledger.get("reason") or "credit quote unavailable"),
        )
    return store.build_preflight_check(
        check_id=check_id,
        status="pass",
        detail=(
            f"quoted {ledger.get('display') or ledger.get('total_cost')} "
            f"({ledger.get('unit') or 'call'}) for {quantity} unit(s)"
        ),
    )


async def _run_preflight(
    *,
    resolved: ProjectResolution,
    project_dir: Path,
    recipe: dict[str, Any],
    version: dict[str, Any],
    body: ShotRecipePreflightRequest,
    capabilities: Any = _CAPABILITIES_UNRESOLVED,
    references: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """算出这条版本的预检报告。纯读：不写版本行、不入队、不扣费。

    render 端点跑的是同一个函数——两处口径只有一份实现，不可能打架。调用方已经
    按同一 model_id 解析过目录时（render 就是）把 ``capabilities`` 传进来，已经把画布
    参考算出来时（同样只有 render）再把 ``references`` 传进来，避免同一请求里查两遍。
    """
    requester_user_id = str(resolved.ctx.requester_user_id or "")
    model_id = _preflight_model_id(body, version)
    if capabilities is _CAPABILITIES_UNRESOLVED:
        capabilities = await _resolve_capabilities(
            model_id, requester_user_id=requester_user_id
        )
    if references is None:
        references = _collect_render_references(
            project_dir, version, capabilities=capabilities
        )
    checks = [
        _check_model_capabilities(
            capabilities,
            body,
            version=version,
            model_id=model_id,
            gen_mode=str(references.get("mode") or RENDER_GEN_MODE),
        ),
        _check_look_decisions(recipe, version),
        _check_source_refs(
            project_dir,
            version,
            project_id=str(resolved.ctx.project_id or ""),
            references=references,
        ),
        await _check_billing(
            model_id=model_id,
            video_backend=str(body.video_backend or "").strip(),
            duration_seconds=_requested_duration_seconds(body, version),
            requester_user_id=requester_user_id,
        ),
    ]
    return store.build_preflight_report(
        recipe_id=str(recipe.get("recipe", {}).get("recipe_id") or ""),
        version_id=str(version.get("version_id") or ""),
        checks=checks,
    )


# --------------------------------------------------------------------------
# Quality report — 一条版本的风险清单（只读，报告即时算出、不落盘）
# --------------------------------------------------------------------------


def _quality_model_id(version: dict[str, Any]) -> str:
    """版本的有效模型：行上的 ``model_id`` 优先，回退到冻结快照里的那个。"""
    snapshot = version.get("model_snapshot") or {}
    return str(version.get("model_id") or snapshot.get("model_id") or "").strip()


def _quality_backend(version: dict[str, Any]) -> str:
    return str((version.get("source_refs") or {}).get("video_backend") or "").strip()


def _look_decisions_for(
    recipe: dict[str, Any], version: dict[str, Any]
) -> list[dict[str, Any]]:
    """本版本实际拥有的造型决策（两种既有记法的并集）。

    写入侧（``append_shot_recipe_version``）只认版本行的 ``look_decision_ids``，而
    ``POST .../look-decisions`` 也允许把决策直接绑到某个 ``version_id`` —— 同一关系
    有两种记法。这里两种都认：用另一种记法记录了不会被误判成「零条绑定」，而真正
    引用了一条不存在的 ``decision_id`` 仍会被 ``look_decision_missing`` 抓到。
    """
    ids = [str(item) for item in (version.get("look_decision_ids") or [])]
    version_id = str(version.get("version_id") or "")
    return [
        decision
        for decision in (recipe.get("look_decisions") or [])
        if str(decision.get("decision_id") or "") in ids
        or (version_id and str(decision.get("version_id") or "") == version_id)
    ]


def _look_risks(
    recipe: dict[str, Any], version: dict[str, Any], parent: dict[str, Any] | None
) -> list[dict[str, Any]]:
    """造型连续性：缺失 / 未知 / 中途换人 / 零绑定。"""
    version_id = str(version.get("version_id") or "")
    ids = [str(item) for item in (version.get("look_decision_ids") or [])]
    by_id = {
        str(decision.get("decision_id") or ""): decision
        for decision in (recipe.get("look_decisions") or [])
    }
    risks: list[dict[str, Any]] = []

    missing = [item for item in ids if item not in by_id]
    if missing:
        risks.append(
            store.build_quality_risk(
                risk_id=store.QUALITY_RISK_LOOK_DECISION_MISSING,
                severity="critical",
                detail=(
                    "look decision referenced by this version is not in the recipe: "
                    + ", ".join(missing)
                ),
                evidence={"version_id": version_id, "decision_ids": missing},
            )
        )

    bound = _look_decisions_for(recipe, version)
    if not bound:
        risks.append(
            store.build_quality_risk(
                risk_id=store.QUALITY_RISK_NO_LOOK_DECISIONS,
                severity="warning",
                detail="this version binds no character look decision",
                evidence={"version_id": version_id, "look_decision_ids": ids},
            )
        )

    unknown = [
        decision
        for decision in bound
        if decision.get("identity_known") is not True
    ]
    if unknown:
        risks.append(
            store.build_quality_risk(
                risk_id=store.QUALITY_RISK_LOOK_IDENTITY_UNKNOWN,
                severity="warning",
                detail=(
                    "identity baseline unavailable for: "
                    + ", ".join(
                        str(
                            decision.get("decision_id")
                            or decision.get("identity_id")
                            or "?"
                        )
                        for decision in unknown
                    )
                ),
                evidence={
                    "version_id": version_id,
                    "decision_ids": [
                        str(decision.get("decision_id") or "") for decision in unknown
                    ],
                },
            )
        )

    if parent is None:
        return risks
    parent_by_character = {
        str(decision.get("character_name") or ""): str(
            decision.get("identity_id") or ""
        )
        for decision in _look_decisions_for(recipe, parent)
    }
    for decision in bound:
        name = str(decision.get("character_name") or "")
        identity_id = str(decision.get("identity_id") or "")
        if not name or name not in parent_by_character:
            continue
        previous = parent_by_character[name]
        if previous != identity_id:
            risks.append(
                store.build_quality_risk(
                    risk_id=store.QUALITY_RISK_LOOK_IDENTITY_DRIFT,
                    severity="critical",
                    detail=(
                        f"character {name!r} changed identity: "
                        f"{previous!r} -> {identity_id!r}"
                    ),
                    evidence={
                        "version_id": version_id,
                        "parent_version_id": str(
                            version.get("parent_version_id") or ""
                        ),
                        "decision_id": str(decision.get("decision_id") or ""),
                        "character_name": name,
                        "identity_id": identity_id,
                        "parent_identity_id": previous,
                    },
                )
            )
    return risks


def _lineage_risks(
    version: dict[str, Any], parent: dict[str, Any] | None
) -> list[dict[str, Any]]:
    """谱系：父版本解析不到 / delta 缺失 / 父版本本身没成立。"""
    version_id = str(version.get("version_id") or "")
    parent_version_id = str(version.get("parent_version_id") or "")
    risks: list[dict[str, Any]] = []
    if parent_version_id and parent_version_id != version_id and parent is None:
        risks.append(
            store.build_quality_risk(
                risk_id=store.QUALITY_RISK_LINEAGE_GAP,
                severity="critical",
                detail=(
                    "parent_version_id cannot be resolved in this recipe: "
                    f"{parent_version_id!r}"
                ),
                evidence={
                    "version_id": version_id,
                    "parent_version_id": parent_version_id,
                },
            )
        )
    if parent is None:
        return risks

    delta = version.get("prompt_delta") or {}
    if str(delta.get("mode") or "") != "delta" or not dict(
        delta.get("changes") or {}
    ):
        risks.append(
            store.build_quality_risk(
                risk_id=store.QUALITY_RISK_PROMPT_DELTA_MISSING,
                severity="warning",
                detail=(
                    "this version has a parent but records no prompt delta: "
                    f"mode={delta.get('mode')!r}"
                ),
                evidence={
                    "version_id": version_id,
                    "parent_version_id": parent_version_id,
                    "mode": str(delta.get("mode") or ""),
                },
            )
        )

    parent_status = str(parent.get("status") or "")
    if parent_status in {"failed", "cancelled", "rendering"}:
        risks.append(
            store.build_quality_risk(
                risk_id=store.QUALITY_RISK_PARENT_NOT_COMPLETED,
                severity="warning",
                detail=(
                    "this version branches off a shoot that never succeeded: "
                    f"parent status={parent_status!r}"
                ),
                evidence={
                    "version_id": version_id,
                    "parent_version_id": parent_version_id,
                    "parent_status": parent_status,
                },
            )
        )
    return risks


def _model_risks(
    version: dict[str, Any], parent: dict[str, Any] | None
) -> list[dict[str, Any]]:
    """模型一致性：model_id / video_backend 与父版本不一致 → 一条 warning。

    两侧都未记录时无从比较（不报）；两侧都记了但不同，或一侧记了一侧没记，都是
    真实的不一致。两个字段一起进同一条 risk：id 是契约，同一条 risk 不该出现两行。
    """
    if parent is None:
        return []
    version_id = str(version.get("version_id") or "")
    parent_version_id = str(version.get("parent_version_id") or "")
    current_model = _quality_model_id(version)
    parent_model = _quality_model_id(parent)
    current_backend = _quality_backend(version)
    parent_backend = _quality_backend(parent)
    changes: list[str] = []
    if (current_model or parent_model) and current_model != parent_model:
        changes.append(
            f"model_id {parent_model or '(unrecorded)'!r} -> "
            f"{current_model or '(unrecorded)'!r}"
        )
    if (current_backend or parent_backend) and current_backend != parent_backend:
        changes.append(
            f"video_backend {parent_backend or '(unrecorded)'!r} -> "
            f"{current_backend or '(unrecorded)'!r}"
        )
    if not changes:
        return []
    return [
        store.build_quality_risk(
            risk_id=store.QUALITY_RISK_MODEL_CHANGED,
            severity="warning",
            detail="model changed from the parent version: " + "; ".join(changes),
            evidence={
                "version_id": version_id,
                "parent_version_id": parent_version_id,
                "model_id": current_model,
                "parent_model_id": parent_model,
                "video_backend": current_backend,
                "parent_video_backend": parent_backend,
            },
        )
    ]


def _drift_risks(
    version: dict[str, Any], parent: dict[str, Any] | None
) -> list[dict[str, Any]]:
    """duration / resolution 与父版本不同 → info，附两侧数值。

    只有两侧都记了值才谈得上「漂移」：``None`` 是「没指定」，不是「变成了 0」。
    """
    if parent is None:
        return []
    version_id = str(version.get("version_id") or "")
    parent_version_id = str(version.get("parent_version_id") or "")
    risks: list[dict[str, Any]] = []
    current_duration = version.get("duration_seconds")
    parent_duration = parent.get("duration_seconds")
    if (
        current_duration is not None
        and parent_duration is not None
        and current_duration != parent_duration
    ):
        risks.append(
            store.build_quality_risk(
                risk_id=store.QUALITY_RISK_DURATION_DRIFT,
                severity="info",
                detail=(
                    "duration differs from the parent version: "
                    f"{parent_duration} -> {current_duration}"
                ),
                evidence={
                    "version_id": version_id,
                    "parent_version_id": parent_version_id,
                    "duration_seconds": current_duration,
                    "parent_duration_seconds": parent_duration,
                },
            )
        )
    current_resolution = str(version.get("resolution") or "")
    parent_resolution = str(parent.get("resolution") or "")
    if (
        current_resolution
        and parent_resolution
        and current_resolution != parent_resolution
    ):
        risks.append(
            store.build_quality_risk(
                risk_id=store.QUALITY_RISK_RESOLUTION_DRIFT,
                severity="info",
                detail=(
                    "resolution differs from the parent version: "
                    f"{parent_resolution} -> {current_resolution}"
                ),
                evidence={
                    "version_id": version_id,
                    "parent_version_id": parent_version_id,
                    "resolution": current_resolution,
                    "parent_resolution": parent_resolution,
                },
            )
        )
    return risks


def _render_risks(version: dict[str, Any]) -> list[dict[str, Any]]:
    """渲染事实：失败原因（后端原话）/ 自称完成却没有产物。"""
    version_id = str(version.get("version_id") or "")
    status = str(version.get("status") or "")
    refs = dict(version.get("source_refs") or {})
    risks: list[dict[str, Any]] = []
    error = str(refs.get("error") or "")
    if status == "failed" and error:
        risks.append(
            store.build_quality_risk(
                risk_id=store.QUALITY_RISK_RENDER_FAILED,
                severity="critical",
                detail=error,
                evidence={
                    "version_id": version_id,
                    "status": status,
                    "error": error,
                    "job_id": str(refs.get("job_id") or ""),
                },
            )
        )
    if status == "completed" and not str(refs.get("artifact_url") or ""):
        risks.append(
            store.build_quality_risk(
                risk_id=store.QUALITY_RISK_ARTIFACT_MISSING,
                severity="warning",
                detail="version is completed but records no artifact url",
                evidence={
                    "version_id": version_id,
                    "status": status,
                    "job_id": str(refs.get("job_id") or ""),
                },
            )
        )
    return risks


def _cost_risks(version: dict[str, Any]) -> list[dict[str, Any]]:
    """计费：没拿到报价就如实记 info，沿用 ``costUnavailable`` 口径，绝不编造数字。"""
    version_id = str(version.get("version_id") or "")
    ledger = version.get("cost_ledger") or {}
    if ledger.get("quoted") is True:
        return []
    reason = str(ledger.get("reason") or "credit quote unavailable")
    return [
        store.build_quality_risk(
            risk_id=store.QUALITY_RISK_COST_UNKNOWN,
            severity="info",
            detail=reason,
            evidence={
                "version_id": version_id,
                "quoted": bool(ledger.get("quoted")),
                "reason": reason,
            },
        )
    ]


def _build_quality_report(
    recipe: dict[str, Any], version: dict[str, Any]
) -> dict[str, Any]:
    """算出这条版本的质量风险清单。纯读：不写版本行、不入队、不扣费、不落盘。

    报告是**结构化 risks 列表**，没有总分/评分——单一分数会把「哪条事实坏了」和
    「读不到」一起糊掉。自指父指针（``parent_version_id == version_id``，渲染/回写
    同版本新行时的既有记法）不当成父版本：否则会拿自己跟自己比，凭空产出漂移。
    """
    version_id = str(version.get("version_id") or "")
    parent_version_id = str(version.get("parent_version_id") or "")
    parent = None
    if parent_version_id and parent_version_id != version_id:
        parent = next(
            (
                item
                for item in (recipe.get("versions") or [])
                if str(item.get("version_id") or "") == parent_version_id
            ),
            None,
        )
    risks = [
        *_look_risks(recipe, version, parent),
        *_lineage_risks(version, parent),
        *_model_risks(version, parent),
        *_drift_risks(version, parent),
        *_render_risks(version),
        *_cost_risks(version),
    ]
    risks.sort(
        key=lambda row: store.QUALITY_RISK_SEVERITY_ORDER.index(row["severity"])
    )
    return store.build_quality_report(
        recipe_id=str(recipe.get("recipe", {}).get("recipe_id") or ""),
        version_id=version_id,
        risks=risks,
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


@router.post(
    "/projects/{project}/shot-recipes/{recipe_id}/versions/{version_id}/preflight"
)
async def preflight_shot_recipe_version(
    project: str,
    recipe_id: str,
    version_id: str,
    body: ShotRecipePreflightRequest | None = None,
    user: dict = Depends(get_api_user),
):
    """渲染预检：入队**之前**先回答「这条配方能不能渲染」，只读。

    纯只读——不写版本行、不入队、不扣费。报告是结构化 check 列表（每项 id/status/
    detail），``ok=false`` 表示存在 block 项；**是否阻止渲染由调用方决定**，本端点
    自己绝不 409（用户有权在知道代价后继续）。
    """
    resolved = await resolve_project_scope(project, user, required_role="viewer")
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
    report = await _run_preflight(
        resolved=resolved,
        project_dir=project_dir,
        recipe=recipe,
        version=version,
        body=body or ShotRecipePreflightRequest(),
    )
    return {"ok": True, "data": report}


@router.get(
    "/projects/{project}/shot-recipes/{recipe_id}/versions/{version_id}/quality"
)
async def quality_shot_recipe_version(
    project: str,
    recipe_id: str,
    version_id: str,
    user: dict = Depends(get_api_user),
):
    """版本质量报告：一条版本的**结构化风险清单**，只读。

    纯只读（viewer 权限）——不写版本行、不入队、不扣费、不调用任何模型/LLM/联网，
    报告即时算出且**不落盘**（可重算的东西不持久化）。报告没有总分/评分：单一分数
    会把「哪条事实坏了」和「读不到」一起糊掉，而读不到的事实必须如实降级成
    warning/info，绝不能静默变干净。
    """
    resolved = await resolve_project_scope(project, user, required_role="viewer")
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
    return {"ok": True, "data": _build_quality_report(recipe, version)}


@router.post("/projects/{project}/shot-recipes/{recipe_id}/versions/{version_id}/render")
async def render_shot_recipe_version(
    project: str,
    recipe_id: str,
    version_id: str,
    body: ShotRecipeRenderRequest,
    user: dict = Depends(get_api_user),
):
    """把 ``ready`` 版本接到真实 freezone 视频生成。

    本端点只**构造 payload** 并调用既有任务后端：canvas/node 取自版本自己的
    ``source_refs``，**参考素材**则由这些 id 现读画布得出——绑定节点的一跳上游节点上
    的媒体（含白模导出的 video 节点）会作为 ``reference_items`` 真正喂给生成任务，
    版本行与配方头仍由 store 单一 schema owner 构造。计费沿用既有
    ``freezone_video_generate_task_billing`` + ``get_credit_quote()``——只是记录，不新增
    任何积分/扣费机制；``video_input_present`` / ``operation`` 按真实参考如实填写。

    模式不再硬编码：无参考仍是 ``text_to_video``，只有图片参考 ``image_to_video``，
    含视频/音频参考 ``all_reference``；模型没声明该模式 → 400，参考解析不出来 / 超出
    目录上限 → 400——绝不静默降级回 text_to_video，也绝不静默丢掉参考素材。

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
    # 既有的参数边界守卫先跑：duration/resolution 越界仍是 400 并给出边界值（比预检的
    # 通用 409 更具体，也正是用户需要的那条信息）。它同时保证 duration_seconds 已合法，
    # 后面的预检与 payload 用的是同一个数。
    duration_seconds = _validate_render_knobs(
        capabilities, body, default_duration=version.get("duration_seconds")
    )
    # 参考素材：绑定节点在画布上的（一跳）上游媒体。读不到画布 / 上游没素材 = 这次没有
    # 参考，照旧 text_to_video；但候选素材解析不出来、或超出目录上限，就是 400 ——
    # 静默丢素材正是本切片要关掉的缺口。
    references = _collect_render_references(
        project_dir, version, capabilities=capabilities
    )
    if references["problems"]:
        raise HTTPException(
            400,
            "reference assets rejected: " + "; ".join(references["problems"]),
        )
    # 模式必须由模型声明（既有 helper，与 freezone 端点同一句文案）；没声明就 400，
    # 不退回 text_to_video 假装跑得动。
    from novelvideo.api.routes.freezone import _require_catalog_video_mode

    _require_catalog_video_mode(capabilities, str(references["mode"]))
    # 同一份预检（同一个 `_run_preflight`）再次跑在入队之前：warn 只进报告，block
    # 才 409——按 store 的 check 顺序取第一条 block，文案与 render 既有 409 同风格。
    _preflight_body = ShotRecipePreflightRequest(
        model_id=body.model_id,
        video_backend=body.video_backend,
        aspect_ratio=body.aspect_ratio,
        duration_seconds=body.duration_seconds,
        resolution=body.resolution,
    )
    preflight = await _run_preflight(
        resolved=resolved,
        project_dir=project_dir,
        recipe=recipe,
        version=version,
        body=_preflight_body,
        capabilities=capabilities,
        references=references,
    )
    blocking = [
        check
        for check in preflight["checks"]
        if check.get("status") == "block"
    ]
    if blocking:
        first = blocking[0]
        raise HTTPException(
            409,
            f"preflight blocked: {first['id']}: {first['detail']}"
            + (f" (+{len(blocking) - 1} more)" if len(blocking) > 1 else ""),
        )

    from novelvideo.freezone.video_node import resolve_freezone_video_backend

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

    reference_items = list(references["items"])
    gen_mode = str(references["mode"])
    # 画布请求侧的模式名（freezone 端点的 requested_gen_mode / billing operation 就是它）。
    requested_gen_mode = RENDER_MODE_REQUEST_NAMES.get(gen_mode, gen_mode)
    video_input_present = any(item["type"] == "video" for item in reference_items)

    billing = freezone_video_generate_task_billing(
        {
            "video_backend": backend,
            "resolution": resolution,
            "pricing_quantity": duration_seconds,
            "operation": requested_gen_mode,
            "generate_audio": bool(body.generate_audio),
            "video_input_present": video_input_present,
            # 输入视频的秒数没有探测（ffprobe 不在本切片的范围内）：报价仍只按输出时长，
            # 与切片前的口径一致；flag 本身如实反映「这次真的带了视频参考」。
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
        "gen_mode": gen_mode,
        "requested_gen_mode": requested_gen_mode,
        "prompt": prompt,
        "reference_items": reference_items,
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
        # reference_node_ids：这次渲染真的吃掉了哪些画布节点的素材（下一片据此在画布上
        # 建「白模节点 → 渲染节点」的显式边）。没有参考就是空列表，如实记。
        source_refs={
            **source_refs,
            "job_id": job_id,
            "reference_node_ids": list(references["node_ids"]),
        },
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


@router.post(
    "/projects/{project}/shot-recipes/{recipe_id}/versions/{version_id}/reshoot"
)
async def reshoot_shot_recipe_version(
    project: str,
    recipe_id: str,
    version_id: str,
    body: ShotRecipeReshootRequest,
    user: dict = Depends(get_api_user),
):
    """把源版本的成片里的一段换成新生成的一段，产出**一条新的子版本行**。

    入队的是既有 ``freezone_video_reshoot`` 任务（首尾帧锚定重生成后拼回原片），
    端点只构造 payload。守卫顺序（任一失败都**一行都不写**）：

    1. 幂等——这个源版本已经重拍过（``source_refs.reshoot_job_id``，或配方里已有一条
       以它为 ``reshoot_of`` 的子版本）→ 409 并附既有 job_id；
    2. 状态——源版本必须 ``completed``，否则 409 并带实际 status；
    3. 素材——``body.source_url`` 或源版本 ``source_refs.artifact_url``；两者都空 409，
       解析不成项目内路径 400（外链/越界一律不放行）；
    4. 区间——``end_seconds <= start_seconds`` → 400（与 freezone.py 的 reshoot 同口径）；
    5. 模型——目录取不到 → 409（``capabilities_known=false``，不按已支持放行）；模型未
       声明 ``firstLastFrame`` → 400；区间短于 ``minDuration`` 或长于 ``maxDuration``
       → 400 并给出边界（**不静默截断**）。

    计费只记录既有 ``freezone_video_generate_task_billing`` + ``get_credit_quote()``
    的结果（按生成段计价），不新增任何积分/扣费/账本机制。
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

    source_refs = dict(version.get("source_refs") or {})

    # 1) 幂等：这个源版本已经重拍过就 409 并附既有 job_id，不重复入队。
    #    源版本那一行必须逐字节不变，所以「重拍过」这个事实只能由**追加出去的那条
    #    子版本行**回答（它的 source_refs 带 reshoot_of / reshoot_job_id）。
    existing_job_id = next(
        (
            str((child.get("source_refs") or {}).get("job_id") or "")
            or str((child.get("source_refs") or {}).get("reshoot_job_id") or "")
            for child in recipe["versions"]
            if str((child.get("source_refs") or {}).get("reshoot_of") or "")
            == version_id
            and str((child.get("source_refs") or {}).get("task_type") or "")
            == RESHOOT_TASK_TYPE
        ),
        "",
    )
    if existing_job_id:
        raise HTTPException(
            409,
            f"version {version_id} already has a reshoot job: {existing_job_id}",
        )

    # 2) 状态：只有出过片的版本才谈得上重拍。
    source_status = str(version.get("status") or "")
    if source_status != "completed":
        raise HTTPException(
            409,
            f"version {version_id} is not completed: status={source_status!r}",
        )

    # 3) 素材：请求里给的优先，否则用源版本自己的成片地址。解析不成项目内路径
    #    一律 400——外链/越界地址绝不能静默放行给 runner 当 source_path。
    from novelvideo.freezone.paths import resolve_static_url_to_path

    source_url = str(body.source_url or "").strip() or str(
        source_refs.get("artifact_url") or ""
    ).strip()
    if not source_url:
        raise HTTPException(
            409,
            f"version {version_id} has no source video: pass source_url or render it first",
        )
    try:
        source_path = resolve_static_url_to_path(source_url, project_dir)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    # 与 freezone.py 的 reshoot 端点同口径：路径解析出来了但文件不在，是 404——
    # 放它进队只会让任务一路跑到 runner 里 FileNotFoundError。
    if not source_path.exists():
        raise HTTPException(404, f"video source not found: {source_path}")

    # 4) 区间：口径与 freezone.py 的 reshoot 端点逐字一致。
    if body.end_seconds <= body.start_seconds:
        raise HTTPException(400, "end_seconds must be greater than start_seconds")
    span = float(body.end_seconds) - float(body.start_seconds)
    duration_seconds = int(round(span))

    requester_user_id = str(resolved.ctx.requester_user_id or "")
    # 5) 模型：首尾帧锚定是片段重拍的唯一生成路径，目录取不到就显式拒绝。
    from novelvideo.api.routes.freezone import (
        _catalog_duration_bounds,
        _require_catalog_video_mode,
        _resolve_catalog_request,
    )

    request_schema, model_params, capabilities = await _resolve_catalog_request(
        "video",
        body.model_id,
        {},
        mode=RESHOOT_GEN_MODE,
        requester_user_id=requester_user_id,
    )
    if capabilities is None:
        raise HTTPException(
            409,
            "capabilities_known=false: media model catalog has no entry for "
            f"model_id={body.model_id!r}, refusing to reshoot",
        )
    _require_catalog_video_mode(capabilities, RESHOOT_GEN_MODE)
    min_duration, max_duration = _catalog_duration_bounds(capabilities)
    if type(min_duration) is int and span < min_duration:
        raise HTTPException(
            400,
            f"segment {span:.1f}s is shorter than model min duration {min_duration}s",
        )
    if type(max_duration) is int and span > max_duration:
        raise HTTPException(
            400,
            f"segment {span:.1f}s exceeds model max duration {max_duration}s",
        )

    from novelvideo.freezone.video_node import resolve_freezone_video_backend

    backend = str(body.video_backend or "").strip()
    if not backend:
        try:
            backend = resolve_freezone_video_backend(body.model_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    resolution = normalize_video_resolution_for_backend(
        backend,
        body.resolution or version.get("resolution") or None,
        capabilities.get("resolutionOptions") or None,
    )

    # 函数内导入（与 render 同一写法）：测试因此能塞假后端。
    from novelvideo.ports import get_task_backend

    job_id = store.new_shot_job_id()
    segment = store.build_reshoot_segment(
        source_version_id=version_id,
        start_seconds=body.start_seconds,
        end_seconds=body.end_seconds,
        source_url=source_url,
        job_id=job_id,
    )
    # payload 与 runners/freezone.py::_run_freezone_video_reshoot_async 逐键对齐：
    # 少一个键 runner 就 KeyError（end_seconds 更是必填）。
    payload = {
        "job_id": job_id,
        "source_path": source_path.as_posix(),
        "start_seconds": float(body.start_seconds),
        "end_seconds": float(body.end_seconds),
        "prompt": str(body.prompt or ""),
        "model": body.model_id,
        "backend": backend,
        "model_params": model_params or None,
        "request_schema": request_schema or None,
        "duration_seconds": duration_seconds,
        "resolution": resolution,
        "generate_audio": bool(body.generate_audio),
        "camera_template_id": body.camera_template_id,
        "max_duration_seconds": int(max_duration or 0),
    }
    try:
        queued = await get_task_backend().enqueue_project_task(
            resolved.ctx,
            product_surface=PRODUCT_SURFACE,
            task_type=RESHOOT_TASK_TYPE,
            queue_kind=RESHOOT_QUEUE_KIND,
            episode=0,
            scope=job_id,
            payload=payload,
        )
    except RuntimeError as exc:
        raise HTTPException(503, f"failed to start reshoot task: {exc}") from exc

    # 计费按生成段计价：quantity = 区间长度（秒），走既有 _cost_ledger。
    cost_ledger = await _cost_ledger(
        model_id=body.model_id,
        video_backend=backend,
        duration_seconds=duration_seconds,
        requester_user_id=requester_user_id,
    )
    next_refs = {
        **source_refs,
        "job_id": job_id,
        "task_type": RESHOOT_TASK_TYPE,
        "reshoot_of": version_id,
        "reshoot_job_id": job_id,
        store.RESHOOT_SEGMENT_KEY: segment,
    }
    record = store.build_version_record(
        version_id=store.next_version_id(project_dir=project_dir, recipe_id=recipe_id),
        parent_version_id=version_id,
        prompt_delta=store.build_prompt_delta(
            prompt=str(body.prompt or "").strip()
            or str((version.get("prompt_delta") or {}).get("prompt") or ""),
            changes={store.RESHOOT_SEGMENT_KEY: segment},
            has_parent=True,
        ),
        model_snapshot=store.build_model_snapshot(
            model_id=body.model_id,
            catalog_id=str(capabilities.get("catalogId") or "") or None,
            capabilities=capabilities,
        ),
        cost_ledger=cost_ledger,
        status="rendering",
        source_refs=next_refs,
        look_decision_ids=version.get("look_decision_ids") or [],
        duration_seconds=span,
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
            "version_id": record["version_id"],
            "source_version_id": version_id,
            "job_id": job_id,
            "task_id": queued.task_state.task_id,
            "task_type": RESHOOT_TASK_TYPE,
            "backend": queued.backend,
            "queue": queued.queue,
            "status": record["status"],
            "parent_version_id": record["parent_version_id"],
            "start_seconds": segment["start_seconds"],
            "end_seconds": segment["end_seconds"],
            "duration_seconds": record["duration_seconds"],
            "cost_ledger": record["cost_ledger"],
            "source_refs": record["source_refs"],
        },
    }


@router.post(
    "/projects/{project}/shot-recipes/{recipe_id}/versions/{version_id}/sync"
)
async def sync_shot_recipe_version(
    project: str,
    recipe_id: str,
    version_id: str,
    user: dict = Depends(get_api_user),
):
    """把一次渲染推进到终态：读任务状态，按结果追加一条终态版本行。

    定位参数与 :func:`render_shot_recipe_version` 入队时逐项一致：``scope`` 就是
    版本 ``source_refs.job_id``，``episode`` 恒为 0，``task_type`` 取版本自己记下的
    ``source_refs.task_type``（重拍版本是 ``freezone_video_reshoot``），缺失时回退
    :data:`RENDER_TASK_TYPE`——所以既有渲染版本的行为零变化。

    写回口径：
    - 任务仍在 ``submitting`` / ``queued`` / ``running`` → **一行都不动**，
      返回 ``changed=false`` 且 ``status`` 仍是当前版本状态；
    - ``completed`` → 追加 ``completed`` 行并把产物 url 写进
      ``source_refs.artifact_url``（result 里没有 url 则如实写 ``failed``，
      不伪造产物）；
    - ``failed`` / ``cancelled`` → 追加 ``failed`` 行并把原因写进
      ``source_refs.error``；
    - 任务查不到（终态被清理、过期或从未入队）→ 保留 ``rendering`` 并如实回报
      ``task_found=false``，绝不伪装成已渲染。

    重复 sync 是幂等的：同一次任务不会同一终态写两行（``cancelled`` 之后到来的
    ``completed`` 仍会覆盖它——晚到的成功才是真相）。
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

    source_refs = dict(version.get("source_refs") or {})
    job_id = str(source_refs.get("job_id") or "")
    current_status = str(version.get("status") or "")
    # 重拍版本的任务类型与渲染不同：以版本自己记下的 task_type 为准，缺省回退渲染
    # 任务类型（既有渲染版本 source_refs 里没有这个键，行为零变化）。
    task_type = str(source_refs.get("task_type") or "").strip() or RENDER_TASK_TYPE

    def unchanged(found: bool, task_status: str) -> dict[str, Any]:
        return {
            "ok": True,
            "data": {
                "recipe_id": recipe_id,
                "version_id": version_id,
                "job_id": job_id,
                "task_id": "",
                "task_status": task_status,
                "task_found": found,
                "changed": False,
                "status": current_status,
                "artifact_url": str(source_refs.get("artifact_url") or "") or None,
                "error": str(source_refs.get("error") or "") or None,
                "source_refs": source_refs,
            },
        }

    if not job_id:
        # 从未渲染过——没有任务可对账，但也不是终态，不改任何行。
        return unchanged(False, "")
    if current_status in TERMINAL_VERSON_STATUSES:
        # 已经是终态：重复 sync 不写重复行（幂等，见 docstring）。
        return unchanged(True, current_status)

    # 函数内导入（与 render 同一写法）：测试因此能塞假后端 / 假任务管理器。
    from starlette.concurrency import run_in_threadpool

    from novelvideo.task_state import get_task_manager

    try:
        task = await run_in_threadpool(
            get_task_manager().get_task_for_project,
            resolved.ctx,
            task_type,
            0,
            beat_num=None,
            scope=job_id,
        )
    except Exception as exc:  # noqa: BLE001 - 读不到状态是一种显式降级，不是终态
        logger.debug("shot recipe sync: task state unavailable", exc_info=True)
        raise HTTPException(503, f"task state unavailable: {exc}") from exc
    if task is None:
        # 查不到 ≠ 已渲染。保留 rendering，如实回报（stop_if 明确禁止伪造 completed）。
        return unchanged(False, "")

    task_status = task_status_of(task)
    outcome = store.render_outcome_for(
        task_status=task_status,
        result=getattr(task, "result", None),
        error=str(getattr(task, "error", "") or ""),
    )
    if outcome["status"] not in TERMINAL_VERSON_STATUSES:
        # 中间态：一行都不改，只回报任务进度。
        payload = unchanged(True, task_status)
        payload["data"]["status"] = current_status
        return payload
    if TERMINAL_VERSION_RANK[outcome["status"]] <= TERMINAL_VERSION_RANK.get(
        current_status, -1
    ):
        # 同一终态重复 sync（或 cancelled 之后又报 cancelled）：不再追加行。
        return unchanged(True, task_status)

    next_refs = {
        **source_refs,
        **({"artifact_url": outcome["artifact_url"]} if outcome["artifact_url"] else {}),
        **({"error": outcome["error"]} if outcome["error"] else {}),
    }
    next_refs["task_status"] = task_status
    record = store.build_version_record(
        version_id=version_id,
        parent_version_id=version.get("parent_version_id") or version_id,
        prompt_delta=store.build_prompt_delta(
            prompt=str((version.get("prompt_delta") or {}).get("prompt") or ""),
            changes={
                **dict((version.get("prompt_delta") or {}).get("changes") or {}),
                "render": {
                    "job_id": job_id,
                    "task_status": task_status,
                    "status": outcome["status"],
                },
            },
            has_parent=bool(version.get("parent_version_id")),
        ),
        model_snapshot=version.get("model_snapshot") or store.build_model_snapshot(),
        cost_ledger=version.get("cost_ledger") or store.build_cost_ledger(),
        status=outcome["status"],
        source_refs=next_refs,
        look_decision_ids=version.get("look_decision_ids") or [],
        duration_seconds=version.get("duration_seconds"),
        resolution=version.get("resolution"),
        model_id=version.get("model_id"),
    )
    try:
        store.append_version_record(
            project_dir=project_dir, recipe_id=recipe_id, record=record
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {
        "ok": True,
        "data": {
            "recipe_id": recipe_id,
            "version_id": version_id,
            "job_id": job_id,
            "task_id": str(getattr(task, "task_id", "") or ""),
            "task_status": task_status,
            "task_found": True,
            "changed": True,
            "status": record["status"],
            "parent_version_id": record["parent_version_id"],
            "artifact_url": outcome["artifact_url"] or None,
            "error": outcome["error"] or None,
            "source_refs": record["source_refs"],
            "cost_ledger": record["cost_ledger"],
        },
    }
