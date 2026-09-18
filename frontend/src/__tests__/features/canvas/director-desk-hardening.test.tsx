// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 阶段 8 收口：边界态、惰性挂载、实例隔离、连点竞态、a11y 的 **DOM 断言**。
 *
 * 规格明确要求这些子项「一律换成 DOM/计数断言，不用『流畅』『不卡』这类描述」，
 * 所以这里断言的都是可数的东西：iframe 元素数量、`src` 里的 instanceId、可见文案、
 * `document.activeElement` 的归属。
 *
 * 注意所有查询都用 `findAllByRole` / `waitFor` 等待元素真的出现再操作 —— 用同步
 * `querySelectorAll` + `fireEvent` 会在对话框挂载完成前抢跑（测试自己变成 flaky）。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirectorDeskNodeData } from "@/features/canvas/domain/canvasNodes";
import {
  DirectorDeskNode,
  DIRECTOR_DESK_READY_TIMEOUT_MS,
} from "@/features/canvas/nodes/DirectorDeskNode";
import { DIRECTOR_DESK_MESSAGE_TYPES } from "@/features/canvas/nodes/directorDeskBridge";
import { isImmersiveViewerActive } from "@/features/viewer-kit/useViewerImmersiveBody";
import { useCanvasStore } from "@/stores/canvasStore";

vi.mock("@/api/ops", () => ({
  uploadFreezoneImage: vi.fn(),
  uploadFreezoneVideo: vi.fn(),
}));

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
  NodeHeader: ({ titleText }: { titleText: string }) => (
    <div data-testid="node-title">{titleText}</div>
  ),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const NODE_A = "hardening_desk_a";
const NODE_B = "hardening_desk_b";
const PROJECT_ID = "proj_hardening";

const OPEN_RE = /打开|Open|Mở/;
const CLOSE_RE = /关闭|Close|Đóng/;

function deskData(): DirectorDeskNodeData {
  return {
    displayName: "3D 导演台",
    isOpen: false,
    directorProjectRef: null,
    videoUrl: null,
    previewImageUrl: null,
  };
}

function seedCanvas(): void {
  useCanvasStore.setState({
    nodes: [
      { id: NODE_A, type: "directorDeskNode", position: { x: 0, y: 0 }, data: deskData() },
      { id: NODE_B, type: "directorDeskNode", position: { x: 700, y: 0 }, data: deskData() },
    ] as never,
    edges: [],
    selectedNodeId: null,
  } as never);
}

function Harness({ nodeId }: { nodeId: string }) {
  const node = useCanvasStore((state) => state.nodes.find((item) => item.id === nodeId));
  if (!node) return null;
  return (
    <DirectorDeskNode
      id={nodeId}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {...({ type: "directorDeskNode", dragging: false, zIndex: 0 } as any)}
      data={node.data as DirectorDeskNodeData}
      selected
    />
  );
}

function renderBoth() {
  return render(
    <>
      <Harness nodeId={NODE_A} />
      <Harness nodeId={NODE_B} />
    </>,
  );
}

function deskIframes(): HTMLIFrameElement[] {
  return Array.from(
    document.querySelectorAll<HTMLIFrameElement>('iframe[src^="/director-desk/"]'),
  );
}

function instanceIds(): string[] {
  return deskIframes().map(
    (frame) =>
      new URLSearchParams((frame.getAttribute("src") ?? "").split("?")[1]).get("instanceId") ?? "",
  );
}

function isOpen(nodeId: string): boolean {
  return useCanvasStore.getState().nodes.find((n) => n.id === nodeId)?.data.isOpen === true;
}

/** 点开第 index 个导演台节点的弹窗，并等到 iframe 真的挂上。 */
async function openDesk(index = 0): Promise<void> {
  const user = userEvent.setup();
  const buttons = await screen.findAllByRole("button", { name: OPEN_RE }, { timeout: 5000 });
  await user.click(buttons[index]);
  await waitFor(() => expect(deskIframes()).toHaveLength(1), { timeout: 5000 });
}

/** 点弹窗里的关闭，并等到 iframe 被卸载。 */
async function closeDesk(): Promise<void> {
  const user = userEvent.setup();
  const buttons = await screen.findAllByRole("button", { name: CLOSE_RE }, { timeout: 5000 });
  await user.click(buttons[buttons.length - 1]);
  await waitFor(() => expect(deskIframes()).toHaveLength(0), { timeout: 5000 });
}

beforeEach(() => {
  useCanvasStore.setState({ nodes: [], edges: [], selectedNodeId: null } as never);
  window.history.replaceState({}, "", `/projects/${PROJECT_ID}/freezone`);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.history.replaceState({}, "", "/");
});

describe("Perf — 惰性挂载", () => {
  it("两个节点都未打开时，DOM 里没有任何 director-desk iframe", () => {
    seedCanvas();
    renderBoth();
    expect(deskIframes()).toHaveLength(0);
    // 节点壳本身在，只是没有 iframe
    expect(screen.getAllByTestId("node-title")).toHaveLength(2);
  });

  it("只打开 A 时只有 A 的 iframe，B 仍为 0", async () => {
    seedCanvas();
    renderBoth();
    await openDesk(0);
    expect(deskIframes()).toHaveLength(1);
    expect(instanceIds()).toEqual([NODE_A]);
    expect(isOpen(NODE_B)).toBe(false);
  });
});

describe("Edges — 开关循环与连点竞态", () => {
  it("开/关 5 次后 iframe 数量回到 0（DOM 断言）", async () => {
    seedCanvas();
    renderBoth();
    for (let i = 0; i < 5; i += 1) {
      await openDesk(0);
      await closeDesk();
    }
    expect(deskIframes()).toHaveLength(0);
    expect(isImmersiveViewerActive()).toBe(false);
    expect(document.body).not.toHaveClass("st-viewer-immersive-active");
    expect(isOpen(NODE_A)).toBe(false);
  });

  it("连点打开 10 次后最多 1 个 iframe，且状态自洽", async () => {
    seedCanvas();
    renderBoth();
    const button = (await screen.findAllByRole("button", { name: OPEN_RE }))[0];
    act(() => {
      for (let i = 0; i < 10; i += 1) fireEvent.click(button);
    });
    await waitFor(() => expect(deskIframes()).toHaveLength(1), { timeout: 5000 });
    expect(new Set(instanceIds()).size).toBe(1);
    expect(instanceIds()).toEqual([NODE_A]);
    expect(isOpen(NODE_A)).toBe(true);
  });

  it("连点关闭 10 次不会留下残留 iframe", async () => {
    seedCanvas();
    renderBoth();
    await openDesk(0);
    const button = (await screen.findAllByRole("button", { name: CLOSE_RE })).pop();
    expect(button).toBeTruthy();
    act(() => {
      for (let i = 0; i < 10; i += 1) fireEvent.click(button!);
    });
    await waitFor(() => expect(deskIframes()).toHaveLength(0), { timeout: 5000 });
    expect(isOpen(NODE_A)).toBe(false);
    expect(isImmersiveViewerActive()).toBe(false);
  });

  it("关闭后重开回到同一个 instanceId（同一节点同一工程）", async () => {
    seedCanvas();
    renderBoth();
    await openDesk(0);
    const first = instanceIds()[0];
    await closeDesk();
    await openDesk(0);
    expect(instanceIds()[0]).toBe(first);
  });
});

describe("States — 加载态 / 错误态", () => {
  it("iframe 冷启动期间有可见加载指示", async () => {
    seedCanvas();
    renderBoth();
    await openDesk(0);
    // 还没收到 ready：必须显示「正在连接」而不是空白
    expect(
      screen.getByText(/正在连接导演台|Connecting to the director desk|Đang kết nối/),
    ).toBeTruthy();
  });

  it("ready 超时后显示可读错误态与重试入口，且不白屏", async () => {
    vi.useFakeTimers();
    seedCanvas();
    renderBoth();
    const buttons = screen.getAllByRole("button", { name: OPEN_RE });
    act(() => {
      fireEvent.click(buttons[0]);
    });
    expect(deskIframes()).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DIRECTOR_DESK_READY_TIMEOUT_MS + 500);
    });
    expect(
      screen.getAllByText(/连接导演台失败|Could not reach the director desk|Không kết nối được/)
        .length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /重试|Retry|Thử lại/ })).toBeTruthy();
  });

  it("握手成功后加载指示消失、能力文案出现", async () => {
    seedCanvas();
    renderBoth();
    await openDesk(0);
    const frame = deskIframes()[0];
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: DIRECTOR_DESK_MESSAGE_TYPES.ready },
          origin: window.location.origin,
          source: frame.contentWindow as unknown as MessageEventSource,
        }),
      );
    });
    await waitFor(() => expect(screen.getByText(/已连接|Connected|Đã kết nối/)).toBeTruthy());
    expect(screen.queryByText(/正在连接导演台|Connecting to the director desk/)).toBeNull();
  });
});

describe("A11y — Esc 关闭与焦点归属", () => {
  it("弹窗内按 Esc 关闭弹窗并清掉沉浸式键盘独占", async () => {
    const user = userEvent.setup();
    seedCanvas();
    renderBoth();
    await openDesk(0);
    expect(isImmersiveViewerActive()).toBe(true);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(deskIframes()).toHaveLength(0), { timeout: 5000 });
    expect(isImmersiveViewerActive()).toBe(false);
    expect(isOpen(NODE_A)).toBe(false);
  });

  it("弹窗打开后焦点落在弹窗内（不在画布上）", async () => {
    seedCanvas();
    renderBoth();
    await openDesk(0);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    // Base UI Dialog 的焦点管理把初始焦点放进弹窗；断言焦点归属而不是「不卡」。
    await waitFor(() => expect(dialog?.contains(document.activeElement)).toBe(true));
  });

  it("关闭按钮有可访问名称", async () => {
    seedCanvas();
    renderBoth();
    await openDesk(0);
    const close = await screen.findAllByRole("button", { name: CLOSE_RE }, { timeout: 5000 });
    expect(close.length).toBeGreaterThan(0);
    expect(close[close.length - 1].getAttribute("aria-label")).toBeTruthy();
  });

  it("握手前不产生 alert 噪声（错误态只在真出错时出现）", async () => {
    seedCanvas();
    renderBoth();
    await openDesk(0);
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });
});

describe("相邻功能回归 — 节点壳与把手不受影响", () => {
  it("两个导演台节点的把手 id 仍是 target/source（连线能力未被改坏）", () => {
    seedCanvas();
    renderBoth();
    expect(screen.getAllByTestId("handle-target-target")).toHaveLength(2);
    expect(screen.getAllByTestId("handle-source-source")).toHaveLength(2);
  });
});

describe("States — 封面图加载失败不留破图", () => {
  it("封面资源 404 时回落到空态，DOM 里不再有破图 img", async () => {
    useCanvasStore.setState({
      nodes: [
        {
          id: NODE_A,
          type: "directorDeskNode",
          position: { x: 0, y: 0 },
          data: { ...deskData(), previewImageUrl: "/static/projects/gone/missing-poster.png" },
        },
      ] as never,
      edges: [],
      selectedNodeId: null,
    } as never);
    render(
      <Harness nodeId={NODE_A} />,
    );

    const img = document.querySelector<HTMLImageElement>("img");
    expect(img?.getAttribute("src")).toBe("/static/projects/gone/missing-poster.png");
    // 浏览器解码失败会触发 error
    act(() => {
      img?.dispatchEvent(new Event("error", { bubbles: true }));
    });

    await waitFor(() => expect(document.querySelectorAll("img")).toHaveLength(0));
    expect(screen.getByText(/在 3D 里摆位预演|Stage the shot in 3D/)).toBeTruthy();
  });

  it("换成新的可用封面后重新渲染图片（失败标记随 URL 复位）", async () => {
    useCanvasStore.setState({
      nodes: [
        {
          id: NODE_A,
          type: "directorDeskNode",
          position: { x: 0, y: 0 },
          data: { ...deskData(), previewImageUrl: "/static/broken.png" },
        },
      ] as never,
      edges: [],
      selectedNodeId: null,
    } as never);
    render(<Harness nodeId={NODE_A} />);

    const first = document.querySelector<HTMLImageElement>("img");
    act(() => {
      first?.dispatchEvent(new Event("error", { bubbles: true }));
    });
    await waitFor(() => expect(document.querySelectorAll("img")).toHaveLength(0));

    act(() => {
      useCanvasStore.getState().updateNodeData(NODE_A, {
        previewImageUrl: "/static/projects/ok/fresh-poster.png",
      });
    });
    await waitFor(() =>
      expect(document.querySelector("img")?.getAttribute("src")).toBe(
        "/static/projects/ok/fresh-poster.png",
      ),
    );
  });
});
