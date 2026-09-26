#!/usr/bin/env python3
"""读 GLB 的**整体**包围盒（不依赖 Blender）—— 用来验证"模板参数 → 实际尺寸"的尺度标定。

**为什么要算节点变换**：glTF 的 accessor `min`/`max` 是**局部坐标**，零件的位置/缩放
放在**节点**上。只读 accessor 会得到"最大那个零件的自身尺寸"（实测踩过：rail 读出 3.000
正好等于 length 参数，因为钢轨的局部长度就是 3.0，而它的位置在节点平移里）。

做法：从 `scenes[0].nodes` 递归遍历节点树，累积 TRS 矩阵，把每个 primitive 的局部 AABB
的 **8 个角点**变换到世界空间，取整体并集。

用法：python3 scripts/blender/glb_bounds.py out.glb
"""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

IDENTITY = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]]


def read_glb_json(path: Path) -> dict:
    data = path.read_bytes()
    magic, _version, _length = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67:  # 'glTF'
        raise SystemExit(f"不是 GLB：{path}")
    offset = 12
    while offset < len(data):
        chunk_len, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        if chunk_type == 0x4E4F534A:  # 'JSON'
            return json.loads(data[offset:offset + chunk_len].decode("utf-8"))
        offset += chunk_len
    raise SystemExit("GLB 里没有 JSON chunk")


def mat_mul(a: list[list[float]], b: list[list[float]]) -> list[list[float]]:
    """3×4 仿射矩阵相乘（a∘b）。"""
    out = [[0.0] * 4 for _ in range(3)]
    for i in range(3):
        for j in range(4):
            out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j] + (a[i][3] if j == 3 else 0.0)
    return out


def trs_matrix(node: dict) -> list[list[float]]:
    """节点的 local 变换。优先用 matrix 字段（列主序），否则 TRS。"""
    if "matrix" in node:
        m = node["matrix"]  # 列主序 16 元素
        return [[m[0], m[4], m[8], m[12]], [m[1], m[5], m[9], m[13]], [m[2], m[6], m[10], m[14]]]
    tx, ty, tz = node.get("translation", [0.0, 0.0, 0.0])
    qx, qy, qz, qw = node.get("rotation", [0.0, 0.0, 0.0, 1.0])
    sx, sy, sz = node.get("scale", [1.0, 1.0, 1.0])
    rot = [
        [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
        [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
        [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
    ]
    return [[rot[i][0] * sx, rot[i][1] * sy, rot[i][2] * sz, [tx, ty, tz][i]] for i in range(3)]


def transform_point(m: list[list[float]], p: list[float]) -> list[float]:
    return [m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2] + m[i][3] for i in range(3)]


def bounds(path: Path) -> dict:
    gltf = read_glb_json(path)
    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    mesh_count = 0

    def visit(index: int, parent: list[list[float]]) -> None:
        nonlocal mesh_count
        node = gltf["nodes"][index]
        world = mat_mul(parent, trs_matrix(node))
        mesh_index = node.get("mesh")
        if mesh_index is not None:
            mesh_count += 1
            for prim in gltf["meshes"][mesh_index].get("primitives", []):
                accessor_index = prim.get("attributes", {}).get("POSITION")
                if accessor_index is None:
                    continue
                accessor = gltf["accessors"][accessor_index]
                minimum, maximum = accessor.get("min"), accessor.get("max")
                if not minimum or not maximum:
                    continue
                for corner in range(8):  # AABB 的 8 个角点
                    point = [minimum[i] if (corner >> i) & 1 == 0 else maximum[i] for i in range(3)]
                    world_point = transform_point(world, point)
                    for axis in range(3):
                        lo[axis] = min(lo[axis], world_point[axis])
                        hi[axis] = max(hi[axis], world_point[axis])
        for child in node.get("children", []):
            visit(child, world)

    for root in gltf.get("scenes", [{}])[gltf.get("scene", 0)].get("nodes", []):
        visit(root, IDENTITY)

    if lo[0] == float("inf"):
        raise SystemExit("没找到 POSITION accessor")
    return {
        "size": [round(hi[i] - lo[i], 4) for i in range(3)],
        "min": [round(v, 4) for v in lo],
        "max": [round(v, 4) for v in hi],
        "meshes": mesh_count,
        "compressed": "KHR_draco_mesh_compression" in (gltf.get("extensionsUsed") or []),
        "bytes": path.stat().st_size,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("用法：glb_bounds.py <file.glb>")
    print(json.dumps(bounds(Path(sys.argv[1])), ensure_ascii=False))
