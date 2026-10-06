// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeAll, describe, expect, it } from 'vitest';

/** 通过 Vite 运行 vendor 真正的报告函数，宿主 tsc 不递归检查整个上游工程。 */
const modules = import.meta.glob('../../../../vendor/director-desk/src/automation/{previs-quality,read-scene,validate}.ts');

type Warning = { code: string; field: string; entityId?: string; start?: number; end?: number };
type Report = {
  status: string;
  duration: number;
  targetDuration?: number;
  warnings: Warning[];
  unchecked: string[];
};
let previsQuality: (project: unknown, targetDuration?: number) => Report;
let readScene: (ctx: unknown, revision: number, options: unknown) => Record<string, unknown>;
let validateToolInput: (name: string, input: unknown) => void;

beforeAll(async () => {
  const quality = await modules['../../../../vendor/director-desk/src/automation/previs-quality.ts']() as {
    previsQuality: typeof previsQuality;
  };
  const reader = await modules['../../../../vendor/director-desk/src/automation/read-scene.ts']() as {
    readScene: typeof readScene;
  };
  previsQuality = quality.previsQuality;
  readScene = reader.readScene;
  const validator = await modules['../../../../vendor/director-desk/src/automation/validate.ts']() as {
    validateToolInput: typeof validateToolInput;
  };
  validateToolInput = validator.validateToolInput;
});

/** 与真实存档一致：实体动作、走位、姿态各有独立时钟。 */
function actor() {
  return {
    id: 'lin-wan', name: '林晚', kind: 'actor', asset: 'woman',
    position: [-3, 0, 1.8],
    path: {
      smooth: false,
      points: [
        { time: 0, position: [-3, 0, 1.8] },
        { time: 2.5, position: [-1.6, 0, 0.3] },
        { time: 4.2, position: [-0.8, 0, 0.1] },
      ],
      sections: undefined as { start: number; end: number; from: number; to: number }[] | undefined,
    },
    clips: [{ id: 'walk', action: 'walk', start: 0, end: 4.2, speed: 1 }] as {
      id: string; action: string; start: number; end: number; speed: number;
      retarget?: { resourceId: string; index: number };
    }[],
    poseKeys: [] as { time: number; pose: { headYaw: number } }[],
  };
}

function project() {
  return {
    name: '咖啡馆', duration: 8.2, fps: 24, aspect: '16:9',
    room: { enabled: true, width: 8, depth: 8, height: 3 },
    entities: [actor(), { id: 'camera-1', kind: 'camera', name: '入口全景', asset: 'camera' }] as [ReturnType<typeof actor>, { id: string; kind: string; name: string; asset: string }],
    cuts: [{ time: 0, cameraId: 'camera-1' }],
    resources: [{ id: 'motion-source' }], references: [],
  };
}

function warnings(report: Report, code: string) {
  return report.warnings.filter(warning => warning.code === code);
}

describe('分镜预演时间与动作报告', () => {
  it('实际存档的 14.5 秒、0—4.2 秒走位配 0—12 秒待机应同时报告两类问题', () => {
    const draft = project();
    draft.duration = 14.5;
    draft.entities[0].clips = [
      { id: 'idle', action: 'idle', start: 0, end: 12, speed: 1 },
      { id: 'late-walk', action: 'retarget', start: 12, end: 14.5, speed: 1 },
    ];
    const before = JSON.stringify(draft);
    const report = previsQuality(draft, 8.2);

    expect(report).toMatchObject({ status: 'needs-review', duration: 14.5, targetDuration: 8.2 });
    expect(warnings(report, 'DURATION_MISMATCH')).toHaveLength(1);
    expect(warnings(report, 'MOVEMENT_ACTION_MISSING')).toEqual([
      expect.objectContaining({ entityId: 'lin-wan', start: 0, end: 4.2 }),
    ]);
    expect(JSON.stringify(draft)).toBe(before);
  });

  it('走位配同期 walk 且总时长一致时通过；人物走完后站定无需强行延长路径', () => {
    const report = previsQuality(project(), 8.2);
    expect(report.warnings).toEqual([]);
    expect(report.status).toBe('checked');
    expect(report.unchecked.join(' ')).toMatch(/互动/);
    expect(report.unchecked.join(' ')).toMatch(/碰撞/);
  });

  it('动作只覆盖半程时报告具体缺失区间，而不把有一小段走路当作整程匹配', () => {
    const draft = project();
    draft.entities[0].clips[0].end = 2.5;
    expect(warnings(previsQuality(draft), 'MOVEMENT_ACTION_MISSING')).toEqual([
      expect.objectContaining({ start: 2.5, end: 4.2 }),
    ]);
  });

  it('重复位置形成站定区间时允许待机，随后移动仍需同期动作', () => {
    const draft = project();
    draft.entities[0].path.points = [
      { time: 0, position: [0, 0, 0] },
      { time: 2, position: [0, 0, 0] },
      { time: 4, position: [1, 0, 0] },
    ];
    draft.entities[0].clips = [
      { id: 'idle', action: 'idle', start: 0, end: 2, speed: 1 },
      { id: 'walk', action: 'walk', start: 2, end: 4, speed: 1 },
    ];
    expect(previsQuality(draft).warnings).toEqual([]);
  });

  it('路径裁剪使用场景时钟验动作，合法的源路径时长可长于当前戏段', () => {
    const draft = project();
    draft.entities[0].path.points = [
      { time: 0, position: [0, 0, 0] },
      { time: 20, position: [2, 0, 0] },
    ];
    draft.entities[0].path.sections = [{ start: 1, end: 3, from: 10, to: 20 }];
    draft.entities[0].clips = [{ id: 'walk', action: 'walk', start: 1, end: 3, speed: 1 }];
    expect(previsQuality(draft).warnings).toEqual([]);
    draft.entities[0].clips[0].start = 2;
    expect(warnings(previsQuality(draft), 'MOVEMENT_ACTION_MISSING')).toEqual([
      expect.objectContaining({ start: 1, end: 2 }),
    ]);
  });

  it('切镜只能引用摄影机，末帧切镜及人物路径、动作、姿态超出戏段时长都可定位', () => {
    const draft = project();
    draft.cuts.push({ time: 8.2, cameraId: 'lin-wan' });
    draft.entities[0].path.points[2].time = 9;
    draft.entities[0].clips[0].end = 9;
    draft.entities[0].poseKeys.push({ time: 9, pose: { headYaw: 30 } });
    const report = previsQuality(draft);
    expect(warnings(report, 'CUT_CAMERA_MISSING')).toEqual([
      expect.objectContaining({ field: 'cuts[1].cameraId' }),
    ]);
    expect(warnings(report, 'TIME_OUT_OF_RANGE').map(warning => warning.field)).toEqual(
      expect.arrayContaining(['cuts[1].time', 'path.points[2].time', 'clips[0].end', 'poseKeys[0].time']),
    );
  });

  it('同步导入动作需实际存在源资源，报告仍明确没有验证该素材的动作语义', () => {
    const draft = project();
    draft.entities[0].clips = [{
      id: 'retarget-walk', action: 'retarget', start: 0, end: 4.2, speed: 1,
      retarget: { resourceId: 'motion-source', index: 2 },
    }];
    const report = previsQuality(draft);
    expect(warnings(report, 'MOVEMENT_ACTION_MISSING')).toEqual([]);
    expect(report.unchecked.join(' ')).toMatch(/动作语义/);
    draft.resources = [];
    expect(warnings(previsQuality(draft), 'MOVEMENT_ACTION_MISSING')).toHaveLength(1);
  });

  it('路径片段超出源时钟或场景时钟时报告对应边界', () => {
    const draft = project();
    draft.entities[0].path.sections = [{ start: 1, end: 9, from: 0, to: 20 }];
    const fields = warnings(previsQuality(draft), 'TIME_OUT_OF_RANGE').map(warning => warning.field);
    expect(fields).toEqual(expect.arrayContaining(['path.sections[0].end', 'path.sections[0].source']));
  });

  it('终点路径与动作可恰好结束在 duration，但切镜首段需从零开始且时间递增', () => {
    const draft = project();
    draft.entities[0].path.points[2].time = 8.2;
    draft.entities[0].clips[0].end = 8.2;
    draft.entities[0].poseKeys.push({ time: 8.2, pose: { headYaw: 30 } });
    expect(warnings(previsQuality(draft), 'TIME_OUT_OF_RANGE')).toEqual([]);
    draft.cuts = [{ time: 1, cameraId: 'camera-1' }, { time: 1, cameraId: 'camera-1' }];
    const report = previsQuality(draft);
    expect(warnings(report, 'CUT_START_MISSING')).toHaveLength(1);
    expect(warnings(report, 'TIME_ORDER_INVALID')).toHaveLength(1);
  });

  it('没有分镜目标时长时只核实际戏段，不捏造时长不匹配', () => {
    const draft = project();
    draft.duration = 14.5;
    const report = previsQuality(draft);
    expect(report).not.toHaveProperty('targetDuration');
    expect(warnings(report, 'DURATION_MISMATCH')).toEqual([]);
    expect(report.unchecked.join(' ')).toMatch(/目标时长/);
  });

  it('无效目标时长应显式拒绝，避免 NaN 或零值被当作验收依据', () => {
    for (const target of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => previsQuality(project(), target)).toThrow(/目标时长/);
    }
  });
});

describe('director_read 的分镜报告入口', () => {
  it('只有请求 scene 时附报告，并检查完整活动场景而非 ids 过滤后的对象', () => {
    const draft = project();
    draft.duration = 14.5;
    const ctx = { project: draft, time: 0, preview: 'camera-1', selected: null, scenes: { list: () => [] } };
    const request = { sections: ['scene', 'entities', 'cuts', 'production'], ids: ['camera-1'], details: true, targetDuration: 8.2 };
    expect(() => validateToolInput('director_read', request)).not.toThrow();
    const result = readScene(ctx, 7, request);
    expect(result.previsQuality).toMatchObject({
      targetDuration: 8.2,
      warnings: expect.arrayContaining([expect.objectContaining({ code: 'DURATION_MISMATCH' })]),
    });
    expect(readScene(ctx, 7, { sections: ['entities'] })).not.toHaveProperty('previsQuality');
  });
});
