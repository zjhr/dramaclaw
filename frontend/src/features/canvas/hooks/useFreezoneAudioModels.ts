// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from "react";

import { fetchFreezoneAudioModels, type FreezoneImageModelInfo } from "@/api/ops";
import { readUrl } from "@/lib/url-params";

/**
 * 画布音频节点的可选模型。
 *
 * 比图片版轻得多：音频节点数量少、切换不频繁，没必要上 `useSyncExternalStore`
 * 那套模块级去重。加载失败时返回空列表——调用方应当退回"用后端默认模型"，
 * 而不是让节点无法使用：没配媒体模型映射是完全正常的状态。
 */
export function useFreezoneAudioModels() {
  const [models, setModels] = useState<FreezoneImageModelInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const project = readUrl().project;
    if (!project) return;
    let cancelled = false;
    setIsLoading(true);
    fetchFreezoneAudioModels(project)
      .then((items) => {
        if (!cancelled) setModels(items);
      })
      .catch((error) => {
        console.warn("[audio-models] load failed", error);
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { models, isLoading };
}
