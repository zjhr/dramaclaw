// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * MonoformDeskNode 的节点外壳与全屏弹窗行为。真实驱动已交付的组件与已交付的
 * directorDeskBridge（复用同一套 postMessage 桥），只替 React Flow 的 Handle 与
 * NodeHeader 两个展示件。
 *
 * 与 DirectorDeskNode 的关键差异（本测试重点守住）：
 *   - iframe 指向 /monoform-desk/ 且**不带** theme 参数（MONOFORM 不读它）；
 *   - ready 之后宿主**只发 capabilities.get**，不发 session（MONOFORM 自己按
 *     instanceId 存本地 localStorage，宿主不做 freezone 工程快照回灌）。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirectorDeskNodeData } from "@/features/canvas/domain/canvasNodes";
import {
  MonoformDeskNode,
  MONOFORM_DESK_NODE_HEIGHT,
  MONOFORM_DESK_NODE_WIDTH,
  MONOFORM_DESK_READY_TIMEOUT_MS,
  monoformDeskIframeSrc,
} from "@/features/canvas/nodes/MonoformDeskNode";
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

const NODE_ID = "node_monoform_desk_1";

function defaultData(overrides: Partial<DirectorDeskNodeData> = {}): DirectorDeskNodeData {
  return {
    displayName: "MONOFORM 白模台",
    isOpen: false,
    directorProjectRef: null,
    videoUrl: null,
    previewImageUrl: null,
    ...overrides,
  };
}

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
      <MonoformDeskNode
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

function emitFromDesk(data: unknown) {
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

function installFrameRecorder(frames: unknown[]) {
  const contentWindow = iframeEl()?.contentWindow;
  if (!contentWindow) throw new Error("no iframe content window");
  const originalPost = contentWindow.postMessage.bind(contentWindow);
  (contentWindow as unknown as { postMessage: unknown }).postMessage = (message: unknown) => {
    frames.push(message);
    return originalPost(message as never, "*");
  };
}

function requestFrames(frames: unknown[], action: string) {
  return frames.filter((f) => {
    const candidate = f as { type?: string; payload?: { action?: string } };
    return candidate.type === DIRECTOR_DESK_MESSAGE_TYPES.request && candidate.payload?.action === action;
  }) as Array<{ type: string; payload: { requestId: string; action: string } }>;
}

function sessionFrames(frames: unknown[]) {
  return frames.filter((f) => (f as { type?: string }).type === DIRECTOR_DESK_MESSAGE_TYPES.session);
}

beforeEach(() => {
  useCanvasStore.setState({ nodes: [], edges: [], selectedNodeId: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("monoformDeskIframeSrc", () => {
  it("指向 /monoform-desk/ 且带 nodeId 作为 instanceId", () => {
    const src = monoformDeskIframeSrc("node_abc");
    expect(src.startsWith("/monoform-desk/?")).toBe(true);
    const params = new URLSearchParams(src.split("?")[1]);
    expect(params.get("instanceId")).toBe("node_abc");
    // MONOFORM 不读 theme，故不传（与 directorDesk 的关键差异）。
    expect(params.get("theme")).toBeNull();
    expect(params.get("hostOrigin")).toBeNull();
  });

  it("对 nodeId 做 URL 编码", () => {
    const params = new URLSearchParams(monoformDeskIframeSrc("a b&c").split("?")[1]);
    expect(params.get("instanceId")).toBe("a b&c");
  });
});

describe("MonoformDeskNode 节点壳与惰性 iframe", () => {
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

describe("MonoformDeskNode 握手（只探能力，不做工程回灌）", () => {
  it("ready → 只发 capabilities.get，绝不发 session", async () => {
    const user = userEvent.setup();
    renderNode();
    await user.click(screen.getByRole("button", { name: /打开|Open|Mở/ }));
    await waitFor(() => expect(iframeEl()).not.toBeNull());

    const frames: unknown[] = [];
    installFrameRecorder(frames);

    emitFromDesk({ type: DIRECTOR_DESK_MESSAGE_TYPES.ready });

    await waitFor(() => expect(requestFrames(frames, "capabilities.get").length).toBe(1));
    // MONOFORM 自己按 instanceId 存本地，宿主不做快照回灌 → 没有 session 帧。
    expect(sessionFrames(frames)).toEqual([]);

    const request = requestFrames(frames, "capabilities.get")[0];
    emitFromDesk({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: {
        protocolVersion: 1,
        requestId: request.payload.requestId,
        action: "capabilities.get",
        ok: true,
        data: {
          protocolVersion: 1,
          projectSchemaVersion: 16,
          actions: ["capabilities.get", "project.get"],
          assetPersistence: "localStorage",
        },
      },
    });

    // 连上后顶栏显示已连接态（协议版本）。
    await waitFor(() => expect(screen.getAllByText(/已连接|connected|Đã kết nối/i).length).toBeGreaterThan(0));
  });

  it("ready 超时后给出可读错误态与重试入口", async () => {
    vi.useFakeTimers();
    renderNode();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /打开|Open|Mở/ }));
    });
    expect(iframeEl()).not.toBeNull();
    expect(screen.queryByRole("button", { name: /重试|Retry|Thử lại/ })).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MONOFORM_DESK_READY_TIMEOUT_MS + 1000);
    });

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
      await vi.advanceTimersByTimeAsync(MONOFORM_DESK_READY_TIMEOUT_MS + 1000);
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /重试|Retry|Thử lại/ }));
    });

    expect(iframeEl()).not.toBe(firstIframe);
    expect(screen.queryByRole("button", { name: /重试|Retry|Thử lại/ })).toBeNull();
  });
});

describe("MonoformDeskNode 键盘独占", () => {
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
});

describe("MonoformDeskNode 常量", () => {
  it("紧凑壳尺寸与 LOD 兜底表一致", () => {
    expect({ width: MONOFORM_DESK_NODE_WIDTH, height: MONOFORM_DESK_NODE_HEIGHT }).toEqual({
      width: 340,
      height: 210,
    });
  });
});
