// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useState } from 'react';
import { GitBranch, Loader2, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  getShotRecipe,
  listShotRecipes,
  type ShotRecipe,
  type ShotRecipeCostLedger,
  type ShotRecipeVersion,
} from '@/api/ops';
import { CANVAS_NODE_OPS_PANEL_CLASS } from '@/features/canvas/ui/nodeFrameStyles';

interface ShotRecipePanelProps {
  /** SuperTale project_id（不是显示名）。 */
  project: string;
  /** 当前视频节点 id：面板标题里显示溯源归属的节点。 */
  nodeId: string;
  onClose: () => void;
}

/**
 * 溯源链的渲染行：把「root → … → 本版本」预展开成缩进，parent 关系一眼可读，
 * 而不是让用户自己去 versions 数组里按 id 找父节点。
 */
interface VersionRow {
  version: ShotRecipeVersion;
  depth: number;
  /** 父 id 在本次返回的版本里找不到（或首版）——首版为 null。 */
  parentId: string | null;
  parentMissing: boolean;
  isTip: boolean;
}

function buildRows(versions: ShotRecipeVersion[]): VersionRow[] {
  const byId = new Map(
    versions.map((version) => [String(version.version_id), version]),
  );
  return versions.map((version) => {
    const id = String(version.version_id);
    // lineage 是 GET 详情给的 root → … → 本版本 链。用链长算缩进，链条断了
    // （父版本被墓碑隐藏等）就退回数组顺序，反正父 id 本身照常显示。
    const lineage = Array.isArray(version.lineage) ? version.lineage : [];
    const depth = lineage.length > 1 && lineage[lineage.length - 1] === id
      ? lineage.length - 1
      : 0;
    const parentId = version.parent_version_id ? String(version.parent_version_id) : null;
    return {
      version,
      depth,
      parentId,
      parentMissing: Boolean(parentId) && !byId.has(parentId as string),
      isTip: parentId === null || versions.every((item) => item.parent_version_id !== id),
    };
  });
}

/** cost_ledger 的诚实渲染：没有报价就说没有报价，不编造 0 或价格。 */
function costText(
  ledger: ShotRecipeCostLedger | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (!ledger) return t('node.shotRecipe.costUnknown');
  if (
    ledger.quoted !== true &&
    (typeof ledger.reason === 'string' || typeof ledger.quoted === 'boolean')
  ) {
    return t('node.shotRecipe.costUnavailable', {
      reason: ledger.reason || t('node.shotRecipe.costUnknownReason'),
    });
  }
  if (ledger.display) return ledger.display;
  if (typeof ledger.total_cost === 'number') {
    return t('node.shotRecipe.costTotal', {
      value: ledger.total_cost,
      unit: ledger.unit || 'call',
    });
  }
  return t('node.shotRecipe.costUnknown');
}

function capabilityText(
  version: ShotRecipeVersion,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const snapshot = version.model_snapshot;
  if (!snapshot || snapshot.capabilities_known !== true) {
    // 目录读不到 ≠ 模型不支持。显式降级，不渲染任何能力数值。
    const modelId = snapshot?.model_id || version.model_id || '';
    return modelId
      ? t('node.shotRecipe.capabilitiesUnknown', { model: modelId })
      : t('node.shotRecipe.capabilitiesUnknownNoModel');
  }
  const parts: string[] = [];
  const duration =
    typeof snapshot.minDuration === 'number' && typeof snapshot.maxDuration === 'number'
      ? `${snapshot.minDuration}-${snapshot.maxDuration}s`
      : '';
  if (duration) parts.push(duration);
  if (Array.isArray(snapshot.supportedModes) && snapshot.supportedModes.length > 0) {
    parts.push(snapshot.supportedModes.join('/'));
  }
  if (typeof snapshot.referenceImageMax === 'number') {
    parts.push(t('node.shotRecipe.referenceImageMax', { value: snapshot.referenceImageMax }));
  }
  return parts.length > 0 ? parts.join(' · ') : t('node.shotRecipe.capabilitiesEmpty');
}

/**
 * 镜头配方面板：配方列表 + 版本链 + parent 溯源。
 *
 * 只读既有后端数据，不新增任何积分 / 扣费 / 余额机制——cost_ledger 是后端记录的
 * 既有 `get_credit_quote()` 结果，这里原样展示（拿不到报价时明说拿不到）。
 */
export function ShotRecipePanel({ project, nodeId, onClose }: ShotRecipePanelProps) {
  const { t } = useTranslation();
  const [recipes, setRecipes] = useState<ShotRecipeHeaderRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ShotRecipe | null>(null);
  const [isLoadingList, setIsLoadingList] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    if (!project) return;
    setIsLoadingList(true);
    setError(null);
    try {
      const list = await listShotRecipes(project);
      setRecipes(list);
      setSelectedId((current) => current ?? list[0]?.recipe_id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoadingList(false);
    }
  }, [project]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    if (!project || !selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setIsLoadingDetail(true);
    (async () => {
      try {
        const recipe = await getShotRecipe(project, selectedId);
        if (!cancelled) setDetail(recipe);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setIsLoadingDetail(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project, selectedId]);

  const versionRows = useMemo(
    () => buildRows(detail?.versions ?? []),
    [detail?.versions],
  );
  const lookDecisions = detail?.look_decisions ?? [];

  return (
    <div
      className={`nodrag ${CANVAS_NODE_OPS_PANEL_CLASS} absolute left-0 right-0 z-[400] flex max-h-[420px] flex-col overflow-hidden`}
      style={{ top: 'calc(100% + 8px)' }}
      data-testid="shot-recipe-panel"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-white/60" />
        <span className="text-[11px] font-medium text-white/80">
          {t('node.shotRecipe.title')}
        </span>
        <span className="truncate text-[10px] text-white/40">{nodeId}</span>
        <button
          type="button"
          className="ml-auto text-white/50 hover:text-white/80"
          onClick={() => void refreshList()}
          data-testid="shot-recipe-refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="text-white/50 hover:text-white/80"
          onClick={onClose}
          data-testid="shot-recipe-close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {isLoadingList && recipes.length === 0 && (
        <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-white/50">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('node.shotRecipe.loading')}
        </div>
      )}

      {!isLoadingList && recipes.length === 0 && !error && (
        <div className="px-3 py-3 text-[11px] text-white/50" data-testid="shot-recipe-empty">
          {t('node.shotRecipe.empty')}
        </div>
      )}

      {error && (
        <div
          className="px-3 py-2 text-[11px] text-red-300 break-words [overflow-wrap:anywhere]"
          data-testid="shot-recipe-failed"
        >
          {t('node.shotRecipe.failed', { detail: error })}
        </div>
      )}

      {recipes.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b border-white/10 px-3 py-2">
          {recipes.map((recipe) => (
            <button
              key={recipe.recipe_id}
              type="button"
              className={`rounded px-2 py-0.5 text-[10px] ${
                recipe.recipe_id === selectedId
                  ? 'bg-white/15 text-white/90'
                  : 'bg-white/5 text-white/50 hover:text-white/80'
              }`}
              onClick={() => setSelectedId(recipe.recipe_id)}
              data-testid={`shot-recipe-item-${recipe.recipe_id}`}
            >
              {recipe.title || recipe.recipe_id}
            </button>
          ))}
        </div>
      )}

      {detail && (
        <div className="flex-1 overflow-y-auto px-3 py-2">
          <div className="mb-2 text-[10px] uppercase tracking-wide text-white/40">
            {t('node.shotRecipe.versionChain')}
          </div>
          {versionRows.length === 0 && !isLoadingDetail && (
            <div className="text-[11px] text-white/50">{t('node.shotRecipe.noVersions')}</div>
          )}
          <ol className="flex flex-col gap-1.5">
            {versionRows.map((row) => {
              const version = row.version;
              const id = String(version.version_id);
              return (
                <li
                  key={id}
                  className="rounded bg-white/5 px-2 py-1.5"
                  style={{ marginLeft: row.depth * 12 }}
                  data-testid={`shot-recipe-version-${id}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-medium text-white/85">{id}</span>
                    <span className="rounded bg-white/10 px-1 text-[9px] text-white/60">
                      {version.status || t('node.shotRecipe.statusUnknown')}
                    </span>
                    {row.isTip && (
                      <span className="text-[9px] text-emerald-300/80">
                        {t('node.shotRecipe.tip')}
                      </span>
                    )}
                    <span className="ml-auto text-[9px] text-white/35">
                      {t('node.shotRecipe.promptDeltaMode', {
                        mode: version.prompt_delta?.mode || '-',
                      })}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-white/45" data-testid={`shot-recipe-parent-${id}`}>
                    {row.parentId
                      ? t('node.shotRecipe.parent', { value: row.parentId })
                      : t('node.shotRecipe.root')}
                    {row.parentMissing && ` ${t('node.shotRecipe.parentMissing')}`}
                  </div>
                  {version.prompt_delta?.prompt && (
                    <div className="mt-0.5 truncate text-[10px] text-white/60">
                      {version.prompt_delta.prompt}
                    </div>
                  )}
                  <div className="mt-0.5 text-[10px] text-white/45" data-testid={`shot-recipe-capabilities-${id}`}>
                    {capabilityText(version, t)}
                  </div>
                  <div className="mt-0.5 text-[10px] text-white/45" data-testid={`shot-recipe-cost-${id}`}>
                    {costText(version.cost_ledger, t)}
                  </div>
                </li>
              );
            })}
          </ol>

          {lookDecisions.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-white/40">
                {t('node.shotRecipe.lookDecisions')}
              </div>
              {lookDecisions.map((decision) => (
                <div
                  key={decision.decision_id}
                  className="mb-1 rounded bg-white/5 px-2 py-1.5 text-[10px] text-white/60"
                  data-testid={`shot-recipe-look-${decision.decision_id}`}
                >
                  <div className="text-white/80">
                    {decision.character_name || decision.identity_id}
                  </div>
                  <div className="text-white/45">
                    {decision.identity_known === false
                      ? t('node.shotRecipe.identityUnknown')
                      : t('node.shotRecipe.identityKnown', {
                          value: decision.identity_id,
                        })}
                    {decision.version_id
                      ? ` · ${t('node.shotRecipe.boundVersion', { value: decision.version_id })}`
                      : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** listShotRecipes 返回的配方头（单独起名，避免与 @/api/ops 的 ShotRecipeHeader 撞名）。 */
type ShotRecipeHeaderRow = ShotRecipe['recipe'];

export default ShotRecipePanel;