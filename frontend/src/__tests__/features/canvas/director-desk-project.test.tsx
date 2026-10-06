// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * DirectorDeskNode 阶段 6：工程快照的落库、回灌与失效降级。
 *
 * 被测单元是**已交付的**组件与 store 装配（真实导出路径）。只把两个 I/O 边界替掉：
 * 上传调用（`@/api/ops`）与快照读取（`global.fetch`）。落库命名、JSON 序列化与体积
 * 上限、`directorProjectRef` 回写、`project.load` 回灌、404 降级分支全部跑真实代码。
 *
 * ── v2（T003 起）对照：被本文件取代的 v1 断言 ──────────────────────────────
 * 换子应用（`mangfufu/director-desk`）之后，宿主**不再问子应用要工程**，也不再自己
 * 序列化它：
 *
 *   v1  宿主 → `project.get` 拉回整份工程 → 宿主 JSON.stringify → 上传
 *   v1  宿主 → `session {instanceId}` 让子应用激活自己那份 localStorage 工程
 *
 *   v2  宿主 → `tool.call {director_export, kind:'project'}` 让子应用跑它自己的保存流程
 *       子应用 → `files('save-project')` → 反过来请宿主落盘（`project.save`，
 *               **child-to-host** 方向）→ 宿主上传并写 `directorProjectRef`
 *       宿主回执给子应用 → 子应用把 tool.call 的结果回给宿主
 *   v2  宿主 → `project.load {document}` 把 `.director` 原文推回子应用的导入入口
 *
 * 所以本文件里凡是断言 `project.get` 回包被上传、或是断言发出 `session` 帧的地方，
 * 都是 v1 语义，已按上面这条链路重写。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirectorDeskNodeData } from "@/features/canvas/domain/canvasNodes";
import {
  DirectorDeskNode,
  DIRECTOR_DESK_SNAPSHOT_MAX_BYTES,
  directorDeskProjectUploadName,
} from "@/features/canvas/nodes/DirectorDeskNode";
import { DIRECTOR_DESK_MESSAGE_TYPES } from "@/features/canvas/nodes/directorDeskBridge";
import { getDirectorDeskV2Session } from "@/features/canvas/nodes/directorDeskV2Session";
import { useCanvasStore } from "@/stores/canvasStore";

const uploadFreezoneImage = vi.fn();
/** 工程与封面共用上传 API，在边界按文件名分开控制，保留两条链路的真实等待。 */
const uploadPreview = vi.fn();
vi.mock("@/api/ops", () => ({
  uploadFreezoneImage: (...args: unknown[]) =>
    String(args[2]).endsWith(".jpg") ? uploadPreview(...args) : uploadFreezoneImage(...args),
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
const CAPABILITIES = { protocolVersion: 2, actions: ["capabilities.get", "tool.call"] };
/** v2 子应用自报的协议版本（vendor/director-desk/src/host-bridge.ts 的 PROTOCOL_VERSION）。 */
const CHILD_PROTOCOL_VERSION = 2;
const SNAPSHOT_REF = `/static/projects/${PROJECT_ID}/freezone/_uploads/director-desk-${NODE_ID}-project-1.json?st_v=1`;
/** 相同长度、不同内容的两帧，复现旧的 length 指纹漏更新。 */
const PREVIEW_A = "data:image/jpeg;base64,YQ==";
const PREVIEW_B = "data:image/jpeg;base64,Yg==";
let previewDataUrl = PREVIEW_A;

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
    const request = message as { type?: string; payload?: { requestId: string; action: string; options?: { name?: string } } };
    if (request.type === DIRECTOR_DESK_MESSAGE_TYPES.request) {
      const payload = request.payload!;
      const data = payload.action === "preview.capture"
        ? { dataUrl: previewDataUrl, width: 640, height: 360 }
        : payload.action === "ai.describe"
          ? { contract: { definitions: [] } }
          : payload.action === "agent.event"
            ? {}
        : payload.action === "tool.call" && payload.options?.name === "director_read"
          ? { revision: 7, result: { entities: [{ id: "camera-1", kind: "camera" }] } }
          : undefined;
      if (data) queueMicrotask(() => emitFromDirector({
        type: DIRECTOR_DESK_MESSAGE_TYPES.response,
        payload: { protocolVersion: CHILD_PROTOCOL_VERSION, requestId: payload.requestId, action: payload.action, ok: true, data },
      }));
    }
    return originalPost(message as never, "*");
  };
}

interface RequestFrame {
  payload: { requestId: string; action: string; options?: Record<string, unknown> };
}

function requestFrame(frames: unknown[], action: string): RequestFrame {
  const frame = frames.find((f) => {
    const candidate = f as { type?: string; payload?: { action?: string } };
    return (
      candidate.type === DIRECTOR_DESK_MESSAGE_TYPES.request && candidate.payload?.action === action
    );
  });
  if (!frame) throw new Error(`no request frame for ${action}`);
  return frame as RequestFrame;
}

function requestActions(frames: unknown[]): string[] {
  return frames
    .filter((f) => (f as { type?: string }).type === DIRECTOR_DESK_MESSAGE_TYPES.request)
    .map((f) => String((f as { payload?: { action?: string } }).payload?.action ?? ""));
}

interface ResponseFrame {
  payload: { requestId: string; action: string; ok: boolean; data?: unknown; error?: { code: string; message: string } };
}

function responseFrame(frames: unknown[], requestId: string): ResponseFrame {
  const frame = frames.find((f) => {
    const candidate = f as { type?: string; payload?: { requestId?: string } };
    return (
      candidate.type === DIRECTOR_DESK_MESSAGE_TYPES.response &&
      candidate.payload?.requestId === requestId
    );
  });
  if (!frame) throw new Error(`no response frame for requestId ${requestId}`);
  return frame as ResponseFrame;
}

/**
 * v1 的 `session` 回灌帧。**v2 起宿主一次都不发它**：工程改存在子应用自己的 IndexedDB
 * 里，宿主没有它的存储可指，回灌走 `project.load`。留着这个函数是为了让"不该再有
 * session 帧"成为一条可断言的事实。
 */
function sessionFrames(frames: unknown[]): Array<{ instanceId?: string; theme?: string }> {
  return frames
    .filter((f) => (f as { type?: string }).type === DIRECTOR_DESK_MESSAGE_TYPES.session)
    .map((f) => (f as { payload?: { instanceId?: string; theme?: string } }).payload ?? {});
}

/** 握手到 connected；返回帧记录器。 */
async function handshake() {
  const frames: unknown[] = [];
  installFrameRecorder(frames);
  emitFromDirector({
    type: DIRECTOR_DESK_MESSAGE_TYPES.ready,
    payload: { protocolVersion: CHILD_PROTOCOL_VERSION, nodeId: NODE_ID },
  });
  await waitFor(() => expect(requestFrame(frames, "capabilities.get")).toBeTruthy());
  emitFromDirector({
    type: DIRECTOR_DESK_MESSAGE_TYPES.response,
    payload: {
      protocolVersion: CHILD_PROTOCOL_VERSION,
      requestId: requestFrame(frames, "capabilities.get").payload.requestId,
      action: "capabilities.get",
      ok: true,
      data: CAPABILITIES,
    },
  });
  await waitFor(() => expect(screen.getByText(/可用接口 2 个|2 interfaces available/)).toBeTruthy());
  return frames;
}

/** 点「关闭」，等宿主把子应用的保存流程**发起**（`tool.call{director_export}`）。 */
async function closeAndStartSave(frames: unknown[]): Promise<string> {
  act(() => {
    fireEvent.click(screen.getAllByRole("button", { name: /关闭|Close|Đóng/ }).pop()!);
  });
  await waitFor(() => expect(requestFrame(frames, "tool.call")).toBeTruthy());
  const toolCall = requestFrame(frames, "tool.call");
  // 宿主不再自己去拉工程：v1 的 project.get 往返已被 tool.call 取代。
  expect(toolCall.payload.options).toMatchObject({
    name: "director_export",
    args: { kind: "project" },
  });
  expect(requestActions(frames)).not.toContain("project.get");
  expect(sessionFrames(frames)).toEqual([]);
  return toolCall.payload.requestId;
}

/**
 * 子应用跑完保存流程后反过来请宿主落盘（`files('save-project')` → child-to-host 的
 * `project.save`）。等宿主的回执帧出现再返回，好让调用方接着发 tool.call 的结果。
 */
async function childAsksHostToSave(
  frames: unknown[],
  content: string,
  requestId = `child-save-${content.length}`,
): Promise<string> {
  emitFromDirector({
    type: DIRECTOR_DESK_MESSAGE_TYPES.request,
    payload: {
      protocolVersion: CHILD_PROTOCOL_VERSION,
      requestId,
      action: "project.save",
      options: { kind: "project", name: "project.director", content },
    },
  });
  await waitFor(() => expect(responseFrame(frames, requestId)).toBeTruthy());
  return requestId;
}

/** 子应用把 `toolService.call` 的信封回给宿主。失败时子应用会如实回 ok:false。 */
async function replyToolCall(
  requestId: string,
  outcome: { ok: true } | { ok: false; message: string } = { ok: true },
) {
  emitFromDirector({
    type: DIRECTOR_DESK_MESSAGE_TYPES.response,
    payload: {
      protocolVersion: CHILD_PROTOCOL_VERSION,
      requestId,
      action: "tool.call",
      ok: outcome.ok,
      ...(outcome.ok
        ? { data: { revision: 7, result: { saved: true } } }
        : { error: { code: "director_desk_v2_error", message: outcome.message } }),
    },
  });
}

beforeEach(() => {
  uploadFreezoneImage.mockReset();
  uploadPreview.mockReset().mockImplementation(async (_project, _blob, filename) => ({
    url: `/static/projects/${PROJECT_ID}/freezone/_uploads/${filename}`,
    filename,
  }));
  previewDataUrl = PREVIEW_A;
  toastError.mockReset();
  toastSuccess.mockReset();
  useCanvasStore.setState({ nodes: [], edges: [], selectedNodeId: null });
  window.history.replaceState({}, "", `/projects/${PROJECT_ID}/freezone`);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
  it("tool.call{director_export} → 子应用回请 project.save → JSON Blob 上传 → 引用写回 data.directorProjectRef", async () => {
    uploadFreezoneImage.mockResolvedValue({
      url: `/static/projects/${PROJECT_ID}/freezone/_uploads/director-desk-${NODE_ID}-project-1700000000000.json`,
      filename: "snap.json",
      size: 256,
    });

    await renderOpenNode();
    const frames = await handshake();
    const content = JSON.stringify(PROJECT_PAYLOAD);

    const toolCallId = await closeAndStartSave(frames);
    const saveId = await childAsksHostToSave(frames, content);
    // 宿主的回执如实反映上传结果（子应用正卡在 await 上等它）。
    expect(responseFrame(frames, saveId).payload).toMatchObject({
      ok: true,
      data: { saved: true, url: expect.stringContaining(`/static/projects/${PROJECT_ID}/`) },
    });
    await replyToolCall(toolCallId);

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

  it("上传的字节就是子应用交回来的 .director 原文（宿主不复述工程结构）", async () => {
    uploadFreezoneImage.mockResolvedValue({
      url: `/static/projects/${PROJECT_ID}/freezone/_uploads/snap.json`,
      filename: "snap.json",
      size: 256,
    });
    await renderOpenNode();
    const frames = await handshake();
    const toolCallId = await closeAndStartSave(frames);
    await childAsksHostToSave(frames, JSON.stringify(PROJECT_PAYLOAD));
    await waitFor(() => expect(uploadFreezoneImage).toHaveBeenCalledTimes(1));
    await replyToolCall(toolCallId);

    const blob = uploadFreezoneImage.mock.calls[0][1] as Blob;
    // 逐字节相等：v2 的工程 schema 由上游定义，宿主序列化一遍就是第二份会漂移的实现。
    expect(await blob.text()).toBe(JSON.stringify(PROJECT_PAYLOAD));
    // 仍然是一份导入器读得回来的工程文档（验收要求快照含 schemaVersion / 项目结构键）。
    const parsed = JSON.parse(await blob.text()) as Record<string, unknown>;
    expect(parsed.projectSchemaVersion).toBe(1);
    expect(parsed.projectFingerprint).toBe("fnv1a32-cafebabe");
    expect(parsed.project).toMatchObject({ version: 1, activeCameraId: "c1" });
  });

  it("工程超过体积上限时跳过上传、不留引用，并保留编辑器让用户重试", async () => {
    await renderOpenNode();
    const frames = await handshake();
    const content = "x".repeat(DIRECTOR_DESK_SNAPSHOT_MAX_BYTES + 1);

    const toolCallId = await closeAndStartSave(frames);
    const saveId = await childAsksHostToSave(frames, content);
    await waitFor(() => expect(responseFrame(frames, saveId).payload.ok).toBe(false));
    await replyToolCall(toolCallId, { ok: false, message: "工程过大" });

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(storedData().isOpen).toBe(true);
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
    expect(storedData().directorProjectRef).toBeNull();
    expect(document.querySelector("iframe")).not.toBeNull();
    expect(String(toastError.mock.calls[0][0])).toMatch(/工程过大|too large|quá lớn/);
  });

  it("存档失败（上传报错）保留编辑器和内存改动，给出可读提示", async () => {
    uploadFreezoneImage.mockRejectedValue(new Error("upload boom"));
    await renderOpenNode();
    const frames = await handshake();

    const toolCallId = await closeAndStartSave(frames);
    const saveId = await childAsksHostToSave(frames, JSON.stringify(PROJECT_PAYLOAD));
    // 宿主把失败如实回给子应用（不是空壳成功），子应用据此把工具调用回成 ok:false。
    expect(responseFrame(frames, saveId).payload).toMatchObject({
      ok: false,
      error: { code: "host_save_failed", message: "upload boom" },
    });
    await replyToolCall(toolCallId, { ok: false, message: "upload boom" });

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(storedData().isOpen).toBe(true);
    expect(storedData().directorProjectRef).toBeNull();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(String(toastError.mock.calls[0][0])).toContain("upload boom");
  });

  it("相同长度的新画面仍更新封面，且新封面上传完成前不能关闭", async () => {
    uploadFreezoneImage.mockResolvedValue({ url: SNAPSHOT_REF });
    await renderOpenNode();
    const frames = await handshake();
    await waitFor(() => expect(storedData().previewImageUrl).toBeTruthy());
    const oldPreview = storedData().previewImageUrl;
    expect(PREVIEW_A.length).toBe(PREVIEW_B.length);
    previewDataUrl = PREVIEW_B;

    let finishPreview!: (value: { url: string }) => void;
    uploadPreview.mockImplementationOnce(() => new Promise(resolve => { finishPreview = resolve; }));
    const toolCallId = await closeAndStartSave(frames);
    const saveTask = childAsksHostToSave(frames, JSON.stringify(PROJECT_PAYLOAD), "pending-preview-save");
    await waitFor(() => expect(uploadPreview).toHaveBeenCalledTimes(2));
    expect(storedData().isOpen).toBe(true);
    expect(storedData().previewImageUrl).toBe(oldPreview);
    expect(frames.some(frame => (frame as ResponseFrame).payload?.requestId === "pending-preview-save"
      && (frame as { type?: string }).type === DIRECTOR_DESK_MESSAGE_TYPES.response)).toBe(false);

    await act(async () => { finishPreview({ url: `/static/projects/${PROJECT_ID}/latest-shot.jpg` }); });
    await saveTask;
    await replyToolCall(toolCallId);
    await waitFor(() => expect(storedData().isOpen).toBe(false));
    expect(storedData().previewImageUrl).toContain("/latest-shot.jpg");
    expect(storedData().previewImageUrl).not.toBe(oldPreview);
  });

  it("工程已上传但封面上传失败时保留窗口，不能假报全部同步成功", async () => {
    uploadFreezoneImage.mockResolvedValue({ url: SNAPSHOT_REF });
    await renderOpenNode();
    const frames = await handshake();
    await waitFor(() => expect(storedData().previewImageUrl).toBeTruthy());
    const oldPreview = storedData().previewImageUrl;
    previewDataUrl = PREVIEW_B;
    uploadPreview.mockRejectedValueOnce(new Error("preview upload failed"));

    const toolCallId = await closeAndStartSave(frames);
    const saveId = await childAsksHostToSave(frames, JSON.stringify(PROJECT_PAYLOAD));
    expect(responseFrame(frames, saveId).payload).toMatchObject({ ok: true, data: { saved: true, previewSynced: false } });
    await replyToolCall(toolCallId);
    await waitFor(() => expect(toastError).toHaveBeenCalledOnce());
    expect(storedData().isOpen).toBe(true);
    expect(storedData().directorProjectRef).toBeTruthy();
    expect(storedData().previewImageUrl).toBe(oldPreview);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(String(toastError.mock.calls[0][0])).toMatch(/工程已保存|project was saved|Dự án đã được lưu/);
  });

  it("等待保存期间重复点击关闭只发起一次工程保存", async () => {
    uploadFreezoneImage.mockResolvedValue({ url: SNAPSHOT_REF });
    await renderOpenNode();
    const frames = await handshake();
    const toolCallId = await closeAndStartSave(frames);
    act(() => fireEvent.click(screen.getAllByRole("button", { name: /关闭|Close|Đóng/ }).pop()!));
    const exports = frames.filter(frame => {
      const candidate = frame as RequestFrame;
      return candidate.payload?.action === "tool.call" && candidate.payload.options?.name === "director_export";
    });
    expect(exports).toHaveLength(1);
    await childAsksHostToSave(frames, JSON.stringify(PROJECT_PAYLOAD));
    await replyToolCall(toolCallId);
    await waitFor(() => expect(storedData().isOpen).toBe(false));
  });

  it("桥还没 ready 就关窗：不发起任何保存流程，直接关", async () => {
    await renderOpenNode();
    const frames: unknown[] = [];
    installFrameRecorder(frames);
    // 不握手，直接关
    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: /关闭|Close|Đóng/ }).pop()!);
    });
    await waitFor(() => expect(storedData().isOpen).toBe(false));
    expect(requestActions(frames)).toEqual([]);
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
  });
});

describe("新节点 AI 提交后自动保存", () => {
  it("会话建立后能收到提交事件，预检不保存，实际提交在静默期结束后落盘", async () => {
    let publish!: (response: Response) => void;
    const response = (data: unknown) => new Response(JSON.stringify(data), {
      status: 200, headers: { "content-type": "application/json" },
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).endsWith("/ai/session")) return response({ sessionId: "new-node-auto-save" });
      if (String(url).endsWith("/ai/poll")) return new Promise<Response>(resolve => { publish = resolve; });
      return response({ ok: true, data: { episode: 1, episodes: [1], beats: [], selected: null, context: "" } });
    }));
    uploadFreezoneImage.mockResolvedValue({ url: SNAPSHOT_REF });
    // 此时组件先挂载，iframe 会话尚不存在；不能在渲染前偷偷注册会话来绕过真实生命周期。
    await renderOpenNode();
    const frames = await handshake();
    await waitFor(() => expect(storedData().previewImageUrl).toBeTruthy());
    await act(async () => { await getDirectorDeskV2Session(NODE_ID)!.startAgent(); });
    // 刻意不回复技能刷新通知，验证工具轮询不依赖界面通知的确认。
    expect(requestActions(frames)).toContain("skills.sync");
    expect(publish).toBeTypeOf("function");
    const exports = () => frames.filter(frame => {
      const request = frame as RequestFrame;
      return request.payload?.action === "tool.call" && request.payload.options?.name === "director_export";
    }) as RequestFrame[];

    vi.useFakeTimers();
    await act(async () => {
      publish(response({ events: [{ type: "tool", name: "director_apply", status: "completed",
        summary: { preview: true, committed: false, summary: { hasChanges: true } } }] }));
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(exports()).toHaveLength(0);
    expect(uploadFreezoneImage).not.toHaveBeenCalled();

    await act(async () => {
      publish(response({ events: [{ type: "tool", name: "director_apply", status: "completed",
        summary: { preview: false, committed: true, summary: { hasChanges: true } } }, { type: "done" }] }));
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(exports()).toHaveLength(1);
    vi.useRealTimers();
    await childAsksHostToSave(frames, JSON.stringify(PROJECT_PAYLOAD));
    await replyToolCall(exports()[0].payload.requestId);
    await waitFor(() => expect(storedData().directorProjectRef).toBeTruthy());
    expect(uploadFreezoneImage).toHaveBeenCalledOnce();
    expect(storedData().errorMessage ?? null).toBeNull();
    expect(storedData().isOpen).toBe(true);
  });
});

describe("重开节点 → 工程回灌", () => {
  it("有快照引用时：fetch 快照 → 把 .director 原文交给 project.load 推回子应用", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => PROJECT_PAYLOAD,
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderOpenNode({ directorProjectRef: SNAPSHOT_REF });
    const frames = await handshake();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(SNAPSHOT_REF, expect.anything()));
    // v2 回灌走 project.load，document 是快照原文（v1 那条带 instanceId 的 session 帧没有了）。
    const load = requestFrame(frames, "project.load");
    expect((load.payload.options as { document: string }).document).toBe(
      JSON.stringify(PROJECT_PAYLOAD),
    );
    expect(sessionFrames(frames)).toEqual([]);

    // 导入尚未结束时不得抓初始化封面；真实导入完成后才接通节点。
    expect(requestActions(frames)).not.toContain("preview.capture");
    emitFromDirector({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: {
        protocolVersion: CHILD_PROTOCOL_VERSION,
        requestId: load.payload.requestId,
        action: "project.load",
        ok: true,
        data: { loaded: true },
      },
    });

    // 快照可用 → 不出现降级提示
    await waitFor(() => expect(requestActions(frames)).toContain("preview.capture"));
    await waitFor(() =>
      expect(screen.queryByText(/快照加载失败|snapshot failed to load|Không tải được bản chụp/)).toBeNull(),
    );
    // 回灌不得反过来改写节点字段（那是保存方向的写路径）
    expect(storedData().directorProjectRef).toBe(SNAPSHOT_REF);
    expect(storedData().errorMessage ?? null).toBeNull();
  });

  it("没有快照引用时不发起回灌（v1 靠 session 复用本地工程，v2 换成 project.load）", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await renderOpenNode({ directorProjectRef: null });
    const frames = await handshake();
    expect(requestActions(frames)).not.toContain("project.load");
    expect(sessionFrames(frames)).toEqual([]);
    // 弹窗打开会读一次项目分镜（`/director-desk/storyboard`）——那是取「第 N 场戏」
    // 的依据，与工程回灌无关。这条用例要断的是**没有 directorProjectRef 就不发起
    // 工程回灌**，上面那两行（`project.load` 不在请求里、`session` 为空）已经断到了，
    // 所以这里不该再断言整个 fetch 一次没发——那会把「读了分镜」也判成回归。
    const projectLoadCalls = fetchMock.mock.calls.filter(([, init]) =>
      String((init as RequestInit | undefined)?.body ?? "").includes("project.load"),
    );
    expect(projectLoadCalls).toHaveLength(0);
    // 没有快照只是不回灌，不影响握手与能力
    expect(screen.getByRole("button", { name: /保存工程|Save project/ })).toBeTruthy();
  });

  it("快照 404 时降级：不抛未捕获异常、不推空文档、给非阻塞提示、节点照常可用", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.error ?? event.message);
    window.addEventListener("error", onError);

    await renderOpenNode({ directorProjectRef: SNAPSHOT_REF });
    const frames = await handshake();

    await waitFor(() =>
      expect(screen.getByText(/快照加载失败|snapshot failed to load|Không tải được bản chụp/)).toBeTruthy(),
    );
    // 关键：拿不到快照就**不能**把空文档推给子应用（那等于把用户的工程清空）。
    expect(requestActions(frames)).not.toContain("project.load");
    // 仍然可用：握手完成、能力已在、受控按钮照常渲染
    expect(sessionFrames(frames)).toEqual([]);
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
      expect(screen.getByText(/快照加载失败|snapshot failed to load|Không tải được bản chụp/)).toBeTruthy(),
    );
    expect(document.querySelector("iframe")).not.toBeNull();
  });

  it("网络异常（fetch reject）也是降级，不是未捕获拒绝", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    await renderOpenNode({ directorProjectRef: SNAPSHOT_REF });
    await handshake();
    await waitFor(() =>
      expect(screen.getByText(/快照加载失败|snapshot failed to load|Không tải được bản chụp/)).toBeTruthy(),
    );
  });
});

describe("node_id 隔离（v2 参数名）", () => {
  it("iframe 的 node_id 就是画布 nodeId", async () => {
    await renderOpenNode();
    const params = new URLSearchParams((iframeEl().getAttribute("src") ?? "").split("?")[1]);
    expect(params.get("node_id")).toBe(NODE_ID);
    // v1 的 instanceId 不再传（v2 子应用只读 node_id）
    expect(params.get("instanceId")).toBeNull();
  });

  it("两个导演台节点同开：各自 node_id；A 的 ready 只让 A 开口，B 一声不吭", async () => {
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
    const ids = iframes.map(
      (frame) => new URLSearchParams((frame.getAttribute("src") ?? "").split("?")[1]).get("node_id"),
    );
    expect(new Set(ids)).toEqual(new Set([NODE_ID, SECOND]));

    // 两条桥各自只认自己 iframe 的 source：A 的 ready 只让 A 发帧。
    const posts = new Map<HTMLIFrameElement, unknown[]>();
    for (const frame of iframes) {
      const bucket: unknown[] = [];
      posts.set(frame, bucket);
      const cw = frame.contentWindow;
      if (!cw) continue;
      const original = cw.postMessage.bind(cw);
      (cw as unknown as { postMessage: unknown }).postMessage = (message: unknown) => {
        bucket.push(message);
        return original(message as never, "*");
      };
    }

    const firstFrame = iframes[0];
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: DIRECTOR_DESK_MESSAGE_TYPES.ready,
            payload: { protocolVersion: CHILD_PROTOCOL_VERSION, nodeId: ids[0] },
          },
          origin: window.location.origin,
          source: firstFrame.contentWindow as unknown as MessageEventSource,
        }),
      );
    });

    await waitFor(() =>
      expect(requestActions(posts.get(firstFrame) ?? [])).toContain("capabilities.get"),
    );
    // B 没有握手过，一条帧都不该有
    expect(posts.get(iframes[1])).toEqual([]);
  });
});
