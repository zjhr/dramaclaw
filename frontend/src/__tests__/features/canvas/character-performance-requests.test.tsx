import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  appendPerformancePrompts,
  buildImagePerformancePrompt,
  buildVideoPerformancePrompt,
  NEUTRAL_CHARACTER_PERFORMANCE,
} from "@/features/canvas/domain/characterPerformance";

const imageNodeSource = readFileSync("src/features/canvas/nodes/ImageGenNode.tsx", "utf8");
const videoNodeSource = readFileSync("src/features/canvas/nodes/VideoNode.tsx", "utf8");

describe("character performance request prompts", () => {
  it("adds only explicitly selected identities in their selection order", () => {
    const result = appendPerformancePrompts("base", [
      { characterName: "Lin", identityId: "lin-a" },
      { characterName: "Bo", identityId: "bo-b" },
    ], {
      "lin-a": { ...NEUTRAL_CHARACTER_PERFORMANCE, mouth: 0.8 },
      "unselected": { ...NEUTRAL_CHARACTER_PERFORMANCE, brows: -1 },
    });
    expect(result).toContain("base");
    expect(result).toContain("Lin: Current performance:");
    expect(result).not.toContain("Bo:");
    expect(result).not.toContain("unselected");
  });

  it("leaves legacy prompts untouched when no bound performance exists", () => {
    expect(appendPerformancePrompts("base", [{ characterName: "Lin", identityId: "lin-a" }], undefined)).toBe("base");
  });

  it("appends each identity timeline in timestamp order without changing identity order", () => {
    const result = buildVideoPerformancePrompt("base", [
      { characterName: "Lin", identityId: "lin-a" },
      { characterName: "Bo", identityId: "bo-b" },
    ], {
      "lin-a": { ...NEUTRAL_CHARACTER_PERFORMANCE, mouth: -0.8 },
      "bo-b": NEUTRAL_CHARACTER_PERFORMANCE,
    }, {
      "lin-a": [
        { timeMs: 2000, performance: { ...NEUTRAL_CHARACTER_PERFORMANCE, mouth: 0.8 } },
        { timeMs: 500, performance: { ...NEUTRAL_CHARACTER_PERFORMANCE, mouth: -0.8 } },
      ],
      "bo-b": [
        { timeMs: 1000, performance: { ...NEUTRAL_CHARACTER_PERFORMANCE, eyes: 0.9 } },
      ],
    });
    expect(result.indexOf("Lin at 0.5s:")).toBeLessThan(result.indexOf("Lin at 2s:"));
    expect(result.indexOf("Lin at 2s:")).toBeLessThan(result.indexOf("Bo at 1s:"));
    expect(result.match(/Current performance:/g)).toHaveLength(3);
  });

  it("uses only the selected shot identity for the image request prompt", () => {
    const prompt = buildImagePerformancePrompt(
      "portrait",
      { characterName: "Bo", identityId: "bo-b" },
      {
        "lin-a": { ...NEUTRAL_CHARACTER_PERFORMANCE, mouth: 0.8 },
        "bo-b": { ...NEUTRAL_CHARACTER_PERFORMANCE, mouth: -0.8 },
      },
    );
    expect(prompt).toContain("portrait");
    expect(prompt).toContain("Bo: Current performance:");
    expect(prompt).toContain("downturned mouth");
    expect(prompt).not.toContain("Lin:");
    expect(prompt).not.toContain("smiling mouth");
  });

  it("connects image shot/identity selection to the prompt passed in the actual generation payload", () => {
    expect(imageNodeSource).toContain("buildImagePerformancePrompt(");
    expect(imageNodeSource).toContain("selectedPerformanceIdentity,");
    expect(imageNodeSource).toContain("performanceShot?.data.performances,");
    expect(imageNodeSource).toContain("prompt: requestPrompt,");
    expect(imageNodeSource).toContain("submitFreezoneGen(projectId, {");
    expect(imageNodeSource).toContain("...genPayload,");
  });

  it("connects selected video identities and their ordered timelines to submitted prompts", () => {
    expect(videoNodeSource).toContain("buildVideoPerformancePrompt(");
    expect(videoNodeSource).toContain("identityCalls,");
    expect(videoNodeSource).toContain("data.performances,");
    expect(videoNodeSource).toContain("data.performanceTimelines,");
    expect(videoNodeSource).toContain("prompt: composedPrompt,");
  });
});
