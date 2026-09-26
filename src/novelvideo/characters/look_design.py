"""身份设计点选。词只用于生成这个身份的图，不写进视频提示词。"""

from __future__ import annotations

from typing import Any

MAKEUP = (
    "无妆原生",
    "素颜",
    "清透底妆",
    "水光肌",
    "哑光",
    "日常淡妆",
    "自然修容",
    "明艳红唇",
    "烟熏",
    "新娘妆",
    "古风妆",
    "舞台妆",
    "浓妆",
    "战损妆",
    "淤青",
    "旧疤",
    "哭花妆",
    "汗湿",
    "苍白",
    "黑眼圈",
    "病容",
    "晒伤",
    "醉容",
)
CLOTHING = (
    "白衬衫",
    "黑T恤",
    "白上衣",
    "黑上衣",
    "针织衫",
    "卫衣",
    "西装",
    "风衣",
    "大衣",
    "夹克",
    "连衣裙",
    "长裙",
    "短裙",
    "校服",
    "制服",
    "工装",
    "睡衣",
    "运动装",
    "礼服",
    "汉服",
    "旗袍",
    "古装",
    "盔甲",
    "破旧衣",
)
ACCESSORIES = (
    "无配饰",
    "细框眼镜",
    "墨镜",
    "小银耳饰",
    "珍珠耳钉",
    "金色耳圈",
    "耳钉",
    "项链",
    "锁骨链",
    "帽子",
    "棒球帽",
    "手表",
    "手链",
    "戒指",
    "发夹",
    "发带",
    "围巾",
    "口罩",
    "耳机",
    "背包",
)
FACE_SHAPES = ("鹅蛋脸", "圆脸", "方脸", "长脸", "瓜子脸", "菱形脸")
EYES = ("杏眼", "圆眼", "丹凤眼", "细长眼", "下垂眼", "双眼皮", "单眼皮")
EYEBROWS = ("平眉", "挑眉", "浓眉", "细眉", "剑眉")
NOSES = ("高鼻梁", "小巧鼻", "宽鼻", "驼峰鼻")
LIPS = ("薄唇", "厚唇", "嘴角上扬", "嘴角下垂", "花瓣唇")
BODIES = ("纤细", "标准", "高挑", "娇小", "丰满", "壮实", "瘦高", "少年", "儿童", "老年")
HAIR = (
    "黑长直",
    "黑短发",
    "长卷发",
    "波浪卷",
    "马尾",
    "双马尾",
    "丸子头",
    "寸头",
    "中分",
    "侧分",
    "齐刘海",
    "盘发",
    "白发",
    "金发",
    "棕发",
    "红发",
    "银发",
    "光头",
)
STYLES = (
    "写实",
    "电影感",
    "日漫",
    "国漫",
    "韩漫",
    "水彩",
    "赛博",
    "古风",
    "民国",
    "现代都市",
    "奇幻",
    "暗黑",
)
EXPRESSIONS = ("平静", "微笑", "大笑", "愤怒", "悲伤", "哭泣", "震惊", "恐惧", "冷笑")

SINGLE_FIELDS = {
    "makeup": MAKEUP,
    "clothing": CLOTHING,
    "face_shape": FACE_SHAPES,
    "eyes": EYES,
    "eyebrows": EYEBROWS,
    "nose": NOSES,
    "lips": LIPS,
    "body": BODIES,
    "hair": HAIR,
    "style": STYLES,
    "expression": EXPRESSIONS,
}
ACCESSORY_LIMIT = 3
EMPTY_LOOK = {key: "" for key in SINGLE_FIELDS} | {"accessories": []}


def normalize_look(raw: Any) -> dict[str, Any]:
    """把存下来的点选收成固定形状。非法值在 validate_look 里拒绝，这里只补缺省。"""
    source = raw if isinstance(raw, dict) else {}
    look = dict(EMPTY_LOOK)
    for key in SINGLE_FIELDS:
        value = source.get(key, "")
        look[key] = value.strip() if isinstance(value, str) else ""
    accessories = source.get("accessories") or []
    if isinstance(accessories, str):
        accessories = [accessories]
    cleaned: list[str] = []
    for item in accessories:
        if not isinstance(item, str):
            continue
        text = item.strip()
        if text and text not in cleaned:
            cleaned.append(text)
    if "无配饰" in cleaned:
        cleaned = ["无配饰"]
    look["accessories"] = cleaned[:ACCESSORY_LIMIT]
    return look


def validate_look(raw: Any) -> dict[str, Any]:
    look = normalize_look(raw)
    for key, allowed in SINGLE_FIELDS.items():
        value = look[key]
        if value and value not in allowed:
            raise ValueError(f"未知的{key}: {value}")
    for item in look["accessories"]:
        if item not in ACCESSORIES:
            raise ValueError(f"未知的配饰: {item}")
    source = raw if isinstance(raw, dict) else {}
    incoming = source.get("accessories") or []
    if isinstance(incoming, list) and len([item for item in incoming if isinstance(item, str) and item.strip()]) > ACCESSORY_LIMIT:
        raise ValueError(f"配饰最多 {ACCESSORY_LIMIT} 个")
    return look


def _clauses(look: dict[str, Any]) -> list[str]:
    labels = {
        "makeup": "妆容",
        "clothing": "服装",
        "face_shape": "脸型",
        "eyes": "眼睛",
        "eyebrows": "眉毛",
        "nose": "鼻子",
        "lips": "嘴唇",
        "body": "体型",
        "hair": "发型",
        "style": "风格",
        "expression": "表情",
    }
    lines = [f"{label}：{look[key]}" for key, label in labels.items() if look.get(key)]
    accessories = [item for item in look.get("accessories") or [] if item and item != "无配饰"]
    if accessories:
        lines.append("配饰：" + "、".join(accessories))
    elif look.get("accessories") == ["无配饰"]:
        lines.append("配饰：无配饰")
    return lines


def face_prompt(character_name: str, look: dict[str, Any]) -> str:
    clauses = _clauses(look)
    detail = "。".join(clauses)
    lead = f"角色「{character_name}」的单人设定图，正面，中性背景，表情平静"
    if detail:
        lead = f"{lead}。在这个角色上只加上这些细节：{detail}"
    return f"{lead}。不要文字，不要拼贴。"


def sheet_prompt(character_name: str, look: dict[str, Any], kind: str) -> str:
    clauses = _clauses(look)
    detail = "。".join(clauses)
    if kind == "three_view":
        lead = (
            f"以参考图里的角色「{character_name}」为底，画一张正面、侧面、背面的全身三视图，"
            "统一中性背景"
        )
    else:
        names = "、".join(EXPRESSIONS)
        lead = (
            f"以参考图里的角色「{character_name}」为底，画一张 3x3 表情九宫格，"
            f"九格从左到右、从上到下依次是：{names}"
        )
    if detail:
        lead = f"{lead}。只在这个角色上强化这些细节，不要换成另一个人：{detail}"
    else:
        lead = f"{lead}。不要换成另一个人"
    return f"{lead}。不要文字。"
