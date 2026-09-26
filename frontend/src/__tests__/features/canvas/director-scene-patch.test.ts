import { describe, expect, it } from 'vitest';

import {
  applyDirectorSceneIntent,
  buildCameraKeyframes,
  parseDirectorSceneIntent,
  stripDirectorSceneIntent,
  parseDirectorProposals,
  stripDirectorProposals,
  hasDirectorSceneBlock,
  summarizeDirectorSceneIntent,
  type DeskProject,
} from '@/features/canvas/nodes/directorScenePatch';

const baseProject = (): DeskProject => ({
  objects: [
    { id: 'char_default_a', name: '角色01', kind: 'character', bodyType: 'mannequin' },
    { id: 'user_prop_1', name: '桌子', kind: 'prop' },
  ],
  cameras: [
    {
      id: 'cam_1',
      name: '机位01',
      fov: 50,
      transform: { position: [0, 1.7178, 7.2122], rotation: [0, 0, 0], scale: [1, 1, 1] },
      target: [0, 1.05, 0],
      motionPath: { duration: 6, loop: false, interpolation: 'smooth', easing: 'ease-in-out', keyframes: [] },
    },
    { id: 'cam_2', name: '机位02', fov: 50, transform: { position: [0, 1.7178, 7.2122], rotation: [0, 0, 0], scale: [1, 1, 1] }, target: [0, 1.05, 0] },
  ],
  activeCameraId: 'cam_2',
});

describe('applyDirectorSceneIntent — 角色摆位', () => {
  it('追加 AI 角色，保留用户手摆的物体', () => {
    const p = applyDirectorSceneIntent(baseProject(), {
      type: 'director-desk-scene',
      characters: [{ pose: 'sit', at: [2, -1], facing: 90, color: '#ff0000' }],
    });
    const ids = p.objects!.map((o) => o.id);
    expect(ids).toContain('user_prop_1'); // 用户的道具没被删
    const gen = p.objects!.find((o) => o.id.startsWith('aigen_char_'))!;
    expect(gen.kind).toBe('character');
    expect(gen.bodyType).toBe('mannequin');
    expect((gen.characterRig as { posePresetId: string }).posePresetId).toBe('sit');
    expect((gen.transform as { position: number[] }).position).toEqual([2, 0, -1]); // y 恒 0
    expect(gen.color).toBe('#ff0000');
  });

  it('重新生成会替换上一批 AI 角色，而不是无限叠加', () => {
    let p = applyDirectorSceneIntent(baseProject(), {
      type: 'director-desk-scene',
      characters: [{ at: [1, 0] }, { at: [2, 0] }, { at: [3, 0] }],
    });
    expect(p.objects!.filter((o) => o.id.startsWith('aigen_char_'))).toHaveLength(3);
    p = applyDirectorSceneIntent(p, { type: 'director-desk-scene', characters: [{ at: [0, 0] }] });
    expect(p.objects!.filter((o) => o.id.startsWith('aigen_char_'))).toHaveLength(1);
  });

  it('非法字段回落安全默认，不抛', () => {
    const p = applyDirectorSceneIntent(baseProject(), {
      type: 'director-desk-scene',
      characters: [{ pose: '', at: [Number.NaN, 5] as [number, number], color: 'not-a-hex' }],
    });
    const gen = p.objects!.find((o) => o.id.startsWith('aigen_char_'))!;
    expect((gen.characterRig as { posePresetId: string }).posePresetId).toBe('stand');
    expect(gen.color).toBe('#4F8EF7');
    expect((gen.transform as { position: number[] }).position).toEqual([0, 0, 5]); // NaN→0
  });

  it('不改入参（纯函数）', () => {
    const src = baseProject();
    const before = JSON.stringify(src);
    applyDirectorSceneIntent(src, { type: 'director-desk-scene', characters: [{ at: [9, 9] }] });
    expect(JSON.stringify(src)).toBe(before);
  });
});

describe('applyDirectorSceneIntent — 骨骼姿势 controls（按描述现算）', () => {
  const rig = (p: DeskProject) =>
    (p.objects!.find((o) => o.id.startsWith('aigen_char_'))!.characterRig as {
      controls: Record<string, number>;
    }).controls;

  it('白名单骨骼名透传，写进 characterRig.controls', () => {
    const p = applyDirectorSceneIntent(baseProject(), {
      type: 'director-desk-scene',
      characters: [{ controls: { 'leftShoulder.spread': -85, 'rightShoulder.spread': 85 } }],
    });
    expect(rig(p)).toEqual({ 'leftShoulder.spread': -85, 'rightShoulder.spread': 85 });
  });

  it('丢掉不在白名单的骨骼名（防拼错字段崩导演台）', () => {
    const p = applyDirectorSceneIntent(baseProject(), {
      type: 'director-desk-scene',
      characters: [{ controls: { 'leftShoulder.spread': -80, 'bogus.bone': 50, evil: 1 } }],
    });
    expect(rig(p)).toEqual({ 'leftShoulder.spread': -80 });
  });

  it('角度 clamp 到 ±180，非数丢弃', () => {
    const p = applyDirectorSceneIntent(baseProject(), {
      type: 'director-desk-scene',
      characters: [
        {
          controls: {
            'head.yaw': 999,
            'torso.pitch': -400,
            'leftElbow.bend': Number.NaN,
            'rightElbow.bend': '30' as unknown as number,
          },
        },
      ],
    });
    expect(rig(p)).toEqual({ 'head.yaw': 180, 'torso.pitch': -180 });
  });

  it('没给 controls 时为空对象（不破坏 rig）', () => {
    const p = applyDirectorSceneIntent(baseProject(), {
      type: 'director-desk-scene',
      characters: [{ at: [0, 0] }],
    });
    expect(rig(p)).toEqual({});
  });

  it('route 路线展开成 walk-cycle motionPath，起点用 route[0]', () => {
    const p = applyDirectorSceneIntent(baseProject(), {
      type: 'director-desk-scene',
      characters: [{ route: [[-2, 2], [0, 0], [1, -1]], routeDuration: 8 }],
    });
    const gen = p.objects!.find((o) => o.id.startsWith('aigen_char_'))!;
    const mp = gen.motionPath as {
      duration: number;
      keyframes: Array<{ time: number; actionPresetId: string; facingMode: string; transform: { position: number[] } }>;
    };
    expect(mp.duration).toBe(8);
    expect(mp.keyframes).toHaveLength(3);
    expect(mp.keyframes.map((k) => k.time)).toEqual([0, 1, 2]); // 序号，非秒
    expect(mp.keyframes.every((k) => k.actionPresetId === 'walk-cycle')).toBe(true);
    expect(mp.keyframes.every((k) => k.facingMode === 'path')).toBe(true);
    expect(mp.keyframes[0].transform.position).toEqual([-2, 0, 2]); // route[0]，y=0
    expect((gen.transform as { position: number[] }).position).toEqual([-2, 0, 2]); // 起点对齐 route[0]
  });

  it('route 少于 2 点忽略（不建 motionPath），回落 at', () => {
    const p = applyDirectorSceneIntent(baseProject(), {
      type: 'director-desk-scene',
      characters: [{ route: [[1, 1]] as Array<[number, number]>, at: [3, 3] }],
    });
    const gen = p.objects!.find((o) => o.id.startsWith('aigen_char_'))!;
    expect(gen.motionPath).toBeUndefined();
    expect((gen.transform as { position: number[] }).position).toEqual([3, 0, 3]);
  });

  it('routeDuration 缺省为 5', () => {
    const p = applyDirectorSceneIntent(baseProject(), {
      type: 'director-desk-scene',
      characters: [{ route: [[0, 0], [2, 0]] }],
    });
    const gen = p.objects!.find((o) => o.id.startsWith('aigen_char_'))!;
    expect((gen.motionPath as { duration: number }).duration).toBe(5);
  });

  it('嵌套格式 {关节:{轴:值}} 自动拍平成扁平点号（LLM 常这么产）', () => {
    const p = applyDirectorSceneIntent(baseProject(), {
      type: 'director-desk-scene',
      // 这是 agent 真实产出过的格式
      characters: [
        {
          controls: {
            rightShoulder: { pitch: -15, spread: 40 },
            rightElbow: { bend: 115 },
            head: { yaw: -14 },
            bogus: { pitch: 5 }, // 非白名单关节 → 丢
          } as unknown as Record<string, number>,
        },
      ],
    });
    expect(rig(p)).toEqual({
      'rightShoulder.pitch': -15,
      'rightShoulder.spread': 40,
      'rightElbow.bend': 115,
      'head.yaw': -14,
    });
  });
});

describe('applyDirectorSceneIntent — 运镜写活动相机', () => {
  it('orbit 写到 activeCameraId(cam_2) 而不是 cam_1', () => {
    const p = applyDirectorSceneIntent(baseProject(), {
      type: 'director-desk-scene',
      camera: { move: 'orbit-left', duration: 8 },
    });
    const cam1 = p.cameras!.find((c) => c.id === 'cam_1')!;
    const cam2 = p.cameras!.find((c) => c.id === 'cam_2')!;
    expect(cam1.motionPath!.keyframes).toHaveLength(0); // 非活动，不动
    expect(cam2.motionPath!.keyframes!.length).toBeGreaterThanOrEqual(2);
    expect(cam2.motionPath!.duration).toBe(8);
  });

  it('activeCameraId 缺失时回落第一台', () => {
    const src = baseProject();
    delete src.activeCameraId;
    const p = applyDirectorSceneIntent(src, { type: 'director-desk-scene', camera: { move: 'dolly-in' } });
    expect(p.cameras![0].motionPath!.keyframes!.length).toBe(2);
  });
});

describe('buildCameraKeyframes — 运镜几何', () => {
  const cam = {
    id: 'c',
    fov: 50,
    transform: {
      position: [0, 1.7, 7] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    },
    target: [0, 1, 0] as [number, number, number],
  };

  it('time 是递增序号(0,1,2…)不是秒', () => {
    const kf = buildCameraKeyframes(cam, 'orbit-right');
    expect(kf.map((k) => k.time)).toEqual([0, 1, 2, 3]);
  });

  it('orbit 保持到 target 的水平半径不变', () => {
    const kf = buildCameraKeyframes(cam, 'orbit-left');
    const r = (p: number[]) => Math.hypot(p[0] - 0, p[2] - 0);
    const r0 = r(kf[0].position);
    for (const k of kf) expect(r(k.position)).toBeCloseTo(r0, 4);
  });

  it('dolly-in 让相机更靠近 target，dolly-out 更远', () => {
    const dist = (p: number[]) => Math.hypot(p[0], p[1] - 1, p[2]);
    const inKf = buildCameraKeyframes(cam, 'dolly-in');
    const outKf = buildCameraKeyframes(cam, 'dolly-out');
    expect(dist(inKf[1].position)).toBeLessThan(dist(inKf[0].position));
    expect(dist(outKf[1].position)).toBeGreaterThan(dist(outKf[0].position));
  });

  it('static 不产生关键帧', () => {
    expect(buildCameraKeyframes(cam, 'static')).toHaveLength(0);
  });

  it('pan 位置不动、只转 target', () => {
    const kf = buildCameraKeyframes(cam, 'pan-left');
    expect(kf[0].position).toEqual(kf[1].position);
    expect(kf[0].target).not.toEqual(kf[1].target);
  });
});

describe('parse / strip fenced 块', () => {
  const reply = '好的，我来摆一下。\n```dd-scene\n{"type":"director-desk-scene","camera":{"move":"orbit-left","duration":6}}\n```\n已经生成运镜。';

  it('从回复里抽出 intent', () => {
    const intent = parseDirectorSceneIntent(reply)!;
    expect(intent.type).toBe('director-desk-scene');
    expect(intent.camera!.move).toBe('orbit-left');
  });

  it('裸 json fence 也能解析', () => {
    const intent = parseDirectorSceneIntent('```json\n{"type":"director-desk-scene","characters":[]}\n```')!;
    expect(intent).not.toBeNull();
    expect(intent.type).toBe('director-desk-scene');
  });

  it('无块 / 坏 JSON 返回 null，不抛', () => {
    expect(parseDirectorSceneIntent('就是聊聊天')).toBeNull();
    expect(parseDirectorSceneIntent('```dd-scene\n{坏的 json\n```')).toBeNull();
  });

  it('渲染时把块剥掉，只留散文', () => {
    const clean = stripDirectorSceneIntent(reply);
    expect(clean).not.toContain('director-desk-scene');
    expect(clean).toContain('好的，我来摆一下');
    expect(clean).toContain('已经生成运镜');
  });
});

describe('applyDirectorSceneToStorage — localStorage 注入胶水', () => {
  const KEY = 'storyai-3d-director-desk-demo:node-x';
  const fakeStorage = (init: Record<string, string>) => {
    const map = new Map(Object.entries(init));
    return {
      map,
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  };

  it('工程存在时应用 intent 并写回，返回 true', async () => {
    const { applyDirectorSceneToStorage } = await import('@/features/canvas/nodes/DirectorDeskNode');
    const s = fakeStorage({
      [KEY]: JSON.stringify({ viewMode: 'x', project: { objects: [], cameras: [], activeCameraId: 'c1' } }),
    });
    const ok = applyDirectorSceneToStorage('node-x', { type: 'director-desk-scene', characters: [{ at: [1, 2] }] }, s);
    expect(ok).toBe(true);
    const written = JSON.parse(s.getItem(KEY)!);
    expect(written.viewMode).toBe('x'); // 非 project 字段原样保留
    expect(written.project.objects.some((o: { id: string }) => o.id.startsWith('aigen_char_'))).toBe(true);
  });

  it('还没建过工程（无键）返回 false，不抛', async () => {
    const { applyDirectorSceneToStorage } = await import('@/features/canvas/nodes/DirectorDeskNode');
    const s = fakeStorage({});
    expect(applyDirectorSceneToStorage('node-x', { type: 'director-desk-scene', camera: { move: 'orbit-left' } }, s)).toBe(false);
  });

  it('坏 JSON / 无 project 返回 false', async () => {
    const { applyDirectorSceneToStorage } = await import('@/features/canvas/nodes/DirectorDeskNode');
    expect(applyDirectorSceneToStorage('node-x', { type: 'director-desk-scene' }, fakeStorage({ [KEY]: '{坏' }))).toBe(false);
    expect(applyDirectorSceneToStorage('node-x', { type: 'director-desk-scene' }, fakeStorage({ [KEY]: '{"noProject":1}' }))).toBe(false);
  });
});

describe('parseDirectorProposals / stripDirectorProposals — 灵感提案', () => {
  const block = (extra = '') =>
    '给你几个方向，点一个应用。\n```dd-proposals\n' +
    JSON.stringify({
      type: 'director-desk-proposals',
      proposals: [
        { title: '近身缠斗', summary: '贴身互搏', scene: { type: 'director-desk-scene', camera: { move: 'orbit-left' } } },
        { title: '远景对峙', summary: '缓慢环绕', scene: { type: 'director-desk-scene', camera: { move: 'dolly-in' } } },
      ],
    }) +
    '\n```' + extra;

  it('解析出多条提案，每条带 title/summary/合法 scene', () => {
    const out = parseDirectorProposals(block());
    expect(out).not.toBeNull();
    expect(out!).toHaveLength(2);
    expect(out![0].title).toBe('近身缠斗');
    expect(out![0].scene.type).toBe('director-desk-scene');
  });

  it('丢掉 scene 非法（缺 type）的提案', () => {
    const text =
      '```dd-proposals\n' +
      JSON.stringify({
        type: 'director-desk-proposals',
        proposals: [
          { title: '好的', summary: 'x', scene: { type: 'director-desk-scene' } },
          { title: '坏的', summary: 'y', scene: { camera: {} } },
        ],
      }) +
      '\n```';
    const out = parseDirectorProposals(text);
    expect(out).toHaveLength(1);
    expect(out![0].title).toBe('好的');
  });

  it('全部非法或无提案时返回 null', () => {
    expect(parseDirectorProposals('普通回复，没有提案')).toBeNull();
    const empty = '```dd-proposals\n' + JSON.stringify({ type: 'director-desk-proposals', proposals: [] }) + '\n```';
    expect(parseDirectorProposals(empty)).toBeNull();
  });

  it('提案块不会被 parseDirectorSceneIntent 误当成 dd-scene 自动应用', () => {
    // 提案里的内层 scene 含 director-desk-scene，但顶层是数组包装，不应被当单个 scene 抓走。
    expect(parseDirectorSceneIntent(block())).toBeNull();
  });

  it('渲染时把提案 JSON 块从气泡剥掉，保留自然语言', () => {
    const stripped = stripDirectorProposals(block());
    expect(stripped).toBe('给你几个方向，点一个应用。');
    expect(stripped).not.toContain('director-desk-proposals');
  });
});

/**
 * 容错回归（2026-09-20 真实故障）：agent 输出的 dd-scene 漏了**最外层闭合 `}`**，
 * JSON.parse 抛错 → 整块被静默丢弃 → 用户点完「AI 助手」白模台毫无反应。
 * 下面这段 fixture 就是当时存进 chat.db 的原文。
 */
const REAL_BROKEN_REPLY = [
  '```dd-scene',
  '{',
  '  "type": "director-desk-scene",',
  '  "characters": [',
  '    {"name": "角色A", "pose": "idle", "at": [-2.8, 0.8], "route": [[-2.8, 0.8], [-0.8, 0.8]], "routeDuration": 4, "start": 0},',
  '    {"name": "角色B", "pose": "idle", "at": [2.8, 0.8], "route": [[2.8, 0.8], [0.8, 0.8]], "routeDuration": 4, "start": 0}',
  '  ],',
  '  "objects": [',
  '    {"type": "table", "at": [-0.5, 0], "name": "桌子1"},',
  '    {"type": "table", "at": [0.5, 0], "name": "桌子2"}',
  '  ],',
  '  "camera": {"move": "orbit-right", "duration": 8, "start": 4.5}',
  '```',
  '两张桌子并排摆在画面中央……',
].join('\n');

describe('parseDirectorSceneIntent — 容错（真实故障回归）', () => {
  it('缺最外层闭合 } 也能解析出来（以前是静默失效）', () => {
    const intent = parseDirectorSceneIntent(REAL_BROKEN_REPLY);
    expect(intent).not.toBeNull();
    expect(intent!.characters).toHaveLength(2);
    expect(intent!.objects).toHaveLength(2);
    expect(intent!.camera!.move).toBe('orbit-right');
  });

  it('尾随逗号 + 前后夹带叙述 也能解析', () => {
    const messy =
      '好的，我来摆：\n```dd-scene\n{"type":"director-desk-scene","characters":[{"at":[0,0],},],"camera":{"move":"static",},}\n```\n完成';
    const intent = parseDirectorSceneIntent(messy);
    expect(intent).not.toBeNull();
    expect(intent!.camera!.move).toBe('static');
  });

  it('字符串里的逗号与花括号不会被修坏', () => {
    const tricky =
      '```dd-scene\n{"type":"director-desk-scene","objects":[{"type":"box","name":"a,}b{"}]\n```';
    const intent = parseDirectorSceneIntent(tricky);
    expect(intent!.objects![0].name).toBe('a,}b{');
  });

  it('彻底坏掉的块仍返回 null，但能被识别为「声称有块」以便提示用户', () => {
    const broken = '```dd-scene\n{"type":"director-desk-scene","characters":[oops\n```';
    expect(parseDirectorSceneIntent(broken)).toBeNull();
    expect(hasDirectorSceneBlock(broken)).toBe(true);
  });

  it('合法输入行为不变', () => {
    const ok =
      '```dd-scene\n{"type":"director-desk-scene","camera":{"move":"orbit-left","duration":6}}\n```';
    expect(parseDirectorSceneIntent(ok)!.camera!.move).toBe('orbit-left');
  });
});

describe('parseDirectorProposals — 同一套容错', () => {
  it('提案块缺闭合也能解析', () => {
    const text =
      '```dd-proposals\n{"type":"director-desk-proposals","proposals":[{"title":"近身对峙","summary":"贴身对峙","scene":{"type":"director-desk-scene","camera":{"move":"dolly-in"}}}\n```';
    const proposals = parseDirectorProposals(text);
    expect(proposals).toHaveLength(1);
    expect(proposals![0].title).toBe('近身对峙');
  });
});

describe('summarizeDirectorSceneIntent — 分镜卡摘要', () => {
  it('提出角色/物品/镜头/节拍四行', () => {
    const summary = summarizeDirectorSceneIntent({
      type: 'director-desk-scene',
      characters: [
        { name: '甲', at: [-2, 0], route: [[-2, 0], [0, 0]], routeDuration: 3 },
        { name: '乙', at: [2, 0], route: [[2, 0], [0, 0]], routeDuration: 3 },
      ],
      objects: [{ type: 'table' }, { type: 'chair' }],
      camera: { move: 'orbit-right', duration: 8, start: 4 },
    });

    expect(summary.characterNames).toEqual(['甲', '乙']);
    expect(summary.objectTypes).toEqual(['table', 'chair']);
    expect(summary.camera).toEqual({ move: 'orbit-right', duration: 8, start: 4 });
    // 两个角色同刻起步 → 去重成一条；运镜在 4s 另起一拍
    expect(summary.beats).toEqual([
      { at: 0, kind: 'walk' },
      { at: 4, kind: 'camera' },
    ]);
  });

  it('没名字的角色按序号称呼（数据，不是文案）', () => {
    const summary = summarizeDirectorSceneIntent({
      type: 'director-desk-scene',
      characters: [{ pose: 'idle' }, { pose: 'idle' }],
    });
    expect(summary.characterNames).toEqual(['#1', '#2']);
  });

  it('静止机位不算节拍（没有「什么时候开始动」这回事）', () => {
    const summary = summarizeDirectorSceneIntent({
      type: 'director-desk-scene',
      camera: { move: 'static' },
    });
    expect(summary.beats).toEqual([]);
    expect(summary.camera).toEqual({ move: 'static', duration: null, start: null });
  });

  it('空 intent 不炸，四行都空', () => {
    const summary = summarizeDirectorSceneIntent({ type: 'director-desk-scene' });
    expect(summary.characterNames).toEqual([]);
    expect(summary.objectTypes).toEqual([]);
    expect(summary.camera).toBeNull();
    expect(summary.beats).toEqual([]);
  });
});
