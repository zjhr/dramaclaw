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


def _detail_budget(duration_seconds: float | None) -> str:
    """按时长给细度——动作数与字数一起给，且字数是**上限**。

    两轮实测把区间定下来的：

    - 写死「80-150 字」太紧：12 秒场景只写出三步（压低身形→冲撞→各退数步），
      缺起势发力惯性收势，不够用。
    - 放开成「250 字上下」又太松：同一场景产出 690 字，把音效、惯性、衣摆摆动
      反复铺开；「上下」被读成「尽量多写」。

    所以这里给区间 + 明确上限语义，并单独限制反向段长度——反向段本该短，
    写长了只会稀释真正的约束。
    """
    if duration_seconds is None:
        return "每个动作写全起势、发力、惯性与收势。"
    if duration_seconds <= 5:
        return (
            "2 个动作。画面过程描述控制在 100-140 字，"
            "每个动作写全起势、发力、惯性与收势；写完即止，不要用形容词拉长。"
        )
    if duration_seconds <= 8:
        return (
            "3 个动作。画面过程描述控制在 160-200 字，"
            "每个动作写全起势、发力、惯性与收势；写完即止，不要用形容词拉长。"
        )
    if duration_seconds <= 12:
        return (
            "4 个动作。画面过程描述控制在 220-280 字，"
            "每个动作写全起势、发力、惯性与收势；写完即止，不要用形容词拉长。"
        )
    return (
        "5 个动作。画面过程描述控制在 300-360 字，"
        "每个动作写全起势、发力、惯性与收势；写完即止，不要用形容词拉长。"
    )


def resolve_continue_dialect(model: str | None) -> str:
    """目标模型 → 提示词方言。与前端 `dialectForVideoModel` 同一套判定。

    刻意**不在后端另写一套**映射：前端 `dialectForVideoModel` 决定「优化提示词」
    走哪个方言，这里决定「按设定推荐」走哪个。两边认不出模型时都落
    `video-generic`，新增模型只改前端那一处映射。
    """
    value = str(model or "").lower()
    if "agnes" in value:
        return "agnes-2.5"
    if "minimax" in value or "hailuo" in value:
        return "minimax-h3"
    if "seedance" in value:
        return "seedance-2.5" if "2.5" in value else "seedance-2.0"
    return "video-generic"


# 各方言的**结构要求**，抄自 `text_node.py` 的 FREEZONE_PROMPT_ENHANCE_SYSTEM_PROMPT
# 同名章节。两个按钮共用一份规范，否则推荐和优化会各写各的、产出两个水平。
#
# 之前这里是手写的 13 条自由文本规则（Sora/Runway 各一句），堆到十几条后模型只
# 认真执行最后几条，产出反而退化成散文。结构要求比规则清单有效：它规定输出长
# 什么样，而不是逐条祈使。
DIALECT_STRUCTURE_HINTS: dict[str, str] = {
    "agnes-2.5": (
        "输出三段，方括号标题不可省：\n"
        "【核心创意】一句话锁定整段：时长、画幅、主体、场景、事件、风格、运镜；"
        "有续写原片时写明承接锚点帧的画面与光线。\n"
        "【画面过程描述】按目标时长分段；每段写景别、运镜、可见动作、逐字台词与音效；"
        "不要出现「镜头 N」「切到」——整段必须是一次连续拍摄。\n"
        "【反向】只写这一段明确不要出现的东西（如不要多余背景音乐、不要切镜、不要多余手指）。"
    ),
    "seedance-2.0": (
        "输出一段连贯中文，按「主体 + 动作细节 + 场景 + 光色 + 运镜 + 视觉形态 + 约束」顺序。"
        "一次生成只演一个连续镜头，不要编排多次转场；对白写成 `{角色说：“逐字台词”}`。"
    ),
    "seedance-2.5": (
        "输出分镜式：每镜写 `镜头 N [0:00–0:03]：` 加整数秒区间，不重叠、不留缝、末段终点等于总时长。"
        "续写只写新增内容，不要写成从零重新生成。"
    ),
    "minimax-h3": (
        "字段名用英文，输出 `integrated_multimodal_description:` / `overall_soundscape:` / "
        "`non_diegetic_music:` 三段。每个镜头标 `[Shot 1]`，续镜写 `[Shot 2] At 00:03.500, ` 加递增时间戳。"
        "中文对白逐字保留在 `<d>[Chinese] 台词</d>` 里，用稳定说话人编号 (S1)/(S2)。"
    ),
    "video-generic": (
        "输出一段连贯中文，按「主体 + 动作细节 + 场景 + 光色 + 运镜 + 风格 + 约束」顺序。"
        "运镜要写方向与速度；动作写模型能渲染的物理变化，不要抽象情绪结论。"
    ),
}


def _continuity_rules(anchor_note: str, duration_seconds: float) -> str:
    """续写专有的约束，与方言无关，两个方言都要守。

    这些来自各家官方指南的共性（见 /tmp/video-prompt-research.md），不属于任何
    一家的方言，所以单列：换模型时它们不用变。
    """
    return "\n".join(
        [
            "## 续写专有约束",
            f"- {anchor_note}",
            # 这条被写错过一次：原话是「不要用文字重新描述外貌」，模型理解成
            # 「连能区分角色的颜色词都不能写」，于是产出「白衣身影」「另一人」——
            # 角色在提示词里匿名，生成时两个角色会互相漂移。现在明确划线。
            "- **区分角色要写标识**（用哪件衣服、站哪个位置、身高差）——「蓝衣人」「左侧持刀者」"
            "这种最小标识必须写，否则多个角色在提示词里没有区别。"
            "但不要写完整外貌清单（五官、发型细节、材质质感），那些已经在图里，"
            "文字重写会让模型改人改景。",
            "- 用肯定句表述约束（把「不要怎样」写成「要怎样」），各家官方对负向句的处理互相矛盾。",
            "- 开头不要重复时长（「12秒，……」这类写法是废话），时长由请求参数决定。",
            f"- 细度下限：{_detail_budget(duration_seconds)}",
        ]
    )


# 防编光源单列成一段，放在结构要求之后、约束之前。
#
# 之前它只是约束里的第 2 条，被前面的结构要求压住了：实测同一段视频连续产出 6 次
# 「红光」，画面里只有冷蓝月光。把要求写成输出格式的一部分（「每处光线都要可追溯到
# 具体画面元素」），模型才会当成必检项而不是一条可跳过的祈使句。
_LIGHT_GROUNDING_RULE = (
    "## 光线可追溯\n"
    "提示词里每写一处光线，都必须能指到画面里的具体来源（哪束光、来自哪个方向、"
    "打在谁身上）。画面里没出现的光源一律不写——保持原有光线即可。"
)

# 反向段单独限长。它本该短：写长了只会稀释真正的约束，实测一度铺到 8 条。
_REVERSE_SECTION_RULE = (
    "## 反向段限长\n"
    "【反向】最多 3 条、60 字以内，每条只写这一段最可能出问题的一件事"
    "（例如：不要新增光源、不要切镜、不要多余背景音乐）。写满三句就停。"
)


def _model_identity_cue(model: str | None) -> str:
    """目标模型的样片档位，认不出就回通用约束。

    官方建议时长档各家不同（agnes 6/8/10/12、Sora 4/8/12/16/20、Veo 4/6/8），
    给目标模型的大致档位比笼统的「4-15 秒」更能压住模型写出不合法的时长。
    """
    value = str(model or "").lower()
    if "agnes" in value:
        return "目标模型常用 6/8/10/12 秒档位，优先选其中之一。"
    if "seedance" in value:
        return (
            "目标模型 2.0 系列常用 4-15 秒，2.5 系列常用 4-30 秒；"
            "优先落在整秒上。"
        )
    if "minimax" in value or "hailuo" in value:
        return "目标模型常用 6/10 秒档位。"
    return "时长取整秒，并且必须与用户设定的目标时长一致。"


def build_continue_prompt_task(
    *,
    duration_seconds: float,
    direction: str,
    frame_count: int,
    model: str | None = None,
    reference_image_count: int = 0,
) -> str:
    """整片采样帧 + 结尾锚点帧 + 用户参考图 + 时长 + 方向 → 续写提示词。

    输出结构由目标模型的方言决定（`DIALECT_STRUCTURE_HINTS`），不再手写一份规则
    清单：之前堆了十几条祈使句，模型只认真执行最后几条，产出退化成散文。
    """
    dialect = resolve_continue_dialect(model)

    parts = [
        "你是一个视频续写提示词创作助手。",
        f"我会给你 {frame_count} 张图片：前 {frame_count - 1} 张是原片按时间顺序的采样帧，"
        "最后一张是原片的结尾帧——它将作为续写片段的**首帧**，也就是两段之间的接缝。",
    ]
    if reference_image_count > 0:
        # 用户素材排在锚点帧之后。抽帧保证不了「参照物齐全」——角色可能中途出画、
        # 道具只在某个镜头出现过——所以把「该长什么样」交给用户指定的素材来锁，
        # 采样帧只负责交代这条片子在演什么。
        parts.append(
            f"在那之后还有 {reference_image_count} 张图，是**用户指定的参考素材**，"
            "代表续写片段里必须保持一致的角色或物体。写提示词时把它们当作权威依据："
            "凡是与素材冲突的外貌、衣着、形态，一律以素材为准，不要照抄锚点帧里的。"
        )
    parts += [
        "请根据这些画面，写一段可直接用于「首帧续写」的视频生成提示词，描述结尾帧之后发生什么。",
        "",
        "## 输出结构",
        DIALECT_STRUCTURE_HINTS.get(dialect, DIALECT_STRUCTURE_HINTS["video-generic"]),
        "",
        _LIGHT_GROUNDING_RULE,
        "",
        _REVERSE_SECTION_RULE,
        "",
        _continuity_rules(
            "第一帧就是锚点帧，续写必须从锚点帧的画面与光线接上去，不重置人物姿态。",
            duration_seconds,
        ),
        "",
        "## 本次设定",
        f"- 目标时长约 {duration_seconds:.1f} 秒。{_model_identity_cue(model)}",
        f"- 发展方向：{VIDEO_CONTINUE_DIRECTIONS[direction]}",
        "- 只输出最终提示词，不要解释，不要 markdown 代码围栏，不要编号列表。",
    ]
    return "\n".join(parts)


async def suggest_continue_prompt_from_frames(
    *,
    frame_paths: Sequence[Path],
    duration_seconds: float,
    direction: str,
    model: str | None = None,
    reference_image_paths: Sequence[Path] = (),
    egress_context: TrustedEgressContext | None = None,
) -> str:
    """看着「整片采样帧 + 结尾锚点帧 + 用户参考图」与设定，写一段续写提示词。

    `frame_paths` 的**最后一张必须是结尾锚点帧**，顺序即任务描述里的叙事顺序。
    `reference_image_paths` 是用户指定的角色/物体素材，紧随锚点帧之后。
    """
    paths = [Path(path) for path in frame_paths]
    if len(paths) < 2:
        raise ValueError("continue prompt needs context frames and an anchor frame")
    direction_id = normalize_video_continue_direction(direction)
    references = [Path(path) for path in reference_image_paths]
    prompt = build_continue_prompt_task(
        duration_seconds=duration_seconds,
        direction=direction_id,
        frame_count=len(paths),
        model=model,
        reference_image_count=len(references),
    )
    images = await load_compact_vision_inputs([*paths, *references])
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