// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

// 片段重拍的画布接线是「提交一次、派生两个下游节点」。这类跨 store/异步的
// 行为在 jsdom 里跑真实 toolbar 代价很高（要 Canvas + ReactFlow + 任务轮询），
// 用源码契约断言锁住关键接线点：入口 chip、双节点派生、溯源标记、错误兜底。
describe("video reshoot toolbar contract", () => {
  const source = read("src/features/canvas/ui/NodeActionToolbar.tsx");

  it("wires the reshoot entry chip to the timeline + submit", () => {
    expect(source).toContain('key="video-reshoot"');
    expect(source).toContain('t("nodeToolbar.video.reshoot")');
    expect(source).toContain("<VideoReshootTimeline");
    expect(source).toContain("void handleVideoReshoot();");
  });

  it("derives both the clip node and the full node from the source", () => {
    expect(source).toContain("handleVideoReshoot = useCallback");
    // 两个 addNode + 两条溯源边，缺一个就表现为「只有片段没有整片」。
    expect(source.match(/const (clipNodeId|fullNodeId) = addNode\(/g)).toHaveLength(2);
    expect(source).toContain("addEdge(node.id, clipNodeId);");
    expect(source).toContain("addEdge(node.id, fullNodeId);");
    // 溯源边靠这两个标记免素材上限校验（见 videoReferenceLimits.ts）。
    expect(source.match(/isReshootNode: true/g)).toHaveLength(2);
    expect(source).toContain("reshootSourceUrl: videoUrl");
  });

  it("fills both nodes from clip_url / output_url and fails loudly otherwise", () => {
    expect(source).toContain("result.clip_url");
    expect(source).toContain("result.output_url");
    expect(source).toContain('t("node.reshoot.noResult")');
    // 失败必须落到两个派生节点上，不能只落一个让另一个永久转圈。
    expect(source).toContain("for (const id of [clipNodeId, fullNodeId])");
  });

  it("keeps the loading flag on the source node across toolbar unmounts", () => {
    expect(source).toContain('updateNodeData(node.id, { isReshooting: true })');
    expect(source).toContain('updateNodeData(node.id, { isReshooting: false })');
  });

  it("gates submit on range validity, model duration bounds and in-flight state", () => {
    // 提交按钮的禁用条件必须同时在文案与 disabled 上生效，否则会发出
    // 后端必然拒的请求（或重复提交）。上下限都要拦：区间超 maxDuration 与
    // 短于 minDuration 时上游都直接 400。
    const submitAnchor = source.indexOf("nodeToolbar.video.reshootSubmit");
    const submitBlock = source.slice(submitAnchor - 1800, submitAnchor + 200);
    expect(submitBlock).toContain("reshootOverMaxDuration");
    expect(submitBlock).toContain("reshootUnderMinDuration");
    expect(submitBlock).toContain("reshootRangeUnknown");
    expect(source).toContain("reshootModelMaxDuration");
    // 时长上下限取自模型目录；目录没加载（isFallback）时不拦。
    expect(source).toContain("useFreezoneVideoModels(");
    expect(source).toContain("match?.maxDuration");
    expect(source).toContain("match?.minDuration");
  });

  it("disables the entry when the model has no first_last_frame mode", () => {
    // 首尾帧锚定是唯一生成路径：模型没声明这个模式就进不去，按钮置灰 +
    // tooltip 说清楚，别让用户发一次必然失败的请求。
    const entryAnchor = source.indexOf('key="video-reshoot"');
    const entryBlock = source.slice(entryAnchor, entryAnchor + 1200);
    expect(entryBlock).toContain("reshootModelUnsupported");
    expect(entryBlock).toContain(
      "if (!hasVideo || isReshooting || reshootModelUnsupported) {",
    );
    // 能力判定读目录的 supportedModes，找不到匹配项或没配这个字段都不拦
    // （后端有同一道校验兜底）。提成单个候选的判定函数，入口与选择器共用。
    expect(source).toContain("const reshootModelUnsupportedFor = useCallback");
    expect(source).toContain('modes.includes("first_last_frame")');
  });

  it("lets the reshoot panel pick a model and writes it back to the node", () => {
    // 同一节点上不能有两个模型状态源：面板里改模型必须写回 node.data，
    // 节点自己的选择器才会跟着变。
    const pickerAnchor = source.indexOf("nodeToolbar.video.reshootModelLabel");
    expect(pickerAnchor).toBeGreaterThan(0);
    const block = source.slice(pickerAnchor, pickerAnchor + 1200);
    expect(block).toContain("<ProviderModelPicker");
    expect(block).toContain("selectedModelId={reshootModelId}");
    expect(block).toContain("models={reshootModels.models}");
    expect(block).toContain('domain="video"');
    expect(block).toContain("reshootModelUnsupportedFor");
    expect(block).toContain("updateNodeData(node.id, { model: nextModelId })");
  });

  it("requires a non-empty prompt and offers the gallery as a shortcut", () => {
    // 上游 video/generations 强校验 prompt：空串必须在提交前就拦住，
    // 不能等任务打到上游才 400。同时给一个推荐入口，免得用户对着空框发呆。
    const promptAnchor = source.indexOf("reshootPromptPlaceholder");
    expect(promptAnchor).toBeGreaterThan(0);
    const block = source.slice(promptAnchor - 200, promptAnchor + 5200);
    // 多行文本域：推荐提示词动辄两三百字，单行 input 只能看到末尾
    expect(source).toContain("<textarea");
    expect(source).toContain("rows={3}");
    expect(source).toContain("resize-y");
    expect(block).toContain("reshootPrompt.trim().length === 0");
    expect(block).toContain("reshootPromptRequired");
    // 禁用条件里必须含 prompt 为空
    const submitAnchor = source.indexOf("nodeToolbar.video.reshootSubmit");
    const submitBlock = source.slice(submitAnchor - 1200, submitAnchor + 200);
    expect(submitBlock).toContain("reshootPrompt.trim().length === 0");
  });

  it("suggests a prompt from the keyframes instead of a static gallery", () => {
    // 推荐是让视觉模型看着区间首尾两帧 + 时长联想一段，不是从静态画廊里挑：
    // 挑出来的跟当前这段画面没关系。抽帧与重拍本体共用后端 helper。
    expect(source).toContain("handleSuggestReshootPrompt = useCallback");
    expect(source).toContain("submitFreezoneVideoReshootSuggestPrompt");
    expect(source).toContain("fetchFreezoneVideoReshootSuggestPromptResult");
    expect(source).toContain("setIsSuggestingPrompt");
    // 推荐只填输入框，不自动提交；失败不清空用户已写的内容
    expect(source).toContain("setReshootPrompt(trimmed)");
    // 与画廊那套彻底脱钩
    expect(source).not.toContain("PromptGalleryModal");
    // 注入旁边还有强化：复用节点上那套方言弹窗，结果回填同一个输入框。
    expect(source).toContain("reshootPromptEnhance");
    expect(source).toContain("<EnhancePromptDialog");
    expect(source).toContain("dialectForVideoModel(reshootModelId)");
    expect(source).toContain("nodeToolbar.video.reshootPromptEnhance");
  });
});
