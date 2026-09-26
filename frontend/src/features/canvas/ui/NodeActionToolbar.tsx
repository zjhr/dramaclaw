// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { NodeToolbar as ReactFlowNodeToolbar } from "@xyflow/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import {
  Boxes,
  ChevronDown,
  Copy,
  Crop,
  Download,
  Eraser,
  Expand,
  FastForward,
  Film,
  FolderOpen,
  Globe2,
  Grid2x2,
  Grid3x3,
  Forward,
  GitBranch,
  ImageUpscale,
  LayoutDashboard,
  LayoutGrid,
  Link2,
  Lightbulb,
  Loader2,
  Maximize2,
  Package,
  Palette,
  PenLine,
  RefreshCw,
  Rewind,
  RotateCw,
  Scissors,
  Send,
  Sparkles,
  Trash2,
  Unlink2,
  User,
  Users,
  Video as VideoIcon,
  Wand2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFn } from "@/lib/i18n-types";

import { toast } from "sonner";

import { downloadBlobAsFile, downloadUrlAsFile } from "@/lib/browserDownload";
import {
  AUDIO_DOWNLOAD_FORMATS,
  canProduceFormat,
  getAudioExtFromUrl,
  transcodeAudio,
  type AudioDownloadFormat,
} from "@/lib/audioTranscode";
import { nodeMainlineFlags } from "@/features/canvas/domain/mainlineNodeFlags";
import { inheritMainlineFields } from "@/features/canvas/domain/inheritMainlineFields";
import {
  extractMainlineContextsFromNode,
  type MainlineContext,
} from "@/features/freezone/context/mainlineContext";
import { deriveNodeDropInfo } from "@/stores/assetDropStore";

import {
  NODE_TOOL_TYPES,
  CANVAS_NODE_TYPES,
  DEFAULT_NODE_WIDTH,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  isAudioNode,
  isExportImageNode,
  isGroupNode,
  isImageEditNode,
  isImageGenNode,
  isProtectedProjectionGroupNode,
  isStoryboardGenNode,
  isStoryboardGroupNode,
  isStoryboardSplitNode,
  isUploadNode,
  isVideoNode,
  resolveNodeSourceImageUrl,
  type CanvasNode,
  type GroupNodeData,
  type NodeToolType,
} from "@/features/canvas/domain/canvasNodes";
import { GROUP_COLOR_PRESETS } from "@/features/canvas/domain/groupColors";
import { StoryboardGroupToolbar } from "@/features/canvas/ui/StoryboardGroupToolbar";
import { canvasEventBus } from "@/features/canvas/application/canvasServices";
import { useCanvasProjectionStatus } from "@/features/freezone/projectionStatusStore";
import {
  matteInWorker,
  preloadMatteWorker,
} from "@/features/canvas/application/matteClient";
import { getNodeToolPlugins } from "@/features/canvas/tools";
import type { ToolIconKey } from "@/features/canvas/tools";
import { UiChipButton, UiPanel } from "@/components/ui";
import { ZoomScaledToolbar } from "@/features/canvas/ui/ZoomScaledToolbar";
import { copyImageSourceToClipboard } from "@/commands/image";
import { resolveImageDisplayUrl, snapToAllowedAspectRatio } from "@/features/canvas/application/imageData";
import { FALLBACK_VIDEO_ASPECT_OPTIONS } from "@/features/canvas/domain/mediaModelOptions";
import { useSettingsStore } from "@/stores/settingsStore";
import { useCanvasStore } from "@/stores/canvasStore";
import {
  fetchFreezoneAudioSeparateResult,
  fetchFreezoneJobResult,
  fetchFreezoneVideoReshootSuggestPromptResult,
  submitFreezoneVideoReshootSuggestPrompt,
  submitFreezoneAnalyzeVideoStory,
  submitFreezoneAudioSeparate,
  submitFreezoneVideoGreybox,
  submitFreezoneVideoCompose,
  submitFreezoneVideoKeyframes,

  submitFreezoneVideoReshoot,
  uploadFreezoneImage,
} from "@/api/ops";
import { openPresetProjectionInMyCanvas } from "@/features/freezone/openPresetProjection";
import { captureVideoFrameBlob } from "@/features/canvas/application/videoFrameCapture";
import { awaitTaskCompletion, isTaskPollTimeoutError } from "@/api/tasks";
import { notifyTaskStillRunning } from "@/features/canvas/application/errorDialog";
import { normalizeVideoStoryRows } from "@/features/canvas/application/videoStoryNormalizer";
import {
  ProviderModelPicker,
  type ModelOption,
} from "@/features/canvas/ui/ProviderModelPicker";
import { useFreezoneVideoModels } from "@/features/canvas/hooks/useFreezoneVideoModels";
import { readUrl } from "@/lib/url-params";
import { sanitizeStoryboardText } from "@/features/canvas/application/storyboardText";
import {
  useVideoDurationSeconds,
  VideoReshootTimeline,
} from "@/features/canvas/ui/VideoReshootTimeline";
import { EnhancePromptDialog } from "@/features/canvas/nodes/EnhancePromptDialog";
import {
  dialectForVideoModel,
  usePromptEnhance,
  VIDEO_PROMPT_DIALECTS,
} from "@/features/canvas/nodes/usePromptEnhance";
import { buildGenerationErrorReport } from "@/features/canvas/application/generationErrorReport";
import { BillingRuleNotConfiguredError } from "@/lib/api-errors";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { CreditCostPill } from "@/components/credits/credit-visual";
import {
  NODE_TOOLBAR_ALIGN,
  NODE_TOOLBAR_CLASS,
  NODE_TOOLBAR_OFFSET,
  NODE_TOOLBAR_POSITION,
} from "./nodeToolbarConfig";
import type {
  GridActionKey,
  GridActionRequest,
} from "./GridActionConfirmOverlay";

/**
 * 深度视频（内部代号 greybox）画布预设。参数与后端
 * `run_freezone_video_greybox` 默认值/调参台预设保持一致：
 * 留空的字段走后端默认（fps=8 / fov=60 / ambient=0.15 / base_grey=0.9 /
 * gamma=2.2 / smooth=1 / fill=0.45）。默认值依据见 greybox_render.py docstring。
 */
/**
 * 「转深度视频」的默认参数。2026-09-21 主人拍板：画布不做多预设，
 * 点一下就出效果——用纯深度灰度（近白远灰、无光照无描边）。
 * 其余可调参数走调参台（http://localhost:8790/）试好后回填这里。
 */
const DEPTH_VIDEO_PARAMS = { shade: "depth" } as const;

interface NodeActionToolbarProps {
  node: CanvasNode;
  onOpenMultiAngleEditor: (nodeId: string) => void;
  onOpenLightEditor: (nodeId: string) => void;
  onOpenScene360: (nodeId: string) => void;
  onOpenUpscale: (nodeId: string) => void;
  onOpenOutpaint: (nodeId: string) => void;
  onOpenGridAction: (request: GridActionRequest) => void;
  onOpenRedraw: (nodeId: string) => void;
  onOpenErase: (nodeId: string) => void;
  onOpenRotate: (nodeId: string) => void;
}

const toolIconMap: Record<ToolIconKey, typeof Crop> = {
  crop: Crop,
  annotate: PenLine,
  split: Scissors,
};

const TOOLBAR_BUTTON_RADIUS_CLASS = "rounded-[12px]";
/**
 * 「继续生成」提交用的画幅比。
 *
 * 不能把节点上的 `aspectRatio` 原样传：它常常是 `"auto"`（跟随输入画面），而上游
 * 明确拒绝 `aspect_ratio=auto`（实测 400 `aspect_ratio 不能为 auto`）。这里按
 * VideoNode 提交时的同一套口径，从**视频的真实像素尺寸**吸附到一个具体比例，兜底 16:9。
 */
function continueAspectRatio(data: {
  aspectRatio?: unknown;
  widthPx?: unknown;
  heightPx?: unknown;
}): string {
  const raw = typeof data.aspectRatio === "string" ? data.aspectRatio.trim() : "";
  const widthPx = typeof data.widthPx === "number" ? data.widthPx : 0;
  const heightPx = typeof data.heightPx === "number" ? data.heightPx : 0;
  const candidate =
    raw && raw !== "auto"
      ? raw
      : widthPx > 0 && heightPx > 0
        ? `${widthPx}:${heightPx}`
        : "";
  return snapToAllowedAspectRatio(
    candidate,
    FALLBACK_VIDEO_ASPECT_OPTIONS.filter((ratio) => ratio !== "auto"),
    "16:9",
  );
}

/** 延长段开头丢掉的秒数。首帧就是原片锚点，留着会在接缝停住。 */
const EXTEND_JOIN_SKIP_SECONDS = 0.1;

function probeVideoDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    const timer = window.setTimeout(() => {
      video.src = "";
      reject(new Error("duration timeout"));
    }, 15000);
    video.onloadedmetadata = () => {
      window.clearTimeout(timer);
      const duration = video.duration;
      video.src = "";
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(new Error("invalid duration"));
        return;
      }
      resolve(duration);
    };
    video.onerror = () => {
      window.clearTimeout(timer);
      video.src = "";
      reject(new Error("duration probe failed"));
    };
    video.src = url;
  });
}

// 扁平菜单项：去掉独立边框与胶囊背景，融入工具栏整条；仅靠 hover 高亮区分。
const TOOLBAR_NEUTRAL_BUTTON_CLASS =
  "!border-transparent !bg-transparent text-text-dark hover:!bg-[rgba(255,255,255,0.075)] focus:!border-transparent focus:!bg-transparent focus:!shadow-none focus-visible:!outline-none focus-visible:!ring-0 data-[state=open]:!border-transparent data-[state=open]:!shadow-none";
const TOOLBAR_TEXT_BUTTON_CLASS =
  `h-9 shrink-0 whitespace-nowrap ${TOOLBAR_BUTTON_RADIUS_CLASS} px-3 text-sm ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`;
const TOOLBAR_MENU_CONTENT_CLASS =
  "z-[120] border-white/10 bg-[#242426]/50 text-text-dark shadow-none backdrop-blur-3xl";
const TOOLBAR_MENU_ITEM_CLASS =
  "gap-2 rounded-[10px] text-text-dark focus:bg-[rgba(255,255,255,0.075)] focus:text-text-dark";

type BeatMainlineContext = MainlineContext & {
  projectId: string;
  episode: number;
  beat: number;
};

const BEAT_CONTEXT_SOURCE_KINDS = new Set([
  "beat",
  "sketch",
  "frame",
  "video",
  "audio",
  "director_combined",
  "selected_background",
]);

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayOrUndefined(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : undefined;
}

function beatContextLabel(episode: number, beat: number): string {
  return `EP${episode} / Beat ${beat}`;
}

function beatContextFromRecord(
  raw: unknown,
  projectFallback?: string,
): BeatMainlineContext | null {
  const record = recordOrNull(raw);
  if (!record || record.kind !== "beat") return null;
  const projectId = stringOrUndefined(record.projectId) ?? projectFallback;
  const episode = numberOrUndefined(record.episode);
  const beat = numberOrUndefined(record.beat);
  if (!projectId || episode === undefined || beat === undefined) return null;
  return {
    ...(record as MainlineContext),
    kind: "beat",
    projectId,
    episode,
    beat,
    role: "beat_context",
    label: stringOrUndefined(record.label) ?? beatContextLabel(episode, beat),
  };
}

function beatContextFromParts(
  projectId: string | undefined,
  episode: number | undefined,
  beat: number | undefined,
  meta: Record<string, unknown> | null,
): BeatMainlineContext | null {
  if (!projectId || episode === undefined || beat === undefined) return null;
  return {
    kind: "beat",
    projectId,
    episode,
    beat,
    role: "beat_context",
    label: beatContextLabel(episode, beat),
    visualDescription: stringOrUndefined(meta?.visual_description),
    narrationSegment: stringOrUndefined(meta?.narration_segment),
    sceneId: stringOrUndefined(meta?.scene_id),
    detectedIdentities: stringArrayOrUndefined(meta?.detected_identities),
    detectedProps: stringArrayOrUndefined(meta?.detected_props),
    sketchColors:
      (recordOrNull(meta?.sketch_colors) as Record<string, string> | null) ?? undefined,
    propMarkerColors:
      (recordOrNull(meta?.prop_marker_colors) as Record<string, string> | null) ?? undefined,
  };
}

function beatContextFromNode(node: CanvasNode): BeatMainlineContext | null {
  const data = recordOrNull(node.data) ?? {};
  const source = recordOrNull(data.__freezone_source);
  const projectFallback =
    stringOrUndefined(source?.projectId) ??
    stringOrUndefined(data.projectId) ??
    readUrl().project ??
    undefined;

  const explicit =
    beatContextFromRecord(source?.beat_context, projectFallback) ??
    beatContextFromRecord(data.beat_context, projectFallback);
  if (explicit) return explicit;

  const contexts = extractMainlineContextsFromNode(node);
  const direct = contexts.find(
    (ctx): ctx is BeatMainlineContext =>
      ctx.kind === "beat" &&
      typeof ctx.projectId === "string" &&
      typeof ctx.episode === "number" &&
      typeof ctx.beat === "number",
  );
  if (direct) return direct;

  const slotContext = contexts.find(
    (ctx) =>
      BEAT_CONTEXT_SOURCE_KINDS.has(ctx.kind) &&
      typeof ctx.projectId === "string" &&
      typeof ctx.episode === "number" &&
      typeof ctx.beat === "number",
  );
  if (slotContext) {
    return {
      ...slotContext,
      kind: "beat",
      role: "beat_context",
      label:
        stringOrUndefined(slotContext.label) ??
        beatContextLabel(slotContext.episode as number, slotContext.beat as number),
      sourceUrl: undefined,
    } as BeatMainlineContext;
  }

  const sourceRole = stringOrUndefined(source?.role);
  const sourceKind = stringOrUndefined(source?.kind);
  const beatScoped = Boolean(
    sourceRole &&
      ["current_sketch", "current_frame", "current_video", "current_audio", "selected_background", "director_combined"].includes(sourceRole),
  ) || Boolean(sourceKind && ["video", "audio"].includes(sourceKind));
  if (!beatScoped) return null;

  return beatContextFromParts(
    projectFallback,
    numberOrUndefined(source?.episode),
    numberOrUndefined(source?.beat),
    recordOrNull(source?.meta),
  );
}

function sameBeatContext(a: MainlineContext, b: BeatMainlineContext): boolean {
  return (
    a.kind === "beat" &&
    a.projectId === b.projectId &&
    a.episode === b.episode &&
    a.beat === b.beat
  );
}

function beatContextText(ctx: BeatMainlineContext): string {
  return [
    `Episode: ${ctx.episode}`,
    `Beat: ${ctx.beat}`,
    ctx.visualDescription ? `Visual: ${ctx.visualDescription}` : "",
    ctx.narrationSegment ? `Narration: ${ctx.narrationSegment}` : "",
  ].filter(Boolean).join("\n");
}

function beatContextNodeData(
  ctx: BeatMainlineContext,
  t: TFn,
): Record<string, unknown> {
  return {
    displayName: t("canvas.nodeToolbar.beatContextName", {
      episode: ctx.episode,
      beat: ctx.beat,
    }),
    content: beatContextText(ctx),
    projectId: ctx.projectId,
    episode: ctx.episode,
    beat: ctx.beat,
    context_scope: "mainline",
    beat_context: undefined,
    snapshot: {
      visualDescription: ctx.visualDescription ?? "",
      narrationSegment: ctx.narrationSegment ?? "",
      sceneId: ctx.sceneId ?? "",
      detectedIdentities: ctx.detectedIdentities ?? [],
      detectedProps: ctx.detectedProps ?? [],
      sketchColors: ctx.sketchColors ?? {},
      propMarkerColors: ctx.propMarkerColors ?? {},
    },
    mainline_context: [ctx],
    beat_edit_fields: {
      visual_description: ctx.visualDescription ?? "",
      scene_id: ctx.sceneId ?? "",
      time_of_day: "",
      detected_identities: ctx.detectedIdentities ?? [],
      detected_props: ctx.detectedProps ?? [],
    },
  };
}

/** 工具栏内分组之间的竖向分隔线，呼应 libtv 的连续扁平条视觉。 */
function ToolbarDivider() {
  return (
    <span
      aria-hidden
      className="mx-1 h-4 w-px shrink-0 self-center bg-[rgba(255,255,255,0.14)]"
    />
  );
}

/**
 * 让 Radix DropdownMenu 支持鼠标 hover 自动展开/移出延迟收起（Radix 原生只支持
 * 点击）。返回挂到根的受控 props 与挂到「触发器 + 内容」的 hover 事件；点击仍可用。
 * `onOpen` 在打开瞬间触发（用来关掉同行的下载浮层等）。
 */
function useHoverMenu(onOpen?: () => void) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const openNow = useCallback(() => {
    cancelClose();
    onOpen?.();
    setOpen(true);
  }, [cancelClose, onOpen]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 160);
  }, [cancelClose]);

  const onOpenChange = useCallback(
    (next: boolean) => {
      cancelClose();
      if (next) onOpen?.();
      setOpen(next);
    },
    [cancelClose, onOpen],
  );

  useEffect(() => cancelClose, [cancelClose]);

  return {
    open,
    rootProps: { open, onOpenChange, modal: false } as const,
    hoverProps: { onMouseEnter: openNow, onMouseLeave: scheduleClose },
  };
}


/**
 * Icon-only toolbar 按钮：方形 32×32 click area + 16px icon，与同行的带文字 chip
 * 等高对齐；hover 时在下方浮出主题化 tooltip（不依赖原生 title 的浏览器实现）。
 */
function ToolbarIconChip({
  label,
  icon: Icon,
  onClick,
  extraButtonClass = "",
}: {
  label: string;
  icon: typeof Crop;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  extraButtonClass?: string;
}) {
  return (
    <div className="group/iconchip relative">
      <UiChipButton
        title={label}
        aria-label={label}
        className={`h-9 w-9 justify-center !px-0 ${TOOLBAR_BUTTON_RADIUS_CLASS} text-sm ${TOOLBAR_NEUTRAL_BUTTON_CLASS} ${extraButtonClass}`}
        onClick={onClick}
      >
        <Icon className="h-4 w-4" />
      </UiChipButton>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-[140] mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md border border-[rgba(255,255,255,0.18)] bg-surface-dark/95 px-2 py-1 text-[11px] font-medium text-text-dark opacity-0 shadow-lg backdrop-blur-sm transition-opacity duration-150 delay-100 group-hover/iconchip:opacity-100"
      >
        {label}
      </span>
    </div>
  );
}

export const NodeActionToolbar = memo(
  ({
    node,
    onOpenMultiAngleEditor,
    onOpenLightEditor,
    onOpenScene360,
    onOpenUpscale,
    onOpenOutpaint,
    onOpenGridAction,
    onOpenRedraw,
    onOpenErase,
    onOpenRotate,
  }: NodeActionToolbarProps) => {
    const { t, i18n } = useTranslation();
    const videoAnalyzeCreditCost = useGenerationCreditCost(
      "feature",
      isVideoNode(node) ? "freezone.video_analyze" : null,
      {
        surface: "canvas",
        params: { operation: "video_story" },
      },
    );
    const videoAnalyzeBillingRuleMissing =
      videoAnalyzeCreditCost.error instanceof BillingRuleNotConfiguredError;
    const videoAnalyzeCreditCostDisplay =
      videoAnalyzeCreditCost.data?.data.display ??
      (videoAnalyzeBillingRuleMissing
        ? t("common.billingRuleNotConfiguredShort")
        : null);
    const isImageEdit = isImageEditNode(node);
    // Plain (non-protected) group → eligible for ungroup. Captured up here as a
    // boolean + a plain id while `node` still has its full type: over-broad node
    // type guards below narrow `node` to `never` by the time the ungroup button
    // renders, so reading `node.id` at the call site fails to type-check.
    const nodeId = node.id;
    const isUngroupableGroup = isGroupNode(node) && !isProtectedProjectionGroupNode(node);
    // 主线投影组只锁拓扑（不能解组），几何类操作（背景色 / 排列）照常给：后端算出的
    // 布局不合意时，用户得有补救手段——组框本身是只读的，没有这两项就真的动不了。
    const isAdjustableGroup = isGroupNode(node);
    // 同 nodeId:在 node 仍是完整类型时捕获组背景色。下方过宽的类型守卫会把 node
    // 收窄成 never,到 ungroup 按钮渲染处再读 node.data 会编译失败(tsc -b)。
    const groupBackgroundColor = isGroupNode(node)
      ? ((node.data as GroupNodeData).backgroundColor ?? null)
      : null;
    const isStoryboardGen = isStoryboardGenNode(node);
    const isStoryboardSplit = isStoryboardSplitNode(node);
    const canCopyStoryboardText = isStoryboardGen || isStoryboardSplit;
    const tools = useMemo(() => getNodeToolPlugins(node), [node]);
    const deleteNode = useCanvasStore((state) => state.deleteNode);
    const addNode = useCanvasStore((state) => state.addNode);
    const addEdge = useCanvasStore((state) => state.addEdge);
    const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
    const onNodesChange = useCanvasStore((state) => state.onNodesChange);
    const requestFocusNode = useCanvasStore((state) => state.requestFocusNode);
    const ungroupNode = useCanvasStore((state) => state.ungroupNode);
    const arrangeGroupChildren = useCanvasStore(
      (state) => state.arrangeGroupChildren,
    );
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const findNodePosition = useCanvasStore((state) => state.findNodePosition);
    const canReupload = isUploadNode(node) && Boolean(node.data.imageUrl);
    const ignoreAtTagWhenCopyingAndGenerating = useSettingsStore(
      (state) => state.ignoreAtTagWhenCopyingAndGenerating,
    );
    const [activeEditAction, setActiveEditAction] = useState<
      "repaint" | "erase" | "matting" | "crop" | "hd" | "outpaint"
    >("matting");
    const [activeGridAction, setActiveGridAction] =
      useState<GridActionKey | null>(null);
    const [isCopySuccess, setIsCopySuccess] = useState(false);
    const [isCopyTextSuccess, setIsCopyTextSuccess] = useState(false);
    const [isCopyErrorSuccess, setIsCopyErrorSuccess] = useState(false);
    const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );
    const copyTextFeedbackTimerRef = useRef<ReturnType<
      typeof setTimeout
    > | null>(null);
    const copyErrorFeedbackTimerRef = useRef<ReturnType<
      typeof setTimeout
    > | null>(null);
    // mainline canvas readonly state + "打开工作台" 入口需要的本地状态。
    const workbenchTarget = useMemo(() => {
      const raw = (node.data as { workbench_target?: unknown }).workbench_target;
      if (!raw || typeof raw !== "object") return null;
      const target = raw as { scope?: unknown; episode?: unknown; beat?: unknown };
      if (
        target.scope === "beat" &&
        typeof target.episode === "number" &&
        typeof target.beat === "number"
      ) {
        return { scope: "beat" as const, episode: target.episode, beat: target.beat };
      }
      return null;
    }, [node.data]);
    const [openingWorkbench, setOpeningWorkbench] = useState(false);
    // 片段重拍的 UI 态（展开/选区/提示词）只能放在组件层：下面 video 工具栏
    // 分支是个 IIFE 而不是组件，hook 写在里面会违反调用顺序。
    // 这三项都是纯交互态，不落 node.data——避免把临时选择写进节点 schema。
    const reshootVideoUrl =
      isVideoNode(node) && typeof node.data.videoUrl === "string"
        ? node.data.videoUrl
        : null;
    // 提交态落 node.data（见 handleVideoReshoot 的 finally），这里只是读。
    const isReshooting = Boolean(node.data.isReshooting);
    const isVideoSelection = isVideoNode(node);
    // 模型目录（module-level store，已预取）：重拍要用它的 maxDuration 提前拦区间。
    const reshootModels = useFreezoneVideoModels(
      isVideoSelection ? readUrl().project : null,
    );
    const [showReshootTimeline, setShowReshootTimeline] = useState(false);
    const [reshootRange, setReshootRange] = useState({ start: 0, end: 0 });
    const [reshootPrompt, setReshootPrompt] = useState("");
    const [isSuggestingPrompt, setIsSuggestingPrompt] = useState(false);
    const applyReshootEnhancedPrompt = useCallback((text: string) => {
      setReshootPrompt(text);
    }, []);
    const reshootPromptEnhance = usePromptEnhance(
      node.id,
      applyReshootEnhancedPrompt,
    );
    const reshootDurationSeconds = useVideoDurationSeconds(
      reshootVideoUrl,
      typeof node.data.durationMs === "number" ? node.data.durationMs : null,
    );
    const openReshootTimeline = useCallback(() => {
      setShowReshootTimeline(true);
      // 首次展开把选区铺满整条源视频；之后保留用户上次的选择。
      setReshootRange((prev) =>
        prev.end > prev.start
          ? prev
          : { start: 0, end: reshootDurationSeconds ?? 0 },
      );
    }, [reshootDurationSeconds]);
    // 「向后延长」：从片尾接着往下演，节点上放的是原片接到延长段之后的整段成片。
    // 交互上只要两件事——选生成多久、写一句要演什么。
    const [showContinuePanel, setShowContinuePanel] = useState(false);
    const [continueDurationSeconds, setContinueDurationSeconds] = useState(5);
    const [continuePrompt, setContinuePrompt] = useState("");
    const [isContinuing, setIsContinuing] = useState(false);

    /**
     * 「继续生成」的锚点区间：片尾往里收 0.1 秒的一小段。
     *
     * 必须**收在片内**：把 end 取成正好等于片长时，`ffmpeg -ss <片长>` 一帧都解不出来，
     * 抽帧器会以「没产出文件」失败（stderr 还是空的，极难定位 —— 实测就是这么挂的）。
     * 前端算出的 durationMs 与容器里的真实时长也会差零点几秒，往里收一点两头都躲开。
     *
     * 抽帧与推荐共用这一份，免得两个 handler 各写一套参数后悄悄漂移。
     */
    const continueAnchor = useMemo(() => {
      if (reshootDurationSeconds === null) return null;
      const margin = 0.1;
      const end = Math.max(margin, reshootDurationSeconds - margin);
      const start = Math.max(0, end - 0.2);
      return end > start ? { start, end } : null;
    }, [reshootDurationSeconds]);

    // 自动写提示词：面板一打开就跑一次「推荐」，把框填好。用户看到的是「已经
    // 写好的下一步」，而不是一个空框——空框等于把「该演什么」这个问题又丢回给
    // 用户。接的还是重拍那条推荐链路（视觉模型看锚点两帧 + 时长后写一句）。
    const [isSuggestingContinuePrompt, setIsSuggestingContinuePrompt] =
      useState(false);

    const handleSuggestContinuePrompt = useCallback(async () => {
      if (!isVideoNode(node)) return;
      const videoUrl = reshootVideoUrl;
      const projectId = readUrl().project;
      if (
        !videoUrl ||
        !projectId ||
        continueAnchor === null ||
        isSuggestingContinuePrompt
      ) {
        return;
      }
      const { start, end } = continueAnchor;
      setIsSuggestingContinuePrompt(true);
      try {
        const ref = await submitFreezoneVideoReshootSuggestPrompt(projectId, {
          sourceUrl: videoUrl,
          startSeconds: start,
          endSeconds: end,
          canvasId: readUrl().canvas ?? undefined,
          nodeId: node.id,
        });
        await awaitTaskCompletion(ref.task_key, projectId, {
          taskType: ref.task_type,
        });
        const { prompt } = await fetchFreezoneVideoReshootSuggestPromptResult(
          projectId,
          ref.job_id,
        );
        const trimmed = (prompt ?? "").trim();
        if (!trimmed) throw new Error(t("node.reshoot.suggestEmpty"));
        setContinuePrompt(trimmed);
      } catch (error) {
        if (isTaskPollTimeoutError(error)) {
          toast.error(t("node.reshoot.suggestDetached"));
        } else {
          toast.error(error instanceof Error ? error.message : String(error));
        }
      } finally {
        setIsSuggestingContinuePrompt(false);
      }
    }, [
      awaitTaskCompletion,
      continueAnchor,
      isSuggestingContinuePrompt,
      node,
      reshootVideoUrl,
      t,
    ]);

    const handleVideoContinue = useCallback(async () => {
      if (!isVideoNode(node)) return;
      const videoUrl = reshootVideoUrl;
      if (!videoUrl || continueAnchor === null || isContinuing) return;
      if (continuePrompt.trim().length === 0) return;
      const projectId = readUrl().project;
      if (!projectId) {
        console.error("[video-continue] no project in URL");
        return;
      }
      const previewImageUrl =
        typeof node.data.previewImageUrl === "string"
          ? node.data.previewImageUrl
          : null;
      const aspectRatio = continueAspectRatio(node.data);
      const continuationNodeId = addNode(
        CANVAS_NODE_TYPES.video,
        findNodePosition(node.id, 580, 380),
        {
          displayName: t("nodeToolbar.video.continueTitle"),
          videoUrl: null,
          previewImageUrl,
          aspectRatio,
          // 与重拍/greybox 同：产物由工具栏直接提交，抑制底部生成面板。
          referenceOnly: true,
          // 溯源标志：让「源视频 → 续写片段」这条入边按溯源边处理，不被素材上限拒掉
          // （agnes 系 referenceVideoMax=0，照那张表算这条边会被静默丢弃）。
          isContinuationNode: true,
          isGenerating: true,
        } as unknown as Parameters<typeof addNode>[2],
      );
      // 显式来源边：续写片段是从这条视频续出来的，画布上要看得出来。
      addEdge(node.id, continuationNodeId);
      setSelectedNode(continuationNodeId);
      setShowContinuePanel(false);
      setIsContinuing(true);
      try {
        // 抽尾帧。**不**走重拍那条链路：重拍是首尾帧锚定（把区间两端都钉死），
        // 拿它来续写只会得到「从几秒前那张图演到尾帧」的补段，不是往下续。
        // 续写要的是「从这一帧出发、结尾自由」= 首帧模式，所以这里自己抽帧、
        // 把尾帧当图片参考交给既有 omni-gen 生成。
        const frameBlob = await captureVideoFrameBlob(
          resolveImageDisplayUrl(videoUrl),
          continueAnchor.end,
        );
        const stamp = Date.now();
        const uploaded = await uploadFreezoneImage(
          projectId,
          new File([frameBlob], `continue-${stamp}.png`, { type: "image/png" }),
          `continue-${stamp}.png`,
        );
        const ref = await submitFreezoneVideoKeyframes(projectId, {
          prompt: continuePrompt.trim(),
          // 只钉首帧：首尾帧端点允许「只提供首帧」，那边就是自由结尾 —— 正是续写。
          firstFrameUrl: uploaded.url,
          aspectRatio,
          resolution:
            typeof node.data.resolution === "string" && node.data.resolution
              ? node.data.resolution
              : "720p",
          durationSeconds: continueDurationSeconds,
          genMode: "firstFrame",
          model: typeof node.data.model === "string" ? node.data.model : undefined,
          canvasId: readUrl().canvas ?? undefined,
          nodeId: continuationNodeId,
        });
        const completed = await awaitTaskCompletion(ref.task_key, projectId, {
          taskType: ref.task_type,
        });
        const result = (completed.result ?? {}) as Record<string, unknown>;
        const outputUrl =
          (typeof result.output_url === "string" && result.output_url) ||
          (typeof result.outputUrl === "string" && result.outputUrl) ||
          (typeof result.video_url === "string" && result.video_url) ||
          (typeof result.videoUrl === "string" && result.videoUrl) ||
          null;
        if (!outputUrl) throw new Error(t("node.reshoot.noResult"));
        // 延长段的第 0 秒就是锚点那一帧。原片收到锚点为止，延长段从 0.1 秒
        // 再接上，接缝处不会把同一帧停住。片太短时不裁，避免把新演的内容剪没。
        const extensionDuration = await probeVideoDuration(
          resolveImageDisplayUrl(outputUrl),
        ).catch(() => continueDurationSeconds);
        const joinSkip =
          extensionDuration > EXTEND_JOIN_SKIP_SECONDS + 0.25
            ? EXTEND_JOIN_SKIP_SECONDS
            : 0;
        const extensionEnd = extensionDuration;
        if (extensionEnd - joinSkip <= 0.05) {
          throw new Error(t("node.reshoot.noResult"));
        }
        const sourceEnd = continueAnchor.end;
        const composed = await submitFreezoneVideoCompose(projectId, {
          title: t("nodeToolbar.video.continueTitle"),
          canvasId: readUrl().canvas ?? undefined,
          preserveSourceSize: true,
          keepOriginalAudio: true,
          tracks: [
            {
              trackId: "video",
              kind: "video",
              items: [
                {
                  itemId: "source",
                  sourceUrl: videoUrl,
                  timelineStart: 0,
                  sourceStart: 0,
                  sourceEnd,
                },
                {
                  itemId: "extension",
                  sourceUrl: outputUrl,
                  timelineStart: sourceEnd,
                  sourceStart: joinSkip,
                  sourceEnd: extensionEnd,
                },
              ],
            },
          ],
        });
        await awaitTaskCompletion(composed.task_key, projectId, {
          taskType: composed.task_type,
        });
        const composedResult = await fetchFreezoneJobResult(
          projectId,
          "freezone_video_compose",
          composed.job_id,
        );
        if (!composedResult.url) throw new Error(t("node.reshoot.noResult"));
        updateNodeData(continuationNodeId, {
          videoUrl: composedResult.url,
          isGenerating: false,
          generationError: null,
        });
      } catch (error) {
        if (isTaskPollTimeoutError(error)) {
          console.warn("[video-continue] detached from a still-running job", {
            taskKey: error.taskKey,
            idleMs: error.idleMs,
          });
          updateNodeData(continuationNodeId, {
            isGenerating: false,
            generationError: t("nodeToolbar.video.continuePollTimeout"),
          });
        } else {
          console.error("[video-continue] failed", error);
          updateNodeData(continuationNodeId, {
            isGenerating: false,
            generationError:
              error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        setIsContinuing(false);
      }
    }, [
      addEdge,
      addNode,
      awaitTaskCompletion,
      continueAnchor,
      continueDurationSeconds,
      continuePrompt,
      findNodePosition,
      isContinuing,
      node,
      reshootVideoUrl,
      setSelectedNode,
      t,
      updateNodeData,
    ]);

    // 区间合法性：时长探测失败、区间为空、或终点越过源视频时长，一律不许提交。
    const reshootRangeInvalid =
      reshootDurationSeconds === null ||
      !(reshootRange.end > reshootRange.start) ||
      reshootRange.end > reshootDurationSeconds;
    // 模型 maxDuration：区间超上限时后端会拒（不静默截断），前端提前拦并报出
    // 具体数字。拿不到目录（isFallback）就不拦——后端那层已经有兜底。
    const reshootModelId =
      typeof node.data.model === "string" ? node.data.model : "";
    const reshootModelMaxDuration = useMemo(() => {
      if (!reshootModelId) return null;
      const match = reshootModels.models.find(
        (option) => option.id === reshootModelId || option.apiModel === reshootModelId,
      );
      const limit = match?.maxDuration;
      return typeof limit === "number" && limit > 0 ? limit : null;
    }, [reshootModels.models, reshootModelId]);
    const reshootOverMaxDuration =
      reshootModelMaxDuration !== null &&
      reshootRange.end - reshootRange.start > reshootModelMaxDuration;
    // 模型 minDuration：多数模型的 seconds 有硬下限（agnes/seedance/MiniMax 都是
    // 4s），区间短于下限时上游直接 400。生成段时长不可能小于该下限，所以提前拦。
    const reshootModelMinDuration = useMemo(() => {
      if (!reshootModelId) return null;
      const match = reshootModels.models.find(
        (option) => option.id === reshootModelId || option.apiModel === reshootModelId,
      );
      const limit = match?.minDuration;
      return typeof limit === "number" && limit > 0 ? limit : null;
    }, [reshootModels.models, reshootModelId]);
    const reshootUnderMinDuration =
      reshootModelMinDuration !== null &&
      reshootRange.end - reshootRange.start < reshootModelMinDuration;

    // 「继续生成」生成多久：与重拍用同一份模型时长边界（同一个模型的同一个限制），
    // 目录读不到时给 4~12 秒的保守区间——后端还会再判一次，这里只保证滑杆有范围。
    const CONTINUE_FALLBACK_MIN_SECONDS = 4;
    const CONTINUE_FALLBACK_MAX_SECONDS = 12;
    const continueMinSeconds = reshootModelMinDuration ?? CONTINUE_FALLBACK_MIN_SECONDS;
    const continueMaxSeconds = Math.max(
      continueMinSeconds,
      reshootModelMaxDuration ?? CONTINUE_FALLBACK_MAX_SECONDS,
    );
    // 首尾帧锚定是片段重拍唯一的生成路径：模型没声明 first_last_frame 就没得可跑。
    // 目录没加载出来（找不到匹配项）时不拦——后端有同一道校验兜底，别在这里
    // 因为列表还没到就把入口锁死。
    // 提成单个候选的判定函数：入口按钮用当前模型，模型选择器要用它逐个置灰选项。
    const reshootModelUnsupportedFor = useCallback(
      (option: ModelOption) => {
        const modes = option.supportedModes;
        // 没配 supportedModes 的老条目不拦：那份数据是后加的，缺省时以目录为准的
        // 前端判定无从下手。
        if (!Array.isArray(modes) || modes.length === 0) return false;
        return !modes.includes("first_last_frame");
      },
      [],
    );
    const reshootModelUnsupported = useMemo(() => {
      if (!reshootModelId) return false;
      const match = reshootModels.models.find(
        (option) => option.id === reshootModelId || option.apiModel === reshootModelId,
      );
      if (!match) return false;
      return reshootModelUnsupportedFor(match);
    }, [reshootModels.models, reshootModelId, reshootModelUnsupportedFor]);
    // 用统一 helper 解析节点当前图片源，避免每种图片节点各写一套判断。
    const imageSource = useMemo(() => resolveNodeSourceImageUrl(node), [node]);
    const canHandleImage = Boolean(imageSource);
    // commit 按钮现在覆盖所有媒体节点(图像/视频/音频/3GS)——只要能从节点推断出
    // 可提交的媒体 url 就显示。具体提交目标在 CommitDialog 里按 mediaType 处理。
    const canCommitNode = useMemo(
      () => Boolean(deriveNodeDropInfo(node)?.sourceUrl),
      [node],
    );
    const protectedProjectionKey =
      isProtectedProjectionGroupNode(node) &&
      typeof node.data.projection_key === "string" &&
      node.data.projection_key.trim()
        ? node.data.projection_key.trim()
        : null;
    const projectionStatus = useCanvasProjectionStatus(protectedProjectionKey);
    const projectionIsStale = projectionStatus?.stale === true;
    const extractableBeatContext = useMemo(() => beatContextFromNode(node), [node]);
    const canExposeGenerationError =
      isExportImageNode(node) || isImageGenNode(node);
    const generationError =
      canExposeGenerationError &&
      typeof (node.data as { generationError?: unknown }).generationError ===
        "string"
        ? (
            (node.data as { generationError?: string }).generationError ?? ""
          ).trim()
        : "";
    const generationErrorDetails =
      canExposeGenerationError &&
      typeof (node.data as { generationErrorDetails?: unknown })
        .generationErrorDetails === "string"
        ? (
            (node.data as { generationErrorDetails?: string })
              .generationErrorDetails ?? ""
          ).trim()
        : "";
    const canCopyGenerationError =
      canExposeGenerationError && generationError.length > 0;
    const generationErrorReport = useMemo(
      () => {
        // ImageGen keeps the exact pre-normalization error in details: copy it
        // verbatim. Export-image nodes retain their richer diagnostic report.
        if (isImageGenNode(node)) {
          return generationErrorDetails || generationError;
        }
        return buildGenerationErrorReport({
          errorMessage: generationError || t("ai.error"),
          errorDetails: generationErrorDetails || undefined,
          context: (node.data as { generationDebugContext?: unknown })
            .generationDebugContext,
        });
      },
      [generationError, generationErrorDetails, node, t],
    );

    const closeDownloadMenu = useCallback(() => {}, []);

    const resolveToolLabel = useCallback(
      (toolType: NodeToolType) => {
        if (toolType === NODE_TOOL_TYPES.crop) {
          return t("tool.crop");
        }
        if (toolType === NODE_TOOL_TYPES.annotate) {
          return t("tool.annotate");
        }
        if (toolType === NODE_TOOL_TYPES.splitStoryboard) {
          return t("tool.split");
        }
        return "";
      },
      [t],
    );

    // hover 即展开的编辑/九宫格下拉（打开时顺手关掉下载浮层）。
    const editMenu = useHoverMenu(closeDownloadMenu);
    const gridMenu = useHoverMenu(closeDownloadMenu);

    // 选中可抠图的节点时,在浏览器空闲间隙预热抠图管线,把一次性的模型/Worker/
    // WASM 初始化挪到用户点击「抠图」之前,避免点击瞬间主线程卡 2~3s。整段只跑一次。
    useEffect(() => {
      if (!canHandleImage) {
        return;
      }
      const win = window as unknown as {
        requestIdleCallback?: (cb: () => void) => number;
        cancelIdleCallback?: (handle: number) => void;
      };
      if (typeof win.requestIdleCallback === "function") {
        const handle = win.requestIdleCallback(() => {
          preloadMatteWorker();
        });
        return () => {
          win.cancelIdleCallback?.(handle);
        };
      }
      const timer = setTimeout(() => {
        preloadMatteWorker();
      }, 1200);
      return () => {
        clearTimeout(timer);
      };
    }, [canHandleImage]);

    useEffect(() => {
      return () => {
        if (copyFeedbackTimerRef.current) {
          clearTimeout(copyFeedbackTimerRef.current);
        }
        if (copyTextFeedbackTimerRef.current) {
          clearTimeout(copyTextFeedbackTimerRef.current);
        }
        if (copyErrorFeedbackTimerRef.current) {
          clearTimeout(copyErrorFeedbackTimerRef.current);
        }
      };
    }, []);

    const handleCopyImage = useCallback(async () => {
      if (!imageSource) {
        return;
      }

      setIsCopySuccess(true);
      if (copyFeedbackTimerRef.current) {
        clearTimeout(copyFeedbackTimerRef.current);
      }
      copyFeedbackTimerRef.current = setTimeout(() => {
        setIsCopySuccess(false);
        copyFeedbackTimerRef.current = null;
      }, 1100);

      try {
        await copyImageSourceToClipboard(imageSource);
      } catch (error) {
        console.error("Failed to copy image to clipboard", error);
      }
    }, [imageSource]);

    const storyboardText = useMemo(() => {
      if (isStoryboardGen) {
        return node.data.frames
          .map((frame, index) =>
            t("nodeToolbar.storyboardLine", {
              index: String(index + 1).padStart(2, "0"),
              content: sanitizeStoryboardText(
                frame.description ?? "",
                ignoreAtTagWhenCopyingAndGenerating,
              ),
            }),
          )
          .join("\n");
      }
      if (isStoryboardSplit) {
        const orderedFrames = [...node.data.frames].sort(
          (a, b) => a.order - b.order,
        );
        return orderedFrames
          .map((frame, index) =>
            t("nodeToolbar.storyboardLine", {
              index: String(index + 1).padStart(2, "0"),
              content: sanitizeStoryboardText(
                frame.note ?? "",
                ignoreAtTagWhenCopyingAndGenerating,
              ),
            }),
          )
          .join("\n");
      }
      return "";
    }, [
      ignoreAtTagWhenCopyingAndGenerating,
      isStoryboardGen,
      isStoryboardSplit,
      node,
      t,
      i18n.language,
    ]);

    const handleCopyStoryboardText = useCallback(async () => {
      if (!storyboardText) {
        return;
      }

      setIsCopyTextSuccess(true);
      if (copyTextFeedbackTimerRef.current) {
        clearTimeout(copyTextFeedbackTimerRef.current);
      }
      copyTextFeedbackTimerRef.current = setTimeout(() => {
        setIsCopyTextSuccess(false);
        copyTextFeedbackTimerRef.current = null;
      }, 1100);

      try {
        await navigator.clipboard.writeText(storyboardText);
      } catch (error) {
        console.error("Failed to copy storyboard text", error);
      }
    }, [storyboardText]);

    const handleCopyGenerationError = useCallback(async () => {
      if (!canCopyGenerationError) {
        return;
      }

      setIsCopyErrorSuccess(true);
      if (copyErrorFeedbackTimerRef.current) {
        clearTimeout(copyErrorFeedbackTimerRef.current);
      }
      copyErrorFeedbackTimerRef.current = setTimeout(() => {
        setIsCopyErrorSuccess(false);
        copyErrorFeedbackTimerRef.current = null;
      }, 1100);

      try {
        await navigator.clipboard.writeText(generationErrorReport);
      } catch (error) {
        console.error("Failed to copy generation error report", error);
      }
    }, [canCopyGenerationError, generationErrorReport]);

    const resolveImageDownloadFilename = useCallback(() => {
      const sourceFileName =
        typeof (node.data as { sourceFileName?: unknown }).sourceFileName === "string"
          ? ((node.data as { sourceFileName?: string }).sourceFileName ?? "").trim()
          : "";
      if (sourceFileName) {
        return sourceFileName;
      }
      const displayName =
        typeof (node.data as { displayName?: unknown }).displayName === "string"
          ? ((node.data as { displayName?: string }).displayName ?? "").trim()
          : "";
      if (displayName) {
        return `${displayName}.png`;
      }
      return `node-${node.id}.png`;
    }, [node.data, node.id]);

    const handleDownloadSaveAs = useCallback(async () => {
      if (!imageSource) {
        return;
      }
      try {
        await downloadUrlAsFile(
          resolveImageDisplayUrl(imageSource),
          resolveImageDownloadFilename(),
        );
        closeDownloadMenu();
      } catch (error) {
        console.error("Failed to download image", error);
      }
    }, [closeDownloadMenu, imageSource, resolveImageDownloadFilename]);

    // 以下符号被暂时隐藏的 toolbar 按钮使用，保留代码不删除：
    // - Sparkles 图标用于 AI 改图按钮
    // - Copy 图标用于复制按钮
    // - RefreshCw 图标 / canReupload 用于"重新上传"按钮
    // - handleCreateAiEditNode / handleCopyImage / isCopySuccess 同上
    // 取消注释相关 JSX 后这些 void 也可以一起删掉
    void Sparkles;
    void RefreshCw;
    void canReupload;
    void handleCopyImage;
    void isCopySuccess;

    const handleCreateAiEditNode = useCallback(() => {
      if (!imageSource) {
        return;
      }
      closeDownloadMenu();
      const nodeWidth =
        typeof node.measured?.width === "number"
          ? node.measured.width
          : typeof node.width === "number"
            ? node.width
            : DEFAULT_NODE_WIDTH;
      const nextNodeId = addNode(
        CANVAS_NODE_TYPES.imageEdit,
        {
          x: node.position.x + nodeWidth + 96,
          y: node.position.y,
        },
        {
          displayName: t("nodeToolbar.aiEdit"),
          prompt: "",
          requestAspectRatio: "auto",
          generationMode: "image_reference",
        },
      );
      addEdge(node.id, nextNodeId);
      setSelectedNode(nextNodeId);
    }, [
      addEdge,
      addNode,
      closeDownloadMenu,
      imageSource,
      node,
      setSelectedNode,
      t,
    ]);
    // 同上：保留 handleCreateAiEditNode 等待恢复 AI 改图按钮
    void handleCreateAiEditNode;

    const handleCreatePresetEditNode = useCallback(
      (displayKey: "repaint" | "erase" | "matting", presetPrompt: string) => {
        if (!imageSource) {
          return;
        }
        closeDownloadMenu();
        const nodeWidth =
          typeof node.measured?.width === "number"
            ? node.measured.width
            : typeof node.width === "number"
              ? node.width
              : DEFAULT_NODE_WIDTH;
        // preset_managed parent nodes spawn user_spawned imageEdit children
        // via inheritMainlineFields — they carry slot_target/mainline_context/
        // committed_slot_url so Push can land back on the original canonical.
        const initialData = inheritMainlineFields(
          { data: node.data as Record<string, unknown> },
          {
            displayName: t(`nodeToolbar.${displayKey}`),
            prompt: presetPrompt,
            requestAspectRatio: "auto",
            generationMode: "image_reference",
          },
        );
        const nextNodeId = addNode(
          CANVAS_NODE_TYPES.imageEdit,
          {
            x: node.position.x + nodeWidth + 96,
            y: node.position.y,
          },
          initialData as unknown as Parameters<typeof addNode>[2],
        );
        addEdge(node.id, nextNodeId);
        setSelectedNode(nextNodeId);
      },
      [
        addEdge,
        addNode,
        closeDownloadMenu,
        imageSource,
        node,
        setSelectedNode,
        t,
      ],
    );
    // 擦除已改为 EraseOverlay（蒙版 + 重绘接口），不再新建 imageEdit 预设节点；
    // 保留此 helper 以便将来其它预设改图入口复用。
    void handleCreatePresetEditNode;

    const handleMatteImage = useCallback(() => {
      if (!imageSource) {
        return;
      }
      const projectId = readUrl().project;
      if (!projectId) {
        console.warn(
          "[matte] no project_id in URL (?p=<project_id>) — cannot persist matted PNG",
        );
        return;
      }
      closeDownloadMenu();

      const sourceAspectRatio =
        typeof (node.data as { aspectRatio?: unknown }).aspectRatio === "string"
          ? ((node.data as { aspectRatio?: string }).aspectRatio ?? "1:1")
          : "1:1";
      const position = findNodePosition(
        node.id,
        EXPORT_RESULT_NODE_DEFAULT_WIDTH,
        EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
      );
      // Same inheritance contract as the spawn-style overlays — matting
      // produces a user_spawned exportImage child that still represents
      // the same canonical slot at Push time.
      const matteInitialData = inheritMainlineFields(
        { data: node.data as Record<string, unknown> },
        {
          displayName: t("nodeToolbar.matting"),
          imageUrl: null,
          previewImageUrl: null,
          aspectRatio: sourceAspectRatio,
          resultKind: "matte",
          isGenerating: true,
          generationStartedAt: Date.now(),
        },
      );
      const nextNodeId = addNode(
        CANVAS_NODE_TYPES.exportImage,
        position,
        matteInitialData as unknown as Parameters<typeof addNode>[2],
      );
      addEdge(node.id, nextNodeId);
      setSelectedNode(nextNodeId);

      const sourceUrl = imageSource;
      void (async () => {
        try {
          const sourceResp = await fetch(sourceUrl);
          if (!sourceResp.ok) {
            throw new Error(`fetch source failed: ${sourceResp.status}`);
          }
          const sourceBlob = await sourceResp.blob();
          // 整段去背在自建 Worker 内执行(见 matteClient / matteWorker):无论 WebGPU
          // 是否可用,主线程都不阻塞,点击抠图后画布保持流畅。
          const mattedBlob = await matteInWorker(sourceBlob);
          const filename = `matte-${node.id}-${Date.now()}.png`;
          const uploaded = await uploadFreezoneImage(
            projectId,
            mattedBlob,
            filename,
          );
          updateNodeData(nextNodeId, {
            imageUrl: uploaded.url,
            previewImageUrl: uploaded.url,
            isGenerating: false,
            generationStartedAt: null,
            generationError: null,
            generationErrorDetails: null,
          });
        } catch (error) {
          console.error("[matte] failed", error);
          const message =
            error instanceof Error ? error.message : String(error);
          updateNodeData(nextNodeId, {
            isGenerating: false,
            generationStartedAt: null,
            generationError: message,
            generationErrorDetails: message,
          });
        }
      })();
    }, [
      addEdge,
      addNode,
      closeDownloadMenu,
      findNodePosition,
      imageSource,
      node,
      setSelectedNode,
      t,
      updateNodeData,
    ]);

    const handleOpenWorkbench = useCallback(() => {
      if (!workbenchTarget || openingWorkbench) {
        return;
      }
      const projectId = readUrl().project;
      if (!projectId) {
        console.warn("[freezone] no project_id in URL (?p=<project_id>)");
        return;
      }
      setOpeningWorkbench(true);
      void (async () => {
        try {
          await openPresetProjectionInMyCanvas(projectId, {
            scope: workbenchTarget.scope,
            episode: workbenchTarget.episode,
            beat: workbenchTarget.beat,
            primary_slot: "render",
          });
        } catch (error) {
          console.error("[freezone] open workbench failed", error);
        } finally {
          setOpeningWorkbench(false);
        }
      })();
    }, [openingWorkbench, workbenchTarget]);

    // 提示词推荐：让视觉模型看着首尾两帧联想一段。结果只填进输入框，不自动提交
    // ——模型看不到两帧之间原来发生了什么，推荐值必须经用户过目。
    // 失败时不清空用户已写的内容：推荐是"帮忙"，不是"接管"。
    const handleSuggestReshootPrompt = useCallback(async () => {
      const videoUrl = reshootVideoUrl;
      const projectId = readUrl().project;
      if (!videoUrl || !projectId || isSuggestingPrompt) return;
      const start = reshootRange.start;
      const end =
        reshootRange.end > reshootRange.start
          ? reshootRange.end
          : (reshootDurationSeconds ?? 0);
      if (!(end > start)) {
        console.warn("[video-reshoot] suggest prompt: empty range");
        return;
      }
      setIsSuggestingPrompt(true);
      try {
        const ref = await submitFreezoneVideoReshootSuggestPrompt(projectId, {
          sourceUrl: videoUrl,
          startSeconds: start,
          endSeconds: end,
          canvasId: readUrl().canvas ?? undefined,
          nodeId: node.id,
        });
        await awaitTaskCompletion(ref.task_key, projectId, {
          taskType: ref.task_type,
        });
        // SSE 的 result 只带 output_format；提示词文本要走下面那个 job-result
        // 端点，与 TextAnnotationNode 的反推同一套路。
        const { prompt } = await fetchFreezoneVideoReshootSuggestPromptResult(
          projectId,
          ref.job_id,
        );
        const trimmed = (prompt ?? "").trim();
        if (!trimmed) {
          throw new Error(t("node.reshoot.suggestEmpty"));
        }
        console.info("[video-reshoot] prompt suggested", { jobId: ref.job_id });
        setReshootPrompt(trimmed);
      } catch (error) {
        // 脱离监听 ≠ 失败：任务可能还在后台跑，结果仍会落到磁盘上。
        // 这里不弹「仍在后台继续」那种通用文案——它对不上本场景：推荐是一次
        // 性的、没有节点句柄可以回填，用户要知道的是「去哪取」。指到任务中心。
        if (isTaskPollTimeoutError(error)) {
          console.warn("[video-reshoot] suggest prompt detached", {
            taskKey: error.taskKey,
          });
          toast.error(t("node.reshoot.suggestDetached"));
        } else {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[video-reshoot] suggest prompt failed", error);
          toast.error(message);
        }
      } finally {
        setIsSuggestingPrompt(false);
      }
      // readUrl 是模块级纯函数（不随渲染变），不进依赖数组。
    }, [
      isSuggestingPrompt,
      node.id,
      reshootDurationSeconds,
      reshootRange.end,
      reshootRange.start,
      reshootVideoUrl,
      t,
    ]);

    // 「片段重拍」：提交一次，派生两个下游节点——「重拍片段」放区间新生成的
    // 片段（试看用），「拼接整片」放 前段+新段+后段 的整片（后端已拼好）。
    // 范式仿 handleVideoGreybox：先建节点让用户立刻看到占位，再 awaitTaskCompletion
    // 回填；失败时错误落在两个派生节点上（走 video 节点既有的 generationError 渲染）。
    const handleVideoReshoot = useCallback(async () => {
      const videoUrl = reshootVideoUrl;
      if (!isVideoNode(node) || !videoUrl || node.data.isReshooting) {
        return;
      }
      const projectId = readUrl().project;
      if (!projectId) {
        console.error("[video-reshoot] no project in URL");
        return;
      }
      const span = reshootDurationSeconds ?? 0;
      const start = reshootRange.start;
      const end = reshootRange.end > reshootRange.start ? reshootRange.end : span;
      if (!(end > start)) {
        console.warn("[video-reshoot] empty range, refusing to submit");
        return;
      }
      const previewImageUrl =
        typeof node.data.previewImageUrl === "string"
          ? node.data.previewImageUrl
          : null;
      const aspectRatio =
        typeof node.data.aspectRatio === "string" ? node.data.aspectRatio : "16:9";
      const clipPosition = findNodePosition(node.id, 580, 380);
      // 「整片」固定落在「片段」正下方 420px（380 节点高 + 40 间隙）——不能
      // 再调一次 findNodePosition：那时片段节点已入列，避让算法会把整片绕到
      // 旁边一列，两个相关产物就看得不像一组了。
      const fullPosition = { x: clipPosition.x, y: clipPosition.y + 420 };
      const clipNodeId = addNode(
        CANVAS_NODE_TYPES.video,
        clipPosition,
        {
          displayName: t("node.reshoot.clipTitle"),
          videoUrl: null,
          previewImageUrl,
          aspectRatio,
          // 与 greybox 同：抑制底部生成面板，本节点由工具栏直接提交。
          referenceOnly: true,
          isReshootNode: true,
          reshootSourceUrl: videoUrl,
          isGenerating: true,
        } as unknown as Parameters<typeof addNode>[2],
      );
      const fullNodeId = addNode(
        CANVAS_NODE_TYPES.video,
        fullPosition,
        {
          displayName: t("node.reshoot.fullTitle"),
          videoUrl: null,
          previewImageUrl,
          aspectRatio,
          referenceOnly: true,
          isReshootNode: true,
          reshootSourceUrl: videoUrl,
          isGenerating: true,
        } as unknown as Parameters<typeof addNode>[2],
      );
      addEdge(node.id, clipNodeId);
      addEdge(node.id, fullNodeId);
      // 选中「拼接整片」——它才是用户最终要的那条产物。
      onNodesChange([
        { id: node.id, type: "select", selected: false },
        { id: fullNodeId, type: "select", selected: true },
      ]);
      setSelectedNode(fullNodeId);
      setShowReshootTimeline(false);
      // 提交态落 node.data 而不是组件 state：任务跑几十秒，期间用户很可能
      // 点去别的节点把工具条卸载了，落组件 state 会让 loading 指示静默消失。
      updateNodeData(node.id, { isReshooting: true });
      const identityCalls = "identityCalls" in node.data ? node.data.identityCalls : undefined;
      if (Array.isArray(identityCalls) && identityCalls.length > 0) {
        toast.info(t("node.identityCall.reshootKeepsFrames"));
      }
      try {
        const ref = await submitFreezoneVideoReshoot(projectId, {
          sourceUrl: videoUrl,
          startSeconds: start,
          endSeconds: end,
          prompt: reshootPrompt.trim() || undefined,
          // 带节点上已选的模型：不传的话后端回落到自己的默认后端，用户在视频节点
          // 面板里挑的那个模型就白挑了。
          model: typeof node.data.model === "string" ? node.data.model : undefined,
        });
        const completed = await awaitTaskCompletion(ref.task_key, projectId, {
          taskType: ref.task_type,
        });
        console.info("[video-reshoot] task completed", completed.result);
        const result = (completed.result ?? {}) as Record<string, unknown>;
        const clipUrl =
          (typeof result.clip_url === "string" && result.clip_url) ||
          (typeof result.clipUrl === "string" && result.clipUrl) ||
          null;
        const fullUrl =
          (typeof result.output_url === "string" && result.output_url) ||
          (typeof result.outputUrl === "string" && result.outputUrl) ||
          (typeof result.video_url === "string" && result.video_url) ||
          (typeof result.videoUrl === "string" && result.videoUrl) ||
          null;
        if (!clipUrl || !fullUrl) {
          throw new Error(t("node.reshoot.noResult"));
        }
        updateNodeData(clipNodeId, {
          videoUrl: clipUrl,
          isGenerating: false,
          generationError: null,
        });
        updateNodeData(fullNodeId, {
          videoUrl: fullUrl,
          isGenerating: false,
          generationError: null,
        });
      } catch (error) {
        // 脱离监听 ≠ 失败：任务可能仍在后台跑，结果去任务中心取。两个派生
        // 节点都不能一直转圈，落一条提示后停掉 loading。
        if (isTaskPollTimeoutError(error)) {
          console.warn("[video-reshoot] detached from a still-running job", {
            taskKey: error.taskKey,
            idleMs: error.idleMs,
          });
          notifyTaskStillRunning(t);
          for (const id of [clipNodeId, fullNodeId]) {
            updateNodeData(id, {
              isGenerating: false,
              generationError: t("errorDialog.stillRunningMessage"),
            });
          }
        } else {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[video-reshoot] failed", error);
          for (const id of [clipNodeId, fullNodeId]) {
            updateNodeData(id, { isGenerating: false, generationError: message });
          }
        }
      } finally {
        updateNodeData(node.id, { isReshooting: false });
      }
    }, [
      addNode,
      addEdge,
      findNodePosition,
      node,
      onNodesChange,
      reshootDurationSeconds,
      reshootPrompt,
      reshootRange,
      reshootVideoUrl,
      setSelectedNode,
      t,
      updateNodeData,
    ]);

    const handleEnsureBeatContextNode = useCallback(
      (event: ReactMouseEvent) => {
        event.stopPropagation();
        if (!extractableBeatContext) return;

        const store = useCanvasStore.getState();
        const existing = store.nodes.find((candidate) =>
          extractMainlineContextsFromNode(candidate).some((ctx) =>
            sameBeatContext(ctx, extractableBeatContext),
          ),
        );
        if (existing?.id) {
          setSelectedNode(String(existing.id));
          requestFocusNode(String(existing.id));
          return;
        }

        const nodeWidth =
          node.measured?.width ??
          (typeof node.width === "number" ? node.width : DEFAULT_NODE_WIDTH);
        const contextNodeId = addNode(
          CANVAS_NODE_TYPES.beatContext,
          {
            x: node.position.x + nodeWidth + 80,
            y: node.position.y,
          },
          beatContextNodeData(extractableBeatContext, t),
        );
        setSelectedNode(contextNodeId);
        requestFocusNode(contextNodeId);
      },
      [
        addNode,
        extractableBeatContext,
        node.measured?.width,
        node.position.x,
        node.position.y,
        node.width,
        requestFocusNode,
        setSelectedNode,
        t,
      ],
    );

    // Per-node mainline lock decision: only preset-managed nodes are locked.
    // Ordinary/user-created nodes stay editable even on a mainline preset canvas.
    //
    // NB: we deliberately do NOT early-return on locked. preset_managed
    // nodes still need access to **spawn-style** edit tools (relight /
    // multi-dim / crop / repaint / outpaint) — those produce new
    // user_spawned children that carry the inherited slot_target and Push
    // back to the same canonical. The lock affects only:
    //   - mutate-in-place tools (Rotate, the HD/upscale entry inside the
    //     edit-menu dropdown) — they'd violate canonical immutability;
    // The leading "主线投影 · 锁定" pill (+ optional "打开工作台" button)
    // signals the state visually so the user knows why some chips are
    // missing.
    const _toolbarFlags = nodeMainlineFlags(node);
    const isPresetLocked = _toolbarFlags.isPresetManaged;

    // 分镜组 has its own dedicated toolbar (aspect / grid / index / convert /
    // ungroup) — render it instead of the generic node toolbar.
    if (isStoryboardGroupNode(node)) {
      return <StoryboardGroupToolbar node={node} />;
    }

    return (
      <>
        <ReactFlowNodeToolbar
          nodeId={node.id}
          isVisible
          position={NODE_TOOLBAR_POSITION}
          align={NODE_TOOLBAR_ALIGN}
          offset={NODE_TOOLBAR_OFFSET}
          className={`${NODE_TOOLBAR_CLASS} !w-max`}
        >
          <ZoomScaledToolbar origin="bottom center" mode="counter" counterMax={1}>
          {/* 节点激活时，顶部菜单从节点上沿淡入+轻微上滑浮现（而非生硬地直接出现），
              与下方操作区的入场动画呼应。motion-reduce 下退化为无动画。
              按钮按内容排成一行，不跟节点等宽，避免中文折行。 */}
          <UiPanel className="flex w-max max-w-none flex-nowrap animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 items-center gap-1.5 rounded-[18px] !border-white/10 !bg-[#242426]/95 px-2 py-1.5 text-sm shadow-[0_10px_24px_rgba(0,0,0,0.28)] backdrop-blur-2xl duration-200 ease-out motion-reduce:animate-none [&_svg]:h-4 [&_svg]:w-4">
            {/* Mainline lock indicator — shown as a leading pill when the
                node is preset-managed (or canvas-level fallback applies).
                The chips below remain visible for spawn-style edits; the
                mutate-style chips are gated separately so
                the user can still spawn user_spawned children from a
                canonical slot but cannot violate its immutability. */}
            {isPresetLocked && (
              <span
                key="mainline-lock-pill"
                className="rounded-full bg-amber-500/15 px-3 py-1.5 text-sm text-amber-100"
              >
                {t("canvas.nodeToolbar.mainlineLocked")}
              </span>
            )}
            {isPresetLocked && workbenchTarget && (
              <UiChipButton
                key="mainline-open-workbench"
                className={`h-9 ${TOOLBAR_BUTTON_RADIUS_CLASS} border-cyan-300/45 bg-cyan-400/12 px-3 text-sm text-cyan-100 hover:bg-cyan-300/20 disabled:opacity-50`}
                disabled={openingWorkbench}
                onClick={(event) => {
                  event.stopPropagation();
                  handleOpenWorkbench();
                }}
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {openingWorkbench
                  ? t("canvas.nodeToolbar.openingWorkbench")
                  : t("canvas.nodeToolbar.openWorkbench")}
              </UiChipButton>
            )}
            {extractableBeatContext && node.type !== CANVAS_NODE_TYPES.beatContext && (
              <UiChipButton
                key="extract-beat-context"
                className={TOOLBAR_TEXT_BUTTON_CLASS}
                title={t("canvas.nodeToolbar.beatContextHint")}
                onClick={handleEnsureBeatContextNode}
              >
                <Link2 className="h-3.5 w-3.5" />
                {t("canvas.nodeToolbar.beatContext")}
              </UiChipButton>
            )}
            {/* AI 改图按钮暂时隐藏（保留代码，等需求恢复时取消注释）
        {!isImageEdit && canHandleImage && (
          <UiChipButton
            key="image-ai-edit"
            className={`h-9 ${TOOLBAR_BUTTON_RADIUS_CLASS} border-[rgb(var(--accent-rgb)/0.55)] bg-[rgb(var(--accent-rgb)/0.18)] px-3 text-sm text-accent hover:bg-[rgb(var(--accent-rgb)/0.28)]`}
            onClick={(event) => {
              event.stopPropagation();
              handleCreateAiEditNode();
            }}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {t('nodeToolbar.aiEdit')}
          </UiChipButton>
        )}
        */}
            {!isImageEdit && canHandleImage && (
              <UiChipButton
                key="image-panorama"
                className={TOOLBAR_TEXT_BUTTON_CLASS}
                onClick={(event) => {
                  event.stopPropagation();
                  closeDownloadMenu();
                  onOpenScene360(node.id);
                }}
              >
                <Globe2 className="h-3.5 w-3.5" />
                {t("nodeToolbar.panorama")}
              </UiChipButton>
            )}
            {!isImageEdit && canHandleImage && (
              <UiChipButton
                key="image-multi-dimension"
                className={TOOLBAR_TEXT_BUTTON_CLASS}
                onClick={(event) => {
                  event.stopPropagation();
                  closeDownloadMenu();
                  onOpenMultiAngleEditor(node.id);
                }}
              >
                <Boxes className="h-3.5 w-3.5" />
                {t("nodeToolbar.multiDimension")}
              </UiChipButton>
            )}
            {!isImageEdit && canHandleImage && (
              <UiChipButton
                key="image-relight"
                className={TOOLBAR_TEXT_BUTTON_CLASS}
                onClick={(event) => {
                  event.stopPropagation();
                  closeDownloadMenu();
                  onOpenLightEditor(node.id);
                }}
              >
                <Lightbulb className="h-3.5 w-3.5" />
                {t("nodeToolbar.relight")}
              </UiChipButton>
            )}
            {!isImageEdit &&
              canHandleImage &&
              tools.some((tool) => tool.type === NODE_TOOL_TYPES.crop) &&
              (() => {
                const editActions = [
                  {
                    key: "repaint" as const,
                    icon: Wand2,
                    label: t("nodeToolbar.repaint"),
                    run: () => onOpenRedraw(node.id),
                  },
                  {
                    key: "erase" as const,
                    icon: Eraser,
                    label: t("nodeToolbar.erase"),
                    run: () => {
                      closeDownloadMenu();
                      onOpenErase(node.id);
                    },
                  },
                  {
                    key: "matting" as const,
                    icon: Scissors,
                    label: t("nodeToolbar.matting"),
                    run: () => handleMatteImage(),
                  },
                  {
                    key: "crop" as const,
                    icon: Crop,
                    label: t("tool.crop"),
                    run: () =>
                      canvasEventBus.publish("tool-dialog/open", {
                        nodeId: node.id,
                        toolType: NODE_TOOL_TYPES.crop,
                      }),
                  },
                  {
                    key: "hd" as const,
                    icon: ImageUpscale,
                    label: t("nodeToolbar.hd"),
                    run: () => {
                      closeDownloadMenu();
                      onOpenUpscale(node.id);
                    },
                  },
                  {
                    key: "outpaint" as const,
                    icon: Expand,
                    label: t("nodeToolbar.outpaint"),
                    run: () => {
                      closeDownloadMenu();
                      onOpenOutpaint(node.id);
                    },
                  },
                ]
                  // HD/upscale mutates source in place
                  // (UpscaleEditorOverlay → updateNodeData(node.id, ...))
                  // so hide it from the edit-menu on preset_managed nodes.
                  // Repaint/Erase/Matting/Crop/Outpaint all spawn child
                  // nodes via inheritMainlineFields, safe to keep.
                  .filter((a) => !(isPresetLocked && a.key === "hd"));
                const active =
                  editActions.find((a) => a.key === activeEditAction) ??
                  editActions[Math.min(2, editActions.length - 1)];
                const ActiveIcon = active.icon;
                return (
                  <DropdownMenu {...editMenu.rootProps}>
                    <DropdownMenuTrigger asChild>
                      <UiChipButton
                        key="image-edit-menu"
                        className={TOOLBAR_TEXT_BUTTON_CLASS}
                        onClick={(event) => event.stopPropagation()}
                        {...editMenu.hoverProps}
                      >
                        <ActiveIcon className="h-3.5 w-3.5" />
                        {active.label}
                        <ChevronDown className="h-3 w-3" />
                      </UiChipButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="start"
                      sideOffset={6}
                      className={`${TOOLBAR_MENU_CONTENT_CLASS} min-w-[180px]`}
                      onClick={(event) => event.stopPropagation()}
                      {...editMenu.hoverProps}
                    >
                      {editActions.map((action) => {
                        const Icon = action.icon;
                        return (
                          <DropdownMenuItem
                            key={action.key}
                            className={TOOLBAR_MENU_ITEM_CLASS}
                            onSelect={() => {
                              setActiveEditAction(action.key);
                              action.run();
                            }}
                          >
                            <Icon className="h-4 w-4" />
                            {action.label}
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuContent>
                  </DropdownMenu>
                );
              })()}
            {!isImageEdit &&
              canHandleImage &&
              (() => {
                const gridActions: Array<{
                  key: GridActionKey;
                  icon: typeof Crop;
                  label: string;
                  prompt: string;
                  cost: number;
                }> = [
                  {
                    key: "multiCameraGrid",
                    icon: Grid3x3,
                    label: t("nodeToolbar.gridMenu.multiCameraGrid"),
                    prompt: t("nodeToolbar.gridMenu.multiCameraGridPrompt"),
                    cost: 14,
                  },
                  {
                    key: "plotFourGrid",
                    icon: Grid2x2,
                    label: t("nodeToolbar.gridMenu.plotFourGrid"),
                    prompt: t("nodeToolbar.gridMenu.plotFourGridPrompt"),
                    cost: 8,
                  },
                  {
                    key: "faceThreeView",
                    icon: User,
                    label: t("nodeToolbar.gridMenu.faceThreeView"),
                    prompt: t("nodeToolbar.gridMenu.faceThreeViewPrompt"),
                    cost: 6,
                  },
                  {
                    key: "productThreeView",
                    icon: Package,
                    label: t("nodeToolbar.gridMenu.productThreeView"),
                    prompt: t("nodeToolbar.gridMenu.productThreeViewPrompt"),
                    cost: 6,
                  },
                  {
                    key: "serialStoryboard25",
                    icon: LayoutDashboard,
                    label: t("nodeToolbar.gridMenu.serialStoryboard25"),
                    prompt: t("nodeToolbar.gridMenu.serialStoryboard25Prompt"),
                    cost: 32,
                  },
                  {
                    key: "cinematicLightCorrection",
                    icon: Film,
                    label: t("nodeToolbar.gridMenu.cinematicLightCorrection"),
                    prompt: t(
                      "nodeToolbar.gridMenu.cinematicLightCorrectionPrompt",
                    ),
                    cost: 4,
                  },
                  {
                    key: "characterThreeView",
                    icon: Users,
                    label: t("nodeToolbar.gridMenu.characterThreeView"),
                    prompt: t("nodeToolbar.gridMenu.characterThreeViewPrompt"),
                    cost: 6,
                  },
                  {
                    key: "frameProjection3sLater",
                    icon: FastForward,
                    label: t("nodeToolbar.gridMenu.frameProjection3sLater"),
                    prompt: t(
                      "nodeToolbar.gridMenu.frameProjection3sLaterPrompt",
                    ),
                    cost: 4,
                  },
                  {
                    key: "frameProjection5sEarlier",
                    icon: Rewind,
                    label: t("nodeToolbar.gridMenu.frameProjection5sEarlier"),
                    prompt: t(
                      "nodeToolbar.gridMenu.frameProjection5sEarlierPrompt",
                    ),
                    cost: 4,
                  },
                ];
                return (
                  <DropdownMenu {...gridMenu.rootProps}>
                    <DropdownMenuTrigger asChild>
                      <UiChipButton
                        key="image-grid-menu"
                        className={TOOLBAR_TEXT_BUTTON_CLASS}
                        onClick={(event) => event.stopPropagation()}
                        {...gridMenu.hoverProps}
                      >
                        <LayoutGrid className="h-3.5 w-3.5" />
                        {t("nodeToolbar.gridMenu.trigger")}
                        <ChevronDown className="h-3 w-3" />
                      </UiChipButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="start"
                      sideOffset={6}
                      className={`${TOOLBAR_MENU_CONTENT_CLASS} min-w-[200px]`}
                      onClick={(event) => event.stopPropagation()}
                      {...gridMenu.hoverProps}
                    >
                      {gridActions.map((action) => {
                        const Icon = action.icon;
                        const isActive = action.key === activeGridAction;
                        return (
                          <DropdownMenuItem
                            key={action.key}
                            className={
                              isActive
                                ? "gap-2 bg-[rgb(var(--accent-rgb)/0.18)] text-accent focus:bg-[rgb(var(--accent-rgb)/0.28)] focus:text-accent"
                                : TOOLBAR_MENU_ITEM_CLASS
                            }
                            onSelect={() => {
                              setActiveGridAction(action.key);
                              onOpenGridAction({
                                nodeId: node.id,
                                key: action.key,
                                label: action.label,
                                prompt: action.prompt,
                                cost: action.cost,
                              });
                            }}
                          >
                            <Icon className="h-4 w-4" />
                            {action.label}
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuContent>
                  </DropdownMenu>
                );
              })()}
            {!isImageEdit && canHandleImage && <ToolbarDivider />}
            {!isImageEdit &&
              tools
                .filter((tool) => tool.type !== NODE_TOOL_TYPES.crop)
                .map((tool) => {
                  const Icon = toolIconMap[tool.icon] ?? Crop;
                  const label = resolveToolLabel(tool.type);
                  const isAnnotate = tool.type === NODE_TOOL_TYPES.annotate;

                  if (isAnnotate) {
                    return (
                      <ToolbarIconChip
                        key={tool.type}
                        label={label}
                        icon={Icon}
                        onClick={() =>
                          canvasEventBus.publish("tool-dialog/open", {
                            nodeId: node.id,
                            toolType: tool.type,
                          })
                        }
                      />
                    );
                  }

                  return (
                    <UiChipButton
                      key={tool.type}
                      className={TOOLBAR_TEXT_BUTTON_CLASS}
                      onClick={() =>
                        canvasEventBus.publish("tool-dialog/open", {
                          nodeId: node.id,
                          toolType: tool.type,
                        })
                      }
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </UiChipButton>
                  );
                })}
            {!isImageEdit && canHandleImage && !isPresetLocked && (
              // Hidden on preset_managed nodes — Rotate mutates the source
              // image in place (RotateEditorOverlay calls updateNodeData(node.id, ...))
              // which would violate canonical immutability. Same for HD/upscale
              // below (filtered out of the edit-menu dropdown when locked).
              <ToolbarIconChip
                key="image-rotate"
                label={t("nodeToolbar.rotate")}
                icon={RotateCw}
                onClick={(event) => {
                  event.stopPropagation();
                  closeDownloadMenu();
                  onOpenRotate(node.id);
                }}
              />
            )}
            {/* 重新上传按钮暂时隐藏（保留代码，等需求恢复时取消注释）
        {!isImageEdit && canReupload && (
          <UiChipButton
            key="upload-reupload"
            className={TOOLBAR_TEXT_BUTTON_CLASS}
            onClick={() =>
              canvasEventBus.publish('upload-node/reupload', {
                nodeId: node.id,
              })
            }
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('nodeToolbar.reupload')}
          </UiChipButton>
        )}
        */}
            {/* 复制图片按钮暂时隐藏（保留代码，等需求恢复时取消注释）
        {!isImageEdit && canHandleImage && (
          <UiChipButton
            key="image-copy"
            className={`h-9 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-3 text-sm ${TOOLBAR_NEUTRAL_BUTTON_CLASS} ${
              isCopySuccess
                ? '!border-emerald-400/70 !bg-emerald-500/20 !text-emerald-200 hover:!bg-emerald-500/30'
                : ''
            }`}
            onClick={() => {
              void handleCopyImage();
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            {t('nodeToolbar.copy')}
          </UiChipButton>
        )}
        */}
            {!isImageEdit && canCopyStoryboardText && (
              <UiChipButton
                key="storyboard-text-copy"
                className={`${TOOLBAR_TEXT_BUTTON_CLASS} ${
                  isCopyTextSuccess
                    ? "!border-emerald-400/70 !bg-emerald-500/20 !text-emerald-200 hover:!bg-emerald-500/30"
                    : ""
                }`}
                onClick={() => {
                  void handleCopyStoryboardText();
                }}
              >
                <Copy className="h-3.5 w-3.5" />
                {t("nodeToolbar.copyText")}
              </UiChipButton>
            )}
            {!isImageEdit && canCopyGenerationError && (
              <UiChipButton
                key="generation-error-copy"
                className={`${TOOLBAR_TEXT_BUTTON_CLASS} ${
                  isCopyErrorSuccess
                    ? "!border-emerald-400/70 !bg-emerald-500/20 !text-emerald-200 hover:!bg-emerald-500/30"
                    : "!border-red-500/45 !bg-red-500/15 !text-red-200 hover:!bg-red-500/25"
                }`}
                onClick={() => {
                  void handleCopyGenerationError();
                }}
              >
                <Copy className="h-3.5 w-3.5" />
                {isCopyErrorSuccess
                  ? t("nodeToolbar.copied")
                  : t("nodeToolbar.copyErrorReport")}
              </UiChipButton>
            )}
            {!isImageEdit && canHandleImage && (
              <ToolbarIconChip
                key="image-download"
                label={t("nodeToolbar.download")}
                icon={Download}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleDownloadSaveAs();
                }}
              />
            )}
            {isVideoNode(node) &&
              (() => {
                const videoData = node.data;
                const videoUrl =
                  typeof videoData.videoUrl === "string"
                    ? videoData.videoUrl
                    : null;
                const isAnalyzing = Boolean(videoData.isAnalyzing);
                const hasVideo = Boolean(videoUrl);
                const stubButtonClass = TOOLBAR_TEXT_BUTTON_CLASS;

                const handleVideoStub = (label: string) => {
                  console.info(
                    `[video-toolbar] stub action triggered: ${label}`,
                  );
                };

                const handleVideoAnalyze = async () => {
                  if (!hasVideo || !videoUrl || isAnalyzing) {
                    return;
                  }
                  const projectId = readUrl().project;
                  if (!projectId) {
                    console.error("[video-analyze] no project in URL");
                    return;
                  }
                  updateNodeData(node.id, {
                    isAnalyzing: true,
                    analysisError: null,
                  });

                  // 立即在下游建一个 loading 态的视频故事节点 —— 不等后端返回。
                  // 数据回来后再 updateNodeData 把分镜填进去；失败则把错误写到该节点。
                  const storyPosition = findNodePosition(node.id, 720, 360);
                  const storyNodeId = addNode(
                    CANVAS_NODE_TYPES.videoStory,
                    storyPosition,
                    {
                      sourceVideoUrl: videoUrl,
                      rows: [],
                      rawResult: null,
                      isAnalyzing: true,
                      analysisStartedAt: Date.now(),
                      analysisError: null,
                    },
                  );
                  addEdge(node.id, storyNodeId);

                  try {
                    const durationSec =
                      typeof videoData.durationMs === "number" && videoData.durationMs > 0
                        ? videoData.durationMs / 1000
                        : undefined;
                    const submitResp = (await submitFreezoneAnalyzeVideoStory(
                      projectId,
                      { videoUrl, durationSec },
                    )) as unknown;
                    console.info("[video-analyze] submit response", submitResp);

                    const submitRecord =
                      submitResp && typeof submitResp === "object"
                        ? (submitResp as Record<string, unknown>)
                        : {};
                    const taskKey =
                      typeof submitRecord.task_key === "string"
                        ? submitRecord.task_key
                        : null;

                    let rawResult: Record<string, unknown>;
                    if (taskKey) {
                      const completed = await awaitTaskCompletion(taskKey, projectId);
                      console.info(
                        "[video-analyze] task completed",
                        completed.result,
                      );
                      rawResult = (completed.result ?? {}) as Record<string, unknown>;
                    } else {
                      // Endpoint returned the result synchronously (OpenAPI 200 is `{}` —
                      // not guaranteed to be the async FreezoneJobAcceptedResponse).
                      console.info(
                        "[video-analyze] no task_key, treating response as inline result",
                      );
                      rawResult = submitRecord;
                    }

                    const rows = normalizeVideoStoryRows(rawResult);
                    console.info(
                      "[video-analyze] normalized rows",
                      rows.length,
                      rows,
                    );

                    // 把解析结果回填到先前创建的 loading 故事节点。
                    updateNodeData(storyNodeId, {
                      rows,
                      rawResult,
                      isAnalyzing: false,
                      analysisError: null,
                    });
                    updateNodeData(node.id, {
                      isAnalyzing: false,
                      analysisError: null,
                    });
                  } catch (error) {
                    const message =
                      error instanceof Error ? error.message : String(error);
                    console.error("[video-analyze] failed", error);
                    // 把错误写到下游故事节点,清掉它的 loading 态。
                    updateNodeData(storyNodeId, {
                      isAnalyzing: false,
                      analysisError: message,
                    });
                    updateNodeData(node.id, {
                      isAnalyzing: false,
                      analysisError: message,
                    });
                  }
                };

                const handleVideoDownload = async () => {
                  if (!hasVideo || !videoUrl) {
                    return;
                  }
                  try {
                    const sourceFileName =
                      typeof videoData.sourceFileName === "string" && videoData.sourceFileName.trim().length > 0
                        ? videoData.sourceFileName
                        : typeof videoData.displayName === "string" && videoData.displayName.trim().length > 0
                          ? `${videoData.displayName}.mp4`
                          : `video-${node.id}.mp4`;
                    await downloadUrlAsFile(
                      resolveImageDisplayUrl(videoUrl),
                      sourceFileName,
                    );
                  } catch (error) {
                    console.error("[video-download] failed", error);
                  }
                };

                const handleVideoFullscreen = () => {
                  if (!hasVideo || !videoUrl) {
                    return;
                  }
                  canvasEventBus.publish("video-viewer/open", {
                    videoUrl,
                    title:
                      typeof videoData.displayName === "string"
                        ? videoData.displayName
                        : undefined,
                  });
                };

                // 「高清」：在下游建一个视频节点（复用 video 节点的播放器/角标/尺寸，
                // 与普通视频节点一致），以本视频为源、打 isUpscaleNode 标记 —— 选中后在
                // 其下方展开 VideoUpscaleEditorOverlay 配置面板，提交走 /freezone/video/upscale。
                const handleVideoUpscale = () => {
                  if (!hasVideo || !videoUrl) {
                    return;
                  }
                  const position = findNodePosition(node.id, 580, 380);
                  const upscaleNodeId = addNode(
                    CANVAS_NODE_TYPES.video,
                    position,
                    {
                      displayName: `${t("node.videoUpscale.nodeTitle")}（1080P）`,
                      videoUrl: null,
                      previewImageUrl:
                        typeof videoData.previewImageUrl === "string"
                          ? videoData.previewImageUrl
                          : null,
                      aspectRatio:
                        typeof videoData.aspectRatio === "string"
                          ? videoData.aspectRatio
                          : "16:9",
                      isUpscaleNode: true,
                      upscaleSourceUrl: videoUrl,
                      upscaleResolution: "1080p",
                      upscaleDenoise: "1x",
                      isGenerating: false,
                    } as unknown as Parameters<typeof addNode>[2],
                  );
                  addEdge(node.id, upscaleNodeId);
                  onNodesChange([
                    { id: node.id, type: "select", selected: false },
                    { id: upscaleNodeId, type: "select", selected: true },
                  ]);
                  setSelectedNode(upscaleNodeId);
                };

                const isGreyboxing = Boolean(videoData.isGreyboxing);

                // 「转深度视频」（内部代号 greybox）：在下游建一个视频节点（复用 video
                // 节点的播放器/角标/尺寸，打 isGreyboxNode 标记）。点入口按钮直接带默认
                // 参数提交——提交范式仿 handleAudioSeparate（无配置浮层），
                // awaitTaskCompletion 拿到 output_url 后回填派生节点 videoUrl；
                // 失败时错误落在派生节点上（走 video 节点既有的 generationError 渲染）。
                const handleVideoGreybox = async () => {
                  if (!hasVideo || !videoUrl || isGreyboxing) {
                    return;
                  }
                  const projectId = readUrl().project;
                  if (!projectId) {
                    console.error("[video-greybox] no project in URL");
                    return;
                  }
                  const position = findNodePosition(node.id, 580, 380);
                  const greyboxNodeId = addNode(
                    CANVAS_NODE_TYPES.video,
                    position,
                    {
                      displayName: t("node.videoGreybox.nodeTitle"),
                      videoUrl: null,
                      previewImageUrl:
                        typeof videoData.previewImageUrl === "string"
                          ? videoData.previewImageUrl
                          : null,
                      aspectRatio:
                        typeof videoData.aspectRatio === "string"
                          ? videoData.aspectRatio
                          : "16:9",
                      // 抑制底部生成面板：转白模由工具栏直接提交，不走常规生成流。
                      referenceOnly: true,
                      isGreyboxNode: true,
                      greyboxSourceUrl: videoUrl,
                      isGenerating: true,
                    } as unknown as Parameters<typeof addNode>[2],
                  );
                  const greyboxEdgeId = addEdge(node.id, greyboxNodeId);
                  // 诊断：源节点 → 深度视频节点的溯源边偶发不显示。打出建边返回值与
                  // 当前 edges，区分「没建成」（store 层拦截）和「建成了没渲染」。
                  console.info(
                    "[video-greybox] edge",
                    greyboxEdgeId,
                    "edges:",
                    useCanvasStore.getState().edges.length,
                    JSON.stringify(useCanvasStore.getState().edges),
                  );
                  onNodesChange([
                    { id: node.id, type: "select", selected: false },
                    { id: greyboxNodeId, type: "select", selected: true },
                  ]);
                  setSelectedNode(greyboxNodeId);
                  updateNodeData(node.id, { isGreyboxing: true });
                  try {
                    const ref = await submitFreezoneVideoGreybox(projectId, {
                      sourceUrl: videoUrl,
                      ...DEPTH_VIDEO_PARAMS,
                    });
                    const completed = await awaitTaskCompletion(
                      ref.task_key,
                      projectId,
                      { taskType: ref.task_type },
                    );
                    console.info(
                      "[video-greybox] task completed",
                      completed.result,
                    );
                    // runner 固定返回 output_url（runners/freezone.py 灰盒 result），
                    // 其余键名宽容兜底。
                    const result = (completed.result ?? {}) as Record<
                      string,
                      unknown
                    >;
                    const outputUrl =
                      (typeof result.output_url === "string" &&
                        result.output_url) ||
                      (typeof result.outputUrl === "string" &&
                        result.outputUrl) ||
                      (typeof result.video_url === "string" &&
                        result.video_url) ||
                      (typeof result.videoUrl === "string" &&
                        result.videoUrl) ||
                      null;
                    if (!outputUrl) {
                      throw new Error(t("node.videoGreybox.noResult"));
                    }
                    updateNodeData(greyboxNodeId, {
                      videoUrl: outputUrl,
                      isGenerating: false,
                      generationError: null,
                    });
                  } catch (error) {
                    if (isTaskPollTimeoutError(error)) {
                      // 脱离监听 ≠ 失败。任务可能仍在后台跑，结果去任务中心取；
                      // 派生节点不能一直转圈，落一条提示后停掉 loading。
                      console.warn(
                        "[video-greybox] detached from a still-running job",
                        { taskKey: error.taskKey, idleMs: error.idleMs },
                      );
                      notifyTaskStillRunning(t);
                      updateNodeData(greyboxNodeId, {
                        isGenerating: false,
                        generationError: t("errorDialog.stillRunningMessage"),
                      });
                    } else {
                      const message =
                        error instanceof Error ? error.message : String(error);
                      console.error("[video-greybox] failed", error);
                      updateNodeData(greyboxNodeId, {
                        isGenerating: false,
                        generationError: message,
                      });
                    }
                  } finally {
                    updateNodeData(node.id, { isGreyboxing: false });
                  }
                };

                const isSeparatingAv = Boolean(videoData.isSeparatingAv);

                const handleAudioSeparate = async () => {
                  if (!hasVideo || !videoUrl || isSeparatingAv) {
                    return;
                  }
                  const projectId = readUrl().project;
                  if (!projectId) {
                    console.error("[audio-separate] no project in URL");
                    return;
                  }
                  updateNodeData(node.id, { isSeparatingAv: true });
                  try {
                    const ref = await submitFreezoneAudioSeparate(
                      projectId,
                      { sourceUrl: videoUrl },
                    );
                    const completed = await awaitTaskCompletion(ref.task_key, projectId, { taskType: ref.task_type });
                    console.info(
                      "[audio-separate] task completed",
                      completed.result,
                    );

                    // Walk an arbitrary JSON tree and pull every string that
                    // looks like a URL/path. Backend hasn't typed the result
                    // schema, so we can't rely on key names alone.
                    const collectStrings = (
                      value: unknown,
                      out: string[],
                    ): void => {
                      if (typeof value === "string") {
                        if (value.length > 0) out.push(value);
                        return;
                      }
                      if (Array.isArray(value)) {
                        for (const item of value) collectStrings(item, out);
                        return;
                      }
                      if (value && typeof value === "object") {
                        for (const item of Object.values(
                          value as Record<string, unknown>,
                        )) {
                          collectStrings(item, out);
                        }
                      }
                    };

                    // Fallback only: some legacy results carry a backend
                    // filesystem path (e.g. `/data/output/<user>/<project>/...`)
                    // instead of a servable URL. Rewriting `<...>/output/` into
                    // `/static/<user>/<project>/...` yields the LEGACY scheme,
                    // which production now rejects with 410 — so this is used
                    // strictly as a last resort when no `*_url` field exists.
                    const toStaticUrl = (raw: string): string => {
                      if (!raw) return raw;
                      if (
                        raw.startsWith("/static/") ||
                        raw.startsWith("http://") ||
                        raw.startsWith("https://") ||
                        raw.startsWith("blob:") ||
                        raw.startsWith("data:")
                      ) {
                        return raw;
                      }
                      const outputIdx = raw.lastIndexOf("/output/");
                      if (outputIdx >= 0) {
                        return `/static/${raw.slice(outputIdx + "/output/".length)}`;
                      }
                      return raw;
                    };

                    const pickUrlField = (
                      source: Record<string, unknown>,
                      keys: string[],
                    ): string | null => {
                      for (const key of keys) {
                        const value = source[key];
                        if (typeof value === "string" && value.length > 0) {
                          return value;
                        }
                      }
                      return null;
                    };

                    const classify = (
                      source: Record<string, unknown> | null | undefined,
                    ): { audio: string | null; video: string | null } => {
                      if (!source)
                        return { audio: null, video: null };

                      // Prefer the backend-provided canonical URLs. The result
                      // carries BOTH a filesystem `*_path`
                      // (`/data/output/<user>/<project>/...`) and a
                      // ready-to-serve `*_url` (`/static/projects/<project_id>/...`).
                      // Only the `*_url` form is reachable online — OpenResty
                      // returns 410 for legacy `/static/<user>/<project>/...`.
                      // Never derive a URL from `*_path`.
                      let audio = pickUrlField(source, ["audio_url", "audioUrl"]);
                      let video = pickUrlField(source, [
                        "mute_video_url",
                        "muteVideoUrl",
                      ]);

                      // Fallback heuristic for results that don't carry explicit
                      // URL fields: walk the tree and pick by extension,
                      // preferring already-servable `/static`/http URLs over raw
                      // filesystem paths so we never reconstruct a legacy URL.
                      if (!audio || !video) {
                        const strings: string[] = [];
                        collectStrings(source, strings);
                        const isServable = (s: string) =>
                          s.startsWith("/static/") ||
                          s.startsWith("http://") ||
                          s.startsWith("https://");
                        strings.sort(
                          (a, b) =>
                            Number(isServable(b)) - Number(isServable(a)),
                        );
                        const audioExt =
                          /\.(mp3|m4a|aac|wav|flac|ogg|opus)(\?|$)/i;
                        const videoExt =
                          /\.(mp4|mov|webm|mkv|avi|m4v)(\?|$)/i;
                        for (const s of strings) {
                          if (
                            !audio &&
                            (audioExt.test(s) || /audio|sound/i.test(s))
                          ) {
                            audio = s;
                          } else if (
                            !video &&
                            (videoExt.test(s) ||
                              /silent|mute|no[_-]?audio|video/i.test(s))
                          ) {
                            video = s;
                          }
                          if (audio && video) break;
                        }
                      }

                      return {
                        audio: audio ? toStaticUrl(audio) : null,
                        video: video ? toStaticUrl(video) : null,
                      };
                    };

                    let { audio: audioOutputUrl, video: silentVideoOutputUrl } =
                      classify(
                        (completed.result ?? null) as Record<
                          string,
                          unknown
                        > | null,
                      );

                    // Fallback: hit the dedicated job-result endpoint when SSE
                    // result didn't carry the URLs (some freezone task types
                    // surface artifacts only via /jobs/.../result).
                    if (!audioOutputUrl || !silentVideoOutputUrl) {
                      try {
                        const jobResult =
                          await fetchFreezoneAudioSeparateResult(
                            projectId,
                            ref.job_id,
                          );
                        console.info(
                          "[audio-separate] job result",
                          jobResult,
                        );
                        const classified = classify(jobResult);
                        audioOutputUrl = audioOutputUrl ?? classified.audio;
                        silentVideoOutputUrl =
                          silentVideoOutputUrl ?? classified.video;
                      } catch (jobErr) {
                        console.warn(
                          "[audio-separate] job result fetch failed",
                          jobErr,
                        );
                      }
                    }

                    if (!audioOutputUrl || !silentVideoOutputUrl) {
                      console.warn(
                        "[audio-separate] could not resolve audio/video urls",
                        { sseResult: completed.result },
                      );
                      return;
                    }
                    console.info("[audio-separate] resolved urls", {
                      audioOutputUrl,
                      silentVideoOutputUrl,
                    });
                    const rawName =
                      typeof videoData.sourceFileName === "string" &&
                      videoData.sourceFileName.trim().length > 0
                        ? videoData.sourceFileName
                        : typeof videoData.displayName === "string" &&
                            videoData.displayName.trim().length > 0
                          ? videoData.displayName
                          : "video";
                    const baseName = rawName.replace(/\.[^/.]+$/, "");
                    const audioTitle = `${baseName}_${t("canvas.nodeToolbar.audioSuffix")}`;
                    const silentTitle = `${baseName}_${t("canvas.nodeToolbar.silentSuffix")}`;

                    const audioPos = findNodePosition(node.id, 480, 180);
                    const audioNodeId = addNode(
                      CANVAS_NODE_TYPES.audio,
                      audioPos,
                      {
                        audioUrl: audioOutputUrl,
                        sourceFileName: audioTitle,
                        displayName: audioTitle,
                      },
                    );
                    addEdge(node.id, audioNodeId);

                    const silentPos = findNodePosition(node.id, 480, 270);
                    const silentNodeId = addNode(
                      CANVAS_NODE_TYPES.video,
                      silentPos,
                      {
                        videoUrl: silentVideoOutputUrl,
                        sourceFileName: `${silentTitle}.mp4`,
                        displayName: silentTitle,
                      },
                    );
                    addEdge(node.id, silentNodeId);
                  } catch (error) {
                    // 脱离监听 ≠ 分离失败。音视频分离不落节点句柄（结果是两个
                    // 新节点，没有承载 taskKey 的宿主），所以这里只能明确告诉
                    // 用户任务还在后台跑、结果去任务中心取，而不是静默收场。
                    if (isTaskPollTimeoutError(error)) {
                      console.warn("[audio-separate] detached from a still-running job", {
                        taskKey: error.taskKey,
                        idleMs: error.idleMs,
                      });
                      notifyTaskStillRunning(t);
                    } else {
                      console.error("[audio-separate] failed", error);
                    }
                  } finally {
                    updateNodeData(node.id, { isSeparatingAv: false });
                  }
                };

                return (
                  <>
                    <UiChipButton
                      key="video-clip"
                      className={`${stubButtonClass} ${!hasVideo ? "opacity-50 cursor-not-allowed" : ""}`}
                      title={
                        !hasVideo
                          ? t("nodeToolbar.video.requiresVideo")
                          : undefined
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        if (!hasVideo) return;
                        updateNodeData(node.id, {
                          isClipMode: !videoData.isClipMode,
                        });
                      }}
                    >
                      <Scissors className="h-3.5 w-3.5" />
                      {t("nodeToolbar.video.clip")}
                    </UiChipButton>
                    <UiChipButton
                      key="video-hd"
                      className={`${stubButtonClass} ${!hasVideo ? "opacity-50 cursor-not-allowed" : ""}`}
                      title={
                        !hasVideo
                          ? t("nodeToolbar.video.requiresVideo")
                          : undefined
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        handleVideoUpscale();
                      }}
                    >
                      <ImageUpscale className="h-3.5 w-3.5" />
                      {t("nodeToolbar.video.hd")}
                    </UiChipButton>
                    <UiChipButton
                      key="video-greybox"
                      className={`${stubButtonClass} ${
                        !hasVideo || isGreyboxing
                          ? "opacity-50 cursor-not-allowed"
                          : ""
                      }`}
                      title={
                        !hasVideo
                          ? t("nodeToolbar.video.requiresVideo")
                          : isGreyboxing
                            ? t("node.videoGreybox.generating")
                            : undefined
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        if (!hasVideo || isGreyboxing) {
                          return;
                        }
                        // 一键出效果：不展开预设条，直接用默认参数（纯深度图）跑。
                        void handleVideoGreybox();
                      }}
                    >
                      {isGreyboxing ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Boxes className="h-3.5 w-3.5" />
                      )}
                      {t("nodeToolbar.video.greybox")}
                    </UiChipButton>
                    <UiChipButton
                      key="video-reshoot"
                      className={`${stubButtonClass} ${
                        !hasVideo || isReshooting || reshootModelUnsupported
                          ? "opacity-50 cursor-not-allowed"
                          : ""
                      }`}
                      title={
                        reshootModelUnsupported
                          ? t("nodeToolbar.video.reshootModelUnsupported")
                          : !hasVideo
                            ? t("nodeToolbar.video.requiresVideo")
                            : isReshooting
                              ? t("node.reshoot.generating")
                              : undefined
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        if (!hasVideo || isReshooting || reshootModelUnsupported) {
                          return;
                        }
                        // 再点一次收起；展开时把选区铺满整条源视频。
                        if (showReshootTimeline) {
                          setShowReshootTimeline(false);
                          return;
                        }
                        openReshootTimeline();
                      }}
                    >
                      {isReshooting ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                      {t("nodeToolbar.video.reshoot")}
                    </UiChipButton>
                    <UiChipButton
                      key="video-continue"
                      className={`${stubButtonClass} ${
                        !hasVideo || isContinuing ? "opacity-50 cursor-not-allowed" : ""
                      }`}
                      title={
                        !hasVideo
                          ? t("nodeToolbar.video.requiresVideo")
                          : reshootDurationSeconds === null
                            ? t("nodeToolbar.video.reshootRangeUnknown")
                            : t("nodeToolbar.video.continueHint")
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        if (!hasVideo || isContinuing || reshootDurationSeconds === null) {
                          return;
                        }
                        // 打开面板只开面板：**不**自动跑推荐。推荐要花一次视觉模型
                        // 调用，用户可能只想自己写一句；要推荐就点面板里的按钮。
                        setShowContinuePanel((open) => !open);
                      }}
                    >
                      {isContinuing ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Forward className="h-3.5 w-3.5" />
                      )}
                      {t("nodeToolbar.video.continue")}
                    </UiChipButton>
                    <UiChipButton
                      key="video-identity-call"
                      className={stubButtonClass}
                      title={t("node.identityCall.toggle")}
                      data-testid="video-node-identity-call-toggle"
                      onClick={(event) => {
                        event.stopPropagation();
                        canvasEventBus.publish("video-node/identity-call", {
                          nodeId,
                        });
                      }}
                    >
                      <GitBranch className="h-3.5 w-3.5" />
                      {t("node.identityCall.toggle")}
                    </UiChipButton>
                    <UiChipButton
                      key="video-analyze"
                      className={`${stubButtonClass} ${
                        !hasVideo || videoAnalyzeBillingRuleMissing
                          ? "opacity-50 cursor-not-allowed"
                          : ""
                      }`}
                      title={
                        !hasVideo
                          ? t("nodeToolbar.video.requiresVideo")
                          : videoAnalyzeBillingRuleMissing
                            ? t("common.billingRuleNotConfiguredShort")
                          : undefined
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        if (videoAnalyzeBillingRuleMissing) return;
                        void handleVideoAnalyze();
                      }}
                    >
                      {isAnalyzing ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Wand2 className="h-3.5 w-3.5" />
                      )}
                      {t("nodeToolbar.video.analyze")}
                      <CreditCostPill
                        display={videoAnalyzeCreditCostDisplay}
                        promotion={videoAnalyzeCreditCost.data?.data.promotion}
                        disabled={!hasVideo || isAnalyzing || videoAnalyzeBillingRuleMissing}
                      />
                    </UiChipButton>
                    <DropdownMenu
                      onOpenChange={(open) => {
                        if (open) closeDownloadMenu();
                      }}
                    >
                      <DropdownMenuTrigger asChild>
                        <UiChipButton
                          key="video-subtitle-removal"
                          className={stubButtonClass}
                          title={t("nodeToolbar.video.subtitleRemovalTip")}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <Eraser className="h-3.5 w-3.5" />
                          {t("nodeToolbar.video.subtitleRemoval")}
                          <ChevronDown className="h-3 w-3" />
                        </UiChipButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="start"
                        sideOffset={6}
                        className={`${TOOLBAR_MENU_CONTENT_CLASS} min-w-[180px]`}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <DropdownMenuItem
                          className={TOOLBAR_MENU_ITEM_CLASS}
                          onSelect={() => {
                            if (!hasVideo) {
                              handleVideoStub("subtitle-smart-erase");
                              return;
                            }
                            updateNodeData(node.id, {
                              subtitleEraseMode: 'smart',
                              subtitleEraseBox: null,
                              isClipMode: false,
                            });
                            setSelectedNode(node.id);
                          }}
                        >
                          <Wand2 className="h-4 w-4" />
                          {t("nodeToolbar.video.subtitleRemovalSmart")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className={TOOLBAR_MENU_ITEM_CLASS}
                          onSelect={() => {
                            if (!hasVideo) {
                              handleVideoStub("subtitle-box-erase");
                              return;
                            }
                            updateNodeData(node.id, {
                              subtitleEraseMode: 'box',
                              subtitleEraseBox: null,
                              isClipMode: false,
                            });
                            setSelectedNode(node.id);
                          }}
                        >
                          <Crop className="h-4 w-4" />
                          {t("nodeToolbar.video.subtitleRemovalBox")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <UiChipButton
                      key="video-separate-av"
                      className={`${stubButtonClass} ${
                        !hasVideo || isSeparatingAv
                          ? "opacity-50 cursor-not-allowed"
                          : ""
                      }`}
                      title={
                        !hasVideo
                          ? t("nodeToolbar.video.requiresVideo")
                          : undefined
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleAudioSeparate();
                      }}
                    >
                      {isSeparatingAv ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <VideoIcon className="h-3.5 w-3.5" />
                      )}
                      {t("nodeToolbar.video.separateAudioVideo")}
                    </UiChipButton>
                    <UiChipButton
                      key="video-download"
                      className={`${stubButtonClass} !px-2 ${!hasVideo ? "opacity-50 cursor-not-allowed" : ""}`}
                      title={
                        !hasVideo
                          ? t("nodeToolbar.video.requiresVideo")
                          : t("nodeToolbar.download")
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleVideoDownload();
                      }}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </UiChipButton>
                    <UiChipButton
                      key="video-fullscreen"
                      className={`${stubButtonClass} !px-2 ${!hasVideo ? "opacity-50 cursor-not-allowed" : ""}`}
                      title={
                        !hasVideo
                          ? t("nodeToolbar.video.requiresVideo")
                          : t("nodeToolbar.video.fullscreen")
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        handleVideoFullscreen();
                      }}
                    >
                      <Maximize2 className="h-3.5 w-3.5" />
                    </UiChipButton>
                  </>
                );
              })()}
            {isAudioNode(node) &&
              (() => {
                const audioData = node.data;
                const audioUrl =
                  typeof audioData.audioUrl === "string"
                    ? audioData.audioUrl
                    : null;
                const hasAudio = Boolean(audioUrl);
                const audioButtonClass = TOOLBAR_TEXT_BUTTON_CLASS;
                const sourceExt = audioUrl ? getAudioExtFromUrl(audioUrl) : "";
                const convertingFormat =
                  typeof audioData.convertingAudioFormat === "string"
                    ? (audioData.convertingAudioFormat as AudioDownloadFormat)
                    : null;
                const isConverting = Boolean(convertingFormat);

                // The separated-audio node stores `sourceFileName` WITHOUT an
                // extension (e.g. `xxx_背景音`), which previously produced an
                // extensionless download the OS couldn't open. Strip any trailing
                // audio extension and re-append the chosen format below.
                const baseFileName = (() => {
                  const raw =
                    typeof audioData.sourceFileName === "string" &&
                    audioData.sourceFileName.trim().length > 0
                      ? audioData.sourceFileName.trim()
                      : typeof audioData.displayName === "string" &&
                          audioData.displayName.trim().length > 0
                        ? audioData.displayName.trim()
                        : `audio-${node.id}`;
                  return raw.replace(
                    /\.(mp3|m4a|aac|wav|flac|ogg|opus|mp4|m4b)$/i,
                    "",
                  );
                })();

                const handleAudioDownload = async (
                  format: AudioDownloadFormat,
                ) => {
                  if (!hasAudio || !audioUrl || isConverting) {
                    return;
                  }
                  if (!canProduceFormat(format, sourceExt)) {
                    toast.error(t("nodeToolbar.audio.m4aSourceOnly"));
                    return;
                  }
                  const filename = `${baseFileName}.${format}`;
                  const resolvedUrl = resolveImageDisplayUrl(audioUrl);
                  // Passthrough (target container == source): download original
                  // bytes via downloadUrlAsFile (robust cross-origin fallback +
                  // correct extension), no lossy re-encode.
                  const passthrough =
                    format === sourceExt ||
                    (format === "m4a" && canProduceFormat("m4a", sourceExt));
                  if (passthrough) {
                    try {
                      await downloadUrlAsFile(resolvedUrl, filename);
                    } catch (error) {
                      console.error("[audio-download] passthrough failed", error);
                      toast.error(t("nodeToolbar.audio.downloadFailed"));
                    }
                    return;
                  }
                  updateNodeData(node.id, { convertingAudioFormat: format });
                  try {
                    const resp = await fetch(resolvedUrl);
                    if (!resp.ok) {
                      throw new Error(`fetch failed: ${resp.status}`);
                    }
                    const srcBlob = await resp.blob();
                    const outBlob = await transcodeAudio(
                      srcBlob,
                      sourceExt,
                      format,
                    );
                    downloadBlobAsFile(outBlob, filename);
                  } catch (error) {
                    console.error("[audio-download] transcode failed", error);
                    toast.error(t("nodeToolbar.audio.downloadFailed"));
                  } finally {
                    updateNodeData(node.id, { convertingAudioFormat: null });
                  }
                };

                return (
                  <DropdownMenu
                    onOpenChange={(open) => {
                      if (open) closeDownloadMenu();
                    }}
                  >
                    <DropdownMenuTrigger asChild>
                      <UiChipButton
                        key="audio-download"
                        className={`${audioButtonClass} ${
                          !hasAudio ? "opacity-50 cursor-not-allowed" : ""
                        }`}
                        title={
                          !hasAudio
                            ? t("nodeToolbar.audio.requiresAudio")
                            : t("nodeToolbar.download")
                        }
                        onClick={(event) => event.stopPropagation()}
                      >
                        {isConverting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                        {t("nodeToolbar.download")}
                        <ChevronDown className="h-3 w-3" />
                      </UiChipButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="start"
                      sideOffset={6}
                      className={`${TOOLBAR_MENU_CONTENT_CLASS} min-w-[170px]`}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {AUDIO_DOWNLOAD_FORMATS.map((format) => {
                        const available = canProduceFormat(format, sourceExt);
                        return (
                          <DropdownMenuItem
                            key={format}
                            disabled={!hasAudio || !available || isConverting}
                            className={TOOLBAR_MENU_ITEM_CLASS}
                            onSelect={() => {
                              void handleAudioDownload(format);
                            }}
                          >
                            {convertingFormat === format ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Download className="h-4 w-4" />
                            )}
                            <span className="flex-1">
                              {t("nodeToolbar.audio.downloadAs", {
                                format: format.toUpperCase(),
                              })}
                            </span>
                            {!available ? (
                              <span className="text-[10px] opacity-60">
                                {t("nodeToolbar.audio.m4aSourceOnlyHint")}
                              </span>
                            ) : null}
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuContent>
                  </DropdownMenu>
                );
              })()}
            {!isImageEdit && isAdjustableGroup && (() => {
              const groupColor = groupBackgroundColor;
              return (
                <>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <UiChipButton
                        key="group-color"
                        className={TOOLBAR_TEXT_BUTTON_CLASS}
                        title={t("canvas.nodeToolbar.groupBackground")}
                        onClick={(event) => event.stopPropagation()}
                      >
                        {groupColor ? (
                          <span
                            className="h-3.5 w-3.5 rounded-full border border-white/40"
                            style={{ backgroundColor: groupColor }}
                          />
                        ) : (
                          <Palette className="h-3.5 w-3.5" />
                        )}
                        {t("canvas.nodeToolbar.backgroundColor")}
                        <ChevronDown className="h-3 w-3" />
                      </UiChipButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="start"
                      sideOffset={6}
                      className={TOOLBAR_MENU_CONTENT_CLASS}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <div className="grid grid-cols-5 gap-1.5 p-1.5">
                        <button
                          type="button"
                          title={t("canvas.nodeToolbar.noColor")}
                          onClick={() => updateNodeData(nodeId, { backgroundColor: null })}
                          className={`relative flex h-6 w-6 items-center justify-center rounded-full border bg-transparent transition-transform hover:scale-110 ${
                            groupColor ? 'border-white/25' : 'border-white ring-1 ring-white/60'
                          }`}
                        >
                          <span className="absolute h-[1.5px] w-4 rotate-45 rounded bg-rose-400/80" />
                        </button>
                        {GROUP_COLOR_PRESETS.map((preset) => (
                          <button
                            key={preset.key}
                            type="button"
                            title={t(preset.labelKey)}
                            onClick={() =>
                              updateNodeData(nodeId, { backgroundColor: preset.value })
                            }
                            className={`h-6 w-6 rounded-full border-2 transition-transform hover:scale-110 ${
                              groupColor === preset.value
                                ? 'border-white'
                                : 'border-transparent'
                            }`}
                            style={{ backgroundColor: preset.value }}
                          />
                        ))}
                      </div>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <UiChipButton
                        key="group-arrange"
                        className={TOOLBAR_TEXT_BUTTON_CLASS}
                        title={t("canvas.nodeToolbar.arrangeMode")}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <LayoutGrid className="h-3.5 w-3.5" />
                        {t("canvas.multiSelect.arrange")}
                        <ChevronDown className="h-3 w-3" />
                      </UiChipButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="start"
                      sideOffset={6}
                      className={`${TOOLBAR_MENU_CONTENT_CLASS} min-w-[120px]`}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <DropdownMenuItem
                        className={TOOLBAR_MENU_ITEM_CLASS}
                        onSelect={() => arrangeGroupChildren(nodeId, 'grid')}
                      >
                        {t("canvas.nodeToolbar.arrangeGrid")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className={TOOLBAR_MENU_ITEM_CLASS}
                        onSelect={() => arrangeGroupChildren(nodeId, 'horizontal')}
                      >
                        {t("canvas.nodeToolbar.arrangeHorizontal")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className={TOOLBAR_MENU_ITEM_CLASS}
                        onSelect={() => arrangeGroupChildren(nodeId, 'vertical')}
                      >
                        {t("canvas.nodeToolbar.arrangeVertical")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  {isUngroupableGroup && (
                    <UiChipButton
                      key="group-ungroup"
                      className={`${TOOLBAR_TEXT_BUTTON_CLASS} hover:!border-amber-400/60 hover:!bg-amber-500/20 hover:!text-amber-200`}
                      onClick={(event) => {
                        event.stopPropagation();
                        closeDownloadMenu();
                        ungroupNode(nodeId);
                      }}
                    >
                      <Unlink2 className="h-3.5 w-3.5" />
                      {t("nodeToolbar.ungroup")}
                    </UiChipButton>
                  )}
                </>
              );
            })()}
            {protectedProjectionKey && (
              <UiChipButton
                key="projection-refresh"
                className={
                  projectionIsStale
                    ? `${TOOLBAR_TEXT_BUTTON_CLASS} !border-amber-300/60 !bg-amber-300/15 !text-amber-100 hover:!bg-amber-300/20`
                    : TOOLBAR_TEXT_BUTTON_CLASS
                }
                title={
                  projectionIsStale
                    ? t("freezone.projections.staleBadge")
                    : undefined
                }
                onClick={(event) => {
                  event.stopPropagation();
                  closeDownloadMenu();
                  canvasEventBus.publish("freezone/projection-sync", {
                    projectionKey: protectedProjectionKey,
                  });
                }}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {projectionIsStale
                  ? t("freezone.projections.syncStale")
                  : t("freezone.projections.sync")}
              </UiChipButton>
            )}
            {!isImageGenNode(node) && !isVideoNode(node) && !isAudioNode(node) && (
              <UiChipButton
                key="node-delete"
                className={`h-9 ${TOOLBAR_BUTTON_RADIUS_CLASS} !border-transparent !bg-transparent px-3 text-sm text-rose-200/85 hover:!bg-white/[0.08] hover:!text-rose-100`}
                onClick={(event) => {
                  event.stopPropagation();
                  closeDownloadMenu();
                  if (protectedProjectionKey) {
                    canvasEventBus.publish("freezone/projection-remove", {
                      projectionKey: protectedProjectionKey,
                    });
                    return;
                  }
                  deleteNode(node.id);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {protectedProjectionKey
                  ? t("freezone.projections.remove")
                  : t("common.delete")}
              </UiChipButton>
            )}
            {canCommitNode && (
              <UiChipButton
                key="node-commit"
                className={TOOLBAR_TEXT_BUTTON_CLASS}
                onClick={(event) => {
                  event.stopPropagation();
                  closeDownloadMenu();
                  canvasEventBus.publish("freezone/commit-node", {
                    nodeId: node.id,
                  });
                }}
                title={t("canvas.nodeToolbar.commitHint")}
              >
                <Send className="h-3.5 w-3.5" />
                {t("freezone.commit.submit")}
              </UiChipButton>
            )}
          </UiPanel>
          {/* 继续生成：只问两件事——生成多久、要演什么。提交后直接出片。 */}
          {isVideoNode(node) && showContinuePanel && (
            <UiPanel className="nodrag mt-1.5 w-full min-w-[280px] animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 rounded-[18px] !border-white/10 !bg-[#242426]/95 px-3 py-2.5 text-sm shadow-[0_10px_24px_rgba(0,0,0,0.28)] backdrop-blur-2xl duration-200 ease-out motion-reduce:animate-none">
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-[11px] text-text-dim">
                  {t("nodeToolbar.video.continueDurationLabel")}
                </span>
                <input
                  type="range"
                  min={continueMinSeconds}
                  max={continueMaxSeconds}
                  step={1}
                  value={continueDurationSeconds}
                  disabled={isContinuing}
                  onChange={(event) =>
                    setContinueDurationSeconds(Number(event.target.value))
                  }
                  onClick={(event) => event.stopPropagation()}
                  className="nodrag h-1.5 min-w-0 flex-1 cursor-pointer accent-cyan-300"
                  aria-label={t("nodeToolbar.video.continueDurationLabel")}
                />
                <span className="shrink-0 tabular-nums text-[12px] text-text-main">
                  {t("nodeToolbar.video.continueSeconds", {
                    count: continueDurationSeconds,
                  })}
                </span>
              </div>
              <textarea
                value={continuePrompt}
                onChange={(event) => setContinuePrompt(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                rows={2}
                placeholder={t("nodeToolbar.video.continuePromptPlaceholder")}
                className="nodrag mt-2 w-full resize-y rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-[12px] leading-relaxed text-text-main outline-none placeholder:text-text-dim focus:border-[rgb(var(--accent-rgb)/0.6)]"
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-[11px] text-text-dim">
                  {isSuggestingContinuePrompt
                    ? t("nodeToolbar.video.reshootPromptSuggestRunning")
                    : t("nodeToolbar.video.continueHint")}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    disabled={
                      isSuggestingContinuePrompt ||
                      isContinuing ||
                      reshootDurationSeconds === null
                    }
                    title={t("nodeToolbar.video.reshootPromptSuggest")}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleSuggestContinuePrompt();
                    }}
                    className="flex items-center gap-1 rounded-full border border-white/15 bg-white/10 px-2.5 py-1 text-[12px] text-text-main transition-colors hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
                    data-testid="video-continue-suggest"
                  >
                    {isSuggestingContinuePrompt ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Sparkles className="h-3 w-3" />
                    )}
                    {isSuggestingContinuePrompt
                      ? t("nodeToolbar.video.reshootPromptSuggestRunning")
                      : t("nodeToolbar.video.reshootPromptSuggest")}
                  </button>
                  <button
                    type="button"
                    disabled={isContinuing}
                    onClick={(event) => {
                      event.stopPropagation();
                      setShowContinuePanel(false);
                    }}
                    className="rounded-full border border-white/15 px-3 py-1 text-[12px] text-text-main transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t("nodeToolbar.video.continueCancel")}
                  </button>
                  <button
                    type="button"
                    disabled={isContinuing || continuePrompt.trim().length === 0}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleVideoContinue();
                    }}
                    className="flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[12px] text-text-main transition-colors hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
                    data-testid="video-continue-submit"
                  >
                    {isContinuing && <Loader2 className="h-3 w-3 animate-spin" />}
                    {t("nodeToolbar.video.continueSubmit")}
                  </button>
                </div>
              </div>
            </UiPanel>
          )}
          {/* 片段重拍的时间轴：放在工具栏面板外面、竖排在其下方——面板本身是
              flex 行，塞进去会把一排 chip 挤成两行。ZoomScaledToolbar 的子节点
              是普通块级盒，天然竖排。 */}
          {isVideoNode(node) && showReshootTimeline && (
            <UiPanel className="nodrag mt-1.5 w-full min-w-[280px] animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 rounded-[18px] !border-white/10 !bg-[#242426]/95 px-3 py-2.5 text-sm shadow-[0_10px_24px_rgba(0,0,0,0.28)] backdrop-blur-2xl duration-200 ease-out motion-reduce:animate-none">
              <VideoReshootTimeline
                durationSeconds={reshootDurationSeconds}
                startSeconds={reshootRange.start}
                endSeconds={
                  reshootRange.end > reshootRange.start
                    ? reshootRange.end
                    : (reshootDurationSeconds ?? 0)
                }
                disabled={isReshooting}
                videoUrl={reshootVideoUrl}
                onChange={(start, end) => setReshootRange({ start, end })}
              />
              <div className="mt-2 flex items-center gap-2">
                <span className="shrink-0 text-[11px] text-text-dim">
                  {t("nodeToolbar.video.reshootModelLabel")}
                </span>
                {/* 重拍用的模型。这里改的不是局部状态，而是直接写回节点的
                    `model`——单一状态源，节点面板里的选择器会跟着变。
                    不然同一节点上有两个模型下拉框，用户不知道以哪个为准。 */}
                <ProviderModelPicker
                  selectedModelId={reshootModelId}
                  models={reshootModels.models}
                  domain="video"
                  popoverPlacement="top"
                  getOptionDisabledReason={(option) =>
                    reshootModelUnsupportedFor(option)
                      ? t("nodeToolbar.video.reshootModelUnsupported")
                      : null
                  }
                  onChange={(nextModelId) => {
                    if (nextModelId === reshootModelId) return;
                    updateNodeData(node.id, { model: nextModelId });
                  }}
                />
              </div>
              {/* 提示词用多行文本域而不是单行 input：推荐出来的提示词动辄两三百字，
                  单行输入框只能看到末尾十几个字，用户没法改。 */}
              <textarea
                value={reshootPrompt}
                onChange={(event) => setReshootPrompt(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                rows={3}
                placeholder={t("nodeToolbar.video.reshootPromptPlaceholder")}
                className="nodrag mt-2 w-full resize-y rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-[12px] leading-relaxed text-text-main outline-none placeholder:text-text-dim focus:border-[rgb(var(--accent-rgb)/0.6)]"
              />
              <div className="mt-1.5 flex items-center justify-end gap-1.5">
                {/* 提示词注入：让视觉模型看着区间首尾两帧 + 时长，写进输入框。
                    只填框，不自动提交——模型看不到两帧之间原来发生了什么。 */}
                <button
                  type="button"
                  disabled={
                    isSuggestingPrompt ||
                    isReshooting ||
                    reshootRangeInvalid ||
                    reshootUnderMinDuration ||
                    !reshootVideoUrl
                  }
                  title={t("nodeToolbar.video.reshootPromptSuggest")}
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleSuggestReshootPrompt();
                  }}
                  className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-white/15 bg-white/10 px-2 text-[11px] text-text-main transition-colors hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSuggestingPrompt ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Sparkles className="h-3 w-3" />
                  )}
                  {isSuggestingPrompt
                    ? t("nodeToolbar.video.reshootPromptSuggestRunning")
                    : t("nodeToolbar.video.reshootPromptSuggest")}
                </button>
                {/* 提示词强化：按当前重拍模型的方言改写框里已有的文字。
                    空框没有可改的内容，先注入再强化。 */}
                <button
                  type="button"
                  disabled={
                    reshootPromptEnhance.busy ||
                    isReshooting ||
                    reshootPrompt.trim().length === 0
                  }
                  title={t("nodeToolbar.video.reshootPromptEnhance")}
                  onClick={(event) => {
                    event.stopPropagation();
                    reshootPromptEnhance.setOpen(true);
                  }}
                  className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-white/15 bg-white/10 px-2 text-[11px] text-text-main transition-colors hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {reshootPromptEnhance.busy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Wand2 className="h-3 w-3" />
                  )}
                  {reshootPromptEnhance.busy
                    ? t("nodeToolbar.video.reshootPromptEnhanceRunning")
                    : t("nodeToolbar.video.reshootPromptEnhance")}
                </button>
              </div>
              <EnhancePromptDialog
                open={reshootPromptEnhance.open}
                onOpenChange={reshootPromptEnhance.setOpen}
                dialects={VIDEO_PROMPT_DIALECTS}
                defaultDialect={dialectForVideoModel(reshootModelId)}
                busy={reshootPromptEnhance.busy}
                onConfirm={(dialect, strength) => {
                  void reshootPromptEnhance.run(reshootPrompt, dialect, strength);
                }}
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-[11px] text-text-dim">
                  {reshootPrompt.trim().length === 0
                    ? t("nodeToolbar.video.reshootPromptRequired")
                    : reshootOverMaxDuration
                      ? t("nodeToolbar.video.reshootOverMaxDuration", {
                          limit: reshootModelMaxDuration,
                        })
                      : reshootUnderMinDuration
                        ? t("nodeToolbar.video.reshootUnderMinDuration", {
                            limit: reshootModelMinDuration,
                          })
                        : reshootRangeInvalid
                          ? reshootDurationSeconds === null
                            ? t("nodeToolbar.video.reshootRangeUnknown")
                            : t("nodeToolbar.video.reshootRangeInvalid")
                          : t("nodeToolbar.video.reshootHint")}
                </span>
                <button
                  type="button"
                  disabled={
                    reshootRangeInvalid ||
                    reshootOverMaxDuration ||
                    reshootUnderMinDuration ||
                    isReshooting ||
                    reshootPrompt.trim().length === 0
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    if (
                      reshootRangeInvalid ||
                      reshootOverMaxDuration ||
                      reshootUnderMinDuration ||
                      isReshooting
                    ) {
                      return;
                    }
                    void handleVideoReshoot();
                  }}
                  className="flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[12px] text-text-main transition-colors hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isReshooting && (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  )}
                  {t("nodeToolbar.video.reshootSubmit")}
                </button>
              </div>
            </UiPanel>
          )}
          </ZoomScaledToolbar>
        </ReactFlowNodeToolbar>
      </>
    );
  },
);

NodeActionToolbar.displayName = "NodeActionToolbar";
