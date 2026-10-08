// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

import { useMutation } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { jsonWithBackendError } from '@/lib/api-errors';
import { p } from '@/lib/api-path';

export interface PromptGallerySearchRequest {
  query: string;
  media_kind?: 'image' | 'video' | '';
}

export interface PromptGallerySearchResult {
  terms: string[];
  tags: string[];
  strategy: 'ai' | 'fallback' | 'empty' | string;
}

/** 将自然语言交给后端解析，候选提示词正文不随请求发送。 */
export function usePromptGalleryAiSearch() {
  return useMutation({
    mutationFn: async (params: PromptGallerySearchRequest) => {
      const response = await jsonWithBackendError<{
        ok: boolean;
        data?: PromptGallerySearchResult;
        error?: string;
      }>(
        api.post(p`api/v1/prompt-gallery/ai-search`, {
          json: params,
          timeout: 120_000,
          throwHttpErrors: false,
        }),
      );
      if (!response.ok || !response.data) {
        throw new Error(response.error || 'AI prompt search failed');
      }
      return response.data;
    },
  });
}
