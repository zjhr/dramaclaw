import { describe, expect, it } from 'vitest';

import {
  buildMonoformCameraBeatTrack,
  type CameraKey,
} from '../../../features/canvas/nodes/monoformCameraBeats';

function path(frame: number, progress: number): CameraKey {
  return {
    frame,
    interpolation: 'smooth',
    position: [frame / 10, progress, 5],
    target: [progress * 10, 1 + progress, frame / 20],
    focalLength: 35 + progress * 20,
  };
}

describe('buildMonoformCameraBeatTrack', () => {
  it('按实际全局帧采样，补入精确节拍并保持有界', () => {
    const seenFrames: number[] = [];
    const keys = buildMonoformCameraBeatTrack(
      [
        { t: 2, progress: 0.1 },
        { t: 4.25, progress: 0.8 },
        { t: 7, progress: 0.2 },
      ],
      24,
      (frame, progress) => {
        seenFrames.push(frame);
        return path(frame, progress);
      },
      () => undefined,
    );

    expect(keys).not.toBeNull();
    expect(keys!.map(key => key.frame)).toContain(48);
    expect(keys!.map(key => key.frame)).toContain(102);
    expect(keys!.map(key => key.frame)).toContain(168);
    expect(keys!.length).toBeLessThanOrEqual(64 * 60 / 5 + 5);
    expect(seenFrames.every(frame => Number.isInteger(frame) && frame >= 48 && frame <= 168)).toBe(true);
    expect(keys!.every(key => key.interpolation === 'linear')).toBe(true);
    expect(keys!.every(key => [key.position, key.target, [key.focalLength]].flat().every(Number.isFinite))).toBe(true);
  });

  it('所有节拍省略 progress 时，按实际起止时间线性推算', () => {
    const keys = buildMonoformCameraBeatTrack(
      [{ t: 2 }, { t: 6 }],
      24,
      path,
      () => undefined,
    );
    expect(keys).not.toBeNull();
    expect(keys!.find(key => key.frame === 48)?.position[1]).toBeCloseTo(0);
    expect(keys!.find(key => key.frame === 144)?.position[1]).toBeCloseTo(1);
  });

  it('部分节拍省略 progress 时继承上一拍，允许反向', () => {
    const keys = buildMonoformCameraBeatTrack(
      [
        { t: 0, progress: 0.9 },
        { t: 1 },
        { t: 2, progress: 0.1 },
      ],
      24,
      path,
      () => undefined,
    );
    expect(keys).not.toBeNull();
    expect(keys!.find(key => key.frame === 24)?.position[1]).toBeCloseTo(0.9);
    expect(keys!.find(key => key.frame === 48)?.position[1]).toBeCloseTo(0.1);
  });

  it('hold 冻结左拍的实际相机状态，直到右拍精确切换', () => {
    const keys = buildMonoformCameraBeatTrack(
      [
        { t: 1, progress: 0.2, focus: '甲', interpolation: 'hold', targetHeight: 1.1 },
        { t: 3, progress: 0.8, focus: '甲', targetHeight: 2.2 },
      ],
      24,
      (frame, progress) => ({
        frame,
        interpolation: 'smooth',
        position: [frame, progress, 8],
        target: [frame / 10, 9, frame / 20],
        focalLength: frame + 40,
      }),
      () => [100, 0, 200],
    );
    expect(keys).not.toBeNull();
    const held = keys!.filter(key => key.frame > 24 && key.frame < 72);
    expect(held.length).toBeGreaterThan(0);
    expect(new Set(held.map(key => JSON.stringify(key.position))).size).toBe(1);
    expect(new Set(held.map(key => JSON.stringify(key.target))).size).toBe(1);
    expect(new Set(held.map(key => key.focalLength)).size).toBe(1);
    expect(keys!.find(key => key.frame === 72)?.focalLength).toBeCloseTo(72 + 40);
    expect(keys!.find(key => key.frame === 72)?.target[1]).toBeCloseTo(2.2);
  });

  it('同一个移动 focus 在每个实际时刻重新解析，切换目标时平滑过渡', () => {
    const resolveCalls: Array<[string, number]> = [];
    const keys = buildMonoformCameraBeatTrack(
      [
        { t: 0, progress: 0, focus: '甲' },
        { t: 2, progress: 1, focus: '乙', targetHeight: 1.5 },
      ],
      24,
      path,
      (hint, frame) => {
        resolveCalls.push([hint, frame]);
        return hint === '甲' ? [frame / 10, 0, 0] : [-frame / 10, 0, 0];
      },
    );
    expect(keys).not.toBeNull();
    const middle = keys!.find(key => key.frame === 24);
    expect(middle?.target[0]).toBeCloseTo(0);
    expect(middle?.target[1]).toBeCloseTo(1.25);
    expect(resolveCalls.some(([hint, frame]) => hint === '甲' && frame === 24)).toBe(true);
    expect(resolveCalls.some(([hint, frame]) => hint === '乙' && frame === 24)).toBe(true);
  });

  it('按时间排序，同帧最后项胜出；坏数据与单点输入交旧逻辑', () => {
    const keys = buildMonoformCameraBeatTrack(
      [
        { t: 1.01, progress: 0.1 },
        { t: 0, progress: 0 },
        { t: 1.02, progress: 0.7 },
        { t: Number.NaN },
        null,
        { t: 2, progress: 1 },
      ],
      24,
      path,
      () => undefined,
    );
    expect(keys).not.toBeNull();
    expect(keys!.find(key => key.frame === 24)?.position[1]).toBeCloseTo(0.7);
    expect(buildMonoformCameraBeatTrack([{ t: 1 }], 24, path, () => undefined)).toBeNull();
    expect(buildMonoformCameraBeatTrack([{ t: -1 }, { t: 1 }], 24, path, () => undefined)).toBeNull();
  });

  it('限制节拍数量、焦距高度和非法 fps，输出不含 NaN', () => {
    const beats = Array.from({ length: 80 }, (_, index) => ({ t: index * 0.5, progress: index / 79 }));
    const keys = buildMonoformCameraBeatTrack(
      beats,
      Number.NaN,
      () => ({
        frame: 0,
        interpolation: 'smooth',
        position: [Number.NaN, 1, Infinity],
        target: [0, Number.NaN, 2],
        focalLength: Number.NaN,
      }),
      () => undefined,
    );
    expect(keys).not.toBeNull();
    expect(keys!.every(key => key.frame >= 0 && key.frame <= 60 * 24)).toBe(true);
    expect(keys!.every(key => [...key.position, ...key.target, key.focalLength].every(Number.isFinite))).toBe(true);
  });

  it('在关注点周围组合距离、连续方位、升降和焦距，并在首拍前保持旧路径', () => {
    const basePath = (frame: number, _progress: number): CameraKey => ({
      frame,
      interpolation: 'smooth',
      position: [0, 1, 5],
      target: [0, 1, 0],
      focalLength: 50,
    });
    const keys = buildMonoformCameraBeatTrack(
      [
        { t: 0, progress: 0 },
        { t: 2, progress: 0.5, distance: 4, azimuth: 360, elevation: 4, focalLength: 70 },
        { t: 4, progress: 1, distance: 6, azimuth: 540, elevation: 6, focalLength: 35 },
      ],
      24,
      basePath,
      () => [0, 0, 0],
    );
    expect(keys).not.toBeNull();
    const start = keys!.find(key => key.frame === 0)!;
    const middle = keys!.find(key => key.frame === 48)!;
    const end = keys!.find(key => key.frame === 96)!;
    expect(start.position).toEqual(basePath(0, 0).position);
    expect(middle.position[0]).toBeCloseTo(0, 5);
    expect(middle.position[1]).toBeCloseTo(4, 5);
    expect(middle.position[2]).toBeCloseTo(4, 5);
    expect(middle.focalLength).toBeCloseTo(70);
    expect(end.position[0]).toBeCloseTo(0, 5);
    expect(end.position[1]).toBeCloseTo(6, 5);
    expect(end.position[2]).toBeCloseTo(-6, 5);
    expect(end.focalLength).toBeCloseTo(35);
  });

  it('后拍首次声明距离时，从旧路径连续过渡，不提前套用新值', () => {
    const basePath = (frame: number, _progress: number): CameraKey => ({
      frame,
      interpolation: 'smooth',
      position: [0, 1, 5],
      target: [0, 1, 0],
      focalLength: 50,
    });
    const keys = buildMonoformCameraBeatTrack(
      [{ t: 0, progress: 0 }, { t: 2, progress: 1, distance: 10 }],
      24,
      basePath,
      () => undefined,
    );
    expect(keys).not.toBeNull();
    expect(keys!.find(key => key.frame === 0)!.position[2]).toBeCloseTo(5);
    expect(keys!.find(key => key.frame === 24)!.position[2]).toBeGreaterThan(5);
    expect(keys!.find(key => key.frame === 48)!.position[2]).toBeCloseTo(10);
  });
});
