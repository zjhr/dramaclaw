#!/usr/bin/env python3
"""参数化模板 → **未压缩** GLB（给导演台注入真几何）。

## 与「AI 现场写脚本」那条通路的关系

这个脚本是**确定性的固定模板**通路：agent 从 4 个模板里选、填几个尺寸，几何完全
由这里的脚本生成。同一场景永远得到同一个 GLB，评审和回归都便宜。

另一条通路是 `ai_model.py`：让 AI 现场写 bpy 脚本，跑完过一遍护栏再导出。
**为什么当初不放开、以及现在为什么放开**（2026-10 立场更新）：

- 原立场：「不把 AI 生成的 Python 喂给 Blender（安全与质量都不可控）」。
- **可执行率已经不是问题**：单次裸调 LLM 写 Blender 脚本的可执行率只有 0.41~0.92
  （3DCodeBench, arXiv 2606.01057）；挂上 coding agent harness 后升到 0.986~1.000。
  我们本来就是 agent 场景，所以「AI 脚本大概率跑不起来」不再成立。
- **质量问题仍然成立，但可检测**：同一篇论文点名的残余缺陷是
  「successful renders still suffer from disconnected or floating 3D geometric
  components」，并强调「Physical Plausibility supersedes Executability」。
  也就是说失败模式是**几何不成立**而非语法不成立，而几何不成立是可测量、
  可拒绝、可重试的 —— 这正是 `ai_guard.py` 那套护栏做的事。
- **难度分层**：L1 成功 75~89%，L3 掉到 8~32%。短剧预演道具（桌/椅/瓶/花器）
  属于 L1~L2，够用；越接近 L3 越应该退回固定模板。

所以两条通路**并存**：能用模板就用模板（更稳、更省），模板覆盖不到才让 AI 写，
并且**必须**过护栏。护栏不过就如实说做不了，不许把坏模型塞进场景。

用法（由 `ensure_blender.py` 找到的 Blender 执行）：
    blender -b -P scripts/blender/build_template.py -- \
        --template rail --out /tmp/rail.glb --params '{"length": 3.0}'

尺度：**米制**（Blender 默认单位）。导出时 `export_yup=True` 做 Z-up → Y-up 转换，
`export_draco_mesh_compression_enable=False` —— 上游 v2 导演台的 glTF loader
**显式拒绝** Draco（`vendor/director-desk/src/resources/gltf-model.ts:18` 见到
`KHR_draco_mesh_compression` 直接抛错），压缩过的 GLB 它加载不了。
（注意：MONOFORM 已下线，但结论不变 —— 换了个 loader，仍然不认 Draco。）
"""

from __future__ import annotations

import argparse
import json
import math
import sys

import bpy  # 只在 Blender 内部可用（-P 方式运行）


def clear_scene() -> None:
    """清掉默认的 Cube / Light / Camera —— 导出物只该有模板几何。"""
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for item in list(block):
            block.remove(item)


def box(size: tuple[float, float, float], location: tuple[float, float, float]):
    """一个长方体（size 是**米**，不是缩放系数）。"""
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location)
    obj = bpy.context.active_object
    obj.scale = (max(0.001, size[0]), max(0.001, size[1]), max(0.001, size[2]))
    return obj


def cylinder(radius: float, depth: float, location, rotation=(0.0, 0.0, 0.0)):
    bpy.ops.mesh.primitive_cylinder_add(radius=max(0.001, radius), depth=max(0.001, depth),
                                        location=location, rotation=rotation, vertices=16)
    return bpy.context.active_object


def build_rail(p: dict) -> None:
    """轨道 / 滑轨：两条平行钢轨 + 枕木 + 端部挡块。"""
    length = float(p.get("length", 3.0))
    gauge = float(p.get("gauge", 0.62))  # 轨距（两条轨的间距）
    sleepers = max(2, int(p.get("sleepers", 6)))
    rail_h, rail_w = 0.09, 0.06
    # 两条钢轨（沿 X 轴铺开）
    for side in (-1, 1):
        box((length, rail_w, rail_h), (0.0, side * gauge / 2, 0.12 + rail_h / 2))
    # 枕木
    for index in range(sleepers):
        x = -length / 2 + (length * index / (sleepers - 1))
        box((0.14, gauge + 0.24, 0.07), (x, 0.0, 0.035))
    # 端部挡块
    for side in (-1, 1):
        box((0.1, gauge + 0.3, 0.16), (side * (length / 2 + 0.05), 0.0, 0.08))


def build_crane(p: dict) -> None:
    """摇臂 / 小型吊臂：配重底座 + 立柱 + 水平臂 + 臂端滑轮块。"""
    height = float(p.get("height", 3.2))
    arm = float(p.get("armLength", 2.4))
    base = float(p.get("baseSize", 1.1))
    box((base, base, 0.16), (0.0, 0.0, 0.08))                       # 底座
    cylinder(0.09, height, (0.0, 0.0, 0.16 + height / 2))           # 立柱
    box((arm, 0.14, 0.14), (arm / 2 - 0.2, 0.0, 0.16 + height))     # 水平臂
    box((0.22, 0.22, 0.22), (arm - 0.2, 0.0, 0.16 + height - 0.2))  # 臂端块
    box((0.34, 0.34, 0.3), (-0.24, 0.0, 0.16 + height - 0.22))      # 配重


def build_light_stand(p: dict) -> None:
    """灯架：三脚 + 立杆 + 顶部灯板。"""
    height = float(p.get("height", 2.6))
    spread = float(p.get("spread", 0.55))
    for index in range(3):
        angle = index * (2 * math.pi / 3)
        x, y = math.cos(angle) * spread / 2, math.sin(angle) * spread / 2
        leg = cylinder(0.03, height, (x / 2, y / 2, height / 2))
        leg.rotation_euler = (math.atan2(spread, height) * math.sin(angle),
                              -math.atan2(spread, height) * math.cos(angle), angle)
    cylinder(0.035, height * 0.9, (0.0, 0.0, height * 0.55))        # 立杆
    box((0.5, 0.12, 0.34), (0.0, 0.0, height + 0.17))               # 灯板


def build_platform(p: dict) -> None:
    """高台 / 脚手架：平台板 + 四角立柱 + 横撑 + 可选护栏。"""
    width = float(p.get("width", 2.2))
    depth = float(p.get("depth", 1.6)) if "depth" in p else float(p.get("length", 1.6))
    height = float(p.get("height", 1.2))
    railing = bool(p.get("railing", True))
    box((width, depth, 0.1), (0.0, 0.0, height))                     # 台板
    for sx in (-1, 1):
        for sy in (-1, 1):
            box((0.1, 0.1, height), (sx * (width / 2 - 0.08), sy * (depth / 2 - 0.08), height / 2))
    # 横撑（前后各一道）
    for sy in (-1, 1):
        box((width - 0.16, 0.07, 0.07), (0.0, sy * (depth / 2 - 0.08), height * 0.45))
    if railing:
        rail_h = 0.95
        for sy in (-1, 1):  # 前后护栏
            box((width, 0.06, 0.06), (0.0, sy * (depth / 2 - 0.08), height + rail_h))
            box((width, 0.05, 0.05), (0.0, sy * (depth / 2 - 0.08), height + rail_h * 0.5))
        for sx in (-1, 1):  # 侧面立柱
            for sy in (-1, 1):
                box((0.06, 0.06, rail_h), (sx * (width / 2 - 0.08), sy * (depth / 2 - 0.08),
                                           height + rail_h / 2))


def apply_scales() -> None:
    """把对象的 scale **烘进网格**再导出。

    不烘的话 glTF 会把 scale 留在**节点**上、accessor 里仍是单位立方体的 ±0.5 ——
    加载器虽然也能渲染对，但"读 bounding box 验尺寸"就永远读到 1×1×1（实测踩过），
    而且下游任何按几何算尺寸的逻辑都会拿到错的数。
    """
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)


TEMPLATES = {
    "rail": build_rail,
    "crane": build_crane,
    "light_stand": build_light_stand,
    "platform": build_platform,
}


def main() -> int:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description="参数化模板 → 未压缩 GLB")
    parser.add_argument("--template", required=True, choices=sorted(TEMPLATES))
    parser.add_argument("--out", required=True, help="输出 .glb 路径")
    parser.add_argument("--params", default="{}", help="JSON 参数对象")
    parser.add_argument("--list", action="store_true", help="只列出模板名")
    args = parser.parse_args(argv)

    if args.list:
        print(json.dumps(sorted(TEMPLATES)))
        return 0

    params = json.loads(args.params or "{}")
    clear_scene()
    TEMPLATES[args.template](params)
    apply_scales()

    bpy.ops.export_scene.gltf(
        filepath=args.out,
        export_format="GLB",
        # 上游 v2 导演台的 glTF loader 见到 KHR_draco_mesh_compression 会**直接拒绝加载**
        # （vendor/director-desk/src/resources/gltf-model.ts:18），所以压缩保持关闭。
        export_draco_mesh_compression_enable=False,
        export_yup=True,          # Blender Z-up → GLB Y-up
        export_apply=True,        # 应用缩放/修改器，几何带上真实尺寸
        export_materials="EXPORT",
    )
    # 供调用方解析（stdout 里给一行机器可读的结果）
    print("TEMPLATE_OK " + json.dumps({"template": args.template, "out": args.out}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
