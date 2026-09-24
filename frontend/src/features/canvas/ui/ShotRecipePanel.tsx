// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GitBranch, Loader2, Play, RefreshCw, Scissors, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  getShotRecipe,
  listShotRecipes,
  preflightShotRecipeVersion,
  qualityShotRecipeVersion,
  renderShotRecipeVersion,
  reshootShotRecipeVersion,
  syncShotRecipeVersion,
  type ShotRecipe,
  type ShotRecipeCostLedger,
  type ShotRecipePreflightCheck,
  type ShotRecipePreflightReport,
  type ShotRecipeQualityReport,
  type ShotRecipeRiskSeverity,
  type ShotRecipeVersion,
} from '@/api/ops';
import { CANVAS_NODE_OPS_PANEL_CLASS } from '@/features/canvas/ui/nodeFrameStyles';
import { useCanvasStore } from '@/stores/canvasStore';

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
 * 「可以提交渲染」的判据：版本是 ready、还没带 job_id，且**能力目录已知**。
 *
 * capabilities_known=false 表示模型目录读不到，不等于模型支持——后端会 409，
 * 所以这里根本不给入口，而不是让用户点了再失败。
 */
function canRender(version: ShotRecipeVersion): boolean {
  if (version.status !== 'ready') return false;
  if (version.source_refs?.job_id) return false;
  return version.model_snapshot?.capabilities_known === true;
}

/**
 * 预检入口的判据：**故意比 canRender 宽松**。
 *
 * 预检的意义正是在「还不能渲染」时告诉用户为什么（能力目录读不到、素材丢了、
 * 报价拿不到），所以只看版本是否 ready；failed / rendering / completed 不给入口，
 * 免得让人以为可以重跑。
 */
function canPreflight(version: ShotRecipeVersion): boolean {
  return version.status === 'ready';
}

/**
 * 重拍入口的判据：**只有出过片的版本**才谈得上重拍。
 *
 * 判据与后端守卫同源（status === 'completed' 且有 artifact_url）：没产物就没有可
 * 重拍的源视频，给入口只会让用户白吃一次 409。已经重拍过的版本（配方里已有以它为
 * reshoot_of 的子版本）仍给入口——是否再拍由后端幂等 409 回答，前端不做跨行推断。
 */
function canReshoot(version: ShotRecipeVersion): boolean {
  if (version.status !== 'completed') return false;
  return typeof version.source_refs?.artifact_url === 'string'
    && version.source_refs.artifact_url.length > 0;
}

/**
 * 重拍表单的本地校验：`end > start` 且都是有限数。
 *
 * 后端对非法区间是 400——但让用户先等一次往返再报错毫无意义，这里就地拦下。
 * 模型上下限不在这里判（目录事实只有后端有），越界仍由后端 400 如实回答。
 */
function reshootRangeError(start: string, end: string): boolean {
  const startValue = Number(start);
  const endValue = Number(end);
  if (!Number.isFinite(startValue) || !Number.isFinite(endValue)) return true;
  if (startValue < 0) return true;
  return endValue <= startValue;
}

/** 单条 check 的颜色：block 红 / warn 黄 / pass 弱化——绝不把 warn 画成 pass。 */
function checkStatusClass(status: ShotRecipePreflightCheck['status']): string {
  if (status === 'block') return 'text-red-300';
  if (status === 'warn') return 'text-amber-300';
  return 'text-white/40';
}

/**
 * 质量风险的颜色：critical 红 / warning 黄 / info 弱化。
 *
 * 与预检的 checkStatusClass 刻意分开：语义不同（critical ≠ block，info ≠ pass），
 * 复用一个函数只会让两套分档在下次改动时互相牵连。
 */
function riskSeverityClass(severity: ShotRecipeRiskSeverity): string {
  if (severity === 'critical') return 'text-red-300';
  if (severity === 'warning') return 'text-amber-300';
  return 'text-white/40';
}

/**
 * 质量报告的一句话摘要：按 severity 报数。
 *
 * 没有任何风险时说的是「逐条读过、没发现风险」，而不是「质量合格」——报告本来
 * 就没有、也不该有一个总评分可以下这种结论。
 */
function qualitySummaryText(
  report: ShotRecipeQualityReport,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const counts = report.counts ?? {};
  const total =
    (counts.critical ?? 0) + (counts.warning ?? 0) + (counts.info ?? 0);
  if (total === 0) return t('node.shotRecipe.qualityClean');
  return t('node.shotRecipe.qualitySummary', {
    critical: counts.critical ?? 0,
    warning: counts.warning ?? 0,
    info: counts.info ?? 0,
  });
}

/**
 * evidence 的展示：能指回具体记录的键值对，一行 `k=v`。
 *
 * 空 evidence 不渲染成空串——那看起来像「没有证据」，而 report 的契约恰恰要求
 * evidence 必须存在。
 */
function evidenceText(evidence: Record<string, unknown> | undefined): string {
  if (!evidence) return '';
  const entries = Object.entries(evidence).filter(([, value]) => value !== '' && value != null);
  return entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ');
}

/**
 * 预检结论的一句话摘要：ok=false 时**明说哪几条 block**。
 *
 * warn 只报数，不合并进「通过」；没有任何 block 时也不宣称「可以渲染」——那是
 * 调用方的判断。
 */
function preflightSummaryText(
  report: ShotRecipePreflightReport,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (!report.ok) {
    return t('node.shotRecipe.preflightBlocked', {
      ids: (report.blocking ?? []).join(', '),
    });
  }
  if ((report.warnings ?? []).length > 0) {
    return t('node.shotRecipe.preflightWarnings', {
      ids: report.warnings.join(', '),
    });
  }
  return t('node.shotRecipe.preflightAllPassed');
}

/** 取 source_refs 里的字符串字段：非字符串/空串一律当没有。 */
function refString(
  refs: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = refs?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 渲染终态的展示：completed 给产物链接，failed 给后端原话。
 *
 * 中间态（rendering）与无终态时返回 null——不编造进度，也不把「在跑」渲染成「好了」。
 */
function renderOutcomeText(
  version: ShotRecipeVersion,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  const status = version.status;
  if (status === 'completed') {
    const url = typeof version.source_refs?.artifact_url === 'string'
      ? version.source_refs.artifact_url
      : '';
    return url
      ? t('node.shotRecipe.renderCompleted', { url })
      : t('node.shotRecipe.renderCompletedNoUrl');
  }
  if (status === 'failed') {
    const detail = typeof version.source_refs?.error === 'string'
      ? version.source_refs.error
      : '';
    return t('node.shotRecipe.renderFailed', {
      detail: detail || t('node.shotRecipe.renderFailedNoDetail'),
    });
  }
  return null;
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
  /** 发过渲染/对账的版本 id：按钮禁用，防止连点出多次假任务。 */
  const [busyVersionId, setBusyVersionId] = useState<string | null>(null);
  /** 正在预检的版本 id（预检也是真实网络动作，必须有 busy 态）。 */
  const [preflightingVersionId, setPreflightingVersionId] = useState<string | null>(
    null,
  );
  /** 每个版本最近一次的预检报告，按 version_id 存。 */
  const [preflightReports, setPreflightReports] = useState<
    Record<string, ShotRecipePreflightReport>
  >({});
  /** 正在跑质量报告的版本 id（也是真实网络动作，必须有 busy 态）。 */
  const [qualityVersionId, setQualityVersionId] = useState<string | null>(null);
  /** 每个版本最近一次的质量报告，按 version_id 存。 */
  const [qualityReports, setQualityReports] = useState<
    Record<string, ShotRecipeQualityReport>
  >({});
  /** 正在提交重拍的版本 id（重拍也是真实入队动作，必须有 busy 态）。 */
  const [reshootingVersionId, setReshootingVersionId] = useState<string | null>(
    null,
  );
  /** 展开了重拍表单的版本 id（同一时刻只展开一个）。 */
  const [reshootFormVersionId, setReshootFormVersionId] = useState<string | null>(
    null,
  );
  /** 每个版本重拍表单的输入（起止秒 + 可选提示词）。 */
  const [reshootInputs, setReshootInputs] = useState<
    Record<string, { start: string; end: string; prompt: string }>
  >({});
  /** 每次明细刷新后自增的世代号：异步回写只认最新一代，避免用旧列表覆盖新数据。 */
  const detailGenerationRef = useRef(0);
  /**
   * 渲染产物回写画布的结果：把产物写进本节点后，面板上给一条明确回执。
   *
   * 这里**不建边**。本面板只认自己绑定的那条 versions 链：一次渲染产出的是该版本
   * 绑定的那个视频节点的成片（回执 source_refs.node_id 与面板 props.nodeId 同一），
   * 产物回写它自己就够了。
   *
   * ⚠️ T016 曾在此写「video→video 不在白名单、addEdge 静默返回 null，所以只能让
   * 用户手动拖线」——**那是错的**。实测（jsdom 里跑真 canvasStore）：真实的建边
   * 规则是 UPSTREAM_SOURCE_WHITELIST（只约束 audio 的上游）与 DOWNSTREAM_TARGET_
   * WHITELIST（只约束 audio / style 的下游）；video→video 两张表都不限制，
   * addEdge(video, video) 返回 `e-a-b`（建成）。源码里另有两份**同名不同物**的
   * 菜单候选表 DOWNSTREAM_SPAWN_WHITELIST / UPSTREAM_SPAWN_WHITELIST 写着
   * video 的上游 = text/imageGen/audio/directorDesk，那只决定「+ 菜单能创建什么」，
   * 不参与 addEdge 收口。所以「不能建边」的说法作废，不再据此提示用户。
   */
  const [canvasWriteback, setCanvasWriteback] = useState<
    { nodeId: string; artifactUrl: string } | null
  >(null);
  /** 刚完成回写的版本 id：提示只挂在这一行上，不糊到整条链。 */
  const [renderedVersionId, setRenderedVersionId] = useState<string | null>(null);

  const applyDetail = useCallback((recipe: ShotRecipe) => {
    setDetail(recipe);
    detailGenerationRef.current += 1;
  }, []);

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
        if (!cancelled) {
          setDetail(recipe);
          detailGenerationRef.current += 1;
        }
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

  /**
   * 渲染入口的真实动作：入队一次，然后**立刻对账一次**。
   *
   * 入队只证明任务提交成功，不代表出片；对账把任务推进到终态（跑完→completed、
   * 失败→failed、还在跑→保持 rendering 且 changed=false）。中间态一律保留
   * rendering，不伪装成完成。
   */
  const handleRender = useCallback(
    async (version: ShotRecipeVersion) => {
      if (!project || !selectedId) return;
      const modelId = version.model_snapshot?.model_id || version.model_id || '';
      if (!modelId) {
        setError(t('node.shotRecipe.renderNoModel'));
        return;
      }
      const versionId = String(version.version_id);
      setBusyVersionId(versionId);
      setError(null);
      setCanvasWriteback(null);
      setRenderedVersionId(versionId);
      const generation = detailGenerationRef.current;
      try {
        await renderShotRecipeVersion(project, selectedId, versionId, {
          modelId,
          durationSeconds: version.duration_seconds ?? undefined,
          resolution: version.resolution ?? undefined,
        });
        const receipt = await syncShotRecipeVersion(project, selectedId, versionId);
        if (receipt.changed && receipt.status === 'completed' && !receipt.artifact_url) {
          // 任务自称完成却没有产物：这不是「已完成」，如实说出来。
          setError(t('node.shotRecipe.renderNoArtifact'));
        }
        // 产物落回画布：**回写对象是本节点自己**。
        //
        // 依据是面板的挂载契约：ShotRecipePanel 由 VideoNode 挂载（VideoNode.tsx
        // 传 `nodeId={id}`），而版本行的 source_refs.node_id 正是写配方时绑定的那个
        // 视频节点 —— 两者是同一个节点。所以这里不需要、也不应该从回执里找「产物节点
        // id」：后端从来没有这个字段（T016 前误读的那个 artifact_node_id 在任何一端
        // 都不存在）。渲染产物就是这条版本绑定的那个视频节点的成片。
        //
        // 显示语义：版本行的 artifact 就是本节点的 videoUrl。已经把产物写进版本行了，
        // 所以这里不写画布、不建边 —— 建边的责任在下游真正存在的边类型上（白模 →
        // 视频 由 directorDesk 源类型放行，video→video 虽被白名单放行但不是本面板的
        // 职责，本面板只认自己绑定的那条 versions 链）。
        const artifactUrl = refString(receipt.source_refs, 'artifact_url');
        const receiptRefs = receipt.source_refs;
        const targetNodeId = refString(receiptRefs, 'node_id');
        if (artifactUrl && targetNodeId === nodeId) {
          const canvas = useCanvasStore.getState();
          const targetNode = canvas.nodes.find((node) => node.id === targetNodeId);
          if (!targetNode) {
            // 版本绑定的节点不在当前画布上（比如换了画布打开同一配方）：不猜、不崩，
            // 只如实说产物在版本行里、画布上没有对应节点。
            setError(
              t('node.shotRecipe.artifactWritebackMissingNode', {
                node: targetNodeId,
              }),
            );
          } else {
            canvas.updateNodeData(targetNodeId, { videoUrl: artifactUrl });
            setCanvasWriteback({
              nodeId: targetNodeId,
              artifactUrl,
            });
          }
        }
        const fresh = await getShotRecipe(project, selectedId);
        // 迟到的响应不能覆盖更新的列表：只有还处在同一代才回写。
        if (detailGenerationRef.current === generation) applyDetail(fresh);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyVersionId(null);
      }
    },
    [applyDetail, project, selectedId, t],
  );

  /**
   * 重拍的真实动作：在源版本的成片里换掉一个秒区间，产出**一条新的子版本**。
   *
   * 动作序列与 handleRender 一致（入队 → 立刻对账 → 拉新明细），因为重拍同样是
   * 一次真实任务：回执只证明已入队。区间非法（end <= start）在这里就地拦下，**不发
   * 请求**——让用户先等一次 400 往返毫无意义。
   */
  const handleReshoot = useCallback(
    async (version: ShotRecipeVersion) => {
      if (!project || !selectedId) return;
      const versionId = String(version.version_id);
      const modelId = version.model_snapshot?.model_id || version.model_id || '';
      if (!modelId) {
        setError(t('node.shotRecipe.reshootNoModel'));
        return;
      }
      const input = reshootInputs[versionId] ?? {
        start: '0',
        end: String(version.duration_seconds ?? 0),
        prompt: '',
      };
      if (reshootRangeError(input.start, input.end)) {
        setError(t('node.shotRecipe.reshootRangeInvalid'));
        return;
      }
      setReshootingVersionId(versionId);
      setError(null);
      const generation = detailGenerationRef.current;
      try {
        const receipt = await reshootShotRecipeVersion(project, selectedId, versionId, {
          modelId,
          startSeconds: Number(input.start),
          endSeconds: Number(input.end),
          prompt: input.prompt,
          resolution: version.resolution ?? undefined,
        });
        // 新子版本已入队：立刻对账一次（中间态不会写行），再拉明细让子版本出现。
        await syncShotRecipeVersion(project, selectedId, receipt.version_id);
        const fresh = await getShotRecipe(project, selectedId);
        if (detailGenerationRef.current === generation) applyDetail(fresh);
        setReshootFormVersionId(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setReshootingVersionId(null);
      }
    },
    [applyDetail, project, reshootInputs, selectedId, t],
  );

  const versionRows = useMemo(
    () => buildRows(detail?.versions ?? []),
    [detail?.versions],
  );
  const lookDecisions = detail?.look_decisions ?? [];

  /**
   * 预检的真实动作：只读地跑一次「这条配方能不能渲染」，把结构化结论留在面板上。
   *
   * 只展示后端给的 check 行，不把 warn 合并成 pass，也不把「读不到」说成「通过」。
   */
  const handlePreflight = useCallback(
    async (version: ShotRecipeVersion) => {
      if (!project || !selectedId) return;
      const versionId = String(version.version_id);
      setPreflightingVersionId(versionId);
      setError(null);
      try {
        const report = await preflightShotRecipeVersion(
          project,
          selectedId,
          versionId,
          {
            modelId:
              version.model_snapshot?.model_id || version.model_id || undefined,
            durationSeconds: version.duration_seconds ?? undefined,
            resolution: version.resolution ?? undefined,
          },
        );
        setPreflightReports((current) => ({ ...current, [versionId]: report }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPreflightingVersionId(null);
      }
    },
    [project, selectedId],
  );

  /**
   * 质量检查的真实动作：只读地算一次这条版本的风险清单。
   *
   * 面板只逐条渲染后端给的 risks（severity / detail / evidence），**不合成任何
   * 总分或评分**——那正是 oracle 明确要求不要的东西。
   */
  const handleQuality = useCallback(
    async (version: ShotRecipeVersion) => {
      if (!project || !selectedId) return;
      const versionId = String(version.version_id);
      setQualityVersionId(versionId);
      setError(null);
      try {
        const report = await qualityShotRecipeVersion(
          project,
          selectedId,
          versionId,
        );
        setQualityReports((current) => ({ ...current, [versionId]: report }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setQualityVersionId(null);
      }
    },
    [project, selectedId],
  );
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
                    {canRender(version) && (
                      <button
                        type="button"
                        className="flex items-center gap-0.5 rounded bg-white/10 px-1.5 py-0.5 text-[9px] text-white/70 hover:bg-white/20 hover:text-white/95 disabled:opacity-50"
                        disabled={busyVersionId === id}
                        onClick={() => void handleRender(version)}
                        data-testid={`shot-recipe-render-${id}`}
                      >
                        {busyVersionId === id ? (
                          <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        ) : (
                          <Play className="h-2.5 w-2.5" />
                        )}
                        {t('node.shotRecipe.render')}
                      </button>
                    )}
                    {canPreflight(version) && (
                      <button
                        type="button"
                        className="flex items-center gap-0.5 rounded bg-white/10 px-1.5 py-0.5 text-[9px] text-white/70 hover:bg-white/20 hover:text-white/95 disabled:opacity-50"
                        disabled={preflightingVersionId === id}
                        onClick={() => void handlePreflight(version)}
                        data-testid={`shot-recipe-preflight-${id}`}
                      >
                        {preflightingVersionId === id ? (
                          <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        ) : (
                          <ShieldCheck className="h-2.5 w-2.5" />
                        )}
                        {t('node.shotRecipe.preflight')}
                      </button>
                    )}
                    {canPreflight(version) && (
                      <button
                        type="button"
                        className="flex items-center gap-0.5 rounded bg-white/10 px-1.5 py-0.5 text-[9px] text-white/70 hover:bg-white/20 hover:text-white/95 disabled:opacity-50"
                        disabled={qualityVersionId === id}
                        onClick={() => void handleQuality(version)}
                        data-testid={`shot-recipe-quality-${id}`}
                      >
                        {qualityVersionId === id ? (
                          <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        ) : (
                          <ShieldAlert className="h-2.5 w-2.5" />
                        )}
                        {t('node.shotRecipe.quality')}
                      </button>
                    )}
                    {canReshoot(version) && (
                      <button
                        type="button"
                        className="flex items-center gap-0.5 rounded bg-white/10 px-1.5 py-0.5 text-[9px] text-white/70 hover:bg-white/20 hover:text-white/95 disabled:opacity-50"
                        disabled={reshootingVersionId === id}
                        onClick={() =>
                          setReshootFormVersionId((current) =>
                            current === id ? null : id,
                          )
                        }
                        data-testid={`shot-recipe-reshoot-${id}`}
                      >
                        {reshootingVersionId === id ? (
                          <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        ) : (
                          <Scissors className="h-2.5 w-2.5" />
                        )}
                        {t('node.shotRecipe.reshoot')}
                      </button>
                    )}
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
                  {reshootFormVersionId === id && (
                    <div
                      className="mt-1 flex flex-wrap items-center gap-1 border-t border-white/10 pt-1"
                      data-testid={`shot-recipe-reshoot-form-${id}`}
                    >
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        className="w-16 rounded bg-white/10 px-1 py-0.5 text-[10px] text-white/80"
                        value={
                          (reshootInputs[id] ?? { start: '0' }).start
                        }
                        onChange={(event) =>
                          setReshootInputs((current) => ({
                            ...current,
                            [id]: {
                              start: event.target.value,
                              end: current[id]?.end ?? '0',
                              prompt: current[id]?.prompt ?? '',
                            },
                          }))
                        }
                        data-testid={`shot-recipe-reshoot-start-${id}`}
                        aria-label={t('node.shotRecipe.reshootStart')}
                      />
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        className="w-16 rounded bg-white/10 px-1 py-0.5 text-[10px] text-white/80"
                        value={
                          (reshootInputs[id] ?? {
                            end: String(version.duration_seconds ?? 0),
                          }).end
                        }
                        onChange={(event) =>
                          setReshootInputs((current) => ({
                            ...current,
                            [id]: {
                              start: current[id]?.start ?? '0',
                              end: event.target.value,
                              prompt: current[id]?.prompt ?? '',
                            },
                          }))
                        }
                        data-testid={`shot-recipe-reshoot-end-${id}`}
                        aria-label={t('node.shotRecipe.reshootEnd')}
                      />
                      <input
                        type="text"
                        className="min-w-0 flex-1 rounded bg-white/10 px-1 py-0.5 text-[10px] text-white/80"
                        placeholder={t('node.shotRecipe.reshootPrompt')}
                        value={(reshootInputs[id] ?? { prompt: '' }).prompt}
                        onChange={(event) =>
                          setReshootInputs((current) => ({
                            ...current,
                            [id]: {
                              start: current[id]?.start ?? '0',
                              end:
                                current[id]?.end ??
                                String(version.duration_seconds ?? 0),
                              prompt: event.target.value,
                            },
                          }))
                        }
                        data-testid={`shot-recipe-reshoot-prompt-${id}`}
                      />
                      <button
                        type="button"
                        className="rounded bg-white/10 px-1.5 py-0.5 text-[9px] text-white/70 hover:bg-white/20 hover:text-white/95 disabled:opacity-50"
                        disabled={reshootingVersionId === id}
                        onClick={() => void handleReshoot(version)}
                        data-testid={`shot-recipe-reshoot-submit-${id}`}
                      >
                        {reshootingVersionId === id
                          ? t('node.shotRecipe.reshootBusy')
                          : t('node.shotRecipe.reshootSubmit')}
                      </button>
                    </div>
                  )}
                  {id === renderedVersionId && canvasWriteback && (
                    <div
                      className="mt-1 break-words text-[10px] [overflow-wrap:anywhere] text-white/60"
                      data-testid="shot-recipe-canvas-writeback"
                    >
                      {t('node.shotRecipe.renderCompleted', {
                        url: canvasWriteback.artifactUrl,
                      })}
                    </div>
                  )}
                  {renderOutcomeText(version, t) && (
                    <div
                      className={`mt-0.5 break-words text-[10px] [overflow-wrap:anywhere] ${
                        version.status === 'failed' ? 'text-red-300' : 'text-emerald-300/80'
                      }`}
                      data-testid={`shot-recipe-render-outcome-${id}`}
                    >
                      {renderOutcomeText(version, t)}
                    </div>
                  )}
                  {preflightReports[id] && (
                    <div
                      className="mt-1 flex flex-col gap-0.5 border-t border-white/10 pt-1"
                      data-testid={`shot-recipe-preflight-report-${id}`}
                    >
                      <div
                        className={`text-[10px] font-medium ${
                          preflightReports[id].ok ? 'text-white/70' : 'text-red-300'
                        }`}
                        data-testid={`shot-recipe-preflight-summary-${id}`}
                      >
                        {preflightSummaryText(preflightReports[id], t)}
                      </div>
                      {(preflightReports[id].checks ?? []).map((check) => (
                        <div
                          key={check.id}
                          className={`text-[10px] [overflow-wrap:anywhere] ${checkStatusClass(check.status)}`}
                          data-testid={`shot-recipe-preflight-check-${id}-${check.id}`}
                        >
                          {t('node.shotRecipe.preflightCheck', {
                            id: check.id,
                            status: check.status,
                            detail: check.detail || '',
                          })}
                        </div>
                      ))}
                    </div>
                  )}
                  {qualityReports[id] && (
                    <div
                      className="mt-1 flex flex-col gap-0.5 border-t border-white/10 pt-1"
                      data-testid={`shot-recipe-quality-report-${id}`}
                    >
                      <div
                        className="text-[10px] font-medium text-white/70"
                        data-testid={`shot-recipe-quality-summary-${id}`}
                      >
                        {qualitySummaryText(qualityReports[id], t)}
                      </div>
                      {(qualityReports[id].risks ?? []).map((risk, index) => (
                        <div
                          key={`${risk.id}-${index}`}
                          className={`text-[10px] [overflow-wrap:anywhere] ${riskSeverityClass(risk.severity)}`}
                          data-testid={`shot-recipe-quality-risk-${id}-${risk.id}`}
                        >
                          <div>
                            {t('node.shotRecipe.qualityRisk', {
                              id: risk.id,
                              severity: risk.severity,
                              detail: risk.detail || '',
                            })}
                          </div>
                          {evidenceText(risk.evidence) && (
                            <div className="text-white/35">
                              {t('node.shotRecipe.qualityEvidence', {
                                evidence: evidenceText(risk.evidence),
                              })}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
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