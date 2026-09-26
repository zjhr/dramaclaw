"""片段重拍（run_freezone_video_reshoot）单测。

模型生成段用 monkeypatch 的假 runner 顶替，只验「校验/抽帧/对齐/拼接」逻辑，
不依赖真实视频 API——真实 API 路径由 docs/goals/video-reshoot 的证据报告覆盖。
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from novelvideo.api.schemas import FreezoneVideoReshootRequest
from novelvideo.freezone import jobs
from novelvideo.freezone.jobs import run_freezone_video_reshoot


def _probe(path: Path) -> dict:
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height,r_frame_rate",
            "-show_entries", "format=duration",
            "-of", "json", str(path),
        ],
        capture_output=True, text=True, check=True,
    ).stdout
    data = json.loads(out)
    stream = data["streams"][0]
    return {
        "duration": float(data["format"]["duration"]),
        "width": int(stream["width"]),
        "height": int(stream["height"]),
        "fps": stream["r_frame_rate"],
    }


def _make_source(path: Path, *, duration: float = 5.0, audio: bool = True, rate: int = 30) -> Path:
    """合成一个 testsrc 视频；audio=True 时带正弦音轨。"""
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", f"testsrc=duration={duration}:size=320x240:rate={rate}",
    ]
    if audio:
        cmd += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={duration}"]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest"]
    if audio:
        cmd += ["-c:a", "aac"]
    cmd += [str(path)]
    subprocess.run(cmd, capture_output=True, text=True, check=True)
    return path


def _stub_gen(monkeypatch, clip_duration: float, *, with_audio: bool = True) -> None:
    """把 run_freezone_video_gen 换成产出指定时长片段的假实现。

    假片段故意用和源不同的参数（不同时长/带音轨），用来验证对齐与拼接逻辑。
    """
    created: dict[str, Path] = {}

    async def fake_gen(*, project_dir: Path, job_id: str, **_kwargs):
        out = jobs.outputs_dir(project_dir, "freezone_video_gen") / f"{job_id}.mp4"
        out.parent.mkdir(parents=True, exist_ok=True)
        cmd = [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", f"testsrc=duration={clip_duration}:size=320x240:rate=30",
        ]
        if with_audio:
            cmd += ["-f", "lavfi", "-i", f"sine=frequency=880:duration={clip_duration}"]
        cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest"]
        if with_audio:
            cmd += ["-c:a", "aac"]
        cmd += [str(out)]
        subprocess.run(cmd, capture_output=True, text=True, check=True)
        created["path"] = out
        return out

    monkeypatch.setattr(jobs, "run_freezone_video_gen", fake_gen)


# ---------------------------------------------------------------- 校验


def test_reshoot_rejects_bad_range(tmp_path: Path) -> None:
    import asyncio

    src = _make_source(tmp_path / "src.mp4")
    for job_id, start, end, pattern in (
        ("j1", 3.0, 3.0, "greater than"),
        ("j2", 4.0, 2.0, "greater than"),
        ("j3", -1.0, 2.0, ">= 0"),
    ):
        with pytest.raises(ValueError, match=pattern):
            asyncio.run(
                run_freezone_video_reshoot(
                    project_dir=tmp_path, job_id=job_id, source_path=str(src),
                    start_seconds=start, end_seconds=end,
                )
            )


def test_reshoot_rejects_over_max_duration(tmp_path: Path) -> None:
    import asyncio

    src = _make_source(tmp_path / "src.mp4")
    with pytest.raises(ValueError, match="5"):
        asyncio.run(
            run_freezone_video_reshoot(
                project_dir=tmp_path, job_id="j4", source_path=str(src),
                start_seconds=0.0, end_seconds=12.0, max_duration_seconds=5,
            )
        )


def test_reshoot_missing_source(tmp_path: Path) -> None:
    import asyncio

    with pytest.raises(FileNotFoundError):
        asyncio.run(
            run_freezone_video_reshoot(
                project_dir=tmp_path, job_id="j5",
                source_path=str(tmp_path / "nope.mp4"),
                start_seconds=0.0, end_seconds=1.0,
            )
        )


# ---------------------------------------------------------------- 端到端（合成腿）


def test_reshoot_synthetic_end_to_end(tmp_path: Path, monkeypatch) -> None:
    import asyncio

    src = _make_source(tmp_path / "src.mp4", duration=5.0)
    src_info = _probe(src)
    _stub_gen(monkeypatch, clip_duration=2.0)

    clip, full, meta = asyncio.run(
        run_freezone_video_reshoot(
            project_dir=tmp_path, job_id="e2e", source_path=str(src),
            start_seconds=1.5, end_seconds=3.5,
        )
    )

    clip_info = _probe(clip)
    full_info = _probe(full)

    # clip 时长对齐区间 2.0s
    assert 1.7 <= clip_info["duration"] <= 2.3, clip_info
    # full 时长 ≈ 源 5s ± 0.5
    assert 4.5 <= full_info["duration"] <= 5.5, full_info
    # 分辨率与帧率继承源
    assert (full_info["width"], full_info["height"]) == (src_info["width"], src_info["height"])
    assert full_info["fps"] == src_info["fps"]
    # 音轨保留
    audio = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(full)],
        capture_output=True, text=True,
    ).stdout.strip()
    assert audio, "full output lost the audio track"
    # meta 字段齐全
    for key in ("clip_path", "full_path", "start_seconds", "end_seconds",
                "span_seconds", "source_duration", "clip_duration",
                "full_duration", "concat_retry", "frames_extracted"):
        assert key in meta, f"meta missing {key}"
    assert meta["span_seconds"] == pytest.approx(2.0)
    assert meta["frames_extracted"] == 2


def test_reshoot_aligns_short_clip(tmp_path: Path, monkeypatch) -> None:
    """生成段只有 1.2s → 应冻帧补足到区间 2.0s。"""
    import asyncio

    src = _make_source(tmp_path / "src.mp4", duration=5.0)
    _stub_gen(monkeypatch, clip_duration=1.2)

    clip, _full, meta = asyncio.run(
        run_freezone_video_reshoot(
            project_dir=tmp_path, job_id="short", source_path=str(src),
            start_seconds=1.0, end_seconds=3.0,
        )
    )
    assert 1.9 <= _probe(clip)["duration"] <= 2.1, _probe(clip)
    assert meta["clip_duration"] == pytest.approx(2.0, abs=0.1)


def test_reshoot_aligns_long_clip(tmp_path: Path, monkeypatch) -> None:
    """生成段 3.0s 超出区间 2.0s → 应裁齐。"""
    import asyncio

    src = _make_source(tmp_path / "src.mp4", duration=5.0)
    _stub_gen(monkeypatch, clip_duration=3.0)

    clip, _full, meta = asyncio.run(
        run_freezone_video_reshoot(
            project_dir=tmp_path, job_id="long", source_path=str(src),
            start_seconds=1.0, end_seconds=3.0,
        )
    )
    assert 1.9 <= _probe(clip)["duration"] <= 2.1, _probe(clip)


def test_reshoot_source_without_audio(tmp_path: Path, monkeypatch) -> None:
    """源无音轨：不报错，full 产出（可无音轨）。"""
    import asyncio

    src = _make_source(tmp_path / "src.mp4", duration=5.0, audio=False)
    _stub_gen(monkeypatch, clip_duration=2.0, with_audio=False)

    _clip, full, meta = asyncio.run(
        run_freezone_video_reshoot(
            project_dir=tmp_path, job_id="noaudio", source_path=str(src),
            start_seconds=1.0, end_seconds=3.0,
        )
    )
    assert full.exists()
    assert meta["concat_retry"] is None


def test_reshoot_maps_model_to_generator_backend(tmp_path: Path, monkeypatch) -> None:
    """直接调用时，模型名要转成生成层的 backend 串。

    不转的话 run_freezone_video_gen 退回自己的默认后端，而那个后端的构造器连
    model_params 都不收（HuimengVideoGenerator）——请求根本到不了指定的模型。
    这里用白名单内的模型：兜底解析只认白名单（目录宽的型号由端点层先解析好）。
    """
    import asyncio

    from novelvideo.freezone.video_node import resolve_freezone_video_backend

    src = _make_source(tmp_path / "src.mp4", duration=5.0)
    seen: dict[str, object] = {}

    async def spy_gen(**kwargs):
        seen.update(kwargs)
        return _make_stub_clip(tmp_path, kwargs["job_id"])

    monkeypatch.setattr(jobs, "run_freezone_video_gen", spy_gen)

    asyncio.run(
        run_freezone_video_reshoot(
            project_dir=tmp_path, job_id="backend", source_path=str(src),
            start_seconds=1.0, end_seconds=3.0,
            model="newapi_seedance-2.0-fast",
        )
    )
    assert seen["backend"] == resolve_freezone_video_backend("newapi_seedance-2.0-fast")
    assert seen["backend"] == "newapi_seedance-2.0-fast"


def test_reshoot_rejects_model_outside_whitelist_without_backend(
    tmp_path: Path, monkeypatch
) -> None:
    """目录宽于白名单：没带 backend 又点了白名单外模型，要明确报错而不是静默换后端。"""
    import asyncio

    src = _make_source(tmp_path / "src.mp4", duration=5.0)
    monkeypatch.setattr(
        jobs, "run_freezone_video_gen",
        lambda **kw: (_ for _ in ()).throw(AssertionError("不应调到生成层")),
    )

    with pytest.raises(ValueError, match="unknown video model"):
        asyncio.run(
            run_freezone_video_reshoot(
                project_dir=tmp_path, job_id="oob", source_path=str(src),
                start_seconds=1.0, end_seconds=3.0,
                model="agnes-video-2.5-flash",
            )
        )


def test_reshoot_prefers_endpoint_resolved_backend(tmp_path: Path, monkeypatch) -> None:
    """端点已按目录解析出 backend 时，leaf 不得再用窄白名单重解析。

    目录比 resolve_freezone_video_backend 的白名单宽（含 agnes 等），端点解析过的
    值直接透传；只有直接调用（测试/脚本）才走兜底解析。
    """
    import asyncio

    src = _make_source(tmp_path / "src.mp4", duration=5.0)
    seen: dict[str, object] = {}

    async def spy_gen(**kwargs):
        seen.update(kwargs)
        return _make_stub_clip(tmp_path, kwargs["job_id"])

    monkeypatch.setattr(jobs, "run_freezone_video_gen", spy_gen)

    asyncio.run(
        run_freezone_video_reshoot(
            project_dir=tmp_path, job_id="passthrough", source_path=str(src),
            start_seconds=1.0, end_seconds=3.0,
            model="agnes-video-2.5-flash",
            backend="newapi_agnes-video-2.5-flash",
            model_params={"seed": 7},
        )
    )
    assert seen["backend"] == "newapi_agnes-video-2.5-flash"
    assert seen["model_params"] == {"seed": 7}


def _make_stub_clip(tmp_path: Path, job_id: str):
    out = jobs.outputs_dir(tmp_path, "freezone_video_gen") / f"{job_id}.mp4"
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error",
         "-f", "lavfi", "-i", "testsrc=duration=2.0:size=320x240:rate=30",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest", str(out)],
        capture_output=True, text=True, check=True,
    )
    return out


# ---------------------------------------------------------------- Phase 6: 边界与安全


def test_reshoot_rejects_path_traversal_source(tmp_path: Path) -> None:
    """`source_url` 含 ../ 形态必须在端点层被拒（走 resolve_static_url_to_path）。"""
    from novelvideo.freezone.paths import resolve_static_url_to_path

    for bad in (
        "/static/projects/proj/../../../../etc/passwd",
        "/static/../../../etc/passwd",
        "/static/projects/proj/%2e%2e/%2e%2e/etc/passwd",
        "/static/projects/proj/..%2f..%2fetc/passwd",
    ):
        with pytest.raises(ValueError):
            resolve_static_url_to_path(bad, tmp_path)


def test_reshoot_missing_ffmpeg_raises(tmp_path: Path, monkeypatch) -> None:
    """PATH 里没有 ffmpeg 时给明确 RuntimeError，不是后面某个诡异失败。"""
    import asyncio

    src = _make_source(tmp_path / "src.mp4", duration=5.0)
    monkeypatch.setattr(jobs.shutil, "which", lambda _name: None)

    with pytest.raises(RuntimeError, match="ffmpeg not found on PATH"):
        asyncio.run(
            run_freezone_video_reshoot(
                project_dir=tmp_path, job_id="noffmpeg", source_path=str(src),
                start_seconds=1.0, end_seconds=2.0,
            )
        )


def test_reshoot_frame_extract_failure_raises(tmp_path: Path, monkeypatch) -> None:
    """给一个非视频文件：抽帧必须报错，不能静默出黑帧/空产物。"""
    import asyncio

    broken = tmp_path / "broken.mp4"
    broken.write_bytes(b"this is not a video at all")
    _stub_gen(monkeypatch, clip_duration=2.0)

    with pytest.raises(RuntimeError, match="frame extract failed"):
        asyncio.run(
            run_freezone_video_reshoot(
                project_dir=tmp_path, job_id="broken", source_path=str(broken),
                start_seconds=1.0, end_seconds=3.0,
            )
        )


def test_reshoot_meta_has_source_has_audio(tmp_path: Path, monkeypatch) -> None:
    """meta 报源有没有音轨，前端据此提示「原片无音轨」。"""
    import asyncio

    src = _make_source(tmp_path / "src.mp4", duration=5.0, audio=False)
    _stub_gen(monkeypatch, clip_duration=2.0, with_audio=False)

    _clip, _full, meta = asyncio.run(
        run_freezone_video_reshoot(
            project_dir=tmp_path, job_id="silent", source_path=str(src),
            start_seconds=1.0, end_seconds=3.0,
        )
    )
    assert meta["source_has_audio"] is False


def test_reshoot_meta_reports_audio_present(tmp_path: Path, monkeypatch) -> None:
    """有声源的对照：source_has_audio 为 True。"""
    import asyncio

    src = _make_source(tmp_path / "src.mp4", duration=5.0, audio=True)
    _stub_gen(monkeypatch, clip_duration=2.0, with_audio=True)

    _clip, _full, meta = asyncio.run(
        run_freezone_video_reshoot(
            project_dir=tmp_path, job_id="loud", source_path=str(src),
            start_seconds=1.0, end_seconds=3.0,
        )
    )
    assert meta["source_has_audio"] is True


def test_reshoot_schema_rejects_absurd_seconds() -> None:
    """区间值必须有上界：不设顶的话 1e30 / inf 会变成 ffmpeg 的怪异行为。"""
    import pydantic

    from novelvideo.api.schemas import FreezoneVideoReshootRequest

    for payload in (
        {"source_url": "u", "start_seconds": 0, "end_seconds": 1e30},
        {"source_url": "u", "start_seconds": 0, "end_seconds": float("inf")},
        {"source_url": "u", "start_seconds": 0, "end_seconds": 86401},
        {"source_url": "u", "start_seconds": -1, "end_seconds": 3},
    ):
        with pytest.raises(pydantic.ValidationError):
            FreezoneVideoReshootRequest(**payload)


def test_reshoot_no_shell_invocation() -> None:
    """新增代码一律 list 形式调 ffmpeg；shell=True 会被注入。"""
    import re
    from pathlib import Path as _Path

    source = _Path("src/novelvideo/freezone/jobs.py").read_text()
    start = source.find("async def run_freezone_video_reshoot")
    end = source.find("\nasync def ", start + 10)
    body = source[start:end]
    assert "shell=True" not in body
    assert "os.system(" not in body
    # 抽帧/拼接的参数都以 f-string 进 list，没有字符串拼命令
    assert re.search(r'f"segment \{span:\.1f\}s', body) is not None


# ---------------------------------------------------------------- Phase 2: 注册与路由


def test_reshoot_schema_rejects_bad_range() -> None:
    import pydantic

    with pytest.raises(pydantic.ValidationError):
        FreezoneVideoReshootRequest(source_url="x", end_seconds=0)
    with pytest.raises(pydantic.ValidationError):
        FreezoneVideoReshootRequest(source_url="x", start_seconds=5, end_seconds=3)


def test_reshoot_schema_defaults() -> None:
    req = FreezoneVideoReshootRequest(source_url="x", end_seconds=2.0, prompt="p")
    assert req.start_seconds == 0.0
    assert req.prompt == "p"
    assert req.resolution == "720p"
    assert req.duration_seconds == 0
    assert req.generate_audio is False
    assert req.camera_template_id is None


def test_reshoot_schema_requires_prompt() -> None:
    """上游 video/generations 强校验 prompt，空串必须在本层就拒。

    曾经的假设是"首尾帧模式下提示词可留空"——那条注释参考的是别的端点
    （i2v / keyframes），reshoot 走的是 text_to_video 路径，空 prompt 会一路
    打到上游才 400。min_length 放 schema 层，脚本/测试调用方也一并拦住。
    """
    import pydantic

    # min_length 只拦真空串；纯空白由前端 trim 后禁提交（schema 不 strip，
    # 上游对纯空白同样 400，所以两层都要有）。
    for bad in ("",):
        with pytest.raises(pydantic.ValidationError):
            FreezoneVideoReshootRequest(source_url="x", end_seconds=2.0, prompt=bad)
    # 超长同样拒（max_length 2000）
    with pytest.raises(pydantic.ValidationError):
        FreezoneVideoReshootRequest(source_url="x", end_seconds=2.0, prompt="x" * 2001)


def test_reshoot_runner_registered() -> None:
    from novelvideo.task_backend.runners import freezone as runners  # noqa: F401
    from novelvideo.task_backend.registry import get_project_task_runner

    assert get_project_task_runner("freezone_video_reshoot") is not None


def test_reshoot_route_registered() -> None:
    from novelvideo.api.routes import freezone

    paths = [
        (getattr(route, "path", ""), sorted(getattr(route, "methods", None) or []))
        for route in freezone.router.routes
        if getattr(route, "path", "").endswith("/freezone/video/reshoot")
    ]
    assert paths, "reshoot route not registered on freezone.router"
    assert any("POST" in methods for _path, methods in paths), paths


def test_reshoot_task_label() -> None:
    from novelvideo.api.routes import tasks as tasks_route
    labels = getattr(tasks_route, "TASK_TYPE_LABELS", None) or {}
    if labels:
        assert labels.get("freezone_video_reshoot") == "视频片段重拍"


# ------------------------------------------------- Phase 6b: 首尾帧模式门禁


def test_reshoot_rejects_model_without_first_last_frame_mode(tmp_path: Path, monkeypatch) -> None:
    """没声明 first_last_frame 的模型必须在入队前被拒。

    首尾帧锚定是片段重拍唯一的生成路径，放过的话任务会一路打到上游才失败，
    用户白等一场——而这个问题在媒体目录里是现成的。
    """
    import asyncio

    from fastapi import HTTPException

    from novelvideo.api.routes import freezone

    src = _make_source(tmp_path / "src.mp4", duration=5.0)
    captured: dict[str, object] = {}

    async def fake_resolve_catalog(media_type, model, params, *, mode=None, requester_user_id=None):
        captured["mode"] = mode
        return (
            {"parameters": []},
            {},
            # happyhorse 这类：目录里显式没有 first_last_frame。
            {"supportedModes": ["text_to_video", "first_frame", "video_edit"]},
        )

    monkeypatch.setattr(freezone, "_resolve_catalog_request", fake_resolve_catalog)
    monkeypatch.setattr(
        freezone, "_resolve_catalog_video_backend", _async_return("newapi_happyhorse-1.0")
    )

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(_call_reshoot_endpoint(freezone, monkeypatch, str(src), model="happyhorse-1.0"))
    assert excinfo.value.status_code == 400
    assert "first_last_frame" in str(excinfo.value.detail)
    assert captured["mode"] == "firstLastFrame"


def test_reshoot_allows_model_with_first_last_frame_mode(tmp_path: Path, monkeypatch) -> None:
    """声明了 first_last_frame 的模型照常放行（含 agnes / wan / MiniMax 等）。"""
    import asyncio

    from novelvideo.api.routes import freezone

    src = _make_source(tmp_path / "src.mp4", duration=5.0)
    monkeypatch.setattr(
        freezone,
        "_resolve_catalog_request",
        _async_return(({"parameters": []}, {}, {"supportedModes": ["first_last_frame"], "maxDuration": 12})),
    )
    monkeypatch.setattr(
        freezone, "_resolve_catalog_video_backend", _async_return("newapi_agnes-video-2.5-flash")
    )

    accepted = asyncio.run(
        _call_reshoot_endpoint(freezone, monkeypatch, str(src), model="agnes-video-2.5-flash")
    )
    assert accepted["task_type"] == "freezone_video_reshoot"


def test_reshoot_allows_model_without_any_mode_declaration(tmp_path: Path, monkeypatch) -> None:
    """目录压根没配 supportedModes（capabilities 为 None）时不拦。

    与"配了列表但里面没有首尾帧"是两回事：后者是显式声明不支持，必须拦；
    前者是无从判定，交给上游报错。`_catalog_mode_enabled` 正好把这两档分成
    None / False，所以端点不需要额外判断缺省。
    """
    import asyncio

    from novelvideo.api.routes import freezone

    src = _make_source(tmp_path / "src.mp4", duration=5.0)
    monkeypatch.setattr(
        freezone,
        "_resolve_catalog_request",
        _async_return(({"parameters": []}, {}, None)),
    )
    monkeypatch.setattr(freezone, "_resolve_catalog_video_backend", _async_return("newapi_x"))

    accepted = asyncio.run(_call_reshoot_endpoint(freezone, monkeypatch, str(src), model="whatever"))
    assert accepted["task_type"] == "freezone_video_reshoot"


def _async_return(value):
    async def _inner(*_args, **_kwargs):
        return value

    return _inner


async def _call_reshoot_endpoint(
    freezone,
    monkeypatch,
    source_path: str,
    *,
    model: str,
    start_seconds: float = 1.0,
    end_seconds: float = 3.0,
):
    """直接调端点函数，绕过 FastAPI 依赖注入。

    payload 里只需要端点真正读到的字段；project/user 用假的即可——端点第一个
    动作是 `_resolve_freezone_project`，把它 monkeypatch 掉。
    """
    from novelvideo.api.schemas import FreezoneVideoReshootRequest

    class _Ctx:
        output_dir = None
        requester_user_id = "local"

    monkeypatch.setattr(
        freezone,
        "_resolve_freezone_project",
        _async_return((_Ctx(), "local", "proj", Path("/tmp/reshoot_probe"), None)),
    )
    monkeypatch.setattr(freezone, "_enqueue_or_start_freezone_media_job", _async_return({"task_type": "freezone_video_reshoot"}))
    # source_url 走 resolve_static_url_to_path：给一个真路径，让它解析回自身。
    monkeypatch.setattr(freezone, "resolve_static_url_to_path", lambda url, _root: Path(url))

    body = FreezoneVideoReshootRequest(
        source_url=source_path,
        start_seconds=start_seconds,
        end_seconds=end_seconds,
        prompt="p",
        model=model,
    )
    return await freezone.freezone_video_reshoot("proj", body, {"username": "local"})


# --------------------------------------------- Phase 7: 首尾帧提示词推荐


def test_reshoot_keyframe_prompt_task_mentions_span_and_both_frames() -> None:
    """推荐任务描述必须同时提两张帧和时长——少一个模型就少一分依据。"""
    from novelvideo.freezone.image_node import build_reshoot_keyframe_prompt_task

    task = build_reshoot_keyframe_prompt_task(2.5)
    assert "起始帧" in task and "结束帧" in task
    assert "2.5" in task
    # 重点在"演化"，不是静态描述某一帧
    assert "运动" in task or "演化" in task


def test_reshoot_extract_keyframes_helper(tmp_path: Path) -> None:
    """抽帧 helper：与重拍本体同一套参数，区间非法要拒。"""
    import asyncio

    from novelvideo.freezone.jobs import extract_reshoot_keyframes

    src = _make_source(tmp_path / "src.mp4", duration=5.0)
    first, last = asyncio.run(
        extract_reshoot_keyframes(
            source_path=str(src),
            start_seconds=1.0,
            end_seconds=3.0,
            out_dir=tmp_path / "frames",
        )
    )
    assert first.exists() and last.exists()
    # 两帧内容不同（1s vs 3s 的 testsrc 画面不一样）
    assert first.read_bytes() != last.read_bytes()

    with pytest.raises(ValueError, match="greater than"):
        asyncio.run(
            extract_reshoot_keyframes(
                source_path=str(src),
                start_seconds=3.0,
                end_seconds=1.0,
                out_dir=tmp_path / "frames2",
            )
        )


def test_reshoot_suggest_prompt_route_registered() -> None:
    from novelvideo.api.routes import freezone

    paths = [
        (getattr(route, "path", ""), sorted(getattr(route, "methods", None) or []))
        for route in freezone.router.routes
        if getattr(route, "path", "").endswith("/freezone/video/reshoot/suggest-prompt")
    ]
    assert paths, "suggest-prompt route not registered on freezone.router"
    assert any("POST" in methods for _path, methods in paths), paths


def test_reshoot_suggest_prompt_runner_registered() -> None:
    from novelvideo.task_backend.runners import freezone as runners  # noqa: F401
    from novelvideo.task_backend.registry import get_project_task_runner

    assert get_project_task_runner("freezone_video_reshoot_suggest_prompt") is not None


def test_reshoot_suggest_prompt_schema_requires_range() -> None:
    """区间口径与重拍本体一致：end 必须大于 start。"""
    import pydantic

    from novelvideo.api.schemas import FreezoneVideoReshootSuggestPromptRequest

    with pytest.raises(pydantic.ValidationError):
        FreezoneVideoReshootSuggestPromptRequest(source_url="x", start_seconds=3, end_seconds=3)


def test_reshoot_suggest_prompt_end_to_end(tmp_path: Path, monkeypatch) -> None:
    """推荐 leaf 端到端：真抽两帧，视觉调用打成桩，验证 prompt 原样返回。"""
    import asyncio

    from novelvideo.freezone import image_node
    from novelvideo.freezone.jobs import extract_reshoot_keyframes

    src = _make_source(tmp_path / "src.mp4", duration=5.0)
    frames = tmp_path / "frames"
    first, last = asyncio.run(
        extract_reshoot_keyframes(
            source_path=str(src), start_seconds=1.0, end_seconds=3.0, out_dir=frames
        )
    )
    seen: dict[str, object] = {}

    async def fake_vision(*, prompt, images, **_kwargs):
        seen["prompt"] = prompt
        seen["image_count"] = len(images)
        return "model-name", "镜头缓慢推近，人物回头看向窗外"

    monkeypatch.setattr(image_node, "call_freezone_vision_model", fake_vision)
    # egress 的 prepare/complete 是函数体内 import 的，要 patch 它真正的所在模块。
    import novelvideo.freezone.presets as presets

    monkeypatch.setattr(presets, "prepare_freezone_vision_egress", _fake_egress_prepare)
    monkeypatch.setattr(presets, "complete_freezone_vision_egress", _fake_egress_complete)

    result = asyncio.run(
        image_node.suggest_reshoot_prompt_from_keyframes(
            first_frame_path=first,
            last_frame_path=last,
            span_seconds=2.0,
        )
    )
    assert result == "镜头缓慢推近，人物回头看向窗外"
    # 两张帧都要喂进去，且任务描述带了时长
    assert seen["image_count"] == 2
    assert "2.0" in str(seen["prompt"])


async def _fake_egress_prepare(**kwargs):
    return None


async def _fake_egress_complete(egress, *, result):
    return None


def test_reshoot_aspect_ratio_follows_source(tmp_path: Path) -> None:
    """画幅必须跟随源视频：重拍段要拼回原片，画幅不一致会黑边/拉伸。

    曾硬编码 "auto" 实测被 agnes 的网关适配器 400（`aspect_ratio 不能为 auto`），
    而它的 ratioOptions 里明明列着 auto——所以按源比例算具体值，不依赖模型
    对 auto 的接受程度。
    """
    import asyncio

    from novelvideo.freezone.jobs import _probe_aspect_ratio

    cases = {"16x9": "640x360", "9x16": "360x640", "square": "500x500", "wide": "800x334"}
    expected = {"16x9": "16:9", "9x16": "9:16", "square": "1:1", "wide": "21:9"}
    for name, size in cases.items():
        src = tmp_path / f"{name}.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error",
             "-f", "lavfi", "-i", f"testsrc=duration=1:size={size}:rate=30",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", str(src)],
            capture_output=True, text=True, check=True,
        )
        assert asyncio.run(_probe_aspect_ratio(src)) == expected[name], name


def test_reshoot_rejects_span_below_model_min_duration(tmp_path: Path, monkeypatch) -> None:
    """区间短于模型 minDuration 必须在入队前被拒。

    实测踩过：1.0s 的区间一路跑到上游，agnes 回 400
    `seconds 必须在 [4, 12] 范围内` —— 用户在界面上等半天换一句上游报错。
    生成段的时长就是区间长度，不可能小于模型下限，所以这道拦截在端点层。
    """
    import asyncio

    from fastapi import HTTPException

    from novelvideo.api.routes import freezone

    src = _make_source(tmp_path / "src.mp4", duration=5.0)
    monkeypatch.setattr(
        freezone,
        "_resolve_catalog_request",
        _async_return(
            (
                {"parameters": []},
                {},
                {"supportedModes": ["first_last_frame"], "minDuration": 4, "maxDuration": 12},
            )
        ),
    )
    monkeypatch.setattr(
        freezone, "_resolve_catalog_video_backend", _async_return("newapi_agnes-video-2.5-flash")
    )

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(
            _call_reshoot_endpoint(
                freezone,
                monkeypatch,
                str(src),
                model="agnes-video-2.5-flash",
                start_seconds=0.5,
                end_seconds=1.5,
            )
        )
    assert excinfo.value.status_code == 400
    assert "min duration" in str(excinfo.value.detail)
    assert "4" in str(excinfo.value.detail)


def test_reshoot_allows_span_at_model_min_duration(tmp_path: Path, monkeypatch) -> None:
    """恰好等于下限要放行——边界不能写成严格大于。"""
    import asyncio

    from novelvideo.api.routes import freezone

    src = _make_source(tmp_path / "src.mp4", duration=8.0)
    monkeypatch.setattr(
        freezone,
        "_resolve_catalog_request",
        _async_return(
            (
                {"parameters": []},
                {},
                {"supportedModes": ["first_last_frame"], "minDuration": 4, "maxDuration": 12},
            )
        ),
    )
    monkeypatch.setattr(
        freezone, "_resolve_catalog_video_backend", _async_return("newapi_agnes-video-2.5-flash")
    )

    accepted = asyncio.run(
        _call_reshoot_endpoint(
            freezone,
            monkeypatch,
            str(src),
            model="agnes-video-2.5-flash",
            start_seconds=1.0,
            end_seconds=5.0,
        )
    )
    assert accepted["task_type"] == "freezone_video_reshoot"


def test_reshoot_skips_min_duration_when_catalog_has_none(tmp_path: Path, monkeypatch) -> None:
    """目录没声明 minDuration 时不拦（老条目/自定义渠道）。"""
    import asyncio

    from novelvideo.api.routes import freezone

    src = _make_source(tmp_path / "src.mp4", duration=5.0)
    monkeypatch.setattr(
        freezone,
        "_resolve_catalog_request",
        _async_return(({"parameters": []}, {}, {"supportedModes": ["first_last_frame"]})),
    )
    monkeypatch.setattr(freezone, "_resolve_catalog_video_backend", _async_return("newapi_x"))

    accepted = asyncio.run(
        _call_reshoot_endpoint(
            freezone,
            monkeypatch,
            str(src),
            model="x",
            start_seconds=0.5,
            end_seconds=1.5,
        )
    )
    assert accepted["task_type"] == "freezone_video_reshoot"
