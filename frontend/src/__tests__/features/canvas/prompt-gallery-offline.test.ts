// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePromptGallery } from "@/features/canvas/hooks/usePromptGallery";
import { PROMPT_SOURCES } from "@/features/canvas/domain/promptGallery";

/**
 * 离线兜底的三个分支：正常走网络、网络挂了退缓存、两头都没有。
 *
 * 缓存层用的是浏览器原生 CacheStorage，jsdom 里没有，所以这里塞一个内存实现 ——
 * 正好也把「put 进去的 Response body 只能读一次」这个真实约束暴露出来：mock 里
 * 存取两端都做 clone，读法跟真实现一致，不然测试会掩盖掉二次读取失败的 bug。
 */

const REGISTRY_BODY = JSON.stringify([
  { id: "t1", title: "测试条目", prompt: "一段提示词正文" },
]);

const README_BODY = [
  "### Test Prompt Title",
  "",
  "> 摘要",
  "",
  "#### 📝 Prompt",
  "",
  "```",
  "body text",
  "```",
].join("\n");

const WUYOSCAR_BODY = [
  "### No. 1 · Test Entry",
  "",
  "- Image: `docs/test/a.png`",
  "- Metadata: Test · `square`",
  "",
  "```text",
  "body text",
  "```",
].join("\n");

const NUMBERED_BODY = [
  "### 1.1. Test Prompt Title",
  "",
  "![alt](https://pbs.twimg.com/media/XXXX.jpg)",
  "",
  "摘要段",
  "",
  "**Prompt:**",
  "",
  "```",
  "body text",
  "```",
].join("\n");

const COLLECTION_BODY = JSON.stringify({
  prompts: [{ id: "t1", title: "测试条目", prompt: "一段提示词正文" }],
});

/**
 * 加载单元是「源 × 文件」而不是「源」：wuyoscar 一个源挂了 31 个上游文件，
 * 缓存和条数都按文件数算，只有 offlineCount（按源计）还对着源数。
 */
const FILE_COUNT = PROMPT_SOURCES.reduce(
  (sum, source) => sum + source.urls.length,
  0,
);

let networkUp = true;
/** 请求发得出去但永远不返回 —— 模拟「刷新页面后网络很慢」，首屏不该等它。 */
let networkHangs = false;

function bodyFor(url: string): string {
  const source = PROMPT_SOURCES.find((item) => item.urls.includes(url));
  switch (source?.kind) {
    case "registry-json":
      return REGISTRY_BODY;
    case "json-collection":
      return COLLECTION_BODY;
    case "wuyoscar-gallery":
      return WUYOSCAR_BODY;
    case "awesome-numbered":
      return NUMBERED_BODY;
    default:
      return README_BODY;
  }
}

const cacheStore = new Map<string, Response>();

/** 这些 URL 永远 404 —— 用来复现「上游有个源挂了一直拉不到」的网络。 */
const deadUrls = new Set<string>();

function installMocks() {
  cacheStore.clear();
  deadUrls.clear();
  networkUp = true;
  networkHangs = false;

  vi.stubGlobal("caches", {
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
    "fetch",
    vi.fn(async (url: string) => {
      if (!networkUp) throw new TypeError("Failed to fetch");
      if (networkHangs) return new Promise<Response>(() => {});
      if (deadUrls.has(url)) return new Response("gone", { status: 404 });
      return new Response(bodyFor(url), {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }),
  );
}

/** 每个用例一个新 QueryClient —— 内存缓存不串味，CacheStorage 才是跨会话那层。 */
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    // retryDelay 压到 1ms：hook 里给每个源配了 retry: 1，默认的指数退避会让
    // 「断网」那类用例要等好几秒才落到 error 态，测试没必要陪它等。
    defaultOptions: { queries: { retry: false, retryDelay: 1 } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(installMocks);
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("usePromptGallery 离线兜底", () => {
  it("网络正常时不碰缓存", async () => {
    const { result } = renderHook(() => usePromptGallery(true), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.failures).toEqual([]);
    expect(result.current.offlineCount).toBe(0);
    expect(result.current.hasAnySuccess).toBe(true);
    expect(result.current.items.length).toBe(FILE_COUNT);
    // 成功那次应该把每个文件都写进缓存了
    expect(cacheStore.size).toBe(FILE_COUNT);
  });

  it("网络挂了就退到离线缓存，并报出 offlineCount", async () => {
    // 第一轮：联网跑一次，把缓存填上。
    const first = renderHook(() => usePromptGallery(true), { wrapper });
    await waitFor(() => expect(first.result.current.isLoading).toBe(false));
    expect(cacheStore.size).toBe(FILE_COUNT);

    // 第二轮：断网 + 全新 QueryClient（内存缓存清空），只剩 CacheStorage 可用。
    networkUp = false;
    const second = renderHook(() => usePromptGallery(true), { wrapper });
    await waitFor(() => expect(second.result.current.isLoading).toBe(false));

    expect(second.result.current.items.length).toBe(FILE_COUNT);
    // offlineCount 数的是源，不是文件 —— UI 上那句话说的是「N 个源用的是缓存」。
    expect(second.result.current.offlineCount).toBe(PROMPT_SOURCES.length);
    expect(second.result.current.hasAnySuccess).toBe(true);
    // 有缓存兜着，就不该同时报「源失败了」—— 那会让用户以为没内容可看。
    expect(second.result.current.failures).toEqual([]);
  });

  it("断网且无缓存时如实报失败，不伪造内容", async () => {
    networkUp = false;
    const { result } = renderHook(() => usePromptGallery(true), { wrapper });

    // 等 failures 而不是 isLoading：每个源还要各走一次重试，等状态机自己收敛。
    await waitFor(
      () =>
        expect(result.current.failures.length).toBe(PROMPT_SOURCES.length),
      { timeout: 10000 },
    );

    expect(result.current.items).toEqual([]);
    expect(result.current.hasAnySuccess).toBe(false);
    expect(result.current.offlineCount).toBe(0);
  });

  it("enabled=false 时一个请求都不发", async () => {
    renderHook(() => usePromptGallery(false), { wrapper });

    // 给足时间让「本该发出的请求」暴露出来
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(cacheStore.size).toBe(0);
  });
});

describe("usePromptGallery 重开画廊", () => {
  /**
   * 用户看到的现象：每次点开提示词画廊都先闪一下「正在拉取提示词源…」。
   *
   * 这一组用**同一个 QueryClient** 跨两次挂载 —— 这正是「关掉弹窗再点开」的形状。
   * 上面那组每个用例都新建 client，反而把这个 bug 遮住了。
   */
  function sharedClient() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 1 } },
    });
    return function Shared({ children }: { children: ReactNode }) {
      return createElement(QueryClientProvider, { client }, children);
    };
  }

  it("第二次打开不该重新进入加载态", async () => {
    const wrapper = sharedClient();

    const first = renderHook(() => usePromptGallery(true), { wrapper });
    await waitFor(() => expect(first.result.current.isLoading).toBe(false), {
      timeout: 10000,
    });
    const loadedCount = first.result.current.items.length;
    expect(loadedCount).toBe(FILE_COUNT);
    first.unmount();

    // 关掉再点开：同一个 client，数据还在内存里
    const second = renderHook(() => usePromptGallery(true), { wrapper });
    expect(second.result.current.isLoading).toBe(false);
    expect(second.result.current.items.length).toBe(loadedCount);
  });

  it("第二次打开不该重新发请求", async () => {
    const wrapper = sharedClient();

    const first = renderHook(() => usePromptGallery(true), { wrapper });
    await waitFor(() => expect(first.result.current.isLoading).toBe(false), {
      timeout: 10000,
    });
    const callsAfterFirst = vi.mocked(fetch).mock.calls.length;
    first.unmount();

    const second = renderHook(() => usePromptGallery(true), { wrapper });
    await waitFor(() => expect(second.result.current.isLoading).toBe(false));
    // 给足时间让「本该发出的重复请求」暴露出来
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(vi.mocked(fetch).mock.calls.length).toBe(callsAfterFirst);
  });

  it("有源一直拉不到时，重开画廊仍然不该进入加载态", async () => {
    // 上游挂掉一个源是常态（仓被删、raw 被墙、文件改名）。这个源永远拿不到数据，
    // 但它不该让整面墙每次打开都退回「正在拉取」。
    const wrapper = sharedClient();
    deadUrls.add(PROMPT_SOURCES[0].urls[0]);

    const first = renderHook(() => usePromptGallery(true), { wrapper });
    await waitFor(
      () => expect(first.result.current.failures.length).toBe(1),
      { timeout: 10000 },
    );
    // 其余源照常出内容
    expect(first.result.current.items.length).toBe(FILE_COUNT - 1);
    first.unmount();

    const second = renderHook(() => usePromptGallery(true), { wrapper });
    // 这一行就是用户看到的现象：失败源在重开时重新进入 pending，
    // 「任意一个 pending 就算 isLoading」于是整面墙又变成「正在拉取」。
    expect(second.result.current.isLoading).toBe(false);
    expect(second.result.current.items.length).toBe(FILE_COUNT - 1);
  });

  it("刷新页面后（全新 QueryClient）该先用磁盘缓存出内容", async () => {
    // 第一轮：联网跑一次，把内容写进磁盘缓存。
    const first = renderHook(() => usePromptGallery(true), { wrapper: sharedClient() });
    await waitFor(() => expect(first.result.current.isLoading).toBe(false), {
      timeout: 10000,
    });
    expect(first.result.current.items.length).toBe(FILE_COUNT);
    first.unmount();

    // 第二轮：全新 QueryClient（≈ 刷新页面，内存缓存全没了）+ 网络卡住不返回。
    // 这正是用户报的现象：刷新一次就要重新拉几 MB，期间只能干等。
    networkHangs = true;
    const second = renderHook(() => usePromptGallery(true), {
      wrapper: sharedClient(),
    });

    await waitFor(() =>
      expect(second.result.current.items.length).toBe(FILE_COUNT),
    );
    expect(second.result.current.isLoading).toBe(false);
  });
});
