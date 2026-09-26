"""白模深度推理层：transformers Depth Anything V2（透视模型）。

与 `pano_sharp.py` 的关键差异：那边 `predict_da2_distance` **每次调用都重建模型**
（`build_da2_model` 在函数内），白模逐帧推理必须**模型加载一次、循环复用**，
否则 96 帧会慢几个数量级。

torch/transformers 全部函数内导入 —— 本模块 import 不需要重依赖，
`pano_sharp.choose_device` 可安全顶层复用（该模块用 `_LazyModule` 延迟加载 torch）。
"""

from __future__ import annotations

import importlib.util
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from novelvideo.director_world.pano_sharp import choose_device

GREYBOX_DEPTH_MODEL_ID = "depth-anything/Depth-Anything-V2-Small-hf"

# ---- Video-Depth-Anything 后端（时序一致，CVPR 2025 Highlight）----------------
# 仓库 clone 到哪就在哪找（与 pano_sharp.find_installed_da2_root 同思路：探测而非
# vendor）。权重 ~116MB。一次性 setup 命令：
#   git clone --depth 1 https://github.com/DepthAnything/Video-Depth-Anything.git ~/.cache/greybox/vda_repo
#   下载 video_depth_anything_vits.pth 到 ~/.cache/greybox/vda/
VDA_REPO_CANDIDATES = [
    Path.home() / ".cache/greybox/vda_repo",
    Path(__file__).resolve().parents[2] / "third_party" / "Video-Depth-Anything",
]
VDA_WEIGHTS_PATH = Path.home() / ".cache/greybox/vda/video_depth_anything_vits.pth"
VDA_MODEL_CONFIG = {"encoder": "vits", "features": 64, "out_channels": [48, 96, 192, 384]}


def depth_model_available() -> bool:
    """torch 与 transformers 均可导入才为真（仿 `pano_sharp.da2_available` 的 find_spec 写法）。"""
    return (
        importlib.util.find_spec("torch") is not None
        and importlib.util.find_spec("transformers") is not None
    )


def vda_available() -> bool:
    """Video-Depth-Anything 仓库与权重都在位才为真。"""
    repo_ok = any((p / "video_depth_anything").is_dir() for p in VDA_REPO_CANDIDATES)
    return repo_ok and VDA_WEIGHTS_PATH.exists()


def load_depth_model(device_name: str = "auto") -> tuple[Any, Any, Any]:
    """加载 processor + model + device。**只在循环外调一次**。"""
    import torch  # noqa: F401  (重依赖，函数内导入)
    from transformers import AutoImageProcessor, AutoModelForDepthEstimation

    device = choose_device(device_name)
    processor = AutoImageProcessor.from_pretrained(GREYBOX_DEPTH_MODEL_ID)
    model = AutoModelForDepthEstimation.from_pretrained(GREYBOX_DEPTH_MODEL_ID)
    model.eval()
    return processor, model.to(device), device


def predict_depth(
    image: Image.Image,
    processor: Any,
    model: Any,
    device: Any,
) -> np.ndarray:
    """单帧 -> (H, W) float32 相对深度，插值回原始分辨率。

    Depth Anything 的 `predicted_depth` 是模型原生分辨率（约 518 边），
    这里 bicubic 上采样回源尺寸再交给渲染层。
    """
    import torch

    inputs = processor(images=image.convert("RGB"), return_tensors="pt").to(device)
    with torch.inference_mode():
        depth = model(**inputs).predicted_depth
        depth = torch.nn.functional.interpolate(
            depth.unsqueeze(1),
            size=image.size[::-1],  # PIL size 是 (W, H)，interpolate 要 (H, W)
            mode="bicubic",
            align_corners=False,
        )[0, 0]
    return depth.detach().float().cpu().numpy()


def predict_depth_sequence_vda(images: list[Image.Image], device: Any) -> np.ndarray:
    """VDA 整段推理：一次吃全部帧，输出 [T, H, W] 相对深度。

    与逐帧后端的本质差异：VDA 在 32 帧窗口内做时序 attention 并用关键帧对齐
    融合，帧间深度一致（不闪烁）；代价是必须一次拿全部帧、显存/内存随
    视频长度增长（官方建议不超过 16:9 比例的较长视频）。
    """
    import torch

    for repo in VDA_REPO_CANDIDATES:
        if (repo / "video_depth_anything").is_dir():
            if str(repo) not in sys.path:
                sys.path.insert(0, str(repo))
            break
    else:
        raise RuntimeError(
            "Video-Depth-Anything repo not found. Run: "
            "git clone --depth 1 https://github.com/DepthAnything/Video-Depth-Anything.git "
            f"{VDA_REPO_CANDIDATES[0]}"
        )

    from video_depth_anything.video_depth import VideoDepthAnything

    model = VideoDepthAnything(**VDA_MODEL_CONFIG)
    model.load_state_dict(
        torch.load(VDA_WEIGHTS_PATH, map_location="cpu", weights_only=True), strict=True
    )
    model.to(device).eval()

    frames = np.stack([np.asarray(im.convert("RGB")) for im in images])
    with torch.no_grad():
        depths, _fps = model.infer_video_depth(
            frames,
            target_fps=-1,
            input_size=518,
            device=str(device),
            fp32=True,
        )
    return depths


def iter_frame_depths(
    frame_paths: list[Path],
    *,
    device_name: str = "auto",
    progress_callback: Any = None,
    backend: str = "frame",
) -> Iterator[np.ndarray]:
    """逐帧产出深度数组。两种后端：

    - ``backend="frame"``（默认）：transformers DA V2 逐帧推理，模型加载一次复用
    - ``backend="vda"``：Video-Depth-Anything 整段推理（时序一致，不闪烁），
      算完后逐帧 yield —— 接口与 frame 后端一致，调用方无感知
    """
    if backend == "vda":
        if not vda_available():
            raise RuntimeError(
                "greybox VDA backend requires the Video-Depth-Anything repo and weights. "
                "Setup: git clone --depth 1 https://github.com/DepthAnything/Video-Depth-Anything.git "
                f"{VDA_REPO_CANDIDATES[0]} ; download video_depth_anything_vits.pth to {VDA_WEIGHTS_PATH.parent}"
            )
        import torch

        device = choose_device(device_name)
        images = [Image.open(p) for p in frame_paths]
        if progress_callback is not None:
            progress_callback(0.02, "VDA 整段推理中（时序一致模式，较慢）...")
        depths = predict_depth_sequence_vda(images, device)
        total = len(frame_paths)
        for i, depth in enumerate(depths, 1):
            if progress_callback is not None:
                progress_callback(i / total, f"深度推理(VDA) {i}/{total}")
            yield depth
        return

    if not depth_model_available():
        raise RuntimeError(
            "greybox depth requires torch + transformers. Install the 'world' extra "
            "(uv sync --extra world); model weights download at first run."
        )
    processor, model, device = load_depth_model(device_name)
    total = len(frame_paths)
    for i, path in enumerate(frame_paths, 1):
        yield predict_depth(Image.open(path), processor, model, device)
        if progress_callback is not None:
            progress_callback(i / total, f"深度推理 {i}/{total}")


if __name__ == "__main__":
    # 自检不下载权重：只验证依赖探测可用。真实推理冒烟见计划 L2：
    #   python -c "from transformers import pipeline; pipeline('depth-estimation',
    #   model='depth-anything/Depth-Anything-V2-Small-hf')"
    available = depth_model_available()
    print(f"depth_model_available: {available}")
    if not available:
        print("SKIP: torch/transformers 未安装，装上 'world' extra 后重跑")
    else:
        print("OK: 依赖就绪，可跑 L2 权重冒烟")
