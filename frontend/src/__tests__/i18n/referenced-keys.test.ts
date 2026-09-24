// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 代码引用的 i18n key 必须在词条里存在。
//
// 为什么需要它：`locales-json.test.ts` 只校验 en/zh/vi 三语**互相一致**，不校验
// 「代码里引用的 key 到底有没有」。于是代码写了 `t('node.xxx')` 而词条从没加过时，
// 三语一起缺失、测试全绿，线上 i18next 把 key 原样渲染出来给用户看。
// 这个 bug 在本仓已经发生过两次（重拍工具栏与重拍时间轴），所以在这里钉住。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const LANGS = ["en", "zh", "vi"];

function loadLocale(lang: string): unknown {
  return JSON.parse(readFileSync(`public/locales/${lang}/translation.json`, "utf8"));
}

function hasKey(root: unknown, key: string): boolean {
  let current: unknown = root;
  for (const segment of key.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return false;
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) return false;
  }
  return true;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * 取出每个 `t(...)` 调用的实参文本。做括号配对而不是正则，是为了能穿过三元与换行 ——
 * `t(cond ? 'a.b' : 'a.c')` 里的两个 key 同样要算数（漏掉这类正是上一轮修不全的原因）。
 */
function translationArguments(source: string): string[] {
  const args: string[] = [];
  const call = /(?<![\w.])t\(\s*/g;
  let match: RegExpExecArray | null;

  while ((match = call.exec(source)) !== null) {
    let index = match.index + match[0].length;
    let depth = 1;
    let quote: string | null = null;
    let escaped = false;

    while (index < source.length && depth > 0) {
      const char = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'" || char === "`") {
        quote = char;
      } else if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
      index += 1;
    }
    args.push(source.slice(match.index, index));
  }

  return args;
}

const KEY_LITERAL = /['"]([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+)['"]/g;
/** `t(`node.move.${x}`)` 这类模板：前缀只能静态查到「点号前」那一段。 */
const DYNAMIC_PREFIX = /`([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)*)\.\$\{/g;

function scanSource(): { keys: Map<string, string>; prefixes: Map<string, string> } {
  const keys = new Map<string, string>();
  const prefixes = new Map<string, string>();

  for (const file of walk("src")) {
    for (const arg of translationArguments(readFileSync(file, "utf8"))) {
      for (const match of arg.matchAll(KEY_LITERAL)) {
        // `t('audioType.' + type)`：完整 key 只有运行时才知道，静态查不了。
        if (match[1].endsWith(".")) continue;
        if (!keys.has(match[1])) keys.set(match[1], file);
      }
      for (const match of arg.matchAll(DYNAMIC_PREFIX)) {
        if (!prefixes.has(match[1])) prefixes.set(match[1], file);
      }
    }
  }

  return { keys, prefixes };
}

const { keys: referencedKeys, prefixes: dynamicPrefixes } = scanSource();

describe("i18n keys referenced by the source", () => {
  it("parses the source tree instead of silently finding nothing", () => {
    // 防呆：解析器坏掉时（比如 `t(` 的匹配失效）这条先红，
    // 而不是让下面几条拿着空集合「全部通过」。
    expect(referencedKeys.size).toBeGreaterThan(3000);
    expect(dynamicPrefixes.size).toBeGreaterThan(20);
  });

  it.each(LANGS)("every referenced key exists in %s", (lang) => {
    const locale = loadLocale(lang);
    const missing = [...referencedKeys.entries()]
      .filter(([key]) => !hasKey(locale, key))
      .map(([key, file]) => `${key}  ← ${file}`)
      .sort();

    expect(missing).toEqual([]);
  });

  it.each(LANGS)("every dynamic key prefix resolves to an object in %s", (lang) => {
    const locale = loadLocale(lang);
    const missing = [...dynamicPrefixes.entries()]
      .filter(([prefix]) => !hasKey(locale, prefix))
      .map(([prefix, file]) => `${prefix}  ← ${file}`)
      .sort();

    expect(missing).toEqual([]);
  });
});
