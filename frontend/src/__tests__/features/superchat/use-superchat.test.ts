// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeMessage } from "@/features/superchat/message";
import {
  isChatScope,
  mergeHistorySnapshot,
  pruneOldMessageCaches,
  commitAssistantText,
  upsertAssistantMessage,
  sanitizeMessagesForCache,
  reconcileScopeTurn,
  turnCompletedInHistory,
  turnHasAssistantReply,
  upsertServerAssistantMessage,
} from "@/features/superchat/use-superchat";
import type { ChatMessage, ChatRole, ChatScope } from "@/features/superchat/types";

const MESSAGE_CACHE_PREFIX = "superchat:messages:v2:";
const DAY_MS = 24 * 60 * 60 * 1000;

function message(
  id: string,
  role: ChatRole,
  text: string,
  timestamp: number,
  turnId?: string,
): ChatMessage {
  return { id, role, text, timestamp, turnId };
}

describe("mergeHistorySnapshot", () => {
  it("replaces local turn messages with matching backend history", () => {
    const current = [
      message("user-turn-1", "user", "你好", 10, "turn-1"),
      message("assistant-turn-1", "assistant", "你好，有什么可以帮你？", 20, "turn-1"),
    ];
    const history = [
      message("backend-user-1", "user", "你好", 30),
      message("backend-assistant-1", "assistant", "你好，有什么可以帮你？", 40),
    ];

    const merged = mergeHistorySnapshot(current, history, "turn-1");

    expect(merged.map((item) => item.id)).toEqual(["backend-user-1", "backend-assistant-1"]);
  });

  it("replaces a completed local turn when the final local delta is newer than backend history", () => {
    const current = [
      message("user-turn-1", "user", "你好", 100, "turn-1"),
      message("assistant-turn-1", "assistant", "你好，有什么可以帮你？", 300, "turn-1"),
    ];
    const history = [
      message("backend-user-1", "user", "你好", 150),
      message("backend-assistant-1", "assistant", "你好，有什么可以帮你？", 250),
    ];

    const merged = mergeHistorySnapshot(current, history, "turn-1");

    expect(merged.map((item) => item.id)).toEqual(["backend-user-1", "backend-assistant-1"]);
  });

  it("历史条目缺 turnId（服务端库不存 turn_id）时，流式占位仍算同一条", () => {
    // 真实时序：服务端落库时间 ≥ 本地发送时刻（user），但**必然早于**本地流式占位的
    // 最后一次 delta（assistant 的 timestamp 每次 delta 都刷成 Date.now()）。
    // 曾经 assistant 分支也用时间戳判「不算同一条」→ 每次刷新出现两遍。
    const current = [
      message("user-turn-1", "user", "摆两个人面对面", 100, "turn-1"),
      message("assistant-turn-1", "assistant", "已经摆好了", 900, "turn-1"),
    ];
    const history = [
      message("backend-user-1", "user", "摆两个人面对面", 110),
      message("backend-assistant-1", "assistant", "已经摆好了", 120),
    ];

    const merged = mergeHistorySnapshot(current, history, "turn-1");

    expect(merged.filter((item) => item.role === "assistant")).toHaveLength(1);
    expect(merged.filter((item) => item.role === "user")).toHaveLength(1);
  });

  it("replaces a completed local turn even when local partial text differs", () => {
    const current = [
      message("user-turn-1", "user", "你好", 100, "turn-1"),
      message("assistant-turn-1", "assistant", "正在生成", 120, "turn-1"),
    ];
    const history = [
      message("backend-user-1", "user", "你好", 150),
      message("backend-assistant-1", "assistant", "你好！有什么我可以帮你的吗？", 250),
    ];

    const merged = mergeHistorySnapshot(current, history, "turn-1");

    expect(merged.map((item) => item.id)).toEqual(["backend-user-1", "backend-assistant-1"]);
  });

  it("keeps the protected in-flight turn when a stale snapshot has the same user text", () => {
    const current = [
      message("backend-user-1", "user", "你好", 10),
      message("backend-assistant-1", "assistant", "第一轮回复", 20),
      message("user-turn-2", "user", "你好", 30, "turn-2"),
      message("assistant-turn-2", "assistant", "正在生成", 40, "turn-2"),
    ];
    const staleHistory = [
      message("backend-user-1", "user", "你好", 10),
      message("backend-assistant-1", "assistant", "第一轮回复", 20),
    ];

    const merged = mergeHistorySnapshot(current, staleHistory, "turn-2");

    expect(merged.map((item) => item.id)).toEqual([
      "backend-user-1",
      "backend-assistant-1",
      "user-turn-2",
      "assistant-turn-2",
    ]);
  });

  it("keeps a protected assistant reply even when it resembles an earlier turn", () => {
    const current = [
      message("backend-user-1", "user", "你好", 10, "turn-1"),
      message("backend-assistant-1", "assistant", "你好，有什么可以帮你？", 20, "turn-1"),
      message("user-turn-2", "user", "你好", 30, "turn-2"),
      message("assistant-turn-2", "assistant", "你好，有什么可以帮你？", 40, "turn-2"),
    ];
    const staleHistory = [
      message("backend-user-1", "user", "你好", 10, "turn-1"),
      message("backend-assistant-1", "assistant", "你好，有什么可以帮你？", 20, "turn-1"),
    ];

    const merged = mergeHistorySnapshot(current, staleHistory, "turn-2");

    expect(merged.map((item) => item.id)).toEqual([
      "backend-user-1",
      "backend-assistant-1",
      "user-turn-2",
      "assistant-turn-2",
    ]);
  });

  it("does not collapse repeated completed turns from backend history", () => {
    const history = [
      message("backend-user-1", "user", "你好", 10),
      message("backend-assistant-1", "assistant", "回复", 20),
      message("backend-user-2", "user", "你好", 30),
      message("backend-assistant-2", "assistant", "回复", 40),
    ];

    const merged = mergeHistorySnapshot([], history);

    expect(merged.map((item) => item.id)).toEqual([
      "backend-user-1",
      "backend-assistant-1",
      "backend-user-2",
      "backend-assistant-2",
    ]);
  });

  it("drops unprotected local assistant leftovers when backend history arrives", () => {
    const current = [
      message("backend-user-1", "user", "第一句", 10),
      message("backend-assistant-1", "assistant", "第一轮回复", 20),
      message("assistant-stale", "assistant", "上次残留的回复", 30, "turn-stale"),
    ];
    const history = [
      message("backend-user-1", "user", "第一句", 10),
      message("backend-assistant-1", "assistant", "第一轮回复", 20),
    ];

    const merged = mergeHistorySnapshot(current, history);

    expect(merged.map((item) => item.id)).toEqual(["backend-user-1", "backend-assistant-1"]);
  });
});

describe("normalizeMessage", () => {
  it("strips internal DramaClaw context blocks from displayed text", () => {
    const normalized = normalizeMessage({
      id: "backend-user-1",
      role: "user",
      content: `上传了哪些文件了

[DRAMACLAW_UPLOADED_FILES]
dramaclaw_project_id: 01KT62KTBQCDR69WW889VHJR3N
file_1_filename: 她与她的江山.docx
[/DRAMACLAW_UPLOADED_FILES]`,
      created_at: "2026-06-03T09:00:00Z",
    });

    expect(normalized?.text).toBe("上传了哪些文件了");
  });
});

describe("sanitizeMessagesForCache", () => {
  it("strips attachment inline content but keeps metadata and raw", () => {
    const original: ChatMessage = {
      id: "m1",
      role: "user",
      text: "见图",
      timestamp: 1,
      raw: { keep: "me" },
      attachments: [
        {
          fileName: "a.png",
          mimeType: "image/png",
          fileSize: 1234,
          url: "https://example/a.png",
          path: "/a.png",
          content: "data:image/png;base64,AAAA",
        },
      ],
    };

    const [sanitized] = sanitizeMessagesForCache([original]);

    expect(sanitized.attachments?.[0].content).toBeUndefined();
    expect(sanitized.attachments?.[0].fileName).toBe("a.png");
    expect(sanitized.attachments?.[0].url).toBe("https://example/a.png");
    expect(sanitized.raw).toEqual({ keep: "me" });
    // The original message must not be mutated.
    expect(original.attachments?.[0].content).toBe("data:image/png;base64,AAAA");
  });

  it("leaves messages without attachments or raw untouched", () => {
    const original: ChatMessage = { id: "m1", role: "user", text: "hi", timestamp: 1 };
    expect(sanitizeMessagesForCache([original])[0]).toBe(original);
  });

  it("de-nests raw so it can't grow across load→save cycles", () => {
    // After one round-trip, normalizeMessage stores the prior normalized
    // message under raw — which itself carries a raw field. Caching must drop
    // that inner raw so depth never exceeds 1.
    const serverPayload = { content: "<ui-spec>{}</ui-spec>" };
    const roundTripped: ChatMessage = {
      id: "m1",
      role: "assistant",
      text: "hi",
      timestamp: 1,
      raw: { id: "m1", role: "assistant", text: "hi", raw: serverPayload },
    };

    const [sanitized] = sanitizeMessagesForCache([roundTripped]);
    const raw = sanitized.raw as Record<string, unknown>;

    expect("raw" in raw).toBe(false);
    expect(raw.text).toBe("hi");
    // Re-sanitizing stays flat (stable fixpoint, no unbounded growth).
    const reSanitized = sanitizeMessagesForCache([
      { ...sanitized, raw: { ...raw, raw: serverPayload } },
    ]);
    expect("raw" in (reSanitized[0].raw as Record<string, unknown>)).toBe(false);
  });
});

describe("pruneOldMessageCaches", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("removes expired, legacy, and malformed caches but keeps fresh ones", () => {
    const now = 10 * DAY_MS;
    localStorage.setItem(
      `${MESSAGE_CACHE_PREFIX}fresh`,
      JSON.stringify({ updatedAt: now - DAY_MS, messages: [] }),
    );
    localStorage.setItem(
      `${MESSAGE_CACHE_PREFIX}stale`,
      JSON.stringify({ updatedAt: now - 8 * DAY_MS, messages: [] }),
    );
    // Legacy bare-array format has no updatedAt → reclaimed.
    localStorage.setItem(`${MESSAGE_CACHE_PREFIX}legacy`, JSON.stringify([{ id: "x" }]));
    localStorage.setItem(`${MESSAGE_CACHE_PREFIX}broken`, "{not json");
    localStorage.setItem("unrelated:key", "keep-me");

    pruneOldMessageCaches(now);

    expect(localStorage.getItem(`${MESSAGE_CACHE_PREFIX}fresh`)).not.toBeNull();
    expect(localStorage.getItem(`${MESSAGE_CACHE_PREFIX}stale`)).toBeNull();
    expect(localStorage.getItem(`${MESSAGE_CACHE_PREFIX}legacy`)).toBeNull();
    expect(localStorage.getItem(`${MESSAGE_CACHE_PREFIX}broken`)).toBeNull();
    expect(localStorage.getItem("unrelated:key")).toBe("keep-me");
  });

  it("reclaims caches with a future timestamp (clock skew / corruption)", () => {
    const now = 10 * DAY_MS;
    localStorage.setItem(
      `${MESSAGE_CACHE_PREFIX}future`,
      JSON.stringify({ updatedAt: now + DAY_MS, messages: [] }),
    );
    pruneOldMessageCaches(now);
    expect(localStorage.getItem(`${MESSAGE_CACHE_PREFIX}future`)).toBeNull();
  });
});

describe("isChatScope", () => {
  // `satisfies Record<ChatScope["kind"], true>` 才是这条测试的价值所在：
  // 以后往 ChatScope 加 kind 却忘了同步白名单，这里会**编译不过**。
  // 漏一个的后果不是报错，是 `scope.changed` 被静默丢弃、面板永远停在
  // 「正在初始化会话」—— 导演台就踩过这个坑。
  const ALL_KINDS = Object.keys({
    home: true,
    project: true,
    asset: true,
    task: true,
    directorDesk: true,
  } satisfies Record<ChatScope["kind"], true>) as ChatScope["kind"][];

  it("认下每一种 ChatScope kind", () => {
    expect(ALL_KINDS.length).toBeGreaterThan(0);
    for (const kind of ALL_KINDS) {
      expect(isChatScope({ kind, id: "x" })).toBe(true);
    }
  });

  it("拒绝未知 kind 与非对象", () => {
    expect(isChatScope({ kind: "unknown_kind", id: "x" })).toBe(false);
    expect(isChatScope(null)).toBe(false);
    expect(isChatScope("project")).toBe(false);
    expect(isChatScope({})).toBe(false);
  });
});

/**
 * 真实故障回归（2026-09-20）：一次回复在界面上**出现两遍** ——
 * 一份是本地流式占位（id = `assistant-<客户端 turn id>`），一份是服务端收尾消息
 * （帧里没带上同一个 turn id，匹配不上，于是被追加成第二条）。
 */
describe("upsertServerAssistantMessage", () => {
  const streamed = (text: string, turnId = "turn-1") =>
    message(`assistant-${turnId}`, "assistant", text, 100, turnId);

  it("服务端收尾消息没带同一个 turn id 时，折叠掉末尾的本地流式占位（不出现两条）", () => {
    const current = [message("user-turn-1", "user", "摆两个人", 10, "turn-1"), streamed("两张桌子并排摆在画面中央……")];
    const merged = upsertServerAssistantMessage(current, { id: "srv-1", text: "两张桌子并排摆在画面中央……" });
    expect(merged).toHaveLength(2);
    expect(merged.map((m) => m.id)).toEqual(["user-turn-1", "srv-1"]);
  });

  it("末尾那条不是等价占位时不折叠（两条真·相同回复都要在）", () => {
    const current = [
      message("assistant-turn-1", "assistant", "好的", 10, "turn-1"),
      message("user-turn-2", "user", "再来一次", 20, "turn-2"),
    ];
    const merged = upsertServerAssistantMessage(current, { id: "srv-2", text: "好的" });
    expect(merged).toHaveLength(3);
  });

  it("带同一个 turn id 时照旧收敛（原有行为不变）", () => {
    const current = [message("user-turn-1", "user", "你好", 10, "turn-1"), streamed("你好呀", "turn-1")];
    const merged = upsertServerAssistantMessage(current, { id: "srv-3", text: "你好呀", turn_id: "turn-1" }, "turn-1");
    expect(merged.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("文本不等价时绝不折叠（防止吞掉真实回复）", () => {
    const current = [streamed("第一版内容")];
    const merged = upsertServerAssistantMessage(current, { id: "srv-4", text: "完全不同的另一段话" });
    expect(merged).toHaveLength(2);
  });
});

describe("turnHasAssistantReply — busy 看门狗的正面证据", () => {
  // 用户实测：发完话一直转「正在生成…」，点了停止却「摆好了」。
  // 根因是 busy 被永久钉住（后端不发 chat.done / 历史合并已带回回复但 busy 不收摊），
  // 看门狗成了唯一能自救的地方。它只认「这个回合的助手回复已经落库」。
  it("回合内出现带 turnId 的助手回复 → 算结束", () => {
    const messages = [
      message("u1", "user", "摆两个人", 10, "turn-1"),
      message("a1", "assistant", "```dd-scene\n{}\n```", 20, "turn-1"),
    ];
    expect(turnHasAssistantReply(messages, "turn-1")).toBe(true);
  });

  it("只有用户消息、没有回复 → 不算结束（刚点完发送不能误清）", () => {
    const messages = [message("u1", "user", "摆两个人", 10, "turn-1")];
    expect(turnHasAssistantReply(messages, "turn-1")).toBe(false);
  });

  it("空回复不算结束（避免白回复把 busy 放掉）", () => {
    const messages = [
      message("u1", "user", "摆两个人", 10, "turn-1"),
      message("a1", "assistant", "   ", 20, "turn-1"),
    ];
    expect(turnHasAssistantReply(messages, "turn-1")).toBe(false);
  });

  // 后端 append_message 不传 turn_id，历史里的助手回复对不上号 —— 这正是必须在
  // assistant.message / scope.changed 两帧里就地收摊的原因，看门狗兜不住这种情况。
  it("历史回复不带 turnId 时看门狗认不出（兜底靠帧内收摊）", () => {
    const messages = [
      message("u1", "user", "摆两个人", 10, "turn-1"),
      message("a1", "assistant", "已经摆好了", 20),
    ];
    expect(turnHasAssistantReply(messages, "turn-1")).toBe(false);
  });

  it("别的回合的回复不算数", () => {
    const messages = [
      message("u1", "user", "摆两个人", 10, "turn-1"),
      message("a0", "assistant", "上一轮的回答", 5, "turn-0"),
    ];
    expect(turnHasAssistantReply(messages, "turn-1")).toBe(false);
  });
});

describe("reconcileScopeTurn — 断线后不能一直转圈", () => {
  it("服务端还在生成时保持转圈", () => {
    expect(reconcileScopeTurn({
      serverBusy: true,
      activeTurnId: "turn-1",
      turnLive: true,
      alreadyDone: false,
    })).toBe("keep-busy");
  });

  it("服务端没在生成、历史里也没有回复时停掉转圈", () => {
    expect(reconcileScopeTurn({
      serverBusy: false,
      activeTurnId: "turn-1",
      turnLive: true,
      alreadyDone: false,
    })).toBe("drop");
  });

  it("历史里已经有回复时收摊，即使服务端还标着忙", () => {
    expect(reconcileScopeTurn({
      serverBusy: true,
      activeTurnId: "turn-1",
      turnLive: true,
      alreadyDone: true,
    })).toBe("finish");
  });
});

describe("commitAssistantText — 同一条回复不能出现两遍", () => {
  // 用户实测反复出现「两次回复」。真实帧序是：
  //   assistant.delta ×N（流式，写进 messages，id = assistant-<turnId>）
  //   → assistant.message（服务端，按 turnId 换成分服务端 id 的那条）
  //   → chat.done（finalizeStream 只按 id 找 → 找不到就追加 → 第二条！）
  const serverMessage = (id: string, turnId: string, text: string): ChatMessage => ({
    id,
    role: "assistant",
    text,
    timestamp: 20,
    turnId,
  });
  // 流式占位的形状（= upsertAssistantMessage 造出来的那种）：id 带 assistant- 前缀。
  const streamPlaceholder = (turnId: string, text: string): ChatMessage => ({
    id: `assistant-${turnId}`,
    role: "assistant",
    text,
    timestamp: 15,
    turnId,
  });

  it("服务端消息已占位时，定稿只更新不追加", () => {
    const afterServer = upsertServerAssistantMessage(
      [message("u1", "user", "摆两个人", 10, "turn-1")],
      { id: "srv-1", role: "assistant", content: "已经摆好了", created_at: 20 },
      "turn-1",
    );
    const streamed = "已经摆好了，两人相对而立";

    const done = commitAssistantText(afterServer, "turn-1", streamed);

    expect(done.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(done[done.length - 1].text).toBe(streamed); // 更长的流式文本获胜
  });

  it("完整的 delta→message→done 序列只留一条助手回复", () => {
    let messages: ChatMessage[] = [message("u1", "user", "摆两个人", 10, "turn-1")];
    // 1) 流式：每条 delta 把累积文本写进 messages（占位 id = assistant-<turnId>）
    messages = [streamPlaceholder("turn-1", "已经")];
    messages = [streamPlaceholder("turn-1", "已经摆好了")];
    // 2) 服务端收尾帧：按 turnId 换成分服务端 id 的那条
    messages = upsertServerAssistantMessage(
      messages,
      { id: "srv-1", role: "assistant", content: "已经摆好了", created_at: 20 },
      "turn-1",
    );
    // 3) chat.done → 定稿
    messages = commitAssistantText(messages, "turn-1", "已经摆好了");

    const assistants = messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].id).toBe("srv-1");
  });

  it("后端 done 分支补发 delta 时也不会多出第二条（真实帧序）", () => {
    // chat.py 的 done 分支在 assistant.message **之后**还会补发一条 accumulated delta
    // （_should_emit_final_text 命中时）。这一步曾经把本地占位重新造出来 → 两条回复。
    let messages: ChatMessage[] = [message("u1", "user", "摆两个人", 10, "turn-1")];
    messages = [streamPlaceholder("turn-1", "已经")];
    messages = [streamPlaceholder("turn-1", "已经摆好了")];
    messages = upsertServerAssistantMessage(
      messages,
      { id: "srv-1", role: "assistant", content: "已经摆好了", created_at: 20 },
      "turn-1",
    );
    // 补发 delta：列表里已是服务端 id 的那条，必须就地更新而不是新建占位
    messages = upsertAssistantMessage(messages, "turn-1", "已经摆好了");
    messages = commitAssistantText(messages, "turn-1", "已经摆好了");

    const assistants = messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].id).toBe("srv-1");
  });

  it("没有服务端消息时照旧建本地占位（流式中断也要看得到回复）", () => {
    const done = commitAssistantText(
      [message("u1", "user", "摆两个人", 10, "turn-1")],
      "turn-1",
      "半截回复",
    );
    const assistants = done.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].id).toBe("assistant-turn-1");
  });

  it("服务端快照比流式文本短时，保留长的（中途快照不能吞掉后半段）", () => {
    const done = commitAssistantText(
      [
        message("u1", "user", "摆两个人", 10, "turn-1"),
        serverMessage("srv-1", "turn-1", "已经"),
      ],
      "turn-1",
      "已经摆好了",
    );
    expect(done[done.length - 1].text).toBe("已经摆好了");
  });
});


describe("turnCompletedInHistory — 历史 user 文本与本地不同也认得出来", () => {
  // 导演台把「上下文 + 技能指令 + 用户原话」整段作为 transportText 发出去，服务端
  // **整段存库**（chat.py: `add_user_message(username, project, text)`，text = msg.text）。
  // 于是历史里的 user 消息远长于本地乐观消息，逐字相等永远不成立 —— 曾经因此把
  // busy 永久钉住（用户实测「一直显示正在生成」）。
  it("本地是原话、历史是 transportText 时仍判定回合已完成", () => {
    const turnId = "turn-1";
    const local: ChatMessage[] = [
      { id: `user-${turnId}`, role: "user", text: "我想做一个唯美的爱情画面", turnId, timestamp: 1000 },
    ];
    const history: ChatMessage[] = [
      {
        id: "srv-user",
        role: "user",
        text: "[导演台上下文] …\n[技能：电影级运镜] …\n\n用户：我想做一个唯美的爱情画面",
        timestamp: 1005,
      },
      { id: "srv-a", role: "assistant", text: "```dd-scene …```\n摆好了", timestamp: 1010 },
    ];
    expect(turnCompletedInHistory(turnId, history, local)).toBe(true);
  });

  it("回合还没回完时，本地原话和历史里的整段上下文只留一条", () => {
    const current = [
      message("user-turn-1", "user", "一段精彩的功夫对打", 1000, "turn-1"),
    ];
    const history = [
      message(
        "srv-user",
        "user",
        "[导演台上下文]\n场景说明\n[/导演台上下文]\n\n用户：一段精彩的功夫对打",
        1005,
      ),
    ];
    const merged = mergeHistorySnapshot(current, history, "turn-1");
    expect(merged.filter((item) => item.role === "user")).toHaveLength(1);
    expect(merged[0]?.id).toBe("srv-user");
  });

  it("历史里这条 user 之后没有回复时判定未完成", () => {
    const turnId = "turn-1";
    const local: ChatMessage[] = [
      { id: `user-${turnId}`, role: "user", text: "原话", turnId, timestamp: 1000 },
    ];
    const history: ChatMessage[] = [
      { id: "srv-user", role: "user", text: "上下文 + 原话", timestamp: 1005 },
    ];
    expect(turnCompletedInHistory(turnId, history, local)).toBe(false);
  });
});
