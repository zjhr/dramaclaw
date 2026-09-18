// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  ALL_SOURCES,
  PROMPT_SOURCES,
  collectPromptSources,
  collectPromptTags,
  filterPromptItems,
  parseAwesomeNumbered,
  parseAwesomeReadme,
  parseJsonCollection,
  parsePromptSource,
  parseRegistrySource,
  parseWuyoscarGallery,
  type PromptSource,
} from "@/features/canvas/domain/promptGallery";

/**
 * 样本全部是从上游真实响应里抄下来的片段，不是照着解析器反推的。
 * 两个上游都不为我们而写，格式随时可能变 —— 这些用例的价值就在于上游一变
 * 就会红，而不是等到用户看到空画廊。
 */

const REGISTRY_URL =
  "https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/awesome-gpt-image.json";

const REGISTRY_SOURCE: PromptSource = {
  id: "awesome-gpt-image",
  name: "Awesome GPT Image",
  kind: "registry-json",
  urls: [REGISTRY_URL],
  homepage: "https://github.com/ZeroLu/awesome-gpt-image",
  license: "MIT",
  mediaKind: "image",
  enabled: true,
};

const SEEDANCE_URL =
  "https://raw.githubusercontent.com/YouMind-OpenLab/awesome-seedance-2-prompts/main/README.md";

const SEEDANCE_SOURCE: PromptSource = {
  id: "seedance-prompts",
  name: "视频提示词 · Seedance 2.0",
  kind: "awesome-readme",
  urls: [SEEDANCE_URL],
  homepage: "https://github.com/YouMind-OpenLab/awesome-seedance-2-prompts",
  license: "CC BY 4.0",
  mediaKind: "video",
  enabled: true,
};

describe("parseRegistrySource", () => {
  it("读取扁平数组并展开字段", () => {
    const items = parseRegistrySource(
      [
        {
          id: "awesome-gpt-image:ad0d0535caecb924",
          sourceId: "awesome-gpt-image",
          title: "现实中的名人",
          prompt: "山姆·奥特曼在一家繁忙电影院的柜台后面工作",
          description: "",
          coverUrl:
            "https://github.com/user-attachments/assets/45e4f24f-4f73-4426-947d-e6ed51291956",
          referenceImageUrls: [
            "https://github.com/user-attachments/assets/45e4f24f-4f73-4426-947d-e6ed51291956",
          ],
          tags: ["摄影与照片级写实", "@flowersslop"],
          author: "@flowersslop",
          sourceUrl: "https://x.com/flowersslop/status/2044334054380552438",
          imageModel: "gpt-image-2",
        },
      ],
      REGISTRY_SOURCE,
    );

    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("现实中的名人");
    expect(items[0].tags).toEqual(["摄影与照片级写实", "@flowersslop"]);
    // 上游 id 已经带了 sourceId 前缀，不该再叠一层。
    expect(items[0].id).toBe("awesome-gpt-image:ad0d0535caecb924");
    expect(items[0].sourceUrl).toBe(
      "https://x.com/flowersslop/status/2044334054380552438",
    );
  });

  it("丢掉没有标题或没有正文的条目", () => {
    const items = parseRegistrySource(
      [
        { id: "a", title: "有标题没正文", prompt: "" },
        { id: "b", title: "", prompt: "有正文没标题" },
        { id: "c", title: "都齐", prompt: "正文" },
      ],
      REGISTRY_SOURCE,
    );
    expect(items.map((item) => item.id)).toEqual(["awesome-gpt-image:c"]);
  });

  it("缺 coverUrl 时退到第一张参考图", () => {
    const items = parseRegistrySource(
      [
        {
          id: "x",
          title: "t",
          prompt: "p",
          coverUrl: "",
          referenceImageUrls: ["https://cdn.example.com/a.png"],
        },
      ],
      REGISTRY_SOURCE,
    );
    expect(items[0].coverUrl).toBe("https://cdn.example.com/a.png");
  });

  it("相对路径按源地址展开", () => {
    const items = parseRegistrySource(
      [{ id: "x", title: "t", prompt: "p", coverUrl: "images/a.png" }],
      REGISTRY_SOURCE,
    );
    expect(items[0].coverUrl).toBe(
      "https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/images/a.png",
    );
  });

  it("id 重复只留第一条", () => {
    const items = parseRegistrySource(
      [
        { id: "dup", title: "先来的", prompt: "p" },
        { id: "dup", title: "后来的", prompt: "p" },
      ],
      REGISTRY_SOURCE,
    );
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("先来的");
  });

  it("上游返回非数组时给空结果，不抛错", () => {
    expect(parseRegistrySource({ error: "rate limited" }, REGISTRY_SOURCE)).toEqual(
      [],
    );
    expect(parseRegistrySource(null, REGISTRY_SOURCE)).toEqual([]);
  });
});

describe("parseAwesomeReadme", () => {
  const SAMPLE = [
    "## 🎬 All Prompts",
    "",
    "### Rainy Night Chase Cinematic Video Prompt",
    "",
    "![English](https://img.shields.io/badge/lang-English-blue)",
    "",
    "> A prompt for a 30-second ultra-realistic live-action video depicting a tense chase scene.",
    "",
    "#### 📝 Prompt",
    "",
    "```",
    "Create a 30-second cinematic, ultra-realistic live-action video set on a rainy city street at night.",
    "Show a person walking alone along the sidewalk in the heavy rain.",
    "```",
    "",
    '<img src="https://pbs.twimg.com/amplify_video_thumb/2100087659473625088/img/DUCQqATPo0faWWv1.jpg" width="600" alt="Rainy Night Chase">',
    "",
    "**[🎬 Watch Video →](https://youmind.com/en-US/seedance-2-0-prompts?id=10905)**",
    "",
    "**Author:** [liana](https://x.com/Lianaalane) | **Source:** [Link](https://x.com/Lianaalane/status/2100088243492385019) | **Published:** Sep 16, 2026",
    "",
    "---",
    "### Korean Morning Routine Beauty Video Prompt",
    "",
    "> Another summary.",
    "",
    "#### 📝 Prompt",
    "",
    "```",
    "Created a video of a Korean girl enjoying a calm morning routine.",
    "```",
  ].join("\n");

  it("从围栏代码块取正文，摘要取正文之前那段引用", () => {
    const items = parseAwesomeReadme(SAMPLE, SEEDANCE_SOURCE);

    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("Rainy Night Chase Cinematic Video Prompt");
    expect(items[0].description).toBe(
      "A prompt for a 30-second ultra-realistic live-action video depicting a tense chase scene.",
    );
    expect(items[0].prompt).toBe(
      "Create a 30-second cinematic, ultra-realistic live-action video set on a rainy city street at night.\nShow a person walking alone along the sidewalk in the heavy rain.",
    );
    expect(items[0].author).toBe("liana");
    expect(items[0].sourceUrl).toBe(
      "https://x.com/Lianaalane/status/2100088243492385019",
    );
    expect(items[0].coverUrl).toBe(
      "https://pbs.twimg.com/amplify_video_thumb/2100087659473625088/img/DUCQqATPo0faWWv1.jpg",
    );
    expect(items[0].mediaKind).toBe("video");
  });

  it("围栏里的 `###` 不会被当成新条目", () => {
    const items = parseAwesomeReadme(
      [
        "### Title",
        "",
        "#### 📝 Prompt",
        "",
        "```",
        "### this is prompt text, not a heading",
        "body",
        "```",
      ].join("\n"),
      SEEDANCE_SOURCE,
    );
    expect(items).toHaveLength(1);
    expect(items[0].prompt).toBe("### this is prompt text, not a heading\nbody");
  });

  it("没有代码块的条目被丢弃", () => {
    const items = parseAwesomeReadme(
      ["### 只有标题", "", "> 摘要", "", "没有正文块"].join("\n"),
      SEEDANCE_SOURCE,
    );
    expect(items).toEqual([]);
  });
});

describe("parsePromptSource 分发", () => {
  it("按 kind 选解析器，文本源收到非字符串时给空结果", () => {
    expect(parsePromptSource("not json", REGISTRY_SOURCE)).toEqual([]);
    expect(parsePromptSource({}, SEEDANCE_SOURCE)).toEqual([]);
  });
});

describe("筛选与聚合", () => {
  const items = [
    {
      id: "a:1",
      title: "雨夜追逐",
      prompt: "rainy night chase",
      description: "",
      coverUrl: "",
      referenceImageUrls: [],
      tags: ["视频", "cinematic"],
      author: "",
      sourceUrl: "",
      sourceId: "a",
      sourceName: "A",
      mediaKind: "video" as const,
    },
    {
      id: "b:1",
      title: "角色板",
      prompt: "character sheet",
      description: "锁定身份",
      coverUrl: "",
      referenceImageUrls: [],
      tags: ["视频", "分镜"],
      author: "",
      sourceUrl: "",
      sourceId: "b",
      sourceName: "B",
      mediaKind: "image" as const,
    },
  ];

  it("无筛选条件时全返回", () => {
    expect(
      filterPromptItems(items, {
        keyword: "",
        sourceId: ALL_SOURCES,
        tags: [],
      }),
    ).toHaveLength(2);
  });

  it("关键词匹配标题、正文和描述", () => {
    const byKeyword = (keyword: string) =>
      filterPromptItems(items, { keyword, sourceId: ALL_SOURCES, tags: [] });
    expect(byKeyword("雨夜")).toHaveLength(1);
    expect(byKeyword("character")).toHaveLength(1);
    expect(byKeyword("锁定")).toHaveLength(1);
    expect(byKeyword("不存在")).toHaveLength(0);
  });

  it("关键词也匹配标签", () => {
    // 筛选栏只铺得下头部几十个标签，剩下的标签一旦从栏里消失，搜索就是它们
    // 唯一的入口 —— 这条断了，那些条目就等于从画廊里消失了。
    const byKeyword = (keyword: string) =>
      filterPromptItems(items, { keyword, sourceId: ALL_SOURCES, tags: [] });
    // "分镜" 只出现在 b 的标签里，标题/正文/描述都没有它
    expect(byKeyword("分镜")).toHaveLength(1);
    expect(byKeyword("分镜")[0].id).toBe("b:1");
    // 标签里出现、但不属于任何条目的词仍然搜不到
    expect(byKeyword("不存在的标签")).toHaveLength(0);
  });

  it("标签搜索大小写不敏感", () => {
    expect(
      filterPromptItems(items, {
        keyword: "CINEMATIC",
        sourceId: ALL_SOURCES,
        tags: [],
      }),
    ).toHaveLength(1);
  });

  it("关键词大小写不敏感", () => {
    expect(
      filterPromptItems(items, {
        keyword: "RAINY",
        sourceId: ALL_SOURCES,
        tags: [],
      }),
    ).toHaveLength(1);
  });

  it("源与标签是取交集", () => {
    expect(
      filterPromptItems(items, { keyword: "", sourceId: "b", tags: ["视频"] }),
    ).toHaveLength(1);
    expect(
      filterPromptItems(items, { keyword: "", sourceId: "a", tags: ["分镜"] }),
    ).toHaveLength(0);
  });

  it("标签按出现次数降序，并带上频次", () => {
    // 频次是给弹层显示的：用户得看得出哪些是头部标签，哪些只挂了一条。
    expect(collectPromptTags(items)).toEqual([
      { tag: "视频", count: 2 },
      { tag: "cinematic", count: 1 },
      { tag: "分镜", count: 1 },
    ]);
  });

  it("标签筛选是「或」不是「与」", () => {
    // 选了 Tech 和 UI 想看的是两类。交集在标签维度上几乎必然为空
    // —— 一条内容很少同时挂两个冷门标签。
    const byTags = (tags: string[]) =>
      filterPromptItems(items, { keyword: "", sourceId: ALL_SOURCES, tags });
    expect(byTags([])).toHaveLength(2);
    expect(byTags(["cinematic"])).toHaveLength(1);
    expect(byTags(["分镜"])).toHaveLength(1);
    // 两个标签各命中一条 ⇒ 并集 2 条（交集为 0，若按「与」算会是 0）
    expect(byTags(["cinematic", "分镜"])).toHaveLength(2);
    expect(byTags(["cinematic", "不存在"])).toHaveLength(1);
  });

  it("只列出真有内容的源", () => {
    expect(collectPromptSources(items)).toEqual(["a", "b"]);
    expect(collectPromptSources([])).toEqual([]);
  });
});

describe("源注册表", () => {
  it("id 唯一，且都以 main 分支的 raw 地址为准", () => {
    const ids = PROMPT_SOURCES.map((source) => source.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const source of PROMPT_SOURCES) {
      expect(source.urls.length).toBeGreaterThan(0);
      for (const url of source.urls) {
        expect(url).toMatch(/^https:\/\/raw\.githubusercontent\.com\//);
      }
      expect(source.homepage).toMatch(/^https:\/\//);
      expect(source.enabled).toBe(true);
    }
  });

  it("CC BY 源带许可标识，UI 才有得展示", () => {
    const seedance = PROMPT_SOURCES.find(
      (source) => source.id === "seedance-prompts",
    );
    expect(seedance?.license).toContain("CC BY");
  });
});

// ---------------------------------------------------------------------------
// 三个新源。样本同样是从上游真实响应里截的。
// ---------------------------------------------------------------------------

const WUYOSCAR_URL =
  "https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/skills/gpt-image/references/gallery-fashion-editorial.md";

const WUYOSCAR_SOURCE: PromptSource = {
  id: "wuyoscar-gpt-image2",
  name: "GPT Image 2.5 Gallery · wuyoscar",
  kind: "wuyoscar-gallery",
  urls: [WUYOSCAR_URL],
  assetBase: "https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/",
  homepage: "https://github.com/wuyoscar/GPT-Image2-Skill",
  license: "MIT",
  mediaKind: "image",
  enabled: true,
};

const WUYOSCAR_SAMPLE = [
  "# 👗 Fashion Editorial",
  "",
  "Range: No. 130–136 · Count: 7",
  "",
  "### No. 130 · Urban Streetwear Lookbook: Shibuya Night",
  "",
  "- Image: `docs/fashion-editorial/streetwear-tokyo-lookbook.png`",
  "",
  '  <img src="../../../docs/fashion-editorial/streetwear-tokyo-lookbook.png" width="420"/>',
  "- Metadata: Fashion Editorial · `portrait` · `1024x1536` · Curated",
  "",
  "```text",
  "Full-body lookbook photography of a model in Shibuya.",
  "```",
  "",
  "### No. 135 · Muted streetwear studio editorial portrait",
  "",
  "- Image: `docs/fashion-editorial/editorial-studio-portrait.png`",
  "- Metadata: Fashion Editorial · `portrait` · `1024x1536` · Author: @john_my07 · Source: [X](https://x.com/john_my07/status/2047182640760140198)",
  "",
  "```text",
  "A high-end studio photoshoot featuring a half-body portrait.",
  "```",
].join("\n");

describe("parseWuyoscarGallery", () => {
  it("按 `### No. N ·` 切条目，正文取围栏内容", () => {
    const items = parseWuyoscarGallery(
      WUYOSCAR_SAMPLE,
      WUYOSCAR_SOURCE,
      WUYOSCAR_URL,
    );
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("Urban Streetwear Lookbook: Shibuya Night");
    expect(items[0].prompt).toContain("Full-body lookbook photography");
    // 围栏外的 Image/Metadata 两行不能混进正文
    expect(items[0].prompt).not.toContain("docs/fashion-editorial");
    expect(items[0].prompt).not.toContain("Metadata:");
  });

  it("配图走 assetBase 而不是 md 文件所在目录", () => {
    const items = parseWuyoscarGallery(
      WUYOSCAR_SAMPLE,
      WUYOSCAR_SOURCE,
      WUYOSCAR_URL,
    );
    // md 在 skills/gpt-image/references/ 下，图在仓库根的 docs/ 下。
    // 按文件位置解析会得到 .../references/docs/... 这种不存在的地址。
    expect(items[0].coverUrl).toBe(
      "https://raw.githubusercontent.com/wuyoscar/GPT-Image2-Skill/main/docs/fashion-editorial/streetwear-tokyo-lookbook.png",
    );
  });

  it("标了 deferImage：442MB 原图不能跟着卡片自动加载", () => {
    const items = parseWuyoscarGallery(
      WUYOSCAR_SAMPLE,
      WUYOSCAR_SOURCE,
      WUYOSCAR_URL,
    );
    expect(items.every((item) => item.deferImage === true)).toBe(true);
  });

  it("Metadata 里的分类、作者、出处都能取出来", () => {
    const items = parseWuyoscarGallery(
      WUYOSCAR_SAMPLE,
      WUYOSCAR_SOURCE,
      WUYOSCAR_URL,
    );
    expect(items[0].tags).toEqual(["Fashion Editorial"]);
    expect(items[0].author).toBe("");
    expect(items[1].author).toBe("@john_my07");
    expect(items[1].sourceUrl).toBe(
      "https://x.com/john_my07/status/2047182640760140198",
    );
  });

  it("`### No.` 出现在正文围栏里不算新条目", () => {
    const text = [
      "### No. 1 · First",
      "",
      "```text",
      "### No. 2 · 这是正文里的字样，不是条目标题",
      "```",
    ].join("\n");
    const items = parseWuyoscarGallery(text, WUYOSCAR_SOURCE, WUYOSCAR_URL);
    expect(items).toHaveLength(1);
  });

  it("没有正文的条目直接丢", () => {
    const text = [
      "### No. 1 · Only Metadata",
      "- Image: `docs/x.png`",
      "- Metadata: Test · `square`",
    ].join("\n");
    expect(parseWuyoscarGallery(text, WUYOSCAR_SOURCE, WUYOSCAR_URL)).toEqual(
      [],
    );
  });
});

const NUMBERED_URL =
  "https://raw.githubusercontent.com/devanshug2307/Awesome-AI-Image-Prompts/main/README.md";

const NUMBERED_SOURCE: PromptSource = {
  id: "awesome-ai-image-prompts",
  name: "Awesome AI Image Prompts",
  kind: "awesome-numbered",
  urls: [NUMBERED_URL],
  homepage: "https://github.com/devanshug2307/Awesome-AI-Image-Prompts",
  license: "MIT",
  mediaKind: "image",
  enabled: true,
};

const NUMBERED_SAMPLE = [
  "## 1. 🏙️ 3D Miniatures & Dioramas",
  "",
  "### 1.1. 3D Render: Whimsical Miniature Starbucks Coffee Shop Scene",
  "",
  "![3D Render: Whimsical Miniature Starbucks Coffee Shop Scene](https://pbs.twimg.com/media/G7BWvI8X0AApeZB.jpg)",
  "",
  "A whimsical 3D render illustrates a multi-story Starbucks coffee shop.",
  "",
  "**Prompt:**",
  "",
  "```",
  "{Brand Name}",
  "--- Prompt ---",
  "3D chibi-style miniature concept store of {Brand Name}.",
  "```",
  "",
  "**Source:** [宝玉](https://x.com/dotey/status/1995190286775881780)",
  "",
  "## 15. ✨ Miscellaneous",
  "",
  "### 15.2. Gemini Google Nano Banana Pro",
  "",
  "![dup a](https://pbs.twimg.com/media/AAAA.jpg)",
  "",
  "第一条同名条目。",
  "",
  "**Prompt:**",
  "",
  "```",
  "body one",
  "```",
  "",
  "### 15.3. Gemini Google Nano Banana Pro",
  "",
  "![dup b](https://pbs.twimg.com/media/BBBB.jpg)",
  "",
  "第二条同名条目。",
  "",
  "**Prompt:**",
  "",
  "```",
  "body two",
  "```",
].join("\n");

describe("parseAwesomeNumbered", () => {
  it("按 `### N.N.` 切条目并剥掉序号前缀", () => {
    const items = parseAwesomeNumbered(
      NUMBERED_SAMPLE,
      NUMBERED_SOURCE,
      NUMBERED_URL,
    );
    expect(items[0].title).toBe(
      "3D Render: Whimsical Miniature Starbucks Coffee Shop Scene",
    );
    expect(items[0].prompt).toContain("3D chibi-style miniature concept store");
    expect(items[0].description).toBe(
      "A whimsical 3D render illustrates a multi-story Starbucks coffee shop.",
    );
  });

  it("Twitter 图加 ?name=small 取缩略图（149KB → 63KB）", () => {
    const items = parseAwesomeNumbered(
      NUMBERED_SAMPLE,
      NUMBERED_SOURCE,
      NUMBERED_URL,
    );
    expect(items[0].coverUrl).toBe(
      "https://pbs.twimg.com/media/G7BWvI8X0AApeZB.jpg?name=small",
    );
  });

  it("标题重名的条目不会被去重挤掉", () => {
    // 上游 15.2/15.3/15.4 三条都叫 Gemini Google Nano Banana Pro。
    // 只拿标题做 id 会只剩一条，序号才是唯一键。
    const items = parseAwesomeNumbered(
      NUMBERED_SAMPLE,
      NUMBERED_SOURCE,
      NUMBERED_URL,
    );
    const dups = items.filter(
      (item) => item.title === "Gemini Google Nano Banana Pro",
    );
    expect(dups).toHaveLength(2);
    expect(new Set(dups.map((item) => item.id)).size).toBe(2);
    expect(dups.map((item) => item.prompt).sort()).toEqual([
      "body one",
      "body two",
    ]);
  });

  it("Author 从 **Source:** 行取，且正文不受 Source 行干扰", () => {
    const items = parseAwesomeNumbered(
      NUMBERED_SAMPLE,
      NUMBERED_SOURCE,
      NUMBERED_URL,
    );
    expect(items[0].author).toBe("宝玉");
    expect(items[0].sourceUrl).toBe(
      "https://x.com/dotey/status/1995190286775881780",
    );
    expect(items[0].prompt).not.toContain("**Source:**");
  });

  it("编号章节当分类标签，emoji 与序号都剥掉", () => {
    const items = parseAwesomeNumbered(
      NUMBERED_SAMPLE,
      NUMBERED_SOURCE,
      NUMBERED_URL,
    );
    // `## 1. 🏙️ 3D Miniatures & Dioramas`
    expect(items[0].tags).toEqual(["3D Miniatures & Dioramas"]);
    // 条目按章节归属，15.x 不该还挂在第 1 章下
    const misc = items.filter((item) => item.title === "Gemini Google Nano Banana Pro");
    expect(misc.every((item) => item.tags[0] === "Miscellaneous")).toBe(true);
  });

  it("非编号的二级标题不当分类", () => {
    // 上游那份 README 里 `## JSON Structure Template` 这类段落标题和真分类长得
    // 一模一样，只有编号能区分。把它们当分类会凭空造出十几个假标签。
    const text = [
      "## Common Mistakes to Avoid",
      "",
      "### 1.1. First Prompt",
      "",
      "**Prompt:**",
      "",
      "```",
      "body",
      "```",
    ].join("\n");
    const items = parseAwesomeNumbered(text, NUMBERED_SOURCE, NUMBERED_URL);
    expect(items).toHaveLength(1);
    expect(items[0].tags).toEqual([]);
  });
});

const COLLECTION_URL =
  "https://raw.githubusercontent.com/gpt-img-2/ai-image-prompt-cookbook/main/data/prompts.zh.json";

const COLLECTION_SOURCE: PromptSource = {
  id: "image-prompt-cookbook-zh",
  name: "AI 图像提示词库 · 中文",
  kind: "json-collection",
  urls: [COLLECTION_URL],
  homepage: "https://github.com/gpt-img-2/ai-image-prompt-cookbook",
  license: "CC BY 4.0",
  mediaKind: "image",
  enabled: true,
};

const COLLECTION_SAMPLE = {
  name: "AI Image Prompt Cookbook",
  language: "zh",
  license: "CC BY 4.0",
  total: 2,
  prompts: [
    {
      id: "ai-nvzhuang-tishici-template-01",
      type: "template",
      category: "AI 女装",
      title: "女装店对镜自拍",
      scenario: "女装店上新、直播预热视频、小红书穿搭图。",
      prompt: "生成一张 9:16 竖版女装店对镜自拍图，年轻模特穿着[服装款式]。",
      sourceUrl: "https://image3.org/zh/prompts/ai-nvzhuang-tishici",
    },
    {
      id: "ecommerce-main-image-01",
      category: "电商主图",
      title: "白底商品主图",
      scenario: "电商平台上架。",
      prompt: "生成一张白底商品主图。",
      sourceUrl: "https://image3.org/zh/prompts/ecommerce-main-image",
    },
  ],
};

describe("parseJsonCollection", () => {
  it("读 prompts 数组并把 scenario 当描述位", () => {
    const items = parseJsonCollection(
      COLLECTION_SAMPLE,
      COLLECTION_SOURCE,
      COLLECTION_URL,
    );
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("女装店对镜自拍");
    expect(items[0].description).toBe("女装店上新、直播预热视频、小红书穿搭图。");
    expect(items[0].tags).toEqual(["AI 女装"]);
    expect(items[0].sourceUrl).toBe(
      "https://image3.org/zh/prompts/ai-nvzhuang-tishici",
    );
  });

  it("没有 prompts 字段 / 不是对象时退空数组，不抛错", () => {
    expect(
      parseJsonCollection({ error: "rate limited" }, COLLECTION_SOURCE, COLLECTION_URL),
    ).toEqual([]);
    expect(
      parseJsonCollection(null, COLLECTION_SOURCE, COLLECTION_URL),
    ).toEqual([]);
    expect(
      parseJsonCollection("not json", COLLECTION_SOURCE, COLLECTION_URL),
    ).toEqual([]);
  });

  it("缺 title 或 prompt 的条目跳过", () => {
    const items = parseJsonCollection(
      { prompts: [{ id: "a", title: "只有标题" }, COLLECTION_SAMPLE.prompts[0]] },
      COLLECTION_SOURCE,
      COLLECTION_URL,
    );
    expect(items).toHaveLength(1);
  });
});
