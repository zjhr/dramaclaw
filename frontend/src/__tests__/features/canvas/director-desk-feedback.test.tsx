// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 用户反馈的三个问题，逐条锁住：
 *
 * 1. 割裂感 —— 画布上游接进来的 360° 全景必须真的进到导演台场景里，
 *    而不是接了一根死线；并且弹窗里要看得出上游接了什么。
 * 2. 没有保存按钮 —— 有可点的「保存工程」，有进度，存完标签带上存档时间。
 * 3. 没有同步到节点小图 —— 封面 = 最近一次产物，截图回传后必须立刻变。
 *
 * 仍然只替掉网络边界（`@/api/ops`、`fetch`）与图片解码，其余走真实代码。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirectorDeskNodeData } from "@/features/canvas/domain/canvasNodes";
import {
  DirectorDeskNode,
  DIRECTOR_DESK_SAVE_TIMEOUT_MS,
  directorDeskPanoramaSource,
  directorDeskSnapshotSavedAt,
} from "@/features/canvas/nodes/DirectorDeskNode";
import {
  DIRECTOR_DESK_MESSAGE_TYPES,
  type DirectorDeskAction,
} from "@/features/canvas/nodes/directorDeskBridge";
import {
  DIRECTOR_DESK_PANORAMA_MAX_BYTES,
  directorDeskPanoramaEntityId,
} from "@/features/canvas/nodes/directorDeskV2Session";
import { useCanvasStore } from "@/stores/canvasStore";

const uploadFreezoneImage = vi.fn();
const uploadPreview = vi.fn();
vi.mock("@/api/ops", () => ({
  uploadFreezoneImage: (...args: unknown[]) =>
    String(args[2]).endsWith(".jpg") ? uploadPreview(...args) : uploadFreezoneImage(...args),
  uploadFreezoneVideo: vi.fn(),
}));

/** 全景链路的图片字节。测试里只关心「有可读字节」，不追求是一张真 PNG。 */
const PANORAMA_BODY = "scene panorama bytes";

function panoramaResponse(body = PANORAMA_BODY, type = "image/png"): Response {
  const bytes = new TextEncoder().encode(body);
  return new Response(bytes, { status: 200, headers: { "content-type": type } });
}

/** 替掉全局 fetch：全景图下载的那一次。默认给一张合法 PNG。 */
function stubPanoramaFetch(make: () => Response = () => panoramaResponse()) {
  const fetchMock = vi.fn().mockImplementation(async () => make());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

vi.mock("@/features/canvas/application/imageData", async () => {
  const actual = await vi.importActual<typeof import("@/features/canvas/application/imageData")>(
    "@/features/canvas/application/imageData",
  );
  return {
    ...actual,
    loadImageElement: async () => ({ naturalWidth: 1280, naturalHeight: 720 }),
  };
});

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
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

const DESK = "feedback_desk";
const UPSTREAM_IMG = "feedback_upstream_image";
const UPSTREAM_TEXT = "feedback_upstream_text";
const PROJECT_ID = "proj_feedback";
const CAPABILITIES = { protocolVersion: 2, actions: ["capabilities.get", "tool.call"] };
const PNG_DATA_URL = `data:image/png;base64,${btoa("png-bytes")}`;
const PANORAMA_URL = "/static/projects/proj_feedback/freezone/_uploads/scene-pano.png";

function deskData(overrides: Partial<DirectorDeskNodeData> = {}): DirectorDeskNodeData {
  return {
    displayName: "3D 导演台",
    isOpen: false,
    directorProjectRef: null,
    videoUrl: null,
    previewImageUrl: null,
    ...overrides,
  };
}

/** 画布：按 `upstream` 声明把上游素材接到导演台节点上。 */
function seedCanvas(
  overrides: Partial<DirectorDeskNodeData> = {},
  upstream: { image?: boolean; text?: boolean } = { image: true },
) {
  const nodes: unknown[] = [
    {
      id: DESK,
      type: "directorDeskNode",
      position: { x: 400, y: 0 },
      data: deskData(overrides),
    },
  ];
  const edges: unknown[] = [];
  const connect = (sourceId: string) => {
    edges.push({
      id: `${sourceId}->${DESK}`,
      source: sourceId,
      target: DESK,
      sourceHandle: "source",
      targetHandle: "target",
      type: "disconnectableEdge",
    });
  };
  if (upstream.image) {
    nodes.push({
      id: UPSTREAM_IMG,
      type: "pano360ViewerNode",
      position: { x: 0, y: 0 },
      data: { displayName: "场景全景", imageUrl: PANORAMA_URL },
    });
    connect(UPSTREAM_IMG);
  }
  if (upstream.text) {
    nodes.push({
      id: UPSTREAM_TEXT,
      type: "textAnnotationNode",
      position: { x: 0, y: 300 },
      data: { displayName: "剧本", content: "雨夜，天台" },
    });
    connect(UPSTREAM_TEXT);
  }
  useCanvasStore.setState({ nodes, edges, selectedNodeId: DESK } as never);
}

function Harness() {
  const node = useCanvasStore((state) => state.nodes.find((n) => n.id === DESK));
  if (!node) return null;
  return (
    <DirectorDeskNode
      id={DESK}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {...({ type: "directorDeskNode", dragging: false, zIndex: 0 } as any)}
      data={node.data as DirectorDeskNodeData}
      selected
    />
  );
}

function iframeEl(): HTMLIFrameElement {
  const frame = document.querySelector("iframe");
  if (!frame) throw new Error("no iframe");
  return frame;
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
  const cw = iframeEl().contentWindow;
  if (!cw) throw new Error("no content window");
  const original = cw.postMessage.bind(cw);
  (cw as unknown as { postMessage: unknown }).postMessage = (message: unknown) => {
    frames.push(message);
    const frame = message as { type?: string; payload?: { requestId: string; action: string } };
    if (frame.type === DIRECTOR_DESK_MESSAGE_TYPES.request && frame.payload?.action === "preview.capture") {
      const requestId = frame.payload.requestId;
      queueMicrotask(() => emitFromDirector({
        type: DIRECTOR_DESK_MESSAGE_TYPES.response,
        payload: { protocolVersion: 2, requestId, action: "preview.capture", ok: true,
          data: { dataUrl: "data:image/jpeg;base64,YQ==", width: 640, height: 360 } },
      }));
    }
    return original(message as never, "*");
  };
}

function frameOfType(frames: unknown[], type: string) {
  return frames.filter((f) => (f as { type?: string }).type === type) as Array<{
    type: string;
    payload: Record<string, string>;
  }>;
}

function requestFrames(frames: unknown[], action: string) {
  return frames.filter((f) => {
    const candidate = f as { type?: string; payload?: { action?: string } };
    return (
      candidate.type === DIRECTOR_DESK_MESSAGE_TYPES.request && candidate.payload?.action === action
    );
  }) as Array<{
    type: string;
    payload: { requestId: string; action: string; options?: Record<string, unknown> };
  }>;
}

function responseFrames(frames: unknown[], requestId: string) {
  return frames.filter((f) => {
    const candidate = f as { type?: string; payload?: { requestId?: string } };
    return (
      candidate.type === DIRECTOR_DESK_MESSAGE_TYPES.response &&
      candidate.payload?.requestId === requestId
    );
  }) as Array<{
    type: string;
    payload: { ok: boolean; data?: { saved?: boolean; url?: string }; error?: { code: string; message: string } };
  }>;
}

/** 一次 `tool.call` 请求的形状。 */
interface ToolCallFrame {
  payload: {
    requestId: string;
    action: DirectorDeskAction;
    options?: { name?: string; args?: Record<string, unknown> };
  };
}

function toolCallFrames(frames: unknown[]): ToolCallFrame[] {
  return requestFrames(frames, "tool.call") as unknown as ToolCallFrame[];
}

/** 一次工具调用：工具名 + 参数，按发出顺序排。 */
export function toolCalls(frames: unknown[]) {
  return toolCallFrames(frames).map((frame) => ({
    requestId: frame.payload.requestId,
    name: String(frame.payload.options?.name ?? ""),
    args: (frame.payload.options?.args ?? {}) as Record<string, unknown>,
  }));
}

function answerToolCall(requestId: string, revision: number, result: unknown) {
  emitFromDirector({
    type: DIRECTOR_DESK_MESSAGE_TYPES.response,
    payload: {
      protocolVersion: 2,
      requestId,
      action: "tool.call",
      ok: true,
      data: { revision, result },
    },
  });
}

function failToolCall(requestId: string, message: string) {
  emitFromDirector({
    type: DIRECTOR_DESK_MESSAGE_TYPES.response,
    payload: {
      protocolVersion: 2,
      requestId,
      action: "tool.call",
      ok: false,
      error: { code: "director_desk_v2_error", message },
    },
  });
}

/**
 * 轮询已录到的帧，逐个回应未回过的 `tool.call`；返回停表函数。
 *
 * 宿主这边是「发一帧 → 等回包」串起来的，所以回应必须发生在帧录下之后。用轮询而不是
 * hook postMessage，是因为握手与能力查询的回包由各测试自己负责，职责不该混在一起。
 */
function serveToolCalls(
  frames: unknown[],
  handler: (call: { requestId: string; name: string; args: Record<string, unknown> }) => void,
): () => void {
  const answered = new Set<string>();
  const timer = setInterval(() => {
    for (const frame of toolCallFrames(frames)) {
      if (answered.has(frame.payload.requestId)) continue;
      // 先标记再回调：handler 会同步 emit 回包，重入时不能把同一帧再答一次。
      answered.add(frame.payload.requestId);
      handler({
        requestId: frame.payload.requestId,
        name: String(frame.payload.options?.name ?? ""),
        args: (frame.payload.options?.args ?? {}) as Record<string, unknown>,
      });
    }
  }, 4);
  return () => clearInterval(timer);
}

/** 上游 `service.ts` 的忙碌守卫原文（`idle()`）。命中即抛，不重试。 */
const UPSTREAM_BUSY_ERROR = '当前正在编辑、绘制或执行长任务，请等待或取消';

/**
 * 复刻上游 `media/source.ts:22-23` 的内容寻址 id。
 *
 * 假工具层必须用**真的** sha 派生资源 id，否则测不到宿主那条「这张图已经在工程里，
 * 别再导一遍」的短路 —— 用一个假的 id 的话宿主的预测永远对不上，测试等于没测那条路。
 *
 * 用 `node:crypto` 的同步版本而不是 `crypto.subtle`：这个假工具层要**同步**回话，
 * 异步回话会让宿主的 await 链跨过 `act()` 边界，测出来的是竞态不是链路。
 */
function upstreamResourceId(dataUrl: unknown): string {
  const [, payload = ''] = String(dataUrl).split(',');
  return `media-${createHash('sha256').update(Buffer.from(payload, 'base64')).digest('hex')}`;
}

/**
 * 一个会自己回话的 v2 子应用工具层，按上游 `service.ts` 的真实语义应答：
 *
 * - `director_media {action:'list'}` → `{revision, media}`
 * - `director_media {action:'import'}` → 校验 revision 与 requestId，回 `{revision, resourceId}`
 * - `director_read {ids}` → `{revision, entities, missingIds}`
 * - `director_apply` → 校验 revision，回 `{revision, committed}`
 *
 * 收据表按上游语义实现：同一个 `requestId` 配同样的参数返回缓存结果，换了参数则报
 * 「requestId 已用于不同操作」（`service.ts:65`）—— 这正是宿主每轮换新 requestId 的原因。
 *
 * import 成功会推进 revision（真实工程确实变了）。不这么建模的话，「revision 冲突后
 * 重试」这条测试就测不出真实行为：冲突之所以能重试，正是因为重读拿到的是新版本。
 */
function serveDirectorToolService(
  frames: unknown[],
  options: {
    startRevision?: number;
    entities?: Array<{ id: string; asset?: string }>;
    /** import 成功后让 revision 前进（默认开）。 */
    bumpOnImport?: boolean;
    /** 这些工具各注入几次 REVISION_CONFLICT。 */
    conflicts?: Record<string, number>;
    /** 这些工具直接报忙碌。 */
    busy?: string[];
    /** 媒体清单里已有的资源 id（用来验证宿主认得出「这张图已经在工程里」）。 */
    media?: Array<{ id: string }>;
    onImport?: (resourceId: string) => void;
  } = {},
): () => void {
  let revision = options.startRevision ?? 7;
  const conflicts = { ...(options.conflicts ?? {}) };
  const busy = new Set(options.busy ?? []);
  const media = [...(options.media ?? [])];
  const receipts = new Map<string, { args: string; result: unknown }>();
  let revisionRef = revision;

  return serveToolCalls(frames, ({ requestId, name, args }) => {
    revision = revisionRef;
    const settle = (result: unknown) => {
      revisionRef = revision;
      answerToolCall(requestId, revision, result);
    };
    const takeConflict = (): boolean => {
      const left = conflicts[name] ?? 0;
      if (left <= 0) return false;
      conflicts[name] = left - 1;
      return true;
    };
    if (busy.has(name)) {
      failToolCall(requestId, UPSTREAM_BUSY_ERROR);
      return;
    }
    if (takeConflict()) {
      failToolCall(
        requestId,
        `REVISION_CONFLICT：请求版本 ${String(args.revision)}，当前版本 ${revision + 1}；请重新读取工程`,
      );
      // 冲突时工程已经变了 —— 这是重试能成功的唯一原因。
      revision += 1;
      revisionRef = revision;
      return;
    }

    if (name === 'director_media' && args.action === 'list') {
      settle({ revision, media, runtime: {} });
      return;
    }
    if (name === 'director_media' && args.action === 'import') {
      if (typeof args.revision !== 'number' || args.revision !== revision) {
        failToolCall(
          requestId,
          `REVISION_CONFLICT：请求版本 ${String(args.revision)}，当前版本 ${revision}；请重新读取工程`,
        );
        return;
      }
      if (typeof args.requestId !== 'string' || !args.requestId) {
        failToolCall(requestId, '需要唯一 requestId');
        return;
      }
      const encoded = JSON.stringify({ name, revision: args.revision, args: args.data });
      const receipt = receipts.get(args.requestId);
      if (receipt) {
        if (receipt.args !== encoded) {
          failToolCall(requestId, 'requestId 已用于不同操作');
          return;
        }
        settle(receipt.result);
        return;
      }
      if (options.bumpOnImport !== false) revision += 1;
      const resourceId = upstreamResourceId(args.data);
      media.push({ id: resourceId });
      options.onImport?.(resourceId);
      const result = {
        revision,
        resourceId,
        name: args.name,
        width: 2048,
        height: 1024,
        duration: 0,
      };
      receipts.set(args.requestId, { args: encoded, result });
      settle(result);
      return;
    }
    if (name === 'director_read') {
      const ids = Array.isArray(args.ids) ? (args.ids as string[]) : null;
      const entities = (options.entities ?? []).filter(
        (entity) => !ids || ids.includes(entity.id),
      );
      settle({
        revision,
        entities,
        missingIds: ids?.filter((id) => !entities.some((entity) => entity.id === id)) ?? [],
      });
      return;
    }
    if (name === 'director_apply') {
      if (typeof args.revision !== 'number' || args.revision !== revision) {
        failToolCall(
          requestId,
          `REVISION_CONFLICT：请求版本 ${String(args.revision)}，当前版本 ${revision}；请重新读取工程`,
        );
        return;
      }
      revision += 1;
      settle({ revision, preview: false, committed: true, summary: {} });
      return;
    }
    failToolCall(requestId, `工具未实现: ${name}`);
  });
}

/**
 * v2 的工程存档往返。**旧的 `project.get` 往返已被取代**：宿主不再拉回整份工程自己
 * 序列化上传，而是发 `tool.call {director_export, kind:'project'}` 让子应用跑它自己的
 * 保存流程；子应用经 `files('save-project')` 反过来请宿主落盘（child-to-host 的
 * `project.save`），上传与 `directorProjectRef` 写入都发生在宿主这一侧。
 */
async function runChildProjectSave(frames: unknown[], content: string) {
  // 只认导出那一次 tool.call —— 全景链路也在发 tool.call，不能按「只有一个」来定位。
  const exportCalls = () =>
    requestFrames(frames, "tool.call").filter(
      (frame) =>
        (frame.payload.options as { name?: string } | undefined)?.name === "director_export",
    );
  await waitFor(() => expect(exportCalls()).toHaveLength(1));
  const toolCall = exportCalls()[0];
  expect(toolCall.payload.options).toMatchObject({
    name: "director_export",
    args: { kind: "project" },
  });
  // 宿主不再自己问子应用要工程。
  expect(requestFrames(frames, "project.get")).toHaveLength(0);

  const saveRequestId = `child-save-${content.length}`;
  emitFromDirector({
    type: DIRECTOR_DESK_MESSAGE_TYPES.request,
    payload: {
      protocolVersion: 2,
      requestId: saveRequestId,
      action: "project.save",
      options: { kind: "project", name: "project.director", content },
    },
  });
  await waitFor(() => expect(responseFrames(frames, saveRequestId)).toHaveLength(1));

  const syncStart = frames.length;
  emitFromDirector({
    type: DIRECTOR_DESK_MESSAGE_TYPES.response,
    payload: {
      protocolVersion: 2,
      requestId: toolCall.payload.requestId,
      action: "tool.call",
      ok: true,
      data: { revision: 3, result: { saved: true } },
    },
  });
  // 保存回执后才读场景概况，不能在子应用还等宿主落盘时嵌套另一条工具调用。
  await waitFor(() => expect(toolCalls(frames.slice(syncStart)).some(call => call.name === "director_read")).toBe(true));
  const read = toolCalls(frames.slice(syncStart)).find(call => call.name === "director_read")!;
  answerToolCall(read.requestId, 3, { entities: [] });
  return { toolCall, saveRequestId };
}

async function renderOpenDesk(
  overrides: Partial<DirectorDeskNodeData> = {},
  upstream: { image?: boolean; text?: boolean } = { image: true },
) {
  seedCanvas(overrides, upstream);
  render(<Harness />);
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: /打开|Open|Mở/ }));
  });
  await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
}

async function handshake() {
  const frames: unknown[] = [];
  installFrameRecorder(frames);
  emitFromDirector({
    type: DIRECTOR_DESK_MESSAGE_TYPES.ready,
    payload: { protocolVersion: 2, nodeId: DESK },
  });
  await waitFor(() =>
    expect(
      frames.some(
        (f) =>
          (f as { type?: string; payload?: { action?: string } }).type ===
            DIRECTOR_DESK_MESSAGE_TYPES.request &&
          (f as { payload?: { action?: string } }).payload?.action === "capabilities.get",
      ),
    ).toBe(true),
  );
  const request = frames.find(
    (f) =>
      (f as { type?: string; payload?: { action?: string } }).type ===
        DIRECTOR_DESK_MESSAGE_TYPES.request &&
      (f as { payload?: { action?: string } }).payload?.action === "capabilities.get",
  ) as { payload: { requestId: string } };
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
  return frames;
}

function storedData(): DirectorDeskNodeData {
  return useCanvasStore.getState().nodes.find((n) => n.id === DESK)?.data as DirectorDeskNodeData;
}

beforeEach(() => {
  uploadFreezoneImage.mockReset();
  uploadPreview.mockReset().mockResolvedValue({ url: "/static/projects/proj_feedback/preview.jpg" });
  uploadFreezoneImage.mockResolvedValue({
    url: `/static/projects/${PROJECT_ID}/freezone/_uploads/director-desk-${DESK}-project-1789615646820.json`,
    filename: "snap.json",
    size: 100,
  });
  toastError.mockReset();
  toastSuccess.mockReset();
  useCanvasStore.setState({ nodes: [], edges: [], selectedNodeId: null } as never);
  window.history.replaceState({}, "", `/projects/${PROJECT_ID}/freezone`);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

/**
 * 全景链路在 v2 里的真实形状。
 *
 * v2 子应用（vendor/director-desk/src/host-bridge.ts:32-38）的 MESSAGES 只有
 * ready/request/response，**没有全景帧的接收方**；v2 也没有「把图片设为场景背景」
 * 这个概念（`lighting.background` 是十六进制色值，lighting/model.ts:22-25）。所以宿主
 * 改走工具面：`director_media{action:'import'}` 把字节写进工程媒体，再用
 * `director_apply` 建一个 `visual-panorama` 内向球并给它加一层 unlit surface layer。
 *
 * 下面断言的是**宿主发出的工具调用**（参数形状与顺序），配合一个按上游 `service.ts`
 * 语义回话的假工具层。这比「帧发出去了」强：参数错了上游会直接抛
 * 「工具参数类型或取值错误」，而旧断言对着一个没有接收方的帧，怎么都能绿。
 */
describe("割裂感修复 — 上游 360° 全景真的进到导演台", () => {
  const ENTITY_ID = directorDeskPanoramaEntityId(DESK);

  it("三步工具调用：导媒体 → 建 visual-panorama 内向球 → 挂 unlit 贴图层", async () => {
    stubPanoramaFetch();
    await renderOpenDesk();
    const frames = await handshake();
    let importedId = '';
    const stop = serveDirectorToolService(frames, {
      onImport: (id) => {
        importedId = id;
      },
    });

    try {
      await waitFor(() => expect(importedId).toMatch(/^media-[a-f0-9]{64}$/));
      await waitFor(() =>
        expect(toolCalls(frames).some((call) => call.name === "director_apply")).toBe(true),
      );
      const calls = toolCalls(frames);
      const mediaCall = calls.find((call) => call.args.action === "list");
      const importCall = calls.find((call) => call.args.action === "import");
      const applyCall = calls.find((call) => call.name === "director_apply");
      expect(mediaCall).toBeTruthy();
      expect(importCall).toBeTruthy();
      expect(applyCall).toBeTruthy();
      // 先读当前 revision 再写；顺序反了就是拿旧版本号去改工程。
      expect(calls.indexOf(mediaCall!)).toBeLessThan(calls.indexOf(importCall!));

      // 网页版必须走 data URL：本机路径上游直接拒（service.ts:60）。
      expect(importCall!.args).not.toHaveProperty("path");
      expect(String(importCall!.args.data)).toMatch(/^data:image\/png;base64,/);
      expect(importCall!.args.mime).toBe("image/png");
      expect(String(importCall!.args.requestId)).toBeTruthy();
      expect(importCall!.args.revision).toBe(7);

      expect(applyCall!.args.revision).toBe(8); // import 推进了版本
      const operations = applyCall!.args.operations as Array<Record<string, unknown>>;
      expect(operations).toHaveLength(1);
      const [operation] = operations;
      expect(operation.operation).toBe("add");
      expect(operation.asset).toBe("visual-panorama");
      expect(operation.id).toBe(ENTITY_ID);
      const patch = operation.patch as Record<string, Record<string, unknown>>;
      // 内向球 + unlit 贴图层，是上游 media/help.ts 末行给出的官方做法。
      expect(patch.visual.preset).toBe("panorama");
      expect(patch.visual.opacity).toBe(1);
      expect(Number(patch.visual.spread)).toBeGreaterThan(1);
      const layer = (patch.surface as { layers: Array<Record<string, unknown>> }).layers[0];
      expect(layer.unlit).toBe(true);
      expect(layer.mapping).toBe("sphere");
      expect(layer.resourceId).toBe(importedId);

      // 旧断言钉的是一条没有接收方的帧；它不该再出现。
      expect(frameOfType(frames, DIRECTOR_DESK_MESSAGE_TYPES.panorama)).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it("这张图已经在工程里时跳过导入，直接复用媒体资源", async () => {
    // 先算出这张图在工程里会长成什么 id —— 上游按内容寻址，所以同字节必得同 id。
    const known = upstreamResourceId(`data:image/png;base64,${btoa(PANORAMA_BODY)}`);
    stubPanoramaFetch();
    await renderOpenDesk();
    const frames = await handshake();
    const stop = serveDirectorToolService(frames, {
      media: [{ id: known }],
      bumpOnImport: false,
    });
    try {
      await waitFor(() =>
        expect(toolCalls(frames).some((call) => call.name === "director_apply")).toBe(true),
      );
      // 这才是「同一个 resourceId 意味着同一份字节」这条短路的意义：不再送几十 MB。
      expect(toolCalls(frames).some((call) => call.args.action === "import")).toBe(false);
      const applyCall = toolCalls(frames).find((call) => call.name === "director_apply")!;
      const [operation] = applyCall.args.operations as Array<Record<string, unknown>>;
      const layer = (
        (operation.patch as Record<string, { layers: Array<Record<string, unknown>> }>).surface
      ).layers[0];
      expect(layer.resourceId).toBe(known);
    } finally {
      stop();
    }
  });

  it("弹窗里能看出上游接了什么、且全景真的落地了", async () => {
    stubPanoramaFetch();
    await renderOpenDesk();
    const frames = await handshake();
    const stop = serveDirectorToolService(frames);
    try {
      await waitFor(() =>
        expect(screen.getByText(/已载入全景图：场景全景|Panorama from: 场景全景/)).toBeTruthy(),
      );
      await waitFor(() =>
        expect(screen.getByRole("status").textContent).toMatch(
          /全景图已进场景|Panorama in scene/,
        ),
      );
    } finally {
      stop();
    }
  });

  it("只有文本上游时不发任何全景调用", async () => {
    stubPanoramaFetch();
    await renderOpenDesk({}, { text: true });
    const frames = await handshake();
    const stop = serveDirectorToolService(frames);
    try {
      await waitFor(() =>
        expect(screen.getByText(/参考文本已接上|Reference text attached/)).toBeTruthy(),
      );
      const chip = screen.getByText(/参考文本已接上|Reference text attached/).closest("span");
      expect(chip?.getAttribute("title")).toMatch(
        /不会自动写进导演台场景|not written into the desk scene/,
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(toolCallFrames(frames)).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it("同一张图重开不重发（不会覆盖用户在导演台里自己换过的背景）", async () => {
    stubPanoramaFetch();
    await renderOpenDesk();
    const first = await handshake();
    const stopFirst = serveDirectorToolService(first);
    try {
      await waitFor(() =>
        expect(toolCalls(first).some((call) => call.name === "director_apply")).toBe(true),
      );
    } finally {
      stopFirst();
    }

    // 关窗会先存档：v2 走 tool.call{director_export}，子应用再回请宿主落盘。
    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: /关闭|Close|Đóng/ }).pop()!);
    });
    await runChildProjectSave(first, JSON.stringify({ project: {} }));
    await waitFor(() => expect(document.querySelector("iframe")).toBeNull());

    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: /打开|Open|Mở/ })[0]);
    });
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const second = await handshake();
    const stopSecond = serveDirectorToolService(second);
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(toolCallFrames(second)).toHaveLength(0);
    } finally {
      stopSecond();
    }
  });

  it("上游换成另一张图后重新走一遍链路（换图要生效）", async () => {
    stubPanoramaFetch();
    await renderOpenDesk();
    const frames = await handshake();
    const stop = serveDirectorToolService(frames);
    try {
      await waitFor(() =>
        expect(toolCalls(frames).filter((call) => call.name === "director_apply")).toHaveLength(1),
      );
      act(() => {
        useCanvasStore.getState().updateNodeData(UPSTREAM_IMG, {
          imageUrl: "/static/projects/proj_feedback/freezone/_uploads/another.png",
        });
      });
      await waitFor(() =>
        expect(toolCalls(frames).filter((call) => call.name === "director_apply")).toHaveLength(2),
      );
    } finally {
      stop();
    }
  });

  it("工程里已有这个全景球时走 update，而不是再叠一个球", async () => {
    stubPanoramaFetch();
    await renderOpenDesk();
    const frames = await handshake();
    const stop = serveDirectorToolService(frames, {
      entities: [{ id: ENTITY_ID, asset: "visual-panorama" }],
    });
    try {
      await waitFor(() =>
        expect(toolCalls(frames).some((call) => call.name === "director_apply")).toBe(true),
      );
      const applyCall = toolCalls(frames).find((call) => call.name === "director_apply")!;
      const [operation] = applyCall.args.operations as Array<Record<string, unknown>>;
      expect(operation.operation).toBe("update");
      expect(operation.id).toBe(ENTITY_ID);
      expect(operation).not.toHaveProperty("asset");
    } finally {
      stop();
    }
  });

  it("revision 冲突时重读版本重试，且每轮换新的 requestId", async () => {
    stubPanoramaFetch();
    await renderOpenDesk();
    const frames = await handshake();
    const stop = serveDirectorToolService(frames, { conflicts: { director_apply: 1 } });
    try {
      await waitFor(() =>
        expect(toolCalls(frames).filter((call) => call.name === "director_apply")).toHaveLength(2),
      );
      const applies = toolCalls(frames).filter((call) => call.name === "director_apply");
      // 两轮用同一个 requestId 会被上游判成「requestId 已用于不同操作」（service.ts:65）。
      expect(applies[0].args.requestId).not.toBe(applies[1].args.requestId);
      // 第一轮 import 已经把字节写进工程了，所以重试读清单时认得出这张图，
      // 直接复用 media —— 不必把同一份字节再送一遍。版本也随之从 8 走到 9。
      expect(applies[1].args.revision).toBe(9);
      expect(toolCalls(frames).filter((call) => call.args.action === "import")).toHaveLength(1);
      await waitFor(() =>
        expect(screen.getByRole("status").textContent).toMatch(
          /全景图已进场景|Panorama in scene/,
        ),
      );
    } finally {
      stop();
    }
  });

  it("子应用正忙时如实报错，不静默、也不空转重试", async () => {
    stubPanoramaFetch();
    await renderOpenDesk();
    const frames = await handshake();
    const stop = serveDirectorToolService(frames, { busy: ["director_media"] });
    try {
      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toMatch(
          /正在编辑或执行长任务|busy editing or running a long job/,
        ),
      );
      // 忙碌是状态不是竞态：只试一次，不靠重试碰运气。
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(toolCalls(frames).filter((call) => call.args.action === "import")).toHaveLength(0);
      expect(toolCalls(frames).some((call) => call.name === "director_apply")).toBe(false);
    } finally {
      stop();
    }
  });

  it("非 PNG/JPEG/WebP 在联网之前就失败，不往导演台送", async () => {
    const fetchMock = stubPanoramaFetch(() => panoramaResponse("GIF89a", "image/gif"));
    await renderOpenDesk();
    const frames = await handshake();
    const stop = serveDirectorToolService(frames);
    try {
      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toMatch(
          /不是 PNG \/ JPEG \/ WebP|not PNG \/ JPEG \/ WebP/,
        ),
      );
      expect(fetchMock).toHaveBeenCalled();
      expect(toolCallFrames(frames)).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it("超过体积上限就明确报错，不截断也不偷偷换图", async () => {
    const big = new Uint8Array(DIRECTOR_DESK_PANORAMA_MAX_BYTES + 1);
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () => new Response(big, { status: 200, headers: { "content-type": "image/png" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await renderOpenDesk();
    const frames = await handshake();
    const stop = serveDirectorToolService(frames);
    try {
      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toMatch(/太大|too large/i),
      );
      // 关键：不能把截断后的字节送进去。
      expect(toolCallFrames(frames)).toHaveLength(0);
    } finally {
      stop();
    }
  });
});

describe("directorDeskPanoramaSource（纯函数）", () => {
  it("跳过视频、跳过非图片 data URL，取第一张真图片", () => {
    expect(
      directorDeskPanoramaSource([
        { id: "v1", type: "pano360ViewerNode", data: { displayName: "片段", videoUrl: "/static/a.mp4", previewImageUrl: "/static/a.mp4" } },
        { id: "d1", type: "pano360ViewerNode", data: { imageUrl: "data:video/mp4;base64,AAAA" } },
        { id: "i1", type: "pano360ViewerNode", data: { displayName: "全景图", imageUrl: "/static/pano.png" } },
      ]),
    ).toEqual({
      sourceNodeId: "i1",
      imageUrl: "/static/pano.png",
      fileName: "全景图.png",
      displayName: "全景图",
    });
  });

  it("一张图都没有时返回 null（不发空消息）", () => {
    expect(directorDeskPanoramaSource([{ id: "t1", type: "textAnnotationNode", data: { content: "剧本" } }])).toBeNull();
    expect(directorDeskPanoramaSource([])).toBeNull();
  });

  it("node.data 为空对象也不炸", () => {
    expect(directorDeskPanoramaSource([{ id: "x", type: "pano360ViewerNode", data: {} }])).toBeNull();
  });

  it("普通图片分镜不会在重开时变成球面背景，混接时仍读取明确的 360° 节点", () => {
    const reference = { id: "reference", type: "uploadNode", data: { displayName: "参考分镜", imageUrl: "/static/reference.png" } };
    expect(directorDeskPanoramaSource([reference])).toBeNull();
    expect(directorDeskPanoramaSource([
      reference,
      { id: "panorama", type: "pano360ViewerNode", data: { displayName: "场景全景", imageUrl: "/static/panorama.png" } },
    ])?.sourceNodeId).toBe("panorama");
  });
});

describe("保存按钮", () => {
  it("点「保存工程」会真的发起子应用保存流程、上传快照、写回引用，标签带存档时间", async () => {
    await renderOpenDesk();
    const frames = await handshake();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /保存工程|Save project|Lưu dự án/ }));
    await runChildProjectSave(frames, JSON.stringify({ project: { objects: [] } }));

    await waitFor(() => expect(storedData().directorProjectRef).toBeTruthy());
    expect(uploadFreezoneImage).toHaveBeenCalledTimes(1);
    // 标签变成带时间的「工程已存档 · HH:MM」
    await waitFor(() => expect(screen.getByText(/工程已存档 · |Project archived · /)).toBeTruthy());
    // 而且没有关窗（显式保存不该把弹窗关掉）
    expect(document.querySelector("iframe")).not.toBeNull();
  });
});

describe("directorDeskSnapshotSavedAt（纯函数）", () => {
  it("从存档引用里取回时间戳", () => {
    expect(
      directorDeskSnapshotSavedAt(
        "/static/projects/p/freezone/_uploads/20260917_112726_908754_director-desk-x-project-1789615646820.json?st_v=1",
      ),
    ).toBe(1789615646820);
  });

  it("没有引用 / 引用形态不对时返回 null", () => {
    expect(directorDeskSnapshotSavedAt(null)).toBeNull();
    expect(directorDeskSnapshotSavedAt("")).toBeNull();
    expect(directorDeskSnapshotSavedAt("/static/whatever.json")).toBeNull();
  });
});

describe("封面同步到节点小图", () => {
  it("截图回传后封面立刻更新，第二次截图也更新（旧规则只在没封面时写）", async () => {
    await renderOpenDesk();
    await handshake();

    // 第一次回传
    uploadFreezoneImage.mockResolvedValueOnce({
      url: "/static/projects/proj_feedback/freezone/_uploads/cap-1.png",
      filename: "cap-1.png",
      size: 10,
    });
    emitFromDirector({
      type: DIRECTOR_DESK_MESSAGE_TYPES.captures,
      payload: { captures: [{ dataUrl: PNG_DATA_URL, fileName: "机位01-截图01.png" }] },
    });
    await waitFor(() => expect(storedData().previewImageUrl).toContain("cap-1.png"));

    // 第二次回传：封面必须换成新的，否则用户看不出刚刚截了什么
    uploadFreezoneImage.mockResolvedValueOnce({
      url: "/static/projects/proj_feedback/freezone/_uploads/cap-2.png",
      filename: "cap-2.png",
      size: 10,
    });
    emitFromDirector({
      type: DIRECTOR_DESK_MESSAGE_TYPES.captures,
      payload: { captures: [{ dataUrl: PNG_DATA_URL, fileName: "机位01-截图02.png" }] },
    });
    await waitFor(() => expect(storedData().previewImageUrl).toContain("cap-2.png"));
  });

  it("节点小图渲染的就是最新封面（DOM 上能看到 src 变化）", async () => {
    await renderOpenDesk({ previewImageUrl: "/static/projects/proj_feedback/freezone/_uploads/cap-1.png" });
    await handshake();

    const firstImg = document.querySelector<HTMLImageElement>(".react-flow__node img, img");
    expect(firstImg?.getAttribute("src")).toContain("cap-1.png");

    uploadFreezoneImage.mockResolvedValueOnce({
      url: "/static/projects/proj_feedback/freezone/_uploads/cap-9.png",
      filename: "cap-9.png",
      size: 10,
    });
    emitFromDirector({
      type: DIRECTOR_DESK_MESSAGE_TYPES.captures,
      payload: { captures: [{ dataUrl: PNG_DATA_URL, fileName: "机位02-截图01.png" }] },
    });
    await waitFor(() =>
      expect(document.querySelector("img")?.getAttribute("src")).toContain("cap-9.png"),
    );
  });
});

/**
 * 放在最后单独一组：这里全程用假定时器，且**完全不用 `waitFor` / `userEvent`** ——
 * 它们内部也等定时器，和假时钟混用会互相卡死（同文件前面的用例会被泄漏的假时钟拖垮）。
 * 一切都是同步 fireEvent + act，只把时钟推进到存档超时之后。
 */
describe("保存超时保留编辑器", () => {
  it("导演台不回话时保留窗口，明确告知保存尚未完成", async () => {
    vi.useFakeTimers();
    try {
      seedCanvas();
      render(<Harness />);
      act(() => {
        fireEvent.click(screen.getAllByRole("button", { name: /打开|Open|Mở/ })[0]);
      });
      // 弹窗内容在 portal 里，晚一个 commit 挂载：flush 一次微任务即可，不需要 waitFor
      await act(async () => {});
      expect(document.querySelector("iframe")).not.toBeNull();

      // 同步派发 ready → 桥进入 ready 态 → 关窗会走「先存档再关」
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: DIRECTOR_DESK_MESSAGE_TYPES.ready },
            origin: window.location.origin,
            source: iframeEl().contentWindow as unknown as MessageEventSource,
          }),
        );
      });
      act(() => {
        fireEvent.click(screen.getAllByRole("button", { name: /关闭|Close|Đóng/ }).pop()!);
      });
      // 保存工具一直不回：推进到等待超时之后，未完成的工程不能假装保存成功。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DIRECTOR_DESK_SAVE_TIMEOUT_MS + 1);
      });
      expect(document.querySelector("iframe")).not.toBeNull();
      expect(useCanvasStore.getState().nodes.find((n) => n.id === DESK)?.data.isOpen).toBe(true);
      expect(toastError).toHaveBeenCalled();
      expect(String(toastError.mock.calls[0][0])).toMatch(/尚未完成|not finished|Chưa lưu xong|timed out/);
    } finally {
      vi.useRealTimers();
    }
  });
});
