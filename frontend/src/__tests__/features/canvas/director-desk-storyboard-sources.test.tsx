// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { CANVAS_NODE_TYPES, type CanvasNode, type DirectorDeskNodeData } from '@/features/canvas/domain/canvasNodes';
import {
  directorStoryboardSources, resolveDirectorStoryboardSource, DIRECTOR_PROJECT_STORYBOARD_SOURCE,
} from '@/features/canvas/application/directorStoryboardSources';
import { useDirectorStoryboard } from '@/features/canvas/nodes/useDirectorStoryboard';
import { withStoryboardContext } from '@/features/canvas/nodes/directorDeskV2Session';

vi.mock('@/lib/url-params', () => ({ readUrl: () => ({ project: 'project-1' }) }));
const prepareImage = vi.hoisted(() => vi.fn<(source: string) => Promise<string>>());
vi.mock('@/features/canvas/application/directorReferenceImage', () => ({ prepareDirectorReferenceImage: prepareImage }));
const node = (id: string, type: CanvasNode['type'], data: Record<string, unknown>): CanvasNode =>
  ({ id, type, position: { x: 0, y: 0 }, data } as CanvasNode);
const textNode = (id: string, content: string) => node(id, CANVAS_NODE_TYPES.textAnnotation, { content, displayName: id });
const blank: DirectorDeskNodeData = { isOpen: true, directorProjectRef: null, videoUrl: null, previewImageUrl: null };
const t = ((key: string) => key) as TFunction;
const ignoreUpdate = () => undefined;
const shot = (number: number, synopsis: string) => ({ beat_number: number, scene: '咖啡馆', duration_seconds: 8, speaker: '', synopsis, spoken_text: '' });
const response = (selected = 1, synopsis = '已关联', episode = 0) => new Response(JSON.stringify({
  ok: true, data: { episodes: episode ? [episode] : [], episode, beats: [shot(selected, synopsis)], selected, context: synopsis + '的模型输入' },
}), { status: 200 });
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  fetcher.mockReset(); prepareImage.mockReset();
  prepareImage.mockResolvedValue('data:image/jpeg;base64,current-picture');
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('画布分镜来源投影', () => {
  it.each([CANVAS_NODE_TYPES.upload, CANVAS_NODE_TYPES.imageGen, CANVAS_NODE_TYPES.imageEdit, CANVAS_NODE_TYPES.exportImage])(
    '%s 的主图可作为参考画面，不拿生成提示词推断画面或时长', type => {
      const source = directorStoryboardSources([node('picture', type, {
        imageUrl: '/main.png', previewImageUrl: '/preview.png', prompt: '预期画面不是实际结果', description: '人物站在门边',
      })])[0];
      expect(source.beats).toEqual([{
        beat_number: 1, reference_image_url: '/main.png', visual_description: '人物站在门边', audio_type: 'silence', duration_seconds: 0,
      }]);
      expect(JSON.stringify(source.beats)).not.toContain('预期画面');
      expect(directorStoryboardSources([node('empty', type, { prompt: '还没有图片' })])).toEqual([]);
    },
  );

  it('生成图片取当前主图，预览和参考图逐级回落，图库不自动全发', () => {
    const pick = (data: Record<string, unknown>) => directorStoryboardSources([node('gen', CANVAS_NODE_TYPES.imageGen, data)])[0].beats[0].reference_image_url;
    expect(pick({ imageUrl: '/main.png', images: ['/other.png'], previewImageUrl: '/preview.png', referenceImageUrl: '/ref.png' })).toBe('/main.png');
    expect(pick({ previewImageUrl: '/preview.png', referenceImageUrl: '/ref.png' })).toBe('/preview.png');
    expect(pick({ referenceImageUrl: '/ref.png' })).toBe('/ref.png');
  });

  it('脚本的参考占位文字不是图片，不能让有文字的来源卡在读取图片', () => {
    const source = directorStoryboardSources([node('script', CANVAS_NODE_TYPES.script, {
      scriptResult: { rows: [{ visual_description: '人物推门', reference: '无' }] },
    })])[0];
    expect(source.beats[0].reference_image_url).toBe('');
  });

  it('镜头上下文只关联明确的project/episode/beat，不把当前项目整集自动当作输入', () => {
    const source = node('beat', CANVAS_NODE_TYPES.beatContext, { projectId: 'other-project', episode: 3, beat: 9 });
    expect(directorStoryboardSources([source, source])).toMatchObject([
      { id: 'beat', kind: 'beat', project: 'other-project', episode: 3, beat: 9, beats: [] },
    ]);
    expect(resolveDirectorStoryboardSource([], undefined)).toBeNull();
    const choices = directorStoryboardSources([source, textNode('text', '另一份素材')]);
    expect(resolveDirectorStoryboardSource(choices, undefined)).toBeNull();
    expect(resolveDirectorStoryboardSource(choices, 'beat')?.id).toBe('beat');
    expect(resolveDirectorStoryboardSource(choices.slice(1), 'beat')).toBeNull();
  });

  it('脚本取真实输出rows并保留动作、人物、台词和时长，不消费生成输入prompt', () => {
    const source = node('script', CANVAS_NODE_TYPES.script, {
      prompt: '不要把这段输入当成分镜', scriptResult: { rows: [
        { shot_no: 4, duration: '8.2s', visual_description: '她推门进来', character_1: '林晚', character_action: '拿起杯子', dialogue: '你好', video_motion_prompt: '镜头推近' },
      ] },
    });
    const beats = directorStoryboardSources([source])[0].beats;
    expect(beats[0]).toMatchObject({ beat_number: 4, duration_seconds: 8.2, narration_segment: '你好', detected_identities: ['林晚'], video_prompt: '镜头推近' });
    expect(beats[0].visual_description).toContain('拿起杯子');
    expect(JSON.stringify(beats)).not.toContain('不要把这段输入');
    expect(directorStoryboardSources([node('empty', CANVAS_NODE_TYPES.script, { prompt: '只有输入' })])).toEqual([]);
  });

  it('分格按上游order取note，文本未填时长保持未知，不猜拆分多镜头', () => {
    const sources = directorStoryboardSources([
      node('split', CANVAS_NODE_TYPES.storyboardSplit, { frames: [{ order: 2, note: '她坐下' }, { order: 1, note: '她推门' }] }),
      textNode('text', '她推門\n随后坐下'),
    ]);
    expect(sources[0].beats.map(beat => beat.visual_description)).toEqual(['她推门', '她坐下']);
    expect(sources[1].beats).toMatchObject([{ beat_number: 1, duration_seconds: 0 }]);
    expect(sources[1].beats).toHaveLength(1);
  });
});

/** 测试两张实际关联画面的选择，不借项目目录构造来源。 */
const splitWithImages = node('split-images', CANVAS_NODE_TYPES.storyboardSplit, {
  frames: [{ order: 1, imageUrl: '/first.png' }, { order: 2, imageUrl: '/second.png' }],
});
const imageResponse = (selected = 1) => new Response(JSON.stringify({ ok: true, data: {
  episode: 0, episodes: [], selected, context: `第${selected}张图的文字输入`,
  beats: [1, 2].map(number => ({ ...shot(number, `图${number}`), reference_image_url: number === 1 ? '/first.png' : '/second.png' })),
} }));

describe('当前参考画面真正进入模型输入', () => {
  it('只读取选中的分格图片，换成文字后清除旧图，prompt保持原话', async () => {
    fetcher.mockImplementation((_url, init) => {
      const body = JSON.parse(init!.body as string);
      return Promise.resolve(body.beats?.[0].reference_image_url ? imageResponse(body.beat || 1) : response(1, '纯文字'));
    });
    const { result } = renderHook(() => useDirectorStoryboard('desk', blank, [splitWithImages, textNode('text', '纯文字')], ignoreUpdate, t));
    await act(async () => { await result.current.selectSource('split-images'); await result.current.select(0, 2); });
    const input = await result.current.inputForRun();
    expect(prepareImage).toHaveBeenCalledExactlyOnceWith('/second.png');
    const payload = withStoryboardContext({ prompt: '按照这张图摆场景' }, input.context, input.images);
    expect(payload).toEqual({ prompt: '按照这张图摆场景', context: '第2张图的文字输入', images: ['data:image/jpeg;base64,current-picture'] });
    await act(async () => { await result.current.selectSource('text'); });
    expect(await result.current.inputForRun()).toEqual({ context: '纯文字的模型输入', images: [] });
    expect(prepareImage).toHaveBeenCalledTimes(1);
  });

  it('图片读取失败则拒绝本轮输入，不悄悄降成仅发链接的请求', async () => {
    fetcher.mockResolvedValue(imageResponse());
    prepareImage.mockRejectedValue(new Error('参考图片读取超时'));
    const { result } = renderHook(() => useDirectorStoryboard('desk', blank, [splitWithImages], ignoreUpdate, t));
    await waitFor(() => expect(result.current.get().selected).toBe(1));
    await expect(result.current.inputForRun()).rejects.toThrow('参考图片读取超时');
  });

  it.each(['disconnect', 'close', 'unmount'])('读取图片期间%s，旧画面不能发送', async action => {
    let finish: (value: string) => void = () => undefined;
    prepareImage.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    fetcher.mockResolvedValue(imageResponse());
    const { result, rerender, unmount } = renderHook(({ data, upstream }) => useDirectorStoryboard('desk', data, upstream, ignoreUpdate, t), {
      initialProps: { data: blank, upstream: [splitWithImages] },
    });
    await waitFor(() => expect(result.current.get().selected).toBe(1));
    const pending = result.current.inputForRun();
    const rejected = expect(pending).rejects.toThrow('参考画面已改变');
    await waitFor(() => expect(prepareImage).toHaveBeenCalledOnce());
    if (action === 'unmount') unmount();
    else rerender({ data: { ...blank, isOpen: action !== 'close' }, upstream: action === 'disconnect' ? [] : [splitWithImages] });
    finish('data:image/jpeg;base64,old-picture');
    await rejected;
  });

  it('等待文字输入的微任务期间换来源，也不能混用旧context与新图', async () => {
    fetcher.mockResolvedValue(imageResponse());
    const { result, rerender } = renderHook(({ upstream }) => useDirectorStoryboard('desk', blank, upstream, ignoreUpdate, t), {
      initialProps: { upstream: [splitWithImages] },
    });
    await waitFor(() => expect(result.current.get().selected).toBe(1));
    const pending = result.current.inputForRun();
    const rejected = expect(pending).rejects.toThrow('参考画面已改变');
    rerender({ upstream: [] });
    await rejected;
    expect(prepareImage).not.toHaveBeenCalled();
  });

  it('断开来源后同时清空旧context与图片，不改用户原话', () => {
    expect(withStoryboardContext({ prompt: '继续', context: '旧来源', images: ['旧图'] }, '', [])).toEqual({ prompt: '继续', context: '', images: [] });
  });
});

describe('来源与模型上下文一致', () => {
  it('新节点无连线时不请求项目分镜；项目目录必须主动选', async () => {
    fetcher.mockResolvedValue(response(1, '主动选择的项目镜头', 2));
    const update = vi.fn();
    const { result } = renderHook(() => useDirectorStoryboard('desk', blank, [], update, t));
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.contextRef.current).toBe('');
    expect(result.current.get().shots).toEqual([]);
    expect(result.current.get().sources).toContainEqual(expect.objectContaining({ id: DIRECTOR_PROJECT_STORYBOARD_SOURCE }));
    await act(async () => { await result.current.selectSource(DIRECTOR_PROJECT_STORYBOARD_SOURCE); });
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/storyboard'), expect.objectContaining({
      body: expect.stringContaining('"project":"project-1"'),
    }));
    expect(result.current.contextRef.current).toContain('主动选择的项目镜头');
    expect(update).toHaveBeenCalledWith('desk', expect.objectContaining({ storyboardSourceId: DIRECTOR_PROJECT_STORYBOARD_SOURCE }));
  });

  it('连接镜头上下文只读该项目的该镜头，断线即撤掉旧上下文', async () => {
    fetcher.mockResolvedValue(response(9, '镜头九', 3));
    const source = node('beat', CANVAS_NODE_TYPES.beatContext, { projectId: 'beat-project', episode: 3, beat: 9 });
    const update = vi.fn();
    const { result, rerender } = renderHook(({ upstream, data }) => useDirectorStoryboard('desk', data, upstream, update, t), {
      initialProps: { upstream: [source], data: blank },
    });
    await waitFor(() => expect(result.current.get().selected).toBe(9));
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({ project: 'beat-project', episode: 3, beat: 9, beatNumbers: [9] });
    rerender({ upstream: [], data: { ...blank, storyboardSourceId: 'beat', storyboardBeat: 9 } });
    expect(result.current.contextRef.current).toBe('');
    expect(result.current.get().shots).toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('上游改内容时重读自己的输出，较晚返回的旧来源不能覆盖新来源', async () => {
    let finishOld: ((value: Response) => void) | undefined;
    const update = vi.fn();
    fetcher.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; })).mockResolvedValue(response(1, '新内容'));
    const { result, rerender } = renderHook(({ source }) => useDirectorStoryboard('desk', blank, [source], update, t), {
      initialProps: { source: textNode('text', '旧内容') },
    });
    rerender({ source: textNode('text', '新内容') });
    await waitFor(() => expect(result.current.contextRef.current).toBe('新内容的模型输入'));
    await act(async () => { finishOld?.(response(1, '旧内容')); });
    expect(result.current.contextRef.current).toBe('新内容的模型输入');
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string).beats[0].visual_description).toBe('新内容');
  });

  it('选择读取失败时不能记录新选中项，也不能伪装成成功', async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { episode: 0, episodes: [], beats: [shot(1, '一'), shot(2, '二')], selected: 1, context: '一的输入' } })))
      .mockResolvedValue(new Response(JSON.stringify({ detail: '读取失败' }), { status: 503 }));
    const update = vi.fn();
    const source = node('split', CANVAS_NODE_TYPES.storyboardSplit, { frames: [{ note: '一' }, { note: '二' }] });
    const { result } = renderHook(() => useDirectorStoryboard('desk', { ...blank, storyboardSourceId: 'split' }, [source], update, t));
    await waitFor(() => expect(result.current.get().selected).toBe(1));
    update.mockClear();
    await act(async () => { await expect(result.current.select(0, 2)).rejects.toThrow('读取失败'); });
    expect(update).not.toHaveBeenCalled();
    expect(result.current.contextRef.current).toBe('');
    expect(result.current.get().error).toBe('读取失败');
  });
});
