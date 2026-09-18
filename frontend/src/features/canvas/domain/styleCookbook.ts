// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { FreezoneStyleTemplate } from '@/api/ops';

/**
 * VigoZhao/AI-Visual-Prompt-Cookbook 的 130 个风格包，作为内置 45 条之外的补充。
 *
 * 上游把全量数据烘进一个 `site/styles-data.js`（2.25MB），形如
 * `window.COOKBOOK_STYLES = { styleCount, categories, styles: [...] }`。
 * 剥掉赋值前缀就是纯 JSON —— 130 个风格各带一份完整的视觉解构（构图/字体/配色/
 * 材质/光照/情绪），但画廊只需要其中的名字、分类和一句话摘要，所以这里只取那几项，
 * 正文留在上游，不进内存。
 *
 * 配图两套：`assets/thumbs/<slug>-16x9.jpg`（640×512，均 87KB）当封面，
 * `styles/<slug>/preview-16x9.jpg`（1402×1122，824KB）当详情大图。
 */

const COOKBOOK_RAW =
  'https://raw.githubusercontent.com/VigoZhao/AI-Visual-Prompt-Cookbook/main';

export const COOKBOOK_DATA_URL = `${COOKBOOK_RAW}/site/styles-data.js`;

/**
 * id 前缀。加它有两个原因：一是和内置清单的 id 不会撞车，二是后端一眼能看出
 * 这条不在自己的清单里 —— 请求会把这个风格的正文一起带上做兜底。
 */
export const COOKBOOK_ID_PREFIX = 'cookbook:';

/** 判断某条风格是不是远端来源。生成请求据此决定要不要带上正文。 */
export function isCookbookStyleId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(COOKBOOK_ID_PREFIX);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 把 `styles-data.js` 剥成风格数组。认不出来就退空数组 —— 上游改了导出方式
 * 时图墙少 130 条是看得见的降级，整页白屏不是。
 */
export function parseCookbookStyles(source: string): FreezoneStyleTemplate[] {
  const marker = 'window.COOKBOOK_STYLES';
  const markerAt = source.indexOf(marker);
  if (markerAt < 0) return [];
  const eqAt = source.indexOf('=', markerAt);
  if (eqAt < 0) return [];

  let data: unknown;
  try {
    data = JSON.parse(source.slice(eqAt + 1).trim().replace(/;\s*$/, ''));
  } catch {
    return [];
  }

  const list =
    data && typeof data === 'object' && Array.isArray((data as { styles?: unknown }).styles)
      ? ((data as { styles: unknown[] }).styles)
      : [];

  const templates: FreezoneStyleTemplate[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const slug = str(record.slug);
    const label = str(record.name);
    if (!slug || !label) continue;

    // summary 是一句话风格描述，最贴「拼到提示词后面的修饰符」这个语义；
    // 上游缺它时退到稍长的 description。
    const stylePrompt = str(record.summary) || str(record.description);
    if (!stylePrompt) continue;

    templates.push({
      id: `${COOKBOOK_ID_PREFIX}${slug}`,
      label,
      category: str(record.category),
      cover: `${COOKBOOK_RAW}/assets/thumbs/${slug}-16x9.jpg`,
      samples: [`${COOKBOOK_RAW}/styles/${slug}/preview-16x9.jpg`],
      style_prompt: stylePrompt,
    });
  }

  return templates;
}
