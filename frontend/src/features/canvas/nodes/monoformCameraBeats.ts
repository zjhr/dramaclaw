/**
 * 把导演模型给出的镜头节拍展开成 MONOFORM 相机关键帧。
 *
 * `samplePath` 负责既有运镜的几何，且始终收到真实的全局帧；本模块只负责
 * 非均匀节拍、暂停/反向进度、跟焦和每拍的摄影机参数。这样镜头节奏改变时，
 * 演员仍按时间轴上的真实时刻移动。
 */

export interface CameraKey {
  frame: number;
  interpolation: 'smooth' | 'linear' | 'hold';
  position: number[];
  target: number[];
  focalLength: number;
  [key: string]: unknown;
}

export interface CameraBeat {
  t: number;
  progress?: number;
  focus?: string;
  targetHeight?: number;
  interpolation?: 'smooth' | 'linear' | 'hold';
  /** 镜头到关注点的水平距离（米）。 */
  distance?: number;
  /** 围绕关注点的方位角（度，0 度为关注点正后方，允许连续超过 360）。 */
  azimuth?: number;
  /** 镜头离地高度（米）。 */
  elevation?: number;
  /** 焦距（毫米）。 */
  focalLength?: number;
}

type NumericBeatField = 'targetHeight' | 'distance' | 'azimuth' | 'elevation' | 'focalLength';
type NormalizedBeat = {
  frame: number;
  t: number;
  progress: number;
  focus?: string;
  targetHeight?: number;
  distance?: number;
  azimuth?: number;
  elevation?: number;
  focalLength?: number;
  interpolation: 'smooth' | 'linear' | 'hold';
};

type SamplePath = (frame: number, progress: number) => CameraKey;
type ResolveFocus = (hint: string, frame: number) => number[] | undefined;

const DEFAULT_FPS = 24;
const MAX_BEATS = 64;
const MAX_SECONDS = 60;
const SAMPLE_RATE = 12;
const DEFAULT_FOCAL_LENGTH = 42;
const DEFAULT_INTERPOLATION: NormalizedBeat['interpolation'] = 'smooth';

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validFps(value: number): number {
  return finiteNumber(value) && value > 0 && value <= 240 ? value : DEFAULT_FPS;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value: unknown, fallback: number): number {
  return finiteNumber(value) ? value : fallback;
}

function cloneVector(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value) || value.length < 3) return [...fallback];
  return [
    finiteOr(value[0], fallback[0]),
    finiteOr(value[1], fallback[1]),
    finiteOr(value[2], fallback[2]),
  ];
}

function cloneCamera(sample: unknown, frame: number): CameraKey {
  const source = sample && typeof sample === 'object' ? sample as Record<string, unknown> : {};
  return {
    ...source,
    frame,
    position: cloneVector(source.position, [0, 0, 0]),
    target: cloneVector(source.target, [0, 0, 0]),
    focalLength: finiteOr(source.focalLength, DEFAULT_FOCAL_LENGTH),
    // 速度曲线已经烘焙进采样点；hold 会在下方显式保留。
    interpolation: 'linear',
  };
}

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function interpolateVector(from: number[], to: number[], amount: number): number[] {
  return [
    lerp(from[0], to[0], amount),
    lerp(from[1], to[1], amount),
    lerp(from[2], to[2], amount),
  ];
}

function normalizeFocusPoint(value: unknown, fallback: number[]): number[] | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const x = finiteOr(value[0], Number.NaN);
  const z = finiteOr(value.length >= 3 ? value[2] : value[1], Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return undefined;
  const y = value.length >= 3 ? finiteOr(value[1], fallback[1]) : fallback[1];
  return [x, y, z];
}

function beatFrom(value: unknown, fps: number, order: number): (NormalizedBeat & { order: number }) | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (!finiteNumber(item.t) || item.t < 0 || item.t > MAX_SECONDS) return undefined;
  const frame = Math.round(item.t * fps);
  if (!Number.isFinite(frame) || frame < 0) return undefined;
  const interpolation = item.interpolation === 'linear' || item.interpolation === 'hold'
    ? item.interpolation
    : DEFAULT_INTERPOLATION;
  const numberField = (name: NumericBeatField, min?: number, max?: number) => {
    if (!finiteNumber(item[name])) return undefined;
    const value = item[name] as number;
    return min === undefined || max === undefined ? value : clamp(value, min, max);
  };
  const progress = finiteNumber(item.progress) ? clamp(item.progress, 0, 1) : undefined;
  const focus = typeof item.focus === 'string' && item.focus.trim() ? item.focus.trim() : undefined;
  const targetHeight = numberField('targetHeight', 0.2, 3);
  const distance = numberField('distance', 0.8, 30);
  const azimuth = numberField('azimuth');
  const elevation = numberField('elevation', 0.2, 15);
  const focalLength = numberField('focalLength', 18, 120);
  return {
    frame,
    t: item.t,
    progress: progress ?? 0,
    ...(focus ? { focus } : {}),
    ...(targetHeight === undefined ? {} : { targetHeight }),
    ...(distance === undefined ? {} : { distance }),
    ...(azimuth === undefined ? {} : { azimuth }),
    ...(elevation === undefined ? {} : { elevation }),
    ...(focalLength === undefined ? {} : { focalLength }),
    interpolation,
    order,
  };
}

function normalizeBeats(input: unknown, fps: number): NormalizedBeat[] {
  if (!Array.isArray(input)) return [];
  const parsed = input
    .map((value, order) => beatFrom(value, fps, order))
    .filter((value): value is NormalizedBeat & { order: number } => value !== undefined)
    .sort((a, b) => a.t - b.t || a.order - b.order);
  // 同一整数帧最后一项胜出，避免引擎收到两个互相覆盖的状态。
  const byFrame = new Map<number, NormalizedBeat & { order: number }>();
  for (const beat of parsed) byFrame.set(beat.frame, beat);
  const beats = [...byFrame.values()].sort((a, b) => a.frame - b.frame || a.order - b.order);
  if (beats.length < 2) return [];

  const hasAnyProgress = beats.some(beat => {
    const raw = input[beat.order];
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      && finiteNumber((raw as Record<string, unknown>).progress);
  });
  const firstT = beats[0].t;
  const span = Math.max(Number.EPSILON, beats[beats.length - 1].t - firstT);
  let previousProgress = 0;
  return beats.map(beat => {
    const raw = input[beat.order];
    const explicitProgress = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).progress
      : undefined;
    const progress = hasAnyProgress
      ? (finiteNumber(explicitProgress) ? clamp(explicitProgress, 0, 1) : previousProgress)
      : clamp((beat.t - firstT) / span, 0, 1);
    previousProgress = progress;
    return { ...beat, progress };
  });
}

function inherited<T extends keyof NormalizedBeat>(beats: NormalizedBeat[], index: number, field: T): NormalizedBeat[T] {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const value = beats[cursor][field];
    if (value !== undefined) return value;
  }
  return undefined as NormalizedBeat[T];
}

function targetWithFocus(
  sampleTarget: number[],
  leftFocus: string | undefined,
  rightFocus: string | undefined,
  frame: number,
  amount: number,
  resolveFocus: ResolveFocus,
): number[] {
  if (!leftFocus && !rightFocus) return [...sampleTarget];
  const left = leftFocus ? normalizeFocusPoint(resolveFocus(leftFocus, frame), sampleTarget) : undefined;
  const right = rightFocus ? normalizeFocusPoint(resolveFocus(rightFocus, frame), sampleTarget) : undefined;
  return interpolateVector(left ?? sampleTarget, right ?? sampleTarget, amount);
}

function withTargetHeight(target: number[], height: number | undefined): number[] {
  return height === undefined ? target : [target[0], clamp(height, 0.2, 3), target[2]];
}

function baseAzimuth(position: number[], target: number[]): number {
  return Math.atan2(position[0] - target[0], position[2] - target[2]) * 180 / Math.PI;
}

function cameraWithBeatGeometry(
  sampled: CameraKey,
  leftSample: CameraKey,
  rightSample: CameraKey,
  target: number[],
  beats: NormalizedBeat[],
  leftIndex: number,
  rightIndex: number,
  amount: number,
): CameraKey {
  const fields: NumericBeatField[] = ['distance', 'azimuth', 'elevation', 'focalLength'];
  const values: Partial<Record<NumericBeatField, number>> = {};
  for (const field of fields) {
    const leftExplicit = inherited(beats, leftIndex, field) as number | undefined;
    const rightExplicit = inherited(beats, rightIndex, field) as number | undefined;
    const leftBase = field === 'distance'
      ? Math.hypot(leftSample.position[0] - leftSample.target[0], leftSample.position[2] - leftSample.target[2])
      : field === 'azimuth'
        ? baseAzimuth(leftSample.position, leftSample.target)
        : field === 'elevation' ? leftSample.position[1] : leftSample.focalLength;
    const rightBase = field === 'distance'
      ? Math.hypot(rightSample.position[0] - rightSample.target[0], rightSample.position[2] - rightSample.target[2])
      : field === 'azimuth'
        ? baseAzimuth(rightSample.position, rightSample.target)
        : field === 'elevation' ? rightSample.position[1] : rightSample.focalLength;
    if (leftExplicit === undefined && rightExplicit === undefined) continue;
    values[field] = lerp(leftExplicit ?? leftBase, rightExplicit ?? rightBase, amount);
  }

  const hasOrbit = values.distance !== undefined || values.azimuth !== undefined || values.elevation !== undefined;
  const position = hasOrbit
    ? (() => {
      const distance = values.distance ?? Math.hypot(sampled.position[0] - target[0], sampled.position[2] - target[2]);
      const angle = (values.azimuth ?? baseAzimuth(sampled.position, sampled.target)) * Math.PI / 180;
      return [
        target[0] + Math.sin(angle) * distance,
        values.elevation ?? sampled.position[1],
        target[2] + Math.cos(angle) * distance,
      ];
    })()
    : sampled.position;
  return {
    ...sampled,
    position,
    target,
    focalLength: values.focalLength ?? sampled.focalLength,
  };
}

/** 展开镜头节拍；无效或单点输入返回 null，宿主可继续使用旧运镜。 */
export function buildMonoformCameraBeatTrack(
  beatsInput: unknown,
  fpsInput: number,
  samplePath: SamplePath,
  resolveFocus: ResolveFocus,
): CameraKey[] | null {
  const fps = validFps(fpsInput);
  const beats = normalizeBeats(beatsInput, fps).slice(0, MAX_BEATS);
  if (beats.length < 2) return null;

  const firstFrame = beats[0].frame;
  const lastFrame = beats[beats.length - 1].frame;
  const frames = new Set<number>();
  for (let frame = firstFrame; frame <= lastFrame; frame += Math.max(1, Math.round(fps / SAMPLE_RATE))) frames.add(frame);
  for (const beat of beats) frames.add(beat.frame);
  const sampleFrames = [...frames].sort((a, b) => a - b);
  const exactBeat = new Map(beats.map(beat => [beat.frame, beat]));
  const result: CameraKey[] = [];
  let segmentIndex = 0;
  const holdCache = new Map<number, CameraKey>();

  const buildAt = (frame: number, leftIndex: number, rightIndex: number, amount: number, outputInterpolation: CameraKey['interpolation']): CameraKey => {
    const left = beats[leftIndex];
    const right = beats[rightIndex];
    const progress = lerp(left.progress, right.progress, amount);
    const sampled = cloneCamera(samplePath(frame, progress), frame);
    const leftSample = cloneCamera(samplePath(left.frame, left.progress), left.frame);
    const rightSample = rightIndex === leftIndex
      ? leftSample
      : cloneCamera(samplePath(right.frame, right.progress), right.frame);
    const leftFocus = inherited(beats, leftIndex, 'focus') as string | undefined;
    const rightFocus = inherited(beats, rightIndex, 'focus') as string | undefined;
    const target = targetWithFocus(sampled.target, leftFocus, rightFocus, frame, amount, resolveFocus);
    const leftHeight = inherited(beats, leftIndex, 'targetHeight') as number | undefined;
    const rightHeight = inherited(beats, rightIndex, 'targetHeight') as number | undefined;
    const leftY = leftHeight ?? leftSample.target[1];
    const rightY = rightHeight ?? rightSample.target[1];
    return {
      ...cameraWithBeatGeometry(sampled, leftSample, rightSample, withTargetHeight(target, lerp(leftY, rightY, amount)), beats, leftIndex, rightIndex, amount),
      frame,
      interpolation: outputInterpolation,
    };
  };

  for (const frame of sampleFrames) {
    const exact = exactBeat.get(frame);
    while (segmentIndex < beats.length - 2 && frame >= beats[segmentIndex + 1].frame) segmentIndex += 1;
    const leftIndex = exact ? beats.indexOf(exact) : segmentIndex;
    const rightIndex = exact ? leftIndex : Math.min(leftIndex + 1, beats.length - 1);
    if (exact) {
      const interpolation = exact.interpolation === 'hold' ? 'hold' : 'linear';
      const key = buildAt(frame, leftIndex, rightIndex, 0, interpolation);
      result.push(key);
      if (exact.interpolation === 'hold') holdCache.set(leftIndex, key);
      continue;
    }

    const left = beats[leftIndex];
    const right = beats[rightIndex];
    const rawAmount = clamp((frame - left.frame) / Math.max(1, right.frame - left.frame), 0, 1);
    if (left.interpolation === 'hold') {
      let held = holdCache.get(leftIndex);
      if (!held) {
        held = buildAt(left.frame, leftIndex, leftIndex, 0, 'hold');
        holdCache.set(leftIndex, held);
      }
      // 关键帧的 interpolation=hold 会让 MONOFORM 在到达右拍前始终冻结左拍。
      result.push({ ...held, frame, interpolation: 'hold' });
      continue;
    }
    const amount = left.interpolation === 'smooth' ? smoothstep(rawAmount) : rawAmount;
    result.push(buildAt(frame, leftIndex, rightIndex, amount, 'linear'));
  }
  return result.length >= 2 ? result : null;
}
