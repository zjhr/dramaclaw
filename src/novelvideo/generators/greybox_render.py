"""白模渲染层：深度图 -> 无材质灰白几何图像。

纯 numpy 实现，不依赖 torch —— 因此可独立单测（见文件末尾 __main__ 自检）。

原理：单目深度是「几何」最直接的代理。把深度反投影成点云、对点云求法线，
再用朗伯着色压成灰阶，即得「只有几何、没有材质」的白模观感。
"""

from __future__ import annotations

import numpy as np


def normalize_depth(depth: np.ndarray, *, invert: bool = False) -> np.ndarray:
    """把相对深度线性归一化到 [0, 1]。

    invert 用于兜住 DepthAnything 的符号方向（大=远 还是 大=近，需实测确认）。
    常量图（无深度变化）返回全 0.5，避免除零。
    """
    d = np.asarray(depth, dtype=np.float32)
    lo, hi = float(d.min()), float(d.max())
    if hi - lo < 1e-6:
        return np.full_like(d, 0.5)
    out = (d - lo) / (hi - lo)
    return 1.0 - out if invert else out


def depth_to_pointcloud(depth01: np.ndarray, *, fov_deg: float) -> np.ndarray:
    """归一化深度 -> 针孔相机点云 (H, W, 3)，z 轴朝前。"""
    h, w = depth01.shape
    f = (w / 2.0) / np.tan(np.radians(fov_deg) / 2.0)
    u, v = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    z = depth01
    x = (u - w / 2.0) * z / f
    y = (v - h / 2.0) * z / f
    return np.stack([x, y, z], axis=-1)


def pointcloud_normals(pc: np.ndarray) -> np.ndarray:
    """有限差分求法线，无效处（深度边缘）回落为 (0, 0, 1)。"""
    gy, gx = np.gradient(pc, axis=(0, 1))
    n = np.cross(gx, gy)
    norm = np.linalg.norm(n, axis=-1, keepdims=True)
    valid = norm > 1e-8
    n = np.where(valid, n / np.where(valid, norm, 1.0), np.array([0.0, 0.0, 1.0]))
    return n


def smooth_depth(depth01: np.ndarray, *, sigma: float = 1.0) -> np.ndarray:
    """轻度均值平滑（3x3 两遍 ≈ 高斯 sigma≈1），压掉深度量化噪声。

    必要性：单目深度在平坦区域有量化台阶，法线对噪声极敏感——
    不平滑就出现横向条纹伪影。这是 normal-from-height 的标准前置步骤。
    """
    if sigma <= 0:
        return depth01
    a = depth01
    # 边缘复制填充，避免边缘被拉黑
    padded = np.pad(a, 1, mode="edge")
    for _ in range(2):
        acc = np.zeros_like(a)
        for dy in (0, 1, 2):
            for dx in (0, 1, 2):
                acc += padded[dy : dy + a.shape[0], dx : dx + a.shape[1]]
        a = acc / 9.0
        padded = np.pad(a, 1, mode="edge")
    return a


def depth_to_greybox(
    depth: np.ndarray,
    *,
    fov_deg: float = 60.0,
    ambient: float = 0.15,
    base_grey: float = 0.9,
    light_dir: tuple[float, float, float] = (-0.4, -0.5, 0.75),
    fill_strength: float = 0.45,
    outline: float = 0.0,
    invert: bool = False,
    gamma: float = 2.2,
    smooth: float = 1.0,
    shade: str = "lambert",
) -> np.ndarray:
    """深度图 -> 白模图像 (H, W) uint8。

    参数（全部可经请求体调节，不必改代码）：
    - fov_deg: 反投影用视场角，决定起伏强度
    - ambient: 环境光比例 0-1（图形学经典值 0.1，见 learnopengl Basic Lighting；
      默认 0.15 略留灰避免纯黑背光面，调大=更平更灰）
    - base_grey: 受光面基准灰度 0-1（线性空间）
    - light_dir: 主光源方向（会被归一化），左上打光
    - fill_strength: 填充光强度 0-1（背光面兜底，图形学标准 fill light；0 关闭）
    - outline: 深度边缘描边强度 0-1，0 为关闭
    - invert: 深度符号兜底
    - gamma: 输出 gamma 编码指数（显示器 2.2 定律，见 learnopengl Gamma Correction）。
      lambert 在线性空间计算，直接输出会被显示器压暗导致暗部细节全糊；
      默认 2.2 = 线性->sRGB 编码。传 0 关闭（输出纯线性值，更暗）
    - smooth: 深度预平滑强度（0 关；1 = 推荐）。单目深度有量化台阶，
      法线对噪声极敏感，不平滑会出横向条纹。normal-from-height 标准前置
    - shade: 着色模式。
      `"lambert"`（默认）深度->点云->法线->朗伯光照，有明确的明暗起伏与体积感，
      代价是表面带方向性明暗（观感偏素描/浮雕）。
      `"depth"` 纯深度灰度：深度值直接当灰度，近处白、远处暗，无光照无描边。
      这就是最常见的「深度图可视化」样式，也是拿深度视频当结构参考时
      信息最干净的一种——不掺任何光照方向的歧义。

    默认值依据（2026-09-21 资料考证）：
    - ambient 0.15：learnopengl 官方教程 ambientStrength=0.1；早期默认 0.35 是其
      3.5 倍，导致画面发灰、无结构感
    - gamma 2.2：不做编码时线性 0.5 上屏仅 0.218（2.2 幂），背光面糊死
    - smooth 1.0：量化噪声经法线放大成条纹，预平滑是标准解法
    """
    d01 = normalize_depth(depth, invert=invert)

    if shade == "depth":
        # 纯深度灰度：省掉反投影/法线/光照整条链，深度本身就是灰度。
        # smooth 仍然有用——单目深度的量化台阶在纯灰度下是可见的色带。
        grey = smooth_depth(d01, sigma=smooth) if smooth > 0 else d01
        if gamma and gamma > 0.0:
            # gamma 在这里不是补暗部，而是把中远景压暗、拉开前景对比：
            # 「近白远灰」的观感主要来自这一步，不是来自深度分布本身。
            grey = np.power(np.clip(grey, 0.0, 1.0), 1.0 / gamma)
        return (np.clip(grey, 0.0, 1.0) * 255.0).round().astype(np.uint8)

    pc = depth_to_pointcloud(smooth_depth(d01, sigma=smooth) if smooth > 0 else d01, fov_deg=fov_deg)
    n = pointcloud_normals(pc)

    def _unit(v: tuple[float, float, float]) -> np.ndarray | None:
        a = np.asarray(v, dtype=np.float32)
        norm = float(np.linalg.norm(a))
        if norm < 1e-6:
            return None
        return a / norm

    light = _unit(light_dir)
    # 双光源朗伯：主光 + 弱填充光取大值，背光面不再死黑（图形学 fill light 惯例）
    lambert = np.clip(n @ light, 0.0, 1.0)
    if fill_strength > 0:
        fill = _unit((0.5, 0.3, 0.6))
        lambert = np.maximum(lambert, np.clip(n @ fill, 0.0, 1.0) * fill_strength)
    shade = ambient + (1.0 - ambient) * lambert
    grey = np.clip(base_grey * shade, 0.0, 1.0)

    if outline > 0.0:
        # 深度梯度大 = 几何边缘，压暗成描边
        gy, gx = np.gradient(d01)
        edge = np.hypot(gx, gy)
        edge = edge / max(float(edge.max()), 1e-8)
        grey = grey * (1.0 - outline * np.clip(edge * 4.0, 0.0, 1.0))

    if gamma and gamma > 0.0:
        # 线性 -> sRGB 感知编码：不做的后果是暗部被显示器 2.2 幂压成一团黑
        grey = np.power(np.clip(grey, 0.0, 1.0), 1.0 / gamma)

    return (grey * 255.0).round().astype(np.uint8)


if __name__ == "__main__":
    # 自检：左近右远的斜坡，应产生「左亮右暗」的朝向变化（光源在左上）
    h = w = 64
    ramp = np.tile(np.linspace(0.9, 0.1, w, dtype=np.float32), (h, 1))
    out = depth_to_greybox(ramp)
    assert out.shape == (h, w), f"shape mismatch: {out.shape}"
    assert out.dtype == np.uint8, f"dtype mismatch: {out.dtype}"
    assert out.min() >= 0 and out.max() <= 255, "value out of [0, 255]"
    assert out[:, 5].mean() > out[:, w - 5].mean(), "ramp should shade left-bright"

    # 常量图（无深度变化）不应崩
    flat = depth_to_greybox(np.full((8, 8), 0.5, dtype=np.float32))
    assert flat.shape == (8, 8)

    # invert 应反转明暗关系
    inv = depth_to_greybox(ramp, invert=True)
    assert inv[:, 5].mean() < inv[:, w - 5].mean(), "invert should flip shading"

    # outline 应让边缘（中间突变处）比无描边时更暗
    step = np.zeros((16, 16), dtype=np.float32)
    step[:, 8:] = 1.0
    no_outline = depth_to_greybox(step)
    with_outline = depth_to_greybox(step, outline=0.8)
    assert with_outline[:, 8].mean() < no_outline[:, 8].mean(), "outline should darken edges"

    print("greybox_render self-check OK")
