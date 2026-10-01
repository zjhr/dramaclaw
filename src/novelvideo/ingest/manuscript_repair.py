# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Turn an uploaded manuscript into a working copy without replacing the original."""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from novelvideo.cognee.chapter_detector import ChapterDetector
from novelvideo.utils.screenplay_quality import build_import_format_check

CHUNK_CHARS = 3500
PARALLEL_CHAPTERS = 2
_RECORD_MARKER = "_::~RECORD::~_"
_HEADING_NOTE = "如果这是第 1 段并且上面给了章节标题，输出的第一行必须原样保留该标题。"

SYSTEM_PROMPT = """你在整理已有稿件，让它能按虾料格式导入。
只输出整理后的正文。任何语言都不要输出解释、分析、计划、自检或过程说明。不要写分镜、镜号、景别，不要输出 _::~RECORD::~_。
不得把故事改成另一部，不得新增情节，不得删掉整章。人名保持不变。"""

RepairRunner = Callable[[str], Awaitable[str]]
logger = logging.getLogger(__name__)
_REPAIR_ATTEMPTS = 2
_CHANNEL_RETRY_ATTEMPTS = 2
_CONTENT_REPAIR_RETRIES = 1
_RETRY_STATUS_CODES = {408, 429, 500, 502, 503, 504, 524}


@dataclass
class ChapterPlan:
    number: int
    heading: str
    chunks: list[str]
    mode: str
    original: str


@dataclass
class RepairAdvance:
    chapter_number: int
    chunk_index: int
    chunk_count: int
    chapter_count: int
    completed_chapters: list[int]
    done: bool
    assembled: str
    error: str | None = None
    needs_choice: bool = False
    choices: list[str] | None = None
    calls: list[str] | None = None


def fresh_progress(spine_template: str) -> dict:
    return {"spine_template": spine_template, "chapters": {}}


def split_chunks(text: str, size: int = CHUNK_CHARS) -> list[str]:
    body = text.strip()
    if not body:
        return []
    if len(body) <= size:
        return [body]
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for paragraph in re.split(r"\n\s*\n", body):
        piece = paragraph.strip()
        if not piece:
            continue
        if len(piece) > size:
            if current:
                chunks.append("\n\n".join(current))
                current = []
                current_len = 0
            for start in range(0, len(piece), size):
                chunks.append(piece[start : start + size])
            continue
        if current and current_len + len(piece) + 2 > size:
            chunks.append("\n\n".join(current))
            current = [piece]
            current_len = len(piece)
            continue
        current.append(piece)
        current_len += len(piece) + 2
    if current:
        chunks.append("\n\n".join(current))
    return chunks


def _split_heading(content: str) -> tuple[str, str]:
    lines = content.splitlines()
    if not lines:
        return "", ""
    first = lines[0].strip()
    if ChapterDetector()._match_chapter(first) is not None:
        return first, "\n".join(lines[1:]).strip()
    return "", content.strip()


def repair_mode(chapter_text: str, spine_template: str) -> str:
    if spine_template == "narrated":
        return "narrated"
    check = build_import_format_check(
        chapter_text,
        has_chapters=True,
        require_scene_headers=True,
    )
    status = check.get("scene_header_status")
    if status == "missing":
        return "to_screenplay"
    if status == "repairable":
        return "fill_headers"
    return "keep"


def plan_chapters(original: str, spine_template: str) -> list[ChapterPlan]:
    plans: list[ChapterPlan] = []
    for chapter in ChapterDetector().detect(original):
        content = (chapter.content or "").strip()
        if not content:
            continue
        heading, body = _split_heading(content)
        chunks = split_chunks(body or content)
        plans.append(
            ChapterPlan(
                number=int(chapter.number),
                heading=heading,
                chunks=chunks or [content],
                mode=repair_mode(content, spine_template),
                original=content,
            )
        )
    return plans


def build_whole_prompt(original: str, spine_template: str) -> str:
    if spine_template == "narrated":
        instruction = (
            "把下面整篇一次整理完。保留章节标题和叙述正文，不要改成对白剧本，"
            "不要删章，不要加情节。只输出正文。"
        )
    else:
        instruction = (
            "把下面整篇一次收成场次稿。保持章节顺序，章节标题行保持原样。"
            "每一场单独一行，写成「地点 日 内」或「地点 夜 外」，下一行起写成「角色：台词」。"
            "不要删章，不要加情节，不要写分镜。只输出全文。"
        )
    return f"{instruction}\n\n{original.strip()}"


def build_prompt(plan: ChapterPlan, chunk: str, index: int) -> str:
    heading_line = (
        f"章节标题：{plan.heading}" if plan.heading else "这一段没有单独的章节标题。"
    )
    if plan.mode == "to_screenplay":
        instruction = (
            "把这一段收成场次稿。每一场第一行写成「地点 日或夜 内或外」，"
            "下一行起写成「角色：台词」。保留已有人名和已经说出口的话，"
            "不要加新情节，不要删掉这段里的事。"
        )
    elif plan.mode == "fill_headers":
        instruction = (
            "只补场景头里缺的地点、日或夜、内或外。对白和动作保持原句。"
            "场景头单独写成一行「地点 日或夜 内或外」。"
        )
    else:
        instruction = "只整理分段。保留叙述正文，不要改成对白剧本，不要增删情节。"
    return (
        f"{heading_line}\n"
        f"这是本章的第 {index} 段，共 {len(plan.chunks)} 段。\n"
        f"{instruction}\n"
        f"{_HEADING_NOTE}\n\n"
        f"{chunk}"
    )


_REASONING_MARKERS = ("The user wants", "I need to", "Let me ", "Write final output")
_FINAL_OUTPUT_DIRECTIVE_RE = re.compile(
    r"write\s+final|output\s+now|compose\s+final|output\s+only|only\s+output|"
    r"produce\s+final|now\s+compose|write\s+out\s+final",
    re.IGNORECASE,
)
_REASONING_LINE_PREFIXES = (
    "order issue:",
    "one more check:",
    "any other:",
    "line:",
    "time: both",
    "do i mark",
    "then next lines",
    "also chapter title",
    "check soldier line",
    "fix typos",
    "check none of",
    "no added plot",
    "no extra commentary",
    "that covers everything",
    "alternatively",
    "overthinking",
    "reception scene starts:",
    "corridor:",
    "that works well",
    "scene names:",
    "phone dialogue:",
    "inner-thought lines",
    "also colon usage:",
    "characters identified:",
    "dialogue in scene",
    "now identifying scenes:",
    "original order",
    "scenes list final:",
    "potential issue:",
    "format check:",
    "length moderate.",
    "i think good.",
    "final check",
    "double-check",
    "trailing divider",
    "one concern:",
    "punctuation normalization:",
    "all covered.",
    "one nuance:",
    "numbering fans:",
    "time-of-day:",
    "hmm the format",
    "better:",
    "honestly,",
    "actually, reconsider",
    "wait",
    "write output",
    "write final",
    "compose final",
    "output now",
    "now compose final",
    "the user wants",
    "i need to",
    "let me ",
)
_INLINE_REASONING_RE = re.compile(
    r"\b(?:wait|hmm|overthinking|put:|one more check|order issue|original order|"
    r"no added plot|the user wants|let me |i need to|i think good|we need|"
    r"format check|scene names|phone dialogue|inner-thought lines)\b",
    re.IGNORECASE,
)
_MODEL_PROCESS_NOTE_RE = re.compile(
    r"\b(?:token\s+budget|compliance|meta\s+commentary|"
    r"manageable\s+effort|fully\s+faithful|sound\s+acceptable|"
    r"lengths?\s+ok|ship\b|proceed\s+fully|no\s+explanation|"
    r"chapter\s+title|user\s+message|punctuation[- ]normalization|"
    r"slight\s+loss|could\s+add|i\s+converted|one\s+thing|"
    r"i\s+think\s+(?:done|good)|establishing|don't\s+add\s+explanation|"
    r"check\s+(?:compliance|trailing|quotes|format|names|"
    r"the\s+.*|once\s+more))\b",
    re.IGNORECASE,
)
_ENGLISH_SPEAKER_LINE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9 _.'’-]{0,30}[:：]")


def _is_chapter_heading(line: str) -> bool:
    stripped = line.strip()
    return stripped.startswith("第") and "章" in stripped[:8]


def _is_reasoning_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped or _HEADER_LINE_RE.match(stripped):
        return False
    if any(marker in stripped for marker in _REASONING_MARKERS):
        return True
    if _MODEL_PROCESS_NOTE_RE.search(stripped):
        return True
    if stripped.startswith(
        ("Better:", "Output only", "Note:", "So I", "So the", "Then ")
    ):
        return True
    letters = sum(char.isascii() and char.isalpha() for char in stripped)
    cjk = sum("\u4e00" <= char <= "\u9fff" for char in stripped)
    return (
        (letters >= 8 and cjk == 0 and not _ENGLISH_SPEAKER_LINE_RE.match(stripped))
        or (letters >= 25 and cjk < 4)
    )


def _without_reasoning_lines(text: str) -> str:
    kept = [line for line in text.splitlines() if not _is_reasoning_line(line)]
    return "\n".join(kept).strip()


def drop_reasoning_preamble(text: str) -> str:
    """流式模型有时先把英文思考写进正文。只留下最后一版场景稿。"""
    lines = text.splitlines()
    if not any(marker in text for marker in _REASONING_MARKERS):
        return text
    heading_indexes = [
        index for index, line in enumerate(lines) if _is_chapter_heading(line)
    ]
    for index in reversed(heading_indexes):
        window = lines[index + 1 : index + 6]
        if any(_HEADER_LINE_RE.match(line.strip()) for line in window) and index > 0:
            return "\n".join(lines[index:]).strip()
    if not heading_indexes:
        return text
    start = heading_indexes[0]
    header_at = next(
        (
            index
            for index in range(start + 1, len(lines))
            if _HEADER_LINE_RE.match(lines[index].strip())
        ),
        None,
    )
    if header_at is None:
        return text
    return "\n".join([lines[start], *lines[header_at:]]).strip()


def _is_model_reasoning_line(line: str, source_lines: set[str]) -> bool:
    stripped = line.strip()
    if not stripped or stripped in source_lines or _HEADER_LINE_RE.match(stripped):
        return False
    lowered = stripped.lower()
    if lowered.startswith(_REASONING_LINE_PREFIXES):
        return True
    if _MODEL_PROCESS_NOTE_RE.search(stripped):
        return True
    if stripped.startswith(("- ", "* ")) and any(
        char.isascii() and char.isalpha() for char in stripped
    ):
        return True
    if _INLINE_REASONING_RE.search(stripped) and any(
        "\u4e00" <= char <= "\u9fff" for char in stripped
    ):
        return True
    latin_letters = sum(char.isascii() and char.isalpha() for char in stripped)
    cjk_letters = sum("\u4e00" <= char <= "\u9fff" for char in stripped)
    if (
        cjk_letters == 0
        and latin_letters >= 8
        and not _ENGLISH_SPEAKER_LINE_RE.match(stripped)
    ):
        return True
    if latin_letters >= 20 and cjk_letters < 5 and not _ENGLISH_SPEAKER_LINE_RE.match(
        stripped
    ):
        return True
    return any(marker.lower() in lowered for marker in _REASONING_MARKERS)


def _first_scene_header_after(lines: list[str], start: int) -> int | None:
    for index in range(start + 1, min(len(lines), start + 8)):
        if not lines[index].strip():
            continue
        return index if _HEADER_LINE_RE.match(lines[index].strip()) else None
    return None


def _extract_safe_final_draft(
    text: str,
    *,
    heading: str,
    source_text: str | None,
    require_scene_headers: bool,
) -> str:
    lines = text.splitlines()
    detector = ChapterDetector()
    chapter_number = detector._match_chapter(heading)
    source_lines = {line.strip() for line in (source_text or "").splitlines()}

    if chapter_number is not None:
        final_markers: list[int] = []
        number_pattern = re.compile(rf"第\s*{chapter_number}\s*章")
        for index, line in enumerate(lines):
            directive = _FINAL_OUTPUT_DIRECTIVE_RE.search(line)
            if directive and number_pattern.search(line[directive.end() :]):
                final_markers.append(index)
        for index in reversed(final_markers):
            if not require_scene_headers or _first_scene_header_after(lines, index):
                return "\n".join([heading, *lines[index + 1 :]]).strip()

    reasoning_indexes = [
        index
        for index, line in enumerate(lines)
        if _is_model_reasoning_line(line, source_lines)
    ]
    if not reasoning_indexes:
        return text

    # 模型常把简短自检插在最终稿中间；逐行识别清楚时可移除说明并保留正文。
    reasoning_index_set = set(reasoning_indexes)
    stripped_lines = [
        line
        for index, line in enumerate(lines)
        if index not in reasoning_index_set
    ]
    stripped_text = "\n".join(stripped_lines).strip()
    if stripped_text:
        if chapter_number is None:
            has_heading = any(_is_chapter_heading(line) for line in stripped_lines)
            has_scene = any(_HEADER_LINE_RE.match(line.strip()) for line in stripped_lines)
            if has_heading and (not require_scene_headers or has_scene):
                return stripped_text
        else:
            heading_indexes = [
                index
                for index, line in enumerate(stripped_lines)
                if detector._match_chapter(line.strip()) == chapter_number
            ]
            if heading_indexes:
                start = heading_indexes[-1]
                if (
                    not require_scene_headers
                    or _first_scene_header_after(stripped_lines, start) is not None
                ):
                    return "\n".join([heading, *stripped_lines[start + 1 :]]).strip()

    last_reasoning = max(reasoning_indexes)
    if chapter_number is not None:
        final_headings = [
            index
            for index in range(last_reasoning + 1, len(lines))
            if detector._match_chapter(lines[index].strip()) == chapter_number
            and _first_scene_header_after(lines, index) is not None
        ]
        if final_headings:
            index = final_headings[-1]
            return "\n".join([heading, *lines[index + 1 :]]).strip()

    if require_scene_headers:
        earlier_headers = {
            line.strip()
            for line in lines[: last_reasoning + 1]
            if _HEADER_LINE_RE.match(line.strip())
        }
        for index in range(last_reasoning + 1, len(lines)):
            header = lines[index].strip()
            if _HEADER_LINE_RE.match(header) and header in earlier_headers:
                return "\n".join([heading, *lines[index:]]).strip()

    raise ValueError("模型输出含有思路说明，无法安全分离最终稿")


def clean_model_text(
    text: str,
    *,
    heading: str | None = None,
    source_text: str | None = None,
    require_scene_headers: bool = True,
) -> str:
    cleaned = str(text or "").strip()
    if cleaned.startswith("```"):
        lines = cleaned.splitlines()[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()
    if heading:
        cleaned = _extract_safe_final_draft(
            cleaned,
            heading=heading,
            source_text=source_text,
            require_scene_headers=require_scene_headers,
        )
        source_lines = {line.strip() for line in (source_text or "").splitlines()}
        if any(
            _is_model_reasoning_line(line, source_lines)
            for line in cleaned.splitlines()
        ):
            raise ValueError("模型输出含有思路说明，无法安全分离最终稿")
    else:
        if any(_is_reasoning_line(line) for line in cleaned.splitlines()):
            cleaned = _without_reasoning_lines(drop_reasoning_preamble(cleaned))
        if any(_is_reasoning_line(line) for line in cleaned.splitlines()):
            raise ValueError("模型把思考过程写进了正文")
    if _RECORD_MARKER in cleaned:
        raise ValueError("模型输出了不允许的标记")
    if not cleaned:
        raise ValueError("模型没有返回正文")
    return cleaned


def _is_reasoning_contamination_error(error: BaseException) -> bool:
    message = str(error)
    return "思路说明" in message or "思考过程" in message


def _build_content_retry_prompt(prompt: str) -> str:
    return (
        "自动纠偏：上一轮输出混入了任务说明文字，没有通过正文检查。"
        "请忽略上一轮回答，只根据下面的原始要求和原文重新生成完整稿件。"
        "回答只能包含最终正文，不得出现解释、分析、计划、自检或任何过程说明。\n\n"
        f"{prompt}"
    )


async def _generate_clean_chapter(
    plan: ChapterPlan,
    spine_template: str,
    runner: RepairRunner,
) -> tuple[str, int]:
    prompt = build_whole_prompt(plan.original, spine_template)
    for retry_count in range(_CONTENT_REPAIR_RETRIES + 1):
        attempt_prompt = (
            prompt if retry_count == 0 else _build_content_retry_prompt(prompt)
        )
        output = await runner(attempt_prompt)
        try:
            cleaned = clean_model_text(
                output,
                heading=plan.heading,
                source_text=plan.original,
                require_scene_headers=plan.mode != "narrated",
            )
        except ValueError as exc:
            if (
                retry_count >= _CONTENT_REPAIR_RETRIES
                or not _is_reasoning_contamination_error(exc)
            ):
                if retry_count:
                    raise ValueError(f"自动纠偏后仍失败：{exc}") from exc
                raise
            logger.warning(
                "虾料改稿第 %s 章输出混入说明文字，自动重新生成最终稿",
                plan.number,
            )
            continue
        return cleaned, retry_count
    raise AssertionError("内容纠偏重试循环异常结束")


def ensure_heading(text: str, heading: str) -> str:
    """确保工作稿只保留当前章节的标题，避免预览把同章正文再次切开。"""
    body = text.strip()
    if not heading:
        return body

    detector = ChapterDetector()
    chapter_number = detector._match_chapter(heading)
    if chapter_number is None:
        return body if body.startswith(heading) else f"{heading}\n{body}"

    lines = body.splitlines()
    normalized: list[str] = []
    heading_seen = False
    for line in lines:
        if detector._match_chapter(line.strip()) != chapter_number:
            normalized.append(line)
            continue
        if heading_seen:
            continue
        normalized.append(heading)
        heading_seen = True

    if not heading_seen:
        normalized.insert(0, heading)
    return "\n".join(normalized).strip()


_PLACE_RE = re.compile(
    r"(办公室|营区|训练场|宿舍|会议室|操场|广场|房间|客厅|卧室|街道|门口|医院|学校|茶馆|巷口|工位)"
)
_HEADER_LINE_RE = re.compile(
    r"^[\u4e00-\u9fffA-Za-z0-9·《》、 ]{2,40}\s+(?:日|夜|白天|深夜|黄昏|清晨|凌晨|上午|下午|傍晚|夜晚)\s+(?:内|外)$"
)
_FALLBACK_HEADERS = ("室内 日 内", "室外 日 外", "室内 夜 内")


def scene_header_status(text: str) -> str:
    check = build_import_format_check(
        text,
        has_chapters=True,
        require_scene_headers=True,
    )
    return str(check.get("scene_header_status") or "")


def header_is_usable(line: str) -> bool:
    header = line.strip()
    if not _HEADER_LINE_RE.match(header):
        return False
    sample = f"第1章 试探\n{header}\n甲：好。"
    return scene_header_status(sample) != "missing"


def suggest_scene_headers(text: str) -> list[str]:
    """Offer scene-header choices. The user picks one or types their own."""

    time_token = "夜" if re.search(r"夜|凌晨|深夜", text) else "日"
    choices: list[str] = []
    for match in _PLACE_RE.finditer(text):
        header = f"{match.group(1)} {time_token} 内"
        if header in choices or not header_is_usable(header):
            continue
        choices.append(header)
        if len(choices) >= 3:
            break
    for header in _FALLBACK_HEADERS:
        if header not in choices:
            choices.append(header)
        if len(choices) >= 4:
            break
    return choices


def apply_scene_header(text: str, heading: str, header: str) -> str:
    if not header_is_usable(header):
        raise ValueError("场景头要单独写成一行，例如「办公室 日 内」。")
    lines = text.splitlines()
    insert_at = 1 if heading and lines and lines[0].strip() == heading else 0
    while insert_at < len(lines) and not lines[insert_at].strip():
        insert_at += 1
    lines.insert(insert_at, header.strip())
    return "\n".join(lines)


def validate_chapter(text: str, plan: ChapterPlan) -> None:
    if plan.mode == "narrated":
        if len(plan.original) > 80 and len(text) < int(len(plan.original) * 0.4):
            raise ValueError("整理后的正文短了太多")
        return
    if plan.mode == "keep":
        return
    check = build_import_format_check(
        text,
        has_chapters=True,
        require_scene_headers=True,
    )
    if check.get("scene_header_status") == "missing":
        raise ValueError("这一章还没有场景头")


def assemble_manuscript(plans: list[ChapterPlan], progress: dict) -> str:
    stored = progress.get("chapters") or {}
    blocks: list[str] = []
    for plan in plans:
        state = stored.get(str(plan.number)) or {}
        if state.get("done") and str(state.get("text") or "").strip():
            blocks.append(ensure_heading(str(state["text"]), plan.heading))
        else:
            blocks.append(plan.original.strip())
    return "\n\n".join(block for block in blocks if block)


def _snapshot(
    plans: list[ChapterPlan],
    progress: dict,
    *,
    chapter_number: int,
    chunk_index: int,
    chunk_count: int,
    done: bool,
    error: str | None = None,
    needs_choice: bool = False,
    choices: list[str] | None = None,
    calls: list[str] | None = None,
) -> RepairAdvance:
    completed = [
        plan.number
        for plan in plans
        if (progress.get("chapters") or {}).get(str(plan.number), {}).get("done")
    ]
    return RepairAdvance(
        chapter_number=chapter_number,
        chunk_index=chunk_index,
        chunk_count=chunk_count,
        chapter_count=len(plans),
        completed_chapters=completed,
        done=done,
        assembled=assemble_manuscript(plans, progress),
        error=error,
        needs_choice=needs_choice,
        choices=list(choices or []),
        calls=list(calls or []),
    )


def _close_finished_parts(plan: ChapterPlan, state: dict) -> str | None:
    """Return ``choice`` or an error string. ``None`` means the chapter is done."""

    try:
        _finish_chapter(plan, state)
    except ValueError as exc:
        if str(exc) != "这一章还没有场景头":
            state["parts"] = []
            state["done"] = False
            return str(exc)
        draft = ensure_heading("\n\n".join(state.get("parts") or []), plan.heading)
        state["parts"] = []
        state["done"] = False
        state["awaiting_header"] = True
        state["draft"] = draft
        return "choice"
    return None


def _finish_chapter(plan: ChapterPlan, state: dict) -> None:
    text = ensure_heading("\n\n".join(state.get("parts") or []), plan.heading)
    validate_chapter(text, plan)
    state["text"] = text
    state["done"] = True
    state["awaiting_header"] = False
    state["draft"] = ""
    state["parts"] = []


async def advance_manuscript_repair(
    original: str,
    progress: dict,
    *,
    spine_template: str,
    runner: RepairRunner,
    restart: bool = False,
    chosen_header: str | None = None,
) -> RepairAdvance:
    """Repair several chapters at once. Each chapter is its own model request."""

    if restart:
        progress["chapters"] = {}
        progress["whole_called"] = False
    progress.setdefault("chapters", {})
    plans = plan_chapters(original, spine_template)
    if not plans:
        raise ValueError("没有可整理的正文")

    for plan in plans:
        state = progress["chapters"].setdefault(
            str(plan.number),
            {"parts": [], "done": False, "text": ""},
        )
        if state.get("done"):
            if state.get("text"):
                try:
                    cleaned = clean_model_text(
                        str(state["text"]),
                        heading=plan.heading,
                        source_text=plan.original,
                        require_scene_headers=spine_template != "narrated",
                    )
                    cleaned = ensure_heading(cleaned, plan.heading)
                    validate_chapter(cleaned, plan)
                    state["text"] = cleaned
                except ValueError:
                    # 旧版已保存稿可能带有模型自检；不再把它当作完成稿复用。
                    state["done"] = False
                    state["text"] = ""
                    state["parts"] = []
                    state["awaiting_header"] = False
                    state["draft"] = ""
            else:
                state["done"] = False
                state["text"] = ""
                state.setdefault("parts", [])
                state.setdefault("awaiting_header", False)
                state.setdefault("draft", "")
                continue
            continue
        if state.get("awaiting_header"):
            draft = str(state.get("draft") or "")
            choices = suggest_scene_headers(draft or plan.original)
            if not chosen_header:
                return _snapshot(
                    plans,
                    progress,
                    chapter_number=plan.number,
                    chunk_index=0,
                    chunk_count=len(plan.chunks),
                    done=False,
                    needs_choice=True,
                    choices=choices,
                )
            try:
                text = apply_scene_header(draft, plan.heading, chosen_header)
                validate_chapter(text, plan)
            except ValueError as exc:
                return _snapshot(
                    plans,
                    progress,
                    chapter_number=plan.number,
                    chunk_index=0,
                    chunk_count=len(plan.chunks),
                    done=False,
                    error=str(exc),
                    needs_choice=True,
                    choices=choices,
                )
            state["text"] = text
            state["done"] = True
            state["awaiting_header"] = False
            state["draft"] = ""
            state["parts"] = []
            return _snapshot(
                plans,
                progress,
                chapter_number=plan.number,
                chunk_index=len(plan.chunks) or 1,
                chunk_count=len(plan.chunks) or 1,
                done=False,
            )
        if plan.mode == "keep":
            state["text"] = plan.original.strip()
            state["done"] = True
            state["parts"] = []

    pending = [
        plan
        for plan in plans
        if not (progress["chapters"].get(str(plan.number)) or {}).get("done")
        and not (progress["chapters"].get(str(plan.number)) or {}).get(
            "awaiting_header"
        )
        and plan.mode != "keep"
    ]
    if pending:
        wave = pending[:PARALLEL_CHAPTERS]
        outputs = await asyncio.gather(
            *(
                _generate_clean_chapter(plan, spine_template, runner)
                for plan in wave
            ),
            return_exceptions=True,
        )
        first_error: str | None = None
        choice_plan: ChapterPlan | None = None
        call_notes: list[str] = []
        for plan, output in zip(wave, outputs, strict=True):
            state = progress["chapters"][str(plan.number)]
            if isinstance(output, Exception):
                first_error = first_error or str(output)
                call_notes.append(f"第 {plan.number} 章调用失败：{output}")
                continue
            cleaned, content_retry_count = output
            if len(plan.original) > 400 and len(cleaned) < int(
                len(plan.original) * 0.2
            ):
                first_error = first_error or f"第 {plan.number} 章返回的正文短了太多"
                call_notes.append(f"第 {plan.number} 章返回的正文短了太多")
                continue
            preview = cleaned.replace("\n", " ")[:120]
            state["parts"] = [cleaned]
            closed = _close_finished_parts(plan, state)
            if closed == "choice" and choice_plan is None:
                choice_plan = plan
                call_notes.append(f"第 {plan.number} 章没有场景头。输出：{preview}")
            elif closed and closed != "choice":
                first_error = first_error or closed
                call_notes.append(f"第 {plan.number} 章未通过：{closed}")
            elif content_retry_count:
                call_notes.append(
                    f"第 {plan.number} 章首次输出混入说明，自动重试后已收好。输出：{preview}"
                )
            else:
                call_notes.append(f"第 {plan.number} 章已收好。输出：{preview}")
        if choice_plan is not None:
            draft = str(
                progress["chapters"][str(choice_plan.number)].get("draft") or ""
            )
            return _snapshot(
                plans,
                progress,
                chapter_number=choice_plan.number,
                chunk_index=0,
                chunk_count=1,
                done=False,
                needs_choice=True,
                choices=suggest_scene_headers(draft or choice_plan.original),
                calls=call_notes,
            )
        if first_error:
            return _snapshot(
                plans,
                progress,
                chapter_number=wave[0].number,
                chunk_index=0,
                chunk_count=1,
                done=False,
                error=first_error,
                calls=call_notes,
            )
        remaining = [
            plan
            for plan in plans
            if not (progress["chapters"].get(str(plan.number)) or {}).get("done")
            and plan.mode != "keep"
        ]
        return _snapshot(
            plans,
            progress,
            chapter_number=wave[-1].number,
            chunk_index=1,
            chunk_count=1,
            done=not remaining,
            calls=call_notes,
        )

    return _snapshot(
        plans,
        progress,
        chapter_number=plans[-1].number,
        chunk_index=0,
        chunk_count=0,
        done=True,
    )


_REASONING_EFFORTS = {"none", "low", "medium", "high"}


def repair_model_settings(reasoning_effort: str | None) -> dict[str, str]:
    effort = str(reasoning_effort or "none").strip().lower()
    if effort not in _REASONING_EFFORTS:
        effort = "none"
    return {"openai_reasoning_effort": effort}


def repair_upstream_should_retry(exc: BaseException) -> bool:
    """判断上游故障是否值得重试；内容错误和鉴权错误不重试。"""
    status = getattr(exc, "status_code", None)
    body = getattr(exc, "body", None)
    error_type = body.get("type") if isinstance(body, dict) else None
    error_code = body.get("code") if isinstance(body, dict) else None
    text = str(exc).lower()
    if any(
        marker in text
        for marker in (
            "expecting value",
            "unexpected end of json input",
            "error processing stream token data",
            "jsondecodeerror",
        )
    ):
        return True
    if (status == 404 and error_type == "model_not_found") or (
        status == 500 and error_code == "do_request_failed"
    ):
        return True
    if isinstance(status, int):
        return status in _RETRY_STATUS_CODES
    from pydantic_ai.exceptions import ModelAPIError, ModelHTTPError

    if isinstance(exc, ModelAPIError) and not isinstance(exc, ModelHTTPError):
        return True
    if isinstance(exc, (TimeoutError, asyncio.TimeoutError)):
        return True
    return any(
        marker in text
        for marker in (
            "proxy read timeout",
            "timed out",
            "timeout",
            "server disconnected",
            "connection reset",
            "incomplete chunked read",
            "peer closed connection",
            "ended without content",
        )
    )


def _is_channel_selection_failure(exc: BaseException) -> bool:
    status = getattr(exc, "status_code", None)
    body = getattr(exc, "body", None)
    if not isinstance(body, dict):
        return False
    return status == 404 and body.get("type") == "model_not_found"


async def stream_repair_text(agent: Any, prompt: str) -> str:
    """流式读完一章。上游只要开始吐字，120 秒静默限制就不会按整章耗时切断。"""
    async with agent.run_stream(prompt) as response:
        output = await response.get_output()
    if not isinstance(output, str):
        return "" if output is None else str(output)
    return output


async def run_repair_with_retry(
    agent: Any,
    prompt: str,
    *,
    channel_retry_attempts: int | None = None,
    transient_retry_attempts: int = _REPAIR_ATTEMPTS,
) -> str:
    channel_retry_limit = (
        _CHANNEL_RETRY_ATTEMPTS
        if channel_retry_attempts is None
        else max(1, channel_retry_attempts)
    )
    transient_retry_limit = max(1, transient_retry_attempts)
    channel_failures = 0
    transient_failures = 0
    while True:
        try:
            return await stream_repair_text(agent, prompt)
        except Exception as exc:
            if not repair_upstream_should_retry(exc):
                raise
            if _is_channel_selection_failure(exc):
                channel_failures += 1
                if channel_failures >= channel_retry_limit:
                    raise
                attempt = channel_failures
                limit = channel_retry_limit
            else:
                transient_failures += 1
                if transient_failures >= transient_retry_limit:
                    raise
                attempt = transient_failures
                limit = transient_retry_limit
            logger.warning(
                "虾料改稿流式调用失败，第 %s/%s 次尝试后重试：%s",
                attempt,
                limit,
                exc,
            )
            await asyncio.sleep(min(0.25 * attempt, 1.0))


async def run_repair_with_fallback(
    prompt: str,
    primary_runner: RepairRunner,
    fallback_runner: RepairRunner | None = None,
) -> str:
    try:
        return await primary_runner(prompt)
    except Exception as exc:
        if fallback_runner is None or not repair_upstream_should_retry(exc):
            raise
        logger.warning("虾料改稿主模型调用失败，切换备用别名后重试：%s", exc)
        return await fallback_runner(prompt)


async def default_repair_runner(
    prompt: str,
    reasoning_effort: str = "none",
    *,
    system_prompt: str = SYSTEM_PROMPT,
    agent_name: str = "虾料改稿",
) -> str:
    from pydantic_ai import Agent

    from novelvideo.config import (
        get_newapi_text_model_name,
        get_newapi_text_pydantic_model,
    )

    default_model = "DC-cognee-LLM"
    model_name = get_newapi_text_model_name("MANUSCRIPT_REPAIR_MODEL", default_model)
    fallback_model = None
    if model_name == default_model:
        fallback_model = get_newapi_text_model_name(
            "MANUSCRIPT_REPAIR_FALLBACK_MODEL", "DC-cognee-LLM"
        )

    async def invoke(name: str, channel_attempts: int, transient_attempts: int) -> str:
        agent = Agent(
            get_newapi_text_pydantic_model(
                "MANUSCRIPT_REPAIR_MODEL",
                default_model,
                model_name_override=name,
                capability="text.generate",
            ),
            system_prompt=system_prompt,
            output_type=str,
            name=agent_name,
            model_settings=repair_model_settings(reasoning_effort),
        )
        return await run_repair_with_retry(
            agent,
            prompt,
            channel_retry_attempts=channel_attempts,
            transient_retry_attempts=transient_attempts,
        )

    async def primary_runner(repair_prompt: str) -> str:
        has_fallback = bool(fallback_model and fallback_model != model_name)
        channel_attempts = 1 if has_fallback else _CHANNEL_RETRY_ATTEMPTS
        transient_attempts = 1 if has_fallback else _REPAIR_ATTEMPTS
        return await invoke(model_name, channel_attempts, transient_attempts)

    fallback_runner = None
    if fallback_model and fallback_model != model_name:

        async def fallback_runner(repair_prompt: str) -> str:
            return await invoke(fallback_model, 2, _REPAIR_ATTEMPTS)

    return await run_repair_with_fallback(prompt, primary_runner, fallback_runner)
