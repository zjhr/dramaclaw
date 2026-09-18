// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";
import {
  cacheStorageAvailable,
  readCachedResponse,
  writeCachedResponse,
} from "@/features/canvas/domain/remoteCache";
import {
  enabledPromptSources,
  parsePromptSource,
  type PromptItem,
  type PromptSource,
} from "@/features/canvas/domain/promptGallery";

/**
 * 提示词画廊的数据源：前端直连各个上游的 raw 文件。
 *
 * 走前端直连而不是后端代理，是因为这些都是静态文件、上游都带
 * `access-control-allow-origin: *`，为它们在后端加一个「拉远端 + 缓存 + 超时重试」
 * 的运行时依赖不划算。代价是内容不由我们掌控，所以：源清单写死在编译期（要改
 * 得发版），每个源独立加载互不牵连，单源失败只在 UI 上标一行「这个源没拉到」，
 * 不会让整面墙白掉。
 *
 * 源都是 100KB~1.2MB 的静态文件，全量约 3.5MB —— 所以这个 hook 默认不发请求，
 * 要调用方显式 `enabled`（画廊打开）才拉。画布上的节点只要渲染就拉一次 3.5MB
 * 是不可接受的。
 *
 * 离线兜底走 CacheStorage（浏览器原生的 HTTP 缓存，非 localforage 那类 JS 库）：
 * 拉成功就顺手存一份，网络挂了就拿出来用。它与 TanStack Query 的内存缓存是两层
 * 互补的东西 —— Query 管「这次会话里别重复拉」，CacheStorage 管「下次开浏览器
 * 且断网时还有得看」。缓存是尽力而为，配额满或隐私模式下静默降级，不影响主流程。
 */

export interface PromptSourceFailure {
  sourceId: string;
  sourceName: string;
  message: string;
}

export interface UsePromptGalleryResult {
  items: PromptItem[];
  /**
   * 首次加载中：一个源都还没回来，整面墙无内容可显示。
   *
   * 不能简写成「还有查询在 pending」。拉不到的源在每次重开时都会被重新尝试，
   * 那一瞬间它又回到 pending —— 只要有一个源是死的，整面墙就会永远停在
   * 「正在拉取」。已经有内容之后，剩下的进度归 isRefreshing 管。
   */
  isLoading: boolean;
  /** 已经有内容，但还有源在路上或正在重取。 */
  isRefreshing: boolean;
  /** 拉取失败的源。UI 应如实展示，不能假装这些源不存在。 */
  failures: PromptSourceFailure[];
  /** 至少一个源没失败 —— 决定「空态」还是「全部失败」。 */
  hasAnySuccess: boolean;
  /** 有几个源的内容来自离线缓存。大于 0 时 UI 该提示并给出重拉入口。 */
  offlineCount: number;
  refetch: () => void;
}

const EMPTY_ITEMS: PromptItem[] = [];
const CACHE_NAME = "prompt-gallery-v1";

interface SourcePayload {
  items: PromptItem[];
  fromCache: boolean;
}

/**
 * 一个「源 × 文件」加载单元。
 *
 * 多数源只有一个文件，但 wuyoscar 按分类拆成了 31 个 —— 每个文件各拉各的、
 * 各挂各的，一个分类挂了不该把同源另外 30 个一起拖下水。
 */
interface SourceFile {
  source: PromptSource;
  url: string;
}

/** CacheStorage 的读写在 remoteCache 里，与远端风格包共用一层。 */
async function readCachedSource(file: SourceFile): Promise<PromptItem[] | null> {
  const hit = await readCachedResponse(CACHE_NAME, file.url);
  if (!hit) return null;
  try {
    const payload: unknown = isJsonKind(file.source)
      ? await hit.json()
      : await hit.text();
    const items = parsePromptSource(payload, file.source, file.url);
    // 缓存里那份也可能是坏的（上游当时就返回了垃圾），解析不出东西等于没有。
    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}

/** 按 kind 决定怎么读 body —— raw.githubusercontent.com 对 JSON 也回 text/plain，不能靠 Content-Type 猜。 */
function isJsonKind(source: PromptSource): boolean {
  return source.kind === "registry-json" || source.kind === "json-collection";
}

async function fetchPromptSource(
  file: SourceFile,
  signal: AbortSignal,
): Promise<SourcePayload> {
  try {
    const response = await fetch(file.url, { signal, cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    // clone 必须在读 body 之前拿，之后原 response 的流就归解析用了。
    const forCache = response.clone();
    const payload: unknown = isJsonKind(file.source)
      ? await response.json()
      : await response.text();

    const items = parsePromptSource(payload, file.source, file.url);
    if (items.length === 0) {
      // 拉到了但一条都解析不出来，等于这个文件坏了。当成失败报出来，
      // 比静默显示空更诚实 —— 上游改格式时我们要能立刻看见。
      throw new Error("no parsable items");
    }
    // 解析成功才落缓存：把坏数据写进去，比不写更糟。
    void writeCachedResponse(CACHE_NAME, file.url, forCache);
    return { items, fromCache: false };
  } catch (error) {
    // 用户主动取消不算「源挂了」，别拿缓存去糊它。
    if (signal.aborted) throw error;

    const cached = await readCachedSource(file);
    if (cached) return { items: cached, fromCache: true };
    throw error;
  }
}

/** 单个源的加载汇总。失败判定挂在源上（UI 报的是「这个源没拉到」），计数在文件上。 */
interface SourceRollup {
  source: PromptSource;
  total: number;
  ok: number;
  failed: number;
  fromCache: number;
  lastError: string;
}

/**
 * 把磁盘上已有的内容读出来，顺序与 files 对齐。
 *
 * 刷新页面时内存缓存全没了，但磁盘缓存还在 —— 这层读取就是为了让首屏不用等
 * 那几 MB 重新下载。读不到（没缓存 / CacheStorage 不可用）就退空数组。
 */
async function readCachedGallery(files: SourceFile[]): Promise<PromptItem[]> {
  if (!cacheStorageAvailable()) return [];
  const perFile = await Promise.all(files.map((file) => readCachedSource(file)));
  const out: PromptItem[] = [];
  for (const items of perFile) {
    if (items) out.push(...items);
  }
  return out;
}

export function usePromptGallery(enabled: boolean): UsePromptGalleryResult {
  const sources = useMemo(() => enabledPromptSources(), []);
  const queryClient = useQueryClient();

  const files = useMemo(
    () =>
      sources.flatMap((source) =>
        source.urls.map((url) => ({ source, url })),
      ),
    [sources],
  );

  // 磁盘里已有的内容。刷新页面后内存缓存是空的，靠它先把墙画出来。
  const [seed, setSeed] = useState<PromptItem[]>(EMPTY_ITEMS);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void readCachedGallery(files).then((items) => {
      if (!cancelled && items.length > 0) setSeed(items);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, files]);

  const results = useQueries({
    queries: files.map((file) => ({
      queryKey: queryKeys.promptGallerySource(file.source.id, file.url),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchPromptSource(file, signal),
      enabled,
      // raw 文件几乎不变，重取一次要几 MB 带宽。半小时的 staleTime 足够，
      // 也顺手挡掉「关掉画廊再打开」这种来回切产生的重复请求。
      staleTime: 30 * 60 * 1000,
      gcTime: 2 * 60 * 60 * 1000,
      retry: 1,
    })),
  });

  const { items, failures, isLoading, isRefreshing, hasAnySuccess, offlineCount } =
    useMemo(() => {
      const collected: PromptItem[] = [];
      const rollups = new Map<string, SourceRollup>();
      let pending = false;
      let fetching = false;

      const rollupOf = (source: PromptSource): SourceRollup => {
        let entry = rollups.get(source.id);
        if (!entry) {
          entry = {
            source,
            total: 0,
            ok: 0,
            failed: 0,
            fromCache: 0,
            lastError: "",
          };
          rollups.set(source.id, entry);
        }
        return entry;
      };

      files.forEach((file, index) => {
        const entry = rollupOf(file.source);
        entry.total += 1;

        const result = results[index];
        if (result.isPending) pending = true;
        if (result.isFetching) fetching = true;

        if (result.isError) {
          const error = result.error;
          entry.failed += 1;
          entry.lastError =
            error instanceof Error ? error.message : String(error);
          return;
        }
        const data = result.data as SourcePayload | undefined;
        if (data) {
          entry.ok += 1;
          if (data.fromCache) entry.fromCache += 1;
          // 按源在清单里的固定顺序拼接：useQueries 的结果顺序是稳定的，
          // 但哪天有人改成动态源列表，这里也不会跟着抖。
          collected.push(...data.items);
        }
      });

      const failed: PromptSourceFailure[] = [];
      let succeeded = false;
      let fromCache = 0;
      for (const entry of rollups.values()) {
        if (entry.ok > 0) succeeded = true;
        if (entry.fromCache > 0) fromCache += 1;
        // 全部文件都挂了才算这个源不可用。wuyoscar 31 个文件里挂 3 个，
        // 报成「源不可用」是误导 —— 另外 28 个的内容明明就在墙上。
        if (entry.total > 0 && entry.ok === 0 && entry.failed === entry.total) {
          failed.push({
            sourceId: entry.source.id,
            sourceName: entry.source.name,
            message: entry.lastError,
          });
        }
      }

      const live = collected.length > 0 ? collected : EMPTY_ITEMS;
      // 网络没落定前先用磁盘内容顶着。不这么做的话，刷新页面后会「先闪 1 条
      // 再跳回全部」—— 第一个源回来时实时数据只有它自己那几条。
      const items = pending && seed.length > 0 ? seed : live;

      return {
        items,
        failures: failed,
        // 「还没东西可看」才算首次加载：一个源都没回、磁盘也没缓存。
        isLoading: pending && items.length === 0,
        // 已经有内容还在拉时，转圈图标就是唯一的后台进度提示。
        isRefreshing: fetching && !(pending && items.length === 0),
        hasAnySuccess: succeeded,
        offlineCount: fromCache,
      };
    }, [results, files, seed]);

  const refetch = useCallback(() => {
    for (const file of files) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.promptGallerySource(file.source.id, file.url),
      });
    }
  }, [queryClient, files]);

  return {
    items,
    isLoading,
    isRefreshing,
    failures,
    hasAnySuccess,
    offlineCount,
    refetch,
  };
}
