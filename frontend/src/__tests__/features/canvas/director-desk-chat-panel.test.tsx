// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 导演台专用对话面板。
 *
 * 用户反馈原话：「为什么导演台的 ai 助手是虾导？而且那些文案都九不搭八的」。
 * 根因是它当时直接挂了项目助手的 `SuperChatPanel`，标题/空态/占位全是项目流水线
 * 口径（虾导 / 分集、画面、配音或成片任务）。这个文件存在的意义就是把**表现层**
 * 独立出来：文案、布局、以及将来的导演台专属能力只长在这里。
 *
 * 替掉的边界：`useSuperChat`（WS 传输层，它自己另有测试）与 `MessageBubble`
 * （消息渲染，135KB，另有测试）。被测的是这个面板自己的行为。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DirectorDeskChatPanel,
  buildDirectorDeskAgentContext,
  stripDirectorDeskAgentContext,
  readStoredAutoApply,
} from "@/features/canvas/nodes/DirectorDeskChatPanel";
import type { ChatMessage, ChatScope } from "@/features/superchat/types";
import {
  buildDirectorDeskSkillPrompt,
  MONOFORM_DESK_SKILLS,
} from "@/features/canvas/nodes/directorDeskSkills";
import { readFileSync } from "node:fs";

const hookCalls: Array<{ scope?: ChatScope }> = [];
// 显式声明参数，这样 `send.mock.calls[0]` 能推断出三元组（含 transportText）。
const send = vi.fn((_text: string, _attachments?: unknown, _transportText?: string) => true);
const abort = vi.fn();

function fakeChat(overrides: Record<string, unknown> = {}) {
  return {
    abort,
    approvals: [],
    activeTurnId: null,
    busy: false,
    connected: true,
    connecting: false,
    error: null,
    activeModel: null,
    appendNotification: vi.fn(),
    clearPinned: vi.fn(),
    deleteMessage: vi.fn(),
    deletedIds: new Set<string>(),
    historyReady: true,
    messages: [] as ChatMessage[],
    models: [],
    modelsLoading: false,
    requestHistory: vi.fn(),
    refreshModels: vi.fn(),
    refreshRelayInstances: vi.fn(),
    relayInstances: [],
    resolveApproval: vi.fn(),
    selectRelayInstance: vi.fn(),
    send,
    selectedInstanceId: "",
    sessionControl: vi.fn(),
    setSettings: vi.fn(),
    settings: {},
    pinnedIds: new Set<string>(),
    streamText: "",
    switchModel: vi.fn(),
    togglePin: vi.fn(),
    ...overrides,
  };
}

let currentChat = fakeChat();
vi.mock("@/features/superchat/use-superchat", () => ({
  useSuperChat: (args: { scope?: ChatScope }) => {
    hookCalls.push(args);
    return currentChat;
  },
}));

vi.mock("@/features/superchat/superchat-panel", () => ({
  // 桩里把两个回调暴露成按钮：详情面板 / 媒体弹层的接线才测得到。
  MessageBubble: ({
    message,
    onOpenDetail,
    onOpenMedia,
  }: {
    message: ChatMessage;
    onOpenDetail: (message: ChatMessage) => void;
    onOpenMedia: (detail: { kind: "image"; src: string }) => void;
  }) => (
    <div data-testid="bubble">
      {message.text}
      <button type="button" onClick={() => onOpenDetail(message)}>
        open-detail
      </button>
      <button type="button" onClick={() => onOpenMedia({ kind: "image", src: "/shot.png" })}>
        open-media
      </button>
    </div>
  ),
  MessageDetailPanel: ({ message }: { message: ChatMessage | null }) =>
    message ? <div data-testid="detail-panel">{message.text}</div> : null,
  SpecMediaDetailModal: ({ detail }: { detail: { src: string } | null }) =>
    detail ? <div data-testid="media-modal">{detail.src}</div> : null,
}));

const postJson = vi.fn();
const apiPost = vi.fn(() => ({ json: postJson }));
vi.mock("@/lib/api", () => ({
  api: { post: (...args: unknown[]) => apiPost(...(args as [])) },
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (selector: (s: { displayName: string }) => unknown) =>
    selector({ displayName: "测试用户" }),
}));

const SCOPE: ChatScope = { kind: "directorDesk", id: "proj1/node-a" };

function message(id: string, role: ChatMessage["role"], text: string): ChatMessage {
  return { id, role, text, timestamp: 1 };
}

beforeEach(() => {
  hookCalls.length = 0;
  send.mockClear();
  abort.mockClear();
  apiPost.mockClear();
  postJson.mockReset().mockResolvedValue({ ok: true });
  toastError.mockClear();
  toastSuccess.mockClear();
  // 开关偏好是持久化的 —— 不清会让用例互相污染。
  window.localStorage.clear();
  currentChat = fakeChat();
});

describe("DirectorDeskChatPanel", () => {
  it("文案是导演台口径，不是项目流水线口径", () => {
    render(<DirectorDeskChatPanel scope={SCOPE} />);

    // 标题不再是产品级品牌名「虾导」——它在 3D 导演台里和「导演台」撞概念。
    expect(screen.getByText("导演台助手")).toBeTruthy();
    // 占位是「描述你想摆的画面」，不是「说出要推进的分集、画面、配音或成片任务」。
    const box = screen.getByRole("textbox");
    expect(box.getAttribute("placeholder")).toContain("描述你想摆的画面");
    expect(box.getAttribute("placeholder")).not.toContain("分集");
    // 空态说的是这个导演台能做的事，不是项目进度/任务失败原因 —— 也不能再承诺换背景
    // （节点已换 MONOFORM 引擎，没有背景系统；旧文案「生成对应的全景背景」是空承诺）。
    expect(screen.getByText(/我会把角色和机位摆到导演台里/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("全景背景");
    expect(document.body.textContent).not.toContain("任务失败原因");
    // 作用域承诺常驻可见。
    expect(screen.getByText("只作用于当前节点")).toBeTruthy();
  });

  it("把本节点的 scope 原样交给传输层（不自己拼项目级 scope）", () => {
    render(<DirectorDeskChatPanel scope={SCOPE} />);
    expect(hookCalls[hookCalls.length - 1]?.scope).toEqual(SCOPE);
  });

  it("没有 scope 时也不报错（面板退化而非崩）", () => {
    render(<DirectorDeskChatPanel />);
    expect(hookCalls[hookCalls.length - 1]?.scope).toBeUndefined();
    expect(screen.getByText("导演台助手")).toBeTruthy();
  });

  it("输入后 Enter 发送，发送成功清空输入框", () => {
    render(<DirectorDeskChatPanel scope={SCOPE} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "雨夜的天台" } });
    fireEvent.keyDown(box, { key: "Enter" });

    // 第 1 个参数仍是用户原话（界面上显示的就是它），上下文走第 3 个 transportText。
    expect(send.mock.calls[0]?.[0]).toBe("雨夜的天台");
    expect(String(send.mock.calls[0]?.[2])).toContain("[导演台上下文]");
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("Shift+Enter 换行而不是发送", () => {
    render(<DirectorDeskChatPanel scope={SCOPE} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "第一行" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(send).not.toHaveBeenCalled();
  });

  it("忙碌时发送按钮换成停止，停止走 abort", () => {
    currentChat = fakeChat({ busy: true });
    render(<DirectorDeskChatPanel scope={SCOPE} />);

    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
    expect(screen.getByText("正在生成，通常要一两分钟…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(abort).toHaveBeenCalled();
  });

  it("未连接时不能发送", () => {
    currentChat = fakeChat({ connected: false });
    render(<DirectorDeskChatPanel scope={SCOPE} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "雨夜的天台" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(send).not.toHaveBeenCalled();
  });

  it("历史未就绪时给同步提示，而不是空态", () => {
    currentChat = fakeChat({
      historyReady: false,
      messages: [],
      connecting: true,
      connected: false,
    });
    render(<DirectorDeskChatPanel scope={SCOPE} />);
    expect(screen.getByText(/正在连接导演台助手并同步这段对话/)).toBeTruthy();
    expect(screen.queryByText(/我会把角色和机位摆到导演台里/)).toBeNull();
  });

  it("渲染历史消息与流式内容", () => {
    currentChat = fakeChat({
      messages: [message("m1", "assistant", "已生成：雨夜天台全景")],
      streamText: "正在描绘…",
    });
    render(<DirectorDeskChatPanel scope={SCOPE} />);
    const bubbles = screen.getAllByTestId("bubble").map((n) => n.textContent ?? "");
    // 桩气泡里还挂着操作按钮（用于测详情/媒体接线），所以按「包含」判文本。
    expect(bubbles.some((text) => text.includes("已生成：雨夜天台全景"))).toBe(true);
    expect(bubbles.some((text) => text.includes("正在描绘…"))).toBe(true);
  });

  it("错误以 role=alert 露出", () => {
    currentChat = fakeChat({ error: "连接失败" });
    render(<DirectorDeskChatPanel scope={SCOPE} />);
    expect(screen.getByRole("alert").textContent).toBe("连接失败");
  });

  it("关闭按钮接的是 onRequestClose", () => {
    const onRequestClose = vi.fn();
    render(<DirectorDeskChatPanel scope={SCOPE} onRequestClose={onRequestClose} />);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onRequestClose).toHaveBeenCalled();
  });

  describe("生成背景", () => {
    it("只在导演台 scope 下出现（没有 scope 就没有这个能力）", () => {
      render(<DirectorDeskChatPanel scope={SCOPE} />);
      expect(screen.getByTitle("生成背景")).toBeTruthy();
    });

    it("非导演台 scope 时不出现 —— 隔离是结构性的，不靠调用点自觉", () => {
      render(<DirectorDeskChatPanel scope={{ kind: "project", id: "proj1" }} />);
      expect(screen.queryByTitle("生成背景")).toBeNull();
    });

    it("scope id 不完整时不出现", () => {
      render(<DirectorDeskChatPanel scope={{ kind: "directorDesk", id: "只有项目" }} />);
      expect(screen.queryByTitle("生成背景")).toBeNull();
    });

    it("描述为空时不可点", () => {
      render(<DirectorDeskChatPanel scope={SCOPE} />);
      expect((screen.getByTitle("生成背景") as HTMLButtonElement).disabled).toBe(true);
    });

    it("点了就用 scope 里的 project/node 打那条路由，并清空输入框", async () => {
      render(<DirectorDeskChatPanel scope={SCOPE} />);
      const box = screen.getByRole("textbox");
      fireEvent.change(box, { target: { value: "雨夜的天台" } });
      fireEvent.click(screen.getByTitle("生成背景"));

      await waitFor(() =>
        expect(apiPost).toHaveBeenCalledWith(
          "api/v1/projects/proj1/freezone/director-desk-panorama",
          { json: { description: "雨夜的天台", node_id: "node-a" } },
        ),
      );
      await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""));
      expect(toastSuccess).toHaveBeenCalled();
      // 对话里必须留下这次操作的记录 —— 面板长得像对话，点了按钮什么都不出现
      // 会让用户以为没生效（实测反馈）。
      const notify = currentChat.appendNotification as ReturnType<typeof vi.fn>;
      expect(notify).toHaveBeenCalled();
      expect(String(notify.mock.calls[0]?.[0])).toContain("雨夜的天台");
    });

    it("失败时给可读提示，不吞掉", async () => {
      postJson.mockRejectedValueOnce(new Error("boom"));
      render(<DirectorDeskChatPanel scope={SCOPE} />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "雨夜的天台" } });
      fireEvent.click(screen.getByTitle("生成背景"));

      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(String(toastError.mock.calls[0]?.[0])).toContain("boom");
    });

    it("生成只作用于本节点：换成另一个节点就是另一条 URL", async () => {
      render(<DirectorDeskChatPanel scope={{ kind: "directorDesk", id: "proj1/node-b" }} />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "晴天" } });
      fireEvent.click(screen.getByTitle("生成背景"));
      await waitFor(() =>
        expect(apiPost).toHaveBeenCalledWith(
          "api/v1/projects/proj1/freezone/director-desk-panorama",
          { json: { description: "晴天", node_id: "node-b" } },
        ),
      );
    });
  });

  describe("agent 上下文（只走 transportText，不污染用户可见的对话）", () => {
    const args = { project: "proj1", nodeId: "node-a", upstreamSummary: "图片「场景全景」、文本「剧本」" };

    it("上下文自带：节点 id、项目、上游素材、那条按节点隔离的路由", () => {
      const ctx = buildDirectorDeskAgentContext(args);
      expect(ctx).toContain("[导演台上下文]");
      expect(ctx).toContain("node-a");
      expect(ctx).toContain("proj1");
      expect(ctx).toContain("图片「场景全景」、文本「剧本」");
      expect(ctx).toContain("/projects/proj1/freezone/director-desk-panorama");
      // 边界要 writ 清楚：只作用当前节点
      expect(ctx).toContain("只落在当前节点");
    });

    it("body 的两个字段必须点名，不能只丢一个 JSON 模板", () => {
      // 实测：给模型一段带尖括号占位符的 JSON 模板，它会把占位符理解成「不该发的东西」，
      // 整个 body 发成 {} —— 路由回 422，用户在对话里只看到「任务执行失败」。
      const ctx = buildDirectorDeskAgentContext(args);
      expect(ctx).toContain("description");
      expect(ctx).toContain("node_id");
      expect(ctx).toContain("不能传空对象");
      expect(ctx).not.toContain("<把用户的描述整理成");
    });

    it("明确点名只读查询工具，并把写权限边界说死", () => {
      const ctx = buildDirectorDeskAgentContext(args);
      // 工具给了不引导 = 它不会用（实测问「项目到哪了」答不好）。
      expect(ctx).toContain("dramaclaw_pipeline_status");
      expect(ctx).toContain("dramaclaw_list_tasks");
      expect(ctx).toContain("dramaclaw_get_episode_script");
      // 边界：改不了就说改不了，别假装做了。
      expect(ctx).toContain("只有");
      expect(ctx).toContain("项目助手");
    });

    it("没有上游素材时给明确交代，而不是留空", () => {
      const ctx = buildDirectorDeskAgentContext({ project: "p", nodeId: "n" });
      expect(ctx).toContain("（没有接上游素材）");
    });

    it("发送时把上下文放进第 3 个参数，第 1 个仍是用户原话", () => {
      render(<DirectorDeskChatPanel scope={SCOPE} upstreamSummary="图片「上游图」" />);
      const box = screen.getByRole("textbox");
      fireEvent.change(box, { target: { value: "换成雨夜天台" } });
      fireEvent.keyDown(box, { key: "Enter" });

      expect(send).toHaveBeenCalledTimes(1);
      const [visible, attachments, outbound] = send.mock.calls[0] as unknown as [string, unknown, string];
      // 用户看到的就是自己那句话
      expect(visible).toBe("换成雨夜天台");
      expect(attachments).toEqual([]);
      // agent 拿到的是上下文 + 原话
      expect(outbound).toContain("[导演台上下文]");
      expect(outbound).toContain("图片「上游图」");
      expect(outbound).toContain("用户：换成雨夜天台");
    });

    it("没有导演台 scope 时不塞上下文（这段能力不存在）", () => {
      render(<DirectorDeskChatPanel upstreamSummary="图片「上游图」" />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "你好" } });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      const [, , outbound] = send.mock.calls[0] as unknown as [string, unknown, string];
      expect(outbound).toBe("你好");
    });
  });

  describe("上下文块不能在界面上冒出来", () => {
    const ctx = buildDirectorDeskAgentContext({ project: "p", nodeId: "n" });
    const full = `${ctx}\n\n用户：把背景换成雨夜`;

    it("回读历史时剥掉上下文，只显示用户原话", () => {
      expect(stripDirectorDeskAgentContext(full)).toBe("把背景换成雨夜");
    });

    it("技能指令块也不冒出来（选中专业技能时它跟在上下文块后面）", () => {
      // 真实结构（从浏览器里抓到的历史消息）：上下文块 → 技能块 → 「用户：」原话。
      // 三段都是 transportText 的一部分，服务端整段当用户消息存了下来。
      const withSkill = `${ctx}\n\n[技能：MONOFORM 白模台操作向导]\n你熟悉这个 MONOFORM 白模预演台，是它的操作向导。\n\n用户：站在桌前，镜头绕着他们环绕 8 秒`;
      expect(stripDirectorDeskAgentContext(withSkill)).toBe(
        "站在桌前，镜头绕着他们环绕 8 秒",
      );
    });

    it("没选技能时（上下文块后直接是原话）照常剥", () => {
      expect(stripDirectorDeskAgentContext(`${ctx}\n\n用户：回一条带表格的消息`)).toBe(
        "回一条带表格的消息",
      );
    });

    it("没有上下文的普通消息原样返回", () => {
      expect(stripDirectorDeskAgentContext("把背景换成雨夜")).toBe("把背景换成雨夜");
      expect(stripDirectorDeskAgentContext("")).toBe("");
    });

    it("块残缺（只有开头没有结尾）时原样返回，不吞消息", () => {
      const broken = `[导演台上下文]\n半截`;
      expect(stripDirectorDeskAgentContext(broken)).toBe(broken);
    });

    it("剥完为空时退回原文，不渲染空气泡", () => {
      const onlyCtx = `[导演台上下文]\n只有上下文\n[/导演台上下文]`;
      expect(stripDirectorDeskAgentContext(onlyCtx)).toBe(onlyCtx);
    });
  });
});

describe("DirectorDeskChatPanel — dd-scene 检测", () => {
  const withBlock = (move: string) =>
    "好的，我来运镜。\n```dd-scene\n" +
    JSON.stringify({ type: "director-desk-scene", camera: { move, duration: 6 } }) +
    "\n```\n已生成。";

  it("回合结束后把助手回复里的 dd-scene 解析成 intent 交给宿主", async () => {
    currentChat = fakeChat({ busy: false, messages: [message("a1", "assistant", withBlock("orbit-left"))] });
    const onSceneIntent = vi.fn();
    render(<DirectorDeskChatPanel scope={SCOPE} onSceneIntent={onSceneIntent} />);
    await waitFor(() => expect(onSceneIntent).toHaveBeenCalledTimes(1));
    expect(onSceneIntent.mock.calls[0][0].camera.move).toBe("orbit-left");
  });

  it("流式进行中（busy）不提前触发，避免抓到半截 JSON", async () => {
    currentChat = fakeChat({ busy: true, messages: [message("a1", "assistant", withBlock("dolly-in"))] });
    const onSceneIntent = vi.fn();
    render(<DirectorDeskChatPanel scope={SCOPE} onSceneIntent={onSceneIntent} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(onSceneIntent).not.toHaveBeenCalled();
  });

  it("普通回复（无块）不触发", async () => {
    currentChat = fakeChat({ busy: false, messages: [message("a1", "assistant", "就聊聊天，没有块")] });
    const onSceneIntent = vi.fn();
    render(<DirectorDeskChatPanel scope={SCOPE} onSceneIntent={onSceneIntent} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(onSceneIntent).not.toHaveBeenCalled();
  });

  it("dd-scene 块在气泡里被剥掉，用户看不到 JSON", async () => {
    currentChat = fakeChat({ busy: false, messages: [message("a1", "assistant", withBlock("pan-left"))] });
    render(<DirectorDeskChatPanel scope={SCOPE} onSceneIntent={vi.fn()} />);
    const bubble = await screen.findByTestId("bubble");
    expect(bubble.textContent).not.toContain("director-desk-scene");
    expect(bubble.textContent).toContain("已生成");
  });

  // 回归：以前解析失败是**静默丢弃** —— 用户看着不动的白模台不知道发生了什么
  // （实测：agent 输出的 dd-scene 漏了最外层 `}`）。
  it("有 dd-scene 块但解析不出来时报错，且不误应用更早的旧块", async () => {
    currentChat = fakeChat({
      busy: false,
      messages: [
        message("old", "assistant", '```dd-scene\n{"type":"director-desk-scene","camera":{"move":"orbit-left"}}\n```'),
        message("new", "assistant", '```dd-scene\n{"type":"director-desk-scene","characters":[oops\n```'),
      ],
    });
    const onSceneIntent = vi.fn();
    render(<DirectorDeskChatPanel scope={SCOPE} onSceneIntent={onSceneIntent} />);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0][0])).toContain("场景块解析失败");
    expect(onSceneIntent).not.toHaveBeenCalled();
  });
});

describe("DirectorDeskChatPanel — 技能选择器", () => {
  it("默认（无专业技能）仍注入常驻的「导演台操作专家」基础层", () => {
    render(<DirectorDeskChatPanel scope={SCOPE} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "帮我看看能做什么" } });
    fireEvent.keyDown(box, { key: "Enter" });
    const transport = String(send.mock.calls[0]?.[2]);
    expect(transport).toContain("[技能：导演台操作专家]"); // 常驻基础层
    expect(transport).toContain("[导演台上下文]");
    expect(transport).not.toContain("[专业技能："); // 没叠加任何专业技能
  });

  it("选中「电影级运镜」后基础层保留、并叠加该专业技能", () => {
    render(<DirectorDeskChatPanel scope={SCOPE} />);
    // 按钮默认显示「选择专业技能（可选）」，不是操作专家
    fireEvent.click(screen.getByText("选择专业技能（可选）"));
    fireEvent.click(screen.getByText("电影级运镜"));
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "给我一个有电影感的镜头" } });
    fireEvent.keyDown(box, { key: "Enter" });
    const transport = String(send.mock.calls[0]?.[2]);
    expect(transport).toContain("[技能：导演台操作专家]"); // 基础层仍在
    expect(transport).toContain("[专业技能：电影级运镜]"); // 叠加
  });

  it("选「通用」清空专业技能，回到只有基础层", () => {
    render(<DirectorDeskChatPanel scope={SCOPE} />);
    fireEvent.click(screen.getByText("选择专业技能（可选）"));
    fireEvent.click(screen.getByText("电影级运镜"));
    // 再打开（按钮此时显示已选技能名）选「通用」
    fireEvent.click(screen.getByText("电影级运镜"));
    fireEvent.click(screen.getByText("通用"));
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "随便聊聊" } });
    fireEvent.keyDown(box, { key: "Enter" });
    const transport = String(send.mock.calls[0]?.[2]);
    expect(transport).not.toContain("[专业技能：");
    expect(transport).toContain("[技能：导演台操作专家]");
  });

  it("弹窗列出全部专业技能，「操作专家」不在可选列表里", () => {
    render(<DirectorDeskChatPanel scope={SCOPE} />);
    fireEvent.click(screen.getByText("选择专业技能（可选）"));
    for (const name of ["分镜灵感", "电影级运镜", "角色调度走位", "构图与镜头语言", "光影氛围", "美术风格"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    // 7 个选项 = 通用 + 6 个专业技能；操作专家是常驻基础层，不作为独立可选项的**标题**出现
    expect(screen.getAllByRole("option")).toHaveLength(7);
    // 「导演台操作专家」只会作为「通用」描述里的子串出现，不该有一个以它为标题的选项
    expect(screen.queryByText("导演台操作专家")).toBeNull();
  });

  it("非导演台 scope 下不出现技能选择器（结构性隔离）", () => {
    render(<DirectorDeskChatPanel scope={{ kind: "project", id: "proj1" }} />);
    expect(screen.queryByText("选择专业技能（可选）")).toBeNull();
  });
});

describe("DirectorDeskChatPanel — 灵感提案卡片", () => {
  const proposalsMsg = () =>
    "给你几个方向，点一个应用。\n```dd-proposals\n" +
    JSON.stringify({
      type: "director-desk-proposals",
      proposals: [
        { title: "近身缠斗", summary: "贴身互搏跟拍", scene: { type: "director-desk-scene", camera: { move: "orbit-left", duration: 6 } } },
        { title: "远景对峙", summary: "缓慢环绕", scene: { type: "director-desk-scene", camera: { move: "dolly-in", duration: 8 } } },
      ],
    }) +
    "\n```";

  it("助手回复里的 dd-proposals 渲染成可点选卡片，不自动应用", async () => {
    currentChat = fakeChat({ busy: false, messages: [message("a1", "assistant", proposalsMsg())] });
    const onSceneIntent = vi.fn();
    render(<DirectorDeskChatPanel scope={SCOPE} onSceneIntent={onSceneIntent} />);
    expect(await screen.findByText("近身缠斗")).toBeTruthy();
    expect(screen.getByText("远景对峙")).toBeTruthy();
    expect(screen.getByText("贴身互搏跟拍")).toBeTruthy();
    // 关键：提案是给用户选的，绝不自动应用
    await new Promise((r) => setTimeout(r, 30));
    expect(onSceneIntent).not.toHaveBeenCalled();
  });

  it("点选一张卡片才把它的 scene 应用出去", async () => {
    currentChat = fakeChat({ busy: false, messages: [message("a1", "assistant", proposalsMsg())] });
    const onSceneIntent = vi.fn();
    render(<DirectorDeskChatPanel scope={SCOPE} onSceneIntent={onSceneIntent} />);
    fireEvent.click(await screen.findByText("远景对峙"));
    expect(onSceneIntent).toHaveBeenCalledTimes(1);
    expect(onSceneIntent.mock.calls[0][0].camera.move).toBe("dolly-in");
  });
});

/**
 * MONOFORM 白模台共用同一个面板，能做动作与运镜关键帧，但没有 360 导演台的背景系统。
 * 用户实测反馈：「AI 助手目前也还是支持全景背景是吗？」—— 面板复用时
 * agent 仍在承诺换背景，而白模台里永远不会出现。这一组锁住引擎口径的对齐。
 */
describe("DirectorDeskChatPanel — MONOFORM 引擎口径", () => {
  it("上下文不再给换背景路由，并明确说不支持", () => {
    const ctx = buildDirectorDeskAgentContext({ project: "proj1", nodeId: "node-a" }, "monoform");
    expect(ctx).toContain("[导演台上下文]");
    // 给了路由 = 让 agent 空承诺（MONOFORM 没有背景系统，宿主也没接那条管线）
    expect(ctx).not.toContain("director-desk-panorama");
    expect(ctx).toContain("没有背景系统");
    expect(ctx).toContain("直接说不支持");
    // 只读查询工具与写权限边界照旧
    expect(ctx).toContain("dramaclaw_pipeline_status");
    expect(ctx).toContain("项目助手");
  });

  it("姿势词表换成 MONOFORM 真实预设 id（假 id 会被静默回落成 idle）", () => {
    const ctx = buildDirectorDeskAgentContext({ project: "p", nodeId: "n" }, "monoform");
    for (const id of ["stand_relaxed", "squat_full", "tpose", "headShake", "sad_pose"]) {
      expect(ctx).toContain(id);
    }
    // director 的姿势行（stand/sit/... /t-pose，后两个不是 MONOFORM 合法 id）不能残留
    expect(ctx).not.toContain("内置姿势：stand");
    expect(ctx).not.toContain("t-pose");
  });

  it("相机承诺运镜（环绕/推拉/摇镜），并说明镜头跟着走动的角色", () => {
    const ctx = buildDirectorDeskAgentContext({ project: "p", nodeId: "n" }, "monoform");
    expect(ctx).toContain("orbit-left/orbit-right");
    expect(ctx).toContain("dolly-in");
    expect(ctx).toContain("pan-left/pan-right");
    expect(ctx).toContain("跟着走动的角色");
  });

  it("大白话场景由技能选择单或多镜头，不把机位术语交给用户", () => {
    const ctx = buildDirectorDeskAgentContext({ project: "p", nodeId: "n" }, "monoform");
    expect(ctx).toContain("一段唯美的爱情场景");
    expect(ctx).toContain("不要等用户说「多机位」");
    expect(ctx).not.toContain("只摆人可以不给 shots");
    const prompt = buildDirectorDeskSkillPrompt(null, "monoform");
    expect(prompt).toContain("一段唯美的爱情场景");
    expect(prompt).toContain("必须输出 shots");
    expect(prompt).toContain("单镜头或多镜头由你按叙事需要选择");
    expect(prompt).not.toContain("只有用户明确说「只要一个镜头」时才写单个 camera");
    // 不把开放的创作要求固定成旧的爱情布景与全景/越肩/反打模板。
    expect(prompt).not.toContain("加一张长椅或一棵树");
    expect(prompt).not.toContain('"name":"全景"');
  });

  it("物品与走位词表交给 agent（未知物品类型会被丢弃，不写坏工程）", () => {
    const ctx = buildDirectorDeskAgentContext({ project: "p", nodeId: "n" }, "monoform");
    for (const t of ["table(桌子)", "chair(椅子)", "sofa(沙发)", "tree(树木)", "vehicle(车辆)"]) {
      expect(ctx).toContain(t);
    }
    expect(ctx).toContain('"objects"');
    expect(ctx).toContain('"route"');
    expect(ctx).toContain("start"); // 编排：每个元素的开始时刻
  });

  it("不传 engine 仍是 director 口径（旧导演台行为不变）", () => {
    const ctx = buildDirectorDeskAgentContext({ project: "p", nodeId: "n" });
    expect(ctx).toContain("/projects/p/freezone/director-desk-panorama");
    expect(ctx).not.toContain("没有背景系统");
  });

  it("面板：无「生成背景」按钮，基础层换成白模台口径", () => {
    render(<DirectorDeskChatPanel scope={SCOPE} engine="monoform" />);
    expect(screen.queryByTitle("生成背景")).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "摆两个人面对面" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    const transport = String(send.mock.calls[0]?.[2]);
    expect(transport).toContain("[技能：MONOFORM 白模台操作向导]");
    expect(transport).not.toContain("[技能：导演台操作专家]");
    expect(transport).toContain("没有背景系统");
  });

  it("技能菜单按两组渲染，分镜灵感仍在且提示词按白模台真实能力写", () => {
    render(<DirectorDeskChatPanel scope={SCOPE} engine="monoform" />);
    fireEvent.click(screen.getByText("选择专业技能（可选）"));
    // 通用 + 操作组 4（运镜与动作/模型/场景/构图）+ 顾问组 4（含灵感）= 9
    expect(screen.getAllByRole("option")).toHaveLength(9);
    expect(screen.getByText("操作导演台")).toBeTruthy();
    expect(screen.getByText("顾问建议")).toBeTruthy();
    expect(screen.getByText("分镜灵感")).toBeTruthy();
    expect(screen.getByText("电影级运镜与动作编排")).toBeTruthy();
    expect(screen.queryByText("电影级运镜")).toBeNull();
    expect(screen.queryByText("动作编排")).toBeNull();
    // 360 导演台专属的技能（已删除/不适用）不进 MONOFORM 菜单
    expect(screen.queryByText("角色调度走位")).toBeNull();
    expect(screen.queryByText("光影氛围")).toBeNull();

    fireEvent.click(screen.getByText("分镜灵感"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "来点灵感" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    const transport = String(send.mock.calls[0]?.[2]);
    expect(transport).toContain("[专业技能：分镜灵感]");
    // 白模台现在真能做走位与运镜，提案提示词可以提运动了（静态版限制已解除）
    expect(transport).toContain("走位路线");
    expect(transport).toContain("环绕");
    expect(transport).not.toContain("只提静态方案");
  });

  it("顾问组三个技能的指令都写死了「不要输出 dd-scene」（结构性约束）", () => {
    for (const id of ["directing-method", "script-to-shots", "review-notes"]) {
      const prompt = buildDirectorDeskSkillPrompt(id, "monoform");
      expect(prompt).toContain("绝对不要输出 dd-scene");
    }
  });

  it("运镜导演的镜头清单由术语表生成（含新增的导演级 id）", () => {
    const prompt = buildDirectorDeskSkillPrompt("cinematic-camera", "monoform");
    for (const id of ["crane-up", "rail-left", "handheld", "zoom-in", "pov", "over-shoulder"]) {
      expect(prompt).toContain(id);
    }
    // 做不到的也要显式禁掉
    expect(prompt).toContain("rack-focus");
  });

  it("场景与道具技能列出了 4 个 Blender 模板与两条边界", () => {
    const prompt = buildDirectorDeskSkillPrompt("staging-props", "monoform");
    for (const template of ["rail", "crane", "light_stand", "platform"]) {
      expect(prompt).toContain(template);
    }
    expect(prompt).toContain("不是任意建模"); // 模板 ≠ 随便造模型
    expect(prompt).toContain("depthMapUrl"); // 深度地形的用法也在
  });

  it("合并技能要求完整场景、剧情动作和运镜，并兼容旧的技能选择", () => {
    const prompt = buildDirectorDeskSkillPrompt("cinematic-action", "monoform");
    expect(buildDirectorDeskSkillPrompt("action-blocking", "monoform")).toBe(prompt);
    expect(buildDirectorDeskSkillPrompt("cinematic-camera", "monoform")).toBe(prompt);
    expect(prompt).toContain("每位主要演员必须有 performance 或 route");
    expect(prompt).toContain("characters 和 objects");
    expect(prompt).toContain("camera 或 shots");
    expect(prompt).toContain("leftArm.pitch");
    expect(prompt).toContain("rightArm.pitch");
    expect(prompt).toContain("继承上一拍");
    expect(prompt).toContain("continuousMotion:false");
    // 硬边界 2：与走位动画互斥
    expect(prompt).toContain("不能同时用");
    // 硬边界 3：脚可能浮空 / 细节去滑杆
    expect(prompt).toContain("脚可能浮空");
  });

  it("动作合同使用真实 GLB 的 Arm/ForeArm pitch 与 Elbow bend 语义", () => {
    const ctx = buildDirectorDeskAgentContext({ project: "p", nodeId: "n" }, "monoform");
    const prompt = buildDirectorDeskSkillPrompt("cinematic-action", "monoform");
    for (const text of [ctx, prompt]) {
      expect(text).toContain("stand_relaxed/idle");
      expect(text).toContain("-35~-60");
      expect(text).toContain("20~45");
      expect(text).toContain("左右镜像由引擎处理");
      expect(text).toContain("Arm/ForeArm 的 twist/yaw");
      expect(text).toContain("Shoulder 是锁骨");
      expect(text).toContain("不能只写 idle 加几个");
    }
    expect(ctx).toContain("不要求用户写关节术语");
    expect(prompt).toContain("不要求用户输入这些术语");
    expect(prompt).toContain("leftArm/leftForeArm.pitch → 局部 Y 正向");
    expect(prompt).toContain("rightArm/rightForeArm.pitch → 局部 Y 反向");
    expect(prompt).toContain("leftElbow.bend → 局部 Y 反向");
    expect(prompt).toContain("rightElbow.bend → 局部 Y 正向");
  });

  it("高级舞蹈按动作层次编排，并让 camera.beats 服务动作节拍", () => {
    const ctx = buildDirectorDeskAgentContext({ project: "p", nodeId: "n" }, "monoform");
    const prompt = buildDirectorDeskSkillPrompt("cinematic-action", "monoform");
    for (const text of [ctx, prompt]) {
      expect(text).toContain("准备 → 重心转移 → 主动作 → 回应 → 停顿 → 收势");
      expect(text).toContain("两类身体层次");
      expect(text).toContain("左右不对称");
      expect(text).toContain("迟半拍回应");
      expect(text).toContain("关键帧");
      expect(text).toContain("camera.beats");
      expect(text).toContain("观看目的");
      expect(text).toContain("建立");
      expect(text).toContain("跟随");
      expect(text).toContain("停顿");
      expect(text).toContain("收束");
      expect(text).toContain("脚底 IK");
      expect(text).toContain("接触求解");
      expect(text).toContain("10~16 个有意义的 performance 节拍");
      expect(text).toContain("actions:[\"脚步\",\"上肢\"]");
      expect(text).toContain("0.2~0.6 秒");
    }
    expect(prompt).toContain("t、progress、focus、targetHeight、interpolation");
    expect(prompt).toContain("at/facing 或 route");
    expect(prompt).toContain("不让用户选择舞种");
    expect(prompt).toContain("每个手势写成准备、峰值、跟随");
    expect(prompt).toContain("不要用左右来回的重心摆动当收尾");
    expect(prompt).toContain("功夫对打");
    expect(prompt).toContain("1.1 米");
    expect(ctx).toContain("1.1 米");
    expect(prompt).toContain("6 个回合");
    expect(ctx).toContain("6 个回合");
    expect(prompt).toContain("蓄势");
    expect(prompt).toContain("不要把停顿写成 pose:\"idle\"");
    expect(prompt).toContain("收势只写在最后一拍");
    expect(prompt).toContain("功夫对打不套这套重心节拍");
    expect(ctx).toContain("功夫对打不套这套重心节拍");
    expect(prompt).toContain("同一秒");
    expect(prompt).toContain("不会自动补三台");
    for (const scene of ["单人", "对白", "争吵", "爱情", "告别", "递物见面", "追逐", "潜行", "惊吓", "喜剧", "舞蹈或唯美演出"]) {
      expect(ctx).toContain(scene);
      expect(prompt).toContain(scene);
    }
    expect(prompt).toContain("4~8 个有意义的 camera.beats");
    expect(prompt).toContain("手臂绕环");
    expect(prompt).toContain("交叉步");
    expect(ctx).toContain("camera.beats");
    expect(ctx).toContain("targetHeight");
  });

  it("新演出与局部微调有明确的姿态基础，避免 target 把旧表演带入新戏", () => {
    const ctx = buildDirectorDeskAgentContext({ project: "p", nodeId: "n" }, "monoform");
    const prompt = buildDirectorDeskSkillPrompt("cinematic-action", "monoform");
    for (const text of [ctx, prompt]) {
      expect(text).toContain('mode:"compose"');
      expect(text).toContain('mode:"edit"');
      expect(text).toContain("首拍 t:0");
      expect(text).toContain("骨骼偏移");
      expect(text).toContain("不等于 reset");
      expect(text).toContain("手工姿态");
    }
    expect(ctx).toContain("compose 默认 neutral，edit 默认 current");
    expect(prompt).toContain('poseBase:"neutral"');
    expect(prompt).toContain('poseBase:"current"');
    expect(prompt).toContain("行动、回应与停顿");
    expect(prompt).toContain("不以增加关键帧数量代替演出设计");
  });

  it("取景目标、轴线和全段时长进入常驻协议及合并技能", () => {
    const ctx = buildDirectorDeskAgentContext({ project: "p", nodeId: "n" }, "monoform");
    const prompt = buildDirectorDeskSkillPrompt("cinematic-action", "monoform");
    for (const text of [ctx, prompt]) {
      expect(text).toContain("同一时间轴");
      expect(text).toContain("0.5 秒");
      expect(text).toContain("前景人物");
      expect(text).toContain("被拍人物");
      expect(text).toContain("focus");
      expect(text).toContain("axisSide");
      expect(text).toContain("同一组镜头必须一致");
      expect(text).toContain("溢出镜头前移并尽量保留时长");
    }
    expect(ctx).toContain("camera.start + camera.duration 不得超过顶层 duration");
    expect(prompt).toContain("不能人物收手后镜头才开始推近");
    expect(prompt).toContain("不代表已看过渲染或自动验收画面");
    expect(prompt).toContain('characters[].lines');
    expect(ctx).toContain('lines:[{"text":"台词","start":秒,"end":秒}]');
    expect(prompt).toContain("不要为气泡另写关键帧");
  });

  it("只输入普通场景描述时，传输内容自动带上重编演出与镜头的约束", () => {
    render(<DirectorDeskChatPanel scope={SCOPE} engine="monoform" />);
    fireEvent.click(screen.getByText("选择专业技能（可选）"));
    fireEvent.click(screen.getByRole("option", { name: /电影级运镜与动作编排/ }));
    const request = "一段唯美的爱情演出场景";
    fireEvent.change(screen.getByRole("textbox"), { target: { value: request } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(send.mock.calls[0]?.[0]).toBe(request);
    const transport = String(send.mock.calls[0]?.[2]);
    expect(transport).toContain("[专业技能：电影级运镜与动作编排]");
    expect(transport).toContain('mode:"compose"');
    expect(transport).toContain("人物表演和镜头");
    expect(transport).toContain("行动、回应与停顿");
    expect(transport).toContain("同一个 dd-scene 里一起输出");
    expect(transport).toContain("复用场景时先检查地点是否完整");
    expect(transport).toContain(`用户：${request}`);
  });

  it("菜单分两组、组内单选（同一时刻只有一个选中）", () => {
    render(<DirectorDeskChatPanel scope={SCOPE} engine="monoform" />);
    fireEvent.click(screen.getByText("选择专业技能（可选）"));
    fireEvent.click(screen.getByText("审片建议")); // 选中 → 菜单自动关闭
    // 关闭后触发按钮显示的是选中的技能名，再点一次重新打开菜单看选中态
    fireEvent.click(screen.getByText("审片建议"));

    const selected = screen
      .getAllByRole("option")
      .filter((el) => el.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain("审片建议");
  });
});

describe("面板体验（P1）", () => {
  it("空态给三条示例指令，点一下只填进输入框、不偷偷发出去", () => {
    render(<DirectorDeskChatPanel scope={SCOPE} engine="monoform" />);
    const chip = screen.getByText("两个人面对面站着说话");
    fireEvent.click(chip);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "两个人面对面站着说话",
    );
    // 示例是给用户改的草稿，不是一键烧模型
    expect(send).not.toHaveBeenCalled();
  });

  it("点消息详情 → 打开详情面板（这里以前写死 no-op）", () => {
    currentChat = fakeChat({ messages: [message("m1", "assistant", "已经把两个人摆好了")] });
    render(<DirectorDeskChatPanel scope={SCOPE} />);
    expect(screen.queryByTestId("detail-panel")).toBeNull();
    fireEvent.click(screen.getAllByText("open-detail")[0]);
    expect(screen.getByTestId("detail-panel").textContent).toContain("已经把两个人摆好了");
  });

  it("点媒体卡 → 走 superchat 那套真实弹层（带 tags/sections/下载）", () => {
    currentChat = fakeChat({ messages: [message("m1", "assistant", "出图了")] });
    render(<DirectorDeskChatPanel scope={SCOPE} />);
    fireEvent.click(screen.getAllByText("open-media")[0]);
    expect(screen.getByTestId("media-modal").textContent).toBe("/shot.png");
  });

  it("用户上翻历史时出现「回到底部」，点了真的回底", () => {
    currentChat = fakeChat({ messages: [message("m1", "assistant", "一屏装不下的长回复")] });
    const { container } = render(<DirectorDeskChatPanel scope={SCOPE} />);
    const list = container.querySelector(".overflow-y-auto") as HTMLElement;
    const scrollTo = vi.fn();
    // jsdom 不做布局：手工造出「内容 1000px、视口 400px、当前在 100px」的离底状态
    Object.defineProperty(list, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(list, "scrollTo", { value: scrollTo, configurable: true });
    list.scrollTop = 100;
    fireEvent.scroll(list);

    fireEvent.click(screen.getByTitle("回到底部"));
    expect(scrollTo).toHaveBeenCalledWith({ top: 600, behavior: "smooth" });
  });

  it("用户刚上翻过，发消息后仍贴回底部（自己的动作要看到回应）", () => {
    currentChat = fakeChat({ messages: [message("m1", "assistant", "历史消息")] });
    const { container } = render(<DirectorDeskChatPanel scope={SCOPE} />);
    const list = container.querySelector(".overflow-y-auto") as HTMLElement;
    const scrollTo = vi.fn();
    Object.defineProperty(list, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(list, "scrollTo", { value: scrollTo, configurable: true });
    list.scrollTop = 100;
    fireEvent.scroll(list);
    expect(screen.getByTitle("回到底部")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "再近一点" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    // 发送后按钮收起 = 已经贴回底部
    expect(screen.queryByTitle("回到底部")).toBeNull();
  });
});

describe("白模台实时场景进上下文（增量修改的基准）", () => {
  const scene = "[白模台当前场景]\n- 人物 aigen_char_1「甲」 站[-2,0] 面向90° 姿势walk\n[/白模台当前场景]";

  it("场景摘要随上下文送出，并说明它该怎么用", () => {
    const ctx = buildDirectorDeskAgentContext(
      { project: "p", nodeId: "n", sceneSummary: scene },
      "monoform",
    );
    expect(ctx).toContain("白模台当前场景");
    expect(ctx).toContain("aigen_char_1");
    // 提示词得说清「基于现状只改提到的部分」，否则模型照旧全量重摆
    expect(ctx).toContain("只改他提到的那部分");
  });

  it("宿主没给摘要时不出现空章节", () => {
    const ctx = buildDirectorDeskAgentContext({ project: "p", nodeId: "n" }, "monoform");
    // 断的是注入行本身 —— 提示词里也有「白模台当前场景」几个字，拿它当判据会误伤。
    expect(ctx).not.toContain("实时内容（改场景前先看它）");
  });
});

describe("清空重来（破坏性，二次确认 + 不走模型）", () => {
  it("第一次点只是上膛，第二次点才真的清空，且不经过模型", () => {
    const onSceneIntent = vi.fn();
    render(<DirectorDeskChatPanel scope={SCOPE} onSceneIntent={onSceneIntent} />);

    fireEvent.click(screen.getByText("清空"));
    expect(onSceneIntent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("确认清空？"));
    expect(onSceneIntent).toHaveBeenCalledWith({
      type: "director-desk-scene",
      reset: true,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("宿主没接 onSceneIntent 时不显示清空按钮（没有通道就别给入口）", () => {
    render(<DirectorDeskChatPanel scope={SCOPE} />);
    expect(screen.queryByText("清空")).toBeNull();
  });
});

describe("「允许改动画面」总开关", () => {
  const AUTO_KEY = "dramaclaw.monoformDesk.autoApply";
  const sceneText =
    '已经摆好了\n```dd-scene\n{"type":"director-desk-scene","characters":[{"at":[1,1]}]}\n```';

  it("readStoredAutoApply：只有显式存过 false 才算关，缺省/垃圾值都算开", () => {
    window.localStorage.removeItem(AUTO_KEY);
    expect(readStoredAutoApply()).toBe(true);
    window.localStorage.setItem(AUTO_KEY, "true");
    expect(readStoredAutoApply()).toBe(true);
    window.localStorage.setItem(AUTO_KEY, "垃圾值");
    expect(readStoredAutoApply()).toBe(true);
    window.localStorage.setItem(AUTO_KEY, "false");
    expect(readStoredAutoApply()).toBe(false);
  });

  it("开着时自动应用（既有行为不回归）", () => {
    const onSceneIntent = vi.fn();
    currentChat = fakeChat({ messages: [message("m1", "assistant", sceneText)] });
    render(<DirectorDeskChatPanel scope={SCOPE} onSceneIntent={onSceneIntent} />);
    expect(onSceneIntent).toHaveBeenCalledTimes(1);
  });

  it("关着时不自动应用，但分镜卡仍在（用户手点应用）", () => {
    window.localStorage.setItem(AUTO_KEY, "false");
    const onSceneIntent = vi.fn();
    currentChat = fakeChat({ messages: [message("m1", "assistant", sceneText)] });
    render(<DirectorDeskChatPanel scope={SCOPE} onSceneIntent={onSceneIntent} />);

    expect(onSceneIntent).not.toHaveBeenCalled();
    // 卡片还在、且是「待应用」态 —— 关掉的是自动应用，不是这条能力
    expect(screen.getByText("分镜")).toBeTruthy();
    expect(screen.getByText("待应用")).toBeTruthy();
    expect(screen.getByText("应用")).toBeTruthy();
  });

  it("点开关打开后落盘，且从此开始自动应用", () => {
    window.localStorage.setItem(AUTO_KEY, "false");
    const onSceneIntent = vi.fn();
    currentChat = fakeChat({ messages: [message("m1", "assistant", sceneText)] });
    render(<DirectorDeskChatPanel scope={SCOPE} onSceneIntent={onSceneIntent} />);

    const toggle = screen.getByRole("button", { name: /不自动改动/ });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(window.localStorage.getItem(AUTO_KEY)).toBe("true");
    // 开关打回来时，刚才那条没被处理的场景应当被补上
    expect(onSceneIntent).toHaveBeenCalledTimes(1);
  });
});

describe("DirectorDeskChatPanel — 技能选择按节点记忆", () => {
  // 用户实测：「节点没有记忆之前选择的 skill 选项」—— 每开一次节点都要重选一遍。
  it("选过的技能在重新挂载后仍在", () => {
    const first = render(<DirectorDeskChatPanel scope={SCOPE} />);
    fireEvent.click(screen.getByRole("button", { name: /选择专业技能/ }));
    fireEvent.click(screen.getByRole("option", { name: /电影级运镜/ }));
    first.unmount();

    render(<DirectorDeskChatPanel scope={SCOPE} />);
    // 触发器上显示的是技能名，不再是「选择专业技能（可选）」。
    expect(screen.getByRole("button", { name: /电影级运镜/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /选择专业技能/ })).toBeNull();
  });

  it("按节点隔离：另一个节点的选择不会串过来", () => {
    const first = render(<DirectorDeskChatPanel scope={SCOPE} />);
    fireEvent.click(screen.getByRole("button", { name: /选择专业技能/ }));
    fireEvent.click(screen.getByRole("option", { name: /电影级运镜/ }));
    first.unmount();

    render(<DirectorDeskChatPanel scope={{ kind: "directorDesk", id: "proj1/node-b" }} />);
    expect(screen.getByRole("button", { name: /选择专业技能/ })).toBeTruthy();
  });

  it("选回「通用」会清掉记忆", () => {
    const first = render(<DirectorDeskChatPanel scope={SCOPE} />);
    fireEvent.click(screen.getByRole("button", { name: /选择专业技能/ }));
    fireEvent.click(screen.getByRole("option", { name: /电影级运镜/ }));
    fireEvent.click(screen.getByRole("button", { name: /电影级运镜/ }));
    fireEvent.click(screen.getByRole("option", { name: /通用/ }));
    first.unmount();

    render(<DirectorDeskChatPanel scope={SCOPE} />);
    expect(screen.getByRole("button", { name: /选择专业技能/ })).toBeTruthy();
  });

  it("存了个技能池里没有的 id 时退回「通用」（池子会变）", () => {
    window.localStorage.setItem("dramaclaw.monoformDesk.skill.director.node-a", "已下架的技能");
    render(<DirectorDeskChatPanel scope={SCOPE} />);
    expect(screen.getByRole("button", { name: /选择专业技能/ })).toBeTruthy();
  });
});

describe("DirectorDeskChatPanel — 顾问组技能不落地画面（硬门控）", () => {
  // 用户实测：选了【顾问建议】skill，助手还是把人物摆上了导演台。
  // 提示词里那句「绝对不要输出 dd-scene」是**软约束**—— 模型不听就没辙。
  // 这里守的是客户端这道硬门控：顾问组只出嘴，场景绝不自动应用。
  const SCENE_REPLY = "建议你先定轴线。\n\n```dd-scene\n" + JSON.stringify({
    type: "director-desk-scene",
    characters: [{ at: [-1, 0], facing: 90 }, { at: [1, 0], facing: -90 }],
    camera: { move: "static", duration: 6 },
  }) + "\n```";

  // 技能是**先选后发**的，所以用持久化预选（这也顺带验证了上一条修的记忆功能）。
  function withSkill(skillId: string) {
    window.localStorage.setItem("dramaclaw.monoformDesk.skill.monoform.node-a", skillId);
  }

  it.each([
    ["导演方法论", "directing-method"],
    ["剧本→分镜表", "script-to-shots"],
    ["审片建议", "review-notes"],
  ])("选「%s」时，回复里的 dd-scene 不自动应用", (_label, skillId) => {
    const sceneIntent = vi.fn();
    withSkill(skillId);
    currentChat = fakeChat({
      messages: [message("a1", "assistant", SCENE_REPLY)],
    });

    render(
      <DirectorDeskChatPanel scope={SCOPE} onSceneIntent={sceneIntent} engine="monoform" />,
    );

    expect(sceneIntent).not.toHaveBeenCalled();
  });

  it("切回操作组技能后，同一条场景回复能被补上（不标哨兵）", () => {
    const sceneIntent = vi.fn();
    withSkill("directing-method");
    currentChat = fakeChat({
      messages: [message("a1", "assistant", SCENE_REPLY)],
    });

    const view = render(
      <DirectorDeskChatPanel scope={SCOPE} onSceneIntent={sceneIntent} engine="monoform" />,
    );
    expect(sceneIntent).not.toHaveBeenCalled();

    // 切到操作组 → 同一条回复补上
    fireEvent.click(screen.getByRole("button", { name: /导演方法论/ }));
    fireEvent.click(screen.getByRole("option", { name: /电影级运镜/ }));
    expect(sceneIntent).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("没选技能（操作组默认）时场景照旧自动落地 —— 门控只拦顾问", () => {
    const sceneIntent = vi.fn();
    currentChat = fakeChat({
      messages: [message("a1", "assistant", SCENE_REPLY)],
    });
    render(
      <DirectorDeskChatPanel scope={SCOPE} onSceneIntent={sceneIntent} engine="monoform" />,
    );
    expect(sceneIntent).toHaveBeenCalledTimes(1);
  });

  it("分镜卡仍然渲染 —— 顾问只挡住「自动落地」，不挡住用户自己点应用", () => {
    withSkill("review-notes");
    currentChat = fakeChat({
      messages: [message("a1", "assistant", SCENE_REPLY)],
    });
    render(
      <DirectorDeskChatPanel scope={SCOPE} onSceneIntent={() => undefined} engine="monoform" />,
    );

    // 卡片在（用户可以自己点「应用」），但没有「已应用」态。
    expect(screen.getByText("分镜")).toBeTruthy();
    expect(screen.getByText("待应用")).toBeTruthy();
    expect(screen.queryByText("已应用")).toBeNull();
  });
});


describe("DirectorDeskChatPanel — 创建模型技能", () => {
  // 用户实测：MONOFORM 池里少了一个专门「生成导演台模型」的 skill
  it("操作组里有「创建模型」，提示词给三档阶梯且不许承诺任意 3D", () => {
    const skill = MONOFORM_DESK_SKILLS.find((s) => s.id === "model-maker");
    expect(skill).toBeDefined();
    expect(skill?.group).toBe("operate");
    expect(skill?.nameKey).toBe("node.directorDesk.skills.modelMaker.name");
    expect(skill?.prompt).toContain("depthMesh");
    expect(skill?.prompt).toContain("/previs-models/rail.glb");
    // 阶梯顺序：先粗模，再深度图，最后 GLB
    expect(skill?.prompt.indexOf("粗模拼装")).toBeLessThan(skill?.prompt.indexOf("depthMesh") ?? -1);
    expect(skill?.prompt.indexOf("depthMesh")).toBeLessThan(skill?.prompt.indexOf("/previs-models/") ?? -1);
    // 边界：不是任意 3D 生成
    expect(skill?.prompt).toContain("不是任意 3D 生成");
  });

  it("三语都有 modelMaker 键", () => {
    for (const L of ["zh", "en", "vi"]) {
      const d = JSON.parse(readFileSync(`public/locales/${L}/translation.json`, "utf8"));
      const s = d.node.directorDesk.skills.modelMaker;
      expect(typeof s.name).toBe("string");
      expect(s.name.length).toBeGreaterThan(0);
      expect(typeof s.desc).toBe("string");
    }
  });
});
