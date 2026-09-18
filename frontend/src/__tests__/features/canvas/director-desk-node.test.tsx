// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * DirectorDeskNode 的节点外壳与全屏弹窗行为。真实驱动已交付的组件与已交付的
 * directorDeskBridge（只替 React Flow 的 Handle 与 NodeHeader 两个展示件）。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirectorDeskNodeData } from "@/features/canvas/domain/canvasNodes";
import {
  DirectorDeskNode,
  DIRECTOR_DESK_NODE_HEIGHT,
  DIRECTOR_DESK_NODE_WIDTH,
  DIRECTOR_DESK_READY_TIMEOUT_MS,
  directorDeskIframeSrc,
  directorDeskSupports,
  summarizeDirectorDeskProject,
} from "@/features/canvas/nodes/DirectorDeskNode";
import { DIRECTOR_DESK_MESSAGE_TYPES } from "@/features/canvas/nodes/directorDeskBridge";
import { isImmersiveViewerActive } from "@/features/viewer-kit/useViewerImmersiveBody";
import { useCanvasStore } from "@/stores/canvasStore";

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    ...actual,
    Handle: ({ id, type }: { id?: string; type?: string }) => (
      <div data-testid={`handle-${type ?? "unknown"}-${id ?? "default"}`} />
    ),
  };
});

vi.mock("@/features/canvas/ui/NodeHeader", () => ({
  NODE_HEADER_FLOATING_POSITION_CLASS: "",
  NodeHeader: ({ titleText }: { titleText: string }) => <div data-testid="node-title">{titleText}</div>,
}));

const NODE_ID = "node_director_desk_1";

function defaultData(overrides: Partial<DirectorDeskNodeData> = {}): DirectorDeskNodeData {
  return {
    displayName: "3D 导演台",
    isOpen: false,
    directorProjectRef: null,
    videoUrl: null,
    previewImageUrl: null,
    ...overrides,
  };
}

/**
 * 把节点塞进真实 canvasStore，并让 updateNodeData 生效后再渲染 —— 弹窗开关走的是
 * store 里的 `data.isOpen`，所以断言必须打在这条真实写入路径上。
 */
function renderNode(dataOverrides: Partial<DirectorDeskNodeData> = {}) {
  useCanvasStore.setState({
    nodes: [
      {
        id: NODE_ID,
        type: "directorDeskNode",
        position: { x: 0, y: 0 },
        data: defaultData(dataOverrides),
      },
    ],
    edges: [],
    selectedNodeId: null,
  });

  const Harness = () => {
    const node = useCanvasStore((state) => state.nodes[0]);
    return (
      <DirectorDeskNode
        id={NODE_ID}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {...({ type: "directorDeskNode", dragging: false, zIndex: 0 } as any)}
        data={node.data as DirectorDeskNodeData}
        selected={false}
      />
    );
  };

  return render(<Harness />);
}

function storedData(): DirectorDeskNodeData {
  return useCanvasStore.getState().nodes[0].data as DirectorDeskNodeData;
}

function iframeEl(): HTMLIFrameElement | null {
  return document.querySelector("iframe");
}

/** 从宿主方向投一条真实 MessageEvent，source 指向当前 iframe。 */
function emitFromDirector(data: unknown) {
  const iframe = iframeEl();
  if (!iframe?.contentWindow) throw new Error("no iframe mounted");
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data,
        origin: window.location.origin,
        source: iframe.contentWindow as unknown as MessageEventSource,
      }),
    );
  });
}

/** 记录宿主 → 导演台的帧。 */
function installFrameRecorder(frames: unknown[]) {
  const contentWindow = iframeEl()?.contentWindow;
  if (!contentWindow) throw new Error("no iframe content window");
  const originalPost = contentWindow.postMessage.bind(contentWindow);
  (contentWindow as unknown as { postMessage: unknown }).postMessage = (message: unknown) => {
    frames.push(message);
    return originalPost(message as never, "*");
  };
}

/** 按 action 找宿主发出的 request 帧（`ready` 之后还会有一条 `session`，不能按下标取）。 */
function requestFrame(frames: unknown[], action: string): { type: string; payload: { requestId: string; action: string; options?: Record<string, unknown> } } {
  const frame = frames.find((f) => {
    const candidate = f as { type?: string; payload?: { action?: string } };
    return candidate.type === DIRECTOR_DESK_MESSAGE_TYPES.request && candidate.payload?.action === action;
  });
  if (!frame) throw new Error(`no request frame for ${action}; got ${JSON.stringify(frames)}`);
  return frame as { type: string; payload: { requestId: string; action: string; options?: Record<string, unknown> } };
}

/** 宿主发出的 `session` 帧（工程回灌动作）。 */
function sessionFrames(frames: unknown[]): Array<{ instanceId?: string; theme?: string }> {
  return frames
    .filter((f) => (f as { type?: string }).type === DIRECTOR_DESK_MESSAGE_TYPES.session)
    .map((f) => ((f as { payload?: { instanceId?: string; theme?: string } }).payload ?? {}));
}

const CAPABILITIES = {
  protocolVersion: 1,
  projectSchemaVersion: 1,
  actions: ["capabilities.get", "project.get", "timeline.get", "export.video"],
  uiExports: ["project-json", "reference-video", "viewport-still"],
  protocolExports: ["clean-frame", "reference-video"],
  assetPersistence: "browser-local-references",
};

beforeEach(() => {
  useCanvasStore.setState({ nodes: [], edges: [], selectedNodeId: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("directorDeskIframeSrc", () => {
  it("指向 /director-desk/ 且带 nodeId 作为 instanceId", () => {
    const src = directorDeskIframeSrc("node_abc");
    expect(src.startsWith("/director-desk/?")).toBe(true);
    const params = new URLSearchParams(src.split("?")[1]);
    expect(params.get("instanceId")).toBe("node_abc");
    expect(params.get("theme")).toBe("dark");
    // 同源子路径部署：不引入 hostOrigin 跨 origin 复杂度。
    expect(params.get("hostOrigin")).toBeNull();
  });

  it("对 nodeId 做 URL 编码", () => {
    const params = new URLSearchParams(directorDeskIframeSrc("a b&c").split("?")[1]);
    expect(params.get("instanceId")).toBe("a b&c");
  });
});

describe("directorDeskSupports", () => {
  it("只放行导演台自己声明了的 action", () => {
    expect(directorDeskSupports(CAPABILITIES, "export.video")).toBe(true);
    expect(directorDeskSupports(CAPABILITIES, "export.frame")).toBe(false);
    expect(directorDeskSupports(null, "export.video")).toBe(false);
  });
});

describe("summarizeDirectorDeskProject", () => {
  it("取出指纹与实体计数", () => {
    expect(
      summarizeDirectorDeskProject({
        projectFingerprint: "fnv1a32-1234abcd",
        project: { objects: [{}, {}], cameras: [{}] },
      }),
    ).toEqual({ fingerprint: "fnv1a32-1234abcd", objects: 2, cameras: 1 });
  });

  it("形状不对时返回 null 而不是抛", () => {
    expect(summarizeDirectorDeskProject(null)).toBeNull();
    expect(summarizeDirectorDeskProject({})).toBeNull();
  });
});

describe("DirectorDeskNode 节点壳与惰性 iframe", () => {
  it("未打开时节点壳渲染，且**不**挂载 iframe", () => {
    renderNode();
    expect(screen.getByTestId("node-title")).toBeTruthy();
    expect(iframeEl()).toBeNull();
    expect(isImmersiveViewerActive()).toBe(false);
  });

  it("点打开按钮写入 data.isOpen，并挂载 src 带 instanceId 的 iframe", async () => {
    const user = userEvent.setup();
    renderNode();

    await user.click(screen.getByRole("button", { name: /打开|Open|Mở/ }));

    await waitFor(() => expect(storedData().isOpen).toBe(true));
    const iframe = iframeEl();
    expect(iframe).not.toBeNull();
    const params = new URLSearchParams((iframe?.getAttribute("src") ?? "").split("?")[1]);
    expect(params.get("instanceId")).toBe(NODE_ID);
    expect(iframe?.getAttribute("allow")).toBe("pointer-lock");
  });

  it("关闭弹窗卸载 iframe 并从 data.isOpen 收回", async () => {
    const user = userEvent.setup();
    renderNode({ isOpen: false });
    await user.click(screen.getByRole("button", { name: /打开|Open|Mở/ }));
    await waitFor(() => expect(iframeEl()).not.toBeNull());

    const closeButtons = screen.getAllByRole("button", { name: /关闭|Close|Đóng/ });
    await user.click(closeButtons[closeButtons.length - 1]);

    await waitFor(() => expect(iframeEl()).toBeNull());
    expect(storedData().isOpen).toBe(false);
  });

  it("存档画布里残留的 isOpen=true 不会在挂载时自拉起 3D 引擎", async () => {
    renderNode({ isOpen: true });
    await waitFor(() => expect(storedData().isOpen).toBe(false));
    expect(iframeEl()).toBeNull();
  });
});

describe("DirectorDeskNode 握手与能力", () => {
  it("ready → capabilities.get → 按 actions 渲染受控按钮", async () => {
    const user = userEvent.setup();
    renderNode();
    await user.click(screen.getByRole("button", { name: /打开|Open|Mở/ }));
    await waitFor(() => expect(iframeEl()).not.toBeNull());

    const frames: unknown[] = [];
    installFrameRecorder(frames);

    emitFromDirector({ type: DIRECTOR_DESK_MESSAGE_TYPES.ready });

    // ready 之后宿主会发两条：capabilities.get（能力探测）与 session（工程回灌）。
    await waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(2));
    const request = requestFrame(frames, "capabilities.get");
    // 回灌动作必须带上本节点的 instanceId，否则导演台会激活到别的工程上。
    expect(sessionFrames(frames)).toEqual([{ instanceId: NODE_ID, theme: "dark" }]);

    emitFromDirector({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: {
        protocolVersion: 1,
        requestId: request.payload.requestId,
        action: "capabilities.get",
        ok: true,
        data: CAPABILITIES,
      },
    });

    // 声明了 project.get → 「读取工程」按钮出现，并在点击后走真实 project.get 往返。
    const readButton = await screen.findByRole("button", { name: /读取工程|Read project|Đọc dự án/ });
    expect(screen.getByText(/可用接口 4 个|4 interfaces available|4 giao diện/)).toBeTruthy();

    await user.click(readButton);
    await waitFor(() => expect(requestFrame(frames, "project.get")).toBeTruthy());
    const projectRequest = requestFrame(frames, "project.get");

    emitFromDirector({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: {
        protocolVersion: 1,
        requestId: projectRequest.payload.requestId,
        action: "project.get",
        ok: true,
        data: {
          projectFingerprint: "fnv1a32-deadbeef",
          project: { objects: [{}, {}, {}], cameras: [{}] },
        },
      },
    });

    await waitFor(() =>
      expect(
        screen.getByText(/fnv1a32-deadbeef/),
      ).toBeTruthy(),
    );
  });

  it("导演台没声明 project.get 时该按钮不出现（能力由 actions 决定）", async () => {
    const user = userEvent.setup();
    renderNode();
    await user.click(screen.getByRole("button", { name: /打开|Open|Mở/ }));
    await waitFor(() => expect(iframeEl()).not.toBeNull());

    const frames: unknown[] = [];
    installFrameRecorder(frames);

    emitFromDirector({ type: DIRECTOR_DESK_MESSAGE_TYPES.ready });
    await waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(1));
    const { requestId } = requestFrame(frames, "capabilities.get").payload;

    emitFromDirector({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: {
        protocolVersion: 1,
        requestId,
        action: "capabilities.get",
        ok: true,
        data: { ...CAPABILITIES, actions: ["capabilities.get"] },
      },
    });

    await screen.findByText(/可用接口 1 个|1 interfaces available|1 giao diện/);
    expect(screen.queryByRole("button", { name: /读取工程|Read project|Đọc dự án/ })).toBeNull();
  });

  it("ready 超时后给出可读错误态与重试入口", async () => {
    // 桥的超时定时器在 iframe 挂载（回调 ref）时就创建了，所以假定时器必须在
    // 打开弹窗之前装好，否则 advanceTimersByTime 推的是另一个时钟。
    // 全程用 fireEvent + act（不依赖 waitFor），因为 waitFor 自己也要定时器，
    // 在假定时器下会互相卡住。
    vi.useFakeTimers();
    renderNode();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /打开|Open|Mở/ }));
    });
    expect(iframeEl()).not.toBeNull();
    expect(screen.queryByRole("button", { name: /重试|Retry|Thử lại/ })).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DIRECTOR_DESK_READY_TIMEOUT_MS + 1000);
    });

    expect(
      screen.getAllByText(/连接导演台失败|Could not reach|Không kết nối được/).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /重试|Retry|Thử lại/ })).toBeTruthy();
  });

  it("重试会重新挂载 iframe 重新握手", async () => {
    vi.useFakeTimers();
    renderNode();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /打开|Open|Mở/ }));
    });
    const firstIframe = iframeEl();
    expect(firstIframe).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DIRECTOR_DESK_READY_TIMEOUT_MS + 1000);
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /重试|Retry|Thử lại/ }));
    });

    // 换了 key → 旧 iframe 卸载、新 iframe 挂载，握手从头再来。
    expect(iframeEl()).not.toBe(firstIframe);
    expect(screen.queryByRole("button", { name: /重试|Retry|Thử lại/ })).toBeNull();
  });
});

describe("DirectorDeskNode 键盘独占", () => {
  it("弹窗打开期间沉浸式标志置位，关闭后归还", async () => {
    const user = userEvent.setup();
    renderNode();
    expect(isImmersiveViewerActive()).toBe(false);

    await user.click(screen.getByRole("button", { name: /打开|Open|Mở/ }));
    await waitFor(() => expect(isImmersiveViewerActive()).toBe(true));
    expect(document.body).toHaveClass("st-viewer-immersive-active");

    const closeButtons = screen.getAllByRole("button", { name: /关闭|Close|Đóng/ });
    await user.click(closeButtons[closeButtons.length - 1]);
    await waitFor(() => expect(isImmersiveViewerActive()).toBe(false));
    expect(document.body).not.toHaveClass("st-viewer-immersive-active");
  });

  it("弹窗打开期间 WASD 与画布快捷键都不会改变画布视图状态", async () => {
    const user = userEvent.setup();
    renderNode();
    await user.click(screen.getByRole("button", { name: /打开|Open|Mở/ }));
    await waitFor(() => expect(isImmersiveViewerActive()).toBe(true));

    // 画布视角/最小化钉住是 canvasStore 之外的状态，这里用「不会被 takeover 影响」的
    // 事实断言：keydown 派发不发也不应改变 store 的 nodes/edges。
    const before = {
      nodes: useCanvasStore.getState().nodes.length,
      edges: useCanvasStore.getState().edges.length,
      selectedNodeId: useCanvasStore.getState().selectedNodeId,
    };
    for (const key of ["w", "a", "s", "d", "m", "Tab"]) {
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
        window.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
      });
    }
    const after = {
      nodes: useCanvasStore.getState().nodes.length,
      edges: useCanvasStore.getState().edges.length,
      selectedNodeId: useCanvasStore.getState().selectedNodeId,
    };
    expect(after).toEqual(before);
    // 弹窗仍然开着 —— 没有被快捷键意外关掉/删除。
    expect(storedData().isOpen).toBe(true);
  });
});

describe("DirectorDeskNode 常量", () => {
  it("紧凑壳尺寸与 LOD 兜底表一致", () => {
    expect({ width: DIRECTOR_DESK_NODE_WIDTH, height: DIRECTOR_DESK_NODE_HEIGHT }).toEqual({
      width: 340,
      height: 210,
    });
  });
});
