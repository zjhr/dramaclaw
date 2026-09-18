// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  COOKBOOK_ID_PREFIX,
  isCookbookStyleId,
  parseCookbookStyles,
} from '@/features/canvas/domain/styleCookbook';

/**
 * 样本按上游 `site/styles-data.js` 的真实形状手写（`window.COOKBOOK_STYLES = {...};`），
 * 只是把条数压到 2 条。上游是「每日更新」的策展仓，导出方式一变这些用例就该红。
 */
const SAMPLE = `window.COOKBOOK_STYLES = {
  "styleCount": 2,
  "categories": [
    "Editorial + Minimal",
    "Type Posters"
  ],
  "styles": [
    {
      "name": "Color Pop Interlocked Marker Type",
      "slug": "color-pop-interlocked-marker-type",
      "category": "Type Posters",
      "description": "Playful hand-drawn megatype posters with irregular interlocking colored letters.",
      "summary": "Dense playful hand-drawn megatype: irregular interlocking colored letters, bold black contours.",
      "preview16": "../styles/color-pop-interlocked-marker-type/preview-16x9.jpg",
      "preview9": "../styles/color-pop-interlocked-marker-type/preview-9x16.jpg",
      "jsonText": "{\\"style_version\\":\\"2.1.0\\"}"
    },
    {
      "name": "Crimson Ink Manga Dossier",
      "slug": "crimson-ink-manga-dossier",
      "category": "Editorial + Minimal",
      "description": "A high-density manga editorial dossier poster.",
      "summary": "",
      "jsonText": "{}"
    }
  ]
};
`;

describe('parseCookbookStyles', () => {
  it('剥掉赋值前缀后按条映射成风格模板', () => {
    const styles = parseCookbookStyles(SAMPLE);
    expect(styles).toHaveLength(2);
    expect(styles[0].id).toBe(`${COOKBOOK_ID_PREFIX}color-pop-interlocked-marker-type`);
    expect(styles[0].label).toBe('Color Pop Interlocked Marker Type');
    expect(styles[0].category).toBe('Type Posters');
  });

  it('封面用 640×512 的缩略图，详情用 preview 大图', () => {
    const styles = parseCookbookStyles(SAMPLE);
    expect(styles[0].cover).toBe(
      'https://raw.githubusercontent.com/VigoZhao/AI-Visual-Prompt-Cookbook/main/assets/thumbs/color-pop-interlocked-marker-type-16x9.jpg',
    );
    expect(styles[0].samples).toEqual([
      'https://raw.githubusercontent.com/VigoZhao/AI-Visual-Prompt-Cookbook/main/styles/color-pop-interlocked-marker-type/preview-16x9.jpg',
    ]);
  });

  it('style_prompt 优先取一句话的 summary', () => {
    const styles = parseCookbookStyles(SAMPLE);
    expect(styles[0].style_prompt).toContain('Dense playful hand-drawn megatype');
  });

  it('summary 为空时退到 description', () => {
    const styles = parseCookbookStyles(SAMPLE);
    // 第二条的 summary 是空串 —— 空正文的风格选不出效果，必须退到 description
    expect(styles[1].style_prompt).toBe(
      'A high-density manga editorial dossier poster.',
    );
  });

  it('认不出的输入退空数组，不抛错', () => {
    expect(parseCookbookStyles('')).toEqual([]);
    expect(parseCookbookStyles('const x = 1;')).toEqual([]);
    expect(parseCookbookStyles('window.COOKBOOK_STYLES = not json;')).toEqual([]);
    expect(parseCookbookStyles('window.COOKBOOK_STYLES = {};')).toEqual([]);
  });

  it('缺 slug / name / 正文的条目跳过，不污染整份清单', () => {
    const broken = `window.COOKBOOK_STYLES = ${JSON.stringify({
      styles: [
        { name: '没有 slug', summary: 'x' },
        { slug: 'no-name', summary: 'x' },
        { slug: 'no-summary', name: 'No Summary' },
        { slug: 'good', name: 'Good', summary: 'ok' },
      ],
    })};`;
    const styles = parseCookbookStyles(broken);
    expect(styles).toHaveLength(1);
    expect(styles[0].id).toBe(`${COOKBOOK_ID_PREFIX}good`);
  });
});

describe('isCookbookStyleId', () => {
  it('认前缀', () => {
    expect(isCookbookStyleId('cookbook:abc')).toBe(true);
    expect(isCookbookStyleId('period_idol')).toBe(false);
    expect(isCookbookStyleId(null)).toBe(false);
    expect(isCookbookStyleId(undefined)).toBe(false);
  });
});
