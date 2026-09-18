// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 直接驱动**已交付的** directorDeskBridge（真实导出路径，不 mock 被测单元）：
 * 用真实 `MessageEvent` 喂消息，用包在 postMessage 外面的记录器观察宿主发出的帧。
 * 覆盖三条最容易出错的契约：来源校验、requestId 配对、生命周期清理。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DIRECTOR_DESK_MESSAGE_TYPES,
  DIRECTOR_DESK_PROTOCOL_VERSION,
  createDirectorDeskBridge,
  isDirectorDeskResponsePayload,
  normalizeDirectorDeskCaptures,
  type DirectorDeskBridge,
  type DirectorDeskCapture,
} from "@/features/canvas/nodes/directorDeskBridge";

const HOST_ORIGIN = window.location.origin;

interface Harness {
  iframe: HTMLIFrameElement;
  /** 宿主 → 导演台的帧，按发出顺序记录。 */
  sent: Array<Record<string, unknown>>;
  /** 从导演台方向投递给宿主的帧（走真实的 window message 事件）。 */
  emit: (
    data: unknown,
    overrides?: { origin?: string; source?: MessageEventSource | null },
  ) => void;
  bridge: DirectorDeskBridge;
}

function makeHarness(
  handlers: Parameters<typeof createDirectorDeskBridge>[0] extends infer _T
    ? { onReady?: () => void; onCaptures?: (c: DirectorDeskCapture[]) => void; onClose?: () => void; onError?: (e: Error) => void }
    : never = {},
): Harness {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const contentWindow = iframe.contentWindow;
  if (!contentWindow) throw new Error("jsdom did not give the iframe a content window");

  const sent: Array<Record<string, unknown>> = [];
  const originalPostMessage = contentWindow.postMessage.bind(contentWindow);
  (contentWindow as unknown as { postMessage: unknown }).postMessage = (
    message: Record<string, unknown>,
    targetOrigin?: string,
  ) => {
    sent.push({ ...message, __targetOrigin: targetOrigin } as Record<string, unknown>);
    return originalPostMessage(message, targetOrigin ?? "*");
  };

  const bridge = createDirectorDeskBridge({ iframe, ...handlers });

  const emit = (
    data: unknown,
    overrides: { origin?: string; source?: MessageEventSource | null } = {},
  ) => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data,
        origin: overrides.origin ?? HOST_ORIGIN,
        source: overrides.source === undefined ? contentWindow : overrides.source,
      }),
    );
  };

  return { iframe, sent, emit, bridge };
}

function responsePayload(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: DIRECTOR_DESK_PROTOCOL_VERSION,
    requestId: "req-1",
    action: "capabilities.get",
    ok: true,
    data: { protocolVersion: 1, projectSchemaVersion: 1, actions: ["capabilities.get"] },
    ...overrides,
  };
}

let cleanup: Array<() => void> = [];

beforeEach(() => {
  cleanup = [];
});

afterEach(() => {
  cleanup.forEach((fn) => fn());
});

describe("directorDeskBridge 来源校验", () => {
  it("丢弃 origin 不匹配的消息（同 origin 之外的一律不处理）", async () => {
    const h = makeHarness();
    cleanup.push(() => h.bridge.dispose());
    const onCaptures = vi.fn();
    // 换一条带 spy 的桥，确保断言打在被测单元的处理路径上。
    h.bridge.dispose();
    const spyHarness = makeHarness({ onCaptures });
    cleanup.push(() => spyHarness.bridge.dispose());

    spyHarness.emit(
      {
        type: DIRECTOR_DESK_MESSAGE_TYPES.captures,
        payload: { captures: [{ dataUrl: "data:image/png;base64,AAAA", fileName: "a.png" }] },
      },
      { origin: "https://evil.example" },
    );
    expect(onCaptures).not.toHaveBeenCalled();

    spyHarness.emit({
      type: DIRECTOR_DESK_MESSAGE_TYPES.captures,
      payload: { captures: [{ dataUrl: "data:image/png;base64,AAAA", fileName: "a.png" }] },
    });
    expect(onCaptures).toHaveBeenCalledTimes(1);
  });

  it("丢弃 source 不是本 iframe 的窗口的消息（多实例隔离）", async () => {
    const onCaptures = vi.fn();
    const h = makeHarness({ onCaptures });
    cleanup.push(() => h.bridge.dispose());

    const otherIframe = document.createElement("iframe");
    document.body.appendChild(otherIframe);
    cleanup.push(() => otherIframe.remove());

    // 同一个 origin，但来源窗口是另一个 iframe —— 必须丢弃。
    h.emit(
      {
        type: DIRECTOR_DESK_MESSAGE_TYPES.captures,
        payload: { captures: [{ dataUrl: "data:image/png;base64,BBBB", fileName: "b.png" }] },
      },
      { source: otherIframe.contentWindow as unknown as MessageEventSource },
    );
    expect(onCaptures).not.toHaveBeenCalled();

    h.emit(
      {
        type: DIRECTOR_DESK_MESSAGE_TYPES.captures,
        payload: { captures: [{ dataUrl: "data:image/png;base64,CCCC", fileName: "c.png" }] },
      },
      { source: window as unknown as MessageEventSource },
    );
    expect(onCaptures).not.toHaveBeenCalled();
  });

  it("合法来源的 ready 只触发一次 onReady，并让 whenReady 落地", async () => {
    const onReady = vi.fn();
    const h = makeHarness({ onReady });
    cleanup.push(() => h.bridge.dispose());

    expect(h.bridge.isReady()).toBe(false);
    let resolved = false;
    void h.bridge.whenReady().then(() => {
      resolved = true;
    });

    h.emit({ type: DIRECTOR_DESK_MESSAGE_TYPES.ready });
    h.emit({ type: DIRECTOR_DESK_MESSAGE_TYPES.ready });

    await h.bridge.whenReady();
    expect(resolved).toBe(true);
    expect(h.bridge.isReady()).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);
  });
});

describe("directorDeskBridge requestId 配对", () => {
  it("request 发出协议形状的帧，并按 requestId resolve", async () => {
    const h = makeHarness();
    cleanup.push(() => h.bridge.dispose());
    h.emit({ type: DIRECTOR_DESK_MESSAGE_TYPES.ready });

    const promise = h.bridge.getCapabilities();
    expect(h.sent).toHaveLength(1);
    const frame = h.sent[0] as {
      type: string;
      payload: { requestId: string; action: string };
      __targetOrigin: string;
    };
    expect(frame.type).toBe(DIRECTOR_DESK_MESSAGE_TYPES.request);
    expect(frame.payload.action).toBe("capabilities.get");
    expect(typeof frame.payload.requestId).toBe("string");
    expect(frame.payload.requestId.length).toBeGreaterThan(0);
    // 目标 origin 必须是宿主自己的 origin，不能是 '*'。
    expect(frame.__targetOrigin).toBe(HOST_ORIGIN);

    h.emit({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: responsePayload({ requestId: frame.payload.requestId }),
    });
    await expect(promise).resolves.toMatchObject({ actions: ["capabilities.get"] });
  });

  it("响应乱序到达也按 requestId 各自配对", async () => {
    const h = makeHarness();
    cleanup.push(() => h.bridge.dispose());
    h.emit({ type: DIRECTOR_DESK_MESSAGE_TYPES.ready });

    const first = h.bridge.request<string>("timeline.get");
    const second = h.bridge.request<string>("project.get");
    const ids = h.sent.map(
      (frame) => (frame.payload as { requestId: string }).requestId,
    );
    expect(new Set(ids).size).toBe(2);

    // 后发的先回。
    h.emit({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: responsePayload({ requestId: ids[1], action: "project.get", data: "project" }),
    });
    h.emit({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: responsePayload({ requestId: ids[0], action: "timeline.get", data: "timeline" }),
    });

    await expect(second).resolves.toBe("project");
    await expect(first).resolves.toBe("timeline");
  });

  it("ok:false 的响应按 error.code/message reject", async () => {
    const h = makeHarness();
    cleanup.push(() => h.bridge.dispose());
    h.emit({ type: DIRECTOR_DESK_MESSAGE_TYPES.ready });

    const promise = h.bridge.request("export.video", { fps: 30 });
    const { requestId, action } = (h.sent[0] as { payload: { requestId: string; action: string } })
      .payload;
    h.emit({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: responsePayload({
        requestId,
        action,
        ok: false,
        data: undefined,
        error: { code: "export-busy", message: "已有导出任务正在进行" },
      }),
    });

    await expect(promise).rejects.toThrow(/export-busy/);
  });

  it("action 不匹配的响应被 reject，而不是把错的 data 交出去", async () => {
    const h = makeHarness();
    cleanup.push(() => h.bridge.dispose());
    h.emit({ type: DIRECTOR_DESK_MESSAGE_TYPES.ready });

    const promise = h.bridge.request("project.get");
    const { requestId } = (h.sent[0] as { payload: { requestId: string } }).payload;
    h.emit({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: responsePayload({ requestId, action: "timeline.get", data: "wrong" }),
    });

    await expect(promise).rejects.toThrow(/different action/);
  });

  it("形状不对的响应体不会被当成回话（走超时）", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      cleanup.push(() => h.bridge.dispose());
      h.emit({ type: DIRECTOR_DESK_MESSAGE_TYPES.ready });

      const promise = h.bridge.request("project.get");
      const { requestId } = (h.sent[0] as { payload: { requestId: string } }).payload;
      const assertion = expect(promise).rejects.toThrow(/timed out/);

      // protocolVersion 缺失 / ok 不是 boolean / 失败却没有 error —— 都不算合法响应。
      h.emit({ type: DIRECTOR_DESK_MESSAGE_TYPES.response, payload: { requestId, action: "project.get", ok: true } });
      h.emit({ type: DIRECTOR_DESK_MESSAGE_TYPES.response, payload: responsePayload({ requestId, protocolVersion: 2 }) });
      h.emit({ type: DIRECTOR_DESK_MESSAGE_TYPES.response, payload: responsePayload({ requestId, ok: false }) });

      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("未 ready 时请求立即失败，不等超时", async () => {
    const h = makeHarness();
    cleanup.push(() => h.bridge.dispose());
    await expect(h.bridge.request("project.get")).rejects.toThrow(/not ready/);
    expect(h.sent).toHaveLength(0);
  });

  it("超时后 pending 表被清掉，迟到的响应不会再 resolve 一次", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      cleanup.push(() => h.bridge.dispose());
      h.emit({ type: DIRECTOR_DESK_MESSAGE_TYPES.ready });

      const promise = h.bridge.request("project.get");
      const { requestId } = (h.sent[0] as { payload: { requestId: string } }).payload;
      const assertion = expect(promise).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;

      // 迟到响应：没有 pending 表项 → 直接忽略，不抛也不 resolve。
      expect(() =>
        h.emit({
          type: DIRECTOR_DESK_MESSAGE_TYPES.response,
          payload: responsePayload({ requestId, action: "project.get", data: "late" }),
        }),
      ).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("directorDeskBridge 生命周期", () => {
  it("dispose 摘掉监听：之后再投消息不再触发回调", async () => {
    const onCaptures = vi.fn();
    const h = makeHarness({ onCaptures });
    h.emit({
      type: DIRECTOR_DESK_MESSAGE_TYPES.captures,
      payload: { captures: [{ dataUrl: "data:image/png;base64,AAAA" }] },
    });
    expect(onCaptures).toHaveBeenCalledTimes(1);

    h.bridge.dispose();
    expect(h.bridge.isAttached()).toBe(false);
    h.emit({
      type: DIRECTOR_DESK_MESSAGE_TYPES.captures,
      payload: { captures: [{ dataUrl: "data:image/png;base64,BBBB" }] },
    });
    expect(onCaptures).toHaveBeenCalledTimes(1);
  });

  it("dispose 会 reject 所有 pending 并清掉各自的超时定时器", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.emit({ type: DIRECTOR_DESK_MESSAGE_TYPES.ready });
      const first = h.bridge.request("project.get");
      const second = h.bridge.request("timeline.get");
      const firstAssertion = expect(first).rejects.toThrow(/disposed/);
      const secondAssertion = expect(second).rejects.toThrow(/disposed/);

      // 直接盯着平台原语：dispose 必须为每条 pending 各调用一次 clearTimeout，
      // 否则被 reject 的请求还会留一个 15s 后触发的孤儿定时器。
      const clearSpy = vi.spyOn(globalThis, "clearTimeout");
      h.bridge.dispose();

      await firstAssertion;
      await secondAssertion;
      expect(clearSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("超时之后不再保留该请求的定时器（不会二次触发）", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      cleanup.push(() => h.bridge.dispose());
      h.emit({ type: DIRECTOR_DESK_MESSAGE_TYPES.ready });
      const promise = h.bridge.request("project.get");
      const assertion = expect(promise).rejects.toThrow(/timed out/);

      const clearSpy = vi.spyOn(globalThis, "clearTimeout");
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
      // 超时路径里 clearTimeout 不会被调用（定时器已经自然到期），但表项必须删干净：
      // 再推进多久都不会有第二次 settle。
      clearSpy.mockClear();
      await vi.advanceTimersByTimeAsync(120_000);
      await expect(promise).rejects.toThrow(/timed out/);
      expect(clearSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ready 之前 dispose 会让 whenReady reject，不留下悬空 promise", async () => {
    const h = makeHarness();
    const assertion = expect(h.bridge.whenReady()).rejects.toThrow(/before ready/);
    h.bridge.dispose();
    await assertion;
  });

  it("多个桥各自只处理自己 iframe 的消息（两实例同开）", async () => {
    const a: DirectorDeskCapture[][] = [];
    const b: DirectorDeskCapture[][] = [];
    const ha = makeHarness({ onCaptures: (c) => a.push(c) });
    const hb = makeHarness({ onCaptures: (c) => b.push(c) });
    cleanup.push(() => ha.bridge.dispose(), () => hb.bridge.dispose());

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: DIRECTOR_DESK_MESSAGE_TYPES.captures,
          payload: { captures: [{ dataUrl: "data:image/png;base64,AAAA", fileName: "a.png" }] },
        },
        origin: HOST_ORIGIN,
        source: ha.iframe.contentWindow as unknown as MessageEventSource,
      }),
    );

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });
});

describe("directorDeskBridge 载荷校验", () => {
  it("normalizeDirectorDeskCaptures 丢掉没有 dataUrl 的条目并补默认文件名", () => {
    expect(
      normalizeDirectorDeskCaptures([
        { dataUrl: "data:image/png;base64,AAAA" },
        { fileName: "no-data-url.png" },
        null,
        { dataUrl: "   " },
        { dataUrl: "data:image/png;base64,BBBB", fileName: "  named.png  " },
      ]),
    ).toEqual([
      { dataUrl: "data:image/png;base64,AAAA", fileName: "director-desk-capture-1.png" },
      { dataUrl: "data:image/png;base64,BBBB", fileName: "named.png" },
    ]);
  });

  it("captures 为空数组时不触发回调", () => {
    const onCaptures = vi.fn();
    const h = makeHarness({ onCaptures });
    cleanup.push(() => h.bridge.dispose());
    h.emit({ type: DIRECTOR_DESK_MESSAGE_TYPES.captures, payload: { captures: [] } });
    h.emit({ type: DIRECTOR_DESK_MESSAGE_TYPES.captures, payload: {} });
    expect(onCaptures).not.toHaveBeenCalled();
  });

  it("isDirectorDeskResponsePayload 拒绝协议版本不同的响应", () => {
    expect(isDirectorDeskResponsePayload(responsePayload())).toBe(true);
    expect(isDirectorDeskResponsePayload(responsePayload({ protocolVersion: 2 }))).toBe(false);
    expect(isDirectorDeskResponsePayload(responsePayload({ requestId: "" }))).toBe(false);
    expect(isDirectorDeskResponsePayload(null)).toBe(false);
  });

  it("close 消息映射到 onClose", () => {
    const onClose = vi.fn();
    const h = makeHarness({ onClose });
    cleanup.push(() => h.bridge.dispose());
    h.emit({ type: DIRECTOR_DESK_MESSAGE_TYPES.close });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
