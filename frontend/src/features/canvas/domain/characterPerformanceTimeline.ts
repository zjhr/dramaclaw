import type {
  CharacterPerformance,
  CharacterPerformanceKeyframe,
} from "@/features/canvas/domain/canvasNodes";
import { normalizeCharacterPerformance } from "@/features/canvas/domain/characterPerformance";

/** 按时间整理帧，并让同一时间点最后写入的帧生效。 */
export function normalizeCharacterPerformanceKeyframes(value: unknown): CharacterPerformanceKeyframe[] {
  if (!Array.isArray(value)) return [];
  const byTime = new Map<number, CharacterPerformance>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const frame = entry as { timeMs?: unknown; performance?: unknown };
    const timeMs = Number(frame.timeMs);
    if (!Number.isFinite(timeMs) || timeMs < 0) continue;
    byTime.set(Math.round(timeMs), normalizeCharacterPerformance(frame.performance));
  }
  return [...byTime.entries()]
    .sort(([a], [b]) => a - b)
    .map(([timeMs, performance]) => ({ timeMs, performance }));
}

export function upsertCharacterPerformanceKeyframe(
  keyframes: unknown,
  timeMs: number,
  performance: CharacterPerformance,
): CharacterPerformanceKeyframe[] {
  if (!Number.isFinite(timeMs) || timeMs < 0) return normalizeCharacterPerformanceKeyframes(keyframes);
  return normalizeCharacterPerformanceKeyframes([
    ...normalizeCharacterPerformanceKeyframes(keyframes),
    { timeMs: Math.round(timeMs), performance },
  ]);
}

export function removeCharacterPerformanceKeyframe(
  keyframes: unknown,
  timeMs: number,
): CharacterPerformanceKeyframe[] {
  const target = Math.round(timeMs);
  return normalizeCharacterPerformanceKeyframes(keyframes).filter((frame) => frame.timeMs !== target);
}

/** 数值字段线性插值；非数值字段在区间中点稳定切换到后一个关键帧。 */
export function interpolateCharacterPerformance(
  keyframes: unknown,
  timeMs: number,
  fallback: unknown,
): CharacterPerformance {
  const frames = normalizeCharacterPerformanceKeyframes(keyframes);
  if (frames.length === 0) return normalizeCharacterPerformance(fallback);
  const time = Math.max(0, Number.isFinite(timeMs) ? timeMs : 0);
  if (time <= frames[0].timeMs) return frames[0].performance;
  const last = frames[frames.length - 1];
  if (time >= last.timeMs) return last.performance;
  const rightIndex = frames.findIndex((frame) => frame.timeMs >= time);
  const right = frames[rightIndex];
  const left = frames[rightIndex - 1];
  const ratio = (time - left.timeMs) / (right.timeMs - left.timeMs);
  const result = {} as CharacterPerformance;
  for (const field of Object.keys(left.performance) as Array<keyof CharacterPerformance>) {
    const from = left.performance[field];
    const to = right.performance[field];
    result[field] = typeof from === "number" && typeof to === "number"
      ? from + (to - from) * ratio
      : (ratio < 0.5 ? from : to) as number;
  }
  return normalizeCharacterPerformance(result);
}
