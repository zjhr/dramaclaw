// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { dialectForVideoModel } from "@/features/canvas/nodes/usePromptEnhance";

describe("dialectForVideoModel", () => {
  it("maps each known family to its own dialect sheet", () => {
    expect(dialectForVideoModel("agnes-video-v2.5")).toBe("agnes-2.5");
    expect(dialectForVideoModel("MiniMax-H3")).toBe("minimax-h3");
    expect(dialectForVideoModel("hailuo-02")).toBe("minimax-h3");
    expect(dialectForVideoModel("seedance-2.5")).toBe("seedance-2.5");
  });

  it("falls back to 2.0 when the seedance version is unstated", () => {
    // 版本认不出时选低版本：套 2.5 的 30 秒时间戳语法到 2.0 上会生成
    // 执行端读不懂的正文，反向则只是少用了一段能力。
    expect(dialectForVideoModel("seedance-1.0-pro")).toBe("seedance-2.0");
  });

  it("falls back to the generic dialect for unknown or missing models", () => {
    expect(dialectForVideoModel("kling-v2")).toBe("video-generic");
    expect(dialectForVideoModel(null)).toBe("video-generic");
    expect(dialectForVideoModel(undefined)).toBe("video-generic");
    expect(dialectForVideoModel("")).toBe("video-generic");
  });
});
