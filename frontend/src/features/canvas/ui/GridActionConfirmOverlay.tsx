// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useMemo, useState } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar, Position } from '@xyflow/react';
import { ArrowUp, Image as ImageIcon, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { resolveFixedFeatureModelRequest } from '@/features/canvas/domain/fixedFeatureModelRequest';
import {
  resolveModelQualityOptions,
  resolveModelSizeOptions,
} from '@/features/canvas/domain/mediaModelOptions';
import { useCanvasStore } from '@/stores/canvasStore';
import {
  fetchFreezoneJobResult,
  submitFreezoneTemplateEdit,
  type FreezoneTemplateEditMode,
} from '@/api/ops';
import { CreditCostInline } from '@/components/credit-cost-inline';
import { awaitTaskCompletion, isTaskPollTimeoutError } from '@/api/tasks';
import { notifyTaskStillRunning } from '@/features/canvas/application/errorDialog';
import { generationTaskDescriptor } from '@/features/canvas/application/resumeGeneration';
import {
  isAuthoritativeEmptyCatalog,
  useFreezoneImageModels,
} from '@/features/canvas/hooks/useFreezoneImageModels';
import { useGenerationCreditCost } from '@/lib/queries/generation-credit-cost';
import { BillingRuleNotConfiguredError } from '@/lib/api-errors';
import { readUrl } from '@/lib/url-params';
import { FREEZONE_IMAGE_FEATURES } from '@/features/canvas/application/freezoneImageFeatureBilling';
import { NODE_TOOLBAR_CLASS } from './nodeToolbarConfig';
import { CANVAS_NODE_TOOLBAR_CARD_CLASS } from './nodeFrameStyles';
import { ProviderModelPicker } from './ProviderModelPicker';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export type GridActionKey =
  | 'multiCameraGrid'
  | 'plotFourGrid'
  | 'faceThreeView'
  | 'productThreeView'
  | 'serialStoryboard25'
  | 'cinematicLightCorrection'
  | 'characterThreeView'
  | 'frameProjection3sLater'
  | 'frameProjection5sEarlier';

const GRID_ACTION_MODE_MAP: Record<GridActionKey, FreezoneTemplateEditMode> = {
  multiCameraGrid: 'multi_camera_nine_grid',
  plotFourGrid: 'story_pitch_four_grid',
  faceThreeView: 'character_face_three_view',
  productThreeView: 'product_three_view',
  serialStoryboard25: 'storyboard_25_grid',
  cinematicLightCorrection: 'cinematic_light_correction',
  characterThreeView: 'character_three_view_generation',
  frameProjection3sLater: 'image_projection_after_3s',
  frameProjection5sEarlier: 'image_projection_before_5s',
};

// 与后端 `template_edit_aspect_ratio` 保持一致：宫格模板的输出比例是模板
// 语义的一部分（三视图固定 3:2 等），前端只读展示，不提供覆盖。
const GRID_ACTION_ASPECT_MAP: Record<GridActionKey, string> = {
  multiCameraGrid: 'original',
  plotFourGrid: 'original',
  faceThreeView: '3:2',
  productThreeView: '3:2',
  serialStoryboard25: 'original',
  cinematicLightCorrection: 'original',
  characterThreeView: '16:9',
  frameProjection3sLater: 'original',
  frameProjection5sEarlier: 'original',
};

export interface GridActionRequest {
  nodeId: string;
  key: GridActionKey;
  label: string;
  prompt: string;
  cost: number;
}

export interface GridActionSubmitPayload {
  sourceNodeId: string;
  imageSource: string;
  actionKey: GridActionKey;
  label: string;
  prompt: string;
  cost: number;
  generationMode: 'image_reference';
  requestAspectRatio: 'auto';
  submittedAt: string;
}

interface GridActionConfirmOverlayProps {
  node: CanvasNode;
  imageSource: string;
  request: GridActionRequest;
  onClose: () => void;
}

export const GridActionConfirmOverlay = memo(
  ({ node, imageSource, request, onClose }: GridActionConfirmOverlayProps) => {
    const { t } = useTranslation();
    const addNode = useCanvasStore((state) => state.addNode);
    const addEdge = useCanvasStore((state) => state.addEdge);
    const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
    const findNodePosition = useCanvasStore((state) => state.findNodePosition);
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const imageCatalog = useFreezoneImageModels();
    const imageModels = imageCatalog.models;
    // 用户显式选择的模型 / 尺寸 / 画质；null = 跟随面板默认（目录首模型 + 后台档位）。
    const [modelKey, setModelKey] = useState<string | null>(null);
    const [sizeOverride, setSizeOverride] = useState<string | null>(null);
    const [qualityOverride, setQualityOverride] = useState<string | null>(null);
    const selectedModel = useMemo(() => {
      if (!modelKey) return imageModels[0];
      return (
        imageModels.find(
          (entry) =>
            entry.id === modelKey ||
            entry.catalogId === modelKey ||
            entry.apiModel === modelKey
        ) ?? imageModels[0]
      );
    }, [imageModels, modelKey]);
    // 后台确实一个图片模型都没配时禁止提交：提交下去后端拿不到目录条目会直接
    // 409，先让用户点一下再报错是最糟的体验。
    const catalogIsEmpty = isAuthoritativeEmptyCatalog(imageCatalog);
    const gridMode = GRID_ACTION_MODE_MAP[request.key];
    const sizeOptions = useMemo(
      () => resolveModelSizeOptions(selectedModel),
      [selectedModel],
    );
    const qualityOptions = useMemo(
      () => resolveModelQualityOptions(selectedModel),
      [selectedModel],
    );
    // 报价与提交必须来自同一次解析，见 `resolveFixedFeatureModelRequest` 的注释；
    // 用户选的档位经 pickAllowedOption 收敛，不会被目录外值污染。
    const modelRequest = useMemo(
      () =>
        resolveFixedFeatureModelRequest(
          selectedModel,
          { mode: gridMode },
          {
            ...(sizeOverride ? { size: sizeOverride } : {}),
            ...(qualityOverride ? { quality: qualityOverride } : {}),
          },
        ),
      [gridMode, qualityOverride, selectedModel, sizeOverride],
    );
    const handleSelectModel = useCallback((nextKey: string | null) => {
      // Select 清空（null）时保持当前模型不动。
      if (!nextKey) return;
      // 换模型后旧模型的档位可能不存在于新模型，先回到面板默认再让用户重选。
      setModelKey(nextKey);
      setSizeOverride(null);
      setQualityOverride(null);
    }, []);
    const gridActionCost = useGenerationCreditCost(
      'feature',
      selectedModel ? FREEZONE_IMAGE_FEATURES.grid : null,
      {
        surface: 'canvas',
        params: modelRequest.billingParams,
      },
    );
    const billingRuleMissing =
      gridActionCost.error instanceof BillingRuleNotConfiguredError;
    const submitDisabled = billingRuleMissing || catalogIsEmpty;
    const costDisplay =
      gridActionCost.data?.data.display ??
      (billingRuleMissing ? t('common.billingRuleNotConfiguredShort') : null);

    const handleSubmit = useCallback(async () => {
      // 按钮已经禁用，这里再挡一道：没有模型就绝不该发出请求。
      if (catalogIsEmpty) return;
      const project = readUrl().project;
      if (!project) {
        console.error('[grid-action] no project in URL — cannot submit');
        return;
      }

      const sourceAspectRatio =
        typeof (node.data as { aspectRatio?: unknown }).aspectRatio === 'string'
          ? ((node.data as { aspectRatio?: string }).aspectRatio ?? DEFAULT_ASPECT_RATIO)
          : DEFAULT_ASPECT_RATIO;
      const position = findNodePosition(
        node.id,
        EXPORT_RESULT_NODE_DEFAULT_WIDTH,
        EXPORT_RESULT_NODE_LAYOUT_HEIGHT
      );
      const generationStartedAt = Date.now();
      const nextNodeId = addNode(
        CANVAS_NODE_TYPES.exportImage,
        position,
        {
          displayName: request.label,
          imageUrl: null,
          previewImageUrl: null,
          aspectRatio: sourceAspectRatio,
          resultKind: 'generic',
          isGenerating: true,
          generationStartedAt,
        }
      );
      addEdge(node.id, nextNodeId);
      setSelectedNode(nextNodeId);
      onClose();

      try {
        const ref = await submitFreezoneTemplateEdit(project, {
          sourceUrl: imageSource.split('?')[0],
          mode: gridMode,
          prompt: request.label,
          ...modelRequest.submit,
        });
        updateNodeData(nextNodeId, generationTaskDescriptor(ref));
        const completed = await awaitTaskCompletion(ref.task_key, project, { taskType: ref.task_type });
        const directUrl = completed.result?.['output_url'] as string | undefined;
        let url = directUrl;
        if (!url) {
          const fallback = await fetchFreezoneJobResult(project, ref.task_type, ref.job_id);
          url = fallback.url;
        }
        updateNodeData(nextNodeId, {
          imageUrl: url,
          previewImageUrl: url,
          isGenerating: false,
          generationStartedAt: null,
          generationError: null,
        });
      } catch (err) {
        // 轮询超时 ≠ 生成失败：后端还在跑，节点上的任务句柄仍可续接。
        // 写错误横幅会把一个还活着的任务标成失败，并清掉句柄。
        if (isTaskPollTimeoutError(err)) {
          notifyTaskStillRunning(t);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error('[grid-action] generation failed', err);
        updateNodeData(nextNodeId, {
          isGenerating: false,
          generationStartedAt: null,
          generationError: message,
        });
      }
    }, [
      addEdge,
      addNode,
      catalogIsEmpty,
      findNodePosition,
      gridMode,
      imageSource,
      modelRequest,
      node,
      onClose,
      request,
      setSelectedNode,
      t,
      updateNodeData,
    ]);

    return (
      <ReactFlowNodeToolbar
        nodeId={node.id}
        isVisible
        position={Position.Bottom}
        align="center"
        offset={12}
        className={NODE_TOOLBAR_CLASS}
      >
        <div
          // 多行内容用卡片容器（rounded-2xl）：胶囊（rounded-full）是单行设计，
          // 两行参数网格会顶出圆角边界。
          className={`flex min-w-[440px] flex-col gap-1.5 p-2 ${CANVAS_NODE_TOOLBAR_CARD_CLASS}`}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-dark/70 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
              onClick={onClose}
              title={t('nodeToolbar.gridMenu.confirmBar.close')}
            >
              <X className="h-4 w-4" />
            </button>

            <div className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-xs text-text-dark">
              <ImageIcon className="h-3.5 w-3.5 shrink-0 text-text-muted" />
              <span className="truncate font-medium">{request.label}</span>
            </div>
            <CreditCostInline
              display={costDisplay}
              promotion={gridActionCost.data?.data.promotion}
            />

            <button
              type="button"
              disabled={submitDisabled}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-bg-dark transition-colors hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={handleSubmit}
              title={
                catalogIsEmpty
                  ? t('modelParams.noModelsAvailable')
                  : t('nodeToolbar.gridMenu.confirmBar.submit')
              }
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </div>
          {/* 参数区：标签-控件网格对齐。比例是模板语义（跟随源图 / 固定值），只读展示。 */}
          <div className="grid grid-cols-[36px_minmax(0,1fr)_36px_minmax(0,auto)] items-center gap-x-2 gap-y-1.5 border-t border-white/[0.06] pt-1.5 text-[11px]">
            <span className="text-text-muted">
              {t('nodeToolbar.gridMenu.confirmBar.modelLabel')}
            </span>
            <ProviderModelPicker
              selectedModelId={
                selectedModel
                  ? String(
                      selectedModel.id ??
                        selectedModel.catalogId ??
                        selectedModel.apiModel ??
                        ''
                    )
                  : ''
              }
              onChange={handleSelectModel}
              models={imageModels}
              popoverPlacement="top"
              className="min-w-0"
            />
            <span className="text-text-muted">
              {t('nodeToolbar.gridMenu.confirmBar.aspectLabel')}
            </span>
            <span
              className="truncate text-text-dark/80"
              title={t('nodeToolbar.gridMenu.confirmBar.aspectNote')}
            >
              {GRID_ACTION_ASPECT_MAP[request.key] === 'original'
                ? t('nodeToolbar.gridMenu.confirmBar.aspectFollowSource')
                : GRID_ACTION_ASPECT_MAP[request.key]}
            </span>
            <span className="text-text-muted">
              {t('nodeToolbar.gridMenu.confirmBar.sizeLabel')}
            </span>
            <Select
              value={modelRequest.submit.imageSize}
              onValueChange={setSizeOverride}
              disabled={sizeOptions.length <= 1}
            >
              <SelectTrigger className="nodrag h-6 rounded-full border-white/10 bg-white/[0.04] px-2.5 font-medium text-text-dark transition-colors hover:border-white/20 hover:bg-white/[0.07]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {sizeOptions.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-text-muted">
              {t('nodeToolbar.gridMenu.confirmBar.qualityLabel')}
            </span>
            {qualityOptions.length > 0 ? (
              <Select
                value={modelRequest.submit.quality ?? ''}
                onValueChange={setQualityOverride}
              >
                <SelectTrigger className="nodrag h-6 rounded-full border-white/10 bg-white/[0.04] px-2.5 font-medium text-text-dark transition-colors hover:border-white/20 hover:bg-white/[0.07]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  {qualityOptions.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="text-text-dark/50">—</span>
            )}
          </div>
        </div>
      </ReactFlowNodeToolbar>
    );
  }
);

GridActionConfirmOverlay.displayName = 'GridActionConfirmOverlay';
