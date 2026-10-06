// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/** 直接驱动 vendor 面板和真实 DOM，覆盖选择、流式事件、工具配对与浏览器偏好。 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Channel = { id: string; name: string; protocol: string; baseUrl: string; model: string; hasKey: boolean; kind?: string };
type Event = { type: string; sessionId: string; text?: string; name?: string; status?: string; summary?: unknown; toolCallId?: string; imagePrevis?: Record<string, unknown>; timing?: { rounds: number; modelMs: number; toolMs: number; toolCalls: number; totalMs: number } };
type Snapshot = { sessionId: string; profileId: string; transcript: string; imagePrevis?: Record<string, unknown> };
const PREFERENCE = 'director-ai-last-channel-v1';
const channel = (id: string, kind = 'text'): Channel => ({ id, name: id, protocol: 'chat', baseUrl: 'https://example.invalid', model: id + '-model', hasKey: true, kind });
const shots = [
    { beat_number: 1, scene: '咖啡馆', duration_seconds: 8.2, synopsis: '她推开门，餐桌上多了一副碗筷。镜头需要完整看见门口和餐桌，概要不能被裁切。', speaker: '林晚', spoken_text: '这段很长的台词需要换行展示，不能只能看见开头几个字。' },
    { beat_number: 2, scene: '咖啡馆窗边', duration_seconds: 5, synopsis: '他抬起头，望向门口。', speaker: '', spoken_text: '' },
    { beat_number: 3, scene: '雨夜车内', duration_seconds: 12, synopsis: '雨刷来回，雨夜霓虹反光。', speaker: '林晚', spoken_text: '我们走吧。' },
];

let mountAI: (ctx: never) => void;
let panelCss = '';
beforeAll(async () => {
    // glob 由 Vite 加载 vendor，避免把 vendor 的 ES2022 类型拉进宿主 ES2020 的 TS 工程。
    const modules = import.meta.glob('../../../../vendor/director-desk/src/ui/ai-panel.ts');
    const load = modules['../../../../vendor/director-desk/src/ui/ai-panel.ts'];
    if (!load) throw new Error('vendor AI 面板未被 Vite 加载');
    mountAI = ((await load()) as { mountAI: typeof mountAI }).mountAI;
    // Vitest 默认剥掉 CSS 模块；把实际样式交给浏览器 CSSOM 解析，验证媒体规则的行为配置。
    panelCss = readFileSync(resolve(process.cwd(), 'vendor/director-desk/src/ui/ai-panel.css'), 'utf8');
});

function makeBridge(initial = [channel('openai'), channel('sharellm')], conversation: Partial<Snapshot> = {}) {
    let listener: ((event: Event) => void) | undefined;
    let resolveRun: ((value: unknown) => void) | undefined;
    const state = { channels: initial, selected: 1, held: false, imageUrl: '' };
    const payload = () => ({ episodes: [1], episode: 1, shots: shots.map(shot => ({ ...shot, reference_image_url: state.imageUrl })), selected: state.selected, hint: '', error: null });
    const bridge = {
        profiles: vi.fn(async () => ({ ok: true, data: state.channels })),
        conversation: vi.fn(async () => ({ ok: true, data: { sessionId: 'session-1', profileId: '', transcript: '', ...conversation } })),
        newConversation: vi.fn(async () => ({ ok: true, data: { sessionId: 'session-2', profileId: '', transcript: '' } })),
        conversationHistory: vi.fn(async () => ({ ok: true, data: [] as { sessionId: string; title: string; updatedAt: number; profileId: string; current: boolean }[] })),
        selectConversation: vi.fn(async (sessionId: string) => ({ ok: true, data: { sessionId, profileId: 'openai', transcript: '\n你：旧任务\nAI：旧回复' }, error: undefined as string | undefined })),
        mcp: vi.fn(async () => ({ ok: true, data: { enabled: false } })),
        channelModels: vi.fn(async (request: { profileId: string }) => ({ ok: true, data: [request.profileId + '-model'] })),
        onEvent: vi.fn((callback: (event: Event) => void) => { listener = callback; }),
        storyboard: vi.fn(async () => ({ ok: true, data: payload() })),
        selectStoryboard: vi.fn(async (_episode: number, beat: number) => { state.selected = beat; return { ok: true, data: payload() }; }),
        test: vi.fn(async () => ({ ok: true, data: {} })),
        skills: vi.fn(async (request: { action: string; id?: string; path?: string }) => ({ ok: true, data: request.action === 'list'
            ? { skills: [{ id: 'image-previs', name: 'image-previs', description: '图片分镜共创预演', version: 'v1', enabled: true, builtin: true, source: '随软件内置 · 本项目补充', files: ['SKILL.md'] }] }
            : { instructions: '图片分镜共创预演，使用 director_image_previs 报告识图结果和方案。' } })),
        stop: vi.fn(async () => ({ ok: true, data: {} })),
        run: vi.fn((_data: Record<string, unknown>) => state.held ? new Promise(resolve => { resolveRun = resolve; }) : Promise.resolve({ ok: true, data: {} })),
    };
    return {
        state, bridge,
        emit(event: Omit<Event, 'sessionId'>) { if (!listener) throw new Error('面板事件尚未订阅'); listener({ sessionId: 'session-1', ...event }); },
        complete() { resolveRun?.({ ok: true, data: {} }); },
    };
}

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.querySelector<T>('#' + id)!;
const flush = () => vi.advanceTimersByTimeAsync(0);
const hostDom = () => { document.body.innerHTML = '<div class="header-actions"></div><div id="timeline-content"></div><button id="timeline-to-ai"></button>'; };
async function mount(bridge: unknown) {
    hostDom();
    (window as unknown as { directorDesktop: unknown }).directorDesktop = bridge;
    const ctx = { act: vi.fn(async () => {}), project: { entities: [], cuts: [], clips: [] }, selected: '', scenes: { context: { sessionId: 's', sceneId: 'scene' } },
        renderCameras: vi.fn(), seek: vi.fn(), updateTimeUI: vi.fn(), preview: 'camera-old', playing: false };
    mountAI(ctx as never);
    await flush();
    element<HTMLButtonElement>('ai-toggle').click();
    await flush();
    return ctx;
}
async function send(fake: ReturnType<typeof makeBridge>) {
    fake.state.held = true;
    element<HTMLTextAreaElement>('ai-prompt').value = '按当前分镜布置咖啡馆';
    element<HTMLButtonElement>('ai-send').click();
    await flush();
    expect(fake.bridge.run).toHaveBeenCalledOnce();
}
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
    delete (window as unknown as { directorDesktop?: unknown }).directorDesktop;
});

describe('分镜选择的真实交互', () => {
    it('鼠标转移卡片焦点时，即使 activeElement 暂时为 body 也不能关闭或重建目标卡片', async () => {
        const fake = makeBridge(); await mount(fake.bridge);
        element<HTMLButtonElement>('ai-storyboard-toggle').click();
        const first = document.querySelector<HTMLButtonElement>('[data-beat="1"]')!;
        const target = document.querySelector<HTMLButtonElement>('[data-beat="3"]')!;
        target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        // 模拟真实 Chromium 的 focusout → 微任务 → focusin → pointerup/click 顺序。
        Object.defineProperty(document, 'activeElement', { configurable: true, get: () => document.body });
        first.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: target }));
        await flush();
        delete (document as unknown as { activeElement?: HTMLElement }).activeElement;
        expect(element('ai-storyboard-pop')).not.toHaveAttribute('hidden');
        expect(target.isConnected).toBe(true);
        target.focus(); target.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); target.click();
        await flush();
        expect(fake.bridge.selectStoryboard).toHaveBeenCalledWith(1, 3);
        expect(element('ai-storyboard-current')).toHaveTextContent('#3');
    });

    it('完整呈现概要和台词，方向键选镜、Esc只收浮层并返回触发器', async () => {
        const fake = makeBridge(); await mount(fake.bridge);
        const toggle = element<HTMLButtonElement>('ai-storyboard-toggle');
        expect(toggle.querySelector('.ai-storyboard-caret')).toHaveTextContent('');
        toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        const options = [...document.querySelectorAll<HTMLButtonElement>('.ai-shot')];
        expect(element('ai-storyboard-pop')).not.toHaveAttribute('hidden');
        expect(options[0]).toHaveTextContent(shots[0].synopsis);
        expect(options[0]).toHaveTextContent(shots[0].spoken_text);
        expect(document.activeElement).toBe(options[0]);
        options[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(options[1]);
        options[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(options[2]);
        options[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(element('ai-storyboard-pop')).toHaveAttribute('hidden');
        expect(element('ai-panel')).not.toHaveAttribute('hidden');
        expect(document.activeElement).toBe(toggle);
    });

    it('选镜以后以宿主回包更新当前场次、选中态和焦点', async () => {
        const fake = makeBridge(); await mount(fake.bridge);
        element<HTMLButtonElement>('ai-storyboard-toggle').click();
        document.querySelector<HTMLButtonElement>('[data-beat="2"]')!.click();
        await flush();
        expect(fake.bridge.selectStoryboard).toHaveBeenCalledWith(1, 2);
        expect(element('ai-storyboard-current')).toHaveTextContent('#2');
        expect(document.querySelector('[data-beat="2"]')).toHaveAttribute('aria-selected', 'true');
        expect(element('ai-storyboard-pop')).toHaveAttribute('hidden');
        expect(document.activeElement).toBe(element('ai-storyboard-toggle'));
    });
});

describe('图片分镜共创入口', () => {
    it('选图即显示技能入口和流程，收到方案后确认按钮发送该方案编号', async () => {
        const fake = makeBridge(); fake.state.imageUrl = '/reference.png'; await mount(fake.bridge);
        expect(element('ai-image-previs')).not.toHaveAttribute('hidden');
        expect(element('ai-image-previs')).toHaveTextContent('图片分镜共创预演');
        fake.emit({ type: 'image-previs', imagePrevis: { stage: 'ready', observation: '两个人在桌子两侧', questions: [], plan: '6 秒内伸手，摄影机平稳推近。', planId: 'plan-1' } });
        expect(element('ai-previs-card')).toHaveTextContent('两个人在桌子两侧');
        expect(element('ai-previs-card')).toHaveTextContent('6 秒内伸手');
        element<HTMLButtonElement>('ai-previs-confirm').click(); await flush();
        expect(fake.bridge.run).toHaveBeenCalledWith(expect.objectContaining({ imagePrevisConfirmation: 'plan-1', mode: 'execute' }));
    });

    it('换图清掉旧方案，不能识图时提供更换模型入口', async () => {
        const fake = makeBridge(); fake.state.imageUrl = '/first.png'; await mount(fake.bridge);
        fake.emit({ type: 'image-previs', imagePrevis: { stage: 'ready', observation: '人物', questions: [], plan: '旧方案', planId: 'old-plan' } });
        fake.state.imageUrl = '/second.png'; window.dispatchEvent(new Event('director-storyboard-changed')); await flush();
        expect(document.querySelector('#ai-previs-confirm')).toBeNull();
        fake.emit({ type: 'image-previs', imagePrevis: { stage: 'unsupported', observation: '模型不支持图像', questions: [], plan: '', planId: '' } });
        expect(element('ai-previs-card')).toHaveTextContent('模型不支持图像');
        element<HTMLButtonElement>('ai-previs-change-model').click();
        expect(element('ai-settings')).not.toHaveAttribute('hidden');
    });

    it('恢复待确认方案，输入修改时禁止确认；普通发送不携带旧许可', async () => {
        const fake = makeBridge(undefined, { imagePrevis: { stage: 'ready', observation: '人物在左侧', questions: [], plan: '6 秒推近', planId: 'restored-plan' } });
        fake.state.held = true;
        fake.state.imageUrl = '/reference.png'; await mount(fake.bridge);
        expect(element('ai-previs-card')).toHaveTextContent('6 秒推近');
        const input = element<HTMLTextAreaElement>('ai-prompt');
        input.value = '改成拉远'; input.dispatchEvent(new Event('input'));
        expect(element<HTMLButtonElement>('ai-previs-confirm')).toBeDisabled();
        element<HTMLButtonElement>('ai-send').click(); await flush();
        expect(fake.bridge.run).toHaveBeenCalledWith(expect.objectContaining({ prompt: '改成拉远' }));
        expect(fake.bridge.run.mock.calls[0]?.[0]).not.toHaveProperty('imagePrevisConfirmation');
        fake.emit({ type: 'image-previs', imagePrevis: { stage: 'clarifying', observation: '人物在左侧', questions: ['拉远时关注人物还是环境？'], plan: '', planId: '' } });
        fake.emit({ type: 'done' }); fake.complete(); await flush();
        expect(element('ai-status')).toHaveTextContent('请回答');
        expect(element('ai-run-progress')).toHaveTextContent('等待回答');
        expect(document.querySelector('#ai-previs-confirm')).toBeNull();
    });

    it('请求中换图后忽略旧图报告，断开图片隐藏工作流', async () => {
        const fake = makeBridge(); fake.state.imageUrl = '/first.png'; await mount(fake.bridge);
        fake.state.held = true;
        element<HTMLTextAreaElement>('ai-prompt').value = '按图讨论'; element<HTMLButtonElement>('ai-send').click(); await flush();
        fake.state.imageUrl = '/second.png'; window.dispatchEvent(new Event('director-storyboard-changed')); await flush();
        fake.emit({ type: 'image-previs', imagePrevis: { stage: 'ready', observation: '旧图人物', questions: [], plan: '旧图方案', planId: 'stale' } });
        expect(document.querySelector('#ai-previs-confirm')).toBeNull();
        fake.emit({ type: 'done' }); fake.complete(); await flush();
        fake.state.imageUrl = ''; window.dispatchEvent(new Event('director-storyboard-changed')); await flush();
        expect(element('ai-image-previs')).toHaveAttribute('hidden');
        expect(document.querySelector('#ai-previs-card')).toBeNull();
    });

    it('技能说明直接打开独立图片技能，方案中的 HTML 只按文本显示', async () => {
        const fake = makeBridge(); fake.state.imageUrl = '/reference.png'; await mount(fake.bridge);
        element<HTMLButtonElement>('ai-previs-skill').click(); await flush();
        expect(element('ai-skills')).not.toHaveAttribute('hidden');
        expect(element<HTMLSelectElement>('skill-select').value).toBe('image-previs');
        expect(element<HTMLSelectElement>('skill-file').value).toBe('SKILL.md');
        expect(fake.bridge.skills).toHaveBeenCalledWith({ action: 'read', id: 'image-previs', path: 'SKILL.md' });
        expect(element<HTMLTextAreaElement>('skill-content').value).toContain('director_image_previs');
        element<HTMLButtonElement>('ai-chat-toggle').click();
        fake.emit({ type: 'image-previs', imagePrevis: { stage: 'ready', observation: '<img src=x onerror=alert(1)>', questions: [], plan: '<script>坏内容</script>', planId: 'safe' } });
        expect(element('ai-previs-card').querySelector('img,script')).toBeNull();
        expect(element('ai-previs-card')).toHaveTextContent('<script>坏内容</script>');
    });

    it('完成后直接播放实际时间轴和成片机位，不再次调用模型', async () => {
        const fake = makeBridge(); fake.state.imageUrl = '/reference.png'; const ctx = await mount(fake.bridge);
        fake.emit({ type: 'image-previs', imagePrevis: { stage: 'complete', observation: '两个物体', questions: [], plan: '6 秒相遇', planId: 'done' } });
        element<HTMLButtonElement>('ai-previs-play').click();
        expect(ctx.preview).toBe('program'); expect(ctx.seek).toHaveBeenCalledWith(0); expect(ctx.playing).toBe(true);
        expect(element('ai-panel')).toHaveAttribute('hidden');
        expect(fake.bridge.run).not.toHaveBeenCalled();
    });
});

describe('历史会话切换', () => {
    it('开始新对话后，可从历史找回正文、工具和错误，切回后继续原会话', async () => {
        const old = { sessionId: 'session-1', profileId: 'sharellm', transcript: '\n你：咖啡馆旧任务\nAI：旧回复\n[director_read：completed]{"entities":2}\n[notice：error]"封面同步失败"' };
        const fake = makeBridge(undefined, old);
        fake.bridge.conversationHistory.mockResolvedValue({ ok: true, data: [
            { sessionId: 'session-2', title: '新对话', updatedAt: Date.now(), profileId: '', current: true },
            { sessionId: old.sessionId, title: '咖啡馆旧任务', updatedAt: Date.now() - 1000, profileId: old.profileId, current: false },
        ] });
        fake.bridge.selectConversation.mockResolvedValue({ ok: true, data: old, error: undefined });
        await mount(fake.bridge);
        element<HTMLButtonElement>('ai-new').click(); await flush();
        expect(element('ai-transcript')).not.toHaveTextContent('旧回复');
        element<HTMLButtonElement>('ai-history-toggle').click(); await flush();
        expect(element('ai-history-list')).toHaveTextContent('咖啡馆旧任务');
        document.querySelector<HTMLButtonElement>('[data-session-id="session-1"]')!.click(); await flush();
        expect(fake.bridge.selectConversation).toHaveBeenCalledWith('session-1');
        expect(element('ai-transcript')).toHaveTextContent('旧回复');
        expect(element('ai-transcript')).toHaveTextContent('封面同步失败');
        expect(element('ai-transcript').querySelector('details')).toHaveTextContent('entities');
        expect(element<HTMLSelectElement>('ai-channel').value).toBe('sharellm');
        expect(element('ai-history')).toHaveAttribute('hidden');
        await send(fake);
        expect(fake.bridge.run).toHaveBeenCalledWith(expect.objectContaining({ sessionId: old.sessionId, profileId: old.profileId }));
        fake.emit({ type: 'done' }); fake.complete(); await flush();
    });

    it('任务执行中可以打开历史，但不能切换或开始新对话', async () => {
        const fake = makeBridge();
        fake.bridge.conversationHistory.mockResolvedValue({ ok: true, data: [
            { sessionId: 'older', title: '另一个旧任务', updatedAt: Date.now(), profileId: '', current: false },
        ] });
        await mount(fake.bridge); await send(fake);
        element<HTMLButtonElement>('ai-history-toggle').click(); await flush();
        const older = document.querySelector<HTMLButtonElement>('[data-session-id="older"]')!;
        expect(older).toBeDisabled(); older.click();
        element<HTMLButtonElement>('ai-new').click(); await flush();
        expect(fake.bridge.selectConversation).not.toHaveBeenCalled();
        expect(fake.bridge.newConversation).not.toHaveBeenCalled();
        fake.emit({ type: 'done' }); fake.complete(); await flush();
        expect(document.querySelector('[data-session-id="older"]')).not.toBeDisabled();
    });

    it('历史切换失败保留当前消息；标题中的HTML只作为文本显示', async () => {
        const fake = makeBridge(undefined, { transcript: '\n你：当前任务\nAI：保留这条回复' });
        fake.bridge.conversationHistory.mockResolvedValue({ ok: true, data: [
            { sessionId: 'bad', title: '<img src=x onerror=alert(1)>', updatedAt: Date.now(), profileId: '', current: false },
        ] });
        fake.bridge.selectConversation.mockResolvedValue({ ok: false, data: undefined as never, error: '归档文件不可用' });
        await mount(fake.bridge);
        element<HTMLButtonElement>('ai-history-toggle').click(); await flush();
        expect(element('ai-history-list').querySelector('img')).toBeNull();
        document.querySelector<HTMLButtonElement>('[data-session-id="bad"]')!.click(); await flush();
        expect(element('ai-transcript')).toHaveTextContent('保留这条回复');
        expect(element('ai-history-status')).toHaveTextContent('归档文件不可用');
        expect(element<HTMLButtonElement>('ai-send')).not.toBeDisabled();
    });
});

describe('跨节点渠道偏好', () => {
    it('只记手选的渠道ID，新节点默认选它，不存密钥和模型', async () => {
        const first = makeBridge(); await mount(first.bridge);
        expect(localStorage.getItem(PREFERENCE)).toBeNull();
        const select = element<HTMLSelectElement>('ai-channel');
        select.value = 'sharellm'; select.dispatchEvent(new Event('change'));
        await flush();
        expect(localStorage.getItem(PREFERENCE)).toBe('sharellm');
        await mount(makeBridge().bridge);
        expect(element<HTMLSelectElement>('ai-channel').value).toBe('sharellm');
        expect(element('ai-channel-current')).toHaveTextContent('sharellm');
        expect(element<HTMLSelectElement>('ai-channel-model').value).toBe('sharellm-model');
    });

    it('旧节点恢复自己的渠道，但不能覆盖最近手选的全局偏好', async () => {
        localStorage.setItem(PREFERENCE, 'sharellm');
        await mount(makeBridge(undefined, { profileId: 'openai', transcript: '\n你：检查场景\nAI：已有两个人物' }).bridge);
        expect(element<HTMLSelectElement>('ai-channel').value).toBe('openai');
        expect(localStorage.getItem(PREFERENCE)).toBe('sharellm');
        await mount(makeBridge().bridge);
        expect(element<HTMLSelectElement>('ai-channel').value).toBe('sharellm');
    });

    it('偏好的渠道已删除时，落到有效文本渠道并保留偏好原值', async () => {
        localStorage.setItem(PREFERENCE, 'removed');
        await mount(makeBridge([channel('image', 'image'), channel('openai')]).bridge);
        expect(element<HTMLSelectElement>('ai-channel').value).toBe('openai');
        expect(localStorage.getItem(PREFERENCE)).toBe('removed');
    });

    it('浏览器拒绝保存偏好时，手选渠道仍能发送任务', async () => {
        vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('存储受限'); });
        const fake = makeBridge(); await mount(fake.bridge);
        const select = element<HTMLSelectElement>('ai-channel'); select.value = 'sharellm'; select.dispatchEvent(new Event('change'));
        await flush(); await send(fake);
        expect(fake.bridge.run).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'sharellm' }));
        fake.emit({ type: 'done' }); fake.complete(); await flush();
    });
});

describe('真实事件驱动的 agent 对话', () => {
    it('阶段、轮次和计时随实际事件变化，结束后计时停住', async () => {
        const fake = makeBridge(); await mount(fake.bridge); await send(fake);
        fake.emit({ type: 'status', text: '正在请求模型 · 第 2 轮' });
        await vi.advanceTimersByTimeAsync(3000);
        const root = element('ai-run-progress');
        expect(root).toHaveAttribute('data-phase', 'requesting');
        expect(root).toHaveTextContent('第 2 轮');
        expect(root).toHaveTextContent('已用时 3 秒');
        fake.emit({ type: 'status', text: '模型正在思考 · 第 2 轮' });
        expect(root).toHaveAttribute('data-phase', 'thinking');
        fake.emit({ type: 'text', text: '先调整餐桌位置。' });
        expect(root).toHaveAttribute('data-phase', 'responding');
        fake.emit({ type: 'tool', name: 'director_apply', status: 'running' });
        expect(root).toHaveAttribute('data-phase', 'executing');
        expect(root).toHaveTextContent('布置场景');
        fake.emit({ type: 'tool', name: 'director_apply', status: 'completed', summary: { committed: true } });
        expect(root).toHaveTextContent('已执行 1 步');
        fake.emit({ type: 'done', timing: { rounds: 2, toolCalls: 1, modelMs: 2600, toolMs: 400, totalMs: 3000 } });
        fake.complete(); await flush();
        expect(root).toHaveAttribute('data-phase', 'done');
        expect(root).not.toHaveClass('is-active');
        await vi.advanceTimersByTimeAsync(3000);
        expect(root).toHaveTextContent('已用时 3 秒');
        expect(root.textContent).not.toContain('%');
    });

    it('运行中的工具卡立即出现，返回以后原位更新并保留展开状态', async () => {
        const fake = makeBridge(); await mount(fake.bridge);
        fake.emit({ type: 'tool', name: 'director_apply', status: 'running', toolCallId: 'apply-1' });
        const card = document.querySelector<HTMLLIElement>('.ai-msg-tool')!;
        const details = card.querySelector('details')!; details.open = true;
        expect(card).toHaveTextContent('执行中');
        fake.emit({ type: 'tool', name: 'director_apply', status: 'completed', toolCallId: 'apply-1', summary: { committed: true, summary: { added: ['cafe-table'] } } });
        expect(document.querySelectorAll('.ai-msg-tool')).toHaveLength(1);
        expect(document.querySelector('.ai-msg-tool')).toBe(card);
        expect(details.open).toBe(true);
        expect(card).toHaveTextContent('已完成');
        expect(card.querySelector('pre')).toHaveTextContent('cafe-table');
        expect(card.querySelector('summary')).not.toHaveTextContent('committed');
    });

    it('同名并发工具优先按调用ID配对，连续调用不错误合并', async () => {
        const fake = makeBridge(); await mount(fake.bridge);
        for (const toolCallId of ['first', 'second']) fake.emit({ type: 'tool', name: 'director_apply', status: 'running', toolCallId });
        fake.emit({ type: 'tool', name: 'director_apply', status: 'completed', toolCallId: 'second' });
        const cards = [...document.querySelectorAll<HTMLLIElement>('.ai-msg-tool')];
        expect(cards).toHaveLength(2);
        expect(cards[0]).toHaveAttribute('data-tool-status', 'running');
        expect(cards[1]).toHaveAttribute('data-tool-status', 'completed');
        fake.emit({ type: 'tool', name: 'director_apply', status: 'failed', toolCallId: 'first', summary: 'operations[0]: 不支持摄影机字段。请核对契约。' });
        expect(cards[0]).toHaveClass('is-failed');
        expect(cards[0].querySelector('summary')).toHaveTextContent('不支持摄影机字段');
        expect(cards[0].querySelector('pre')).toHaveTextContent('请核对契约');
    });

    it('旧桥无调用ID时，按同名队列配对并保留每次调用', async () => {
        const fake = makeBridge(); await mount(fake.bridge);
        fake.emit({ type: 'tool', name: 'director_read', status: 'running' });
        fake.emit({ type: 'tool', name: 'director_read', status: 'running' });
        fake.emit({ type: 'tool', name: 'director_read', status: 'completed' });
        const cards = [...document.querySelectorAll('.ai-msg-tool')];
        expect(cards).toHaveLength(2);
        expect(cards[0]).toHaveAttribute('data-tool-status', 'completed');
        expect(cards[1]).toHaveAttribute('data-tool-status', 'running');
    });

    it('工具前后的文本按时间顺序分条，结束后安全呈现正文格式', async () => {
        const fake = makeBridge(); await mount(fake.bridge);
        fake.emit({ type: 'text', text: '先检查场景。' });
        fake.emit({ type: 'tool', name: 'director_read', status: 'running' });
        fake.emit({ type: 'tool', name: 'director_read', status: 'completed' });
        fake.emit({ type: 'text', text: '### 分镜结果\n- **人物**已面向餐桌\n- 保留 `<img src=x onerror=alert(1)>` 原文' });
        fake.emit({ type: 'done' });
        expect([...document.querySelectorAll<HTMLElement>('.ai-messages>li')].map(item => item.dataset.role)).toEqual(['assistant', 'tool', 'assistant']);
        expect(document.querySelector('.ai-messages h3')).toHaveTextContent('分镜结果');
        expect(document.querySelector('.ai-messages strong')).toHaveTextContent('人物');
        expect(document.querySelector('.ai-messages img')).toBeNull();
        expect(document.querySelector('.ai-messages code')).toHaveTextContent('<img src=x onerror=alert(1)>');
    });

    it('用户向上阅读时，持续输出和工具更新不能把滚动位置拉回底部', async () => {
        const fake = makeBridge(); await mount(fake.bridge);
        const transcript = element('ai-transcript');
        Object.defineProperties(transcript, { scrollHeight: { value: 1200, configurable: true }, clientHeight: { value: 300, configurable: true } });
        transcript.scrollTop = 140;
        fake.emit({ type: 'text', text: '正在检查这场戏。' });
        fake.emit({ type: 'tool', name: 'director_spatial', status: 'running' });
        fake.emit({ type: 'tool', name: 'director_spatial', status: 'completed' });
        fake.emit({ type: 'done' });
        expect(transcript.scrollTop).toBe(140);
    });

    it('恢复历史会保留失败原因和完整详情，不伪装成正在执行', async () => {
        const raw = '\n你：摆场景\nAI：需要先核对摄影机。\n[director_apply：unknown]"director_desk_v2_error: operations[10]: 不支持摄影机字段：patch.camera.path"';
        await mount(makeBridge(undefined, { transcript: raw }).bridge);
        const card = document.querySelector('.ai-msg-tool')!;
        expect(card).toHaveClass('is-failed');
        expect(card.querySelector('summary')).toHaveTextContent('不支持摄影机字段');
        expect(card.querySelector('pre')).toHaveTextContent('patch.camera.path');
        expect(element('ai-run-progress')).toHaveAttribute('hidden');
    });

    it('重开历史后，工具后的换行和正常正文仍按助手消息呈现', async () => {
        const raw = '\n你：核对保存\nAI：\n[director_read：completed]{"name":"工程"}\n\n已读取工程，接下来核对镜头。\n[director_apply：completed]{"hasChanges":true}\n### 实际结果\n- **名称**已更新\n- 提示词中提到“连接中断”，这不是本轮错误';
        await mount(makeBridge(undefined, { transcript: raw }).bridge);
        expect([...document.querySelectorAll<HTMLElement>('.ai-messages>li')].map(item => item.dataset.role))
            .toEqual(['user', 'tool', 'assistant', 'tool', 'assistant']);
        expect(document.querySelector('.ai-msg-error')).toBeNull();
        expect(document.querySelector('.ai-messages h3')).toHaveTextContent('实际结果');
        expect(document.querySelector('.ai-messages strong')).toHaveTextContent('名称');
    });

    it('显式错误记录和助手正文保持边界，恢复后错误全文仍可读', async () => {
        const notice = '连接中断\n已提交操作保留。 对话已保留，可继续。';
        const raw = '\n你：核对保存\nAI：\n[director_read：completed]{}\n工程已核对。\n[notice：error]' + JSON.stringify(notice) + '\n';
        await mount(makeBridge(undefined, { transcript: raw }).bridge);
        expect([...document.querySelectorAll<HTMLElement>('.ai-messages>li')].map(item => item.dataset.role))
            .toEqual(['user', 'tool', 'assistant', 'error']);
        expect(document.querySelector('.ai-msg-assistant')).toHaveTextContent('工程已核对');
        expect(document.querySelector('.ai-msg-error')?.textContent).toBe(notice);
        expect(document.querySelectorAll('.ai-msg-tool')).toHaveLength(1);
    });

    it('请求失败会停下状态动效、标明未确认工具结果，错误全文可读', async () => {
        const fake = makeBridge(); await mount(fake.bridge); await send(fake);
        fake.emit({ type: 'tool', name: 'director_apply', status: 'running' });
        fake.emit({ type: 'error', text: '连接中断，已提交操作保留。请检查场景后再继续。' });
        const root = element('ai-run-progress');
        expect(root).toHaveAttribute('data-phase', 'error');
        expect(root).not.toHaveClass('is-active');
        expect(document.querySelector('.ai-msg-error')).toHaveTextContent('请检查场景后再继续');
        expect(document.querySelector('.ai-msg-tool')).toHaveTextContent('结果未确认');
        fake.complete(); await flush();
        expect(root).toHaveAttribute('data-phase', 'error');
    });

    it('实际CSS在减少动态效果媒体条件下关闭文字动画并恢复静态可读颜色', () => {
        const style = document.createElement('style'); style.textContent = panelCss; document.head.append(style);
        try {
            // jsdom 的 CSSOM 对象与全局构造器不同域，使用规范 type 而不是 instanceof。
            const media = [...style.sheet!.cssRules].filter((rule): rule is CSSMediaRule => rule.type === CSSRule.MEDIA_RULE)
                .find(rule => rule.conditionText.replace(/\s/g, '') === '(prefers-reduced-motion:reduce)');
            expect(media).toBeDefined();
            const rule = [...media!.cssRules].find((item): item is CSSStyleRule => item.type === CSSRule.STYLE_RULE && (item as CSSStyleRule).selectorText.includes('.ai-run-phase'));
            expect(rule!.style.getPropertyValue('animation')).toBe('none');
            expect(rule!.style.getPropertyValue('color')).not.toBe('transparent');
        } finally { style.remove(); }
    });
});
