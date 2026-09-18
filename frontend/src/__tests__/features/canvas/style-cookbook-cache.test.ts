// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCookbookStyles } from '@/features/canvas/hooks/useCookbookStyles';
import { COOKBOOK_DATA_URL } from '@/features/canvas/domain/styleCookbook';

/**
 * 远端风格包的磁盘缓存。用户报的现象是「刷新页面后每次点开风格画廊都要重下」——
 * 内存缓存随刷新清空是必然的，所以这层必须落在磁盘上。
 */

const BODY = `window.COOKBOOK_STYLES = ${JSON.stringify({
  styles: [
    { slug: 'style-a', name: 'Style A', category: 'Type Posters', summary: 'A 的描述' },
    { slug: 'style-b', name: 'Style B', category: 'Zine + Collage', summary: 'B 的描述' },
  ],
})};`;

let networkHangs = false;
const cacheStore = new Map<string, Response>();

function installMocks() {
  networkHangs = false;
  cacheStore.clear();

  vi.stubGlobal('caches', {
    open: async () => ({
      put: async (req: RequestInfo, res: Response) => {
        cacheStore.set(String(req), res.clone());
      },
      match: async (req: RequestInfo) => {
        const hit = cacheStore.get(String(req));
        return hit ? hit.clone() : undefined;
      },
    }),
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (networkHangs) return new Promise<Response>(() => {});
      return new Response(BODY, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }),
  );
}

beforeEach(installMocks);
afterEach(() => vi.unstubAllGlobals());

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 1 } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe('useCookbookStyles', () => {
  it('enabled=false 时一个请求都不发', async () => {
    renderHook(() => useCookbookStyles(false), { wrapper: wrapper() });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(cacheStore.size).toBe(0);
  });

  it('拉成功后把原文落进磁盘缓存', async () => {
    const { result } = renderHook(() => useCookbookStyles(true), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.length).toBe(2));
    expect(cacheStore.has(COOKBOOK_DATA_URL)).toBe(true);
  });

  it('刷新页面后（全新 QueryClient）该先用磁盘缓存出内容', async () => {
    const first = renderHook(() => useCookbookStyles(true), { wrapper: wrapper() });
    await waitFor(() => expect(first.result.current.length).toBe(2));
    first.unmount();

    // 刷新：新 client（内存缓存没了）+ 网络卡住不返回
    networkHangs = true;
    const second = renderHook(() => useCookbookStyles(true), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(second.result.current.length).toBe(2));
    expect(second.result.current[0].id).toBe('cookbook:style-a');
  });

  it('解析不出版本不对的缓存时退空数组，不抛错', async () => {
    cacheStore.set(COOKBOOK_DATA_URL, new Response('garbage', { status: 200 }));
    networkHangs = true;

    const { result } = renderHook(() => useCookbookStyles(true), {
      wrapper: wrapper(),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(result.current).toEqual([]);
  });

  it('解析结果为空时不写缓存（坏数据比没数据更糟）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('window.COOKBOOK_STYLES = {};', { status: 200 })),
    );

    const { result } = renderHook(() => useCookbookStyles(true), {
      wrapper: wrapper(),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(result.current).toEqual([]);
    expect(cacheStore.size).toBe(0);
  });
});
