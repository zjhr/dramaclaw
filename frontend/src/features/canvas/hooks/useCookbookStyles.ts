// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { FreezoneStyleTemplate } from '@/api/ops';
import { queryKeys } from '@/lib/query-keys';
import {
  readCachedResponse,
  writeCachedResponse,
} from '@/features/canvas/domain/remoteCache';
import { COOKBOOK_DATA_URL, parseCookbookStyles } from '@/features/canvas/domain/styleCookbook';

/**
 * 远端风格包（VigoZhao/AI-Visual-Prompt-Cookbook）的数据源。
 *
 * 和内置的 45 条并列展示，但来路完全不同：内置那批走项目后端接口，这批是前端
 * 直连上游 raw 文件。所以：
 *
 * - **默认不发请求**。全量 2.25MB，画布上只要有节点渲染就去拉是不可接受的，
 *   要调用方显式 `enabled`（图墙打开，或已选中一个远端风格）才拉。
 * - **落磁盘缓存**。刷新页面后内存缓存是空的，没有这一层用户每次刷新都要重下
 *   2.25MB。命中缓存时先把内容顶上去，网络回来后自然替换。
 * - **失败就退空数组**，只 warn 不上抛。内置 45 条照常可用，图墙少 130 条是能
 *   看懂的降级；为此把整个风格选择流程卡住才是真问题。这与同族的
 *   useFreezoneStyleTemplates 对失败的处理保持一致。
 */
const EMPTY: FreezoneStyleTemplate[] = [];
const CACHE_NAME = 'style-cookbook-v1';

async function readCookbookCache(): Promise<FreezoneStyleTemplate[]> {
  const hit = await readCachedResponse(CACHE_NAME, COOKBOOK_DATA_URL);
  if (!hit) return EMPTY;
  try {
    return parseCookbookStyles(await hit.text());
  } catch {
    return EMPTY;
  }
}

export function useCookbookStyles(enabled: boolean): FreezoneStyleTemplate[] {
  const { data } = useQuery({
    queryKey: queryKeys.cookbookStyles(),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      try {
        const response = await fetch(COOKBOOK_DATA_URL, {
          signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // clone 要在读 body 之前拿，之后原 response 的流就归解析用了。
        const forCache = response.clone();
        const templates = parseCookbookStyles(await response.text());
        if (templates.length === 0) {
          // 拉到了但一条都解析不出来，等于这个文件坏了。当成失败报出来，
          // 别把坏数据写进缓存 —— 那比不写更糟。
          throw new Error('no parsable styles');
        }
        void writeCachedResponse(CACHE_NAME, COOKBOOK_DATA_URL, forCache);
        return templates;
      } catch (error) {
        if (!signal.aborted) {
          console.warn(
            '[freezone] cookbook styles fetch failed:',
            error instanceof Error ? error.message : String(error),
          );
        }
        throw error;
      }
    },
    enabled,
    // 上游是「每日更新」的策展仓，半小时的 staleTime 足够，
    // 也顺手挡掉「关掉图墙再打开」这种来回切产生的重复请求。
    staleTime: 30 * 60 * 1000,
    gcTime: 2 * 60 * 60 * 1000,
    retry: 1,
  });

  // 刷新页面后内存缓存是空的，先拿磁盘里那份顶上，别让图墙只剩内置 45 条。
  const [seed, setSeed] = useState<FreezoneStyleTemplate[]>(EMPTY);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void readCookbookCache().then((templates) => {
      if (!cancelled && templates.length > 0) setSeed(templates);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return useMemo(() => {
    const live = data && data.length > 0 ? data : EMPTY;
    return live.length > 0 ? live : seed;
  }, [data, seed]);
}
