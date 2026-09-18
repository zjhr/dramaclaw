// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDeferredImage } from '@/features/canvas/hooks/useDeferredImage';

/**
 * 按需取图的四个分支：命中缓存直接给、没缓存就等点击、点击后落缓存、失败报错。
 *
 * CacheStorage 和 createObjectURL 在 jsdom 里都没有，塞内存实现顶上。object URL
 * 用「blob:序号」这种可读形式，方便断言「是不是换了一张」。
 */

const URL_A = 'https://example.test/big-image.png';

const cacheStore = new Map<string, Blob>();
let blobSeq = 0;
let fetchCount = 0;
let fetchShouldFail = false;

function installMocks() {
  cacheStore.clear();
  blobSeq = 0;
  fetchCount = 0;
  fetchShouldFail = false;

  vi.stubGlobal('caches', {
    open: async () => ({
      put: async (req: RequestInfo, res: Response) => {
        cacheStore.set(String(req), await res.blob());
      },
      match: async (req: RequestInfo) => {
        const hit = cacheStore.get(String(req));
        if (!hit) return undefined;
        // 真 CacheStorage 每次 match 都回一个新的 Response，这里跟着来，
        // 免得测试靠着「同一个 Response 能读两次」这种真实里不成立的假设过关。
        return new Response(hit);
      },
    }),
  });

  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: () => `blob:test-${(blobSeq += 1)}`,
    revokeObjectURL: () => {},
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      fetchCount += 1;
      if (fetchShouldFail) throw new TypeError('Failed to fetch');
      return new Response('image-bytes', { status: 200 });
    }),
  );
}

beforeEach(installMocks);
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useDeferredImage', () => {
  it('没缓存时什么都不拉，等用户点', async () => {
    const { result } = renderHook(() => useDeferredImage(URL_A));
    // 探缓存的异步分支走完
    await waitFor(() => expect(fetchCount).toBe(0));

    expect(result.current.src).toBe('');
    expect(result.current.isLoading).toBe(false);
    expect(fetchCount).toBe(0);
  });

  it('点击后才发请求，拿到就显示并落缓存', async () => {
    const { result } = renderHook(() => useDeferredImage(URL_A));
    await waitFor(() => expect(result.current.src).toBe(''));

    act(() => result.current.load());

    await waitFor(() => expect(result.current.src).not.toBe(''));
    expect(fetchCount).toBe(1);
    expect(cacheStore.has(URL_A)).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('缓存里有就直接给，一次请求都不发', async () => {
    cacheStore.set(URL_A, new Blob(['cached-bytes']));

    const { result } = renderHook(() => useDeferredImage(URL_A));

    await waitFor(() => expect(result.current.src).not.toBe(''));
    expect(fetchCount).toBe(0);
  });

  it('连点两下只发一个请求', async () => {
    const { result } = renderHook(() => useDeferredImage(URL_A));
    await waitFor(() => expect(result.current.src).toBe(''));

    act(() => {
      result.current.load();
      result.current.load();
    });

    await waitFor(() => expect(result.current.src).not.toBe(''));
    expect(fetchCount).toBe(1);
  });

  it('取图失败时报错，且允许再点一次重试', async () => {
    fetchShouldFail = true;
    const { result } = renderHook(() => useDeferredImage(URL_A));
    await waitFor(() => expect(result.current.src).toBe(''));

    act(() => result.current.load());
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.src).toBe('');

    // 网络恢复后重试应当能成 —— inFlight 闸门不能在失败后卡死。
    fetchShouldFail = false;
    act(() => result.current.load());
    await waitFor(() => expect(result.current.src).not.toBe(''));
    expect(result.current.error).toBeNull();
  });

  it('url 为空串时整体 no-op（非 defer 源走的路径）', async () => {
    const { result } = renderHook(() => useDeferredImage(''));
    await waitFor(() => expect(fetchCount).toBe(0));

    act(() => result.current.load());
    expect(result.current.src).toBe('');
    expect(fetchCount).toBe(0);
  });

  it('换 url 会清掉上一条的图，不把旧图挂到新条目下', async () => {
    const { result, rerender } = renderHook(
      ({ url }: { url: string }) => useDeferredImage(url),
      { initialProps: { url: URL_A } },
    );
    await waitFor(() => expect(result.current.src).toBe(''));
    act(() => result.current.load());
    await waitFor(() => expect(result.current.src).not.toBe(''));

    rerender({ url: 'https://example.test/other.png' });
    expect(result.current.src).toBe('');
  });
});
