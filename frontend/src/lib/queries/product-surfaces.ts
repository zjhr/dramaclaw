// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import type { OkResponse } from "@/types/api";

export type ProductSurfaceCode =
  | "mainline"
  | "freezone"
  | "assistant"
  | "freezone_assistant"
  | "payment";

export interface ProductSurfaceAccess {
  surface_code: ProductSurfaceCode;
  label: string;
  available: boolean;
  unavailable_message: string;
}

export function useProductSurfaces(enabled = true) {
  return useQuery({
    queryKey: queryKeys.productSurfaces(),
    queryFn: ({ signal }) =>
      api
        .get("api/v1/product-surfaces/me", { signal, retry: 0 })
        .json<OkResponse<{ items: ProductSurfaceAccess[] }>>(),
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    // 瞬时失败(窗口聚焦重取被取消/网络抖动)不要立刻锁面板：允许几次重试，
    // 且已有上次成功状态时保留旧值（门禁改为 error && !data 才拦截）。
    retry: 2,
  });
}

export function surfaceAccess(
  data: OkResponse<{ items: ProductSurfaceAccess[] }> | undefined,
  surfaceCode: ProductSurfaceCode,
): ProductSurfaceAccess | undefined {
  return data?.data.items.find((item) => item.surface_code === surfaceCode);
}
