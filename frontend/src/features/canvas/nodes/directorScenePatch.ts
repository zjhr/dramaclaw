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
  /**
   * 整段演出共用时长（秒，最多 60）；未写时 compose 取动作终点后半秒。
   * **仅 MONOFORM 消费**：v2 的时长由 `project.patch.duration` 表达，不是独立操作。
   */
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

// ═══════════════════════════════════════════════════════════════════════════
// v2 迁移层：dd-scene intent → 上游 director_apply 操作数组
// ═══════════════════════════════════════════════════════════════════════════
//
// 为什么需要它：上面的 `applyDirectorSceneIntent` 是 **MONOFORM 白模台**的语义 ——
// 「拿已有工程整体覆盖」。新导演台（`mangfufu/director-desk` v0.4.10）的语义相反：
// `director_apply` 接收一批**增量操作**，原子提交、可撤销。所以同一份 dd-scene 协议
// 在两个引擎下必须走两条不同的翻译路径，否则「整体覆盖」会把用户在 v2 里手摆的东西
// 一起抹掉。
//
// `applyDirectorSceneIntent` 保留不删：MONOFORM 分支仍要用它，且既有 MONOFORM 节点
// 里已存的工程必须还能打开（单向不可逆迁移）。
//
// 上游合同（`vendor/director-desk/src/automation/contract.ts` 的 `director_apply`）
// 允许的 operation：add / update / remove / project / cuts / notes / motion /
// camera-motion / lighting-preset / replace-prop / resource / resource-remove /
// clear-inherited-pose。下面的映射只用 add / update / remove / project / cuts /
// notes / motion / camera-motion。

/** 一条上游 `director_apply` 操作。字段名与 `EditOperation` 逐字对齐，不做改写。 */
export interface DirectorOperation {
  operation: string;
  id?: string;
  asset?: string;
  kind?: 'actor' | 'prop';
  name?: string;
  time?: number;
  duration?: number;
  position?: [number, number, number];
  patch?: Record<string, unknown>;
  value?: unknown;
}

/** 生成对象的 id 前缀。v2 的 id 必须过 `model.ts` 的 safeId（`/^[\p{L}\p{N}_:.-]{1,200}$/u`）。 */
const GEN_V2_PREFIX = 'dd-';

/**
 * 合成 id 的分配器。
 *
 * ## 为什么需要它
 *
 * 新角色的 id 由「前缀 + 序号」合成（`dd-char1`、`dd-char2`…），这样 agent 下一轮
 * 报 `target:"dd-char1"` 就能改到同一个对象。但序号是**本批内**的下标：agent 连着
 * 说两轮「摆两个人」，第二轮的第一个角色又会拿到 `dd-char1` —— 而它已经存在了。
 * 上游 `model.ts:256` 的 `ids.has(e.id)` 会判「对象标识重复」，**整批回滚**。
 *
 * 所以分配时必须避开宿主已告知的占用 id；真撞上了就顺延到下一个空位。
 * 这是实测跑上游 `applyOperations` 才发现的：字段名照着合同写没错，
 * 但「同一 id 出现两次」这条约束只在 `assertProject` 里，不在 `validateToolInput` 里。
 */
function allocateId(prefix: string, index: number, occupied: ReadonlySet<string>): string {
  let slot = index + 1;
  let id = `${GEN_V2_PREFIX}${prefix}${slot}`;
  while (occupied.has(id)) {
    slot += 1;
    id = `${GEN_V2_PREFIX}${prefix}${slot}`;
  }
  return id;
}

/**
 * v2 导演台里「角色」用什么资产。
 *
 * `human-adult` 而不是老的 `person`（`person` 是 legacy id，能力表更弱）；
 * 目录条目见 `vendor/director-desk/src/assets/catalog/humans.ts:13`，
 * `kind:'actor'`、`capabilities.pose===true`，所以 `pose` / `poseKeys` 补丁能过
 * `model.ts:279` 的「该白模不支持关节姿态」检查。
 */
const V2_ACTOR_ASSET = 'human-adult';

/**
 * v2 的道具类型 → 上游资产目录 id。
 *
 * 只收**目录里确实存在**的 id（`vendor/director-desk/src/asset-catalog.ts:47` 的
 * `ASSETS` 是唯一事实来源，`model.ts:257` 会逐条校验 `ASSETS.some(...)`）。
 * 查不到的（`window`、`roof`）一律不映射 —— 翻译层宁可少摆一个物品，
 * 也不能产出一个 `未知资产` 让整批 `director_apply` 原子回滚。
 *
 * `depthMesh` / `model` 同样不映射：v2 没有「灰度高度场」也没有「外部 GLB 直接摆」
 * 这两个概念（GLB 走 `director_media{action:'import'}` 变成工程资源后才能用）。
 */
const V2_PROP_ASSET: Partial<Record<DirectorScenePropType, string>> = {
  box: 'shape-box',
  sphere: 'shape-sphere',
  cylinder: 'shape-cylinder',
  plane: 'shape-plane',
  arch: 'shape-arch',
  stairs: 'structure-stairs-straight',
  door: 'door',
  table: 'furniture-table',
  chair: 'furniture-chair',
  sofa: 'furniture-sofa',
  tree: 'plant-broadleaf',
  vehicle: 'vehicle-sedan',
};

/**
 * MONOFORM 姿势预设 id → v2 的 `Action`（`model.ts:33` 的联合类型）。
 *
 * v2 的姿势不是「预设 id」而是**关节角度**（`Pose = Partial<Record<Joint, number>>`，
 * 单位是度 —— `assets/human-animation.ts:113` 的 `degToRad(v)` 证明）。
 * 预设动作改由 `clips[].action` 表达，所以这里映射到动作名；映射不到的静默丢弃。
 */
const V2_POSE_ACTION: Record<string, string> = {
  stand: 'idle',
  stand_relaxed: 'idle',
  idle: 'idle',
  walk: 'walk',
  run: 'run',
  crouch: 'crouch',
  squat_full: 'crouch',
  sit: 'sit',
  wave: 'wave',
  agree: 'idle',
  headShake: 'turn',
  sad_pose: 'idle',
  tpose: 'idle',
};

/**
 * MONOFORM 骨骼名 → v2 关节名。
 *
 * v2 的白名单只有 11 个（`assets/joint-schema.ts:2` 的 `HUMAN_JOINTS`），
 * 且 `model.ts:272` 的 `poseValid` 用 `Object.hasOwn(assetJoints(e.asset), k)` 逐键
 * 检查 —— 写一个不存在的关节名会让**整批**操作回滚。左手系映射到 left、右手系到
 * right，ForeArm/UpLeg/Leg 是 MONOFORM 的分段命名，在 v2 里并入相邻的大关节。
 */
const V2_JOINT_BY_BONE: Record<string, string> = {
  'head.pitch': 'head',
  'head.yaw': 'headYaw',
  'head.roll': 'head',
  'torso.pitch': 'torso',
  'torso.yaw': 'torso',
  'torso.roll': 'torso',
  'body.pitch': 'torso',
  'body.yaw': 'torso',
  'body.roll': 'torso',
  'leftArm.pitch': 'leftArm',
  'leftArm.yaw': 'leftArm',
  'leftArm.twist': 'leftArm',
  'rightArm.pitch': 'rightArm',
  'rightArm.yaw': 'rightArm',
  'rightArm.twist': 'rightArm',
  'leftForeArm.pitch': 'leftArm',
  'leftForeArm.yaw': 'leftArm',
  'rightForeArm.pitch': 'rightArm',
  'rightForeArm.yaw': 'rightArm',
  'leftElbow.bend': 'leftElbow',
  'rightElbow.bend': 'rightElbow',
  'leftUpLeg.pitch': 'leftHip',
  'rightUpLeg.pitch': 'rightHip',
  'leftLeg.pitch': 'leftKnee',
  'rightLeg.pitch': 'rightKnee',
  'leftHand.pitch': 'leftElbow',
  'rightHand.pitch': 'rightElbow',
  'leftFoot.pitch': 'leftKnee',
  'rightFoot.pitch': 'rightKnee',
  'leftFoot.roll': 'leftKnee',
  'rightFoot.roll': 'rightKnee',
  'leftHip.pitch': 'leftHip',
  'rightHip.pitch': 'rightHip',
  'leftHip.spread': 'leftHip',
  'rightHip.spread': 'rightHip',
  'leftKnee.bend': 'leftKnee',
  'rightKnee.bend': 'rightKnee',
};

/** v2 `Pose` 允许的关节名（与 `HUMAN_JOINTS` 逐字一致，导入时不做静态依赖）。 */
const V2_JOINT_NAMES = new Set([
  'head', 'headYaw', 'torso',
  'leftArm', 'rightArm', 'leftElbow', 'rightElbow',
  'leftHip', 'rightHip', 'leftKnee', 'rightKnee',
]);

const V2_ACTIONS = new Set([
  'idle', 'walk', 'run', 'sit', 'standup', 'crouch', 'crawl', 'jump',
  'lie', 'fall', 'wave', 'point', 'turn',
]);

/** 上游运镜预设（`vendor/director-desk/src/cinematography/motion-presets.ts:6`）。 */
export type DirectorCameraPreset =
  | 'push' | 'pull' | 'truck' | 'rise' | 'descend' | 'arc' | 'arc-push'
  | 'crane-reveal' | 'ground-rise' | 'whip-pan' | 'push-pause'
  | 'dolly-zoom' | 'roll-recover' | 'reframe';

/**
 * MONOFORM `DirectorCameraMove` → 上游 `CameraPreset`。
 *
 * v2 的运镜是**路径预设**（`applyCameraMotion` 直接改写摄影机的 `path.points` 与
 * `effects.channels`），语义比「关键帧数组」粗但更稳。上游没有「推轨 + 摇镜」
 * 的复合预设，所以这里是一对多的降级映射，`static` 走 `camera-motion` 之外的
 * 分支（见 `cameraOperation`）。
 */
const V2_CAMERA_PRESET: Record<DirectorCameraMove, { preset: DirectorCameraPreset; side: 1 | -1 }> = {
  'dolly-in': { preset: 'push', side: 1 },
  'dolly-out': { preset: 'pull', side: 1 },
  'orbit-left': { preset: 'arc', side: -1 },
  'orbit-right': { preset: 'arc', side: 1 },
  'pan-left': { preset: 'whip-pan', side: -1 },
  'pan-right': { preset: 'whip-pan', side: 1 },
  'crane-up': { preset: 'rise', side: 1 },
  'crane-down': { preset: 'descend', side: 1 },
  'rail-left': { preset: 'truck', side: -1 },
  'rail-right': { preset: 'truck', side: 1 },
  'zoom-in': { preset: 'push', side: 1 },
  'zoom-out': { preset: 'pull', side: 1 },
  'handheld': { preset: 'roll-recover', side: 1 },
  'pov': { preset: 'ground-rise', side: 1 },
  'over-shoulder': { preset: 'arc-push', side: 1 },
  static: { preset: 'push', side: 1 },
};

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 台词拍点 → 上游 `ProductionNote` 形状（`vendor/director-desk/src/model.ts:134`）。 */
export interface DirectorProductionNote {
  id: string;
  start: number;
  end: number;
  actorId: string;
  story: string;
  emotion: string;
  dialogue: string;
  action: string;
}

/** `notes` 操作的完整替换值。`promptText` / `textOnlyPrompt` 两稿都在这里。 */
export interface DirectorProductionValue {
  fixedPrompt: string;
  sceneReferenceIds: string[];
  notes: DirectorProductionNote[];
  promptText?: string;
  textOnlyPrompt?: string;
  promptMode?: 'reference-video' | 'text-only';
}

/** 语音气泡渲染需要的最小信息（宿主侧 `DirectorDeskNode` 用它驱动叠加层）。 */
export interface DirectorSpeechLine {
  /** 说话人实体 id（= 拍点的 actorId）。 */
  actorId: string;
  text: string;
  start: number;
  end: number;
}

/** 一个角色被翻译成「实体 id + 台词」的结果，供调用方建索引。 */
export interface DirectorTranslatedCharacter {
  id: string;
  name: string;
  /** 该角色携带的台词（已按 id 关联到实体）。 */
  lines: DirectorSpeechLine[];
}

/**
 * 翻译产物。除了操作数组，还带上「谁是谁」的索引 ——
 * 气泡叠加层要按 actorId 找实体位置，agent 的下一轮也要按名字指代对象。
 */
export interface DirectorTranslation {
  operations: DirectorOperation[];
  characters: DirectorTranslatedCharacter[];
  /** `lines` 翻译出的台词拍点（同时已并进 operations 里的 `notes` 操作）。 */
  speech: DirectorSpeechLine[];
  /** 现有 production 的原样回带，用于构造 `notes` 的完整替换值。 */
  production: DirectorProductionValue;
  /** 无法翻译而被丢弃的字段（agent 拼错 id / v2 没有对应资产）。如实报，不静默。 */
  dropped: string[];
}

/** 上游 `model.ts:272` 的 `poseValid` 要求角度绝对值 ≤ 360，这里再收一道 180。 */
function clampDegrees(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(-180, Math.min(180, value));
}

/**
 * MONOFORM 的地面坐标 `[x, z]` → v2 的三维 `position`。
 *
 * y 恒为 0：角色站地面，道具按各自默认抬升单独给（`propOperations` 里处理）。
 * 形状不合法时回落到原点而不是猜 —— `model.ts:261` 的 `v3()` 要求正好三项。
 */
function toDirectorPosition(at: unknown, y: number): [number, number, number] {
  if (Array.isArray(at) && at.length === 2) {
    return [finite(at[0], 0), y, finite(at[1], 0)];
  }
  return [0, y, 0];
}

/**
 * MONOFORM `controls`（`{关节}.{轴}` → 度）→ v2 `Pose`（关节名 → 度）。
 *
 * 两层过滤：先按 {@link V2_JOINT_BY_BONE} 映射，再按 {@link V2_JOINT_NAMES} 白名单
 * 复核。任一层放行的名字若不在白名单里，上游 `assertProject` 会让整批操作回滚。
 */
export function toDirectorPose(raw: unknown): Record<string, number> {
  const pose: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return pose;
  for (const [bone, value] of Object.entries(raw as Record<string, unknown>)) {
    const angle = clampDegrees(value);
    if (angle === null) continue;
    const joint = V2_JOINT_BY_BONE[bone];
    if (!joint || !V2_JOINT_NAMES.has(joint)) continue;
    // 同一关节被多个骨骼名映射到时取绝对值较大者：MONOFORM 里 ForeArm 与 Arm
    // 是串联的两段，角度叠加在 v2 的单关节上会超出可动范围。
    pose[joint] = Math.abs(pose[joint] ?? 0) >= Math.abs(angle) ? pose[joint] : angle;
  }
  return pose;
}

/** MONOFORM 姿势预设 id → v2 `Action`；映射不到返回 null。 */
export function toDirectorAction(poseId: unknown): string | null {
  if (typeof poseId !== 'string') return null;
  const action = V2_POSE_ACTION[poseId.trim()];
  return action && V2_ACTIONS.has(action) ? action : null;
}

/** MONOFORM 道具类型 → v2 资产 id；v2 目录里没有的返回 null。 */
export function toDirectorPropAsset(type: unknown): string | null {
  if (typeof type !== 'string') return null;
  return V2_PROP_ASSET[type.trim() as DirectorScenePropType] ?? null;
}

/** MONOFORM 走位路点 → v2 `MotionPath`（`{smooth, points:[{time, position}]}`）。 */
function toDirectorPath(route: unknown, start: number, duration: number) {
  if (!Array.isArray(route)) return null;
  const points = route
    .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2)
    .map(([x, z]) => [finite(x, 0), finite(z, 0)] as [number, number]);
  if (points.length < 2) return null;
  const last = start + Math.max(duration, 0.1);
  return {
    smooth: true,
    // v2 的 path.points[].time 是**绝对秒数**（`model.ts:40`），不是 MONOFORM 的序号。
    points: points.map(([x, z], index) => ({
      time: start + ((last - start) * index) / (points.length - 1),
      position: [x, 0, z] as [number, number, number],
    })),
  };
}

/**
 * 一个角色 intent → 一条 `add`（新角色）或 `update`（带 `target` 的增量修改）。
 *
 * 关键差异：MONOFORM 是「整批替换」，没给 target 的角色会**替换**全部生成物；
 * v2 是纯增量，`add` 就是新增一条实体，`update` 只覆盖 patch 里显式写了的字段。
 * 于是 `target` 缺失时我们给每个角色一个**稳定的合成 id**（`dd-char1`），
 * 用户下一轮说「把甲往左挪」时 agent 只要带上 `target:"dd-char1"` 就能改到同一个。
 */
function characterOperations(
  character: DirectorSceneCharacterIntent,
  index: number,
  dropped: string[],
  occupied: ReadonlySet<string>,
): { operations: DirectorOperation[]; id: string; name: string; lines: DirectorSceneLine[] } {
  const target = character.target?.trim();
  if (target && !occupied.has(target)) {
    dropped.push(`characters[${index}].target=${target}（工程里没有这个对象）`);
  }
  const id = target || allocateId('char', index, occupied);
  const name = character.name?.trim() || `角色${index + 1}`; // i18n-exempt
  const pose = toDirectorPose(character.controls);
  const action = toDirectorAction(character.pose);
  if (character.pose && !action) {
    dropped.push(`characters[${index}].pose=${character.pose}（v2 无此姿势预设）`);
  }

  const patch: Record<string, unknown> = {};
  if (Object.keys(pose).length) patch.pose = pose;

  const route = Array.isArray(character.route) ? character.route : null;
  const path = toDirectorPath(route, finite(character.start, 0), finite(character.routeDuration, 5));
  if (path) patch.path = path;

  // `performance` 拍点 → v2 的 poseKeys（`{time, pose}`，`model.ts:64`）。
  // 上游会在相邻关键帧之间做线性插值（`timeline.ts:103` 的 `samplePose`），
  // 这正好是 MONOFORM 「骨骼与过渡由引擎平滑混合」的对应物。
  const beats = Array.isArray(character.performance) ? character.performance : [];
  const poseKeys = beats
    .map((beat, beatIndex) => ({
      time: Math.max(0, finite(beat?.t, 0)),
      pose: toDirectorPose(beat?.controls),
      beatIndex,
    }))
    .filter((key) => {
      if (Object.keys(key.pose).length) return true;
      dropped.push(`characters[${index}].performance[${key.beatIndex}].controls（无 v2 关节）`);
      return false;
    });
  if (poseKeys.length) {
    // `model.ts:274`：poseKeys 的 time 必须互不重复。
    const seen = new Set<number>();
    patch.poseKeys = poseKeys.filter((key) => {
      if (seen.has(key.time)) {
        dropped.push(`characters[${index}].performance t=${key.time}（重复，已丢弃）`);
        return false;
      }
      seen.add(key.time);
      return true;
    }).map(({ time, pose }) => ({ time, pose }));
  }

  const color = typeof character.color === 'string' && HEX.test(character.color)
    ? character.color
    : undefined;

  const operations: DirectorOperation[] = [];
  if (target) {
    const update: Record<string, unknown> = { ...patch };
    if (character.name?.trim()) update.name = character.name.trim();
    if (color) update.color = color;
    if (Array.isArray(character.at) && character.at.length === 2) {
      update.position = toDirectorPosition(character.at, 0);
    }
    if (typeof character.facing === 'number' && Number.isFinite(character.facing)) {
      update.rotation = [0, (character.facing * Math.PI) / 180, 0];
    }
    operations.push({ operation: 'update', id, patch: update });
    return { operations, id, name, lines: Array.isArray(character.lines) ? character.lines : [] };
  }

  operations.push({
    operation: 'add',
    asset: V2_ACTOR_ASSET,
    id,
    name,
    position: toDirectorPosition(character.at, 0),
    ...(color ? { patch: { ...patch, color } } : Object.keys(patch).length ? { patch } : {}),
  });

  // 预设动作 → v2 clip。`model.ts:290` 要求 clip 的 id 过 safeId、start < end、
  // speed > 0，且相邻 clip 不重叠。新建角色的 clip 跨度取整段时长。
  if (action && action !== 'idle') {
    operations.push({
      operation: 'update',
      id,
      patch: {
        clips: [{ id: `${id}-clip`, action, start: 0, end: Math.max(finite(character.routeDuration, 3), 0.5), speed: 1 }],
      },
    });
  } else if (typeof character.facing === 'number' && Number.isFinite(character.facing)) {
    // 新建角色的朝向与颜色走 add 的顶层字段 / patch，避免多一次 update。
    const add = operations[0];
    add.patch = { ...(add.patch ?? {}), rotation: [0, (character.facing * Math.PI) / 180, 0] };
  }

  return { operations, id, name, lines: Array.isArray(character.lines) ? character.lines : [] };
}

/** 一个道具 intent → 一条 `add` / `update`。v2 目录没有的类型被丢弃并记账。 */
function propOperations(
  prop: DirectorScenePropIntent,
  index: number,
  dropped: string[],
  occupied: ReadonlySet<string>,
) {
  const asset = toDirectorPropAsset(prop?.type);
  if (!asset) {
    dropped.push(`objects[${index}].type=${String(prop?.type)}（v2 资产目录无对应项）`);
    return [];
  }
  const target = prop.target?.trim();
  if (target && !occupied.has(target)) {
    dropped.push(`objects[${index}].target=${target}（工程里没有这个对象）`);
  }
  const id = target || allocateId('prop', index, occupied);
  const name = prop.name?.trim() || undefined;
  const patch: Record<string, unknown> = {};
  if (typeof prop.rotationY === 'number' && Number.isFinite(prop.rotationY)) {
    patch.rotation = [0, (prop.rotationY * Math.PI) / 180, 0];
  }
  if (Array.isArray(prop.scale) && prop.scale.length === 3) {
    // `model.ts:261`：scale 的每一项必须 > 0，否则 assertProject 报「对象坐标错误」。
    const scale = prop.scale.map((v) => Math.max(0.02, finite(v, 1))) as [number, number, number];
    patch.scale = scale;
  }
  if (typeof prop.color === 'string' && HEX.test(prop.color)) patch.color = prop.color;

  if (target) {
    const update: Record<string, unknown> = { ...patch };
    if (name) update.name = name;
    if (Array.isArray(prop.at) && prop.at.length === 2) {
      update.position = [finite(prop.at[0], 0), finite(prop.y, 0.5), finite(prop.at[1], 0)];
    }
    return [{ operation: 'update', id, patch: update }];
  }

  return [{
    operation: 'add',
    asset,
    id,
    ...(name ? { name } : {}),
    position: toDirectorPosition(prop.at, finite(prop.y, 0.5)),
    ...(Object.keys(patch).length ? { patch } : {}),
  }];
}

/**
 * 运镜 intent → 上游运镜操作。
 *
 * 上游 `camera-motion` 的形状是 `{operation, id: cameraId, asset: preset, time, duration, patch}`，
 * `id` **必填**且必须是真实摄影机实体 id（`motion-presets.ts:22` 的
 * `project.entities.find(e => e.id === id)` + `运镜目标必须是摄影机`）。
 * 没有摄影机时返回空数组 —— 宿主负责先补一台（或报「导演台里还没有摄影机」）。
 */
function cameraOperation(
  camera: DirectorSceneCameraIntent | undefined,
  cameraId: string | undefined,
): DirectorOperation[] {
  if (!camera?.move || !cameraId) return [];
  const mapped = V2_CAMERA_PRESET[camera.move];
  if (!mapped) return [];
  return [{
    operation: 'camera-motion',
    id: cameraId,
    asset: mapped.preset,
    time: Math.max(0, finite(camera.start, 0)),
    // `motion-presets.ts:23`：duration 必须有限且 > 0。
    duration: Math.max(finite(camera.duration, 6), 0.1),
    // `motion-presets.ts:25`：只接受 amplitude / angle / side / easing 四个键。
    patch: { side: mapped.side },
  }];
}

/**
 * dd-scene intent → v2 `director_apply` 的操作数组。
 *
 * ## 与 MONOFORM 语义的差异（这是迁移的全部要点）
 *
 * - **不是整体覆盖**。`characters` / `objects` 逐个翻成 `add`（或 `update`），
 *   没提到的对象原样保留 —— 用户在 v2 里手摆的东西不会被一次重摆抹掉。
 * - **没有 `reset`**。`intent.reset` 表达的是「把 MONOFORM 工程清成空画布」，
 *   在 v2 里没有对应物（v2 有撤销栈，`director_history{action:'undo'}` 才是正解），
 *   所以这里返回空操作并在 `dropped` 里记账。
 * - **`mode` / `duration` / `poseBase` / `continuousMotion` 不翻译**。它们描述的是
 *   MONOFORM 引擎自己的状态机，v2 没有对应字段。
 * - **`lines` 走 `notes`**，不是「对象上的一个字段」——见 {@link DirectorTranslation}。
 *
 * ## 台词（语音气泡）
 *
 * MONOFORM 把台词挂在角色的 `lines` 上，由白模台自己在视口里画气泡。
 * v2 的对应载体是 `production.notes`：每个拍点带 `{id,start,end,actorId,story,emotion,dialogue,action}`，
 * `director_read(sections:['production'])` 会原样返回它（`read-scene.ts:51`），
 * 时间轴也已经把 notes 画成轨道（`ui/timeline.ts:23`）。
 * 所以台词翻译成 `notes` 拍点，**渲染**由导演台侧的叠加层按 actorId 找实体位置来画
 * （见 [[DIRECTOR_DESK_SPEECH_BUBBLES]]）。
 *
 * ## 参数形状由真实上游验证
 *
 * `tests/test_director_desk_dd_scene.py` 把本函数的输出喂进上游自己的
 * `validateToolInput` 与 `applyOperations + assertProject` 跑一遍 —— 参数名不是猜的。
 *
 * @param intent agent 产出的 dd-scene 块。
 * @param existingProduction v2 当前工程里的 production 原值。**有台词时必填**：
 *   `notes` 是「完整替换」语义（`productionValueGuide`：use full production value, not patch），
 *   不带回来就会把用户已有的两份提示词文稿与备注清空。
 * @param cameraId 落点摄影机实体 id。缺省时不产生运镜操作。
 * @param occupiedIds 工程里已占用的实体 id。**必填**：合成 id 会避开它们，
 *   否则 agent 连着两轮「摆角色」会让第二轮拿到已存在的 `dd-char1`，整批被上游回滚。
 */
export function toDirectorOperations(
  intent: DirectorSceneIntent,
  existingProduction?: Partial<DirectorProductionValue>,
  cameraId?: string,
  occupiedIds: Iterable<string> = [],
): DirectorTranslation {
  const dropped: string[] = [];
  const operations: DirectorOperation[] = [];
  const characters: DirectorTranslatedCharacter[] = [];
  const speech: DirectorSpeechLine[] = [];
  const occupied = new Set(occupiedIds);

  if (intent.reset) {
    // v2 没有「清空画布」这个操作：它有完整的撤销栈（director_history），
    // 强行用 remove 模拟会连带删掉摄影机与用户的灯光设置。
    dropped.push('reset（v2 无清空操作，请用 director_history undo）');
    return { operations, characters, speech, production: normalizeProduction(existingProduction), dropped };
  }

  const characters_ = Array.isArray(intent.characters) ? intent.characters.slice(0, 12) : [];
  characters_.forEach((character, index) => {
    const translated = characterOperations(character, index, dropped, occupied);
    // 本批内也要占位：同一批里两个角色都落到 dd-char1 同样会撞。
    occupied.add(translated.id);
    operations.push(...translated.operations);
    characters.push({
      id: translated.id,
      name: translated.name,
      // 此刻还没有 actorId —— 它就是自己。真正的台词行在下面按拍点生成。
      lines: translated.lines.map((line) => ({ ...line, actorId: translated.id })),
    });
  });

  const objects = Array.isArray(intent.objects) ? intent.objects : [];
  objects.forEach((prop, index) => {
    const produced = propOperations(prop, index, dropped, occupied);
    const target = prop.target?.trim();
    occupied.add(target || allocateId('prop', index, occupied));
    operations.push(...produced);
  });

  // `shots` 是 MONOFORM 的「可切换多机位」。v2 里多机位是多个 camera 实体 +
  // cuts 时间轴，语义不同（v2 不能在一条时间线上自动切镜）。这里取第一条，
  // 其余记账丢弃 —— 宁可少给一个机位，也不要静默造出用户没要求的切镜。
  const shots = Array.isArray(intent.shots) ? intent.shots : [];
  const camera = intent.camera ?? shots[0]?.camera;
  if (shots.length > 1) {
    dropped.push(`shots[1..${shots.length - 1}]（v2 多机位需 cuts 时间轴，dd-scene 不再整批替换）`);
  }
  const projectPatch: Record<string, unknown> = {};
  if (typeof intent.duration === 'number' && Number.isFinite(intent.duration) && intent.duration > 0) {
    projectPatch.duration = Math.min(intent.duration, 60);
  }
  operations.push(...cameraOperation(camera, cameraId));
  if (Object.keys(projectPatch).length) operations.push({ operation: 'project', patch: projectPatch });

  const production = normalizeProduction(existingProduction);
  const notes = production.notes.slice();
  for (const character of characters) {
    character.lines.forEach((line, lineIndex) => {
      const text = typeof line?.text === 'string' ? line.text.trim() : '';
      const start = finite(line?.start, 0);
      const end = finite(line?.end, start + 1);
      if (!text || end <= start) {
        dropped.push(`characters[${character.id}].lines[${lineIndex}]（台词为空或时长非正）`);
        return;
      }
      // `validation.ts:21`：id 要过 `/^[\p{L}\p{N}_:.-]{1,200}$/u` 且批内唯一；
      // `validation.ts:22`：0 <= start < end。
      const id = `${character.id}-line${lineIndex + 1}`;
      notes.push({
        id,
        start,
        end,
        // `model.ts:365`：actorId 必须是已有 actor id 或空串。
        actorId: character.id,
        story: '',
        emotion: '',
        dialogue: text,
        action: '',
      });
      speech.push({ actorId: character.id, text, start, end });
    });
  }
  if (speech.length) {
    // notes 是完整替换：带上全部既有拍点与**两份提示词文稿**，否则会被清空。
    operations.push({ operation: 'notes', value: { ...production, notes } });
  }

  return { operations, characters, speech, production: { ...production, notes }, dropped };
}

/** 补齐 `notes` 完整替换值缺的字段。缺 `fixedPrompt` / `sceneReferenceIds` 会被上游拒绝。 */
export function normalizeProduction(
  value: Partial<DirectorProductionValue> | undefined,
): DirectorProductionValue {
  return {
    fixedPrompt: typeof value?.fixedPrompt === 'string' ? value.fixedPrompt : '',
    sceneReferenceIds: Array.isArray(value?.sceneReferenceIds)
      ? value.sceneReferenceIds.filter((id): id is string => typeof id === 'string')
      : [],
    notes: Array.isArray(value?.notes) ? value.notes.filter(Boolean) : [],
    ...(typeof value?.promptText === 'string' ? { promptText: value.promptText } : {}),
    ...(typeof value?.textOnlyPrompt === 'string' ? { textOnlyPrompt: value.textOnlyPrompt } : {}),
    ...(value?.promptMode === 'text-only' || value?.promptMode === 'reference-video'
      ? { promptMode: value.promptMode }
      : {}),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 提示词工程产出层（上游 `src/production/prompts.ts` 的 DramaClaw 侧表面）
// ═══════════════════════════════════════════════════════════════════════════
//
// 上游的事实来源（`vendor/director-desk/src/production/prompts.ts:6-9`）：
//
//   promptModes      = ['reference-video', 'text-only']
//   promptField      = mode => mode === 'text-only' ? 'textOnlyPrompt' : 'promptText'
//   selectedPromptMode = data => data?.promptMode ?? 'reference-video'
//
// 两份文稿**各自独立**：切换模式只改 `promptMode`，不搬运、不转换任何一份
// （`production-panel.ts:139` 只写 `production.promptMode = mode`，随后 `fillPrompt()`
// 重新读**当前模式对应的那一份**）。这一点 DramaClaw 侧必须原样保持 —— 主人写了一半的
// 参考视频稿切到纯文本再切回来，内容必须还在。
//
// 读写通道与 v2 的其它能力同一条：`director_read(sections:['production'])` 读，
// `director_apply{operation:'notes', value:<完整 production>}` 写
// （`validation.ts:3`：use full production value, not patch）。

/** 提示词模式。与上游 `PromptMode`（`model.ts:135`）逐字一致。 */
export type DirectorPromptMode = 'reference-video' | 'text-only';

/** 模式顺序与上游一致：先「参考视频」，后「纯文本」。 */
export const DIRECTOR_PROMPT_MODES: readonly DirectorPromptMode[] = [
  'reference-video',
  'text-only',
];

/** 模式 → production 里的字段名。对应上游 `promptField`。 */
export function directorPromptField(mode: DirectorPromptMode): 'promptText' | 'textOnlyPrompt' {
  return mode === 'text-only' ? 'textOnlyPrompt' : 'promptText';
}

/** 缺省模式。对应上游 `selectedPromptMode`：不写就是参考视频。 */
export function directorPromptMode(production: Partial<DirectorProductionValue> | undefined): DirectorPromptMode {
  return production?.promptMode === 'text-only' ? 'text-only' : 'reference-video';
}

/** 两份文稿 + 当前模式的快照。给宿主 UI 与 agent 上下文读用。 */
export interface DirectorPromptDrafts {
  mode: DirectorPromptMode;
  /** 参考视频模式的完整提示词（`production.promptText`）。 */
  referenceVideo: string;
  /** 纯文本模式的完整提示词（`production.textOnlyPrompt`）。 */
  textOnly: string;
  /** 固定提示词头（`production.fixedPrompt`）。 */
  fixedPrompt: string;
}

/** 读出当前的两份文稿与模式。两份**同时**返回，调用方自己决定显示哪一份。 */
export function readDirectorPromptDrafts(
  production: Partial<DirectorProductionValue> | undefined,
): DirectorPromptDrafts {
  return {
    mode: directorPromptMode(production),
    referenceVideo: typeof production?.promptText === 'string' ? production.promptText : '',
    textOnly: typeof production?.textOnlyPrompt === 'string' ? production.textOnlyPrompt : '',
    fixedPrompt: typeof production?.fixedPrompt === 'string' ? production.fixedPrompt : '',
  };
}

/** 写回时只允许改这三样，键名与上游字段一致。 */
export interface DirectorPromptPatch {
  mode?: DirectorPromptMode;
  referenceVideo?: string;
  textOnly?: string;
  fixedPrompt?: string;
}

/**
 * 合并一次提示词改动，返回新的 production。
 *
 * ## 硬约束：切换模式**绝不**改写任何一份文稿
 *
 * 这是上游的行为契约（`productionValueGuide`：Switching mode never
 * converts/copies either draft），DramaClaw 侧必须逐字保持。实现上就是：
 * `mode` 与两份文稿是**三个互不相干的键**，合并时各写各的，谁也不碰谁。
 *
 * ## 为什么返回完整 production 而不是 patch
 *
 * `notes` 是「完整替换」语义。少带一个键就是**清空**那一份文稿（`validation.ts:3`
 * 明确写了 Keep existing fixedPrompt, promptText, textOnlyPrompt, promptMode when
 * not changing them）。所以宿主拿到的是「合并后的完整值」，直接整份提交。
 */
export function writeDirectorPromptDraft(
  production: Partial<DirectorProductionValue> | undefined,
  patch: DirectorPromptPatch,
): DirectorProductionValue {
  const base = normalizeProduction(production);
  const next: DirectorProductionValue = { ...base };
  if (patch.mode) next.promptMode = patch.mode;
  if (typeof patch.fixedPrompt === 'string') next.fixedPrompt = patch.fixedPrompt;
  if (typeof patch.referenceVideo === 'string') next.promptText = patch.referenceVideo;
  if (typeof patch.textOnly === 'string') next.textOnlyPrompt = patch.textOnly;
  return next;
}

/**
 * `director_read(sections:['production'])` 的回包 → 两份文稿。
 *
 * 回包是 `{revision, result:{production:{…}}}`（桥把 `toolService.call` 的
 * `{ok,data}` 翻成 `{revision, result}`，见 `host-bridge.ts`）。形不对就返回 null ——
 * 读不到两份文稿时如实说读不到，不要拿空串冒充「用户没写过」。
 */
export function parseDirectorPromptReadback(payload: unknown): DirectorPromptDrafts | null {
  if (!payload || typeof payload !== 'object') return null;
  const envelope = payload as { result?: unknown };
  const result = (envelope.result ?? {}) as { production?: unknown };
  if (!result.production || typeof result.production !== 'object') return null;
  return readDirectorPromptDrafts(result.production as Partial<DirectorProductionValue>);
}
