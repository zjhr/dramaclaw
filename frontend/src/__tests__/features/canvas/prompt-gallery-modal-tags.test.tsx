// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createElement } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PromptItem } from '@/features/canvas/domain/promptGallery';

/**
 * 标签筛选区的交互。
 *
 * 这组用例是被一次真实的接入事故催出来的：弹层接进画廊后点了没反应 —— 弹层
 * portal 到 body、z 却只有 61，而画廊弹窗自己那层是 300，整个被压在下面。
 * jsdom 不算层叠，测不到这一类；所以这里测「点了有没有渲染出来」，
 * 层级另有一条不变量用例守着（见 prompt-tag-panel-z）。
 */

const ITEMS: PromptItem[] = [
  {
    id: 'a:1',
    title: '雨夜霓虹街景',
    prompt: 'rainy neon street',
    description: '',
    coverUrl: '',
    referenceImageUrls: [],
    tags: ['Tech', 'Photography'],
    author: '',
    sourceUrl: '',
    sourceId: 'a',
    sourceName: 'A 源',
    mediaKind: 'image',
  },
  {
    id: 'b:1',
    title: '产品主图',
    prompt: 'product shot',
    description: '',
    coverUrl: '',
    referenceImageUrls: [],
    tags: ['Commerce', 'Tech'],
    author: '',
    sourceUrl: '',
    sourceId: 'b',
    sourceName: 'B 源',
    mediaKind: 'image',
  },
  {
    id: 'c:1',
    title: '海报排版',
    prompt: 'poster layout',
    description: '',
    coverUrl: '',
    referenceImageUrls: [],
    tags: ['Poster'],
    author: '',
    sourceUrl: '',
    sourceId: 'a',
    sourceName: 'A 源',
    mediaKind: 'image',
  },
];

vi.mock('@/features/canvas/hooks/usePromptGallery', () => ({
  usePromptGallery: () => ({
    items: ITEMS,
    isLoading: false,
    isRefreshing: false,
    failures: [],
    hasAnySuccess: true,
    offlineCount: 0,
    refetch: () => {},
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

vi.mock('@/hooks/use-escape-to-close', () => ({ useEscapeToClose: () => {} }));

import { PromptGalleryModal } from '@/features/canvas/ui/PromptGalleryModal';

const panelEl = () =>
  screen.getByRole('dialog', { name: 'canvas.promptGallery.tagPanelAria' });

const countText = () =>
  screen.getByText(/canvas\.promptGallery\.resultCount/).textContent ?? '';

function renderModal() {
  return render(
    createElement(PromptGalleryModal, { onApply: () => {}, onClose: () => {} }),
  );
}

/** 按可见文字找按钮。标签 chip 和卡片标签都可能重名，取第一个。 */
function buttonByText(text: string): HTMLElement {
  const hit = screen
    .getAllByRole('button')
    .find((el) => el.textContent?.trim() === text);
  if (!hit) throw new Error(`找不到按钮: ${text}`);
  return hit;
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('PromptGalleryModal 标签筛选', () => {
  it('三个标签都作为快捷项出现，卡片上也能看到标签', () => {
    renderModal();
    expect(buttonByText('Tech')).toBeTruthy();
    expect(buttonByText('Commerce')).toBeTruthy();
    // 卡片标签也是按钮，和快捷项同名 —— 至少得有一处
    expect(screen.getAllByRole('button').filter((el) => el.textContent?.trim() === 'Poster').length)
      .toBeGreaterThan(0);
  });

  it('点「更多」会把弹层渲染出来', () => {
    renderModal();
    // 画廊弹窗自己也是 role=dialog，所以按 aria-label 认标签弹层这一颗。
    expect(screen.queryByRole('dialog', { name: 'canvas.promptGallery.tagPanelAria' })).toBeNull();

    fireEvent.click(buttonByText('canvas.promptGallery.moreTags'));

    // 挂到 body 上的 dialog。这里只验「渲染了」——层叠由 z 不变量用例守。
    const panel = screen.getByRole('dialog', { name: 'canvas.promptGallery.tagPanelAria' });
    expect(panel).toBeTruthy();
    expect(panel.textContent).toContain('canvas.promptGallery.selectedTags');
    // 全量标签都列在弹层里，包括没进快捷区的那批低频标签
    expect(panel.textContent).toContain('Poster');
  });

  it('弹层里勾选标签后，筛选生效且底部计数跟着变', () => {
    renderModal();
    fireEvent.click(buttonByText('canvas.promptGallery.moreTags'));
    const panel = panelEl();

    const commerceRow = [...panel.querySelectorAll('button')].find(
      (el) => el.textContent?.includes('Commerce'),
    );
    expect(commerceRow).toBeTruthy();
    fireEvent.click(commerceRow!);

    // 只剩「产品主图」带 Commerce
    expect(countText()).toContain('"n":1');
    expect(panel.textContent).toContain('"n":1');
  });

  it('标签是「或」：勾两个标签看的是两类，不是交集', () => {
    renderModal();
    fireEvent.click(buttonByText('canvas.promptGallery.moreTags'));
    const panel = panelEl();
    const rowOf = (tag: string) =>
      [...panel.querySelectorAll('button')].find((el) => el.textContent?.includes(tag))!;

    fireEvent.click(rowOf('Commerce'));
    expect(countText()).toContain('"n":1');
    fireEvent.click(rowOf('Poster'));
    // Commerce 命中 1 条 + Poster 命中 1 条 = 2 条（交集为 0，按「与」算会是 0）
    expect(countText()).toContain('"n":2');
  });

  it('清除按钮清空所有已选标签', () => {
    renderModal();
    fireEvent.click(buttonByText('canvas.promptGallery.moreTags'));
    const panel = panelEl();
    fireEvent.click(
      [...panel.querySelectorAll('button')].find((el) =>
        el.textContent?.includes('Commerce'),
      )!,
    );
    expect(countText()).toContain('"n":1');

    fireEvent.click(buttonByText('canvas.promptGallery.clearTags'));
    expect(countText()).toContain('"n":3');
  });

  it('点卡片上的标签即按它筛', () => {
    renderModal();
    // 快捷项里没有 Poster（频次最低，被挤到第 3），只能从卡片上点
    const cardTag = screen
      .getAllByRole('button')
      .filter((el) => el.textContent?.trim() === 'Poster')
      .pop()!;
    fireEvent.click(cardTag);
    expect(countText()).toContain('"n":1');
  });
});
