// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 导演台内的 AI 助手侧栏（原型变体 1：侧栏对话）。
 *
 * 这里锁的是**接线**，不是对话面板本身（面板有自己的测试，真实面板由浏览器
 * 实测覆盖）：面板被替成一个记录 props 的桩，因为这个测试要回答的问题是
 *
 *   1. 默认收起、点得开、关得掉；
 *   2. 挂的是同一个 `SuperChatPanel` 本体，但作用域是本节点自己的 `directorDesk`
 *      scope —— 与「项目助手」页**互不可见**，同时仍带着项目 id；
 *   3. **开合对话不能动 3D 编辑器**：iframe 的 src / key 不能变，否则消息桥会
 *      随重挂载断掉，节点永远停在「正在连接」。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirectorDeskNodeData } from "@/features/canvas/domain/canvasNodes";
import { DirectorDeskNode } from "@/features/canvas/nodes/DirectorDeskNode";
import { useCanvasStore } from "@/stores/canvasStore";

/** 面板桩：只记录宿主交给它的东西，不引入 WS / 全局 store。 */
const panelProps: Array<{
  scope?: { kind?: string; id?: string | null };
  onRequestClose?: () => void;
}> = [];
vi.mock("@/features/canvas/nodes/DirectorDeskChatPanel", () => ({
  DirectorDeskChatPanel: (props: {
    scope?: { kind?: string; id?: string | null };
    onRequestClose?: () => void;
  }) => {
    panelProps.push(props);
    return (
      <div data-testid="superchat-panel">
        <button type="button" onClick={() => props.onRequestClose?.()}>
          面板请求关闭
        </button>
      </div>
    );
  },
}));

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    ...actual,
    Handle: () => <div />,
  };
});

vi.mock("@/features/canvas/ui/NodeHeader", () => ({
  NODE_HEADER_FLOATING_POSITION_CLASS: "",
  NodeHeader: ({ titleText }: { titleText: string }) => <div>{titleText}</div>,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const DESK = "chat_rail_desk";

function seedCanvas(
  overrides: Partial<DirectorDeskNodeData> = {},
  deskId: string = DESK,
) {
  useCanvasStore.setState({
    nodes: [
      {
        id: deskId,
        type: "directorDeskNode",
        position: { x: 0, y: 0 },
        data: {
          displayName: "3D 导演台",
          isOpen: false,
          directorProjectRef: null,
          videoUrl: null,
          previewImageUrl: null,
          ...overrides,
        },
      },
    ],
    edges: [],
    selectedNodeId: deskId,
  } as never);
}

function Harness() {
  const node = useCanvasStore((state) =>
    state.nodes.find((n) => n.type === "directorDeskNode"),
  );
  if (!node) return null;
  return (
    <DirectorDeskNode
      id={node.id}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {...({ type: "directorDeskNode", dragging: false, zIndex: 0 } as any)}
      data={node.data as DirectorDeskNodeData}
      selected
    />
  );
}

function chatToggle() {
  return screen.getByRole("button", { name: /AI 助手|Assistant|Trợ lý AI/ });
}

function iframeEl(): HTMLIFrameElement {
  const frame = document.querySelector("iframe");
  if (!frame) throw new Error("no iframe");
  return frame;
}

async function renderOpenDesk(deskId: string = DESK) {
  // 项目 id 从 URL 里解（`readUrl()`）—— 这里就把 URL 摆成真实的画布路由，
  // 不替掉任何模块，验的是真实那条解析路径。
  window.history.pushState({}, "", "/projects/proj_chat/freezone?canvas=c1");
  seedCanvas({}, deskId);
  render(<Harness />);
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: /打开|Open|Mở/ }));
  });
  await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
}

/** 打开某个导演台节点的对话侧栏，返回交给面板的 scope id。 */
async function railScopeId(deskId: string): Promise<string | null | undefined> {
  // 同一个测试里渲染两次：先清掉上一棵树，否则 iframe / 「打开」按钮都会撞上旧的。
  cleanup();
  await renderOpenDesk(deskId);
  act(() => {
    fireEvent.click(chatToggle());
  });
  return panelProps[panelProps.length - 1]?.scope?.id;
}

beforeEach(() => {
  panelProps.length = 0;
});

afterEach(() => {
  useCanvasStore.setState({ nodes: [], edges: [], selectedNodeId: null } as never);
});

describe("导演台 AI 助手侧栏", () => {
  it("默认收起：全屏编辑器里没有对话面板", async () => {
    await renderOpenDesk();
    expect(screen.queryByTestId("superchat-panel")).toBeNull();
    expect(chatToggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("点「AI 助手」展开导演台自己的面板，且它挂在弹窗内部", async () => {
    await renderOpenDesk();
    act(() => {
      fireEvent.click(chatToggle());
    });

    const panel = screen.getByTestId("superchat-panel");
    expect(panel).not.toBeNull();
    // 挂的是导演台**自己的**面板组件（`DirectorDeskChatPanel`），不是项目助手的
    // `SuperChatPanel` —— 这条正是「以后能分开给导演台加功能」的结构保证：
    // 导演台的专属能力只长在那个文件里，改它不会碰项目助手。
    // 在弹窗里，不是在画布上另开一个浮层。
    expect(document.querySelector('[role="dialog"]')?.contains(panel)).toBe(true);
    expect(chatToggle().getAttribute("aria-expanded")).toBe("true");
  });

  it("交给面板的是本节点自己的 scope：存储隔离，但仍带着项目 id", async () => {
    await renderOpenDesk();
    act(() => {
      fireEvent.click(chatToggle());
    });

    const scope = panelProps[panelProps.length - 1]?.scope;
    // 独立作用域 —— 导演台的对话不进「项目助手」那一份，反之亦然。
    expect(scope?.kind).toBe("directorDesk");
    // id 是 `<project>/<node>`：节点段保证每个导演台节点一段自己的对话，
    // 项目段保证 agent 的工具仍拿得到项目上下文。
    expect(scope?.id).toBe(`proj_chat/${DESK}`);
  });

  it("两个导演台节点拿到不同的 scope（对话不互相串）", async () => {
    // 各自独立渲染一次：换节点 id 会连带重置 isOpen，同一次挂载里换不出来。
    expect(await railScopeId(DESK)).toBe(`proj_chat/${DESK}`);
    expect(await railScopeId("other_desk")).toBe("proj_chat/other_desk");
  });

  it("再点一次收起", async () => {
    await renderOpenDesk();
    act(() => {
      fireEvent.click(chatToggle());
    });
    expect(screen.queryByTestId("superchat-panel")).not.toBeNull();

    act(() => {
      fireEvent.click(chatToggle());
    });
    expect(screen.queryByTestId("superchat-panel")).toBeNull();
  });

  it("面板请求关闭时侧栏收起（onRequestClose 真的接上了）", async () => {
    await renderOpenDesk();
    act(() => {
      fireEvent.click(chatToggle());
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "面板请求关闭" }));
    });
    expect(screen.queryByTestId("superchat-panel")).toBeNull();
  });

  it("开合对话不重挂 3D 编辑器：iframe 的 src 与实例都不变", async () => {
    await renderOpenDesk();
    const frame = iframeEl();
    const srcBefore = frame.getAttribute("src");

    act(() => {
      fireEvent.click(chatToggle());
    });
    // 同一个 DOM 节点（重挂载会换掉它，消息桥随之断掉）。
    expect(iframeEl()).toBe(frame);
    expect(iframeEl().getAttribute("src")).toBe(srcBefore);

    act(() => {
      fireEvent.click(chatToggle());
    });
    expect(iframeEl()).toBe(frame);
    expect(iframeEl().getAttribute("src")).toBe(srcBefore);
  });

  it("关窗后重开：侧栏回到默认收起，不留残留状态", async () => {
    await renderOpenDesk();
    act(() => {
      fireEvent.click(chatToggle());
    });
    expect(screen.queryByTestId("superchat-panel")).not.toBeNull();

    // 真实关窗（走 closeDesk，会先存档再卸载）。
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /^(关闭|Close|Đóng)$/ }));
    });
    await waitFor(() => expect(document.querySelector("iframe")).toBeNull());
    expect(screen.queryByTestId("superchat-panel")).toBeNull();
  });
});
