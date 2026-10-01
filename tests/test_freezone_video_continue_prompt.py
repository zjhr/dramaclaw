"""画布视频节点「向后延长」的提示词推荐。

这块的三个关键契约，任何一个被改坏都会以「提示词莫名其妙」的形式出现，而不是报错：

1. 抽帧口径——喂给视觉模型的必须是**整片采样帧 + 片尾锚点帧**，且锚点在最后。
   只给片尾一帧，模型看不到这条片子在演什么，写出来的下一段会换人换场。
2. 时长与方向要进任务描述——用户把时长调大、调方向，是期待提示词跟着变的。
3. 方向 id 是前后端契约，对不上必须报错而不是静默回退成 `auto`。
"""

from __future__ import annotations

import asyncio
import re
import subprocess
from pathlib import Path

import pytest

from novelvideo.freezone.continue_prompt import (
    VIDEO_CONTINUE_DIRECTIONS,
    build_continue_prompt_task,
    normalize_video_continue_direction,
    suggest_continue_prompt_from_frames,
)

REPOSITORY_ROOT = Path(__file__).parents[1]
TOOLBAR_TSX = REPOSITORY_ROOT / "frontend" / "src" / "features" / "canvas" / "ui" / "NodeActionToolbar.tsx"


def _make_source(path: Path, *, duration: float = 6.0, rate: int = 30) -> Path:
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", f"testsrc=duration={duration}:size=320x240:rate={rate}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path),
        ],
        check=True,
        capture_output=True,
    )
    return path


async def _fake_egress_prepare(**_kwargs):
    return None


async def _fake_egress_complete(_egress, *, result):
    return None


# 路由 / runner 接线 ------------------------------------------------------------


def test_continue_suggest_prompt_route_registered() -> None:
    from novelvideo.api.routes import freezone

    paths = [
        (getattr(route, "path", ""), sorted(getattr(route, "methods", None) or []))
        for route in freezone.router.routes
        if getattr(route, "path", "").endswith(
            "/freezone/video/continue/suggest-prompt"
        )
    ]
    assert paths, "continue suggest-prompt route not registered on freezone.router"
    assert any("POST" in methods for _path, methods in paths), paths


def test_continue_suggest_prompt_runner_registered() -> None:
    from novelvideo.task_backend.runners import freezone as runners  # noqa: F401
    from novelvideo.task_backend.registry import get_project_task_runner

    assert get_project_task_runner("freezone_video_continue_suggest_prompt") is not None


def test_continue_suggest_prompt_job_result_is_readable() -> None:
    """任务中心与前端取结果都走同一个端点：任务类型必须在允许名单里，
    并且输出按 json 解析（写成 mp4 路径的话前端会拿到一段二进制当提示词）。"""
    from novelvideo.api.routes import freezone

    source = Path(freezone.__file__).read_text(encoding="utf-8")
    assert source.count('"freezone_video_continue_suggest_prompt"') >= 4
    assert "_continue_suggest_prompt_output_path" in source


def test_continue_suggest_prompt_has_human_task_name() -> None:
    from novelvideo.api.routes.tasks import _TASK_TYPE_LABELS

    assert _TASK_TYPE_LABELS.get("freezone_video_continue_suggest_prompt")


# 方向 id 契约 ----------------------------------------------------------------


def test_direction_catalog_matches_frontend_options() -> None:
    """方向 id 是前后端契约：前端多一个 chip，后端就得有一句创作指令，
    反之用户点了没反应的 chip。"""
    source = TOOLBAR_TSX.read_text(encoding="utf-8")
    block = re.search(
        r"const CONTINUE_DIRECTION_OPTIONS: FreezoneVideoContinueDirection\[\] = \[(.*?)\];",
        source,
        re.S,
    )
    assert block, "CONTINUE_DIRECTION_OPTIONS not found in the toolbar"
    frontend_ids = set(re.findall(r'"([a-z]+)"', block.group(1)))
    assert frontend_ids == set(VIDEO_CONTINUE_DIRECTIONS)


def test_unknown_direction_is_rejected() -> None:
    """静默回退成 auto 会让用户拿到一段与自己所选不符的提示词，且无从察觉。"""
    with pytest.raises(ValueError, match="unknown continue direction"):
        normalize_video_continue_direction("slowmo")
    assert normalize_video_continue_direction("") == "auto"
    assert normalize_video_continue_direction(None) == "auto"
    assert normalize_video_continue_direction("camera") == "camera"


# 任务描述 --------------------------------------------------------------------


def test_task_description_carries_duration_direction_and_anchor() -> None:
    prompt = build_continue_prompt_task(
        duration_seconds=8.0, direction="camera", frame_count=4
    )
    # 时长与方向是这次推荐的全部意义所在，缺一条推荐就退回成泛泛的"接着演"。
    assert "8.0" in prompt
    assert VIDEO_CONTINUE_DIRECTIONS["camera"] in prompt
    # 锚点帧的位置必须在描述里说清楚：模型分不清哪张是接缝就会重演一遍原片。
    assert "最后一张" in prompt
    assert "4" in prompt


def test_beat_plan_scales_with_duration() -> None:
    """时长变了，动作节拍数量也得跟着变，否则 12 秒的活会被塞进一个动作。"""
    short = build_continue_prompt_task(
        duration_seconds=3.0, direction="auto", frame_count=2
    )
    long = build_continue_prompt_task(
        duration_seconds=12.0, direction="auto", frame_count=2
    )
    assert "一个完整动作" in short
    assert "3 个递进的动作节拍" in long


# 抽帧 ------------------------------------------------------------------------


def test_extract_continue_anchor_frames_puts_anchor_last(tmp_path: Path) -> None:
    from novelvideo.freezone.jobs import extract_continue_anchor_frames

    src = _make_source(tmp_path / "src.mp4", duration=6.0)
    frames = asyncio.run(
        extract_continue_anchor_frames(
            source_path=str(src),
            end_seconds=6.0,  # 故意等于片长，验证会被夹回片内
            out_dir=tmp_path / "frames",
            sample_count=3,
        )
    )
    assert len(frames) == 4
    assert frames[-1].name == "anchor.png"
    assert all(frame.exists() for frame in frames)
    # 采样帧彼此要拉开距离：贴着锚点抽等于给模型同一张图。
    assert [frame.name for frame in frames[:-1]] == [
        "context_00.png",
        "context_01.png",
        "context_02.png",
    ]


def test_extract_continue_anchor_frames_rejects_missing_source(tmp_path: Path) -> None:
    from novelvideo.freezone.jobs import extract_continue_anchor_frames

    with pytest.raises(FileNotFoundError):
        asyncio.run(
            extract_continue_anchor_frames(
                source_path=str(tmp_path / "nope.mp4"),
                end_seconds=1.0,
                out_dir=tmp_path / "frames",
            )
        )


# 视觉 leaf -------------------------------------------------------------------


def test_suggest_continue_prompt_end_to_end(tmp_path: Path, monkeypatch) -> None:
    """推荐 leaf 端到端：真抽帧、视觉调用打成桩，验证任务描述与图片张数。"""
    from novelvideo.freezone import continue_prompt, jobs

    src = _make_source(tmp_path / "src.mp4", duration=6.0)
    frames = asyncio.run(
        jobs.extract_continue_anchor_frames(
            source_path=str(src),
            end_seconds=5.9,
            out_dir=tmp_path / "frames",
            sample_count=3,
        )
    )
    seen: dict[str, object] = {}

    async def fake_vision(*, prompt, images, **_kwargs):
        seen["prompt"] = prompt
        seen["image_count"] = len(images)
        return "model-name", "```\n女主推门而入，镜头缓慢横移\n```"

    monkeypatch.setattr(continue_prompt, "call_freezone_vision_model", fake_vision)
    # egress 的 prepare/complete 是函数体内 import 的，要 patch 它真正的所在模块。
    import novelvideo.freezone.presets as presets

    monkeypatch.setattr(presets, "prepare_freezone_vision_egress", _fake_egress_prepare)
    monkeypatch.setattr(presets, "complete_freezone_vision_egress", _fake_egress_complete)

    result = asyncio.run(
        continue_prompt.suggest_continue_prompt_from_frames(
            frame_paths=frames,
            duration_seconds=6.0,
            direction="plot",
        )
    )
    # markdown 围栏必须剥掉：它会被原样拼进送上游的提示词里。
    assert result == "女主推门而入，镜头缓慢横移"
    assert seen["image_count"] == 4
    assert VIDEO_CONTINUE_DIRECTIONS["plot"] in str(seen["prompt"])


def test_suggest_continue_prompt_needs_context_frames(tmp_path: Path) -> None:
    """只有锚点帧没有上下文，等于让模型凭空续写；直接拒掉。"""
    anchor = tmp_path / "anchor.png"
    anchor.write_bytes(b"not-really-a-png")
    with pytest.raises(ValueError, match="context frames"):
        asyncio.run(
            suggest_continue_prompt_from_frames(
                frame_paths=[anchor],
                duration_seconds=5.0,
                direction="auto",
            )
        )


# 请求 schema -----------------------------------------------------------------


def test_continue_suggest_prompt_schema_bounds() -> None:
    import pydantic

    from novelvideo.api.schemas import FreezoneVideoContinueSuggestPromptRequest

    with pytest.raises(pydantic.ValidationError):
        FreezoneVideoContinueSuggestPromptRequest(source_url="x", end_seconds=0)
    with pytest.raises(pydantic.ValidationError):
        FreezoneVideoContinueSuggestPromptRequest(
            source_url="x", end_seconds=1.0, duration_seconds=0
        )
    # 方向不在枚举内时直接 422，而不是落回 auto。
    with pytest.raises(pydantic.ValidationError):
        FreezoneVideoContinueSuggestPromptRequest(
            source_url="x", end_seconds=1.0, direction="slowmo"
        )
    ok = FreezoneVideoContinueSuggestPromptRequest(source_url="x", end_seconds=1.0)
    assert ok.direction == "auto"
    assert ok.duration_seconds == 5