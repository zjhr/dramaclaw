// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 远端源的磁盘缓存原语。
 *
 * 用浏览器原生 CacheStorage，不引入 localforage 那类 JS 库。它和 TanStack Query
 * 的内存缓存是互补的两层：Query 管「这次会话里别重复拉」，这层管「刷新页面 /
 * 关掉再开 / 断网之后还有得看」—— 前端直连上游就意味着每次刷新几 MB 下载，
 * 没有这一层用户每次刷新都要干等。
 *
 * 注意 CacheStorage 只在安全上下文可用（https 与 localhost）。用局域网 IP 打开
 * dev server 时它是 undefined，这层整体 no-op —— 功能不受影响，只是每次都得重拉。
 */

let unavailableWarned = false;

export function cacheStorageAvailable(): boolean {
  if (typeof caches !== 'undefined') return true;
  // 只喊一次。这层静默失效最难查 —— 用户看到的是「缓存没生效」，控制台却一片安静。
  if (!unavailableWarned) {
    unavailableWarned = true;
    console.warn(
      '[freezone] CacheStorage 不可用（非安全上下文？）：远端源的磁盘缓存已停用，' +
        '每次打开都会重新拉取。用 localhost 或 https 访问即可恢复。',
    );
  }
  return false;
}

/** 读不到（没缓存、读失败、环境不支持）一律返回 null，调用方按「没缓存」处理。 */
export async function readCachedResponse(
  cacheName: string,
  url: string,
): Promise<Response | null> {
  if (!cacheStorageAvailable()) return null;
  try {
    const cache = await caches.open(cacheName);
    return (await cache.match(url)) ?? null;
  } catch {
    return null;
  }
}

export async function writeCachedResponse(
  cacheName: string,
  url: string,
  response: Response,
): Promise<void> {
  if (!cacheStorageAvailable()) return;
  try {
    const cache = await caches.open(cacheName);
    await cache.put(url, response);
  } catch {
    // 配额满 / 隐私模式禁止存储。缓存是锦上添花，失败不冒泡。
  }
}
