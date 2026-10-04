"""AI 现场写 Blender 脚本 → 护栏 → 未压缩 GLB 这条通路。

## 为什么这些测试要真的调 Blender

护栏的价值全在「**真的跑过**」。用假的 bpy 模块把连通分量、包围盒、悬空判定
重写一遍，测的就不是生产代码 —— 恰恰是重写的那份实现可能和 `ai_guard.py` 漂移。

所以这里**跑真 Blender**（`ensure_blender.py` 解析，找不到就 skip），
断言的是护栏**能不能把坏模型挡住**，而不是「函数返回了什么」。

实测基线（macOS 15 / Blender 4.5.14 LTS，2026-10）：
    四腿圆凳（正常）   → componentCount=5，bbox 1.0m → 0.45m，GLB 19948 字节
    四腿方桌 + 悬空花瓶 → floating-parts，**不产出 GLB**
    联网脚本          → network-blocked，0.74s 退出
    死循环脚本        → timeout，5.0s 退出

跑不动 Blender 的环境（CI / 精简镜像）会整体 skip，而不是假装通过。
"""

from __future__ import annotations

import ast
import json
import struct
import subprocess
import sys
from pathlib import Path

import pytest

BLENDER_DIR = Path(__file__).resolve().parents[1] / "scripts" / "blender"
sys.path.insert(0, str(BLENDER_DIR))

from ensure_blender import find_blender  # noqa: E402
from real_sizes import REAL_HEIGHTS  # noqa: E402

_blender, _source = find_blender()
pytestmark = pytest.mark.skipif(
    _blender is None, reason=f"本机没有可用的 Blender（find_blender → {_source}）"
)


def run_pipeline(tmp_path: Path, script: str, **flags) -> dict:
    """跑一次完整通路，返回宿主打印的那行 JSON。"""
    script_path = tmp_path / "ai_script.py"
    script_path.write_text(script, encoding="utf-8")
    out = tmp_path / "prop.glb"

    argv = [
        sys.executable, str(BLENDER_DIR / "ai_model.py"),
        "--script", str(script_path), "--out", str(out),
    ]
    for key, value in flags.items():
        argv += [f"--{key.replace('_', '-')}", str(value)]

    proc = subprocess.run(argv, capture_output=True, text=True, timeout=300, check=False)
    payload = json.loads(proc.stdout.strip().splitlines()[-1])
    payload["_exit"] = proc.returncode
    payload["_out_path"] = out
    return payload


# 四腿圆凳。AI 把座高写成 1.0m（错的），护栏应按 REAL_HEIGHTS['stool'] 拉回 0.45m。
STOOL = """
import bpy
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
SEAT_R, SEAT_H, LEG_R = 0.17, 0.05, 0.025
SEAT_Z = 1.0  # 故意写错
def cyl(r, d, loc, v=24):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=d, location=loc, vertices=v)
    return bpy.context.active_object
cyl(SEAT_R, SEAT_H, (0.0, 0.0, SEAT_Z - SEAT_H / 2))
for i in range(4):
    x = SEAT_R * 0.62 * (1 if i % 2 == 0 else -1)
    y = SEAT_R * 0.62 * (1 if i < 2 else -1)
    cyl(LEG_R, SEAT_Z - SEAT_H, (x, y, (SEAT_Z - SEAT_H) / 2), 16)
"""

# 四腿方桌 + 一个悬空在桌面上方 0.6m 的花瓶。
FLOATING_VASE = """
import bpy
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
TOP_H, TOP_W, TOP_D, TOP_T, LEG = 0.75, 0.6, 0.6, 0.04, 0.05
def box(sx, sy, sz, loc):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc)
    o = bpy.context.active_object
    o.scale = (sx, sy, sz)
    return o
box(TOP_W, TOP_D, TOP_T, (0.0, 0.0, TOP_H - TOP_T / 2))
for sx in (-1, 1):
    for sy in (-1, 1):
        box(LEG, LEG, TOP_H - TOP_T,
            (sx * (TOP_W / 2 - LEG / 2), sy * (TOP_D / 2 - LEG / 2), (TOP_H - TOP_T) / 2))
bpy.ops.mesh.primitive_cylinder_add(radius=0.08, depth=0.3,
                                    location=(0.0, 0.0, TOP_H + 0.75), vertices=24)
"""


def glb_json(path: Path) -> dict:
    """解出 GLB 的第一个 JSON chunk。"""
    data = path.read_bytes()
    assert data[:4] == b"glTF", "不是 GLB"
    offset, doc = 12, None
    while offset < len(data):
        length, kind = struct.unpack("<II", data[offset:offset + 8])
        chunk = data[offset + 8:offset + 8 + length]
        if kind == 0x4E4F534A:
            doc = json.loads(chunk)
            break
        offset += 8 + length
    assert doc is not None, "GLB 里没有 JSON chunk"
    return doc


class TestHappyPath:
    def test_normalizes_scale_to_real_size(self, tmp_path):
        """AI 把座高写成 1.0m，护栏必须拉回真实座高 0.45m。"""
        result = run_pipeline(tmp_path, STOOL, kind="stool", expect_parts=5)

        assert result["ok"] is True, result["report"]
        norm = result["report"]["normalization"]
        assert norm["targetHeight"] == REAL_HEIGHTS["stool"] == 0.45
        assert norm["bboxBefore"][2] == pytest.approx(1.0, abs=1e-3)
        assert norm["bboxAfter"][2] == pytest.approx(0.45, abs=1e-3)
        # 等比缩放：横截面也必须跟着缩，不能只改高度
        assert norm["bboxAfter"][0] == pytest.approx(norm["bboxBefore"][0] * 0.45, abs=1e-3)
        assert norm["groundedTo"] == pytest.approx(0.0, abs=1e-6)

    def test_counts_connected_components(self, tmp_path):
        result = run_pipeline(tmp_path, STOOL, kind="stool", expect_parts=5)
        assert result["report"]["componentCount"] == 5
        assert result["report"]["floating"] == []

    def test_exports_uncompressed_glb(self, tmp_path):
        """上游 loader 拒绝 Draco，所以导出物绝不能带 Draco 扩展。"""
        result = run_pipeline(tmp_path, STOOL, kind="stool", expect_parts=5)
        out = result["_out_path"]
        assert out.is_file() and out.stat().st_size > 0

        doc = glb_json(out)
        used = doc.get("extensionsUsed") or []
        assert not any("draco" in (e or "").lower() for e in used), f"带了 Draco：{used}"

    def test_exports_y_up(self, tmp_path):
        """Blender 是 Z-up、glTF 是 Y-up：座高必须落在世界 Y 轴上。"""
        result = run_pipeline(tmp_path, STOOL, kind="stool", expect_parts=5)
        doc = glb_json(result["_out_path"])
        nodes = {n.get("name", ""): n for n in doc["nodes"]}
        offset = list(nodes.values())[0].get("translation", [0, 0, 0])

        lo, hi = [], []
        for accessor in doc["accessors"]:
            if "min" in accessor:
                lo.append(accessor["min"]), hi.append(accessor["max"])
        world = [
            min(l[i] for l in lo) + offset[i] for i in range(3)
        ], [
            max(h[i] for h in hi) + offset[i] for i in range(3)
        ]
        assert world[1][1] - world[0][1] == pytest.approx(0.45, abs=1e-3)
        assert world[0][1] == pytest.approx(0.0, abs=1e-3)


class TestGuardrails:
    def test_catches_floating_part_and_writes_nothing(self, tmp_path):
        """**核心护栏**：悬空部件必须在导出前被抓住，且不留半成品。"""
        result = run_pipeline(tmp_path, FLOATING_VASE, kind="table", expect_parts=6)

        assert result["ok"] is False
        assert result["report"]["reason"].startswith("floating-parts")
        assert result["report"]["componentCount"] == 6
        # 正好一个悬空件：那个花瓶（z 在桌面上方）
        assert len(result["report"]["floating"]) == 1
        assert result["report"]["floating"][0]["minZ"] == pytest.approx(1.35, abs=1e-2)
        # 坏模型绝不能落盘
        assert not result["_out_path"].exists()

    def test_component_count_mismatch_fails(self, tmp_path):
        result = run_pipeline(tmp_path, STOOL, kind="stool", expect_parts=4)
        assert result["ok"] is False
        assert result["report"]["reason"].startswith("component-count")
        assert not result["_out_path"].exists()

    def test_blocks_network(self, tmp_path):
        evil = "import bpy\nbpy.ops.mesh.primitive_cube_add()\nimport socket\nsocket.socket()\n"
        result = run_pipeline(tmp_path, evil)
        assert result["ok"] is False
        assert result["report"]["reason"].startswith("network-blocked")

    def test_timeout_kills_runaway_script(self, tmp_path):
        loop = "import bpy\nbpy.ops.mesh.primitive_cube_add()\nwhile True:\n    pass\n"
        result = run_pipeline(tmp_path, loop, timeout=5)
        assert result["ok"] is False
        assert result["timedOut"] is True
        assert result["report"]["reason"] == "timeout"
        assert not result["_out_path"].exists()

    def test_script_exception_becomes_machine_readable(self, tmp_path):
        broken = "raise ValueError('AI 脚本自己炸了')\n"
        result = run_pipeline(tmp_path, broken)
        assert result["ok"] is False
        assert result["report"]["reason"] == "ai-script-error"
        assert "ValueError" in result["report"]["error"]

    def test_retry_never_leaves_stale_output(self, tmp_path):
        """重试耗尽后也必须没有产物 —— 不许把坏模型塞进场景。"""
        result = run_pipeline(tmp_path, FLOATING_VASE, kind="table",
                              expect_parts=6, max_attempts=3)
        assert result["ok"] is False
        assert result["attempts"] == 3
        assert not result["_out_path"].exists()

    def test_locks_blender_version(self):
        """版本锁与 ensure_blender 的 BLENDER_SERIES 一致（Blender 5.0 实测 0% 通过）。

        用 ast 读常量而不是 import —— `ai_guard` 顶部 import bmesh，
        在普通 Python 里根本导不进来。
        """
        tree = ast.parse((BLENDER_DIR / "ai_guard.py").read_text(encoding="utf-8"))
        locked = next(
            ast.literal_eval(node.value)
            for node in tree.body
            if isinstance(node, ast.Assign)
            and any(getattr(t, "id", None) == "LOCKED_SERIES" for t in node.targets)
        )
        from ensure_blender import BLENDER_SERIES

        assert f"Blender{locked}" == BLENDER_SERIES, (
            "护栏锁的版本与 ensure_blender 下载/解析的系列不一致，"
            "会出现「装的是 4.5 却按另一套 API 校验」"
        )


# ── 技能包（可执行的 skill）────────────────────────────────────────────────
# 这个包的硬要求是「每一条指令 AI 都能真的做到」。最容易回归的两种坏法：
#   ① 写进 v2 并不存在的工具/字段（AI 照着调必失败）
#   ② 把上一代白模台的语法漏回来（执行层会静默丢弃）
# 下面这两个测试就是防这个的。

REPO = Path(__file__).resolve().parents[1]
SKILL_DIR = REPO / "src" / "novelvideo" / "director_desk" / "skill_packages" / "previs-props"
CONTRACT = REPO / "frontend" / "vendor" / "director-desk" / "src" / "automation" / "contract.ts"


def skill_text(name: str) -> str:
    return (SKILL_DIR / name).read_text(encoding="utf-8")


class TestSkillPackage:
    def test_package_loads_through_real_store(self, tmp_path):
        from novelvideo.director_desk.skill_store import SkillStore, package_from_folder

        pack = package_from_folder(SKILL_DIR)
        assert pack.name == "previs-props"
        assert {f.path for f in pack.files} == {
            "SKILL.md", "references/props.md", "references/blender-pipeline.md",
        }

        import asyncio

        async def install_and_read():
            store = SkillStore(tmp_path)
            await store.install(pack, source="test")
            entries = await store.list()
            body = await store.read(id=entries[0]["id"], path="references/props.md")
            return body["instructions"]

        assert len(asyncio.run(install_and_read())) > 1000

    def test_only_references_real_v2_tools(self):
        """技能里点名的每个 director_* 工具都必须真在上游契约里存在。"""
        import re

        contract = CONTRACT.read_text(encoding="utf-8")
        real = set(re.findall(r"name:\s*'(director_\w+)'", contract))

        mentioned = set()
        for name in ("SKILL.md", "references/props.md", "references/blender-pipeline.md"):
            mentioned |= set(re.findall(r"director_\w+", skill_text(name)))

        assert mentioned, "技能里一个工具都没提到，说明白写了"
        assert mentioned <= real, f"技能提到了不存在的工具：{mentioned - real}"

    def test_no_monoform_syntax_leaks_back(self):
        """v2 没有 objects 粗模 / depthMesh / type:model —— 漏回来就是教 AI 走死路。

        只禁**用法**不禁词：技能里必须能写「v2 没有 depthMesh」这句话来提醒 AI，
        所以拦的是 JSON 用法与调参键，不是那个词本身。
        """
        usage = (
            '"type":"depthMesh"', "depthMapUrl", "depth.near", "depth.density",
            "depth.fov", '"type":"model"', "modelUrl", "objects[].at",
            "routeDuration", "白模台只有这些基础形状",
        )
        for name in ("SKILL.md", "references/props.md", "references/blender-pipeline.md"):
            text = skill_text(name)
            for token in usage:
                assert token not in text, f"{name} 里漏回了上一代白模台的用法：{token}"

    def test_documents_the_honest_limits(self):
        """边界必须写清楚：既能做的不要说成做不到，不能做的不要说成能做到。"""
        text = skill_text("SKILL.md")
        for must_say in ("直说做不了", "handBinding", "contactAnchors",
                         "assetParameters", "geometry"):
            assert must_say in text, f"SKILL.md 少了 {must_say}"
