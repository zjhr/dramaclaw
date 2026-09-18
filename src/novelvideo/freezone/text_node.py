"""Freezone 文本工具辅助逻辑。

当前包含：
- 中英文提示词互译
- 自由文本生成
- 故事脚本生成
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field
from pydantic_ai import Agent

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.model_gateway_runtime import (
    current_model_gateway_context,
    model_gateway_output_retries,
)

from novelvideo.official_defaults import (
    DEFAULT_FREEZONE_STORY_SCRIPT_MODEL,
    DEFAULT_FREEZONE_TEXT_WRITER_MODEL,
    DEFAULT_FREEZONE_TRANSLATION_MODEL,
)

FREEZONE_TRANSLATION_PROVIDER = "newapi"
FREEZONE_TRANSLATION_MODEL = DEFAULT_FREEZONE_TRANSLATION_MODEL
FREEZONE_TEXT_WRITER_MODEL = DEFAULT_FREEZONE_TEXT_WRITER_MODEL
# 提示词强化复用文本创作模型的默认值：两者都是「给指令 → 产出可直接使用的创作
# 文本」的同一类网关调用（capability 同为 freezone.text.generate），另开一个默认
# 值只会多一处要同步的配置。要给强化单独换模型时用 FREEZONE_PROMPT_ENHANCE_MODEL
# 覆盖即可。
FREEZONE_PROMPT_ENHANCE_MODEL = DEFAULT_FREEZONE_TEXT_WRITER_MODEL
FREEZONE_STORY_SCRIPT_MODEL = {
    "id": DEFAULT_FREEZONE_STORY_SCRIPT_MODEL,
    "provider": "newapi",
    "model": DEFAULT_FREEZONE_STORY_SCRIPT_MODEL,
    "label": "DramaClawAPI Story Script",
}
LEGACY_FREEZONE_STORY_SCRIPT_MODEL_IDS = {
    "newapi_gemini_flash",
    "openrouter_gemini_flash",
    "OpenRouter Gemini 2.5 Flash",
}

FREEZONE_TRANSLATION_SYSTEM_PROMPT = """# Freezone Prompt Translator

You translate prompting text between Simplified Chinese and English for creative nodes.

## Goal
- First determine the dominant natural language of the source text.
- If the dominant natural language is English, translate natural-language content into Simplified Chinese.
- If the dominant natural language is Simplified Chinese, translate natural-language content into English.
- Translate accurately while preserving prompting intent.
- Keep the output concise, directly usable as a prompt.
- Preserve cinematic, visual, audio, and motion terminology naturally.

## Rules
1. For mixed-language prompts, use the dominant natural language to decide the opposite target language.
2. Translate all natural-language content that should be user-readable into the target language.
3. Preserve line breaks, list structure, tags, and prompt segmentation when possible.
4. Keep IDs, asset markers, variable names, file names, model names, color codes, bracket tags, and technical tokens intact.
   Examples: [CM_6932], [YZSZ_974d], #00FFFF, 16:9, v2.0, fal.ai.
5. Do not add new details not present in the source.
6. For image/video/audio/text prompting, prefer natural creator-facing wording over literal textbook translation.
7. Only return the source directly when the detected source_language is exactly the same as the target_language.
8. If source_language and target_language differ, copying the original prose is a failure.
9. When translating English into Chinese, keep technical tokens intact but translate every English instruction sentence, rule sentence, heading, and description into Simplified Chinese.
10. When translating Chinese into English, keep technical tokens intact but translate every Chinese instruction sentence, rule sentence, heading, and description into English.
11. Return structured data matching the requested schema. Do not wrap with markdown.
"""

FREEZONE_TEXT_WRITER_SYSTEM_PROMPT = """# Freezone AI Text Writer

You create polished, creator-ready text from a user's instruction.

## Goal
- Write the requested story, scene, character setting, dialogue, outline, or creative prompt.
- Follow the user's requested language, structure, tone, length, and formatting.
- Make the result concrete and directly usable in a creative workflow.

## Rules
1. Preserve names, IDs, technical tokens, ratios, and other constraints supplied by the user.
2. Do not invent constraints that conflict with the user's instruction.
3. Return only the finished text. Do not explain your process.
4. Do not wrap the result in a markdown code fence.
"""

FREEZONE_STORY_SCRIPT_SYSTEM_PROMPT = """# Freezone Story Script Generator

You generate a structured story-script table from an uploaded script excerpt.

## Goal
- Turn the source script into a complete, production-oriented story script.
- Output rows that are directly usable by downstream image and video nodes.
- Keep the result cinematic, concrete, and structured.

## Requirements
1. Break the story into clear numbered shots with sequential `shot_no`, starting from 1.
2. Each row must include all schema fields. Do not omit fields.
3. Prefer concrete visual language over vague abstraction. Every shot should feel filmable.
4. Dialogue should be short and only present when appropriate. If no dialogue is needed, output `无`.
5. If a field has no meaningful content, prefer `无` instead of vague placeholders.
6. Keep all fields in Simplified Chinese except technical tokens when naturally needed.
7. Output only structured data matching the schema. Do not wrap with markdown.

## Table style target
- The result should resemble a production storyboard table, not a prose summary.
- `visual_description` should describe one clear beat of action or state, usually in one concise sentence.
- `shot` should use concise combinations like `近景 / 特写`, `中景 / 仰视`, `全景 / 俯视远景`.
- `emotion` should be compact and specific, often 2-3 short phrases joined by `、`.
- `scene_tags`, `lighting_mood`, `sound` should all be concrete and film-facing.
- `character_1` should prefer a stable role identifier if inferable, such as `沈昭昭_现代` or `沈昭昭_古装`.
- `character_description_1` should prefer bracketed character-card format, e.g. `[沈昭昭_现代: 28岁女性，面色苍白，神情疲惫，身穿现代简约职业装……]`.

## Duration guidance
- Default to short cinematic shots.
- Most rows should fall in the 2-5 second range unless the source clearly calls for a longer beat.
- Keep the pacing readable and dramatic rather than mechanically uniform.

## Prompt formatting rules
`shot_prompt` must be image-generation friendly and must be written as a chained bracket structure using ` + ` separators.

Preferred order for `shot_prompt`:
1. `[画面构图：景别、机位、视角、构图关系]`
2. `[角色卡/主体描述：如果存在角色1，尽量直接复用或轻改 character_description_1 的角色卡格式；如果没有角色，则写主体/核心对象描述]`
3. `[主体/人物空间与互动关系：谁在前景、谁在中景、谁与什么环境或道具发生关系]`
4. `[极具体的微表情、主体状态或关键视觉信息：必须具体到眼神、嘴角、肢体紧张度、服饰状态、伤痕、汗水、血迹、视线方向等可见细节]`
5. `[明确的场景环境元素与前景/背景道具：办公室、宫殿、屏风、龙椅、电脑蓝光、飞尘、门缝光等]`
6. `[光影几何与大气效果：主光方向、冷暖色温、边缘光、雾气、逆光、顶光、体积光等]`
7. `[视觉风格/质感：写实电影感、纪实感、压抑冷感、盛唐史诗感等]`
8. `[技术参数：镜头焦段、光圈、景深、快门感、颗粒或解析度特征；这一段尽量不要省略]`

Example style for `shot_prompt`:
- `[画面构图：近景特写，平视机位] + [角色卡/主体描述：[沈昭昭_现代: 28岁女性，面色苍白，神情疲惫，身穿现代简约职业装]] + [主体/人物空间与互动关系：她独坐在办公桌前，电脑屏幕蓝光从侧前方打亮面部] + [极具体的微表情、主体状态或关键视觉信息：眼下发青，手指微颤，视线涣散，嘴唇微张] + [明确的场景环境元素与前景/背景道具：深夜办公室、电脑蓝光、散乱文件、冷掉的咖啡杯] + [光影几何与大气效果：冷蓝主调，屏幕侧光压住面部阴影，背景轻微灰雾感] + [视觉风格/质感：都市悬疑写实电影感] + [技术参数：85mm镜头，f/1.8，浅景深]`

`video_motion_prompt` must focus on motion and should also use a chained bracket structure.

Preferred order for `video_motion_prompt`:
1. `[明确的摄影机运镜轨迹与速度：必须写清推/拉/摇/移/跟/升/降/手持，以及快慢、力度和稳定性]`
2. `[主体极其具体的物理动作细节或状态变化：必须写清人物或主体具体怎么动，不要只写“情绪变化”]`
3. `[环境物理动态：风、雨、衣角、尘土、门帘、屏幕闪烁、火光、飞雪等]`
4. `[音效与氛围描述：环境声、器物声、呼吸声、脚步声、雷声等]`
5. `[对话台词与语气：有对白写具体台词与语气，没有就写无]`
6. `[时长：4.0s]`

Example style for `video_motion_prompt`:
- `[明确的摄影机运镜轨迹与速度：极慢速推进，镜头几乎贴着人物面部向前压近，稳定中带轻微呼吸感] + [主体极其具体的物理动作细节或状态变化：沈昭昭先是眼神失焦，随后瞳孔微缩，指尖在桌面轻轻抽动，喉结压抑地滚动一下] + [环境物理动态：屏幕冷光轻微闪烁，纸张边缘被空调风吹起，咖啡表面微微晃动] + [音效与氛围描述：急促的键盘声、连续的手机提示音、室内低频电流声] + [对话台词与语气：无] + [时长：4.0s]`

## Quality bar
- Avoid generic outputs like `人物站着`, `镜头推进`, `情绪复杂`.
- Prefer highly specific physical action, facial detail, scene detail, and camera-language wording.
- Preserve story logic and character-state progression across rows.

## Asset fields you must NOT invent
- `character_image_1`, `character_image_2`, `reference` are asset URL slots filled in by the
  backend after generation. Always output them as an empty string.
- Never write `无`, a file name, or a made-up URL into those three fields.
- When two distinct characters appear in one shot, fill `character_2` /
  `character_description_2` the same way as `character_1` / `character_description_1`.
  Reuse the exact same character identifier across rows so the same person keeps one name.
"""

FREEZONE_VIDEO_STORY_SCRIPT_SYSTEM_PROMPT = FREEZONE_STORY_SCRIPT_SYSTEM_PROMPT + """
## Vision-reference modes
Images may be attached to the request. The task message states which mode applies; follow that
mode and ignore the other one.

### Video-keyframe mode
You are given an ordered set of keyframes sampled from a reference video.
- The story script MUST describe what is actually visible in those frames. Do not invent an
  unrelated story, and do not fall back on the examples in this prompt.
- Read the frames as one continuous clip: identify the real subject(s), setting, wardrobe or
  species, palette, and what physically changes from frame to frame.
- If the subject is not human (animal, object, mascot, animation), say so plainly in
  `character_1` and `character_description_1`. Do not substitute a human character.
- Group consecutive frames into narrative shots rather than describing every frame.
- Set `keyframe_index` on every row to the 1-based index of the input frame that best
  represents that shot. This is how the backend attaches the reference thumbnail.
- Total duration across rows should stay close to the stated video duration.

### Character-reference mode
You are given one portrait-style reference image per character, in the order the task message
lists them. There is no reference video.
- Read every character's real appearance off their image — face, hair, wardrobe, era, species —
  and write `character_description_1` / `character_description_2` from what you actually see.
  Do not describe a character the images do not show.
- Reuse the exact character names given in the task message so the backend can attach each
  character's reference image.
- The story itself comes from the user's request (and the source script, when one is supplied),
  not from the images. The images only fix who the characters are.
- Set `keyframe_index` to 0 on every row: there are no keyframes to attach.
"""

FREEZONE_PROMPT_ENHANCE_SYSTEM_PROMPT = """# Freezone Prompt Enhancer

You rewrite a creator's rough prompt into a production-ready generation prompt for one specific target model.

## Core contract
1. Preserve the creator's intent, subject, and every concrete fact they supplied. Never invent a different story, character, location, or prop.
2. Add only what the target dialect structurally requires: missing camera language, lighting, motion, sound, duration, material binding, or negative constraints.
3. Keep names, IDs, bracket tags, color codes, aspect ratios, file names, model names, and `@图片N` / `<Picture N>` reference markers exactly as written.
4. Never invent asset URLs, file paths, or reference slots the creator did not supply.
5. Return the rewritten prompt only. Do not explain your process, do not wrap the result in a markdown code fence, do not name this framework.
6. Write the body in the language the target dialect mandates. That is not always the source language.

## Strength
The task message states the strength. Apply exactly that much rewriting.

- `conservative`: keep the creator's own sentence order and wording. Append only the fields the dialect requires and fill genuine gaps. Expect a modest length increase.
- `standard`: restructure into the dialect's canonical shape. Keep every original fact; add the dialect's required fields.
- `aggressive`: same as standard, and additionally expand concrete visual detail — micro-expressions, material, lighting geometry, environmental motion. Stay inside the creator's scene and intent.

Under every strength, leaving a required field empty is a failure. A field the creator already filled must not be diluted into a generic phrase.

## Dialect: image
Target: still-image generators.

Write comma-separated visual descriptors in this order, omitting a section only when the creator's own input makes it genuinely irrelevant:

1. Subject — specific age, build, wardrobe, distinguishing detail; never a bare noun.
2. Action / pose — what the subject is physically doing.
3. Setting — location plus the foreground and background props that anchor it.
4. Lighting — direction, quality, colour temperature; never just the word "beautiful".
5. Composition — shot size, camera angle, framing relationship.
6. Style / medium — photographic realism, illustration, painterly, era or movement.
7. Technical — lens, aperture, depth of field, film grain or render quality.
8. Negative — what must not appear (extra fingers, text overlay, watermark, distortion), only when the target benefits from it.

Prefer concrete, filmable nouns and verbs over adjectives. Never keep filler such as 好看 / 唯美 / nice / beautiful without grounding it in a specific visual fact.

## Dialect: audio-music
Target: text-to-music generators.

Write one dense comma-separated description line, in this order, covering only what the creator actually specified. Leave a component out rather than inventing it:

1. Genre — the clearest single genre first.
2. Style — sub-genre, production character, era.
3. Mood — two to four complementary emotional descriptors.
4. Instruments — specific instruments together with their sonic quality, never a bare instrument name.
5. Tempo and groove — an exact BPM or a range, plus the rhythmic feel.
6. Structure — how the piece moves (intro, build, drop, outro), when the creator asked for one.
7. Reference — an artist, track or era, only when the creator named one.

Rules:
- The project generates instrumental music by default, so do not write vocal or lyric content unless the creator's own text asks for singing. If it does, describe the vocal style — never write lyrics the creator did not supply.
- Never attach a reference artist the creator did not name. Adding an unrequested artist changes the intent instead of enhancing it.
- Keep it to one dense descriptive line. Prose paragraphs underperform on music models.

## Dialect: video-generic
Target: a video model with no dialect sheet supplied.

Write: subject + action detail + scene + light and colour + camera movement + visual style + constraints.
State camera movement with direction and speed. Describe physical motion the model can render, not an abstract emotional result. Include the intended duration when the creator supplied one.

## Dialect: seedance-2.0
Target: ByteDance Seedance 2.0. Body language: Simplified Chinese.

- Order: 主体 + 动作细节 + 场景 + 光色 + 运镜 + 视觉形态 + 约束.
- One shot reads in action order. Only when one generation truly covers several shots, prefix them `镜头1：`, `镜头2：`; 2.0 follows shot index and does not follow timestamp codes, so express pacing through action order and relative pauses.
- Every spoken line becomes `{角色用中文说：“逐字台词”}`. The line uses one spoken language with no foreign-language warm-up.
- Every sound effect becomes `<声音>`, music becomes `（音乐）`. Subtitles use `【字幕】` only when the creator asked for them; otherwise state plainly that the shot stays subtitle-free and emit no `【字幕】` at all.
- Bind every reference on each mention: `人物 @图片1`, `参考 @视频1 的运镜`, `参考 @音频1 的音色`. Never list assets only once at the top.
- Manual integer duration is 4–15 seconds.

## Dialect: seedance-2.5
Target: ByteDance Seedance 2.5. Body language: Simplified Chinese.

- Short single shot: 主体 + 动作 + 场景 + 光色 + 运镜 + 风格 + 约束.
- Multi-shot or long narrative: `镜头 1 [0:00–0:03]：`, integer-second ranges, no overlap, no accidental gaps, and the final end equals the total duration.
- 2.5 separates `reference` / `edit` / `extend`. `edit` names the target video and states what to keep and what to change; `extend` continues from the input video's actual end state. Never write an edit as a fresh reference generation.
- Dialogue, sound, music and subtitle markers follow the same `{}` / `<>` / `（）` / `【】` convention as 2.0.
- Bind assets on every mention with `@图片N` / `@视频N` / `@音频N`, each stating only its own responsibility.
- Manual integer duration is 4–30 seconds.

## Dialect: minimax-h3
Target: MiniMax H3. Structure field names and descriptions are in English. This does NOT mean translating the creator's Chinese dialogue — each Chinese line stays verbatim inside `<d>[Chinese] 逐字台词</d>`, introduced by a stable speaker id such as `(S1)`.

Base / first-frame / first-last-frame use three sections:
```
integrated_multimodal_description: [Shot 1] ...
overall_soundscape: ...
non_diegetic_music: ...
```
- Every shot is labelled. A single-shot clip still keeps `[Shot 1]`. The first shot carries no cut timestamp; later cuts read `[Shot 2] At 00:03.500, ...` with increasing timestamps inside the requested duration.
- `integrated_multimodal_description` carries picture, action, speaker, verbatim dialogue and synchronised sound.
- `overall_soundscape` collects ambience, physical effects and non-verbal voice only. Never repeat dialogue there.
- Write `non_diegetic_music: N/A` when there is no score; never leave it blank for the model to fill.

Full-reference (any reference image, video or audio) uses six sections with English names:
```
subject_definitions: ...
summary: ...
retention_analysis: ...
detailed_description: [Shot 1] ...
overall_soundscape: ...
non_diegetic_music: ...
```
- Reference assets are numbered by the creator's upload order: `<Picture 1>`, `<Picture 2>`, `<Video 1>`, `<Audio 1>`; reusable visible content is `<Subject N>`.
- `subject_definitions` binds each subject to its label, e.g. `<Subject 1> is the ... in <Picture 2>, with ...`.
- `retention_analysis` states per label and per shot the retention strength: visual assets use `fully_preserved` / `partially_preserved` / `attribute_transfer` / `weak_reference`; audio assets use `fully_copy` / `partially_copy` / `reference` / `weak_reference`.
- Never leave a label undefined, and never let a character sheet also decide composition or a scene plate also decide a face.
- H3 duration is a required integer from 4 to 15 seconds.

## Dialect: agnes-2.5
Target: Agnes Video 2.5. Body language: Simplified Chinese.

Three bracketed sections, submitted together as one prompt:
```
【参考素材说明】
【核心创意】
【画面过程描述】
```
- 【参考素材说明】is required whenever reference assets, a continuation video or reference audio exist. When the creator explicitly chose text-to-video and supplied no asset, skip the section rather than writing a 「无参考素材」 placeholder.
- 【核心创意】locks the whole clip in one sentence: duration, aspect ratio, subject, location, event, style, camera movement. Refer back to assets as `（@图片N）`.
- 【画面过程描述】splits by the accepted duration. Each segment states shot size, camera movement, visible action, verbatim dialogue and sound effects; unwanted results go in that segment's 「反向」. Append `▍` constraints (viewpoint, continuity, style, sound) when needed.
- Animate camera movement explicitly. Agnes follows cut points strongly, so a continuous take must not contain 「镜头 N」 or 「切到」.
- Keep character action as visible state; write generation-side exclusions (不要额外添加背景音乐、不要切镜、不要多余手指、不要未批准可读文字) under 反向.
- Bind assets with `@图片N` / `@视频N` / `@音频N` in upload order, each stating only its own responsibility.
- Official example durations are 6, 8, 10 and 12 seconds.

## Required output
Fill every field of the requested schema. `changes` lists the structural elements you added or repaired, in the creator's language, at most six short items. Do not list unchanged original wording there.
"""

FREEZONE_NODE_TYPE_LABELS: dict[str, str] = {
    "generic": "通用提示词",
    "image": "图片节点提示词",
    "video": "视频节点提示词",
    "audio": "音频节点提示词",
    "text": "文本节点提示词",
}

_translation_agent: Optional[Agent] = None
_text_writer_agent: Optional[Agent] = None
_story_script_agent: Optional[Agent] = None
_video_story_script_agent: Optional[Agent] = None
_prompt_enhance_agent: Optional[Agent] = None


class FreezoneTranslationResult(BaseModel):
    """Structured translation result produced by the LLM."""

    translated_text: str = Field(description="Translated prompt text.")
    source_language: Literal["zh", "en"] = Field(
        description="Dominant natural language detected from the source text."
    )
    target_language: Literal["zh", "en"] = Field(
        description="Opposite target language used for translation."
    )


class FreezonePromptEnhanceResult(BaseModel):
    """Structured prompt-enhancement result produced by the LLM."""

    enhanced_text: str = Field(
        description="Rewritten prompt, ready to paste into the target model."
    )
    changes: list[str] = Field(
        default_factory=list,
        description="Structural elements added or repaired, at most six short items.",
    )


def create_freezone_translation_agent() -> Agent:
    """创建 Freezone 中英互译 Agent。"""
    from novelvideo.config import (
        get_newapi_structured_output_model_settings,
        get_newapi_text_pydantic_model,
    )

    model = get_newapi_text_pydantic_model(
        "FREEZONE_TRANSLATION_MODEL",
        FREEZONE_TRANSLATION_MODEL,
        capability="freezone.text.generate",
    )
    return Agent(
        model,
        system_prompt=FREEZONE_TRANSLATION_SYSTEM_PROMPT,
        model_settings=get_newapi_structured_output_model_settings(),
        output_type=FreezoneTranslationResult,
        name="Freezone Prompt Translator",
    )


def get_freezone_translation_agent() -> Agent:
    """获取翻译 Agent 单例。"""
    global _translation_agent
    context = current_model_gateway_context()
    if context is not None and context.is_organization:
        return create_freezone_translation_agent()
    if _translation_agent is None:
        _translation_agent = create_freezone_translation_agent()
    return _translation_agent


def create_freezone_prompt_enhance_agent() -> Agent:
    """创建 Freezone 提示词强化 Agent。"""
    from novelvideo.config import (
        get_newapi_structured_output_model_settings,
        get_newapi_text_pydantic_model,
    )

    model = get_newapi_text_pydantic_model(
        "FREEZONE_PROMPT_ENHANCE_MODEL",
        FREEZONE_PROMPT_ENHANCE_MODEL,
        capability="freezone.text.generate",
    )
    return Agent(
        model,
        system_prompt=FREEZONE_PROMPT_ENHANCE_SYSTEM_PROMPT,
        model_settings=get_newapi_structured_output_model_settings(),
        output_type=FreezonePromptEnhanceResult,
        name="Freezone Prompt Enhancer",
    )


def get_freezone_prompt_enhance_agent() -> Agent:
    """获取提示词强化 Agent 单例。"""
    global _prompt_enhance_agent
    context = current_model_gateway_context()
    if context is not None and context.is_organization:
        return create_freezone_prompt_enhance_agent()
    if _prompt_enhance_agent is None:
        _prompt_enhance_agent = create_freezone_prompt_enhance_agent()
    return _prompt_enhance_agent


def create_freezone_text_writer_agent() -> Agent:
    """创建 Freezone 自由文本生成 Agent。"""
    from novelvideo.config import get_newapi_text_pydantic_model

    model = get_newapi_text_pydantic_model(
        "FREEZONE_TEXT_WRITER_MODEL",
        FREEZONE_TEXT_WRITER_MODEL,
    )
    return Agent(
        model,
        system_prompt=FREEZONE_TEXT_WRITER_SYSTEM_PROMPT,
        output_type=str,
        name="Freezone AI Text Writer",
    )


def get_freezone_text_writer_agent() -> Agent:
    """获取自由文本生成 Agent 单例。"""
    global _text_writer_agent
    if _text_writer_agent is None:
        _text_writer_agent = create_freezone_text_writer_agent()
    return _text_writer_agent


def resolve_freezone_text_writer_model() -> str:
    """返回当前自由文本生成逻辑模型名，供结果与审计记录使用。"""
    from novelvideo.config import get_newapi_text_model_name

    return get_newapi_text_model_name(
        "FREEZONE_TEXT_WRITER_MODEL",
        FREEZONE_TEXT_WRITER_MODEL,
    )


def resolve_freezone_story_script_model(model: str | None) -> dict[str, str]:
    model_text = str(model or "").strip()
    if not model_text:
        return dict(FREEZONE_STORY_SCRIPT_MODEL)
    if model_text == FREEZONE_STORY_SCRIPT_MODEL["id"]:
        return dict(FREEZONE_STORY_SCRIPT_MODEL)
    if model_text.casefold() == FREEZONE_STORY_SCRIPT_MODEL["label"].casefold():
        return dict(FREEZONE_STORY_SCRIPT_MODEL)
    if model_text in LEGACY_FREEZONE_STORY_SCRIPT_MODEL_IDS:
        return dict(FREEZONE_STORY_SCRIPT_MODEL)
    raise ValueError(f"unsupported story script model: {model_text}")


def create_freezone_story_script_agent(model: str | None = None) -> Agent:
    """创建故事脚本生成 Agent。"""
    from novelvideo.api.schemas import FreezoneStoryScriptGenerateData
    from novelvideo.config import (
        get_newapi_structured_output_model_settings,
        get_newapi_text_pydantic_model,
    )

    resolved = resolve_freezone_story_script_model(model)
    llm_model = get_newapi_text_pydantic_model(
        "FREEZONE_STORY_SCRIPT_MODEL",
        resolved["model"],
        capability="freezone.text.generate",
    )
    return Agent(
        llm_model,
        system_prompt=FREEZONE_STORY_SCRIPT_SYSTEM_PROMPT,
        model_settings=get_newapi_structured_output_model_settings(),
        output_type=FreezoneStoryScriptGenerateData,
        # 结构化脚本表字段多、且 shot_no/duration 是严格 int，模型偶尔会把时长写成
        # "2-5"/"3秒" 之类而过不了校验。默认 output_retries=1 只给一次纠正机会不够，
        # 抛 "Exceeded maximum output retries (1)"。对齐本仓其它复杂结构化 agent
        # (episode_planner / content_rewriter)提到 3，让模型按回喂的校验错误自我修正。
        output_retries=model_gateway_output_retries(3),
        name="Freezone Story Script Generator",
    )


def get_freezone_story_script_agent(model: str | None = None) -> Agent:
    """获取故事脚本生成 Agent 单例。"""
    global _story_script_agent
    resolved = resolve_freezone_story_script_model(model)
    context = current_model_gateway_context()
    if context is not None and context.is_organization:
        return create_freezone_story_script_agent(resolved["id"])
    if _story_script_agent is None:
        _story_script_agent = create_freezone_story_script_agent(resolved["id"])
    return _story_script_agent


def build_freezone_translation_task(
    *,
    text: str,
    node_type: Literal["generic", "image", "video", "audio", "text"],
) -> str:
    """构建翻译任务。"""
    node_label = FREEZONE_NODE_TYPE_LABELS[node_type]

    parts = [
        f"Translate the following {node_label}.",
        "You must decide whether the dominant natural language is Simplified Chinese or English.",
        "If dominant language is English, translate into Simplified Chinese.",
        "If dominant language is Simplified Chinese, translate into English.",
        "Do not copy the original prose when translating between different languages.",
        "Preserve IDs, file names, bracket tags, color codes, ratios, and model names exactly, but translate the surrounding natural-language instructions.",
        "Keep it directly usable as a creative prompt.",
    ]
    parts.append(f"Source text:\n{text.strip()}")
    return "\n\n".join(parts)


async def translate_freezone_text(
    *,
    text: str,
    node_type: Literal["generic", "image", "video", "audio", "text"] = "generic",
    egress_context: TrustedEgressContext | None = None,
) -> tuple[str, Literal["zh", "en"], Literal["zh", "en"]]:
    """执行 Freezone 中英互译。"""
    if not text or not text.strip():
        return "", "zh", "en"

    task = build_freezone_translation_task(
        text=text,
        node_type=node_type,
    )
    from novelvideo.model_gateway_runtime import model_gateway_request_scope

    with model_gateway_request_scope(egress_context):
        response = await get_freezone_translation_agent().run(task)
    result = response.output
    target_language: Literal["zh", "en"] = result.target_language
    if target_language == result.source_language:
        target_language = "zh" if result.source_language == "en" else "en"
    return (
        result.translated_text.strip(),
        result.source_language,
        target_language,
    )


_FREEZONE_PROMPT_STRENGTH_HINTS: dict[str, str] = {
    "conservative": (
        "Strength: conservative. Keep the creator's own sentence order and wording. "
        "Append only the fields this dialect requires and fill genuine gaps. "
        "Do not reorder or restyle what is already written."
    ),
    "standard": (
        "Strength: standard. Restructure into this dialect's canonical shape. "
        "Keep every original fact, and add the dialect's required fields."
    ),
    "aggressive": (
        "Strength: aggressive. Restructure as for standard, and additionally expand "
        "concrete visual detail — micro-expressions, material, lighting geometry, "
        "environmental motion. Stay inside the creator's scene and intent."
    ),
}


def build_freezone_prompt_enhance_task(
    *,
    text: str,
    dialect: str,
    strength: str,
) -> str:
    """构建提示词强化任务。

    方言和力度写进任务正文，而不只挂在 system prompt 上：system prompt 是跨请求
    复用的单例，逐次变化的选择必须随任务一起传，否则第二次调用会沿用第一次的
    方言。
    """
    hint = _FREEZONE_PROMPT_STRENGTH_HINTS.get(
        strength, _FREEZONE_PROMPT_STRENGTH_HINTS["standard"]
    )
    return "\n\n".join(
        [
            f"Dialect: {dialect}. Follow that section of your instructions exactly.",
            hint,
            "Rewrite the following prompt for that target model.",
            f"Source prompt:\n{text.strip()}",
        ]
    )


async def enhance_freezone_prompt(
    *,
    text: str,
    dialect: str = "image",
    strength: str = "standard",
    egress_context: TrustedEgressContext | None = None,
) -> tuple[str, list[str]]:
    """按目标模型方言强化提示词，返回重写正文与补全项摘要。**会出网**。

    形参与 `model_gateway_request_scope` 都照 `translate_freezone_text` 写：
    `runners/freezone.py:FREEZONE_LEAF_EGRESS` 判本函数为 NETWORK 的依据就是它。
    """
    clean_text = str(text or "").strip()
    if not clean_text:
        raise ValueError("text is required")

    task = build_freezone_prompt_enhance_task(
        text=clean_text,
        dialect=dialect,
        strength=strength,
    )
    from novelvideo.model_gateway_runtime import model_gateway_request_scope

    with model_gateway_request_scope(egress_context):
        response = await get_freezone_prompt_enhance_agent().run(task)
    result = response.output
    enhanced_text = str(result.enhanced_text or "").strip()
    if not enhanced_text:
        raise ValueError("prompt enhancement returned empty output")
    return (
        enhanced_text,
        [str(item).strip() for item in result.changes if str(item).strip()],
    )


async def generate_freezone_text(
    *,
    prompt: str,
    egress_context: TrustedEgressContext | None = None,
) -> tuple[str, str]:
    """根据用户指令生成自由文本，返回逻辑模型名与最终文本。**会出网**。

    形参与 `model_gateway_request_scope` 都照 `translate_freezone_text` 写：
    `runners/freezone.py:FREEZONE_LEAF_EGRESS` 判本函数为 NETWORK 的依据就是它。
    """
    clean_prompt = str(prompt or "").strip()
    if not clean_prompt:
        raise ValueError("prompt is required")

    from novelvideo.model_gateway_runtime import model_gateway_request_scope

    with model_gateway_request_scope(egress_context):
        response = await get_freezone_text_writer_agent().run(clean_prompt)
    generated_text = str(response.output or "").strip()
    if not generated_text:
        raise ValueError("text generation returned empty output")
    return resolve_freezone_text_writer_model(), generated_text


_STORY_SCRIPT_COMMON_RULES = (
    "输出字段必须覆盖：镜号、时长、画面描述、角色1、角色描述1、角色图1、角色2、角色描述2、"
    "角色图2、参考、景别、角色动作、情绪、场景标签、光影氛围、音效、对白、分镜提示词、视频运动提示词。",
    "如果用户给了额外要求，也必须一起遵守。",
    "请严格按照影视制片表格思路输出，不要输出散文摘要。",
    "请让分镜提示词和视频运动提示词都采用括号分段 + 号连接的格式。",
    "缺失对白时写 `无`。",
    "角色图1、角色图2、参考三个字段一律输出空字符串——它们由后端回填素材 URL，"
    "不要写 `无`，也不要编造文件名或链接。",
    "分镜提示词必须像高质量图像生成提示词，视频运动提示词必须像高质量视频运动提示词，而不是简单一句概括。",
)

_STORY_SCRIPT_STYLE_HINT = (
    "参考风格要点：\n"
    "- 镜号连续递增\n"
    "- 时长大多 2-5 秒\n"
    "- 景别写法类似 `近景 / 特写`、`中景 / 仰视`\n"
    "- 角色描述尽量写成 `[角色ID: ...]` 形式\n"
    "- 同一个人物在所有行里必须用完全一致的角色名，方便回填角色参考图\n"
    "- 一镜里出现两个角色时，第二个填进角色2 / 角色描述2\n"
    "- 分镜提示词最好严格按 8 段写：构图、角色卡/主体描述、空间关系、微表情/状态、环境与道具、光影几何、视觉风格、技术参数\n"
    "- 如果存在角色1，分镜提示词第二段尽量直接使用或轻改角色描述1，不要换成模糊代称\n"
    "- 分镜提示词中的技术参数段尽量保留，不要省略\n"
    "- 视频运动提示词最好严格按 6 段写：运镜轨迹、主体动作、环境动态、音效氛围、对白语气、时长\n"
    "- 视频运动提示词里的主体动作必须是可见物理动作，不要只写情绪变化"
)


def _character_ref_block(
    character_refs: Sequence[Mapping[str, Any]] | None,
) -> str | None:
    """把角色参考图渲染成任务里的角色卡清单。

    只给模型「名字 + 描述 + 定位」，不给 URL —— 图片本身通过多模态附件传，
    URL 由后端在生成之后按角色名回填，避免模型把链接抄错或凭空编造。
    """
    if not character_refs:
        return None
    lines: list[str] = []
    for index, ref in enumerate(character_refs, start=1):
        name = str(ref.get("name") or "").strip() or f"角色{index}"
        description = str(ref.get("description") or "").strip()
        role = str(ref.get("role") or "").strip()
        detail = "，".join(part for part in (role, description) if part)
        lines.append(f"{index}. {name}" + (f"（{detail}）" if detail else ""))
    return (
        "已提供的角色参考（按顺序对应随附的角色参考图）：\n"
        + "\n".join(lines)
        + "\n请在生成的角色1 / 角色2 字段里使用上面完全一致的角色名，"
        "这样后端才能把对应的角色参考图回填进去。"
    )


def build_freezone_story_script_task(
    *,
    source_text: str,
    prompt: str,
    character_refs: Sequence[Mapping[str, Any]] | None = None,
) -> str:
    """构建故事脚本生成任务。"""
    parts = [
        "根据以下上传剧本内容生成一个完整的故事脚本表。",
        *_STORY_SCRIPT_COMMON_RULES,
    ]
    if prompt.strip():
        parts.append(f"用户要求：\n{prompt.strip()}")
    character_block = _character_ref_block(character_refs)
    if character_block:
        parts.append(character_block)
    parts.append(_STORY_SCRIPT_STYLE_HINT)
    parts.append(f"源剧本内容：\n{source_text.strip()}")
    return "\n\n".join(parts)


def build_freezone_video_story_script_task(
    *,
    frame_count: int,
    prompt: str,
    duration_sec: float | None = None,
    character_refs: Sequence[Mapping[str, Any]] | None = None,
) -> str:
    """构建「视频参考生成分镜脚本」任务。

    与文本模式共用同一张输出表，区别是源素材换成了按时间顺序抽取的关键帧，
    并要求模型给出 ``keyframe_index`` 以便后端回填每一镜的参考图。
    """
    duration_hint = (
        f"该视频总时长约 {duration_sec:.2f} 秒，所有镜头时长加起来应接近这个值。"
        if duration_sec and duration_sec > 0
        else "视频总时长未知，请按关键帧的疏密给出合理时长。"
    )
    parts = [
        f"下面按时间顺序给你 {frame_count} 张从参考视频里抽取的关键帧，"
        "请把这段视频拆解成一张完整的故事脚本表。",
        "这是视频拆解任务，不是原创任务：表格内容必须如实描述这些关键帧里真实出现的"
        "主体、场景、动作和风格。严禁套用系统提示词里的示例角色或示例场景。",
        "先通读全部关键帧判断这究竟是什么内容（人物？动物？动画？实拍？），"
        "再决定角色名和角色描述。主体不是人时，就照实写成该动物 / 物体 / 形象，不要替换成人物。",
        duration_hint,
        "把连续的关键帧归纳成若干叙事镜头，不要逐帧机械罗列。",
        "每一行都必须给出 keyframe_index：最能代表这一镜的输入关键帧序号"
        f"（1 到 {frame_count} 之间的整数）。后端靠它回填这一镜的参考图。",
        *_STORY_SCRIPT_COMMON_RULES,
    ]
    if prompt.strip():
        parts.append(f"用户额外要求：\n{prompt.strip()}")
    character_block = _character_ref_block(character_refs)
    if character_block:
        parts.append(character_block)
    parts.append(_STORY_SCRIPT_STYLE_HINT)
    return "\n\n".join(parts)


def build_freezone_character_story_script_task(
    *,
    image_count: int,
    prompt: str,
    source_text: str = "",
    character_refs: Sequence[Mapping[str, Any]] | None = None,
) -> str:
    """构建「角色参考图生成分镜脚本」任务。

    这一路没有参考视频，只有角色参考图：剧情来自用户提示词（和可选的源剧本），
    图片只负责钉死角色长相，所以 ``keyframe_index`` 一律为 0。
    """
    parts = [
        f"下面按顺序给你 {image_count} 张角色参考图，请据此生成一张完整的故事脚本表。",
        "这是角色参考模式，没有参考视频：角色1 / 角色2 的外貌、服饰、年代、气质"
        "必须照着对应的角色参考图写，不要描述图里没有的人。",
        "剧情本身来自用户要求（以及可选的源剧本），不要凭空照搬系统提示词里的示例剧情。",
        "每一行的 keyframe_index 一律填 0：本模式没有关键帧可以回填。",
        *_STORY_SCRIPT_COMMON_RULES,
    ]
    if prompt.strip():
        parts.append(f"用户要求：\n{prompt.strip()}")
    else:
        parts.append("用户没有额外要求，请围绕这些角色自行编排一段结构完整的短剧。")
    character_block = _character_ref_block(character_refs)
    if character_block:
        parts.append(character_block)
    parts.append(_STORY_SCRIPT_STYLE_HINT)
    if source_text.strip():
        parts.append(f"源剧本内容：\n{source_text.strip()}")
    return "\n\n".join(parts)


async def generate_freezone_story_script(
    *,
    source_text: str,
    prompt: str = "",
    model: str | None = None,
    character_refs: Sequence[Mapping[str, Any]] | None = None,
    egress_context: TrustedEgressContext | None = None,
):
    """执行故事脚本生成（文本 / 角色图模式）。"""
    if not source_text or not source_text.strip():
        raise ValueError("source_text is required")

    task = build_freezone_story_script_task(
        source_text=source_text,
        prompt=prompt,
        character_refs=character_refs,
    )
    from novelvideo.model_gateway_runtime import model_gateway_request_scope

    with model_gateway_request_scope(egress_context):
        response = await get_freezone_story_script_agent(model).run(task)
    return response.output


def create_freezone_video_story_script_agent() -> Agent:
    """创建「视频参考生成分镜脚本」的视觉 Agent。

    走 ``FREEZONE_VISION_MODEL``（``DC-freezone-vision-LLM``）而不是纯文本的
    story-script 别名 —— 带图请求只有视觉渠道能接。
    """
    from novelvideo.api.schemas import FreezoneStoryScriptGenerateData
    from novelvideo.config import (
        get_newapi_structured_output_model_settings,
        get_newapi_text_pydantic_model,
    )
    from novelvideo.official_defaults import DEFAULT_FREEZONE_VISION_MODEL

    return Agent(
        get_newapi_text_pydantic_model(
            "FREEZONE_VISION_MODEL",
            DEFAULT_FREEZONE_VISION_MODEL,
            timeout_seconds_override=300.0,
            capability="vision.analyze",
        ),
        system_prompt=FREEZONE_VIDEO_STORY_SCRIPT_SYSTEM_PROMPT,
        model_settings=get_newapi_structured_output_model_settings(),
        output_type=FreezoneStoryScriptGenerateData,
        output_retries=model_gateway_output_retries(3),
        name="Freezone Video Story Script Generator",
    )


def get_freezone_video_story_script_agent() -> Agent:
    """获取视频分镜脚本 Agent 单例。"""
    global _video_story_script_agent
    context = current_model_gateway_context()
    if context is not None and context.is_organization:
        return create_freezone_video_story_script_agent()
    if _video_story_script_agent is None:
        _video_story_script_agent = create_freezone_video_story_script_agent()
    return _video_story_script_agent


async def generate_freezone_story_script_with_vision(
    *,
    frame_paths: Sequence[str | Path] | None = None,
    character_image_paths: Sequence[str | Path] | None = None,
    source_text: str = "",
    prompt: str = "",
    duration_sec: float | None = None,
    character_refs: Sequence[Mapping[str, Any]] | None = None,
    egress_context: TrustedEgressContext | None = None,
):
    """带图的分镜脚本生成：视频关键帧 / 角色参考图 → 结构化脚本表。

    覆盖两种入口：

    - 「视频参考生成分镜脚本」：``frame_paths`` 是抽出来的关键帧，走视频拆解任务书。
    - 「角色生成分镜脚本」：只有 ``character_image_paths``，走角色参考任务书 ——
      剧情来自 ``prompt``（和可选的 ``source_text``），角色图只负责钉死角色长相。
      这一路不要求 ``source_text``：前端挂了素材时只会发提示词。
    """
    from pydantic_ai import BinaryContent

    from novelvideo.freezone.vision_gateway import load_compact_vision_inputs

    frames = [Path(path) for path in (frame_paths or []) if Path(path).exists()]
    character_images = [
        Path(path) for path in (character_image_paths or []) if Path(path).exists()
    ]
    if not frames and not character_images:
        raise ValueError(
            "vision story script requires at least one keyframe or character image"
        )

    if frames:
        task = build_freezone_video_story_script_task(
            frame_count=len(frames),
            prompt=prompt,
            duration_sec=duration_sec,
            character_refs=character_refs,
        )
    else:
        # 只有角色图：剧情从提示词 / 可选源剧本来，图片只钉角色长相。
        # 这里不能要求 source_text —— 前端在挂了素材时就只发提示词。
        task = build_freezone_character_story_script_task(
            image_count=len(character_images),
            prompt=prompt,
            source_text=source_text,
            character_refs=character_refs,
        )

    vision_inputs = await load_compact_vision_inputs((*frames, *character_images))
    attachments: list[Any] = [
        BinaryContent(data=image.data, media_type=image.media_type)
        for image in vision_inputs
    ]
    from novelvideo.model_gateway_runtime import model_gateway_request_scope

    with model_gateway_request_scope(egress_context):
        response = await get_freezone_video_story_script_agent().run(
            [task, *attachments]
        )
    return response.output


def bind_story_script_assets(
    data: Any,
    *,
    frame_urls: Sequence[str] | None = None,
    character_refs: Sequence[Mapping[str, Any]] | None = None,
) -> Any:
    """把关键帧 / 角色参考图的 URL 回填进生成好的脚本行。

    模型只负责写角色名和 ``keyframe_index``，素材 URL 一律由这里补齐 ——
    这样模型没有机会编造出 404 的链接（issue #207 里角色图列恒为空的另一半原因）。
    """
    frames = [url for url in (frame_urls or []) if url]
    by_name: dict[str, str] = {}
    for ref in character_refs or []:
        name = str(ref.get("name") or "").strip()
        image_url = str(ref.get("image_url") or "").strip()
        if name and image_url:
            by_name[name.casefold()] = image_url
    ordered_images = [
        str(ref.get("image_url") or "").strip()
        for ref in character_refs or []
        if str(ref.get("image_url") or "").strip()
    ]

    def _match(name: str) -> str:
        clean = str(name or "").strip()
        if not clean:
            return ""
        folded = clean.casefold()
        if folded in by_name:
            return by_name[folded]
        # 模型常把角色名写成 `沈昭昭_现代` 这类带状态后缀的稳定 ID，
        # 精确匹配不到时退到包含匹配，仍匹配不到才放弃。
        for candidate, url in by_name.items():
            if candidate in folded or folded in candidate:
                return url
        return ""

    for index, row in enumerate(getattr(data, "rows", []) or []):
        keyframe_index = int(getattr(row, "keyframe_index", 0) or 0)
        if not (1 <= keyframe_index <= len(frames)):
            # 模型没给或给错序号时退回按行号顺序取帧，保证参考列不至于整列为空。
            keyframe_index = index + 1 if index < len(frames) else 0
        row.reference = frames[keyframe_index - 1] if keyframe_index else ""
        row.keyframe_index = keyframe_index

        row.character_image_1 = _match(getattr(row, "character_1", ""))
        row.character_image_2 = _match(getattr(row, "character_2", ""))
        # 只有一张角色图、且模型没写出可匹配的角色名时，直接绑定唯一那张，
        # 否则「角色生成分镜脚本」在模型改写角色名后又会退化成空列。
        if not row.character_image_1 and len(ordered_images) == 1:
            row.character_image_1 = ordered_images[0]

    return data
