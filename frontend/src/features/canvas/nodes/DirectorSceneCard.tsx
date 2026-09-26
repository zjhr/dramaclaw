// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 分镜卡：每条 dd-scene 在对话里的一张可读摘要 + 操作入口。
//
// 为什么需要它：agent 输出的 dd-scene 块会被 `stripDirectorSceneIntent` 从气泡里剥掉，
// 用户只看到一段自然语言、画面却变了 ——「它到底摆了/动了什么」没有任何可复查的痕迹，
// 也没法重新应用或退回（用户实测反馈「没有卡片」）。卡片就是这个痕迹的载体。
import { useCallback, useMemo, useState } from 'react';
import { Check, Clapperboard, ClipboardCopy, Play, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  summarizeDirectorSceneIntent,
  type DirectorSceneIntent,
  type DirectorScenePropType,
} from './directorScenePatch';

/** 相机运动 → i18n 键后缀（词表与 dd-scene 一致，覆盖全部 16 个 move id）。 */
const CAMERA_MOVE_LABEL: Record<string, string> = {
  'orbit-left': 'orbitLeft',
  'orbit-right': 'orbitRight',
  'dolly-in': 'dollyIn',
  'dolly-out': 'dollyOut',
  'pan-left': 'panLeft',
  'pan-right': 'panRight',
  static: 'static',
  'crane-up': 'craneUp',
  'crane-down': 'craneDown',
  'rail-left': 'railLeft',
  'rail-right': 'railRight',
  handheld: 'handheld',
  'zoom-in': 'zoomIn',
  'zoom-out': 'zoomOut',
  pov: 'pov',
  'over-shoulder': 'overShoulder',
};

type DirectorSceneCardProps = {
  intent: DirectorSceneIntent;
  /** 这条已经落到导演台上了（也只有这种状态给撤销入口）。 */
  applied: boolean;
  onApply: () => void;
  /** 没有这个回调（宿主不支持快照）就不显示撤销按钮。 */
  onUndo?: () => void;
};

export function DirectorSceneCard({ intent, applied, onApply, onUndo }: DirectorSceneCardProps) {
  const { t } = useTranslation();
  const data = useMemo(() => summarizeDirectorSceneIntent(intent), [intent]);
  const [copied, setCopied] = useState(false);

  const copyJson = useCallback(async () => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(intent, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      // 剪贴板被拒（无权限/非安全上下文）时保持静默：这不是用户主动要的结果，
      // 弹错误反而吵。按钮文案不变即表示没复制成功。
    }
  }, [intent]);

  const moveLabel = data.camera
    ? t(`node.directorDesk.move.${CAMERA_MOVE_LABEL[data.camera.move] ?? 'static'}`)
    : null;
  const cameraLine = data.camera
    ? data.camera.duration
      ? t('node.directorDesk.card.cameraLine', { move: moveLabel, duration: data.camera.duration })
      : t('node.directorDesk.card.cameraLinePlain', { move: moveLabel })
    : null;

  const rows: Array<{ key: string; label: string; value: string }> = [];
  if (data.characterNames.length > 0) {
    rows.push({
      key: 'characters',
      label: t('node.directorDesk.card.characters'),
      value: data.characterNames.join('、'),
    });
  }
  if (data.objectTypes.length > 0) {
    rows.push({
      key: 'objects',
      label: t('node.directorDesk.card.objects'),
      value: data.objectTypes
        .map((type: DirectorScenePropType) => t(`node.directorDesk.prop.${type}`))
        .join('、'),
    });
  }
  if (cameraLine) {
    rows.push({ key: 'camera', label: t('node.directorDesk.card.camera'), value: cameraLine });
  }
  if (data.beats.length > 0) {
    rows.push({
      key: 'beats',
      label: t('node.directorDesk.card.beats'),
      value: data.beats
        .map(
          (beat) =>
            `${beat.at}s ${t(
              beat.kind === 'walk'
                ? 'node.directorDesk.card.beatWalk'
                : beat.kind === 'action'
                  ? 'node.directorDesk.card.beatAction'
                  : 'node.directorDesk.card.beatCamera',
            )}`,
        )
        .join(' · '),
    });
  }

  const actionClass =
    'flex items-center gap-1 rounded-md border border-white/[0.12] bg-white/[0.05] px-2 py-1 text-[11px] leading-4 text-white/80 transition-colors hover:border-white/25 hover:bg-white/[0.09] hover:text-white';

  return (
    <div className="rounded-lg border border-white/[0.1] bg-white/[0.03] px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <Clapperboard className="size-3.5 shrink-0 text-cyan-200/90" />
        <span className="text-[12px] font-medium leading-5 text-white/85">
          {t('node.directorDesk.card.title')}
        </span>
        <span
          className={`ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] leading-4 ${
            applied
              ? 'bg-cyan-300/[0.16] text-cyan-100'
              : 'bg-white/[0.06] text-white/50'
          }`}
        >
          {applied ? t('node.directorDesk.card.applied') : t('node.directorDesk.card.pending')}
        </span>
      </div>

      <dl className="mt-1.5 space-y-0.5">
        {rows.map((row) => (
          <div key={row.key} className="flex gap-1.5 text-[11px] leading-4">
            <dt className="shrink-0 text-white/40">{row.label}</dt>
            {/* 摘要里可能有很长的名字串，断词兜住，别撑破卡片。 */}
            <dd className="min-w-0 break-words text-white/70">{row.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={onApply} className={actionClass}>
          <Play className="size-3" />
          {applied
            ? t('node.directorDesk.card.reapply')
            : t('node.directorDesk.card.apply')}
        </button>
        {applied && onUndo && (
          <button type="button" onClick={onUndo} className={actionClass}>
            <RotateCcw className="size-3" />
            {t('node.directorDesk.card.undo')}
          </button>
        )}
        <button type="button" onClick={() => void copyJson()} className={actionClass}>
          {copied ? <Check className="size-3" /> : <ClipboardCopy className="size-3" />}
          {copied ? t('node.directorDesk.card.copied') : t('node.directorDesk.card.copy')}
        </button>
      </div>
    </div>
  );
}
