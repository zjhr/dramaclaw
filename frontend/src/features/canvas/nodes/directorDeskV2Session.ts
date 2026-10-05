// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 3D 导演台 v2（`mangfufu/director-desk`，挂载在 `/director-desk-v2/`）的**节点会话**。
 *
 * 桥（[[directorDeskBridge]]）只管消息与 promise 表，不认识画布节点。这里补上缺的
 * 那一层：nodeId ↔ iframe 会话的映射、握手状态、以及每个节点自己的在途请求记账。
 * 有了它，宿主 UI 与后续的 agent 才能用「给我 node X 的导演台发一次 director_apply」
 * 这种口径说话，而不是各自去摸 React ref。
 *
 * 两条设计约束：
 *
 * 1. **注册与注销必须成对**。弹窗关掉时 iframe 连同桥一起销毁，会话表里留着一条死
 *    会话的后果不是内存泄漏那么轻 —— agent 会对着一个已经 dispose 的桥发请求，等到
 *    超时才报错，而用户看到的现象是「有时灵有时不灵」。`registerDirectorDeskV2Session`
 *    返回的退订函数由 `DirectorDeskNode` 的 iframe ref cleanup 调用。
 * 2. **工程按节点隔离**。iframe 地址带 `?node_id=`，子应用把它原样报回
 *    `capabilities.get` 的回包里，宿主据此确认自己跟对了窗口，而不是只靠「有一个
 *    窗口回了话」。同一节点重开时 `node_id` 相同，落盘与回灌都指向同一份工程。
 */
import type { DirectorDeskAction } from './directorDeskBridge';
import {
  readDirectorPromptDrafts,
  writeDirectorPromptDraft,
  type DirectorPromptDrafts,
  type DirectorPromptMode,
  type DirectorPromptPatch,
  type DirectorProductionValue,
} from './directorScenePatch';

/** 子应用的同源子路径。dev 由 `frontend/vite.config.ts` 的 vendoredDesks 中间件兜住，
 *  prod 由 `frontend/docker/nginx.conf.template` 的 `location ^~ /director-desk-v2/` 兜住。 */
export const DIRECTOR_DESK_V2_BASE_PATH = '/director-desk-v2/';

/**
 * iframe 地址。
 *
 * 参数是 `node_id` 而不是上游的 `instanceId`：上游 v0.4.10 根本没读过 `instanceId`
 * （工程只存在 IndexedDB 的单一 `recovery` 键上），传它等于传一个没人读的参数。节点
 * 隔离放在宿主这层做 —— 子应用把 `node_id` 报回能力包，宿主据此认领。
 */
export function directorDeskV2IframeSrc(nodeId: string): string {
  return `${DIRECTOR_DESK_V2_BASE_PATH}?node_id=${encodeURIComponent(nodeId)}`;
}

/** 会话在宿主侧能观察到的状态。子应用自己的 busy/编辑态不归这层管。 */
export type DirectorDeskV2SessionState = 'connecting' | 'ready' | 'closed';

export interface DirectorDeskV2Session {
  readonly nodeId: string;
  getState: () => DirectorDeskV2SessionState;
  isReady: () => boolean;
  /** 在途请求数（含工具调用）。关窗排障时能看出「宿主还在等一个回不来的回包」。 */
  pendingCount: () => number;
  /** 工具面唯一入口。宿主 UI 与 agent 共用这一个方法。 */
  callTool: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  /**
   * 把一张图接成导演台里的全景背景。**这是 v2 唯一能表达「全景背景」的方式**，
   * 详见 [[setDirectorDeskPanoramaBackground]]。
   */
  setPanoramaBackground: (
    input: DirectorDeskPanoramaInput,
  ) => Promise<DirectorDeskPanoramaResult>;
  /**
   * 读出提示词工程产出的**两份**文稿（参考视频 / 纯文本）与当前模式。
   *
   * 两份一起返回，调用方自己挑显示哪一份 —— 上游的硬约束是切模式不搬内容
   * （`production/validation.ts:3`），所以任何一侧都不该只看见一份。
   * 读不到（没就绪 / 没写 production）时返回 null，不拿空串冒充「用户没写过」。
   */
  readPromptDrafts: () => Promise<DirectorPromptDrafts | null>;
  /**
   * 写回提示词文稿。**只改传进来的键**，另一份文稿与 fixedPrompt 原样带回 ——
   * `notes` 是完整替换语义（`production-panel.ts:76` 的 `ctx.project.production[promptField(...)]`
   * 与工具层的 `use full production value, not patch` 都指向这一点）。
   */
  writePromptDraft: (patch: DirectorPromptPatch) => Promise<DirectorPromptMode>;
  saveProject: () => Promise<unknown>;
  loadProject: (documentText: string) => Promise<unknown>;
  syncSkills: (entries: readonly unknown[]) => Promise<unknown>;
  /**
   * 登记后端会话并启动工具调用长轮询。
   *
   * 这条循环就是工具传输层的画布半边：agent 循环在后端跑，`director_*` 在这里执行。
   * 它**不是**按需启动的 —— 没有这条循环，后端连一次 `director_read` 都发不出去。
   */
  startAgent: () => Promise<{ sessionId: string }>;
  /** 关窗时注销会话。后端据此把在途调用收成 `execution: 'unknown'`。 */
  stopAgent: () => Promise<void>;
  /** 面板动作（渠道 / 对话 / run / stop / 技能）。细节见 `routes.py`。 */
  requestAgent: (op: DirectorDeskAiOp, payload?: Record<string, unknown>) => Promise<unknown>;
  /** 桥协议出错时的旁路出口（诊断用，不参与业务判断）。 */
  onError: (listener: (error: Error) => void) => () => void;
}

/** AI 面板动作。与后端 `routes.py` 的 `/ai/*` 端点一一对应。 */
export type DirectorDeskAiOp =
  | 'profiles'
  | 'conversation'
  | 'newConversation'
  | 'configure'
  | 'channelModels'
  | 'channelQuickCreate'
  | 'profileModels'
  | 'profileModel'
  | 'test'
  | 'run'
  | 'stop'
  | 'skills'
  | 'mcp'
  | 'mcpConfig'
  | 'update';

/** 后端路由前缀。与 `novelvideo.director_desk.routes` 的挂载前缀一致。 */
export const DIRECTOR_DESK_API_BASE = '/api/v1/director-desk';

/**
 * 全景背景的失败分类。宿主据此选本地化文案，**不把上游的中文错误串直接甩给用户**。
 *
 * - `unreachable`：没有可用会话（弹窗没开 / 已关 / 正在重连）。
 * - `unsupported-media`：不是 PNG/JPEG/WebP —— 上游 `media/source.ts:14-23` 的白名单。
 * - `too-large`：超过 {@link DIRECTOR_DESK_PANORAMA_MAX_BYTES}，网页通道带不动。
 * - `busy`：子应用正在编辑 / 绘制 / 执行长任务，撞上 `service.ts` 的 `idle()` 守卫。
 * - `unreachable-tool`：导演台没回话（超时 / 已 dispose）。
 * - `failed`：其它失败，`message` 里带原始原因。
 */
export type DirectorDeskPanoramaFailure =
  | 'unreachable'
  | 'unsupported-media'
  | 'too-large'
  | 'busy'
  | 'unreachable-tool'
  | 'failed';

export class DirectorDeskPanoramaError extends Error {
  constructor(
    readonly reason: DirectorDeskPanoramaFailure,
    message: string,
  ) {
    super(message);
    this.name = 'DirectorDeskPanoramaError';
  }
}

export interface DirectorDeskPanoramaInput {
  /** 宿主侧可取的图片地址（同源 `/static/...` 或 `data:image/...`）。 */
  imageUrl: string;
  /** 展示用文件名，同时作为工程内媒体资源的 `name`。 */
  fileName: string;
}

export interface DirectorDeskPanoramaResult {
  /** 工程内承载全景的实体 id（`director-panorama-<nodeId>`）。 */
  entityId: string;
  /** 媒体资源 id（`media-<sha256>`）。 */
  resourceId: string;
  /** 媒体是否已在工程里（复用而非重新导入）。 */
  reusedMedia: boolean;
  /** 全景实体是新建的还是覆盖已有的。 */
  createdEntity: boolean;
}

/** 网页通道能带动的最大图片字节。超限**明确报错**，不截断、不偷偷换图。 */
export const DIRECTOR_DESK_PANORAMA_MAX_BYTES = 12 * 1024 * 1024;

/** 上游 `media/source.ts:14-23` 的图片白名单（视频 mime 对静态全景没有意义）。 */
export const DIRECTOR_DESK_PANORAMA_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

const PANORAMA_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * 全景实体 id。
 *
 * 必须满足上游 `model.ts:252` 的 `safeId`（`/^[\p{L}\p{N}_:.-]{1,200}$/u`），而画布
 * nodeId 的字符集不受这条正则约束，所以这里自己消毒并截断到 180，留出前缀长度。
 * 同一 nodeId 恒得同一 id —— 换图是 `update` 覆盖同一个球，而不是每次再叠一个。
 */
export function directorDeskPanoramaEntityId(nodeId: string): string {
  const suffix = nodeId.trim().replace(/[^\p{L}\p{N}_:.-]/gu, '-').slice(0, 180);
  return `director-panorama-${suffix}`;
}

/**
 * 从 Content-Type 或扩展名认 mime。
 *
 * 服务端**明确声明**了一个非白名单类型时直接失败，不用扩展名兜底：声明是权威信号，
 * 拿 `.png` 的扩展名去盖掉服务端的 `image/gif`，等于把一张动图当静态图塞进引擎 ——
 * 上游 `importMedia` 也会在解码时才发现，那时字节已经在工程里了。
 *
 * 只有 Content-Type 缺失或确实是通用二进制流（静态站常见的
 * `application/octet-stream`）才回落到扩展名。
 */
export function detectPanoramaMime(
  imageUrl: string,
  contentType?: string | null,
): string | null {
  const declared = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const supported = DIRECTOR_DESK_PANORAMA_MIME_TYPES as readonly string[];
  if (declared && supported.includes(declared)) return declared;
  if (declared && declared !== 'application/octet-stream' && declared !== 'binary/octet-stream') {
    return null;
  }
  const path = imageUrl.split(/[?#]/)[0] ?? '';
  const extension = /\.([A-Za-z0-9]{1,5})$/.exec(path)?.[1]?.toLowerCase() ?? '';
  return PANORAMA_MIME_BY_EXTENSION[extension] ?? null;
}

/** 文件名换成与实际 mime 一致的扩展名，避免工程媒体面板里名实不符。 */
export function panoramaFileNameForMime(fileName: string, mime: string): string {
  const extension = mime.split('/')[1] === 'jpeg' ? 'jpg' : mime.split('/')[1] ?? 'png';
  const base = (fileName.split(/[?#]/)[0] ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, '').slice(0, 180);
  return `${base || 'panorama'}.${extension}`;
}

/** btoa 一次吃不下十几 MB，分块编码。 */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

interface PanoramaMedia {
  data: string;
  name: string;
  mime: string;
  /** 上游按内容寻址（`media-<sha256>`）。算不出来时留空，走「总是导入」。 */
  predictedResourceId: string;
}

async function loadPanoramaMedia(
  input: DirectorDeskPanoramaInput,
): Promise<PanoramaMedia> {
  let response: Response;
  try {
    response = await fetch(input.imageUrl, { credentials: 'same-origin' });
  } catch (error) {
    throw new DirectorDeskPanoramaError(
      'failed',
      `panorama image request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new DirectorDeskPanoramaError(
      'failed',
      `panorama image request failed: http ${response.status}`,
    );
  }
  const mime = detectPanoramaMime(input.imageUrl, response.headers.get('content-type'));
  if (!mime) {
    throw new DirectorDeskPanoramaError(
      'unsupported-media',
      `panorama media type is not supported: ${input.imageUrl}`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new DirectorDeskPanoramaError('failed', 'panorama image is empty');
  }
  if (bytes.byteLength > DIRECTOR_DESK_PANORAMA_MAX_BYTES) {
    // 明确失败，不截断、不降质。上游 mediaGuide 也说大字节该走桌面通道。
    throw new DirectorDeskPanoramaError(
      'too-large',
      `panorama image is ${bytes.byteLength} bytes, over ${DIRECTOR_DESK_PANORAMA_MAX_BYTES}`,
    );
  }
  return {
    data: `data:${mime};base64,${bytesToBase64(bytes)}`,
    name: panoramaFileNameForMime(input.fileName, mime),
    mime,
    predictedResourceId: await predictMediaResourceId(bytes),
  };
}

/**
 * 复刻上游 `media/source.ts:22-23` 的资源 id：内容 SHA-256 → `media-<hex>`。
 *
 * 有了它，宿主能认出「这张图已经在工程里了」，省掉一次几十 MB 的 data URL 往返。
 * 算不出来（没有 `crypto.subtle`）就留空 —— 那只是退回「总是导入」，不会错。
 */
async function predictMediaResourceId(bytes: Uint8Array): Promise<string> {
  const subtle = typeof crypto === 'undefined' ? undefined : crypto.subtle;
  if (!subtle) return '';
  try {
    const digest = await subtle.digest('SHA-256', bytes);
    const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `media-${hex}`;
  } catch {
    return '';
  }
}

type ToolCaller = (name: string, args?: Record<string, unknown>) => Promise<unknown>;

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** `tool.call` 的回包是 `{revision, result}`；子应用已把失败折成异常，这里只读成功分支。 */
function readToolResult(value: unknown): Record<string, unknown> {
  return readRecord(readRecord(value).result);
}

function readRevision(value: unknown): number | null {
  const result = readToolResult(value);
  return typeof result.revision === 'number' ? result.revision : null;
}

function isRevisionConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('REVISION_CONFLICT');
}

function isDeskBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('正在编辑、绘制或执行长任务');
}

/**
 * 全景球的半径（米）。`sampleVisual` 对 panorama 直接 `setScalar(spread)`
 * （`vendor/director-desk/src/visuals/runtime.ts:99`），所以这是唯一的尺寸旋钮。
 * 取 120：远大于单人场景，也远小于 `engine.ts:51` 的 `camera.far = 2000`，深度精度不吃紧。
 */
export const PANORAMA_SPHERE_RADIUS = 120;

/**
 * 全景球的完整 `visual` 配置。
 *
 * `patch.visual` 是**整体替换**（`model.ts:351` 的 `assertVisual` 要求字段齐全），
 * 所以这里必须给全。字段与默认值逐条对齐
 * `vendor/director-desk/src/visuals/model.ts:12` 的 `defaultVisual('panorama')`，
 * 只有两处刻意改：
 *
 * - `opacity: 1` —— 默认 0.8。材质是 `transparent:true`，半透明会把场景背景色透出来。
 * - `spread: {@link PANORAMA_SPHERE_RADIUS}` —— 球的半径（`visuals/runtime.ts:99`
 *   对 panorama 用 `spread` 而不是 `size`），必须罩住整个场景。
 *
 * `preset` 决定 `asset`：`model.ts:351` 要求 `e.asset === 'visual-' + e.visual.preset`。
 */
const PANORAMA_VISUAL = {
  preset: 'panorama',
  timeOffset: 0,
  cameraId: '',
  lifetime: 5,
  count: 200,
  seed: 42,
  size: 1,
  spread: PANORAMA_SPHERE_RADIUS,
  speed: 1,
  amplitude: 0.5,
  frequency: 2,
  opacity: 1,
  start: 0,
  end: 0,
  text: '文字',
  secondaryColor: '#527bff',
  additive: false,
  quality: 'normal',
} as const;

/**
 * 承载全景的那层 unlit 贴图。
 *
 * 字段形状对齐上游 `media/model.ts:12` 的 `defaultSurfaceLayer`（`assertSurface`
 * 逐字段校验，见 `media/model.ts:41-53`）。三处刻意值：
 *
 * - `mapping: 'sphere'` —— 上游的等距圆柱投影模式（`media/surface-runtime.ts:27`），
 *   `mediaAspect` 对它直接返回 2.0（`:35`），就是全景图的长宽比。它从**几何位置**
 *   算 UV，不依赖网格自带 uv，因此换几何也不会退化成盒式投影。
 * - `unlit: true` —— `media/help.ts` 末行明确要求：全景背景不受光照影响。
 * - `fit: 'stretch'` —— 球面本身就是 2:1 的映射，铺满即可，不做 contain/cover 裁切。
 *
 * `yaw` 说明：两个映射模式都把图像正中（u=0.5）放在世界 +X，而摄影机朝 +Z
 * （`engine.ts:377`）。差的是一个固定偏航角，不是镜像 —— 全景图本身不带朝向信息，
 * 这里不去猜，也就没有加旋转。
 */
function panoramaSurfaceLayer(resourceId: string) {
  return {
    layers: [
      {
        id: 'panorama',
        resourceId,
        timeOffset: 0,
        mesh: -1,
        material: -1,
        face: 'all',
        mapping: 'sphere',
        crop: [0, 0, 1, 1],
        offset: [0, 0],
        repeat: [1, 1],
        rotation: 0,
        tile: false,
        fit: 'stretch',
        opacity: 1,
        unlit: true,
        start: 0,
        trimIn: 0,
        trimOut: 0,
        speed: 1,
        loop: true,
      },
    ],
  };
}

/** revision 冲突最多重试两轮：每一轮之间用户都可能又动了一下工程。 */
const PANORAMA_MAX_ATTEMPTS = 3;

/**
 * 读提示词工程产出的两份文稿。
 *
 * `director_read` 是只读工具（`contract.ts` 的 `DISCUSSION_TOOLS` 收录了它），
 * 不走 `idle()` 守卫也不改 revision，所以播放中读是安全的 —— 用户正看着预览改词时
 * 不会因为「导演台正在编辑」而被拒。
 */
async function readPromptDrafts(callTool: ToolCaller): Promise<DirectorPromptDrafts | null> {
  const read = await callTool('director_read', { sections: ['production'] });
  const result = readToolResult(read) as { production?: Partial<DirectorProductionValue> };
  if (!result.production) return null;
  const drafts = readDirectorPromptDrafts(result.production);
  return drafts;
}

/**
 * 写回一份提示词文稿，返回写完后的实际模式。
 *
 * 读-改-写：先把当前 production **整份**读回来（`productionData` 补齐
 * `fixedPrompt` / `sceneReferenceIds` / `notes` 三个必填项），只替换要改的那一个键，
 * 再整份提交。直接提交 patch 会把另一份文稿与全部备注清空 —— 上游
 * `productionValueGuide` 对这点写得很明确。
 *
 * revision 冲突重试同 [[PANORAMA_MAX_ATTEMPTS]]：每一轮重读一次，顺带把用户在这
 * 期间新写的另一份文稿带上，避免用旧快照覆盖他。
 */
async function writePromptDraft(
  callTool: ToolCaller,
  patch: DirectorPromptPatch,
): Promise<DirectorPromptMode> {
  for (let attempt = 1; attempt <= PANORAMA_MAX_ATTEMPTS; attempt += 1) {
    try {
      const read = readToolResult(await callTool('director_read', { sections: ['production'] }));
      const revision = readRevision(read);
      if (revision === null) throw new Error('导演台没有返回工程版本');
      const value = writeDirectorPromptDraft(read.production as Partial<DirectorProductionValue>, patch);
      await callTool('director_apply', {
        revision,
        requestId: newRequestId(),
        operations: [{ operation: 'notes', value }],
      });
      return value.promptMode ?? 'reference-video';
    } catch (error) {
      if (isRevisionConflict(error) && attempt < PANORAMA_MAX_ATTEMPTS) continue;
      throw error;
    }
  }
  /* c8 ignore next */
  throw new Error('导演台工程一直在变，写入提示词失败');
}

function newRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `pano-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 把一张图接成导演台里的全景背景 —— v2 的三步链路。
 *
 * ## 为什么是三步，而不是一条消息
 *
 * v2 子应用的 `MESSAGES` 只有 `ready / request / response`
 * （`vendor/director-desk/src/host-bridge.ts:32-38`），**没有全景帧的接收方**。
 * v2 也没有「设置场景背景」这个概念：`lighting.background` 被 `assertLighting`
 * 限制成十六进制色值（`lighting/model.ts:22-25`），由 `engine.ts:546` 交给
 * `new T.Color(...)`。上游自己给出的官方做法写在 `media/help.ts` 末行：
 *
 * > Panorama uses an inward-facing sphere; add an unlit surface layer for image or
 * > video backgrounds.
 *
 * 于是链路固定为：
 *
 * ```
 * director_media {action:'import'}          → 字节进工程媒体，回 resourceId
 * director_apply  {add visual-panorama}    → 内向球体（visuals/runtime.ts:80 用 BackSide）
 * director_apply  {update + patch.surface} → 该实体加一层 unlit surface layer
 * ```
 *
 * `add` 与 `update` 合成同一批 `operations`：批次是先算后提交的（`edits.ts` 的
 * `applyOperations` 最后统一 `assertProject`），所以「建球」和「贴图」要么一起成立，
 * 要么一起不成立，不会留下一个没有背景的空球。
 *
 * ## revision 握手
 *
 * `director_media` 的 import 分支在 `service.ts:66` 用 `checkRevision` 卡版本，
 * 不匹配就抛 `REVISION_CONFLICT`。所以每轮都先 `director_media {action:'list'}`
 * 与 `director_read` 取当时的 revision，再用它发起写操作；撞上冲突就重来一轮，
 * 最多 {@link PANORAMA_MAX_ATTEMPTS} 轮。**每一轮都用新的 requestId** ——
 * 上游的收据表把 `requestId` 与参数（含 revision）绑定，复用同一个 id 换 revision
 * 会被判成「requestId 已用于不同操作」（`service.ts:65`）。
 *
 * ## idle 守卫
 *
 * import 与 apply 都先过 `idle()`（`service.ts:59` / `:136`）：子应用正在编辑、绘制
 * 或跑长任务时直接抛错。这类失败**不重试** —— 重试只会再撞一次同一个忙碌状态，
 * 如实报成 `busy` 交给宿主提示。
 */
export async function setDirectorDeskPanoramaBackground(
  callTool: ToolCaller,
  nodeId: string,
  input: DirectorDeskPanoramaInput,
): Promise<DirectorDeskPanoramaResult> {
  const media = await loadPanoramaMedia(input);
  const entityId = directorDeskPanoramaEntityId(nodeId);

  for (let attempt = 1; attempt <= PANORAMA_MAX_ATTEMPTS; attempt += 1) {
    try {
      const listed = readToolResult(await callTool('director_media', { action: 'list' }));
      const read = readToolResult(await callTool('director_read', { ids: [entityId] }));
      // 取两次读取里较新的 revision：越贴近写操作越不容易被中途的用户动作顶掉。
      const revision =
        readRevision(read) ?? readRevision(listed) ?? readRevision(await callTool('director_read'));
      if (revision === null) {
        throw new DirectorDeskPanoramaError(
          'failed',
          'director desk did not report a project revision',
        );
      }

      const alreadyImported =
        media.predictedResourceId !== '' &&
        Array.isArray(listed.media) &&
        listed.media.some(
          (item) => readRecord(item).id === media.predictedResourceId,
        );

      let resourceId = media.predictedResourceId;
      let currentRevision = revision;
      if (!alreadyImported) {
        const imported = readToolResult(
          await callTool('director_media', {
            action: 'import',
            revision,
            requestId: newRequestId(),
            data: media.data,
            name: media.name,
            mime: media.mime,
          }),
        );
        resourceId = typeof imported.resourceId === 'string' ? imported.resourceId : '';
        if (!resourceId) {
          throw new DirectorDeskPanoramaError(
            'failed',
            'director desk imported the panorama but returned no resourceId',
          );
        }
        currentRevision = typeof imported.revision === 'number' ? imported.revision : revision;
      }

      const existing = Array.isArray(read.entities) ? read.entities : [];
      const createdEntity = existing.length === 0;
      const patch = {
        visual: { ...PANORAMA_VISUAL },
        surface: panoramaSurfaceLayer(resourceId),
      };
      await callTool('director_apply', {
        revision: currentRevision,
        requestId: newRequestId(),
        operations: [
          createdEntity
            ? {
                operation: 'add',
                asset: 'visual-panorama',
                id: entityId,
                name: media.name,
                patch,
              }
            : { operation: 'update', id: entityId, patch },
        ],
      });

      return { entityId, resourceId, reusedMedia: alreadyImported, createdEntity };
    } catch (error) {
      if (error instanceof DirectorDeskPanoramaError) throw error;
      if (isDeskBusy(error)) {
        throw new DirectorDeskPanoramaError(
          'busy',
          error instanceof Error ? error.message : String(error),
        );
      }
      if (isRevisionConflict(error) && attempt < PANORAMA_MAX_ATTEMPTS) continue;
      if (isRevisionConflict(error)) {
        throw new DirectorDeskPanoramaError(
          'failed',
          error instanceof Error ? error.message : String(error),
        );
      }
      throw new DirectorDeskPanoramaError(
        'failed',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  /* c8 ignore next */
  throw new DirectorDeskPanoramaError('failed', 'panorama apply gave up');
}

interface SessionRecord {
  session: DirectorDeskV2Session;
  /** 长轮询要把调用交给 iframe、把事件推回 iframe，都得直接用桥（session 的方法包了计数）。 */
  bridge: DirectorDeskV2BridgeLike;
  errorListeners: Set<(error: Error) => void>;
  /**
   * 宿主画布侧的 agent 事件订阅者。
   *
   * 事件本来只有一条去向（推给 iframe 面板）。方案 3 之后画布侧面板也跑在**同一个**
   * 后端循环上，所以同一批事件要同时喂给两个消费方 —— 它们看到的是同一个 runId、
   * 同一份对话，不存在「两边各跑一遍」的可能。
   */
  agentEventListeners: Set<(event: Record<string, unknown>) => void>;
  pending: number;
  state: DirectorDeskV2SessionState;
  /** 后端会话 id；未登记为 null。 */
  agentSessionId: string;
  /** 长轮询的停机开关。注销会话时置位。 */
  agentStopped: boolean;
  /** 有没有在途任务。由 agent 事件的 `start` / `done` / `error` 翻转。 */
  agentRunning: boolean;
}

const sessions = new Map<string, SessionRecord>();

/** 长轮询挂起秒数。比后端上限小，留一次重连的余量。 */
const AGENT_POLL_WAIT_SECONDS = 25;

/** 底层桥的最小形状。本模块只依赖这两个方法，不 import 实现，方便单测替身。 */
export interface DirectorDeskV2BridgeLike {
  isReady: () => boolean;
  request: <T = unknown>(
    action: DirectorDeskAction,
    options?: Record<string, unknown>,
  ) => Promise<T>;
}

export interface RegisterDirectorDeskV2SessionOptions {
  bridge: DirectorDeskV2BridgeLike;
  onError?: (error: Error) => void;
}

/**
 * 注册一个节点会话。**同一 nodeId 重复注册会顶掉前一条**并把前一条标记为 closed ——
 * 「重试」按钮换 iframe key 时会走到这里，旧会话必须立刻失效而不是继续收消息。
 *
 * @returns 退订函数。调用后该 nodeId 的会话从表里移除；重复调用是安全的空操作。
 */
export function registerDirectorDeskV2Session(
  nodeId: string,
  options: RegisterDirectorDeskV2SessionOptions,
): () => void {
  const key = nodeId.trim();
  if (!key) throw new Error('director desk v2 session requires a node id');
  const { bridge } = options;
  const errorListeners = new Set<(error: Error) => void>();
  if (options.onError) errorListeners.add(options.onError);

  const previous = sessions.get(key);
  if (previous) previous.state = 'closed';

  const track = async <T>(task: Promise<T>): Promise<T> => {
    record.pending += 1;
    try {
      return await task;
    } finally {
      record.pending -= 1;
    }
  };

  const callTool: ToolCaller = (name, args) =>
    track(bridge.request('tool.call', { name, args: args ?? {} }));

  const record: SessionRecord = {
    pending: 0,
    state: 'connecting',
    bridge,
    errorListeners,
    agentEventListeners: new Set(),
    agentSessionId: '',
    agentStopped: false,
    agentRunning: false,
    session: {
      nodeId: key,
      // 桥的 ready 是握手的唯一事实来源；会话自己记的那个标记只是让「ready 到了又
      // 立刻 dispose」这种边缘情形不至于倒退回 connecting。
      getState: () => {
        if (record.state === 'closed') return 'closed';
        return bridge.isReady() || record.state === 'ready' ? 'ready' : 'connecting';
      },
      isReady: () => bridge.isReady() && record.state !== 'closed',
      pendingCount: () => record.pending,
      callTool,
      setPanoramaBackground: (input) =>
        track(setDirectorDeskPanoramaBackground(callTool, key, input)),
      readPromptDrafts: () => track(readPromptDrafts(callTool)),
      writePromptDraft: (patch) => track(writePromptDraft(callTool, patch)),
      saveProject: () =>
        track(bridge.request('tool.call', { name: 'director_export', args: { kind: 'project' } })),
      loadProject: (documentText) => track(bridge.request('project.load', { document: documentText })),
      syncSkills: (entries) => track(bridge.request('skills.sync', { entries: [...entries] })),
      startAgent: () => track(startAgentSession(key, record)),
      stopAgent: () => stopAgentSession(key, record),
      requestAgent: (op, payload) => track(requestAgentApi(key, op, payload)),
      onError: (listener) => {
        errorListeners.add(listener);
        return () => {
          errorListeners.delete(listener);
        };
      },
    },
  };

  sessions.set(key, record);

  return () => {
    if (sessions.get(key) !== record) return; // 已被新会话顶掉，别删掉别人的
    record.state = 'closed';
    record.errorListeners.clear();
    record.agentEventListeners.clear();
    sessions.delete(key);
    // 后端会话必须跟着注销：否则下一次 open 会话时后端还会把工具调用排给一个
    // 已经消失的窗口，而画布这一侧没人再 poll —— 那批调用只能等超时。
    void stopAgentSession(key, record);
  };
}

// ── AI 会话（工具传输层的画布半边）───────────────────────────────────────────

async function postJson(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${DIRECTOR_DESK_API_BASE}${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`导演台接口返回了非 JSON 响应（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    const detail = readRecord(payload).detail;
    throw new Error(typeof detail === 'string' ? detail : `导演台接口失败（HTTP ${response.status}）`);
  }
  return payload;
}

function reportError(record: SessionRecord, error: unknown): void {
  const failure = error instanceof Error ? error : new Error(String(error));
  for (const listener of record.errorListeners) {
    try {
      listener(failure);
    } catch {
      // 监听器抛错不该把轮询循环带走。
    }
  }
}

/**
 * 登记后端会话并起长轮询。
 *
 * 工具面与内置技能由子应用自报（`ai.describe`）：上游一升级，工具定义和内置技能都会
 * 变，让后端抄一份副本只会在某次升级后静默漂移。
 */
async function startAgentSession(
  nodeId: string,
  record: SessionRecord,
): Promise<{ sessionId: string }> {
  if (record.agentSessionId) return { sessionId: record.agentSessionId };
  const described = readRecord(await record.bridge.request('ai.describe'));
  const opened = readRecord(
    await postJson('/ai/session', {
      nodeId,
      contract: described.contract ?? {},
      builtinSkill: described.builtinSkill ?? null,
    }),
  );
  const sessionId = typeof opened.sessionId === 'string' ? opened.sessionId : '';
  if (!sessionId) throw new Error('导演台后端没有返回会话 id');
  record.agentSessionId = sessionId;
  record.agentStopped = false;
  void pumpAgentSession(nodeId, record);
  return { sessionId };
}

/**
 * 长轮询循环 —— 传输层的画布半边。
 *
 * 一次回包同时带**工具调用**与**agent 事件**：
 *   - 调用在这里就地执行（走 {@link DirectorDeskV2Session.callTool}，即上游那条
 *     `tool.call` → `toolService.call` 通道），结果按 requestId 回填；
 *   - 事件转给子应用的 `onEvent` 回调，AI 面板据此更新。
 *
 * 模型永远不直连引擎：它只知道「有个 request_id 要执行」，执行的是这扇 iframe。
 */
async function pumpAgentSession(nodeId: string, record: SessionRecord): Promise<void> {
  while (!record.agentStopped && record.agentSessionId) {
    let payload: Record<string, unknown>;
    try {
      payload = readRecord(
        await postJson('/ai/poll', {
          nodeId,
          sessionId: record.agentSessionId,
          wait: AGENT_POLL_WAIT_SECONDS,
        }),
      );
    } catch (error) {
      // 会话已经没了（后端重启 / 另一扇窗口顶替）就退出循环，不做无意义的重试风暴。
      if (record.agentStopped || record.state === 'closed') return;
      reportError(record, error);
      await sleep(1000);
      continue;
    }
    for (const call of Array.isArray(payload.calls) ? payload.calls : []) {
      const request = readRecord(call);
      const requestId = typeof request.request_id === 'string' ? request.request_id : '';
      const name = typeof request.name === 'string' ? request.name : '';
      if (!requestId || !name) continue;
      record.pending += 1;
      try {
        const envelope = await record.session.callTool(name, readRecord(request.args));
        // `tool.call` 的回包是 `{revision, result}`（子应用已把失败折成异常），
        // 而后端要的是上游约定的 `{ok, data, revision}`。不在这补一层，agent 循环
        // 会把每一次成功都当成失败。
        const bridge = readRecord(envelope);
        const revision = typeof bridge.revision === 'number' ? bridge.revision : null;
        await postJson('/ai/tool-result', {
          nodeId,
          requestId,
          result: { ok: true, revision, data: bridge.result ?? null },
        });
      } catch (error) {
        // 工具执行失败是业务结果（工具自己会返回 {ok:false}）；这里捕的是桥断了。
        await postJson('/ai/tool-result', {
          nodeId,
          requestId,
          result: { ok: false, execution: 'unknown', error: describeError(error) },
        }).catch(() => undefined);
      } finally {
        record.pending -= 1;
      }
    }
    for (const event of Array.isArray(payload.events) ? payload.events : []) {
      // 先喂宿主订阅者再推 iframe：画布侧面板与 iframe 面板看到的是**同一批**事件，
      // 顺序固定，宿主渲染不必等一次 postMessage 往返。
      fanOutAgentEvent(record, readRecord(event));
      try {
        await record.bridge.request('agent.event', { event });
      } catch (error) {
        reportError(record, error);
      }
    }
  }
}

/**
 * 把一条 agent 事件交给宿主侧订阅者。
 *
 * 订阅者抛错只影响它自己：面板的事件回调里渲染一条坏消息不该把长轮询循环带走 ——
 * 那个循环是整条工具传输层的命脉（`director_apply` 全靠它执行）。
 */
function fanOutAgentEvent(record: SessionRecord, event: Record<string, unknown>): void {
  // 任务在途标志只认这三种事件：`start` 开，`done` / `error` 关。面板据此把「发送」变
  // 「停止」，错认一次的后果只是按钮状态不对一两秒，而去后端另问一次才是真的往返。
  const kind = typeof event.type === 'string' ? event.type : '';
  if (kind === 'start') record.agentRunning = true;
  else if (kind === 'done' || kind === 'error') record.agentRunning = false;
  for (const listener of [...record.agentEventListeners]) {
    try {
      listener(event);
    } catch (error) {
      reportError(record, error);
    }
  }
}

async function stopAgentSession(nodeId: string, record: SessionRecord): Promise<void> {
  const sessionId = record.agentSessionId;
  record.agentStopped = true;
  record.agentSessionId = '';
  record.agentRunning = false;
  if (!sessionId) return;
  await postJson('/ai/session/close', { nodeId, sessionId }).catch(() => undefined);
}

/** AI 面板动作 → 后端端点。两张表要对齐，改了一边记得改另一边。 */
const AGENT_ENDPOINTS: Record<DirectorDeskAiOp, string> = {
  profiles: '/ai/profiles',
  conversation: '/ai/conversation',
  newConversation: '/ai/conversation/new',
  configure: '/ai/configure',
  // 面板「极简新建渠道」向导的两步。试拉列表是只读的，建渠道落全局 settings 库。
  channelModels: '/ai/channel-models',
  channelQuickCreate: '/ai/channel-quick-create',
  // 「选完渠道 → 选模型」：按渠道 id 读它自己的上游模型列表（密钥不出后端），
  // 以及把选中的模型存下来。两者都是全局的 —— 渠道不属于某扇 iframe。
  profileModels: '/ai/profile-models',
  profileModel: '/ai/profile-model',
  test: '/ai/test',
  run: '/ai/run',
  stop: '/ai/stop',
  skills: '/skills',
  mcp: '/ai/mcp',
  mcpConfig: '/ai/mcp/config',
  update: '/ai/update',
};

/**
 * 哪些动作是**全局**的（不带 nodeId）。
 *
 * 渠道、技能、软件更新与连接配置都不属于某扇 iframe；`mcp` 反而必须带 —— 它问的是
 * 「这个节点现在能不能被外部客户端驱动」，不问节点就没有答案。
 */
const AGENT_OPS_WITHOUT_NODE: ReadonlySet<DirectorDeskAiOp> = new Set<DirectorDeskAiOp>([
  'configure',
  'channelModels',
  'channelQuickCreate',
  'profileModels',
  'profileModel',
  'skills',
  'mcpConfig',
  'update',
]);

async function requestAgentApi(
  nodeId: string,
  op: DirectorDeskAiOp,
  payload?: Record<string, unknown>,
): Promise<unknown> {
  const path = AGENT_ENDPOINTS[op];
  if (!path) throw new Error(`未知的导演台 AI 动作: ${op}`);
  const body: Record<string, unknown> = { ...(payload ?? {}) };
  if (!AGENT_OPS_WITHOUT_NODE.has(op)) body.nodeId = nodeId;
  return postJson(path, body);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 通知某节点会话「握手完成」。由 `DirectorDeskNode` 在收到 ready 时调用。 */
export function markDirectorDeskV2SessionReady(nodeId: string): void {
  const record = sessions.get(nodeId.trim());
  if (!record || record.state === 'closed') return;
  record.state = 'ready';
  // 握手完成才能登记后端会话：工具清单要问子应用，握手没完成时它答不上来。
  void record.session.startAgent().catch((error: unknown) => {
    reportError(record, error);
  });
}

/** 取某节点的会话。没开弹窗就是 null —— 这是正常状态，不是错误。 */
export function getDirectorDeskV2Session(nodeId: string): DirectorDeskV2Session | null {
  return sessions.get(nodeId.trim())?.session ?? null;
}

/**
 * 订阅某节点的 agent 事件流。返回退订函数。
 *
 * 这是方案 3 的接口：画布侧面板不再自己跑 agent，它与 iframe 面板**共用后端那一个循环**，
 * 所以两边拿到的 `runId`、文本增量与工具收据逐条相同。会话没登记时直接退订（不抛）——
 * 面板在弹窗打开前就会挂载，那时还没有长轮询。
 */
export function subscribeDirectorDeskAgentEvents(
  nodeId: string,
  listener: (event: Record<string, unknown>) => void,
): () => void {
  const record = sessions.get(nodeId.trim());
  if (!record) return () => undefined;
  record.agentEventListeners.add(listener);
  return () => {
    record.agentEventListeners.delete(listener);
  };
}

/**
 * 某节点当前有没有在途 agent 任务。
 *
 * 由事件流自己判定（`start` / `done` / `error`），不另找后端问一次：轮询循环本来就在
 * 处理每一条事件，在这里记一个标志是零成本的，而多打一次端点会在「按钮点下去到按钮
 * 变灰」之间留一个空窗。
 *
 * 画布侧面板据此把「发送」变「停止」：两个入口跑的是同一个循环，后端本来就只允许
 * 同一时刻一个任务，面板不跟着变就会让用户以为自己那条被吞了。
 */
export function isDirectorDeskAgentRunning(nodeId: string): boolean {
  return sessions.get(nodeId.trim())?.agentRunning ?? false;
}

/** 当前所有活着的会话（按 nodeId 排序，便于测试与诊断输出稳定）。 */
export function listDirectorDeskV2NodeIds(): string[] {
  return [...sessions.keys()].sort();
}

/** 测试与热重载后清表。生产代码不该调用。 */
export function resetDirectorDeskV2SessionsForTests(): void {
  sessions.clear();
}

/**
 * 一场分镜。字段与后端 `beat_view` 的输出一一对应，只多一个 `episode`。
 */
export interface DirectorDeskStoryboardShot {
  beat_number: number;
  scene: string;
  duration_seconds: number;
  speaker: string;
  synopsis: string;
  spoken_text: string;
}

/** 整个项目的分镜，以及这一轮带上哪个 episode / beat。 */
export interface DirectorDeskStoryboard {
  episode: number;
  episodes: number[];
  beats: DirectorDeskStoryboardShot[];
  /** 选中的场次；`null` = 这个集还没有分镜。 */
  selected: number | null;
  /**
   * 后端拼好的「这一轮要带进模型上下文的分镜说明」。
   *
   * 由后端生成而不是前端拼：它有 beat 的全部字段和防注入的措辞，前端拼一遍就得
   * 维护第二套格式，两边一漂移模型就看到半截说明。
   */
  context: string;
}

/**
 * 从后端拉分镜。
 *
 * 走宿主这一侧而不是面板：面板在 iframe 里，取不到项目 id 和登录态，而且分镜是
 * **项目级**数据，宿主是唯一知道当前项目的地方。
 *
 * 读失败时返回 `null` 而不是抛 —— 调用方要区分「这个项目真的没有分镜」和「接口
 * 挂了」，合成一句「没有分镜」会把一次故障说成用户没素材。
 */
export async function fetchDirectorDeskStoryboard(
  project: string,
  options?: { episode?: number; beat?: number; signal?: AbortSignal },
): Promise<DirectorDeskStoryboard | null> {
  const response = await fetch(`${DIRECTOR_DESK_API_BASE}/storyboard`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      // 字段名必须是 `project` —— 端点的请求模型用这个名字（`StoryboardRequest`）。
      // 写成 `projectId` 会拿到 422，而这里原本把失败当成「读不到」，用户只看到
      // 一句「工程快照加载失败」类的提示，真正的原因被吞掉了。
      project,
      episode: options?.episode,
      beat: options?.beat,
    }),
    signal: options?.signal,
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`分镜接口返回了非 JSON 响应（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    const detail = readRecord(payload).detail;
    throw new Error(typeof detail === 'string' ? detail : `分镜接口失败（HTTP ${response.status}）`);
  }
  // 回包是 `{ok:true, data:{…}}`，和 `postJson` 同一层壳。
  const data = readRecord(readRecord(payload).data);
  const episodes = (data.episodes as unknown[]).filter(
    (value): value is number => typeof value === 'number',
  );
  const beats = (data.beats as unknown[]).filter(isShot);
  const selected = data.selected;
  return {
    episode: typeof data.episode === 'number' ? data.episode : 0,
    episodes,
    beats,
    selected: typeof selected === 'number' ? selected : null,
    context: typeof data.context === 'string' ? data.context : '',
  };
}

function isShot(value: unknown): value is DirectorDeskStoryboardShot {
  const record = readRecord(value);
  return typeof record.beat_number === 'number';
}

/**
 * 把分镜上下文挂进 `run` 请求的 `context` 字段。
 *
 * **不改 prompt**：prompt 是用户原话，会原样落进共享对话历史，两个面板都会看到
 * 这段内部文本。`context` 是后端单独取的字段，只进这一轮的模型上下文。
 *
 * 没有分镜时原样返回 —— 上层已经准备好了一段可读的说明塞在那里，这里不重复。
 */
export function withStoryboardContext(
  payload: unknown,
  context: string | null | undefined,
): Record<string, unknown> {
  if (!context) return readRecord(payload);
  const record = readRecord(payload);
  if (record.context === context) return record;
  return { ...record, context };
}