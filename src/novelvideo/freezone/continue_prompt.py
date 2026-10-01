"""画布视频节点「向后延长」的提示词推荐。

延长与重拍要的东西不一样：重拍是「把选中这段重演一遍」，区间首尾两帧就够了；
延长是「从片尾接着往下演」，模型必须先知道这条片子在演什么——人物是谁、在哪、
光线什么调子、当前情绪到哪了——否则它写出来的下一段会换人换场。所以这里喂的是
**整片采样帧 + 结尾锚点帧**，再叠上用户设定的目标时长与选中的发展方向。

出网仍走图反推那套视觉网关（`call_freezone_vision_model` 本来就收多张图），只有
任务描述整段换掉。
"""

from __future__ import annotations

from pathlib import Path
from typing import Sequence

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.freezone.vision_gateway import (
    FREEZONE_IMAGE_REVERSE_PROMPT_TIMEOUT_SECONDS,
    call_freezone_vision_model,
    load_compact_vision_inputs,
)
from novelvideo.official_defaults import DEFAULT_FREEZONE_VISION_MODEL

# 发展方向：id → 写进任务描述的创作指令。id 是前端契约，改名要同步
# `frontend/src/api/ops.ts` 的 FreezoneVideoContinueDirection 与三语词条。
VIDEO_CONTINUE_DIRECTIONS: dict[str, str] = {
    "auto": "由你根据画面自行判断最有价值的方向：优先延续当前冲突或情绪，让下一段有明确的推进感。",
    "plot": "推进剧情：出现一个新的事件或动作，人物做出有目的的行为，情节往前走一步，不要原地抒情。",
    "emotion": "情绪递进：情绪强度要看得见地变化（压抑到爆发、或紧张到松弛），靠表情、眼神、呼吸与身体幅度体现，不要只靠表情符号式的形容。",
    "action": "动作爆发：安排一个明确有力的身体动作或位移，起势、发力、收势完整，动作有惯性、有重量感。",
    "camera": "镜头运动为主角：机位或构图发生一次清晰的变化（推近、拉远、横移、跟拍、环绕、手持轻微晃动），让画面语言本身承担叙事。",
    "environment": "环境与光线变化：让环境参与叙事——光线明暗与色温改变、天气或时间变化、尘埃雨水烟雾等氛围元素流动，人物仍在原场景内。",
    "dialogue": "对白推进：人物开口说话（有明确的口型与说话节奏），配合手势与视线交流，让内容由台词承载，而不是纯画面表演。",
    "ending": "收尾定格：情绪落到一个落点上，节奏放缓、动作收干净，结尾画面稳定下来可以停住，给整段一个完整的句号。",
}

DEFAULT_VIDEO_CONTINUE_DIRECTION = "auto"


def normalize_video_continue_direction(value: str | None) -> str:
    """把外部传入的方向 id 收敛成已知方向。

    未知 id 直接报错，不静默回退成 `auto`：前端多发一个拼错的 id 时，静默换方向
    会让用户拿到一段与所选不符的提示词，而且无从察觉。
    """
    raw = str(value or "").strip() or DEFAULT_VIDEO_CONTINUE_DIRECTION
    if raw not in VIDEO_CONTINUE_DIRECTIONS:
        raise ValueError(f"unknown continue direction: {raw}")
    return raw


def _beat_plan(duration_seconds: float) -> str:
    """按时长给模型一个节拍数量，避免它写出演不完的动作。"""
    if duration_seconds <= 4:
        return "只安排一个完整动作，不要转场。"
    if duration_seconds <= 8:
        return "安排 2 个前后衔接的动作节拍。"
    return "安排 3 个递进的动作节拍（起势 → 变化 → 收势），不要塞入转场。"


def build_continue_prompt_task(
    *,
    duration_seconds: float,
    direction: str,
    frame_count: int,
) -> str:
    """整片采样帧 + 结尾锚点帧 + 时长 + 方向 → 续写提示词的任务描述。"""
    return "\n".join(
        [
            "你是一个视频续写提示词创作助手。",
            f"我会给你 {frame_count} 张图片：前 {frame_count - 1} 张是原片按时间顺序的采样帧，"
            "最后一张是原片的结尾帧——它将作为续写片段的**首帧**，也就是两段之间的接缝。",
            "请根据这些画面，写一段直接可用于「首帧续写」的视频生成提示词，描述从结尾帧之后发生什么。",
            "要求：",
            "- 只输出最终提示词，不要解释，不要 markdown，不要引号。",
            "- 严格承接结尾帧：主体身份、服装、发型、场景、光线、色调、构图与人物朝向都要延续；"
            "不换人、不换场、不换装、不做时间跳跃。",
            f"- 目标时长约 {duration_seconds:.1f} 秒。{_beat_plan(duration_seconds)}",
            f"- 发展方向：{VIDEO_CONTINUE_DIRECTIONS[direction]}",
            "- 覆盖这几件事：主体动作、表情与情绪、镜头运动、环境与光线、氛围与节奏。",
            "- 只写接下来要发生什么，不要复述原片已经演过的内容。",
            "- 用创作者写提示词的自然表达，不要写成分析报告，也不要分点罗列。",
        ]
    )


async def suggest_continue_prompt_from_frames(
    *,
    frame_paths: Sequence[Path],
    duration_seconds: float,
    direction: str,
    egress_context: TrustedEgressContext | None = None,
) -> str:
    """看着「整片采样帧 + 结尾锚点帧」与设定，写一段续写提示词。

    `frame_paths` 的**最后一张必须是结尾锚点帧**，顺序即任务描述里的叙事顺序。
    """
    paths = [Path(path) for path in frame_paths]
    if len(paths) < 2:
        raise ValueError("continue prompt needs context frames and an anchor frame")
    direction_id = normalize_video_continue_direction(direction)
    prompt = build_continue_prompt_task(
        duration_seconds=duration_seconds,
        direction=direction_id,
        frame_count=len(paths),
    )
    images = await load_compact_vision_inputs(paths)
    if not images:
        raise RuntimeError("no readable frames for continue prompt")
    from novelvideo.freezone.presets import (
        complete_freezone_vision_egress,
        prepare_freezone_vision_egress,
    )

    vision_egress = await prepare_freezone_vision_egress(
        egress_context=egress_context,
        model_name=DEFAULT_FREEZONE_VISION_MODEL,
        prompt=prompt,
        images=[image.data for image in images],
        timeout_seconds=FREEZONE_IMAGE_REVERSE_PROMPT_TIMEOUT_SECONDS,
    )
    _model, prompt_text = await call_freezone_vision_model(
        prompt=prompt,
        images=images,
        timeout_seconds=FREEZONE_IMAGE_REVERSE_PROMPT_TIMEOUT_SECONDS,
        transport_context=vision_egress.transport_context if vision_egress else None,
    )
    prompt_text = prompt_text.strip()
    if prompt_text.startswith("```"):
        prompt_text = "\n".join(
            line for line in prompt_text.splitlines() if not line.strip().startswith("```")
        ).strip()
    if not prompt_text:
        raise RuntimeError("continue prompt model returned empty prompt")
    await complete_freezone_vision_egress(vision_egress, result=prompt_text)
    return prompt_text