// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React, { useSyncExternalStore } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const canvasStoreMock = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const actions = {
    setSelectedNode: vi.fn(),
    setActiveOverlayNodeId: vi.fn(),
    updateNodeSize: vi.fn(),
    deleteEdge: vi.fn(),
    addNode: vi.fn(),
    addEdge: vi.fn(),
  };
  let state: Record<string, unknown>;
  const updateNodeData = vi.fn(
    (_id: string, patch: Record<string, unknown>) => {
      state = {
        ...state,
        nodeData: { ...(state.nodeData as Record<string, unknown>), ...patch },
      };
      listeners.forEach((listener) => listener());
    },
  );
  const reset = (
    nodeData: Record<string, unknown>,
    nodes: Array<Record<string, unknown>> = [],
  ) => {
    state = {
      ...actions,
      updateNodeData,
      nodeData,
      nodes,
      edges: [],
      activeOverlayNodeId: null,
    };
    updateNodeData.mockClear();
  };
  reset({});
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset,
    updateNodeData,
  };
});

vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  NodeToolbar: ({ children }: { children?: React.ReactNode }) => children ?? null,
  NodeResizeControl: ({ children }: { children?: React.ReactNode }) =>
    children ?? null,
  Position: { Left: "left", Right: "right" },
  useUpdateNodeInternals: () => vi.fn(),
  // 节点按 transform[2] 决定主体图喂原图还是降采样副本；这里固定在缩放 1，
  // 即「不是在细看单张图」那一档。
  useStore: (
    selector: (state: {
      transform: [number, number, number];
      nodeLookup: Map<string, { internals: { z: number } }>;
    }) => unknown,
  ) => selector({ transform: [0, 0, 1], nodeLookup: new Map() }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === "node.performance.videoShotNumber") {
        return `Video shot ${String(values?.number ?? "")}`;
      }
      const message = key === "node.performance.imageBindingSelected"
        ? `Added: {{character}}'s emotion and facial state from “{{shot}}”.`
        : key;
      return Object.entries(values ?? {}).reduce(
        (text, [name, value]) => text.split(`{{${name}}}`).join(String(value)),
        message,
      );
    },
  }),
}));

vi.mock("@/stores/canvasStore", async () => {
  const ReactModule = await import("react");
  const useCanvasStore = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      ReactModule.useSyncExternalStore(canvasStoreMock.subscribe, () =>
        selector(canvasStoreMock.getState()),
      ),
    { getState: canvasStoreMock.getState },
  );
  return { useCanvasStore, useIsBoxSelecting: () => false };
});

vi.mock("@/features/canvas/hooks/useFreezoneImageModels", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/canvas/hooks/useFreezoneImageModels")
  >()),
  useFreezoneImageModels: () => ({
    models: [{ id: "test-model", apiModel: "test-model", label: "Test" }],
    isLoading: false,
    isFallback: false,
  }),
}));
vi.mock("@/features/canvas/hooks/useNodeGenerationHistory", () => ({
  useNodeGenerationHistory: () => ({
    records: [{ id: "history-1", status: "completed" }],
    isLoading: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("@/features/canvas/ui/NodeGenerationHistory", () => ({
  hasCompletedHistoryRecords: () => true,
  historyRecordOutputUrl: (record: { result?: { output_url?: string } }) =>
    record.result?.output_url ?? null,
  NodeGenerationHistory: ({
    onRestore,
  }: {
    onRestore: (record: unknown) => void;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        onClick: () =>
          onRestore({
            id: "history-1",
            status: "completed",
            result: { output_url: "https://example.test/restored.png" },
          }),
      },
      "restore history",
    ),
}));
vi.mock("@/features/canvas/hooks/useFreezoneCameraOptions", () => ({
  useFreezoneCameraOptions: () => ({ options: [] }),
}));
vi.mock("@/features/canvas/hooks/useFreezoneStyleTemplates", () => ({
  useFreezoneStyleTemplates: () => ({ templates: [] }),
}));
// 远端风格包要 QueryClient，这个用例没包 provider：给空数组，只验错误横幅。
vi.mock("@/features/canvas/hooks/useCookbookStyles", () => ({
  useCookbookStyles: () => [],
}));
vi.mock("@/features/canvas/application/useUpstreamGraph", () => ({
  useUpstreamContents: () => [],
  useUpstreamNodes: () => [],
}));
vi.mock("@/features/canvas/application/useNodeGenerationTaskState", () => ({
  useNodeGenerationTaskState: () => ({ isGenerating: false }),
}));
vi.mock("@/features/canvas/nodes/useReferenceMentionSync", () => ({
  useReferenceMentionSync: () => undefined,
}));
vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: () => ({ data: undefined, error: null }),
}));
vi.mock("@/lib/model-task-access", () => ({
  useModelTaskAccess: () => ({ blocked: false, denialReason: null, message: null }),
}));
vi.mock("@/features/canvas/nodes/shared/albumPendingTotals", () => ({
  setAlbumPendingTotal: vi.fn(),
  useAlbumPendingTotal: () => 0,
}));
vi.mock("@/features/canvas/ui/CanvasNodeImage", () => ({
  CanvasNodeImage: ({ src, alt }: { src: string; alt: string }) =>
    React.createElement("img", { src, alt }),
}));
vi.mock("@/features/canvas/ui/NodeHeader", () => ({
  NODE_HEADER_FLOATING_POSITION_CLASS: "",
  NodeHeader: () => null,
}));

import {
  GENERATION_ERROR_CLEARED_PATCH,
  buildImageGenerationSuccessPatch,
} from "@/features/canvas/application/generationTaskArbitration";
import { ImageGenNode } from "@/features/canvas/nodes/ImageGenNode";

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

/**
 * 抓出 `updateNodeData(<目标>, { ... })` 里那对花括号的完整内容（按嵌套配平，
 * 因为 slot_target / generationBatch 这些字段本身就是对象字面量）。
 * 目标写法各文件不同：节点自己用 `id`，编辑器浮层用 `nodeId` / `node.id`。
 */
function updateNodeDataPatches(source: string): string[] {
  const patches: string[] = [];
  const opener = /updateNodeData\(\s*[\w.]+\s*,\s*\{/g;
  let match = opener.exec(source);
  while (match !== null) {
    let depth = 0;
    let index = match.index + match[0].length - 1;
    for (; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    patches.push(source.slice(match.index + match[0].length, index));
    opener.lastIndex = index;
    match = opener.exec(source);
  }
  return patches;
}

/** 只管「装上一张新图」的写入；清空（`: null`）不会露出图，无所谓。 */
function installsImage(patch: string): boolean {
  return [
    ...patch.matchAll(
      /\b(?:imageUrl|previewImageUrl|referenceImageUrl)\s*:\s*([^\s,]+)/g,
    ),
  ].some((match) => match[1] !== "null");
}

function staleErrorOffenders(source: string): string[] {
  return updateNodeDataPatches(source).filter(
    (patch) =>
      installsImage(patch) &&
      !patch.includes("GENERATION_ERROR_CLEARED_PATCH") &&
      !patch.includes("buildImageGenerationSuccessPatch"),
  );
}

describe("stale generation-error banner", () => {
  it("keeps optional shot-performance binding collapsed until explicitly opened", () => {
    canvasStoreMock.reset(
      {
        displayName: "图片",
        model: "test-model",
        performanceShotNodeId: "video-1",
      },
      [
        {
          id: "video-1",
          type: "videoNode",
          data: {},
        },
      ],
    );

    function Harness() {
      const data = useSyncExternalStore(
        canvasStoreMock.subscribe,
        () => canvasStoreMock.getState().nodeData as Record<string, unknown>,
      );
      return React.createElement(ImageGenNode, {
        id: "image-1",
        data,
        selected: true,
        width: 580,
        height: 360,
        type: "imageGenNode",
        dragging: false,
        zIndex: 0,
        selectable: true,
        deletable: true,
        draggable: true,
        isConnectable: true,
        positionAbsoluteX: 0,
        positionAbsoluteY: 0,
      } as never);
    }

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => render(React.createElement(Harness))).not.toThrow();
      expect(canvasStoreMock.getState().nodes).toHaveLength(1);
      const bindingTitle = screen.getByText("node.performance.imageBindingTitle");
      const disclosure = bindingTitle.closest("details");
      expect(disclosure).not.toHaveAttribute("open");
      expect(screen.getByLabelText("node.performance.chooseReferencedCharacter")).not.toBeVisible();
      fireEvent.click(bindingTitle);
      expect(disclosure).toHaveAttribute("open");
      const selector = screen.getByLabelText("node.performance.chooseReferencedCharacter");
      expect(selector).toBeVisible();
      expect(selector).toBeDisabled();
      expect(screen.getByText("node.performance.noShotIdentities")).toBeInTheDocument();
      expect(screen.queryByLabelText("node.performance.controls.brows")).not.toBeInTheDocument();
      expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(
        /Maximum update depth exceeded|getSnapshot should be cached/i,
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("selects a character from shot groups and writes both IDs in one update", () => {
    canvasStoreMock.reset(
      { displayName: "静帧", model: "test-model" },
      [
        {
          id: "video-1",
          type: "videoNode",
          data: {
            displayName: "厨房争执",
            identityCalls: [{ characterName: "林夏", identityId: "identity-linxia" }],
          },
        },
        {
          id: "video-2",
          type: "videoNode",
          data: {
            identityCalls: [{ characterName: "阿景", identityId: "identity-ajing" }],
          },
        },
        {
          id: "video-3",
          type: "videoNode",
          data: {},
        },
      ],
    );

    function Harness() {
      const data = useSyncExternalStore(
        canvasStoreMock.subscribe,
        () => canvasStoreMock.getState().nodeData as Record<string, unknown>,
      );
      return React.createElement(ImageGenNode, {
        id: "image-1",
        data,
        selected: true,
        width: 580,
        height: 360,
        type: "imageGenNode",
        dragging: false,
        zIndex: 0,
        selectable: true,
        deletable: true,
        draggable: true,
        isConnectable: true,
        positionAbsoluteX: 0,
        positionAbsoluteY: 0,
      } as never);
    }

    render(React.createElement(Harness));
    fireEvent.click(screen.getByText("node.performance.imageBindingTitle"));
    const selectors = screen.getAllByLabelText("node.performance.chooseReferencedCharacter");
    expect(selectors).toHaveLength(1);
    const selector = selectors[0] as HTMLSelectElement;
    expect(selector).toHaveValue("");
    expect(screen.getByRole("group", { name: "厨房争执" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Video shot 2" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "林夏" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "阿景" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "node.performance.noCharactersInShot" })).toBeDisabled();
    expect(screen.queryByText("video-1")).not.toBeInTheDocument();
    expect(screen.queryByText("identity-ajing")).not.toBeInTheDocument();

    fireEvent.change(selector, {
      target: { value: JSON.stringify(["video-2", "identity-ajing"]) },
    });

    expect(canvasStoreMock.getState().nodeData).toMatchObject({
      performanceShotNodeId: "video-2",
      performanceIdentityId: "identity-ajing",
    });
    expect(canvasStoreMock.updateNodeData).toHaveBeenCalledTimes(1);
    expect(canvasStoreMock.updateNodeData).toHaveBeenLastCalledWith("image-1", {
      performanceShotNodeId: "video-2",
      performanceIdentityId: "identity-ajing",
    });
    expect(selector).toHaveValue(JSON.stringify(["video-2", "identity-ajing"]));
    const bindingSummary = screen.getByRole("status");
    expect(bindingSummary).toHaveTextContent("阿景");
    expect(bindingSummary).toHaveTextContent("Video shot 2");
    expect(bindingSummary).not.toHaveTextContent("identity-ajing");
    expect(bindingSummary).not.toHaveTextContent("video-2");
    expect(screen.getByText("node.performance.imageBindingEditElsewhere")).toBeInTheDocument();
    expect(screen.queryByLabelText("node.performance.controls.brows")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "node.performance.clearImageBinding" }));

    expect(canvasStoreMock.updateNodeData).toHaveBeenLastCalledWith("image-1", {
      performanceShotNodeId: null,
      performanceIdentityId: null,
    });
    expect(selector).toHaveValue("");
    expect(screen.queryByRole("status")).not.toHaveTextContent("阿景");
  });

  it("restores a saved shot and character binding in the grouped selector", () => {
    canvasStoreMock.reset(
      {
        displayName: "静帧",
        model: "test-model",
        performanceShotNodeId: "video-2",
        performanceIdentityId: "identity-ajing",
      },
      [
        { id: "video-1", type: "videoNode", data: { identityCalls: [{ characterName: "林夏", identityId: "identity-linxia" }] } },
        { id: "video-2", type: "videoNode", data: { identityCalls: [{ characterName: "阿景", identityId: "identity-ajing" }] } },
      ],
    );

    function Harness() {
      const data = useSyncExternalStore(
        canvasStoreMock.subscribe,
        () => canvasStoreMock.getState().nodeData as Record<string, unknown>,
      );
      return React.createElement(ImageGenNode, {
        id: "image-1",
        data,
        selected: true,
        width: 580,
        height: 360,
        type: "imageGenNode",
        dragging: false,
        zIndex: 0,
        selectable: true,
        deletable: true,
        draggable: true,
        isConnectable: true,
        positionAbsoluteX: 0,
        positionAbsoluteY: 0,
      } as never);
    }

    render(React.createElement(Harness));
    fireEvent.click(screen.getByText("node.performance.imageBindingTitle"));
    expect(screen.getByLabelText("node.performance.chooseReferencedCharacter")).toHaveValue(
      JSON.stringify(["video-2", "identity-ajing"]),
    );
    expect(screen.getByRole("status")).toHaveTextContent("阿景");
    expect(screen.getByRole("status")).toHaveTextContent("Video shot 2");
  });

  it("removes the rendered failure banner when a history image is restored", () => {
    canvasStoreMock.reset({
      displayName: "图片",
      imageUrl: "https://example.test/failed.png",
      previewImageUrl: "https://example.test/failed.png",
      generationError: "provider failed",
      generationErrorDetails: "provider details",
      generationErrorRequestId: "req-old",
      isGenerating: false,
      model: "test-model",
    });

    function Harness() {
      const data = useSyncExternalStore(
        canvasStoreMock.subscribe,
        () => canvasStoreMock.getState().nodeData as Record<string, unknown>,
      );
      return React.createElement(ImageGenNode, {
        id: "image-1",
        data,
        selected: true,
        width: 580,
        height: 360,
        type: "imageGenNode",
        dragging: false,
        zIndex: 0,
        selectable: true,
        deletable: true,
        draggable: true,
        isConnectable: true,
        positionAbsoluteX: 0,
        positionAbsoluteY: 0,
      } as never);
    }

    render(React.createElement(Harness));
    expect(screen.getByText("provider failed")).toBeInTheDocument();

    act(() =>
      fireEvent.click(screen.getByRole("button", { name: "restore history" })),
    );

    expect(screen.queryByText("provider failed")).not.toBeInTheDocument();
    expect(canvasStoreMock.updateNodeData).toHaveBeenCalledWith(
      "image-1",
      expect.objectContaining({
        imageUrl: "https://example.test/restored.png",
        generationError: null,
        generationErrorDetails: null,
        generationErrorRequestId: null,
      }),
    );
  });

  it("clears every field the failure overlay reads", () => {
    // 浮层读这三个字段（文案 / 详情 / 请求 ID），少清一个就会留下残影。
    expect(Object.keys(GENERATION_ERROR_CLEARED_PATCH).sort()).toEqual([
      "generationError",
      "generationErrorDetails",
      "generationErrorRequestId",
    ]);
    expect(Object.values(GENERATION_ERROR_CLEARED_PATCH)).toEqual([
      null,
      null,
      null,
    ]);
    expect(buildImageGenerationSuccessPatch("https://x/y.png")).toMatchObject(
      GENERATION_ERROR_CLEARED_PATCH,
    );
  });

  it("clears the failure state on every in-place image write in ImageGenNode", () => {
    const source = read("src/features/canvas/nodes/ImageGenNode.tsx");

    // 失败横幅是 absolute 盖在图上的，只要节点换了新图却没清错误字段，
    // 上一次的「生成失败」就会糊在新图上面。
    expect(source).toContain("{!isGenerating && generationError && (");

    expect(staleErrorOffenders(source)).toEqual([]);
  });

  // 四个编辑器浮层都会往节点上写一张新图。超分是唯一原地改写源节点的
  // （其余三个都 addNode 建新结果节点），所以只有它会真的留下上一轮的失败残影；
  // 另外三个一并纳入，是为了挡住「以后被改成原地写」时悄悄退化。
  it.each([
    "src/features/canvas/ui/UpscaleEditorOverlay.tsx",
    "src/features/canvas/ui/EraseOverlay.tsx",
    "src/features/canvas/ui/RedrawOverlay.tsx",
    "src/features/canvas/ui/OutpaintEditorOverlay.tsx",
  ])("clears the failure state on every image write in %s", (path) => {
    expect(staleErrorOffenders(read(path))).toEqual([]);
  });

  // 超分原地复用源节点，所以「开一轮新的」本身就得把上一轮的请求 ID 清掉，
  // 不能等回填成功——中途失败时横幅会挂着上一次的请求 ID。
  it("clears the previous failure when an in-place upscale starts", () => {
    const source = read("src/features/canvas/ui/UpscaleEditorOverlay.tsx");
    const startPatch = updateNodeDataPatches(source).find((patch) =>
      /isGenerating\s*:\s*true/.test(patch),
    );

    expect(startPatch).toBeDefined();
    expect(startPatch).toContain("GENERATION_ERROR_CLEARED_PATCH");
  });

  // 参考图排在显示优先级最后：已有生成图时它顶不到主体，失败信息仍然对得上那张
  // 旧图，不能一上传就清掉。
  it("only clears the banner on reference upload when nothing was generated yet", () => {
    const source = read("src/features/canvas/nodes/ImageGenNode.tsx");
    const uploadPatch = updateNodeDataPatches(source).find((patch) =>
      patch.includes("referenceImageUrl: result.url"),
    );

    expect(uploadPatch).toBeDefined();
    expect(uploadPatch).toContain(
      "hasGeneratedResult ? {} : GENERATION_ERROR_CLEARED_PATCH",
    );
  });

  it("clears the request id alongside the message in the Canvas job poller", () => {
    const source = read("src/features/canvas/Canvas.tsx");
    const successPatch = source.slice(
      source.indexOf("generationStoryboardMetadata: undefined,"),
      source.indexOf("generationDebugContext: undefined,"),
    );

    expect(successPatch).toContain("generationError: null,");
    expect(successPatch).toContain("generationErrorDetails: null,");
    expect(successPatch).toContain("generationErrorRequestId: null,");
  });

  it("invalidates late batch writes when a history image replaces the result", () => {
    const source = read("src/features/canvas/nodes/ImageGenNode.tsx");
    const restoreStart = source.indexOf(
      "const handleRestoreHistory = useCallback",
    );
    const restoreEnd = source.indexOf("// 生成结束（成功/失败）", restoreStart);
    const restoreHandler = source.slice(restoreStart, restoreEnd);
    const submitStart = source.indexOf("const handleSubmit = useCallback");
    const submitEnd = source.indexOf("// ===== Step B", submitStart);
    const submitHandler = source.slice(submitStart, submitEnd);

    expect(source).toContain("const generationAttemptRef = useRef(0)");
    expect(restoreHandler).toContain("generationAttemptRef.current += 1");
    expect(submitHandler).toContain(
      "generationAttemptRef.current === generationAttempt",
    );
    expect(
      submitHandler.match(/if \(!isCurrentGenerationAttempt\(\)\) return;/g),
    ).toHaveLength(3);
  });
});
