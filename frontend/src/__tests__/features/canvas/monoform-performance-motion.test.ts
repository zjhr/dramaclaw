// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMonoformSceneIntent, buildMonoformActionTrack, buildMonoformCharacter } from '@/features/canvas/nodes/monoformScenePatch';
import type { DirectorSceneIntent } from '@/features/canvas/nodes/directorScenePatch';
import romanceResponse from './fixtures/romance-performance.intent.json';

type Samples = Record<number, Record<string, [number, number, number]>>;
const distance = (a: number[], b: number[]) => Math.hypot(...a.map((value, index) => value - b[index]));

describe('动作指令在真实人物骨架上可见', () => {
  let measurements: Samples[];
  beforeAll(() => {
    const actor = buildMonoformCharacter({ pose: 'stand_relaxed' }, 0);
    const requests = ['Arm.pitch', 'Elbow.bend'].flatMap(control => ['left', 'right'].map(side => ({
      object: actor,
      keys: buildMonoformActionTrack({ performance: [
        { t: 0, pose: 'stand_relaxed' },
        { t: 2, controls: { [`${side}${control}`]: control === 'Arm.pitch' ? -45 : 60 } },
        { t: 4, controls: { [`${side}${control}`]: 0 } },
      ] }, 24, actor),
      frames: [0, 12, 24, 36, 48, 72, 96],
    })));
    const project = applyMonoformSceneIntent({ objects: [
      buildMonoformCharacter({ name: '林晚', at: [-0.35, -0.3], facing: 90 }, 0),
      buildMonoformCharacter({ name: '沈青', at: [0.35, -0.3], facing: -90 }, 1),
    ] }, romanceResponse as DirectorSceneIntent);
    const originalRequests = [84, 36].map((frame, index) => ({
      object: project.objects![index],
      keys: project.objectKeyframes![String(project.objects![index].id)],
      frames: [0, frame, 156],
    }));
    const danceRequest = {
      object: actor,
      keys: buildMonoformActionTrack({
        at: [0, 0],
        performance: [
          { t: 0, pose: 'stand_relaxed', action: '收势' },
          { t: 1, action: '向左迈', side: 'left' },
          { t: 2, action: '上举双臂', side: 'both' },
          { t: 3, action: '收势', side: 'both' },
        ],
      }, 24, actor),
      frames: [0, 24, 48, 72],
    };
    // 所有场景共用一个 Node 进程和同一 GLB，避免重复加载与 jsdom 的跨 realm 类型问题。
    const helper = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../vendor/monoform/tests/helpers/measure-performance.mjs');
    measurements = JSON.parse(execFileSync(process.execPath, [helper], {
      input: JSON.stringify([...requests, ...originalRequests, danceRequest]), encoding: 'utf8', timeout: 20000,
    }));
  }, 25000);

  it.each(['left', 'right'])('%s 手臂前抬 45° 时，手腕向前超过 25 厘米并抬高', (side) => {
    const samples = measurements[side === 'left' ? 0 : 1];
    const id = `mixamorig${side === 'left' ? 'Left' : 'Right'}Hand`;
    expect(samples[48][id][2] - samples[0][id][2]).toBeGreaterThan(0.25);
    expect(samples[48][id][1] - samples[0][id][1]).toBeGreaterThan(0.08);
    for (const [previous, next] of [[0, 12], [12, 24], [24, 36], [36, 48]]) {
      expect(samples[next][id][2]).toBeGreaterThan(samples[previous][id][2]);
    }
    expect(samples[72][id][2]).toBeLessThan(samples[48][id][2]);
    expect(distance(samples[96][id], samples[0][id])).toBeLessThan(0.001);
  });

  it.each(['left', 'right'])('%s 弯肘 60° 时，肘不移位而手腕向前抬起', (side) => {
    const samples = measurements[side === 'left' ? 2 : 3];
    const prefix = `mixamorig${side === 'left' ? 'Left' : 'Right'}`;
    expect(distance(samples[48][`${prefix}ForeArm`], samples[0][`${prefix}ForeArm`])).toBeLessThan(0.001);
    expect(samples[48][`${prefix}Hand`][2] - samples[0][`${prefix}Hand`][2]).toBeGreaterThan(0.15);
    expect(samples[48][`${prefix}Hand`][1] - samples[0][`${prefix}Hand`][1]).toBeGreaterThan(0.08);
  });

  it('原模型回复的伸手节拍使两个演员的手分别朝对方前移，收手后回到身边', () => {
    for (const [index, frame] of [84, 36].entries()) {
      const samples = measurements[4 + index];
      const hand = 'mixamorigRightHand';
      // 两人沿 X 轴面对面：左侧向 +X 伸手，右侧向 -X 伸手。
      expect((samples[frame][hand][0] - samples[0][hand][0]) * (index === 0 ? 1 : -1)).toBeGreaterThan(0.2);
      expect(samples[frame][hand][1] - samples[0][hand][1]).toBeGreaterThan(0.05);
      expect(distance(samples[156][hand], samples[0][hand])).toBeLessThan(0.02);
    }
  });

  it('高层舞步在真实 GLB 上同时看得到重心变化、双臂上举和收势回位', () => {
    const samples = measurements[6];
    const baseLeftKnee = samples[0].mixamorigLeftLeg;
    const stepLeftKnee = samples[24].mixamorigLeftLeg;
    expect(stepLeftKnee[1]).not.toBeCloseTo(baseLeftKnee[1], 2);
    expect(Math.abs(samples[24].mixamorigLeftHand[0] - samples[0].mixamorigLeftHand[0])).toBeGreaterThan(0.05);
    expect(samples[48].mixamorigLeftHand[1]).toBeGreaterThan(samples[0].mixamorigLeftHand[1] + 0.35);
    expect(samples[48].mixamorigRightHand[1]).toBeGreaterThan(samples[0].mixamorigRightHand[1] + 0.35);
    const relativeHand = (frame: number, hand: string) => samples[frame][hand].map((value, index) => value - samples[frame].mixamorigHips[index]);
    expect(distance(relativeHand(72, 'mixamorigLeftHand'), relativeHand(0, 'mixamorigLeftHand'))).toBeLessThan(0.03);
    expect(distance(relativeHand(72, 'mixamorigRightHand'), relativeHand(0, 'mixamorigRightHand'))).toBeLessThan(0.03);
  });
});
