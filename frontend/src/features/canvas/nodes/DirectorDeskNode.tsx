// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  Clapperboard,
  Download,
  Link2,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Sparkles,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { uploadFreezoneImage, uploadFreezoneVideo } from '@/api/ops';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  CANVAS_NODE_TYPES,
  type DirectorDeskNodeData,
} from '@/features/canvas/domain/canvasNodes';
import {
  dataUrlToBlob,
  loadImageElement,
  withImageCacheBust,
} from '@/features/canvas/application/imageData';
import { aspectRatioFromImageDimensions } from '@/features/canvas/application/imageNodeSizing';
import { useUpstreamNodes } from '@/features/canvas/application/useUpstreamGraph';
import { localizeNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import {
  NodeHeader,
  NODE_HEADER_FLOATING_POSITION_CLASS,
} from '@/features/canvas/ui/NodeHeader';
import {
  CANVAS_NODE_INPUT_SURFACE_CLASS,
  canvasNodeFrameClass,
} from '@/features/canvas/ui/nodeFrameStyles';
import {
  applyDirectorSceneIntent,
  type DeskProject,
  type DirectorSceneIntent,
} from './directorScenePatch';
import { useViewerImmersiveBody } from '@/features/viewer-kit/useViewerImmersiveBody';
import { EventBusContext } from '@/task-center/event-bus-context';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  createDirectorDeskBridge,
  DIRECTOR_DESK_PROTOCOL_VERSION,
  type DirectorDeskBridge,
  type DirectorDeskCapabilities,
  type DirectorDeskCapture,
  type DirectorDeskExportVideoResult,
  type DirectorDeskProjectSaveRequest,
  type DirectorDeskReadyInfo,
} from './directorDeskBridge';
import {
  DIRECTOR_DESK_PANORAMA_MAX_BYTES,
  DirectorDeskPanoramaError,
  directorDeskV2IframeSrc,
  getDirectorDeskV2Session,
  markDirectorDeskV2SessionReady,
  registerDirectorDeskV2Session,
  subscribeDirectorDeskAgentEvents,
  withStoryboardContext,
} from './directorDeskV2Session';
import type { DirectorDeskAiOp } from './directorDeskV2Session';
import { useDirectorStoryboard } from './useDirectorStoryboard';

type DirectorDeskNodeProps = NodeProps & {
  id: string;
  data: DirectorDeskNodeData;
  selected?: boolean;
};

// 紧凑壳：编辑器本身在全屏弹窗里的 iframe 中运行，节点只留一张封面 + 入口按钮，
// 尺寸因此按「缩略图 + 一行按钮」定，不跟着弹窗走。
export const DIRECTOR_DESK_NODE_WIDTH = 340;
export const DIRECTOR_DESK_NODE_HEIGHT = 210;

/**
 * 导演台冷启动要初始化 Three.js 引擎、模型索引与场景，实测要几秒。超过这个时间
 * 还没收到 ready 就按失败处理并给出重试入口，而不是让用户对着空白弹窗等。
 */
export const DIRECTOR_DESK_READY_TIMEOUT_MS = 30_000;

export type DirectorDeskConnectionState = 'idle' | 'connecting' | 'connected' | 'failed';

/**
 * iframe 地址：`node_id` 用画布 nodeId。子应用把它原样报回 `capabilities.get` 的回包，
 * 宿主据此确认自己跟对了窗口 —— 工程按节点隔离就落在这条链上。
 *
 * 同源子路径部署，因此**不带** `hostOrigin` —— 导演台在该参数缺失时回落到它自己的
 * origin，与宿主 origin 相同；显式传反而会在换端口调试时引入跨 origin 复杂度。
 *
 * 路径常量与 v2 会话登记见 [[directorDeskV2Session]]。
 */
export function directorDeskIframeSrc(nodeId: string): string {
  return directorDeskV2IframeSrc(nodeId);
}

/** 按导演台自己声明的 `actions` 判断某个受控接口能不能用，宿主不假设。 */
export function directorDeskSupports(
  capabilities: DirectorDeskCapabilities | null,
  action: string,
): boolean {
  return Boolean(capabilities?.actions?.includes(action));
}

/**
 * 回传截图的落库文件名。上游给的 `fileName` 是导演台那边的人类可读名（可能带中文、
 * 空格、`/`），直接当上传名会在后端路径里出问题，所以只保留扩展名、其余自己拼：
 * 节点 id + 序号 + 时间戳，天然不重名。
 */
export function directorDeskCaptureUploadName(
  nodeId: string,
  index: number,
  sourceFileName: string,
  stamp: number,
): string {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(sourceFileName.trim());
  const rawExtension = match?.[1]?.toLowerCase();
  const extension = rawExtension && /^[a-z0-9]+$/.test(rawExtension) ? rawExtension : 'png';
  return `director-desk-${nodeId}-capture-${index + 1}-${stamp}.${extension}`;
}

/** 导出产物的落库文件名（`poster` = 导出视频的首帧，用作节点封面）。 */
export function directorDeskArtifactUploadName(
  nodeId: string,
  kind: 'video' | 'poster',
  extension: string,
  stamp: number,
): string {
  const safeExtension = /^[a-z0-9]+$/.test(extension) ? extension : 'bin';
  return `director-desk-${nodeId}-${kind}-${stamp}.${safeExtension}`;
}

/** 缩略图落库文件名（`preview` = 画布节点封面那张场景缩略图）。 */
export function directorDeskPreviewUploadName(
  nodeId: string,
  stamp: number,
): string {
  return `director-desk-${nodeId}-preview-${stamp}.jpg`;
}

/**
 * 工程快照 JSON 的落库文件名。
 *
 * 走的是既有的 `/freezone/upload`（`uploadDirectorCaptureBundle` 也用它传 frame_meta.json），
 * 所以这里同样用 `director-desk-` 前缀，方便在 `_uploads/` 里一眼认出是本节点产物。
 */
export function directorDeskProjectUploadName(nodeId: string, stamp: number): string {
  return `director-desk-${nodeId}-project-${stamp}.json`;
}

/**
 * 导演台把整份工程存在同源 localStorage 的这个键下，`<instanceId>` 就是画布节点 id
 * （iframe `?instanceId=` 传的那个）。宿主与 `/director-desk/` iframe 同源，共享同一
 * localStorage，所以父窗口直接读写这个键即可注入场景/运镜；写完 reload iframe 生效。
 * 见 mem:director-desk-localstorage-inject。
 */
export const directorDeskStorageKey = (nodeId: string): string =>
  `storyai-3d-director-desk-demo:${nodeId}`;

/**
 * 把 agent 产出的场景 intent 应用到 localStorage 工程；返回是否真的写入。
 *
 * ## 只服务 MONOFORM 分支（**v2 主链路不再走这里**）
 *
 * 这是 MONOFORM 白模台时代的注入胶水：v1 的工程存在同源 localStorage 的
 * `storyai-3d-director-desk-demo:<nodeId>` 键下，父窗口直接改写再 reload iframe。
 * v2 换了存储（IndexedDB + 上游自己的导入入口），且接口语义从「整体覆盖」变成
 * 「施加增量操作」——继续用它会做两件错事：写一个没人读的键，以及抹掉用户手摆的东西。
 * 保留不删：既有 MONOFORM 节点里已存的工程还要能打开（单向不可逆迁移），
 * 且 `DirectorSceneCard` 的撤销快照与本函数成对使用。
 */
export function applyDirectorSceneToStorage(
  nodeId: string,
  intent: DirectorSceneIntent,
  storage: Pick<Storage, 'getItem' | 'setItem'>,
): boolean {
  const raw = storage.getItem(directorDeskStorageKey(nodeId));
  if (!raw) return false; // 导演台还没为这个节点建过工程（没打开过），无从注入
  let state: { project?: DeskProject } & Record<string, unknown>;
  try {
    state = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!state.project) return false;
  state.project = applyDirectorSceneIntent(state.project, intent);
  storage.setItem(directorDeskStorageKey(nodeId), JSON.stringify(state));
  return true;
}

/**
 * 后端那条路由用的任务 scope：`director_desk_panorama:<node_id>:<job_id>`。
 *
 * 前端靠它认出「这条任务是不是这个节点的」。**失败时尤其重要** —— 失败的任务
 * 没有产物 URL 可供认领，只能靠 scope；否则用户得自己去任务中心翻才知道背景
 * 生成失败了（实测踩过：网关 CPU 保护拒单，界面上一点反馈都没有）。
 */
export function directorDeskTaskScopePrefix(nodeId: string): string {
  return `director_desk_panorama:${nodeId}:`;
}

export function directorDeskTaskBelongsTo(
  task: { scope?: string | null } | null | undefined,
  nodeId: string,
): boolean {
  return typeof task?.scope === 'string'
    && task.scope.startsWith(directorDeskTaskScopePrefix(nodeId));
}

/**
 * 从一条任务里取出「属于这个导演台节点」的 AI 生成全景图 URL。
 *
 * 按**产物路径里的 node_id** 认领，而不是按任务 key/scope：产物目录是
 * `director_desk_panorama/<node_id>/...`（后端那条路由按 node_id 分目录），所以
 * 这条判断天然是「只作用于当前节点」—— 别的节点的生成结果不会被这里认领，
 * 这个节点的结果也不会被别的节点抢走。
 */
export function directorDeskPanoUrlFromTask(
  task: { task_type?: string | null; result?: unknown } | null | undefined,
  nodeId: string,
): string | null {
  if (!task || task.task_type !== 'scene_pano_generation') return null;
  const marker = `/director_desk_panorama/${nodeId}/`;
  const seen = new WeakSet<object>();
  const walk = (value: unknown): string | null => {
    if (typeof value === 'string') {
      const [path] = value.split('?');
      return value.includes(marker) && /\.(png|jpe?g|webp)$/i.test(path) ? value : null;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);
    for (const item of Object.values(value as Record<string, unknown>)) {
      const hit = walk(item);
      if (hit) return hit;
    }
    return null;
  };
  return walk(task.result);
}

/**
 * 工程快照的体积上限。超限就跳过上传：留一个指向超大 JSON 的引用没有意义，
 * 反而会把项目资产目录撑起来。当前工程 JSON 实测在几十 KB 量级，5MB 是安全余量。
 */
export const DIRECTOR_DESK_SNAPSHOT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 关闭时的存档最多等这么久，超时照常关窗（存档是尽力而为，不能把弹窗卡死）。
 *
 * 5s 而不是更长：桥是同源的本地消息，`project.get` 正常在毫秒级（实测 424KB 工程也是
 * 一瞬间）。这个值只是防御「导演台卡死 / 不回话」—— 那种情况下用户不该被一个关不掉的
 * 弹窗困住，几秒已经是能忍的上限。
 */
/** 工程与封面需要完成两次上传，关闭时给足等待时间，超时保留编辑器。 */
export const DIRECTOR_DESK_SAVE_TIMEOUT_MS = 60_000;

/** 工程已存好但封面失败，不能把它误报成工程或 AI 改动没有落盘。 */
class DirectorDeskPreviewSyncError extends Error {}

/**
 * 缩略图的最长边（像素）。
 *
 * 节点封面那格只有 ~200px 见方，960 是给高 DPI 与放大看留的余量；再大就只是让
 * 画布存档里的 base64 前的 JPEG 更胖。上游 `capturePreview` 还会自己降采样。
 */
export const DIRECTOR_DESK_PREVIEW_SIZE = 640;

/** 节点上显示的「agent 正在做什么」。只存够画一行字的东西，不留事件原文。 */
export type DirectorDeskNodeActivity = {
  kind: 'thinking' | 'text' | 'tool';
  /** 仅 ``kind === 'tool'``：上游工具名，如 ``director_apply``。 */
  name?: string;
  /** 仅 ``kind === 'tool'``：这一调用是否还在跑。 */
  running?: boolean;
  at: number;
};

/** 存档引用里的时间戳（文件名形如 `…-project-<ms>.json`），取不到返回 null。 */
export function directorDeskSnapshotSavedAt(projectRef: unknown): number | null {
  if (typeof projectRef !== 'string') return null;
  const match = /-project-(\d{10,})\.json/.exec(projectRef);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

const VIDEO_EXTENSION = /\.(mp4|webm|mov|m4v|avi|mkv)(\?|$)/i;

/**
 * 只读取连入的 360° 全景查看器，不根据普通图片的文件名或链接推定球面投影。
 * 全景节点也要按字段与扩展名排除视频和非图片数据，避免把视频海报当作场景环境。
 */
export function directorDeskPanoramaSource(
  upstreamNodes: ReadonlyArray<{ id: string; type: string; data: unknown }>,
): { sourceNodeId: string; imageUrl: string; fileName: string; displayName: string } | null {
  for (const node of upstreamNodes) {
    // 只有明确的 360° 查看器才自动铺全景，普通图片留给识图共创，避免重开时改写预演。
    if (node.type !== CANVAS_NODE_TYPES.pano360Viewer) continue;
    const data = (node.data ?? {}) as Record<string, unknown>;
    const videoUrl = typeof data.videoUrl === 'string' ? data.videoUrl.trim() : '';
    const candidates = [data.imageUrl, data.previewImageUrl];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const imageUrl = candidate.trim();
      if (!imageUrl) continue;
      if (imageUrl.startsWith('data:') && !imageUrl.startsWith('data:image/')) continue;
      if (VIDEO_EXTENSION.test(imageUrl)) continue;
      // 同一节点上图片与视频并存时（视频海报）也不是全景图素材。
      if (videoUrl && imageUrl === videoUrl) continue;
      const displayName = typeof data.displayName === 'string' ? data.displayName.trim() : '';
      return {
        sourceNodeId: node.id,
        imageUrl,
        fileName: `${displayName || 'panorama'}.png`,
        displayName: displayName || node.id,
      };
    }
  }
  return null;
}

/** 从 `project.get` 的返回里取一段可读的摘要，取不到就返回 null。 */
export function summarizeDirectorDeskProject(
  project: unknown,
): { fingerprint: string; objects: number; cameras: number } | null {
  if (typeof project !== 'object' || project === null) return null;
  const value = project as Record<string, unknown>;
  const fingerprint = typeof value.projectFingerprint === 'string' ? value.projectFingerprint : '';
  const inner = value.project;
  if (typeof inner !== 'object' || inner === null) return null;
  const scene = inner as Record<string, unknown>;
  const count = (candidate: unknown) => (Array.isArray(candidate) ? candidate.length : 0);
  return {
    fingerprint: fingerprint || '—',
    objects: count(scene.objects),
    cameras: count(scene.cameras),
  };
}

/** 节点卡片上的场景概况。字段少而都是**导演台自己报的数**，不猜。 */
export type DirectorDeskSceneStatus = {
  /** 场景里的实体总数（角色 + 道具 + 机位 …）。 */
  entities: number;
  /** 摄影机数量。单独列是因为「摆机位」是这个节点的主要工作。 */
  cameras: number;
  /** 读到的那一刻。 */
  at: number;
};

/**
 * 从 `director_read` 的回包里读出场景概况。
 *
 * 读 `tool.call` 的回包而不是 `project.get`：前者是 v2 的工具面（子应用用
 * `toolService` 跑，有 `revision` 守卫），后者是 v1 的接口，v2 的 `actions` 里根本没有。
 * 形状不对一律返回 null —— 宁可节点上少显示一个数，也不要显示一个编出来的数。
 */
export function readDirectorDeskSceneStatus(
  payload: unknown,
): DirectorDeskSceneStatus | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const envelope = payload as Record<string, unknown>;
  const result = (
    typeof envelope.result === 'object' && envelope.result !== null
      ? envelope.result
      : envelope
  ) as Record<string, unknown>;
  const entities = Array.isArray(result.entities) ? result.entities : null;
  if (!entities) return null;
  const cameras = entities.filter(
    (entity) => (entity as { kind?: unknown }).kind === 'camera',
  ).length;
  return { entities: entities.length, cameras, at: Date.now() };
}

/**
 * 上传后的项目内 URL → 画布节点字段里该存的值。带上 `?v=` 破缓存，否则用户在同一
 * 会话里重新导出、后端同名覆盖时，画布上看到的还是旧图。
 */
export function directorDeskAssetUrl(url: string, stamp: number): string {
  const clean = url.split('?')[0];
  return clean ? withImageCacheBust(clean, stamp) : '';
}

/**
 * 全景链路失败的本地化文案。
 *
 * 上游抛的是中文裸串（`service.ts` 的 `idle()` 与 `checkRevision`），en/vi 用户不该看到
 * 它们。这里按 [[DirectorDeskPanoramaError]] 的分类选文案，只有兜底分支才带上原始原因。
 */
export function directorDeskPanoramaErrorText(
  error: unknown,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (!(error instanceof DirectorDeskPanoramaError)) {
    return t('node.directorDesk.panoramaFailed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  switch (error.reason) {
    case 'unreachable':
      return t('node.directorDesk.panoramaDeskClosed');
    case 'unsupported-media':
      return t('node.directorDesk.panoramaUnsupportedMedia');
    case 'too-large':
      return t('node.directorDesk.panoramaTooLarge', {
        limit: Math.round(DIRECTOR_DESK_PANORAMA_MAX_BYTES / (1024 * 1024)),
      });
    case 'busy':
      return t('node.directorDesk.panoramaDeskBusy');
    case 'unreachable-tool':
      return t('node.directorDesk.panoramaDeskClosed');
    default:
      return t('node.directorDesk.panoramaFailed', { message: error.message });
  }
}

/** 图片尺寸 → 比例字符串；量不出来时返回 null，交给节点自己回落到默认比例。 */
async function measureCaptureAspectRatio(dataUrl: string): Promise<string | null> {
  try {
    const image = await loadImageElement(dataUrl);
    return aspectRatioFromImageDimensions(image.naturalWidth, image.naturalHeight);
  } catch {
    return null;
  }
}

export const DirectorDeskNode = memo(({ id, data, selected }: DirectorDeskNodeProps) => {
  const { t } = useTranslation();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addDerivedUploadNode = useCanvasStore((state) => state.addDerivedUploadNode);
  // 导演台 AI 面板的「去设置页管理渠道」按钮最终落在这里。
  const openSettingsDialog = useSettingsStore((state) => state.openSettings);
  // 一跳上游（按连线顺序、浅比较订阅）。导演台是「画布上的一个工作台」，上游接进来的
  // 360° 图片进入场景环境；普通图片由分镜来源送给模型，确认后再由模型制作预演。
  const upstreamNodes = useUpstreamNodes(id);
  const panoramaSource = useMemo(
    () => directorDeskPanoramaSource(upstreamNodes),
    [upstreamNodes],
  );
  const isOpen = data.isOpen === true;
  const bridgeRef = useRef<ReturnType<typeof createDirectorDeskBridge> | null>(null);
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 卸载后不再 setState / 不再往画布上落产物。
  const mountedRef = useRef(true);
  const capturesBusyRef = useRef(false);
  const exportBusyRef = useRef(false);

  const [connection, setConnection] = useState<DirectorDeskConnectionState>('idle');
  const [capabilities, setCapabilities] = useState<DirectorDeskCapabilities | null>(null);
  const [projectReadout, setProjectReadout] = useState<string | null>(null);
  const [isReadingProject, setIsReadingProject] = useState(false);
  const [isImportingCaptures, setIsImportingCaptures] = useState(false);
  const [isExportingVideo, setIsExportingVideo] = useState(false);
  const [isSavingProject, setIsSavingProject] = useState(false);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [snapshotNotice, setSnapshotNotice] = useState<string | null>(null);
  /**
   * AI 背景的状态：正在生成 / 最近一次落地的时间。
   *
   * 这条反馈以前是缺的 —— 用户点完「换背景」，agent 说一句「已开始生成」，然后
   * **1-2 分钟毫无动静**（实测 360 全景要 100 秒上下），成功时唯一的信号是 3D 画面
   * 自己变了，很容易被当成没生效、或者被当成还在转。失败那条原来也只走 toast，
   * 而那个 toast 还被 task-center 的 sawRunning 门槛拦死过，等于全程失声。
   */
  const [aiBackgroundBusy, setAiBackgroundBusy] = useState(false);
  const [aiBackgroundAt, setAiBackgroundAt] = useState<number | null>(null);
  // AI 摆场景 / 生成运镜落地的时刻（工具栏胶囊反馈用）。
  // 已经送进导演台的那张全景图（来源节点 + 地址）。用它避免每次重开都把用户在导演台
  // 里自己换的背景覆盖掉；只有上游真的换图时才重发。
  const sentPanoramaRef = useRef<string | null>(null);
  /**
   * 全景链路的反馈。**必须有**：v2 的全景要走三步工具调用，素材太大、格式不对、
   * 导演台正在忙这三种情况都会真失败 —— 界面毫无反应的话用户只会以为功能坏了。
   * `panoramaAppliedAt` 让成功也看得见（跟 AI 背景那条胶囊一个路数）。
   */
  const [panoramaNotice, setPanoramaNotice] = useState<string | null>(null);
  const [panoramaAppliedAt, setPanoramaAppliedAt] = useState<number | null>(null);
  // 每次「重试」都换一个 key，强制 iframe 重新挂载重新握手。
  const [attempt, setAttempt] = useState(0);
  /**
   * 统一循环改过场景之后，节点上要立刻看得见 —— 并且工程要落盘。
   *
   * 这是主人说的「感觉像各自独立」里最扎手的一处：iframe 面板里一句「改一下机位」，
   * 画布节点上什么都没发生（`directorProjectRef` 指向的还是改动前的存档），关窗时的
   * 静默存档是唯一兜底，而用户在界面上分辨不出「没改」和「改了但没记」。
   *
   * 两个状态分开：胶囊立刻亮（反馈），落盘延后（一次任务可能几十个 apply，逐个上传
   * 会把项目资产堆成垃圾）。落盘失败**不弹 toast** —— 用户没要求保存，替他报错只会
   * 打断正在进行的对话；关窗时那次显式存档仍然会兜住。
   */
  const [aiSceneAt, setAiSceneAt] = useState<number | null>(null);
  /**
   * agent 正在做什么。与 iframe 面板收到的是**同一批事件**（同一个
   * `subscribeDirectorDeskAgentEvents`），只是这里画到节点上，让人一眼看出「我点的
   * 就是这个框」。
   */
  const [aiActivity, setAiActivity] = useState<DirectorDeskNodeActivity | null>(
    null,
  );
  /**
   * 场景概况（几个实体、几个机位）与节点封面缩略图。
   *
   * 主人报「哪里体现节点变化」时，节点上只有一句静态文案、一个「打开」按钮，
   * 0 张图 —— 导演台里发生的一切在画布上不留任何痕迹。这两个状态是补上那条痕迹：
   * 缩略图是**当前取景**（子应用从自己的渲染画布截，宿主上传成项目资产），
   * 概况是子应用自己 `director_read` 报出来的实体数。
   *
   * 都只在弹窗开着时刷新，且带去重（缩略图内容相同不重传，概况同数量不重写节点）——
   * 画布上挂着一堆导演台节点时，刷新一次不该把每个节点都标成「已修改」。
   */
  const [sceneStatus, setSceneStatus] = useState<DirectorDeskSceneStatus | null>(null);
  /** 保存和封面更新串行结算，关闭 iframe 前必须等到真实回执。 */
  const projectSaveTaskRef = useRef<Promise<void> | null>(null);
  const sceneSyncTaskRef = useRef<Promise<void> | null>(null);
  const projectPreviewErrorRef = useRef<DirectorDeskPreviewSyncError | null>(null);
  const previewTaskRef = useRef<Promise<void> | null>(null);
  const lastPreviewRef = useRef<string>('');
  const sceneSaveTimerRef = useRef<number | null>(null);
  /** 存档失败过一次。只有「曾经失败过」才需要在下次成功时清掉红字，
   *  否则每次成功都写一次节点数据，纯属浪费。 */
  const saveErrorRef = useRef(false);

  // 沉浸式独占键盘：弹窗打开期间画布的全局快捷键（Delete / Tab / M / 空格平移 …）
  // 必须让位，否则用户在导演台里按 WASD 会串到画布上。
  useViewerImmersiveBody(isOpen);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clearReadyTimer = useCallback(() => {
    if (readyTimerRef.current !== null) {
      clearTimeout(readyTimerRef.current);
      readyTimerRef.current = null;
    }
  }, []);

  /**
   * 节点是从存档画布挂载出来的话，`data.isOpen` 可能是上次会话留下的 true ——
   * 那是**内存态**（见 DirectorDeskNodeData 注释），不能让它在新会话里自动拉起
   * 一个 3D 引擎。挂载时归零一次。
   *
   * 这段逻辑只该在「换画布 / 刷新后从存档恢复」时生效。它曾经会在用户弹窗开着时
   * 被误触发：低缩放档下组件被 LOD 换成壳 = 卸载，之后重挂载又看到 isOpen 为 true，
   * 于是把用户正用着的弹窗关掉。现在由 LodShell 的 `holdsOpenOverlay` 保证
   * 「弹窗打开期间不降级」，这条链路就断了。
   */
  useEffect(() => {
    if (data.isOpen) {
      updateNodeData(id, { isOpen: false });
    }
    // 只在挂载时跑一次：之后 isOpen 的变化都是用户操作产生的。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /**
   * 工程快照回灌（v2）。
   *
   * v1 没有 `project.set`，宿主只能发 `session` 让导演台激活它自己那份 localStorage。
   * v2 换了存储：工程存在子应用的 IndexedDB 里，宿主拿不到也不该复述它的结构。所以
   * 回灌走 `project.load` —— 宿主把节点 `directorProjectRef` 指向的 `.director` 文档
   * 原文推过去，子应用与文件入口共用导入流程，由上游负责校验、
   * 模型预热与场景上下文切换。
   *
   * 快照取不到（404/网络错误）时只提示、不阻断 —— 用户还能继续用导演台的本地存档。
   */
  const restoreProjectSnapshot = useCallback(
    async (bridge: DirectorDeskBridge) => {
      const ref = typeof data.directorProjectRef === 'string' ? data.directorProjectRef : '';
      if (!ref) return;
      try {
        const response = await fetch(ref, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`snapshot http ${response.status}`);
        const snapshot: unknown = await response.json();
        if (typeof snapshot !== 'object' || snapshot === null) {
          throw new Error('snapshot is not an object');
        }
        await bridge.loadProject(JSON.stringify(snapshot));
        if (mountedRef.current) setSnapshotNotice(null);
      } catch {
        // 降级：不抛、不拦。用户还能继续用导演台（本地存档），只是提示他快照没了。
        if (mountedRef.current) {
          setSnapshotNotice(t('node.directorDesk.snapshotUnavailable'));
        }
      }
    },
    [data.directorProjectRef, t],
  );

  /**
   * 把上游接进来的图片接成导演台里的全景背景。
   *
   * **不是发一条 panorama 帧** —— v2 子应用的消息表只有 ready/request/response
   * （`vendor/director-desk/src/host-bridge.ts:32-38`），那条帧在 v2 没有任何接收方。
   * 真正生效的是会话上的三步工具链路，见 [[setDirectorDeskPanoramaBackground]]：
   * 导入媒体 → 建 `visual-panorama` 内向球 → 给它加一层 unlit surface layer。
   *
   * 单独成一个 effect（而不是塞进 ready 回调）是为了让「上游换图」也生效 —— 用户在画布上
   * 换一张图、或者接上第一张图时，导演台里必须跟着变，否则连好的线是死的，这就是割裂感的
   * 来源。用 `sentPanoramaRef` 记住「已经送过哪一对（来源节点 + 地址）」：
   *   - 同一张图重开弹窗 → 不重发，避免覆盖用户在导演台里自己换过的背景；
   *   - 换了图 / 换了来源 → 重发。
   *
   * 失败一律说出来：全景链路有三处会真失败（素材太大、格式不支持、导演台正在忙），
   * 静默失败等于让用户对着没变的画面猜。
   */
  const applyPanorama = useCallback(
    async (imageUrl: string, fileName: string): Promise<boolean> => {
      const session = getDirectorDeskV2Session(id);
      if (!session) {
        setPanoramaNotice(t('node.directorDesk.panoramaDeskClosed'));
        return false;
      }
      setPanoramaNotice(null);
      try {
        await session.setPanoramaBackground({ imageUrl, fileName });
        if (mountedRef.current) setPanoramaAppliedAt(Date.now());
        return true;
      } catch (error) {
        if (mountedRef.current) setPanoramaNotice(directorDeskPanoramaErrorText(error, t));
        return false;
      }
    },
    [id, t],
  );

  useEffect(() => {
    if (connection !== 'connected') return;
    if (!panoramaSource) return;
    const key = `${panoramaSource.sourceNodeId}|${panoramaSource.imageUrl}`;
    if (sentPanoramaRef.current === key) return;
    sentPanoramaRef.current = key;
    void applyPanorama(panoramaSource.imageUrl, panoramaSource.fileName);
  }, [applyPanorama, connection, id, panoramaSource]);

  const handleReady = useCallback((info: DirectorDeskReadyInfo = {}) => {
    clearReadyTimer();
    const bridge = bridgeRef.current;
    if (!bridge) return;
    // 子应用自报的 node_id 必须就是这个节点的。origin + contentWindow 只能证明「是我们
    // 开的那扇 iframe」，证明不了「它以为自己是哪个节点」——而工程落盘是按 node_id
    // 写进画布的，写错节点就是静默的数据损坏。子应用没报这个字段时不拦（向前兼容）。
    if (info.nodeId && info.nodeId !== id) {
      setConnection('failed');
      setCapabilities(null);
      updateNodeData(id, {
        errorMessage: `director desk node mismatch: expected ${id}, got ${info.nodeId}`,
      });
      return;
    }
    markDirectorDeskV2SessionReady(id);
    // 能力必须问出来再用：导演台的 `actions` 才是可用接口的唯一事实来源。
    void bridge
      .getCapabilities()
      .then((next) => {
        if (!mountedRef.current) return;
        setCapabilities(next);
        updateNodeData(id, { errorMessage: null });
      })
      .catch((error: unknown) => {
        // 握手成功但能力查询失败：不把节点判成连不上（编辑器其实可用），
        // 只是所有受控按钮都按「不可用」处理。
        if (!mountedRef.current) return;
        setCapabilities(null);
        updateNodeData(id, {
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });
    // 工程载入后再抓封面，避免把初始化场景覆盖到节点的最新缩略图上。
    void restoreProjectSnapshot(bridge).finally(() => {
      if (mountedRef.current) setConnection('connected');
    });
  }, [clearReadyTimer, id, restoreProjectSnapshot, updateNodeData]);

  /**
   * 关闭前的工程落盘（v2）。走子应用**自己的**保存流程：宿主发
   * `tool.call {director_export, kind:'project'}`，子应用转手 `toolService`，后者最终
   * 调 `window.directorDesktop.files('save-project', {name, content})`；宿主桥把它翻成
   * 子 → 宿主的 `project.save`，真正的上传与节点字段写入在 `handleProjectSave` 里。
   *
   * 宿主**不**在这里自己序列化工程：v2 的工程结构由上游定义，宿主复述一遍就是第二份
   * 会漂移的实现。节点 data 里只留引用（`directorProjectRef`），绝不存工程 JSON 本身。
   */
  const persistProjectSnapshot = useCallback((): Promise<void> => {
    if (projectSaveTaskRef.current) return projectSaveTaskRef.current;
    const bridge = bridgeRef.current;
    if (!bridge || !bridge.isReady()) return Promise.resolve();
    const task = (async () => {
      if (!readUrl().project) throw new Error(t('node.directorDesk.noProject'));
      await bridge.saveProject();
    })().finally(() => { projectSaveTaskRef.current = null; });
    projectSaveTaskRef.current = task;
    return task;
  }, [t]);

  /**
   * 抓一张当前取景，存进节点封面。
   *
   * 走 `preview.capture`（v2 桥的新动作）：子应用从自己的渲染画布
   * `toDataURL` 出一张降过采样的 JPEG，宿主上传成**项目资产**后只把 URL 写进节点
   * —— 与截图回传、工程存档同一条落库路径，绝不把 base64 塞进画布 data（那是几 MB）。
   *
   * 普通刷新失败时保留上一张并提示；保存触发的强制刷新必须把失败传回调用方，
   * 避免把旧封面当成已经同步的结果，然后卸载编辑器。
   */
  const refreshScenePreview = useCallback(async (force = false): Promise<void> => {
    const previous = previewTaskRef.current;
    if (previous && !force) return previous;
    const bridge = bridgeRef.current;
    if (!bridge || !bridge.isReady()) return;
    const projectId = readUrl().project;
    if (!projectId) return;
    const task = (async () => { try {
      // 强制刷新排在旧帧上传后面，防止旧请求晚返回，把新封面覆盖掉。
      await previous?.catch(() => undefined);
      const stamp = Date.now();
      const frame = await bridge.capturePreview({ size: DIRECTOR_DESK_PREVIEW_SIZE });
      // 同一帧不重传：agent 连着 apply 时每一帧都可能一样，逐张上传会在项目资产里
      // 堆出一串肉眼无法区分的封面。
      // 相同长度的 JPEG 也可能是完全不同的画面，必须比较内容。
      const fingerprint = frame.dataUrl;
      if (fingerprint === lastPreviewRef.current) return;
      const uploaded = await uploadFreezoneImage(
        projectId,
        dataUrlToBlob(frame.dataUrl),
        directorDeskPreviewUploadName(id, stamp),
        { timeoutMs: false },
      );
      const assetUrl = directorDeskAssetUrl(uploaded.url, stamp);
      if (!assetUrl || !mountedRef.current) return;
      lastPreviewRef.current = fingerprint;
      updateNodeData(id, { previewImageUrl: assetUrl });
    } catch (error) {
      // 关闭或重新握手后，旧桥的在途刷新已经失效，不给新窗口留错误提示。
      if (!mountedRef.current || bridgeRef.current !== bridge) return;
      console.warn('[director-desk] 节点封面同步失败', error);
      if (mountedRef.current) setArtifactError(t('node.directorDesk.previewSyncFailed'));
      if (force) throw new DirectorDeskPreviewSyncError(t('node.directorDesk.previewSyncFailed'));
    } })();
    previewTaskRef.current = task;
    try {
      await task;
    } finally {
      if (previewTaskRef.current === task) previewTaskRef.current = null;
    }
  }, [id, t, updateNodeData]);

  /**
   * 读一次场景概况（实体数 / 机位数）。
   *
   * 只在数字真的变了时才 `setState`：agent 的读工具会返回同一份 entities，逐次
   * setState 会让挂着的每个导演台节点不停重渲染。
   */
  const refreshSceneStatus = useCallback(async () => {
    const session = getDirectorDeskV2Session(id);
    if (!session || !session.isReady()) return;
    try {
      const payload = await session.callTool('director_read', { sections: ['entities'] });
      const status = readDirectorDeskSceneStatus(payload);
      if (!status || !mountedRef.current) return;
      setSceneStatus((previous) =>
        previous && previous.entities === status.entities && previous.cameras === status.cameras
          ? previous
          : status,
      );
    } catch {
      // 读不到就是读不到，不在节点上编一个数出来。
    }
  }, [id]);

  /** 工程上传、场景概况、最新取景一起结算，返回画布时才有完整结果。 */
  const persistAndSyncScene = useCallback((): Promise<void> => {
    if (sceneSyncTaskRef.current) return sceneSyncTaskRef.current;
    const task = (async () => {
      // project.save 回执已经等过封面上传，不能在这里再抓一张，也不能嵌套读工具。
      await persistProjectSnapshot();
      await refreshSceneStatus();
      if (projectPreviewErrorRef.current) throw projectPreviewErrorRef.current;
      if (mountedRef.current && saveErrorRef.current) {
        saveErrorRef.current = false;
        updateNodeData(id, { errorMessage: null });
      }
    })().finally(() => { sceneSyncTaskRef.current = null; });
    sceneSyncTaskRef.current = task;
    return task;
  }, [id, persistProjectSnapshot, refreshSceneStatus, updateNodeData]);

  /**
   * 弹窗一连上就取一次封面与场景概况。
   *
   * 封面延到 `connection === 'connected'` 之后：ready 之前子应用还没有渲染画布，
   * `preview.capture` 只会拿到一句「渲染画布尚未就绪」。这一下也让「刚打开导演台
   * 但什么都没改」的节点也有封面 —— 否则用户看到的仍是一张空卡片。
   *
   * **概况要再延后一点。** 它走的是 `tool.call{director_read}`，而 ready 之后的
   * 第一个 `tool.call` 有既定归属（工程存档、全景导入都在等它）：插在前面会让
   * 「宿主发出去的第一条工具调用是什么」变得不确定。2s 静默期与场景存档用的
   * 那个是同一段 —— 那段时间里子应用已经建好场景、模型也还没开始改东西。
   */
  useEffect(() => {
    if (connection !== 'connected') return undefined;
    void refreshScenePreview();
    const timer = window.setTimeout(() => void refreshSceneStatus(), 2000);
    return () => window.clearTimeout(timer);
  }, [connection, refreshScenePreview, refreshSceneStatus]);

  /**
   * 统一循环改了场景 → 画布上看得见，并且工程跟着落盘。
   *
   * 订阅的是**与 iframe 面板同一批**事件（[[subscribeDirectorDeskAgentEvents]] 收到的是
   * 后端 `ai_host.py` 那一个循环发出的），所以不管这句话是从画布侧面板还是从 iframe
   * 面板说的，这里都会响应 —— 这正是「同一个助手」在节点这一侧的表现。
   *
   * 只认 `director_apply` 的成功收据：那是唯一会改工程的工具，其余都是读。
   */
  useEffect(() => {
    // 节点初次挂载时可能还没有 iframe 会话；握手完成后重新订阅，才能收到实际提交。
    const scheduleSceneSave = () => {
      if (sceneSaveTimerRef.current !== null) clearTimeout(sceneSaveTimerRef.current);
      // 延后落盘而不是立即：一次任务可能连续 apply 十几次，逐次上传会在项目资产里
      // 堆出一串几乎一样的存档。静默期取 2s —— 够覆盖模型连着几轮工具调用。
      sceneSaveTimerRef.current = window.setTimeout(() => {
        sceneSaveTimerRef.current = null;
        // 存档失败**必须显形**。这里原来写的是 `.catch(() => undefined)`，后果是
        // AI 改了几十轮、节点上看起来一切正常，关掉页面却什么都没留下，而且
        // 日志里一条线索都没有 —— 现场实测就是这样：无静默就无从定位。
        void persistAndSyncScene()
          .then(() => {
            if (mountedRef.current && saveErrorRef.current) {
              saveErrorRef.current = false;
              updateNodeData(id, { errorMessage: null });
            }
          })
          .catch((error: unknown) => {
            saveErrorRef.current = true;
            const detail = error instanceof Error ? error.message : String(error);
            const message = error instanceof DirectorDeskPreviewSyncError
              ? error.message
              : t('node.directorDesk.saveFailed', { detail });
            console.error('[director-desk] 工程或封面同步未完成', detail);
            if (mountedRef.current) {
              updateNodeData(id, {
                errorMessage: message,
              });
            }
          });
      }, 2000);
    };
    const unsubscribe = subscribeDirectorDeskAgentEvents(id, (event) => {
      const type = typeof event.type === 'string' ? event.type : '';
      // 节点上显示「agent 正在做什么」—— 这一条不是新加的状态通道，而是把面板本来
      // 就收到的那批事件也画到节点上。主人说的「导演台和画布节点像是独立的东西」，
      // 有一半来自「节点是哑的」：面板里明明在跑，节点上却毫无动静。
      if (type === 'start') setAiActivity({ kind: 'thinking', at: Date.now() });
      else if (type === 'tool') {
        const status = typeof event.status === 'string' ? event.status : '';
        const name = typeof event.name === 'string' ? event.name : '';
        setAiActivity(name ? { kind: 'tool', name, running: status === 'running', at: Date.now() } : null);
      } else if (type === 'text') setAiActivity({ kind: 'text', at: Date.now() });
      else if (type === 'done' || type === 'error') setAiActivity(null);
      if (type !== 'tool' || event.name !== 'director_apply' || event.status !== 'completed') return;
      const summary = event.summary as { preview?: boolean; committed?: boolean; summary?: { hasChanges?: boolean } } | undefined;
      if (summary?.preview === true || summary?.committed === false || summary?.summary?.hasChanges === false) return;
      if (mountedRef.current) setAiSceneAt(Date.now());
      scheduleSceneSave();
    });
    return () => {
      unsubscribe();
      if (sceneSaveTimerRef.current !== null) clearTimeout(sceneSaveTimerRef.current);
    };
  }, [connection, isOpen, id, persistAndSyncScene, t, updateNodeData]);

  /**
   * 子应用请宿主落盘（`project.save`）。
   *
   * 两条分支：
   *   * `project` —— 上传成项目资产，引用写回节点 data（「保存相对节点」的落点）。
   *   * `export` —— 导出产物（批量交付面板）。本切片没有产物入库位，触发浏览器下载，
   *     并如实告诉子应用「只是下载」。
   */
  const handleProjectSave = useCallback(
    async (request: DirectorDeskProjectSaveRequest) => {
      const projectId = readUrl().project;
      if (request.kind === 'export') {
        if (!request.bytes || !projectId) {
          throw new Error(t('node.directorDesk.noProject'));
        }
        const blob = new Blob([request.bytes], {
          type: request.mimeType || 'application/octet-stream',
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = request.name;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        return { saved: true, filename: request.name };
      }
      const content = request.content ?? '';
      if (content.length > DIRECTOR_DESK_SNAPSHOT_MAX_BYTES) {
        throw new Error(t('node.directorDesk.snapshotTooLarge'));
      }
      if (!projectId) throw new Error(t('node.directorDesk.noProject'));
      const stamp = Date.now();
      const uploaded = await uploadFreezoneImage(
        projectId,
        new Blob([content], { type: 'application/json' }),
        directorDeskProjectUploadName(id, stamp),
        { timeoutMs: false },
      );
      const ref = directorDeskAssetUrl(uploaded.url, stamp);
      if (!ref) throw new Error(t('node.directorDesk.uploadFailed', { message: 'no url' }));
      if (mountedRef.current) updateNodeData(id, { directorProjectRef: ref });
      // 子应用自己的「保存」按钮也走这里。只等不经过工具队列的封面请求，
      // 否则嵌套 director_read 会等外层保存工具，形成循环等待。
      projectPreviewErrorRef.current = null;
      try {
        await refreshScenePreview(true);
        setArtifactError(previous => previous === t('node.directorDesk.previewSyncFailed') ? null : previous);
      } catch (error) {
        projectPreviewErrorRef.current = error instanceof DirectorDeskPreviewSyncError
          ? error : new DirectorDeskPreviewSyncError(t('node.directorDesk.previewSyncFailed'));
      }
      // 文件确实已保存；封面失败是单独的同步结果，宿主关闭流程会明确保留窗口。
      return { saved: true, previewSynced: !projectPreviewErrorRef.current, url: ref, filename: request.name };
    },
    [id, refreshScenePreview, t, updateNodeData],
  );

  /**
   * 显式「保存工程」：用户看得见、点得动的那一个。
   *
   * 关窗时的静默存档仍然保留（兜底），但只靠它用户根本不知道自己存了没有 ——
   * 顶部一个只读的「工程已存档」标签不足以让人放心。这里有按钮、有进度、有结果，
   * 存完标签会带上存档时间。
   */
  const saveProjectNow = useCallback(() => {
    const bridge = bridgeRef.current;
    if (!bridge || !bridge.isReady() || isSavingProject) return;
    setIsSavingProject(true);
    setArtifactError(null);
    void persistAndSyncScene()
      .then(() => {
        if (!mountedRef.current) return;
        toast.success(t('node.directorDesk.projectSaved'));
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        const message = error instanceof DirectorDeskPreviewSyncError ? error.message : t('node.directorDesk.projectSaveFailed', {
          message: error instanceof Error ? error.message : String(error),
        });
        setArtifactError(message);
        toast.error(message);
      })
      .finally(() => {
        if (mountedRef.current) setIsSavingProject(false);
      });
  }, [isSavingProject, persistAndSyncScene, t]);

  /**
   * 关窗：先把工程存档，再卸载 iframe。
   *
   * 顺序不能反 —— 桥随 iframe 一起销毁，卸载后就再也问不到工程了。
   * 工程和封面都结算成功才关闭；失败或超时保留窗口与内存状态，允许重试。
   */
  const closeDesk = useCallback(() => {
    if (isSavingProject) return;
    const bridge = bridgeRef.current;
    const shouldSave = Boolean(bridge?.isReady());
    if (!shouldSave) {
      updateNodeData(id, { isOpen: false });
      return;
    }
    setIsSavingProject(true);
    setArtifactError(null);
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), DIRECTOR_DESK_SAVE_TIMEOUT_MS);
    });
    let saved = false;
    void Promise.race([persistAndSyncScene(), timeout])
      .then((outcome) => {
        if (!mountedRef.current) return;
        if (outcome === 'timeout') {
          const message = t('node.directorDesk.projectSaveTimeout');
          setArtifactError(message);
          toast.error(message);
        } else {
          saved = true;
          toast.success(t('node.directorDesk.projectSaved'));
        }
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        const message = error instanceof DirectorDeskPreviewSyncError ? error.message : t('node.directorDesk.projectSaveFailed', {
          message: error instanceof Error ? error.message : String(error),
        });
        setArtifactError(message);
        toast.error(message);
      })
      .finally(() => {
        clearTimeout(timer);
        if (!mountedRef.current) return;
        setIsSavingProject(false);
        // 保存失败或尚未完成时保留编辑器，用户可以重试，避免把内存改动一起关掉。
        if (saved) updateNodeData(id, { isOpen: false });
      });
  }, [id, isSavingProject, persistAndSyncScene, t, updateNodeData]);

  const handleDeskClose = useCallback(() => {
    closeDesk();
  }, [closeDesk]);

  /**
   * 截图回传：base64 → Blob → 项目作用域上传 → 每张落成一个**派生上传节点**。
   *
   * 两条硬规矩：
   *   1. 绝不把 dataUrl 本身写进画布 data（画布 JSON 会直接膨胀几 MB），只存上传后的 URL；
   *   2. 先上传成功再建节点 —— 反过来会在失败时留下一个 `imageUrl` 为空/为 base64 的
   *      半成品节点。已建出来的节点都是完整可用的，不必回滚。
   */
  const importCaptures = useCallback(
    async (captures: DirectorDeskCapture[]) => {
      if (capturesBusyRef.current) return;
      const projectId = readUrl().project;
      if (!projectId) {
        setArtifactError(t('node.directorDesk.noProject'));
        return;
      }
      capturesBusyRef.current = true;
      setIsImportingCaptures(true);
      setArtifactError(null);
      const stamp = Date.now();
      try {
        let firstUrl: string | null = null;
        for (const [index, capture] of captures.entries()) {
          const blob = dataUrlToBlob(capture.dataUrl);
          const uploaded = await uploadFreezoneImage(
            projectId,
            blob,
            directorDeskCaptureUploadName(id, index, capture.fileName, stamp),
            { timeoutMs: false },
          );
          const assetUrl = directorDeskAssetUrl(uploaded.url, stamp);
          if (!assetUrl) throw new Error(t('node.directorDesk.uploadFailed', { message: 'no url' }));
          const aspectRatio = await measureCaptureAspectRatio(capture.dataUrl);
          addDerivedUploadNode(id, assetUrl, aspectRatio ?? '', assetUrl);
          firstUrl = firstUrl ?? assetUrl;
        }
        if (!mountedRef.current) return;
        // 封面 = 最近一次产物。用户截图回传后节点小图必须立刻跟着变，否则画布上
        // 看不出「我刚刚做了什么」——这正是之前 only-if-empty 规则造成的问题。
        if (firstUrl) {
          updateNodeData(id, { previewImageUrl: firstUrl });
        }
        updateNodeData(id, { errorMessage: null });
        toast.success(t('node.directorDesk.captureImported', { count: captures.length }));
      } catch (error) {
        if (!mountedRef.current) return;
        setArtifactError(
          t('node.directorDesk.uploadFailed', {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        capturesBusyRef.current = false;
        if (mountedRef.current) setIsImportingCaptures(false);
      }
    },
    [addDerivedUploadNode, id, t, updateNodeData],
  );

  const handleCaptures = useCallback(
    (captures: DirectorDeskCapture[]) => {
      void importCaptures(captures);
    },
    [importCaptures],
  );

  /**
   * 导出参考视频：`export.video` 拿 MP4 Blob（协议不会自动下载，宿主自己处置），
   * 再补一次 `export.frame(position: first)` 取首帧当封面 —— `previewImageUrl` 是喂给
   * 图片元素用的，直接塞视频地址渲染不出来。
   * 两者都上传成**项目内**资产后才回写节点字段。
   */
  // capabilities 是渲染态，用 ref 让 exportVideo 读到最新一份，而不是建回调那一份。
  const capabilitiesRef = useRef<DirectorDeskCapabilities | null>(null);
  capabilitiesRef.current = capabilities;

  const exportVideo = useCallback(async () => {
    if (exportBusyRef.current) return;
    const bridge = bridgeRef.current;
    if (!bridge) return;
    const projectId = readUrl().project;
    if (!projectId) {
      setArtifactError(t('node.directorDesk.noProject'));
      return;
    }
    exportBusyRef.current = true;
    setIsExportingVideo(true);
    setArtifactError(null);
    const stamp = Date.now();
    try {
      const result = await bridge.exportVideo({ fps: 30, quality: '720p' });
      const blob: unknown = (result as DirectorDeskExportVideoResult | undefined)?.blob;
      if (!(blob instanceof Blob)) {
        throw new Error(t('node.directorDesk.exportFailed', { message: 'no blob' }));
      }
      const uploaded = await uploadFreezoneVideo(
        projectId,
        blob,
        directorDeskArtifactUploadName(id, 'video', 'mp4', stamp),
      );
      const videoUrl = directorDeskAssetUrl(uploaded.url, stamp);
      if (!videoUrl) throw new Error(t('node.directorDesk.exportFailed', { message: 'no url' }));

      // 封面是加分项：拿不到首帧也要把视频写回去，否则用户白等一次导出。
      let previewImageUrl: string | null = null;
      if (directorDeskSupports(capabilitiesRef.current, 'export.frame')) {
        try {
          const frame = (await bridge.request('export.frame', {
            position: 'first',
            quality: '720p',
          })) as { dataUrl?: string } | undefined;
          if (typeof frame?.dataUrl === 'string' && frame.dataUrl.startsWith('data:')) {
            const poster = await uploadFreezoneImage(
              projectId,
              dataUrlToBlob(frame.dataUrl),
              directorDeskArtifactUploadName(id, 'poster', 'png', stamp),
              { timeoutMs: false },
            );
            previewImageUrl = directorDeskAssetUrl(poster.url, stamp) || null;
          }
        } catch {
          previewImageUrl = null;
        }
      }

      if (!mountedRef.current) {
        // 弹窗在导出途中被关掉：产物已经落在项目里，但不往画布上写。
        return;
      }
      updateNodeData(id, {
        videoUrl,
        ...(previewImageUrl ? { previewImageUrl } : {}),
        errorMessage: null,
      });
      toast.success(t('node.directorDesk.videoExported'));
    } catch (error) {
      if (!mountedRef.current) return;
      setArtifactError(
        t('node.directorDesk.exportFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      exportBusyRef.current = false;
      if (mountedRef.current) setIsExportingVideo(false);
    }
  }, [id, t, updateNodeData]);

  // 回调走 ref 取最新闭包，桥只建一次，不随渲染重建监听。
  const handlersRef = useRef({ handleReady, handleDeskClose, handleCaptures, handleProjectSave });
  handlersRef.current = { handleReady, handleDeskClose, handleCaptures, handleProjectSave };

  const storyboardState = useDirectorStoryboard(id, data, upstreamNodes, updateNodeData, t);
  const storyboardBridgeRef = useRef(storyboardState);
  storyboardBridgeRef.current = storyboardState;
  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!isOpen || connection !== 'connected' || !bridge || !directorDeskSupports(capabilities, 'storyboard.updated')) return;
    // 来源变动和异步加载结束主动通知面板，避免它停在启动时拿到的旧快照。
    void bridge.request('storyboard.updated', { ...storyboardState.get() }).catch(() => undefined);
  }, [isOpen, connection, capabilities, storyboardState.version, storyboardState.sourceOptionsKey, storyboardState.get]);

  // 桥必须在 iframe 的文档开始执行之前就位，否则首帧 ready 会丢。
  //
  // 用**回调 ref** 而不是 useLayoutEffect + 普通 ref：Dialog 的内容是 portal 且比
  // 外层晚一个 commit 才挂上，layout effect 跑的时候 iframe 还没进 DOM（实测
  // iframeRef.current === null），桥就再也不会建了 —— 节点会永远停在「正在连接」。
  // 回调 ref 在元素真正插入 DOM 的那一刻同步执行，与是第几个 commit 无关；React 19
  // 的 ref cleanup 负责在元素卸载（关弹窗、点重试换 key）时收尾。
  const attachIframe = useCallback(
    (iframe: HTMLIFrameElement | null) => {
      if (!iframe) return undefined;
      const bridge = createDirectorDeskBridge({
        iframe,
        onReady: (info) => handlersRef.current.handleReady(info),
        onClose: () => handlersRef.current.handleDeskClose(),
        onCaptures: (captures) => handlersRef.current.handleCaptures(captures),
        onProjectSave: (request) => handlersRef.current.handleProjectSave(request),
        // AI 面板动作由节点会话转给 Python 后端。会话表是按 nodeId 存的，所以这里
        // 在桥创建之后立刻能取到；取不到说明桥已被换掉，交给请求方报错。
        onAgentRequest: async (op, payload) => {
          const session = getDirectorDeskV2Session(id);
          if (!session) throw new Error('导演台会话尚未就绪');
          // 「按第 N 场戏摆」要成立，AI 必须先知道第 N 场戏是什么。宿主是唯一同时
          // 知道「当前项目」和「用户正在看哪条分镜」的地方，所以在这里把分镜上下文
          // 挂进 run 的 `context` —— **不改 prompt**：那是用户原话，会原样落进共享
          // 对话历史，两个面板都会看到这段内部文本。
          if (op === 'run') {
            const storyboardInput = await storyboardBridgeRef.current.inputForRun();
            return session.requestAgent(
              op as DirectorDeskAiOp,
              withStoryboardContext(payload, storyboardInput.context, storyboardInput.images),
            );
          }
          return session.requestAgent(op as DirectorDeskAiOp, payload);
        },
        // 分镜选择搬进 AI 面板后，面板自己不再有取数通道 —— 它向宿主要。
        // 两个回调都走 ref：桥只在建桥那一刻创建，闭包会停在当时。
        onStoryboardGet: () => storyboardBridgeRef.current.get(),
        onStoryboardSelect: ({ episode, beat }) => storyboardBridgeRef.current.select(episode, beat),
        onStoryboardSource: (sourceId) => storyboardBridgeRef.current.selectSource(sourceId),
        // 导演台 AI 面板只留渠道选择器与极简新建；完整渠道管理跳 DramaClaw 设置页。
        // 走 settingsStore 而不是事件总线：设置弹窗本来就由 header 渲染，store 是
        // 它已有的跨组件通道，再开一条只能多一处真相。
        onOpenHostSettings: () => {
          openSettingsDialog();
        },
      });
      bridgeRef.current = bridge;
      const unregisterSession = registerDirectorDeskV2Session(id, { bridge });

      clearReadyTimer();
      readyTimerRef.current = setTimeout(() => {
        if (bridge.isReady()) return;
        setConnection('failed');
      }, DIRECTOR_DESK_READY_TIMEOUT_MS);

      return () => {
        clearReadyTimer();
        unregisterSession();
        bridge.dispose();
        if (bridgeRef.current === bridge) bridgeRef.current = null;
      };
    },
    [clearReadyTimer, id, openSettingsDialog],
  );

  /**
   * AI 生成的背景回灌。
   *
   * 「描述 → 全景图」是一条后端任务（`scene_pano_generation` / `pano_from_text`），
   * 完成事件从任务总线来，这里按**产物路径里的本节点 id** 认领，
   * 只把属于这个节点的结果推给导演台当背景 —— 这就是产品边界
   * 「修改生成只作用于当前节点」的执行点。
   *
   * 用 `useContext(EventBusContext)` 而不是 `useEventBus()`：后者在没有
   * `TaskCenterProvider` 时会**抛**，而画布节点在测试里是脱离 provider 渲染的
   * （和 `useParams` 同一类坑）。这里没总线就安静地不订阅。
   */
  const taskBus = useContext(EventBusContext);
  useEffect(() => {
    if (!taskBus) return undefined;
    return taskBus.on('*', (event) => {
      // 进行中：按钮点下去到产物落地之间有一两分钟空窗，这段时间必须看得见。
      // 按 scope 认领（产物 URL 那时还不存在）。
      if (event.type === 'task_updated' && directorDeskTaskBelongsTo(event.task, id)) {
        const status = String((event.task as { status?: string } | null)?.status ?? '');
        setAiBackgroundBusy(status !== 'completed' && status !== 'failed');
        return;
      }
      if (event.type === 'task_complete') {
        const url = directorDeskPanoUrlFromTask(event.task, id);
        if (!url) return;
        setAiBackgroundBusy(false);
        // 全景真正落进场景要等三步工具调用跑完，所以「已更新」的时刻由链路自己报，
        // 不在这里提前宣布 —— 提前宣布就是又一次「看起来成功、实际没生效」。
        void applyPanorama(url, t('node.directorDesk.assistantBackgroundName')).then((applied) => {
          if (applied && mountedRef.current) setAiBackgroundAt(Date.now());
        });
        return;
      }
      // 失败必须说出来。失败的任务没有产物 URL，只能靠 scope 认领；不提示的话
      // 用户点了「生成背景」之后界面上一点反馈都没有，得自己去任务中心翻。
      if (event.type === 'task_failed' && directorDeskTaskBelongsTo(event.task, id)) {
        setAiBackgroundBusy(false);
        toast.error(
          t('node.directorDesk.assistantGenerateFailed', {
            message: event.task.error || t('node.directorDesk.connectFailed'),
          }),
        );
      }
    });
  }, [applyPanorama, taskBus, id, t]);

  // 弹窗关闭即卸载 iframe：3D 引擎不常驻，也不在后台空转。进行中的上传不会被取消
  // （产物已经落在项目里），但卸载后既不 setState 也不往画布上写节点。
  useEffect(() => {
    if (!isOpen) {
      setConnection('idle');
      setCapabilities(null);
      setProjectReadout(null);
      setIsReadingProject(false);
      setArtifactError(null);
    }
  }, [isOpen]);

  useEffect(() => {
    setConnection(isOpen ? 'connecting' : 'idle');
  }, [isOpen, attempt]);

  const openDesk = useCallback(() => {
    updateNodeData(id, { isOpen: true, errorMessage: null });
  }, [id, updateNodeData]);

  /*
   * 这里原来有一个 `handleDirectorScene`（画布侧把 dd-scene intent 翻译成
   * `director_apply`）。**随侧栏一起移除了**：它唯一的调用点是那个侧栏，而那条侧栏
   * 与 iframe 内的 AI 面板同时存在、抢同一份对话（主人报「还是有两个 AI 助手」）。
   *
   * 场景落地没有因此少一条路：iframe 面板里的 agent 直接调 `director_apply`，
   * 走的就是后端那**一个**循环。节点侧照旧通过
   * `subscribeDirectorDeskAgentEvents` 收 `director_apply` 的收据并刷新节点
   * （见下面的 `scheduleSceneSave`），所以「画布上看得出变化」这一条仍然成立。
   *
   * MONOFORM 白模台那条通道（[[applyDirectorSceneToStorage]] → localStorage 整体覆盖）
   * 保留在 {@link DirectorDeskChatPanel} 的 `monoform` 分支里，未删除；那条面板仍由
   * [[MonoformDeskNode]] 挂着。
   */

  const readProject = useCallback(() => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    setIsReadingProject(true);
    bridge
      .getProject()
      .then((project) => {
        if (!mountedRef.current) return;
        const summary = summarizeDirectorDeskProject(project);
        setProjectReadout(
          summary
            ? t('node.directorDesk.projectReadout', {
                fingerprint: summary.fingerprint,
                objects: summary.objects,
                cameras: summary.cameras,
              })
            : null,
        );
      })
      .catch(() => {
        if (mountedRef.current) setProjectReadout(null);
      })
      .finally(() => {
        if (mountedRef.current) setIsReadingProject(false);
      });
  }, [t]);

  const title = localizeNodeDisplayName(CANVAS_NODE_TYPES.directorDesk, data, t);
  const previewUrl =
    typeof data.previewImageUrl === 'string' && data.previewImageUrl.length > 0
      ? data.previewImageUrl
      : null;

  // 封面资产可能已经不在项目里了（用户清过资产、或换了部署）——此时浏览器会画一个
  // 破图方块。加载失败就回落到空态，而不是留一个坏掉的图位。
  const [previewFailed, setPreviewFailed] = useState(false);
  useEffect(() => {
    setPreviewFailed(false);
  }, [previewUrl]);
  const showPreview = previewUrl !== null && !previewFailed;

  const canReadProject = directorDeskSupports(capabilities, 'project.get');
  const canExportVideo = directorDeskSupports(capabilities, 'export.video');
  const artifactBusy = isImportingCaptures || isExportingVideo;
  const savedAt = directorDeskSnapshotSavedAt(data.directorProjectRef);
  const upstreamHasText = useMemo(
    () =>
      upstreamNodes.some(
        (node) => node.type === CANVAS_NODE_TYPES.textAnnotation,
      ),
    [upstreamNodes],
  );
  // 让「上游接了什么」在弹窗里看得见 —— 接了线却毫无反应是最容易让人以为坏掉的地方。
  const upstreamMediaSummary = useMemo(() => {
    if (panoramaSource) {
      return t('node.directorDesk.upstreamPanorama', { name: panoramaSource.displayName });
    }
    const storyboard = storyboardState.get();
    const selectedShot = storyboard.shots.find(shot => shot.beat_number === storyboard.selected);
    if (selectedShot?.reference_image_url) {
      return t('node.directorDesk.upstreamImage', { name: storyboard.sourceLabel });
    }
    if (upstreamHasText) return t('node.directorDesk.upstreamText');
    return null;
  }, [panoramaSource, storyboardState.get, storyboardState.version, upstreamHasText, t]);

  return (
    <div
      className="group relative h-full w-full overflow-visible"
      style={{ width: DIRECTOR_DESK_NODE_WIDTH, height: DIRECTOR_DESK_NODE_HEIGHT }}
      onClick={() => setSelectedNode(id)}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="target"
        className="!h-2 !w-2 !border-0 !bg-[rgb(148,163,184)]"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="source"
        className="!h-2 !w-2 !border-0 !bg-[rgb(148,163,184)]"
      />

      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Clapperboard className="h-4 w-4" />}
        titleText={title}
      />

      <div
        className={`relative flex h-full w-full flex-col overflow-hidden rounded-[var(--node-radius)] border ${CANVAS_NODE_INPUT_SURFACE_CLASS} transition-colors ${canvasNodeFrameClass({ selected })}`}
      >
        <div className="relative flex-1 overflow-hidden bg-white/[0.04]">
          {showPreview ? (
            <img
              src={previewUrl ?? undefined}
              alt={t('node.directorDesk.previewAlt')}
              draggable={false}
              onError={() => setPreviewFailed(true)}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center">
              <Clapperboard className="h-7 w-7 text-cyan-200/70" />
              <span className="text-[12px] leading-5 text-text-muted/90">
                {t('node.directorDesk.emptyHint')}
              </span>
            </div>
          )}
        </div>

        {/*
          节点卡上的状态条。主人报「哪里体现节点变化」时这里只有一个「打开」按钮 ——
          导演台里摆了什么、agent 在不在跑、工程存没存，画布上一个字都看不到。

          三段都是**导演台自己报的**：实体数来自 `director_read`，存档时间来自
          ``directorProjectRef`` 的文件名时间戳，agent 状态来自与 iframe 面板同一批
          事件。没有任何一段是宿主猜的 —— 猜出来的那段比空着更坏。
        */}
        <div className="flex min-h-[22px] items-center gap-1.5 border-t border-white/[0.06] px-2 py-1 text-[11px] leading-4 text-white/60">
          {sceneStatus ? (
            <span title={t('node.directorDesk.sceneStatusHint')}>
              {t('node.directorDesk.sceneStatus', {
                entities: sceneStatus.entities,
                cameras: sceneStatus.cameras,
              })}
            </span>
          ) : (
            <span>{t(savedAt === null ? 'node.directorDesk.sceneStatusUnknown' : 'node.directorDesk.sceneStatusSaved')}</span>
          )}
          {savedAt !== null && (
            <span className="rounded-full bg-cyan-300/[0.12] px-1.5 text-[11px] text-cyan-200/90">
              {t('node.directorDesk.projectArchivedShort')}
            </span>
          )}
          {aiActivity && (
            <span className="flex items-center gap-1 text-[11px] text-sky-200/90">
              <Loader2 className="size-2.5 animate-spin" />
              {aiActivity.kind === 'tool' && aiActivity.name
                ? t('node.directorDesk.assistantActivityShort', { name: aiActivity.name })
                : t('node.directorDesk.assistantBusyShort')}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-white/[0.06] px-2 py-1.5">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              openDesk();
            }}
            className="flex items-center gap-1.5 rounded-md bg-cyan-300/[0.14] px-2.5 py-1 text-[12px] leading-5 text-cyan-100 transition-colors hover:bg-cyan-300/[0.22]"
          >
            <Play className="size-3.5" />
            {t('node.directorDesk.open')}
          </button>
          {typeof data.videoUrl === 'string' && data.videoUrl.length > 0 && (
            <span className="text-[12px] leading-5 text-white/45">
              {t('node.directorDesk.hasVideo')}
            </span>
          )}
          <span
            role="status"
            className="ml-auto flex items-center gap-1 text-[11px] leading-4 text-white/40"
          >
            {aiSceneAt !== null && t('node.directorDesk.sceneAppliedShort')}
          </span>
        </div>
      </div>

      {isOpen && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) closeDesk();
          }}
        >
          <DialogContent
            className="inset-0 left-0 top-0 h-dvh w-dvw max-w-none translate-x-0 translate-y-0 overflow-hidden rounded-none border-0 p-0 ring-0 data-open:zoom-in-100 data-closed:zoom-out-100 sm:max-w-none"
            overlayClassName="bg-black/55 supports-backdrop-filter:backdrop-blur-none"
            showCloseButton={false}
          >
            <DialogHeader className="sr-only">
              <DialogTitle>{t('node.directorDesk.dialogTitle')}</DialogTitle>
              <DialogDescription>{t('node.directorDesk.dialogDescription')}</DialogDescription>
            </DialogHeader>

            {/*
              `min-h-0` 不能省：这一层是 DialogContent（grid）的 grid item，而它自己
              又是 flex column 容器 —— 它的 `min-height: auto` 会解析成**内容的最小
              高度**，于是它拒绝收缩成 `h-dvh` 那一屏，整棵树跟着长到 4717px（实测
              视口 881px），把侧栏连同最下面的输入框一起顶出视口外。用户看到的就是
              「对话记录一堆，输入框没了」。
            */}
            <div className="flex h-full min-h-0 w-full flex-col bg-[#090909]">
              <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.08] px-3 py-2">
                <span className="flex items-center gap-2 text-[12px] leading-5 text-white/80">
                  {connection === 'connecting' && (
                    <Loader2 className="size-3.5 animate-spin text-cyan-200" />
                  )}
                  <Clapperboard className="hidden size-3.5 text-cyan-200/80" />
                  {connection === 'connecting' && t('node.directorDesk.connecting')}
                  {connection === 'connected' &&
                    t('node.directorDesk.connected', {
                      version: capabilities?.protocolVersion ?? DIRECTOR_DESK_PROTOCOL_VERSION,
                    })}
                  {connection === 'failed' && (
                    <span className="text-amber-300">{t('node.directorDesk.connectFailed')}</span>
                  )}
                  {connection === 'idle' && t('node.directorDesk.dialogTitle')}
                </span>

                {capabilities && (
                  <span className="text-[12px] leading-5 text-white/50">
                    {t('node.directorDesk.capabilityCount', {
                      count: capabilities.actions.length,
                    })}
                  </span>
                )}
                {capabilities?.assetPersistence === 'browser-local-references' && (
                  <span className="rounded-full bg-amber-300/[0.12] px-2 py-0.5 text-[12px] leading-5 text-amber-200/90">
                    {t('node.directorDesk.persistenceLocal')}
                  </span>
                )}

                {/*
                  受控按钮一律按导演台自己声明的 actions 渲染 —— 不硬编码假设。
                  导演台升级后新增的能力自动出现，撤掉的能力自动消失。
                */}
                {canReadProject && (
                  <button
                    type="button"
                    onClick={readProject}
                    disabled={isReadingProject}
                    className="flex items-center gap-1.5 rounded-md bg-white/[0.08] px-2.5 py-1 text-[12px] leading-5 text-white/85 transition-colors hover:bg-white/[0.14] disabled:opacity-50"
                  >
                    {isReadingProject ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                    {isReadingProject
                      ? t('node.directorDesk.reading')
                      : t('node.directorDesk.readProject')}
                  </button>
                )}
                {canExportVideo && (
                  <button
                    type="button"
                    // busy 保护：导出含录制 + 两次上传，重复点击会并发触发多次落库。
                    disabled={artifactBusy || connection !== 'connected'}
                    onClick={() => {
                      void exportVideo();
                    }}
                    className="flex items-center gap-1.5 rounded-md bg-cyan-300/[0.14] px-2.5 py-1 text-[12px] leading-5 text-cyan-100 transition-colors hover:bg-cyan-300/[0.22] disabled:opacity-50"
                  >
                    {isExportingVideo ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Download className="size-3.5" />
                    )}
                    {isExportingVideo
                      ? t('node.directorDesk.exportingVideo')
                      : t('node.directorDesk.exportVideo')}
                  </button>
                )}
                <button
                  type="button"
                  // 显式保存：用户点得动、看得见结果。关窗时的静默存档仍在（兜底），
                  // 但只靠它用户不知道自己存没存。
                  disabled={isSavingProject || connection !== 'connected'}
                  onClick={saveProjectNow}
                  className="flex items-center gap-1.5 rounded-md bg-white/[0.08] px-2.5 py-1 text-[12px] leading-5 text-white/85 transition-colors hover:bg-white/[0.14] disabled:opacity-50"
                >
                  {isSavingProject ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Save className="size-3.5" />
                  )}
                  {isSavingProject
                    ? t('node.directorDesk.savingProject')
                    : t('node.directorDesk.saveProject')}
                </button>
                {upstreamMediaSummary && (
                  <span
                    className="flex items-center gap-1.5 rounded-full bg-white/[0.06] px-2 py-0.5 text-[12px] leading-5 text-white/70"
                    title={t('node.directorDesk.upstreamHint')}
                  >
                    <Link2 className="size-3.5" />
                    {upstreamMediaSummary}
                  </span>
                )}
                {/* 全景是否真的进了导演台场景。没有这条的话，导入失败与成功长得一模一样。 */}
                {panoramaAppliedAt !== null && (
                  <span
                    role="status"
                    className="flex items-center gap-1.5 rounded-full bg-emerald-300/[0.12] px-2 py-0.5 text-[12px] leading-5 text-emerald-200/90"
                  >
                    <Link2 className="size-3.5" />
                    {t('node.directorDesk.panoramaApplied', {
                      time: new Date(panoramaAppliedAt).toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit',
                      }),
                    })}
                  </span>
                )}
                {panoramaNotice && (
                  <span role="alert" className="text-[12px] leading-5 text-amber-300">
                    {panoramaNotice}
                  </span>
                )}
                {isImportingCaptures && (
                  <span className="flex items-center gap-1.5 text-[12px] leading-5 text-white/70">
                    <Loader2 className="size-3.5 animate-spin" />
                    {t('node.directorDesk.importingCaptures')}
                  </span>
                )}
                {projectReadout && (
                  <span className="text-[12px] leading-5 text-white/45">{projectReadout}</span>
                )}
                {/*
                  分镜选择不在这里，而在导演台自己的 AI 面板里（`ai-chat` 视图，
                  紧邻渠道选择器）。这是用户的原话：「这分镜太占地方了，不应该放这里，
                  应该放 AI 对话，选择」—— 它占满整行宽度，还把「保存工程」「工程已存档」
                  挤到别处。

                  选分镜本来就是「这一轮用什么」的决定，与选渠道、选模式同一性质，所以
                  跟着对话去。数据层没有跟着搬走：`refreshStoryboard` 仍随弹窗开关读一次，
                  面板经 `storyboard.get` / `storyboard.select` 两条子→宿主动作取数与回写
                  （见 `attachIframe`）。AI 上下文注入也不变：`withStoryboardContext` 仍
                  只写 `context`，绝不混进 `prompt`。
                */}
                {savedAt !== null && (
                  <span className="rounded-full bg-cyan-300/[0.12] px-2 py-0.5 text-[12px] leading-5 text-cyan-200/90">
                    {t('node.directorDesk.projectArchivedAt', {
                      time: new Date(savedAt).toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit',
                      }),
                    })}
                  </span>
                )}
                {aiBackgroundBusy && (
                  <span
                    role="status"
                    className="flex items-center gap-1.5 rounded-full bg-cyan-300/[0.12] px-2 py-0.5 text-[12px] leading-5 text-cyan-200/90"
                  >
                    <Loader2 className="size-3.5 animate-spin" />
                    {t('node.directorDesk.assistantBackgroundGenerating')}
                  </span>
                )}
                {!aiBackgroundBusy && aiBackgroundAt !== null && (
                  <span className="flex items-center gap-1.5 rounded-full bg-emerald-300/[0.12] px-2 py-0.5 text-[12px] leading-5 text-emerald-200/90">
                    <Sparkles className="size-3.5" />
                    {t('node.directorDesk.assistantBackgroundApplied', {
                      time: new Date(aiBackgroundAt).toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit',
                      }),
                    })}
                  </span>
                )}
                {aiActivity && (
                  <span
                    role="status"
                    className="flex items-center gap-1.5 rounded-full bg-sky-300/[0.12] px-2 py-0.5 text-[12px] leading-5 text-sky-200/90"
                  >
                    {aiActivity.kind === 'tool' && aiActivity.running ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="size-3.5" />
                    )}
                    {aiActivity.kind === 'text'
                      ? t('node.directorDesk.assistantActivityText')
                      : aiActivity.kind === 'tool'
                        ? t('node.directorDesk.assistantActivityTool', {
                            name: aiActivity.name ?? '',
                          })
                        : t('node.directorDesk.assistantActivityThinking')}
                  </span>
                )}
                {aiSceneAt !== null && (
                  <span className="flex items-center gap-1.5 rounded-full bg-violet-300/[0.12] px-2 py-0.5 text-[12px] leading-5 text-violet-200/90">
                    <Sparkles className="size-3.5" />
                    {t('node.directorDesk.assistantSceneAppliedAt', {
                      time: new Date(aiSceneAt).toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit',
                      }),
                    })}
                  </span>
                )}
                {isSavingProject && (
                  <span className="flex items-center gap-1.5 text-[12px] leading-5 text-white/70">
                    <Loader2 className="size-3.5 animate-spin" />
                    {t('node.directorDesk.savingProject')}
                  </span>
                )}
                {snapshotNotice && (
                  <span role="status" className="text-[12px] leading-5 text-amber-200/85">
                    {snapshotNotice}
                  </span>
                )}
                {artifactError && (
                  <span role="alert" className="text-[12px] leading-5 text-amber-300">
                    {artifactError}
                  </span>
                )}

                {/*
                  **这里不再挂 AI 助手侧栏。**
                  它与 iframe 内的「AI」面板同时在，主人报的是「还是有两个 AI 助手」。
                  那个侧栏在 director 引擎下并不走 agent 循环：`DirectorDeskChatPanel`
                  的场景落地口是 `canApplyScene = engine === 'monoform'` 分支，
                  director 引擎下那条 `onDirectorScene` 是宿主自己拼操作的另一条路 ——
                  两个输入框抢同一份对话，用户看到的是两个助手各说各话。
                  导演台的对话只剩 iframe 里的「AI」面板一个入口，那才是真跑
                  `ai_host.py` 那一个循环的地方。

                  `DirectorDeskChatPanel` 组件本身**没删**：MONOFORM 白模台
                  （[[MonoformDeskNode]]）仍在用它，那边的「整体覆盖」场景落地语义
                  只存在于那个面板里。
                */}

                <button
                  type="button"
                  onClick={closeDesk}
                  disabled={isSavingProject}
                  aria-label={t('node.directorDesk.close')}
                  className="ml-auto flex items-center gap-1.5 rounded-md bg-white/[0.08] px-2.5 py-1 text-[12px] leading-5 text-white/85 transition-colors hover:bg-white/[0.14] disabled:opacity-50"
                >
                  <X className="size-3.5" />
                  {t('node.directorDesk.close')}
                </button>
              </div>

              <div className="relative flex min-h-0 flex-1">
                {/*
                  `min-w-0` 不能省：flex item 默认 `min-width: auto`，iframe 的
                  min-content 宽度会把这一行顶宽，窄屏上连侧栏一起溢出视口
                  （实测 390px 视口里 iframe 被撑到 495px、侧栏被顶到 420px）。
                */}
                <div className="relative min-h-0 min-w-0 flex-1">
                <iframe
                  key={attempt}
                  ref={attachIframe}
                  src={directorDeskIframeSrc(id)}
                  // 同源子路径部署，子应用直接用自己 origin 与宿主通信，不需要额外授权。
                  // pointer-lock 是掌镜模式（WASD + 鼠标锁定）必需的唯一一项；摄像头/
                  // 麦克风/定位都不用，所以不进白名单。
                  allow="pointer-lock"
                  title={t('node.directorDesk.iframeTitle')}
                  className="h-full w-full border-0 bg-[#090909]"
                />
                {connection === 'failed' && (
                  <div className="absolute inset-x-0 top-1/3 mx-auto flex w-[min(420px,80%)] flex-col items-center gap-3 rounded-xl border border-white/[0.08] bg-[#1c1c1e]/95 px-5 py-5 text-center">
                    <span className="text-[14px] leading-5 text-white/80">
                      {t('node.directorDesk.connectFailed')}
                    </span>
                    {typeof data.errorMessage === 'string' && data.errorMessage && (
                      <code className="max-w-full overflow-hidden text-ellipsis text-[12px] leading-5 text-amber-200/80">
                        {data.errorMessage}
                      </code>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setConnection('connecting');
                        setAttempt((value) => value + 1);
                      }}
                      className="flex items-center gap-1.5 rounded-md bg-cyan-300/[0.16] px-3 py-1.5 text-[12px] leading-5 text-cyan-100 transition-colors hover:bg-cyan-300/[0.24]"
                    >
                      <RefreshCw className="size-3.5" />
                      {t('node.directorDesk.retry')}
                    </button>
                  </div>
                )}
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
});

DirectorDeskNode.displayName = 'DirectorDeskNode';
