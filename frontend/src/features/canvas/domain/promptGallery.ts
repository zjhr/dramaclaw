// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 提示词画廊的数据层：源注册表 + 两种格式的解析器 + 统一归一化。
 *
 * 和「风格图墙」是两件事。风格清单里的 `style_prompt` 是拼到用户提示词后面的
 * 修饰符，选中即回填节点；这里的 `prompt` 是一整条可以独立成立的画面/视频描述，
 * 选中是把它填进输入框。语义不同，所以各走各的通道，不往同一份清单里塞。
 *
 * 两个上游都不是为我们写的，格式各异，且随时可能变。解析器一律容错：认不出的
 * 条目跳过而不是抛错，整源解析结果为空才让 hook 报「这个源没拉到内容」。宁可
 * 少几条，不能因为上游加了个字段就整面墙白掉。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 归一化后的条目。UI 只认这个形状，不关心上游长什么样。 */
export interface PromptItem {
  /** 全局唯一，`${sourceId}:${localId}`。 */
  id: string;
  title: string;
  /** 可直接复制/套用的正文。空正文的条目在上游就已被丢弃。 */
  prompt: string;
  description: string;
  coverUrl: string;
  referenceImageUrls: string[];
  /** 自由标签，第一项通常是分类。UI 的标签筛选吃这个。 */
  tags: string[];
  author: string;
  /** 出处链接。CC BY 系源必须一路带到 UI，这是许可要求不是装饰。 */
  sourceUrl: string;
  sourceId: string;
  sourceName: string;
  mediaKind: PromptMediaKind;
  /**
   * 封面要用户点了才加载。
   *
   * 上游把原图直接丢在仓库里（wuyoscar 的 `docs/` 有 442MB、单张最大 14.7MB），
   * 跟着卡片一起 `<img src>` 等于让画廊首屏去拖几百 MB。这类源标上它，UI 换成
   * 「占位块 + 取图按钮」，取过一次进 CacheStorage，之后直接命中。
   */
  deferImage?: boolean;
}

export type PromptMediaKind = 'image' | 'video';

/**
 * 解析器类型。新增一个上游时，先看它属于哪一类，再决定要不要加解析器 ——
 * 能塞进现有两类就别加第三类。
 */
export type PromptSourceKind =
  /** 扁平的 JSON 数组，字段名固定（yukkcat/image-prompts 那套 registry）。 */
  | 'registry-json'
  /** awesome 列表 README：`### 标题` + `#### 📝 Prompt` + 围栏代码块。 */
  | 'awesome-readme'
  /** wuyoscar 的 Gallery Atlas：`### No. N · 标题` + `- Image:` + 围栏代码块。 */
  | 'wuyoscar-gallery'
  /** 带序号的 awesome 列表：`### N.N. 标题` + `**Prompt:**` + 围栏代码块。 */
  | 'awesome-numbered'
  /** 上游自己导出的 JSON 集合：`{ total, prompts: [...] }`。 */
  | 'json-collection';

export interface PromptSource {
  id: string;
  /** 展示名，也是 UI 上「分类」这一栏的选项。 */
  name: string;
  kind: PromptSourceKind;
  /**
   * 上游文件地址。多数源一个文件就够，wuyoscar 按分类拆成了 31 个 —— 一个源
   * 持有多个文件，各自独立加载，挂掉一个不影响同源的其他文件。
   */
  urls: string[];
  /**
   * 图片基地址。上游把图和正文分开放时用（wuyoscar 正文在 `skills/`、图在
   * `docs/`），缺省按 urls[0] 所在目录解析相对路径。
   */
  assetBase?: string;
  /** 源主页。版权归属和「内容出问题找谁」都指这里。 */
  homepage: string;
  license: string;
  mediaKind: PromptMediaKind;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// 源注册表
// ---------------------------------------------------------------------------

const REGISTRY_BASE =
  'https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources';

/**
 * yukkcat/image-prompts 是个 MIT 的聚合仓：把若干 awesome 列表爬成统一的
 * `dist/sources/*.json`。借它省掉自己写爬虫 —— 但它只有 ⭐6，随时可能没，
 * 所以 7 个源各自独立加载，挂哪个都不影响其他源。
 */
function registrySource(
  id: string,
  name: string,
  homepage: string,
): PromptSource {
  return {
    id,
    name,
    kind: 'registry-json',
    urls: [`${REGISTRY_BASE}/${id}.json`],
    homepage,
    license: 'MIT (via yukkcat/image-prompts)',
    mediaKind: 'image',
    enabled: true,
  };
}

export const PROMPT_SOURCES: PromptSource[] = [
  registrySource(
    'freestylefly-gpt-image-2',
    'GPT Image 2 · Freestylefly',
    'https://github.com/freestylefly/awesome-gpt-image-2',
  ),
  registrySource(
    'youmind-gpt-image-2',
    'GPT Image 2 · YouMind',
    'https://github.com/YouMind-OpenLab/awesome-gpt-image-2',
  ),
  registrySource(
    'youmind-nano-banana-pro',
    'Nano Banana Pro',
    'https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts',
  ),
  registrySource(
    'awesome-gpt-image',
    'Awesome GPT Image',
    'https://github.com/ZeroLu/awesome-gpt-image',
  ),
  registrySource(
    'awesome-gpt4o-image-prompts',
    'GPT-4o Image',
    'https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts',
  ),
  registrySource(
    'davidwu-gpt-image2-prompts',
    'GPT Image 2 · DavidWu',
    'https://github.com/davidwuw0811-boop/awesome-gpt-image2-prompts',
  ),
  registrySource(
    'banana-prompt-quicker',
    'Banana Prompt Quicker',
    'https://glidea.github.io/banana-prompt-quicker/',
  ),
  {
    // 提示词正文只在 README 里，`video-urls.json` 是 id→mp4 的映射表、没有文本，
    // 所以这里解析 README。仓库有 15 种语言的 README，先固定用英文那份 ——
    // 按界面语言挑 README 要维护一张语言映射表，等真有人抱怨再说。
    id: 'seedance-prompts',
    name: '视频提示词 · Seedance 2.0',
    kind: 'awesome-readme',
    urls: [
      'https://raw.githubusercontent.com/YouMind-OpenLab/awesome-seedance-2-prompts/main/README.md',
    ],
    homepage: 'https://github.com/YouMind-OpenLab/awesome-seedance-2-prompts',
    license: 'CC BY 4.0',
    mediaKind: 'video',
    enabled: true,
  },
  {
    // 2.5 时代的 Gallery Atlas，31 个分类文件按序号连续编排（No. 1–163）。
    // 上游把正文和配图分开放：正文在 skills/gpt-image/references/，配图在
    // docs/<分类>/，所以得单独给图片基地址，否则相对路径会解析到 references/docs/。
    //
    // 图是 442MB / 172 张（均 2.6MB，最大 14.7MB），绝不跟着卡片自动加载 ——
    // deferImage 让 UI 改成「占位块 + 取图按钮」，取过的进 CacheStorage。
    id: 'wuyoscar-gpt-image2',
    name: 'GPT Image 2.5 Gallery · wuyoscar',
    kind: 'wuyoscar-gallery',
    urls: [
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-anime-and-manga.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-architecture-and-interior.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-beauty-and-lifestyle.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-brand-systems-and-identity.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-character-design.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-cinematic-and-animation.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-cinematic-film-references.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-data-visualization.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-edit-endpoint-showcase.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-events-and-experience.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-fashion-editorial.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-fine-art-painting.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-gaming.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-illustration.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-infographics-and-field-guides.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-ink-and-chinese.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-isometric.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-more-illustration-styles.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-official-openai-cookbook-examples.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-photography.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-pixel-art.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-product-and-food.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-research-paper-figures.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-retro-and-cyberpunk.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-scientific-and-educational.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-screen-photography.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-tattoo-design.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-technical-illustration.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-typography-and-posters.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-ui-ux-mockups.md',
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-watercolor.md',
    ],
    assetBase:
      'https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/',
    homepage: 'https://github.com/wuyoscar/GPT-Image2-Skill',
    license: 'MIT',
    mediaKind: 'image',
    enabled: true,
  },
  {
    // 中文电商场景（女装/童装/电商主图/小红书封面），单文件一次拿全。
    // 上游另有一个 visuals.zh.json 带 54 张配图，但两边的 id 体系只在部分条目
    // 上对得上，且图在无 CORS 头的第三方 CDN 上、单张 1.7MB —— 跨文件 join 的
    // 收益不抵成本，这里只取文字。
    id: 'image-prompt-cookbook-zh',
    name: 'AI 图像提示词库 · 中文',
    kind: 'json-collection',
    urls: [
      'https://raw.githubusercontent.com/gpt-img-2/ai-image-prompt-cookbook/main/data/prompts.zh.json',
    ],
    homepage: 'https://github.com/gpt-img-2/ai-image-prompt-cookbook',
    license: 'CC BY 4.0',
    mediaKind: 'image',
    enabled: true,
  },
  {
    // 带序号的 awesome 列表，格式和 seedance 那类不同（`**Prompt:**` 而非
    // `#### 📝 Prompt`、图片走 markdown 而非 `<img>`），所以走另一个解析器。
    // 配图在 pbs.twimg.com，`?name=small` 后单张约 63KB，可以直接 lazy 加载。
    id: 'awesome-ai-image-prompts',
    name: 'Awesome AI Image Prompts',
    kind: 'awesome-numbered',
    urls: [
      'https://raw.githubusercontent.com/devanshug2307/Awesome-AI-Image-Prompts/main/README.md',
    ],
    homepage: 'https://github.com/devanshug2307/Awesome-AI-Image-Prompts',
    license: 'MIT',
    mediaKind: 'image',
    enabled: true,
  },
];

export function enabledPromptSources(): PromptSource[] {
  return PROMPT_SOURCES.filter((source) => source.enabled);
}

export function findPromptSource(sourceId: string): PromptSource | null {
  return PROMPT_SOURCES.find((source) => source.id === sourceId) ?? null;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function str(value: unknown): string {
  return typeof value === 'string'
    ? value.trim()
    : typeof value === 'number'
      ? String(value)
      : '';
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const text = str(entry);
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

/** 相对路径按源的 URL 展开；已经是绝对地址的原样返回。 */
function absoluteUrl(baseUrl: string, path: string): string {
  if (!path) return '';
  try {
    return new URL(path, baseUrl).toString();
  } catch {
    return path;
  }
}

/** 去掉 markdown 链接/加粗包裹，留下纯文本。`[名字](url)` → `名字`。 */
export function stripMarkdownInline(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/** 从 markdown 片段里抽第一个链接的 href。抽不到返回空串。 */
export function firstMarkdownHref(text: string): string {
  const match = /\]\(([^)\s]+)\)/.exec(text);
  return match ? match[1].trim() : '';
}

/** 从 `<img src="...">` 这类裸 HTML 里抽 src。 */
function firstImgSrc(text: string): string {
  const match = /<img[^>]*\ssrc=["']([^"']+)["']/i.exec(text);
  return match ? match[1].trim() : '';
}

function cleanUrl(url: string): string {
  return url.trim().replace(/^<|>$/g, '');
}

// ---------------------------------------------------------------------------
// 解析器 1：registry 扁平 JSON 数组
// ---------------------------------------------------------------------------

/**
 * 上游字段：`id / sourceId / title / prompt / description / coverUrl /
 * referenceImageUrls / tags / author / sourceUrl / imageMode / imageModel`。
 * 没有 title 或没有 prompt 的条目直接丢 —— 画廊卡片没标题没法看，没正文没法用。
 */
export function parseRegistrySource(
  raw: unknown,
  source: PromptSource,
  fileUrl: string = source.urls[0] ?? '',
): PromptItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const items: PromptItem[] = [];

  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const record = entry as Record<string, unknown>;
    const title = str(record.title);
    const prompt = str(record.prompt);
    if (!title || !prompt) return;

    const localId = str(record.id) || `item-${String(index + 1).padStart(4, '0')}`;
    const id = localId.includes(':') ? localId : `${source.id}:${localId}`;
    if (seen.has(id)) return;
    seen.add(id);

    const referenceImageUrls = strArray(record.referenceImageUrls).map((url) =>
      absoluteUrl(fileUrl, cleanUrl(url)),
    );
    const coverUrl =
      absoluteUrl(fileUrl, cleanUrl(str(record.coverUrl))) ||
      referenceImageUrls[0] ||
      '';

    items.push({
      id,
      title,
      prompt,
      description: str(record.description),
      coverUrl,
      referenceImageUrls,
      tags: strArray(record.tags),
      author: stripMarkdownInline(str(record.author)),
      sourceUrl:
        absoluteUrl(fileUrl, cleanUrl(str(record.sourceUrl))) ||
        source.homepage,
      sourceId: source.id,
      sourceName: source.name,
      mediaKind: source.mediaKind,
    });
  });

  return items;
}

// 解析器 3：awesome 列表 README
// ---------------------------------------------------------------------------

const README_ENTRY_HEADING = /^###\s+(?!#)(.+)$/;
const README_PROMPT_SUBHEADING = /^####\s*.*(📝|Prompt)/i;

/**
 * seedance 的 README 由 `scripts/generate-readme.ts` 生成，条目形状稳定：
 *
 * ```
 * ### Rainy Night Chase Cinematic Video Prompt
 *
 * > A prompt for a 30-second ...
 *
 * #### 📝 Prompt
 *
 * ```
 * Create a 30-second cinematic ...
 * ```
 *
 * <img src="https://.../thumb.jpg" width="600" alt="...">
 *
 * **[🎬 Watch Video →](https://...)**
 *
 * **Author:** [liana](https://x.com/...) | **Source:** [Link](https://...) | **Published:** Sep 16, 2026
 * ```
 *
 * 正文藏在围栏代码块里，所以这里按行扫，进代码块才收正文。摘要取 `#### 📝 Prompt`
 * 之前那段 `>` 引用 —— 正文之后也可能有引用，得区分开。
 */
export function parseAwesomeReadme(
  text: string,
  source: PromptSource,
  fileUrl: string = source.urls[0] ?? '',
): PromptItem[] {
  if (!text.trim()) return [];
  const lines = text.split(/\r?\n/);

  const items: PromptItem[] = [];
  const seen = new Set<string>();

  let heading: string | null = null;
  let summary = '';
  let inPromptSection = false;
  let inFence = false;
  let promptLines: string[] = [];
  let coverUrl = '';
  let author = '';
  let sourceUrl = '';

  const flush = () => {
    if (heading === null) return;
    const prompt = promptLines.join('\n').trim();
    if (prompt) {
      const id = `${source.id}:${slugify(heading)}`;
      if (!seen.has(id)) {
        seen.add(id);
        items.push({
          id,
          title: heading,
          prompt,
          description: summary,
          coverUrl: absoluteUrl(fileUrl, cleanUrl(coverUrl)),
          referenceImageUrls: [],
          // seedance 的 README 只有导航性标题（Table of Contents / All Prompts），
          // 取不出分类。与其塞源名充数（源筛选栏已经有了），不如老实留空。
          tags: [],
          author,
          sourceUrl: absoluteUrl(fileUrl, cleanUrl(sourceUrl)) || source.homepage,
          sourceId: source.id,
          sourceName: source.name,
          mediaKind: source.mediaKind,
        });
      }
    }
    heading = null;
    summary = '';
    inPromptSection = false;
    inFence = false;
    promptLines = [];
    coverUrl = '';
    author = '';
    sourceUrl = '';
  };

  for (const line of lines) {
    // 围栏内部一律当正文，`###` 之类的 markdown 在提示词里也可能出现。
    if (inFence) {
      if (/^\s*```/.test(line)) {
        inFence = false;
        inPromptSection = false;
      } else {
        promptLines.push(line);
      }
      continue;
    }

    const entryHeading = README_ENTRY_HEADING.exec(line);
    if (entryHeading) {
      flush();
      heading = entryHeading[1].trim();
      continue;
    }
    if (heading === null) continue;

    if (README_PROMPT_SUBHEADING.test(line)) {
      inPromptSection = true;
      continue;
    }
    if (/^\s*```/.test(line) && inPromptSection) {
      inFence = true;
      continue;
    }
    if (inPromptSection) continue;

    if (!summary && line.trim().startsWith('>')) {
      summary = stripMarkdownInline(line.replace(/^\s*>\s?/, ''));
      continue;
    }
    if (!coverUrl) {
      const src = firstImgSrc(line);
      if (src) {
        coverUrl = src;
        continue;
      }
    }
    if (!author) {
      const match = /\*\*Author:\*\*\s*(.+?)(?:\s*\||$)/.exec(line);
      if (match) author = stripMarkdownInline(match[1]);
    }
    if (!sourceUrl) {
      const match = /\*\*Source:\*\*\s*(.+?)(?:\s*\|\s*\*\*Published|\s*$)/.exec(line);
      if (match) sourceUrl = firstMarkdownHref(match[1]);
    }
  }
  flush();

  return items;
}

/** 标题转 slug，给 README 源生成稳定的本地 id（上游没有 id）。 */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'item';
}

/**
 * 分类标签。
 *
 * 刻意不掺源名：源筛选栏列的就是 `source.name`，再往标签里塞一份是纯占位 ——
 * 那批标签频次还特别高（每个源的全部条目都带），会把真正有区分度的标签挤下去。
 */
function categoryTags(category: string): string[] {
  const clean = stripMarkdownInline(category).trim();
  return clean ? [clean] : [];
}

/**
 * 给图片挑一个「基地址」。多数源正文和配图同目录，就近解析；wuyoscar 把正文放
 * `skills/`、配图放 `docs/`，相对路径是仓库根相对的，只能靠显式 assetBase 兜。
 */
function imageBase(source: PromptSource, fileUrl: string): string {
  return source.assetBase ?? fileUrl;
}

// ---------------------------------------------------------------------------
// 解析器 4：wuyoscar Gallery Atlas
// ---------------------------------------------------------------------------

const WUYOSCAR_ENTRY = /^###\s+No\.\s*(\d+)\s*·\s*(.+)$/;
const WUYOSCAR_IMAGE = /^-\s*Image:\s*`([^`]+)`/;
const WUYOSCAR_METADATA = /^-\s*Metadata:\s*(.+)$/;

/**
 * 上游把每个分类拆成一个文件，条目形状统一：
 *
 * ```
 * ### No. 130 · Urban Streetwear Lookbook: Shibuya Night
 *
 * - Image: `docs/fashion-editorial/streetwear-tokyo-lookbook.png`
 *
 *   <img src="../../../docs/..." width="420"/>
 * - Metadata: Fashion Editorial · `portrait` · `1024x1536` · Curated
 *
 * ```text
 * Full-body lookbook photography of ...
 * ```
 * ```
 *
 * 少数条目在 Metadata 末尾多带 `Author: @xxx · Source: [X](url)`，解析不到就留空。
 * 配图单独放在 docs/ 下、路径以仓库根起算，所以这里用 imageBase 而不是文件自身位置。
 */
export function parseWuyoscarGallery(
  text: string,
  source: PromptSource,
  fileUrl: string,
): PromptItem[] {
  if (!text.trim()) return [];
  const lines = text.split(/\r?\n/);
  const items: PromptItem[] = [];
  const seen = new Set<string>();

  let sequence = '';
  let title: string | null = null;
  let imagePath = '';
  let category = '';
  let author = '';
  let sourceUrl = '';
  let inFence = false;
  let promptLines: string[] = [];

  const flush = () => {
    if (title === null) return;
    const prompt = promptLines.join('\n').trim();
    if (prompt) {
      const id = `${source.id}:no-${sequence}`;
      if (!seen.has(id)) {
        seen.add(id);
        items.push({
          id,
          title,
          prompt,
          description: category ? `${category} · No. ${sequence}` : '',
          coverUrl: absoluteUrl(imageBase(source, fileUrl), cleanUrl(imagePath)),
          referenceImageUrls: [],
          tags: categoryTags(category),
          author,
          sourceUrl: sourceUrl || source.homepage,
          sourceId: source.id,
          sourceName: source.name,
          mediaKind: source.mediaKind,
          // 配图是仓库里的原图（均 2.6MB、最大 14.7MB），不能跟着卡片自动加载。
          deferImage: true,
        });
      }
    }
    sequence = '';
    title = null;
    imagePath = '';
    category = '';
    author = '';
    sourceUrl = '';
    inFence = false;
    promptLines = [];
  };

  for (const line of lines) {
    // 围栏优先：提示词正文里出现 `### No.` 之类的字样不能当新条目切。
    if (inFence) {
      if (/^\s*```/.test(line)) inFence = false;
      else promptLines.push(line);
      continue;
    }

    const entry = WUYOSCAR_ENTRY.exec(line);
    if (entry) {
      flush();
      sequence = entry[1];
      title = entry[2].trim();
      continue;
    }
    if (title === null) continue;

    if (/^\s*```/.test(line)) {
      inFence = true;
      continue;
    }
    if (!imagePath) {
      const image = WUYOSCAR_IMAGE.exec(line);
      if (image) {
        imagePath = image[1];
        continue;
      }
    }
    const meta = WUYOSCAR_METADATA.exec(line);
    if (meta && !category) {
      // 形如 `Fashion Editorial · \`portrait\` · \`1024x1536\` · Author: @x · Source: [X](url)`
      const head = meta[1].split('·')[0];
      category = stripMarkdownInline(head);
      const authorMatch = /Author:\s*([^·]+)/.exec(meta[1]);
      if (authorMatch) author = stripMarkdownInline(authorMatch[1]);
      const sourceMatch = /Source:\s*(.+)$/.exec(meta[1]);
      if (sourceMatch) sourceUrl = firstMarkdownHref(sourceMatch[1]);
    }
  }
  flush();

  return items;
}

// ---------------------------------------------------------------------------
// 解析器 5：带序号的 awesome 列表
// ---------------------------------------------------------------------------

const NUMBERED_ENTRY = /^###\s+(\d+\.\d+\.)\s*(.+)$/;
/**
 * 只认**编号**的二级标题当分类。
 *
 * 那份 README 的 `##` 有两类：`## 1. 🏙️ 3D Miniatures & Dioramas` 是真分类，
 * 另外十来个（JSON Structure Template / Common Mistakes to Avoid / Your
 * Communication Style …）是正文段落，标题样式一模一样。编号是唯一稳定的区分。
 */
const NUMBERED_SECTION = /^##\s+\d+\.\s*(.+)$/;
const PROMPT_MARKER = /^\*\*Prompt:?\*\*\s*$/i;
const MARKDOWN_IMAGE = /^!\[[^\]]*\]\(([^)\s]+)\)/;

/** 去掉标题开头的 emoji 与变体选择符，`🏙️ 3D Miniatures` → `3D Miniatures`。 */
function stripLeadingEmoji(text: string): string {
  return text.replace(/^[\p{Extended_Pictographic}️‍\s]+/u, '').trim();
}

/**
 * devanshug 那份 1000+ 条列表的 README 形状：
 *
 * ```
 * ### 1.1. 3D Render: Whimsical Miniature Starbucks Coffee Shop Scene
 *
 * ![3D Render: ...](https://pbs.twimg.com/media/G7BWvI8X0AApeZB.jpg)
 *
 * A whimsical 3D render illustrates ...
 *
 * **Prompt:**
 *
 * ```
 * {Brand Name}
 * --- Prompt ---
 * 3D chibi-style miniature concept store of ...
 * ```
 *
 * **Source:** [宝玉](https://x.com/dotey/status/...)
 * ```
 *
 * 和 seedance 那份的区别：序号前缀、`**Prompt:**` 而非 `#### 📝 Prompt`、配图走
 * markdown 而非 `<img>`、摘要是普通段落而非引用 —— 差异够多，不值得硬塞进同一个
 * 解析器里堆分支。
 */
export function parseAwesomeNumbered(
  text: string,
  source: PromptSource,
  fileUrl: string,
): PromptItem[] {
  if (!text.trim()) return [];
  const lines = text.split(/\r?\n/);
  const items: PromptItem[] = [];
  const seen = new Set<string>();

  let title: string | null = null;
  /** 上游的 `N.N.` 序号。标题会重名（15.2/15.3/15.4 都叫 Gemini Google Nano Banana Pro），
   *  只拿标题做 id 会把另外两条挤掉，序号才是这份列表里真正的唯一键。 */
  let sequence = '';
  /** 当前所属的编号章节。 */
  let section = '';
  /**
   * 条目**开始那一刻**的章节快照。
   *
   * 不能等到 flush 时再读 section：下一个 `## N.` 出现在两条之间，那时条目还没
   * 落盘、section 却已经被换成新章节了，整段都会被打上后一章的标签。
   */
  let entrySection = '';
  let summary = '';
  let inPromptSection = false;
  let inFence = false;
  let promptLines: string[] = [];
  let coverUrl = '';
  let sourceUrl = '';
  let author = '';

  const flush = () => {
    if (title === null) return;
    const prompt = promptLines.join('\n').trim();
    if (prompt) {
      const id = `${source.id}:${sequence}${slugify(title)}`;
      if (!seen.has(id)) {
        seen.add(id);
        items.push({
          id,
          title,
          prompt,
          description: summary,
          coverUrl: thumbSize(absoluteUrl(fileUrl, cleanUrl(coverUrl))),
          referenceImageUrls: [],
          // 上游自己的编号章节就是最好的分类，比源名有区分度得多。
          tags: categoryTags(entrySection),
          author,
          sourceUrl: absoluteUrl(fileUrl, cleanUrl(sourceUrl)) || source.homepage,
          sourceId: source.id,
          sourceName: source.name,
          mediaKind: source.mediaKind,
        });
      }
    }
    title = null;
    sequence = '';
    summary = '';
    inPromptSection = false;
    inFence = false;
    promptLines = [];
    coverUrl = '';
    sourceUrl = '';
    author = '';
  };

  for (const line of lines) {
    if (inFence) {
      if (/^\s*```/.test(line)) {
        inFence = false;
        inPromptSection = false;
      } else {
        promptLines.push(line);
      }
      continue;
    }

    const entry = NUMBERED_ENTRY.exec(line);
    if (entry) {
      flush();
      sequence = entry[1];
      title = entry[2].trim();
      entrySection = section;
      continue;
    }
    // 章节要排在 `title === null` 之前判：它出现在条目与条目之间，那时 title 是空的。
    const sectionMatch = NUMBERED_SECTION.exec(line);
    if (sectionMatch) {
      section = stripLeadingEmoji(sectionMatch[1]);
      continue;
    }
    if (title === null) continue;

    if (PROMPT_MARKER.test(line)) {
      inPromptSection = true;
      continue;
    }
    if (/^\s*```/.test(line) && inPromptSection) {
      inFence = true;
      continue;
    }
    if (inPromptSection) continue;

    if (!coverUrl) {
      const image = MARKDOWN_IMAGE.exec(line.trim());
      if (image) {
        coverUrl = image[1];
        continue;
      }
    }
    if (!summary && line.trim() && !line.startsWith('#') && !line.startsWith('**')) {
      summary = stripMarkdownInline(line);
      continue;
    }
    const sourceMatch = /\*\*Source:\*\*\s*(.+)$/.exec(line);
    if (sourceMatch) {
      sourceUrl = firstMarkdownHref(sourceMatch[1]);
      author = stripMarkdownInline(sourceMatch[1]);
    }
  }
  flush();

  return items;
}

/**
 * Twitter 图床支持 `?name=small` 取缩略图，原图 149KB → 63KB。只对 pbs.twimg.com
 * 生效，别的图床加了参数可能直接 404，所以按 host 判断而不是无脑拼。
 * 已经是小图（带了 name=）的不重复加。
 */
function thumbSize(url: string): string {
  if (!url.includes('pbs.twimg.com')) return url;
  if (/[?&]name=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}name=small`;
}

// ---------------------------------------------------------------------------
// 解析器 6：上游自导出的 JSON 集合
// ---------------------------------------------------------------------------

/**
 * cookbook 那份 `prompts.zh.json`：`{ name, language, license, total, prompts }`，
 * 每条形如 `{ id, category, title, scenario, prompt, sourceUrl }`。
 * `scenario` 是「什么场景用得上」，正好当描述位。
 *
 * 上游另有一份 visuals.zh.json 带 54 张配图，但两边的 id 只在部分条目上对得上、
 * 图又挂在没有 CORS 头的第三方 CDN 上（单张 1.7MB），所以这一版只取文字。
 */
export function parseJsonCollection(
  raw: unknown,
  source: PromptSource,
  fileUrl: string,
): PromptItem[] {
  const list =
    raw && typeof raw === 'object' && Array.isArray((raw as { prompts?: unknown }).prompts)
      ? ((raw as { prompts: unknown[] }).prompts)
      : [];
  const items: PromptItem[] = [];
  const seen = new Set<string>();

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const title = str(record.title);
    const prompt = str(record.prompt);
    if (!title || !prompt) continue;

    const localId = str(record.id) || slugify(title);
    const id = `${source.id}:${localId}`;
    if (seen.has(id)) continue;
    seen.add(id);

    items.push({
      id,
      title,
      prompt,
      description: str(record.scenario),
      coverUrl: '',
      referenceImageUrls: [],
      tags: categoryTags(str(record.category)),
      author: str(record.author),
      sourceUrl: absoluteUrl(fileUrl, cleanUrl(str(record.sourceUrl))) ||
        source.homepage,
      sourceId: source.id,
      sourceName: source.name,
      mediaKind: source.mediaKind,
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// 分发
// ---------------------------------------------------------------------------

export function parsePromptSource(
  payload: unknown,
  source: PromptSource,
  /** 这份 payload 来自源的哪个文件。多文件源必须显式传，否则相对路径会算错。 */
  fileUrl: string = source.urls[0] ?? '',
): PromptItem[] {
  switch (source.kind) {
    case 'registry-json':
      return parseRegistrySource(payload, source, fileUrl);
    case 'awesome-readme':
      return typeof payload === 'string'
        ? parseAwesomeReadme(payload, source, fileUrl)
        : [];
    case 'wuyoscar-gallery':
      return typeof payload === 'string'
        ? parseWuyoscarGallery(payload, source, fileUrl)
        : [];
    case 'awesome-numbered':
      return typeof payload === 'string'
        ? parseAwesomeNumbered(payload, source, fileUrl)
        : [];
    case 'json-collection':
      return parseJsonCollection(payload, source, fileUrl);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// 筛选
// ---------------------------------------------------------------------------

export const ALL_SOURCES = '__all__';

export interface PromptFilter {
  keyword: string;
  /** 源 id，或 ALL_SOURCES。 */
  sourceId: string;
  /**
   * 选中的标签，空数组 = 不限。
   *
   * 是数组不是单值：标签之间是「或」——选了 Tech 和 UI 想看的是两类，不是交集。
   * 交集在标签维度上几乎必然为空（一条内容很少同时挂两个冷门标签）。
   */
  tags: string[];
}

export function filterPromptItems(
  items: PromptItem[],
  filter: PromptFilter,
): PromptItem[] {
  const keyword = filter.keyword.trim().toLowerCase();
  return items.filter((item) => {
    if (filter.sourceId !== ALL_SOURCES && item.sourceId !== filter.sourceId) {
      return false;
    }
    if (filter.tags.length > 0 && !filter.tags.some((tag) => item.tags.includes(tag))) {
      return false;
    }
    if (!keyword) return true;
    return (
      item.title.toLowerCase().includes(keyword) ||
      item.prompt.toLowerCase().includes(keyword) ||
      item.description.toLowerCase().includes(keyword) ||
      // 标签也进搜索：筛选栏只铺得下头部几十个，剩下的标签一旦从栏里消失，
      // 没有这一条就等于那些条目再也找不到了（搜索是它们唯一的入口）。
      item.tags.some((tag) => tag.toLowerCase().includes(keyword))
    );
  });
}

/**
 * 标签按出现次数降序；次数相同的保持首次出现顺序。Map 保序 + sort 稳定（ES2019+）
 * 就够了 —— 不用 localeCompare，那个结果随运行环境的 locale 变，同一份数据在
 * 不同机器上会排得不一样。
 */
export function collectPromptTags(
  items: PromptItem[],
): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of item.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));
}

/** 有内容的源才算数，空源不进筛选栏 —— 免得点进去一片空白。 */
export function collectPromptSources(items: PromptItem[]): string[] {
  const seen: string[] = [];
  for (const item of items) {
    if (!seen.includes(item.sourceId)) seen.push(item.sourceId);
  }
  return seen;
}
