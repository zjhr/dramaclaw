// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 按需加载 + 本地缓存的远程图片。
 *
 * wuyoscar 那份 Gallery Atlas 把配图原图直接放进仓库：172 张共 442MB，均 2.6MB、
 * 单张最大 14.7MB。跟着卡片自动 `<img src>` 等于让画廊首屏去拖几百 MB —— 所以
 * 反过来：默认一张都不拉，用户点了才取，取到就进 CacheStorage，之后（含断网、
 * 含重开浏览器）直接命中，不再走网络。
 *
 * 不用 TanStack Query 是因为它缓存的是「查询结果」而不是二进制体，把 Blob 塞进
 * query cache 反而要在 gcTime 到期时自己管 object URL 的生命周期。这里的状态
 * 边界很清楚：一个 url 对应一个 object URL，卸载时撤销。
 *
 * CacheStorage 不可用（http 环境、隐私模式、配额满）时静默降级：图照样能加载，
 * 只是每次都得走网络。
 */

const CACHE_NAME = 'prompt-gallery-image-v1';

function cacheAvailable(): boolean {
  return typeof caches !== 'undefined';
}

export interface DeferredImageState {
  /** 可直接塞进 `<img src>` 的地址。空串表示还没取到。 */
  src: string;
  isLoading: boolean;
  /** 取图失败的原因。空表示没失败过。 */
  error: string | null;
  load: () => void;
}

export function useDeferredImage(url: string): DeferredImageState {
  const [src, setSrc] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 卸载后不再 setState；也用来让换 url 之后到达的旧响应自行作废。
  const alive = useRef(true);
  const objectUrl = useRef('');
  // 同一个 url 不重复取：点两下按钮不该发两个请求。
  const inFlight = useRef('');

  const swap = useCallback((next: string) => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = next;
    setSrc(next);
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = '';
    };
  }, []);

  // 换图就先清空，免得旧图挂在新条目的标题下。
  useEffect(() => {
    swap('');
    setError(null);
    setIsLoading(false);
    inFlight.current = '';
  }, [url, swap]);

  // 挂载/换 url 时先探一次缓存，命中就直接显示，用户不用点。
  useEffect(() => {
    if (!url || !cacheAvailable()) return;
    let cancelled = false;
    void (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        const hit = await cache.match(url);
        if (!hit || cancelled || !alive.current) return;
        const blob = await hit.blob();
        if (cancelled || !alive.current) return;
        swap(URL.createObjectURL(blob));
      } catch {
        // 读缓存失败等于没缓存，用户点按钮照样能取。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, swap]);

  const load = useCallback(() => {
    if (!url || inFlight.current === url) return;
    inFlight.current = url;
    setIsLoading(true);
    setError(null);
    void (async () => {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // clone 要在读 body 之前拿，之后原 response 的流就归 blob 用了。
        const forCache = response.clone();
        const blob = await response.blob();

        if (cacheAvailable()) {
          try {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(url, forCache);
          } catch {
            // 配额满：图照显示，只是下次还得重新取。
          }
        }
        if (!alive.current || inFlight.current !== url) return;
        swap(URL.createObjectURL(blob));
      } catch (cause) {
        if (!alive.current || inFlight.current !== url) return;
        inFlight.current = '';
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (alive.current && inFlight.current === url) setIsLoading(false);
      }
    })();
  }, [url, swap]);

  return { src, isLoading, error, load };
}
