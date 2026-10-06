// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { CANVAS_NODE_TYPES, resolveNodeSourceImageUrl, type CanvasNode } from '../domain/canvasNodes';
import { isRenderableImageSrc } from './imageData';

/** 用户主动选择项目目录时使用的独立标识，不与任何画布节点 ID 混用。 */
export const DIRECTOR_PROJECT_STORYBOARD_SOURCE = '@project-storyboard';

/** 只描述一跳关联节点的输出；上下文格式与防注入说明仍由后端统一生成。 */
export interface DirectorStoryboardSource {
  id: string;
  node: CanvasNode;
  kind: 'beat' | 'canvas';
  project?: string;
  episode?: number;
  beat?: number;
  beats: Record<string, unknown>[];
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const positiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

/** 只接受明确的秒数；空值、区间和时间码不猜时长。 */
function seconds(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  const match = text(value).match(/^(\d+(?:\.\d+)?)\s*(?:s|秒)?$/i);
  return match ? Number(match[1]) : 0;
}

/** 读取上游实际画面或结构化输出；图片不凭空推断动作、人物名称或时长。 */
function canvasBeats(node: CanvasNode): Record<string, unknown>[] {
  const data = record(node.data);
  const imageUrl = resolveNodeSourceImageUrl(node);
  if (imageUrl) {
    return [{
      beat_number: 1, reference_image_url: imageUrl,
      visual_description: text(data.description) || text(data.note),
      audio_type: 'silence', duration_seconds: 0,
    }];
  }
  if (node.type === CANVAS_NODE_TYPES.textAnnotation) {
    return text(data.content) ? [{ beat_number: 1, visual_description: text(data.content), duration_seconds: 0 }] : [];
  }
  if (node.type === CANVAS_NODE_TYPES.beatContext) {
    const snapshot = record(data.snapshot), edited = record(data.beat_edit_fields);
    const description = text(edited.visual_description) || text(snapshot.visualDescription) || text(data.content);
    const dialogue = text(snapshot.narrationSegment);
    if (!description && !dialogue) return [];
    return [{
      ...edited, beat_number: positiveInteger(data.beat) || 1,
      visual_description: description, narration_segment: dialogue,
      audio_type: dialogue ? 'narration' : 'silence',
      scene_ref: { scene_id: text(edited.scene_id) || text(snapshot.sceneId) },
      time_of_day: text(edited.time_of_day) || text(snapshot.timeOfDay),
      detected_identities: edited.detected_identities ?? snapshot.detectedIdentities ?? [],
      duration_seconds: seconds(edited.duration_seconds),
    }];
  }
  let rows: unknown[] = [];
  if (node.type === CANVAS_NODE_TYPES.script) {
    const result = record(data.scriptResult);
    rows = Array.isArray(result.rows) ? result.rows : [];
  } else if (node.type === CANVAS_NODE_TYPES.videoStory) {
    rows = Array.isArray(data.rows) ? data.rows : [];
  } else if (node.type === CANVAS_NODE_TYPES.storyboardSplit || node.type === CANVAS_NODE_TYPES.storyboardGen) {
    rows = Array.isArray(data.frames) ? [...data.frames] : [];
    if (node.type === CANVAS_NODE_TYPES.storyboardSplit) {
      rows.sort((a, b) => Number(record(a).order || 0) - Number(record(b).order || 0));
    }
  }
  const numbers = new Set<number>();
  return rows.map((value, index) => {
    const row = record(value);
    let number = positiveInteger(row.shot_no) || positiveInteger(row.shotNumber) || index + 1;
    // 非法/重复编号只影响画布目录编号，绝不改上游节点本身。
    while (numbers.has(number)) number += 1;
    numbers.add(number);
    const description = text(row.visual_description) || text(row.visualDescription) || text(row.description) || text(row.note);
    const dialogue = text(row.dialogue) || text(row.voiceAndSfx);
    // 脚本参考栏可能填「无」等占位文字，只选可显示的真实图片来源。
    const imageUrl = [row.imageUrl, row.previewImageUrl, row.reference].map(text).find(isRenderableImageSrc) || '';
    const interaction = [text(row.character_action), text(row.emotion), text(row.cameraMovement), text(row.shotSize)].filter(Boolean).join('；');
    return {
      beat_number: number,
      visual_description: [description, text(row.narrative), interaction].filter(Boolean).join('\n'),
      duration_seconds: seconds(row.duration),
      scene_ref: { scene_id: text(row.scene_tags) },
      narration_segment: dialogue,
      audio_type: dialogue ? 'dialogue' : 'silence',
      detected_identities: [text(row.character_1), text(row.character_2)].filter(Boolean),
      video_prompt: text(row.video_motion_prompt) || text(row.videoMotionPrompt) || text(row.shot_prompt),
      reference_image_url: imageUrl,
    };
  }).filter(beat => text(beat.visual_description) || text(beat.narration_segment) || text(beat.video_prompt) || text(beat.reference_image_url));
}

/**
 * 入参必须来自 useUpstreamNodes；未连线节点、同项目其他分镜不会成为候选。
 * 镜头上下文带明确项目/集/镜号时只查该镜头，其余节点读取自己的输出字段。
 */
export function directorStoryboardSources(upstream: readonly CanvasNode[]): DirectorStoryboardSource[] {
  const sources: DirectorStoryboardSource[] = [], seen = new Set<string>();
  for (const node of upstream) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    const data = record(node.data);
    const project = text(data.projectId), episode = positiveInteger(data.episode), beat = positiveInteger(data.beat);
    if (node.type === CANVAS_NODE_TYPES.beatContext && project && episode && beat) {
      sources.push({ id: node.id, node, kind: 'beat', project, episode, beat, beats: [] });
      continue;
    }
    const beats = canvasBeats(node);
    if (beats.length) sources.push({ id: node.id, node, kind: 'canvas', beats });
  }
  return sources;
}

/** 初次只有一个上游时自动关联；断开已选来源、多源或主动清空时必须重新选择。 */
export function resolveDirectorStoryboardSource(
  sources: readonly DirectorStoryboardSource[],
  selectedId: string | null | undefined,
): DirectorStoryboardSource | null {
  if (selectedId === undefined) return sources.length === 1 ? sources[0] : null;
  return sources.find(source => source.id === selectedId) ?? null;
}
