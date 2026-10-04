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
import {
  createDirectorDeskBridge,
  DIRECTOR_DESK_ACTIONS,
  DIRECTOR_DESK_ACTION_DIRECTION,
  DIRECTOR_DESK_MESSAGE_TYPES,
} from "@/features/canvas/nodes/directorDeskBridge";
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

/**
 * v2（T003 起）换子应用后，iframe 挂载点从 `/director-desk/` 改为 `/director-desk-v2/`，
 * 实例标识参数从 `instanceId` 改为 `node_id`。选择器与取值都跟着改，否则下面所有
 * iframe 计数断言都会因为"一个都选不中"而 5s 超时（而不是因为行为坏了）。
 */
function deskIframes(): HTMLIFrameElement[] {
  return Array.from(
    document.querySelectorAll<HTMLIFrameElement>('iframe[src^="/director-desk-v2/"]'),
  );
}

function nodeIds(): string[] {
  return deskIframes().map(
    (frame) =>
      new URLSearchParams((frame.getAttribute("src") ?? "").split("?")[1]).get("node_id") ?? "",
  );
}

/** 宿主 → 子应用发出的 request 帧里的 action 列表。 */
function requestActions(frames: unknown[]): string[] {
  return frames
    .filter((f) => (f as { type?: string }).type === DIRECTOR_DESK_MESSAGE_TYPES.request)
    .map((f) => String((f as { payload?: { action?: string } }).payload?.action ?? ""));
}

/** 宿主回给子应用的、某个 requestId 的 response 帧（v2 的落盘回执走这条）。 */
function responseFrames(
  frames: unknown[],
  requestId: string,
): Array<{ payload: { ok: boolean; data?: unknown; error?: { code: string; message: string } } }> {
  return frames.filter((f) => {
    const candidate = f as { type?: string; payload?: { requestId?: string } };
    return (
      candidate.type === DIRECTOR_DESK_MESSAGE_TYPES.response &&
      candidate.payload?.requestId === requestId
    );
  }) as never;
}

/** 记录一扇 iframe 收到的宿主帧。 */
function recordFrames(frame: HTMLIFrameElement, frames: unknown[]): void {
  const contentWindow = frame.contentWindow;
  if (!contentWindow) throw new Error("no iframe content window");
  const original = contentWindow.postMessage.bind(contentWindow);
  (contentWindow as unknown as { postMessage: unknown }).postMessage = (message: unknown) => {
    frames.push(message);
    return original(message as never, "*");
  };
}

/** 从宿主方向投一条 ready。`nodeId` 省略 = 子应用没自报身份（向前兼容，不拦）。 */
function emitReadyFrom(frame: HTMLIFrameElement, nodeId?: string) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: DIRECTOR_DESK_MESSAGE_TYPES.ready,
          payload: nodeId ? { protocolVersion: 2, nodeId } : {},
        },
        origin: window.location.origin,
        source: frame.contentWindow as unknown as MessageEventSource,
      }),
    );
  });
}

/** 不经过组件、直接驱动一层桥用的裸 iframe。 */
function mountStandaloneIframe(nodeId: string): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.setAttribute("data-guard-probe", "");
  frame.setAttribute("src", `/director-desk-v2/?node_id=${nodeId}`);
  document.body.appendChild(frame);
  return frame;
}

function emitFromFrame(frame: HTMLIFrameElement, data: unknown) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data,
        origin: window.location.origin,
        source: frame.contentWindow as unknown as MessageEventSource,
      }),
    );
  });
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
  // 裸 iframe 是直接 append 到 body 的，testing-library 的自动清理管不到。
  document.querySelectorAll("iframe[data-guard-probe]").forEach((node) => node.remove());
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
    expect(nodeIds()).toEqual([NODE_A]);
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
    expect(new Set(nodeIds()).size).toBe(1);
    expect(nodeIds()).toEqual([NODE_A]);
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

  it("关闭后重开回到同一个 node_id（同一节点同一工程）", async () => {
    seedCanvas();
    renderBoth();
    await openDesk(0);
    const first = nodeIds()[0];
    await closeDesk();
    await openDesk(0);
    expect(nodeIds()[0]).toBe(first);
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
    // 不带 nodeId = 子应用没自报身份。宿主不该因此判失败（向前兼容：更早的子应用
    // 不报这个字段）。
    emitReadyFrom(deskIframes()[0]);
    await waitFor(() => expect(screen.getByText(/已连接|Connected|Đã kết nối/)).toBeTruthy());
    expect(screen.queryByText(/正在连接导演台|Connecting to the director desk/)).toBeNull();
  });
});

describe("协议守卫 — v2 的动作方向与身份自报", () => {
  // v2 之后同一个 action 名不再等于"宿主发、子回"：`project.save` 是子应用主动请宿主
  // 把工程写进节点（上游没有反向通道，于是复用同一对 request/response 消息，子发
  // request、宿主回 response）。下面这几条把"方向"这条新机制钉住。
  it("方向表给每个受控动作都留了条目（漏一个就是静默放行）", () => {
    for (const action of DIRECTOR_DESK_ACTIONS) {
      expect(DIRECTOR_DESK_ACTION_DIRECTION[action]).toMatch(/^(host-to-child|child-to-host)$/);
    }
    expect(DIRECTOR_DESK_ACTION_DIRECTION["project.save"]).toBe("child-to-host");
    expect(DIRECTOR_DESK_ACTION_DIRECTION["tool.call"]).toBe("host-to-child");
  });

  it("宿主主动发 child-to-host 的 project.save：立即被拒，不发帧、不等超时", async () => {
    const frame = mountStandaloneIframe("guard_probe");
    const posted: unknown[] = [];
    recordFrames(frame, posted);
    // 超时给足 60s：若它是被"等超时"拒掉的，这条断言会挂在测试超时上而不是立刻拿到
    // 方向错误 —— 两者要区分开，就靠这个值。
    const bridge = createDirectorDeskBridge({ iframe: frame, requestTimeoutMs: 60_000 });
    try {
      emitFromFrame(frame, {
        type: DIRECTOR_DESK_MESSAGE_TYPES.ready,
        payload: { protocolVersion: 2, nodeId: "guard_probe" },
      });
      expect(bridge.isReady()).toBe(true);

      await expect(
        bridge.request("project.save", { kind: "project", name: "p.director", content: "{}" }),
      ).rejects.toThrow(/child-to-host/);
      // 拒绝发生在发出去之前：一条 request 帧都不该有。
      expect(requestActions(posted)).not.toContain("project.save");

      // 对照组：方向对的 host-to-child 动作照常发帧（否则上一条可能只是"桥还没 ready"）。
      const pending = bridge.request("tool.call", { name: "director_export" });
      void pending.catch(() => {});
      expect(requestActions(posted)).toEqual(["tool.call"]);

      bridge.dispose();
      await expect(pending).rejects.toThrow(/disposed/);
    } finally {
      bridge.dispose();
    }
  });

  it("子应用发来的 project.save 被接住，并按 onProjectSave 的结果如实回执", async () => {
    const frame = mountStandaloneIframe("guard_probe");
    const posted: unknown[] = [];
    recordFrames(frame, posted);
    const url = "/static/projects/p/freezone/_uploads/director-desk-guard_probe-project-1.json?v=1";
    const onProjectSave = vi.fn().mockResolvedValue({ saved: true, url, filename: "project.director" });
    const bridge = createDirectorDeskBridge({ iframe: frame, onProjectSave });
    try {
      emitFromFrame(frame, {
        type: DIRECTOR_DESK_MESSAGE_TYPES.ready,
        payload: { protocolVersion: 2, nodeId: "guard_probe" },
      });

      const requestId = "child-save-1";
      emitFromFrame(frame, {
        type: DIRECTOR_DESK_MESSAGE_TYPES.request,
        payload: {
          protocolVersion: 2,
          requestId,
          action: "project.save",
          options: { kind: "project", name: "project.director", content: '{"project":{}}' },
        },
      });

      await waitFor(() => expect(responseFrames(posted, requestId)).toHaveLength(1));
      expect(onProjectSave).toHaveBeenCalledTimes(1);
      expect(onProjectSave.mock.calls[0][0]).toEqual({
        kind: "project",
        name: "project.director",
        content: '{"project":{}}',
      });
      // 子应用正卡在 await 上等回包：回执必须是宿主真实结果，不是空壳成功。
      expect(responseFrames(posted, requestId)[0].payload).toMatchObject({ ok: true, data: { saved: true, url } });
    } finally {
      bridge.dispose();
    }
  });

  it("宿主没接落盘时回明确失败，不让子应用干等到它自己的 120s", async () => {
    const frame = mountStandaloneIframe("guard_probe");
    const posted: unknown[] = [];
    recordFrames(frame, posted);
    const bridge = createDirectorDeskBridge({ iframe: frame });
    try {
      const requestId = "child-save-orphan";
      emitFromFrame(frame, {
        type: DIRECTOR_DESK_MESSAGE_TYPES.request,
        payload: {
          protocolVersion: 2,
          requestId,
          action: "project.save",
          options: { kind: "project", name: "project.director", content: "{}" },
        },
      });

      await waitFor(() => expect(responseFrames(posted, requestId)).toHaveLength(1));
      expect(responseFrames(posted, requestId)[0].payload).toMatchObject({
        ok: false,
        error: { code: "host_save_failed" },
      });
    } finally {
      bridge.dispose();
    }
  });

  it("ready 帧自报的 nodeId 会原样交给 onReady（桥这一侧是对的）", async () => {
    const frame = mountStandaloneIframe("guard_probe");
    const onReady = vi.fn();
    const bridge = createDirectorDeskBridge({ iframe: frame, onReady });
    try {
      emitFromFrame(frame, {
        type: DIRECTOR_DESK_MESSAGE_TYPES.ready,
        payload: { protocolVersion: 2, nodeId: "guard_probe" },
      });
      expect(onReady).toHaveBeenCalledWith({ protocolVersion: 2, nodeId: "guard_probe" });

      // 向前兼容：子应用没自报身份时只给 protocolVersion，不拦。
      const other = mountStandaloneIframe("other_node");
      const otherReady = vi.fn();
      const otherBridge = createDirectorDeskBridge({ iframe: other, onReady: otherReady });
      try {
        emitFromFrame(other, { type: DIRECTOR_DESK_MESSAGE_TYPES.ready, payload: {} });
        expect(otherReady).toHaveBeenCalledWith({});
      } finally {
        otherBridge.dispose();
      }
    } finally {
      bridge.dispose();
    }
  });

  /**
   * 握手身份校验：**真的会触发**。
   *
   * 这里曾经是 `it.fails` —— T003 留下了 `onReady: () => handlersRef.current.handleReady()`，
   * 回调把桥传进来的 `DirectorDeskReadyInfo` 整个丢掉，于是 `handleReady` 里那道
   * `if (info.nodeId && info.nodeId !== id)` 永远拿到 `{}`，是死代码：子应用自报的
   * node_id 再离谱也不会被拦下，而落盘是按 node_id 写进画布的，属于静默数据损坏。
   *
   * 现在桥回调把 info 透传下来（`DirectorDeskNode.tsx` 的 `onReady: (info) => …`），
   * 所以断言必须是正向的：身份对不上就判 failed，并且**一个请求都不许发出去** ——
   * 判 failed 之后再补发 capabilities.get 等于「先放行再补一刀」。
   */
  it("ready 自报的 nodeId 与本节点不符：判 failed 并写 errorMessage", async () => {
    seedCanvas();
    renderBoth();
    await openDesk(0);
    const frame = deskIframes()[0];
    const frames: unknown[] = [];
    recordFrames(frame, frames);

    // origin 与 contentWindow 都对得上 —— 揭穿"它以为自己是 B"的只有 node_id。
    emitReadyFrom(frame, NODE_B);

    await waitFor(() =>
      expect(
        screen.getAllByText(/连接导演台失败|Could not reach the director desk|Không kết nối được/)
          .length,
      ).toBeGreaterThan(0),
    );
    expect(useCanvasStore.getState().nodes.find((n) => n.id === NODE_A)?.data.errorMessage).toMatch(
      /node mismatch/,
    );
    expect(requestActions(frames)).toEqual([]);
  });

  it("带 nodeId 的 ready 不会把节点挡在门外（身份自报本身不能破坏握手）", async () => {
    seedCanvas();
    renderBoth();
    await openDesk(0);
    const frame = deskIframes()[0];
    const frames: unknown[] = [];
    recordFrames(frame, frames);

    emitReadyFrom(frame, NODE_A);

    await waitFor(() => expect(requestActions(frames)).toContain("capabilities.get"));
    expect(screen.queryByRole("button", { name: /重试|Retry|Thử lại/ })).toBeNull();
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
    expect(screen.getByText(/在 3D 里摆角色和机位|Block out characters and cameras in 3D/)).toBeTruthy();
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
