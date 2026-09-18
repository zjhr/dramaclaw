// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 3D 导演台（`frontend/public/director-desk/`）与其宿主画布之间的 postMessage 桥。
 *
 * 上游契约见 `frontend/public/director-desk/UPSTREAM.md` 指向的 `docs/embed-contract.md`
 * （随产物一起 vendored 在上游仓库里）。这里只实现画布需要的那部分：
 *
 *   子 → 宿主   storyai:director-desk-ready            初始化完成，可以开始对话
 *               storyai:director-desk-close            用户点了导演台自己的关闭
 *               storyai:director-desk-captures-sent    机位截图批次（payload.captures）
 *               storyai:director-desk:response         请求响应（按 requestId 配对）
 *   宿主 → 子   storyai:director-desk:request          { requestId, action, options }
 *               storyai:director-desk-session          { instanceId, theme }
 *               storyai:director-desk-panorama         { edgeId, sourceNodeId, imageUrl, fileName }
 *
 * 三条必须守住的规矩，阶段 5/6 全部建立在它们之上：
 *
 * 1. **来源校验**：`event.origin` 必须是宿主自己的 origin，`event.source` 必须就是
 *    这个 iframe 的 contentWindow。只查 origin 会放过同一 origin 下别处的窗口
 *    （比如另一个 iframe 实例）冒充导演台 —— 多实例同开时那不是理论风险。
 * 2. **requestId 配对**：协议明确说响应顺序不必等于请求顺序，所以不能用「发出去
 *    第几个」对应「收回来第几个」，只能按 requestId 查 pending 表；表项在
 *    resolve/reject/超时/销毁四条路径上都要删掉并清掉定时器，否则泄漏。
 * 3. **按 capabilities 决定能力**：`actions` 数组由导演台自己声明，宿主不假设。
 *
 * 这个模块刻意不依赖 React 与网络 I/O：它只处理消息与 promise 表，因此可以被
 * 单元测试用真实 `MessageEvent` 直接驱动（见 __tests__/features/canvas/director-desk-bridge.test.ts）。
 */

export const DIRECTOR_DESK_PROTOCOL_VERSION = 1;

/** 协议 v1 的受控接口。来自 embed-contract.md 的 `actions` 取值域。 */
export const DIRECTOR_DESK_ACTIONS = [
  'capabilities.get',
  'project.get',
  'timeline.get',
  'export.frame',
  'export.video',
  'plugin.result.submit',
  'plugin.results.list',
] as const;

export type DirectorDeskAction = (typeof DIRECTOR_DESK_ACTIONS)[number];

export const DIRECTOR_DESK_MESSAGE_TYPES = {
  ready: 'storyai:director-desk-ready',
  close: 'storyai:director-desk-close',
  captures: 'storyai:director-desk-captures-sent',
  request: 'storyai:director-desk:request',
  response: 'storyai:director-desk:response',
  session: 'storyai:director-desk-session',
  panorama: 'storyai:director-desk-panorama',
} as const;

/** 默认超时：普通请求 15s；导出视频要现场录制，给 60s。 */
export const DIRECTOR_DESK_REQUEST_TIMEOUT_MS = 15_000;
export const DIRECTOR_DESK_EXPORT_VIDEO_TIMEOUT_MS = 60_000;

export interface DirectorDeskCapture {
  dataUrl: string;
  fileName: string;
}

export interface DirectorDeskCapabilities {
  protocolVersion: number;
  projectSchemaVersion?: number;
  actions: readonly string[];
  uiExports?: readonly string[];
  protocolExports?: readonly string[];
  assetPersistence?: string;
}

export interface DirectorDeskProtocolError {
  code: string;
  message: string;
}

/** 响应体（`event.data.payload`）。宿主必须自己校验，不能信消息形状。 */
export interface DirectorDeskResponsePayload {
  protocolVersion: number;
  requestId: string;
  action: string;
  ok: boolean;
  data?: unknown;
  error?: DirectorDeskProtocolError;
}

export interface DirectorDeskPanoramaPayload {
  edgeId: string;
  sourceNodeId: string;
  imageUrl: string;
  fileName: string;
}

export interface DirectorDeskExportVideoResult {
  blob: Blob;
  mimeType?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  fileName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 校验响应体。宁可整体丢弃一条形状不对的响应（走超时），也不要把它当成导演台的
 * 回话 —— `ok`/`protocolVersion`/`requestId` 任何一个不是预期类型，都无法安全配对。
 */
export function isDirectorDeskResponsePayload(
  value: unknown,
): value is DirectorDeskResponsePayload {
  if (!isRecord(value)) return false;
  if (value.protocolVersion !== DIRECTOR_DESK_PROTOCOL_VERSION) return false;
  if (typeof value.requestId !== 'string' || value.requestId.length === 0) return false;
  if (typeof value.action !== 'string') return false;
  if (typeof value.ok !== 'boolean') return false;
  if (value.ok === false) {
    const error = value.error;
    if (!isRecord(error) || typeof error.code !== 'string' || typeof error.message !== 'string') {
      return false;
    }
  }
  return true;
}

/** 规范化截图批次：丢掉没有可用 dataUrl 的条目，补默认文件名。 */
export function normalizeDirectorDeskCaptures(value: unknown): DirectorDeskCapture[] {
  if (!Array.isArray(value)) return [];
  const captures: DirectorDeskCapture[] = [];
  value.forEach((item, index) => {
    if (!isRecord(item)) return;
    const dataUrl = readString(item.dataUrl);
    if (!dataUrl) return;
    captures.push({
      dataUrl,
      fileName: readString(item.fileName) || `director-desk-capture-${index + 1}.png`,
    });
  });
  return captures;
}

export function isDirectorDeskCapabilities(value: unknown): value is DirectorDeskCapabilities {
  if (!isRecord(value)) return false;
  if (value.protocolVersion !== DIRECTOR_DESK_PROTOCOL_VERSION) return false;
  return Array.isArray(value.actions) && value.actions.every((item) => typeof item === 'string');
}

/** 只有导演台自己声明了的 action 才允许发；否则报错早于超时。 */
export function isDirectorDeskAction(value: string): value is DirectorDeskAction {
  return (DIRECTOR_DESK_ACTIONS as readonly string[]).includes(value);
}

export interface DirectorDeskBridgeHandlers {
  /** 首次收到 ready（幂等，重复 ready 不会再触发）。 */
  onReady?: () => void;
  onCaptures?: (captures: DirectorDeskCapture[]) => void;
  onClose?: () => void;
  /** 协议/传输层错误（超时、非法请求、非致命来源丢弃不计入）。 */
  onError?: (error: Error) => void;
}

export interface CreateDirectorDeskBridgeOptions extends DirectorDeskBridgeHandlers {
  iframe: HTMLIFrameElement;
  /** 宿主 origin；默认取 `window.location.origin`（同源子路径部署）。 */
  hostOrigin?: string;
  requestTimeoutMs?: number;
  exportVideoTimeoutMs?: number;
}

export interface DirectorDeskBridge {
  isReady: () => boolean;
  /** ready 之前挂起、ready 时 resolve、dispose 时 reject。可重复 await。 */
  whenReady: () => Promise<void>;
  request: <T = unknown>(action: DirectorDeskAction, options?: Record<string, unknown>) => Promise<T>;
  getCapabilities: () => Promise<DirectorDeskCapabilities>;
  getProject: () => Promise<unknown>;
  getTimeline: () => Promise<unknown>;
  exportVideo: (options?: {
    fileName?: string;
    fps?: 24 | 30 | 60;
    quality?: '720p' | '1080p';
  }) => Promise<DirectorDeskExportVideoResult>;
  sendSession: (instanceId: string, theme?: 'dark' | 'light') => void;
  sendPanorama: (payload: DirectorDeskPanoramaPayload) => void;
  /** 是否还挂着 message 监听（供测试与节点卸载断言使用）。 */
  isAttached: () => boolean;
  dispose: () => void;
}

interface PendingRequest {
  action: DirectorDeskAction;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createDirectorDeskBridge(
  options: CreateDirectorDeskBridgeOptions,
): DirectorDeskBridge {
  const { iframe } = options;
  const hostOrigin = options.hostOrigin
    ?? (typeof window !== 'undefined' ? window.location.origin : '');
  const requestTimeoutMs = options.requestTimeoutMs ?? DIRECTOR_DESK_REQUEST_TIMEOUT_MS;
  const exportVideoTimeoutMs = options.exportVideoTimeoutMs ?? DIRECTOR_DESK_EXPORT_VIDEO_TIMEOUT_MS;

  const pending = new Map<string, PendingRequest>();
  let ready = false;
  let disposed = false;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  let readySettled = false;

  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // dispose 之前没人 await 也不算未处理拒绝。
  readyPromise.catch(() => {});

  function fail(error: Error) {
    options.onError?.(error);
  }

  function targetWindow(): Window | null {
    try {
      return iframe.contentWindow;
    } catch {
      return null;
    }
  }

  function postToDirector(message: unknown) {
    const target = targetWindow();
    if (!target) {
      fail(new Error('director desk iframe has no content window'));
      return;
    }
    target.postMessage(message, hostOrigin);
  }

  function settlePending(requestId: string): PendingRequest | null {
    const entry = pending.get(requestId);
    if (!entry) return null;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    return entry;
  }

  /**
   * 只有「来源 origin + 来源窗口」都对上的消息才进入协议处理。返回 false 表示丢弃。
   * 故意把两种不匹配合成一个判断：对调用方来说，非预期来源就是非预期来源。
   */
  function isFromOurDirector(event: MessageEvent): boolean {
    if (event.origin !== hostOrigin) return false;
    const target = targetWindow();
    if (!target) return false;
    return event.source === target;
  }

  function handleResponse(payload: DirectorDeskResponsePayload) {
    const entry = settlePending(payload.requestId);
    if (!entry) return;
    if (payload.action !== entry.action) {
      entry.reject(
        new Error(
          `director desk responded with a different action: expected ${entry.action}, got ${payload.action}`,
        ),
      );
      return;
    }
    if (!payload.ok) {
      const code = payload.error?.code ?? 'unknown';
      const message = payload.error?.message ?? 'director desk request failed';
      entry.reject(new Error(`${code}: ${message}`));
      return;
    }
    entry.resolve(payload.data);
  }

  function handleMessage(event: MessageEvent) {
    if (disposed) return;
    if (!isFromOurDirector(event)) return;
    const data = event.data;
    if (!isRecord(data) || typeof data.type !== 'string') return;

    switch (data.type) {
      case DIRECTOR_DESK_MESSAGE_TYPES.ready: {
        if (!ready) {
          ready = true;
          readySettled = true;
          readyResolve?.();
          readyResolve = null;
          readyReject = null;
          options.onReady?.();
        }
        return;
      }
      case DIRECTOR_DESK_MESSAGE_TYPES.close: {
        options.onClose?.();
        return;
      }
      case DIRECTOR_DESK_MESSAGE_TYPES.captures: {
        const payload = isRecord(data.payload) ? data.payload : {};
        const captures = normalizeDirectorDeskCaptures(payload.captures);
        if (captures.length > 0) options.onCaptures?.(captures);
        return;
      }
      case DIRECTOR_DESK_MESSAGE_TYPES.response: {
        if (!isDirectorDeskResponsePayload(data.payload)) return;
        handleResponse(data.payload);
        return;
      }
      default:
        return;
    }
  }

  // 挂监听是同步的：桥必须在 iframe 开始加载之前就位，否则首帧 ready 会丢。
  // 调用方在 layout effect 里创建桥，「DOM 提交 → layout effect → iframe 文档开始
  // 执行」这个顺序保证 ready 不会早于监听器。
  //
  // 两个导演台实例同开时，两条桥都挂在同一个 window 上，各自按
  // `event.source === 自己的 iframe.contentWindow` 过滤，不会串台。
  if (typeof window !== 'undefined') {
    window.addEventListener('message', handleMessage);
  } else {
    fail(new Error('director desk bridge requires a window'));
  }

  function request<T>(action: DirectorDeskAction, requestOptions?: Record<string, unknown>) {
    if (disposed) {
      return Promise.reject(new Error('director desk bridge is disposed'));
    }
    if (!isDirectorDeskAction(action)) {
      return Promise.reject(new Error(`unsupported director desk action: ${action}`));
    }
    if (!ready) {
      // 早失败好过让调用方等一个永远不来的响应：导演台在 ready 之前没挂监听。
      return Promise.reject(new Error(`director desk is not ready yet (action: ${action})`));
    }
    const requestId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `dd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timeoutMs = action === 'export.video' ? exportVideoTimeoutMs : requestTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`director desk request timed out: ${action}`));
      }, timeoutMs);
      pending.set(requestId, {
        action,
        timer,
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        postToDirector({
          type: DIRECTOR_DESK_MESSAGE_TYPES.request,
          payload: { requestId, action, ...(requestOptions ? { options: requestOptions } : {}) },
        });
      } catch (error) {
        const entry = settlePending(requestId);
        entry?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  return {
    isReady: () => ready,
    whenReady: () => readyPromise,
    request,
    async getCapabilities() {
      const data = await request<unknown>('capabilities.get');
      if (!isDirectorDeskCapabilities(data)) {
        throw new Error('director desk returned unusable capabilities');
      }
      return data;
    },
    getProject: () => request<unknown>('project.get'),
    getTimeline: () => request<unknown>('timeline.get'),
    exportVideo: (exportOptions) =>
      request<DirectorDeskExportVideoResult>('export.video', exportOptions as Record<string, unknown>),
    sendSession(instanceId: string, theme: 'dark' | 'light' = 'dark') {
      if (disposed) return;
      postToDirector({
        type: DIRECTOR_DESK_MESSAGE_TYPES.session,
        payload: { instanceId, theme },
      });
    },
    sendPanorama(payload: DirectorDeskPanoramaPayload) {
      if (disposed) return;
      postToDirector({ type: DIRECTOR_DESK_MESSAGE_TYPES.panorama, payload });
    },
    isAttached: () => !disposed,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (typeof window !== 'undefined') {
        window.removeEventListener('message', handleMessage);
      }
      pending.forEach((entry) => {
        clearTimeout(entry.timer);
        entry.reject(new Error('director desk bridge was disposed'));
      });
      pending.clear();
      if (!readySettled) {
        readySettled = true;
        readyReject?.(new Error('director desk bridge was disposed before ready'));
        readyResolve = null;
        readyReject = null;
      }
    },
  };
}
