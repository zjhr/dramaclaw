// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeAll, describe, expect, it, vi } from 'vitest';

const modules = import.meta.glob('../../../../vendor/director-desk/src/automation/service.ts');
let createToolService: (ctx: unknown) => { call: (name: string, args: unknown) => Promise<unknown> };
beforeAll(async () => {
  const service = await modules['../../../../vendor/director-desk/src/automation/service.ts']() as {
    createToolService: typeof createToolService;
  };
  createToolService = service.createToolService;
});

/** 运行真实工具服务；只替换最终的工程上传边界。 */
async function toolService(saveProject: () => Promise<boolean>) {
  return createToolService({
    saveProject, revision: 1, scenes: { context: {} },
    busy: false, draft: null, history: { pending: null }, engine: { exporting: false },
  });
}

describe('工程保存的完成回执', () => {
  it('上传尚未完成时不能返回保存成功', async () => {
    let finish!: (saved: boolean) => void;
    const save = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const service = await toolService(save);
    let finished = false;
    const task = service.call('director_export', { kind: 'project' }).then(result => {
      finished = true;
      return result;
    });
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    finish(true);
    expect(await task).toMatchObject({ ok: true, data: { saved: true } });
  });

  it('编辑器拒绝保存时应返回失败，让宿主保留弹窗和未保存状态', async () => {
    const service = await toolService(async () => false);
    expect(await service.call('director_export', { kind: 'project' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/保存/),
    });
  });
});
