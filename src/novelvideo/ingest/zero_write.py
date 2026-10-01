# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab

"""从零写第 1 稿与续写：按四项回答和写法生成或续写章节/集数。

第 1 稿不读取、不修改任何已上传文件；产物另存为新的上传文件。
续写承接已有稿件的最后一集/章，追加写入同一份文件。
"""

import re
from collections.abc import Awaitable, Callable

from novelvideo.ingest.manuscript_repair import _HEADER_LINE_RE, clean_model_text

ZERO_WRITE_SYSTEM_PROMPT = (
    "你是短剧和小说的执笔写手。全文用中文写作。只输出最终正文本身：第一行是章节标题，之后是正文。"
    "不输出解释、分析、计划、自检、大纲或任何过程说明，不使用 Markdown 代码块。"
)

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


def build_write_first_prompt(
    *,
    kind: str,
    premise: str,
    lead: str,
    count: str,
    skills: list[str],
    episode: int = 1,
    previous_text: str = "",
    note: str = "",
) -> str:
    """把四项回答、选中的写法和前情拼成一次写作指令。"""
    unit = "章" if kind == "novel" else "集"
    directives = [text for skill_id, text in _SKILL_DIRECTIVES.items() if skill_id in skills]
    skill_lines = "\n".join(f"- {text}" for text in directives) if directives else "- 按通用写法写。"
    total = f"全剧大约 {count} {unit}" if count.strip() else "篇幅之后还可以调整"
    lead_line = f"主角：{lead.strip()}" if lead.strip() else "主角：未指定，请起一个中文名。"
    continuing = bool(previous_text.strip())

    if kind == "novel":
        craft = (
            "叙述要求：\n"
            f"1. 第一行写「第 {episode} {unit}」，单独成行。\n"
            "2. 正文是叙述散文，用第三人称讲述，段落之间空一行。\n"
            f"3. 开头直接进入情境，冲突或反差先行；结尾留一个让人想看第 {episode + 1} {unit}的钩子。\n"
            "4. 句子短、信息密；多用有推力的字眼：却、竟、不仅、就连、甚至、反而、只因、谁知、偏偏。\n"
            "5. 本章选定一种信息差（读者先知、读者焦急、与主角同步发现）并贯穿始终。\n"
            "6. 全章正文约 2000 到 3500 字。"
        )
    else:
        craft = (
            "单集工艺要求：\n"
            f"1. 第一行写「第 {episode} {unit}」，单独成行。\n"
            "2. 全集最多三场，每场以单独一行的场景头开始，场景头格式是「地点 日/夜 内/外」，例如「出租屋 夜 内」；场景头就是这三段，不要加编号或 Scene 之类的前缀。\n"
            "3. 本集要么压弹簧（误会、压制、危机累积情绪），要么放弹簧（反转、打脸、揭露瞬间释放），没有中间状态。\n"
            f"4. 开场前三行给出钩子；中段安排一次转折；结尾抛出更强的悬念，让观众想看第 {episode + 1} {unit}。\n"
            "5. 对白行格式是「角色：台词」：一句台词一行、一行只有一个说话人；句子短（一句 15 字左右封顶）、不解释（情绪用动作演出来）、信息密；最好的台词是说一半的话，沉默也是台词。\n"
            "6. 说话人必须是具体角色名：出对白的角色都要有名字（如「西装男：」），不能用「男人/女人/对方/电话那头/他/她」当说话人。\n"
            "7. 叙述行写竖屏里看得见的动作和神态，不堆形容词；多用有推力的字眼：却、竟、不仅、就连、甚至、反而、只因、谁知、偏偏、殊不知、话音刚落。\n"
            "8. 本集选定一种信息差（观众先知、观众焦急、与主角同步发现）并贯穿始终。\n"
            "9. 全集正文约 1000 到 1600 字。"
        )

    if continuing:
        previous_block = (
            f"已有前情（上一{unit}全文）：\n{previous_text.strip()}\n\n"
            "承接要求：\n"
            f"1. 直接承接前情：人物、伏笔、时间线和地点要连贯；上一{unit}结尾的钩子要在本{unit}开头接住。\n"
            "2. 新出场的人物用具体名字。\n"
        )
        if note.strip():
            previous_block += f"3. 用户的额外要求：{note.strip()}\n"
        previous_block += "\n"
        note_line = ""
    else:
        previous_block = ""
        note_line = f"- 用户的额外要求：{note.strip()}\n" if note.strip() else ""

    return (
        f"请根据下面的设定，{'续写' if continuing else '写出'}"
        f"这部{'小说' if kind == 'novel' else '短剧'}的第 {episode} {unit}完整正文。\n\n"
        f"- 题材一句话：{premise.strip()}\n"
        f"- {lead_line}\n"
        f"- {total}；这次只写第 {episode} {unit}，不要写后面各{unit}，也不要写大纲。\n"
        f"{note_line}"
        f"写法要求：\n{skill_lines}\n\n"
        f"{previous_block}"
        f"{craft}\n\n"
        f"只交一版最终稿，不要写两版草稿，也不要在正文里写自我点评或修改说明。"
        f"只输出第 {episode} {unit}的正文，不要输出解释、分集梗概、镜号、景别或画面提示词。"
    )


def build_adapt_prompt(source: str) -> str:
    """把一章小说改编成第 1 集场次稿的指令（删减策略来自小说转短剧改编原则）。"""
    return (
        "把下面这章小说改编成短剧第 1 集场次稿。删减策略：删掉不推动主线的日常和环境描写，"
        "合并重复的陷害和误会，训练、赶路、准备类过程用一句叙述带过；"
        "保留高情绪场景、身份反差、信息差和反转打脸。\n"
        "格式：第一行写「第 1 集」，单独成行；之后每场以单独一行的场景头开始，"
        "场景头格式是「地点 日/夜 内/外」，就是这三段，不要加编号或 Scene 之类的前缀；"
        "对白行格式是「角色：台词」，一句台词一行，"
        "说话人必须是具体角色名，句子短（一句 15 字左右封顶）；"
        "全集最多三场，正文约 1000 到 1600 字。\n"
        "只输出改编后的第 1 集正文，不输出解释、大纲或改编说明。\n\n"
        f"小说原文：\n{source}"
    )


def quality_issues(content: str, *, kind: str) -> list[str]:
    """第 1 稿的内容质量守卫：格式门之外的字数、场次数、对白与残留检查。"""
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    body = lines[1:] if lines else []
    text = "".join(body)
    issues: list[str] = []
    if kind == "drama":
        if len(text) < 500:
            issues.append(f"正文只有约 {len(text)} 字，太短（目标 1000 到 1600 字）。")
        elif len(text) > 2500:
            issues.append(f"正文约 {len(text)} 字，超出目标太多（目标 1000 到 1600 字）。")
        scene_count = sum(1 for line in body if _HEADER_LINE_RE.match(line))
        if scene_count == 0:
            issues.append("没有识别到场景头。")
        elif scene_count > 3:
            issues.append(f"场次数 {scene_count} 超过上限三场。")
        dialogue_count = sum(
            1
            for line in body
            if re.match(r"^[^：:]{1,24}[：:]", line) and not _HEADER_LINE_RE.match(line)
        )
        if dialogue_count < 3:
            issues.append(f"对白行只有 {dialogue_count} 行，短剧正文应当以对白推进。")
    else:
        if len(text) < 1200:
            issues.append(f"正文只有约 {len(text)} 字，太短（目标 2000 到 3500 字）。")
        elif len(text) > 5000:
            issues.append(f"正文约 {len(text)} 字，超出目标太多（目标 2000 到 3500 字）。")
    residue = [
        line
        for line in body
        if sum(char.isascii() and char.isalpha() for char in line) >= 8
        and sum("\u4e00" <= char <= "\u9fff" for char in line) == 0
        and not _HEADER_LINE_RE.match(line)
    ]
    if residue:
        issues.append(f"正文混有 {len(residue)} 行英文说明，疑似规划文字残留。")
    return issues


_RETRY_INSTRUCTION = (
    "自动纠偏：上一轮输出混入了任务说明文字，没有通过正文检查。"
    "请忽略上一轮回答，只根据下面的要求重新生成完整稿件。"
    "回答只能包含最终正文，第一行是章节标题，不得出现解释、分析、计划、自检或任何过程说明。\n\n"
)


def _keep_last_full_pass(lines: list[str], unit: str) -> list[str]:
    """模型先写规划再重写一版时，从第一个场景头最后一次出现起留。

    单集最多三场：正常回到同一地点的写法之后最多只剩一个新场景头，
    不会触发；规划加重写则至少跟有两个不同场景头。
    """
    if unit != "集":
        return lines
    header_indexes = [
        index for index, line in enumerate(lines) if _HEADER_LINE_RE.match(line.strip())
    ]
    if len(header_indexes) < 2:
        return lines
    first_header = lines[header_indexes[0]].strip()
    occurrences = [
        index for index in header_indexes if lines[index].strip() == first_header
    ]
    if len(occurrences) < 2:
        return lines
    start = occurrences[-1]
    rest = {lines[index].strip() for index in header_indexes if index > start}
    if len(rest) >= 2:
        return lines[start:]
    return lines


_CN_NUMERALS = ("零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十")


def _unit_number_pattern(number: int, unit: str) -> re.Pattern[str]:
    """匹配「第 N 集/章」标题行，N 支持阿拉伯数字和中文数字。"""
    variants = [str(number)]
    if 1 <= number <= 10:
        variants.append(_CN_NUMERALS[number])
    elif 11 <= number <= 99:
        tens, ones = divmod(number, 10)
        variants.append(f"{_CN_NUMERALS[tens]}十" + (_CN_NUMERALS[ones] if ones else ""))
    return re.compile(rf"^\s*第\s*(?:{'|'.join(variants)})\s*{unit}(?=\s|$)")


def _final_draft(
    output: str,
    unit: str,
    number: int = 1,
    *,
    heading_required: bool = True,
) -> str:
    """清理模型输出：剥掉标题前的前言；模型重写了一版时只留最后一版。"""
    heading = f"第 {number} {unit}"
    try:
        cleaned = clean_model_text(
            output,
            heading=heading,
            source_text=None,
            require_scene_headers=unit == "集",
        )
    except ValueError:
        # 标题路径提不出干净稿时退回无标题清理；缺标题仍会在这里抛错触发重试。
        cleaned = clean_model_text(output)
    pattern = _unit_number_pattern(number, unit)
    lines = cleaned.splitlines()
    heading_indexes = [
        index for index, line in enumerate(lines) if pattern.match(line.strip())
    ]
    if len(heading_indexes) >= 2:
        lines = lines[heading_indexes[-1]:]
    kept = _keep_last_full_pass(lines, unit)
    full_pass_cut = len(kept) != len(lines)
    lines = kept
    for index, line in enumerate(lines):
        if pattern.match(line.strip()):
            body = "\n".join(lines[index + 1:]).strip()
            if not body:
                raise ValueError(f"模型没有写出第 {number} {unit}正文")
            return "\n".join([heading, *lines[index + 1:]]).strip()
    if full_pass_cut or not heading_required:
        # 最后一版完整稿从场景头开始（标题在被打掉的规划段里），或续写时模型
        # 直接接着上文写正文：补回规范标题即可。
        body = "\n".join(lines).strip()
        if not body:
            raise ValueError(f"模型没有写出第 {number} {unit}正文")
        return "\n".join([heading, *lines]).strip()
    raise ValueError(f"模型没有按格式写出第 {number} {unit}标题")


async def generate_first_manuscript(
    prompt: str,
    runner: Callable[[str, str], Awaitable[str]],
    reasoning_effort: str,
    *,
    unit: str,
    number: int = 1,
    heading_required: bool = True,
) -> str:
    """调用文本模型写出第 1 稿；缺标题或混入过程说明时重试一次。"""
    output = await runner(prompt, reasoning_effort)
    try:
        return _final_draft(output, unit, number, heading_required=heading_required)
    except ValueError:
        pass
    output = await runner(_RETRY_INSTRUCTION + prompt, reasoning_effort)
    return _final_draft(output, unit, number, heading_required=heading_required)


__all__ = [
    "ZERO_WRITE_SYSTEM_PROMPT",
    "build_adapt_prompt",
    "build_write_first_prompt",
    "generate_first_manuscript",
    "quality_issues",
]
