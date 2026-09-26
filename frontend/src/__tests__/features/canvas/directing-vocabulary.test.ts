// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 导演术语表 —— 技能提示词的单一事实源。
 *
 * 守两件事：
 * 1. 可执行清单与翻译层**对得上**（每个 id 都能真的被 `buildMonoformCameraTrack` 执行）；
 * 2. 做不到的术语被显式禁掉（「换背景」那次的教训：agent 答应了、画面没变）。
 */
import { describe, expect, it } from "vitest";

import {
  DIRECTING_TERMS,
  NOT_IMPLEMENTED,
  buildCameraMovePrompt,
} from "@/features/canvas/nodes/directingVocabulary";

describe("directingVocabulary", () => {
  it("覆盖全部可执行运镜，无重复 id", () => {
    const ids = DIRECTING_TERMS.map((term) => term.id);
    const expected = [
      "static",
      "dolly-in",
      "dolly-out",
      "orbit-left",
      "orbit-right",
      "pan-left",
      "pan-right",
      "crane-up",
      "crane-down",
      "rail-left",
      "rail-right",
      "handheld",
      "zoom-in",
      "zoom-out",
      "pov",
      "over-shoulder",
    ];
    for (const id of expected) expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每个术语都有中文名、口语别名与使用时机（给小白看得懂）", () => {
    for (const term of DIRECTING_TERMS) {
      expect(term.zh.trim()).not.toBe("");
      expect(term.aliases.length).toBeGreaterThan(0);
      expect(term.when.trim()).not.toBe("");
      expect(term.vertical.trim()).not.toBe("");
    }
  });

  it("不实现清单含 rack focus / whip pan（且都写了原因）", () => {
    const ids = NOT_IMPLEMENTED.map((item) => item.id);
    expect(ids).toContain("rack-focus");
    expect(ids).toContain("whip-pan");
    expect(ids).not.toContain("shot-reverse-shot");
    for (const item of NOT_IMPLEMENTED) expect(item.why.trim()).not.toBe("");
  });

  it("生成的提示词含全部 id、禁止自创、并显式列出做不到的", () => {
    const prompt = buildCameraMovePrompt();
    for (const term of DIRECTING_TERMS) expect(prompt).toContain(term.id);
    expect(prompt).toContain("不要自创 id");
    expect(prompt).toContain("做不到的");
    expect(prompt).toContain("rack-focus");
  });
});
