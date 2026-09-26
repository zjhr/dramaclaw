"""Freezone 图片节点辅助逻辑。"""

from __future__ import annotations

from pathlib import Path

from novelvideo.freezone.vision_gateway import (
    FREEZONE_IMAGE_REVERSE_PROMPT_TIMEOUT_SECONDS,
    VisionInput,
    call_freezone_vision_model,
    image_media_type,
)
from novelvideo.egress_context import TrustedEgressContext
from novelvideo.official_defaults import DEFAULT_FREEZONE_VISION_MODEL

DEFAULT_IMAGE_REVERSE_PROMPT_INSTRUCTION = (
    "根据图片生成结构化中文提示词，包括主体描述、环境、光影、镜头语言、风格关键词。"
)


def build_image_reverse_prompt_task(instruction: str = "") -> str:
    lines = [
            "你是一个图片节点提示词反推助手。",
            "我会给你一张图片，请根据图片内容反推出一段直接可用于文生图或图生图的中文提示词。",
            "要求：",
            "- 只输出最终提示词，不要解释，不要 markdown，不要引号。",
            "- 提示词应包含：主体、场景、构图/景别、光线、色调、材质/细节、氛围、风格。",
            "- 用创作者写提示词的自然表达，不要写成分析报告。",
            "- 不要编造图片里没有的关键主体或剧情动作。",
            "- 保持精炼但信息密度高，适合直接粘贴给图片模型。",
    ]
    clean_instruction = str(instruction or "").strip()
    if clean_instruction:
        lines.extend(["用户补充要求：", clean_instruction])
    return "\n".join(lines)


async def reverse_prompt_from_image(
    *,
    image_path: Path,
    instruction: str = "",
    egress_context: TrustedEgressContext | None = None,
) -> str:
    prompt = build_image_reverse_prompt_task(instruction)
    image_bytes = image_path.read_bytes()
    from novelvideo.freezone.presets import (
        complete_freezone_vision_egress,
        prepare_freezone_vision_egress,
    )

    vision_egress = await prepare_freezone_vision_egress(
        egress_context=egress_context,
        model_name=DEFAULT_FREEZONE_VISION_MODEL,
        prompt=prompt,
        images=[image_bytes],
        timeout_seconds=FREEZONE_IMAGE_REVERSE_PROMPT_TIMEOUT_SECONDS,
    )
    _model, prompt_text = await call_freezone_vision_model(
        prompt=prompt,
        images=[
            VisionInput(
                data=image_bytes,
                media_type=image_media_type(image_path.name),
            )
        ],
        timeout_seconds=FREEZONE_IMAGE_REVERSE_PROMPT_TIMEOUT_SECONDS,
        transport_context=vision_egress.transport_context if vision_egress else None,
    )
    prompt_text = prompt_text.strip()
    if prompt_text.startswith("```"):
        prompt_text = "\n".join(
            line for line in prompt_text.splitlines() if not line.strip().startswith("```")
        ).strip()
    if not prompt_text:
        raise RuntimeError("reverse prompt model returned empty prompt")
    await complete_freezone_vision_egress(vision_egress, result=prompt_text)
    return prompt_text


def build_reshoot_keyframe_prompt_task(span_seconds: float) -> str:
    """首尾帧 → 视频提示词的任务描述。

    与单图反推的区别：这里给模型**两张图 + 一个时长**，要的是"这段画面如何
    从首帧演化到尾帧"的动态描述，而不是对某一帧的静态描述。所以明确要求
    运动/变化/节奏，并让它把时长当约束（太长的动作在 2s 内演不完）。
    """
    return "\n".join(
        [
            "你是一个视频片段提示词创作助手。",
            "我会给你两张图片——同一个视频片段的起始帧和结束帧——以及这段片子的时长。",
            "请根据这两帧的画面内容，写一段直接可用于视频生成的提示词，描述这段画面"
            "如何从起始帧演化到结束帧。",
            "要求：",
            "- 只输出最终提示词，不要解释，不要 markdown，不要引号。",
            "- 以画面主体、场景、光线、色调为基础，重点描述中间发生的**运动与变化**。",
            f"- 片段时长约 {span_seconds:.1f} 秒：动作节奏要能在这个时长内完成，不要设计过长转场。",
            "- 用创作者写提示词的自然表达，不要写成分析报告。",
            "- 可以合理想象两帧之间的过程，但不要换成与两帧无关的主体或场景。",
        ]
    )


async def suggest_reshoot_prompt_from_keyframes(
    *,
    first_frame_path: Path,
    last_frame_path: Path,
    span_seconds: float,
    egress_context: TrustedEgressContext | None = None,
) -> str:
    """看着区间首尾两帧，让视觉模型联想一段"这段该怎么演"的提示词。

    与 `reverse_prompt_from_image` 共用同一条视觉网关（`call_freezone_vision_model`
    本来就收 images 列表），只是任务描述换成双帧 + 时长。抽帧由调用方负责——
    这里只认两个已经落地的 PNG 路径。
    """
    prompt = build_reshoot_keyframe_prompt_task(span_seconds)
    images = [first_frame_path.read_bytes(), last_frame_path.read_bytes()]
    from novelvideo.freezone.presets import (
        complete_freezone_vision_egress,
        prepare_freezone_vision_egress,
    )

    vision_egress = await prepare_freezone_vision_egress(
        egress_context=egress_context,
        model_name=DEFAULT_FREEZONE_VISION_MODEL,
        prompt=prompt,
        images=images,
        timeout_seconds=FREEZONE_IMAGE_REVERSE_PROMPT_TIMEOUT_SECONDS,
    )
    _model, prompt_text = await call_freezone_vision_model(
        prompt=prompt,
        images=[
            VisionInput(data=images[0], media_type="image/png"),
            VisionInput(data=images[1], media_type="image/png"),
        ],
        timeout_seconds=FREEZONE_IMAGE_REVERSE_PROMPT_TIMEOUT_SECONDS,
        transport_context=vision_egress.transport_context if vision_egress else None,
    )
    prompt_text = prompt_text.strip()
    if prompt_text.startswith("```"):
        prompt_text = "\n".join(
            line for line in prompt_text.splitlines() if not line.strip().startswith("```")
        ).strip()
    if not prompt_text:
        raise RuntimeError("keyframe prompt model returned empty prompt")
    await complete_freezone_vision_egress(vision_egress, result=prompt_text)
    return prompt_text
