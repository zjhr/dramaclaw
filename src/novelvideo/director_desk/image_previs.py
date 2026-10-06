"""图片预演共创的会话状态与本地报告工具，不直接操作引擎。"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Mapping, Sequence
from uuid import uuid4

IMAGE_PREVIS_TOOL_NAME = "director_image_previs"
IMAGE_PREVIS_TOOL = {
    "name": IMAGE_PREVIS_TOOL_NAME,
    "description": "图片分镜共创：根据实际图像报告识图结果和澄清问题，或提交完整方案等待用户确认；不能识图时报告 unsupported 并停止。此工具不修改工程。每轮的最后一步调用它，调用后等待用户。",
    "inputSchema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "status": {"type": "string", "enum": ["clarify", "plan", "unsupported"]},
            "observation": {
                "type": "string",
                "description": "真实图像中的可见事实；不能识图时写原因，不能按文字提示猜图。",
                "maxLength": 4000,
            },
            "questions": {
                "type": "array",
                "items": {"type": "string", "maxLength": 500},
                "maxItems": 3,
            },
            "plan": {
                "type": "string",
                "description": "plan 时必填：场景、人物动作与互动、时间、运镜和能力限制；其他状态填空字符串。",
                "maxLength": 12000,
            },
        },
        "required": ["status", "observation", "questions", "plan"],
    },
}

IMAGE_PREVIS_INSTRUCTIONS = """
本轮自动启用「图片分镜共创预演」技能。先识图，再逐轮澄清用户想法，最后达成共识才执行。
依据实际图片报告可见内容，不能根据文件名、提示词、链接或历史图猜测。静态图不能证明动作、角色身份或时长。
每轮只问一到三个关键问题；已回答的信息直接沿用。澄清过程中只能用只读工具，不改场景。
用 director_image_previs 报告结果：clarify 时 observation 写可见事实、questions 写待问问题；
plan 时 observation 写可见事实、questions 为空、plan 写完整可执行方案（场景、动作、互动、各段时间和运镜、限制）。
不能识图立即报告 unsupported，不编排、不写入，告诉用户更换支持图像输入的模型。图模糊则 clarify 请求清晰图。
不要只在普通正文中说「确认」：必须调用本工具，界面才能显示问题和确认按钮。它是本轮最后一步，报告后等待用户。
普通发送均为讨论或修订；仅宿主附带的有效方案确认才授权开始预演。图片或核心要求变化时重新确认。
确认后依已确认方案实施场景、动画、互动和运镜；检查时长、动作路径覆盖、切镜与空间，并展示可播放预览。
工具完成只说明实际完成项与保存状态，不将白模预演称作最终成片；不能看图时仍必须停止。
"""


def input_key(images: Sequence[str], context: str) -> str:
    """图像与来源文字共同绑定方案，防止相同图片的不同分镜要求复用旧确认。"""
    return hashlib.sha256(
        json.dumps([list(images), context], ensure_ascii=False).encode()
    ).hexdigest()


def channel_key(profile_id: str, model: str, protocol: str, base_url: str) -> str:
    """渠道及模型变化后需要重新识图，密钥不参与对外状态。"""
    return hashlib.sha256(
        json.dumps([profile_id, model, protocol, base_url]).encode()
    ).hexdigest()


def public_state(state: Any) -> dict[str, Any] | None:
    """只返回界面需要的字段，完整图像、来源上下文和内部绑定不进入快照。"""
    if not isinstance(state, dict):
        return None
    return {
        key: state.get(key)
        for key in ("stage", "observation", "questions", "plan", "planId")
    }


def prepare_state(
    previous: Any, image_key: str, model_key: str, confirmation: str
) -> dict[str, Any]:
    """明确确认仅对活动会话的当前图片、模型和待确认方案有效。"""
    same = (
        isinstance(previous, dict)
        and previous.get("imageKey") == image_key
        and previous.get("modelKey") == model_key
    )
    if confirmation:
        if (
            not same
            or previous.get("stage") != "ready"
            or previous.get("planId") != confirmation
        ):
            raise ValueError("图片、模型或方案已变化，请重新讨论并确认当前方案。")
        return {**previous, "stage": "executing"}
    # 发送新想法视为修订；即便同图，也不继承上轮的执行授权。
    return {
        "imageKey": image_key,
        "modelKey": model_key,
        "stage": "clarifying" if same and previous.get("observation") else "reading",
        "observation": previous.get("observation", "") if same else "",
        "questions": [],
        "plan": "",
        "planId": "",
    }


def report_state(state: Mapping[str, Any], args: Mapping[str, Any]) -> dict[str, Any]:
    """报告只推进讨论状态，方案编号由服务端生成，模型不能自授执行许可。"""
    if set(args) != {"status", "observation", "questions", "plan"}:
        raise ValueError("图片共创报告字段不完整。")
    status, observation, questions, plan = (
        args.get(key) for key in ("status", "observation", "questions", "plan")
    )
    if not isinstance(status, str) or status not in {"clarify", "plan", "unsupported"}:
        raise ValueError("图片共创报告状态无效。")
    if (
        not isinstance(observation, str)
        or not observation.strip()
        or len(observation) > 4000
    ):
        raise ValueError("请先报告实际识图结果或不能识图的原因。")
    if (
        not isinstance(questions, list)
        or len(questions) > 3
        or any(
            not isinstance(q, str) or not q.strip() or len(q) > 500 for q in questions
        )
    ):
        raise ValueError("每轮需要一到三个明确的澄清问题。")
    if not isinstance(plan, str) or len(plan) > 12000:
        raise ValueError("图片预演方案过长或格式无效。")
    if status == "plan" and (not plan.strip() or questions):
        raise ValueError("提交方案前请先澄清问题，并给出完整方案。")
    if status == "clarify" and not questions:
        raise ValueError("请给出需要用户回答的澄清问题。")
    if status != "plan" and plan.strip():
        raise ValueError("尚未达成共识时不能提交执行方案。")
    return {
        **state,
        "stage": {
            "clarify": "clarifying",
            "plan": "ready",
            "unsupported": "unsupported",
        }[status],
        "observation": observation.strip(),
        "questions": questions if status == "clarify" else [],
        "plan": plan.strip() if status == "plan" else "",
        "planId": str(uuid4()) if status == "plan" else "",
    }
