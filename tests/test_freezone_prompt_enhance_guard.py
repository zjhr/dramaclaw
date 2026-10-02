# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""提示词强化的结果护栏。

部分渠道会忽略 reasoning_effort=none，把思考过程写回 enhanced_text 而把
changes 留空。护栏要拦住这种情况，否则用户会把思路说明当成提示词。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from novelvideo.freezone import text_node
from novelvideo.freezone.text_node import _looks_like_enhance_reasoning

REASONING_SAMPLE = """Let me carefully parse this task.

Dialect: seedance-2.0. Strength: standard.

Source prompt: "女孩转身跑向门口" — Girl turns around.
"""

REAL_PROMPT_SAMPLE = (
    "继续上一段视频的末尾画面无缝衔接，镜头跟随主体：一位扎着马尾辫的年轻女孩，"
    "身穿白色短袖T恤。\n\n场景：白天的普通居家客厅内。\n\n运镜：中景跟拍。"
)


@pytest.mark.parametrize(
    "text",
    [
        REASONING_SAMPLE,
        "I need to rewrite this prompt for Seedance.",
        "First, let me consider the dialect constraints.",
        "Thinking: the scene needs a light source.",
    ],
)
def test_detects_reasoning_prefixed_output(text: str) -> None:
    assert _looks_like_enhance_reasoning(text) is True


@pytest.mark.parametrize(
    "text",
    [
        REAL_PROMPT_SAMPLE,
        "Let the camera push in slowly as she turns.",
        "",
    ],
)
def test_accepts_real_prompt_output(text: str) -> None:
    assert _looks_like_enhance_reasoning(text) is False


@pytest.mark.asyncio
async def test_enhance_rejects_reasoning_instead_of_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_run(*_args, **_kwargs):
        return SimpleNamespace(
            output=SimpleNamespace(enhanced_text=REASONING_SAMPLE, changes=[])
        )

    monkeypatch.setattr(text_node, "run_agent_with_transport_compat", fake_run)
    monkeypatch.setattr(text_node, "get_freezone_prompt_enhance_agent", lambda: None)
    monkeypatch.setattr(text_node, "resolve_freezone_prompt_enhance_model", lambda: "test")

    with pytest.raises(ValueError, match="reasoning"):
        await text_node.enhance_freezone_prompt(
            text="女孩转身跑向门口", dialect="seedance-2.0"
        )


@pytest.mark.asyncio
async def test_enhance_accepts_rewritten_prompt_with_changes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_run(*_args, **_kwargs):
        return SimpleNamespace(
            output=SimpleNamespace(
                enhanced_text=REAL_PROMPT_SAMPLE, changes=["补充光线设定"]
            )
        )

    monkeypatch.setattr(text_node, "run_agent_with_transport_compat", fake_run)
    monkeypatch.setattr(text_node, "get_freezone_prompt_enhance_agent", lambda: None)
    monkeypatch.setattr(text_node, "resolve_freezone_prompt_enhance_model", lambda: "test")

    text, changes = await text_node.enhance_freezone_prompt(
        text="女孩转身跑向门口", dialect="seedance-2.0"
    )

    assert text == REAL_PROMPT_SAMPLE
    assert changes == ["补充光线设定"]


@pytest.mark.asyncio
async def test_enhance_keeps_long_prompt_even_without_changes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """changes 为空本身不是问题——只有开头像推理过程才拦。"""

    async def fake_run(*_args, **_kwargs):
        return SimpleNamespace(
            output=SimpleNamespace(enhanced_text=REAL_PROMPT_SAMPLE * 20, changes=[])
        )

    monkeypatch.setattr(text_node, "run_agent_with_transport_compat", fake_run)
    monkeypatch.setattr(text_node, "get_freezone_prompt_enhance_agent", lambda: None)
    monkeypatch.setattr(text_node, "resolve_freezone_prompt_enhance_model", lambda: "test")

    text, changes = await text_node.enhance_freezone_prompt(
        text="女孩转身跑向门口", dialect="seedance-2.0"
    )

    assert len(text) == len(REAL_PROMPT_SAMPLE) * 20
    assert changes == []
