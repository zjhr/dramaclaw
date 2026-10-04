// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * AI 生成背景：任务完成 → 推给导演台当全景背景。
 *
 * 产品边界是「可以引用外部节点信息，修改生成只作用于当前节点」。执行点就在
 * `directorDeskPanoUrlFromTask`：它按**产物路径里的本节点 id** 认领结果，
 * 所以别的节点的生成不会被这个节点抢走，这个节点的生成也不会漏掉。
 *
 * 这里同时锁住「没挂任务总线时不炸」—— 画布节点在测试与部分页面里是脱离
 * `TaskCenterProvider` 渲染的（`useEventBus()` 会抛，`useContext` 不会）。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DirectorDeskNodeData } from "@/features/canvas/domain/canvasNodes";
import {
  DirectorDeskNode,
  directorDeskPanoUrlFromTask,
  directorDeskTaskBelongsTo,
} from "@/features/canvas/nodes/DirectorDeskNode";
import { DIRECTOR_DESK_MESSAGE_TYPES } from "@/features/canvas/nodes/directorDeskBridge";
import { directorDeskPanoramaEntityId } from "@/features/canvas/nodes/directorDeskV2Session";
import { EventBusContext } from "@/task-center/event-bus-context";
import type { TaskEventBus } from "@/task-center/event-bus";
import type { TaskState } from "@/task-center/types";
import { useCanvasStore } from "@/stores/canvasStore";

/** 全景链路要下载的图。给一张合法 PNG，让 `Response.arrayBuffer()` 有东西可读。 */
function panoramaResponse(): Response {
  return new Response(new TextEncoder().encode("scene pano bytes"), {
    status: 200,
    headers: { "content-type": "image/png" },
  });
}

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return { ...actual, Handle: () => <div /> };
});

vi.mock("@/features/canvas/ui/NodeHeader", () => ({
  NODE_HEADER_FLOATING_POSITION_CLASS: "",
  NodeHeader: ({ titleText }: { titleText: string }) => <div>{titleText}</div>,
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) },
}));

const DESK = "pano_desk";
const OTHER_DESK = "other_pano_desk";
const PROJECT = "proj_pano";
const NODE_URL = `/static/projects/${PROJECT}/freezone/_director_desk/director_desk_panorama/${DESK}/job1/pano_360.png`;
const OTHER_NODE_URL = `/static/projects/${PROJECT}/freezone/_director_desk/director_desk_panorama/${OTHER_DESK}/job1/pano_360.png`;

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

function seedCanvas() {
  useCanvasStore.setState({
    nodes: [
      { id: DESK, type: "directorDeskNode", position: { x: 0, y: 0 }, data: deskData() },
    ],
    edges: [],
    selectedNodeId: DESK,
  } as never);
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

/** 一个只有 emit/on 的假总线，够用且不依赖 TaskCenterProvider 的其余部分。 */
function fakeBus(): TaskEventBus & { complete: (task: Partial<TaskState>) => void } {
  const listeners = new Set<(e: unknown) => void>();
  return {
    on: (_type, listener) => {
      listeners.add(listener as (e: unknown) => void);
      return () => listeners.delete(listener as (e: unknown) => void);
    },
    emit: (event) => listeners.forEach((l) => l(event)),
    complete: (task) =>
      listeners.forEach((l) =>
        l({
          type: "task_complete",
          task: { task_type: "scene_pano_generation", ...task } as TaskState,
          previous: null,
        }),
      ),
  };
}

function framesOf(iframe: HTMLIFrameElement): unknown[] {
  const cw = iframe.contentWindow as unknown as { __frames?: unknown[] };
  return cw?.__frames ?? [];
}

function emitFromDirector(data: unknown) {
  const iframe = document.querySelector("iframe");
  if (!iframe) throw new Error("no iframe");
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

/** 打开弹窗，装好 iframe 出站帧录制器。 */
async function openDesk(bus?: TaskEventBus) {
  seedCanvas();
  window.history.pushState({}, "", `/projects/${PROJECT}/freezone?canvas=c1`);
  render(
    bus ? (
      <EventBusContext.Provider value={bus}>
        <Harness />
      </EventBusContext.Provider>
    ) : (
      <Harness />
    ),
  );
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: /打开|Open|Mở/ }));
  });
  await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());

  const iframe = document.querySelector("iframe") as HTMLIFrameElement;
  const cw = iframe.contentWindow as unknown as {
    __frames: unknown[];
    postMessage: (m: unknown, t?: string) => void;
  };
  cw.__frames = [];
  const original = cw.postMessage.bind(cw);
  cw.postMessage = (message: unknown) => {
    cw.__frames.push(message);
    return original(message as never, "*");
  };
  return iframe;
}

/**
 * 握手 + 一个会回话的工具层。
 *
 * 工具层按上游 `service.ts` 的语义应答：先给 `director_media{action:'list'}` 与
 * `director_read` 一个 revision，再让 import 推进版本，最后 apply 提交。宿主这边
 * 断言的是「发了哪些工具调用、参数是什么」，因此这个假工具层必须按真实规则回话 ——
 * 参数错了上游会抛错，回话层若照单全收，这条测试就等于没测。
 */
async function handshakeAndServe(iframe: HTMLIFrameElement) {
  const frames = framesOf(iframe);
  let revision = 11;

  emitFromDirector({
    type: DIRECTOR_DESK_MESSAGE_TYPES.ready,
    payload: { protocolVersion: 2, nodeId: DESK },
  });

  const answered = new Set<string>();
  const timer = setInterval(() => {
    for (const frame of frames) {
      const payload = (frame as { type?: string; payload?: Record<string, unknown> }).payload;
      if (
        (frame as { type?: string }).type !== DIRECTOR_DESK_MESSAGE_TYPES.request ||
        !payload ||
        typeof payload.requestId !== "string" ||
        answered.has(payload.requestId)
      ) {
        continue;
      }
      const requestId = payload.requestId;
      const action = String(payload.action ?? "");
      answered.add(requestId);
      if (action === "capabilities.get") {
        emitFromDirector({
          type: DIRECTOR_DESK_MESSAGE_TYPES.response,
          payload: {
            protocolVersion: 2,
            requestId,
            action,
            ok: true,
            data: { protocolVersion: 2, actions: ["capabilities.get", "tool.call"] },
          },
        });
        continue;
      }
      if (action !== "tool.call") continue;
      const options = (payload.options ?? {}) as {
        name?: string;
        args?: Record<string, unknown>;
      };
      const name = String(options.name ?? "");
      const args = options.args ?? {};
      const reply = (result: unknown) =>
        emitFromDirector({
          type: DIRECTOR_DESK_MESSAGE_TYPES.response,
          payload: {
            protocolVersion: 2,
            requestId,
            action,
            ok: true,
            data: { revision, result },
          },
        });
      if (name === "director_media" && args.action === "list") {
        reply({ revision, media: [], runtime: {} });
      } else if (name === "director_media" && args.action === "import") {
        if (args.revision !== revision) {
          emitFromDirector({
            type: DIRECTOR_DESK_MESSAGE_TYPES.response,
            payload: {
              protocolVersion: 2,
              requestId,
              action,
              ok: false,
              error: { code: "director_desk_v2_error", message: "REVISION_CONFLICT" },
            },
          });
          return;
        }
        revision += 1;
        reply({ revision, resourceId: "media-ai-pano", name: args.name, width: 2048, height: 1024 });
      } else if (name === "director_read") {
        reply({ revision, entities: [], missingIds: (args.ids as string[]) ?? [] });
      } else if (name === "director_apply") {
        if (args.revision !== revision) {
          emitFromDirector({
            type: DIRECTOR_DESK_MESSAGE_TYPES.response,
            payload: {
              protocolVersion: 2,
              requestId,
              action,
              ok: false,
              error: { code: "director_desk_v2_error", message: "REVISION_CONFLICT" },
            },
          });
          return;
        }
        revision += 1;
        reply({ revision, committed: true, preview: false, summary: {} });
      } else {
        emitFromDirector({
          type: DIRECTOR_DESK_MESSAGE_TYPES.response,
          payload: {
            protocolVersion: 2,
            requestId,
            action,
            ok: false,
            error: { code: "director_desk_v2_error", message: `工具未实现: ${name}` },
          },
        });
      }
    }
  }, 4);

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
  return () => clearInterval(timer);
}

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** 已发出的工具调用，按顺序。 */
function toolCalls(iframe: HTMLIFrameElement): ToolCall[] {
  return framesOf(iframe)
    .filter(
      (f) =>
        (f as { type?: string; payload?: { action?: string } }).type ===
          DIRECTOR_DESK_MESSAGE_TYPES.request &&
        (f as { payload?: { action?: string } }).payload?.action === "tool.call",
    )
    .map((f) => {
      const payload = (f as { payload: { options?: { name?: string; args?: Record<string, unknown> } } })
        .payload;
      return {
        name: String(payload.options?.name ?? ""),
        args: (payload.options?.args ?? {}) as Record<string, unknown>,
      };
    });
}

afterEach(() => {
  toastError.mockClear();
  useCanvasStore.setState({ nodes: [], edges: [], selectedNodeId: null } as never);
});

describe("directorDeskPanoUrlFromTask", () => {
  const task = (result: unknown, taskType = "scene_pano_generation") => ({
    task_type: taskType,
    result,
  });

  it("从任务结果里认出属于本节点的产物", () => {
    expect(directorDeskPanoUrlFromTask(task({ output_url: NODE_URL }), DESK)).toBe(NODE_URL);
    // 嵌套结构也要找得到（结果字典的字段位置不是契约）。
    expect(
      directorDeskPanoUrlFromTask(task({ data: { files: [{ url: NODE_URL }] } }), DESK),
    ).toBe(NODE_URL);
    // 带缓存参数的 URL 也认。
    expect(directorDeskPanoUrlFromTask(task({ url: `${NODE_URL}?st_v=1` }), DESK)).toBe(
      `${NODE_URL}?st_v=1`,
    );
  });

  it("不认领别的节点的产物（只作用于当前节点）", () => {
    expect(directorDeskPanoUrlFromTask(task({ output_url: OTHER_NODE_URL }), DESK)).toBeNull();
    expect(directorDeskPanoUrlFromTask(task({ output_url: NODE_URL }), OTHER_DESK)).toBeNull();
  });

  it("不认别的任务类型、非图片、空结果", () => {
    expect(directorDeskPanoUrlFromTask(task({ output_url: NODE_URL }, "stage_asset"), DESK)).toBeNull();
    expect(directorDeskPanoUrlFromTask(task({ output_url: NODE_URL.replace(".png", ".mp4") }), DESK)).toBeNull();
    expect(directorDeskPanoUrlFromTask(task(null), DESK)).toBeNull();
    expect(directorDeskPanoUrlFromTask(null, DESK)).toBeNull();
  });

  it("自引用结构不会死循环", () => {
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;
    expect(directorDeskPanoUrlFromTask(task(cyclic), DESK)).toBeNull();
  });
});

describe("AI 背景回灌到导演台", () => {
  it("本节点的任务完成 → 走三步工具链路把图接成场景全景", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => panoramaResponse()));
    const bus = fakeBus();
    const iframe = await openDesk(bus);
    const stop = await handshakeAndServe(iframe);

    try {
      act(() => {
        bus.complete({ result: { output_url: NODE_URL } });
      });

      await waitFor(() =>
        expect(toolCalls(iframe).some((call) => call.name === "director_apply")).toBe(true),
      );
      const calls = toolCalls(iframe);
      const importCall = calls.find((call) => call.args.action === "import")!;
      // 只认领本节点的产物，且字节真的按 data URL 送进去了。
      expect(String(importCall.args.data)).toMatch(/^data:image\/png;base64,/);
      expect(importCall.args).not.toHaveProperty("path");

      const applyCall = calls.find((call) => call.name === "director_apply")!;
      const [operation] = applyCall.args.operations as Array<Record<string, unknown>>;
      expect(operation.operation).toBe("add");
      expect(operation.asset).toBe("visual-panorama");
      expect(operation.id).toBe(directorDeskPanoramaEntityId(DESK));
      const layer = (
        (operation.patch as Record<string, { layers: Array<Record<string, unknown>> }>).surface
      ).layers[0];
      expect(layer.unlit).toBe(true);
      expect(layer.resourceId).toBe("media-ai-pano");

      // 旧断言盯的是一条 v2 侧没有接收方的帧；新链路不再发它。
      expect(
        framesOf(iframe).filter(
          (f) => (f as { type?: string }).type === DIRECTOR_DESK_MESSAGE_TYPES.panorama,
        ),
      ).toHaveLength(0);

      // 真正落进场景之后才宣布「已更新」。
      await waitFor(() =>
        expect(screen.getByText(/AI 背景已更新|AI background updated/)).toBeTruthy(),
      );
    } finally {
      stop();
    }
  });

  it("别的节点的任务完成 → 一条全景调用都不发", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => panoramaResponse()));
    const bus = fakeBus();
    const iframe = await openDesk(bus);
    const stop = await handshakeAndServe(iframe);

    try {
      act(() => {
        bus.complete({ result: { output_url: OTHER_NODE_URL } });
      });
      await new Promise((r) => setTimeout(r, 80));

      expect(toolCalls(iframe)).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it("任务失败不接背景（只有 task_complete 才算数）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => panoramaResponse()));
    const bus = fakeBus();
    const iframe = await openDesk(bus);
    const stop = await handshakeAndServe(iframe);

    try {
      act(() => {
        bus.emit({
          type: "task_failed",
          task: {
            task_type: "scene_pano_generation",
            result: { output_url: NODE_URL },
          } as unknown as TaskState,
          previous: null,
        });
      });
      await new Promise((r) => setTimeout(r, 80));

      expect(toolCalls(iframe)).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it("全景接不上时不谎报「已更新」", async () => {
    // 图下载失败是最容易发生的一种：产物 URL 存在，但文件已经不在项目里了。
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => new Response("", { status: 404 })),
    );
    const bus = fakeBus();
    const iframe = await openDesk(bus);
    const stop = await handshakeAndServe(iframe);

    try {
      act(() => {
        bus.complete({ result: { output_url: NODE_URL } });
      });
      await waitFor(() => expect(toolCalls(iframe)).toHaveLength(0));
      await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
      expect(screen.queryByText(/AI 背景已更新|AI background updated/)).toBeNull();
      expect(screen.queryByText(/AI 背景生成中|Generating AI background/)).toBeNull();
    } finally {
      stop();
    }
  });

  it("没有任务总线时安静工作，不抛也不崩", async () => {
    // 画布节点在部分上下文里就是没有 TaskCenterProvider 的。
    await openDesk();
    expect(document.querySelector("iframe")).not.toBeNull();
  });
});

describe("directorDeskTaskBelongsTo（失败任务只能靠 scope 认领）", () => {
  it("认自己的 scope", () => {
    expect(
      directorDeskTaskBelongsTo({ scope: `director_desk_panorama:${DESK}:job9` }, DESK),
    ).toBe(true);
  });

  it("不认别的节点 / 别的来源 / 空 scope", () => {
    expect(
      directorDeskTaskBelongsTo({ scope: `director_desk_panorama:${OTHER_DESK}:job9` }, DESK),
    ).toBe(false);
    expect(directorDeskTaskBelongsTo({ scope: "stage_asset__abc" }, DESK)).toBe(false);
    expect(directorDeskTaskBelongsTo({ scope: null }, DESK)).toBe(false);
    expect(directorDeskTaskBelongsTo(null, DESK)).toBe(false);
    // 前缀相近但不是本节点（防止 `node-a` 认领 `node-ab` 的任务）
    expect(
      directorDeskTaskBelongsTo({ scope: `director_desk_panorama:${DESK}x:job1` }, DESK),
    ).toBe(false);
  });
});

describe("生成失败要给反馈（实测：网关 CPU 保护拒单，界面上曾毫无提示）", () => {
  let listenerRef: ((e: unknown) => void) | undefined;

  function makeBus(scope: string, error: string) {
    const listeners = new Set<(e: unknown) => void>();
    listenerRef = (e) => listeners.forEach((l) => l(e));
    return {
      on: (_type: unknown, listener: (e: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit: () => undefined,
      fail: () =>
        listenerRef?.({
          type: "task_failed",
          task: { task_type: "scene_pano_generation", scope, error } as unknown as TaskState,
          previous: null,
        }),
    } as unknown as TaskEventBus & { fail: () => void };
  }

  it("本节点失败 → 弹出可读错误", async () => {
    const bus = makeBus(`director_desk_panorama:${DESK}:job1`, "system cpu overloaded");
    await openDesk(bus);
    act(() => {
      (bus as unknown as { fail: () => void }).fail();
    });
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0]?.[0])).toContain("system cpu overloaded");
  });

  it("别的节点失败 → 不打扰这个节点", async () => {
    const bus = makeBus(`director_desk_panorama:${OTHER_DESK}:job1`, "boom");
    await openDesk(bus);
    act(() => {
      (bus as unknown as { fail: () => void }).fail();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("生成期间看得见「进行中」，落地后换成「已更新」", async () => {
    // 用户点完「换背景」到图真的贴上之间有一两分钟（360 全景实测 ~100 秒）。
    // 这段空窗以前完全没有反馈：agent 说一句「已开始生成」之后界面就静止。
    // 「已更新」现在由全景链路真的跑完来报，所以这里必须握手并回话，
    // 否则那条胶囊永远不会亮 —— 那正是这个用例要守住的东西。
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => panoramaResponse()));
    const bus = fakeBus();
    const iframe = await openDesk(bus);
    const stop = await handshakeAndServe(iframe);

    try {
      act(() => {
        bus.emit({
          type: "task_updated",
          task: {
            task_type: "scene_pano_generation",
            scope: `director_desk_panorama:${DESK}:job1`,
            status: "running",
          } as TaskState,
          previous: null,
        });
      });
      expect(screen.getByText(/AI 背景生成中|Generating AI background/)).toBeTruthy();

      act(() => {
        bus.complete({ result: { output_url: NODE_URL } });
      });
      await waitFor(() =>
        expect(screen.getByText(/AI 背景已更新|AI background updated/)).toBeTruthy(),
      );
      expect(screen.queryByText(/AI 背景生成中|Generating AI background/)).toBeNull();
    } finally {
      stop();
    }
  });

  it("别的节点在生成 → 不显示进行中（隔离不靠调用点自觉）", async () => {
    const bus = fakeBus();
    await openDesk(bus);
    act(() => {
      bus.emit({
        type: "task_updated",
        task: {
          task_type: "scene_pano_generation",
          scope: `director_desk_panorama:${OTHER_DESK}:job1`,
          status: "running",
        } as TaskState,
        previous: null,
      });
    });
    expect(screen.queryByText(/AI 背景生成中|Generating AI background/)).toBeNull();
  });
});
