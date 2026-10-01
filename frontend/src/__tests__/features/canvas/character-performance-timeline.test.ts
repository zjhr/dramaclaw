import { describe, expect, it } from "vitest";
import { NEUTRAL_CHARACTER_PERFORMANCE } from "@/features/canvas/domain/characterPerformance";
import {
  interpolateCharacterPerformance,
  normalizeCharacterPerformanceKeyframes,
  removeCharacterPerformanceKeyframe,
  upsertCharacterPerformanceKeyframe,
} from "@/features/canvas/domain/characterPerformanceTimeline";

describe("character performance timeline", () => {
  it("sorts frames and replaces the frame at the same timestamp", () => {
    const sorted = normalizeCharacterPerformanceKeyframes([
      { timeMs: 2000, performance: { ...NEUTRAL_CHARACTER_PERFORMANCE, mouth: 0.8 } },
      { timeMs: 1000, performance: { ...NEUTRAL_CHARACTER_PERFORMANCE, mouth: -0.8 } },
    ]);
    const replaced = upsertCharacterPerformanceKeyframe(sorted, 1000, {
      ...NEUTRAL_CHARACTER_PERFORMANCE,
      mouth: 0.2,
    });
    expect(replaced.map((frame) => frame.timeMs)).toEqual([1000, 2000]);
    expect(replaced[0].performance.mouth).toBe(0.2);
    expect(removeCharacterPerformanceKeyframe(replaced, 1000)).toHaveLength(1);
  });

  it("linearly interpolates values and falls back to legacy single-frame state", () => {
    const frames = [
      { timeMs: 0, performance: { ...NEUTRAL_CHARACTER_PERFORMANCE, mouth: -1 } },
      { timeMs: 2000, performance: { ...NEUTRAL_CHARACTER_PERFORMANCE, mouth: 1 } },
    ];
    expect(interpolateCharacterPerformance(frames, 1000, NEUTRAL_CHARACTER_PERFORMANCE).mouth).toBe(0);
    expect(interpolateCharacterPerformance([], 500, { ...NEUTRAL_CHARACTER_PERFORMANCE, eyes: 0.5 }).eyes).toBe(0.5);
  });
});
