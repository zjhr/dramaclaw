// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useReducedMotion } from '@/hooks/use-reduced-motion';

/**
 * 标签选择弹层：内搜索 + 全量列表 + 多选。
 *
 * 走 portal 挂 body + fixed 定位，**不是** `absolute` 挂在按钮旁边。触发它的那行
 * 标签是 `overflow-x-auto` 的滚动容器，而 CSS 规范里 `overflow-x: auto` 会把另一
 * 轴也强制算成 auto —— 挂在里面会被整个裁掉，只露出上面一条。
 *
 * 定位算法单独抽成 computePanelPos，见下方注释。
 */

/** 下方空间不足时翻到按钮上方，此时用 bottom 锚定 —— 不必先知道面板多高。 */
export type PromptTagPanelPos =
  | { side: 'up'; left: number; bottom: number; maxHeight: number }
  | { side: 'down'; left: number; top: number; maxHeight: number };

export interface PromptTagPanelAnchor {
  top: number;
  bottom: number;
  left: number;
}

const PANEL_WIDTH = 320;
const GAP = 6;
/** 面板与视口边缘至少留这么多，免得贴着边或被别的浮动层压住。 */
const MARGIN = 16;
/** 下方可用高度低于这个值就翻转向上，硬撑只会溢出屏幕。 */
const MIN_USABLE = 220;
/** 再挤也得留这么高，否则列表区塌成一条线。 */
const MIN_PANEL = 120;
const EDGE = 12;

/**
 * 弹层该摆在哪。
 *
 * 这里出过一次事故：早先写的是 `maxHeight: Math.max(180, innerHeight - top - 24)`,
 * 那个 180 的下限在按钮靠近屏幕底部时会**强行把面板撑高到 180**，于是整个越过视口底。
 * 现在改成「下方不够就往上翻」，且不再有任何撑高下限。
 */
export function computePanelPos(
  anchor: PromptTagPanelAnchor,
  viewport: { width: number; height: number },
): PromptTagPanelPos {
  const spaceBelow = viewport.height - anchor.bottom - GAP - MARGIN;
  const spaceAbove = anchor.top - GAP - MARGIN;
  const openUp = spaceBelow < MIN_USABLE && spaceAbove > spaceBelow;
  const maxHeight = Math.max(MIN_PANEL, openUp ? spaceAbove : spaceBelow);
  // 右边缘兜住视口，否则靠右的按钮会把弹层顶出去。
  const left = Math.max(EDGE, Math.min(anchor.left, viewport.width - PANEL_WIDTH - EDGE));
  return openUp
    ? { side: 'up', left, bottom: viewport.height - anchor.top + GAP, maxHeight }
    : { side: 'down', left, top: anchor.bottom + GAP, maxHeight };
}

export interface PromptTagPanelProps {
  open: boolean;
  onClose: () => void;
  /** 触发按钮。弹层按它的位置定位，并在它移动时跟着走。 */
  anchorRef: RefObject<HTMLElement | null>;
  /** 全部候选，按频次降序。 */
  tags: Array<{ tag: string; count: number }>;
  selected: string[];
  onToggle: (tag: string) => void;
  onClear: () => void;
}

export function PromptTagPanel({
  open,
  onClose,
  anchorRef,
  tags,
  selected,
  onToggle,
  onClear,
}: PromptTagPanelProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const reduced = useReducedMotion();
  const [pos, setPos] = useState<PromptTagPanelPos | null>(null);

  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tags;
    return tags.filter((entry) => entry.tag.toLowerCase().includes(needle));
  }, [tags, query]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      setPos(
        computePanelPos(el.getBoundingClientRect(), {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
      );
    };
    update();
    window.addEventListener('resize', update);
    // capture 才能收到内部滚动容器发出的事件（scroll 不冒泡）。
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  if (!open || !pos) return null;

  return createPortal(
    <>
      {/* 点外面关掉。铺满全屏的透明层比 document 监听更省事，也不会漏掉。
          z 要压过画廊弹窗自己那层（z-[300]）：两个都 portal 到 body，谁高谁在上面。
          早先这里写的是 60/61，结果整个弹层被压在画廊下面，看起来像「点了没反应」。 */}
      <div className="fixed inset-0 z-[330]" onClick={onClose} />
      <AnimatePresence>
        <motion.div
          initial={reduced ? false : { opacity: 0, y: pos.side === 'up' ? 6 : -6, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={
            reduced ? { opacity: 1 } : { opacity: 0, y: pos.side === 'up' ? 6 : -6, scale: 0.985 }
          }
          transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
          style={{
            left: pos.left,
            maxHeight: pos.maxHeight,
            width: PANEL_WIDTH,
            // 两个方向只能给一个锚：给 top 就向下生长，给 bottom 就向上生长。
            ...(pos.side === 'up' ? { bottom: pos.bottom } : { top: pos.top }),
          }}
          className={`fixed z-[331] flex flex-col overflow-hidden rounded-[8px] border border-white/[0.12] bg-[#1b1c22] shadow-[0_18px_40px_rgba(0,0,0,0.5)] ${
            pos.side === 'up' ? 'origin-bottom' : 'origin-top'
          }`}
          role="dialog"
          aria-label={t('canvas.promptGallery.tagPanelAria')}
        >
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/[0.08] px-2.5">
            <Search className="size-3.5 shrink-0 text-text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('canvas.promptGallery.searchTags', { n: tags.length })}
              className="h-full flex-1 bg-transparent text-xs text-text-dark outline-none placeholder:text-text-muted/70"
            />
          </div>

          <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto py-1">
            {options.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-text-muted">
                {t('canvas.promptGallery.noMatchingTags')}
              </div>
            ) : (
              options.map((entry) => {
                const active = selected.includes(entry.tag);
                return (
                  <button
                    key={entry.tag}
                    type="button"
                    onClick={() => onToggle(entry.tag)}
                    aria-pressed={active}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.06]"
                  >
                    <span
                      className={`flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border text-[9px] ${
                        active
                          ? 'border-cyan-200/60 bg-cyan-200/80 text-black'
                          : 'border-white/20 text-transparent'
                      }`}
                    >
                      ✓
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-text-dark/85">
                      {entry.tag}
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums text-text-muted">
                      {entry.count}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          <div className="flex h-9 shrink-0 items-center justify-between border-t border-white/[0.08] px-2.5">
            <span className="text-[11px] text-text-muted">
              {t('canvas.promptGallery.selectedTags', { n: selected.length })}
            </span>
            <button
              type="button"
              onClick={onClear}
              disabled={selected.length === 0}
              className="text-[11px] font-medium text-text-dark/70 transition-colors hover:text-text-dark disabled:opacity-40"
            >
              {t('canvas.promptGallery.clearTags')}
            </button>
          </div>
        </motion.div>
      </AnimatePresence>
    </>,
    document.body,
  );
}
