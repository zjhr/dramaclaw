// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// MONOFORM 白模预演节点。与 3D 导演台（DirectorDeskNode）并存：复用同一套
// postMessage 桥（directorDeskBridge）与对话面板（DirectorDeskChatPanel），
// 只把 iframe 指向 vendored 的 MONOFORM（/monoform-desk/，见其 UPSTREAM.md）。
//
// Phase 2 范围：节点能加进画布、能开、iframe 加载 MONOFORM 并握手、能开对话面板。
// 刻意**不做**（与 DirectorDeskNode 的区别，均因 MONOFORM 定位不同）：
//   - 360 全景导入 / AI 背景 / 截图回传（MONOFORM 无 360 概念）
//   - freezone 工程快照上传（MONOFORM 自己按 instanceId 存本地 localStorage）
//   - 场景 intent 注入（Phase 3 才接，届时重写 schema 映射 + 引入专属 chat kind）
//
// 白模导出（T006 曾判定 blocked，T010 解开）：MONOFORM bundle 现在在
// `capabilities.actions` 里声明 `export.video` / `export.frame`（见
// frontend/vendor/monoform/PATCHES.md §9），产物经 postMessage 回到宿主，因此这里
// 照 DirectorDeskNode.exportVideo 的结构接回了完整链路：
//   bridge.exportVideo → Blob → uploadFreezoneVideo（项目内资产）
//     → 首帧 export.frame + uploadFreezoneImage 当封面（拿不到也出片）
//     → addNode(video) 承载白模产物 + addEdge（显式来源边：白模节点 → 派生 video 节点）
//     → updateNodeData 写回 videoUrl / previewImageUrl
//
// 派生节点为什么是 **video** 而不是 upload（T017 修正，T011 曾建错）：upload 的
// `connectivity.targetHandle` 为 false，addEdge 一律回 null —— 建出来的节点永远是
// 画布上的一座孤岛，正式视频生成拿不到它。实测（jsdom 跑真 canvasStore）：
// addEdge(directorDesk, video) 返回真实 edge id，addEdge(directorDesk, upload) 返回
// null。方向固定为「白模节点是源、派生 video 节点是目标」—— 这根边是溯源边，
// 指向白模产物的归属节点。
//
// 能力判断仍然只看握手拿回来的 `capabilities.actions`。注意宿主侧的
// `MONOFORM_CAPABILITIES` 是「已发布的 vendored bundle」那一份构建期事实，也是
// 打包兜底：真实握手拿不到时按它渲染，**不把能力伪造成可用**，所以那条
// 「导出不可用」提示在能力确实缺失时照旧显示（见 `monoformSupportsExport`）。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Boxes, Download, Loader2, MessagesSquare, Play, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { uploadFreezoneImage, uploadFreezoneVideo } from '@/api/ops';
import {
  dataUrlToBlob,
} from '@/features/canvas/application/imageData';
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
import { DirectorDeskChatPanel } from './DirectorDeskChatPanel';
import {
  directorDeskArtifactUploadName,
  directorDeskAssetUrl,
  directorDeskSupports,
} from './DirectorDeskNode';
import type { DirectorSceneIntent } from './directorScenePatch';
import {
  applyMonoformSceneIntent,
  summarizeMonoformProject,
  type MonoformProject,
} from './monoformScenePatch';
import { useViewerImmersiveBody } from '@/features/viewer-kit/useViewerImmersiveBody';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';
import {
  createDirectorDeskBridge,
  DIRECTOR_DESK_PROTOCOL_VERSION,
  type DirectorDeskCapabilities,
  type DirectorDeskExportVideoResult,
} from './directorDeskBridge';

// 节点级硬替换：directorDesk 节点类型现在渲染 MONOFORM（见 monoform-desk/UPSTREAM.md）。
// 因此复用 directorDesk 的 data 形状（MONOFORM 只读 isOpen/previewImageUrl/errorMessage，
// 多出的 360 字段无害忽略），旧画布上的「3D 导演台」节点也能直接打开 MONOFORM。
type MonoformDeskNodeProps = NodeProps & {
  id: string;
  data: DirectorDeskNodeData;
  selected?: boolean;
};

// 紧凑壳：编辑器在全屏弹窗的 iframe 里运行，节点只留封面 + 入口按钮。
export const MONOFORM_DESK_NODE_WIDTH = 340;
export const MONOFORM_DESK_NODE_HEIGHT = 210;

// MONOFORM 冷启动要初始化 Three.js + 加载 X-Bot 白模（~3.7M glb），实测几秒。
export const MONOFORM_DESK_READY_TIMEOUT_MS = 30_000;

// 白模导出派生的 video 节点在画布上按 580×380 渲染（VideoNode 的默认宽高），这里只
// 用来给 `findNodePosition` 一个避让范围，免得派生节点压在上游节点身上。
const WHITEBOX_NODE_WIDTH = 580;
const WHITEBOX_NODE_HEIGHT = 380;

export type MonoformDeskConnectionState = 'idle' | 'connecting' | 'connected' | 'failed';

/** 白模导出用到的两个受控接口。宿主只认 `capabilities.actions` 里声明过的能力 ——
 * `DIRECTOR_DESK_ACTIONS` 是「协议取值域」（同一份白名单也服务 3D 导演台），
 * 白名单里有不等于这个 bundle 实现了它。
 */
export const MONOFORM_EXPORT_ACTIONS = ['export.video', 'export.frame'] as const;

export type MonoformExportAction = (typeof MONOFORM_EXPORT_ACTIONS)[number];

/** 不支持导出时面板要逐条讲清楚缺哪两个接口。 */
export const MONOFORM_UNAVAILABLE_EXPORT_ACTIONS: readonly MonoformExportAction[] = [
  ...MONOFORM_EXPORT_ACTIONS,
];

/**
 * 已发布的 vendored MONOFORM bundle 在 `capabilities.get` 里声明的事实
 * （frontend/vendor/monoform/src/App.jsx 的 `ACTIONS`，与 public/monoform-desk/ 下
 * 预编译 bundle 的回包一致）。两个用途：
 *
 *   1. **打包兜底**：弹窗没开、iframe 还没握手时按它渲染。这里放的是 bundle 的
 *      构建期事实（含 export.video / export.frame），所以未握手也会出现导出入口；
 *      真实能力取不到时它是唯一依据，**不把它当成「还不知道」而隐藏能力状态**。
 *   2. 能力边界文案的断言对象 —— 运行时判断永远只看握手拿回来的那一份。
 */
export const MONOFORM_CAPABILITIES: DirectorDeskCapabilities = {
  protocolVersion: DIRECTOR_DESK_PROTOCOL_VERSION,
  actions: ['capabilities.get', 'project.get', 'scene.apply', 'export.video', 'export.frame'],
};

/** 白模导出能力探测：bundle 自己声明的 actions 是唯一事实来源。 */
export function monoformSupportsExport(
  capabilities: DirectorDeskCapabilities | null,
  action: MonoformExportAction,
): boolean {
  return directorDeskSupports(capabilities, action);
}

/** 导出的白模视频落在项目资产里的文件名（`poster` = 首帧封面，与 3D 导演台同前缀）。 */
export const MONOFORM_ARTIFACT_NODE_PREFIX = 'monoform';

/** 同 `directorDeskArtifactUploadName`，只把节点前缀换成 monoform，便于在 `_uploads/` 区分来源。 */
export function monoformArtifactUploadName(
  nodeId: string,
  kind: 'video' | 'poster',
  extension: string,
  stamp: number,
): string {
  return directorDeskArtifactUploadName(`${MONOFORM_ARTIFACT_NODE_PREFIX}-${nodeId}`, kind, extension, stamp);
}

/**
 * 对话栏宽度：窄于 360 消息挤成一根条，宽于 640 白模台就没地方站了。
 * 持久化在 localStorage（面板宽度是个人偏好，不该跟着项目走）。
 *
 * ⚠️ 这两个是**用户意愿**的边界，不是最终宽度 —— 面板实际宽度还要服从白模台的下限：
 * MONOFORM 的响应式下限是 720px（见 vendor/monoform/PATCHES.md），窄于它文档会横向
 * 溢出、浮层被裁。所以面板宽度最终是 `clamp(360, 设定值, 视口 - 720)`，
 * 且视口放不下「720 + 360」时整体退回**覆盖模式**（不挤 iframe）。
 */
const CHAT_WIDTH_KEY = 'dramaclaw.monoformDesk.chatWidth';
const CHAT_WIDTH_MIN = 360;
const CHAT_WIDTH_MAX = 640;
const CHAT_WIDTH_DEFAULT = 440;
/** MONOFORM 能用的最小宽度，与它的 `body { min-width }` 补丁保持一致。 */
const MONOFORM_MIN_VIEWPORT = 720;

function readStoredChatWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem(CHAT_WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= CHAT_WIDTH_MIN && raw <= CHAT_WIDTH_MAX) return raw;
  } catch {
    // localStorage 不可用（隐私模式/沙箱）时退回默认宽度 —— 不该因此炸掉面板。
  }
  return CHAT_WIDTH_DEFAULT;
}

/**
 * 撤销快照：**只保留最近一次** apply 之前的工程。卡片上的「撤销」语义是
 * 「退回这次改动之前」，而卡片只对最近落画面的那条开放撤销，两者一致。
 * 存不下（配额/禁用）时静默降级 —— 少一个撤销入口，不影响摆场景。
 */
function undoSnapshotKey(nodeId: string): string {
  return `dramaclaw.monoformDesk.undo:${nodeId}`;
}

function saveUndoSnapshot(nodeId: string, project: unknown): void {
  try {
    window.localStorage.setItem(undoSnapshotKey(nodeId), JSON.stringify(project));
  } catch {
    // 配额满或存储被禁用：放弃快照，撤销按钮会提示没有可撤销的改动。
  }
}

function readUndoSnapshot(nodeId: string): Record<string, unknown> | null {
  try {
    const raw = window.localStorage.getItem(undoSnapshotKey(nodeId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function clearUndoSnapshot(nodeId: string): void {
  try {
    window.localStorage.removeItem(undoSnapshotKey(nodeId));
  } catch {
    // 同上：清理失败无害。
  }
}

/**
 * iframe 地址：`instanceId` 用画布 nodeId，MONOFORM 按它隔离 localStorage 工程
 * （键 `monoform-project:<instanceId>`，见其 UPSTREAM.md 的 instanceId 补丁），
 * 两个节点互不覆盖。同源子路径部署，不带 hostOrigin。MONOFORM 不读 theme 参数，
 * 故只传 instanceId。
 */
export function monoformDeskIframeSrc(nodeId: string): string {
  return `/monoform-desk/?instanceId=${encodeURIComponent(nodeId)}`;
}

export const MonoformDeskNode = memo(({ id, data, selected }: MonoformDeskNodeProps) => {
  const { t } = useTranslation();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const upstreamNodes = useUpstreamNodes(id);

  const isOpen = data.isOpen === true;
  const bridgeRef = useRef<ReturnType<typeof createDirectorDeskBridge> | null>(null);
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const [connection, setConnection] = useState<MonoformDeskConnectionState>('idle');
  const [capabilities, setCapabilities] = useState<DirectorDeskCapabilities | null>(null);
  // 每次「重试」换 key 强制 iframe 重挂重新握手。
  const [attempt, setAttempt] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  const [isExportingVideo, setIsExportingVideo] = useState(false);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  /**
   * 导出重入守卫。`isExportingVideo` 是渲染态（按钮禁用靠它），但状态更新是异步的：
   * 连点两次会在同一个 tick 里跑进两遍导出。与 DirectorDeskNode 用同样的 ref 守卫。
   */
  const exportBusyRef = useRef(false);
  /**
   * 给 agent 看的场景摘要：它每轮都得知道白模台**现在长什么样**，否则「再近一点」
   * 「把他挪左边」这类指代只能瞎猜、或者干脆重摆全场。握手成功与每次 apply/undo
   * 之后刷新（读工程失败时保留上一次的，不清空 —— 喂过期场景不如喂旧的）。
   */
  const [sceneSummary, setSceneSummary] = useState('');

  const refreshSceneSummary = useCallback(
    async (bridge: ReturnType<typeof createDirectorDeskBridge>) => {
      try {
        const project = (await bridge.getProject()) as MonoformProject;
        if (!mountedRef.current) return;
        setSceneSummary(summarizeMonoformProject(project));
      } catch {
        // 读工程失败（未就绪/超时）：保留上一次摘要。
      }
    },
    [],
  );
  const [chatWidth, setChatWidth] = useState(readStoredChatWidth);

  /**
   * 拖拽分隔条。面板贴在视口右边缘，所以**向左拖 = 变宽**（把 dx 取反）。
   * 用 pointer capture，鼠标拖到面板外也不会丢事件；落盘放在每次移动里
   * （localStorage 写入是微秒级），拖动结束的那次一定被记住。
   */
  const startChatResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const handle = event.currentTarget;
      const startX = event.clientX;
      const startWidth = chatWidth;
      handle.setPointerCapture(event.pointerId);
      const onMove = (moveEvent: PointerEvent) => {
        const next = Math.min(
          CHAT_WIDTH_MAX,
          Math.max(CHAT_WIDTH_MIN, Math.round(startWidth - (moveEvent.clientX - startX))),
        );
        setChatWidth(next);
        try {
          window.localStorage.setItem(CHAT_WIDTH_KEY, String(next));
        } catch {
          // 存不下就算了，本次会话仍然生效。
        }
      };
      const onUp = (upEvent: PointerEvent) => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        if (handle.hasPointerCapture(upEvent.pointerId)) {
          handle.releasePointerCapture(upEvent.pointerId);
        }
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    },
    [chatWidth],
  );

  /**
   * 对话是这个节点自己的一段（与项目助手页互不可见），scope.id 带项目 id 让 agent
   * 工具照常拿得到项目上下文。
   *
   * Phase 2 复用 `kind:'directorDesk'`：scope.id = `${project}/${nodeId}` 已按 nodeId
   * 隔离会话不串台，后端也已认这个 kind，零改动。Phase 3 接场景注入时再引入专属
   * `monoformDesk` kind（届时要动 superchat/types.ts + use-superchat + 后端白名单）。
   */
  const chatScope = useMemo(() => {
    const project = readUrl().project;
    return project
      ? { kind: 'directorDesk' as const, id: `${project}/${id}` }
      : undefined;
  }, [id]);

  // 沉浸式独占键盘：弹窗打开期间画布全局快捷键让位，否则在 MONOFORM 里按 WASD 会串到画布。
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
   * 从存档画布恢复时 `data.isOpen` 可能是上次会话留下的 true（仅内存态），挂载时归零
   * 一次，避免新会话自动拉起 3D 引擎。弹窗打开期间不降级由 LodShell 的 holdsOpenOverlay 保证。
   */
  useEffect(() => {
    if (data.isOpen) {
      updateNodeData(id, { isOpen: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleReady = useCallback(() => {
    clearReadyTimer();
    const bridge = bridgeRef.current;
    if (!bridge) return;
    setConnection('connected');
    // 能力问出来再用：MONOFORM 的 actions 是可用接口的唯一事实来源。
    void bridge
      .getCapabilities()
      .then((next) => {
        if (!mountedRef.current) return;
        setCapabilities(next);
        updateNodeData(id, { errorMessage: null });
        // 握手成功顺手取一次场景，这样用户开口第一句时 agent 就知道现状。
        void refreshSceneSummary(bridge);
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        setCapabilities(null);
        updateNodeData(id, {
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });
  }, [clearReadyTimer, id, updateNodeData]);

  const closeDesk = useCallback(() => {
    // MONOFORM 自己按 instanceId 存本地 localStorage，宿主不做快照，直接关即可。
    updateNodeData(id, { isOpen: false });
  }, [id, updateNodeData]);

  // 回调走 ref 取最新闭包，桥只建一次。
  const handlersRef = useRef({ handleReady, closeDesk });
  handlersRef.current = { handleReady, closeDesk };

  /**
   * 桥必须在 iframe 文档开始执行前就位，否则首帧 ready 会丢。用**回调 ref**而不是
   * layout effect：Dialog 内容是 portal，比外层晚一个 commit 才挂，layout effect 跑时
   * iframe 还没进 DOM。回调 ref 在元素真正插入 DOM 那一刻同步执行。
   */
  const attachIframe = useCallback(
    (iframe: HTMLIFrameElement | null) => {
      if (!iframe) return undefined;
      const bridge = createDirectorDeskBridge({
        iframe,
        onReady: () => handlersRef.current.handleReady(),
        onClose: () => handlersRef.current.closeDesk(),
      });
      bridgeRef.current = bridge;

      clearReadyTimer();
      readyTimerRef.current = setTimeout(() => {
        if (bridge.isReady()) return;
        setConnection('failed');
      }, MONOFORM_DESK_READY_TIMEOUT_MS);

      return () => {
        clearReadyTimer();
        bridge.dispose();
        if (bridgeRef.current === bridge) bridgeRef.current = null;
      };
    },
    [clearReadyTimer],
  );

  // 弹窗关闭即卸载 iframe：3D 引擎不常驻、不后台空转。
  //
  // `capabilities` 故意不清空：连过之后就不该退回「正在连接」。重开时如果连接失败，
  // 连接态是 failed，但能力的**上层真相**（这份 bundle 不支持导出）仍然成立，
  // 把它抹掉就是在说谎 —— 清掉能力事实等于把已有结论降级成未知。
  useEffect(() => {
    if (!isOpen) {
      setConnection('idle');
    }
  }, [isOpen]);

  useEffect(() => {
    setConnection(isOpen ? 'connecting' : 'idle');
  }, [isOpen, attempt]);

  const openDesk = useCallback(() => {
    updateNodeData(id, { isOpen: true, errorMessage: null });
  }, [id, updateNodeData]);

  /**
   * 接住 agent 的场景 intent：读当前工程 → monoformScenePatch 翻译合并 → scene.apply
   * 推回 MONOFORM 热更新（无 reload）。工程还没就绪（没连上）时只提示，不炸。
   */
  const handleSceneIntent = useCallback(
    (intent: DirectorSceneIntent) => {
      const bridge = bridgeRef.current;
      if (!bridge || !bridge.isReady()) {
        toast.error(t('node.directorDesk.assistantSceneUnavailable'));
        return;
      }
      void (async () => {
        try {
          const project = await bridge.getProject();
          // 快照存的是**改动前**的工程：撤销要退回这里，所以必须在 apply 之前写。
          saveUndoSnapshot(id, project);
          const next = applyMonoformSceneIntent(project as MonoformProject, intent);
          await bridge.request('scene.apply', { project: next });
          // 画面变了，摘要跟着变 —— 下一轮「再近一点」要基于新状态。
          void refreshSceneSummary(bridge);
          if (mountedRef.current) toast.success(t('node.directorDesk.assistantSceneApplied'));
        } catch (error) {
          if (!mountedRef.current) return;
          toast.error(
            t('node.directorDesk.assistantSceneFailed', {
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      })();
    },
    [t, id, refreshSceneSummary],
  );

  /** 撤销最近一次场景注入：把快照推回去，然后清掉快照（撤销只有一层）。 */
  const handleUndoScene = useCallback(() => {
    const bridge = bridgeRef.current;
    if (!bridge || !bridge.isReady()) {
      toast.error(t('node.directorDesk.assistantSceneUnavailable'));
      return;
    }
    const snapshot = readUndoSnapshot(id);
    if (!snapshot) {
      toast.error(t('node.directorDesk.card.undoUnavailable'));
      return;
    }
    void (async () => {
      try {
        await bridge.request('scene.apply', { project: snapshot });
        clearUndoSnapshot(id);
        void refreshSceneSummary(bridge);
        if (mountedRef.current) toast.success(t('node.directorDesk.card.undoApplied'));
      } catch (error) {
        if (!mountedRef.current) return;
        toast.error(
          t('node.directorDesk.assistantSceneFailed', {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    })();
  }, [t, id, refreshSceneSummary]);

  /**
   * 导出白模预演视频：`export.video` 拿 MP4 Blob（协议不会自动下载，宿主自己处置），
   * 上传成项目内资产，再补一次 `export.frame(position: first)` 取首帧当封面 ——
   * `previewImageUrl` 是喂给图片元素用的，直接塞视频地址渲染不出来。
   *
   * 关键在第 3 步：白模视频必须**在画布上留一条来源边**，否则它只是本节点的一个字段，
   * 正式视频生成拿不到它当视频参考。派生节点必须是 **video** —— upload 没有
   * `targetHandle`，`addEdge` 一律回 null（T011 就是这么建错的，见文件头注释）。
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
        monoformArtifactUploadName(id, 'video', 'mp4', stamp),
      );
      const videoUrl = directorDeskAssetUrl(uploaded.url, stamp);
      if (!videoUrl) throw new Error(t('node.directorDesk.exportFailed', { message: 'no url' }));

      // 封面是加分项：拿不到首帧也要把视频写回去，否则用户白等一次导出。
      let previewImageUrl: string | null = null;
      if (monoformSupportsExport(capabilitiesRef.current, 'export.frame')) {
        try {
          const frame = (await bridge.request('export.frame', {
            position: 'first',
            quality: '720p',
          })) as { dataUrl?: string } | undefined;
          if (typeof frame?.dataUrl === 'string' && frame.dataUrl.startsWith('data:')) {
            const poster = await uploadFreezoneImage(
              projectId,
              dataUrlToBlob(frame.dataUrl),
              monoformArtifactUploadName(id, 'poster', 'png', stamp),
              { timeoutMs: false },
            );
            previewImageUrl = directorDeskAssetUrl(poster.url, stamp) || null;
          }
        } catch {
          previewImageUrl = null;
        }
      }

      // 来源边：白模节点（源）→ 派生 video 节点（目标）。放在 mounted 守卫之前 ——
      // 产物已经落在项目里，即便弹窗被关掉，画布上也该看得见它（与视频字段回写同一取舍）。
      // 派生节点承载白模视频本身（`data.videoUrl`），正式视频生成可以直接拿它当视频参考。
      const derivedNodeId = addNode(
        CANVAS_NODE_TYPES.video,
        findNodePosition(id, WHITEBOX_NODE_WIDTH, WHITEBOX_NODE_HEIGHT),
        { videoUrl, previewImageUrl: previewImageUrl ?? null },
      );
      const edgeId = addEdge(id, derivedNodeId);

      if (!mountedRef.current) {
        return;
      }
      updateNodeData(id, {
        videoUrl,
        ...(previewImageUrl ? { previewImageUrl } : {}),
        errorMessage: null,
      });
      if (edgeId) {
        toast.success(t('node.directorDesk.videoExported'));
      } else {
        // 建边被收口拒了（类型规则 / 素材包络）。实测 desk→video 恒成功，所以走到这里
        // 说明有真问题 —— 如实报出来，不把它当成一次成功的导出。
        setArtifactError(
          t('node.directorDesk.exportFailed', { message: 'source edge rejected' }),
        );
      }
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
  }, [addEdge, addNode, findNodePosition, id, t, updateNodeData]);

  const title = localizeNodeDisplayName(CANVAS_NODE_TYPES.directorDesk, data, t);
  const previewUrl =
    typeof data.previewImageUrl === 'string' && data.previewImageUrl.length > 0
      ? data.previewImageUrl
      : null;
  const [previewFailed, setPreviewFailed] = useState(false);
  useEffect(() => {
    setPreviewFailed(false);
  }, [previewUrl]);
  const showPreview = previewUrl !== null && !previewFailed;

  /**
   * 给 agent 看的上游原始事实（不是 UI 文案）。上游连线只有宿主知道，agent 拿不到画布，
   * 所以随对话一起送过去。
   */
  // i18n-exempt-start — 进的是给 agent 的提示词（不是 UI），保持语言稳定。
  const chatUpstreamSummary = useMemo(() => {
    const items = upstreamNodes.map((node) => {
      const nodeData = (node.data ?? {}) as Record<string, unknown>;
      const name = String(nodeData.displayName ?? node.id);
      const kind =
        typeof nodeData.imageUrl === 'string' ? '图片'
        : typeof nodeData.videoUrl === 'string' ? '视频'
        : typeof nodeData.content === 'string' ? '文本'
        : '素材';
      return `${kind}「${name}」`;
    });
    return items.length ? items.join('、') : undefined;
  }, [upstreamNodes]);
  // i18n-exempt-end

  return (
    <div
      className="group relative h-full w-full overflow-visible"
      style={{ width: MONOFORM_DESK_NODE_WIDTH, height: MONOFORM_DESK_NODE_HEIGHT }}
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
        icon={<Boxes className="h-4 w-4" />}
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
              <Boxes className="h-7 w-7 text-cyan-200/70" />
              <span className="text-[12px] leading-5 text-text-muted/90">
                {t('node.directorDesk.emptyHint')}
              </span>
            </div>
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
            {t('node.directorDesk.whiteboxOpen')}
          </button>
        </div>

        {/*
          能力边界与导出入口：**按 bundle 自己声明的 actions 条件渲染**，两条分支互斥。
          未握手时用 vendored 基准事实（`MONOFORM_CAPABILITIES`）—— 那是构建期事实，
          不是「还不知道」，所以正常情况下入口从一开始就在。

          能力确实不可用时（上游换了 bundle、或握手回包没声明 export.video）仍然如实
          显示提示，不隐藏、不退化成一个点了没反应的按钮。
        */}
        {monoformSupportsExport(capabilities ?? MONOFORM_CAPABILITIES, 'export.video') ? (
          <>
            <div className="flex items-center gap-2 border-t border-white/[0.06] px-2 py-1.5">
              <button
                type="button"
                data-testid="monoform-export-button"
                // busy 保护：导出含录制 + 两次上传，重复点击会并发触发多次落库。
                disabled={isExportingVideo || connection !== 'connected'}
                onClick={(event) => {
                  event.stopPropagation();
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
                  : t('node.directorDesk.whiteboxExportVideo')}
              </button>
              {typeof data.videoUrl === 'string' && data.videoUrl.length > 0 && (
                <span className="text-[12px] leading-5 text-white/45">
                  {t('node.directorDesk.hasVideo')}
                </span>
              )}
            </div>
            {artifactError && (
              <p role="alert" className="border-t border-white/[0.06] px-2 py-1.5 text-[11px] leading-4 text-amber-300">
                {artifactError}
              </p>
            )}
          </>
        ) : (
          <p
            data-testid="monoform-export-unavailable"
            title={t('node.directorDesk.exportUnavailableHint')}
            className="border-t border-white/[0.06] px-2 py-1.5 text-[11px] leading-4 text-amber-200/90"
          >
            {t('node.directorDesk.exportUnavailable')}
          </p>
        )}
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

            {/* min-h-0 不能省：grid item 的 min-height:auto 会拒绝收缩到 h-dvh，把侧栏顶出视口。 */}
            <div className="flex h-full min-h-0 w-full flex-col bg-[#090909]">
              <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.08] px-3 py-2">
                <span className="flex items-center gap-2 text-[12px] leading-5 text-white/80">
                  {connection === 'connecting' && (
                    <Loader2 className="size-3.5 animate-spin text-cyan-200" />
                  )}
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

                <button
                  type="button"
                  onClick={() => setChatOpen((value) => !value)}
                  aria-expanded={chatOpen}
                  className={`ml-auto flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] leading-5 transition-colors ${
                    chatOpen
                      ? 'bg-cyan-300/[0.16] text-cyan-100 hover:bg-cyan-300/[0.24]'
                      : 'bg-white/[0.08] text-white/85 hover:bg-white/[0.14]'
                  }`}
                >
                  <MessagesSquare className="size-3.5" />
                  {t('node.directorDesk.assistant')}
                </button>

                <button
                  type="button"
                  onClick={closeDesk}
                  aria-label={t('node.directorDesk.close')}
                  className="flex items-center gap-1.5 rounded-md bg-white/[0.08] px-2.5 py-1 text-[12px] leading-5 text-white/85 transition-colors hover:bg-white/[0.14]"
                >
                  <X className="size-3.5" />
                  {t('node.directorDesk.close')}
                </button>
              </div>

              <div className="relative flex min-h-0 flex-1">
                {/* min-w-0 不能省：flex item 的 min-width:auto 会被 iframe 的 min-content 顶宽溢出视口。 */}
                <div className="relative min-h-0 min-w-0 flex-1">
                  <iframe
                    key={attempt}
                    ref={attachIframe}
                    src={monoformDeskIframeSrc(id)}
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

                {chatOpen && (
                  <aside
                    style={
                      {
                        // clamp 的上界由白模台的下限决定：面板再宽也不能把 iframe 挤到 720 以下。
                        // （CSS clamp 在 max < min 时取 min，所以窄视口下这里是 360，配合下面的
                        //  覆盖模式断点，实际不会以 360 的静态宽度去挤 iframe。）
                        '--desk-chat-width': `clamp(${CHAT_WIDTH_MIN}px, ${chatWidth}px, calc(100vw - ${MONOFORM_MIN_VIEWPORT}px))`,
                      } as CSSProperties
                    }
                    className={`absolute inset-y-0 right-0 z-20 flex min-h-0 w-full max-w-[460px] flex-col border-l border-white/[0.08] bg-[#111111] min-[1080px]:relative min-[1080px]:w-[var(--desk-chat-width)] min-[1080px]:max-w-none min-[1080px]:bg-transparent`}
                  >
                    {/*
                      拖拽手柄。只在并排模式出现 —— 覆盖模式下面板占满，没有宽度可调。
                      断点 1080 = 720（白模台下限）+ 360（面板最小），比这更窄时并排必然
                      挤坏白模台，所以整体退回覆盖。
                    */}
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={t('node.directorDesk.assistantResize')}
                      onPointerDown={startChatResize}
                      className="absolute inset-y-0 -left-px z-10 hidden w-1.5 cursor-col-resize touch-none select-none transition-colors hover:bg-cyan-300/40 min-[1080px]:block"
                    />
                    <DirectorDeskChatPanel
                      scope={chatScope}
                      upstreamSummary={chatUpstreamSummary}
                      sceneSummary={sceneSummary}
                      onRequestClose={() => setChatOpen(false)}
                      onSceneIntent={handleSceneIntent}
                      onUndoScene={handleUndoScene}
                      engine="monoform"
                    />
                  </aside>
                )}
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
});

MonoformDeskNode.displayName = 'MonoformDeskNode';
