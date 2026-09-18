// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Clapperboard, Download, Link2, Loader2, Play, RefreshCw, Save, X } from 'lucide-react';
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
import { useViewerImmersiveBody } from '@/features/viewer-kit/useViewerImmersiveBody';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';
import {
  createDirectorDeskBridge,
  DIRECTOR_DESK_PROTOCOL_VERSION,
  type DirectorDeskBridge,
  type DirectorDeskCapabilities,
  type DirectorDeskCapture,
  type DirectorDeskExportVideoResult,
} from './directorDeskBridge';

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
 * iframe 地址：`instanceId` 用画布 nodeId，导演台按它隔离 localStorage 场景，
 * 所以两个导演台节点互不覆盖对方的工程。`theme=dark` 与画布深色主题一致。
 *
 * 同源子路径部署，因此**不带** `hostOrigin` —— 导演台在该参数缺失时回落到它自己的
 * origin，与宿主 origin 相同；显式传反而会在换端口调试时引入跨 origin 复杂度。
 */
export function directorDeskIframeSrc(nodeId: string): string {
  return `/director-desk/?instanceId=${encodeURIComponent(nodeId)}&theme=dark`;
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
export const DIRECTOR_DESK_SAVE_TIMEOUT_MS = 5_000;

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
 * 上游节点上有没有一张能当导演台全景图的**图片**。
 *
 * 只认图片：`upload` 节点早期版本装过视频（地址在 `data.videoUrl`），把 mp4 当全景图
 * 送进去导演台只会加载失败。上游自己的 `isSupportedHostImageUrl` 只看 scheme，拦不住
 * 这种情况，所以在这里按字段与扩展名先筛一遍。
 */
export function directorDeskPanoramaSource(
  upstreamNodes: ReadonlyArray<{ id: string; data: unknown }>,
): { sourceNodeId: string; imageUrl: string; fileName: string; displayName: string } | null {
  for (const node of upstreamNodes) {
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

/**
 * 上传后的项目内 URL → 画布节点字段里该存的值。带上 `?v=` 破缓存，否则用户在同一
 * 会话里重新导出、后端同名覆盖时，画布上看到的还是旧图。
 */
export function directorDeskAssetUrl(url: string, stamp: number): string {
  const clean = url.split('?')[0];
  return clean ? withImageCacheBust(clean, stamp) : '';
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
  // 一跳上游（按连线顺序、浅比较订阅）。导演台是「画布上的一个工作台」，上游接进来的
  // 图片要真的进到它的场景里，否则接进来的线就是死的 —— 用户会立刻感到割裂。
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
  // 已经送进导演台的那张全景图（来源节点 + 地址）。用它避免每次重开都把用户在导演台
  // 里自己换的背景覆盖掉；只有上游真的换图时才重发。
  const sentPanoramaRef = useRef<string | null>(null);
  // 每次「重试」都换一个 key，强制 iframe 重新挂载重新握手。
  const [attempt, setAttempt] = useState(0);

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
   * 工程快照回灌。协议 v1 **没有** `project.set` / 工程导入动作（受控接口只有
   * `capabilities.get` / `project.get` / `timeline.get` / `export.frame` /
   * `export.video` / `plugin.result.submit` / `plugin.results.list`），所以宿主
   * 无法把 JSON 推送进导演台。能给的回灌动作就是 `session`：它让导演台按
   * `instanceId` 激活它自己那份工程（存在它自己的 localStorage / IndexedDB 里）。
   *
   * 快照本身是**跨设备/清缓存后的持久备份**：拿 URL 到导演台首页的导入入口即可
   * 还原整个工程（上游导入器接受新版外壳 JSON）。这一限制不通过 fork 上游来绕过。
   *
   * 快照取不到（404/网络错误）时只提示、不阻断 —— 导演台自己的本地存档仍然可用。
   */
  const restoreProjectSnapshot = useCallback(
    async (bridge: DirectorDeskBridge) => {
      // 先激活实例：这是"同一节点重开回到同一工程"的机制（按 instanceId 隔离）。
      bridge.sendSession(id, 'dark');
      const ref = typeof data.directorProjectRef === 'string' ? data.directorProjectRef : '';
      if (!ref) return;
      try {
        const response = await fetch(ref, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`snapshot http ${response.status}`);
        const snapshot: unknown = await response.json();
        if (typeof snapshot !== 'object' || snapshot === null) {
          throw new Error('snapshot is not an object');
        }
        if (mountedRef.current) setSnapshotNotice(null);
      } catch {
        // 降级：不抛、不拦。用户还能继续用导演台（本地存档），只是提示他快照没了。
        if (mountedRef.current) {
          setSnapshotNotice(t('node.directorDesk.snapshotUnavailable'));
        }
      }
    },
    [data.directorProjectRef, id, t],
  );

  /**
   * 把上游接进来的图片送进导演台场景当全景图。
   *
   * 单独成一个 effect（而不是塞进 ready 回调）是为了让「上游换图」也生效 —— 用户在画布上
   * 换一张图、或者接上第一张图时，导演台里必须跟着变，否则连好的线是死的，这就是割裂感的
   * 来源。用 `sentPanoramaRef` 记住「已经送过哪一对（来源节点 + 地址）」：
   *   - 同一张图重开弹窗 → 不重发，避免覆盖用户在导演台里自己换过的背景；
   *   - 换了图 / 换了来源 → 重发。
   */
  useEffect(() => {
    if (connection !== 'connected') return;
    const bridge = bridgeRef.current;
    if (!bridge || !panoramaSource) return;
    const key = `${panoramaSource.sourceNodeId}|${panoramaSource.imageUrl}`;
    if (sentPanoramaRef.current === key) return;
    bridge.sendPanorama({
      edgeId: `${panoramaSource.sourceNodeId}->${id}`,
      sourceNodeId: panoramaSource.sourceNodeId,
      imageUrl: panoramaSource.imageUrl,
      fileName: panoramaSource.fileName,
    });
    sentPanoramaRef.current = key;
  }, [connection, id, panoramaSource]);

  const handleReady = useCallback(() => {
    clearReadyTimer();
    const bridge = bridgeRef.current;
    if (!bridge) return;
    setConnection('connected');
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
    void restoreProjectSnapshot(bridge);
  }, [clearReadyTimer, id, restoreProjectSnapshot, updateNodeData]);

  /**
   * 关闭前把工程存成项目资产。`project.get` 拿深拷贝 → JSON Blob →
   * `/freezone/upload`（和 3GS 那边传 frame_meta.json 同一条路径）。
   * 只把**引用**写回节点 data，绝不把工程 JSON 本身写进画布。
   */
  const persistProjectSnapshot = useCallback(async () => {
    const bridge = bridgeRef.current;
    if (!bridge || !bridge.isReady()) return;
    const projectId = readUrl().project;
    if (!projectId) return;
    const snapshot = await bridge.getProject();
    const json = JSON.stringify(snapshot);
    if (json.length > DIRECTOR_DESK_SNAPSHOT_MAX_BYTES) {
      throw new Error(t('node.directorDesk.snapshotTooLarge'));
    }
    const stamp = Date.now();
    const uploaded = await uploadFreezoneImage(
      projectId,
      new Blob([json], { type: 'application/json' }),
      directorDeskProjectUploadName(id, stamp),
      { timeoutMs: false },
    );
    const ref = directorDeskAssetUrl(uploaded.url, stamp);
    if (!ref) throw new Error(t('node.directorDesk.uploadFailed', { message: 'no url' }));
    updateNodeData(id, { directorProjectRef: ref });
  }, [id, t, updateNodeData]);

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
    void persistProjectSnapshot()
      .then(() => {
        if (!mountedRef.current) return;
        toast.success(t('node.directorDesk.projectSaved'));
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        const message = t('node.directorDesk.projectSaveFailed', {
          message: error instanceof Error ? error.message : String(error),
        });
        setArtifactError(message);
        toast.error(message);
      })
      .finally(() => {
        if (mountedRef.current) setIsSavingProject(false);
      });
  }, [isSavingProject, persistProjectSnapshot, t]);

  /**
   * 关窗：先把工程存档，再卸载 iframe。
   *
   * 顺序不能反 —— 桥随 iframe 一起销毁，卸载后就再也问不到工程了。
   * 存档是尽力而为：超时或失败都照常关窗（提示一下），绝不把弹窗卡住。
   */
  const closeDesk = useCallback(() => {
    const bridge = bridgeRef.current;
    const shouldSave = Boolean(bridge?.isReady());
    if (!shouldSave) {
      updateNodeData(id, { isOpen: false });
      return;
    }
    setIsSavingProject(true);
    const timeout = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), DIRECTOR_DESK_SAVE_TIMEOUT_MS);
    });
    void Promise.race([persistProjectSnapshot(), timeout])
      .then((outcome) => {
        if (!mountedRef.current) return;
        if (outcome === 'timeout') {
          const message = t('node.directorDesk.projectSaveTimeout');
          setArtifactError(message);
          // 关窗后内联提示随弹窗一起卸掉，所以失败必须同时走 toast —— 否则用户
          // 什么也看不到，只会以为工程存过了。
          toast.error(message);
        } else {
          toast.success(t('node.directorDesk.projectSaved'));
        }
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        const message = t('node.directorDesk.projectSaveFailed', {
          message: error instanceof Error ? error.message : String(error),
        });
        setArtifactError(message);
        toast.error(message);
      })
      .finally(() => {
        if (!mountedRef.current) return;
        setIsSavingProject(false);
        updateNodeData(id, { isOpen: false });
      });
  }, [id, persistProjectSnapshot, t, updateNodeData]);

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
  const handlersRef = useRef({ handleReady, handleDeskClose, handleCaptures });
  handlersRef.current = { handleReady, handleDeskClose, handleCaptures };

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
        onReady: () => handlersRef.current.handleReady(),
        onClose: () => handlersRef.current.handleDeskClose(),
        onCaptures: (captures) => handlersRef.current.handleCaptures(captures),
      });
      bridgeRef.current = bridge;

      clearReadyTimer();
      readyTimerRef.current = setTimeout(() => {
        if (bridge.isReady()) return;
        setConnection('failed');
      }, DIRECTOR_DESK_READY_TIMEOUT_MS);

      return () => {
        clearReadyTimer();
        bridge.dispose();
        if (bridgeRef.current === bridge) bridgeRef.current = null;
      };
    },
    [clearReadyTimer],
  );

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
    if (upstreamHasText) return t('node.directorDesk.upstreamText');
    return null;
  }, [panoramaSource, upstreamHasText, t]);

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

            <div className="flex h-full w-full flex-col bg-[#090909]">
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
                {isImportingCaptures && (
                  <span className="flex items-center gap-1.5 text-[12px] leading-5 text-white/70">
                    <Loader2 className="size-3.5 animate-spin" />
                    {t('node.directorDesk.importingCaptures')}
                  </span>
                )}
                {projectReadout && (
                  <span className="text-[12px] leading-5 text-white/45">{projectReadout}</span>
                )}
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

              <div className="relative min-h-0 flex-1">
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
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
});

DirectorDeskNode.displayName = 'DirectorDeskNode';
