// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { computePanelPos } from '@/features/canvas/ui/PromptTagPanel';

/**
 * 标签弹层定位。这里出过一次事故：早先用 `Math.max(180, innerHeight - top - 24)` 当下限，
 * 按钮靠近屏幕底部时那个 180 会把面板强行撑高，整个越过视口底。
 *
 * 所以这组用例的重点不是「方向对不对」，而是**任何输入下都不许溢出**。
 */

const VIEWPORT = { width: 1680, height: 880 };
const MARGIN = 16;

/** 面板最长可能占据的纵向区间。maxHeight 是上界，内容少时实际更矮，用它算最坏情况。 */
function extent(pos: ReturnType<typeof computePanelPos>, viewportHeight: number) {
  if (pos.side === 'down') {
    return { top: pos.top, bottom: pos.top + pos.maxHeight };
  }
  const bottom = viewportHeight - pos.bottom;
  return { top: bottom - pos.maxHeight, bottom };
}

describe('computePanelPos', () => {
  it('下方空间充足时向下展开', () => {
    const pos = computePanelPos({ top: 200, bottom: 228, left: 400 }, VIEWPORT);
    expect(pos.side).toBe('down');
    if (pos.side !== 'down') return;
    expect(pos.top).toBe(234);
    expect(pos.left).toBe(400);
  });

  it('下方挤不下时翻到上方', () => {
    // 按钮贴在屏幕底部：下方只剩几十像素
    const pos = computePanelPos({ top: 800, bottom: 828, left: 400 }, VIEWPORT);
    expect(pos.side).toBe('up');
    if (pos.side !== 'up') return;
    // 面板底边贴在按钮上方
    expect(VIEWPORT.height - pos.bottom).toBeLessThanOrEqual(800);
  });

  it('上下都挤时选更宽敞的一侧', () => {
    const small = { width: 1680, height: 500 };
    // 按钮在中间偏上：上方 250，下方 216 —— 下方不足 220 但上方更宽敞
    const pos = computePanelPos({ top: 250, bottom: 278, left: 400 }, small);
    expect(pos.side).toBe('up');
  });

  it('靠右的按钮不会把弹层顶出右边缘', () => {
    const pos = computePanelPos({ top: 200, bottom: 228, left: 1650 }, VIEWPORT);
    // 1680 - 320 - 12
    expect(pos.left).toBe(1348);
  });

  it('靠左的按钮不会顶出左边缘', () => {
    const pos = computePanelPos({ top: 200, bottom: 228, left: -20 }, VIEWPORT);
    expect(pos.left).toBe(12);
  });

  it('任何锚点位置、任何视口高度都不溢出（回归）', () => {
    const failures: string[] = [];
    for (const height of [380, 420, 500, 620, 760, 880, 1200]) {
      for (let anchorBottom = 20; anchorBottom <= height; anchorBottom += 10) {
        const anchor = { top: anchorBottom - 28, bottom: anchorBottom, left: 400 };
        const pos = computePanelPos(anchor, { width: 1680, height });
        const box = extent(pos, height);
        // 上边不许顶出，下边不许越界（除 MARGIN 外不留余量）
        if (box.top < -0.01) {
          failures.push(`h=${height} anchor=${anchorBottom} side=${pos.side} 顶出 ${box.top}`);
        }
        if (box.bottom > height + 0.01) {
          failures.push(
            `h=${height} anchor=${anchorBottom} side=${pos.side} 溢出 ${Math.round(box.bottom - height)}px`,
          );
        }
      }
    }
    expect(failures.slice(0, 6)).toEqual([]);
  });

  it('极端矮视口也不溢出（宁可很矮，不能越过边界）', () => {
    const tiny = { width: 1680, height: 300 };
    const pos = computePanelPos({ top: 140, bottom: 168, left: 400 }, tiny);
    const box = extent(pos, tiny.height);
    expect(box.top).toBeGreaterThanOrEqual(-0.01);
    expect(box.bottom).toBeLessThanOrEqual(tiny.height + 0.01);
  });

  it('MARGIN 生效：向下展开时底部留出余量', () => {
    const pos = computePanelPos({ top: 200, bottom: 228, left: 400 }, VIEWPORT);
    const box = extent(pos, VIEWPORT.height);
    expect(VIEWPORT.height - box.bottom).toBeGreaterThanOrEqual(MARGIN - 0.01);
  });
});

/**
 * 层叠不变量。
 *
 * 弹层和画廊弹窗都 portal 到 document.body，谁在上面完全由 z 决定。这里出过一次
 * 事故：弹层抄的是原型里的 z-[61]，而画廊自己那层是 z-[300] —— 弹层被整个压在
 * 下面，用户看到的是「点了更多没反应」。jsdom 不算层叠，所以只能这样守着。
 */
function zIndexesIn(relativePath: string): number[] {
  // 先剥注释：说明里会引用具体的 z 值（比如「要压过 z-[300]」），不剥就会把它
  // 当成真实类名算进来。
  const source = readFileSync(relativePath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  return [...source.matchAll(/z-\[(\d+)\]/g)].map((match) => Number(match[1]));
}

describe('标签弹层的层叠', () => {
  const MODAL = 'src/features/canvas/ui/PromptGalleryModal.tsx';
  const PANEL = 'src/features/canvas/ui/PromptTagPanel.tsx';

  it('弹层（含遮罩）都高于画廊弹窗自己那层', () => {
    const modalTop = Math.max(...zIndexesIn(MODAL));
    const panelZs = zIndexesIn(PANEL);
    expect(panelZs.length).toBeGreaterThan(0);
    // 遮罩和面板两层都得压过画廊，否则遮罩拦不到点击、面板看不见
    expect(Math.min(...panelZs)).toBeGreaterThan(modalTop);
  });
});
