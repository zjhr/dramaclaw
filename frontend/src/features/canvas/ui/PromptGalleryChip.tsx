// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  NODE_TEXT_CONTROL_ICON_CLASS,
  NODE_TEXT_CONTROL_TRIGGER_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';

export interface PromptGalleryChipProps {
  onOpen: () => void;
}

/**
 * 提示词画廊的入口 chip。和风格 chip 并列摆在节点顶排 —— 两者是不同维度：
 * 风格是拼到提示词后面的修饰符，画廊给的是一整条可以独立成立的描述。
 */
export function PromptGalleryChip({ onOpen }: PromptGalleryChipProps) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      title={t('canvas.promptGallery.chipTitle')}
      className={`${NODE_TEXT_CONTROL_TRIGGER_CLASS} shrink-0`}
    >
      <Sparkles className={`${NODE_TEXT_CONTROL_ICON_CLASS} shrink-0`} />
      <span>{t('canvas.promptGallery.chip')}</span>
    </button>
  );
}
