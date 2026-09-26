import { describe, expect, it } from 'vitest';

import {
  applyMonoformSceneIntent,
  buildMonoformCameraTrack,
} from '../../../features/canvas/nodes/monoformScenePatch';
import { DIRECTOR_SCENE_INTENT_TYPE } from '../../../features/canvas/nodes/directorScenePatch';

const persons = [
  { id: 'a', name: '甲', type: 'person', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  { id: 'b', name: '乙', type: 'person', position: [2, 0, 0], rotation: [0, Math.PI, 0], scale: [1, 1, 1] },
];

describe('buildMonoformCameraTrack × camera beats', () => {
  it('单镜入口输出所有精确节拍帧和组合摄影参数', () => {
    const keys = buildMonoformCameraTrack({
      move: 'orbit-right',
      duration: 4,
      beats: [
        { t: 0, progress: 0, distance: 3, azimuth: 0, elevation: 1, focalLength: 35 },
        { t: 2, progress: 0.25, distance: 4, azimuth: 360, elevation: 3, focalLength: 65 },
        { t: 4, progress: 1, distance: 5, azimuth: 540, elevation: 5, focalLength: 50 },
      ],
    } as never, persons, 24);

    expect(keys.map(key => key.frame)).toContain(0);
    expect(keys.map(key => key.frame)).toContain(48);
    expect(keys.map(key => key.frame)).toContain(96);
    expect(keys.find(key => key.frame === 48)?.focalLength).toBe(65);
    expect(keys.find(key => key.frame === 96)?.focalLength).toBe(50);
    expect(keys.every(key => [...key.position, ...key.target, key.focalLength].every(Number.isFinite))).toBe(true);
  });

  it('真实角色轨在节拍采样中使用当前绝对帧，停顿和反向不会重定时角色', () => {
    const moving = [
      { frame: 0, interpolation: 'linear' as const, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      { frame: 96, interpolation: 'linear' as const, position: [4, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    ];
    const keys = buildMonoformCameraTrack({
      move: 'dolly-in',
      duration: 4,
      beats: [
        { t: 0, progress: 0 },
        { t: 2, progress: 0.8, interpolation: 'hold' },
        { t: 3, progress: 0.2 },
        { t: 4, progress: 1 },
      ],
    } as never, [persons[0]], 24, [moving]);

    const atTwo = keys.find(key => key.frame === 48)!;
    const duringHold = keys.find(key => key.frame === 60)!;
    const atThree = keys.find(key => key.frame === 72)!;
    expect(atTwo.target[0]).toBeCloseTo(2, 1);
    expect(duringHold.position).toEqual(atTwo.position);
    expect(duringHold.target).toEqual(atTwo.target);
    expect(atThree.target[0]).toBeCloseTo(3, 1);
    expect(keys.find(key => key.frame === 96)?.target[0]).toBeCloseTo(4, 1);
  });

  it('节拍可切换 focus，跟随实际移动角色且同一时间点目标平滑', () => {
    const movingTracks = {
      a: [
        { frame: 0, interpolation: 'linear' as const, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        { frame: 96, interpolation: 'linear' as const, position: [4, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      ],
      b: [
        { frame: 0, interpolation: 'linear' as const, position: [0, 0, 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
        { frame: 96, interpolation: 'linear' as const, position: [0, 0, 6], rotation: [0, 0, 0], scale: [1, 1, 1] },
      ],
    };
    const keys = buildMonoformCameraTrack({
      move: 'dolly-in',
      duration: 4,
      beats: [
        { t: 0, progress: 0, focus: '甲' },
        { t: 2, progress: 0.5, focus: '乙' },
        { t: 4, progress: 1, focus: '乙' },
      ],
    } as never, persons, 24, [], { tracks: movingTracks });

    expect(keys.find(key => key.frame === 0)?.target[0]).toBeCloseTo(0, 1);
    expect(keys.find(key => key.frame === 48)?.target[0]).toBeCloseTo(0, 1);
    expect(keys.find(key => key.frame === 48)?.target[2]).toBeCloseTo(4, 1);
    expect(keys.find(key => key.frame === 96)?.target[2]).toBeCloseTo(6, 1);
  });

  it('同一份 camera beats 会写入单镜和 shots 的真实轨道', () => {
    const intent = {
      type: DIRECTOR_SCENE_INTENT_TYPE,
      characters: [
        { name: '甲', at: [0, 0] },
        { name: '乙', at: [2, 0] },
      ],
      shots: [
        {
          name: '环绕',
          camera: {
            move: 'orbit-right',
            duration: 4,
            beats: [
              { t: 0, progress: 0, distance: 4 },
              { t: 2, progress: 0.5, interpolation: 'hold' },
              { t: 4, progress: 1, distance: 6 },
            ],
          },
        },
        {
          name: '反打',
          camera: {
            move: 'over-shoulder',
            subject: '乙',
            focus: '甲',
            duration: 4,
            beats: [
              { t: 0, progress: 0 },
              { t: 4, progress: 1 },
            ],
          },
        },
      ],
    } as never;
    const project = applyMonoformSceneIntent({ settings: { fps: 24 } }, intent);
    expect(project.shots).toHaveLength(2);
    expect((project.shots?.[0].keyframes as { frame: number }[]).map(key => key.frame)).toContain(48);
    expect((project.shots?.[1].keyframes as { frame: number }[]).map(key => key.frame)).toContain(96);
    expect((project.keyframes as { frame: number }[]).map(key => key.frame)).toContain(48);
  });

  it('compose 时不会让超出整段时长的镜头节拍偷偷延长项目', () => {
    const project = applyMonoformSceneIntent({ settings: { fps: 24 } }, {
      type: DIRECTOR_SCENE_INTENT_TYPE,
      duration: 2,
      mode: 'compose',
      characters: [{ name: '甲', performance: [{ t: 0, pose: 'idle' }, { t: 2, action: '收势' }] }],
      camera: {
        move: 'dolly-in',
        duration: 2,
        beats: [{ t: 0, progress: 0 }, { t: 3, progress: 1 }],
      },
    } as never);
    const keys = project.keyframes as { frame: number }[];
    expect(Math.max(...keys.map(key => key.frame))).toBeLessThanOrEqual(48);
    expect(project.settings?.durationSeconds).toBe(2);
  });
});
