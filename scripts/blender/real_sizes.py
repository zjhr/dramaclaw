#!/usr/bin/env python3
"""短剧预演道具的**真实尺寸表**（米），供尺度硬归一化使用。

单独成文件是为了**不依赖 bpy**：`ai_guard.py` 在 Blender 内部跑（顶部 import bpy），
宿主 `ai_model.py` 在普通 Python 里跑，`--kinds` 要能打印这张表而不需要 Blender。

## 为什么要有这张表

AI 写 Blender 脚本时**记不对尺度**：桌高写成 1.2m、椅座写成 0.9m 是典型错误，
而且模型仍然能跑、导出、加载 —— 所以纯靠「模型能加载」是查不出尺度错误的。
导出前按本表把竖直方向拉到真实高度（等比，保持长宽比），就把
「LLM 记错尺度」变成了不可能出错。

数值取家具/日用器物的通行工业尺寸，横截面长宽比**不纠正** —— 那是造型问题，
不是尺度问题，由 AI 脚本自己负责。
"""

from __future__ import annotations

# key = `--kind` 的值；value = 该类道具的真实**高度**（Blender Z 轴 = 竖直方向）。
REAL_HEIGHTS: dict[str, float] = {
    "table": 0.75,        # 餐桌面高
    "desk": 0.75,         # 书桌面高
    "chair": 0.45,        # 座高
    "stool": 0.45,
    "bar_stool": 0.75,
    "bench": 0.45,
    "sofa": 0.80,         # 靠背顶
    "bed": 0.55,          # 床垫面高
    "nightstand": 0.55,
    "wardrobe": 1.90,
    "shelf": 1.80,
    "lamp": 1.60,         # 落地灯总高
    "table_lamp": 0.45,
    "vase": 0.30,         # 花器高
    "bottle": 0.25,       # 酒瓶高
    "cup": 0.10,          # 马克杯高
    "bowl": 0.08,
    "book": 0.24,
    "box": 0.30,
    "crate": 0.40,
    "plant": 1.20,        # 盆栽总高
    "door": 2.05,
    "window": 1.20,
    "barrel": 0.88,
    "toolbox": 0.25,
    "stair": 1.60,        # 单跑总高
    "railing": 1.10,      # 护栏高
}