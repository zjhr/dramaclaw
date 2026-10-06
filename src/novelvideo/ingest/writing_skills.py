# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab

"""「另写一篇」的技能库：本机共用的一条技能 = 名称 + 说明 + 提示词 + 一问 + 三句灵感。

库存在 ``STATE_DIR/writing-skills.json``，所有项目共用：技能是手艺，不是某一本书的设定。
内置技能的名称与说明由前端 i18n 负责本地化，本模块只提供兜底文案；提示词、问句和灵感
一律是发给模型的中文内容，随库落盘。

新增技能保存时（或改了提示词再保存时）由模型生成这一问和三句灵感；提问过程中的
「换一批」只重写屏幕上的三句，不回写本库。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any

__all__ = [
    "AD_BRIEF",
    "MAX_SKILLS",
    "QUESTION_SYSTEM_PROMPT",
    "WritingSkill",
    "WritingSkillError",
    "WritingSkillStore",
    "build_suggestion_prompt",
    "builtin_skills",
    "generate_question",
    "get_writing_skill_store",
    "reset_writing_skill_store_for_tests",
]

MAX_SKILLS = 60
_NAME_LIMIT = 40
_DESCRIPTION_LIMIT = 120
_PROMPT_LIMIT = 4_000
_QUESTION_LIMIT = 120
_SUGGESTION_LIMIT = 80
_MAX_SUGGESTIONS = 5
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)

# 从零写没有原文，洗稿、换角色、改性格、深挖仿写这类改稿写法不产生额外要求。
# 指令蒸馏自 /Users/mac/Downloads/提示词/AI助手 的结构模板与字眼词库（剥掉转换外壳）。
_SKILL_DIRECTIVES: dict[str, str] = {
    "reversal": (
        "剧情反转：本集至少一次反转，用「设定一件事（我一个…）→ 却被… → 就连… → 甚至… → "
        "然而… → 我却…」的递进句式组织开场的钩子，并让反转贯穿到结尾，推翻观众前面的判断。"
    ),
    "contrast": (
        "勾人反差：给主角或核心关系设计强烈对比，用「我明明…，却…」的句式"
        "（身份、言行或处境的反差），并让反差直接推动冲突。"
    ),
    "emotion": (
        "情绪牵引：先用铺垫把情绪拉满再进入事件——借口说一件离谱的事 → 没想到隔天就… → "
        "就连… → 甚至… → 然而… → 此刻…；用具体细节调动情绪，不急着交代设定。"
    ),
    "burst": (
        "爆点澎湃：开头几段每段埋一个爆点，至少两个爆点；用「半解」钩子——说了但没说完整，"
        "持续往下钩；中段安排一个高能量爆点场面，节奏短促、冲击力强。"
    ),
    "setting": (
        "设定结构：先立设定再反转，可用「做过…的都知道，不仅…而且…甚至…，而我却…」"
        "或「全国人都以为…，其实…并不是…而是…」的句式，让事件从设定里自然长出来。"
    ),
    "rebirth": (
        "穿越重生：主角带穿越、重生或系统类的开局优势，用「我意外（发现/穿越/获得/觉醒）… → "
        "然而… → 就连… → 甚至… → 却… → 此刻…」的句式，并让这个优势在第 1 集就显出效果。"
    ),
    "sweet": (
        "甜宠：甜为主、微虐做辅助；宠爱情节用细节说话——记住对方的喜好和习惯，"
        "不声不响地准备好，偏爱要让周围的人都看见。"
    ),
    "revenge": (
        "复仇打脸：压抑起势、爽感释放；打脸用「装 → 打脸 → 震惊 → 收获」的链条，"
        "对方嚣张在前，打脸在后；打脸时主角必须刚好在场，亲眼看见对方的表情。"
    ),
    "warlord": (
        "战神赘婿：隐藏身份受辱 → 亮身份打脸 → 登顶收束；受辱要具体（被谁、当众、因为什么），"
        "亮身份的反转要干脆。"
    ),
}


#: 体裁自带的提问。广告不问篇幅（锁死 1 集），但必须先知道在卖什么。
AD_BRIEF = {
    "id": "ad-brief",
    "name": "广告提案",
    "description": "卖什么、看完要人做什么",
    "question": "这条广告卖什么，看完要人做什么？",
    "suggestions": [
        "卖一款续航三十天的耳机，看完要人点进链接领券",
        "卖一杯三秒出锅的拌面，看完要人现在就去点外卖",
        "卖一个免安装的游戏加速器，看完要人下载试用三分钟",
    ],
}


class WritingSkillError(ValueError):
    """技能内容或技能操作不合法。原因直接写成给用户看的中文。"""


@dataclass(frozen=True)
class WritingSkill:
    id: str
    name: str
    description: str
    prompt: str
    question: str
    suggestions: tuple[str, ...]
    builtin: bool

    def to_json(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["suggestions"] = list(self.suggestions)
        return payload


# ── 内置技能 ────────────────────────────────────────────────────────────────
# 提示词直接复用 zero_write 已有的写法指令；三句灵感与问句是配套的选题示例。

_BUILTIN_EXTRAS: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "reversal": (
        "这一集要推翻观众前面的哪一个判断？",
        (
            "观众以为他低头忍让，其实早知道对方的底牌",
            "观众以为真千金在乡下受苦，其实户口本上的名字能翻盘",
            "观众以为被辞退的是他，其实交接名单等着他签字",
        ),
    ),
    "contrast": (
        "主角身上哪一组反差最刺眼？",
        (
            "西装革履开会的人，回出租屋蹲在楼梯上啃冷馒头",
            "嘴上说随便他，转头把对方随口一句喜好记了一整年",
            "全公司最凶的项目经理，敢在电梯里替实习生挡一句骂",
        ),
    ),
    "emotion": (
        "开场先用哪一件事把情绪拉满？",
        (
            "婚礼前十分钟收到一条「我们分手吧」",
            "灵堂上，叔叔当众念出欠条上的数字",
            "产房外等了三天，护士推出来的门一直没开",
        ),
    ),
    "burst": (
        "这一集最炸的那一下是什么？",
        (
            "被踩进泥里的人当场亮出集团公章",
            "会议室门被踹开，门外站着全公司最不敢惹的人",
            "直播镜头前她把那份合同撕成两半",
        ),
    ),
    "setting": (
        "这个故事发生在哪套规则里，规则卡住了谁？",
        (
            "这栋楼的规矩是顶楼不能开灯，违者从名册上除名",
            "公司里所有人都知道那条禁令，没人敢问为什么",
            "这个县城只有一条致富的路，走的人都不提代价",
        ),
    ),
    "rebirth": (
        "主角重生或穿越带来的最大优势是什么？",
        (
            "她回到签约前一天，知道谁会在当天毁约",
            "他带着三年前的记忆回来，那个人还没动手",
            "系统告诉他这次只能改一件事",
        ),
    ),
    "sweet": (
        "两人现在卡住的关系是什么？",
        (
            "她借住在他家，每天都要假装只是室友",
            "他单恋她三年，只敢写在自己的备忘录里",
            "婚约还剩三十天，两人都没提",
        ),
    ),
    "revenge": (
        "这一集主角要当场打脸的是谁，他做过什么？",
        (
            "当年把他赶出师门的师兄，如今跪在门口求他",
            "抢走她设计稿的总监，正在年会上念名字领奖",
            "嫌他穷的亲戚，正住在他盖的房子里",
        ),
    ),
    "warlord": (
        "主角被谁当众羞辱，羞辱的具体是什么？",
        (
            "全家宴上，岳父让他跪着给次子敬酒",
            "公司年会上，董事长当众撤了他的职",
            "从前一起扛过枪的兄弟要替他出头，被他拦下",
        ),
    ),
}


_BUILTIN: tuple[WritingSkill, ...] = tuple(
    WritingSkill(
        id=skill_id,
        name=skill_id,
        description="",
        prompt=directive,
        question=_BUILTIN_EXTRAS.get(skill_id, ("", ()))[0],
        suggestions=_BUILTIN_EXTRAS.get(skill_id, ("", ()))[1],
        builtin=True,
    )
    for skill_id, directive in _SKILL_DIRECTIVES.items()
)
_BUILTIN_IDS = frozenset(skill.id for skill in _BUILTIN)


def builtin_skills() -> list[WritingSkill]:
    """内置技能的出厂值。改库不会覆盖它；「恢复默认」回到这里。"""
    return list(_BUILTIN)


# ── 校验 ────────────────────────────────────────────────────────────────────

def _clean(value: Any, limit: int, label: str, *, required: bool = False) -> str:
    if value is None:
        text = ""
    elif isinstance(value, str):
        text = value.strip()
    else:
        raise WritingSkillError(f"{label}格式无效")
    if required and not text:
        raise WritingSkillError(f"请填写{label}")
    if len(text) > limit:
        raise WritingSkillError(f"{label}过长（最多 {limit} 字）")
    return text


def _clean_suggestions(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, (list, tuple)):
        raise WritingSkillError("灵感示例格式无效")
    if len(value) > _MAX_SUGGESTIONS:
        raise WritingSkillError(f"灵感示例最多 {_MAX_SUGGESTIONS} 句")
    lines = [
        _clean(item, _SUGGESTION_LIMIT, f"第 {index + 1} 句灵感")
        for index, item in enumerate(value)
        if isinstance(item, str) and item.strip()
    ]
    return tuple(lines)


def new_skill_id(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    if not _ID_RE.match(slug or ""):
        return f"s-{uuid.uuid4().hex[:10]}"
    return f"{slug}-{uuid.uuid4().hex[:6]}"


# ── 落盘 ────────────────────────────────────────────────────────────────────

def _atomic_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
    os.replace(temp, path)


class WritingSkillStore:
    """技能库的读写。写操作串行化，读操作直接吃内存态。"""

    def __init__(self, root: Path | str) -> None:
        self._path = Path(root) / "writing-skills.json"
        self._lock = asyncio.Lock()
        self._error = ""
        self._overrides: dict[str, dict[str, Any]] = {}
        self._customs: list[dict[str, Any]] = []
        self._load()

    def _load(self) -> None:
        try:
            payload = json.loads(self._path.read_text("utf-8"))
        except FileNotFoundError:
            return
        except (OSError, json.JSONDecodeError):
            self._error = "无法读取本机技能库，原文件已保留"
            return
        if not isinstance(payload, dict) or payload.get("version") != 1:
            self._error = "技能库文件已损坏"
            return
        overrides = payload.get("builtins")
        customs = payload.get("customs")
        if not isinstance(overrides, dict) or not isinstance(customs, list):
            self._error = "技能库文件已损坏"
            return
        known = _BUILTIN_IDS
        self._overrides = {
            str(key): dict(value)
            for key, value in overrides.items()
            if key in known and isinstance(value, dict)
        }
        self._customs = [
            dict(item) for item in customs if isinstance(item, dict) and isinstance(item.get("id"), str)
        ]

    def _assert_loaded(self) -> None:
        if self._error:
            raise WritingSkillError(self._error)

    def _persist(self) -> None:
        _atomic_write(
            self._path,
            {"version": 1, "builtins": self._overrides, "customs": self._customs},
        )

    # ── 读 ────────────────────────────────────────────────────────────────

    def list(self) -> list[WritingSkill]:
        self._assert_loaded()
        skills: list[WritingSkill] = []
        for skill in builtin_skills():
            override = self._overrides.get(skill.id)
            skills.append(replace(skill, **_merged_override(skill, override)) if override else skill)
        for item in self._customs:
            skills.append(_custom_skill(item))
        return skills

    def get(self, skill_id: str) -> WritingSkill | None:
        return next((skill for skill in self.list() if skill.id == skill_id), None)

    def prompts_for(self, skill_ids: list[str]) -> list[str]:
        """取选中技能的提示词，按传入顺序去重。找不到的技能静默跳过。"""
        library = {skill.id: skill.prompt for skill in self.list()}
        seen: set[str] = set()
        lines: list[str] = []
        for skill_id in skill_ids:
            prompt = library.get(skill_id, "").strip()
            if prompt and prompt not in seen:
                seen.add(prompt)
                lines.append(prompt)
        return lines

    # ── 写 ────────────────────────────────────────────────────────────────

    async def create(
        self,
        *,
        name: str,
        description: str,
        prompt: str,
        question: str = "",
        suggestions: list[str] | tuple[str, ...] = (),
    ) -> WritingSkill:
        async with self._lock:
            self._assert_loaded()
            if len(self._customs) + len(_BUILTIN) >= MAX_SKILLS:
                raise WritingSkillError(f"技能库最多 {MAX_SKILLS} 条")
            clean_name = _clean(name, _NAME_LIMIT, "技能名称", required=True)
            if any(skill.name == clean_name for skill in self.list()):
                raise WritingSkillError("已经有同名技能")
            skill = WritingSkill(
                id=new_skill_id(clean_name),
                name=clean_name,
                description=_clean(description, _DESCRIPTION_LIMIT, "一句说明"),
                prompt=_clean(prompt, _PROMPT_LIMIT, "提示词", required=True),
                question=_clean(question, _QUESTION_LIMIT, "问题"),
                suggestions=_clean_suggestions(suggestions),
                builtin=False,
            )
            self._customs.append(skill.to_json())
            self._persist()
            return skill

    async def update(
        self,
        skill_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        prompt: str | None = None,
        question: str | None = None,
        suggestions: list[str] | tuple[str, ...] | None = None,
    ) -> WritingSkill:
        async with self._lock:
            self._assert_loaded()
            if not _ID_RE.match(skill_id):
                raise WritingSkillError("技能不存在")
            clean_name = None if name is None else _clean(name, _NAME_LIMIT, "技能名称", required=True)
            clean_description = (
                None if description is None else _clean(description, _DESCRIPTION_LIMIT, "一句说明")
            )
            clean_prompt = None if prompt is None else _clean(prompt, _PROMPT_LIMIT, "提示词", required=True)
            clean_question = None if question is None else _clean(question, _QUESTION_LIMIT, "问题")
            clean_suggestions = None if suggestions is None else _clean_suggestions(suggestions)

            if skill_id in _BUILTIN_IDS:
                override = dict(self._overrides.get(skill_id, {}))
                for key, value in (
                    ("name", clean_name),
                    ("description", clean_description),
                    ("prompt", clean_prompt),
                    ("question", clean_question),
                    ("suggestions", list(clean_suggestions) if clean_suggestions is not None else None),
                ):
                    if value is not None:
                        override[key] = value
                self._overrides[skill_id] = override
                self._persist()
                updated = self.get(skill_id)
                assert updated is not None  # 内置 id 一定在库里
                return updated

            index = next(
                (i for i, item in enumerate(self._customs) if item.get("id") == skill_id),
                -1,
            )
            if index < 0:
                raise WritingSkillError("技能不存在")
            if clean_name and any(
                skill.name == clean_name for skill in self.list() if skill.id != skill_id
            ):
                raise WritingSkillError("已经有同名技能")
            record = dict(self._customs[index])
            for key, value in (
                ("name", clean_name),
                ("description", clean_description),
                ("prompt", clean_prompt),
                ("question", clean_question),
                ("suggestions", list(clean_suggestions) if clean_suggestions is not None else None),
            ):
                if value is not None:
                    record[key] = value
            self._customs[index] = record
            self._persist()
            return _custom_skill(record)

    async def remove(self, skill_id: str) -> None:
        async with self._lock:
            self._assert_loaded()
            if skill_id in _BUILTIN_IDS:
                raise WritingSkillError("内置技能不能删除，可以改，也可以恢复默认")
            remaining = [item for item in self._customs if item.get("id") != skill_id]
            if len(remaining) == len(self._customs):
                raise WritingSkillError("技能不存在")
            self._customs = remaining
            self._persist()

    async def restore(self, skill_id: str) -> WritingSkill:
        async with self._lock:
            self._assert_loaded()
            if skill_id not in _BUILTIN_IDS:
                raise WritingSkillError("只有内置技能能恢复默认")
            self._overrides.pop(skill_id, None)
            self._persist()
            restored = self.get(skill_id)
            assert restored is not None
            return restored


def _merged_override(skill: WritingSkill, override: dict[str, Any]) -> dict[str, Any]:
    """把库里的覆盖项贴回内置技能，只认自己认识的键。"""
    merged: dict[str, Any] = {}
    if isinstance(override.get("name"), str):
        merged["name"] = override["name"].strip() or skill.name
    if isinstance(override.get("description"), str):
        merged["description"] = override["description"]
    if isinstance(override.get("prompt"), str) and override["prompt"].strip():
        merged["prompt"] = override["prompt"]
    if isinstance(override.get("question"), str):
        merged["question"] = override["question"]
    suggestions = override.get("suggestions")
    if isinstance(suggestions, list):
        merged["suggestions"] = tuple(str(item) for item in suggestions if isinstance(item, str))
    return merged


def _custom_skill(record: dict[str, Any]) -> WritingSkill:
    suggestions = record.get("suggestions")
    return WritingSkill(
        id=str(record.get("id") or ""),
        name=str(record.get("name") or "未命名技能"),
        description=str(record.get("description") or ""),
        prompt=str(record.get("prompt") or ""),
        question=str(record.get("question") or ""),
        suggestions=tuple(str(item) for item in suggestions)
        if isinstance(suggestions, list)
        else (),
        builtin=False,
    )


# ── 问句与灵感生成 ──────────────────────────────────────────────────────────

QUESTION_SYSTEM_PROMPT = (
    "你是短剧和漫剧的选题编辑。你只输出一个 JSON 对象，形如 "
    '{"question": "…", "suggestions": ["…", "…", "…"]}。'
    "不输出解释、Markdown 代码块或任何其他文字。"
)


def build_suggestion_prompt(
    *,
    name: str,
    description: str,
    prompt: str,
    kind: str = "",
    context: str = "",
    avoid: list[str] | tuple[str, ...] = (),
) -> str:
    """把一条技能拼成「生成一问 + 三句灵感」的指令。"""
    lines = [
        f"技能名称：{name.strip() or '（未命名）'}",
        f"一句说明：{description.strip() or '（未填写）'}",
        f"技能提示词：{prompt.strip()}",
    ]
    if kind.strip():
        lines.append(f"成稿类型：{kind.strip()}")
    if context.strip():
        lines.append(f"已经和用户确认过的内容（不要重复问）：\n{context.strip()}")
    avoided = [line.strip() for line in avoid if isinstance(line, str) and line.strip()]
    if avoided:
        lines.append("不要使用下面这些已有的句子，换一批新的：\n" + "\n".join(f"- {line}" for line in avoided))
    return (
        "\n".join(lines)
        + "\n\n请给出：\n"
        "1. question：这条技能最该问清的一件事，只问一件事，一句话，20 到 30 字，末尾一个问号。\n"
        "2. suggestions：三句用户可以直接点选的答案示例，不是解释、不是提问，"
        "每句 12 到 30 字，具体到能写进稿子。\n"
        "只输出 JSON 对象。"
    )


def _extract_json_object(text: str) -> dict[str, Any]:
    candidate = text.strip()
    fence = _FENCE_RE.search(candidate)
    if fence:
        candidate = fence.group(1).strip()
    start = candidate.find("{")
    end = candidate.rfind("}")
    if start >= 0 and end > start:
        candidate = candidate[start : end + 1]
    payload = json.loads(candidate)
    if not isinstance(payload, dict):
        raise ValueError("模型没有返回 JSON 对象")
    return payload


async def generate_question(
    runner: Callable[[str, str], Awaitable[str]],
    *,
    name: str,
    description: str,
    prompt: str,
    reasoning_effort: str = "none",
    kind: str = "",
    context: str = "",
    avoid: list[str] | tuple[str, ...] = (),
) -> tuple[str, tuple[str, ...]]:
    """让模型为一条技能写出一问和三句灵感。生成失败时回落到库里的现成文案。"""
    instruction = build_suggestion_prompt(
        name=name,
        description=description,
        prompt=prompt,
        kind=kind,
        context=context,
        avoid=avoid,
    )
    try:
        output = await runner(instruction, reasoning_effort)
        payload = _extract_json_object(output)
        question = _clean(payload.get("question"), _QUESTION_LIMIT, "问题")
        suggestions = _clean_suggestions(payload.get("suggestions"))
    except (ValueError, TypeError, WritingSkillError, json.JSONDecodeError):
        return "", ()
    if not question:
        return "", ()
    return question, suggestions


# ── 进程级实例 ──────────────────────────────────────────────────────────────

_STORE: WritingSkillStore | None = None


def _default_root() -> Path:
    from novelvideo import config

    return Path(config.STATE_DIR)


def get_writing_skill_store() -> WritingSkillStore:
    global _STORE
    if _STORE is None:
        _STORE = WritingSkillStore(_default_root())
    return _STORE


def reset_writing_skill_store_for_tests() -> None:
    """测试用：丢掉单例。生产代码不该调用。"""
    global _STORE
    _STORE = None
