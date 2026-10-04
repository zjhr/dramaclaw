#!/usr/bin/env python3
"""在 Blender headless 里跑一段 **AI 生成的 bpy 脚本**，并在导出前做护栏校验。

只由 `ai_model.py` 调用（它负责进程、限时与沙箱参数）。也可手动跑：

    blender -b --factory-startup -P ai_guard.py -- \
        --script /tmp/prop.py --out /tmp/prop.glb --kind table

## 为什么现在放开了「AI 写 Blender」（2026-10 立场更新）

`build_template.py` 原本只从 4 个固定模板里选参数，理由是「不把 AI 生成的 Python
喂给 Blender：安全与质量都不可控」。这条理由现在**部分失效、部分仍然成立**：

- **可执行率不再是问题**：单次裸调 LLM 写 Blender 脚本的可执行率只有 0.41~0.92
  （3DCodeBench, arXiv 2606.01057），挂上 coding agent harness 后升到 0.986~1.000。
  我们本来就是 agent 场景，所以「AI 脚本大概率跑不起来」不再是拒绝的理由。
- **质量问题仍然成立，但可以检测**：同一篇论文点名残余缺陷是
  「successful renders still suffer from disconnected or floating 3D geometric
  components」，并强调「Physical Plausibility supersedes Executability」——
  也就是说失败模式是**几何不成立**，不是语法不成立。几何不成立是可测量、可拒绝的。
- **难度分层**：L1 成功 75~89%，L3 掉到 8~32%。短剧预演道具（桌/椅/瓶/花器）是
  L1~L2，够用 —— 所以这条路的价值区间正好覆盖我们的主要需求。

因此放开的前提是**护栏**：下面每一项都是为了让「可执行」升级成「可交付」。

## 护栏清单（本文件负责的部分）

| 护栏 | 做法 | 为什么 |
| --- | --- | --- |
| 版本锁 | `_assert_version()` 拒绝非 4.5.x | Blender 5.0 对合成器/布尔枚举类 API 实测 0% 通过；跨版本 API 漂移会让护栏本身静默失效 |
| 无副作用启动 | 由宿主加 `--factory-startup` | 不加载用户 add-on / 偏好 / 启动脚本 |
| 禁网 | `_block_network()` 把 socket/urllib/http 换成会抛错的桩 | AI 脚本没有理由联网；禁网同时挡掉「偷偷把数据发出去」 |
| 内存上限 | `resource.setrlimit`，**macOS 实测不生效**（见 `_limit_memory`） | 兜底靠超时 + 面数预算；报告里的 `memoryCapped` 如实反映 |
| 连通分量检查 | `_components()` 把网格拆成连通分量并计数 | 抓论文点名的 disconnected components |
| 支撑/悬空检查 | 每个分量与更大分量的包围盒必须**接触** | 抓论文点名的 floating components |
| 干净起点 | `_clear_startup_scene()` 先删掉 factory-startup 的默认 Cube | 否则分量数凭空 +1，`component-count` 变成「模型没问题也会挂」的假失败 |
| 退化几何检查 | 分量体积 / 面数下限 | 抓「一个点当零件」这类退化输出 |
| 尺度硬归一化 | `_normalize_scale()` 按真实尺寸缩放并落地 | **不信 LLM 写的尺寸**——把「记错尺度」变成不可能出错 |
| Z-up → Y-up | 导出 `export_yup=True` | Blender 是 Z-up，glTF 是 Y-up |

进程超时、内存与退出码归集在宿主 `ai_model.py`（服务侧是
`src/novelvideo/director_desk/blender_runner.py`）。两处都按平台分支：
POSIX 杀进程组、Windows 杀进程树（`taskkill /T`），Blender 在三个平台上同样会 fork。

## 成功/失败都是机器可读的

stdout 末行固定给一行 `AI_MODEL_OK {...}` 或 `AI_MODEL_FAIL {...}`，宿主据此决定
是重试还是如实报错。**校验失败绝不导出 GLB** —— 不许把坏模型塞进场景。
"""

from __future__ import annotations

import json
import math
import sys
import traceback
from pathlib import Path

# Blender 用 -P 跑脚本时不会把脚本目录放进 sys.path，宿主模块得自己加。
sys.path.insert(0, str(Path(__file__).resolve().parent))

import bmesh  # noqa: E402,F401  （Blender 自带）
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

from real_sizes import REAL_HEIGHTS  # noqa: E402 — 不依赖 bpy 的真实尺寸表

# ── 版本锁 ───────────────────────────────────────────────────────────────
# 与 ensure_blender.py 的 BLENDER_SERIES 保持一致。
LOCKED_SERIES = "4.5"

# ── 护栏阈值 ───────────────────────────────────────────────────────────────
CONTACT_TOL = 0.02        # 允许的接触缝隙（米）
MIN_COMPONENT_VOLUME = 1e-7   # 单个分量的最小体积（米³）
MAX_FACES = 2_000_000     # 面数上限，挡住失控 subdivision
MEMORY_LIMIT_BYTES = 3 * 1024 ** 3


class GuardFailure(Exception):
    """护栏判定失败。携带可机读 reasons，宿主据此决定重试或放弃。"""

    def __init__(self, reason: str, detail: dict | None = None):
        super().__init__(reason)
        self.reason = reason
        self.detail = detail or {}


# ── 护栏原语 ───────────────────────────────────────────────────────────────

def _assert_version() -> str:
    """版本锁：Blender 5.0 对合成器/布尔枚举 API 实测 0% 通过，护栏不能跨版本假设。"""
    version = bpy.app.version_string
    if not version.startswith(LOCKED_SERIES):
        raise GuardFailure(
            f"blender-version: 本管线锁定 Blender {LOCKED_SERIES}.x（实际 {version}）",
            {"expected": LOCKED_SERIES, "actual": version},
        )
    return version


def _block_network() -> None:
    """把**网络**模块换成会抛错的桩。

    这不是 OS 级容器沙箱（macOS 上没有便宜的容器方案），而是**语言级**禁网：
    AI 生成的 bpy 脚本没有任何正当的联网需求，禁网同时挡掉数据外泄。
    进程级隔离由宿主的超时 + 内存上限 + `--factory-startup` 提供。

    **只挡真正的网络模块**，不要连坐 `subprocess` / `selectors` / `asyncio`：
    Blender 自带的 glTF 导出器会 `import subprocess`，一并挡掉会让护栏把
    **合法模型**判成失败。实测踩过。
    """

    class _Blocked:
        def __getattr__(self, name):
            raise GuardFailure(
                f"network-blocked: 访问 {name} 被禁止（AI 脚本不允许联网）",
                {"attr": name},
            )

        def __call__(self, *a, **k):
            raise GuardFailure("network-blocked: 调用被禁止（AI 脚本不允许联网）")

    for name in ("socket", "ssl", "urllib", "urllib.request", "http", "http.client",
                 "ftplib", "smtplib", "telnetlib", "xmlrpc", "requests"):
        sys.modules[name] = _Blocked()


def _limit_memory() -> str:
    """尽力而为地设内存上限，**返回实际生效的结果**，不谎报。

    实测（macOS 15 / Blender 4.5.14）：`RLIMIT_AS` 与 `RLIMIT_DATA` 都是
    `ValueError: current limit exceeds maximum limit` —— 未授权进程不能把
    hard limit 从 unlimited 往下压。所以在 macOS 上**内存上限实际上没生效**，
    报告里的 `memoryCapped` 如实是 false。Linux 上 `RLIMIT_AS` 可用。

    **Windows 上 `resource` 模块不存在**，所以这里如实返回 `"unavailable"`，不假装
    设上了。真正兜住内存的因此只有**超时**（失控分配的进程同样会超时被杀；Windows
    上是 `taskkill /T` 收整棵进程树）与**面数预算**（`MAX_FACES`，在导出前就拒绝）。
    """
    try:
        import resource
    except ImportError:
        return "unavailable"

    for which in ("RLIMIT_AS", "RLIMIT_DATA"):
        limit = getattr(resource, which, None)
        if limit is None:
            continue
        try:
            _, hard = resource.getrlimit(limit)
            if hard not in (resource.RLIM_INFINITY, -1):
                continue  # 已经比我们的上限还小，放着更严
            resource.setrlimit(limit, (MEMORY_LIMIT_BYTES, hard))
            return which.lower()
        except (ValueError, OSError):
            continue
    return "unsupported-on-this-platform"


def _clear_startup_scene() -> None:
    """清空 `--factory-startup` 留下的默认 Cube，再跑 AI 脚本。

    **默认 Cube 不是 AI 的产出，不该混进模型。** 它会让连通分量数凭空 +1，于是
    「四条腿的凳子 = 5 个分量」恒被 `component-count` 打回，而且打回的原因是模型
    本身没问题 —— 这是最难查的一类假失败。与其在技能文档里要求每份脚本都记得先删
    Cube（记得的写、忘了的挂），不如在护栏这一层一次性保证干净起点。
    """
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


def _run_ai_script(script_path: str) -> None:
    """执行 AI 生成的脚本。

    在**干净的命名空间**里跑，不污染 `__main__`；导入 `bpy` 时用的仍然是真 bpy。
    """
    source = open(script_path, encoding="utf-8").read()
    namespace = {"__name__": "__ai_generated__", "__file__": script_path}
    exec(compile(source, script_path, "exec"), namespace)  # noqa: S102 — 沙箱边界就在这里


def _mesh_objects() -> list:
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not objs:
        raise GuardFailure("empty-scene: 脚本跑完了但一个网格都没生成")
    return objs


def _components(objects: list) -> list[dict]:
    """按顶点连通性把网格拆成连通分量。

    比 `loose parts` 更准：loose parts 只按顶点数切分，切不出「一块几何和另一块
    挨在一起但没焊接」的悬空件，而那正是要抓的失败模式。

    **必须在世界空间算**：多个 primitive 创建时各带自己的 location/scale，
    局部坐标全在原点附近，直接比会得到一堆假悬空件。
    """
    bm = bmesh.new()
    for obj in objects:
        bm.from_mesh(obj.data)
        world = obj.matrix_world
        # from_mesh 追加的是该物体全部顶点，按同样的数量回填世界变换。
        offset = len(bm.verts) - len(obj.data.vertices)
        for i, vert in enumerate(bm.verts[offset:]):
            vert.co = world @ vert.co

    index = {v: i for i, v in enumerate(bm.verts)}
    parent = list(range(len(bm.verts)))

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    for edge in bm.edges:
        if len(edge.verts) == 2:
            union(index[edge.verts[0]], index[edge.verts[1]])

    groups: dict[int, list] = {}
    for v in bm.verts:
        groups.setdefault(find(index[v]), []).append(v)

    result = []
    for verts in groups.values():
        if not verts:
            continue
        co = [v.co for v in verts]
        result.append({
            "verts": len(verts),
            "min": [min(c[i] for c in co) for i in range(3)],
            "max": [max(c[i] for c in co) for i in range(3)],
            "volume": _bbox_volume(co),
        })
    bm.free()
    result.sort(key=lambda c: -c["verts"])
    return result


def _bbox_volume(co: list) -> float:
    """顶点包围盒体积 —— 只用来判退化与排名，不做精确体积积分。"""
    if len(co) < 4:
        return 0.0
    ext = [max(c[i] for c in co) - min(c[i] for c in co) for i in range(3)]
    return ext[0] * ext[1] * ext[2]


def _body_volume(comp: dict) -> float:
    """「主体」的排名依据：包围盒体积，其次顶点数。

    **不能按顶点数排名**：一个 24 段的圆柱（花瓶）顶点数多于一块桌面，会被误判成
    「主体」，于是桌面和四条腿全被报成悬空件 —— 诊断结论完全反过来。实测踩过。
    包围盒体积才近似「这东西在场景里占多大」，与「谁是主体」一致。
    """
    ext = [comp["max"][i] - comp["min"][i] for i in range(3)]
    return ext[0] * ext[1] * ext[2]


def _bbox_touches(a: dict, b: dict, tol: float = CONTACT_TOL) -> bool:
    """两个分量的包围盒是否**接触**（而不只是投影重叠）。

    悬空件的特征是：XY 投影压在主件上方，但 Z 上有一截空隙。
    """
    for i in range(3):
        if a["min"][i] > b["max"][i] + tol or b["min"][i] > a["max"][i] + tol:
            return False
    # 至少要在两个轴上有**实打实的重叠**，否则只是擦边而过
    overlap = [
        min(a["max"][i], b["max"][i]) - max(a["min"][i], b["min"][i])
        for i in range(3)
    ]
    touching_axes = sum(1 for o in overlap if o > tol)
    return touching_axes >= 2


def _check_components(comps: list[dict], expect_parts: int | None) -> dict:
    """连通分量数 + 悬空检查。"""
    report = {"componentCount": len(comps), "expectParts": expect_parts, "floating": []}

    if expect_parts is not None and len(comps) != expect_parts:
        raise GuardFailure(
            f"component-count: 期望 {expect_parts} 个连通分量，实际 {len(comps)}",
            {"expectParts": expect_parts, "componentCount": len(comps)},
        )

    degenerate = [i for i, c in enumerate(comps) if c["volume"] <= MIN_COMPONENT_VOLUME]
    if degenerate:
        raise GuardFailure(
            "degenerate-geometry: 存在零体积的退化部件",
            {"degenerateIndices": degenerate},
        )

    if len(comps) <= 1:
        return report

    # 支撑检查：每个分量都必须与**主体**接触。
    # 这正是 3DCodeBench 点名的残余缺陷——「disconnected or floating components」。
    main_index = max(range(len(comps)), key=lambda i: (_body_volume(comps[i]), comps[i]["verts"]))
    main = comps[main_index]
    for i, comp in enumerate(comps):
        if i == main_index:
            continue
        if not _bbox_touches(comp, main):
            report["floating"].append({
                "index": i,
                "verts": comp["verts"],
                "minZ": round(comp["min"][2], 4),
                "maxZ": round(comp["max"][2], 4),
            })
    if report["floating"]:
        raise GuardFailure(
            f"floating-parts: {len(report['floating'])} 个部件没有与主体接触（悬空）",
            {"floating": report["floating"], "componentCount": len(comps),
             "mainIndex": main_index,
             "mainMinZ": round(main["min"][2], 4), "mainMaxZ": round(main["max"][2], 4)},
        )
    return report


def _bounds(objects: list) -> tuple[list[float], list[float]]:
    mins = [math.inf] * 3
    maxs = [-math.inf] * 3
    dg = bpy.context.evaluated_depsgraph_get()
    for obj in objects:
        evaluated = obj.evaluated_get(dg)
        for corner in evaluated.bound_box:
            world = evaluated.matrix_world @ Vector(corner)
            for i in range(3):
                mins[i] = min(mins[i], world[i])
                maxs[i] = max(maxs[i], world[i])
    if not all(math.isfinite(v) for v in mins + maxs):
        raise GuardFailure("degenerate-bounds: 包围盒无效（NaN 或 Inf）")
    return mins, maxs


def _normalize_scale(objects: list, kind: str | None, explicit_height: float | None) -> dict:
    """尺度硬归一化 + 落地。

    **不信 AI 写的尺寸**：按真实尺寸表把竖直方向拉到目标高度（等比，保持长宽比），
    再把底面贴到 z=0。AI 记错尺度这件事由此变成不可能出错。
    """
    mins, maxs = _bounds(objects)
    before = [round(maxs[i] - mins[i], 4) for i in range(3)]

    target = explicit_height
    if target is None and kind:
        target = REAL_HEIGHTS.get(kind)
    current_height = maxs[2] - mins[2]
    factor = 1.0
    if target and current_height > 1e-6:
        factor = float(target) / current_height
    elif not target:
        # 没给 kind 也没有显式高度：仍然必须落地，但不猜尺寸。
        factor = 1.0

    if abs(factor - 1.0) > 1e-9:
        # 必须**先把 scale 乘上去**再 transform_apply：
        # transform_apply 只是把当前 scale 烘进网格，本身不做任何缩放。
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.scale = (obj.scale[0] * factor, obj.scale[1] * factor, obj.scale[2] * factor)
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    mins, maxs = _bounds(objects)
    dz = mins[2]
    if abs(dz) > 1e-9:
        for obj in objects:
            obj.location.z -= dz

    mins, maxs = _bounds(objects)
    after = [round(maxs[i] - mins[i], 4) for i in range(3)]
    return {
        "kind": kind,
        "targetHeight": target,
        "scaleFactor": round(factor, 6),
        "bboxBefore": before,
        "bboxAfter": after,
        "groundedTo": round(mins[2], 6),
    }


# ── 入口 ───────────────────────────────────────────────────────────────────

def main() -> int:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    args = {}
    i = 0
    while i < len(argv):
        if argv[i].startswith("--"):
            key = argv[i][2:]
            args[key] = argv[i + 1] if i + 1 < len(argv) and not argv[i + 1].startswith("--") else True
            i += 2
        else:
            i += 1

    script = args.get("script")
    out = args.get("out")
    if not script or not out:
        print("AI_MODEL_FAIL " + json.dumps({"reason": "usage: --script <py> --out <glb>"}))
        return 2

    kind = args.get("kind") if isinstance(args.get("kind"), str) else None
    expect_parts = args.get("expect-parts")
    expect_parts = int(expect_parts) if isinstance(expect_parts, str) else None
    explicit_height = args.get("real-height")
    explicit_height = float(explicit_height) if isinstance(explicit_height, str) else None

    # 必须在跑 AI 脚本**之前**设限，否则限制的是导出阶段而不是不可信的生成阶段。
    memory_capped = _limit_memory()
    try:
        version = _assert_version()
        _block_network()
        _clear_startup_scene()
        _run_ai_script(script)

        objects = _mesh_objects()
        faces = sum(len(o.data.polygons) for o in objects)
        if faces > MAX_FACES:
            raise GuardFailure(
                f"face-budget: 面数 {faces} 超过上限 {MAX_FACES}",
                {"faces": faces, "limit": MAX_FACES},
            )

        comps = _components(objects)
        comp_report = _check_components(comps, expect_parts)

        bpy.ops.object.select_all(action="SELECT")
        bpy.context.view_layer.objects.active = objects[0]
        bpy.ops.object.join()
        joined = bpy.context.view_layer.objects.active
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

        norm = _normalize_scale([joined], kind, explicit_height)

        bpy.ops.export_scene.gltf(
            filepath=out,
            export_format="GLB",
            # 上游 glTF loader 遇到 KHR_draco_mesh_compression 会**直接拒绝加载**
            # （vendor/director-desk/src/resources/gltf-model.ts:18），所以压缩保持关闭。
            export_draco_mesh_compression_enable=False,
            export_yup=True,   # Blender Z-up → GLB Y-up
            export_apply=True,
            export_materials="EXPORT",
        )

        report = {
            "out": out, "blender": version, "memoryCapped": memory_capped,
            "faces": faces, "objects": len(objects), "normalization": norm, **comp_report,
        }
        print("AI_MODEL_OK " + json.dumps(report, ensure_ascii=False))
        return 0

    except GuardFailure as exc:
        print("AI_MODEL_FAIL " + json.dumps(
            {"reason": exc.reason, **exc.detail}, ensure_ascii=False))
        return 3
    except Exception as exc:  # noqa: BLE001 — AI 脚本抛什么都得变成可机读失败
        print("AI_MODEL_FAIL " + json.dumps(
            {"reason": "ai-script-error", "error": f"{type(exc).__name__}: {exc}",
             "trace": traceback.format_exc()[-1200:]}, ensure_ascii=False))
        return 4


if __name__ == "__main__":
    raise SystemExit(main())