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
 *               storyai:director-desk-panorama         { edgeId, sourceNodeId, imageUrl, fileName }
 *
 * v1 的 `storyai:director-desk-session`（{ instanceId, theme }）已经没有发送方：
 * 子应用侧不再监听它，宿主侧也没有调用点。它仍留在 DIRECTOR_DESK_MESSAGE_TYPES 里，
 * 是为了让「宿主一次都不发 session」这条断言有地方可指。
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
 * 4. **版本窗口而不是版本相等**：回包的 `protocolVersion` 落在支持窗口内即可
 *    （见 `DIRECTOR_DESK_SUPPORTED_PROTOCOL_VERSIONS`），不做 `!==` 硬比 ——
 *    同一座桥既接 3D 导演台（v1）也接 MONOFORM 白模台（v2）。
 *
 * 这个模块刻意不依赖 React 与网络 I/O：它只处理消息与 promise 表，因此可以被
 * 单元测试用真实 `MessageEvent` 直接驱动（见 __tests__/features/canvas/director-desk-bridge.test.ts）。
 */

/**
 * **宿主自己的**协议版本：兼容窗口的下界，也是宿主发出的回执上盖的版本号。
 *
 * 回 `project.save` 回执时带 1 是对的 —— 这个字段描述的是**发包方**的协议版本，
 * 而回执由宿主发，所以它是宿主的版本，不是子应用的。子应用那边只按 requestId 配对
 * 并检查 `ok`，不读这个字段（vendor/director-desk/src/host-bridge.ts:319-334），
 * 今天两边不对称也不会出事。写清楚是为了挡住下一次「看到 v2 说 2 就把这里改成 2」的
 * 顺手修改：那会把宿主谎报成子应用的版本，而兼容窗口的判断仍然走集合，不受影响。
 */
export const DIRECTOR_DESK_PROTOCOL_VERSION = 1;

/**
 * 宿主支持的协议版本集合 —— 兼容策略是「不低过 v1」，而不是只认某一个数字。
 *
 * 用集合而不是把常量提到 2：同一个桥同时服务 3D 导演台（仍回 v1）与 MONOFORM
 * 白模台（T010 起回 v2），`!==` 硬比等于每升一次版本就单方面断开一个已发布的
 * 子应用 —— 真实症状不是报错而是沉默：每条回包都被守卫丢掉，`capabilities.get`
 * 一路等到超时，界面只显示「连不上」。
 *
 * `MIN`/`MAX` 只是这个集合的边界值（供展示与文档用），判断永远走集合。
 */
export const DIRECTOR_DESK_MIN_PROTOCOL_VERSION = 1;
export const DIRECTOR_DESK_MAX_PROTOCOL_VERSION = 2;

export const DIRECTOR_DESK_SUPPORTED_PROTOCOL_VERSIONS: readonly number[] =
  Array.from(
    { length: DIRECTOR_DESK_MAX_PROTOCOL_VERSION - DIRECTOR_DESK_MIN_PROTOCOL_VERSION + 1 },
    (_unused, index) => DIRECTOR_DESK_MIN_PROTOCOL_VERSION + index,
  );

/**
 * 回包版本号是否在兼容窗口内。**只接受整数**：`1.5` 这种带小数的版本没法安全
 * 配对（旧字段可能已经变了语义），宁可丢弃走超时也不要按低版本误读。
 *
 * 高版本按兼容处理（向前兼容的加法式演进：多出来的 action 本就要按
 * `capabilities.actions` 逐条判断）；低版本与非法值一律拒绝 —— 窗口下界是
 * 有意守住的，早期版本的回包形状与现在不同。
 */
export function isDirectorDeskProtocolVersionSupported(value: unknown): boolean {
  return typeof value === 'number'
    && Number.isInteger(value)
    && (DIRECTOR_DESK_SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(value);
}

/** 协议 v1 的受控接口。来自 embed-contract.md 的 `actions` 取值域。 */
export const DIRECTOR_DESK_ACTIONS = [
  'capabilities.get',
  'project.get',
  'timeline.get',
  'export.frame',
  'export.video',
  'plugin.result.submit',
  'plugin.results.list',
  // MONOFORM 白模台用：宿主把 agent 翻译好的工程推回去（走 applyProjectSnapshot 热更新）。
  // director-desk 不声明它，只有 MONOFORM 在 capabilities.actions 里报，所以只对它生效。
  'scene.apply',
  // ── v2（mangfufu/director-desk）新增 ──────────────────────────────────
  // 工具面唯一入口：宿主 UI 与后续的 agent 走同一条路，子侧转手 `toolService.call`。
  'tool.call',
  // 工程 / 导出产物请宿主落盘（**子 → 宿**方向，见 DIRECTOR_DESK_ACTION_DIRECTION）。
  'project.save',
  // 把宿主存的 `.director` 文档推回子应用，导入走子应用自己的入口。
  'project.load',
  // 技能清单与启用态同步（第 4 块切片接内容，本切片只占位）。
  'skills.sync',
  // ── AI 面板（子应用 ↔ Python 后端）───────────────────────────────────────────
  // 宿主问子应用要工具面与内置技能。后端不抄第二份，事实来源永远是 iframe 里的
  // upstream `src/automation/contract.ts` 与 `builtin-skill.json`。
  'ai.describe',
  // 面板动作（渠道增删改查、run/stop/conversation/skills）由子应用发给宿主，
  // 宿主再转后端。密钥与会话都只在后端，中间这一跳不持有它们。
  'ai.request',
  // agent 事件回流：宿主 → 子。这是唯一一条宿主主动往子应用推消息的动作。
  'agent.event',
  // ── 宿主 UI（第 5 条切片）────────────────────────────────────────────────
  // 子应用请宿主打开 DramaClaw 自己的设置弹窗（子 → 宿主）。导演台的 AI 面板只留
  // 渠道选择器 + 极简新建，完整渠道管理跳到宿主设置页 —— 那个页面本来就在，做一份
  // 第二套只会漂移。
  'ui.open-settings',
  // 画布节点的场景缩略图（宿主 → 子）：子应用从自己的渲染画布截一张当前取景回给
  // 宿主。这是「节点上要能看出导演台里发生了什么」的数据来源。
  'preview.capture',
  // ── 分镜选择（子 → 宿主）────────────────────────────────────────────────
  // 「这一轮谈第几场戏」是宿主的知识，不是导演台的：分镜存在 DramaClaw 的项目库里，
  // 宿主还知道节点 data 里记住的是哪一条。子应用没有后端会话，只能向宿主要。
  //
  // **不复用 `ai.request`**：那条通道的终点是 Python 后端（`DirectorDeskAiOp` 一一对应
  // `/ai/*` 端点），而分镜宿主自己已经读到了（`refreshStoryboard`）。走它会为了一个
  // 纯本地的取数多绕一跳后端，还要求后端开一条新端点。
  'storyboard.get',
  // 面板选中某场后回写宿主。返回重读后的同一份载荷，让面板按事实重画而不是自己乐观更新。
  'storyboard.select',
  'storyboard.source',
  'storyboard.updated',
] as const;

export type DirectorDeskAction = (typeof DIRECTOR_DESK_ACTIONS)[number];

/**
 * 宿主设置弹窗的页。子应用只能报这一项，实际落点由宿主决定（今天两页都可达）。
 */
export type DirectorDeskSettingsPage = 'models' | 'storage';

/**
 * 每个 action 的**方向**。
 *
 * v2 之后同一个 action 名不再等于「宿主发、子回」：`project.save` 是子应用主动请宿主
 * 把工程写进节点（上游没有反向通道，于是复用同一对 request/response 消息，子发
 * request、宿主回 response）。方向写死在这里，`request()` 就能在发出去之前拒绝
 * 方向不对的动作，而不是等一个永远不会来的回包直到超时。
 */
export type DirectorDeskActionDirection = 'host-to-child' | 'child-to-host';

export const DIRECTOR_DESK_ACTION_DIRECTION: Record<
  DirectorDeskAction,
  DirectorDeskActionDirection
> = {
  'capabilities.get': 'host-to-child',
  'project.get': 'host-to-child',
  'timeline.get': 'host-to-child',
  'export.frame': 'host-to-child',
  'export.video': 'host-to-child',
  'plugin.result.submit': 'host-to-child',
  'plugin.results.list': 'host-to-child',
  'scene.apply': 'host-to-child',
  'tool.call': 'host-to-child',
  'project.save': 'child-to-host',
  'project.load': 'host-to-child',
  'skills.sync': 'host-to-child',
  'ai.describe': 'host-to-child',
  'ai.request': 'child-to-host',
  'agent.event': 'host-to-child',
  'ui.open-settings': 'child-to-host',
  'preview.capture': 'host-to-child',
  'storyboard.get': 'child-to-host',
  'storyboard.select': 'child-to-host',
  'storyboard.source': 'child-to-host',
  'storyboard.updated': 'host-to-child',
};

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
/**
 * `tool.call` 的超时。工具跑在子应用的 Three.js 渲染进程里，`director_apply` 会做模型
 * 预热与提交校验，15s 的通用默认不够用。
 */
export const DIRECTOR_DESK_TOOL_CALL_TIMEOUT_MS = 60_000;
/** `project.load` 会触发子应用侧的文档校验与模型准备，且宿主要先 fetch 工程 JSON。 */
export const DIRECTOR_DESK_PROJECT_LOAD_TIMEOUT_MS = 30_000;

/** 逐动作超时表；没列到的用 `requestTimeoutMs`。 */
const DIRECTOR_DESK_ACTION_TIMEOUT_MS: Partial<Record<DirectorDeskAction, number>> = {
  'export.video': DIRECTOR_DESK_EXPORT_VIDEO_TIMEOUT_MS,
  'tool.call': DIRECTOR_DESK_TOOL_CALL_TIMEOUT_MS,
  'project.load': DIRECTOR_DESK_PROJECT_LOAD_TIMEOUT_MS,
};

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

/** 子应用请宿主落盘的一次请求（`project.save`，子 → 宿主方向）。 */
export interface DirectorDeskProjectSaveRequest {
  kind: 'project' | 'export';
  name: string;
  /** `kind: 'project'` 时是 `.director` 文档全文（上游 `saveProjectFile` 给的就是字符串）。 */
  content?: string;
  /** `kind: 'export'` 时的二进制产物。 */
  bytes?: ArrayBuffer;
  byteLength?: number;
  mimeType?: string;
}

/** `preview.capture` 的回包：一张降采样后的当前取景。 */
export interface DirectorDeskPreviewFrame {
  dataUrl: string;
  width: number;
  height: number;
}

/** 宿主落盘后的回执。`saved: false` 表示宿主没存成，子应用会照实提示用户。 */
export interface DirectorDeskProjectSaveResult {
  saved: boolean;
  url?: string;
  filename?: string;
}

/** `tool.call` 的回包：子应用转手 `toolService.call` 之后的信封。 */
export interface DirectorDeskToolResult {
  revision: number | null;
  result: unknown;
}

/**
 * 一条分镜。字段名与后端 `ai_director_desk_context.beat_view` 逐字一致，让面板不需要
 * 一份翻译表就能画卡片。
 */
export interface DirectorDeskStoryboardShot {
  reference_image_url?: string;
  beat_number: number;
  scene: string;
  duration_seconds: number;
  speaker: string;
  synopsis: string;
  spoken_text: string;
}

/** 分镜来源的可视化摘要，供 AI 面板显示缩略图与来源类型。 */
export interface DirectorDeskStoryboardSource {
  id: string;
  label: string;
  kind?: 'image' | 'storyboard' | 'shot' | 'script' | 'text' | 'project' | 'other';
  previewImageUrl?: string;
  itemCount?: number;
  detail?: string;
}

/**
 * `storyboard.get` / `storyboard.select` 的载荷。
 *
 * **不含 `context`**：那是宿主喂给 `/ai/run` 的内部上下文，只走 `withStoryboardContext`
 * 那条路。发进面板等于让一段本不该出现在界面上的拼接文本多一个泄漏面，面板也没有用它。
 */
export interface DirectorDeskStoryboardPayload {
  /** 仅含当前导演台的直接上游，以及用户可主动选择的项目目录。 */
  sources?: DirectorDeskStoryboardSource[];
  sourceId?: string | null;
  sourceLabel?: string;
  loading?: boolean;
  /** 有分镜的集号，升序。空数组 = 这个项目还没有分镜。 */
  episodes: number[];
  episode: number;
  shots: DirectorDeskStoryboardShot[];
  /** 当前选中的 `beat_number`；没有选中时为 null。 */
  selected: number | null;
  /** 项目 id 之外的一句话提示（无分镜时告诉用户去哪生成分镜）。空字符串表示无需提示。 */
  hint: string;
  /**
   * 读分镜失败的原文，null 表示没失败。
   *
   * **必须带**：面板只拿到这份载荷，没有别的地方能知道「读不到」与「这个项目真的没有
   * 分镜」的区别 —— 前者该提示重试/看错误，后者该引导去生成分镜。合成一句「没有分镜」
   * 会把一次接口故障说成用户没有素材。
   */
  error: string | null;
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
  if (!isDirectorDeskProtocolVersionSupported(value.protocolVersion)) return false;
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
  if (!isDirectorDeskProtocolVersionSupported(value.protocolVersion)) return false;
  return Array.isArray(value.actions) && value.actions.every((item) => typeof item === 'string');
}

/** 只有导演台自己声明了的 action 才允许发；否则报错早于超时。 */
export function isDirectorDeskAction(value: string): value is DirectorDeskAction {
  return (DIRECTOR_DESK_ACTIONS as readonly string[]).includes(value);
}

/**
 * 校验子应用发来的请求（v2 的 `project.save`）。请求体来自 iframe，虽然同源且已过
 * source 校验，仍然逐字段查：形状不对的请求既不能落盘也不能回包，只能回错误。
 */
export function parseDirectorDeskHostRequest(
  value: unknown,
): { requestId: string; action: DirectorDeskAction; options: Record<string, unknown> } | null {
  if (!isRecord(value)) return null;
  const requestId = readString(value.requestId);
  const action = readString(value.action);
  if (!requestId || !isDirectorDeskAction(action)) return null;
  if (DIRECTOR_DESK_ACTION_DIRECTION[action] !== 'child-to-host') return null;
  const options = isRecord(value.options) ? value.options : {};
  if (action === 'project.save') {
    const kind = readString(options.kind);
    if (kind !== 'project' && kind !== 'export') return null;
    // 工程路径必须真的带得回来一份内容，否则宿主的落盘就是空文件。
    if (kind === 'project' && typeof options.content !== 'string') return null;
  }
  return { requestId, action, options };
}

/** 把 `project.save` 的 options 收窄成宿主处理函数要的形状。 */
export function readDirectorDeskProjectSaveRequest(
  options: Record<string, unknown>,
): DirectorDeskProjectSaveRequest {
  const bytes = options.bytes;
  return {
    kind: readString(options.kind) === 'export' ? 'export' : 'project',
    name: readString(options.name) || 'project.director',
    ...(typeof options.content === 'string' ? { content: options.content } : {}),
    ...(typeof options.byteLength === 'number' ? { byteLength: options.byteLength } : {}),
    ...(typeof options.mimeType === 'string' && options.mimeType ? { mimeType: options.mimeType } : {}),
    ...(bytes instanceof ArrayBuffer ? { bytes } : {}),
  };
}

/** 子应用 ready 帧带回来的自报身份。字段都可能缺，缺失不等于不匹配。 */
export interface DirectorDeskReadyInfo {
  protocolVersion?: number;
  nodeId?: string;
}

export interface DirectorDeskBridgeHandlers {
  /** 首次收到 ready（幂等，重复 ready 不会再触发）。 */
  onReady?: (info: DirectorDeskReadyInfo) => void;
  onCaptures?: (captures: DirectorDeskCapture[]) => void;
  onClose?: () => void;
  /**
   * 子应用请宿主把工程/导出产物落盘（v2 的 `project.save`）。返回值就是回给子应用
   * 的回执；处理函数抛错则回 `ok:false`，子应用会照实告诉用户没存上。
   *
   * 不给这个回调 = 宿主不接落盘：请求会被回成明确失败，而不是静默丢弃让子应用一直等。
   */
  onProjectSave?: (
    request: DirectorDeskProjectSaveRequest,
  ) => Promise<DirectorDeskProjectSaveResult>;
  /**
   * 子应用请宿主代转一个 AI 面板动作（v2 的 `ai.request`）。action 字段是面板动作名
   * （`profiles` / `run` / `skills` …），与后端端点一一对应。
   *
   * 不给这个回调 = 宿主不接 AI 面板：请求会被回成明确失败，而不是静默丢弃让面板一直等。
   * 模型与密钥都在后端，这一跳不持有它们。
   */
  onAgentRequest?: (op: string, payload: Record<string, unknown>) => Promise<unknown>;
  /**
   * 子应用请宿主打开设置弹窗（`ui.open-settings`）。回执只有「开没开成」。
   *
   * 不给这个回调 = 宿主没有设置弹窗：请求会被回成明确失败，而不是静默丢弃让子应用
   * 一直等到超时。
   */
  onOpenHostSettings?: (page: DirectorDeskSettingsPage) => void | Promise<void>;
  /**
   * 子应用问当前项目的分镜（`storyboard.get`，子 → 宿主）。宿主是唯一同时知道
   * 「当前项目」和「用户正在看哪场戏」的地方，所以取数只在这里发生。
   *
   * 不给这个回调 = 宿主不提供分镜：请求会被回成明确失败，面板据此显示「读不到」，
   * 而不是静默丢弃让面板一直等到超时。
   */
  onStoryboardGet?: () => Promise<DirectorDeskStoryboardPayload> | DirectorDeskStoryboardPayload;
  /**
   * 面板选中某一场（`storyboard.select`，子 → 宿主）。宿主回写节点 data、重读分镜，
   * 并把重读后的载荷一并返回 —— 面板按回包重画，不自己乐观更新，避免两边选中态分叉。
   */
  onStoryboardSelect?: (
    shot: { episode: number; beat: number },
  ) => Promise<DirectorDeskStoryboardPayload> | DirectorDeskStoryboardPayload;
  /** 用户显式切换关联来源；空值表示取消，不自动选择别的项目数据。 */
  onStoryboardSource?: (sourceId: string | null) => Promise<DirectorDeskStoryboardPayload> | DirectorDeskStoryboardPayload;
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
  // ── v2 导演台 ───────────────────────────────────────────────────────────
  /**
   * 工具面唯一入口。子应用把 `toolService.call(name, args)` 的结果原样带回，
   * 所以宿主 UI 与后续的 agent 调的是同一条路。
   */
  callTool: (name: string, args?: Record<string, unknown>) => Promise<DirectorDeskToolResult>;
  /**
   * 让子应用走它自己的保存流程（`director_export {kind:'project'}`）。落盘由子应用
   * 在过程中经 `project.save` 回请宿主完成，宿主侧的节点字段在 `onProjectSave` 里写。
   */
  saveProject: () => Promise<unknown>;
  /** 把宿主存的 `.director` 文档推回子应用（关节点重开恢复）。 */
  loadProject: (document: string) => Promise<unknown>;
  /** 技能清单同步（第 4 块切片接内容）。 */
  syncSkills: (entries: readonly unknown[]) => Promise<unknown>;
  /**
   * 截一张当前取景（`preview.capture`）。子应用从自己的渲染画布读，不需要用户
   * 先打开导出对话框 —— 那是 `export.frame` 的路，会弹窗、要选参数。
   */
  capturePreview: (options?: { size?: number }) => Promise<DirectorDeskPreviewFrame>;
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

  /**
   * 逐动作超时。调用方显式给了 `exportVideoTimeoutMs` 时以调用方为准（测试要缩短它），
   * 否则走 `DIRECTOR_DESK_ACTION_TIMEOUT_MS` 表，最后才回落到通用默认。
   */
  const actionTimeoutMs = (action: DirectorDeskAction): number => {
    if (action === 'export.video' && options.exportVideoTimeoutMs !== undefined) {
      return options.exportVideoTimeoutMs;
    }
    return DIRECTOR_DESK_ACTION_TIMEOUT_MS[action] ?? requestTimeoutMs;
  };

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

  /**
   * 子应用发来的请求（v2 的 `project.save` 与 `ai.request`）。方向已在
   * `parseDirectorDeskHostRequest` 里查过白名单，这里只负责执行 + 回包。
   *
   * 处理函数缺失时不静默丢弃：子应用正卡在 `await` 上等回包，丢弃等于让它一直等到
   * 自己的超时。回一条明确失败，它能立刻把「没存上」告诉用户。
   */
  function handleHostRequest(
    requestId: string,
    action: DirectorDeskAction,
    requestOptions: Record<string, unknown>,
  ) {
    const settle = (ok: boolean, data?: unknown, error?: string) => {
      postToDirector({
        type: DIRECTOR_DESK_MESSAGE_TYPES.response,
        payload: {
          protocolVersion: DIRECTOR_DESK_PROTOCOL_VERSION,
          requestId,
          action,
          ok,
          ...(ok ? { data } : { error: { code: 'host_save_failed', message: error ?? '宿主未接受该请求' } }),
        },
      });
    };
    if (action === 'project.save') {
      if (!options.onProjectSave) {
        settle(false, undefined, '宿主未接管工程落盘');
        return;
      }
      void options
        .onProjectSave(readDirectorDeskProjectSaveRequest(requestOptions))
        .then(
          (result) => settle(true, result),
          (error: unknown) =>
            settle(false, undefined, error instanceof Error ? error.message : String(error)),
        );
      return;
    }

    // AI 面板动作（子应用 → 宿主 → Python 后端）。与 `project.save` 同方向：子应用发、
    // 宿主回，回包同样按 requestId 配对。
    if (action === 'ai.request') {
      if (!options.onAgentRequest) {
        settle(false, undefined, '宿主未接管导演台 AI 面板');
        return;
      }
      const op = readString(requestOptions.op);
      if (!op) {
        settle(false, undefined, 'ai.request 缺少动作名');
        return;
      }
      const payload = isRecord(requestOptions.payload) ? requestOptions.payload : {};
      void options.onAgentRequest(op, payload).then(
        (result) => settle(true, result),
        (error: unknown) =>
          settle(false, undefined, error instanceof Error ? error.message : String(error)),
      );
      return;
    }

    // 子应用请宿主打开自己的设置弹窗。处理函数缺失时明确失败：子应用正卡在
    // `await` 上等回包，静默丢弃只会让它一直等到超时。
    if (action === 'ui.open-settings') {
      if (!options.onOpenHostSettings) {
        settle(false, undefined, '宿主没有设置弹窗');
        return;
      }
      const page = readString(requestOptions.page);
      // 未知页码回落 models：渠道管理在那一页，猜错页码比猜错参数更坑。
      const wanted: DirectorDeskSettingsPage = page === 'storage' ? 'storage' : 'models';
      void Promise.resolve(options.onOpenHostSettings(wanted)).then(
        () => settle(true, { opened: true, page: wanted }),
        (error: unknown) =>
          settle(false, undefined, error instanceof Error ? error.message : String(error)),
      );
      return;
    }

    // 分镜选择（子 → 宿主）。与 `ai.request` 同方向，但**不经过 Python 后端**：
    // 分镜宿主自己已经读到了，再绕一圈后端只会让选镜头这件事多一次网络往返，
    // 还要求后端开一条只为转发本地取数的端点。
    if (action === 'storyboard.get' || action === 'storyboard.select' || action === 'storyboard.source') {
      if (action === 'storyboard.source') {
        if (!options.onStoryboardSource) { settle(false, undefined, '宿主未提供来源选择'); return; }
        const sourceId = typeof requestOptions.sourceId === 'string' ? requestOptions.sourceId : null;
        void Promise.resolve(options.onStoryboardSource(sourceId)).then(
          result => settle(true, result),
          (error: unknown) => settle(false, undefined, error instanceof Error ? error.message : String(error)),
        );
        return;
      }
      if (action === 'storyboard.get') {
        if (!options.onStoryboardGet) {
          settle(false, undefined, '宿主未提供分镜数据');
          return;
        }
        void Promise.resolve(options.onStoryboardGet()).then(
          (result) => settle(true, result),
          (error: unknown) =>
            settle(false, undefined, error instanceof Error ? error.message : String(error)),
        );
        return;
      }
      if (!options.onStoryboardSelect) {
        settle(false, undefined, '宿主未接管分镜选择');
        return;
      }
      // 集号与镜头号都必须是正整数：0 是后端「没指定」的哨兵值，放行会让面板的
      // 「没选中」被当成「第 0 场」，而第 0 场不存在。
      const episode = Number(requestOptions.episode);
      const beat = Number(requestOptions.beat);
      if (!Number.isInteger(episode) || episode < 0 || !Number.isInteger(beat) || beat < 1) {
        settle(false, undefined, 'storyboard.select 需要非负整数的 episode 与正整数的 beat');
        return;
      }
      void Promise.resolve(options.onStoryboardSelect({ episode, beat })).then(
        (result) => settle(true, result),
        (error: unknown) =>
          settle(false, undefined, error instanceof Error ? error.message : String(error)),
      );
      return;
    }
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
          const payload = isRecord(data.payload) ? data.payload : {};
          options.onReady?.({
            ...(typeof payload.protocolVersion === 'number'
              ? { protocolVersion: payload.protocolVersion }
              : {}),
            ...(readString(payload.nodeId) ? { nodeId: readString(payload.nodeId) } : {}),
          });
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
      case DIRECTOR_DESK_MESSAGE_TYPES.request: {
        const request = parseDirectorDeskHostRequest(data.payload);
        if (!request) return;
        handleHostRequest(request.requestId, request.action, request.options);
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
    if (DIRECTOR_DESK_ACTION_DIRECTION[action] !== 'host-to-child') {
      // 方向不对的动作发出去只会换一个永远不来的回包。
      return Promise.reject(new Error(`director desk action is child-to-host only: ${action}`));
    }
    if (!ready) {
      // 早失败好过让调用方等一个永远不来的响应：导演台在 ready 之前没挂监听。
      return Promise.reject(new Error(`director desk is not ready yet (action: ${action})`));
    }
    const requestId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `dd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timeoutMs = actionTimeoutMs(action);

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
    callTool: (name, args) =>
      request<DirectorDeskToolResult>('tool.call', { name, args: args ?? {} }),
    // 触发的是子应用**自己的**保存流程：director_export(kind=project) → saveProjectFile
    // → window.directorDesktop.files('save-project') → 回到宿主的 onProjectSave。
    // 宿主不要在这里直接传工程 JSON —— v2 的工程结构由上游定义，宿主不该复述一遍。
    saveProject: () => request<unknown>('tool.call', { name: 'director_export', args: { kind: 'project' } }),
    loadProject: (documentText) => request<unknown>('project.load', { document: documentText }),
    syncSkills: (entries) => request<unknown>('skills.sync', { entries: [...entries] }),
    capturePreview: async (previewOptions) => {
      const data = await request<unknown>('preview.capture', {
        ...(typeof previewOptions?.size === 'number' ? { width: previewOptions.size } : {}),
      });
      if (!isRecord(data) || !readString(data.dataUrl).startsWith('data:image/')) {
        throw new Error('director desk returned an unusable preview frame');
      }
      return {
        dataUrl: readString(data.dataUrl),
        width: typeof data.width === 'number' ? data.width : 0,
        height: typeof data.height === 'number' ? data.height : 0,
      };
    },
    // `sendSession` 已删：v1 的子应用靠这条帧激活自己那份 localStorage 工程，
    // v2 换成 IndexedDB 之后不再监听它（vendor/director-desk/src/host-bridge.ts:32-38
    // 的 MESSAGES 只剩 ready/request/response），而宿主侧也没有任何调用点 ——
    // 留着就是一条「以为发得出去」的死通道。
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
