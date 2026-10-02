"""画布视频节点「向后延长」的提示词推荐。

这块的三个关键契约，任何一个被改坏都会以「提示词莫名其妙」的形式出现，而不是报错：

1. 抽帧口径——喂给视觉模型的必须是**整片采样帧 + 片尾锚点帧**，且锚点在最后。
   只给片尾一帧，模型看不到这条片子在演什么，写出来的下一段会换人换场。
2. 时长与方向要进任务描述——用户把时长调大、调方向，是期待提示词跟着变的。
3. 方向 id 是前后端契约，对不上必须报错而不是静默回退成 `auto`。
"""

from __future__ import annotations

import asyncio
import json
import re
import subprocess
from pathlib import Path

import pytest

from novelvideo.freezone.continue_prompt import (
    DIALECT_STRUCTURE_HINTS,
    VIDEO_CONTINUE_DIRECTIONS,
    resolve_continue_dialect,
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


def test_task_description_uses_dialect_structure() -> None:
    """输出结构必须来自目标模型的方言，不是手写规则清单。

    之前这里堆了十几条祈使句（Sora/Runway 各一句），模型只认真执行最后几条，
    产出退化成散文。改成「规定输出长什么样」后才拿到结构化结果。
    """
    agnes = build_continue_prompt_task(
        duration_seconds=12.0, direction="auto", frame_count=4, model="agnes-video-2.5-flash"
    )
    assert "## 输出结构" in agnes
    assert "【核心创意】" in agnes and "【画面过程描述】" in agnes
    minimax = build_continue_prompt_task(
        duration_seconds=12.0, direction="auto", frame_count=4, model="MiniMax-H3"
    )
    assert "integrated_multimodal_description:" in minimax
    generic = build_continue_prompt_task(
        duration_seconds=12.0, direction="auto", frame_count=4, model=None
    )
    assert "## 输出结构" in generic, "认不出模型也要有结构要求"
    assert "【核心创意】" not in generic, "兜底不该冒充某个具体方言"


def test_dialects_require_time_segmentation() -> None:
    """每段过程描述必须按秒分段，短时长也不例外。

    实测 12 秒时模型会写「0—3秒 / 3—6秒…」，6 秒时却整段连贯叙述、没有分段——
    方言要求原文只说「按目标时长分段」，太含糊，短时长就被跳过了。改成硬格式
    并给示例。
    """
    for model in ("agnes-video-2.5-flash", "seedance-2.0", "unknown-model"):
        prompt = build_continue_prompt_task(
            duration_seconds=6.0, direction="auto", frame_count=4, model=model
        )
        assert "分段" in prompt or "按秒推进" in prompt, (
            f"{model} 的结构要求里没有时间分段"
        )
    agnes = build_continue_prompt_task(
        duration_seconds=6.0, direction="auto", frame_count=4, model="agnes-video-2.5-flash"
    )
    # 带示例，避免只写「必须按秒分段」这种没有锚点的要求被当成建议。
    assert "0—2秒，" in agnes


def test_every_catalog_video_model_has_a_dialect() -> None:
    """目录里每个视频模型都要有结构定义，不能有落到空白的。"""
    catalog = json.loads(
        (REPOSITORY_ROOT / "src" / "novelvideo" / "official_media_models.json").read_text(
            encoding="utf-8"
        )
    )
    missing = [
        key
        for key, entry in catalog["mediaModels"].items()
        if entry.get("mediaType") == "video"
        and resolve_continue_dialect(key) not in DIALECT_STRUCTURE_HINTS
    ]
    assert not missing, f"这些模型没有输出结构定义：{missing}"


def test_task_description_keeps_continuity_constraints() -> None:
    """续写专有约束与方言无关，换模型时它们必须还在。"""
    prompt = build_continue_prompt_task(
        duration_seconds=12.0, direction="auto", frame_count=4
    )
    assert "## 续写专有约束" in prompt
    # 这四条来自官方指南共性，且每一条都对应过一次实测失败。
    assert "第一帧就是锚点帧" in prompt
    assert "不要重复时长" in prompt, "实测产出过「12秒，……」这种废话开头"
    # 防编光源被单列成「输出格式」的一部分：埋在约束清单里时模型会跳过它，
    # 实测同一段视频连续产出 6 次画面里不存在的红光。
    assert "## 光线可追溯" in prompt
    assert "必须能指到画面里的具体来源" in prompt


def test_task_description_requires_role_identifiers() -> None:
    """角色必须有区分标识，否则提示词里角色匿名、生成时互相漂移。

    规则一度写成「不要用文字重新描述外貌」，模型理解成「连颜色词都不能写」，
    产出「白衣身影」「另一人」——提示词本身就没法区分谁是谁。
    """
    prompt = build_continue_prompt_task(
        duration_seconds=12.0, direction="auto", frame_count=4
    )
    assert "区分角色要写标识" in prompt
    assert "蓝衣人" in prompt, "要给出可照抄的示例，否则模型不知道要写到什么粒度"
    assert "不要写完整外貌清单" in prompt, "但完整外貌清单仍要禁止，否则模型改人"


def test_detail_budget_scales_with_duration() -> None:
    """细度按时长给，不写死字数。

    之前是「长度 80-150 字」，实测 12 秒场景写 200 字仍欠细：动作链只有三步，
    缺起势发力惯性收势；项目图库同长度成品单镜有 10+ 个连续动作。
    """
    # 字数是**区间上限**，不是「上下」——实测「250 字上下」被读成尽量多写，
    # 同一场景产出 690 字。用「控制在 X-Y 字」并加「写完即止」。
    expectations = {
        4.0: ("2 个动作", "100-140 字"),
        8.0: ("3 个动作", "160-200 字"),
        12.0: ("4 个动作", "220-280 字"),
        15.0: ("5 个动作", "300-360 字"),
    }
    for seconds, (actions, words) in expectations.items():
        prompt = build_continue_prompt_task(
            duration_seconds=seconds, direction="auto", frame_count=4
        )
        assert actions in prompt, f"{seconds} 秒应当给「{actions}」"
        assert words in prompt, f"{seconds} 秒应当给「{words}」上限"
        # 动作要写全四个阶段，否则模型会用形容词把长度填满而不是展开动作。
        assert "起势、发力、惯性与收势" in prompt
        assert "写完即止" in prompt, "没有这句模型会当配额往多了写"


def test_reverse_section_is_capped() -> None:
    """反向段最多 3 条、60 字以内。

    实测一度铺到 8 条，把「不要切镜」这类真正的约束稀释掉了。
    """
    prompt = build_continue_prompt_task(
        duration_seconds=12.0, direction="auto", frame_count=4
    )
    assert "## 反向段限长" in prompt
    assert "最多 3 条" in prompt


def test_task_description_has_no_hardcoded_length_cap() -> None:
    """旧的「80-150 字」硬上限已被细度预算取代，别再回来。"""
    for seconds in (4.0, 12.0):
        prompt = build_continue_prompt_task(
            duration_seconds=seconds, direction="auto", frame_count=4
        )
        assert "80-150" not in prompt


def test_task_description_tells_model_reference_images_win() -> None:
    """用户指定的参考素材优先于锚点帧——抽帧保证不了参照物齐全。"""
    with_refs = build_continue_prompt_task(
        duration_seconds=8.0, direction="auto", frame_count=4, reference_image_count=2
    )
    assert "用户指定的参考素材" in with_refs
    assert "与素材冲突的外貌" in with_refs, "冲突时要以素材为准，否则加素材没意义"
    without_refs = build_continue_prompt_task(
        duration_seconds=8.0, direction="auto", frame_count=4
    )
    assert "用户指定的参考素材" not in without_refs


def test_reference_image_limit_reads_the_catalog() -> None:
    """参考图上限必须读模型目录，且字段在条目**顶层**而不是 config 里。

    字段位置写错过一次：一开始从 `entry["config"]["referenceImageMax"]` 取，目录
    条目根本没有 config 子键，于是所有模型一律返回 0——功能看着正常（界面不显示
    参考行），实测才发现永远收不到素材。
    """
    import asyncio

    from novelvideo.api.routes.freezone import _continue_reference_image_limit

    async def main() -> dict[str, int]:
        catalog = json.loads(
            (
                REPOSITORY_ROOT
                / "src"
                / "novelvideo"
                / "official_media_models.json"
            ).read_text(encoding="utf-8")
        )
        expected = {
            key: (entry.get("config") or {}).get("referenceImageMax")
            or entry.get("referenceImageMax")
            or 0
            for key, entry in catalog["mediaModels"].items()
            if entry.get("mediaType") == "video"
        }
        return {key: await _continue_reference_image_limit(key) for key in expected}

    resolved = asyncio.run(main())
    assert any(value > 0 for value in resolved.values()), (
        "所有模型都读到 0：多半又把 referenceImageMax 从 config 里取了"
    )
    assert all(value >= 0 for value in resolved.values())


def test_task_description_adapts_to_target_model() -> None:
    """各家可用时长档位不同（agnes 6/8/10/12、Sora 4/8/12/16/20、Veo 4/6/8），
    认得模型就按它的档位约束，认不出才回落通用句。"""
    agnes = build_continue_prompt_task(
        duration_seconds=8.0, direction="auto", frame_count=4, model="agnes-video-2.5-flash"
    )
    seedance = build_continue_prompt_task(
        duration_seconds=8.0, direction="auto", frame_count=4, model="seedance-2.0"
    )
    unknown = build_continue_prompt_task(
        duration_seconds=8.0, direction="auto", frame_count=4, model=None
    )
    assert "6/8/10/12 秒档位" in agnes
    assert "2.0 系列" in seedance
    # 兜底不能把某一家的档位写死进去。
    assert "6/8/10/12" not in unknown
    assert "整秒" in unknown


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