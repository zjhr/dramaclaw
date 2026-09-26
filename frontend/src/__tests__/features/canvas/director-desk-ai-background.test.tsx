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
  DIRECTOR_DESK_AI_PANORAMA_EDGE,
  DirectorDeskNode,
  directorDeskPanoUrlFromTask,
  directorDeskTaskBelongsTo,
} from "@/features/canvas/nodes/DirectorDeskNode";
import { DIRECTOR_DESK_MESSAGE_TYPES } from "@/features/canvas/nodes/directorDeskBridge";
import { EventBusContext } from "@/task-center/event-bus-context";
import type { TaskEventBus } from "@/task-center/event-bus";
import type { TaskState } from "@/task-center/types";
import { useCanvasStore } from "@/stores/canvasStore";

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
  it("本节点的任务完成 → 往 iframe 推 panorama", async () => {
    const bus = fakeBus();
    const iframe = await openDesk(bus);

    act(() => {
      bus.complete({ result: { output_url: NODE_URL } });
    });

    await waitFor(() => {
      const pano = framesOf(iframe).filter(
        (f) => (f as { type?: string }).type === DIRECTOR_DESK_MESSAGE_TYPES.panorama,
      );
      expect(pano).toHaveLength(1);
      expect((pano[0] as { payload: Record<string, string> }).payload).toEqual({
        edgeId: DIRECTOR_DESK_AI_PANORAMA_EDGE,
        sourceNodeId: DESK,
        imageUrl: NODE_URL,
        fileName: "AI 背景",
      });
    });
  });

  it("别的节点的任务完成 → 什么都不推", async () => {
    const bus = fakeBus();
    const iframe = await openDesk(bus);

    act(() => {
      bus.complete({ result: { output_url: OTHER_NODE_URL } });
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(
      framesOf(iframe).filter(
        (f) => (f as { type?: string }).type === DIRECTOR_DESK_MESSAGE_TYPES.panorama,
      ),
    ).toHaveLength(0);
  });

  it("任务失败不推背景（只有 task_complete 才算数）", async () => {
    const bus = fakeBus();
    const iframe = await openDesk(bus);

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
    await new Promise((r) => setTimeout(r, 50));

    expect(
      framesOf(iframe).filter(
        (f) => (f as { type?: string }).type === DIRECTOR_DESK_MESSAGE_TYPES.panorama,
      ),
    ).toHaveLength(0);
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
    // 这段空窗以前完全没有反馈：agent 说一句「已开始生成」之后界面就静止，
    // 成功时唯一的信号是 3D 画面自己变了。
    const bus = fakeBus();
    await openDesk(bus);

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
