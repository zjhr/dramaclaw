// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * MONOFORM 白模台「一句话出片」的确定性翻译层。宿主侧纯函数：把 agent 产的
 * DirectorSceneIntent 翻译成 MONOFORM 工程补丁（物品 + 人物 + 动画关键帧 + 相机轨），
 * 经 scene.apply 契约推给 MONOFORM 走 applyProjectSnapshot 热更新。
 *
 * 设计原则：**几何与时间数学全在这里算，agent 只从封闭词表里选**。
 * agent 说「两人从两侧走向对方，桌边放把椅子，镜头绕着他们转 6 秒」，弧线采样、帧号、
 * 焦距、行进朝向由确定性代码展开 —— LLM 没有算错几何的机会。
 *
 * 四条 MONOFORM 语义事实（读 vendored 源码得到，直接决定本文件的写法）：
 * 1. `normalizeShot` 以 **shot 的 objects/keyframes 优先**、顶层只是 fallback，最终渲染
 *    活动 shot 的值 → 注入必须**同时**改顶层与活动 shot（这个坑踩过一次：apply 返回 ok
 *    但画面不变）。
 * 2. 对象动画走 `objectKeyframes[对象id] = [{frame, interpolation, position, rotation,
 *    scale, pose, continuousMotion, ...}]`。`objectAtFrame` 对 position/rotation/scale 做
 *    lerp（**普通 lerp，不是角度感知**），不同 pose 由引擎混合两侧动画采样；
 *    只有 `continuousMotion + poseCanLoop(pose)` 才跑行走/奔跑这类循环动作。
 * 3. 相机动画走顶层 `keyframes[]`（与 `shot.keyframes` 同名不同层），`cameraAtFrame` 对
 *    rotation 按实际航向/俯仰或四元数插值、position/focalLength 用 lerp；关键帧给 `target`
 *    就由 `cameraRotationToward` 推朝向 —— 所以我们**故意不写 rotation**。
 * 4. 时间轴 fps 默认 24、durationSeconds 默认 15（上限 60）；`normalizeShot` 会按最大
 *    关键帧**自动延长**时长、超出则截断 —— 我们只负责把帧号算对。
 *
 * 已做：粗骨骼 controls、performance 演出、固定 GLB、shots 多机位（可切换，不自动切镜）。
 * 没写 shots 时不补机位。只写 camera 就是一台；shots 有几条就是几台。
 * 故意不做：物品自身的动画（要动物品目前只能用手在时间轴上打关键帧）、GLB 的尺寸参数。
 */
import type {
  DirectorSceneCharacterIntent,
  DirectorSceneIntent,
  DirectorScenePerformanceBeat,
  DirectorScenePropIntent,
} from './directorScenePatch';
import { buildMonoformCameraBeatTrack } from './monoformCameraBeats';

/** director 姿势预设 id → MONOFORM RIG_PRESETS id。只列名字对不上的；同名直传，
 *  未知值交给 MONOFORM 的 normalizePoseId 兜底（回落 idle）。 */
const POSE_MAP: Record<string, string> = {
  stand: 'idle',
  't-pose': 'tpose',
  point: 'idle',
  jump: 'run',
};

/** 生成角色的 id 前缀；重新生成时据此替换上一批、并清掉它们的动画轨。 */
const GEN_CHAR_PREFIX = 'aigen_char_';
/** 生成物品的 id 前缀；重新生成时只换掉这一批，用户手摆的物品不动。 */
const GEN_PROP_PREFIX = 'aigen_prop_';

const FPS_FALLBACK = 24;

/** 与白模引擎 RIG_PRESETS 的可循环动作一致；演出轨默认播放，允许单拍显式定格。 */
const LOOPING_POSES = new Set(['idle', 'walk', 'run', 'agree', 'headShake', 'wave']);

/**
 * 物品默认值表 —— **照抄** MONOFORM `addPrimitive`（App.jsx）的 labels / defaultScales /
 * positionY / 配色，保证 agent 摆出来的物品和用户手点出来的长得一模一样。
 */
const PROP_DEFAULTS: Record<string, { label: string; scale: [number, number, number]; y: number; color: string }> = {
  box: { label: '方块', scale: [1, 1, 1], y: 0.5, color: '#c7c2b7' },
  sphere: { label: '球体', scale: [1, 1, 1], y: 0.5, color: '#c7c2b7' },
  cylinder: { label: '圆柱', scale: [1, 1, 1], y: 0.5, color: '#c7c2b7' },
  plane: { label: '平面', scale: [2, 1, 2], y: 0.02, color: '#c7c2b7' },
  arch: { label: '拱门', scale: [1.8, 2.2, 0.45], y: 0.5, color: '#c7c2b7' },
  stairs: { label: '楼梯', scale: [2.2, 1.4, 2.8], y: 0.5, color: '#c7c2b7' },
  door: { label: '门', scale: [1.2, 2.2, 0.25], y: 0.5, color: '#c7c2b7' },
  window: { label: '窗', scale: [1.5, 1.3, 0.22], y: 0.5, color: '#c7c2b7' },
  table: { label: '桌子', scale: [1.7, 1, 1.1], y: 0.5, color: '#c7c2b7' },
  chair: { label: '椅子', scale: [0.8, 1, 0.8], y: 0.5, color: '#c7c2b7' },
  sofa: { label: '沙发', scale: [2.2, 1.1, 1], y: 0.5, color: '#c7c2b7' },
  roof: { label: '屋顶', scale: [2.8, 1.2, 2.2], y: 0.5, color: '#c7c2b7' },
  tree: { label: '树木', scale: [1.8, 2.6, 1.8], y: 1.3, color: '#9ca68d' },
  vehicle: { label: '车辆', scale: [2.8, 1.2, 1.6], y: 0.5, color: '#c7c2b7' },
};

/**
 * 运镜几何参数（米 / 度 / 帧数）。集中在这里 —— 用户嫌镜头太快太慢、环绕幅度不够，
 * 改这几个数就行，不用碰算法。
 */
const CAM = {
  eyeY: 1.6, // 平视眼高。旧的 2.4 米是俯角，每条镜头看起来都在往下歪。
  lookY: 1.5, // 看向眼睛，和眼高几乎持平，地平线保持水平
  baseDistance: 5, // 默认机位距离（在角色质心前方 +z）
  nearDistance: 3.2, // 推近终点（dolly-in）
  farDistance: 7.5, // 拉远终点（dolly-out）
  orbitRadius: 5, // 环绕半径
  orbitSweep: 90, // 环绕总角度（度）
  panLateral: 2.2, // 摇镜时视线落点横向移动距离（米）
  focal: 50, // 焦距（mm）—— 景别靠距离表达，焦距固定，避免「推轨 + 变焦」双重计数
  // 采样密度：每 6 帧（0.2s @30fps）一个关键帧，含首尾。
  // 为什么不交给引擎的 'smooth'：MONOFORM 对**每个关键帧段各自**做 smoothstep
  // （vendor App.jsx 的 segmentAmount → ease）。只采 5 个点 = 一段一停的
  // 「加速-减速-加速」，观感就是发涩。这里自己烘一条**全局** ease 曲线、
  // 配 linear 插值稠密采样，速度曲线才是一条，段间没有涟漪。
  sampleIntervalFrames: 6,
  minSamples: 9,
  maxSamples: 61,
  // —— 导演级运镜（见 directingVocabulary.ts 的术语表）——
  craneLowY: 1.4, // 升降的低点
  craneHighY: 5.5, // 升降的高点
  railDistance: 3.2, // 横移总距离（米）
  zoomWide: 24, // 变焦的宽端（mm）
  zoomTele: 85, // 变焦的长端（mm）
  povEyeY: 1.55, // 主观镜头的眼高（米）
  jitterAmp: 0.12, // 手持抖动幅度（米）
  otsMinBack: 0.65, // 越肩机位与前景演员的最小后退距离，实际距离由景别和两人间距求解
};

interface MonoformObject {
  id: string;
  name: string;
  type: string;
  bodyType?: string;
  pose?: string;
  // 坐标用 number[]（不用 tuple）：翻译层是松边界，MONOFORM 的 normalizePerson 会 slice(0,3) 兜底。
  position: number[];
  rotation: number[];
  scale: number[];
  color?: string;
  /** 逐骨骼偏移（骨骼名 → [x,y,z] 弧度）。见 `skeletonAxisNotes.md` 与 `buildMonoformJoints`。 */
  joints?: Record<string, number[]>;
  [key: string]: unknown;
}

/** 一条对象动画关键帧（只写我们需要的字段，其余由 normalizeObjectTracks 补全）。 */
interface MonoformObjectKey {
  frame: number;
  interpolation: 'smooth' | 'linear' | 'hold';
  position: number[];
  rotation: number[];
  scale: number[];
  pose?: string;
  continuousMotion?: boolean;
  /** 手动定格/补录的基础姿态，微调时随关节偏移一同保留。 */
  poseTime?: number;
  rigRoot?: number[];
  poseBlend?: unknown;
  /** 稀疏骨骼增量（弧度）。没写的骨头保持姿势预设，不会被清成另一套绑定。 */
  joints?: Record<string, number[]>;
}

/** 一条相机关键帧（target 交给 MONOFORM 推 rotation，故意不写 rotation）。 */
interface MonoformCameraKey {
  frame: number;
  interpolation: 'smooth' | 'linear' | 'hold';
  position: number[];
  target: number[];
  focalLength: number;
  [key: string]: unknown;
}

/**
 * MONOFORM 工程里的任意对象。翻译层只读 `.type`/`.id` 分流、读 `.position` 算质心，
 * 其余字段原样透传 —— 所以是松类型，不是完整 MonoformObject（那是我们**新建**角色/物品
 * 时的形状）。写成显式可选属性（而不是只剩 index signature）才能通过 TS 的 weak-type 检查。
 */
type LooseObject = { id?: string; type?: string; position?: unknown; [key: string]: unknown };

interface MonoformShot {
  id?: string;
  objects?: LooseObject[];
  objectKeyframes?: Record<string, unknown>;
  keyframes?: unknown[];
  camera?: MonoformCameraState;
  [key: string]: unknown;
}

/** MONOFORM 当前机位的最小形状；保留索引签名以兼容引擎未来新增字段。 */
interface MonoformCameraState {
  position?: number[];
  target?: number[];
  rotation?: number[];
  focalLength?: number;
  aspectRatio?: string;
  [key: string]: unknown;
}

export interface MonoformProject {
  objects?: LooseObject[];
  camera?: MonoformCameraState;
  /** 相机轨（顶层）。 */
  keyframes?: unknown[];
  /** 对象动画轨：`{对象id: 关键帧[]}`。 */
  objectKeyframes?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  // MONOFORM 工程按 shot 存对象/相机；normalizeShot 以 shot.* 优先、顶层只是 fallback，
  // 所以注入必须同时改活动 shot（见 applyMonoformSceneIntent 注释）。
  activeShotId?: string;
  shots?: MonoformShot[];
  [key: string]: unknown;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapPose(pose: string | undefined): string {
  if (!pose) return 'idle';
  return POSE_MAP[pose] ?? pose;
}

/** 校验路线：至少 2 个合法 [x,z] 路点才算数，否则 null（与 360 导演台同口径）。 */
function sanitizeRoute(raw: unknown): Array<[number, number]> | null {
  if (!Array.isArray(raw)) return null;
  const pts = raw
    .filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2)
    .map((p) => [num(p[0]), num(p[1])] as [number, number]);
  return pts.length >= 2 ? pts : null;
}

/** 一条角色 intent → 一个 MONOFORM person 对象（最小字段，其余由 normalizePerson 补全）。 */
/**
 * 语义控制键 → 实际 GLB 的骨骼局部轴，不能把全身骨骼当成相同的坐标系。
 * Arm/ForeArm 的 X 沿骨长轴，旋转它只能拧手臂；放松站姿的前抬/弯肘必须绕 Y，
 * 左右再做镜像。负 Arm.pitch 前抬、正 Elbow.bend 弯肘，均按真实手腕位移验证。
 * 其他骨骼与 roll/spread 保留原有局部偏移；不能从蹲姿数值推断所有骨骼轴。
 *
 * 键名做归一化（**去掉所有分隔符**：`.`/`_`/`-`/空格 + 转小写），因为 LLM 常写
 * `Left_Shoulder.spread`、`head-pitch` 这类变体 —— 三者归一后都是同一个键。
 */
const normalizeControlKey = (key: string): string =>
  key.trim().toLowerCase().replace(/[._\-\s]/g, '');

type ControlAxis = 0 | 1 | 2;
const CONTROL_MAP: Record<string, { bone: string; axis: ControlAxis; sign: 1 | -1 }> = {};
{
  const add = (key: string, bone: string, axis: ControlAxis, sign: 1 | -1 = 1) => {
    CONTROL_MAP[normalizeControlKey(key)] = { bone, axis, sign };
  };
  // 躯干与头（白名单 5 根）
  add('hips.pitch', 'Hips', 0); add('hips.yaw', 'Hips', 1); add('hips.roll', 'Hips', 2);
  add('torso.pitch', 'Spine1', 0); add('torso.yaw', 'Spine1', 1); add('torso.roll', 'Spine1', 2);
  add('body.pitch', 'Spine2', 0); add('body.yaw', 'Spine2', 1); add('body.roll', 'Spine2', 2);
  add('neck.pitch', 'Neck', 0); add('neck.yaw', 'Neck', 1);
  add('head.pitch', 'Head', 0); add('head.yaw', 'Head', 1); add('head.roll', 'Head', 2);
  // 手臂长轴为 X；腿、脚和锁骨不套用手臂的局部坐标系。
  for (const segment of ['Shoulder', 'Arm', 'ForeArm', 'UpLeg', 'Leg', 'Foot'] as const) {
    for (const side of ['Left', 'Right'] as const) {
      const lower = side.toLowerCase();
      const arm = segment === 'Arm' || segment === 'ForeArm';
      add(`${lower}${segment}.pitch`, `${side}${segment}`, arm ? 1 : 0, arm && side === 'Right' ? -1 : 1);
      add(`${lower}${segment}.yaw`, `${side}${segment}`, arm ? 0 : 1);
      add(`${lower}${segment}.twist`, `${side}${segment}`, arm ? 0 : 1);
      add(`${lower}${segment}.roll`, `${side}${segment}`, 2);
      add(`${lower}${segment}.spread`, `${side}${segment}`, 2);
    }
  }
  // 旧约定里"弯"用 bend（膝、肘）
  add('leftKnee.bend', 'LeftLeg', 0); add('rightKnee.bend', 'RightLeg', 0);
  add('leftElbow.bend', 'LeftForeArm', 1, -1); add('rightElbow.bend', 'RightForeArm', 1);
}

/**
 * `controls`（`<关节>.<轴>: 度数`）→ MONOFORM 的 `joints`（骨骼名 → `[x,y,z]` **弧度**）。
 *
 * - 白名单外的键**静默丢弃** —— 一个拼错的关节名不该让整次场景注入崩掉。
 * - 角度 clamp 到 ±180（与 360 导演台同口径）。
 * - MONOFORM 的 `joints` 是**在该姿势预设之上叠加的 delta**，缺失骨骼自动补 [0,0,0]，
 *   所以只写要动的那几根即可（稀疏 = 在预设上微调，这是官方手工姿势的做法）。
 */
export function buildMonoformJoints(
  controls: Record<string, number> | undefined,
  baseJoints?: unknown,
): Record<string, number[]> | null {
  const joints: Record<string, number[]> = {};
  // 每拍都写入有效骨骼快照，避免引擎把缺省 joints 归一化为全零；不修改上一拍。
  if (isRecord(baseJoints)) {
    for (const [bone, angles] of Object.entries(baseJoints)) {
      if (Array.isArray(angles) && angles.length >= 3) joints[bone] = angles.slice(0, 3).map((v) => num(v));
    }
  }
  const put = (rawKey: string, rawDegrees: unknown) => {
    const spec = CONTROL_MAP[normalizeControlKey(rawKey)];
    if (!spec || typeof rawDegrees !== 'number' || !Number.isFinite(rawDegrees)) return;
    const clamped = Math.max(-180, Math.min(180, rawDegrees));
    const bone = 'mixamorig' + spec.bone;
    const axisValue = clamped === 0 ? 0 : (clamped * spec.sign * Math.PI) / 180;
    const current = joints[bone] ?? [0, 0, 0];
    current[spec.axis] = axisValue;
    joints[bone] = current;
  };
  for (const [rawKey, rawDegrees] of Object.entries(isRecord(controls) ? controls : {})) {
    if (rawDegrees && typeof rawDegrees === 'object' && !Array.isArray(rawDegrees)) {
      // 兼容模型更容易写出的嵌套格式：{rightShoulder:{pitch:30,spread:45}}。
      for (const [axis, value] of Object.entries(rawDegrees as Record<string, unknown>)) {
        put(rawKey + '.' + axis, value);
      }
    } else {
      put(rawKey, rawDegrees);
    }
  }
  return Object.keys(joints).length > 0 ? joints : null;
}

/** 台词只保留能播的句子。空数组表示调用方显式清空，undefined 表示没写这个字段。 */
function sanitizeSpeechLines(
  value: unknown,
): Array<{ text: string; start: number; end: number }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const lines: Array<{ text: string; start: number; end: number }> = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.text !== 'string') continue;
    const text = raw.text.trim().slice(0, 80);
    const start = Number(raw.start);
    const end = Number(raw.end);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > 600) continue;
    lines.push({ text, start, end });
    if (lines.length >= 12) break;
  }
  return lines;
}

export function buildMonoformCharacter(
  intent: DirectorSceneCharacterIntent,
  index: number,
): MonoformObject {
  const route = sanitizeRoute(intent.route);
  // 起点：at 优先，其次 route 首点，再退到按序号错开（避免重叠）。
  const at = intent.at ?? route?.[0] ?? [index * 1.2 - 0.6, 0];
  const facing = num(intent.facing, 0);
  const restPose = mapPose(intent.pose);
  // 有路线时本体先站住：走路姿势交给关键帧轨（否则起步前会定格在迈步中间）。
  const pose = route && (restPose === 'walk' || restPose === 'run') ? 'idle' : restPose;
  /*
    逐骨骼造型只在**非循环预设**上叠加：走路是循环剪辑，再叠 joints 偏移会打架，
    所以给了 route 就丢弃 controls（以走位为准 —— 这条降级写进了提示词）。
    注意 MONOFORM 的 `cloneJointPose` 是**完全替换**语义（没给的骨骼回到中性），
    所以这里同时给 pose 与 joints：pose 保住基础姿态，joints 表达"改哪几根"。
  */
  const joints = route ? null : buildMonoformJoints(intent.controls);
  const lines = sanitizeSpeechLines(intent.lines);
  return {
    id: `${GEN_CHAR_PREFIX}${index + 1}`,
    name: intent.name || `人物 ${index + 1}`,
    type: 'person',
    bodyType: 'standard',
    pose,
    position: [num(at[0]), 0, num(at[1])],
    // 朝向：绕 Y 轴，度→弧度（0 = 面向 +z/镜头，与 facing 约定一致）。
    rotation: [0, (facing * Math.PI) / 180, 0],
    scale: [1, 1, 1],
    color: intent.color || '#e8e3d8',
    ...(joints ? { joints } : {}),
    ...(lines && lines.length > 0 ? { lines } : {}),
  };
}

/**
 * 一条物品 intent → 一个 MONOFORM 物体；未知类型丢弃（返回 null），
 * 保证 agent 拼错词也不会把工程写坏。默认尺寸/抬升/配色照抄 addPrimitive。
 */
/**
 * depthMesh：**灰度图当高度场**（地形 / 浮雕），不是"任意 3D 生成"。
 *
 * 契约照抄 MONOFORM 的 `DepthMeshModel`（`Viewport.jsx`）：对象上给 `depthMapUrl` +
 * `depthSettings`（invert/near/far/fov/density/smoothing）。值域也按它的 clamp 先钳一次，
 * 免得把脏值写进工程（引擎虽然也会钳，但工程里留着越界值会让用户困惑）。
 *
 * 没给 URL 就丢弃（与未知 type 同口径，静默）—— 没图的 depthMesh 渲染不出任何东西。
 */
function buildMonoformDepthMesh(
  intent: DirectorScenePropIntent,
  index: number,
): MonoformObject | null {
  const url = typeof intent.depthMapUrl === 'string' ? intent.depthMapUrl.trim() : '';
  if (!url) return null;
  const raw = isRecord(intent.depth) ? intent.depth : {};
  const near = Math.max(0.05, num(raw.near, 0.8));
  const at = Array.isArray(intent.at) && intent.at.length >= 2 ? intent.at : [0, 0];
  return {
    id: `${GEN_PROP_PREFIX}${index + 1}`,
    name: typeof intent.name === 'string' && intent.name.trim() ? intent.name.trim() : '地形',
    type: 'depthMesh',
    depthMapUrl: url,
    depthSettings: {
      invert: raw.invert === true,
      near,
      far: Math.max(near + 0.1, num(raw.far, 6)),
      fov: clampNumber(num(raw.fov, 60), 20, 120),
      density: Math.round(clampNumber(num(raw.density, 64), 16, 128)),
      smoothing: Math.round(clampNumber(num(raw.smoothing, 1), 0, 4)),
    },
    // 地形默认贴地（其他粗模的默认抬升是 0.5，那会让地形悬空）。
    position: [num(at[0]), num(intent.y, 0), num(at[1])],
    rotation: [0, (num(intent.rotationY, 0) * Math.PI) / 180, 0],
    scale:
      Array.isArray(intent.scale) && intent.scale.length >= 3
        ? [num(intent.scale[0], 1), num(intent.scale[1], 1), num(intent.scale[2], 1)]
        : [1, 1, 1],
    color: typeof intent.color === 'string' && intent.color ? intent.color : '#c7c2b7',
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * model：外部 GLB（Blender 参数化模板生成的导演向几何）。
 *
 * MONOFORM 的 `type:'model'` + `url` 是它的**原生能力**（内置 X-Bot 就这么加载），
 * `normalizePerson` 对非 person 对象逐字保留 —— 所以只需把 url 原样带过去。
 * 没给 URL 就丢弃（与未知 type 同口径）。
 */
function buildMonoformModel(intent: DirectorScenePropIntent, index: number): MonoformObject | null {
  const url = typeof intent.modelUrl === 'string' ? intent.modelUrl.trim() : '';
  if (!url) return null;
  const at = Array.isArray(intent.at) && intent.at.length >= 2 ? intent.at : [0, 0];
  return {
    id: `${GEN_PROP_PREFIX}${index + 1}`,
    name: typeof intent.name === 'string' && intent.name.trim() ? intent.name.trim() : '模型',
    type: 'model',
    url,
    position: [num(at[0]), num(intent.y, 0), num(at[1])],
    rotation: [0, (num(intent.rotationY, 0) * Math.PI) / 180, 0],
    scale:
      Array.isArray(intent.scale) && intent.scale.length >= 3
        ? [num(intent.scale[0], 1), num(intent.scale[1], 1), num(intent.scale[2], 1)]
        : [1, 1, 1],
    color: typeof intent.color === 'string' && intent.color ? intent.color : '#c7c2b7',
  };
}

export function buildMonoformProp(intent: DirectorScenePropIntent, index: number): MonoformObject | null {
  // depthMesh / model 不走 PROP_DEFAULTS：它们没有预设尺寸/配色，参数是各自那一套。
  if (intent?.type === 'depthMesh') return buildMonoformDepthMesh(intent, index);
  if (intent?.type === 'model') return buildMonoformModel(intent, index);
  const preset = PROP_DEFAULTS[intent?.type];
  if (!preset) return null;
  const at = Array.isArray(intent.at) && intent.at.length >= 2 ? intent.at : [0, 0];
  const scale =
    Array.isArray(intent.scale) && intent.scale.length >= 3
      ? [num(intent.scale[0], 1), num(intent.scale[1], 1), num(intent.scale[2], 1)]
      : [...preset.scale];
  return {
    id: `${GEN_PROP_PREFIX}${index + 1}`,
    name: typeof intent.name === 'string' && intent.name.trim() ? intent.name.trim() : preset.label,
    type: intent.type,
    position: [num(at[0]), num(intent.y, preset.y), num(at[1])],
    rotation: [0, (num(intent.rotationY, 0) * Math.PI) / 180, 0],
    scale,
    color: typeof intent.color === 'string' && intent.color ? intent.color : preset.color,
  };
}

/** 角色质心的地面坐标 [x, z]（相机看向它）。无角色回落原点。 */
function personCentroid(persons: readonly LooseObject[]): [number, number] {
  const pts = persons
    .map((p) => (Array.isArray(p.position) ? p.position : []))
    .filter((pos) => pos.length >= 3);
  if (pts.length === 0) return [0, 0];
  const sx = pts.reduce((s, p) => s + num(p[0]), 0) / pts.length;
  const sz = pts.reduce((s, p) => s + num(p[2]), 0) / pts.length;
  return [sx, sz];
}

/** 与引擎相同的分段插值；相机和人物必须使用相同时间曲线。 */
function trackSegmentAt(keys: readonly MonoformObjectKey[], frame: number) {
  const sorted = [...keys].sort((a, b) => a.frame - b.frame);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (frame <= first.frame) return { a: first, b: first, t: 0 };
  if (frame >= last.frame) return { a: last, b: last, t: 0 };
  const index = sorted.findIndex((key) => key.frame >= frame);
  const a = sorted[index - 1];
  const b = sorted[index];
  const raw = (frame - a.frame) / Math.max(1, b.frame - a.frame);
  const t = a.interpolation === 'hold' && frame < b.frame ? 0
    : a.interpolation === 'smooth' ? raw * raw * (3 - 2 * raw) : raw;
  return { a, b, t };
}

/** 一条角色轨在第 frame 帧的地面坐标 [x,z]，端点外保持端点。 */
export function trackPositionAt(keys: readonly MonoformObjectKey[], frame: number): [number, number] {
  const { a, b, t } = trackSegmentAt(keys, frame);
  return [
    num(a.position[0]) + (num(b.position[0]) - num(a.position[0])) * t,
    num(a.position[2]) + (num(b.position[2]) - num(a.position[2])) * t,
  ];
}

/** 站立白模的身体中心至少隔开这么远，拳脚靠手臂伸过去，躯干不再叠在一起。 */
const PERSON_BODY_GAP = 0.82;
/** 对打能出拳的身体中心距离。更远时拳头够不到，更近时躯干容易叠上。 */
const FIGHT_STRIKE_DISTANCE = 1.1;
/** 一场对打至少这多次出招。模型只写三回合时，后面按这个间隔补攻防。 */
const FIGHT_ROUNDS = 6;
const FIGHT_ROUND_GAP = 1.25;
const FIGHT_STRIKE_PATTERN = /直拳|出拳|冲拳|摆拳|勾拳|前踢|正踢|踢击|punch|jab|cross|hook|frontkick/i;
const FIGHT_REPLY_PATTERN = /格挡|招架|架招|闪避|侧闪|闪身|进步|上步|退步|撤步|后撤|block|parry|dodge|advance|retreat|蓄势|chamber/i;
const FIGHT_ROUND_PATTERNS: ReadonlyArray<readonly [string, string]> = [
  ['直拳', '格挡'],
  ['摆拳', '闪避'],
  ['前踢', '格挡'],
  ['直拳', '闪避'],
  ['摆拳', '格挡'],
  ['前踢', '退步'],
];

function performanceText(beat: DirectorScenePerformanceBeat | undefined): string {
  if (!beat) return '';
  return [beat.action, ...(beat.actions ?? [])].filter((name): name is string => typeof name === 'string').join(' ');
}

function isTrailingFightRest(beat: DirectorScenePerformanceBeat): boolean {
  const text = performanceText(beat);
  if (FIGHT_STRIKE_PATTERN.test(text) || FIGHT_REPLY_PATTERN.test(text)) return false;
  if (/收势|settle|relax/.test(text)) return true;
  return !text && !beat.controls && !beat.at && typeof beat.facing !== 'number';
}

/**
 * 模型常把对打写成三次交手。这里把不足六次的出招补上，攻守轮换，
 * 原来的招式保留，收势仍放在最后。
 */
function padFightRounds(characters: DirectorSceneCharacterIntent[]): DirectorSceneCharacterIntent[] {
  if (characters.length !== 2 || characters.some((character) => sanitizeRoute(character.route))) return characters;
  const strikeTimes: number[] = [];
  for (const character of characters) {
    for (const beat of character.performance ?? []) {
      if (FIGHT_STRIKE_PATTERN.test(performanceText(beat))) strikeTimes.push(Math.max(0, num(beat.t)));
    }
  }
  const unique: number[] = [];
  for (const time of strikeTimes.sort((a, b) => a - b)) {
    if (unique.length === 0 || time - unique[unique.length - 1] > 0.2) unique.push(time);
  }
  if (unique.length === 0 || unique.length >= FIGHT_ROUNDS) return characters;
  const lastStrike = unique[unique.length - 1];
  const added = FIGHT_ROUNDS - unique.length;
  const times = Array.from({ length: added }, (_, index) => lastStrike + (index + 1) * FIGHT_ROUND_GAP);
  const settleAt = times[times.length - 1] + 0.85;
  return characters.map((character, index) => {
    const kept = (character.performance ?? []).filter((beat) => num(beat.t) < lastStrike + 0.15 || !isTrailingFightRest(beat));
    const extra = times.map((time, offset) => {
      const round = unique.length + offset;
      const [strike, answer] = FIGHT_ROUND_PATTERNS[round % FIGHT_ROUND_PATTERNS.length];
      return {
        t: time,
        action: index === round % 2 ? strike : answer,
        side: (round % 2 === 0 ? 'right' : 'left') as 'left' | 'right',
        intensity: 0.9,
      };
    });
    return { ...character, performance: [...kept, ...extra, { t: settleAt, action: '收势' }] };
  });
}

function withFightChambers(beats: Array<DirectorScenePerformanceBeat & { t: number }>): Array<DirectorScenePerformanceBeat & { t: number }> {
  const next: Array<DirectorScenePerformanceBeat & { t: number }> = [];
  for (const beat of beats) {
    const previous = next[next.length - 1];
    const gap = beat.t - (previous?.t ?? 0);
    const chambered = /蓄势|chamber|coil|windup/i.test(performanceText(previous));
    if (FIGHT_STRIKE_PATTERN.test(performanceText(beat)) && !chambered && gap >= 0.45) {
      const t = Math.max((previous?.t ?? 0) + 0.08, beat.t - 0.32);
      if (t < beat.t - 0.05) {
        next.push({
          t,
          action: '蓄势',
          side: beat.side,
          intensity: beat.intensity ?? 0.9,
        });
      }
    }
    next.push(beat);
  }
  return next;
}

function characterPlanarAt(character: DirectorSceneCharacterIntent, index: number): [number, number] {
  if (Array.isArray(character.at) && character.at.length >= 2) return [num(character.at[0]), num(character.at[1])];
  return [index * 1.2 - 0.6, 0];
}

/** 对打站得过远或过近时，沿两人连线收到出拳距离，中点不动。已在可达范围内的站位保持原样。 */
function placeFightStrikingDistance(characters: DirectorSceneCharacterIntent[]): DirectorSceneCharacterIntent[] {
  if (characters.length !== 2 || characters.some((character) => sanitizeRoute(character.route))) return characters;
  const current = characters.map((character, index) => characterPlanarAt(character, index));
  const dx = current[1][0] - current[0][0];
  const dz = current[1][1] - current[0][1];
  const distance = Math.hypot(dx, dz);
  if (distance >= 0.95 && distance <= 1.45) return characters;
  const ux = distance > 1e-4 ? dx / distance : 1;
  const uz = distance > 1e-4 ? dz / distance : 0;
  const midX = (current[0][0] + current[1][0]) / 2;
  const midZ = (current[0][1] + current[1][1]) / 2;
  const half = FIGHT_STRIKE_DISTANCE / 2;
  const targets: [number, number][] = [
    [midX - ux * half, midZ - uz * half],
    [midX + ux * half, midZ + uz * half],
  ];
  return characters.map((character, index) => {
    const deltaX = targets[index][0] - current[index][0];
    const deltaZ = targets[index][1] - current[index][1];
    return {
      ...character,
      at: targets[index],
      performance: character.performance?.map((beat) => (
        Array.isArray(beat.at) && beat.at.length >= 2
          ? { ...beat, at: [num(beat.at[0]) + deltaX, num(beat.at[1]) + deltaZ] as [number, number] }
          : beat
      )),
    };
  });
}

function fightPerformance(characters: readonly { performance?: readonly { action?: string; actions?: string[] }[] }[] | undefined): boolean {
  const tokens = ['直拳', '出拳', '冲拳', '摆拳', '勾拳', '格挡', '招架', '架招', '闪避', '侧闪', '闪身', '前踢', '正踢', '踢击', '进步', '上步', '退步', '撤步', '后撤', 'punch', 'hook', 'block', 'dodge', 'frontkick', 'advance', 'retreat'];
  return (characters ?? []).some((character) => (character.performance ?? []).some((beat) => {
    const names = [beat.action, ...(beat.actions ?? [])].filter((name): name is string => typeof name === 'string');
    return names.some((name) => tokens.some((token) => name.toLowerCase().includes(token)));
  }));
}

function asMotionTrack(value: unknown): MonoformObjectKey[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  if (!value.every((key) => isRecord(key) && typeof key.frame === 'number' && Array.isArray(key.position))) return null;
  return value as MonoformObjectKey[];
}

function restingKey(object: LooseObject): MonoformObjectKey {
  const position = Array.isArray(object.position) ? object.position.map((value) => num(value)) : [0, 0, 0];
  return {
    frame: 0,
    interpolation: 'linear',
    position,
    rotation: Array.isArray(object.rotation) ? object.rotation.map((value) => num(value)) : [0, 0, 0],
    scale: Array.isArray(object.scale) ? object.scale.map((value) => num(value, 1)) : [1, 1, 1],
    pose: typeof object.pose === 'string' ? object.pose : 'idle',
    continuousMotion: false,
  };
}

/** 对打时把过近的身体沿地面推开，并写回关键帧，播放插值也不会再穿过去。 */
function keepPersonClearance(
  objects: LooseObject[],
  tracks: Record<string, unknown>,
): void {
  const actors = objects.flatMap((object) => {
    if (object?.type !== 'person' || typeof object.id !== 'string') return [];
    const track = asMotionTrack(tracks[object.id]);
    return [{ object, track: track ? [...track].sort((a, b) => a.frame - b.frame) : null }];
  });
  if (actors.length < 2) return;
  const frames = new Set<number>([0]);
  let maxFrame = 0;
  for (const actor of actors) {
    for (const key of actor.track ?? []) {
      frames.add(key.frame);
      maxFrame = Math.max(maxFrame, key.frame);
    }
  }
  for (let frame = 0; frame <= maxFrame; frame += 2) frames.add(frame);
  const write = (actor: (typeof actors)[number], frame: number, x: number, z: number) => {
    if (!actor.track) {
      actor.track = [restingKey(actor.object)];
      tracks[String(actor.object.id)] = actor.track;
    }
    const existing = actor.track.find((key) => key.frame === frame);
    if (existing) {
      existing.position = [x, num(existing.position[1]), z];
      return;
    }
    const left = [...actor.track].reverse().find((key) => key.frame <= frame) ?? actor.track[0];
    actor.track.push({
      ...left,
      frame,
      interpolation: 'linear',
      position: [x, num(left.position[1]), z],
      rotation: [...left.rotation],
      scale: [...left.scale],
      ...(left.rigRoot ? { rigRoot: [...left.rigRoot] } : {}),
      ...(left.joints ? { joints: JSON.parse(JSON.stringify(left.joints)) as Record<string, number[]> } : {}),
    });
    actor.track.sort((a, b) => a.frame - b.frame);
  };
  for (let pass = 0; pass < 3; pass += 1) {
    let moved = false;
    for (const frame of [...frames].sort((a, b) => a - b)) {
      const points = actors.map((actor) => {
        const position = Array.isArray(actor.object.position) ? actor.object.position : [0, 0, 0];
        const [x, z] = actor.track?.length ? trackPositionAt(actor.track, frame) : [num(position[0]), num(position[2])];
        return { actor, x, z };
      });
      for (let guard = 0; guard < 4; guard += 1) {
        for (let i = 0; i < points.length; i += 1) {
          for (let j = i + 1; j < points.length; j += 1) {
            const dx = points[i].x - points[j].x;
            const dz = points[i].z - points[j].z;
            const distance = Math.hypot(dx, dz);
            if (distance >= PERSON_BODY_GAP) continue;
            const push = (PERSON_BODY_GAP - distance) / 2;
            const ux = distance > 1e-4 ? dx / distance : 1;
            const uz = distance > 1e-4 ? dz / distance : 0;
            points[i].x += ux * push;
            points[i].z += uz * push;
            points[j].x -= ux * push;
            points[j].z -= uz * push;
          }
        }
      }
      for (const point of points) {
        const position = Array.isArray(point.actor.object.position) ? point.actor.object.position : [0, 0, 0];
        const [x, z] = point.actor.track?.length
          ? trackPositionAt(point.actor.track, frame)
          : [num(position[0]), num(position[2])];
        if (Math.hypot(point.x - x, point.z - z) < 0.005) continue;
        write(point.actor, frame, point.x, point.z);
        moved = true;
      }
    }
    if (!moved) break;
  }
  for (const actor of actors) {
    if (actor.track) tracks[String(actor.object.id)] = actor.track;
    if (!actor.track?.length || !Array.isArray(actor.object.position)) continue;
    const [x, z] = trackPositionAt(actor.track, 0);
    actor.object.position = [x, num(actor.object.position[1]), z];
  }
}

/**
 * 角色 route → 走路动画轨（objectAtFrame 消费）：
 * 沿路点铺 position 关键帧（帧号 = (start + duration·进度)·fps），朝向取该段行进方向，
 * pose 用 walk/run 并打开 continuousMotion 让循环剪辑跑起来；**终点补一帧静止姿势**
 * 把循环停住，否则角色会在终点原地踏步。
 */
export function buildMonoformCharacterTrack(
  route: Array<[number, number]>,
  intent: DirectorSceneCharacterIntent,
  fps: number,
  current: LooseObject = {},
): MonoformObjectKey[] {
  const start = Math.max(0, num(intent.start, 0));
  const duration = Math.max(0.5, num(intent.routeDuration, 5));
  const restPose = mapPose(intent.pose);
  const movingPose = restPose === 'run' ? 'run' : 'walk';
  const stillPose = restPose === 'walk' || restPose === 'run' ? 'idle' : restPose;
  const n = route.length;
  const keys: MonoformObjectKey[] = route.map(([x, z], i) => {
    // 朝向：0 = 面向 +z（与 facing 约定同源）。末点沿用最后一段的方向。
    const dx = i + 1 < n ? route[i + 1][0] - x : x - route[i - 1][0];
    const dz = i + 1 < n ? route[i + 1][1] - z : z - route[i - 1][1];
    return {
      frame: Math.round((start + (duration * i) / (n - 1)) * fps),
      interpolation: 'linear' as const,
      position: [x, 0, z],
      rotation: [0, Math.atan2(dx, dz), 0],
      scale: Array.isArray(current.scale) ? current.scale.map((v) => num(v, 1)) : [1, 1, 1],
      pose: movingPose,
      continuousMotion: true,
    };
  });
  if (keys[0].frame > 0) {
    // 引擎会把首关键帧外推到帧 0；补保持帧才能真正做到「先站住，再起步」。
    const joints = buildMonoformJoints(undefined, current.joints);
    keys.unshift({
      ...keys[0],
      frame: 0,
      interpolation: 'hold',
      position: intent.at
        ? [num(intent.at[0]), 0, num(intent.at[1])]
        : Array.isArray(current.position) ? current.position.map((v) => num(v)) : [...keys[0].position],
      rotation: typeof intent.facing === 'number'
        ? [0, num(intent.facing) * Math.PI / 180, 0]
        : Array.isArray(current.rotation) ? current.rotation.map((v) => num(v)) : [...keys[0].rotation],
      pose: typeof current.pose === 'string' ? mapPose(current.pose) : stillPose,
      continuousMotion: false,
      ...(joints ? { joints } : {}),
    });
  }
  const last = keys[keys.length - 1];
  keys.push({
    ...last,
    frame: last.frame + Math.max(1, Math.round(fps * 0.25)), // 到站后 0.25s 收起动作
    pose: stillPose,
    continuousMotion: false,
  });
  return keys;
}

/** 动作词归一化：允许模型用中文、英文或带短横线的同义词。 */
function normalizePerformanceAction(action: unknown): string {
  return typeof action === 'string'
    ? action.trim().toLowerCase().replace(/[\s_\-·，。,.:：/]+/g, '')
    : '';
}

type PerformanceActionExpansion = {
  pose?: string;
  continuousMotion?: boolean;
  controls: Record<string, number>;
  /** 相对当前朝向的平面位移：[横向（右为正）, 前后（前为正）]，单位米。 */
  positionOffset?: [number, number];
  /** 相对当前朝向的转身角度，单位度。 */
  facingOffset?: number;
};

/**
 * 把模型容易表达的高层动作展开成可执行的骨骼节拍。
 *
 * 这里故意只做“粗演动作词”到白模能力的确定性翻译：真实接触、手指和表情仍不在
 * MONOFORM 的能力范围内。显式 controls 会在调用处覆盖同一拍的默认值，便于模型或
 * 用户在保留大白话动作的同时做局部微调。
 */
export function expandMonoformPerformanceBeat(
  beat: DirectorScenePerformanceBeat,
): PerformanceActionExpansion {
  /**
   * 把一拍里的动作组合拆开再合并。模型常把舞步写成「向右迈并挥臂」，
   * 也可能更稳定地输出 actions 数组；两种写法都落到同一套确定性动作展开。
   * 组合只合并互补的位移/朝向/骨骼，不会改变各动作的强度标定。
   */
  const listedActions = Array.isArray(beat.actions)
    ? beat.actions
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .slice(0, 2)
    : [];
  const textActions = listedActions.length === 0 && typeof beat.action === 'string'
    ? beat.action
      .split(/\s*(?:\+|&|\/|、|,|，|;|；|并且|并|然后|接着|\band\b)\s*/i)
      .map(item => item.trim())
      .filter(Boolean)
    : [];
  const compoundActions = (listedActions.length > 0 ? listedActions : textActions).slice(0, 2);
  if (compoundActions.length > 1 || (listedActions.length === 1 && !beat.action)) {
    const expansions = compoundActions.map(action => expandMonoformPerformanceBeat({
      ...beat,
      action,
      actions: undefined,
    }));
    const mergedControls: Record<string, number> = {};
    let mergedPose: string | undefined;
    let mergedContinuousMotion: boolean | undefined;
    let lateral = 0;
    let forward = 0;
    let turn = 0;
    for (const expansion of expansions) {
      Object.assign(mergedControls, expansion.controls);
      if (expansion.pose !== undefined) mergedPose = expansion.pose;
      if (expansion.continuousMotion !== undefined) mergedContinuousMotion = expansion.continuousMotion;
      const actionName = compoundActions[expansions.indexOf(expansion)] ?? '';
      const hasStrike = /直拳|出拳|冲拳|摆拳|勾拳|前踢|正踢|踢击|punch|hook|frontkick/i.test(compoundActions.join(' '));
      const stepOnly = /进步|上步|靠近|advance|stepin|逼近/i.test(actionName);
      // 直拳自己已经带一小步。再叠加进步会把人送进对方身体，分离时又被推回来，看起来像滑步。
      if (expansion.positionOffset && !(hasStrike && stepOnly)) {
        lateral += expansion.positionOffset[0];
        forward += expansion.positionOffset[1];
      }
      if (expansion.facingOffset !== undefined) turn += expansion.facingOffset;
    }
    return {
      pose: mergedPose,
      continuousMotion: mergedContinuousMotion,
      controls: mergedControls,
      ...(lateral || forward ? { positionOffset: [lateral, forward] as [number, number] } : {}),
      ...(turn ? { facingOffset: turn } : {}),
    };
  }
  const action = normalizePerformanceAction(beat.action);
  const side = beat.side === 'left' || beat.side === 'right' || beat.side === 'both'
    ? beat.side
    : 'right';
  const intensity = Math.min(1.2, Math.max(0.4, num(beat.intensity, 1)));
  const controls: Record<string, number> = {};
  const put = (name: string, value: number) => {
    const scaled = Math.round(value * intensity * 10) / 10;
    controls[name] = scaled === 0 ? 0 : scaled;
  };
  const eachSide = (callback: (prefix: 'left' | 'right') => void) => {
    if (side === 'left' || side === 'both') callback('left');
    if (side === 'right' || side === 'both') callback('right');
  };
  const bothSides = (callback: (prefix: 'left' | 'right') => void) => {
    callback('left');
    callback('right');
  };
  const arm = (prefix: 'left' | 'right', value: number) => put(`${prefix}Arm.pitch`, value);
  const foreArm = (prefix: 'left' | 'right', value: number) => put(`${prefix}ForeArm.pitch`, value);
  const elbow = (prefix: 'left' | 'right', value: number) => put(`${prefix}Elbow.bend`, value);
  const shoulder = (prefix: 'left' | 'right', value: number) => put(`${prefix}Shoulder.pitch`, value);
  const shoulderYaw = (prefix: 'left' | 'right', value: number) => put(`${prefix}Shoulder.yaw`, prefix === 'left' ? value : -value);
  const shoulderRoll = (prefix: 'left' | 'right', value: number) => put(`${prefix}Shoulder.roll`, prefix === 'left' ? value : -value);
  const foreArmTwist = (prefix: 'left' | 'right', value: number) => put(`${prefix}ForeArm.twist`, prefix === 'left' ? value : -value);
  // Arm.roll 的真实 GLB 左右不自动镜像；语义层显式把“向外”换成左正、右负。
  const armRoll = (prefix: 'left' | 'right', value: number) => put(`${prefix}Arm.roll`, prefix === 'left' ? value : -value);
  const foreArmRoll = (prefix: 'left' | 'right', value: number) => put(`${prefix}ForeArm.roll`, prefix === 'left' ? value : -value);
  const thigh = (prefix: 'left' | 'right', value: number) => put(`${prefix}UpLeg.pitch`, value);
  const shin = (prefix: 'left' | 'right', value: number) => put(`${prefix}Leg.pitch`, value);
  const foot = (prefix: 'left' | 'right', value: number) => put(`${prefix}Foot.pitch`, value);

  // 舞蹈动作使用“重心 + 身体层次”的小组合同步展开，而不是只扭一根骨头。
  // 数值保持在白模可读的粗演范围；模型仍可用 controls 覆盖单个轴。
  const danceSide = side === 'left' || side === 'right' ? side : 'right';
  const sideSign = danceSide === 'left' ? -1 : 1;
  const setLegLift = (prefix: 'left' | 'right', amount: number) => {
    thigh(prefix, -amount);
    shin(prefix, amount * 0.35);
    foot(prefix, -amount * 0.28);
  };
  // 手势不只动一根骨头：躯干先带一点，头再多转一点，对侧留一点反向。
  const yawSign = side === 'left' ? -1 : side === 'right' ? 1 : 0;
  const leanInto = (yaw: number, headPitch: number) => {
    if (yawSign !== 0 && yaw !== 0) {
      put('hips.yaw', yaw * 0.4 * yawSign);
      put('torso.yaw', yaw * yawSign);
      put('head.yaw', yaw * 1.5 * yawSign);
    }
    if (headPitch !== 0) put('head.pitch', headPitch);
  };

  let pose: string | undefined;
  let continuousMotion: boolean | undefined;
  let positionOffset: [number, number] | undefined;
  let facingOffset: number | undefined;
  if (['reach', 'reachout', 'extend', 'extendhand', '伸手', '递出', '递给他', '递给她', '指向'].some(token => action.includes(token))) {
    eachSide(prefix => {
      arm(prefix, -42);
      // 前臂再补一小段前伸；肘部用更小的量形成自然折线，而不是一根直棍。
      foreArm(prefix, -18);
      elbow(prefix, 24);
      shoulder(prefix, -8);
    });
    leanInto(8, -6);
  } else if (['withdraw', 'retract', '收手', '收回', '收拢', '放下'].some(token => action.includes(token))) {
    eachSide(prefix => {
      arm(prefix, 0);
      foreArm(prefix, 0);
      elbow(prefix, 0);
      shoulder(prefix, 0);
    });
    put('torso.pitch', 3);
    put('head.pitch', 6);
  } else if (['touch', '轻触', '触碰', '牵手', '接过'].some(token => action.includes(token))) {
    eachSide(prefix => {
      arm(prefix, -30);
      foreArm(prefix, -12);
      elbow(prefix, 18);
      shoulder(prefix, -6);
    });
    leanInto(6, -4);
  } else if (['embrace', 'hug', '拥抱', '抱住'].some(token => action.includes(token))) {
    // 白模没有接触求解，这里表现为双方张臂靠近；不声称手臂已经精确相交。
    bothSides(prefix => {
      arm(prefix, -34);
      foreArm(prefix, -20);
      elbow(prefix, 32);
    });
    put('hips.pitch', 4);
    put('torso.pitch', 8);
    put('head.pitch', 10);
  } else if (['openarms', 'open', '张开双臂', '张开手臂'].some(token => action.includes(token))) {
    put('leftShoulder.spread', -62);
    put('rightShoulder.spread', 62);
    bothSides(prefix => {
      arm(prefix, -28);
      armRoll(prefix, 34);
      foreArmRoll(prefix, 12);
    });
    put('torso.pitch', -6);
    put('head.pitch', -5);
  } else if (['raisearms', 'raise', '举臂', '上举', '抬臂', '举起双手'].some(token => action.includes(token))) {
    // 上举同时分配到大臂、前臂、肘与外展，避免单根骨骼拧到极限。
    bothSides(prefix => {
      arm(prefix, -118);
      foreArm(prefix, -28);
      elbow(prefix, 16);
      armRoll(prefix, 42);
      foreArmRoll(prefix, 16);
    });
    put('torso.pitch', -5);
    put('head.pitch', -8);
  } else if (['armsweep', '挥臂', '摆臂', '手臂扫过'].some(token => action.includes(token))) {
    const sweep = side === 'left' ? 'left' : side === 'right' ? 'right' : 'right';
    arm(sweep, -62);
    foreArm(sweep, -22);
    elbow(sweep, 28);
    armRoll(sweep, 48);
    foreArmRoll(sweep, 20);
    positionOffset = [sweep === 'left' ? -0.18 * intensity : 0.18 * intensity, 0];
  } else if (['armcircle', 'armcircles', '手臂绕环', '大臂绕环', '画臂'].some(token => action.includes(token))) {
    // 绕环把抬臂、外旋和前臂折线分开，避免只用一个 pitch 造成木偶感。
    eachSide(prefix => {
      shoulder(prefix, -14);
      shoulderYaw(prefix, 22 * sideSign);
      arm(prefix, -54);
      foreArm(prefix, -26);
      elbow(prefix, 24);
      armRoll(prefix, 46 * sideSign);
      foreArmRoll(prefix, -18 * sideSign);
    });
    put('torso.roll', 5 * sideSign);
  } else if (['shoulderroll', 'shouldercircle', '肩部绕环', '绕肩', '耸肩'].some(token => action.includes(token))) {
    // 肩部是锁骨层的小幅运动，只用于增加律动，不冒充整条手臂抬起。
    eachSide(prefix => {
      shoulder(prefix, -16);
      shoulderYaw(prefix, 18 * sideSign);
      shoulderRoll(prefix, 24 * sideSign);
    });
    put('torso.roll', 4 * sideSign);
    put('head.roll', -3 * sideSign);
  } else if (['chestpop', 'chestisolation', '胸腔前送', '胸部律动', '胸震', '挺胸'].some(token => action.includes(token))) {
    put('hips.pitch', 5);
    put('torso.pitch', -14);
    put('body.pitch', -18);
    put('head.pitch', -5);
    positionOffset = [0, 0.05 * intensity];
  } else if (['wristflourish', 'handflourish', '腕花', '翻腕', '手腕花'].some(token => action.includes(token))) {
    eachSide(prefix => {
      arm(prefix, -32);
      foreArm(prefix, -22);
      elbow(prefix, 26);
      foreArmTwist(prefix, 34 * sideSign);
      foreArmRoll(prefix, 18 * sideSign);
    });
  } else if (['crossstep', '交叉步', '交叉侧步', '擦步'].some(token => action.includes(token))) {
    const lead = danceSide;
    const support = lead === 'left' ? 'right' : 'left';
    positionOffset = [0.42 * sideSign * intensity, 0.08 * intensity];
    thigh(lead, -28);
    shin(lead, 16);
    foot(lead, -16);
    put(`${lead}UpLeg.yaw`, 20 * sideSign);
    put(`${support}UpLeg.yaw`, -14 * sideSign);
    put('hips.roll', 10 * sideSign);
    put('torso.roll', 6 * sideSign);
    put('head.yaw', -7 * sideSign);
  } else if (['lunge', 'forwardlunge', '弓步', '前弓步', '弓步下压'].some(token => action.includes(token))) {
    const lead = danceSide;
    const support = lead === 'left' ? 'right' : 'left';
    positionOffset = [0.06 * sideSign * intensity, 0.42 * intensity];
    thigh(lead, -38);
    shin(lead, 24);
    foot(lead, -12);
    thigh(support, 12);
    shin(support, -8);
    put('hips.pitch', 6);
    put('torso.pitch', -9);
    put('head.pitch', -4);
  } else if (['toetap', 'toe', '点脚', '脚尖点地', '点步'].some(token => action.includes(token))) {
    const tap = danceSide;
    positionOffset = [0.08 * sideSign * intensity, 0];
    thigh(tap, -18);
    shin(tap, 10);
    foot(tap, -25);
    put('hips.roll', 7 * sideSign);
    put('torso.roll', 4 * sideSign);
  } else if (['stepleft', '向左迈', '左脚迈', '左移', '侧步左', '滑步左'].some(token => action.includes(token))) {
    positionOffset = [-0.55 * intensity, 0];
    put('hips.roll', -8 * intensity);
    put('torso.roll', -5 * intensity);
    put('leftUpLeg.pitch', -28);
    put('leftLeg.pitch', 18);
    put('leftFoot.pitch', -12);
    put('rightUpLeg.pitch', 10);
  } else if (['stepright', '向右迈', '右脚迈', '右移', '侧步右', '滑步右'].some(token => action.includes(token))) {
    positionOffset = [0.55 * intensity, 0];
    put('hips.roll', 8 * intensity);
    put('torso.roll', 5 * intensity);
    put('rightUpLeg.pitch', -28);
    put('rightLeg.pitch', 18);
    put('rightFoot.pitch', -12);
    put('leftUpLeg.pitch', 10);
  } else if (['stepforward', '前进一步', '向前迈', '前进', '踏前', 'glideforward'].some(token => action.includes(token))) {
    positionOffset = [0, 0.65 * intensity];
    put('hips.pitch', -5 * intensity);
    put('torso.pitch', -3 * intensity);
    eachSide(prefix => {
      thigh(prefix, -18);
      shin(prefix, 8);
      foot(prefix, -8);
    });
  } else if (['stepback', '向后一步', '后退', '踏后', 'glideback'].some(token => action.includes(token))) {
    positionOffset = [0, -0.5 * intensity];
    put('hips.pitch', 5 * intensity);
    put('torso.pitch', 3 * intensity);
    eachSide(prefix => {
      thigh(prefix, 14);
      shin(prefix, -6);
      foot(prefix, 6);
    });
  } else if (['swayleft', '向左摆', '左摆', '重心左', 'leanleft'].some(token => action.includes(token))) {
    positionOffset = [-0.2 * intensity, 0];
    put('hips.roll', -14);
    put('torso.roll', -10);
    put('torso.yaw', -6);
    put('head.roll', -4);
    put('head.yaw', -8);
    put('leftKnee.bend', 12);
    arm('right', -16);
    elbow('right', 10);
  } else if (['swayright', '向右摆', '右摆', '重心右', 'leanright'].some(token => action.includes(token))) {
    positionOffset = [0.2 * intensity, 0];
    put('hips.roll', 14);
    put('torso.roll', 10);
    put('torso.yaw', 6);
    put('head.roll', 4);
    put('head.yaw', 8);
    put('rightKnee.bend', 12);
    arm('left', -16);
    elbow('left', 10);
  } else if (['turnleft', '向左转', '左转', 'pivotleft', '左旋'].some(token => action.includes(token))) {
    facingOffset = -45 * intensity;
    put('hips.yaw', -18);
    put('torso.yaw', -12);
    put('head.yaw', -24);
    put('leftFoot.yaw', -18);
  } else if (['turnright', '向右转', '右转', 'pivotright', '右旋'].some(token => action.includes(token))) {
    facingOffset = 45 * intensity;
    put('hips.yaw', 18);
    put('torso.yaw', 12);
    put('head.yaw', 24);
    put('rightFoot.yaw', 18);
  } else if (['spin', '旋转', '旋身', '转一圈'].some(token => action.includes(token))) {
    facingOffset = 180 * intensity * (side === 'left' ? -1 : 1);
    put('hips.yaw', facingOffset * 0.35);
    put('torso.yaw', facingOffset * 0.25);
    put('head.yaw', facingOffset * 0.5);
  } else if (['dip', '下沉', '俯身', '屈膝', '下蹲'].some(token => action.includes(token))) {
    put('hips.pitch', 8);
    put('torso.pitch', 10);
    bothSides(prefix => {
      thigh(prefix, -46);
      shin(prefix, 28);
      foot(prefix, -10);
    });
  } else if (['rise', '起身', '上提', '站起', '抬升'].some(token => action.includes(token))) {
    put('hips.pitch', 0);
    put('torso.pitch', 0);
    bothSides(prefix => {
      thigh(prefix, 0);
      shin(prefix, 0);
      foot(prefix, 0);
    });
  } else if (['accuse', 'pointat', '指责', '质问', '指着'].some(token => action.includes(token))) {
    const point = danceSide;
    positionOffset = [0.04 * sideSign * intensity, 0.22 * intensity];
    arm(point, -72);
    foreArm(point, -10);
    elbow(point, 8);
    put('torso.pitch', -8);
    put('torso.yaw', 12 * sideSign);
    put('head.yaw', 10 * sideSign);
  } else if (['coverface', '捂脸', '掩面', '抹泪'].some(token => action.includes(token))) {
    bothSides(prefix => {
      arm(prefix, -42);
      foreArm(prefix, -28);
      elbow(prefix, 72);
    });
    put('head.pitch', 18);
    put('neck.pitch', 8);
    put('torso.pitch', 8);
  } else if (['guardup', 'flinch', '护住', '护头', '举手挡'].some(token => action.includes(token))) {
    positionOffset = [0, -0.16 * intensity];
    bothSides(prefix => {
      arm(prefix, -52);
      foreArm(prefix, -16);
      elbow(prefix, 48);
    });
    put('torso.pitch', 5);
    put('head.pitch', -6);
  } else if (['freeze', 'startlehold', '愣住', '呆住'].some(token => action.includes(token))) {
    continuousMotion = false;
    bothSides(prefix => {
      arm(prefix, -18);
      elbow(prefix, 22);
    });
    put('torso.pitch', 6);
    put('head.pitch', -6);
  } else if (['sneak', 'creep', '潜行', '蹑手', '猫步'].some(token => action.includes(token))) {
    pose = 'crouch';
    continuousMotion = false;
    positionOffset = [0, 0.16 * intensity];
    put('head.yaw', 16 * sideSign);
    put('torso.pitch', 10);
  } else if (['stumble', 'stagger', '踉跄', '绊倒', '打晃'].some(token => action.includes(token))) {
    positionOffset = [0.24 * sideSign * intensity, -0.06 * intensity];
    put('torso.pitch', 14);
    put('hips.roll', 8 * sideSign);
    thigh(danceSide, -28);
    shin(danceSide, 22);
  } else if (['pause', 'holdstill', '停顿'].some(token => action.includes(token))) {
    continuousMotion = false;
  } else if (['chamber', 'coil', 'windup', '蓄势', '收拳', '架势'].some(token => action.includes(token))) {
    const punch = danceSide;
    const guard = punch === 'left' ? 'right' : 'left';
    positionOffset = [0, -0.06 * intensity];
    arm(punch, -42);
    foreArm(punch, -24);
    elbow(punch, 82);
    arm(guard, -50);
    foreArm(guard, -16);
    elbow(guard, 64);
    put('torso.yaw', -16 * sideSign);
    put('hips.yaw', -8 * sideSign);
    put('head.yaw', -6 * sideSign);
    bothSides(prefix => {
      thigh(prefix, -16);
      shin(prefix, 18);
    });
  } else if (['punch', 'jab', 'cross', '直拳', '出拳', '冲拳'].some(token => action.includes(token))) {
    const punch = danceSide;
    const guard = punch === 'left' ? 'right' : 'left';
    positionOffset = [0.04 * sideSign * intensity, 0.16 * intensity];
    arm(punch, -78);
    foreArm(punch, -8);
    elbow(punch, 10);
    arm(guard, -24);
    elbow(guard, 56);
    foreArm(guard, -18);
    put('torso.yaw', 18 * sideSign);
    put('hips.yaw', 10 * sideSign);
    put('head.yaw', 6 * sideSign);
    thigh(punch, -22);
    shin(punch, 16);
  } else if (['hook', 'swingpunch', '摆拳', '勾拳'].some(token => action.includes(token))) {
    const punch = danceSide;
    positionOffset = [0.12 * sideSign * intensity, 0.1 * intensity];
    arm(punch, -46);
    elbow(punch, 68);
    armRoll(punch, 40);
    put('torso.yaw', 28 * sideSign);
    put('hips.yaw', 14 * sideSign);
    put('head.yaw', 10 * sideSign);
  } else if (['block', 'parry', '格挡', '招架', '架招'].some(token => action.includes(token))) {
    positionOffset = [0, -0.1 * intensity];
    bothSides(prefix => {
      arm(prefix, -58);
      foreArm(prefix, -22);
      elbow(prefix, 64);
    });
    put('torso.pitch', 6);
    put('head.pitch', -4);
  } else if (['dodge', 'sidestep', '闪避', '侧闪', '闪身'].some(token => action.includes(token))) {
    positionOffset = [0.38 * sideSign * intensity, -0.08 * intensity];
    put('hips.roll', 10 * sideSign);
    put('torso.roll', 12 * sideSign);
    put('torso.yaw', -14 * sideSign);
    put('head.yaw', -18 * sideSign);
    put('head.roll', 6 * sideSign);
  } else if (['frontkick', '前踢', '正踢', '踢击'].some(token => action.includes(token))) {
    const kick = danceSide;
    positionOffset = [0, 0.14 * intensity];
    thigh(kick, -68);
    shin(kick, 12);
    foot(kick, -18);
    put('torso.pitch', 8);
    put('hips.pitch', -4);
    bothSides(prefix => {
      arm(prefix, -20);
      elbow(prefix, 40);
    });
  } else if (['advance', 'stepin', '进步', '上步', '逼近', '靠近'].some(token => action.includes(token))) {
    positionOffset = [0, 0.2 * intensity];
    thigh(danceSide, -20);
    shin(danceSide, 12);
    put('hips.pitch', -4);
    put('torso.pitch', -3);
  } else if (['retreat', 'stepout', '退步', '撤步', '后撤'].some(token => action.includes(token))) {
    positionOffset = [0, -0.34 * intensity];
    put('torso.pitch', 5);
    put('hips.pitch', 4);
  } else if (['kickleft', '左踢', '左抬腿', '抬左腿'].some(token => action.includes(token))) {
    positionOffset = [-0.18 * intensity, 0.12 * intensity];
    setLegLift('left', 42);
    put('hips.roll', -8);
    put('torso.roll', -5);
  } else if (['kickright', '右踢', '右抬腿', '抬右腿'].some(token => action.includes(token))) {
    positionOffset = [0.18 * intensity, 0.12 * intensity];
    setLegLift('right', 42);
    put('hips.roll', 8);
    put('torso.roll', 5);
  } else if (['liftleg', '抬腿', '腿部点步', '点步'].some(token => action.includes(token))) {
    positionOffset = [0.16 * sideSign * intensity, 0];
    setLegLift(danceSide, 35);
    put('hips.roll', 10 * sideSign);
    put('torso.roll', 6 * sideSign);
  } else if (['bodywave', '身体波浪', '波浪', '律动'].some(token => action.includes(token))) {
    put('hips.pitch', 8);
    put('torso.pitch', -12);
    put('body.roll', 8 * sideSign);
    put('head.pitch', -8);
  } else if (['clap', '拍手', '击掌'].some(token => action.includes(token))) {
    bothSides(prefix => {
      arm(prefix, -30);
      foreArm(prefix, -24);
      elbow(prefix, 30);
    });
    put('leftShoulder.spread', -12);
    put('rightShoulder.spread', 12);
  } else if (['wave', '招手', '挥手'].some(token => action.includes(token))) {
    pose = 'wave';
    continuousMotion = true;
  } else if (['nod', 'agree', '点头', '回应'].some(token => action.includes(token))) {
    pose = 'agree';
    continuousMotion = true;
  } else if (['shakehead', 'headshake', '摇头', '否认'].some(token => action.includes(token))) {
    pose = 'headShake';
    continuousMotion = true;
  } else if (['lookleft', '向左看', '看左边'].some(token => action.includes(token))) {
    put('head.yaw', -28);
    put('torso.yaw', -8);
    put('neck.yaw', -6);
  } else if (['lookright', '向右看', '看右边'].some(token => action.includes(token))) {
    put('head.yaw', 28);
    put('torso.yaw', 8);
    put('neck.yaw', 6);
  } else if (['lookaway', '别开脸', '移开视线', '看向远处'].some(token => action.includes(token))) {
    put('head.yaw', side === 'left' ? -34 : 34);
    put('torso.yaw', side === 'left' ? -10 : 10);
    put('head.pitch', -6);
  } else if (['look', 'lookat', 'gaze', '看向', '望向', '对视', '抬眼看'].some(token => action.includes(token))) {
    leanInto(14, -8);
    if (yawSign !== 0) put('neck.yaw', 6 * yawSign);
  } else if (['bow', 'lowerhead', '低头', '垂眸', '害羞'].some(token => action.includes(token))) {
    put('head.pitch', 22);
    put('neck.pitch', 8);
    put('torso.pitch', 8);
    put('hips.pitch', 4);
  } else if (['lookup', '抬头', '抬眼'].some(token => action.includes(token))) {
    put('head.pitch', -18);
    put('neck.pitch', -6);
  } else if (['settle', 'relax', 'settledown', '停住', '收势', '放松'].some(token => action.includes(token))) {
    bothSides(prefix => {
      arm(prefix, 0);
      foreArm(prefix, 0);
      elbow(prefix, 0);
      armRoll(prefix, 0);
      foreArmRoll(prefix, 0);
    });
    put('leftShoulder.spread', 0);
    put('rightShoulder.spread', 0);
    put('head.pitch', 0);
    put('head.yaw', 0);
    put('head.roll', 0);
    put('neck.pitch', 0);
    put('neck.yaw', 0);
    bothSides(prefix => shoulder(prefix, 0));
    put('torso.pitch', 0);
    put('torso.roll', 0);
    put('torso.yaw', 0);
    put('body.pitch', 0);
    put('body.roll', 0);
    put('body.yaw', 0);
    put('hips.pitch', 0);
    put('hips.roll', 0);
    put('hips.yaw', 0);
    bothSides(prefix => {
      thigh(prefix, 0);
      shin(prefix, 0);
      foot(prefix, 0);
    });
    pose = 'idle';
    continuousMotion = false;
  }

  return { pose, continuousMotion, controls, positionOffset, facingOffset };
}

const BODY_CONTROL = /^(hips|torso|body|head|neck)\./;
const LEAD_GAP_SECONDS = 0.85;
const LEAD_BODY = 0.72;
const LEAD_LIMB = 0.4;
const LEAD_TRAVEL = 0.35;

/** 准备拍：躯干和头先到七成，四肢大约四成，位移只走一小段。零值不写入。 */
function scalePerformanceExpansion(
  expansion: PerformanceActionExpansion,
  body: number,
  limb: number,
  travel: number,
): PerformanceActionExpansion {
  const controls: Record<string, number> = {};
  for (const [name, value] of Object.entries(expansion.controls)) {
    const scaled = Math.round(value * (BODY_CONTROL.test(name) ? body : limb) * 10) / 10;
    if (scaled !== 0) controls[name] = scaled;
  }
  const positionOffset = expansion.positionOffset
    ? [expansion.positionOffset[0] * travel, expansion.positionOffset[1] * travel] as [number, number]
    : undefined;
  const facingOffset = expansion.facingOffset === undefined ? undefined : expansion.facingOffset * travel;
  return {
    pose: expansion.pose,
    continuousMotion: expansion.continuousMotion,
    controls,
    ...(positionOffset && (positionOffset[0] !== 0 || positionOffset[1] !== 0) ? { positionOffset } : {}),
    ...(facingOffset ? { facingOffset } : {}),
  };
}

function expansionMoves(expansion: PerformanceActionExpansion): boolean {
  return Object.keys(expansion.controls).length > 0
    || Boolean(expansion.positionOffset)
    || Boolean(expansion.facingOffset);
}

/** 对打动作按播放帧加密。间隔和镜头采样同一量级，段内用线性过渡，避免每一拍都缓出再停住。 */
const ACTION_SAMPLE_FRAMES = 2;

function lerpNumberList(
  left: readonly number[] | undefined,
  right: readonly number[] | undefined,
  amount: number,
  length: number,
): number[] {
  return Array.from({ length }, (_, index) => {
    const from = num(left?.[index]);
    return from + (num(right?.[index]) - from) * amount;
  });
}

function lerpJoints(
  left: Record<string, number[]> | undefined,
  right: Record<string, number[]> | undefined,
  amount: number,
): Record<string, number[]> | undefined {
  if (!left && !right) return undefined;
  const joints: Record<string, number[]> = {};
  for (const name of new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])) {
    joints[name] = lerpNumberList(left?.[name], right?.[name], amount, 3);
  }
  return joints;
}

function densifyActionKeys(keys: MonoformObjectKey[]): MonoformObjectKey[] {
  if (keys.length < 2) return keys.map((key) => ({ ...key, interpolation: 'linear' as const }));
  const sorted = [...keys].sort((a, b) => a.frame - b.frame);
  const out: MonoformObjectKey[] = [];
  const push = (key: MonoformObjectKey) => {
    if (out.length > 0 && out[out.length - 1].frame === key.frame) out[out.length - 1] = key;
    else out.push(key);
  };
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const left = sorted[index];
    const right = sorted[index + 1];
    push({ ...left, interpolation: 'linear' });
    const span = right.frame - left.frame;
    for (let frame = left.frame + ACTION_SAMPLE_FRAMES; frame < right.frame; frame += ACTION_SAMPLE_FRAMES) {
      const amount = (frame - left.frame) / span;
      push({
        ...left,
        frame,
        interpolation: 'linear',
        position: lerpNumberList(left.position, right.position, amount, 3),
        rotation: lerpNumberList(left.rotation, right.rotation, amount, 3),
        scale: lerpNumberList(left.scale, right.scale, amount, 3),
        joints: lerpJoints(left.joints, right.joints, amount),
        ...(left.rigRoot || right.rigRoot
          ? { rigRoot: lerpNumberList(left.rigRoot, right.rigRoot, amount, left.rigRoot?.length || right.rigRoot?.length || 3) }
          : {}),
      });
    }
  }
  push({ ...sorted[sorted.length - 1], interpolation: 'linear' });
  return out;
}

/**
 * 没有走路 route 时，把演出收成角色关键帧。
 * 缺省值继承已有角色及上一拍；只有 controls 时，从原造型过渡到目标造型。
 * 间隔够长的动作会先插入一拍准备：身体先动，四肢和位移留到原节拍。
 */
export function buildMonoformActionTrack(
  intent: DirectorSceneCharacterIntent,
  fps: number,
  current: LooseObject = {},
): MonoformObjectKey[] | null {
  if (sanitizeRoute(intent.route)) return null;
  const position = Array.isArray(current.position) ? current.position : [0, 0, 0];
  const rotation = Array.isArray(current.rotation) ? current.rotation : [0, 0, 0];
  const scale = Array.isArray(current.scale) ? current.scale.map((v) => num(v, 1)) : [1, 1, 1];
  let at: [number, number] = intent.at ?? [num(position[0]), num(position[2])];
  let facing = num(intent.facing, num(rotation[1]) * 180 / Math.PI);
  const neutral = intent.poseBase === 'neutral';
  let pose = mapPose(intent.pose ?? (!neutral && typeof current.pose === 'string' ? current.pose : 'idle'));
  let joints = buildMonoformJoints(undefined, neutral ? undefined : current.joints);
  let poseTime = !neutral && typeof current.poseTime === 'number' ? current.poseTime : undefined;
  let poseBlend = !neutral && isRecord(current.poseBlend) ? current.poseBlend : undefined;
  const rigRoot = !neutral && Array.isArray(current.rigRoot) ? current.rigRoot.slice(0, 3).map((v) => num(v)) : undefined;
  const fightTrack = fightPerformance([intent]);
  let continuousMotion = LOOPING_POSES.has(pose) && (neutral || current.continuousMotion !== false);
  if (fightTrack && pose !== 'walk' && pose !== 'run') continuousMotion = false;
  const written = (intent.performance ?? [])
    .filter((beat) => beat && typeof beat === 'object')
    .map((beat) => ({ ...beat, t: Math.max(0, num(beat.t, 0)) }))
    .sort((a, b) => a.t - b.t);
  let beats = written;
  if (written.length > 0) {
    joints = buildMonoformJoints(intent.controls, joints);
    // 第一拍晚于 0 秒时先保留原位；只有一拍也补出可播放的起始状态。
    const initial = { t: 0, pose };
    if (written[0].t > 0) beats = [initial, ...written];
    else if (written.length === 1) beats = [initial, { ...written[0], t: 2 }];
  } else {
    const start = Math.max(0, num(intent.start, 0));
    const targetPose = mapPose(intent.pose);
    if (!buildMonoformJoints(intent.controls) && targetPose === 'idle') return null;
    beats = [
      { t: start, pose: !neutral && typeof current.pose === 'string' ? mapPose(current.pose) : 'idle' },
      { t: start + 3, pose: intent.pose, controls: intent.controls },
    ];
  }
  if (fightTrack) beats = withFightChambers(beats);
  let lastFrame = -1;
  let previousTime = 0;
  const keys: MonoformObjectKey[] = [];
  const pushBeat = (
    beat: DirectorScenePerformanceBeat & { t: number },
    actionExpansion: PerformanceActionExpansion,
    time: number,
    interpolation: 'smooth' | 'linear' | 'hold',
    applyAuthoredControls: boolean,
  ) => {
    let frame = Math.round(time * fps);
    if (frame <= lastFrame) frame = lastFrame + 1;
    lastFrame = frame;
    if (applyAuthoredControls && Array.isArray(beat.at) && beat.at.length >= 2) {
      at = [num(beat.at[0]), num(beat.at[1])];
    } else if (actionExpansion.positionOffset) {
      // 高层舞步相对当前朝向移动：横向右向量 [cos,-sin]，前向量 [sin,cos]。
      // 显式 at 优先，模型不需要自己计算世界坐标。
      const yaw = (facing * Math.PI) / 180;
      const [lateral, forward] = actionExpansion.positionOffset;
      at = [
        at[0] + Math.cos(yaw) * lateral + Math.sin(yaw) * forward,
        at[1] - Math.sin(yaw) * lateral + Math.cos(yaw) * forward,
      ];
    }
    facing = applyAuthoredControls
      ? num(beat.facing, facing + num(actionExpansion.facingOffset))
      : facing + num(actionExpansion.facingOffset);
    const nextPose = mapPose((applyAuthoredControls ? beat.pose : undefined) ?? actionExpansion.pose ?? pose);
    if (nextPose !== pose) continuousMotion = LOOPING_POSES.has(nextPose);
    if (actionExpansion.continuousMotion !== undefined) continuousMotion = LOOPING_POSES.has(nextPose) && actionExpansion.continuousMotion;
    if (applyAuthoredControls && beat.continuousMotion !== undefined) {
      continuousMotion = LOOPING_POSES.has(nextPose) && beat.continuousMotion;
    }
    if (nextPose !== pose || (applyAuthoredControls && beat.continuousMotion !== undefined)) {
      poseTime = undefined;
      poseBlend = undefined;
    }
    pose = nextPose;
    if (fightTrack && pose !== 'walk' && pose !== 'run') continuousMotion = false;
    const expandedControls = applyAuthoredControls
      ? { ...actionExpansion.controls, ...(beat.controls ?? {}) }
      : actionExpansion.controls;
    joints = buildMonoformJoints(expandedControls, joints);
    keys.push({
      frame,
      interpolation,
      position: [at[0], intent.at ? 0 : num(position[1]), at[1]],
      rotation: [num(rotation[0]), (facing * Math.PI) / 180, num(rotation[2])],
      scale: [...scale],
      pose,
      continuousMotion: !poseBlend && continuousMotion,
      ...(poseTime !== undefined ? { poseTime } : {}),
      ...(poseBlend ? { poseBlend } : {}),
      ...(rigRoot ? { rigRoot: [...rigRoot] } : {}),
      ...(joints ? { joints } : {}),
    });
  };
  for (const beat of beats) {
    const actionExpansion = expandMonoformPerformanceBeat(beat);
    const gap = beat.t - previousTime;
    const leadTime = beat.t - Math.min(0.45, gap * 0.4);
    const authoredPlacement = Array.isArray(beat.at) || typeof beat.facing === 'number';
    const fightBeat = /直拳|出拳|冲拳|摆拳|勾拳|格挡|招架|架招|闪避|侧闪|闪身|前踢|正踢|踢击|进步|上步|退步|撤步|后撤|punch|hook|block|parry|dodge|frontkick|advance|retreat|stepin|stepout/i
      .test([beat.action, ...(beat.actions ?? [])].filter((name) => typeof name === 'string').join(' '));
    const lead = beat.interpolation === 'hold' || fightBeat || gap < LEAD_GAP_SECONDS || leadTime <= previousTime + 0.2
      ? undefined
      : scalePerformanceExpansion(
        actionExpansion,
        LEAD_BODY,
        LEAD_LIMB,
        authoredPlacement ? 0 : LEAD_TRAVEL,
      );
    const insertLead = Boolean(lead && expansionMoves(lead) && Math.round(leadTime * fps) < Math.round(beat.t * fps));
    if (insertLead && lead) pushBeat(beat, lead, leadTime, 'smooth', false);
    const peakTravel = insertLead && !authoredPlacement && (actionExpansion.positionOffset || actionExpansion.facingOffset)
      ? 1 - LEAD_TRAVEL
      : 1;
    const peak = peakTravel === 1 ? actionExpansion : {
      ...actionExpansion,
      positionOffset: actionExpansion.positionOffset
        ? [actionExpansion.positionOffset[0] * peakTravel, actionExpansion.positionOffset[1] * peakTravel] as [number, number]
        : undefined,
      facingOffset: actionExpansion.facingOffset === undefined ? undefined : actionExpansion.facingOffset * peakTravel,
    };
    pushBeat(
      beat,
      peak,
      beat.t,
      beat.interpolation === 'linear' || beat.interpolation === 'hold' ? beat.interpolation : 'smooth',
      true,
    );
    previousTime = beat.t;
  }
  return fightTrack ? densifyActionKeys(keys) : keys;
}

/**
 * 运镜 intent → 相机关键帧轨。**几何在这里算**：环绕采样圆弧、推拉沿正前方轴进退、
 * 摇镜移动视线落点；朝向一律交给 MONOFORM 由 target 推导（见文件头第 3 条）。
 *
 * `movingTracks`（刚建好的角色走路轨）让镜头**跟着人走** —— 每个采样帧先算人物当时的
 * 位置再摆机位，否则人一走开镜头就对着空地点拍（这是「环绕走动的两人」能看的前提）。
 * 没有轨就用静止质心。
 *
 * `move` 缺省/未知且没有有效 beats → 返回空数组（= 静态机位，由
 * buildMonoformStaticCamera 兜底）；带 beats 时允许用参数节拍编排一条静态基线。
 */
/**
 * 极简**确定性**伪随机（[-1,1]）：同一个 seed + 序号永远给同一个值。
 * 手持抖动靠它 —— 如果用 `Math.random()`，同一个 intent 每次重放都生成不同的曲线，
 * 用户复查时画面会变，看起来就像 bug。
 */
function jitterUnit(seed: number, index: number): number {
  const raw = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return (raw - Math.floor(raw)) * 2 - 1;
}

function stringSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100000;
}

/** 对象的地面坐标 [x, z]。 */
function objectPlanarPosition(object: LooseObject): [number, number] {
  const position = Array.isArray(object.position) ? object.position : [];
  return [num(position[0], 0), num(position[2], 0)];
}

/** 按 name 或 id 找人。越肩反打靠这个，不填才退回列表顺序。 */
function personByHint(persons: readonly LooseObject[], hint: string | undefined): LooseObject | undefined {
  const needle = hint?.trim();
  if (!needle) return undefined;
  return persons.find((person) => person.name === needle || person.id === needle);
}

/** 角色朝向的弧度（`rotation[1]`；0 = 面向 +z，与 intent 的 facing 约定一致）。 */
function objectYaw(object: LooseObject): number {
  const rotation = Array.isArray(object.rotation) ? object.rotation : [];
  return num(rotation[1], 0);
}

function cameraFraming(camera: DirectorSceneIntent['camera']) {
  const size = camera?.size === 'close' || camera?.size === 'wide' || camera?.size === 'full'
    ? camera.size
    : 'medium';
  const height = camera?.height === 'low' || camera?.height === 'high' ? camera.height : 'eye';
  const distance = size === 'close' ? 2.4 : size === 'wide' ? 8 : size === 'full' ? 11 : CAM.baseDistance;
  const focal = size === 'close' ? 70 : size === 'wide' ? 28 : size === 'full' ? 24 : CAM.focal;
  const eyeY = height === 'low' ? 0.55 : height === 'high' ? 3.4 : CAM.eyeY;
  const lookY = height === 'low' ? 1.35 : height === 'high' ? 1.15 : CAM.lookY;
  return {
    distance,
    focal,
    eyeY,
    lookY,
    orbitRadius: distance,
    near: Math.max(1.6, distance * 0.62),
    far: distance * 1.45,
  };
}

/** 相机共享的空间上下文：轨按演员 id 匹配；反打使用同一个主机位判断轴线侧。 */
interface CameraSceneContext {
  tracks?: Readonly<Record<string, readonly MonoformObjectKey[]>>;
  axisAnchor?: readonly number[];
}

/** 越肩按演员体型与目标景别计算可见高度，避免头顶和关键手部被固定眼高裁掉。 */
function shoulderFraming(camera: DirectorSceneIntent['camera'], person: LooseObject) {
  const scale = Array.isArray(person.scale) ? Math.max(0.1, num(person.scale[1], 1)) : 1;
  const size = camera?.size;
  const height = (size === 'close' ? 0.95 : size === 'wide' ? 2.8 : size === 'full' ? 4 : 1.8) * scale;
  const lookY = (size === 'close' ? 1.45 : size === 'wide' || size === 'full' ? 0.95 : 1.18) * scale;
  return { height, lookY, scale };
}

export function buildMonoformCameraTrack(
  camera: DirectorSceneIntent['camera'],
  persons: readonly LooseObject[],
  fps: number,
  movingTracks: ReadonlyArray<readonly MonoformObjectKey[]> = [],
  context: CameraSceneContext = {},
): MonoformCameraKey[] {
  const move = typeof camera?.move === 'string' ? camera.move : 'static';
  const framing = cameraFraming(camera);
  const startFrame = Math.round(Math.max(0, num(camera?.start, 0)) * fps);
  const durationFrames = Math.max(1, Math.round(Math.max(0.5, num(camera?.duration, 6)) * fps));
  const [cx, cz] = personCentroid(persons);
  // 采样数随时长自适应：短运动不铺一堆重复帧，长运动也不会稀成几段。
  const samples = Math.min(
    CAM.maxSamples,
    Math.max(CAM.minSamples, Math.round(durationFrames / CAM.sampleIntervalFrames) + 1),
  );
  const frameAt = (i: number) => startFrame + Math.round((durationFrames * i) / (samples - 1));
  /** 全局缓动（smoothstep）烘进采样点 —— 与 linear 插值配合才是连续速度曲线。 */
  const easeInOut = (t: number) => t * t * (3 - 2 * t);
  const trackFor = (person: LooseObject) => context.tracks
    ? context.tracks[String(person.id)] : movingTracks[persons.indexOf(person)];
  const positionAt = (person: LooseObject, frame: number): [number, number] => {
    const track = trackFor(person);
    return track?.length ? trackPositionAt(track, frame) : objectPlanarPosition(person);
  };
  const yawAt = (person: LooseObject, frame: number) => {
    const track = trackFor(person);
    if (!track?.length) return objectYaw(person);
    const { a, b, t } = trackSegmentAt(track, frame);
    return num(a.rotation?.[1], objectYaw(person)) * (1 - t) + num(b.rotation?.[1], objectYaw(person)) * t;
  };
  const focusPerson = personByHint(persons, camera?.focus);
  /** 静止演员也参与质心；不能只平均有轨的演员，导致单人一动镜头就丢掉另一个人。 */
  const focusAt = (frame: number): [number, number] => {
    if (focusPerson) return positionAt(focusPerson, frame);
    if (!persons.length) return [cx, cz];
    let sx = 0;
    let sz = 0;
    for (const person of persons) {
      const [x, z] = positionAt(person, frame);
      sx += x;
      sz += z;
    }
    return [sx / persons.length, sz / persons.length];
  };
  const key = (frame: number, position: number[], focus: [number, number], focalLength = framing.focal): MonoformCameraKey => ({
    frame,
    // linear：缓动已经烘进采样点了，再用 smooth 会被引擎逐段再缓一次（又变成一段一停）。
    interpolation: 'linear',
    position,
    target: [focus[0], framing.lookY, focus[1]],
    focalLength,
  });
  const samplePath = (frame: number, progress: number): MonoformCameraKey => {
    const t = Math.max(0, Math.min(1, progress));
    const focus = focusAt(frame);
    switch (move) {
      case 'dolly-in':
      case 'dolly-out': {
        const { near, far } = framing;
        const d = move === 'dolly-in' ? far + (near - far) * t : near + (far - near) * t;
        return key(frame, [focus[0], framing.eyeY, focus[1] + d], focus);
      }
      case 'orbit-left':
      case 'orbit-right': {
        const sign = move === 'orbit-left' ? -1 : 1;
        const angle = sign * (CAM.orbitSweep * Math.PI / 180) * t;
        return key(frame, [focus[0] + framing.orbitRadius * Math.sin(angle), framing.eyeY, focus[1] + framing.orbitRadius * Math.cos(angle)], focus);
      }
      case 'pan-left':
      case 'pan-right': {
        const sign = move === 'pan-left' ? -1 : 1;
        const half = CAM.panLateral / 2;
        return key(frame, [focus[0], framing.eyeY, focus[1] + framing.distance], [focus[0] + sign * (CAM.panLateral * t - half), focus[1]]);
      }
      case 'crane-up':
      case 'crane-down': {
        const from = move === 'crane-up' ? CAM.craneLowY : CAM.craneHighY;
        const to = move === 'crane-up' ? CAM.craneHighY : CAM.craneLowY;
        return key(frame, [focus[0], from + (to - from) * t, focus[1] + framing.distance], focus);
      }
      case 'rail-left':
      case 'rail-right': {
        const sign = move === 'rail-left' ? -1 : 1;
        const offset = sign * (CAM.railDistance * t - CAM.railDistance / 2);
        return key(frame, [focus[0] + offset, framing.eyeY, focus[1] + framing.distance], focus);
      }
      case 'handheld': {
        const seed = stringSeed(`${startFrame}:${durationFrames}:${cx.toFixed(2)}:${cz.toFixed(2)}`);
        // 无 beats 时保持旧采样序号；有 beats 时按绝对时间取样，节奏改变不会重定时演员。
        const jitterIndex = Math.round((frame - startFrame) * (samples - 1) / Math.max(1, durationFrames));
        return key(frame, [focus[0] + jitterUnit(seed, jitterIndex * 2) * CAM.jitterAmp, framing.eyeY + jitterUnit(seed, jitterIndex * 2 + 1) * CAM.jitterAmp * 0.6, focus[1] + framing.distance], focus);
      }
      case 'zoom-in':
      case 'zoom-out': {
        const from = move === 'zoom-in' ? CAM.zoomWide : CAM.zoomTele;
        const to = move === 'zoom-in' ? CAM.zoomTele : CAM.zoomWide;
        return key(frame, [focus[0], framing.eyeY, focus[1] + framing.distance], focus, Math.round(from + (to - from) * t));
      }
      case 'pov': {
        const subject = personByHint(persons, camera?.subject) ?? persons[0];
        if (!subject) return key(frame, [focus[0], framing.eyeY, focus[1] + framing.distance], focus);
        const [px, pz] = positionAt(subject, frame);
        const yaw = yawAt(subject, frame);
        const forward = [Math.sin(yaw), Math.cos(yaw)];
        const subjectTarget = focusPerson
          ? positionAt(focusPerson, frame)
          : [px + forward[0] * (1.5 + t * 1.5), pz + forward[1] * (1.5 + t * 1.5)];
        return { ...key(frame, [px, CAM.povEyeY, pz], [px, pz]), target: [subjectTarget[0], CAM.povEyeY, subjectTarget[1]] };
      }
      case 'over-shoulder': {
        const subject = personByHint(persons, camera?.subject) ?? persons[0];
        const other = (focusPerson !== subject ? focusPerson : undefined) ?? persons.find(person => person !== subject);
        if (!subject || !other) return key(frame, [focus[0], framing.eyeY, focus[1] + framing.distance], focus);
        const pair = persons.indexOf(subject) < persons.indexOf(other) ? [subject, other] : [other, subject];
        const [ax, az] = positionAt(pair[0], 0);
        const [bx, bz] = positionAt(pair[1], 0);
        const axisLength = Math.hypot(bx - ax, bz - az);
        const initialNormal = axisLength > 0.01 ? [-(bz - az) / axisLength, (bx - ax) / axisLength] : [0, 1];
        const anchor = context.axisAnchor ?? [(ax + bx) / 2, 0, (az + bz) / 2 + 5];
        const anchorSide = initialNormal[0] * (num(anchor[0]) - (ax + bx) / 2) + initialNormal[1] * (num(anchor[2]) - (az + bz) / 2);
        const sideSign = camera?.axisSide === 'negative' ? -1 : camera?.axisSide === 'positive' ? 1 : anchorSide < -0.01 ? -1 : 1;
        const shotFrame = shoulderFraming(camera, other);
        const [sx, sz] = positionAt(subject, frame);
        const [ox, oz] = positionAt(other, frame);
        const separation = Math.hypot(ox - sx, oz - sz);
        const fallbackYaw = yawAt(subject, frame);
        const forward = separation > 0.01 ? [(ox - sx) / separation, (oz - sz) / separation] : [Math.sin(fallbackYaw), Math.cos(fallbackYaw)];
        const ordered = pair[0] === subject ? 1 : -1;
        const side = [-forward[1] * ordered * sideSign, forward[0] * ordered * sideSign];
        const distance = shotFrame.height * framing.focal / 24 * (1 + (1 - t) * 0.12);
        const lateral = Math.max(0.55, distance * 0.55);
        const back = Math.max(CAM.otsMinBack, Math.sqrt(Math.max(0, distance ** 2 - lateral ** 2)) - separation);
        const position = [sx - forward[0] * back + side[0] * lateral, framing.eyeY * shotFrame.scale, sz - forward[1] * back + side[1] * lateral];
        const targetY = shotFrame.lookY + num(Array.isArray(other.position) ? other.position[1] : 0);
        return { ...key(frame, position, [ox, oz]), target: [ox, targetY, oz] };
      }
      default:
        return key(frame, [focus[0], framing.eyeY, focus[1] + framing.distance], focus);
    }
  };

  const hasBeats = Array.isArray((camera as unknown as { beats?: unknown[] } | undefined)?.beats)
    && ((camera as unknown as { beats?: unknown[] }).beats?.length ?? 0) > 0;
  if (hasBeats) {
    const beatTrack = buildMonoformCameraBeatTrack(
      (camera as unknown as { beats?: unknown[] }).beats,
      fps,
      samplePath,
      (hint, frame) => {
        const person = personByHint(persons, hint);
        if (!person) return undefined;
        const [x, z] = positionAt(person, frame);
        return [x, 0, z];
      },
    );
    if (beatTrack) return beatTrack as MonoformCameraKey[];
  }

  if (move === 'static' || !['dolly-in', 'dolly-out', 'orbit-left', 'orbit-right', 'pan-left', 'pan-right', 'crane-up', 'crane-down', 'rail-left', 'rail-right', 'handheld', 'zoom-in', 'zoom-out', 'pov', 'over-shoulder'].includes(move)) return [];
  if ((move === 'pov' || move === 'over-shoulder') && persons.length < 2) {
    return [samplePath(startFrame, 0)];
  }
  return Array.from({ length: samples }, (_, i) => samplePath(frameAt(i), easeInOut(i / (samples - 1))));
}

/**
 * 静态机位（move 为 static/缺省，或运镜轨为空时兜底）：质心正前方 baseDistance、看向胸口。
 * 给 `target` 让 MONOFORM 的 normalizeCamera 自己算 rotation，故意不给 rotation。
 * 保留工程里已有的 aspectRatio（那是用户的画幅设置，不该被摆场景改掉）。
 */
function buildMonoformStaticCamera(
  persons: readonly LooseObject[],
  prev: Record<string, unknown> | undefined,
  firstKey?: MonoformCameraKey,
  camera?: DirectorSceneIntent['camera'],
): Record<string, unknown> {
  const focus = personByHint(persons, camera?.focus);
  const [cx, cz] = focus ? objectPlanarPosition(focus) : personCentroid(persons);
  const framing = cameraFraming(camera);
  const aspectRatio = prev && typeof prev.aspectRatio === 'string' ? prev.aspectRatio : undefined;
  return {
    position: firstKey ? firstKey.position : [cx, framing.eyeY, cz + framing.distance],
    target: firstKey ? firstKey.target : [cx, framing.lookY, cz],
    focalLength: firstKey ? firstKey.focalLength : framing.focal,
    ...(aspectRatio ? { aspectRatio } : {}),
  };
}

/**
 * 把 intent 合并进当前 MONOFORM 工程。语义：
 * - **角色**：`characters` 出现时替换**所有** person（「重新布置角色」），并重建它们的动画轨
 *   （上一批 `aigen_char_*` 的走路轨会被清掉，否则旧路线会残留）；用户手摆的角色及其轨不动。
 * - **物品**：`objects` 出现时只替换上一批 AI 生成的物品（`aigen_prop_*`），用户手摆的不动。
 * - **相机**：`camera` 出现时重写相机轨 —— 这是整条轨道的替换语义（MONOFORM 的相机轨没有
 *   单帧 id，没法只换我们生成的），要静态就写空轨把运镜清掉。
 * 三者都没有 → 原样返回（不误删）。返回新对象，不改入参。
 */
/**
 * 把当前工程压成一段**给模型看**的紧凑场景摘要（不是 UI 文案，不进词条）。
 *
 * 为什么需要：agent 每轮都得知道白模台**现在长什么样**，否则「再近一点」「把他挪到
 * 左边」「别动桌子只动镜头」这类指代它只能瞎猜，或者干脆重摆一遍全场。
 * 宿主在 iframe 就绪与每次 `scene.apply` 之后刷新这份摘要，随 transportText 送出去。
 *
 * 预算：每个对象一行（~20-30 token），10 个对象约 250 token。
 */
/**
 * 摘要里最多列几个对象。超出的折叠成一行 —— 实测 35 个对象时全列出来是 ~730 token，
 * 超出「300-500 token」的注入预算；截到 20 个 ≈ 440 token，且多对象场景本来
 * 也没必要让模型逐个数（它要的是"现在大概有什么"）。
 */
const SUMMARY_MAX_OBJECTS = 20;

export function summarizeMonoformProject(project: MonoformProject): string {
  const objects = Array.isArray(project.objects) ? project.objects : [];
  const tracks = isRecord(project.objectKeyframes) ? project.objectKeyframes : {};
  const lines: string[] = [];

  for (const raw of objects.slice(0, SUMMARY_MAX_OBJECTS)) {
    if (!isRecord(raw)) continue;
    const id = String(raw.id ?? '');
    if (!id) continue;
    const position = Array.isArray(raw.position) ? raw.position : [];
    const x = round1(num(position[0], 0));
    const z = round1(num(position[2], 0));
    const name = String(raw.name ?? '').trim();
    const label = name ? `${id}「${name}」` : id;

    if (raw.type === 'person') {
      const yaw = Array.isArray(raw.rotation) ? num(raw.rotation[1], 0) : 0;
      const track = tracks[id];
      const hasTrack = Array.isArray(track) && track.length > 0;
      // 点头、挥手和呼吸也是循环动作，不能把 continuousMotion 一概称为走位。
      const hasWalk = hasTrack && (
        raw.pose === 'walk' || raw.pose === 'run' || track.some((key) => isRecord(key) && (
          key.pose === 'walk' || key.pose === 'run'
        ))
      );
      const trackLabel = hasWalk ? '（有走位动画）' : hasTrack ? '（有动作关键帧）' : '';
      const offsets = isRecord(raw.joints) ? Object.entries(raw.joints)
        .filter(([, angles]) => Array.isArray(angles) && angles.some((v) => Math.abs(num(v)) > 0.02)) : [];
      const poseDetails = offsets.length
        ? ` 骨骼偏移${offsets.slice(0, 6).map(([bone, angles]) => `${bone.replace('mixamorig', '')}[${(angles as unknown[]).slice(0, 3).map((v) => Math.round(num(v) * 180 / Math.PI)).join(',')}]`).join(' ')}${offsets.length > 6 ? '…' : ''}（度）`
        : '';
      const fps = num(project.settings?.fps, FPS_FALLBACK);
      const timing = hasTrack ? ` 节拍[${track.filter(isRecord).map((key) => round1(num(key.frame) / fps)).join(',')}]秒` : '';
      const speech = sanitizeSpeechLines(raw.lines) ?? [];
      const speechLabel = speech.length
        ? ` 台词${speech.slice(0, 3).map((line) => `${round1(line.start)}-${round1(line.end)}「${line.text.slice(0, 16)}」`).join(' ')}`
        : '';
      lines.push(
        '- 人物 ' + label
          + ' 站[' + x + ',' + z + '] 面向' + Math.round((yaw * 180) / Math.PI)
          + '° 姿势' + String(raw.pose ?? 'idle') + trackLabel + timing + poseDetails + speechLabel,
      );
    } else {
      lines.push(`- 物品 ${label} 类型${String(raw.type ?? '?')} 位置[${x},${z}]`);
    }
  }

  if (objects.length > SUMMARY_MAX_OBJECTS) {
    lines.push(`- …另有 ${objects.length - SUMMARY_MAX_OBJECTS} 个对象未列出（如需精确操作请按名字/序号指定）`);
  }

  // 相机的「运动」落在顶层关键帧轨上（camera 对象本身只有当前位姿），所以分开报。
  const camera = isRecord(project.camera) ? project.camera : null;
  if (camera) {
    const position = Array.isArray(camera.position) ? camera.position : [];
    const focal = Math.round(num(camera.focalLength, 0));
    const cameraKeys = Array.isArray(project.keyframes) ? project.keyframes : [];
    const parts = [
      `位置[${round1(num(position[0], 0))},${round1(num(position[1], 0))},${round1(num(position[2], 0))}]`,
    ];
    if (focal) parts.push(`焦距${focal}mm`);
    parts.push(cameraKeys.length > 1 ? `有运镜（${cameraKeys.length} 个关键帧）` : '静止');
    lines.push(`- 镜头 ${parts.join(' ')}`);
  }

  if (lines.length === 0) return '';
  return ['[白模台当前场景]', ...lines, '[/白模台当前场景]'].join('\n');
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * 空画布：对象与动画轨全清，**相机位姿与 settings（fps/时长）原样保留** ——
 * 没有相机就没视角，用户会盯着一片黑。顶层与活动 shot 都要清
 * （normalizeShot 以 `shot.*` 优先，只清顶层等于没清）。
 */
function applyEmptyScene(project: MonoformProject): MonoformProject {
  const empty = { objects: [], objectKeyframes: {}, keyframes: [] };
  let shots = project.shots;
  if (Array.isArray(shots) && shots.length > 0) {
    const matched = shots.findIndex((s) => s?.id === project.activeShotId);
    const target = matched >= 0 ? matched : 0;
    shots = shots.map((s, i) => (i === target ? { ...s, ...empty } : s));
  }
  return { ...project, ...empty, ...(shots ? { shots } : {}) };
}

/** 按 id（精确）或 name（精确）找对象下标；找不到返回 -1。 */
function findObjectIndex(objects: LooseObject[], target: unknown): number {
  const wanted = typeof target === 'string' ? target.trim() : '';
  if (!wanted) return -1;
  const byId = objects.findIndex((o) => String(o?.id ?? '') === wanted);
  if (byId >= 0) return byId;
  return objects.findIndex((o) => String(o?.name ?? '').trim() === wanted);
}

/**
 * 角色 intent → **只含显式给了的字段**的对象补丁。
 * 「没给」不等于「重置成默认值」—— 这是增量语义与整批替换的关键区别。
 */
function characterPatch(intent: DirectorSceneCharacterIntent): LooseObject {
  const patch: LooseObject = {};
  if (intent.poseBase === 'neutral') {
    // 重编演出只清造型，不挪动已有演员，也不重置材质、比例等身份信息。
    patch.pose = mapPose(intent.pose ?? intent.performance?.[0]?.pose);
    patch.joints = {};
    patch.rigRoot = [0, 0, 0];
    patch.poseTime = undefined;
    patch.poseBlend = undefined;
    patch.continuousMotion = false;
  }
  if (Array.isArray(intent.at) && intent.at.length >= 2) {
    patch.position = [num(intent.at[0]), 0, num(intent.at[1])];
  }
  if (typeof intent.facing === 'number' && Number.isFinite(intent.facing)) {
    patch.rotation = [0, (intent.facing * Math.PI) / 180, 0];
  }
  if (typeof intent.pose === 'string' && intent.pose.trim()) {
    patch.pose = mapPose(intent.pose.trim());
  }
  const joints = buildMonoformJoints(intent.controls);
  if (joints) patch.joints = joints;
  if (typeof intent.color === 'string' && intent.color) patch.color = intent.color;
  if (typeof intent.name === 'string' && intent.name.trim()) patch.name = intent.name.trim();
  if (Array.isArray(intent.lines)) patch.lines = sanitizeSpeechLines(intent.lines) ?? [];
  return patch;
}

/** 物品 intent → 部分补丁；未知类型返回 null（调用方丢弃，不把工程写坏）。 */
function propPatch(intent: DirectorScenePropIntent): LooseObject | null {
  const preset = PROP_DEFAULTS[intent?.type];
  if (!preset) return null;
  const patch: LooseObject = { type: intent.type };
  if (Array.isArray(intent.at) && intent.at.length >= 2) {
    patch.position = [num(intent.at[0]), num(intent.y, preset.y), num(intent.at[1])];
  }
  if (typeof intent.rotationY === 'number' && Number.isFinite(intent.rotationY)) {
    patch.rotation = [0, (intent.rotationY * Math.PI) / 180, 0];
  }
  if (Array.isArray(intent.scale) && intent.scale.length >= 3) {
    patch.scale = [num(intent.scale[0], 1), num(intent.scale[1], 1), num(intent.scale[2], 1)];
  }
  if (typeof intent.color === 'string' && intent.color) patch.color = intent.color;
  if (typeof intent.name === 'string' && intent.name.trim()) patch.name = intent.name.trim();
  return patch;
}

/**
 * 活动镜头接收完整补丁；其他镜头只同步同 id 的被点名对象，保留独立布景与相机。
 * 同一场戏复制出的多机位因此共享演员的新动作，不会切镜后退回旧版表演。
 */
function patchSceneLayers(
  project: MonoformProject,
  patch: { objects: LooseObject[]; objectKeyframes?: Record<string, unknown> },
  changedIds: Set<string>,
): MonoformProject {
  let shots = project.shots;
  if (Array.isArray(shots) && shots.length > 0) {
    const matched = shots.findIndex((s) => s?.id === project.activeShotId);
    const target = matched >= 0 ? matched : 0;
    const changed = new Map(patch.objects.filter((o) => changedIds.has(String(o.id))).map((o) => [o.id, o]));
    shots = shots.map((s, i) => {
      if (i === target) return { ...s, ...patch };
      const shared = (s.objects ?? []).filter((o) => changed.has(o.id));
      if (!shared.length) return s;
      const tracks = { ...s.objectKeyframes };
      for (const object of shared) {
        const id = String(object.id);
        if (patch.objectKeyframes?.[id]) tracks[id] = patch.objectKeyframes[id];
        else if (patch.objectKeyframes) delete tracks[id];
      }
      return {
        ...s,
        objects: s.objects?.map((o) => changed.get(o.id) ?? o),
        ...(patch.objectKeyframes ? { objectKeyframes: tracks } : {}),
      };
    });
  }
  return { ...project, ...patch, ...(shots ? { shots } : {}) };
}

/**
 * 增量模式（至少一个元素带 `target`）：只改点名的对象，**不删任何现存对象**。
 *
 * 三条规则：
 * 1. 带 target 且匹配到（先 id 精确、再 name）→ 更新它，只覆盖 intent 里**显式给了的**字段
 * 2. 带 target 没匹配到 / 不带 target → **追加**为新对象（不报错、不中断整次注入）
 * 3. 动画轨：命中且有 route/performance → 重建它自己的轨；**没给动作就保留原轨**
 *    （只说"挪个位置"不该顺手把动作关键帧删掉）
 *
 * 相机不在这里处理 —— 它没有 per-对象 id，本来就是整体替换语义，调用方按原路径走。
 */
function applyTargetedObjects(project: MonoformProject, intent: DirectorSceneIntent): MonoformProject {
  const fps = num(isRecord(project.settings) ? project.settings.fps : undefined, FPS_FALLBACK);
  const objects = [...(Array.isArray(project.objects) ? project.objects : [])];
  const tracks = { ...(isRecord(project.objectKeyframes) ? project.objectKeyframes : {}) };
  let charSeq = objects.filter((o) => String(o?.id ?? '').startsWith(GEN_CHAR_PREFIX)).length;
  let propSeq = objects.filter((o) => String(o?.id ?? '').startsWith(GEN_PROP_PREFIX)).length;
  let tracksTouched = false;
  const changedIds = new Set<string>();

  for (const character of intent.characters ?? []) {
    const index = findObjectIndex(objects, character.target);
    const route = sanitizeRoute(character.route);
    if (index >= 0) {
      const id = String(objects[index].id ?? '');
      const current = character.poseBase === 'neutral'
        ? { ...objects[index], pose: mapPose(character.pose ?? character.performance?.[0]?.pose), joints: {}, rigRoot: [0, 0, 0], poseTime: undefined, poseBlend: undefined, continuousMotion: false }
        : objects[index];
      const actionTrack = route
        ? buildMonoformCharacterTrack(route, character, fps, current)
        : buildMonoformActionTrack(character, fps, current);
      objects[index] = { ...objects[index], ...characterPatch(character) };
      if (character.controls && character.poseBase !== 'neutral') {
        objects[index].joints = buildMonoformJoints(character.controls, current.joints) ?? {};
      }
      changedIds.add(id);
      if (actionTrack) {
        tracks[id] = actionTrack;
        tracksTouched = true;
      } else if (character.poseBase === 'neutral') {
        // 显式回到基础姿态时也要移除旧轨，否则播放会再次把旧拥抱/抬臂盖回来。
        delete tracks[id];
        tracksTouched = true;
      }
      continue;
    }
    const created = buildMonoformCharacter(character, charSeq++);
    const actionTrack = route
      ? buildMonoformCharacterTrack(route, character, fps, created)
      : buildMonoformActionTrack(character, fps, { position: created.position, rotation: created.rotation, scale: created.scale });
    objects.push(created);
    if (actionTrack) {
      tracks[created.id] = actionTrack;
      tracksTouched = true;
    }
  }

  for (const prop of intent.objects ?? []) {
    const index = findObjectIndex(objects, prop.target);
    if (index >= 0) {
      const patched = propPatch(prop);
      if (patched) {
        changedIds.add(String(objects[index].id));
        objects[index] = { ...objects[index], ...patched };
      }
      continue;
    }
    const created = buildMonoformProp(prop, propSeq++);
    if (created) objects.push(created);
  }

  if (fightPerformance(intent.characters)) {
    keepPersonClearance(objects, tracks);
    tracksTouched = true;
  }

  return patchSceneLayers(project, {
    objects,
    ...(tracksTouched ? { objectKeyframes: tracks } : {}),
  }, changedIds);
}

/**
 * 一次完整编排先确定共同时间和起始造型，再生成对象与镜头。
 * 旧格式中「全员从 0 秒明确 pose 重演 + 重建机位」也视为重编；单拍、仅 controls、
 * 仅相机等局部操作仍继承原状。mode=edit/poseBase=current 可明确保留手工造型。
 */
export function applyMonoformSceneIntent(project: MonoformProject, intent: DirectorSceneIntent): MonoformProject {
  if (intent.reset === true) return applyEmptyScene(project);
  const fightCharacters = fightPerformance(intent.characters) ? (intent.characters ?? []) : null;
  const characters = fightCharacters
    ? placeFightStrikingDistance(intent.mode === 'edit' ? fightCharacters : padFightRounds(fightCharacters))
    : (intent.characters ?? []);
  const inferredComposition = Boolean(intent.camera || intent.shots?.length) && characters.length > 0
    && characters.every((character) => !sanitizeRoute(character.route) && (
      (character.performance?.length ?? 0) >= 2
      && num(character.performance?.[0]?.t) === 0
      && typeof character.performance?.[0]?.pose === 'string'
    ));
  const compose = intent.mode === 'compose' || (intent.mode !== 'edit' && inferredComposition);
  const actionEnd = Math.max(0, ...characters.flatMap((character) => {
    if (sanitizeRoute(character.route)) return [Math.max(0, num(character.start)) + Math.max(0.5, num(character.routeDuration, 5)) + 0.25];
    return (character.performance ?? []).map((beat) => Math.max(0, num(beat?.t)));
  }));
  const hasDuration = typeof intent.duration === 'number' && Number.isFinite(intent.duration);
  const duration = hasDuration || (compose && actionEnd > 0)
    ? clampNumber(Math.max(actionEnd, num(intent.duration, actionEnd + 0.5)), 1, 60)
    : undefined;
  const fitCamera = (camera: NonNullable<DirectorSceneIntent['camera']>) => {
    if (!duration || !compose) return camera;
    const motionDuration = Math.min(duration, Math.max(0.5, num(camera.duration, 6)));
    const beats = Array.isArray(camera.beats)
      ? camera.beats.filter((beat) => !isRecord(beat) || num(beat.t, 0) <= duration)
      : undefined;
    return {
      ...camera,
      duration: motionDuration,
      // 保留运动速度和长度，优先把溢出表演的机位前移，而非动作结束后才开机。
      start: Math.min(Math.max(0, num(camera.start)), duration - motionDuration),
      ...(beats ? { beats } : {}),
    };
  };
  const prepared: DirectorSceneIntent = {
    ...intent,
    characters: compose
      ? characters.map((character) => ({ ...character, poseBase: character.poseBase ?? 'neutral' }))
      : characters,
    ...(compose ? { mode: 'compose' } : {}),
    ...(intent.camera ? { camera: fitCamera(intent.camera) } : {}),
    ...(Array.isArray(intent.shots) ? { shots: intent.shots.filter((shot) => isRecord(shot?.camera)).map((shot) => ({ ...shot, camera: fitCamera(shot.camera) })) } : {}),
  };
  const result = applyMonoformSceneLayers(project, prepared);
  if (duration === undefined) return result;
  const fps = num(project.settings?.fps, FPS_FALLBACK);
  const durationFor = (layer: MonoformProject | MonoformShot) => {
    const keys = [...(layer.keyframes ?? []), ...Object.values(layer.objectKeyframes ?? {}).flatMap((track) => Array.isArray(track) ? track : [])];
    // 没被本次改动的轨仍须完整保留，禁止为缩短空尾巴而截断用户已有关键帧。
    return Math.min(60, Math.max(duration, ...keys.map((key) => isRecord(key) ? num(key.frame) / fps : 0)));
  };
  const shots = result.shots?.map((shot) => {
    const touched = shot.id === result.activeShotId || (compose && Boolean(intent.camera || intent.shots?.length));
    return touched ? { ...shot, fps, durationSeconds: durationFor(shot) } : shot;
  });
  return {
    ...result,
    settings: { ...result.settings, fps, durationSeconds: durationFor(result) },
    ...(shots ? { shots } : {}),
  };
}

/** 对象及镜头的实际替换/增量合并；共同时间约束只在外层计算一次。 */
function applyMonoformSceneLayers(project: MonoformProject, intent: DirectorSceneIntent): MonoformProject {
  // 「清空重来」优先于其他字段：用户说「清空」时 agent 不该再顺手摆点什么。
  if (intent.reset === true) return applyEmptyScene(project);

  const hasCharacters = Array.isArray(intent.characters) && intent.characters.length > 0;
  const hasProps = Array.isArray(intent.objects) && intent.objects.length > 0;
  const explicitShots = Array.isArray(intent.shots) ? intent.shots.filter((shot) => isRecord(shot?.camera)).slice(0, 8) : [];
  // 增量模式：**任一**元素带 target 就走这条，只改点名的、不删现存对象。
  // 一个 target 都没有 → 落到下面的整批替换（既有语义，逐字节不变）。
  const targetsGiven = [...(intent.characters ?? []), ...(intent.objects ?? [])].some(
    (el) => typeof el.target === 'string' && el.target.trim().length > 0,
  );
  const projectShotCount = Array.isArray(project.shots) ? project.shots.length : 0;
  const shotSpecs: NonNullable<DirectorSceneIntent['shots']> = explicitShots.length > 0
    ? explicitShots
    // 整场新编排明确选了单镜头时，旧工程的其他机位不能混进这场戏。
    // 没写 camera 也没写 shots 时不补机位，避免两人戏被固定成三台。
    : ((!targetsGiven && hasCharacters) || intent.mode === 'compose') && projectShotCount > 0 && isRecord(intent.camera)
      ? [{ name: '主镜头', camera: intent.camera }]
      : [];
  const hasCamera = isRecord(intent.camera) || shotSpecs.length > 0;
  if (!hasCharacters && !hasProps && !hasCamera) return project;
  if (targetsGiven) {
    const withObjects = applyTargetedObjects(project, intent);
    // 相机交给原路径（它没有 per-对象 id）：递归时不再传 characters/objects，所以走不到这个分支。
    return hasCamera
      ? applyMonoformSceneLayers(withObjects, {
          type: intent.type,
          mode: intent.mode,
          camera: intent.camera,
          shots: intent.shots,
        })
      : withObjects;
  }

  const fps = num(isRecord(project.settings) ? project.settings.fps : undefined, FPS_FALLBACK);
  const existing: LooseObject[] = Array.isArray(project.objects) ? project.objects : [];

  // —— 对象：生成的在数组前部（渲染顺序稳定），保留的原样跟在后面 ——
  let nextObjects: LooseObject[] = existing;
  if (hasCharacters || hasProps) {
    const kept = existing.filter((o) => {
      if (hasCharacters && o?.type === 'person') return false;
      if (hasProps && String(o?.id ?? '').startsWith(GEN_PROP_PREFIX)) return false;
      return true;
    });
    const generated: LooseObject[] = [];
    if (hasCharacters) {
      generated.push(...(intent.characters ?? []).map((c, i) => buildMonoformCharacter(c, i)));
    }
    if (hasProps) {
      (intent.objects ?? []).forEach((p, i) => {
        const prop = buildMonoformProp(p, i);
        if (prop) generated.push(prop);
      });
    }
    nextObjects = [...generated, ...kept];
  }

  // —— 角色动画轨：重建（先清上一批 AI 角色的轨）——
  let nextObjectKeyframes: Record<string, unknown> | null = null;
  if (hasCharacters) {
    const tracks = { ...(isRecord(project.objectKeyframes) ? project.objectKeyframes : {}) };
    for (const id of Object.keys(tracks)) {
      if (id.startsWith(GEN_CHAR_PREFIX)) delete tracks[id];
    }
    (intent.characters ?? []).forEach((c, i) => {
      const route = sanitizeRoute(c.route);
      const track = route
        ? buildMonoformCharacterTrack(route, c, fps, nextObjects[i])
        : buildMonoformActionTrack(c, fps, {
            position: nextObjects[i]?.position,
            rotation: nextObjects[i]?.rotation,
            scale: nextObjects[i]?.scale,
          });
      if (!track) return;
      tracks[GEN_CHAR_PREFIX + (i + 1)] = track;
    });
    nextObjectKeyframes = tracks;
    if (fightPerformance(intent.characters)) keepPersonClearance(nextObjects, nextObjectKeyframes);
  }

  // —— 相机：轨 + 静态字段（帧 0 的读数与 normalizeCamera 的兜底都靠它）——
  let nextCameraKeys: MonoformCameraKey[] | null = null;
  let nextCamera: Record<string, unknown> | undefined;
  let nextShots = project.shots;
  let nextActiveShotId = project.activeShotId;
  if (hasCamera) {
    const personsForCamera = nextObjects.filter((o) => o?.type === 'person');
    const tracks: Record<string, MonoformObjectKey[]> = {};
    for (const [id, value] of Object.entries(nextObjectKeyframes ?? project.objectKeyframes ?? {})) {
      if (Array.isArray(value) && value.length && value.every((key) => isRecord(key) && Array.isArray(key.position) && typeof key.frame === 'number')) {
        tracks[id] = value as MonoformObjectKey[];
      }
    }
    const initialPersons = personsForCamera.map((person) => {
      const track = tracks[String(person.id)];
      if (!track?.length) return person;
      const [x, z] = trackPositionAt(track, 0);
      return { ...person, position: [x, num(Array.isArray(person.position) ? person.position[1] : 0), z] };
    });
    const framePair = fightPerformance(intent.characters) && personsForCamera.length >= 2;
    const readableCamera = (camera: DirectorSceneIntent['camera']) => (
      framePair && camera ? { ...camera, focus: undefined } : camera
    );
    const lead = readableCamera(shotSpecs[0]?.camera ?? intent.camera);
    const leadTrack = buildMonoformCameraTrack(lead, personsForCamera, fps, [], { tracks });
    const leadCamera = buildMonoformStaticCamera(initialPersons, project.camera, leadTrack[0], lead);
    const context: CameraSceneContext = {
      tracks,
      axisAnchor: Array.isArray(leadCamera.position) ? leadCamera.position : project.camera?.position,
    };
    const commonAxisSide = shotSpecs.find((spec) => spec.camera.axisSide)?.camera.axisSide;
    if (shotSpecs.length > 0) {
      const built = shotSpecs.map((spec, index) => {
        const cameraSpec = readableCamera({ ...spec.camera, axisSide: spec.camera.axisSide ?? commonAxisSide }) ?? spec.camera;
        const track = buildMonoformCameraTrack(cameraSpec, personsForCamera, fps, [], context);
        return {
          id: `aigen_shot_${index + 1}`,
          name: typeof spec.name === 'string' && spec.name.trim() ? spec.name.trim().slice(0, 30) : `镜头 ${index + 1}`,
          objects: JSON.parse(JSON.stringify(nextObjects)) as LooseObject[],
          objectKeyframes: JSON.parse(JSON.stringify(nextObjectKeyframes ?? project.objectKeyframes ?? {})) as Record<string, unknown>,
          keyframes: track,
          camera: buildMonoformStaticCamera(initialPersons, project.camera, track[0], cameraSpec),
        };
      });
      nextShots = built;
      nextActiveShotId = built[0].id;
      nextCameraKeys = built[0].keyframes;
      nextCamera = built[0].camera;
    } else {
      const track = buildMonoformCameraTrack(readableCamera(intent.camera), personsForCamera, fps, [], context);
      nextCameraKeys = track; // 空数组 = 静态机位（同时把旧运镜清掉）
      nextCamera = buildMonoformStaticCamera(initialPersons, project.camera, track[0], intent.camera);
    }
  }

  // 关键：normalizeShot 以 shot.objects / shot.keyframes / shot.objectKeyframes 优先、
  // 顶层只是 fallback，最终 return 活动 shot 的值 —— 必须同时改活动 shot
  // （activeShotId 匹配不到退首个 shot，与 normalize 的兜底一致）。
  let shots = nextShots;
  if (shotSpecs.length === 0 && Array.isArray(shots) && shots.length > 0) {
    const matched = shots.findIndex((s) => s?.id === project.activeShotId);
    const target = matched >= 0 ? matched : 0;
    shots = shots.map((s, i) =>
      i === target
        ? {
            ...s,
            ...(hasCharacters || hasProps ? { objects: nextObjects } : {}),
            ...(nextObjectKeyframes ? { objectKeyframes: nextObjectKeyframes } : {}),
            ...(nextCameraKeys ? { keyframes: nextCameraKeys } : {}),
            ...(nextCamera ? { camera: nextCamera } : {}),
          }
        : s,
    );
  }

  return {
    ...project,
    ...(hasCharacters || hasProps ? { objects: nextObjects } : {}),
    ...(nextObjectKeyframes ? { objectKeyframes: nextObjectKeyframes } : {}),
    ...(nextCameraKeys ? { keyframes: nextCameraKeys } : {}),
    ...(nextCamera ? { camera: nextCamera } : {}),
    ...(nextActiveShotId ? { activeShotId: nextActiveShotId } : {}),
    ...(shots ? { shots } : {}),
  };
}
