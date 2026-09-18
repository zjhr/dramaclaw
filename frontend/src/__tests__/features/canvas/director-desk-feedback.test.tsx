// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 用户反馈的三个问题，逐条锁住：
 *
 * 1. 割裂感 —— 画布上游接进来的图片必须**真的进到导演台场景里**（panorama 消息），
 *    而不是接了一根死线；并且弹窗里要看得出上游接了什么。
 * 2. 没有保存按钮 —— 有可点的「保存工程」，有进度，存完标签带上存档时间。
 * 3. 没有同步到节点小图 —— 封面 = 最近一次产物，截图回传后必须立刻变。
 *
 * 仍然只替掉网络边界（`@/api/ops`、`fetch`）与图片解码，其余走真实代码。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirectorDeskNodeData } from "@/features/canvas/domain/canvasNodes";
import {
  DirectorDeskNode,
  directorDeskPanoramaSource,
  directorDeskSnapshotSavedAt,
} from "@/features/canvas/nodes/DirectorDeskNode";
import { DIRECTOR_DESK_MESSAGE_TYPES } from "@/features/canvas/nodes/directorDeskBridge";
import { useCanvasStore } from "@/stores/canvasStore";

const uploadFreezoneImage = vi.fn();
vi.mock("@/api/ops", () => ({
  uploadFreezoneImage: (...args: unknown[]) => uploadFreezoneImage(...args),
  uploadFreezoneVideo: vi.fn(),
}));

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
const CAPABILITIES = { protocolVersion: 1, actions: ["capabilities.get", "project.get"] };
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
      type: "uploadNode",
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
    return original(message as never, "*");
  };
}

function frameOfType(frames: unknown[], type: string) {
  return frames.filter((f) => (f as { type?: string }).type === type) as Array<{
    type: string;
    payload: Record<string, string>;
  }>;
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
  emitFromDirector({ type: DIRECTOR_DESK_MESSAGE_TYPES.ready });
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
      protocolVersion: 1,
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
  toastError.mockReset();
  toastSuccess.mockReset();
  useCanvasStore.setState({ nodes: [], edges: [], selectedNodeId: null } as never);
  window.history.replaceState({}, "", `/projects/${PROJECT_ID}/freezone`);
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("割裂感修复 — 上游图片真的进到导演台", () => {
  it("ready 后发出 panorama，四个要素齐备且指向真正的来源节点", async () => {
    await renderOpenDesk();
    const frames = await handshake();

    await waitFor(() => expect(frameOfType(frames, DIRECTOR_DESK_MESSAGE_TYPES.panorama)).toHaveLength(1));
    const panorama = frameOfType(frames, DIRECTOR_DESK_MESSAGE_TYPES.panorama)[0];
    // 上游 importHostPanorama 对这四个字段都做非空校验 —— 少一个它就静默 return
    expect(panorama.payload.sourceNodeId).toBe(UPSTREAM_IMG);
    expect(panorama.payload.imageUrl).toBe(PANORAMA_URL);
    expect(panorama.payload.fileName).toBeTruthy();
    expect(panorama.payload.edgeId).toBe(`${UPSTREAM_IMG}->${DESK}`);
  });

  it("弹窗里能看出上游接了什么（不再是一根看不见的死线）", async () => {
    await renderOpenDesk();
    await handshake();
    await waitFor(() =>
      expect(screen.getByText(/已载入全景图：场景全景|Panorama from: 场景全景/)).toBeTruthy(),
    );
  });

  it("只有文本上游时提示是参考文本，并说明不会写进导演台场景", async () => {
    await renderOpenDesk({}, { text: true });
    const frames = await handshake();
    // 文本上游没有图片 → 不发 panorama
    expect(frameOfType(frames, DIRECTOR_DESK_MESSAGE_TYPES.panorama)).toHaveLength(0);
    await waitFor(() =>
      expect(screen.getByText(/参考文本已接上|Reference text attached/)).toBeTruthy(),
    );
    const chip = screen.getByText(/参考文本已接上|Reference text attached/).closest("span");
    expect(chip?.getAttribute("title")).toMatch(/不会自动写进导演台场景|not written into the desk scene/);
  });

  it("同一张图重开不重发（不会覆盖用户在导演台里自己换的背景）", async () => {
    await renderOpenDesk();
    const first = await handshake();
    await waitFor(() => expect(frameOfType(first, DIRECTOR_DESK_MESSAGE_TYPES.panorama)).toHaveLength(1));

    // 关窗后重开：同一张上游图，不应再发一次
    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: /关闭|Close|Đóng/ }).pop()!);
    });
    // 真实关窗会先存档（project.get），回一个字让关窗立刻完成
    await waitFor(() =>
      expect(
        first.some((f) => (f as { payload?: { action?: string } }).payload?.action === "project.get"),
      ).toBe(true),
    );
    const saveRequest = first.find(
      (f) => (f as { payload?: { action?: string } }).payload?.action === "project.get",
    ) as { payload: { requestId: string } };
    emitFromDirector({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: {
        protocolVersion: 1,
        requestId: saveRequest.payload.requestId,
        action: "project.get",
        ok: true,
        data: { protocolVersion: 1, projectSchemaVersion: 1, project: { objects: [], cameras: [] } },
      },
    });
    await waitFor(() => expect(document.querySelector("iframe")).toBeNull());

    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: /打开|Open|Mở/ })[0]);
    });
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const second = await handshake();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(frameOfType(second, DIRECTOR_DESK_MESSAGE_TYPES.panorama)).toHaveLength(0);
  });


  it("上游换成另一张图后立即重发（换图要生效）", async () => {
    await renderOpenDesk();
    const first = await handshake();
    await waitFor(() => expect(frameOfType(first, DIRECTOR_DESK_MESSAGE_TYPES.panorama)).toHaveLength(1));

    act(() => {
      useCanvasStore.getState().updateNodeData(UPSTREAM_IMG, {
        imageUrl: "/static/projects/proj_feedback/freezone/_uploads/another.png",
      });
    });
    await waitFor(() =>
      expect(frameOfType(first, DIRECTOR_DESK_MESSAGE_TYPES.panorama).length).toBeGreaterThanOrEqual(2),
    );
    const latest = frameOfType(first, DIRECTOR_DESK_MESSAGE_TYPES.panorama).pop()!;
    expect(latest.payload.imageUrl).toBe("/static/projects/proj_feedback/freezone/_uploads/another.png");
  });
});

describe("directorDeskPanoramaSource（纯函数）", () => {
  it("跳过视频、跳过非图片 data URL，取第一张真图片", () => {
    expect(
      directorDeskPanoramaSource([
        { id: "v1", data: { displayName: "片段", videoUrl: "/static/a.mp4", previewImageUrl: "/static/a.mp4" } },
        { id: "d1", data: { imageUrl: "data:video/mp4;base64,AAAA" } },
        { id: "i1", data: { displayName: "全景图", imageUrl: "/static/pano.png" } },
      ]),
    ).toEqual({
      sourceNodeId: "i1",
      imageUrl: "/static/pano.png",
      fileName: "全景图.png",
      displayName: "全景图",
    });
  });

  it("一张图都没有时返回 null（不发空消息）", () => {
    expect(directorDeskPanoramaSource([{ id: "t1", data: { content: "剧本" } }])).toBeNull();
    expect(directorDeskPanoramaSource([])).toBeNull();
  });

  it("node.data 为空对象也不炸", () => {
    expect(directorDeskPanoramaSource([{ id: "x", data: {} }])).toBeNull();
  });
});

describe("保存按钮", () => {
  it("点「保存工程」会真的发 project.get、上传快照、写回引用，标签带存档时间", async () => {
    uploadFreezoneImage.mockResolvedValue({
      url: `/static/projects/${PROJECT_ID}/freezone/_uploads/director-desk-${DESK}-project-1789615646820.json`,
      filename: "snap.json",
      size: 100,
    });
    await renderOpenDesk();
    const frames = await handshake();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /保存工程|Save project|Lưu dự án/ }));
    await waitFor(() =>
      expect(
        frames.some(
          (f) =>
            (f as { payload?: { action?: string } }).payload?.action === "project.get",
        ),
      ).toBe(true),
    );
    const request = frames.find(
      (f) => (f as { payload?: { action?: string } }).payload?.action === "project.get",
    ) as { payload: { requestId: string } };
    emitFromDirector({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: {
        protocolVersion: 1,
        requestId: request.payload.requestId,
        action: "project.get",
        ok: true,
        data: { protocolVersion: 1, projectSchemaVersion: 1, project: { objects: [], cameras: [] } },
      },
    });

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
describe("存档超时不会把用户困在弹窗里", () => {
  it("导演台不回话时，超时后仍然关窗", async () => {
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
      // project.get 一直不回：推进到存档超时之后
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(document.querySelector("iframe")).toBeNull();
      expect(useCanvasStore.getState().nodes.find((n) => n.id === DESK)?.data.isOpen).toBe(false);
      // 关窗后内联提示随弹窗卸载，用户看到的是 toast
      expect(toastError).toHaveBeenCalled();
      expect(String(toastError.mock.calls[0][0])).toMatch(/超时|timed out|quá thời gian/);
    } finally {
      vi.useRealTimers();
    }
  });
});
