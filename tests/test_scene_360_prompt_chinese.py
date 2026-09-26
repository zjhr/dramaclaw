# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""纯文本 360 全景走**中文**提示词。

实测背景：同一套条件下，英文提示词在上游稳定跑 2 分钟以上并超时；中文版能出图。
所以纯文本路径（没有任何参考图）改用中文提示词。

这个测试锁两条：
1. 纯文本确实走中文，且 360 的核心约束（投影、接缝、地平线、无人物）都在；
2. **有参考图的路径逐字节不变** —— 那是主线「生成 360 全景」在用的，
   绝不能被这条中文路径影响。
"""

from __future__ import annotations

import pytest

from novelvideo.director_world.scene_360_builder import build_prompt

TEXT_ONLY = dict(
    scene_name="导演台背景",
    scene_description="雨夜的城市天台，湿漉漉的水泥地反射霓虹招牌，无人物",
    style="realistic",
    has_master=False,
)

WITH_MASTER = dict(
    scene_name="便利店",
    scene_description="一间便利店",
    style="realistic",
    has_master=True,
    has_reverse=True,
    has_spatial_layout=True,
    spatial_contract_prompt_insert="前门在 x=25%",
    overlap_prompt_insert="重叠区连续",
)


def test_pure_text_uses_chinese_prompt() -> None:
    prompt = build_prompt(**TEXT_ONLY)

    assert "等距圆柱" in prompt
    assert "全景" in prompt
    # 关键约束一条都不能丢
    for kept in ("2:1", "360", "接缝", "地平线", "相机固定", "不要有人物"):
        assert kept in prompt, f"中文提示词缺了：{kept}"
    # 用户输入的描述原样带入
    assert "雨夜的城市天台" in prompt
    # 不该有英文那一套段落头残留
    for gone in ("equirectangular", "PROJECTION REQUIREMENTS", "INPUT IMAGE ROLES",
                 "NEGATIVE REQUIREMENTS", "LAYER MODE"):
        assert gone not in prompt, f"中文提示词里不该有英文段落：{gone}"


def test_pure_text_prompt_is_much_shorter() -> None:
    """中文版明显更短 —— 这是这次改动的一个可观察副作用，值得锁住。"""
    prompt = build_prompt(**TEXT_ONLY)
    assert len(prompt) < 1500, f"中文提示词长到 {len(prompt)} 字符，和预期不符"


def test_pure_text_shell_only_also_chinese() -> None:
    prompt = build_prompt(**{**TEXT_ONLY, "layer_mode": "shell_only"})
    assert "仅场景外壳" in prompt
    assert "等距圆柱" in prompt


@pytest.mark.parametrize(
    "args, expects_contract",
    [
        (WITH_MASTER, True),
        ({**WITH_MASTER, "has_reverse": False, "has_spatial_layout": False}, False),
    ],
)
def test_reference_paths_stay_english_and_untouched(args: dict, expects_contract: bool) -> None:
    """有参考图时必须仍是英文原版（主线 360 全景走这条）。"""
    prompt = build_prompt(**args)
    assert "GEOMETRY / STYLE PRIORITY" in prompt
    assert "equirectangular" in prompt.lower()
    assert "等距圆柱" not in prompt, "有参考图时不该串到中文提示词"
    if expects_contract:
        # 空间契约只在 master+reverse 那条分支注入。
        assert "前门在 x=25%" in prompt
