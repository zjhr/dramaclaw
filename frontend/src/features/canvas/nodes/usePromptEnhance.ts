// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useState } from "react";

import {
  fetchFreezoneTextEnhanceResult,
  submitFreezoneTextEnhance,
  type FreezonePromptDialect,
  type FreezonePromptStrength,
} from "@/api/ops";
import { awaitTaskCompletion } from "@/api/tasks";
import { readUrl } from "@/lib/url-params";

/** 图片生成 / 图片编辑节点可选的方言。 */
export const IMAGE_PROMPT_DIALECTS: FreezonePromptDialect[] = ["image"];

/**
 * 音乐节点的可选方言。
 *
 * 只有 `audioKind === 'music'` 的输入框能接——语音档里填的是要合成的台词正文，
 * 强化它等于改掉人物说的话，不是优化提示词。
 */
export const AUDIO_PROMPT_DIALECTS: FreezonePromptDialect[] = ["audio-music"];

/** 视频节点可选的方言。通用档给目标模型没有方言表的场景兜底。 */
export const VIDEO_PROMPT_DIALECTS: FreezonePromptDialect[] = [
  "video-generic",
  "seedance-2.0",
  "seedance-2.5",
  "minimax-h3",
  "agnes-2.5",
];

/**
 * 从视频模型 id 推默认方言。
 *
 * 只用于预选，最终仍由创作者在弹窗里确认——模型目录里同一个家族常同时挂着
 * 多个版本，id 里认不出 2.0 / 2.5 时退回 2.0，而不是猜一个更高的版本。
 * 完全认不出的模型退回通用档：通用档不会把执行端读不懂的语法写进正文。
 */
export function dialectForVideoModel(
  modelId: string | null | undefined,
): FreezonePromptDialect {
  const value = String(modelId ?? "").toLowerCase();
  if (value.includes("agnes")) return "agnes-2.5";
  if (value.includes("minimax") || value.includes("hailuo")) return "minimax-h3";
  if (value.includes("seedance")) {
    return value.includes("2.5") ? "seedance-2.5" : "seedance-2.0";
  }
  return "video-generic";
}

/**
 * 「强化提示词」的共享流程：提交 → 等任务 → 取结果 → 回填。
 *
 * 抽成 hook 是因为画布上多个节点都要这一个动作，而它自带三段异步状态
 * （弹窗开合、请求中、结果回填）；逐节点复制会把同一套 pending 与错误处理
 * 抄上六遍。
 */
export function usePromptEnhance(
  nodeId: string,
  onEnhanced: (text: string) => void,
) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (
      text: string,
      dialect: FreezonePromptDialect,
      strength: FreezonePromptStrength,
    ) => {
      const trimmed = text.trim();
      const projectId = readUrl().project;
      if (!trimmed || !projectId) {
        setOpen(false);
        return;
      }
      setBusy(true);
      try {
        const ref = await submitFreezoneTextEnhance(projectId, {
          text: trimmed,
          dialect,
          strength,
          canvasId: readUrl().canvas ?? "default",
          nodeId,
        });
        await awaitTaskCompletion(ref.task_key, projectId, {
          taskType: ref.task_type,
        });
        const result = await fetchFreezoneTextEnhanceResult(projectId, ref.job_id);
        if (result.enhanced_text) onEnhanced(result.enhanced_text);
      } catch (error) {
        console.error("[prompt-enhance] failed", error);
      } finally {
        setBusy(false);
        setOpen(false);
      }
    },
    [nodeId, onEnhanced],
  );

  return { open, setOpen, busy, run };
}
