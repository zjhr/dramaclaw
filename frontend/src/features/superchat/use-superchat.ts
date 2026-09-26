// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalRequest,
  ChatAttachment,
  ChatMessage,
  ChatScope,
  ClientFrame,
  ModelEntry,
  RelayInstanceInfo,
  ServerFrame,
  SessionControlCommand,
  SuperChatSettings,
} from "@/features/superchat/types";
import {
  buildLocalUserMessage,
  normalizeMessage,
} from "@/features/superchat/message";
import { hasStructuredContent } from "@/features/superchat/spec-extract";
import { api } from "@/lib/api";
import {
  isStaleByTtl,
  pruneLocalStorageByPrefix,
  registerStorageReclaimer,
  safeLocalStorageSet,
} from "@/lib/localStorageQuota";

const SETTINGS_KEY = "superchat:settings";
const EXECUTABLE_HIDDEN_TOOL_NAMES = new Set(["freezone_emit_canvas_command"]);
const MESSAGE_CACHE_PREFIX = "superchat:messages:v2:";
const MESSAGE_CACHE_LIMIT = 50;
// Refresh-recovery caches are best-effort; expire abandoned scopes so their
// blobs (one per conversation) can't accumulate forever and exhaust the quota.
const MESSAGE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_TURN_PREFIX = "superchat:active-turn:";
const ACTIVE_TURN_TTL_MS = 60 * 60 * 1000;

type ActiveTurnSnapshot = {
  turnId: string;
  startedAt: number;
};

type ChatNotificationResponse = {
  ok: boolean;
  data?: unknown;
};

function loadSettings(): SuperChatSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") as Partial<SuperChatSettings>;
    return {
      showToolEvents: raw.showToolEvents ?? false,
      showStructuredSourceWhileStreaming: raw.showStructuredSourceWhileStreaming ?? true,
      uploadTarget: raw.uploadTarget === "local" ? "local" : "openclaw",
    };
  } catch {
    return {
      showToolEvents: false,
      showStructuredSourceWhileStreaming: true,
      uploadTarget: "openclaw",
    };
  }
}

function resolveChatWsUrl(): string {
  const explicit = import.meta.env.VITE_SUPERCHAT_WS_URL;
  if (explicit) return explicit;

  const url = new URL("/api/v1/chat/ws", window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function scopeForProject(project?: string): ChatScope {
  const name = project?.trim();
  if (name) return { kind: "project", id: name };
  return { kind: "home", id: null };
}

function scopeSessionKey(scope: ChatScope): string {
  if (scope.kind === "project" && scope.id) return `supertale:project:${scope.id}:main`;
  // 导演台对话有自己的本地缓存键。漏了这条分支会退到 home 那份缓存 —— 于是
  // 导演台里的对话会串进首页对话的历史里，正是要避免的「影响其他」。
  if (scope.kind === "directorDesk" && scope.id) {
    return `supertale:director-desk:${scope.id}:main`;
  }
  return "supertale:home:main";
}

function messageCacheKey(scopeKey: string): string {
  return `${MESSAGE_CACHE_PREFIX}${scopeKey}`;
}

// `normalizeMessage` stores the whole source message under `raw`. Across a
// load→save round-trip the loaded (already-normalized) object becomes the new
// `raw`, so an un-stripped `raw` nests one level deeper every refresh and the
// cached blob grows without bound — defeating MESSAGE_CACHE_LIMIT (count-only).
// No consumer reads `raw.raw` (hasStructuredContent / extractSpecsFromRaw /
// the debug panel all read raw's top level), so drop the inner `raw` to cap
// nesting at depth 1.
function denestRaw(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  if (!("raw" in raw)) return raw;
  const { raw: _nested, ...rest } = raw as Record<string, unknown>;
  return rest;
}

// Slim a message down for the refresh-recovery cache: drop the inline
// attachment payload (base64 data URLs etc. — by far the largest field, and
// redundant since url/path/metadata are kept) and the nested `raw` chain.
export function sanitizeMessagesForCache(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    const denestedRaw = denestRaw(message.raw);
    const attachments = message.attachments?.length
      ? message.attachments.map((attachment) => {
          if (attachment.content === undefined) return attachment;
          const { content: _content, ...rest } = attachment;
          return rest;
        })
      : message.attachments;
    if (denestedRaw === message.raw && attachments === message.attachments) {
      return message;
    }
    return { ...message, raw: denestedRaw, attachments };
  });
}

function loadCachedMessages(scopeKey: string): ChatMessage[] {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(messageCacheKey(scopeKey)) || "null",
    ) as unknown;
    // Accept both the legacy bare array and the timestamped wrapper.
    const raw = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { messages?: unknown })?.messages)
        ? (parsed as { messages: unknown[] }).messages
        : [];
    return raw
      .map((message) => normalizeMessage(message))
      .filter((message): message is ChatMessage => Boolean(message));
  } catch {
    return [];
  }
}

function saveCachedMessages(
  scopeKey: string,
  messages: ChatMessage[],
  now = Date.now(),
) {
  const payload = {
    updatedAt: now,
    messages: sanitizeMessagesForCache(messages.slice(-MESSAGE_CACHE_LIMIT)),
  };
  safeLocalStorageSet(messageCacheKey(scopeKey), JSON.stringify(payload));
}

// Reclaim message caches for conversations that haven't been touched within the
// TTL (and any legacy/malformed entries). Runs on mount and as a quota
// reclaimer so a backlog of old chats can't wedge other writes.
export function pruneOldMessageCaches(now = Date.now()): void {
  pruneLocalStorageByPrefix(MESSAGE_CACHE_PREFIX, (_key, raw) => {
    let updatedAt: number | null = null;
    try {
      const parsed = JSON.parse(raw) as { updatedAt?: unknown } | null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : null;
      }
    } catch {
      updatedAt = null; // malformed
    }
    // Legacy arrays / malformed / no-timestamp → reclaim. Surviving scopes
    // rewrite themselves in the timestamped format on their next save.
    return updatedAt == null || isStaleByTtl(updatedAt, now, MESSAGE_CACHE_TTL_MS);
  });
}

registerStorageReclaimer(() => {
  pruneOldMessageCaches();
});

function activeTurnKey(scopeKey: string): string {
  return `${ACTIVE_TURN_PREFIX}${scopeKey}`;
}

function loadActiveTurn(scopeKey: string): ActiveTurnSnapshot | null {
  try {
    const raw = JSON.parse(localStorage.getItem(activeTurnKey(scopeKey)) || "null") as Partial<ActiveTurnSnapshot> | null;
    if (!raw || typeof raw.turnId !== "string" || typeof raw.startedAt !== "number") return null;
    if (!raw.turnId.trim() || Date.now() - raw.startedAt > ACTIVE_TURN_TTL_MS) {
      localStorage.removeItem(activeTurnKey(scopeKey));
      return null;
    }
    return {
      turnId: raw.turnId,
      startedAt: raw.startedAt,
    };
  } catch {
    return null;
  }
}

function saveActiveTurn(scopeKey: string, turnId: string) {
  if (!turnId.trim()) return;
  safeLocalStorageSet(
    activeTurnKey(scopeKey),
    JSON.stringify({ turnId, startedAt: Date.now() } satisfies ActiveTurnSnapshot),
  );
}

function clearActiveTurn(scopeKey: string, turnId?: string | null) {
  try {
    const current = loadActiveTurn(scopeKey);
    if (turnId && current?.turnId && current.turnId !== turnId) return;
    localStorage.removeItem(activeTurnKey(scopeKey));
  } catch {
    // best-effort cleanup
  }
}

/**
 * 这个回合的助手回复是否已经落进 messages（流式收尾和历史合并两条路都算）。
 *
 * 与 `activeTurnIsPending` 的区别：那边在「没有用户消息」时也返回 false（不算待处理），
 * 那种情况下其实**没有任何证据**表明回合结束了 —— 刚点完发送、用户消息还没落库时
 * 就会命中。所以看门狗只认这条正面证据，不用 `!pending` 反推。
 */
export function turnHasAssistantReply(
  messages: ChatMessage[],
  turnId: string | null | undefined,
): boolean {
  if (!turnId) return false;
  return messages.some(
    (message) =>
      message.role === "assistant"
      && message.turnId === turnId
      && (message.text.trim().length > 0 || hasStructuredContent(message.raw)),
  );
}

function activeTurnIsPending(messages: ChatMessage[], turnId: string | null | undefined): boolean {
  if (!turnId) return false;
  const hasUserMessage = messages.some(
    (message) => message.role === "user" && message.turnId === turnId,
  );
  if (!hasUserMessage) return false;

  return !messages.some(
    (message) =>
      message.role === "assistant"
      && message.turnId === turnId
      && (message.text.trim().length > 0 || hasStructuredContent(message.raw)),
  );
}

function loadPendingActiveTurn(scopeKey: string, messages: ChatMessage[]): ActiveTurnSnapshot | null {
  const activeTurn = loadActiveTurn(scopeKey);
  if (!activeTurn) return null;
  if (activeTurnIsPending(messages, activeTurn.turnId)) return activeTurn;
  clearActiveTurn(scopeKey, activeTurn.turnId);
  return null;
}

function currentTurnIsLive(
  turnId: string | null | undefined,
  messages: ChatMessage[],
): boolean {
  if (!turnId) return false;
  return activeTurnIsPending(messages, turnId);
}

/**
 * 重连后的 scope.changed 怎么处理本地还亮着的「正在生成」。
 * 服务端没在跑、历史里也没有回复时，不能把转圈留住：那一轮已经随断线停了。
 */
export function reconcileScopeTurn(input: {
  serverBusy: boolean | undefined;
  activeTurnId: string | null;
  turnLive: boolean;
  alreadyDone: boolean;
}): "keep-busy" | "finish" | "drop" | "idle" {
  if (input.serverBusy === true && input.turnLive && !input.alreadyDone) return "keep-busy";
  if (!input.activeTurnId) return "idle";
  if (input.alreadyDone || !input.turnLive) return "finish";
  return "drop";
}

function scopeMatches(a: ChatScope | undefined, b: ChatScope): boolean {
  if (!a) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "home") return true;
  return (a.id ?? null) === (b.id ?? null);
}

/**
 * `ChatScope["kind"]` 的运行时白名单。漏一个的后果不是报错而是**静默卡住**：
 * `scope.changed` 帧里的 scope 过不了这层，`historyReady` 就永远不置位，
 * 面板停在「正在初始化会话」。所以有测试逐个断言每个 kind 都能通过。
 */
const CHAT_SCOPE_KINDS: readonly ChatScope["kind"][] = [
  "home",
  "project",
  "asset",
  "task",
  "directorDesk",
];

export function isChatScope(value: unknown): value is ChatScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as Record<string, unknown>;
  return CHAT_SCOPE_KINDS.includes(scope.kind as ChatScope["kind"]);
}

function mergeHistory(messages: unknown[]): ChatMessage[] {
  return messages
    .map((message) => normalizeMessage(message))
    .filter((message): message is ChatMessage => Boolean(message));
}

function normalizedText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function messageSignature(message: ChatMessage): string {
  return `${message.role}:${normalizedText(message.text)}`;
}

function assistantTextEquivalent(left: string, right: string): boolean {
  const leftText = normalizedText(left);
  const rightText = normalizedText(right);
  if (!leftText || !rightText) return false;
  return leftText === rightText || leftText.startsWith(rightText) || rightText.startsWith(leftText);
}

function userTextsMatch(left: string, right: string): boolean {
  const a = normalizedText(left);
  const b = normalizedText(right);
  if (!a || !b) return false;
  if (a === b) return true;
  // 导演台把上下文拼在原话前面存库。回读时文本比本地气泡长，但以原话结尾。
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  if (!longer.endsWith(shorter)) return false;
  return longer.includes("[导演台上下文]") || longer.includes("用户：") || longer.includes("用户:");
}

function hasEquivalentTextMessage(message: ChatMessage, history: ChatMessage[]): boolean {
  /*
    user 分支用时间戳兜底：历史里的 user 消息**没有 turn_id**（服务端库无此列），
    所以「本地新消息 vs 过期快照里更早的同文本消息」只能靠时间戳区分 —— 没有它，
    用户刚发出的那轮消息会被上一轮的同文本消息吞掉（有回归测试守着）。

    assistant 分支**刻意不这么做**：服务端落库时间必然早于本地流式占位的
    `Date.now()`，用时间戳判「不算同一条」等于每次刷新都把同一段回复显示两遍
    （用户实测报的 bug）。turnId 两边都有且不同，才是真的不同一条。
  */
  if (message.role !== "assistant") {
    return history.some((entry) => {
      if (entry.role === "user" ? !userTextsMatch(message.text, entry.text) : messageSignature(entry) !== messageSignature(message)) {
        return false;
      }
      if (message.turnId && entry.turnId && message.turnId !== entry.turnId) return false;
      if (message.turnId && !entry.turnId && entry.timestamp < message.timestamp) return false;
      return true;
    });
  }
  return history.some(
    (entry) => {
      if (entry.role !== "assistant") return false;
      if (message.turnId && entry.turnId && message.turnId !== entry.turnId) return false;
      return assistantTextEquivalent(message.text, entry.text);
    },
  );
}

function messageSortRank(message: ChatMessage): number {
  if (message.role === "user") return 0;
  if (message.role === "tool") return 1;
  if (message.role === "assistant") return 2;
  return 3;
}

function sortMessages(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort((left, right) => {
    if (left.turnId && right.turnId && left.turnId === right.turnId) {
      const rank = messageSortRank(left) - messageSortRank(right);
      if (rank !== 0) return rank;
    }
    return left.timestamp - right.timestamp;
  });
}

function hasSameTurnMessage(message: ChatMessage, history: ChatMessage[]): boolean {
  if (!message.turnId) return false;
  return history.some((entry) => entry.role === message.role && entry.turnId === message.turnId);
}

function hasEquivalentHistoryMessage(
  message: ChatMessage,
  history: ChatMessage[],
): boolean {
  if (history.some((entry) => entry.id === message.id)) return true;
  if (hasSameTurnMessage(message, history)) return true;
  return hasEquivalentTextMessage(message, history);
}

function hasCompletedTurnInHistory(
  message: ChatMessage,
  history: ChatMessage[],
  current: ChatMessage[],
): boolean {
  if (!message.turnId) return false;
  return turnCompletedInHistory(message.turnId, history, current);
}

export function turnCompletedInHistory(
  turnId: string,
  history: ChatMessage[],
  current: ChatMessage[],
): boolean {
  const localUser = current.find(
    (entry) => entry.turnId === turnId && entry.role === "user",
  );
  if (!localUser) return false;

  // 导演台（以及任何走 `transportText` 的调用方）把上下文拼在用户原话前面一起发出去，
  // 服务端**整段存库**，所以历史里的 user 文本远长于本地乐观消息，逐字相等永远不成立。
  // 于是改用「历史里 localUser 之后最近的那条 user」来定位这一轮 —— 落库时间不会早于
  // 发送时刻，且一轮只有一条 user，所以它是无歧义的锚点。
  const localIndex = current.findIndex((entry) => entry.turnId === turnId && entry.role === "user");
  const backendUser = history
    .filter((entry) => entry.role === "user" && entry.timestamp >= localUser.timestamp)
    .sort((left, right) => left.timestamp - right.timestamp)[localIndex < 0 ? 0 : 0];
  if (!backendUser) return false;

  return history.some(
    (entry) =>
      entry.role === "assistant"
      && entry.timestamp >= backendUser.timestamp
  );
}

export function mergeHistorySnapshot(
  current: ChatMessage[],
  history: ChatMessage[],
  protectedTurnId: string | null = null,
  preserveTransient = false,
): ChatMessage[] {
  if (current.length === 0) return history;
  if (history.length === 0) return current;
  if (!protectedTurnId && !preserveTransient) {
    return history;
  }

  const preserved = current.filter((message) => {
    const isProtectedTurn = Boolean(protectedTurnId && message.turnId === protectedTurnId);
    if (protectedTurnId && !isProtectedTurn) return false;
    if (message.role === "tool") {
      if (!preserveTransient && !isProtectedTurn) return false;
      return !hasEquivalentHistoryMessage(message, history);
    }
    if (hasCompletedTurnInHistory(message, history, current)) return false;
    return !hasEquivalentHistoryMessage(message, history);
  });

  const protectedLocalUser = protectedTurnId
    ? current.find((entry) => entry.turnId === protectedTurnId && entry.role === "user")
    : null;
  const protectedBackendUser = protectedLocalUser
    ? history.find(
      (entry) =>
        entry.role === "user"
        && normalizedText(entry.text) === normalizedText(protectedLocalUser.text)
        && entry.timestamp >= protectedLocalUser.timestamp,
    )
    : null;
  const protectedBackendAssistant = protectedBackendUser
    ? history.find(
      (entry) =>
        entry.role === "assistant"
        && entry.timestamp >= protectedBackendUser.timestamp,
    )
    : null;
  const protectedToolCount = preserved.filter((message) => message.role === "tool").length;
  let protectedToolIndex = 0;
  const stablePreserved = preserved.map((message) => {
    if (message.role !== "tool" || !protectedBackendUser) return message;
    protectedToolIndex += 1;
    const end = protectedBackendAssistant?.timestamp ?? protectedBackendUser.timestamp + protectedToolCount + 1;
    const gap = Math.max(0.001, end - protectedBackendUser.timestamp);
    return {
      ...message,
      timestamp: protectedBackendUser.timestamp + (gap * protectedToolIndex) / (protectedToolCount + 1),
    };
  });

  return sortMessages(collapseDuplicateAssistants([...history, ...stablePreserved]));
}

/**
 * 同一轮回复在界面上只留一条。
 *
 * 服务端落库的 assistant **没有 turn_id**，本地流式占位有。历史合并时如果两段文本
 * 还没形成前缀关系（流式半截 vs 已落库全文、或时间戳对不齐导致占位没被丢掉），
 * 两条会同时留下来。这里只折叠「中间没有用户消息」的助手重复：同一轮里较长的那份
 * 留下。隔着用户消息的两条独立回复不动。
 */
export function collapseDuplicateAssistants(messages: ChatMessage[]): ChatMessage[] {
  const kept: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") {
      kept.push(message);
      continue;
    }
    const duplicateIndex = kept.findIndex((entry, index) => {
      if (entry.role !== "assistant") return false;
      const sameTurn = Boolean(message.turnId && entry.turnId && message.turnId === entry.turnId);
      const equivalent = assistantTextEquivalent(entry.text, message.text);
      if (!sameTurn && !equivalent) return false;
      return !kept.slice(index + 1).some((between) => between.role === "user");
    });
    if (duplicateIndex < 0) {
      kept.push(message);
      continue;
    }
    const previous = kept[duplicateIndex];
    kept[duplicateIndex] = {
      ...previous,
      id: previous.id.startsWith("assistant-") ? message.id : previous.id,
      text: previous.text.length >= message.text.length ? previous.text : message.text,
      turnId: previous.turnId ?? message.turnId,
    };
  }
  return kept;
}

export function upsertAssistantMessage(
  messages: ChatMessage[],
  turnId: string,
  text: string,
): ChatMessage[] {
  const id = `assistant-${turnId}`;
  /*
    先按 id 找，再按 turnId 兜底。

    为什么需要 turnId 兜底：后端 `chat.py` 的 done 分支会在 `assistant.message` **之后**
    补发一条 `assistant.delta`（`_should_emit_final_text` 命中时）。此时列表里已经是
    **服务端 id** 的那条了（同一个 turnId），只按 id 找就找不到 → 又建一个本地占位 →
    同一条回复在界面上出现两遍（用户实测反复报这个）。按 turnId 认到服务端那条后就地
    更新它，占位根本不会被造出来。
  */
  const existingIndex =
    messages.findIndex((message) => message.id === id) >= 0
      ? messages.findIndex((message) => message.id === id)
      : messages.findIndex((message) => message.role === "assistant" && message.turnId === turnId);
  if (existingIndex >= 0) {
    return sortMessages(
      messages.map((message, index) =>
        index === existingIndex
          ? { ...message, text, timestamp: Date.now() }
          : message,
      ),
    );
  }
  return sortMessages([
    ...messages,
    {
      id,
      role: "assistant",
      text,
      turnId,
      timestamp: Date.now(),
    },
  ]);
}

/**
 * 把这条回合的助手回复**定稿**入列。
 *
 * 为什么不能直接用 upsertAssistantMessage：流式期间每条 `assistant.delta` 都会把
 * 累积文本写进 messages（id = `assistant-<turnId>`），随后服务端的 `assistant.message`
 * 帧又按 turnId 把它换成服务端 id 的那条。等 `chat.done` 走到这里，列表里已经是
 * **服务端 id** 的那条了 —— 只按 id 找就找不到，于是追加成第二条：同一条回复在界面上
 * 出现两遍（用户实测反复报这个）。所以按 turnId 认，命中就地更新。
 *
 * 文本取**较长**的那份：服务端那条可能是流式中途的快照，比本地累积文本短。
 */
export function commitAssistantText(
  messages: ChatMessage[],
  turnId: string,
  text: string,
): ChatMessage[] {
  const existingIndex = messages.findIndex(
    (message) => message.role === "assistant" && message.turnId === turnId,
  );
  if (existingIndex < 0) return upsertAssistantMessage(messages, turnId, text);
  return messages.map((message, index) =>
    index === existingIndex
      ? { ...message, text: message.text.length >= text.length ? message.text : text }
      : message,
  );
}

/**
 * 服务端收尾的 assistant 消息入列。
 *
 * 关键：本地**流式占位**（id = `assistant-<客户端 turn id>`，见 upsertAssistantMessage）
 * 和服务端这条是两个不同 id。当帧里没带上同一个 turn id（实测出现过：整条回复因此
 * 在界面上**出现两遍**，一份是本地占位、一份是服务端消息）就匹配不上，会追加成第二条。
 *
 * 折叠规则：只有当那条占位确实在**列表末尾**、且文本与收尾消息等价时才折叠。
 * 两条真·相同的独立回复不会以「本地占位」身份停在末尾（中间必有 user 消息），所以不误吞。
 */
export function upsertServerAssistantMessage(
  messages: ChatMessage[],
  payload: unknown,
  turnId?: string,
): ChatMessage[] {
  const nextMessage = normalizeMessage(payload, "assistant");
  if (!nextMessage) return messages;
  const normalizedTurnId = nextMessage.turnId ?? (turnId?.trim() || undefined);
  const mergedMessage = normalizedTurnId ? { ...nextMessage, turnId: normalizedTurnId } : nextMessage;
  const existingIndex = messages.findIndex((message) => message.id === mergedMessage.id);
  const tail = messages[messages.length - 1];
  const foldTailIndex =
    existingIndex < 0
    && tail
    && tail.id !== mergedMessage.id
    && tail.role === "assistant"
    && tail.id.startsWith("assistant-")
    && assistantTextEquivalent(tail.text, mergedMessage.text)
      ? messages.length - 1
      : -1;
  const dropIndex = existingIndex >= 0 ? existingIndex : foldTailIndex;
  const withoutTransient =
    dropIndex >= 0 || normalizedTurnId
      ? messages.filter(
          (message, index) =>
            index !== dropIndex
            && !(
              normalizedTurnId
              && message.role === "assistant"
              && message.turnId === normalizedTurnId
            ),
        )
      : messages;
  return sortMessages(collapseDuplicateAssistants([...withoutTransient, mergedMessage]));
}

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const value = result as Record<string, unknown>;
  if (typeof value.text === "string") return value.text;
  return JSON.stringify(result, null, 2);
}

function buildToolMessage(kind: string, payload: unknown): ChatMessage {
  const data = payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};
  const label =
    typeof data.name === "string"
      ? data.name
      : typeof data.message === "string"
        ? data.message
        : kind;
  const body = "result" in data ? resultText(data.result) : JSON.stringify(payload, null, 2);
  return {
    id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: "tool",
    text: body ? `${label}\n\n${body}` : label,
    turnId: typeof data.turn_id === "string" ? data.turn_id : undefined,
    timestamp: Date.now(),
    raw: payload,
  };
}

export function shouldPreserveToolMessage(payload: ServerFrame): boolean {
  const text =
    payload.type === "tool.result" && typeof payload.result === "string"
      ? payload.result
      : payload.type === "tool.result" &&
          payload.result &&
          typeof payload.result === "object" &&
          typeof (payload.result as Record<string, unknown>).text === "string"
        ? String((payload.result as Record<string, unknown>).text)
        : "";
  return (
    (payload.type === "tool.result" || payload.type === "tool.call") &&
    (
      (typeof payload.name === "string" && EXECUTABLE_HIDDEN_TOOL_NAMES.has(payload.name)) ||
      text.includes("canvas_chat_commands.v1") ||
      text.includes("canvas_command_emitted")
    )
  );
}

function upsertToolMessage(messages: ChatMessage[], kind: string, payload: unknown): ChatMessage[] {
  const nextMessage = buildToolMessage(kind, payload);
  if (!nextMessage.turnId) return sortMessages([...messages, nextMessage]);

  const existingIndex = messages.findIndex(
    (message) => message.role === "tool" && message.turnId === nextMessage.turnId,
  );
  if (existingIndex < 0) return sortMessages([...messages, nextMessage]);

  return sortMessages(
    messages.map((message, index) =>
      index === existingIndex
        ? {
          ...message,
          text: nextMessage.text,
          timestamp: nextMessage.timestamp,
          raw: nextMessage.raw,
        }
        : message,
    ),
  );
}

export function useSuperChat({
  project,
  displayName,
  scope,
}: {
  project?: string;
  displayName: string;
  /** 显式作用域 —— directorDesk 的对话靠它把自己从项目主对话里隔离出去。 */
  scope?: ChatScope;
}) {
  const desiredScope = useMemo(() => scope ?? scopeForProject(project), [scope, project]);
  const scopeKey = useMemo(() => scopeSessionKey(desiredScope), [desiredScope]);
  const initialScopeSnapshot = useMemo(() => {
    const cachedMessages = loadCachedMessages(scopeKey);
    const activeTurn = loadPendingActiveTurn(scopeKey, cachedMessages);
    return {
      cachedMessages,
      activeTurnId: activeTurn?.turnId ?? null,
    };
  }, [scopeKey]);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(() => initialScopeSnapshot.cachedMessages);
  const [historyReady, setHistoryReady] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [relayInstances, setRelayInstances] = useState<RelayInstanceInfo[]>([]);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>("");
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => new Set());
  const [deletedIds, setDeletedIds] = useState<Set<string>>(() => new Set());
  const [settings, setSettingsState] = useState<SuperChatSettings>(() => loadSettings());
  const [busy, setBusy] = useState(() => Boolean(initialScopeSnapshot.activeTurnId));
  const [activeTurnId, setActiveTurnId] = useState<string | null>(initialScopeSnapshot.activeTurnId);
  const streamTextRef = useRef("");
  const streamFlushRef = useRef<number | null>(null);
  const messagesRef = useRef<ChatMessage[]>(initialScopeSnapshot.cachedMessages);
  const activeTurnIdRef = useRef<string | null>(initialScopeSnapshot.activeTurnId);
  const pendingClientTurnIdRef = useRef<string | null>(null);
  const recentlyCompletedTurnIdRef = useRef<string | null>(null);
  const cancelledTurnIdsRef = useRef<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const closedRef = useRef(false);
  const authRejectedRef = useRef(false);
  const connectionIdRef = useRef(0);

  const sendFrame = useCallback((frame: ClientFrame) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }, []);

  const requestHistory = useCallback(() => {
    sendFrame({ type: "scope.set", scope: desiredScope });
  }, [desiredScope, sendFrame]);

  const markTurnActive = useCallback((turnId: string | null) => {
    if (!turnId) return;
    activeTurnIdRef.current = turnId;
    setActiveTurnId(turnId);
    recentlyCompletedTurnIdRef.current = null;
    saveActiveTurn(scopeKey, turnId);
    setBusy(true);
  }, [scopeKey]);

  const markTurnInactive = useCallback((turnId?: string | null) => {
    clearActiveTurn(scopeKey, turnId);
    streamTextRef.current = "";
    activeTurnIdRef.current = null;
    setActiveTurnId(null);
    pendingClientTurnIdRef.current = null;
    recentlyCompletedTurnIdRef.current = turnId ?? null;
    setStreamText("");
    setBusy(false);
  }, [scopeKey]);

  const setSettings = useCallback((patch: Partial<SuperChatSettings>) => {
    setSettingsState((current) => {
      const next = { ...current, ...patch };
      safeLocalStorageSet(SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const finalizeStream = useCallback(() => {
    if (streamFlushRef.current != null) {
      window.cancelAnimationFrame(streamFlushRef.current);
      streamFlushRef.current = null;
    }
    const turnId = activeTurnIdRef.current ?? `turn-${Date.now()}`;
    if (cancelledTurnIdsRef.current.has(turnId)) {
      markTurnInactive(turnId);
      return;
    }
    setMessages((current) => {
      if (!streamTextRef.current.trim()) return current;
      // 按 turnId 定稿：服务端消息可能已经占了这条回合（id 不同），按 id 追加会出两条。
      return commitAssistantText(current, turnId, streamTextRef.current);
    });
    markTurnInactive(turnId);
    // Post-done history refresh is intentionally disabled; final assistant
    // messages are now pushed through assistant.message.
  }, [markTurnInactive]);

  const handleFrame = useCallback((frame: ServerFrame) => {
    /*
      服务端的 `busy` 只在 scope.changed 帧上有意义，别处是「这条路径不发射该字段」，
      不是「不在跑」。JS 的 ?? 对 unknown 帮不上忙，所以在这里显式收敛成布尔，
      让下游的比较都是 `boolean | undefined` 而不是 `unknown`。
    */
    const serverBusy =
      "busy" in frame && typeof frame.busy === "boolean" ? frame.busy : undefined;
    switch (frame.type) {
      case "scope.changed": {
        setConnected(true);
        setConnecting(false);
        setError(null);
        const frameScope = isChatScope(frame.scope) ? frame.scope : undefined;
        if (!scopeMatches(frameScope, desiredScope)) break;
        setHistoryReady(true);
        const history = mergeHistory(Array.isArray(frame.history) ? frame.history : []);
        const currentMessages = messagesRef.current;
        const protectedTurnId = activeTurnIdRef.current ?? recentlyCompletedTurnIdRef.current;
        setMessages((current) => {
          const preserveRemoteBusy = frame.busy === true && currentTurnIsLive(protectedTurnId, current);
          return mergeHistorySnapshot(current, history, protectedTurnId, preserveRemoteBusy);
        });
        const activeTurnId = activeTurnIdRef.current;
        // 判「回合还活着」不能只看合并前的旧 messages：后端落库的 assistant 消息
        // **不带 turn_id**（append_message 没传），而 activeTurnIsPending 只认带 turnId
        // 的回复，于是合并前后都认为还活着。此时后端只要补一帧 busy:true，busy 就被
        // 永久钉住 —— 而回复其实早就躺在 history 里了。所以先问一句「历史里是否已经
        // 有这条回合的回复」（那个 helper 用文本+时间戳认，不依赖 turn_id）。
        const alreadyDoneInHistory = activeTurnId
          ? turnCompletedInHistory(activeTurnId, history, currentMessages)
          : false;
        const turnAction = reconcileScopeTurn({
          serverBusy,
          activeTurnId,
          turnLive: currentTurnIsLive(activeTurnId, currentMessages),
          alreadyDone: alreadyDoneInHistory,
        });
        if (turnAction === "keep-busy") {
          setBusy(true);
        } else if (turnAction === "finish") {
          markTurnInactive(activeTurnId);
        } else if (turnAction === "drop") {
          markTurnInactive(activeTurnId);
          setError("连接中断了，这条还没有生成，请再发一次。");
        } else if (!activeTurnIdRef.current) {
          streamTextRef.current = "";
          recentlyCompletedTurnIdRef.current = null;
          setStreamText("");
          setBusy(false);
        }
        break;
      }
      case "chat.busy": {
        const message = typeof frame.message === "string" ? frame.message : null;
        if (message) setError(message);
        const turnId =
          activeTurnIdRef.current
          ?? pendingClientTurnIdRef.current
          ?? (typeof frame.turn_id === "string" && frame.turn_id.trim() ? frame.turn_id : null);
        if (turnId) {
          markTurnActive(turnId);
        } else {
          setBusy(true);
        }
        break;
      }
      case "chat.ping": {
        if (
          typeof frame.turn_id === "string"
          && cancelledTurnIdsRef.current.has(frame.turn_id)
        ) {
          break;
        }
        const turnId =
          activeTurnIdRef.current
          ?? pendingClientTurnIdRef.current
          ?? (typeof frame.turn_id === "string" && frame.turn_id.trim() ? frame.turn_id : null);
        if (turnId) {
          markTurnActive(turnId);
        } else {
          setBusy(true);
        }
        break;
      }
      case "thread.started":
        if (
          typeof frame.turn_id === "string"
          && cancelledTurnIdsRef.current.has(frame.turn_id)
        ) {
          break;
        }
        activeTurnIdRef.current = pendingClientTurnIdRef.current
          ?? (typeof frame.turn_id === "string" && frame.turn_id.trim() ? frame.turn_id : activeTurnIdRef.current);
        if (activeTurnIdRef.current) {
          markTurnActive(activeTurnIdRef.current);
        }
        recentlyCompletedTurnIdRef.current = null;
        break;
      case "assistant.delta": {
        const next = typeof frame.text === "string" ? frame.text : "";
        if (!next) break;
        if (
          typeof frame.turn_id === "string"
          && cancelledTurnIdsRef.current.has(frame.turn_id)
        ) {
          break;
        }
        setBusy(true);
        streamTextRef.current = frame.accumulated === false
          ? `${streamTextRef.current}${next}`
          : next;
        const turnId =
          pendingClientTurnIdRef.current
          ?? activeTurnIdRef.current
          ?? (typeof frame.turn_id === "string" && frame.turn_id.trim() ? frame.turn_id : null);
        if (turnId && streamTextRef.current.trim()) {
          markTurnActive(turnId);
          // 一个动画帧最多刷一次。逐 token setState 会让整段 Markdown 每字重解析，
          // 看起来就是「一个字一个字卡着出来」。
          if (streamFlushRef.current == null) {
            const flushTurnId = turnId;
            streamFlushRef.current = window.requestAnimationFrame(() => {
              streamFlushRef.current = null;
              const displayText = streamTextRef.current;
              if (!displayText.trim()) return;
              setMessages((current) => upsertAssistantMessage(current, flushTurnId, displayText));
            });
          }
        }
        setStreamText("");
        break;
      }
      case "assistant.message":
        setMessages((current) =>
          upsertServerAssistantMessage(
            current,
            frame.message,
            typeof frame.turn_id === "string" ? frame.turn_id : undefined,
          ),
        );
        // 注意：这里**不负责收摊**。后端的 assistant_message 是流式事件，一轮里可能
        // 来好几条（chat.py 的转发分支），在这里关 busy 会让用户在 agent 还在跑时就
        // 又能发一条（后端会回「已有对话正在处理中」）。收摊交给 chat.done、以及
        // 下面那个只看「回合回复已落库」的看门狗。
        break;
      case "tool.call":
        if (
          typeof frame.turn_id === "string"
          && cancelledTurnIdsRef.current.has(frame.turn_id)
        ) {
          break;
        }
        if (settings.showToolEvents || shouldPreserveToolMessage(frame)) {
          setMessages((current) => upsertToolMessage(current, frame.type, frame));
        }
        break;
      case "tool.result":
        if (
          typeof frame.turn_id === "string"
          && cancelledTurnIdsRef.current.has(frame.turn_id)
        ) {
          break;
        }
        if (typeof frame.turn_id === "string" && frame.turn_id.trim()) {
          markTurnActive(frame.turn_id);
        } else {
          setBusy(true);
        }
        if (settings.showToolEvents || shouldPreserveToolMessage(frame)) {
          setMessages((current) => upsertToolMessage(current, frame.type, frame));
        }
        break;
      case "chat.done":
        if (
          typeof frame.turn_id === "string"
          && cancelledTurnIdsRef.current.has(frame.turn_id)
        ) {
          cancelledTurnIdsRef.current.delete(frame.turn_id);
          markTurnInactive(frame.turn_id);
          break;
        }
        finalizeStream();
        break;
      case "project.created":
        setMessages((current) => [...current, buildToolMessage(frame.type, frame)]);
        break;
      case "error":
        setError(typeof frame.message === "string" ? frame.message : "Unknown chat error");
        // 比对的是后端报错原文，不是界面文案。
      // i18n-exempt-start
      if (typeof frame.message === "string" && frame.message.includes("当前用户已有 AI 对话正在处理中")) {
      // i18n-exempt-end
          setBusy(true);
          break;
        }
        if (frame.message === "unauthorized") {
          authRejectedRef.current = true;
          closedRef.current = true;
          wsRef.current?.close();
        }
        markTurnInactive(activeTurnIdRef.current ?? pendingClientTurnIdRef.current);
        setConnecting(false);
        break;
      default:
        break;
    }
  }, [desiredScope, finalizeStream, markTurnActive, markTurnInactive, settings.showToolEvents]);

  const connect = useCallback(() => {
    closedRef.current = false;
    authRejectedRef.current = false;
    const connectionId = connectionIdRef.current + 1;
    connectionIdRef.current = connectionId;
    setConnecting(true);
    setError(null);
    if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
    const previous = wsRef.current;
    if (previous) {
      previous.onopen = null;
      previous.onmessage = null;
      previous.onerror = null;
      previous.onclose = null;
      previous.close();
    }

    const ws = new WebSocket(resolveChatWsUrl());
    wsRef.current = ws;
    ws.onopen = () => {
      if (connectionIdRef.current !== connectionId || wsRef.current !== ws) return;
      sendFrame({ type: "scope.set", scope: desiredScope });
    };
    ws.onmessage = (event) => {
      if (connectionIdRef.current !== connectionId || wsRef.current !== ws) return;
      try {
        handleFrame(JSON.parse(String(event.data)) as ServerFrame);
      } catch {
        // Ignore malformed frames from development proxies.
      }
    };
    ws.onerror = () => {
      if (connectionIdRef.current !== connectionId || wsRef.current !== ws) return;
      setError("WebSocket connection failed");
      setConnecting(false);
    };
    ws.onclose = (event) => {
      if (connectionIdRef.current !== connectionId || wsRef.current !== ws) return;
      wsRef.current = null;
      setConnected(false);
      const hasActiveTurn = Boolean(activeTurnIdRef.current ?? pendingClientTurnIdRef.current);
      setConnecting(hasActiveTurn);
      if (hasActiveTurn) {
        setBusy(true);
      }
      if (
        !closedRef.current
        && !authRejectedRef.current
        && event.code !== 1008
      ) {
        setConnecting(true);
        reconnectRef.current = window.setTimeout(connect, 1200);
      }
    };
  }, [desiredScope, handleFrame, sendFrame]);

  const disconnect = useCallback(() => {
    closedRef.current = true;
    connectionIdRef.current += 1;
    if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
    const ws = wsRef.current;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
      wsRef.current = null;
    }
    setConnected(false);
    setConnecting(false);
  }, []);

  useEffect(() => {
    setRelayInstances([]);
    setSelectedInstanceId("");
    setModels([]);
    setActiveModel(null);
    setModelsLoading(false);
    setHistoryReady(false);
    streamTextRef.current = "";
    pendingClientTurnIdRef.current = null;
    recentlyCompletedTurnIdRef.current = null;
    setStreamText("");
    const cachedMessages = loadCachedMessages(scopeKey);
    setMessages(cachedMessages);
    messagesRef.current = cachedMessages;
    const activeTurn = loadPendingActiveTurn(scopeKey, cachedMessages);
    activeTurnIdRef.current = activeTurn?.turnId ?? null;
    setActiveTurnId(activeTurn?.turnId ?? null);
    setBusy(Boolean(activeTurn));
  }, [desiredScope, scopeKey]);

  // Sweep stale/legacy message caches once on mount so abandoned conversations
  // don't accumulate and eventually exhaust the localStorage quota.
  useEffect(() => {
    pruneOldMessageCaches();
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
    saveCachedMessages(scopeKey, messages);
  }, [messages, scopeKey]);

  useEffect(() => {
    const activeTurnId = activeTurnIdRef.current;
    // 只认「这个回合的助手回复已经落进 messages」这一条正面证据。
    // 守卫里原来还带着 `busy` —— busy 为真时这个 effect 永远进不来，于是后端漏发
    // chat.done、或历史合并已经把回复带回来时，busy 就一直卡在 true：面板上的
    // 「正在生成…」滚不到头，用户只能点停止；而停止一关 busy，场景落地 effect
    // 立刻跑起来，看起来就是「点了停止却摆好了」。
    if (!activeTurnId || !turnHasAssistantReply(messages, activeTurnId)) return;
    clearActiveTurn(scopeKey, activeTurnId);
    activeTurnIdRef.current = null;
    setActiveTurnId(null);
    pendingClientTurnIdRef.current = null;
    setBusy(false);
  }, [messages, scopeKey]);

  useEffect(() => {
    try {
      const pinned = JSON.parse(localStorage.getItem(`superchat:pinned:${scopeKey}`) || "[]");
      const deleted = JSON.parse(localStorage.getItem(`superchat:deleted:${scopeKey}`) || "[]");
      setPinnedIds(new Set(Array.isArray(pinned) ? pinned : []));
      setDeletedIds(new Set(Array.isArray(deleted) ? deleted : []));
    } catch {
      setPinnedIds(new Set());
      setDeletedIds(new Set());
    }
  }, [scopeKey]);

  useEffect(() => {
    const connectTimer = window.setTimeout(connect, 50);
    return () => {
      window.clearTimeout(connectTimer);
      disconnect();
    };
  }, [connect, disconnect]);

  const send = useCallback((text: string, attachments: ChatAttachment[] = [], transportText?: string) => {
    const trimmed = text.trim();
    if (!trimmed || !connected) return false;
    const outboundText = transportText?.trim() || trimmed;
    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pendingClientTurnIdRef.current = turnId;
    markTurnActive(turnId);
    setMessages((current) => [...current, buildLocalUserMessage(trimmed, turnId, displayName, attachments)]);
    streamTextRef.current = "";
    setStreamText("");
    sendFrame({
      type: "chat.message",
      scope: desiredScope,
      text: outboundText,
      turn_id: turnId,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    return true;
  }, [connected, desiredScope, displayName, markTurnActive, sendFrame]);

  const appendNotification = useCallback(async (text: string): Promise<boolean> => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    try {
      const response = await api
        .post("api/v1/chat/notifications", {
          json: {
            scope: desiredScope,
            text: trimmed,
          },
        })
        .json<ChatNotificationResponse>();
      const message = normalizeMessage(response.data, "assistant");
      if (message) {
        setMessages((current) => sortMessages([...current, message]));
      }
      return true;
    } catch (error) {
      console.error("[superchat] append notification failed", error);
      const fallback = normalizeMessage(
        {
          id: `task-notification-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "assistant",
          content: trimmed,
          created_at: new Date().toISOString(),
        },
        "assistant",
      );
      if (fallback) {
        setMessages((current) => sortMessages([...current, fallback]));
      }
      return false;
    }
  }, [desiredScope]);

  const abort = useCallback(() => {
    const turnId = activeTurnIdRef.current ?? pendingClientTurnIdRef.current;
    if (turnId) {
      cancelledTurnIdsRef.current.add(turnId);
    }
    markTurnInactive(turnId);
    void api.post("api/v1/chat/cancel").catch(() => undefined);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close(4000, "client abort");
    }
  }, [markTurnInactive]);

  const resolveApproval = useCallback((_approval: ApprovalRequest, _decision: "allow-once" | "allow-always" | "deny") => {
    setApprovals([]);
  }, []);

  const refreshRelayInstances = useCallback(() => {
    setRelayInstances([]);
  }, []);

  const selectRelayInstance = useCallback((_instanceId: string) => {
    setSelectedInstanceId("");
  }, []);

  const refreshModels = useCallback(() => {
    setModels([]);
    setActiveModel(null);
    setModelsLoading(false);
  }, []);

  const switchModel = useCallback((_modelId: string) => {
    setModelsLoading(false);
  }, []);

  const sessionControl = useCallback((_command: SessionControlCommand, _args?: string) => {
    // novelvideo's native chat endpoint does not expose external session-control commands.
  }, []);

  const persistMessageSet = useCallback((kind: "pinned" | "deleted", next: Set<string>) => {
    safeLocalStorageSet(`superchat:${kind}:${scopeKey}`, JSON.stringify([...next]));
  }, [scopeKey]);

  const togglePin = useCallback((id: string) => {
    setPinnedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persistMessageSet("pinned", next);
      return next;
    });
  }, [persistMessageSet]);

  const deleteMessage = useCallback((id: string) => {
    setDeletedIds((current) => {
      const next = new Set(current);
      next.add(id);
      persistMessageSet("deleted", next);
      return next;
    });
    setPinnedIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      persistMessageSet("pinned", next);
      return next;
    });
  }, [persistMessageSet]);

  const clearPinned = useCallback(() => {
    const next = new Set<string>();
    setPinnedIds(next);
    persistMessageSet("pinned", next);
  }, [persistMessageSet]);

  return {
    abort,
    approvals,
    activeTurnId,
    busy,
    connected,
    connecting,
    error,
    activeModel,
    appendNotification,
    clearPinned,
    deleteMessage,
    deletedIds,
    historyReady,
    messages,
    models,
    modelsLoading,
    requestHistory,
    refreshModels,
    refreshRelayInstances,
    relayInstances,
    resolveApproval,
    selectRelayInstance,
    send,
    selectedInstanceId,
    sessionControl,
    setSettings,
    settings,
    pinnedIds,
    streamText,
    switchModel,
    togglePin,
  };
}
