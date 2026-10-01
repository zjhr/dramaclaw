from __future__ import annotations

import pytest

from novelvideo.ingest.zero_write import (
    ZERO_WRITE_SYSTEM_PROMPT,
    build_write_first_prompt,
    generate_first_manuscript,
    quality_issues,
)


def test_prompt_keeps_single_unit_scope_and_craft():
    prompt = build_write_first_prompt(
        kind="drama",
        premise="雨夜问完那句话",
        lead="林晚",
        count="4",
        skills=["reversal", "wash"],
    )
    assert "第 1 集" in prompt
    assert "雨夜问完那句话" in prompt
    assert "林晚" in prompt
    assert "大约 4 集" in prompt
    assert "剧情反转" in prompt
    assert "内/外" in prompt
    assert "具体角色名" in prompt
    assert "不要写后面各集" in prompt
    assert "洗稿" not in prompt


def test_prompt_novel_variant_and_blank_lead():
    prompt = build_write_first_prompt(
        kind="novel",
        premise="末世种田",
        lead="",
        count="",
        skills=[],
    )
    assert "第 1 章" in prompt
    assert "叙述散文" in prompt
    assert "未指定" in prompt
    assert "按通用写法写" in prompt
    assert "不要写后面各章" in prompt


def test_system_prompt_forbids_process_notes():
    assert "只输出最终正文" in ZERO_WRITE_SYSTEM_PROMPT


def test_quality_issues_flags_short_and_english_residue():
    issues = quality_issues("第 1 集\n巷口 夜 外\nOK fine whatever then", kind="drama")

    assert any("太短" in issue for issue in issues)
    assert any("英文说明" in issue for issue in issues)


def test_quality_issues_flags_too_many_scenes():
    content = "第 1 集\n" + "\n".join(
        f"场景{i} 夜 内\n正文内容。" for i in range(1, 5)
    )

    issues = quality_issues(content, kind="drama")

    assert any("超过上限三场" in issue for issue in issues)


def test_quality_issues_clean_episode_passes():
    scenes = []
    for index in range(1, 4):
        scenes.append(
            "\n".join(
                [
                    f"场景{index} 夜 内",
                    "林晚在雨里走了很久，心里想着那句话。" * 12,
                    "林晚：你来了。",
                    "店主：茶馆打烊了。",
                ]
            )
        )
    content = "第 1 集\n" + "\n".join(scenes)

    assert quality_issues(content, kind="drama") == []


def test_quality_issues_novel_length():
    issues = quality_issues("第 1 章\n短文。", kind="novel")

    assert any("太短" in issue for issue in issues)


def test_prompt_continuation_includes_previous_and_note():
    prompt = build_write_first_prompt(
        kind="drama",
        premise="雨夜问完那句话",
        lead="林晚",
        count="4",
        skills=[],
        episode=2,
        previous_text="第 1 集 雨夜\n巷口 夜 内\n林晚：你来了。",
        note="这集加一个反派",
    )
    assert "续写" in prompt
    assert "第 2 集" in prompt
    assert "上一集全文" in prompt
    assert "这集加一个反派" in prompt
    assert "接住" in prompt
    assert "第 3 集" in prompt


@pytest.mark.asyncio
async def test_generate_second_manuscript_extracts_numbered_heading():
    async def runner(prompt: str, effort: str) -> str:
        return "第 2 集 雨停\n巷口 夜 外\n林晚：跟上。"

    content = await generate_first_manuscript("prompt", runner, "none", unit="集", number=2)

    assert content.startswith("第 2 集")


@pytest.mark.asyncio
async def test_generate_second_manuscript_accepts_chinese_numeral_heading():
    async def runner(prompt: str, effort: str) -> str:
        return "第二集 雨停\n巷口 夜 外\n林晚：跟上。"

    content = await generate_first_manuscript("prompt", runner, "none", unit="集", number=2)

    assert content.startswith("第 2 集")


@pytest.mark.asyncio
async def test_generate_manuscript_rejects_heading_only_output():
    """模型只吐了标题没写正文时按失败处理，触发重试。"""
    calls: list[str] = []

    async def runner(prompt: str, effort: str) -> str:
        calls.append(prompt)
        if len(calls) == 1:
            return "第 2 集"
        return "第 2 集 雨停\n巷口 夜 外\n林晚：跟上。"

    content = await generate_first_manuscript(
        "prompt", runner, "none", unit="集", number=2, heading_required=False
    )

    assert content == "第 2 集\n巷口 夜 外\n林晚：跟上。"
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_generate_first_manuscript_retries_when_output_is_empty():
    calls: list[str] = []

    async def runner(prompt: str, effort: str) -> str:
        calls.append(prompt)
        if len(calls) == 1:
            return "   "
        return "第 1 集 雨夜\n巷口 夜 内\n林晚：你来了。"

    content = await generate_first_manuscript("prompt", runner, "none", unit="集")

    assert content.startswith("第 1 集")
    assert len(calls) == 2
    assert "自动纠偏" in calls[1]


@pytest.mark.asyncio
async def test_generate_first_manuscript_accepts_clean_first_output():
    calls: list[str] = []

    async def runner(prompt: str, effort: str) -> str:
        calls.append(prompt)
        return "第 1 集 雨夜\n巷口 夜 内\n林晚：你来了。"

    content = await generate_first_manuscript("prompt", runner, "low", unit="集")

    assert content.startswith("第 1 集")
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_generate_first_manuscript_strips_planning_before_heading():
    calls: list[str] = []

    async def runner(prompt: str, effort: str) -> str:
        calls.append(prompt)
        return (
            "Requirements:\n- First line: 「第 1 集」 on its own line.\n"
            "Structure plan:\nScene 1: 街道 雨 夜 外 — hook.\n"
            "第 1 集 雨夜\n巷口 夜 内\n林晚：你来了。"
        )

    content = await generate_first_manuscript("prompt", runner, "none", unit="集")

    assert content == "第 1 集\n巷口 夜 内\n林晚：你来了。"
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_generate_first_manuscript_keeps_last_full_pass_after_planning():
    """模型先写英文规划再重写一版时，只留最后一版完整稿。"""
    calls: list[str] = []

    async def runner(prompt: str, effort: str) -> str:
        calls.append(prompt)
        return (
            "第 1 集\n"
            "高架桥下 雨 夜 外\n"
            "Dialogue ideas scene1:\n"
            "陈快脚：（吼）还有三分钟！\n"
            "Scene2: 出租屋 夜 内 Narration: he checks the phone.\n"
            "Names: 陈快脚 consistent. Avoid overlong speeches.\n"
            "高架桥下 雨 夜 外\n"
            "暴雨砸在积水上。陈快脚缩在桥洞深处。\n"
            "陈快脚：还有三分钟！哥，我把电动车蹬出火星子了好吗！\n"
            "出租屋 夜 内\n"
            "十平米隔断间，陈快脚给手肘贴创可贴。\n"
            "废弃公交站 雨 夜 外\n"
            "雨小成了雾。一只黑伞立在场中。\n"
        )

    content = await generate_first_manuscript("prompt", runner, "none", unit="集")

    assert content.startswith("第 1 集\n高架桥下 雨 夜 外\n暴雨砸在积水上。")
    assert "Dialogue ideas" not in content
    assert "Names:" not in content
    assert content.count("高架桥下 雨 夜 外") == 1
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_generate_first_manuscript_keeps_single_draft_with_returning_location():
    """正常单稿回到同一地点时不触发截断。"""
    calls: list[str] = []

    async def runner(prompt: str, effort: str) -> str:
        calls.append(prompt)
        return (
            "第 1 集\n"
            "出租屋 夜 内\n"
            "陈快脚推门进屋。\n"
            "桥上 夜 外\n"
            "他在桥上喘气。\n"
            "出租屋 夜 内\n"
            "他回到屋里躺下。\n"
        )

    content = await generate_first_manuscript("prompt", runner, "none", unit="集")

    assert content.count("出租屋 夜 内") == 2
    assert content.count("桥上 夜 外") == 1
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_generate_first_manuscript_retries_when_heading_missing():
    calls: list[str] = []

    async def runner(prompt: str, effort: str) -> str:
        calls.append(prompt)
        if len(calls) == 1:
            return "Requirements:\n- First line: 「第 1 集」 on its own line.\n"
        return "第 1 集 雨夜\n巷口 夜 内\n林晚：你来了。"

    content = await generate_first_manuscript("prompt", runner, "none", unit="集")

    assert content.startswith("第 1 集")
    assert len(calls) == 2
    assert "自动纠偏" in calls[1]
