// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 阶段 5 的「参考视频识别」验收：把 3D 导演台节点（`data.videoUrl` 已回写）连到视频节点后，
 * 视频节点的 `referenceMedia` 里必须出现 `kind: "video"` 条目，并自动落到可用模式。
 *
 * 这里驱动的是**已交付的 VideoNode**（真实组件、真实参考素材装配、真实 genMode 状态机），
 * 只补 jsdom 缺的两个环境件（React Flow 的 provider、ResizeObserver）与展示壳（Handle）。
 * 断言落在视频 chip 的真实 DOM 上：只有 `kind === "video"` 的分支会渲染 <video>，
 * 也只有它会用上游节点的 `previewImageUrl` 当 chip 缩略图。
 */
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactFlowProvider } from "@xyflow/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { VideoNode } from "@/features/canvas/nodes/VideoNode";
import { useCanvasStore } from "@/stores/canvasStore";

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return { ...actual, Handle: () => <div data-testid="handle" /> };
});

beforeAll(() => {
  // jsdom 没有 ResizeObserver；NodeHeader 用它测标题溢出。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const DESK_ID = "desk_upstream_1";
const VIDEO_ID = "video_downstream_1";
const VIDEO_URL = "/static/proj_artifacts/director-desk-desk_upstream_1-video-1.mp4";
const POSTER_URL = "/static/proj_artifacts/director-desk-desk_upstream_1-poster-1.png";

function seedCanvas(deskData: Record<string, unknown>) {
  const desk = {
    id: DESK_ID,
    type: CANVAS_NODE_TYPES.directorDesk,
    position: { x: 0, y: 0 },
    data: { displayName: "3D 导演台", isOpen: false, directorProjectRef: null, ...deskData },
  } as unknown as CanvasNode;
  const video = {
    id: VIDEO_ID,
    type: CANVAS_NODE_TYPES.video,
    position: { x: 500, y: 0 },
    data: {},
  } as unknown as CanvasNode;
  const edge = {
    id: `${DESK_ID}-${VIDEO_ID}`,
    source: DESK_ID,
    target: VIDEO_ID,
    sourceHandle: "source",
    targetHandle: "target",
    type: "disconnectableEdge",
  } as CanvasEdge;

  useCanvasStore.setState({
    nodes: [desk, video],
    edges: [edge],
    selectedNodeId: VIDEO_ID,
  } as never);
}

function renderVideoNode() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ReactFlowProvider>
        <VideoNode
          id={VIDEO_ID}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {...({ type: CANVAS_NODE_TYPES.video, dragging: false, zIndex: 0 } as any)}
          data={{}}
          selected
        />
      </ReactFlowProvider>
    </QueryClientProvider>,
  );
}

function videoElements(): HTMLVideoElement[] {
  return Array.from(document.querySelectorAll("video"));
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("导演台节点作为视频节点的参考素材", () => {
  it("videoUrl 被识别为 kind:'video'：chip 用 <video> 承载上游视频地址", async () => {
    seedCanvas({ videoUrl: VIDEO_URL, previewImageUrl: null });
    renderVideoNode();

    await waitFor(() => {
      const srcs = videoElements().map((el) => el.getAttribute("src"));
      expect(srcs).toContain(VIDEO_URL);
    });
  });

  it("有封面时 chip 用封面图，alt 取上游节点标题（video 分支专属的缩略图路径）", async () => {
    seedCanvas({ videoUrl: VIDEO_URL, previewImageUrl: POSTER_URL });
    renderVideoNode();

    await waitFor(() => {
      const chip = Array.from(document.querySelectorAll("img")).find(
        (img) => img.getAttribute("src") === POSTER_URL,
      );
      expect(chip).toBeTruthy();
      expect(chip?.getAttribute("alt")).toBe("3D 导演台");
    });
    // 有封面就不再用 <video> 当缩略图（见 ReferenceVideoChip 的 thumb 分支）。
    expect(videoElements().map((el) => el.getAttribute("src"))).not.toContain(VIDEO_URL);
  });

  it("没有 videoUrl 时不产生视频参考条目（识别依据是 videoUrl，不是节点类型）", async () => {
    seedCanvas({ videoUrl: null, previewImageUrl: POSTER_URL });
    renderVideoNode();

    // 给足一拍让 effect 跑完
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(videoElements().map((el) => el.getAttribute("src"))).not.toContain(VIDEO_URL);
    const chip = Array.from(document.querySelectorAll("img")).find(
      (img) => img.getAttribute("src") === POSTER_URL,
    );
    expect(chip).toBeUndefined();
  });

  it("接入视频上游后视频节点自动落到可用模式（视频编辑 / 全能参考）", async () => {
    seedCanvas({ videoUrl: VIDEO_URL, previewImageUrl: null });
    renderVideoNode();

    await waitFor(() => {
      const video = useCanvasStore.getState().nodes.find((node) => node.id === VIDEO_ID);
      const genMode = (video?.data as { genMode?: string } | undefined)?.genMode;
      expect(["videoEdit", "allReference"]).toContain(genMode);
    });
  });

  it("文本上游不会被误判成参考视频", async () => {
    useCanvasStore.setState({
      nodes: [
        {
          id: "text_1",
          type: CANVAS_NODE_TYPES.textAnnotation,
          position: { x: 0, y: 0 },
          data: { content: "一只猫" },
        },
        { id: VIDEO_ID, type: CANVAS_NODE_TYPES.video, position: { x: 500, y: 0 }, data: {} },
      ] as never,
      edges: [
        {
          id: "t-v",
          source: "text_1",
          target: VIDEO_ID,
          sourceHandle: "source",
          targetHandle: "target",
          type: "disconnectableEdge",
        },
      ] as never,
      selectedNodeId: VIDEO_ID,
    } as never);

    renderVideoNode();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(videoElements()).toHaveLength(0);
  });
});
