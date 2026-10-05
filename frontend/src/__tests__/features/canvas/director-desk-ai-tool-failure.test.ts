// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 导演台 AI 面板：失败的工具卡片在折叠行上直接写原因。
 *
 * 起因是一次真实的端到端跑批：对话记录里连着两条 `director_apply`，一条
 * `completed` 一条 `failed`，但折叠行上两条都只显示工具名和状态 —— 「failed」
 * 什么都没说，原因躺在展开层里。人扫一眼只看到一排 failed，得逐条点开才知道
 * 错在哪，而实际原因是「不支持摄影机字段」这种一眼能判断是否值得重试的信息。
 *
 * 被测实现在 vendor 里（`frontend/vendor/director-desk/src/ui/ai-transcript.ts`），
 * vendor 不装测试框架，所以断言走源码里的纯函数，行为改了就红。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** vendor 是 frontend/vendor/…，而 vitest 的 cwd 就是 frontend/。 */
const SOURCE = resolve(process.cwd(), 'vendor/director-desk/src/ui/ai-transcript.ts');

/** vendor 里是 TS，这里只做文本级取证：确认逻辑在、形状对。 */
const source = readFileSync(SOURCE, 'utf8');

/** 镜像 vendor 侧 FAILED_STATUSES：失败语义不止 failed 一种。 */
const FAILED_STATUSES = new Set(['failed', 'error', 'unknown', 'timeout', 'aborted', 'rejected']);

/** 从一段回包 / 错误文本里提取人能读的第一句。镜像 vendor 侧的实现。 */
function reasonFrom(text?: string): string {
    if (!text) return '';
    let body = text.trim();
    const json = body.match(/"error"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (json) body = json[1].replace(/\\"/g, '"');
    else if (/^["']/.test(body) && /["']$/.test(body) && body.length > 1) {
        body = body.slice(1, -1);
    }
    for (const prefix of ['director_desk_v2_error:', 'director_desk_error:']) {
        if (body.startsWith(prefix)) body = body.slice(prefix.length).trim();
    }
    const sentence = body.split(/[。\n]/)[0].trim();
    return sentence.length > 72 ? `${sentence.slice(0, 72)}…` : sentence;
}

describe('真实跑批里出现过的形状', () => {
    it('宿主把错误包成引号字符串时也要剥掉外壳', () => {
        // 端到端跑批实测拿到的就是这一形状：整段带引号，且引号里还有前缀
        const raw = '"director_desk_v2_error: operations[10]: 不支持摄影机字段：patch.camera.path"';
        expect(reasonFrom(raw)).toBe('operations[10]: 不支持摄影机字段：patch.camera.path');
    });

    it('状态是 unknown 也要按失败处理', () => {
        // 后端恢复历史时把丢失的工具帧标成 unknown —— 早先只认 failed，
        // 那条「不支持摄影机字段」因此在最需要看见的时候没显示出来
        expect(FAILED_STATUSES.has('unknown')).toBe(true);
        expect(FAILED_STATUSES.has('error')).toBe(true);
        expect(FAILED_STATUSES.has('timeout')).toBe(true);
        expect(FAILED_STATUSES.has('completed')).toBe(false);
    });
});

describe('失败原因提取', () => {
    it('从宿主回包 JSON 里取出 error', () => {
        const raw = '{"ok":false,"error":"operations[10]: 不支持摄影机字段：patch.camera.path"}';
        expect(reasonFrom(raw)).toBe('operations[10]: 不支持摄影机字段：patch.camera.path');
    });

    it('剥掉传输层前缀', () => {
        expect(reasonFrom('director_desk_v2_error: 未知工具参数：director_apply.operations[14].rotation')).toBe(
            '未知工具参数：director_apply.operations[14].rotation',
        );
    });

    it('空输入返回空串', () => {
        expect(reasonFrom(undefined)).toBe('');
        expect(reasonFrom('   ')).toBe('');
    });
});

describe('工具卡片折叠行', () => {
    it('折叠行文本由 toolSummaryLine 生成', () => {
        expect(source).toContain('toolSummaryLine');
    });

    it('失败态加了 is-failed 类供 CSS 着色', () => {
        expect(source).toContain("classList.add('is-failed')");
        // 判据必须走 isFailedStatus，不能写死 'failed'：恢复历史时工具帧丢失
        // 标成 unknown，只认 failed 会让红色高亮在最需要的时候不出现
        expect(source).toContain('isFailedStatus(message.toolStatus)');
        expect(source).not.toContain("message.toolStatus === 'failed'");
    });

    it('有原因才往折叠行塞，成功态保持短行', () => {
        // 成功态必须保持「名 · 状态」短行，否则每张卡片都拖着一段 JSON 摘要。
        // 判据是「提不提得出原因」，不是状态名。
        expect(source).toContain('const reason = reasonFrom(message.summaryText)');
        expect(source).toContain('if (!reason) return head;');
    });

    it('两处失败判断共用同一个函数，不会各自漂移', () => {
        // 曾经出现过：折叠行用 6 状态集合、高亮只认 failed，两边不一致，
        // 结果是「有原因但不高亮」。共用函数是唯一的防漂移手段。
        const uses = source.match(/isFailedStatus\(/g) ?? [];
        expect(uses.length).toBeGreaterThanOrEqual(3); // 1 处定义 + 2 处调用
        expect(source).toMatch(/function isFailedStatus[\s\S]{0,120}FAILED_STATUSES\.has/);
    });

    it('展开层仍保留完整摘要', () => {
        expect(source).toContain('message.summaryText');
        expect(source).toContain('pre.textContent = message.summaryText');
    });
});