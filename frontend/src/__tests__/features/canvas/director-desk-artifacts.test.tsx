// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * DirectorDeskNode 阶段 5：截图回传与导出视频的落库路径。
 *
 * 被测单元是**已交付的**组件与 store 装配（真实导出路径）：只把网络边界
 * （`@/api/ops` 的上传调用）和设备边界（`loadImageElement` 量尺寸）替掉，
 * 上传命名、dataUrl→Blob、项目作用域取参、派生节点创建、节点字段回写
 * 全部跑真实代码。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirectorDeskNodeData } from "@/features/canvas/domain/canvasNodes";
import {
  DirectorDeskNode,
  directorDeskArtifactUploadName,
  directorDeskAssetUrl,
  directorDeskCaptureUploadName,
} from "@/features/canvas/nodes/DirectorDeskNode";
import { DIRECTOR_DESK_MESSAGE_TYPES } from "@/features/canvas/nodes/directorDeskBridge";
import { useCanvasStore } from "@/stores/canvasStore";

const uploadFreezoneImage = vi.fn();
const uploadFreezoneVideo = vi.fn();
vi.mock("@/api/ops", () => ({
  uploadFreezoneImage: (...args: unknown[]) => uploadFreezoneImage(...args),
  uploadFreezoneVideo: (...args: unknown[]) => uploadFreezoneVideo(...args),
}));

vi.mock("@/features/canvas/application/imageData", async () => {
  const actual = await vi.importActual<typeof import("@/features/canvas/application/imageData")>(
    "@/features/canvas/application/imageData",
  );
  return {
    ...actual,
    // 量图尺寸要真的解码图片，jsdom 不做；这里只替掉解码，其余（dataUrlToBlob、
    // withImageCacheBust）用真实实现。
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

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const NODE_ID = "node_director_desk_artifacts";
const PROJECT_ID = "proj_artifacts_test";
const PNG_DATA_URL = `data:image/png;base64,${btoa("fake-png-bytes")}`;
const CAPABILITIES = {
  protocolVersion: 1,
  actions: ["capabilities.get", "project.get", "export.frame", "export.video"],
  assetPersistence: "browser-local-references",
};

function defaultData(overrides: Partial<DirectorDeskNodeData> = {}): DirectorDeskNodeData {
  return {
    displayName: "3D 导演台",
    isOpen: true,
    directorProjectRef: null,
    videoUrl: null,
    previewImageUrl: null,
    ...overrides,
  };
}

/**
 * 只保留这一个节点，并按**真实用户路径**点开弹窗。
 *
 * 不能直接以 `isOpen: true` 挂载：组件刻意把存档里残留的 isOpen 归零（否则加载
 * 画布会自拉起一个 3D 引擎），所以「打开」这件事只能由用户动作产生。
 */
async function renderOpenNode(overrides: Partial<DirectorDeskNodeData> = {}) {
  useCanvasStore.setState({
    nodes: [
      {
        id: NODE_ID,
        type: "directorDeskNode",
        position: { x: 0, y: 0 },
        data: defaultData({ ...overrides, isOpen: false }),
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

function storedNode() {
  return useCanvasStore.getState().nodes.find((item) => item.id === NODE_ID);
}

function storedData(): DirectorDeskNodeData {
  return storedNode()?.data as DirectorDeskNodeData;
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

/** 记录宿主 → 导演台的帧，用来拿到 requestId / 确认 request 发出。 */
function installFrameRecorder(frames: unknown[]) {
  const contentWindow = iframeEl().contentWindow;
  if (!contentWindow) throw new Error("no content window");
  const originalPost = contentWindow.postMessage.bind(contentWindow);
  (contentWindow as unknown as { postMessage: unknown }).postMessage = (message: unknown) => {
    frames.push(message);
    return originalPost(message as never, "*");
  };
}

/** 按 action 找宿主发出的 request 帧（`ready` 之后还会有一条 `session`，不能按下标取）。 */
function requestFrame(frames: unknown[], action: string) {
  const frame = frames.find((f) => {
    const candidate = f as { type?: string; payload?: { action?: string } };
    return candidate.type === DIRECTOR_DESK_MESSAGE_TYPES.request && candidate.payload?.action === action;
  });
  if (!frame) throw new Error(`no request frame for ${action}; got ${JSON.stringify(frames)}`);
  return frame as {
    type: string;
    payload: { requestId: string; action: string; options?: Record<string, unknown> };
  };
}

/** 握手到 connected + 拿到 capabilities。 */
async function handshake(capabilities: unknown = CAPABILITIES) {
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
      data: capabilities,
    },
  });
  return frames;
}

beforeEach(() => {
  uploadFreezoneImage.mockReset();
  uploadFreezoneVideo.mockReset();
  useCanvasStore.setState({ nodes: [], edges: [], selectedNodeId: null });
  window.history.replaceState({}, "", `/projects/${PROJECT_ID}/freezone`);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("上传命名（纯函数）", () => {
  it("截图名不带上游的中文/空格，只用节点 id + 序号 + 时间戳", () => {
    expect(directorDeskCaptureUploadName(NODE_ID, 0, "机位01-截图01.png", 1700000000000)).toBe(
      `director-desk-${NODE_ID}-capture-1-1700000000000.png`,
    );
    expect(directorDeskCaptureUploadName(NODE_ID, 11, "no extension", 5)).toBe(
      `director-desk-${NODE_ID}-capture-12-5.png`,
    );
    // 上游给个带路径分隔符的名字也不会跑出目录
    expect(directorDeskCaptureUploadName(NODE_ID, 0, "../../etc/passwd", 1)).toBe(
      `director-desk-${NODE_ID}-capture-1-1.png`,
    );
  });

  it("导出产物名区分 video / poster", () => {
    expect(directorDeskArtifactUploadName(NODE_ID, "video", "mp4", 42)).toBe(
      `director-desk-${NODE_ID}-video-42.mp4`,
    );
    expect(directorDeskArtifactUploadName(NODE_ID, "poster", "png", 42)).toBe(
      `director-desk-${NODE_ID}-poster-42.png`,
    );
  });

  it("资产 URL 去掉旧 query 再挂新的破缓存参数", () => {
    expect(directorDeskAssetUrl("/static/p/a.png?v=1", 9)).toBe("/static/p/a.png?st_v=9");
    expect(directorDeskAssetUrl("/static/p/a.png", 9)).toBe("/static/p/a.png?st_v=9");
    expect(directorDeskAssetUrl("", 9)).toBe("");
  });
});

describe("截图回传 → 项目内资产 + 派生节点", () => {
  it("captures-sent 走项目作用域上传，并在画布上生成 imageUrl 为项目 URL 的节点", async () => {
    uploadFreezoneImage.mockResolvedValue({
      url: "/static/proj/artifacts/capture.png",
      filename: "capture.png",
      size: 12,
    });

    await renderOpenNode();
    await handshake();

    emitFromDirector({
      type: DIRECTOR_DESK_MESSAGE_TYPES.captures,
      payload: {
        captures: [
          { dataUrl: PNG_DATA_URL, fileName: "机位01-截图01.png" },
          { dataUrl: PNG_DATA_URL, fileName: "机位02-截图01.png" },
        ],
      },
    });

    await waitFor(() => expect(uploadFreezoneImage).toHaveBeenCalledTimes(2));

    // 1) 上传调用是**项目作用域**的：第一个参数就是 URL 里的 project。
    expect(uploadFreezoneImage.mock.calls[0][0]).toBe(PROJECT_ID);
    // 2) 上传的是 Blob，不是 dataUrl 字符串（画布 JSON 不能被 base64 撑爆）。
    expect(uploadFreezoneImage.mock.calls[0][1]).toBeInstanceOf(Blob);
    expect(typeof uploadFreezoneImage.mock.calls[0][2]).toBe("string");

    // 3) 画布上多出两个派生节点，它们的 imageUrl 是项目内 URL。
    await waitFor(() => {
      expect(useCanvasStore.getState().nodes.filter((n) => n.id !== NODE_ID)).toHaveLength(2);
    });
    const derived = useCanvasStore.getState().nodes.filter((n) => n.id !== NODE_ID);
    for (const node of derived) {
      const data = node.data as { imageUrl?: string };
      expect(data.imageUrl).toContain("/static/proj/artifacts/capture.png");
      expect(data.imageUrl?.startsWith("data:")).toBe(false);
      expect(data.imageUrl?.startsWith("http")).toBe(false);
    }

    // 4) 首张截图成为当前节点的封面；画布 data 里不留 base64。
    await waitFor(() => expect(storedData().previewImageUrl).toContain("/static/proj/artifacts/"));
    expect(JSON.stringify(storedData())).not.toContain("data:image/png;base64");
  });

  it("上传失败时不留半成品节点，并给出可读错误提示", async () => {
    uploadFreezoneImage.mockRejectedValue(new Error("network down"));
    await renderOpenNode();
    await handshake();

    emitFromDirector({
      type: DIRECTOR_DESK_MESSAGE_TYPES.captures,
      payload: { captures: [{ dataUrl: PNG_DATA_URL, fileName: "a.png" }] },
    });

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("network down");
    // 没建节点、没写封面
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
    expect(storedData().previewImageUrl).toBeNull();
  });

  it("回传进行中再次收到 captures-sent 不会并发第二批上传", async () => {
    let release: (() => void) | null = null;
    uploadFreezoneImage.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ url: "/static/p/a.png", filename: "a.png", size: 1 });
        }),
    );

    await renderOpenNode();
    await handshake();

    const batch = {
      type: DIRECTOR_DESK_MESSAGE_TYPES.captures,
      payload: { captures: [{ dataUrl: PNG_DATA_URL, fileName: "a.png" }] },
    };
    emitFromDirector(batch);
    await waitFor(() => expect(uploadFreezoneImage).toHaveBeenCalledTimes(1));
    emitFromDirector(batch);
    // 仍在忙：第二次被 busy 守卫挡掉
    expect(uploadFreezoneImage).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.();
    });
    await waitFor(() => expect(useCanvasStore.getState().nodes).toHaveLength(2));
  });

  it("项目 id 取不到时跳过上传并提示", async () => {
    window.history.replaceState({}, "", "/no-project-here");
    await renderOpenNode();
    await handshake();

    emitFromDirector({
      type: DIRECTOR_DESK_MESSAGE_TYPES.captures,
      payload: { captures: [{ dataUrl: PNG_DATA_URL, fileName: "a.png" }] },
    });

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
  });
});

describe("导出参考视频", () => {
  it("export.video + export.frame 都上传成项目资产后写入 videoUrl / previewImageUrl", async () => {
    const user = userEvent.setup();
    await renderOpenNode();
    const frames = await handshake();

    uploadFreezoneVideo.mockResolvedValue({
      url: "/static/proj/artifacts/ref.mp4",
      filename: "ref.mp4",
      size: 100,
    });
    uploadFreezoneImage.mockResolvedValue({
      url: "/static/proj/artifacts/poster.png",
      filename: "poster.png",
      size: 10,
    });

    const button = await screen.findByRole("button", { name: /导出参考视频|Export reference video/ });
    await user.click(button);
    await waitFor(() => expect(requestFrame(frames, "export.video")).toBeTruthy());
    const request = requestFrame(frames, "export.video");

    // 导演台回视频 Blob
    emitFromDirector({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: {
        protocolVersion: 1,
        requestId: request.payload.requestId,
        action: "export.video",
        ok: true,
        data: { blob: new Blob(["mp4-bytes"], { type: "video/mp4" }), mimeType: "video/mp4" },
      },
    });

    // 随后宿主自己发起 export.frame 取首帧当封面
    await waitFor(() => expect(requestFrame(frames, "export.frame")).toBeTruthy());
    const frameRequest = requestFrame(frames, "export.frame");
    expect(frameRequest.payload.options).toMatchObject({ position: "first" });
    emitFromDirector({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: {
        protocolVersion: 1,
        requestId: frameRequest.payload.requestId,
        action: "export.frame",
        ok: true,
        data: { dataUrl: PNG_DATA_URL, width: 1280, height: 720 },
      },
    });

    await waitFor(() => expect(storedData().videoUrl).toContain("/static/proj/artifacts/ref.mp4"));
    expect(uploadFreezoneVideo.mock.calls[0][0]).toBe(PROJECT_ID);
    expect(uploadFreezoneVideo.mock.calls[0][1]).toBeInstanceOf(Blob);
    expect(storedData().previewImageUrl).toContain("/static/proj/artifacts/poster.png");
    // 画布 data 里不留 base64
    expect(JSON.stringify(storedData())).not.toContain("data:image/png;base64");
  });

  it("首帧拿不到也把视频写回去（封面是加分项，不是前置条件）", async () => {
    const user = userEvent.setup();
    await renderOpenNode();
    const frames = await handshake();
    uploadFreezoneVideo.mockResolvedValue({
      url: "/static/proj/artifacts/ref.mp4",
      filename: "ref.mp4",
      size: 100,
    });

    await user.click(await screen.findByRole("button", { name: /导出参考视频|Export reference video/ }));
    await waitFor(() => expect(requestFrame(frames, "export.video")).toBeTruthy());
    const request = requestFrame(frames, "export.video");
    emitFromDirector({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: {
        protocolVersion: 1,
        requestId: request.payload.requestId,
        action: "export.video",
        ok: true,
        data: { blob: new Blob(["mp4"], { type: "video/mp4" }) },
      },
    });
    await waitFor(() => expect(requestFrame(frames, "export.frame")).toBeTruthy());
    const frameRequest = requestFrame(frames, "export.frame");
    emitFromDirector({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: {
        protocolVersion: 1,
        requestId: frameRequest.payload.requestId,
        action: "export.frame",
        ok: false,
        error: { code: "export-busy", message: "busy" },
      },
    });

    await waitFor(() => expect(storedData().videoUrl).toContain("/static/proj/artifacts/ref.mp4"));
    expect(storedData().previewImageUrl).toBeNull();
  });

  it("导出失败不写入 videoUrl，并给出可读错误提示", async () => {
    const user = userEvent.setup();
    await renderOpenNode();
    const frames = await handshake();
    await user.click(await screen.findByRole("button", { name: /导出参考视频|Export reference video/ }));
    await waitFor(() => expect(requestFrame(frames, "export.video")).toBeTruthy());
    const request = requestFrame(frames, "export.video");
    emitFromDirector({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: {
        protocolVersion: 1,
        requestId: request.payload.requestId,
        action: "export.video",
        ok: false,
        error: { code: "export-failed", message: "recorder unsupported" },
      },
    });

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("recorder unsupported");
    expect(storedData().videoUrl).toBeNull();
    expect(uploadFreezoneVideo).not.toHaveBeenCalled();
  });

  it("重复点击导出不会并发触发多次上传", async () => {
    const user = userEvent.setup();
    await renderOpenNode();
    const frames = await handshake();
    let release: ((value: unknown) => void) | null = null;
    uploadFreezoneVideo.mockImplementation(
      () => new Promise((resolve) => {
        release = resolve;
      }),
    );

    const button = await screen.findByRole("button", { name: /导出参考视频|Export reference video/ });
    await user.click(button);
    await waitFor(() => expect(requestFrame(frames, "export.video")).toBeTruthy());
    const request = requestFrame(frames, "export.video");
    emitFromDirector({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: {
        protocolVersion: 1,
        requestId: request.payload.requestId,
        action: "export.video",
        ok: true,
        data: { blob: new Blob(["mp4"], { type: "video/mp4" }) },
      },
    });
    await waitFor(() => expect(uploadFreezoneVideo).toHaveBeenCalledTimes(1));

    // busy 期间按钮禁用；即便硬点也只能有一次上传。
    await user.click(button);
    await user.click(button);
    expect(uploadFreezoneVideo).toHaveBeenCalledTimes(1);
    expect(
      frames.filter(
        (f) =>
          (f as { type?: string }).type === DIRECTOR_DESK_MESSAGE_TYPES.request &&
          (f as { payload?: { action?: string } }).payload?.action === "export.video",
      ),
    ).toHaveLength(1);

    await act(async () => {
      release?.({ url: "/static/p/ref.mp4", filename: "ref.mp4", size: 1 });
    });
  });

  it("导演台没声明 export.video 时导出按钮不渲染", async () => {
    await renderOpenNode();
    await handshake({ ...CAPABILITIES, actions: ["capabilities.get"] });
    await waitFor(() => expect(screen.queryByRole("button", { name: /导出参考视频|Export reference video/ })).toBeNull());
  });
});
