import { describe, expect, it } from "vitest";
import {
  NEUTRAL_CHARACTER_PERFORMANCE,
  describeCharacterPerformance,
  normalizeCharacterPerformance,
} from "@/features/canvas/domain/characterPerformance";

describe("character performance state", () => {
  it("uses a neutral default for legacy or missing data", () => {
    expect(normalizeCharacterPerformance(undefined)).toEqual(NEUTRAL_CHARACTER_PERFORMANCE);
  });

  it("clamps malformed values and describes the selected controls", () => {
    expect(normalizeCharacterPerformance({ valence: 4, eyes: -2 })).toMatchObject({ valence: 1, eyes: -1 });
    expect(describeCharacterPerformance({ valence: 0.8, eyes: 0.7 })).toContain("positive affect");
    expect(describeCharacterPerformance({ valence: 0.8, eyes: 0.7 })).toContain("wide eyes");
  });
});
