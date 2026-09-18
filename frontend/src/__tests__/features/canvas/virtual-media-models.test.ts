// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

import { describe, expect, it } from 'vitest';

import {
  isVirtualMediaProvider,
  VIRTUAL_MEDIA_MODEL_PROVIDERS,
  withVirtualMediaDefaults,
} from '@/features/canvas/domain/virtualMediaModels';

const EXISTING = {
  'LingShan-MU-11': {
    provider: 'stepfun',
    upstreamModel: '',
    mediaType: 'audio' as const,
    enabled: true,
    sortOrder: 100,
    config: {},
  },
};

describe('媒体模型的虚拟 provider 注册表', () => {
  it('当前没有虚拟 provider —— ElevenLabs 已是真实网关渠道', () => {
    // 它有了 ChannelTypeElevenLabs 适配器，不再需要"只落映射不推渠道"的待遇。
    expect(Object.keys(VIRTUAL_MEDIA_MODEL_PROVIDERS)).toHaveLength(0);
    expect(isVirtualMediaProvider('elevenlabs')).toBe(false);
  });

  it('没有虚拟 provider 时不注入任何条目', () => {
    const merged = withVirtualMediaDefaults({});
    expect(Object.keys(merged)).toHaveLength(0);
  });

  it('原样保留调用方已有的媒体模型条目', () => {
    const merged = withVirtualMediaDefaults(EXISTING);
    expect(merged).toEqual(EXISTING);
  });
});
