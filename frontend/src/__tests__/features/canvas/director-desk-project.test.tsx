// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * DirectorDeskNode 阶段 6：工程快照的落库、回灌与失效降级。
 *
 * 被测单元是**已交付的**组件与 store 装配（真实导出路径）。只把两个 I/O 边界替掉：
 * 上传调用（`@/api/ops`）与快照读取（`global.fetch`）。落库命名、JSON 序列化与体积
 * 上限、`directorProjectRef` 回写、`session` 回灌、404 降级分支全部跑真实代码。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirectorDeskNodeData } from "@/features/canvas/domain/canvasNodes";
import {
  DirectorDeskNode,
  DIRECTOR_DESK_SNAPSHOT_MAX_BYTES,
  directorDeskProjectUploadName,
} from "@/features/canvas/nodes/DirectorDeskNode";
import { DIRECTOR_DESK_MESSAGE_TYPES } from "@/features/canvas/nodes/directorDeskBridge";
import { useCanvasStore } from "@/stores/canvasStore";

const uploadFreezoneImage = vi.fn();
vi.mock("@/api/ops", () => ({
  uploadFreezoneImage: (...args: unknown[]) => uploadFreezoneImage(...args),
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
  NodeHeader: ({ titleText }: { titleText: string }) => <div data-testid="node-title">{titleText}</div>,
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}));

const NODE_ID = "node_director_desk_project";
const PROJECT_ID = "proj_snapshot_test";
const CAPABILITIES = { protocolVersion: 1, actions: ["capabilities.get", "project.get"] };
const SNAPSHOT_REF = `/static/projects/${PROJECT_ID}/freezone/_uploads/director-desk-${NODE_ID}-project-1.json?st_v=1`;

const PROJECT_PAYLOAD = {
  protocolVersion: 1,
  projectSchemaVersion: 1,
  projectFingerprint: "fnv1a32-cafebabe",
  project: {
    version: 1,
    scene: {},
    assets: [],
    animationAssets: [],
    objects: [{ id: "o1" }],
    cameras: [{ id: "c1" }],
    activeCameraId: "c1",
    panoramaAssetId: null,
  },
  portability: { portable: true, browserLocalAssetIds: [], note: null },
};

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

async function renderOpenNode(overrides: Partial<DirectorDeskNodeData> = {}) {
  useCanvasStore.setState({
    nodes: [
      {
        id: NODE_ID,
        type: "directorDeskNode",
        position: { x: 0, y: 0 },
        data: defaultData(overrides),
      },
    ],
    edges: [],
    selectedNodeId: NODE_ID,
  });

  const Harness = () => {
    const node = useCanvasStore((state) => state.nodes.find((item) => item.id === NODE_ID));
    if (!node) return null;
    return (
      <DirectorDeskNode
        id={NODE_ID}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {...({ type: "directorDeskNode", dragging: false, zIndex: 0 } as any)}
        data={node.data as DirectorDeskNodeData}
        selected
      />
    );
  };

  render(<Harness />);
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: /打开|Open|Mở/ }));
  });
  await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
}

function storedData(): DirectorDeskNodeData {
  return useCanvasStore.getState().nodes.find((n) => n.id === NODE_ID)?.data as DirectorDeskNodeData;
}

function iframeEl(): HTMLIFrameElement {
  const iframe = document.querySelector("iframe");
  if (!iframe) throw new Error("no iframe mounted");
  return iframe;
}

function emitFromDirector(data: unknown) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data,
        origin: window.location.origin,
        source: iframeEl().contentWindow as unknown as MessageEventSource,
      }),
    );
  });
}

function installFrameRecorder(frames: unknown[]) {
  const contentWindow = iframeEl().contentWindow;
  if (!contentWindow) throw new Error("no content window");
  const originalPost = contentWindow.postMessage.bind(contentWindow);
  (contentWindow as unknown as { postMessage: unknown }).postMessage = (message: unknown) => {
    frames.push(message);
    return originalPost(message as never, "*");
  };
}

function requestFrame(frames: unknown[], action: string) {
  const frame = frames.find((f) => {
    const candidate = f as { type?: string; payload?: { action?: string } };
    return (
      candidate.type === DIRECTOR_DESK_MESSAGE_TYPES.request && candidate.payload?.action === action
    );
  });
  if (!frame) throw new Error(`no request frame for ${action}`);
  return frame as { payload: { requestId: string; action: string } };
}

function sessionFrames(frames: unknown[]): Array<{ instanceId?: string; theme?: string }> {
  return frames
    .filter((f) => (f as { type?: string }).type === DIRECTOR_DESK_MESSAGE_TYPES.session)
    .map((f) => (f as { payload?: { instanceId?: string; theme?: string } }).payload ?? {});
}

/** 握手到 connected；返回帧记录器。 */
async function handshake() {
  const frames: unknown[] = [];
  installFrameRecorder(frames);
  emitFromDirector({ type: DIRECTOR_DESK_MESSAGE_TYPES.ready });
  await waitFor(() => expect(requestFrame(frames, "capabilities.get")).toBeTruthy());
  emitFromDirector({
    type: DIRECTOR_DESK_MESSAGE_TYPES.response,
    payload: {
      protocolVersion: 1,
      requestId: requestFrame(frames, "capabilities.get").payload.requestId,
      action: "capabilities.get",
      ok: true,
      data: CAPABILITIES,
    },
  });
  await waitFor(() => expect(screen.getByText(/可用接口 2 个|2 interfaces available/)).toBeTruthy());
  return frames;
}

/** 点「关闭」并把 project.get 往返跑完；返回 project.get 的 requestId 使用情况。 */
async function closeWithProject(frames: unknown[], projectResult: unknown) {
  const user = userEvent.setup();
  act(() => {
    fireEvent.click(screen.getAllByRole("button", { name: /关闭|Close|Đóng/ }).pop()!);
  });
  await waitFor(() => expect(requestFrame(frames, "project.get")).toBeTruthy());
  const request = requestFrame(frames, "project.get");
  emitFromDirector({
    type: DIRECTOR_DESK_MESSAGE_TYPES.response,
    payload: {
      protocolVersion: 1,
      requestId: request.payload.requestId,
      action: "project.get",
      ok: true,
      data: projectResult,
    },
  });
  void user;
  return request;
}

beforeEach(() => {
  uploadFreezoneImage.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  useCanvasStore.setState({ nodes: [], edges: [], selectedNodeId: null });
  window.history.replaceState({}, "", `/projects/${PROJECT_ID}/freezone`);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.history.replaceState({}, "", "/");
});

describe("快照落库命名（纯函数）", () => {
  it("用节点 id + 时间戳，且以 .json 结尾", () => {
    expect(directorDeskProjectUploadName(NODE_ID, 42)).toBe(
      `director-desk-${NODE_ID}-project-42.json`,
    );
  });
});

describe("关闭节点 → 工程快照落项目资产", () => {
  it("project.get → JSON Blob 上传 → 引用写回 data.directorProjectRef", async () => {
    uploadFreezoneImage.mockResolvedValue({
      url: `/static/projects/${PROJECT_ID}/freezone/_uploads/director-desk-${NODE_ID}-project-1700000000000.json`,
      filename: "snap.json",
      size: 256,
    });

    await renderOpenNode();
    const frames = await handshake();
    await closeWithProject(frames, PROJECT_PAYLOAD);

    await waitFor(() => expect(storedData().directorProjectRef).toBeTruthy());
    const ref = storedData().directorProjectRef as string;

    // 1) 项目作用域 + JSON Blob（不是把工程 JSON 塞进节点 data）
    expect(uploadFreezoneImage.mock.calls[0][0]).toBe(PROJECT_ID);
    expect(uploadFreezoneImage.mock.calls[0][1]).toBeInstanceOf(Blob);
    expect((uploadFreezoneImage.mock.calls[0][1] as Blob).type).toBe("application/json");
    expect(uploadFreezoneImage.mock.calls[0][2]).toMatch(
      new RegExp(`^director-desk-${NODE_ID}-project-\\d+\\.json$`),
    );
    // 2) 节点 data 里只有 URL；工程 JSON 本体不进画布
    expect(ref).toContain(`/static/projects/${PROJECT_ID}/`);
    expect(JSON.stringify(storedData())).not.toContain("fnv1a32-cafebabe");
    // 3) 关窗完成，且成功后用户能看到落库确认
    await waitFor(() => expect(storedData().isOpen).toBe(false));
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("上传的 JSON 内容就是 project.get 的原样结果（导入器能读回同一工程）", async () => {
    uploadFreezoneImage.mockResolvedValue({
      url: `/static/projects/${PROJECT_ID}/freezone/_uploads/snap.json`,
      filename: "snap.json",
      size: 256,
    });
    await renderOpenNode();
    const frames = await handshake();
    await closeWithProject(frames, PROJECT_PAYLOAD);
    await waitFor(() => expect(uploadFreezoneImage).toHaveBeenCalledTimes(1));

    const blob = uploadFreezoneImage.mock.calls[0][1] as Blob;
    const text = await blob.text();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    // 导演台工程 schema 字段必须在（验收要求快照含 schemaVersion / 项目结构键）
    expect(parsed.protocolVersion).toBe(1);
    expect(parsed.projectSchemaVersion).toBe(1);
    expect(parsed.projectFingerprint).toBe("fnv1a32-cafebabe");
    expect(parsed.project).toMatchObject({ version: 1, activeCameraId: "c1" });
  });

  it("工程超过体积上限时跳过上传、不留引用，仍照常关窗", async () => {
    const huge = { ...PROJECT_PAYLOAD, blob: "x".repeat(DIRECTOR_DESK_SNAPSHOT_MAX_BYTES + 1) };
    await renderOpenNode();
    const frames = await handshake();
    await closeWithProject(frames, huge);

    await waitFor(() => expect(storedData().isOpen).toBe(false));
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
    expect(storedData().directorProjectRef).toBeNull();
    // 关窗后内联提示已随弹窗卸载，所以断言 toast —— 用户实际看得见的那条。
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(String(toastError.mock.calls[0][0])).toMatch(/工程过大|too large|quá lớn/);
  });

  it("存档失败（上传报错）不阻断关窗，只给可读提示", async () => {
    uploadFreezoneImage.mockRejectedValue(new Error("upload boom"));
    await renderOpenNode();
    const frames = await handshake();
    await closeWithProject(frames, PROJECT_PAYLOAD);

    await waitFor(() => expect(storedData().isOpen).toBe(false));
    expect(storedData().directorProjectRef).toBeNull();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(String(toastError.mock.calls[0][0])).toContain("upload boom");
  });

  it("桥还没 ready 就关窗：不发 project.get，直接关", async () => {
    await renderOpenNode();
    const frames: unknown[] = [];
    installFrameRecorder(frames);
    // 不握手，直接关
    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: /关闭|Close|Đóng/ }).pop()!);
    });
    await waitFor(() => expect(storedData().isOpen).toBe(false));
    expect(frames.filter((f) => (f as { payload?: { action?: string } }).payload?.action === "project.get")).toHaveLength(0);
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
  });
});

describe("重开节点 → 工程回灌", () => {
  it("有快照引用时：校验快照 + 发出带 instanceId 的 session 回灌动作", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => PROJECT_PAYLOAD,
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderOpenNode({ directorProjectRef: SNAPSHOT_REF });
    const frames = await handshake();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(SNAPSHOT_REF, expect.anything()));
    // 回灌动作：session 带上本节点的 instanceId（= 画布 nodeId），导演台据此激活同一工程
    expect(sessionFrames(frames)).toEqual([{ instanceId: NODE_ID, theme: "dark" }]);
    // 快照可用 → 不出现降级提示
    expect(screen.queryByText(/快照不可用|snapshot unavailable|Không có bản chụp/)).toBeNull();
  });

  it("没有快照引用时也发 session（同一节点重开回到同一工程的机制）", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await renderOpenNode({ directorProjectRef: null });
    const frames = await handshake();
    expect(sessionFrames(frames)).toEqual([{ instanceId: NODE_ID, theme: "dark" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("快照 404 时降级：不抛未捕获异常、给非阻塞提示、节点照常可用", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.error ?? event.message);
    window.addEventListener("error", onError);

    await renderOpenNode({ directorProjectRef: SNAPSHOT_REF });
    const frames = await handshake();

    await waitFor(() =>
      expect(screen.getByText(/快照不可用|snapshot unavailable|Không có bản chụp/)).toBeTruthy(),
    );
    // 仍然可用：握手完成、能力已在、受控按钮照常渲染
    expect(sessionFrames(frames)).toEqual([{ instanceId: NODE_ID, theme: "dark" }]);
    expect(screen.getByRole("button", { name: /读取工程|Read project/ })).toBeTruthy();
    expect(document.querySelector("iframe")).not.toBeNull();
    expect(errors).toEqual([]);
    window.removeEventListener("error", onError);
  });

  it("快照内容不是对象（损坏的 JSON）时同样降级而不是崩", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => 42 });
    vi.stubGlobal("fetch", fetchMock);
    await renderOpenNode({ directorProjectRef: SNAPSHOT_REF });
    await handshake();
    await waitFor(() =>
      expect(screen.getByText(/快照不可用|snapshot unavailable|Không có bản chụp/)).toBeTruthy(),
    );
    expect(document.querySelector("iframe")).not.toBeNull();
  });

  it("网络异常（fetch reject）也是降级，不是未捕获拒绝", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    await renderOpenNode({ directorProjectRef: SNAPSHOT_REF });
    await handshake();
    await waitFor(() =>
      expect(screen.getByText(/快照不可用|snapshot unavailable|Không có bản chụp/)).toBeTruthy(),
    );
  });
});

describe("instanceId 隔离", () => {
  it("iframe 的 instanceId 就是画布 nodeId，两个节点各自独立", async () => {
    await renderOpenNode();
    const params = new URLSearchParams((iframeEl().getAttribute("src") ?? "").split("?")[1]);
    expect(params.get("instanceId")).toBe(NODE_ID);
  });

  it("两个导演台节点同开：各自 instanceId、各自 session，互不串扰", async () => {
    const SECOND = "node_director_desk_project_b";
    useCanvasStore.setState({
      nodes: [
        { id: NODE_ID, type: "directorDeskNode", position: { x: 0, y: 0 }, data: defaultData() },
        { id: SECOND, type: "directorDeskNode", position: { x: 600, y: 0 }, data: defaultData() },
      ] as never,
      edges: [],
      selectedNodeId: null,
    } as never);

    const Harness = ({ nodeId }: { nodeId: string }) => {
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
    };

    render(
      <>
        <Harness nodeId={NODE_ID} />
        <Harness nodeId={SECOND} />
      </>,
    );
    // 两个节点都处于打开态（store 里各自 isOpen）
    act(() => {
      useCanvasStore.getState().updateNodeData(NODE_ID, { isOpen: true });
      useCanvasStore.getState().updateNodeData(SECOND, { isOpen: true });
    });
    await waitFor(() => expect(document.querySelectorAll("iframe")).toHaveLength(2));

    const iframes = Array.from(document.querySelectorAll("iframe"));
    const instanceIds = iframes.map(
      (frame) => new URLSearchParams((frame.getAttribute("src") ?? "").split("?")[1]).get("instanceId"),
    );
    expect(new Set(instanceIds)).toEqual(new Set([NODE_ID, SECOND]));

    // 两条桥各自只认自己 iframe 的 source：A 的 ready 只让 A 发 session
    const sent: Array<{ instanceId?: string }> = [];
    for (const frame of iframes) {
      const cw = frame.contentWindow;
      if (!cw) continue;
      const original = cw.postMessage.bind(cw);
      (cw as unknown as { postMessage: unknown }).postMessage = (message: unknown) => {
        const candidate = message as { type?: string; payload?: { instanceId?: string } };
        if (candidate.type === DIRECTOR_DESK_MESSAGE_TYPES.session && candidate.payload?.instanceId) {
          sent.push({ instanceId: candidate.payload.instanceId });
        }
        return original(message as never, "*");
      };
    }

    const firstFrame = iframes[0];
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: DIRECTOR_DESK_MESSAGE_TYPES.ready },
          origin: window.location.origin,
          source: firstFrame.contentWindow as unknown as MessageEventSource,
        }),
      );
    });

    await waitFor(() => expect(sent).toHaveLength(1));
    // 只有 A 的 instanceId，B 不受影响
    expect(sent).toEqual([{ instanceId: instanceIds[0] }]);
  });
});
