// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

// 「向后延长」面板在 jsdom 里跑真实 toolbar 代价很高（要 Canvas + ReactFlow +
// 任务轮询），沿用重拍那套做法：用源码契约断言锁住接线点。
describe("video continue toolbar contract", () => {
  const source = read("src/features/canvas/ui/NodeActionToolbar.tsx");
  const ops = read("src/api/ops.ts");

  it("takes a custom duration and validates it against the model bounds", () => {
    // 自定义时长 = 能直接输入秒数。输入框与滑杆写同一个 draft，秒数从 draft 推出来，
    // 否则三处各存一份值，改到一半会悄悄漂移。
    expect(source).toContain('data-testid="video-continue-duration-input"');
    expect(source).toContain('type="number"');
    expect(source).toContain("setContinueDurationDraft(event.target.value)");
    expect(source).toContain("const continueDurationValid =");
    expect(source).toContain("Number.isInteger(continueDurationNumber)");
    expect(source).toContain("continueMinSeconds");
    expect(source).toContain("continueMaxSeconds");
    // 越界时既不提交也不推荐，并报出该模型的真实上下限。
    expect(source).toContain("continueDurationOutOfRange");
    expect(source).toContain("if (!continueDurationValid) return;");
    const submitBlock = source.slice(
      source.indexOf("data-testid=\"video-continue-submit\"") - 700,
      source.indexOf("data-testid=\"video-continue-submit\""),
    );
    expect(submitBlock).toContain("!continueDurationValid");
  });

  it("offers a development direction and sends it with the suggestion", () => {
    expect(source).toContain("const CONTINUE_DIRECTION_OPTIONS");
    expect(source).toContain("setContinueDirection(option)");
    expect(source).toContain("continueDirectionLabel");
    expect(source).toContain("continueDirection.${option}");
    // 方向必须真的发出去，否则选了对推荐毫无影响。
    expect(source).toContain("direction: continueDirection");
    expect(source).toContain("submitFreezoneVideoContinueSuggestPrompt");
  });

  it("suggests from the whole video plus the tail anchor, not the reshoot range", () => {
    // 复用重拍推荐只会得到「这 0.2 秒里发生了什么」——那不是续写要的东西。
    expect(source).toContain("endSeconds: continueAnchor.end");
    expect(source).toContain("durationSeconds: continueDurationSeconds");
    const suggest = source.slice(
      source.indexOf("handleSuggestContinuePrompt = useCallback"),
      source.indexOf("handleSuggestContinuePrompt = useCallback") + 2400,
    );
    expect(suggest).not.toContain("submitFreezoneVideoReshootSuggestPrompt");
    expect(suggest).toContain("fetchFreezoneVideoContinueSuggestPromptResult");
  });

  it("expands the user's own idea into a detailed prompt", () => {
    // 「优化」是把框里那句想法展开成更细的描述，沿用重拍那套方言弹窗，回填同一框。
    expect(source).toContain('data-testid="video-continue-enhance"');
    expect(source).toContain("continuePromptEnhance");
    expect(source).toContain("<EnhancePromptDialog");
    expect(source).toContain("dialectForVideoModel(reshootModelId)");
    // 时长与方向要跟着进改写指令，否则扩写出来的段落和实际要生成的那段对不上。
    expect(source).toContain("continueEnhanceGuidance");
  });

  it("warns when the prompt no longer matches the chosen duration or direction", () => {
    expect(source).toContain("setContinuePromptSource(");
    expect(source).toContain("const continuePromptStale =");
    expect(source).toContain("continuePromptStale");
  });

  it("exposes the continue suggestion on its own endpoint and task type", () => {
    expect(ops).toContain("freezone/video/continue/suggest-prompt");
    expect(ops).toContain("freezone_video_continue_suggest_prompt");
    expect(ops).toContain("FreezoneVideoContinueDirection");
  });

  it("keeps the direction ids aligned with the backend catalog", () => {
    // 后端按 id 挑创作指令（continue_prompt.py 的 VIDEO_CONTINUE_DIRECTIONS），
    // 方向 id 对不上会 422。前端多一个 chip 就得同步后端表。
    const declared = ops.match(
      /export type FreezoneVideoContinueDirection =([\s\S]*?);/,
    );
    expect(declared).not.toBeNull();
    for (const id of [
      "auto",
      "plot",
      "emotion",
      "action",
      "camera",
      "environment",
      "dialogue",
      "ending",
    ]) {
      expect(declared?.[1]).toContain(`"${id}"`);
    }
    // 每个方向都要有中英文词条，否则界面上会直接显示原始 key。
    for (const id of [
      "auto",
      "plot",
      "emotion",
      "action",
      "camera",
      "environment",
      "dialogue",
      "ending",
    ]) {
      for (const language of ["zh", "en", "vi"]) {
        const locale = JSON.parse(
          read(`public/locales/${language}/translation.json`),
        );
        expect(
          locale.nodeToolbar.video.continueDirection[id],
          `${language} 缺 continueDirection.${id}`,
        ).toBeTruthy();
      }
    }
  });
});
