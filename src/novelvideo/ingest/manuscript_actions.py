"""虾料工作稿的受约束改写动作。"""

from __future__ import annotations

import asyncio
import json
import hashlib
import os
import re
from collections.abc import Awaitable, Callable
from typing import Any
from pathlib import Path

from novelvideo.cognee.chapter_detector import ChapterDetector
from novelvideo.ingest.manuscript_repair import clean_model_text
from novelvideo.utils.screenplay_quality import SCENE_BLOCK_HEADER_RE, SCENE_HEADER_RE

ActionRunner = Callable[[str, str], Awaitable[str]]

ACTION_SYSTEM_PROMPT = """你是虾料的中文小说与短剧稿件编辑。
严格执行用户指定的单一改稿任务，只输出最终正文或指定的 JSON 数据。
不输出分析、计划、自检、解释、Markdown 代码围栏或 _::~RECORD::~_ 等标记。
不得删章、打乱章节顺序或擅自增加原稿没有的剧情。"""

# 开头结构模板蒸馏自 /Users/mac/Downloads/提示词/AI助手 的结构说明与字眼词库。
HOOK_STYLES: dict[str, str] = {
    "default": "用清晰、有吸引力的悬念开场，快速提出本章核心冲突。",
    "reversal": (
        "反转结构：先摆出设定或一件事（我一个…），再反过来（却被…），"
        "具体怎么反转（就连…），递进（甚至…），铺垫（然而…），反转（我却…）。"
        "先呈现结果或反常事实，再揭示冲突起点。"
    ),
    "contrast": (
        "对比结构：人和人、事和事的对比，用「我明明…，却…」的句式，"
        "让违背这个观点的事实开场。"
    ),
    "emotion": (
        "铺垫结构：先借口说一件离谱的事（我吹牛说…），再意料之外的结果（没想到隔天就…），"
        "举例子（就连…），递进（甚至…），铺垫（然而…），反转（却…），接正文（此刻…）。"
    ),
    "burst": (
        "爆点密度：前几行每行埋一个爆点，至少两个爆点；用「半解」钩子——说了但没说完整，"
        "持续往下钩；节奏短促，冲击力强。"
    ),
    "setting": (
        "设定结构：可用「做过…的都知道，不仅…而且…甚至…，而我却…」"
        "或「全国人都以为…，其实…并不是…而是…」的句式，先立设定再反转。"
    ),
    "rebirth": (
        "主题结构：一句话讲明重点（我意外发现/穿越/获得/觉醒…），然而…，就连…，甚至…，"
        "铺垫（然而…），反转（却…），接正文（此刻…）。原稿没有重生或穿越设定时不得凭空添加。"
    ),
}

_CHAPTER_LINE_RE = re.compile(
    r"^(?:#{1,6}\s*)?(?:《[^》\n]{1,40}》\s*)?(?:第\s*[一二三四五六七八九十百千\d]+\s*[章节集回部卷]|Chapter\s*\d+|Episode\s*\d+)(?:$|[\s:：《（(【\[\-—–、.。．])",
    re.IGNORECASE,
)
_SPEAKER_LINE_RE = re.compile(r"^\s*([^：:]{1,24})[：:]")


def _scene_headers(text: str) -> list[str]:
    return [
        line.strip()
        for line in text.splitlines()
        if SCENE_HEADER_RE.fullmatch(line.strip())
        or SCENE_BLOCK_HEADER_RE.fullmatch(line.strip())
    ]


def _speaker_labels(text: str) -> list[str]:
    return [
        match.group(1).strip()
        for line in text.splitlines()
        if not SCENE_HEADER_RE.fullmatch(line.strip())
        and not SCENE_BLOCK_HEADER_RE.fullmatch(line.strip())
        and (match := _SPEAKER_LINE_RE.match(line))
    ]


def _chapter_headings(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines() if _CHAPTER_LINE_RE.match(line.strip())]


def validate_rewrite(
    source: str,
    output: str,
    *,
    preserve_speakers: bool,
    preserve_scene_headers: bool = True,
) -> str:
    cleaned = clean_model_text(output, source_text=source, require_scene_headers=False)
    if len(source) > 200 and len(cleaned) < max(120, int(len(source) * 0.3)):
        raise ValueError("生成结果比原稿短太多，未写入工作稿")
    if _chapter_headings(source) != _chapter_headings(cleaned):
        raise ValueError("生成结果改动了章节标题，未写入工作稿")
    source_lines = source.splitlines()
    output_lines = cleaned.splitlines()
    source_first_heading = next(
        (index for index, line in enumerate(source_lines) if _CHAPTER_LINE_RE.match(line.strip())),
        None,
    )
    output_first_heading = next(
        (index for index, line in enumerate(output_lines) if _CHAPTER_LINE_RE.match(line.strip())),
        None,
    )
    if (
        source_first_heading is not None
        and not any(line.strip() for line in source_lines[:source_first_heading])
        and output_first_heading not in (None, 0)
        and any(line.strip() for line in output_lines[:output_first_heading])
    ):
        raise ValueError("生成结果包含正文以外的前置说明，未写入工作稿")
    source_headers = _scene_headers(source)
    if preserve_scene_headers and source_headers and source_headers != _scene_headers(cleaned):
        raise ValueError("生成结果改动了场景头，未写入工作稿")
    if preserve_speakers and _speaker_labels(source) != _speaker_labels(cleaned):
        raise ValueError("生成结果改动了说话人，未写入工作稿")
    return cleaned


def _build_rewrite_prompt(action: str, source: str, spine_template: str) -> str:
    if action == "wash":
        if spine_template == "narrated":
            rules = (
                "改写各章叙述正文，只换说法，不改情节、顺序、人名、章节标题。"
                "句子尽量短，信息前置：先抛冲突和目标。"
            )
        else:
            rules = (
                "改写动作行和对白正文，只换说法，不改情节、顺序、人名、章节标题、场景头、"
                "说话人名称。人物行和场景头原样保留。对白句子尽量短（一句 15 字左右封顶），"
                "信息前置：先抛身份、冲突、目标。"
            )
        return f"洗稿约束：{rules}\n全文长度尽量接近原稿。只输出完整改写稿。\n\n{source}"
    if action == "imitate":
        return (
            "深挖原稿的叙述节奏、语气、句式和情绪推进，写成一个人物、地点、事件和具体情节"
            "都不同的新故事。不得复用原稿中的独特句子、角色名或事件。保留原稿的章节数量、"
            "章节顺序和标题编号，篇幅与原稿接近。只输出完整新稿。\n\n原稿：\n"
            f"{source}"
        )
    raise ValueError("未知的改稿动作")


async def rewrite_document(
    source: str,
    *,
    action: str,
    spine_template: str,
    runner: ActionRunner,
    reasoning_effort: str = "none",
) -> tuple[str, list[str]]:
    plans = ChapterDetector().detect(source)
    if not plans:
        raise ValueError("没有找到可改写的章节")
    document_lines = source.split("\n")
    outputs: dict[int, str] = {}
    calls: list[str] = []
    semaphore = asyncio.Semaphore(2)

    async def rewrite_chapter(index: int, plan: Any, previous_output: str = "") -> tuple[int, str]:
        chapter_source = plan.content.strip()
        prompt = _build_rewrite_prompt(action, chapter_source, spine_template)
        if action == "imitate" and previous_output:
            prompt = (
                "沿用已写新故事的人物身份、关系和世界设定，保持新故事连续；"
                "不要复用原稿中的名字或具体事件。\n新故事上一章结尾：\n"
                f"{previous_output[-1800:]}\n\n{prompt}"
            )
        async with semaphore:
            raw = await runner(prompt, reasoning_effort)
        cleaned = validate_rewrite(
            chapter_source,
            raw,
            preserve_speakers=action == "wash" and spine_template != "narrated",
            preserve_scene_headers=action != "imitate",
        )
        return index, cleaned

    if action == "imitate":
        previous_output = ""
        for index, plan in enumerate(plans):
            _, cleaned = await rewrite_chapter(index, plan, previous_output)
            outputs[index] = cleaned
            previous_output = cleaned
            calls.append(f"第 {index + 1}/{len(plans)} 章已完成，校验通过（{len(cleaned)} 字）")
    else:
        results = await asyncio.gather(
            *(rewrite_chapter(index, plan) for index, plan in enumerate(plans)),
            return_exceptions=True,
        )
        failures: list[str] = []
        for index, result in enumerate(results):
            if isinstance(result, Exception):
                failures.append(f"第 {index + 1} 章：{result}")
                continue
            completed_index, cleaned = result
            outputs[completed_index] = cleaned
            calls.append(f"第 {completed_index + 1}/{len(plans)} 章已完成，校验通过（{len(cleaned)} 字）")
        if failures:
            raise ValueError("；".join(failures[:5]))

    for index in reversed(range(len(plans))):
        plan = plans[index]
        document_lines[plan.start_line : plan.end_line] = outputs[index].split("\n")
    cleaned_document = "\n".join(document_lines)
    cleaned_document = validate_rewrite(
        source,
        cleaned_document,
        preserve_speakers=action == "wash" and spine_template != "narrated",
        preserve_scene_headers=action != "imitate",
    )
    return cleaned_document, calls


async def rewrite_hook(
    source: str,
    *,
    spine_template: str,
    style: str,
    runner: ActionRunner,
    reasoning_effort: str = "none",
) -> tuple[str, list[str]]:
    style_rule = HOOK_STYLES.get(style)
    if style_rule is None:
        raise ValueError("未知的开头结构")

    detector = ChapterDetector()
    chapters = detector.detect(source)
    if not chapters:
        raise ValueError("没有找到可改写的正文")
    chapter = chapters[0]
    lines = chapter.content.splitlines()

    if spine_template == "drama":
        header_indexes = [
            index
            for index, line in enumerate(lines)
            if SCENE_HEADER_RE.fullmatch(line.strip())
            or SCENE_BLOCK_HEADER_RE.fullmatch(line.strip())
        ]
        if not header_indexes:
            raise ValueError("精品剧工作稿还没有可识别的场景头，请先完成一键修复")
        start = header_indexes[0] + 1
        end = header_indexes[1] if len(header_indexes) > 1 else len(lines)
        original_region = "\n".join(lines[start:end]).strip()
        prompt = (
            f"只重写下面精品剧第一场的动作与对白，使其符合开头结构：{style_rule}\n"
            "保留人物、人名、事件事实和对白的核心意思，不增加原稿没有的情节。"
            "不要输出场景头或章节标题，只输出这一场的动作与对白正文。\n\n"
            f"{original_region}"
        )
        raw = await runner(prompt, reasoning_effort)
        changed = clean_model_text(raw, source_text=original_region, require_scene_headers=False)
        if _scene_headers(changed):
            raise ValueError("模型改动了场景头，未写入工作稿")
        lines[start:end] = changed.splitlines()
        chapter_result = "\n".join(lines)
    else:
        heading = lines[0] if lines and detector._match_chapter(lines[0].strip()) is not None else ""
        body_lines = lines[1:] if heading else lines
        body = "\n".join(body_lines)
        paragraphs = re.split(r"\n\s*\n", body)
        selected_indexes = [index for index, item in enumerate(paragraphs) if item.strip()][:3]
        if not selected_indexes:
            raise ValueError("没有找到可改写的开头段落")
        selected_end = selected_indexes[-1]
        region = "\n\n".join(paragraphs[: selected_end + 1]).strip()
        remainder = paragraphs[selected_end + 1 :]
        prompt = (
            f"只重写小说第一章开头的这几段，采用以下结构：{style_rule}\n"
            "保留人物、事件事实、原有设定和章节标题，不加原稿没有的剧情。只输出改写段落。\n\n"
            f"{region}"
        )
        raw = await runner(prompt, reasoning_effort)
        changed = clean_model_text(raw, source_text=region, require_scene_headers=False)
        output_lines = ([heading] if heading else []) + [changed]
        if remainder:
            output_lines.append("\n\n".join(remainder).strip())
        chapter_result = "\n\n".join(part for part in output_lines if part).strip()

    document_lines = source.split("\n")
    document_lines[chapter.start_line : chapter.end_line] = chapter_result.split("\n")
    result = "\n".join(document_lines)

    if _chapter_headings(source) != _chapter_headings(result):
        raise ValueError("生成结果改动了章节标题，未写入工作稿")
    if _scene_headers(source) != _scene_headers(result):
        raise ValueError("生成结果改动了场景头，未写入工作稿")
    return result, [f"爆款开头（{style}）：只替换首场/首章开头，结构校验通过"]


def _parse_mapping_json(raw: str) -> list[dict[str, Any]]:
    decoder = json.JSONDecoder()
    parsed: dict[str, Any] | None = None
    for match in re.finditer(r"\{", raw):
        try:
            candidate, _ = decoder.raw_decode(raw[match.start() :])
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict) and isinstance(candidate.get("characters"), list):
            parsed = candidate
            break
    if parsed is None:
        raise ValueError("模型没有返回有效的人物对照表，请重新生成")
    rows: list[dict[str, Any]] = []
    for item in parsed["characters"][:200]:
        if not isinstance(item, dict):
            continue
        original = str(item.get("original") or "").strip()
        replacement = str(item.get("replacement") or "").strip()
        if not original:
            continue
        aliases = item.get("aliases")
        replacement_aliases = item.get("replacement_aliases")
        raw_gender = str(item.get("gender") or "unknown").strip().lower()
        gender = {
            "男": "male",
            "男性": "male",
            "man": "male",
            "女": "female",
            "女性": "female",
            "woman": "female",
        }.get(raw_gender, raw_gender)
        if gender not in {"male", "female", "animal", "unknown"}:
            gender = "unknown"
        rows.append(
            {
                "original": original[:100],
                "aliases": [str(value).strip()[:100] for value in aliases[:20] if str(value).strip()]
                if isinstance(aliases, list)
                else [],
                "replacement": replacement[:100],
                "replacement_aliases": [
                    str(value).strip()[:100]
                    for value in replacement_aliases[:20]
                    if str(value).strip()
                ]
                if isinstance(replacement_aliases, list)
                else [],
                "gender": gender,
                "selected": False,
            }
        )
    if not rows:
        raise ValueError("原稿中没有识别到可处理的人物")
    return rows


async def preview_character_map(
    source: str,
    *,
    gender: bool,
    runner: ActionRunner,
    reasoning_effort: str = "none",
) -> tuple[list[dict[str, Any]], list[str]]:
    if gender:
        request = (
            "从原稿识别重要人物，输出性别转换对照表。只包括性别明确的男性或女性人物；"
            "动物和性别不明者不列入。为每人建议转换后的新名字和别称，并标出原性别。"
        )
    else:
        request = (
            "从原稿识别重要角色、人类/动物角色及带姓氏特征的家族称谓，列出主名、别称，"
            "建议一个性别一致的新主名和对应新别称。性别不明时保持未知，不猜测。"
        )
    chapters = ChapterDetector().detect(source)
    if not chapters:
        raise ValueError("没有找到可分析的章节")
    merged: dict[str, dict[str, Any]] = {}
    calls: list[str] = []
    semaphore = asyncio.Semaphore(2)

    async def scan(index: int, chapter_text: str) -> tuple[int, list[dict[str, Any]]]:
        prompt = (
            f"{request}\n只分析这一章，避免列出本章未出现的人物。只输出合法 JSON，格式为 "
            "{\"characters\":[{\"original\":\"原名\",\"aliases\":[\"别称\"],"
            "\"replacement\":\"建议新名\",\"replacement_aliases\":[\"新别称\"],"
            "\"gender\":\"male|female|animal|unknown\"}]}。不得输出解释或 Markdown。\n\n"
            f"原稿：\n{chapter_text}"
        )
        async with semaphore:
            raw = await runner(prompt, reasoning_effort)
        return index, _parse_mapping_json(raw)

    scanned = await asyncio.gather(
        *(scan(index, chapter.content) for index, chapter in enumerate(chapters)),
        return_exceptions=True,
    )
    failures: list[str] = []
    for result in scanned:
        if isinstance(result, Exception):
            failures.append(str(result))
            continue
        index, rows = result
        calls.append(f"第 {index + 1}/{len(chapters)} 章识别到 {len(rows)} 行人物")
        for row in rows:
            current = merged.get(row["original"])
            if current is None:
                merged[row["original"]] = row
                continue
            for key in ("aliases", "replacement_aliases"):
                current[key] = list(dict.fromkeys([*current[key], *row[key]]))
    if failures:
        raise ValueError(f"人物表生成不完整：{failures[0]}，请重试")
    rows = list(merged.values())
    if not rows:
        raise ValueError("原稿中没有识别到可处理的人物")
    calls.append(f"人物对照表：共识别 {len(rows)} 名人物，请确认后应用")
    return rows, calls


def _role_replacements(rows: list[dict[str, Any]]) -> dict[str, str]:
    replacements: dict[str, str] = {}
    for row in rows:
        primary = str(row.get("replacement") or "").strip()
        original = str(row.get("original") or "").strip()
        if not primary or not original:
            continue
        replacements[original] = primary
        aliases = row.get("aliases") or []
        new_aliases = row.get("replacement_aliases") or []
        if isinstance(aliases, list) and isinstance(new_aliases, list):
            for index, old in enumerate(aliases):
                old_name = str(old).strip()
                new_name = str(new_aliases[index]).strip() if index < len(new_aliases) else ""
                if old_name:
                    replacements[old_name] = new_name or primary
    return replacements


def _replace_names(source: str, replacements: dict[str, str]) -> str:
    if not replacements:
        return source
    pattern = re.compile("|".join(re.escape(name) for name in sorted(replacements, key=len, reverse=True)))
    return pattern.sub(lambda match: replacements[match.group(0)], source)


def _replace_names_preserving_structure(source: str, replacements: dict[str, str]) -> str:
    if not replacements:
        return source
    lines = source.split("\n")
    for index, line in enumerate(lines):
        stripped = line.strip()
        if (
            _CHAPTER_LINE_RE.match(stripped)
            or SCENE_HEADER_RE.fullmatch(stripped)
            or SCENE_BLOCK_HEADER_RE.fullmatch(stripped)
        ):
            continue
        lines[index] = _replace_names(line, replacements)
    return "\n".join(lines)


def apply_role_mapping(source: str, rows: list[dict[str, Any]]) -> tuple[str, list[str]]:
    replacements = _role_replacements(rows)
    if not replacements:
        raise ValueError("没有填写要替换的新名字")
    output = _replace_names_preserving_structure(source, replacements)
    if output == source:
        raise ValueError("原文中没有找到对照表里的名字，工作稿未修改")
    return output, [f"换角色：替换 {len(replacements)} 个名称/别称"]


async def rewrite_gender_document(
    source: str,
    *,
    rows: list[dict[str, Any]],
    spine_template: str,
    runner: ActionRunner,
    reasoning_effort: str = "none",
) -> tuple[str, list[str]]:
    selected = [row for row in rows if row.get("selected") and str(row.get("replacement") or "").strip()]
    if not selected:
        raise ValueError("请至少勾选一名要转换的人物，并填写新名字")
    plans = ChapterDetector().detect(source)
    if not plans:
        raise ValueError("没有找到可转换的章节")
    document_lines = source.split("\n")
    outputs: dict[int, str] = {}
    calls: list[str] = []
    semaphore = asyncio.Semaphore(2)

    async def convert(index: int, plan: Any) -> tuple[int, str]:
        prompt = build_gender_prompt(plan.content, selected, spine_template)
        async with semaphore:
            raw = await runner(prompt, reasoning_effort)
        changed = validate_rewrite(
            plan.content,
            raw,
            preserve_speakers=False,
            preserve_scene_headers=True,
        )
        named = _replace_names_preserving_structure(changed, _role_replacements(selected))
        return index, validate_rewrite(
            plan.content,
            named,
            preserve_speakers=False,
            preserve_scene_headers=True,
        )

    results = await asyncio.gather(
        *(convert(index, plan) for index, plan in enumerate(plans)),
        return_exceptions=True,
    )
    failures: list[str] = []
    for index, result in enumerate(results):
        if isinstance(result, Exception):
            failures.append(f"第 {index + 1} 章：{result}")
            continue
        completed_index, output = result
        outputs[completed_index] = output
        calls.append(f"第 {completed_index + 1}/{len(plans)} 章转换完成，校验通过")
    if failures:
        raise ValueError("；".join(failures[:5]))
    for index in reversed(range(len(plans))):
        plan = plans[index]
        document_lines[plan.start_line : plan.end_line] = outputs[index].split("\n")
    output = validate_rewrite(
        source,
        "\n".join(document_lines),
        preserve_speakers=False,
        preserve_scene_headers=True,
    )
    return output, calls


def build_gender_prompt(source: str, rows: list[dict[str, Any]], spine_template: str) -> str:
    selected = [row for row in rows if row.get("selected") and str(row.get("replacement") or "").strip()]
    if not selected:
        raise ValueError("请至少勾选一名要转换的人物，并填写新名字")
    mapping = [
        {
            "原名": row.get("original"),
            "别称": row.get("aliases", []),
            "新名": row.get("replacement"),
            "新别称": row.get("replacement_aliases", []),
            "原性别": row.get("gender"),
        }
        for row in selected
    ]
    structure = (
        "保留章节标题、叙述体裁和段落顺序。"
        if spine_template == "narrated"
        else "保留章节标题、所有场景头、人物行和场景顺序。只调整相关对白和动作正文。"
    )
    return (
        "按以下用户确认的人物表，只转换被勾选人物的性别。同步调整与这些人物直接相关的"
        "代词、亲属称谓、身份词、外貌动作和对白，使前后一致；未选人物不变。"
        f"{structure}不得改变故事情节或增加新人物。只输出完整正文。\n人物表：\n"
        f"{json.dumps(mapping, ensure_ascii=False)}\n\n原稿：\n{source}"
    )


def content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def action_state_path(work_path: Path) -> Path:
    return work_path.with_name(f"{work_path.stem}.actions.json")


def load_action_state(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        value = None
    if not isinstance(value, dict) or not isinstance(value.get("actions"), dict):
        return {"actions": {}}
    return value


def save_action_state(path: Path, state: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)


def prepare_action_baseline(
    state: dict[str, Any], action: str, current: str
) -> tuple[str, dict[str, Any], str]:
    current_hash = content_hash(current)
    actions = state.setdefault("actions", {})
    entry = actions.get(action)
    if isinstance(entry, dict) and entry.get("output_hash") == current_hash:
        baseline = str(entry.get("baseline") or current)
        entry["preview_current_hash"] = current_hash
    else:
        baseline = current
        entry = {
            "baseline": baseline,
            "output_hash": None,
            "preview_current_hash": current_hash,
        }
        actions[action] = entry
    return baseline, state, current_hash


def action_preview_entry(
    state: dict[str, Any], action: str, current_hash: str
) -> dict[str, Any]:
    entry = state.setdefault("actions", {}).get(action)
    if not isinstance(entry, dict) or not isinstance(entry.get("baseline"), str):
        raise ValueError("请先生成这项操作的人物对照表")
    if entry.get("preview_current_hash") != current_hash:
        raise ValueError("工作稿在对照表生成后已变化，请重新生成对照表")
    return entry


def finish_action(
    state: dict[str, Any], action: str, output: str
) -> dict[str, Any]:
    entry = state.setdefault("actions", {}).get(action)
    if not isinstance(entry, dict):
        entry = {"baseline": output}
        state["actions"][action] = entry
    entry["output_hash"] = content_hash(output)
    return state
