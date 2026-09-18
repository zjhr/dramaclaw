// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

import type { MediaModelEntry } from '@/stores/settingsStore';

/**
 * 媒体模型表里的「虚拟 provider」注册表。
 *
 * ElevenLabs 曾在此列（当时它只落映射、不建 NewAPI 渠道）。自 2026-09 起它有了
 * 专属网关适配器（ChannelTypeElevenLabs / type 65），与 senseaudio 一样是**真实
 * 渠道**，因此不再需要这里的特殊处理——留空表示当前没有虚拟 provider。
 *
 * 保留这套机制是因为"只落映射不推渠道"仍是合法需求（例如尚未在网关实现适配器
 * 的上游）；新增时把 provider 名与模型名登记在这里即可。
 */
export const VIRTUAL_MEDIA_MODEL_PROVIDERS: Readonly<Record<string, string>> = {};

/** 是否是该虚拟 provider（用于保存放行与密钥校验豁免）。 */
export function isVirtualMediaProvider(provider: string): boolean {
  return Object.values(VIRTUAL_MEDIA_MODEL_PROVIDERS).includes(provider);
}

/**
 * 给虚拟 provider 的模型补上默认条目，让它们能带着 provider 出现在媒体模型表里
 * 并被保存。已有 provider 的条目一律不动——虚拟 provider 只是默认值，用户可以
 * 改指向别的渠道。
 */
export function withVirtualMediaDefaults(
  entries: Record<string, MediaModelEntry>,
): Record<string, MediaModelEntry> {
  const next = { ...entries };
  for (const [model, provider] of Object.entries(VIRTUAL_MEDIA_MODEL_PROVIDERS)) {
    if (next[model]?.provider) continue;
    next[model] = {
      provider,
      upstreamModel: '',
      mediaType: 'audio',
      enabled: true,
      sortOrder: 100,
      config: {},
    };
  }
  return next;
}
