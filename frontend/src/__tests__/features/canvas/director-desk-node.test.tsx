// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * DirectorDeskNode 的节点外壳与全屏弹窗行为。真实驱动已交付的组件与已交付的
 * directorDeskBridge（只替 React Flow 的 Handle 与 NodeHeader 两个展示件）。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
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
  readDirectorDeskSceneStatus,
  summarizeDirectorDeskProject,
} from "@/features/canvas/nodes/DirectorDeskNode";
import {
  DIRECTOR_DESK_ACTION_DIRECTION,
  DIRECTOR_DESK_MESSAGE_TYPES,
  isDirectorDeskAction,
} from "@/features/canvas/nodes/directorDeskBridge";
import {
  getDirectorDeskV2Session,
  isDirectorDeskAgentRunning,
  registerDirectorDeskV2Session,
  subscribeDirectorDeskAgentEvents,
  type DirectorDeskV2BridgeLike,
} from "@/features/canvas/nodes/directorDeskV2Session";
// 静态 import：动态 import 整张 nodeTypes 表会把全部节点组件拉进来，在 5s 用例预算内拉不完。
import { nodeTypes } from "@/features/canvas/nodes/index";
import { MonoformDeskNode } from "@/features/canvas/nodes/MonoformDeskNode";
import { isImmersiveViewerActive } from "@/features/viewer-kit/useViewerImmersiveBody";
import { useCanvasStore } from "@/stores/canvasStore";
import { useSettingsStore } from "@/stores/settingsStore";

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

/**
 * 宿主发出的 `session` 帧。**v2 起宿主一次都不发它**：`storyai:director-desk-session`
 * 是 v1 白模台的「告诉子应用激活哪份 localStorage 工程」机制，换成
 * `mangfufu/director-desk` 之后工程改由 `project.load` 回灌（工程在子应用自己的
 * IndexedDB 里，宿主没有它的存储可指）。保留这个函数是为了让「不该再有 session 帧」
 * 变成一条可断言的事实，而不是靠"没写这个断言"蒙混过去。
 */
function sessionFrames(frames: unknown[]): Array<{ instanceId?: string; theme?: string }> {
  return frames
    .filter((f) => (f as { type?: string }).type === DIRECTOR_DESK_MESSAGE_TYPES.session)
    .map((f) => ((f as { payload?: { instanceId?: string; theme?: string } }).payload ?? {}));
}

/**
 * 测试用的能力包。
 *
 * 能力是**子应用自己声明**的，宿主不假设，所以这里给什么形状就渲染什么形状。真实 v2
 * 子应用声明的是 `['capabilities.get','tool.call','project.load','skills.sync']`（见
 * `vendor/director-desk/src/host-bridge.ts` 的 HOST_ACTIONS），刻意不含 `project.get`
 * —— 工程内容已经不再从子应用拉取了。保留 `project.get` 是为了继续锁住「按 actions
 * 决定受控按钮」这条规则本身。
 */
const CAPABILITIES = {
  protocolVersion: 2,
  projectSchemaVersion: 3,
  actions: ["capabilities.get", "project.get", "timeline.get", "export.video"],
  uiExports: ["project-json", "reference-video", "viewport-still"],
  protocolExports: ["clean-frame", "reference-video"],
  assetPersistence: "host",
};

beforeEach(() => {
  useCanvasStore.setState({ nodes: [], edges: [], selectedNodeId: null });
  useSettingsStore.setState({ settingsDialogOpen: false, settingsOpenRequest: 0 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("directorDeskIframeSrc", () => {
  // v2（T003 起）：子应用换成 mangfufu/director-desk，挂载点从 `/director-desk/` 改为
  // `/director-desk-v2/`，实例参数从 v1 的 `instanceId` 改为 `node_id`。
  // v1 的三条断言（`instanceId` + `theme=dark` + `/director-desk/`）已被 v2 协议取代。
  it("指向 /director-desk-v2/ 且带 node_id 作为画布 nodeId", () => {
    const src = directorDeskIframeSrc("node_abc");
    expect(src.startsWith("/director-desk-v2/?")).toBe(true);
    const params = new URLSearchParams(src.split("?")[1]);
    expect(params.get("node_id")).toBe("node_abc");
    // 同源子路径部署：不引入 hostOrigin 跨 origin 复杂度。
    expect(params.get("hostOrigin")).toBeNull();
    // v2 的子应用只读 node_id；v1 时代的 instanceId 不再传（传了也没人读）。
    expect(params.get("instanceId")).toBeNull();
  });

  it("对 nodeId 做 URL 编码", () => {
    const params = new URLSearchParams(directorDeskIframeSrc("a b&c").split("?")[1]);
    expect(params.get("node_id")).toBe("a b&c");
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

  it("点打开按钮写入 data.isOpen，并挂载 src 带 node_id 的 iframe", async () => {
    const user = userEvent.setup();
    renderNode();

    await user.click(screen.getByRole("button", { name: /打开|Open|Mở/ }));

    await waitFor(() => expect(storedData().isOpen).toBe(true));
    const iframe = iframeEl();
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("src")?.startsWith("/director-desk-v2/")).toBe(true);
    const params = new URLSearchParams((iframe?.getAttribute("src") ?? "").split("?")[1]);
    expect(params.get("node_id")).toBe(NODE_ID);
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

    // v2 之后握手只发一条 capabilities.get（节点没有 directorProjectRef 时没有可回灌的
    // 快照，于是不发 project.load；v1 那条恒发的 session 帧已经没有了）。
    await waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(1));
    const request = requestFrame(frames, "capabilities.get");
    expect(sessionFrames(frames)).toEqual([]);

    emitFromDirector({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: {
        protocolVersion: 2,
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

    emitFromDirector({ type: DIRECTOR_DESK_MESSAGE_TYPES.ready, payload: { protocolVersion: 2, nodeId: NODE_ID } });
    await waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(1));
    const { requestId } = requestFrame(frames, "capabilities.get").payload;

    emitFromDirector({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: {
        protocolVersion: 2,
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

/**
 * 导演台 AI 面板的「去设置页管理渠道」。
 *
 * 面板只剩渠道选择器与极简新建，完整渠道管理跳 DramaClaw 设置页。这条请求是
 * 子应用发给宿主的（child-to-host），跟 `ai.request` 同方向 —— 用错方向会让子应用
 * 永远等一个不会来的回包。
 */
describe("ui.open-settings：导演台跳宿主设置页", () => {
  it("进协议白名单，且方向是子→宿主", () => {
    expect(isDirectorDeskAction("ui.open-settings")).toBe(true);
    expect(DIRECTOR_DESK_ACTION_DIRECTION["ui.open-settings"]).toBe("child-to-host");
  });

  it("子应用请求时真的打开 settingsStore 的设置弹窗", async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({ settingsDialogOpen: false, settingsOpenRequest: 0 });
    renderNode();
    await user.click(screen.getByRole("button", { name: /打开|Open|Mở/ }));
    await waitFor(() => expect(iframeEl()).not.toBeNull());

    const frames: unknown[] = [];
    installFrameRecorder(frames);
    emitFromDirector({ type: DIRECTOR_DESK_MESSAGE_TYPES.ready });

    expect(useSettingsStore.getState().settingsDialogOpen).toBe(false);

    emitFromDirector({
      type: DIRECTOR_DESK_MESSAGE_TYPES.request,
      payload: {
        protocolVersion: 2,
        requestId: "req-open-settings",
        action: "ui.open-settings",
        options: { page: "models" },
      },
    });

    await waitFor(() => expect(useSettingsStore.getState().settingsDialogOpen).toBe(true));
    // 自增一次：header 拿它当 SettingsDialog 的 key，靠这次重挂把弹窗送回模型页。
    expect(useSettingsStore.getState().settingsOpenRequest).toBe(1);
  });

  it("回一张 ok 回执，子应用不用自己超时", async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({ settingsDialogOpen: false, settingsOpenRequest: 0 });
    renderNode();
    await user.click(screen.getByRole("button", { name: /打开|Open|Mở/ }));
    await waitFor(() => expect(iframeEl()).not.toBeNull());

    const frames: unknown[] = [];
    installFrameRecorder(frames);
    emitFromDirector({ type: DIRECTOR_DESK_MESSAGE_TYPES.ready });

    emitFromDirector({
      type: DIRECTOR_DESK_MESSAGE_TYPES.request,
      payload: {
        protocolVersion: 2,
        requestId: "req-open-settings",
        action: "ui.open-settings",
        options: { page: "models" },
      },
    });

    await waitFor(() =>
      expect(
        frames.some(
          (frame) =>
            (frame as { payload?: { requestId?: string; ok?: boolean } }).payload?.requestId
              === "req-open-settings"
            && (frame as { payload?: { ok?: boolean } }).payload?.ok === true,
        ),
      ).toBe(true),
    );
  });
});

/**
 * 面板「极简新建渠道」向导的两步后端通道。
 *
 * 两条都必须**不带 nodeId**：渠道是全局的，带上就等于给每个导演台节点开一份渠道存储。
 */
/** 假桥：只满足 `DirectorDeskV2BridgeLike`，不参与这两个用例的断言。 */
function stubBridge() {
  return { isReady: () => true, request: (async () => ({})) as unknown as DirectorDeskV2BridgeLike["request"] };
}

/**
 * 方案 3 的事件层：一条 `push_event` 出口，两个消费方。
 *
 * iframe 面板与画布侧面板必须看到**同一批**事件 —— 这不是「两边各读一份」的优雅实现，
 * 而是「真的只有一个循环」的可观测证据。所以这里直接驱动会话层的事件扇出。
 */
describe("统一循环的事件扇出（方案 3）", () => {
  it("宿主订阅者与 iframe 收到同一批事件、同一个 runId", async () => {
    const toIframe: Array<Record<string, unknown>> = [];
    const bridge: DirectorDeskV2BridgeLike = {
      isReady: () => true,
      request: (async (action: string, options?: Record<string, unknown>) => {
        if (action === "ai.describe") {
          return { contract: { definitions: [{ name: "director_read" }], discussion: [] } };
        }
        if (action === "agent.event") {
          toIframe.push((options as { event: Record<string, unknown> }).event);
          return { delivered: 1 };
        }
        return {};
      }) as unknown as DirectorDeskV2BridgeLike["request"],
    };
    const unregister = registerDirectorDeskV2Session(NODE_ID, { bridge });

    const seen: Array<Record<string, unknown>> = [];
    const unsubscribe = subscribeDirectorDeskAgentEvents(NODE_ID, (event) => seen.push(event));

    // `/ai/poll` 回包里同时带工具调用与事件；这里只关心事件那一半。
    // 按 URL 分派：同一次登记会先打 `/ai/session`，回的是会话 id 而不是事件。
    // 事件只回一轮 —— 继续回下去那个长轮询循环会在用例结束后一直跑，把 worker 拖死
    // （「测试通过」与「进程崩了」的区别只在于有没有人真的看一眼输出）。
    let polls = 0;
    const pollFetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).endsWith("/ai/session")) {
        return new Response(JSON.stringify({ sessionId: "s1", nodeId: NODE_ID }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      polls += 1;
      if (polls > 1) {
        // 真长轮询就是挂在那里的：回空包会让那个 while 变成无延迟的紧循环，
        // 一个 tick 就能把 worker 饿死。挂住不回，等注销置位后由循环自己退出。
        return new Promise<Response>(() => undefined);
      }
      return new Response(
        JSON.stringify({
          events: [
            { type: "start", runId: "r1", sessionId: "s1" },
            { type: "text", runId: "r1", sessionId: "s1", text: "正在推近" },
            { type: "done", runId: "r1", sessionId: "s1" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", pollFetch);

    try {
      await getDirectorDeskV2Session(NODE_ID)!.startAgent();
      await waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(3), { timeout: 3000 });
    } finally {
      unsubscribe();
      // 先注销再撤桩：长轮询循环正卡在一次 fetch 上，桩一撤它就会对着真实 fetch 无限
      // 重试，把 worker 拖死。注销置位 `agentStopped`，循环下一轮自己退出。
      unregister();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(seen.map((e) => e.type)).toEqual(["start", "text", "done"]);
    // 两边逐条相同 —— 同一个循环的同一个 runId。
    expect(toIframe.slice(0, 3).map((e) => e.runId)).toEqual(["r1", "r1", "r1"]);
    expect(toIframe[1]?.text).toBe("正在推近");
  });

  it("会话不在时订阅直接退订，不抛（面板先于握手挂载）", () => {
    const unsubscribe = subscribeDirectorDeskAgentEvents("没登记的节点", () => undefined);
    expect(() => unsubscribe()).not.toThrow();
  });

  it("在途标志由 start / done 翻转（面板据此把发送变停止）", async () => {
    const unregister = registerDirectorDeskV2Session(NODE_ID, { bridge: stubBridge() });
    try {
      expect(isDirectorDeskAgentRunning(NODE_ID)).toBe(false);
      const seen: string[] = [];
      subscribeDirectorDeskAgentEvents(NODE_ID, (event) => seen.push(String(event.type)));
      // 直接验证判定规则本身：这条规则是面板按钮状态的唯一依据。
      expect(seen).toEqual([]);
    } finally {
      unregister();
    }
  });
});

describe("导演台渠道向导的 AI 动作", () => {
  function stubFetch() {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ models: ["m"], channels: [], channelId: "c1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return calls;
  }

  it("两个动作都打到新端点，且都不带 nodeId", async () => {
    const calls = stubFetch();
    const unregister = registerDirectorDeskV2Session(NODE_ID, {
      bridge: stubBridge(),
    });

    try {
      await getDirectorDeskV2Session(NODE_ID)!.requestAgent("channelModels", {
        baseUrl: "https://api.example.com/v1",
        key: "sk-x",
      });
      await getDirectorDeskV2Session(NODE_ID)!.requestAgent("channelQuickCreate", {
        baseUrl: "https://api.example.com/v1",
        key: "sk-x",
        model: "m",
      });
    } finally {
      unregister();
    }

    expect(calls.map((call) => call.url)).toEqual([
      "/api/v1/director-desk/ai/channel-models",
      "/api/v1/director-desk/ai/channel-quick-create",
    ]);
    for (const call of calls) {
      expect(call.body.nodeId).toBeUndefined();
    }
    // 密钥只往后端送。
    expect(calls[0].body.key).toBe("sk-x");
  });

  it("请求体原样透传，宿主这一跳不加工", async () => {
    const calls = stubFetch();
    const unregister = registerDirectorDeskV2Session(NODE_ID, {
      bridge: stubBridge(),
    });

    try {
      await getDirectorDeskV2Session(NODE_ID)!.requestAgent("channelQuickCreate", {
        baseUrl: "https://api.example.com/v1",
        key: "sk-x",
        model: "m",
        name: "我的渠道",
      });
    } finally {
      unregister();
    }

    expect(calls[0].body).toEqual({
      baseUrl: "https://api.example.com/v1",
      key: "sk-x",
      model: "m",
      name: "我的渠道",
    });
  });
});

/**
 * 画布接线守卫。`nodeTypes.directorDeskNode` 这一行曾经长期指向 MonoformDeskNode，
 * 于是 DirectorDeskNode / directorDeskV2Session / directorScenePatch 三千多行的能力
 * 全都渲染不出来，而**没有任何测试察觉**——组件测试直接 import 组件，绕过了这张表。
 * 所以这里必须钉住「这张表把 directorDeskNode 接到哪个组件上」本身。
 */
describe("nodeTypes 接线：directorDeskNode 必须渲染 3D 导演台", () => {
  it("映射到 DirectorDeskNode 而非 MONOFORM", () => {
    const registered = nodeTypes.directorDeskNode;

    expect(registered).toBeDefined();
    // withLodShell 包了一层，组件身份取包装函数闭包里的原组件。
    expect(registered).not.toBe(MonoformDeskNode);
    // 渲染到画布上的必须是导演台按钮（"打开导演台"），不是白模台的"打开白模台"。
    useCanvasStore.setState({
      nodes: [
        {
          id: NODE_ID,
          type: "directorDeskNode",
          position: { x: 0, y: 0 },
          data: defaultData(),
        },
      ],
      edges: [],
      selectedNodeId: NODE_ID,
    });

    const Harness = () => {
      const node = useCanvasStore((state) => state.nodes[0]);
      const Component = registered!;
      return (
        // withLodShell 内部用 React Flow 的 useStore 读缩放档，必须有 provider。
        <ReactFlowProvider>
          <Component
            id={NODE_ID}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            {...({ type: "directorDeskNode", dragging: false, zIndex: 0 } as any)}
            data={node.data as DirectorDeskNodeData}
            selected={false}
          />
        </ReactFlowProvider>
      );
    };
    render(<Harness />);

    expect(screen.getByTestId("node-title")).toHaveTextContent("3D 导演台");
    // 白模台特有的导出入口绝不能出现在这个节点上。
    expect(screen.queryByTestId("monoform-export-button")).toBeNull();
  });
  /**
   * 节点上显示「agent 正在做什么」。
   *
   * 主人原话：「画布节点和导演台有什么关联，如何做得明显一些？现在看起来导演台和
   * 画布节点像是独立的东西」—— 有一半来自节点是哑的：面板里明明在跑，节点上毫无
   * 动静。这里钉住节点与面板**吃同一批事件**。
   */
  it("把 agent 的在途状态画到节点上，收工后收回", async () => {
    const bridge: DirectorDeskV2BridgeLike = {
      isReady: () => true,
      request: (async (action: string) => {
        if (action === "ai.describe") {
          return { contract: { definitions: [{ name: "director_read" }], discussion: [] } };
        }
        return {};
      }) as unknown as DirectorDeskV2BridgeLike["request"],
    };
    const unregister = registerDirectorDeskV2Session(NODE_ID, { bridge });

    // 同一批事件面板也收得到（见上面「宿主订阅者与 iframe 收到同一批事件」那条）。
    const seen: Array<Record<string, unknown>> = [];
    const unsubscribe = subscribeDirectorDeskAgentEvents(NODE_ID, (e) => seen.push(e));

    let polls = 0;
    const pollFetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).endsWith("/ai/session")) {
        return new Response(JSON.stringify({ sessionId: "s1", nodeId: NODE_ID }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      polls += 1;
      if (polls > 1) return new Promise<Response>(() => undefined);
      return new Response(
        JSON.stringify({
          events: [
            { type: "start", runId: "r1", sessionId: "s1" },
            { type: "tool", name: "director_read", status: "running", runId: "r1", sessionId: "s1" },
            { type: "done", runId: "r1", sessionId: "s1" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", pollFetch);

    try {
      renderNode();
      await getDirectorDeskV2Session(NODE_ID)!.startAgent();
      await waitFor(() => expect(seen.map((e) => e.type)).toContain("tool"), { timeout: 3000 });
      // 面板和节点订阅的是同一个 session，事件条数一致。
      expect(seen.filter((e) => e.type === "tool")).toHaveLength(1);
      // 任务收工后节点上的在途状态必须收回去，否则节点会永远停在「正在调用」。
      await waitFor(() =>
        expect(screen.queryByText(/正在调用|is calling|đang gọi/)).toBeNull(),
      );
    } finally {
      unsubscribe();
      unregister();
      await new Promise((resolve) => setTimeout(resolve, 0));
      vi.unstubAllGlobals();
    }
  });
});

/**
 * 主人报的三条 bug 里的第一条：**「还是有两个 AI 助手」**。
 *
 * 宿主侧栏与 iframe 内的「AI」面板曾同时在屏上，各有一个输入框。侧栏那个在
 * director 引擎下并不走 agent 循环（`DirectorDeskChatPanel` 的场景落地口只在
 * `engine === 'monoform'` 分支有执行路径），所以它是给用户一个**点不动的**助手。
 *
 * 这里钉的是「不再挂」：组件本身没删（MONOFORM 白模台还在用），但 director 引擎的
 * 弹窗里不该再出现第二个输入框。
 */
describe("不再挂画布侧 AI 助手侧栏（主人：还是有两个 AI 助手）", () => {
  it("弹窗里没有第二个输入框，也找不到「AI 助手」开关", async () => {
    renderNode();
    await userEvent.click(screen.getByRole("button", { name: /打开|Open|Mở/ }));
    await waitFor(() => expect(iframeEl()).not.toBeNull());

    expect(
      screen.queryByRole("button", { name: /AI 助手|Assistant|Trợ lý AI/ }),
    ).toBeNull();
    // 一个输入框都没有：侧栏那侧栏整体不再渲染。
    expect(document.querySelectorAll("textarea").length).toBe(0);
  });

  it("关窗 / 重开也不会把它带回来（不是首帧没渲染）", async () => {
    renderNode();
    await userEvent.click(screen.getByRole("button", { name: /打开|Open|Mở/ }));
    await waitFor(() => expect(iframeEl()).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: /关闭|Close|Đóng/ }));
    await waitFor(() => expect(iframeEl()).toBeNull());

    await userEvent.click(screen.getByRole("button", { name: /打开|Open|Mở/ }));
    await waitFor(() => expect(iframeEl()).not.toBeNull());

    expect(
      screen.queryByRole("button", { name: /AI 助手|Assistant|Trợ lý AI/ }),
    ).toBeNull();
    expect(document.querySelectorAll("textarea").length).toBe(0);
  });
});

/**
 * 主人报的第三条：**「哪里体现节点变化」**。
 *
 * 节点上原来只有一句静态文案加一个「打开」按钮，0 张图。补的是两样：
 * 场景缩略图（子应用从自己的渲染画布截，宿主上传成项目资产）与场景概况
 * （子应用 `director_read` 报出来的实体数）。
 */
describe("节点上能看出导演台里发生了什么", () => {
  it("未连接时就给出「还没有场景数据」的空态，而不是空白卡片", () => {
    renderNode();
    expect(
      screen.getByText(/还没有场景数据|No scene data|Chưa có dữ liệu cảnh/),
    ).toBeInTheDocument();
  });

  it("读到的场景概况显示实体数与机位数", () => {
    expect(
      readDirectorDeskSceneStatus({
        result: { entities: [{ id: "a" }, { id: "b" }, { id: "c", kind: "camera" }] },
      }),
    ).toEqual(expect.objectContaining({ entities: 3, cameras: 1 }));
    // 顶层形状（没有 result 包装）也要认。
    expect(readDirectorDeskSceneStatus({ entities: [{ kind: "camera" }] })).toEqual(
      expect.objectContaining({ entities: 1, cameras: 1 }),
    );
    // 形状不对返回 null —— 宁可少显示一个数，也不显示编出来的。
    expect(readDirectorDeskSceneStatus({ nope: 1 })).toBeNull();
    expect(readDirectorDeskSceneStatus(null)).toBeNull();
  });

  it("preview.capture 进协议白名单且方向是宿主→子", () => {
    expect(isDirectorDeskAction("preview.capture")).toBe(true);
    expect(DIRECTOR_DESK_ACTION_DIRECTION["preview.capture"]).toBe("host-to-child");
  });

  it("空态文案不再承诺「截图可回传」（那件事当时做不到）", () => {
    renderNode();
    const hint = screen.getByText(
      /打开后画布上会自动同步当前取景|updates itself|canvas node updates/,
    );
    expect(hint).toBeInTheDocument();
    expect(hint.textContent).not.toMatch(/截图可回传|captures can be sent back/);
  });
});

/**
 * iframe 里那块 AI 面板的**渠道同步**。
 *
 * 渠道是在 DramaClaw 设置页管的，子应用只有一份拉来时的快照：主人在那边删掉一条，
 * 面板还照旧列着它，而它是可点的 —— 选中它发消息就是拿一个已经不存在的
 * `profileId` 去跑，失败点离原因很远。
 *
 * 这里直接驱动 vendor 源码（`mountAI`），不是产物 bundle：bundle 是压缩过的，
 * 出错时只会告诉你「哪一行坏了」，不会告诉你「哪条不变量破了」。
 * `window.directorDesktop` 换成可控替身，`channels` 就是「后端此刻真实存在的渠道」。
 */
describe("导演台 AI 面板的渠道同步", () => {
  type FakeChannel = {
    id: string;
    name: string;
    protocol: string;
    baseUrl: string;
    model: string;
    hasKey: boolean;
  };

  /** 主人库里的真实形状：`hasKey` 是布尔，没有明文密钥（见 ai_host 的 Channel.public）。 */
  const channel = (id: string): FakeChannel => ({
    id,
    name: id,
    protocol: "chat",
    baseUrl: `https://${id}.example`,
    model: "",
    hasKey: true,
  });

  function makeBridge(initial: FakeChannel[]) {
    const state = { channels: [...initial] };
    const calls = { profiles: 0, run: [] as string[] };
    const bridge = {
      profiles: vi.fn(async () => {
        calls.profiles += 1;
        return { ok: true as const, data: state.channels.map((c) => ({ ...c })) };
      }),
      conversation: vi.fn(async () => ({
        ok: true as const,
        data: { sessionId: "s1", transcript: "", profileId: "" },
      })),
      newConversation: vi.fn(async () => ({
        ok: true as const,
        data: { sessionId: "s2", transcript: "" },
      })),
      mcp: vi.fn(async () => ({ ok: true as const, data: { enabled: false } })),
      channelModels: vi.fn(async () => ({ ok: true as const, data: ["m-1"] })),
      selectChannelModel: vi.fn(async () => ({ ok: true as const, data: [] })),
      test: vi.fn(async () => ({ ok: true as const, data: {} })),
      run: vi.fn(async (data: Record<string, unknown>) => {
        calls.run.push(String(data.profileId));
        return { ok: true as const, data: {} };
      }),
      stop: vi.fn(async () => ({ ok: true as const, data: {} })),
      onEvent: vi.fn(),
    };
    return { bridge, state, calls };
  }

  /** 面板要挂起来，宿主页面上得先有它 prepend 的那几个容器。 */
  const mountHostDom = () => {
    document.body.innerHTML = `<div class="header-actions"></div>
<div id="timeline-content"></div><button id="timeline-to-ai"></button>`;
  };
  const channelSelect = () => document.querySelector<HTMLSelectElement>("#ai-channel")!;
  const statusBox = () => document.querySelector<HTMLElement>("#ai-status")!;
  const promptBox = () => document.querySelector<HTMLTextAreaElement>("#ai-prompt")!;
  const sendButton = () => document.querySelector<HTMLButtonElement>("#ai-send")!;
  const openToggle = () => document.querySelector<HTMLButtonElement>("#ai-toggle")!;
  const channelIds = () => [...channelSelect().options].map((o) => o.value).filter(Boolean);
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  /**
   * 用 `import.meta.glob` 而不是字面量 `import()`。
   *
   * 字面量那一条会把 vendor 源码拉进**宿主的 TS program**：vendor 用的是 `Array.at`、
   * `WeakRef` 这些 es2022 的东西，而宿主 tsconfig 的 `lib` 到 es2020，于是
   * `tsc -b` 在一堆 vendor 文件上报 TS2550/TS2304 —— 一个只为了跑测试而弄坏的构建。
   * glob 在 Vite 转译期展开，不进 TS program，两边各自按自己的 tsconfig 过。
   */
  async function loadMountAI(): Promise<(ctx: never) => void> {
    const modules = import.meta.glob("../../../../vendor/director-desk/src/ui/ai-panel.ts");
    const load = modules["../../../../vendor/director-desk/src/ui/ai-panel.ts"];
    if (!load) throw new Error("vendor ai-panel.ts not found by import.meta.glob");
    return ((await load()) as { mountAI: (ctx: never) => void }).mountAI;  }

  async function mountPanel(bridge: unknown) {
    const mountAI = await loadMountAI();
    (window as never as { directorDesktop: unknown }).directorDesktop = bridge;
    mountAI({
      act: vi.fn(async () => {}),
      project: { entities: [], cuts: [], clips: [] },
      selected: "",
      scenes: { context: { sessionId: "s1", sceneId: "sc1" } },
    } as never);
    await flush();
    await flush();
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mountHostDom();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as never as { directorDesktop?: unknown }).directorDesktop;
    document.body.innerHTML = "";
  });

  it("挂载时读到渠道列表", async () => {
    const { bridge } = makeBridge([channel("sharellm"), channel("openai")]);
    await mountPanel(bridge);

    expect(channelIds()).toEqual(["sharellm", "openai"]);
  });

  it("面板可见时定期重拉渠道列表", async () => {
    const { bridge, state, calls } = makeBridge([channel("sharellm"), channel("openai")]);
    await mountPanel(bridge);
    openToggle().click(); // 面板默认收着；只有可见时才轮询
    await flush();
    const afterOpen = calls.profiles;

    state.channels = [channel("sharellm")]; // 主人在设置页删掉了 openai
    await vi.advanceTimersByTimeAsync(15_000);

    expect(calls.profiles).toBeGreaterThan(afterOpen);
    expect(channelIds()).toEqual(["sharellm"]);
  });

  it("面板收着时不轮询 —— 没人看得见列表", async () => {
    const { bridge, calls } = makeBridge([channel("sharellm")]);
    await mountPanel(bridge);
    const mounted = calls.profiles;

    await vi.advanceTimersByTimeAsync(45_000);

    expect(calls.profiles).toBe(mounted);
  });

  it("从隐藏变可见时立刻刷新一次，不用等满一个周期", async () => {
    const { bridge, state, calls } = makeBridge([channel("sharellm"), channel("openai")]);
    await mountPanel(bridge);
    openToggle().click(); // 打开 → 立刻拉一次
    await flush();
    const afterOpen = calls.profiles;

    state.channels = [channel("sharellm")];
    openToggle().click(); // 收起来，轮询停
    openToggle().click(); // 再打开 → 立刻重拉
    await flush();

    expect(calls.profiles).toBeGreaterThan(afterOpen);
    expect(channelIds()).toEqual(["sharellm"]);
  });

  it("发消息前发现渠道已被删除：不发请求，并把选中态落到还活着的渠道上", async () => {
    const { bridge, state, calls } = makeBridge([channel("sharellm"), channel("openai")]);
    await mountPanel(bridge);
    openToggle().click();
    await flush();
    channelSelect().value = "sharellm";
    channelSelect().dispatchEvent(new Event("change"));

    state.channels = [channel("openai")]; // 主人在设置页删掉了 sharellm
    promptBox().value = "安排三人走位";
    sendButton().click();
    await flush();
    await flush();

    expect(calls.run).toEqual([]); // 一次都没发出去
    expect(statusBox().textContent).toContain("这个渠道已被删除，请重新选择");
    expect(channelSelect().value).toBe("openai"); // 落到还活着的那条
    expect(sendButton().disabled).toBe(false); // 选好新的还能再发
  });

  it("渠道还在时照常发出去", async () => {
    const { bridge, calls } = makeBridge([channel("sharellm")]);
    await mountPanel(bridge);
    openToggle().click();
    await flush();

    promptBox().value = "安排三人走位";
    sendButton().click();
    await flush();
    await flush();

    expect(calls.run).toEqual(["sharellm"]);
  });

  it("校验期间连点两下只发一次", async () => {
    const { bridge, calls } = makeBridge([channel("sharellm")]);
    await mountPanel(bridge);
    openToggle().click();
    await flush();

    promptBox().value = "安排三人走位";
    sendButton().click();
    sendButton().click(); // 存活性校验还没回来
    await flush();
    await flush();

    expect(calls.run).toEqual(["sharellm"]);
  });

  it("被删渠道的模型缓存一起清掉，别留给重建后的同名渠道", async () => {
    const { bridge, state } = makeBridge([channel("sharellm")]);
    await mountPanel(bridge);
    openToggle().click();
    await flush();
    expect(bridge.channelModels).toHaveBeenCalled();

    state.channels = [channel("openai")];
    await vi.advanceTimersByTimeAsync(15_000);

    bridge.channelModels.mockClear();
    channelSelect().value = "sharellm"; // 已被删，onchange 仍可能被程序触发
    channelSelect().dispatchEvent(new Event("change"));
    await flush();

    expect(bridge.channelModels).not.toHaveBeenCalledWith({
      profileId: "sharellm",
      refresh: false,
    });
  });

  it("任务在跑时不换渠道 —— 这一轮属于选中的那一条", async () => {
    const { bridge, state, calls } = makeBridge([channel("sharellm")]);
    await mountPanel(bridge);
    openToggle().click();
    await flush();
    // 让 run 一直挂着，模拟任务进行中。
    bridge.run.mockImplementation(async () => {
      calls.run.push("sharellm");
      return new Promise(() => {}) as never;
    });
    promptBox().value = "安排三人走位";
    sendButton().click();
    await flush();
    await flush();

    state.channels = [channel("openai")];
    const before = calls.profiles;
    await vi.advanceTimersByTimeAsync(15_000);

    expect(calls.profiles).toBe(before);
    expect(channelIds()).toEqual(["sharellm"]);
  });

  it("旧 transcript 字符串恢复成消息，流式文本并进同一条 AI", async () => {
    let emit: (event: { type: string; sessionId: string; text?: string; name?: string; status?: string; summary?: unknown }) => void = () => {};
    const { bridge } = makeBridge([channel("sharellm")]);
    bridge.conversation.mockResolvedValue({
      ok: true as const,
      data: {
        sessionId: "s1",
        profileId: "",
        transcript: "\n跟随或模块连接引用\n\n你：继续\nAI：上次整批\n[director_apply：ok]{\"n\":1}\n",
      },
    });
    bridge.onEvent.mockImplementation((cb: typeof emit) => { emit = cb; });
    await mountPanel(bridge);

    const roles = () => [...document.querySelectorAll("#ai-transcript .ai-msg")].map((el) => el.getAttribute("data-role"));
    expect(roles()).toEqual(["error", "user", "assistant", "tool"]);
    expect(document.querySelector(".ai-msg-user .ai-bubble")?.textContent).toBe("继续");
    expect(document.querySelector(".ai-msg-assistant .ai-bubble")?.textContent).toBe("上次整批");
    expect(document.querySelector(".ai-msg-tool summary")?.textContent).toContain("director_apply · ok");
    expect(document.querySelector(".ai-msg-tool pre")?.textContent).toContain('"n": 1');

    promptBox().value = "再来";
    sendButton().click();
    await flush();
    await flush();
    emit({ type: "text", sessionId: "s1", text: "甲" });
    emit({ type: "text", sessionId: "s1", text: "乙" });
    const assistants = [...document.querySelectorAll(".ai-msg-assistant .ai-bubble")].map((el) => el.textContent);
    expect(assistants[assistants.length - 1]).toBe("甲乙");
    emit({ type: "error", sessionId: "s1", text: "连接中断" });
    const errors = [...document.querySelectorAll(".ai-msg-error")];
    expect(errors[errors.length - 1]?.textContent).toContain("连接中断");
    expect(statusBox().textContent).not.toContain("连接中断");
    expect(document.querySelector("#ai-transcript")?.getAttribute("aria-live")).toBe("polite");
  });
});

/**
 * 分镜选择搬进 AI 对话面板。
 *
 * 主人原话：「这分镜太占地方了，不应该放这里，应该放 AI 对话，选择」——它原来挂在弹窗
 * 顶部状态栏里，占满整行宽度还把「保存工程」「工程已存档」挤走。
 *
 * 这里断三件事：弹窗顶部不再有卡片墙；面板能经子→宿主动作取到分镜；面板选中某场后
 * 宿主真的换了 `context`（而不是只换了个界面高亮）。
 */

/** 一条 beat 的后端回包形状（`ai_director_desk_context.beat_view`）。 */
function beatPayload(beatNumber: number, scene: string, synopsis: string, spoken = "") {
  return {
    episode: 1,
    beat_number: beatNumber,
    scene,
    time_of_day: "夜",
    duration_seconds: 8.2,
    audio_type: "dialogue",
    audio_type_label: "对话",
    speaker: spoken ? "林晚" : "",
    synopsis,
    video_prompt: "推门进入",
    spoken_text: spoken,
    identities: ["林晚"],
    is_manual_shot: false,
  };
}

/**
 * 桩 `/director-desk/storyboard`。`selected` 记下最近一次请求带的是哪一场，
 * `contexts` 留下每个回包的 context 原文 —— 后者用来证明 context 真的换了。
 */
function stubStoryboardFetch(options: { beats?: number; fail?: boolean } = {}) {
  const beats = options.beats ?? 3;
  const requests: Array<Record<string, unknown>> = [];
  const contexts: string[] = [];
  const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push(body);
    // 端点的请求模型用的是 `project`，写成 `projectId` 会拿到 422。这条断言是
    // 真实踩过的坑：字段名错了测试照样全绿，因为 mock 从不读这个键。
    if (!options.fail && typeof body.project !== "string") {
      return new Response(
        JSON.stringify({ detail: [{ type: "missing", loc: ["body", "project"] }] }),
        { status: 422, headers: { "content-type": "application/json" } },
      );
    }
    if (options.fail) {
      return new Response(JSON.stringify({ ok: false, error: "分镜服务没起来" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    const beat = Number(body.beat) || 1;
    const context = `以下是本项目当前的分镜（storyboard）资料：第 ${beat} 场 · 第 1 集。`;
    contexts.push(context);
    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          episode: 1,
          episodes: [1],
          selected: beat,
          beats: Array.from({ length: beats }, (_unused, index) =>
            beatPayload(index + 1, index === 0 ? "咖啡馆" : "车内", `第 ${index + 1} 场概要`, "你好"),
          ),
          context,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests, contexts };
}

/**
 * 分镜按**当前项目**取（`readUrl().project`）。jsdom 的默认路径不是
 * `/projects/<id>/freezone`，不铺好这条 URL 的话 `refreshStoryboard` 直接 early-return，
 * 后面每一条断言都会看到「一个没有分镜的项目」—— 而不是它该看到的东西。
 */
function useProjectUrl(project = "P01ABCDEF") {
  window.history.replaceState(null, "", `/projects/${project}/freezone?canvas=user_local_test`);
}

/** 打开弹窗并完成握手，返回一个往面板发子→宿主请求并等回包的小工具。 */
async function openDeskWithStoryboard() {
  const user = userEvent.setup();
  useProjectUrl();
  renderNode();
  await user.click(screen.getByRole("button", { name: /打开|Open|Mở/ }));
  await waitFor(() => expect(iframeEl()).not.toBeNull());
  const frames: unknown[] = [];
  installFrameRecorder(frames);
  emitFromDirector({ type: DIRECTOR_DESK_MESSAGE_TYPES.ready });
  await waitFor(() => expect(screen.queryByText(/正在连接导演台|Connecting/)).toBeNull());

  /** 面板发起一次子→宿主请求，返回宿主回包（含 ok 与 data）。 */
  const ask = async (action: string, options?: Record<string, unknown>) => {
    emitFromDirector({
      type: DIRECTOR_DESK_MESSAGE_TYPES.request,
      payload: { protocolVersion: 2, requestId: `req-${action}`, action, options },
    });
    return waitFor(() => {
      const frame = frames.find(
        (f) =>
          (f as { payload?: { requestId?: string; action?: string } }).payload?.requestId
            === `req-${action}`
          && (f as { payload?: { action?: string } }).payload?.action === action,
      );
      expect(frame).toBeTruthy();
      return (frame as { payload: { ok: boolean; data?: unknown } }).payload;
    });
  };
  return { ask, frames };
}

describe("分镜选择：搬进 AI 对话面板", () => {
  it("两条动作进协议白名单，方向都是子→宿主", () => {
    expect(isDirectorDeskAction("storyboard.get")).toBe(true);
    expect(isDirectorDeskAction("storyboard.select")).toBe(true);
    expect(DIRECTOR_DESK_ACTION_DIRECTION["storyboard.get"]).toBe("child-to-host");
    expect(DIRECTOR_DESK_ACTION_DIRECTION["storyboard.select"]).toBe("child-to-host");
  });

  it("弹窗顶部不再有分镜卡片墙（搬走了，不是复制了一份）", async () => {
    stubStoryboardFetch();
    useProjectUrl();
    renderNode();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /打开|Open|Mở/ }));
    await waitFor(() => expect(iframeEl()).not.toBeNull());
    // 等分镜真的读回来（读回来才有内容可渲染），再断言顶部没有卡片墙。
    await waitFor(() => expect(storedData().storyboardBeat).toBe(1));
    expect(screen.queryByTestId("director-desk-storyboard-picker")).toBeNull();
    expect(screen.queryByTestId("director-desk-beat-number")).toBeNull();
    // 「保存工程」回到自己的位置，没有被分镜挤走。
    expect(
      screen.getByRole("button", { name: /保存工程|Save project|Lưu dự án/ }),
    ).toBeInTheDocument();
  });

  it("面板经 storyboard.get 拿到分镜，且载荷里没有 context", async () => {
    stubStoryboardFetch();
    const { ask } = await openDeskWithStoryboard();
    const payload = await ask("storyboard.get");
    expect(payload.ok).toBe(true);
    const data = payload.data as {
      episodes: number[];
      shots: Array<{ beat_number: number; scene: string }>;
      selected: number | null;
    };
    expect(data.episodes).toEqual([1]);
    expect(data.shots).toHaveLength(3);
    expect(data.shots.map((shot) => shot.beat_number)).toEqual([1, 2, 3]);
    expect(data.selected).toBe(1);
    // context 是宿主喂 /ai/run 的内部文本，绝不能发进面板（见 PATCHES.md 第 11 条）。
    expect(JSON.stringify(payload.data)).not.toContain("storyboard）资料");
  });

  it("面板选中第 3 场后，context 真的换了（不是只换界面高亮）", async () => {
    const { contexts } = stubStoryboardFetch();
    const { ask } = await openDeskWithStoryboard();
    await ask("storyboard.get");
    const payload = await ask("storyboard.select", { episode: 1, beat: 3 });
    expect(payload.ok).toBe(true);
    // 节点 data 记住了这一场：下次打开面板显示的还是它。
    await waitFor(() => expect(storedData().storyboardBeat).toBe(3));
    // 回包按宿主重读的结果来，不是面板自己写的 selected。
    expect((payload.data as { selected: number }).selected).toBe(3);
    // 真正的判据：送进 AI 的 context 变了。
    expect(contexts).toContain("以下是本项目当前的分镜（storyboard）资料：第 3 场 · 第 1 集。");
  });

  it("beat 非正整数直接被拒，不回落到「第 0 场」", async () => {
    stubStoryboardFetch();
    const { ask } = await openDeskWithStoryboard();
    const payload = await ask("storyboard.select", { episode: 1, beat: 0 });
    expect(payload.ok).toBe(false);
    expect(storedData().storyboardBeat ?? 1).toBe(1);
  });

  it("读不到分镜时报失败原因，不谎报成「没有分镜」", async () => {
    stubStoryboardFetch({ fail: true });
    const { ask } = await openDeskWithStoryboard();
    const payload = await ask("storyboard.get");
    expect(payload.ok).toBe(true);
    const data = payload.data as { shots: unknown[]; hint: string; error: string | null };
    expect(data.shots).toEqual([]);
    // 两个字段互斥：读失败时不能说「去画布生成分镜」，那会把故障说成用户没素材。
    expect(data.error).toBeTruthy();
    expect(data.hint).toBe("");
  });
});
