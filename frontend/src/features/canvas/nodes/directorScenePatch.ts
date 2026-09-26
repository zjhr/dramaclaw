/**
 * 导演台「按描述生成场景 + 相机运镜」的确定性展开器。
 *
 * agent 只产出一段高层 intent（角色摆位 + 运镜类型），真正展开成导演台工程
 * 里的 `objects` / `cameras[].motionPath.keyframes` 由这里完成 —— 纯函数、
 * 无副作用、可测。这样 agent 负担小（intent 就几个字段），而「格式必须能被
 * 导演台反序列化」这件容易错的事由确定性代码扛，导演台 reload 时不会因为一个
 * 字段拼错而崩。
 *
 * 通道见 mem:director-desk-localstorage-inject：写
 * `storyai-3d-director-desk-demo:<nodeId>` + reload iframe 即生效。
 * 关键陷阱：keyframe.time 是**序号**(0,1,2…)不是秒，真实时长由
 * `motionPath.duration` 秒数控制，导演台 reload 时会把 time 规范化重排。
 */

export const DIRECTOR_SCENE_INTENT_TYPE = 'director-desk-scene';

/**
 * 可用的镜头运动。前 7 个是基础位移，后 9 个是"导演级"的那批
 * （术语与适用场景见 `directingVocabulary.ts` —— 那里是单一事实源）。
 */
export type DirectorCameraMove =
  | 'orbit-left'
  | 'orbit-right'
  | 'dolly-in'
  | 'dolly-out'
  | 'pan-left'
  | 'pan-right'
  | 'static'
  /** 升降（摇臂感）：机位竖直起落，水平位置与视线落点不动。 */
  | 'crane-up'
  | 'crane-down'
  /** 横移（轨道感）：机位沿画面横向平移。 */
  | 'rail-left'
  | 'rail-right'
  /** 手持：小幅**确定性**抖动（同一次输入 → 同一条曲线，否则没法复查）。 */
  | 'handheld'
  /** 变焦：机位不动，只改焦距（与 dolly 的质感不同）。 */
  | 'zoom-in'
  | 'zoom-out'
  /** 主观镜头：机位贴角色眼睛、看他前方。 */
  | 'pov'
  /** 越肩：机位在角色的肩后侧，看向对面的人。 */
  | 'over-shoulder';

export interface DirectorSceneCharacterIntent {
  /** 姿势预设 id，导演台内置（stand/sit/walk…）。未知值回落 stand。 */
  pose?: string;
  /**
   * 逐骨骼角度直控（度）—— agent 按用户描述**现算**的姿势，如
   * `{"leftShoulder.spread": -85, "rightShoulder.spread": 85}` = 张开双臂。
   * 只接受白名单骨骼名、值域 clamp 到 ±180，非法项静默丢弃 ——
   * 防一个拼错字段让导演台反序列化崩。这是「按实际情况生成姿势」的落点，不是预设菜单。
   */
  controls?: Record<string, number>;
  /** 演出起始造型：neutral 清除旧骨骼偏移；current 保留手工造型后继续微调。 */
  poseBase?: 'neutral' | 'current';
  /**
   * 演出节拍（秒）。每一拍可以改站位、朝向、姿势和骨骼。
   * 翻译层把它写成角色时间轴上的关键帧；至少两拍才有动作过程。
   * 和 route 不要同时用。
   */
  performance?: DirectorScenePerformanceBeat[];
  /** 地面坐标 [x, z]（米）。y 恒为 0（站地面）。角色起点；若给了 route，route[0] 优先。 */
  at?: [number, number];
  /**
   * 移动路线：地面路点数组 `[[x,z], [x,z], ...]`（米，≥2 个点才成路线）。
   * 展开成角色 `motionPath`，段动作 `walk-cycle`（走路动画），朝向沿路径。
   * 用户"从 A 走到 B"就给起终两点；要拐弯给更多点。
   */
  route?: Array<[number, number]>;
  /** 走完整条路线的秒数（motionPath.duration）。默认 5。 */
  routeDuration?: number;
  /**
   * 起步延迟（秒，默认 0）。与 camera.start 配合可以排出「先站着 → 走到位 → 镜头再动」
   * 这类节拍；MONOFORM 白模台把它换算成关键帧的起始帧号。
   */
  start?: number;
  /** 朝向：绕 Y 轴角度（度，0 = 面向 +Z/镜头）。有 route 时被 facingMode:"path" 覆盖。 */
  facing?: number;
  /** 显示色，#RRGGBB。 */
  color?: string;
  /** 展示名，仅 UI。 */
  name?: string;
  /**
   * 台词气泡。start/end 是整段时间轴的秒。白模台按播放帧采样，
   * 挂在头顶，并在两句交接时淡入淡出。不写就没有气泡。
   */
  lines?: DirectorSceneLine[];
  /**
   * **增量修改**：填一个已存在对象的 id 或名字（从「白模台当前场景」摘要里拿）。
   * 给了它 → 翻译层只更新那个对象、**其余原样保留**（只覆盖本元素里显式给了的字段）；
   * 一个都不给 → 整批替换语义（给少了就是删掉）。
   */
  target?: string;
}

/** 一句台词。时间用整段秒数，不另写气泡关键帧。 */
export interface DirectorSceneLine {
  text: string;
  /** 开始说的秒数。 */
  start: number;
  /** 说完的秒数。后一句若更早开始，播放时会在这里提前收掉。 */
  end: number;
}

/** 一拍表演。action 是给模型的高层动作词，controls 仍可做细调并覆盖动作默认值。 */
export interface DirectorScenePerformanceBeat {
  t?: number;
  at?: [number, number];
  facing?: number;
  pose?: string;
  /**
   * 高层动作：伸手、收手、低头、看向、点头，以及向左/右迈、交叉步、弓步、
   * 手臂绕环、绕肩、胸腔律动、脚尖点地、重心摆动、转身、旋身、下沉、起身、
   * 抬腿、身体波浪、拍手等舞步；执行层
   * 会展开成骨骼偏移和相对走位，普通用户不需要输入骨骼轴。
   */
  action?: string;
  /**
   * 同一拍要叠加的互补动作。建议最多两个：例如「向右迈」+「挥臂」；
   * 只用于组合动作，不替代按时间拆开的准备、峰值和收势节拍。
   */
  actions?: string[];
  /** 动作使用哪只手/哪一侧；不写时由动作类型选择默认侧。 */
  side?: 'left' | 'right' | 'both';
  /** 动作幅度，0.4~1.2 之间最适合白模粗演。 */
  intensity?: number;
  /** 该拍到下一拍的过渡：smooth 连续、linear 匀速、hold 保持前一拍到落点。 */
  interpolation?: 'smooth' | 'linear' | 'hold';
  /** 可循环预设默认随时间轴播放；false 用于保留静态定格。 */
  continuousMotion?: boolean;
  /** 低层骨骼细调（度）；会覆盖同一拍 action 生成的对应轴。 */
  controls?: Record<string, number>;
}

export interface DirectorSceneCameraIntent {
  move?: DirectorCameraMove;
  /**
   * 景别。翻译层把它换成机位距离和焦距，模型不要自己写坐标。
   * close 近景 / medium 中景（默认）/ wide 全景 / full 远景。
   */
  size?: 'close' | 'medium' | 'wide' | 'full';
  /**
   * 机位高度。eye 平视（默认，地平线水平）/ low 仰拍 / high 俯拍。
   * 不写就用平视，避免每条镜头都从同一俯角拍下去。
   */
  height?: 'eye' | 'low' | 'high';
  /**
   * 越肩 / 主观时，肩后或眼睛是谁。填角色 name 或 id。
   * 不填则用人物列表里的第一个。反打要显式写另一个人。
   */
  subject?: string;
  /** 被拍摄的角色 name/id；越肩时与前景 subject 分开，其他机位省略则取全体演员中心。 */
  focus?: string;
  /** 对话轴线的拍摄侧（按演员列表中两人的顺序定义法线）；整组反打须取同侧。 */
  axisSide?: 'positive' | 'negative';
  /** 运镜总时长（秒）。 */
  duration?: number;
  /** 运镜开始延迟（秒，默认 0）—— 「先走位、再运镜」这类编排靠它。 */
  start?: number;
  /**
   * 镜头节拍：在同一条运镜路径上安排停顿、再启动、反向或切换关注对象。
   * 未填写时执行层沿用 move 的连续路径；填写后仍会按真实时间跟随演员。
   */
  beats?: DirectorSceneCameraBeat[];
}

/** 镜头节拍。progress 是该镜头运动路径的进度，0~1；不写则按前后拍自动推算。 */
export interface DirectorSceneCameraBeat {
  t?: number;
  progress?: number;
  focus?: string;
  targetHeight?: number;
  /** 可选的环绕/推拉细节：以焦点为中心的距离（米）、方位角（度）、机位高度（米）。 */
  distance?: number;
  azimuth?: number;
  elevation?: number;
  /** 该拍的焦距（mm）；缺省继承上一拍或镜头默认焦距。 */
  focalLength?: number;
  interpolation?: 'smooth' | 'linear' | 'hold';
}

/**
 * MONOFORM 白模台能生成的物品类型（= 它 `addPrimitive` 的类型域）。
 * 前 4 个是基础几何体，后 10 个是场景粗模，最后一个是**灰度高度场地形**（不是万能建模）。
 * 360 导演台忽略 `objects` 字段。
 */
export type DirectorScenePropType =
  | 'box' | 'sphere' | 'cylinder' | 'plane'
  | 'arch' | 'stairs' | 'door' | 'window' | 'table' | 'chair' | 'sofa' | 'roof' | 'tree' | 'vehicle'
  /** 灰度高度场地形（不是万能建模）。 */
  | 'depthMesh'
  /** 外部 GLB（Blender 参数化模板生成的导演向几何，见 `scripts/blender/`）。 */
  | 'model';

/** depthMesh 的调参（照抄 MONOFORM `DepthMeshModel` 的 settings 键与值域）。 */
export interface DirectorSceneDepthSettings {
  /** 亮 = 远 还是 亮 = 近（默认 false = 亮的地方更远）。 */
  invert?: boolean;
  /** 深度范围（米）：near 默认 0.8、far 默认 6。 */
  near?: number;
  far?: number;
  /** 视场角（度，20~120，默认 60）。 */
  fov?: number;
  /** 网格密度（16~128，默认 64）—— 越高越细也越吃性能。 */
  density?: number;
  /** 平滑次数（0~4，默认 1）。 */
  smoothing?: number;
}

/** 一个物品摆放意图。物品本身是静止的；要动请用角色的 route 或相机运镜。 */
export interface DirectorScenePropIntent {
  type: DirectorScenePropType;
  /** 地面坐标 [x, z]（米）。默认 [0,0]。 */
  at?: [number, number];
  /** 离地高度覆盖（米）；不给用该类型的默认抬升（树 1.3 / 平面 0.02 / 其余 0.5）。 */
  y?: number;
  /** 绕 Y 轴朝向（度）。建议留在 ±180 内 —— 对象旋转是普通 lerp，跨 180° 会绕远路。 */
  rotationY?: number;
  /** 尺寸 [x,y,z]（米）覆盖；不给用该类型默认尺寸。 */
  scale?: [number, number, number];
  color?: string;
  name?: string;
  /**
   * **仅 `type: "depthMesh"`**：灰度高度图的 URL（**必须同源可访问** —— 白模台在
   * 同源 iframe 里 fetch，跨域图会被浏览器拦住）。
   *
   * 语义：像素越亮 = 越远（可用 `depth.invert` 翻转），形成地形/浮雕类的立体块。
   * **这不是"任意 3D 生成"** —— 它只把一张灰度图抬成高度场。
   */
  depthMapUrl?: string;
  /** 仅 `type: "depthMesh"`：可选调参。 */
  depth?: DirectorSceneDepthSettings;
  /**
   * **仅 `type: "model"`**：GLB 的**同源** URL。
   *
   * 由 Blender 参数化模板生成（`scripts/blender/build_template.py`），产物放在
   * `frontend/public/previs-models/`。**必须是未压缩 GLB** —— MONOFORM 的 GLTFLoader
   * 没注册 DRACO/KTX2，压缩过的包它加载不了。
   */
  modelUrl?: string;
  /**
   * **增量修改**：填一个已存在对象的 id 或名字（从「白模台当前场景」摘要里拿）。
   * 给了它 → 只更新那个物品、其余原样保留；一个都不给 → 整批替换 AI 生成的物品。
   */
  target?: string;
}

export interface DirectorSceneIntent {
  type: typeof DIRECTOR_SCENE_INTENT_TYPE;
  /** compose 重新编排演出；edit 保留已有姿态和时长做局部修改。与对象 target 的身份选择独立。 */
  mode?: 'compose' | 'edit';
  /** 整段演出共用时长（秒，最多 60）；未写时 compose 取动作终点后半秒。 */
  duration?: number;
  /**
   * 「清空重来」：把白模台恢复成空画布（清掉所有对象与动画轨，保留相机位姿与
   * fps/时长设置 —— 没有相机就没视角了）。用户说「清空」「重来」「全部删掉」时
   * agent 输出这个；面板上也有一个（带二次确认）不经过模型的按钮。
   * 破坏性操作，宿主会在执行前存撤销快照。
   */
  reset?: boolean;
  characters?: DirectorSceneCharacterIntent[];
  camera?: DirectorSceneCameraIntent;
  /**
   * 多机位。每条是镜头列表里的一台机，只带自己的 camera。
   * 人物和道具仍用上面的 characters / objects，每条镜头各存一份。
   * 这是可切换的机位，不是时间线上自动切镜。出现这个数组就整批替换镜头列表。
   */
  shots?: Array<{ name?: string; camera: DirectorSceneCameraIntent }>;
  /** 物品/粗模摆放（仅 MONOFORM 白模台消费）。 */
  objects?: DirectorScenePropIntent[];
}

export const DIRECTOR_PROPOSALS_TYPE = 'director-desk-proposals';

/**
 * 一条灵感提案：给小白看的标题 + 一句话说明，加上点选后直接应用的完整 scene。
 * scene 就是一个普通 DirectorSceneIntent —— 点选提案 = 走 dd-scene 同一条注入通道。
 */
export interface DirectorProposal {
  title: string;
  summary: string;
  scene: DirectorSceneIntent;
}

/**
 * 分镜卡的展示数据：把 intent 拆成人话摘要（纯函数，UI 只负责排版、不做判断）。
 *
 * 存在的理由：dd-scene 块会被 `stripDirectorSceneIntent` 从气泡里剥掉，用户只看到
 * 一段自然语言 + 画面变了 ——「它到底摆了/动了什么」没有可复查的痕迹（实测用户反馈
 * 「没有卡片」）。卡片就是这个痕迹的载体，也是重新应用 / 撤销的入口。
 */
export type DirectorSceneCardData = {
  characterNames: string[];
  objectTypes: DirectorScenePropType[];
  camera: { move: string; duration: number | null; start: number | null } | null;
  /** 时间轴上的节拍（秒 + 事件种类），按时间升序去重。 */
  beats: Array<{ at: number; kind: 'walk' | 'camera' | 'action' }>;
};

export function summarizeDirectorSceneIntent(intent: DirectorSceneIntent): DirectorSceneCardData {
  const characters = intent.characters ?? [];
  const objects = intent.objects ?? [];
  const camera = intent.camera ?? intent.shots?.[0]?.camera;

  const beats: DirectorSceneCardData['beats'] = [];
  characters.forEach((character) => {
    if (character.route && character.route.length >= 2) {
      beats.push({ at: startSeconds(character.start), kind: 'walk' });
    }
    for (const beat of character.performance ?? []) {
      if (beat && typeof beat === 'object') {
        beats.push({ at: startSeconds(beat.t), kind: 'action' });
      }
    }
  });
  // 静止机位不算节拍 —— 它没有「什么时候开始动」这回事。
  if (camera?.move && camera.move !== 'static') {
    beats.push({ at: startSeconds(camera.start), kind: 'camera' });
  }

  const seen = new Set<string>();
  const deduped = beats
    .filter((beat) => {
      const key = `${beat.at}:${beat.kind}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.at - right.at || left.kind.localeCompare(right.kind));

  return {
    // 没给名字就按序号称呼（这是数据不是文案，不进词条）。
    characterNames: characters.map((character, index) => character.name?.trim() || `#${index + 1}`),
    objectTypes: objects.map((object) => object.type),
    camera: camera?.move
      ? { move: camera.move, duration: camera.duration ?? null, start: camera.start ?? null }
      : null,
    beats: deduped,
  };
}

function startSeconds(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 生成物体/关键帧上打的标记前缀 —— 重新生成时据此替换上一批，不动用户手摆的。 */
const GEN_OBJECT_PREFIX = 'aigen_char_';
const GEN_KF_PREFIX = 'aigen_kf_';

type Vec3 = [number, number, number];

interface DeskTransform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

interface DeskCameraKeyframe {
  id: string;
  time: number;
  position: Vec3;
  target: Vec3;
  fov: number;
  targetMode: string;
  targetObjectId: string | null;
  targetBodyPart: string;
  targetFollowMode: string;
  targetStabilizationEnabled: boolean;
  pointBehavior: string;
  holdSeconds: number;
}

interface DeskCamera {
  id: string;
  name?: string;
  fov?: number;
  transform?: DeskTransform;
  target?: Vec3;
  motionPath?: {
    duration?: number;
    loop?: boolean;
    interpolation?: string;
    easing?: string;
    keyframes?: DeskCameraKeyframe[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

interface DeskObject {
  id: string;
  name: string;
  kind: string;
  [k: string]: unknown;
}

/** 导演台工程根（我们只关心这几段，其余原样保留）。 */
export interface DeskProject {
  objects?: DeskObject[];
  cameras?: DeskCamera[];
  activeCameraId?: string;
  [k: string]: unknown;
}

const DEFAULT_TARGET: Vec3 = [0, 1.05, 0];
const DEFAULT_FOV = 50;
const DEFAULT_EYE_Y = 1.7178;
const DEFAULT_RADIUS = 7.2122;
const HEX = /^#[0-9a-fA-F]{6}$/;

function clampNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * 导演台 UE 人偶的 33 个骨骼控制名（`<关节>.<轴>`）。来自 bundle 实测。
 * 只放行这些名字，其余静默丢弃 —— 一个拼错的 key 就可能让导演台反序列化崩。
 */
const BONE_CONTROL_NAMES = new Set<string>([
  'head.pitch', 'head.yaw', 'head.roll',
  'body.pitch', 'body.yaw', 'body.roll',
  'torso.pitch', 'torso.yaw', 'torso.roll',
  'leftShoulder.pitch', 'leftShoulder.spread', 'leftShoulder.twist',
  'rightShoulder.pitch', 'rightShoulder.spread', 'rightShoulder.twist',
  'leftElbow.bend', 'rightElbow.bend',
  'leftHand.pitch', 'leftHand.roll',
  'rightHand.pitch', 'rightHand.roll', 'rightHand.twist',
  'leftHip.pitch', 'leftHip.spread', 'leftHip.twist',
  'rightHip.pitch', 'rightHip.spread', 'rightHip.twist',
  'leftKnee.bend', 'rightKnee.bend',
  'leftFoot.pitch', 'rightFoot.pitch', 'rightFoot.roll',
]);

/**
 * 只保留白名单骨骼名、把角度 clamp 到 ±180 的净化后 controls。
 *
 * 同时接受两种格式（LLM 会两种都产）：
 * - 扁平点号：`{"rightShoulder.pitch": -15}`（导演台原生格式）
 * - 嵌套：`{"rightShoulder": {"pitch": -15, "spread": 40}}` —— 自动拍平成 `关节.轴`
 *
 * 输出恒为导演台要的扁平格式。非白名单名 / 非数值静默丢弃（防拼错字段崩导演台）。
 */
function sanitizeControls(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, number> = {};
  const put = (name: string, v: unknown) => {
    if (BONE_CONTROL_NAMES.has(name) && typeof v === 'number' && Number.isFinite(v)) {
      out[name] = Math.max(-180, Math.min(180, v));
    }
  };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v && typeof v === 'object') {
      // 嵌套 {关节:{轴:值}} → 拍平成 关节.轴
      for (const [axis, av] of Object.entries(v as Record<string, unknown>)) put(`${k}.${axis}`, av);
    } else {
      put(k, v);
    }
  }
  return out;
}

/** 校验路线：至少 2 个合法 [x,z] 路点才算数，否则返回 null。 */
function sanitizeRoute(raw: unknown): Array<[number, number]> | null {
  if (!Array.isArray(raw)) return null;
  const pts = raw
    .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2)
    .map((p) => [clampNumber(p[0], 0), clampNumber(p[1], 0)] as [number, number]);
  return pts.length >= 2 ? pts : null;
}

/**
 * 把路点数组展开成角色 `motionPath`：段动作 `walk-cycle`（走路动画）、朝向沿路径。
 * keyframe.time 是序号（导演台会规范化），真实时长由 duration 秒控制。
 */
function buildRouteMotionPath(route: Array<[number, number]>, durationSeconds: number) {
  return {
    interpolation: 'linear',
    speedMode: 'uniform',
    duration: durationSeconds,
    keyframes: route.map(([x, z], i) => ({
      id: `${GEN_KF_PREFIX}route_${i}`,
      time: i,
      actionPresetId: 'walk-cycle',
      facingMode: 'path',
      pointBehavior: 'pass',
      holdSeconds: 0,
      holdAction: 'none',
      holdActionPresetId: null,
      controls: {},
      transform: { position: [x, 0, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 },
    })),
  };
}

/** 把一个角色 intent 展开成一个 mannequin 物体（零外部资产依赖）。 */
function buildCharacter(intent: DirectorSceneCharacterIntent, index: number): DeskObject {
  const route = sanitizeRoute(intent.route);
  // 有路线时起点用 route[0]，否则用 at。
  const start = route ? route[0] : Array.isArray(intent.at) && intent.at.length === 2 ? intent.at : [0, 0];
  const x = clampNumber(start[0], 0);
  const z = clampNumber(start[1], 0);
  const facing = clampNumber(intent.facing, 0);
  const color = typeof intent.color === 'string' && HEX.test(intent.color) ? intent.color : '#4F8EF7';
  const pose = typeof intent.pose === 'string' && intent.pose.trim() ? intent.pose.trim() : 'stand';
  const obj: DeskObject = {
    id: `${GEN_OBJECT_PREFIX}${index + 1}`,
    // 写进导演台工程 JSON 的物体名（层级面板标签），非 app UI；与导演台自带默认名「角色01」同口径，随 agent 传入 name 覆盖。
    name: typeof intent.name === 'string' && intent.name.trim() ? intent.name.trim() : `角色${index + 1}`, // i18n-exempt
    kind: 'character',
    visible: true,
    locked: false,
    bodyType: 'mannequin',
    color,
    transform: {
      position: [x, 0, z] as Vec3,
      // 导演台旋转用弧度；facing 是度。
      rotation: [0, (facing * Math.PI) / 180, 0] as Vec3,
      scale: [1, 1, 1] as Vec3,
    },
    characterRig: { rigType: 'ue4-mannequin', posePresetId: pose, controls: sanitizeControls(intent.controls) },
  };
  if (route) {
    obj.motionPath = buildRouteMotionPath(route, clampNumber(intent.routeDuration, 5));
  }
  return obj;
}

function keyframe(time: number, position: Vec3, target: Vec3, fov: number): DeskCameraKeyframe {
  return {
    id: `${GEN_KF_PREFIX}${time}`,
    time,
    position,
    target,
    fov,
    targetMode: 'manual',
    targetObjectId: null,
    targetBodyPart: 'center',
    targetFollowMode: 'immediate',
    targetStabilizationEnabled: false,
    pointBehavior: 'pass',
    holdSeconds: 0,
  };
}

/** 绕 target 的 Y 轴把 position 旋转 deg 度。 */
function rotateAroundY(position: Vec3, target: Vec3, deg: number): Vec3 {
  const rad = (deg * Math.PI) / 180;
  const dx = position[0] - target[0];
  const dz = position[2] - target[2];
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [target[0] + dx * cos - dz * sin, position[1], target[2] + dx * sin + dz * cos];
}

/**
 * 把运镜 intent 展开成一串关键帧。基点取该相机当前的 position/target/fov；
 * 没有就用默认站位（正面 7.2m、fov 50、看向 [0,1.05,0]）。
 */
export function buildCameraKeyframes(cam: DeskCamera | undefined, move: DirectorCameraMove): DeskCameraKeyframe[] {
  const base: Vec3 = cam?.transform?.position ?? [0, DEFAULT_EYE_Y, DEFAULT_RADIUS];
  const target: Vec3 = cam?.target ?? DEFAULT_TARGET;
  const fov = clampNumber(cam?.fov, DEFAULT_FOV);
  let seq = 0;
  const kf = (position: Vec3, t?: Vec3, f?: number) => keyframe(seq++, position, t ?? target, f ?? fov);

  switch (move) {
    case 'static':
      return [];
    case 'orbit-left':
    case 'orbit-right': {
      const dir = move === 'orbit-left' ? -1 : 1;
      // 90° 环绕，4 帧（含起点），足够顺滑又不啰嗦。
      return [0, 30, 60, 90].map((d) => kf(rotateAroundY(base, target, dir * d)));
    }
    case 'dolly-in':
    case 'dolly-out': {
      const sign = move === 'dolly-in' ? 1 : -1;
      // 沿 base→target 方向进/退 35%。
      const lerp = (f: number): Vec3 => [
        base[0] + (target[0] - base[0]) * f,
        base[1] + (target[1] - base[1]) * f,
        base[2] + (target[2] - base[2]) * f,
      ];
      return [kf(base), kf(lerp(sign * 0.35))];
    }
    case 'pan-left':
    case 'pan-right': {
      const dir = move === 'pan-left' ? -1 : 1;
      // 原地摇镜：位置不动，target 绕相机横扫 ±30°。
      const t2 = rotateAroundY(target, base, dir * 30);
      return [kf(base, target), kf(base, t2)];
    }
    default:
      return [];
  }
}

/**
 * 把 intent 应用到当前工程，返回**新工程**（不改入参）。
 * - 角色：先移除上一批 AI 生成的（`aigen_char_*`），再追加本次；用户手摆的不动。
 * - 运镜：写活动相机（`activeCameraId`，回落第一台）的 `motionPath`。
 */
export function applyDirectorSceneIntent(project: DeskProject, intent: DirectorSceneIntent): DeskProject {
  const next: DeskProject = { ...project };

  if (Array.isArray(intent.characters)) {
    const kept = (project.objects ?? []).filter((o) => !o.id?.startsWith?.(GEN_OBJECT_PREFIX));
    const generated = intent.characters.slice(0, 12).map((c, i) => buildCharacter(c, i));
    next.objects = [...kept, ...generated];
  }

  if (intent.camera && intent.camera.move) {
    const cams = (project.cameras ?? []).map((c) => ({ ...c }));
    const activeId = project.activeCameraId;
    let idx = cams.findIndex((c) => c.id === activeId);
    if (idx < 0) idx = 0;
    const cam = cams[idx];
    if (cam) {
      const duration = clampNumber(intent.camera.duration, 6);
      const keyframes = buildCameraKeyframes(cam, intent.camera.move);
      cam.motionPath = {
        ...(cam.motionPath ?? {}),
        duration,
        loop: cam.motionPath?.loop ?? false,
        interpolation: cam.motionPath?.interpolation ?? 'smooth',
        easing: cam.motionPath?.easing ?? 'ease-in-out',
        keyframes,
      };
      next.cameras = cams;
    }
  }

  return next;
}

/**
 * 修复 LLM 手写 JSON 的常见小毛病。**只在 JSON.parse 已经失败后才用**，
 * 所以它不是「宽容解析」，而是最后的兜底。
 *
 * 实测踩到的真实故障：agent 输出的 dd-scene 少了**最外层闭合 `}`**
 * （12 行 JSON，写到 `"camera": {...}` 就停了），JSON.parse 抛错 →
 * 整块被静默丢弃 → 用户点了半天「AI 助手」什么也没发生。
 *
 * 处理三类问题（全部字符串感知，不会改坏字符串内容）：
 * 1. **缺闭合括号**：按栈把没收尾的 `}` / `]` 补齐；
 * 2. **尾随逗号**：`{"a":1,}` / `[1,2,]`；
 * 3. **前后夹带叙述**：从第一个 `{` 开始，到括号配平处结束（后面的话丢掉）。
 * 返回 null 表示连第一个 `{` 都没有（不是 JSON 块）。
 */
function repairLooseJson(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let out = '';
  let balanced = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']');
      out += ch;
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (stack.length === 0) break; // 多余的闭合 → 到上一处就该结束了
      stack.pop();
      out += ch;
      if (stack.length === 0) {
        balanced = true;
        break;
      }
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw[j])) j += 1;
      if (raw[j] === '}' || raw[j] === ']') continue; // 尾随逗号丢掉
      out += ch;
      continue;
    }
    out += ch;
  }
  if (!balanced) out += stack.reverse().join(''); // 补齐没关上的括号
  return out;
}

/** 解析一段 JSON 文本：先按原样，失败再修复一次。 */
function parseLooseJson(body: string): unknown {
  const trimmed = body.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // 落下去修复
  }
  const repaired = repairLooseJson(trimmed);
  if (repaired === null) return undefined;
  try {
    return JSON.parse(repaired);
  } catch {
    return undefined;
  }
}

/**
 * 抽出回复里所有 fenced 块（```dd-scene / ```dd-proposals / ```json / 无标签）并逐个解析，
 * 返回解析成功的对象列表。解析失败但**看起来像**目标块的情况由调用方决定怎么提示
 * （见 hasDirectorSceneBlock）。
 */
function parseJsonCandidates(text: string): unknown[] {
  const fence = text.match(/```(?:dd-scene|dd-proposals|json)?\s*([\s\S]*?)```/g);
  const bodies = fence
    ? fence.map((b) => b.replace(/```(?:dd-scene|dd-proposals|json)?\s*/, '').replace(/```$/, ''))
    : [text];
  const out: unknown[] = [];
  for (const body of bodies) {
    const parsed = parseLooseJson(body);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

/**
 * 回复里是否**声称**含 dd-scene 块（用于「解析失败要让用户看见」——
 * 静默丢弃过一次，用户对着不动的白模台不知道发生了什么）。
 */
export function hasDirectorSceneBlock(text: string): boolean {
  return typeof text === 'string' && text.includes(DIRECTOR_SCENE_INTENT_TYPE);
}

/**
 * 从一段助手回复文本里抽出 ```dd-scene …``` 块并解析成 intent。
 * 解析失败或类型不符返回 null（宁可不动，也不注入半成品）——
 * 调用方应该用 hasDirectorSceneBlock 区分「没有块」和「有块但解析失败」并提示用户。
 */
export function parseDirectorSceneIntent(text: string): DirectorSceneIntent | null {
  if (typeof text !== 'string' || !text.includes(DIRECTOR_SCENE_INTENT_TYPE)) return null;
  for (const parsed of parseJsonCandidates(text)) {
    if (parsed && typeof parsed === 'object' && (parsed as { type?: unknown }).type === DIRECTOR_SCENE_INTENT_TYPE) {
      return parsed as DirectorSceneIntent;
    }
  }
  return null;
}

/** 渲染时把 ```dd-scene``` 块从气泡里剥掉（和上下文块同款处理，别让用户看到 JSON）。 */
export function stripDirectorSceneIntent(text: string): string {
  if (typeof text !== 'string' || !text.includes(DIRECTOR_SCENE_INTENT_TYPE)) return text;
  return text
    .replace(/```(?:dd-scene|json)?\s*\{[\s\S]*?"type"\s*:\s*"director-desk-scene"[\s\S]*?\}\s*```/g, '')
    .trim();
}

/**
 * 从助手回复里抽出 ```dd-proposals …``` 块，解析成一组可点选的灵感提案。
 * 只保留 scene 合法（type=director-desk-scene）且有标题的提案；一条都不合法返回 null。
 */
export function parseDirectorProposals(text: string): DirectorProposal[] | null {
  if (typeof text !== 'string' || !text.includes(DIRECTOR_PROPOSALS_TYPE)) return null;
  for (const parsed of parseJsonCandidates(text)) {
    if (!parsed || typeof parsed !== 'object') continue;
    const value = parsed as { type?: unknown; proposals?: unknown };
    if (value.type !== DIRECTOR_PROPOSALS_TYPE || !Array.isArray(value.proposals)) continue;
    const valid = (value.proposals as DirectorProposal[]).filter(
      (p) => p && typeof p.title === 'string' && p.scene && p.scene.type === DIRECTOR_SCENE_INTENT_TYPE,
    );
    return valid.length ? valid : null;
  }
  return null;
}

/** 渲染时把 ```dd-proposals``` 块从气泡里剥掉 —— 提案改用卡片展示，别让用户看到 JSON。 */
export function stripDirectorProposals(text: string): string {
  if (typeof text !== 'string' || !text.includes(DIRECTOR_PROPOSALS_TYPE)) return text;
  return text
    .replace(/```(?:dd-proposals|json)?\s*\{[\s\S]*?"type"\s*:\s*"director-desk-proposals"[\s\S]*?\}\s*```/g, '')
    .trim();
}
