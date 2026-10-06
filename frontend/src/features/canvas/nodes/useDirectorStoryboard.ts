// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { CANVAS_NODE_TYPES, type CanvasNode, type DirectorDeskNodeData } from '../domain/canvasNodes';
import { localizeNodeDisplayName } from '../domain/nodeDisplay';
import { prepareDirectorReferenceImage } from '../application/directorReferenceImage';
import {
  DIRECTOR_PROJECT_STORYBOARD_SOURCE, directorStoryboardSources, resolveDirectorStoryboardSource,
} from '../application/directorStoryboardSources';
import { readUrl } from '@/lib/url-params';
import type { DirectorDeskStoryboardPayload, DirectorDeskStoryboardSource } from './directorDeskBridge';
import {
  fetchDirectorDeskCanvasStoryboard, fetchDirectorDeskStoryboard, type DirectorDeskStoryboard,
} from './directorDeskV2Session';

/** 分镜读取与来源选择共用一个状态源，避免面板选中态、节点存档和模型输入分叉。 */
export function useDirectorStoryboard(
  id: string, data: DirectorDeskNodeData, upstream: CanvasNode[],
  update: (nodeId: string, patch: Partial<DirectorDeskNodeData>) => void, t: TFunction,
) {
  const sources = useMemo(() => directorStoryboardSources(upstream), [upstream]);
  const sourceCards: DirectorDeskStoryboardSource[] = sources.map(source => ({
    id: source.id,
    label: localizeNodeDisplayName(source.node.type!, source.node.data, t)
      + (source.kind === 'beat' ? ` · EP${source.episode} #${source.beat}` : ''),
    kind: source.kind === 'beat' ? 'shot' : source.node.type === CANVAS_NODE_TYPES.textAnnotation ? 'text'
      : source.node.type === CANVAS_NODE_TYPES.script ? 'script' : source.beats.some(beat => Boolean(beat.reference_image_url)) ? 'image' : 'storyboard',
    previewImageUrl: typeof source.beats[0]?.reference_image_url === 'string' ? source.beats[0].reference_image_url : undefined,
    itemCount: source.beats.length,
    detail: source.kind === 'beat' ? `第 ${source.episode} 集 · 第 ${source.beat} 镜` : undefined,
  }));
  const labels = sourceCards.map(({ id, label }) => ({ id, label }));
  if (readUrl().project) {
    sourceCards.push({
      id: DIRECTOR_PROJECT_STORYBOARD_SOURCE,
      label: t('node.directorDesk.storyboardProjectSource'),
      kind: 'project',
      detail: t('node.directorDesk.storyboardProjectSourceDetail'),
    });
    labels.push({ id: DIRECTOR_PROJECT_STORYBOARD_SOURCE, label: t('node.directorDesk.storyboardProjectSource') });
  }
  const resolved = resolveDirectorStoryboardSource(sources, data.storyboardSourceId);
  const sourceId = resolved?.id ?? (data.storyboardSourceId === DIRECTOR_PROJECT_STORYBOARD_SOURCE ? data.storyboardSourceId : null);
  const input = useRef({ data, sources, labels, sourceCards, sourceId });
  input.current = { data, sources, labels, sourceCards, sourceId };
  const current = useRef<DirectorDeskStoryboard | null>(null);
  const contextRef = useRef('');
  const error = useRef<string | null>(null);
  const loadedSource = useRef<string | null>(null);
  const loadedSignature = useRef('');
  const loading = useRef(false);
  const request = useRef<{ generation: number; controller?: AbortController; promise?: Promise<DirectorDeskStoryboard | null> }>({ generation: 0 });
  const [version, setVersion] = useState(0);
  const changed = useCallback(() => setVersion(value => value + 1), []);

  const get = useCallback((): DirectorDeskStoryboardPayload => {
    const latest = input.current, story = current.current;
    const selectedId = loadedSource.current ?? latest.sourceId;
    const disconnected = latest.data.storyboardSourceId && latest.data.storyboardSourceId !== DIRECTOR_PROJECT_STORYBOARD_SOURCE && !latest.sourceId;
    let hint = '';
    if (!story?.beats.length && !error.current) {
      hint = loading.current ? t('node.directorDesk.storyboardLoading')
        : disconnected ? t('node.directorDesk.storyboardSourceDisconnected')
        : !selectedId ? t(latest.sources.length > 1 ? 'node.directorDesk.storyboardChooseSource' : 'node.directorDesk.storyboardConnectSource')
        : t('node.directorDesk.storyboardEmptyHint');
    }
    return {
      sources: latest.sourceCards, sourceId: selectedId,
      sourceLabel: latest.labels.find(label => label.id === selectedId)?.label || '',
      loading: loading.current,
      episodes: story?.episodes ?? [], episode: story?.episode ?? 0,
      shots: story?.beats ?? [], selected: story?.selected ?? null,
      hint, error: error.current,
    };
  }, [t]);

  const load = useCallback(async (wanted: string | null, selection: { episode?: number; beat?: number } = {}) => {
    const generation = ++request.current.generation;
    request.current.controller?.abort();
    const controller = new AbortController(); request.current.controller = controller;
    const latest = input.current;
    const source = latest.sources.find(candidate => candidate.id === wanted);
    // 换来源、更新素材与断线都立即撤掉旧输入，不能等待较慢的旧请求结束才撤。
    contextRef.current = ''; error.current = null;
    loadedSource.current = wanted;
    current.current = null;
    if (!wanted) { loading.current = false; changed(); return null; }
    if (!source && wanted !== DIRECTOR_PROJECT_STORYBOARD_SOURCE) throw new Error(t('node.directorDesk.storyboardSourceDisconnected'));
    loading.current = true; changed();
    try {
      const sourceName = latest.labels.find(label => label.id === wanted)?.label || '';
      let pending: Promise<DirectorDeskStoryboard | null>;
      if (source?.kind === 'canvas') {
        const remembered = latest.data.storyboardSourceId === wanted ? latest.data.storyboardBeat ?? undefined : undefined;
        const beat = selection.beat ?? (source.beats.some(row => row.beat_number === remembered) ? remembered : undefined);
        pending = fetchDirectorDeskCanvasStoryboard(sourceName, source.beats, { beat, signal: controller.signal });
      } else {
        const project = source?.project ?? readUrl().project;
        if (!project) throw new Error(t('node.directorDesk.storyboardSourceDisconnected'));
        const remembered = latest.data.storyboardSourceId === wanted;
        pending = fetchDirectorDeskStoryboard(project, {
          episode: source?.episode ?? selection.episode ?? (remembered && latest.data.storyboardEpisode ? latest.data.storyboardEpisode : undefined),
          beat: source?.beat ?? selection.beat ?? (remembered ? latest.data.storyboardBeat ?? undefined : undefined),
          ...(source?.kind === 'beat' ? { beatNumbers: [source.beat!] } : {}),
          sourceName, signal: controller.signal,
        });
      }
      request.current.promise = pending;
      const story = await pending;
      if (generation !== request.current.generation || controller.signal.aborted) throw new DOMException('来源已改变', 'AbortError');
      if (!story) throw new Error('宿主没有返回分镜资料');
      if (selection.beat !== undefined && story.selected !== selection.beat) throw new Error('分镜选择未生效');
      current.current = story; contextRef.current = story.context;
      loadedSignature.current = source
        ? JSON.stringify([source.id, source.kind, source.project, source.episode, source.beat, source.beats, sourceName])
        : JSON.stringify([wanted, wanted]);
      // 只在真实加载成功后记住来源和镜头；失败回包不能把节点选中状态改成另一条。
      update(id, { storyboardSourceId: wanted, storyboardEpisode: story.episode, storyboardBeat: story.selected });
      return story;
    } catch (failure) {
      if (generation === request.current.generation && !controller.signal.aborted) {
        error.current = failure instanceof Error ? failure.message : String(failure);
      }
      throw failure;
    } finally {
      if (generation === request.current.generation) { loading.current = false; changed(); }
    }
  }, [changed, id, t, update]);

  // 只订阅当前来源实际输出。拖动其他节点、保存导演台封面都不会重复拉分镜。
  const signature = JSON.stringify(resolved
    ? [resolved.id, resolved.kind, resolved.project, resolved.episode, resolved.beat, resolved.beats, labels.find(label => label.id === resolved.id)?.label]
    : [sourceId, data.storyboardSourceId]);
  useEffect(() => {
    if (data.isOpen) {
      if (current.current && loadedSignature.current === signature) return undefined;
      void load(input.current.sourceId).catch(() => undefined);
    }
    else {
      request.current.generation += 1; request.current.controller?.abort();
      current.current = null; contextRef.current = ''; loadedSource.current = null; loading.current = false; error.current = null;
    }
    return () => { request.current.generation += 1; request.current.controller?.abort(); };
    // 镜头切换走显式 select，不因写回 storyboardBeat 再重复拉一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.isOpen, signature, load]);

  const select = useCallback(async (episode: number, beat: number) => {
    const latest = input.current, wanted = loadedSource.current ?? latest.sourceId;
    if (!wanted || loading.current) throw new Error('请先选择并加载分镜来源');
    const story = current.current;
    if (!story || (story.episode === episode && !story.beats.some(row => row.beat_number === beat)) || (story.episode !== episode && wanted !== DIRECTOR_PROJECT_STORYBOARD_SOURCE)) {
      throw new Error('该镜头不在当前关联来源中');
    }
    const previous = story;
    try { await load(wanted, { episode, beat }); }
    catch (failure) {
      // 同来源选镜失败保留上一个已证实的选中态，模型仍须等待错误解决后才能发送。
      if (loadedSource.current === wanted) { current.current = previous; changed(); }
      throw failure;
    }
    return get();
  }, [changed, get, load]);
  const selectSource = useCallback(async (wanted: string | null) => {
    if (wanted && !input.current.labels.some(label => label.id === wanted)) throw new Error('分镜来源已断开，请重新连接');
    await load(wanted);
    if (!wanted) update(id, { storyboardSourceId: null, storyboardEpisode: null, storyboardBeat: null });
    return get();
  }, [get, id, load, update]);
  const contextForRun = useCallback(async () => {
    // 来源正在读取时，发送必须等它结算；不能抢先用空输入或上一来源启动模型。
    while (loading.current && request.current.promise) {
      const generation = request.current.generation;
      try { await request.current.promise; }
      catch (failure) { if (generation === request.current.generation) throw failure; }
      if (generation === request.current.generation) break;
    }
    if (error.current) throw new Error(`分镜来源读取失败：${error.current}`);
    return contextRef.current;
  }, []);
  /** 将所选图片作为真正的图像输入发送；处理期间换来源或关窗则取消本轮发送。 */
  const inputForRun = useCallback(async () => {
    const generation = request.current.generation;
    const context = await contextForRun();
    // 等文字的微任务本身也可能发生来源切换，不能只保护后续较慢的图片读取。
    if (generation !== request.current.generation) throw new Error('参考画面已改变，请确认当前来源后重新发送');
    const story = current.current;
    const selected = story?.beats.find(beat => beat.beat_number === story.selected);
    const images = selected?.reference_image_url
      ? [await prepareDirectorReferenceImage(selected.reference_image_url)] : [];
    if (generation !== request.current.generation || story !== current.current) {
      throw new Error('参考画面已改变，请确认当前来源后重新发送');
    }
    return { context, images };
  }, [contextForRun]);
  return { contextRef, contextForRun, inputForRun, get, select, selectSource, version, sourceOptionsKey: JSON.stringify(sourceCards) };
}
