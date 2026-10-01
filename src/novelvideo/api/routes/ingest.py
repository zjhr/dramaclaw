"""小说上传 & 导入端点。"""

import asyncio
import json
import logging
import os
import shutil
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Annotated, Any

import anyio
from anyio.lowlevel import RunVar
from fastapi import APIRouter, Depends, File, Form, UploadFile

from novelvideo.api.auth import get_api_user, require_scope
from novelvideo.api.chapter_preview import (
    build_chapter_preview,
    count_billable_novel_chars,
    load_novel_text,
)
from novelvideo.api.deps import resolve_project_scope
from novelvideo.api.schemas import (
    IngestManuscriptAction,
    IngestRepair,
    IngestStart,
    IngestWriteFirst,
    SaveManuscriptImitation,
)
from novelvideo.ingest.manuscript_repair import (
    advance_manuscript_repair,
    default_repair_runner,
    fresh_progress,
)
from novelvideo.ingest.zero_write import (
    ZERO_WRITE_SYSTEM_PROMPT,
    build_adapt_prompt,
    build_write_first_prompt,
    generate_first_manuscript,
    quality_issues,
)
from novelvideo.cognee.chapter_detector import ChapterDetector
from novelvideo.ingest.manuscript_actions import (
    ACTION_SYSTEM_PROMPT,
    action_preview_entry,
    action_state_path,
    apply_role_mapping,
    content_hash,
    finish_action,
    load_action_state,
    prepare_action_baseline,
    preview_character_map,
    rewrite_gender_document,
    rewrite_document,
    rewrite_hook,
    save_action_state,
    validate_rewrite,
)
from novelvideo.knowledge_pipeline import is_structured_pipeline
from novelvideo.graph_preview import (
    empty_graph_preview,
    load_graph_preview,
)
from novelvideo.project_config import (
    default_aspect_ratio_for_spine_template,
    load_project_config_file_from_state_dir,
    save_project_config_in_state_dir,
)
from novelvideo.ports import get_task_backend
from novelvideo.task_identity import project_task_state_key
from novelvideo.utils.document_parsers import (
    DocumentParseError,
    MAX_NOVEL_IMPORT_CHARS,
    is_supported_novel_path,
    supported_novel_extensions_label,
)
from novelvideo.utils.screenplay_quality import build_import_format_check
from novelvideo.utils.async_ops import run_sync_bounded
from novelvideo.utils.upload_safety import (
    MAX_NOVEL_IMPORT_BYTES,
    MAX_NOVEL_UPLOAD_BYTES,
    UploadTooLargeError,
    create_staged_upload_file,
    is_safe_upload_target,
    sanitize_upload_filename,
    stream_to_file_with_limit,
)

logger = logging.getLogger("novelvideo.api.ingest")
router = APIRouter()
_INGEST_UPLOAD_CONCURRENCY = 2
_MANUSCRIPT_ACTION_LOCKS: dict[str, asyncio.Lock] = {}
_ingest_upload_limiter_var: RunVar[anyio.CapacityLimiter] = RunVar(
    "ingest_upload_limiter"
)


def _ingest_upload_limiter() -> anyio.CapacityLimiter:
    """Return the upload-processing gate scoped to the current async run."""

    limiter = _ingest_upload_limiter_var.get(None)
    if limiter is None:
        limiter = anyio.CapacityLimiter(_INGEST_UPLOAD_CONCURRENCY)
        _ingest_upload_limiter_var.set(limiter)
    return limiter


async def _run_ingest_upload_operation(
    operation: Callable[..., Any], /, *args: Any, **kwargs: Any
) -> Any:
    """Run blocking upload work off-loop without abandoning its limiter token."""

    return await run_sync_bounded(
        operation,
        *args,
        limiter=_ingest_upload_limiter(),
        **kwargs,
    )


@router.get("/projects/{project}/ingest/graph")
async def get_ingest_knowledge_graph(
    project: str,
    user: dict = Depends(get_api_user),
):
    """Return the persisted graph preview without opening Ladybug on normal reads."""

    resolved = await resolve_project_scope(project, user, required_role="viewer")
    ctx = resolved.ctx

    # A missing novel.txt means an import has not completed (or a rebuild
    # invalidated the old graph). Do not race the active/failed import by
    # returning a stale sidecar or opening its embedded graph database from an
    # API worker.
    if not (ctx.output_dir / "novel.txt").is_file():
        return {"ok": True, "data": empty_graph_preview()}

    # structured_v1 projects never build a graph, so there is never a sidecar
    # to read and the client renders nothing for an empty preview.
    if is_structured_pipeline(ctx.state_dir):
        return {"ok": True, "data": empty_graph_preview()}

    # Written during import, before novel.txt — which is the public "import
    # succeeded" marker — so a project that imported successfully has one.
    #
    # Projects predating the sidecar do not, and are left without a preview
    # rather than materialized on demand. Backfilling meant a viewer-role GET
    # opening Ladybug from an API worker and waiting on the project graph lock
    # with no timeout: during a rebuild that is the length of the rebuild, held
    # by a request that asyncio.shield keeps alive after the client is gone.
    # And the wait bought nothing — the first thing it did on acquiring the
    # lock was re-check novel.txt, find it removed by the rebuild, and return
    # the empty preview anyway.
    #
    # Nothing downstream reads this file; it is one visualization on the import
    # page, and the client already renders nothing for an empty one. A missing
    # preview is a missing picture, not missing data, and re-importing produces
    # it.
    snapshot = load_graph_preview(ctx.state_dir)
    if snapshot is not None:
        return {"ok": True, "data": snapshot}
    return {"ok": True, "data": empty_graph_preview()}


def _unsupported_format_response(filename: str) -> dict:
    suffix = Path(filename).suffix.lower() or "无扩展名"
    return {
        "ok": False,
        "error": f"不支持的文件类型: {suffix}，当前支持: {supported_novel_extensions_label()}",
        "error_type": "unsupported",
    }


def _format_file_size_limit(limit_bytes: int) -> str:
    if limit_bytes % (1024 * 1024) == 0:
        return f"{limit_bytes // (1024 * 1024)}MB"
    return f"{limit_bytes // 1024}KB"


def _file_too_large_response(
    limit_bytes: int = MAX_NOVEL_UPLOAD_BYTES,
) -> dict:
    limit_label = _format_file_size_limit(limit_bytes)
    return {
        "ok": False,
        "error": f"文件超过 {limit_label} 上限，请压缩文件或拆分正文后重新上传。",
        "error_type": "file_too_large",
        "data": {"limit_bytes": limit_bytes},
    }


def _text_too_large_response(actual_chars: int) -> dict:
    return {
        "ok": False,
        "error": (
            f"正文共 {actual_chars:,} 字，超过单次导入上限 "
            f"{MAX_NOVEL_IMPORT_CHARS:,} 字。请拆分后重新上传。"
        ),
        "error_type": "text_too_large",
        "data": {
            "limit_chars": MAX_NOVEL_IMPORT_CHARS,
            "actual_chars": actual_chars,
        },
    }


def _upload_novel_sync(
    *,
    project: str,
    upload_stream: Any,
    filename: str | None,
    project_dir: Path,
    state_dir: str | Path,
    spine_template: str | None,
) -> dict:
    """Stage, parse, preview, and atomically persist one novel upload."""

    uploads_dir = project_dir / "uploads"
    uploads_dir.mkdir(parents=True, exist_ok=True)

    safe_name = sanitize_upload_filename(filename)
    if not is_safe_upload_target(uploads_dir, safe_name):
        return {"ok": False, "error": "非法文件名"}
    if not is_supported_novel_path(safe_name):
        return _unsupported_format_response(safe_name)
    dest = uploads_dir / safe_name
    staging_dir = uploads_dir / ".staging"
    staging_dir.mkdir(exist_ok=True)
    staged_path = create_staged_upload_file(
        staging_dir,
        suffix=Path(safe_name).suffix,
        destination=dest,
    )
    try:
        try:
            size = stream_to_file_with_limit(upload_stream, staged_path)
        except UploadTooLargeError:
            return _file_too_large_response()

        data = {"filename": safe_name, "size": size}
        try:
            content = load_novel_text(staged_path)
            billable_chars = count_billable_novel_chars(content)
            if billable_chars > MAX_NOVEL_IMPORT_CHARS:
                return _text_too_large_response(billable_chars)
            project_config = load_project_config_file_from_state_dir(state_dir)
            requested_spine_template = str(
                spine_template
                or project_config.get("spine_template")
                or "drama"
            ).strip()
            preview = build_chapter_preview(
                content,
                include_scene_blocks=requested_spine_template != "narrated",
            )
        except DocumentParseError as exc:
            logger.warning(
                "[%s] failed to parse uploaded novel: %s: %s",
                project,
                safe_name,
                exc,
            )
            return {
                "ok": False,
                "error": f"解析章节失败: {exc}",
                "error_type": "parse",
                "format": exc.source_format,
                "detail": str(exc),
            }
        except Exception:
            logger.warning(
                "[%s] failed to build chapter preview", project, exc_info=True
            )
            return {"ok": False, "error": "解析章节失败"}

        has_chapters = bool(preview.get("chapters"))
        format_check = build_import_format_check(
            content,
            has_chapters=has_chapters,
            chapters=preview.get("chapters"),
        )
        if not has_chapters:
            return {
                "ok": False,
                "error": "解析章节失败: 未检测到有效章节内容",
                "format_check": format_check,
            }

        try:
            os.replace(staged_path, dest)
        except OSError:
            logger.exception(
                "[%s] failed to persist uploaded novel: %s", project, safe_name
            )
            return {"ok": False, "error": "保存上传文件失败"}

        data.update(preview)
        data["format_check"] = format_check
        return {"ok": True, "data": data}
    finally:
        try:
            staged_path.unlink(missing_ok=True)
        except OSError:
            logger.warning(
                "[%s] failed to remove staged upload: %s",
                project,
                staged_path.name,
                exc_info=True,
            )


@router.post("/projects/{project}/ingest/upload")
async def upload_novel(
    project: str,
    file: UploadFile = File(...),
    spine_template: Annotated[str | None, Form()] = None,
    user: dict = Depends(get_api_user),
):
    """上传小说文件到项目的 uploads/ 目录。"""
    logger.info("[%s] upload_novel: %s", project, file.filename)
    resolved = await resolve_project_scope(project, user, required_role="editor")
    return await _run_ingest_upload_operation(
        _upload_novel_sync,
        project=project,
        upload_stream=file.file,
        filename=file.filename,
        project_dir=Path(resolved.project_dir),
        state_dir=resolved.state_dir,
        spine_template=spine_template,
    )


_REPAIR_TASK = "manuscript_repair"
_ZERO_WRITE_TASK = "zero_write"
_REPAIR_TERMINAL = {"completed", "failed", "cancelled"}
_REPAIR_BATCH_RECOVERY_ATTEMPTS = 2


def _repair_task_scope(ctx, progress: dict, *, restart: bool) -> str:
    from novelvideo.task_state import get_task_manager

    current = progress.get("task_scope")
    state = None
    if isinstance(current, str) and current:
        state = get_task_manager().get_task_for_project(
            ctx, _REPAIR_TASK, 0, scope=current
        )
    if (
        restart
        or not isinstance(current, str)
        or not current
        or (state is not None and state.status in _REPAIR_TERMINAL)
    ):
        current = f"repair-{uuid.uuid4().hex[:8]}"
        progress["task_scope"] = current
    return current


def _task_center_log(
    ctx,
    scope: str,
    *,
    task_type: str = _REPAIR_TASK,
    message: str,
    progress: float | None = None,
    status: str = "running",
) -> None:
    from novelvideo.task_state import get_task_manager

    manager = get_task_manager()
    if status == "completed":
        manager.complete_task_for_project(
            ctx,
            task_type,
            0,
            scope=scope,
            progress=1,
            current_task=message,
            logs=[message],
        )
        return
    if status == "failed":
        manager.fail_task_for_project(
            ctx,
            task_type,
            0,
            scope=scope,
            error=message,
            current_task=message,
            logs=[message],
        )
        return
    manager.update_progress_for_project(
        ctx,
        task_type,
        0,
        scope=scope,
        progress=progress,
        current_task=message,
        logs=[message],
        status="running",
    )


def _repair_failure_message(exc: Exception) -> str:
    body = getattr(exc, "body", None)
    message = str(body.get("message") or "") if isinstance(body, dict) else ""
    text = message or str(exc)
    if "model_not_found" in text or "No available channel" in text:
        return "改稿模型没有可用通道。"
    if message:
        return f"生成失败：{message[:180]}"
    return "生成失败"


def _repair_names(safe_name: str) -> tuple[str, str]:
    stem = Path(safe_name).stem or "upload"
    return f"{stem}.xialiao.txt", f"{stem}.xialiao.repair.json"


def _repair_source_name(uploads_dir: Path, requested_name: str) -> str:
    """修复稿被再次选中时，找回它对应的原上传稿。"""
    for candidate in uploads_dir.iterdir():
        if (
            candidate.name == requested_name
            or not candidate.is_file()
            or not is_supported_novel_path(candidate.name)
        ):
            continue
        if not is_safe_upload_target(uploads_dir, candidate.name):
            continue
        working_name, progress_name = _repair_names(candidate.name)
        if working_name == requested_name and (uploads_dir / progress_name).is_file():
            return candidate.name
    return requested_name


def _resolve_complete_repair_work_copy(
    uploads_dir: Path, filename: str, spine_template: str
) -> tuple[Path, Path, dict]:
    safe_name = sanitize_upload_filename(filename)
    if safe_name != filename or not is_safe_upload_target(uploads_dir, safe_name):
        raise ValueError("非法文件名")
    source_name = _repair_source_name(uploads_dir, safe_name)
    working_name, progress_name = _repair_names(source_name)
    if safe_name != working_name:
        raise ValueError("请先对上传稿完成一键修复，再使用这些改稿功能")
    source_path = uploads_dir / source_name
    working_path = uploads_dir / working_name
    progress_path = uploads_dir / progress_name
    if not source_path.is_file() or not working_path.is_file() or not progress_path.is_file():
        raise ValueError("没有找到完整的修复工作稿，请先完成一键修复")
    try:
        source_stat = source_path.stat()
        progress = json.loads(progress_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("无法读取工作稿状态，请重新执行一键修复") from exc
    chapters = progress.get("chapters") if isinstance(progress, dict) else None
    if (
        not isinstance(chapters, dict)
        or not chapters
        or any(not isinstance(state, dict) or state.get("done") is not True for state in chapters.values())
        or progress.get("source_size") != source_stat.st_size
        or progress.get("source_mtime_ns") != source_stat.st_mtime_ns
    ):
        raise ValueError("一键修复尚未完成或原稿已变化，请先重新完成修复")
    if progress.get("spine_template") != spine_template:
        raise ValueError("工作稿体裁与当前项目类型不一致，请先重新完成一键修复")
    return source_path, working_path, progress


def _manuscript_action_lock(path: Path) -> asyncio.Lock:
    key = str(path.resolve())
    return _MANUSCRIPT_ACTION_LOCKS.setdefault(key, asyncio.Lock())


def _save_working_copy(path: Path, content: str) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(content, encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _upload_preview(filename: str, path: Path, content: str, spine_template: str) -> dict:
    preview = build_chapter_preview(
        content,
        include_scene_blocks=spine_template != "narrated",
    )
    format_check = build_import_format_check(
        content,
        has_chapters=bool(preview.get("chapters")),
        chapters=preview.get("chapters"),
        require_scene_headers=spine_template == "drama",
    )
    return {
        "filename": filename,
        "size": path.stat().st_size,
        **preview,
        "format_check": format_check,
    }


def _load_repair_progress(
    path: Path,
    *,
    source_size: int,
    source_mtime_ns: int,
    spine_template: str,
) -> dict:
    if not path.is_file():
        progress = fresh_progress(spine_template)
    else:
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            loaded = None
        if (
            isinstance(loaded, dict)
            and loaded.get("source_size") == source_size
            and loaded.get("source_mtime_ns") == source_mtime_ns
            and loaded.get("spine_template") == spine_template
            and isinstance(loaded.get("chapters"), dict)
        ):
            progress = loaded
        else:
            progress = fresh_progress(spine_template)
    progress["source_size"] = source_size
    progress["source_mtime_ns"] = source_mtime_ns
    progress["spine_template"] = spine_template
    return progress


@router.post("/projects/{project}/ingest/repair")
async def repair_manuscript(
    project: str,
    body: IngestRepair,
    user: dict = Depends(get_api_user),
):
    """Rewrite the uploaded file into a working copy. The original stays put."""

    resolved = await resolve_project_scope(project, user, required_role="editor")
    uploads_dir = Path(resolved.project_dir) / "uploads"
    safe_name = sanitize_upload_filename(body.filename)
    if safe_name != body.filename or not is_safe_upload_target(uploads_dir, safe_name):
        return {"ok": False, "error": "非法文件名"}
    if not is_supported_novel_path(safe_name):
        return _unsupported_format_response(safe_name)
    safe_name = _repair_source_name(uploads_dir, safe_name)
    source_path = uploads_dir / safe_name
    if not source_path.is_file():
        return {"ok": False, "error": f"File '{body.filename}' not found in uploads/"}

    working_name, progress_name = _repair_names(safe_name)
    if not is_safe_upload_target(uploads_dir, working_name) or not is_safe_upload_target(
        uploads_dir, progress_name
    ):
        return {"ok": False, "error": "非法文件名"}
    try:
        source_stat = source_path.stat()
        original = load_novel_text(source_path)
    except DocumentParseError as exc:
        return {"ok": False, "error": f"解析章节失败: {exc}"}
    except OSError:
        logger.warning("[%s] failed to read manuscript for repair", project, exc_info=True)
        return {"ok": False, "error": "无法读取上传文件，请重新上传后再试"}

    progress_path = uploads_dir / progress_name
    progress = _load_repair_progress(
        progress_path,
        source_size=source_stat.st_size,
        source_mtime_ns=source_stat.st_mtime_ns,
        spine_template=body.spine_template,
    )
    task_scope = _repair_task_scope(resolved.ctx, progress, restart=body.restart)
    _task_center_log(
        resolved.ctx,
        task_scope,
        message="正在分章调用模型，每章单独请求，多章同时进行。原文不动。",
    )
    try:
        call_notes: list[str] = []
        for attempt in range(_REPAIR_BATCH_RECOVERY_ATTEMPTS):
            step = await advance_manuscript_repair(
                original,
                progress,
                spine_template=body.spine_template,
                runner=lambda prompt: default_repair_runner(
                    prompt, body.reasoning_effort
                ),
                restart=body.restart and attempt == 0,
                chosen_header=body.scene_header.strip() or None,
            )
            call_notes.extend(step.calls or [])
            if not step.error or step.needs_choice:
                break
            if attempt + 1 < _REPAIR_BATCH_RECOVERY_ATTEMPTS:
                _task_center_log(
                    resolved.ctx,
                    task_scope,
                    message="本批有章节调用失败，保留已完成章节后自动重试未完成章节。",
                )
        step.calls = call_notes
    except ValueError as exc:
        _task_center_log(resolved.ctx, task_scope, message=str(exc), status="failed")
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        logger.exception("[%s] manuscript repair failed", project)
        message = _repair_failure_message(exc)
        _task_center_log(resolved.ctx, task_scope, message=message, status="failed")
        return {"ok": False, "error": message}

    try:
        progress_path.write_text(
            json.dumps(progress, ensure_ascii=False),
            encoding="utf-8",
        )
        working_path = uploads_dir / working_name
        working_path.write_text(step.assembled, encoding="utf-8")
    except OSError:
        logger.exception("[%s] failed to save repaired manuscript", project)
        _task_center_log(
            resolved.ctx, task_scope, message="保存工作稿失败", status="failed"
        )
        return {"ok": False, "error": "保存工作稿失败"}

    if step.needs_choice:
        _task_center_log(
            resolved.ctx,
            task_scope,
            message=f"第 {step.chapter_number} 章需要你选择场景头",
        )
    elif step.error:
        _task_center_log(
            resolved.ctx, task_scope, message=step.error, status="failed"
        )
    elif step.done:
        _task_center_log(
            resolved.ctx,
            task_scope,
            message=f"工作稿已写好：{working_name}",
            status="completed",
        )
    else:
        done_count = len(step.completed_chapters)
        total = max(step.chapter_count, 1)
        _task_center_log(
            resolved.ctx,
            task_scope,
            progress=done_count / total,
            message=(
                f"第 {step.chapter_number} 章已收到"
                f"（{step.chunk_index}/{step.chunk_count}），共 {step.chapter_count} 章"
            ),
        )

    preview = build_chapter_preview(
        step.assembled,
        include_scene_blocks=body.spine_template != "narrated",
    )
    format_check = build_import_format_check(
        step.assembled,
        has_chapters=bool(preview.get("chapters")),
        chapters=preview.get("chapters"),
        require_scene_headers=body.spine_template == "drama",
    )
    upload = {
        "filename": working_name,
        "size": working_path.stat().st_size,
        **preview,
        "format_check": format_check,
    }
    return {
        "ok": step.error is None or step.needs_choice,
        "error": "" if step.needs_choice else (step.error or ""),
        "data": {
            "original_filename": safe_name,
            "working_filename": working_name,
            "chapter_number": step.chapter_number,
            "chunk_index": step.chunk_index,
            "chunk_count": step.chunk_count,
            "chapter_count": step.chapter_count,
            "completed_chapters": step.completed_chapters,
            "done": step.done,
            "needs_choice": step.needs_choice,
            "choices": step.choices or [],
            "calls": step.calls or [],
            "format_check": format_check,
            "upload": upload,
        },
    }


@router.post("/projects/{project}/ingest/manuscript-action")
async def run_manuscript_action(
    project: str,
    body: IngestManuscriptAction,
    user: dict = Depends(get_api_user),
):
    """在完整修复工作稿上执行单项改写，原上传稿保持不变。"""
    resolved = await resolve_project_scope(project, user, required_role="editor")
    uploads_dir = Path(resolved.project_dir) / "uploads"
    try:
        _, working_path, _ = _resolve_complete_repair_work_copy(
            uploads_dir, body.filename, body.spine_template
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}

    async with _manuscript_action_lock(working_path):
        try:
            current = load_novel_text(working_path)
        except (DocumentParseError, OSError) as exc:
            return {"ok": False, "error": f"无法读取工作稿：{exc}"}
        state_path = action_state_path(working_path)
        state = load_action_state(state_path)

        async def runner(prompt: str, effort: str) -> str:
            return await default_repair_runner(
                prompt,
                effort,
                system_prompt=ACTION_SYSTEM_PROMPT,
                agent_name="虾料改稿动作",
            )

        try:
            if body.action in {"cast_preview", "gender_preview"}:
                action_key = "cast" if body.action == "cast_preview" else "gender"
                baseline, state, current_hash = prepare_action_baseline(
                    state, action_key, current
                )
                entry = state["actions"][action_key]
                entry["preview_current_hash"] = current_hash
                save_action_state(state_path, state)
                mappings, calls = await preview_character_map(
                    baseline,
                    gender=body.action == "gender_preview",
                    runner=runner,
                    reasoning_effort=body.reasoning_effort,
                )
                entry["mappings"] = mappings
                save_action_state(state_path, state)
                return {
                    "ok": True,
                    "data": {
                        "action": body.action,
                        "working_filename": working_path.name,
                        "mappings": mappings,
                        "calls": calls,
                    },
                }

            if body.action in {"cast_apply", "gender_apply"}:
                action_key = "cast" if body.action == "cast_apply" else "gender"
                current_hash = content_hash(current)
                entry = action_preview_entry(state, action_key, current_hash)
                baseline = str(entry["baseline"])
                mappings = [row.model_dump() for row in body.mappings]
                if not mappings:
                    raise ValueError("请先查看并确认人物对照表")
                if body.action == "cast_apply":
                    output, calls = apply_role_mapping(baseline, mappings)
                else:
                    output, calls = await rewrite_gender_document(
                        baseline,
                        rows=mappings,
                        spine_template=body.spine_template,
                        runner=runner,
                        reasoning_effort=body.reasoning_effort,
                    )
            elif body.action == "hook":
                baseline, state, _ = prepare_action_baseline(state, "hook", current)
                save_action_state(state_path, state)
                output, calls = await rewrite_hook(
                    baseline,
                    spine_template=body.spine_template,
                    style=body.style,
                    runner=runner,
                    reasoning_effort=body.reasoning_effort,
                )
                action_key = "hook"
            elif body.action == "wash":
                baseline, state, _ = prepare_action_baseline(state, "wash", current)
                save_action_state(state_path, state)
                output, calls = await rewrite_document(
                    baseline,
                    action="wash",
                    spine_template=body.spine_template,
                    runner=runner,
                    reasoning_effort=body.reasoning_effort,
                )
                action_key = "wash"
            elif body.action == "imitate":
                output, calls = await rewrite_document(
                    current,
                    action="imitate",
                    spine_template=body.spine_template,
                    runner=runner,
                    reasoning_effort=body.reasoning_effort,
                )
                preview = _upload_preview(
                    "深挖仿写预览.txt", working_path, output, body.spine_template
                )
                if not preview["chapters"]:
                    raise ValueError("仿写结果没有可识别的章节")
                if preview["format_check"]["level"] == "blocking":
                    raise ValueError("仿写结果未通过当前体裁的格式检查，请重试")
                return {
                    "ok": True,
                    "data": {
                        "action": "imitate",
                        "content": output,
                        "calls": calls,
                    },
                }
            elif body.action == "adapt":
                chapters = ChapterDetector().detect(current)
                if not chapters:
                    raise ValueError("没有找到可改编的正文")
                chapter_text = chapters[0].content.strip()
                output = await generate_first_manuscript(
                    build_adapt_prompt(chapter_text),
                    runner,
                    body.reasoning_effort,
                    unit="集",
                    number=1,
                )
                calls = [f"改编自 {chapters[0].title or f'第{chapters[0].number}章'}"]
                preview = _upload_preview(
                    "改编短剧预览.txt", working_path, output, "drama"
                )
                if not preview["chapters"]:
                    raise ValueError("改编结果没有可识别的集")
                if preview["format_check"]["level"] == "blocking":
                    raise ValueError("改编结果没有通过精品剧格式检查，请重试")
                return {
                    "ok": True,
                    "data": {
                        "action": "adapt",
                        "content": output,
                        "calls": calls,
                    },
                }
            else:
                raise ValueError("未知的改稿动作")

            preview = _upload_preview(
                working_path.name, working_path, output, body.spine_template
            )
            if not preview["chapters"]:
                raise ValueError("结果没有可识别的章节，工作稿未修改")
            if preview["format_check"]["level"] == "blocking":
                raise ValueError("结果未通过当前体裁的格式检查，工作稿未修改")
            finish_action(state, action_key, output)
            _save_working_copy(working_path, output)
            save_action_state(state_path, state)
            preview["size"] = working_path.stat().st_size
            return {
                "ok": True,
                "data": {
                    "action": body.action,
                    "working_filename": working_path.name,
                    "upload": preview,
                    "calls": calls,
                },
            }
        except (ValueError, OSError) as exc:
            logger.warning("[%s] manuscript action rejected: %s", project, exc)
            return {"ok": False, "error": str(exc)}
        except Exception as exc:
            logger.exception("[%s] manuscript action failed", project)
            return {"ok": False, "error": _repair_failure_message(exc)}


@router.post("/projects/{project}/ingest/manuscript-action/save-imitation")
async def save_manuscript_imitation(
    project: str,
    body: SaveManuscriptImitation,
    user: dict = Depends(get_api_user),
):
    """把已生成的仿写或改编预览另存为新上传文件，不自动导入。"""
    resolved = await resolve_project_scope(project, user, required_role="editor")
    uploads_dir = Path(resolved.project_dir) / "uploads"
    try:
        source_path, working_path, _ = _resolve_complete_repair_work_copy(
            uploads_dir, body.filename, body.spine_template
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}

    async with _manuscript_action_lock(working_path):
        try:
            if body.validate:
                source = load_novel_text(working_path)
                content = validate_rewrite(
                    source,
                    body.content,
                    preserve_speakers=False,
                    preserve_scene_headers=False,
                )
            else:
                content = body.content.strip()
            target_template = body.target_template or body.spine_template
            preview = build_chapter_preview(
                content,
                include_scene_blocks=target_template != "narrated",
            )
            format_check = build_import_format_check(
                content,
                has_chapters=bool(preview.get("chapters")),
                chapters=preview.get("chapters"),
                require_scene_headers=target_template == "drama",
            )
            if not preview.get("chapters") or format_check["level"] == "blocking":
                return {"ok": False, "error": "结果没有通过目标体裁的格式检查，未保存"}
            if len(content.encode("utf-8")) > MAX_NOVEL_IMPORT_BYTES:
                return {"ok": False, "error": "结果超过可导入文件大小限制，未保存"}

            base_stem = Path(source_path.name).stem
            stem = sanitize_upload_filename(f"{base_stem}-{body.suffix}.txt")
            candidate = stem
            suffix = 2
            while (uploads_dir / candidate).exists():
                candidate = sanitize_upload_filename(f"{base_stem}-{body.suffix}-{suffix}.txt")
                suffix += 1
            if not is_safe_upload_target(uploads_dir, candidate):
                return {"ok": False, "error": "无法生成安全的仿写文件名"}
            target = uploads_dir / candidate
            _save_working_copy(target, content)
            upload = {
                "filename": candidate,
                "size": target.stat().st_size,
                **preview,
                "format_check": format_check,
            }
            return {"ok": True, "data": {"upload": upload, "import_started": False}}
        except (ValueError, DocumentParseError, OSError) as exc:
            logger.warning("[%s] failed to save manuscript imitation: %s", project, exc)
            return {"ok": False, "error": str(exc)}


@router.post("/projects/{project}/ingest/write-first")
async def write_first_manuscript(
    project: str,
    body: IngestWriteFirst,
    user: dict = Depends(get_api_user),
):
    """从零写第 1 稿，或对已有稿件续写下一集/章。

    第 1 稿另存新上传文件，不读取也不修改已上传的稿；续写追加进同一份文件。不自动导入。
    """
    resolved = await resolve_project_scope(project, user, required_role="editor")
    uploads_dir = Path(resolved.project_dir) / "uploads"
    spine_template = "narrated" if body.kind == "novel" else "drama"
    unit = "章" if body.kind == "novel" else "集"
    task_scope = f"zero-write-{uuid.uuid4().hex[:8]}"

    append_mode = bool(body.filename.strip()) and body.episode > 1
    existing_text = ""
    previous_text = ""
    target_name = ""
    if append_mode:
        requested_name = body.filename.strip()
        safe_name = sanitize_upload_filename(requested_name)
        if safe_name != requested_name or not is_safe_upload_target(uploads_dir, safe_name):
            return {"ok": False, "error": "非法文件名"}
        source_path = uploads_dir / safe_name
        if not source_path.is_file():
            return {"ok": False, "error": f"找不到《{requested_name}》，可能已被删除。"}
        try:
            existing_text = load_novel_text(source_path)
        except (DocumentParseError, OSError) as exc:
            return {"ok": False, "error": f"无法读取已有稿件：{exc}"}
        existing_chapters = ChapterDetector().detect(existing_text)
        episode = len(existing_chapters) + 1
        previous_text = existing_chapters[-1].content if existing_chapters else existing_text
        target_name = safe_name
    else:
        episode = max(1, body.episode)

    prompt = build_write_first_prompt(
        kind=body.kind,
        premise=body.premise,
        lead=body.lead,
        count=body.count,
        skills=body.skills,
        episode=episode,
        previous_text=previous_text,
        note=body.note,
    )
    running_message = (
        f"正在写第 {episode} {unit}，写完续在《{target_name}》。"
        if append_mode
        else f"正在写第 1 {unit}，模型生成中。已上传的稿不动。"
    )
    _task_center_log(
        resolved.ctx,
        task_scope,
        task_type=_ZERO_WRITE_TASK,
        message=running_message,
    )

    async def runner(prompt_text: str, effort: str) -> str:
        return await default_repair_runner(
            prompt_text,
            effort,
            system_prompt=ZERO_WRITE_SYSTEM_PROMPT,
            agent_name="从零写第 1 稿",
        )

    try:
        content = await generate_first_manuscript(
            prompt,
            runner,
            body.reasoning_effort,
            unit=unit,
            number=episode,
            heading_required=episode <= 1,
        )
        issues = quality_issues(content, kind=body.kind)
        if issues:
            corrective = (
                "自动纠偏：上一稿有以下质量问题，请重新生成本集并全部修正：\n"
                + "\n".join(f"- {issue}" for issue in issues)
                + "\n\n"
                + prompt
            )
            try:
                retried = await generate_first_manuscript(
                    corrective,
                    runner,
                    body.reasoning_effort,
                    unit=unit,
                    number=episode,
                    heading_required=episode <= 1,
                )
                retried_issues = quality_issues(retried, kind=body.kind)
                if len(retried_issues) <= len(issues):
                    content, issues = retried, retried_issues
            except ValueError:
                pass  # 纠偏稿自身没通过提取时保留第一稿
        full_text = existing_text.rstrip() + "\n\n" + content if append_mode else content
        preview = build_chapter_preview(
            full_text,
            include_scene_blocks=spine_template != "narrated",
        )
        format_check = build_import_format_check(
            full_text,
            has_chapters=bool(preview.get("chapters")),
            chapters=preview.get("chapters"),
            require_scene_headers=spine_template == "drama",
        )
        gate_error = f"写出来的第 {episode} {unit}没有通过格式检查，请再点一次重写。"
        if not preview.get("chapters") or format_check["level"] == "blocking":
            _task_center_log(
                resolved.ctx,
                task_scope,
                task_type=_ZERO_WRITE_TASK,
                message=gate_error,
                status="failed",
            )
            return {"ok": False, "error": gate_error}
        if len(full_text.encode("utf-8")) > MAX_NOVEL_IMPORT_BYTES:
            size_error = f"第 {episode} {unit}超过可导入文件大小限制，未保存"
            _task_center_log(
                resolved.ctx,
                task_scope,
                task_type=_ZERO_WRITE_TASK,
                message=size_error,
                status="failed",
            )
            return {"ok": False, "error": size_error}

        if append_mode:
            candidate = target_name
            target = uploads_dir / candidate
            _save_working_copy(target, full_text)
        else:
            stem_prefix = f"第 1 {unit}-{body.premise[:12]}"
            candidate = sanitize_upload_filename(f"{stem_prefix}.txt")
            suffix = 2
            while (uploads_dir / candidate).exists():
                candidate = sanitize_upload_filename(f"{stem_prefix}-{suffix}.txt")
                suffix += 1
            if not is_safe_upload_target(uploads_dir, candidate):
                name_error = "无法生成安全的文件名"
                _task_center_log(
                    resolved.ctx,
                    task_scope,
                    task_type=_ZERO_WRITE_TASK,
                    message=name_error,
                    status="failed",
                )
                return {"ok": False, "error": name_error}
            target = uploads_dir / candidate
            _save_working_copy(target, full_text)
        upload = {
            "filename": candidate,
            "size": target.stat().st_size,
            "episode": episode,
            **preview,
            "format_check": format_check,
        }
        _task_center_log(
            resolved.ctx,
            task_scope,
            task_type=_ZERO_WRITE_TASK,
            message=f"第 {episode} {unit}已写好：{candidate}",
            status="completed",
        )
        return {"ok": True, "data": {"upload": upload, "quality_issues": issues}}
    except (ValueError, DocumentParseError, OSError) as exc:
        logger.warning("[%s] failed to write first manuscript: %s", project, exc)
        _task_center_log(
            resolved.ctx,
            task_scope,
            task_type=_ZERO_WRITE_TASK,
            message=str(exc),
            status="failed",
        )
        return {"ok": False, "error": str(exc)}
    except Exception as exc:  # 上游网关失败要落到页面，而不是 500
        logger.warning("[%s] write-first model call failed: %s", project, exc)
        message = _repair_failure_message(exc)
        _task_center_log(
            resolved.ctx,
            task_scope,
            task_type=_ZERO_WRITE_TASK,
            message=message,
            status="failed",
        )
        return {"ok": False, "error": message}


@router.post("/projects/{project}/ingest/start")
async def start_ingest(
    project: str, body: IngestStart, user: dict = Depends(require_scope("tasks:submit"))
):
    """触发小说导入（构建知识图谱）。"""
    logger.info("[%s] start_ingest: %s (rebuild=%s)", project, body.filename, body.rebuild)
    resolved = await resolve_project_scope(project, user, required_role="editor")
    ctx = resolved.ctx
    project_dir = resolved.project_dir
    uploads_dir = project_dir / "uploads"
    safe_name = sanitize_upload_filename(body.filename)
    if safe_name != body.filename or not is_safe_upload_target(uploads_dir, safe_name):
        return {"ok": False, "error": "非法文件名"}
    if not is_supported_novel_path(safe_name):
        return _unsupported_format_response(safe_name)
    novel_path = uploads_dir / safe_name

    # Historical projects may only retain the canonical, already-parsed
    # ``novel.txt`` and have no original file under ``uploads/``.  Preserve a
    # durable copy before queuing the rebuild: the Cognee rebuild deliberately
    # removes the canonical marker early, so passing that marker itself to the
    # worker would make a failed rebuild impossible to retry.
    if not novel_path.exists() and safe_name == "novel.txt":
        imported_novel_path = project_dir / "novel.txt"
        if imported_novel_path.is_file():
            uploads_dir.mkdir(parents=True, exist_ok=True)
            try:
                shutil.copy2(imported_novel_path, novel_path)
            except OSError:
                logger.exception("[%s] failed to preserve legacy novel source", project)
                return {"ok": False, "error": "无法保存历史原文，请重新上传后再导入"}

    if not novel_path.exists():
        return {"ok": False, "error": f"File '{body.filename}' not found in uploads/"}

    try:
        if novel_path.stat().st_size > MAX_NOVEL_IMPORT_BYTES:
            return _file_too_large_response(MAX_NOVEL_IMPORT_BYTES)
    except OSError:
        logger.warning("[%s] failed to stat uploaded novel", project, exc_info=True)
        return {"ok": False, "error": "无法读取上传文件，请重新上传后再导入"}

    try:
        content = load_novel_text(novel_path)
        billable_chars = count_billable_novel_chars(content)
        if billable_chars > MAX_NOVEL_IMPORT_CHARS:
            return _text_too_large_response(billable_chars)
    except DocumentParseError as exc:
        return {
            "ok": False,
            "error": f"解析章节失败: {exc}",
            "error_type": "parse",
            "format": exc.source_format,
            "detail": str(exc),
        }
    except Exception:
        logger.warning(
            "[%s] failed to parse uploaded novel for billing",
            project,
            exc_info=True,
        )
        return {"ok": False, "error": "解析章节失败"}

    current_project_config = load_project_config_file_from_state_dir(resolved.state_dir)
    requested_spine_template = str(
        body.spine_template
        or current_project_config.get("spine_template")
        or "drama"
    ).strip()
    effective_spine_template = (
        "narrated" if requested_spine_template == "narrated" else "drama"
    )
    if effective_spine_template == "drama":
        preview = build_chapter_preview(content)
        format_check = build_import_format_check(
            content,
            has_chapters=bool(preview.get("chapters")),
            chapters=preview.get("chapters"),
            require_scene_headers=True,
        )
        if format_check["level"] == "blocking":
            issue_codes = sorted(
                {
                    str(issue.get("code") or "").strip()
                    for issue in format_check.get("issues", [])
                    if str(issue.get("code") or "").strip()
                }
            )
            numeric_metrics = {
                str(key): value
                for key, value in format_check.get("metrics", {}).items()
                if isinstance(value, (int, float)) and not isinstance(value, bool)
            }
            logger.warning(
                "screenplay_format_blocked project=%s filename=%s "
                "spine_template=%s level=%s issue_codes=%s metrics=%s "
                "scene_header_status=%s",
                project,
                safe_name,
                effective_spine_template,
                format_check.get("level", ""),
                issue_codes,
                numeric_metrics,
                format_check.get("scene_header_status", ""),
            )
            return {
                "ok": False,
                "error": format_check["summary"],
                "error_type": "screenplay_format",
                "format_check": format_check,
            }

    config = {
        "rebuild": body.rebuild,
        "spine_template": effective_spine_template,
    }
    # Persist the exact source used by this import. The ingest page can then
    # rebuild from the existing upload without forcing the user to upload again.
    project_config_updates = {"ingest_source_filename": safe_name}
    if body.spine_template is not None:
        if not body.rebuild:
            return {"ok": False, "error": "项目类型只能在重新导入时修改"}
        project_config_updates.update(
            {
                "spine_template": body.spine_template,
                "aspect_ratio": default_aspect_ratio_for_spine_template(
                    body.spine_template
                ),
            }
        )
    save_project_config_in_state_dir(resolved.state_dir, config=project_config_updates)

    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            product_surface="mainline",
            task_type="ingest_fast",
            queue_kind="default",
            episode=0,
            payload={
                "novel_path": str(novel_path),
                "config": config,
                "billing": {
                    "billable_chars": billable_chars,
                    "billing_quantity": billable_chars,
                },
            },
        )
        return {
            "ok": True,
            "task_type": "ingest_fast",
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key("ingest_fast", ctx.project_id, 0),
            "backend": queued.backend,
            "queue": queued.queue,
            "message": f"导入任务已进入队列: {safe_name}",
        }

    return {"ok": False, "error": "导入需要 project context"}
