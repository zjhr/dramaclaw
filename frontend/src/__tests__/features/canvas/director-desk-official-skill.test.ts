// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/** 真实挂载官方技能面板，覆盖会话登记竞态、附件正文和后端开关的事实来源。 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Entry = { id: string; name: string; description: string; version: string; enabled: boolean; builtin: boolean; source: string; files: string[] };
type Request = { action: string; id?: string; path?: string; enabled?: boolean };
type Result = { ok: boolean; data?: { skills?: Entry[]; instructions?: string }; error?: string };
type Builtin = { name: string; version: string; instructions: string; references: Record<string, string> };
let mountSkills: (panel: HTMLElement, status: (message: string) => void) => void;
let builtin: Builtin;

beforeAll(async () => {
    // Vite glob 转译真实 vendor，不把 vendor ES2022 依赖引入宿主的 ES2020 类型检查。
    const modules = import.meta.glob('../../../../vendor/director-desk/src/ui/ai-skills-panel.ts');
    const source = modules['../../../../vendor/director-desk/src/ui/ai-skills-panel.ts'];
    if (!source) throw new Error('官方技能面板未被 Vite 加载');
    mountSkills = ((await source()) as { mountAISkills: typeof mountSkills }).mountAISkills;
    const sources = import.meta.glob('../../../../vendor/director-desk/src/automation/skill.ts');
    const skill = sources['../../../../vendor/director-desk/src/automation/skill.ts'];
    if (!skill) throw new Error('上游官方技能事实来源未被 Vite 加载');
    builtin = ((await skill()) as { BUILTIN_SKILL: Builtin }).BUILTIN_SKILL;
});

const flush = () => vi.advanceTimersByTimeAsync(0);
const find = <T extends HTMLElement = HTMLInputElement>(id: string) => document.querySelector<T>('#' + id)!;
const official = (enabled = true): Entry => ({ id: 'builtin', name: builtin.name, version: builtin.version, description: '上游官方导演台技能', source: '随软件内置', enabled, builtin: true, files: ['SKILL.md', ...Object.keys(builtin.references)] });
const supplemental = (): Entry => ({ id: 'project-previs-1', name: 'previs-props', version: 'v1', description: '本项目预演道具补充', source: '/local/previs-props', enabled: true, builtin: false, files: ['SKILL.md', 'references/props.md'] });
const imageSkill = (): Entry => ({ id: 'image-previs', name: 'image-previs', version: 'v1', description: '图片分镜共创预演', source: '随软件内置 · 本项目补充', enabled: true, builtin: true, files: ['SKILL.md'] });
const custom = (): Entry => ({ id: 'custom-1', name: 'scene-helper', version: 'v2', description: '用户自定义技能', source: '/local/scene-helper', enabled: true, builtin: false, files: ['SKILL.md'] });

function makeBridge(initial?: Entry[]) {
    const state = { entries: initial ?? [official(), supplemental(), custom()], readError: '', enableError: '' };
    const skills = vi.fn(async (request: Request): Promise<Result> => {
        if (request.action === 'list') return { ok: true, data: { skills: state.entries } };
        if (request.action === 'read') {
            if (state.readError) return { ok: false, error: state.readError };
            const entry = state.entries.find(entry => entry.id === request.id);
            if (!entry) return { ok: false, error: '内置技能尚未就绪，请先打开画布上的导演台节点' };
            const path = request.path || 'SKILL.md';
            if (!entry.files.includes(path)) return { ok: false, error: '技能中没有这个文件' };
            return { ok: true, data: { instructions: entry.builtin ? path === 'SKILL.md' ? builtin.instructions : builtin.references[path] : `${entry.name} 的内容：${path}` } };
        }
        if (request.action === 'enable') {
            if (state.enableError) return { ok: false, error: state.enableError };
            state.entries = state.entries.map(entry => entry.id === request.id ? { ...entry, enabled: Boolean(request.enabled) } : entry);
            return { ok: true, data: { skills: state.entries } };
        }
        if (request.action === 'import') return { ok: true, data: { skills: [] } };
        return { ok: true, data: { skills: state.entries } };
    });
    return { bridge: { skills }, skills, state };
}
function install(bridge?: unknown) {
    if (bridge) (window as unknown as { directorDesktop: unknown }).directorDesktop = bridge;
    else delete (window as unknown as { directorDesktop?: unknown }).directorDesktop;
}
async function mount(bridge?: unknown, hidden = false) {
    install(bridge);
    const panel = document.createElement('aside'); panel.id = 'test-ai-panel'; panel.hidden = hidden;
    panel.innerHTML = `<section id="ai-skills"${hidden ? ' hidden' : ''}></section>`;
    document.body.append(panel);
    const status = vi.fn(); mountSkills(panel, status); await flush();
    return { panel, status };
}
beforeEach(() => { vi.useFakeTimers(); document.body.replaceChildren(); });
afterEach(() => { document.body.replaceChildren(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); install(); });

describe('官方技能的冷启动与桥就绪', () => {
    it('首次后端清单缺官方项时仍然可见，等待登记后自动重读，保留项目补充', async () => {
        const fake = makeBridge([supplemental()]); await mount(fake.bridge);
        expect(find<HTMLSelectElement>('skill-select').options[0].value).toBe('builtin');
        expect(find('skill-meta').value).toContain('等待宿主同步');
        expect(find('skill-enabled')).toBeDisabled();
        expect([...find<HTMLSelectElement>('skill-file').options].map(option => option.value)).toEqual(['SKILL.md', ...Object.keys(builtin.references)]);
        expect(find('skill-content').value).toContain('内置技能尚未就绪');
        fake.state.entries = [official(), supplemental()];
        await vi.advanceTimersByTimeAsync(500);
        expect(find('skill-enabled')).toBeEnabled();
        expect(find('skill-enabled')).toBeChecked();
        expect(find('skill-content').value).toBe(builtin.instructions);
        expect([...find<HTMLSelectElement>('skill-select').options].map(option => option.value)).toEqual(['builtin', 'project-previs-1']);
        expect(fake.skills.mock.calls.filter(([request]) => request.action === 'list')).toHaveLength(2);
    });

    it('无桥时读真实随包文件，桥晚装的ready事件恢复后端状态与正文', async () => {
        await mount();
        expect(find('skill-content').value).toBe(builtin.instructions);
        expect(find('skill-meta').value).toContain('随包说明只读');
        expect(find('skill-enabled')).toBeDisabled();
        const path = 'references/camera.md';
        find('skill-file').value = path; find('skill-file').dispatchEvent(new Event('change')); await flush();
        expect(find('skill-content').value).toBe(builtin.references[path]);
        const fake = makeBridge([official(false), supplemental()]); install(fake.bridge);
        window.dispatchEvent(new Event('director-desktop-ready')); await flush();
        expect(find('skill-enabled')).not.toBeChecked();
        expect(find('skill-enabled')).toBeEnabled();
        expect(find('skill-file').value).toBe(path);
        expect(fake.skills).toHaveBeenCalledWith({ action: 'read', id: 'builtin', path });
        expect(find('skill-meta').value).toContain('已停用');
    });

    it('没有ready事件也能在有限启动重试时发现晚装桥', async () => {
        await mount(); const fake = makeBridge(); install(fake.bridge);
        await vi.advanceTimersByTimeAsync(500);
        expect(fake.skills).toHaveBeenCalledWith({ action: 'list' });
        expect(find('skill-content').value).toBe(builtin.instructions);
        expect(find('skill-enabled')).toBeEnabled();
    });

    it('握手通知到达时首个清单还在途，会串行补拉而不会停在旧清单', async () => {
        const fake = makeBridge();
        let resolveList: ((result: Result) => void) | undefined;
        let first = true;
        const initial = fake.skills.getMockImplementation()!;
        fake.skills.mockImplementation(request => {
            if (request.action === 'list' && first) { first = false; return new Promise(resolve => { resolveList = resolve; }); }
            return initial(request);
        });
        await mount(fake.bridge);
        window.dispatchEvent(new Event('director-desktop-ready'));
        resolveList!({ ok: true, data: { skills: [supplemental()] } }); await flush();
        expect(fake.skills.mock.calls.filter(([request]) => request.action === 'list')).toHaveLength(2);
        expect(find('skill-enabled')).toBeEnabled();
        expect(find('skill-content').value).toBe(builtin.instructions);
    });

    it('每次重新打开技能页会同步清单，并保留当前官方附件', async () => {
        const fake = makeBridge(); const { panel } = await mount(fake.bridge, true);
        find('skill-file').value = 'references/previs.md'; find('skill-file').dispatchEvent(new Event('change')); await flush();
        const calls = fake.skills.mock.calls.filter(([request]) => request.action === 'list').length;
        panel.hidden = false; find<HTMLElement>('ai-skills').hidden = false; panel.dataset.aiPage = 'skills'; await flush();
        expect(fake.skills.mock.calls.filter(([request]) => request.action === 'list').length).toBe(calls + 1);
        expect(find('skill-file').value).toBe('references/previs.md');
        expect(find('skill-content').value).toBe(builtin.references['references/previs.md']);
    });
});

describe('官方项、附件与用户开关', () => {
    it('官方与previs-props分开标注，用户技能不冒充官方、也不被删除', async () => {
        const fake = makeBridge(); await mount(fake.bridge);
        const select = find<HTMLSelectElement>('skill-select');
        expect(select.options[0].value).toBe('builtin');
        expect(select.options[0].parentElement).toHaveAttribute('label', '上游官方 · 内置');
        const supplement = [...select.options].find(option => option.value === 'project-previs-1')!;
        expect(supplement.parentElement).toHaveAttribute('label', '本项目补充');
        select.value = 'project-previs-1'; select.dispatchEvent(new Event('change')); await flush();
        expect(find('skill-meta').value).toContain('本项目补充 · 预演道具参考');
        expect(find('skill-meta').value).not.toContain('上游官方');
        expect(find('skill-content').value).toBe('previs-props 的内容：SKILL.md');
        expect(find('skill-remove')).toBeEnabled();
        expect(fake.skills.mock.calls.some(([request]) => request.action === 'remove')).toBe(false);
    });

    it('独立图片共创技能显示在补充组，开关按后端保存且随软件保留', async () => {
        const fake = makeBridge([official(), supplemental(), imageSkill()]); await mount(fake.bridge);
        const select = find<HTMLSelectElement>('skill-select');
        const option = [...select.options].find(item => item.value === 'image-previs')!;
        expect(option).toHaveTextContent('image-previs · 图片分镜共创预演 · 已启用');
        expect(option.parentElement).toHaveAttribute('label', '本项目补充');
        select.value = 'image-previs'; select.dispatchEvent(new Event('change')); await flush();
        expect(fake.skills).toHaveBeenCalledWith({ action: 'read', id: 'image-previs', path: 'SKILL.md' });
        expect(find('skill-meta').value).toContain('本项目补充 · 图片分镜共创预演');
        expect(find('skill-enabled')).toBeChecked(); expect(find('skill-remove')).toBeDisabled();
        find('skill-enabled').checked = false; find('skill-enabled').dispatchEvent(new Event('change')); await flush();
        expect(fake.skills).toHaveBeenCalledWith({ action: 'enable', id: 'image-previs', enabled: false });
        expect(find('skill-enabled')).not.toBeChecked();
        expect(fake.state.entries.find(item => item.id === 'builtin')!.enabled).toBe(true);
    });

    it('官方总览与全部附件逐个从桥读取，独立图片技能不冒充官方附件', async () => {
        const fake = makeBridge(); await mount(fake.bridge);
        const files = ['SKILL.md', ...Object.keys(builtin.references)]; expect(files).not.toContain('references/image-previs.md');
        for (const path of files) {
            find('skill-file').value = path; find('skill-file').dispatchEvent(new Event('change')); await flush();
            expect(fake.skills).toHaveBeenCalledWith({ action: 'read', id: 'builtin', path });
            expect(find('skill-content').value).toBe(path === 'SKILL.md' ? builtin.instructions : builtin.references[path]);
        }
    });

    it('较慢的上一个附件回包不能覆盖用户刚选的附件', async () => {
        const fake = makeBridge(); await mount(fake.bridge);
        let resolveRead: ((result: Result) => void) | undefined;
        const initial = fake.skills.getMockImplementation()!;
        fake.skills.mockImplementation(request => request.action === 'read' && request.path === 'references/camera.md'
            ? new Promise(resolve => { resolveRead = resolve; }) : initial(request));
        find('skill-file').value = 'references/camera.md'; find('skill-file').dispatchEvent(new Event('change')); await flush();
        find('skill-file').value = 'references/media.md'; find('skill-file').dispatchEvent(new Event('change')); await flush();
        resolveRead!({ ok: true, data: { instructions: builtin.references['references/camera.md'] } }); await flush();
        expect(find('skill-content').value).toBe(builtin.references['references/media.md']);
    });

    it('官方启用状态按后端保存结果显示，内置项不能删除或重新加载', async () => {
        const fake = makeBridge(); await mount(fake.bridge);
        expect(find('skill-enabled')).toBeChecked();
        expect(find('skill-remove')).toBeDisabled(); expect(find('skill-reload')).toBeDisabled();
        find('skill-enabled').checked = false; find('skill-enabled').dispatchEvent(new Event('change')); await flush();
        expect(fake.skills).toHaveBeenCalledWith({ action: 'enable', id: 'builtin', enabled: false });
        expect(find('skill-enabled')).not.toBeChecked();
        expect(find('skill-meta').value).toContain('已停用');
        expect(fake.state.entries.find(entry => entry.id === 'project-previs-1')!.enabled).toBe(true);
    });

    it('开关保存失败时还原后端状态，不假装官方技能已停用', async () => {
        const fake = makeBridge(); const { status } = await mount(fake.bridge);
        fake.state.enableError = '技能配置无法写入';
        find('skill-enabled').checked = false; find('skill-enabled').dispatchEvent(new Event('change')); await flush();
        expect(find('skill-enabled')).toBeChecked(); expect(status).toHaveBeenCalledWith('技能配置无法写入');
        expect(find('skill-sync-status')).toHaveTextContent('技能配置无法写入');
    });

    it('有桥时读失败必须展示实际原因，不能用随包正文掩盖', async () => {
        const fake = makeBridge(); await mount(fake.bridge);
        fake.state.readError = '此技能已停用，请遵循用户当前启用的技能';
        find('skill-file').value = 'references/editing.md'; find('skill-file').dispatchEvent(new Event('change')); await flush();
        expect(find('skill-content').value).toContain('读取失败：此技能已停用');
        expect(find('skill-content').value).not.toBe(builtin.references['references/editing.md']);
    });

    it('任务运行中禁止改技能开关，但仍允许查看官方附件', async () => {
        const fake = makeBridge(); const { panel } = await mount(fake.bridge);
        panel.dataset.running = 'true'; await flush();
        expect(find('skill-enabled')).toBeDisabled();
        expect(find('skill-file')).toBeEnabled();
        find('skill-file').value = 'references/previs.md'; find('skill-file').dispatchEvent(new Event('change')); await flush();
        expect(find('skill-content').value).toBe(builtin.references['references/previs.md']);
        panel.dataset.running = 'false'; await flush(); expect(find('skill-enabled')).toBeEnabled();
    });

    it('取消导入不会让官方技能与已安装项目技能消失', async () => {
        const fake = makeBridge(); await mount(fake.bridge);
        document.querySelector<HTMLButtonElement>('[data-skill-import="file"]')!.click(); await flush();
        expect([...find<HTMLSelectElement>('skill-select').options].map(option => option.value)).toEqual(['builtin', 'project-previs-1', 'custom-1']);
        expect(fake.skills).toHaveBeenCalledWith({ action: 'import', kind: 'file' });
    });
});
