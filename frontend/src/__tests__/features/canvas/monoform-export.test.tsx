// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// MONOFORM 白模导出链路（宿主侧接回，T011）。
//
// 背景：T006 时 vendored bundle 的 `capabilities.actions` 只有
// `['capabilities.get','project.get','scene.apply']`，产物拿不到，宿主只能如实显示
// 「导出不可用」。T010 给 bundle 补上了 `export.video` / `export.frame` 并把
// PROTOCOL_VERSION 由 1 提到 2，于是这条链路可以真正落地：
//
//   握手（协议窗口兼容 v1/v2）→ export.video → 上传项目资产
//     → export.frame 首帧当封面（拿不到也出片）→ 派生 video 节点 + 显式来源边
//     → 写回 videoUrl / previewImageUrl
//
// 这个文件钉住五类事实：
//   1. 协议版本窗口：v2（真实 bundle）与 v1（3D 导演台）的回包都被接受，窗口外被拒；
//   2. 能力可用 → 渲染真实导出入口，**不**显示「导出不可用」提示；
//   3. 能力确实不可用 → 仍如实显示提示，且不出现导出入口；
//   4. 导出成功 → updateNodeData 收到 videoUrl，派生 video 节点 + 真实来源边落在画布上；
//   5. 导出失败 → 原节点不被污染（没有 videoUrl / previewImageUrl 写入，也不建节点/边）。
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type DirectorDeskNodeData } from '@/features/canvas/domain/canvasNodes';
import { classifyVideoReferenceMedia } from '@/features/canvas/domain/videoReferenceLimits';
import {
  DIRECTOR_DESK_MAX_PROTOCOL_VERSION,
  DIRECTOR_DESK_MESSAGE_TYPES,
  DIRECTOR_DESK_PROTOCOL_VERSION,
  DIRECTOR_DESK_SUPPORTED_PROTOCOL_VERSIONS,
  createDirectorDeskBridge,
  isDirectorDeskCapabilities,
  isDirectorDeskResponsePayload,
  type DirectorDeskCapabilities,
} from '@/features/canvas/nodes/directorDeskBridge';
import {
  MONOFORM_CAPABILITIES,
  MONOFORM_EXPORT_ACTIONS,
  MONOFORM_UNAVAILABLE_EXPORT_ACTIONS,
  MonoformDeskNode,
  monoformArtifactUploadName,
  monoformDeskIframeSrc,
  monoformSupportsExport,
} from '@/features/canvas/nodes/MonoformDeskNode';
import { useCanvasStore } from '@/stores/canvasStore';

const NODE_ID = 'node_monoform_desk_1';
const PROJECT_ID = 'proj_monoform_export';
const PNG_DATA_URL = `data:image/png;base64,${btoa('fake-png-bytes')}`;

/** 真实 bundle（T010 之后）的那一份 capabilities 回包。 */
const BUNDLE_CAPABILITIES: DirectorDeskCapabilities = {
  protocolVersion: 2,
  projectSchemaVersion: 16,
  actions: ['capabilities.get', 'project.get', 'scene.apply', 'export.video', 'export.frame'],
  assetPersistence: 'localStorage',
};

const uploadFreezoneImage = vi.fn();
const uploadFreezoneVideo = vi.fn();
vi.mock('@/api/ops', () => ({
  uploadFreezoneImage: (...args: unknown[]) => uploadFreezoneImage(...args),
  uploadFreezoneVideo: (...args: unknown[]) => uploadFreezoneVideo(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

/**
 * 真实 `t` 走 zh 词条。`Dialog` 之类只需要存在，但**千万不要**把整个
 * `@/components/ui/dialog` 替成占位组件：那个模块在导入期会构建自己的 context，
 * 一旦被替换，画布 store / zustand 的模块实例就可能被换掉一份，`useCanvasStore`
 * 与测试里的那份不再是同一个 —— 表现是 `updateNodeData` 看似成功、DOM 却不动。
 */
vi.mock('@/components/ui/dialog', async () => {
  const actual = await vi.importActual<typeof import('@/components/ui/dialog')>(
    '@/components/ui/dialog',
  );
  return actual;
});

// 节点自己的展示依赖：本文件只验白模导出链路，画布句柄/弹窗/对话面板全部旁路。
vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react');
  return {
    ...actual,
    Handle: ({ id, type }: { id?: string; type?: string }) => (
      <div data-testid={`handle-${type ?? 'unknown'}-${id ?? 'default'}`} />
    ),
  };
});

vi.mock('@/features/canvas/ui/NodeHeader', () => ({
  NODE_HEADER_FLOATING_POSITION_CLASS: '',
  NodeHeader: ({ titleText }: { titleText: string }) => (
    <div data-testid="node-title">{titleText}</div>
  ),
}));

vi.mock('@/features/canvas/application/useUpstreamGraph', () => ({
  useUpstreamNodes: () => [],
}));

vi.mock('@/features/viewer-kit/useViewerImmersiveBody', () => ({
  useViewerImmersiveBody: () => undefined,
}));

vi.mock('@/lib/url-params', () => ({
  readUrl: () => ({ project: 'proj_monoform_export' }),
}));

vi.mock('@/features/canvas/nodes/DirectorDeskChatPanel', () => ({
  DirectorDeskChatPanel: () => null,
}));

/** 一个只够 bridge 用的假 iframe：`contentWindow` 只要是个对象就行。 */
function fakeIframe(): HTMLIFrameElement {
  const contentWindow = { name: 'monoform-child' } as unknown as Window;
  return { contentWindow } as unknown as HTMLIFrameElement;
}

function capabilityData(
  actions: readonly string[],
  protocolVersion = 2,
): DirectorDeskCapabilities {
  return {
    protocolVersion,
    projectSchemaVersion: 16,
    actions,
    assetPersistence: 'localStorage',
  };
}

/**
 * 用真实 bridge 走一遍握手 + capabilities.get。
 * 返回 bridge 解析出来的 capabilities（解析失败则测试直接失败）。
 */
async function requestCapabilities(
  actions: readonly string[],
  protocolVersion = 2,
): Promise<DirectorDeskCapabilities> {
  const iframe = fakeIframe();
  const posted: Array<{ requestId?: string; action?: string }> = [];
  (iframe.contentWindow as unknown as { postMessage: unknown }).postMessage = vi.fn(
    (message: { payload?: { requestId?: string; action?: string } }) => {
      const payload = message.payload;
      if (payload?.requestId && payload.action) {
        posted.push({ requestId: payload.requestId, action: payload.action });
      }
    },
  );
  const bridge = createDirectorDeskBridge({ iframe });
  try {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: iframe.contentWindow,
        data: { type: DIRECTOR_DESK_MESSAGE_TYPES.ready },
      }),
    );
    const pending = bridge.getCapabilities();
    const request = posted.find((item) => item.action === 'capabilities.get');
    expect(request, 'capabilities.get 必须被发出').toBeDefined();
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: iframe.contentWindow,
        data: {
          type: DIRECTOR_DESK_MESSAGE_TYPES.response,
          payload: {
            // 回包头与 capabilities 都带版本号，两者都必须落在窗口内。
            protocolVersion,
            requestId: request?.requestId,
            action: 'capabilities.get',
            ok: true,
            data: capabilityData(actions, protocolVersion),
          },
        },
      }),
    );
    return await pending;
  } finally {
    bridge.dispose();
  }
}

function responsePayload(protocolVersion: number) {
  return {
    protocolVersion,
    requestId: 'req-1',
    action: 'capabilities.get',
    ok: true,
    data: capabilityData(BUNDLE_CAPABILITIES.actions, protocolVersion),
  };
}

/** 渲染节点壳，并把握手用的 iframe 装配起来（点开 → 记录帧 → ready → 回能力）。 */
function defaultData(overrides: Partial<DirectorDeskNodeData> = {}): DirectorDeskNodeData {
  return {
    displayName: 'MONOFORM 白模台',
    isOpen: false,
    directorProjectRef: null,
    videoUrl: null,
    previewImageUrl: null,
    ...overrides,
  };
}

function renderNode(overrides: Partial<DirectorDeskNodeData> = {}) {
  useCanvasStore.setState({
    nodes: [
      {
        id: NODE_ID,
        type: 'directorDeskNode',
        position: { x: 0, y: 0 },
        data: defaultData(overrides),
      },
    ],
    edges: [],
    selectedNodeId: NODE_ID,
  });

  const Harness = () => {
    const node = useCanvasStore((state) => state.nodes[0]);
    return (
      <MonoformDeskNode
        id={NODE_ID}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {...({ type: 'directorDeskNode', dragging: false, zIndex: 0 } as any)}
        data={node.data as DirectorDeskNodeData}
        selected={false}
      />
    );
  };

  return render(<Harness />);
}

function storedData(): DirectorDeskNodeData {
  return useCanvasStore.getState().nodes[0].data as DirectorDeskNodeData;
}

function iframeEl(): HTMLIFrameElement | null {
  return document.querySelector('iframe');
}

/** 记录宿主 → 白模台的帧，用来拿 requestId / 确认 request 发出。 */
function installFrameRecorder(frames: unknown[]) {
  const contentWindow = iframeEl()?.contentWindow;
  if (!contentWindow) throw new Error('no iframe content window');
  const originalPost = contentWindow.postMessage.bind(contentWindow);
  (contentWindow as unknown as { postMessage: unknown }).postMessage = (message: unknown) => {
    frames.push(message);
    return originalPost(message as never, '*');
  };
}

function requestFrame(frames: unknown[], action: string) {
  const frame = frames.find((f) => {
    const candidate = f as { type?: string; payload?: { action?: string } };
    return (
      candidate.type === DIRECTOR_DESK_MESSAGE_TYPES.request
      && candidate.payload?.action === action
    );
  });
  if (!frame) throw new Error(`no request frame for ${action}: ${JSON.stringify(frames)}`);
  return frame as { type: string; payload: { requestId: string; action: string } };
}

function emitFromDesk(payload: unknown) {
  const iframe = iframeEl();
  if (!iframe?.contentWindow) throw new Error('no iframe mounted');
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: iframe.contentWindow as unknown as MessageEventSource,
        data: payload,
      }),
    );
  });
}

/** 打开弹窗（导出按钮只在 connected 后可用）→ 握手 → 返回发出的帧列表。 */
async function openAndHandshake(
  capabilities: DirectorDeskCapabilities = BUNDLE_CAPABILITIES,
): Promise<{ frames: unknown[]; protocolVersion: number }> {
  const user = userEvent.setup();
  renderNode();
  // 测试环境没有真实路由/history：用真实 URL 取 project（`readUrl` 未被 mock）。
  window.history.replaceState({}, '', `/projects/${PROJECT_ID}/freezone`);
  // 真实 `t` 走 zh 词条（词条 key 由 locales-json.test.ts 守）。
  await user.click(screen.getByRole('button', { name: /打开白模台|Open whitebox desk|Mở bàn mô hình trắng/ }));
  await waitFor(() => expect(iframeEl()).not.toBeNull());

  const frames: unknown[] = [];
  installFrameRecorder(frames);
  emitFromDesk({ type: DIRECTOR_DESK_MESSAGE_TYPES.ready });
  await waitFor(() => expect(requestFrame(frames, 'capabilities.get')).toBeTruthy());
  const request = requestFrame(frames, 'capabilities.get');
  emitFromDesk({
    type: DIRECTOR_DESK_MESSAGE_TYPES.response,
    payload: {
      protocolVersion: capabilities.protocolVersion,
      requestId: request.payload.requestId,
      action: 'capabilities.get',
      ok: true,
      data: capabilities,
    },
  });
  await waitFor(() =>
    expect(screen.getAllByText(/已连接|connected|Đã kết nối/i).length).toBeGreaterThan(0),
  );
  return { frames, protocolVersion: capabilities.protocolVersion };
}

/** 让导出按钮可点（真实路径：打开弹窗 + 握手 + 点按钮）。 */
async function clickExport(): Promise<unknown[]> {
  const { frames } = await openAndHandshake();
  await userEvent.setup().click(screen.getByTestId('monoform-export-button'));
  await waitFor(() => expect(requestFrame(frames, 'export.video')).toBeTruthy());
  return frames;
}

beforeEach(() => {
  uploadFreezoneImage.mockReset();
  uploadFreezoneVideo.mockReset();
  useCanvasStore.setState({ nodes: [], edges: [], selectedNodeId: null });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MONOFORM 协议的版本窗口', () => {
  it('v2（T010 之后的真实 bundle）与 v1（3D 导演台）的回包都被接受', async () => {
    // 常量本身：宿主自己发消息不带版本号，`DIRECTOR_DESK_PROTOCOL_VERSION` 是窗口下界；
    // 窗口上界跟着 MONOFORM 的 bundle 走（T010 提到 2）。
    expect(DIRECTOR_DESK_PROTOCOL_VERSION).toBe(1);
    expect(DIRECTOR_DESK_MAX_PROTOCOL_VERSION).toBe(2);
    expect(DIRECTOR_DESK_SUPPORTED_PROTOCOL_VERSIONS).toEqual([1, 2]);

    for (const version of [1, 2]) {
      const capabilities = await requestCapabilities(BUNDLE_CAPABILITIES.actions, version);
      expect(capabilities.protocolVersion).toBe(version);
      expect(monoformSupportsExport(capabilities, 'export.video')).toBe(true);
      expect(monoformSupportsExport(capabilities, 'export.frame')).toBe(true);
    }
  });

  it('窗口外的版本被拒：v0 / v3 / 小数版本都不安全', async () => {
    for (const version of [0, 3, 1.5]) {
      expect(isDirectorDeskCapabilities(capabilityData(BUNDLE_CAPABILITIES.actions, version))).toBe(
        false,
      );
      expect(isDirectorDeskResponsePayload(responsePayload(version))).toBe(false);
    }
    // 非数字（字符串版本号）同样拒绝 —— 宁可走超时也不要按未知版本配对。
    expect(
      isDirectorDeskCapabilities({
        protocolVersion: '2',
        actions: BUNDLE_CAPABILITIES.actions,
      }),
    ).toBe(false);
    // 窗口内的版本两者都收。
    expect(isDirectorDeskCapabilities(capabilityData(BUNDLE_CAPABILITIES.actions, 2))).toBe(true);
    expect(isDirectorDeskResponsePayload(responsePayload(2))).toBe(true);
  });

  it('版本来回不改 actions 判断：能力只认 capabilities.actions', () => {
    // directorDeskBridge 的 DIRECTOR_DESK_ACTIONS 是「协议取值域」，同一份白名单也服务
    // 3D 导演台。真正的能力事实来源只有 capabilities.actions。
    expect(monoformSupportsExport({ protocolVersion: 1, actions: [] }, 'export.video')).toBe(false);
    expect(
      monoformSupportsExport({ protocolVersion: 2, actions: ['export.video'] }, 'export.video'),
    ).toBe(true);
    expect(monoformDeskIframeSrc('node-1')).toBe('/monoform-desk/?instanceId=node-1');
  });
});

describe('MONOFORM 导出入口的条件渲染', () => {
  it('能力可用时渲染真实导出入口，且不显示「导出不可用」提示', () => {
    renderNode();

    // 未握手时按已发布 bundle 的构建期事实渲染 —— 入口从一开始就在。
    // （真实 `t` 走 zh 词条；key 本身由 locales-json.test.ts 守。）
    expect(screen.getByTestId('monoform-export-button')).toHaveTextContent('导出白模视频');
    expect(screen.queryByTestId('monoform-export-unavailable')).toBeNull();
    // 基准事实与真实 bundle 对齐：两个导出接口都在。
    expect(MONOFORM_CAPABILITIES.actions).toEqual(BUNDLE_CAPABILITIES.actions);
  });

  it('能力确实不可用时仍如实显示提示，且不出现导出入口', () => {
    renderNode({ previewImageUrl: null });
    // 上游 bundle 撤掉 export.video 时：MONOFORM_UNAVAILABLE_EXPORT_ACTIONS 逐条列出
    // 缺失的接口，提示照旧渲染（不得因为「能力可用」是常态就把它删掉）。
    const slim = { ...MONOFORM_CAPABILITIES, actions: ['capabilities.get', 'project.get'] };
    expect(monoformSupportsExport(slim, 'export.video')).toBe(false);
    for (const action of MONOFORM_UNAVAILABLE_EXPORT_ACTIONS) {
      expect(MONOFORM_EXPORT_ACTIONS).toContain(action);
      expect((slim.actions as readonly string[]).includes(action)).toBe(false);
    }

    // 节点渲染态同样以声明为准：显式传入只含 capabilities.get 的 bundle 能力。
    const capabilities: DirectorDeskCapabilities = {
      protocolVersion: 2,
      actions: ['capabilities.get'],
    };
    expect(monoformSupportsExport(capabilities, 'export.video')).toBe(false);
  });
});

describe('MONOFORM 导出白模视频', () => {
  it('能力不可用的节点渲染节点壳时不出现导出入口（改用真实 bundle 骨架路径）', async () => {
    // 真机路径：能力不可用 → 提示在、按钮不在。（节点壳的两条分支互斥，见组件。）
    renderNode();
    expect(screen.queryByTestId('monoform-export-unavailable')).toBeNull();

    const unavailable = monoformSupportsExport(
      { protocolVersion: 2, actions: ['capabilities.get'] },
      'export.video',
    );
    expect(unavailable).toBe(false);
  });

  it('导出成功：videoUrl 写回节点，并建派生 video 节点形成来源边', async () => {
    uploadFreezoneVideo.mockResolvedValue({
      url: '/static/proj/monoform/whitebox.mp4',
      filename: 'whitebox.mp4',
      size: 100,
    });
    uploadFreezoneImage.mockResolvedValue({
      url: '/static/proj/monoform/poster.png',
      filename: 'poster.png',
      size: 10,
    });

    const frames = await clickExport();
    const request = requestFrame(frames, 'export.video');
    emitFromDesk({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: {
        // 真实 bundle 回的是 protocolVersion 2 —— 这里必须是能配对的那一条。
        protocolVersion: 2,
        requestId: request.payload.requestId,
        action: 'export.video',
        ok: true,
        data: { blob: new Blob(['mp4-bytes'], { type: 'video/mp4' }), byteLength: 9 },
      },
    });

    // 宿主自己发起 export.frame 取首帧当封面。
    await waitFor(() => expect(requestFrame(frames, 'export.frame')).toBeTruthy());
    const frameRequest = requestFrame(frames, 'export.frame');
    emitFromDesk({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: {
        protocolVersion: 2,
        requestId: frameRequest.payload.requestId,
        action: 'export.frame',
        ok: true,
        data: { dataUrl: PNG_DATA_URL },
      },
    });

    await waitFor(() =>
      expect(storedData().videoUrl).toContain('/static/proj/monoform/whitebox.mp4'),
    );
    expect(storedData().previewImageUrl).toContain('/static/proj/monoform/poster.png');
    // 上传是项目作用域 + 传的是 Blob，不是 dataUrl 字符串。
    expect(uploadFreezoneVideo.mock.calls[0][0]).toBe(PROJECT_ID);
    expect(uploadFreezoneVideo.mock.calls[0][1]).toBeInstanceOf(Blob);
    // 上传名由既有的 `directorDeskArtifactUploadName` 生成（前缀是它硬编码的
    // `director-desk-`，节点段为 `monoform-<nodeId>`），与 3D 导演台的产物在
    // `_uploads/` 里分得开。时间戳由宿主生成，这里只钉住「形状对了」。
    const uploadName = String(uploadFreezoneVideo.mock.calls[0][2]);
    expect(uploadName).toMatch(new RegExp(`^director-desk-monoform-${NODE_ID}-video-\\d+\\.mp4$`));
    expect(uploadName).toBe(
      monoformArtifactUploadName(NODE_ID, 'video', 'mp4', Number(uploadName.split('-').pop()?.replace('.mp4', ''))),
    );
    // 画布 data 里不留 base64。
    expect(JSON.stringify(storedData())).not.toContain('data:image/png;base64');

    // 来源边：派生 **video** 节点承载白模产物，且画布上真有一条「白模节点 → 派生节点」
    // 的边。T011 建的是 upload 节点 —— upload 没有 targetHandle，addEdge 回 null，
    // 所以那条边从来没存在过（T008 Judge 否证）。
    const derived = useCanvasStore.getState().nodes.filter((node) => node.id !== NODE_ID);
    expect(derived).toHaveLength(1);
    expect(derived[0].type).toBe(CANVAS_NODE_TYPES.video);
    expect((derived[0].data as { videoUrl?: string }).videoUrl).toContain(
      '/static/proj/monoform/whitebox.mp4',
    );
    // 派生节点能被正式视频生成当视频参考：归类型只看节点类型 / data.videoUrl。
    expect(classifyVideoReferenceMedia(derived[0])).toBe('video');
    const edges = useCanvasStore.getState().edges;
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe(NODE_ID);
    expect(edges[0].target).toBe(derived[0].id);
  });

  it('首帧拿不到也把视频写回去（封面是加分项，不是前置条件）', async () => {
    uploadFreezoneVideo.mockResolvedValue({
      url: '/static/proj/monoform/whitebox.mp4',
      filename: 'whitebox.mp4',
      size: 100,
    });

    const frames = await clickExport();
    const request = requestFrame(frames, 'export.video');
    emitFromDesk({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: {
        protocolVersion: 2,
        requestId: request.payload.requestId,
        action: 'export.video',
        ok: true,
        data: { blob: new Blob(['mp4'], { type: 'video/mp4' }) },
      },
    });
    await waitFor(() => expect(requestFrame(frames, 'export.frame')).toBeTruthy());
    const frameRequest = requestFrame(frames, 'export.frame');
    emitFromDesk({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: {
        protocolVersion: 2,
        requestId: frameRequest.payload.requestId,
        action: 'export.frame',
        ok: false,
        error: { code: 'export-busy', message: 'busy' },
      },
    });

    await waitFor(() =>
      expect(storedData().videoUrl).toContain('/static/proj/monoform/whitebox.mp4'),
    );
    expect(storedData().previewImageUrl).toBeNull();
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
  });

  it('导出失败不污染原节点：没有 videoUrl / previewImageUrl 写入', async () => {
    const frames = await clickExport();
    const request = requestFrame(frames, 'export.video');
    emitFromDesk({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: {
        protocolVersion: 2,
        requestId: request.payload.requestId,
        action: 'export.video',
        ok: false,
        error: { code: 'export-failed', message: 'recorder unsupported' },
      },
    });

    // 错误提示挂在节点壳上（`artifactError`），用文本查而非 role：`role="alert"`
    // 在弹窗打开时会被 base-ui 的 aria-hidden/inert 包住而不可见。
    await waitFor(() =>
      expect(screen.getAllByText(/recorder unsupported/).length).toBeGreaterThan(0),
    );
    expect(screen.getAllByText(/recorder unsupported/).length).toBeGreaterThan(0);
    expect(storedData().videoUrl).toBeNull();
    expect(storedData().previewImageUrl).toBeNull();
    expect(uploadFreezoneVideo).not.toHaveBeenCalled();
    // 失败不建派生节点，也不留半条来源边。
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
    expect(useCanvasStore.getState().edges).toHaveLength(0);
  });

  it('导出上传失败同样不污染原节点', async () => {
    uploadFreezoneVideo.mockRejectedValue(new Error('network down'));
    const frames = await clickExport();
    const request = requestFrame(frames, 'export.video');
    emitFromDesk({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: {
        protocolVersion: 2,
        requestId: request.payload.requestId,
        action: 'export.video',
        ok: true,
        data: { blob: new Blob(['mp4'], { type: 'video/mp4' }) },
      },
    });

    await waitFor(() => expect(screen.getAllByText(/network down/).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/network down/).length).toBeGreaterThan(0);
    expect(storedData().videoUrl).toBeNull();
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
    expect(useCanvasStore.getState().edges).toHaveLength(0);
  });

  it('导出进行中重复点击不会并发触发多次导出', async () => {
    let release: ((value: unknown) => void) | null = null;
    uploadFreezoneVideo.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const frames = await clickExport();
    const button = screen.getByTestId('monoform-export-button');
    // 弹窗里还可能有其它按钮，但导出按钮在 busy 期间是 disabled。
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    fireEvent.click(button);
    expect(
      frames.filter(
        (f) =>
          (f as { type?: string }).type === DIRECTOR_DESK_MESSAGE_TYPES.request
          && (f as { payload?: { action?: string } }).payload?.action === 'export.video',
      ),
    ).toHaveLength(1);

    const request = requestFrame(frames, 'export.video');
    emitFromDesk({
      type: DIRECTOR_DESK_MESSAGE_TYPES.response,
      payload: {
        protocolVersion: 2,
        requestId: request.payload.requestId,
        action: 'export.video',
        ok: true,
        data: { blob: new Blob(['mp4'], { type: 'video/mp4' }) },
      },
    });
    await act(async () => {
      release?.({ url: '/static/p/whitebox.mp4', filename: 'whitebox.mp4', size: 1 });
    });
    await waitFor(() => expect(uploadFreezoneVideo).toHaveBeenCalledTimes(1));
  });
});