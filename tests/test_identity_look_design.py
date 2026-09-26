"""身份设计点选：词表、校验，以及出图提示词。"""

import pytest

from novelvideo.characters.look_design import face_prompt, sheet_prompt, validate_look


def test_validate_look_keeps_selected_rows_and_drops_empty():
    look = validate_look(
        {
            "makeup": "战损妆",
            "clothing": "",
            "accessories": ["细框眼镜", "耳钉"],
            "eyes": "丹凤眼",
        }
    )
    assert look["makeup"] == "战损妆"
    assert look["clothing"] == ""
    assert look["accessories"] == ["细框眼镜", "耳钉"]
    assert look["eyes"] == "丹凤眼"
    assert look["hair"] == ""


def test_validate_look_rejects_unknown_and_too_many_accessories():
    with pytest.raises(ValueError):
        validate_look({"makeup": "不存在的妆"})
    with pytest.raises(ValueError):
        validate_look({"accessories": ["眼镜", "耳钉", "项链", "帽子"]})


def test_none_accessory_is_exclusive():
    look = validate_look({"accessories": ["无配饰", "细框眼镜"]})
    assert look["accessories"] == ["无配饰"]


def test_prompts_skip_unselected_rows():
    look = validate_look({"makeup": "战损妆", "style": "写实"})
    face = face_prompt("小美", look)
    sheet = sheet_prompt("小美", look, "expression_grid")
    assert "战损妆" in face
    assert "发型" not in face
    assert "平静" in sheet and "冷笑" in sheet
    assert "以参考图里的角色" in sheet
    assert "只在这个角色上强化这些细节" in sheet
