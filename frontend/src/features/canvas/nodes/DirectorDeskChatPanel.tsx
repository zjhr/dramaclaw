// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Check, ChevronDown, Loader2, RotateCcw, Send, Sparkles, Square, X, Zap, ZapOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import {
  MessageBubble,
  MessageDetailPanel,
  SpecMediaDetailModal,
  type SpecMediaDetail,
} from '@/features/superchat/superchat-panel';
import { useSuperChat } from '@/features/superchat/use-superchat';
import type { ChatMessage, ChatScope } from '@/features/superchat/types';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth-store';
import {
  parseDirectorSceneIntent,
  stripDirectorSceneIntent,
  parseDirectorProposals,
  stripDirectorProposals,
  hasDirectorSceneBlock,
  DIRECTOR_SCENE_INTENT_TYPE,
  type DirectorSceneIntent,
  type DirectorProposal,
} from './directorScenePatch';
import {
  buildDirectorDeskSkillPrompt,
  deskSkillsForEngine,
  getDirectorDeskSkill,
  MONOFORM_SCENE_CATALOG,
  type DirectorDeskEngine,
} from './directorDeskSkills';
import { DirectorSceneCard } from './DirectorSceneCard';

/**
 * 空态示例指令：出厂默认工程是空画布，面对一片空白用户不知道能说什么。
 * 点一下填进输入框（**不直接发**）—— 用户还能改两个字再说。
 */
const EXAMPLE_PROMPTS = ['example1', 'example2', 'example3'] as const;

/** 菜单里的技能分组顺序：先「会改画面」的，再「只动嘴」的。 */
const SKILL_GROUP_ORDER = ['operate', 'advise'] as const;

/**
 * 「允许改动画面」开关的持久化键 —— 默认**开**（agent 说完直接摆好，这是主要用法）。
 * 关掉时它只出分镜卡，等用户手点「应用」。
 */
const AUTO_APPLY_KEY = 'dramaclaw.monoformDesk.autoApply';

/**
 * 技能选择的持久化键：**按节点 + 引擎**分开存。
 * 按节点是因为每个导演台是独立的一场戏，A 节点选「运镜导演」不代表 B 节点也要；
 * 按引擎是因为两个引擎的技能池不同，director 侧的 id 在 monoform 里可能不存在。
 */
function storedSkillKey(nodeId: string, engine: DirectorDeskEngine): string {
  return `dramaclaw.monoformDesk.skill.${engine}.${nodeId}`;
}

function readStoredSkill(nodeId: string, engine: DirectorDeskEngine): string | null {
  try {
    const stored = window.localStorage.getItem(storedSkillKey(nodeId, engine));
    // 存着的 id 可能已经不在技能池里（池子会变）—— 认不出来的当没选过，
    // 否则 getDirectorDeskSkill 返回 undefined，界面会显示成「通用」但状态不是 null。
    return stored && getDirectorDeskSkill(stored, engine) ? stored : null;
  } catch {
    return null;
  }
}

/**
 * 读开关状态。**只有显式存过 `"false"` 才返回 false** —— 没存过、存了垃圾、或
 * localStorage 不可用（隐私模式/沙箱）都退回 `true`：默认行为不能因为读不到偏好就变。
 */
export function readStoredAutoApply(): boolean {
  try {
    return window.localStorage.getItem(AUTO_APPLY_KEY) !== 'false';
  } catch {
    return true;
  }
}

function persistAutoApply(value: boolean): void {
  try {
    window.localStorage.setItem(AUTO_APPLY_KEY, String(value));
  } catch {
    // 存不下就算了，本次会话仍然生效。
  }
}

type DirectorDeskChatPanelProps = {
  /** 本节点自己的作用域：`{ kind: "directorDesk", id: "<project>/<node>" }`。 */
  scope?: ChatScope;
  /**
   * 这个导演台节点上游接进来的素材（给 agent 看的原始事实，不是给用户看的文案）。
   * 产品边界是「agent 可以引用外部节点信息，修改生成只作用于当前节点」——
   * 上游信息由宿主（节点）提供，因为只有它拿得到画布连线。
   */
  upstreamSummary?: string;
  /**
   * 白模台**实时**场景摘要（宿主读工程后生成）。agent 靠它把「再近一点」「把他挪到
   * 左边」这类指代落到具体对象上，而不是每次都重摆全场。
   */
  sceneSummary?: string;
  onRequestClose?: () => void;
  /**
   * agent 在回复里产出 ```dd-scene``` 块时的回调（摆场景 / 生成运镜）。
   * 由宿主节点接住 —— 只有它能写导演台的 localStorage 工程并 reload iframe。
   */
  onSceneIntent?: (intent: DirectorSceneIntent) => void;
  /**
   * 撤销上一次应用（回到那次 apply 之前的工程）。快照由宿主节点在 apply 前存下 ——
   * 只有它拿得到 iframe 里的工程。没有这个回调就不显示撤销按钮。
   */
  onUndoScene?: () => void;
  /**
   * 引擎：决定 agent 拿到什么口径的上下文、菜单里有哪些技能、以及「生成背景」在不在。
   * 默认 `director`（360 导演台）；MONOFORM 白模台传 `monoform`。
   */
  engine?: DirectorDeskEngine;
};

/**
 * 拼给 agent 的上下文。**只走 `transportText`，不进用户可见的对话内容。**
 *
 * 这一段同时解决三件事：
 * 1. agent 知道自己在一个导演台节点的对话里（scope 对 agent 是 project）；
 * 2. agent 拿得到这个节点的上游素材（「可以引用外部节点信息」）；
 * 3. agent 知道唯一能做的动作是那条**按节点隔离**的路由，以及怎么调
 *    （「修改生成只作用于当前节点」—— 它没有别的写入口）。
 */
export function buildDirectorDeskAgentContext(
  args: {
    project: string;
    nodeId: string;
    upstreamSummary?: string;
    /** 白模台当前场景的紧凑摘要（宿主读工程后生成，见 summarizeMonoformProject）。 */
    sceneSummary?: string;
  },
  engine: DirectorDeskEngine = 'director',
): string {
  // i18n-exempt-start — 这是拼给**模型**的提示词，不是 UI 文案。
  // 它必须语言稳定（不能跟着界面语言变），翻译它反而会让 agent 的行为不一致。
  const upstream = args.upstreamSummary?.trim() || '（没有接上游素材）';
  const scene = args.sceneSummary?.trim();
  return [
    '[导演台上下文]',
    `- 这里是一个 3D 导演台节点的对话，当前节点 id：${args.nodeId}`,
    `- 所在项目：${args.project}`,
    `- 这个节点上游接进来的素材：${upstream}`,
    ...(scene ? ['- 这个节点白模台的实时内容（改场景前先看它）：', scene] : []),
    ...(engine === 'monoform' ? MONOFORM_NO_BACKGROUND : panoramaRouteLines(args)),
    ...(engine === 'monoform' ? MONOFORM_SCENE_LINES : DIRECTOR_SCENE_LINES),
    '- 用户问项目情况时**去查、不要凭印象答**。手里有这些只读工具：',
    '-   dramaclaw_pipeline_status —— 这个项目跑到哪一步了、卡在哪',
    '-   dramaclaw_list_tasks —— 有哪些任务、各自什么状态；dramaclaw_get_task 看单条细节',
    '-   dramaclaw_get_episode_script / dramaclaw_get_episode_media —— 某一集的剧本与产物',
    `- 你的写权限**只有**${engine === 'monoform' ? '上面那条摆场景/设机位（输出 dd-scene 块）' : '上面那一条换背景的路由'}。用户要你改剧本、分集、角色、视频这些`,
    '-   项目级的东西时，直接说明这里改不了，请他去「项目助手」说 —— 不要假装做了。',
    '[/导演台上下文]',
  ].join('\n');
  // i18n-exempt-end
}

// i18n-exempt-start — 下面几段都是拼给**模型**的提示词（非 UI 文案），语言必须稳定。
/** 换背景路由：只有 360 导演台有（MONOFORM 无背景系统，见 MONOFORM_NO_BACKGROUND）。 */
function panoramaRouteLines(args: { project: string; nodeId: string }): string[] {
  return [
    '- 用户让你「生成/换背景」时，调用 dramaclaw_post 一次，参数这样填：',
    `  path 填：/projects/${args.project}/freezone/director-desk-panorama`,
    '  body 填一个 JSON 对象，必须同时包含下面两个字段，不能传空对象 {}：',
    '    description：字符串。把用户说的场景整理成一段完整的场景描述写在这里。',
    `    node_id：字符串。固定填 "${args.nodeId}"。`,
    '- 这条路由生成的是 2:1 等距圆柱全景图，产物只落在当前节点，不会影响项目其他部分。',
    '- 生成是异步任务，完成后会自动应用为这个节点的背景，你不需要再做别的。请告诉用户已开始生成。',
    '',
  ];
}

/**
 * MONOFORM 的硬边界：它没有背景系统。这条禁令必须显式写死 —— 否则 agent 会照旧
 * 承诺「已开始生成背景」，而白模台里永远不会出现（宿主也没接那条管线）。
 */
const MONOFORM_NO_BACKGROUND = [
  '- ⚠️ 这个节点现在跑的是 MONOFORM 白模台：**没有背景系统，不能生成/更换背景**。',
  '  用户让你换背景、生成场景图、换环境时，直接说不支持（这里做不到），不要调任何生成路由、不要假装做了。',
];

/** 360 导演台（UE 人偶 + 运镜动画）的 dd-scene 词汇。 */
const DIRECTOR_SCENE_LINES = [
  '- 用户让你「摆场景 / 布置角色 / 设置运镜 / 生成动画」时，**不要调工具**，',
  '  而是在你的回复里输出一个 ```dd-scene 代码块（fenced），里面是一个 JSON：',
  '    {"type":"director-desk-scene","characters":[...],"camera":{...}}',
  '  characters 是数组，每个角色：{"pose":"...","at":[x,z],"facing":角度度数,"color":"#RRGGBB","name":"名字"}',
  '    pose 可选内置姿势：stand/sit/walk/run/idle/wave/point/crouch/jump/t-pose。',
  '    at 是地面坐标（米，x 左右、z 前后，镜头在 +z 方向）。facing（度）：0=面向镜头、90=朝画面右、-90=朝画面左、180=背对镜头；两人面对面让 facing 差 180°。都可省略。',
  '    要更精细的自定义造型（张开双臂、仰头、指向…按逐骨骼角度现算）时，让用户选「角色调度走位」技能，那里有骨骼词汇。',
  '  camera 是运镜：{"move":"orbit-left|orbit-right|dolly-in|dolly-out|pan-left|pan-right|static","duration":秒数}',
  '  只摆场景就只给 characters，只运镜就只给 camera，两个都要就都给。宿主会把它应用到当前节点并刷新导演台。',
  '  这套只摆内置人偶（mannequin）和相机轨迹，**不涉及真实模型/道具库**；做不到的（具体服装、表情、道具外观）就直说。',
  '- 输出 dd-scene 块后用一句自然语言告诉用户你摆了什么，块本身用户看不到。',
];

/**
 * MONOFORM 的 dd-scene 词汇。三块：characters（人）+ objects（物品/粗模）+ camera（运镜），
 * 每块都能带 start（秒）用来编排「先……接着……」。
 *
 * 两个必须写死的约束：
 * - 姿势 id 用 RIG_PRESETS 的**真实 id**（vendor/monoform/src/rig.js），写别的会被
 *   normalizePoseId 静默回落成 idle，用户会以为是 agent 摆错了。
 * - 物品 type 用 addPrimitive 的类型域，未知值翻译层直接丢弃。
 */
const MONOFORM_SCENE_LINES = [
  '- 用户让你「摆场景 / 布置角色 / 放道具 / 让人物动起来 / 设运镜」时，**不要调工具**，',
  '  而是在你的回复里输出一个 ```dd-scene 代码块（fenced），里面是一个 JSON：',
  '    {"type":"director-desk-scene","mode":"compose|edit","duration":整段秒数,"characters":[...],"objects":[...],"camera":{...}}',
  '  用户说的是大白话，例如「一段唯美的爱情场景」「两个人吵架」。他们不会写机位，你来当摄影指导。',
  '  两人及以上由你判断单镜头还是多镜头；**不要等用户说「多机位」**，需要不同观看方向时自己输出 shots，不要把机位术语丢给用户，也不要固定套三镜。',
  '  用户明确说「只要一个镜头」或你判断单镜头更适合时，只写 camera；写 shots 才会建立可切换的多机位。',
  '  mode:"compose" 用于一段新演出或重新编排；即使用 target 复用演员，也要清除上一场的骨骼偏移，首拍 t:0 明确 pose。',
  '  compose 保留 target 对象身份和布局，不等于 reset。mode:"edit" 用于局部微调，保留当前姿态和未提及的内容。',
  '  duration 是整段共同秒数；compose 省略时取动作结束后 0.5 秒。需要余韵时显式给 duration，所有动作与镜头均应在这段内完成。',
  '',
  '① characters 数组 —— 角色：',
  '    {"pose":"...","poseBase":"neutral|current","at":[x,z],"facing":角度,"performance":[{"t":秒,"action":"伸手或舞步","actions":["向右迈","挥臂"],"side":"left|right|both","intensity":0.8,"interpolation":"smooth|linear|hold","pose":"...","controls":{...}}],"lines":[{"text":"台词","start":秒,"end":秒}],"route":[[x,z],...],"routeDuration":秒,"start":秒,"color":"#RRGGBB","name":"名字"}',
  '  - pose 必须用白模台真实预设 id（写别的会静默回落成 idle）：idle(自然站)/stand_relaxed(放松站)/walk(行走)/run(奔跑)/crouch(半蹲)/squat_full(全蹲)/sit(坐，需椅子)/wave(招手)/tpose(T型)/sad_pose(低头含胸)/agree(点头)/headShake(摇头)。',
  '  - poseBase 覆盖单个演员的骨骼基础：neutral 从无附加骨骼偏移的基础姿势开始，current 沿用当前姿态。compose 默认 neutral，edit 默认 current。新演出仅在用户明确要求保留手工姿态时写 current。',
  '  - at 是站位（米，x 左右、z 前后，镜头在 +z 方向）；facing（度）：0=面向镜头、90=朝画面右、-90=朝画面左、180=背对镜头；两人面对面让 facing 差 180°。',
  '  - **让人物走动**就给 route（≥2 个路点）：他会沿路走过去、自动朝行进方向、自动播走路动作；routeDuration 是走完的秒数（默认 5），要跑步把 pose 写成 "run"。',
  '    例·从左侧走到中间停下：{"at":[-2.5,1],"route":[[-2.5,1],[0,0]],"routeDuration":4}',
  '  - **让人物演出连续动作**就给 performance（至少 2 拍）：{"performance":[{"t":0,"pose":"idle"},{"t":2,"pose":"agree"},{"t":4,"pose":"idle"}]}。',
  '    t 是时间轴秒数；每拍可改 pose、controls、at、facing，或用 actions:["脚步","上肢"] 叠加最多两个互补动作；重拍用 interpolation:"linear"，停顿用 interpolation:"hold"。拥抱、抬头、伸手、转身等没有位移的动作也必须这样写，不能只写在说明文字里。',
  '    首拍由 mode/poseBase 决定骨骼基础；之后未写的站位、朝向、姿势与骨骼角度继承上一拍，回到原姿态须显式写回角度。骨骼与跨 pose/播放状态的过渡由引擎平滑混合。',
  '    点头 agree、摇头 headShake、招手 wave 和 walk/run 会随时间轴播放；定格时该拍写 continuousMotion:false。',
  '    每拍要对应可见的行动、回应或停顿，不以关键帧数量证明演出成立。白模没有手与手/物体的自动接触求解。',
  ...MONOFORM_SCENE_CATALOG,
  '    side 控制左右，intensity 控制幅度。',
  '    例如“抬眼—伸右手—对方迟半拍回应—轻触—同时收手”。每个手势写成准备、峰值、跟随三拍，不能让两人机械同步摆动。',
  '    动作骨骼合同由你内部完成（用户不需要写术语），用户只说「伸手」「递给他」「回应」即可，不要求用户写关节术语：stand_relaxed/idle 基础上前抬/伸手用 Arm.pitch 负值（建议约 -35~-60°），',
  '    前臂需要够向前时配合 ForeArm.pitch，弯肘/收拢用 Elbow.bend 正值（约 20~45°），左右镜像由引擎处理。',
  '    实际映射是 leftArm/leftForeArm.pitch→局部 Y 正向、rightArm/rightForeArm.pitch→局部 Y 反向；leftElbow.bend→局部 Y 反向、rightElbow.bend→局部 Y 正向；',
  '    Arm/ForeArm 的 twist/yaw 是沿骨长轴拧转，不是抬臂。Shoulder 是锁骨，只能小幅微调；未经 stand_relaxed 校准的 spread/roll 不用于伸手。头部 pitch 等原有约定不变。',
  '    不能只写 idle 加几个很小角度就宣称完整动作；实际伸手/回应要在准备、行动、回应/停顿、收束拍里出现可读的 Arm/ForeArm/Elbow 变化。',
  '    用户只说「一段高级舞蹈」或「有电影感的舞蹈演出」时，由你自行设计完整段落，不要求用户选择舞种或输入专业词。',
  '    节拍按准备 → 重心转移 → 主动作 → 回应 → 停顿 → 收势组织（相邻阶段可合并）；每拍代表有意义的动作变化，不是逐帧采样。功夫对打不套这套重心节拍。',
  '    至少同时使用两类身体层次：脚步/at/facing、髋与躯干、手臂、头部中任选两类以上；安排左右不对称、迟半拍回应、幅度或时长差异，避免全身机械同步。',
  '    用户要高级舞蹈或只说「唯美演出」时，默认给每位主要演员 10~16 个有意义的 performance 节拍（简单动作可少一些），覆盖准备、重心、主动作、回应、停顿和收势；首拍先建立姿态，末拍明确回收，不能把同一组 controls 原样复制到整段。功夫对打不套这套节拍：一场 6 个回合，身体中心约 1.1 米，先蓄势再出招，动作连续采样，不要用 hold 定住，收势只在最后一拍。',
  '    一拍可用 actions:["脚步","上肢"] 叠加最多两个互补动作（例如 ["向右迈","挥臂"]），也可以把两个动作拆成相邻节拍；叠加服务同一个重心变化，不要把所有部位同时打满。',
  '    舞蹈动作要有层次差：脚步先落地、髋/躯干随后传递、手臂到峰值、头部或视线最后回应。对白和舞蹈的回应可错开 0.2~0.6 秒。功夫的格挡或闪避要和出招落在同一秒。',
  '    动作优先用高层 action 表达，脚步和重心用 at/facing 或 route 完成，controls 只做校准。间隔大约 0.8 秒以上时，执行层会自动补一拍身体先动、四肢后到的准备；跟随和停顿仍要写出来。对白和爱情用看、停、伸、靠、收，不要用左右来回的重心摆动当收尾。',
  '    白模没有脚底 IK、手指与表情，也没有手与手/物体的接触求解；不把「踩稳」「牵到手」「碰到道具」写成系统已经自动完成。',
  '  - 同一角色用 performance 做演出，其中可用 at/facing 完成短步与转身；连续走位用 route，不要同时给 route 和 performance。performance 会变成角色关键帧，route 会变成走路关键帧。',
  '  - 有对白时给说话的角色写 lines:[{"text":"台词","start":秒,"end":秒}]。start/end 用同一时间轴，一人说完再接下一人，两句不要重叠。没有对白就不要写 lines。气泡挂在头顶，交接时自动淡入淡出，不要另写透明度关键帧，也没有口型。',
  '',
  '② objects 数组 —— 物品 / 场景粗模（可选）：',
  '    {"type":"table","at":[x,z],"rotationY":角度,"y":高度,"scale":[x,y,z],"name":"名字"}',
  '  - type 只认这些（写别的会被丢弃）：box(方块)/sphere(球体)/cylinder(圆柱)/plane(平面)/arch(拱门)/stairs(楼梯)/door(门)/window(窗)/table(桌子)/chair(椅子)/sofa(沙发)/roof(屋顶)/tree(树木)/vehicle(车辆)。',
  '  - 通常只给 type 和 at 就够：不给 scale 用该类型默认尺寸，不给 y 用默认抬升（树 1.3 / 平面 0.02 / 其余 0.5）。物品是**静态摆放**。',
  '',
  '③ camera 或 shots —— **摆了人就必须给其中一种**：',
  '    {"move":"...","size":"close|medium|wide|full","height":"eye|low|high","subject":"角色名或id","focus":"角色名或id","axisSide":"positive|negative","duration":秒,"start":秒,"beats":[{"t":秒,"progress":0~1,"focus":"角色名或id","targetHeight":数值,"distance":米,"azimuth":角度,"elevation":米,"focalLength":毫米,"interpolation":"smooth|linear|hold"}]}',
  '  - size 是景别：close 近景 / medium 中景（默认）/ wide 全景 / full 远景。翻译层会换成距离和焦距，不要自己写相机坐标。',
  '  - height 是机位高度：eye 平视（默认，地平线水平）/ low 仰拍 / high 俯拍。不写就是平视。不要用俯拍凑「有电影感」。',
  '  - move 只认：static(固定)、dolly-in/dolly-out(推拉)、orbit-left/orbit-right(环绕)、pan-left/pan-right(摇)、',
  '    crane-up/crane-down(升降)、rail-left/rail-right(横移)、zoom-in/zoom-out(变焦)、handheld(手持)、pov(主观)、over-shoulder(越肩)。',
  '  - 镜头对着角色的眼睛，并且会跟着走动的角色。地平线由引擎锁平，不要写 rotation / roll。',
  '  - focus 指定镜头要拍的角色 name/id，省略时由现有取景规则决定。它是取景目标，不是景深或移焦。先确定要拍谁的哪个动作，再选择 size 和 move。',
  '  - 先定轴线再选机位：两人面对面时 facing 必须差 180°，机位留在他们连线的同一侧。camera.axisSide 为 positive 或 negative，同一组镜头必须一致；省略时自动选接近主镜头的一侧。',
  '  - 越肩和主观用 subject 指定是谁的肩/眼睛，填角色 name/id。越肩的 focus 是被拍人物，subject 是前景人物；反打交换两者并保持 axisSide 一致。越肩在 duration 内从稍远处推到肩后。',
  '  - 同一条运镜需要停顿、再启动或切换关注对象时，用 camera.beats：t 是整段绝对秒数，progress 是路径 0~1，focus 是取景对象，targetHeight 是目标高度；distance/azimuth/elevation/focalLength 可控制距离、环绕角、机位高度与焦距，interpolation 只用 smooth/linear/hold。',
  '    运动镜头默认安排 4~8 个关键节拍：建立→跟随脚步/重心→动作峰值前减速或 hold→回应时切焦/继续运动→收束；每拍都要改变观看信息，不能只把同一 progress 等分复制。静止镜头不需要硬塞 beats。',
  '    每拍都要说明观看目的：建立、跟随、揭示、收紧、反应、停顿或收束；速度、停顿和焦点切换要服务舞蹈的重心、动作峰值与回应。',
  '    JSON 暂无 purpose 字段时，在 dd-scene 后的白话说明里逐拍说清目的；协议扩展出 purpose 后才写进 JSON，不要自创未知字段。',
  '  - 机位数量按这场戏决定，不固定为 3。只写 camera 就是 1 台；shots 写几条就是几台，可以多于 3，最多 8 台。不要凑全景+越肩+反打，执行层也不会自动补三台。人物道具仍写在外层，每条镜头只写自己的 name 和 camera。',
  '    格式示例（镜头数量按剧情选择）：{"shots":[{"name":"甲的回应","camera":{"move":"over-shoulder","subject":"乙","focus":"甲","axisSide":"positive","size":"medium","height":"eye","start":1,"duration":3}}]}',
  '    shots 会整批替换镜头列表，第一条成为当前镜头。这是可切换的机位，不是时间线上自动切镜。',
  '  - 一场里连续运动不超过两个；第三个改 static。duration 对话 3~5 秒，环绕 8~12 秒。',
  '',
  '**编排（「接着」）**：performance.t、route 的 start、camera.start 都是同一时间轴的秒数，不是彼此相对的等待时间。',
  '  camera.start + camera.duration 不得超过顶层 duration；镜头要在目标动作发生时拍到它，不能等人物收束后才开始推近。',
  '  执行层会把溢出镜头前移并尽量保留时长；仍须先把起止时刻设计正确。宿主会应用并热更新白模台。',
  '**改场景前先看「白模台当前场景」**：那是实时状态。用户说「再近一点」「把他挪到左边」「别动桌子、只把镜头拉远」',
  '  这类话时，基于现状**只改他提到的那部分**，其余元素原样保留（沿用同样的 at / pose / route / start 值）——',
  '  **不要每次都把整场重摆一遍**，那会丢掉用户手摆的东西、也让他看不清你到底改了什么。',
  '  characters / objects 是**整批替换**语义：给少了就是删掉了。所以要"保留"的元素必须照样写进 JSON。',
  '**只想改一个对象**时，给它加 `"target":"<场景摘要里的 id>"`（如 `"target":"aigen_char_1"`，也可用名字）——',
  '  翻译层就**只动那一个**、其余原样保留，而且只覆盖你显式写了的字段。例：把甲往左挪 → `{"characters":[{"target":"aigen_char_1","at":[-3,0]}]}`',
  '  （只写 at 就只改位置，姿势/颜色/朝向都不动；要改朝向再加 `facing`，要加走位再加 `route`）。',
  '  **不给 target 的元素**会当作新对象追加 —— 所以要清空重来请用 reset，不要靠"少写几个"。',
  '**清空**：用户说「清空」「重来」「全删了」时，输出 {"type":"director-desk-scene","reset":true} —— 白模台会清成空画布（相机位姿保留）。',
  '  用户说「换一批」「重新摆两个人」时**不要**用它，那是用新的 characters / objects 覆盖（同样是整批替换语义）。',
  '  ⚠️ JSON 必须**写完整**：第一个字符是 {，最后一个字符是最外层的 }。漏掉收尾（实测发生过）整块就作废，用户只会看到「场景块解析失败」。',
  '  白模台只有内置人偶 + 粗模道具：**没有换装/表情/手指级精确造型**（精细摆姿让用户在右侧骨骼滑杆手动调）、**没有背景**。物品是静态的；角色 performance/route 和相机 move 会自动落到时间轴关键帧。',
  '- 输出 dd-scene 块后用一句自然语言告诉用户你摆了什么、镜头怎么动，块本身用户看不到。',
];
// i18n-exempt-end

const DESK_CONTEXT_START = '[导演台上下文]'; // i18n-exempt
const DESK_CONTEXT_END = '[/导演台上下文]'; // i18n-exempt
/** submit() 拼 transportText 时用的分隔标记（原文在它之后）。 */
const USER_TURN_MARKER = '\n\n用户：'; // i18n-exempt

/**
 * 剥掉发给模型的上下文块，只留用户真正说的话。
 *
 * 上下文是**通过 `transportText` 发出去的**，而服务端把它当成用户消息存了下来 ——
 * 本地那条消息用 `trimmed` 显示所以当场看着正常，**回读历史时整段上下文就冒出来了**
 * （实测：用户发完消息，界面上出现一大段 `[导演台上下文]…[/导演台上下文]`）。
 *
 * 上下文块**后面还可能跟着技能指令块**（选中专业技能时也是 transportText 的一部分，
 * 同样被存进历史）。实测用户消息开头挂着一整段 `[技能：MONOFORM 白模台操作向导]…`。
 * 所以按「\n\n用户：」这个结构标记切分取原话，而不是假设上下文块后面只剩一句话。
 *
 * 只在**渲染**这一层剥，不动数据：后续轮次 agent 仍需要历史里那份上下文。
 */
export function stripDirectorDeskAgentContext(text: string): string {
  const start = text.indexOf(DESK_CONTEXT_START);
  if (start === -1) return text;
  const end = text.indexOf(DESK_CONTEXT_END, start);
  if (end === -1) return text;
  const rest = text.slice(end + DESK_CONTEXT_END.length);
  const marker = rest.lastIndexOf(USER_TURN_MARKER);
  const body = marker >= 0 ? rest.slice(marker + USER_TURN_MARKER.length) : rest;
  // 剥完什么都不剩（不该发生）时宁可原样显示，也不要渲染成空气泡。
  const trimmed = body.replace(/^\s*用户：/, '').trim();
  return trimmed || text;
}

/**
 * 导演台专用的 AI 助手面板。
 *
 * **为什么不是直接挂 `SuperChatPanel`**：那个面板是项目助手的门面，标题「虾导」、
 * 空态「可以询问项目进度…」、占位「说出要推进的分集、画面、配音或成片任务」全是
 * 项目流水线口径，塞进 3D 导演台里文不对题；而且以后要给导演台加专属能力（生成
 * 背景、读上游节点…）就得往那个 135KB 的共享组件里塞 `if (scope.kind === ...)`。
 *
 * 所以这里**只复用不该重写的那部分**：
 * - `useSuperChat` —— WS 协议、重连、scope、本地缓存。它是 scope 感知的，照传即可。
 * - `MessageBubble` —— 消息渲染（含 ui_spec / 媒体卡 / 工具消息）。它已经导出了。
 *
 * 文案、布局、以及将来的导演台专属交互，全部长在这个文件里，改这里不会碰到项目助手。
 */
export function DirectorDeskChatPanel({
  scope,
  upstreamSummary,
  sceneSummary,
  onRequestClose,
  onSceneIntent,
  onUndoScene,
  engine = 'director',
}: DirectorDeskChatPanelProps) {
  const { t } = useTranslation();
  const displayName = useAuthStore((state) => state.displayName);
  // scope.id 形如 `<project>/<node>` —— 技能选择按**节点**记忆，取后半段。
  // 没有 scope（理论上不会，宿主总是给）时退化成空串，键仍然合法、只是所有节点共用一个。
  const scopeNodeId = scope?.id?.split('/')[1] ?? '';
  const chat = useSuperChat({
    displayName: displayName || 'SuperTale',
    scope,
  });
  const [draft, setDraft] = useState('');
  const [media, setMedia] = useState<SpecMediaDetail | null>(null);
  // 消息详情（完整结构 + raw JSON）—— 覆盖式展示，窄栏里也放得下。
  const [detail, setDetail] = useState<ChatMessage | null>(null);
  const [generating, setGenerating] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  // 用户当前是否贴在底部。自动滚动只在贴底时发生 —— 否则用户上翻查历史时
  // 每条新消息都会把他拽回底部（实测最恼人的一个体验问题）。
  const atBottomRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  // 选中的**可选专业技能**（叠加在常驻的「导演台操作专家」之上）。默认 null = 只有
  // 基础层。选中后其专业指令随 transportText 拼进上下文，只影响措辞倾向，不写文件、不跨节点。
  // 按节点记忆：用户实测「节点没有记忆之前选择的 skill」—— 每开一次节点都要重选一遍。
  const [skillId, setSkillId] = useState<string | null>(() => readStoredSkill(scopeNodeId, engine));
  const selectSkill = useCallback(
    (id: string | null) => {
      setSkillId(id);
      try {
        if (id) window.localStorage.setItem(storedSkillKey(scopeNodeId, engine), id);
        else window.localStorage.removeItem(storedSkillKey(scopeNodeId, engine));
      } catch {
        // 隐私模式/沙箱下 localStorage 会抛：选择仍然生效，只是下次打开不记得。
      }
    },
    [scopeNodeId, engine],
  );
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const activeSkill = getDirectorDeskSkill(skillId, engine);
  // 菜单技能按引擎分池：monoform 有合并后的「电影级运镜与动作编排」和顾问类技能。
  const skills = useMemo(() => deskSkillsForEngine(engine), [engine]);
  // 已点选应用过的灵感提案（key = `${消息id}:${序号}`），用于给卡片打「已应用」态。
  const [appliedProposals, setAppliedProposals] = useState<Set<string>>(() => new Set());
  // 最近一次真正落到导演台上的那条消息 —— 只有它的分镜卡显示「已应用」与撤销。
  const [appliedSceneMsgId, setAppliedSceneMsgId] = useState<string | null>(null);
  /**
   * 「清空」的二次确认。破坏性操作不做原生 confirm（丑且不可控），改成**同一按钮
   * 点两次**：第一次变成「确认清空？」，3 秒内再点才执行，超时自动解除。
   */
  const [resetArmed, setResetArmed] = useState(false);
  /**
   * 「允许改动画面」总开关（默认开）。关掉后 agent 输出的 dd-scene 只渲染成卡片，
   * 由用户手点「应用」—— 不想被改画面时的闸门。偏好持久化，跨会话记住。
   */
  const [autoApply, setAutoApply] = useState(readStoredAutoApply);

  const toggleAutoApply = useCallback(() => {
    setAutoApply((prev) => {
      const next = !prev;
      persistAutoApply(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!resetArmed) return;
    const timer = setTimeout(() => setResetArmed(false), 3_000);
    return () => clearTimeout(timer);
  }, [resetArmed]);

  /** 清空走 scene 注入通道（宿主会先存撤销快照），**不经过模型** —— 更可靠。 */
  const handleResetScene = useCallback(() => {
    if (!resetArmed) {
      setResetArmed(true);
      return;
    }
    setResetArmed(false);
    onSceneIntent?.({ type: DIRECTOR_SCENE_INTENT_TYPE, reset: true });
  }, [onSceneIntent, resetArmed]);

  /** 点选一条灵感提案 —— 走 dd-scene 同一条注入通道，并给卡片标记已应用。 */
  const pickProposal = useCallback(
    (key: string, proposal: DirectorProposal) => {
      onSceneIntent?.(proposal.scene);
      setAppliedProposals((prev) => new Set(prev).add(key));
    },
    [onSceneIntent],
  );

  /**
   * 生成背景需要 `(project, node)`，两者都在 scope id 里（`<project>/<node>`）。
   * 从 scope 解而不是另加 props 有两个好处：面板的入参保持一个；
   * 而且**没有导演台 scope 时这段能力直接不存在** —— 「只作用于当前节点」是结构性的，
   * 不靠调用点自觉。
   */
  const target = useMemo(() => {
    if (scope?.kind !== 'directorDesk' || !scope.id) return null;
    const [project, nodeId] = scope.id.split('/');
    if (!project || !nodeId) return null;
    return { project, nodeId };
  }, [scope]);

  // 生成背景是 360 导演台独有的能力（MONOFORM 无背景系统）：按钮直接不出现，
  // 与上下文里的禁令双保险 —— 结构上不给入口，不靠 agent 自觉。
  const canGenerateBackground = engine !== 'monoform';

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const list = listRef.current;
    if (!list) return;
    // scrollTo 不是处处都有（jsdom 没实现它），退回直接赋值 —— 行为一致，只是没有平滑动画。
    const top = Math.max(0, list.scrollHeight - list.clientHeight);
    if (Math.abs(list.scrollTop - top) < 1) return;
    if (behavior === 'smooth' && typeof list.scrollTo === 'function') {
      list.scrollTo({ top, behavior });
    } else {
      list.scrollTop = top;
    }
  }, []);

  /**
   * 贴底判定：图片/媒体卡是异步撑高的，所以**每次内容变化后**都要重算一次
   * （只在滚动事件里算会漏掉"加载完图片后已经离底"的情况）。
   */
  const syncBottomState = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
    const atBottom = distance <= 24;
    atBottomRef.current = atBottom;
    setShowScrollToBottom(!atBottom);
  }, []);

  // 出字会先把列表撑高。等绘制后再滚，用户会先看到文字跳上去再被拉回底部。
  useLayoutEffect(() => {
    if (atBottomRef.current) scrollToBottom();
    syncBottomState();
  }, [chat.messages, chat.streamText, chat.busy, scrollToBottom, syncBottomState]);

  /**
   * agent 在回复里输出 ```dd-scene``` 块时，把它解析成 intent 交给宿主注入导演台。
   * 只在**回合结束**（`!chat.busy`）后处理，避免抓到还在流式拼接的半截 JSON；
   * 按消息 id 去重，历史里的旧块不会被重复应用。
   */
  const processedSceneMsgRef = useRef<string | null>(null);
  useEffect(() => {
    if (chat.busy || !onSceneIntent) return;
    // 「允许改动画面」关掉时：不解析、不注入，**也不标哨兵** —— 用户把开关打回来时，
    // 最近那条带场景的回复仍应当能被补上（所以这里直接 return，不动 processedSceneMsgRef）。
    if (!autoApply) return;
    // 顾问组（导演方法论 / 剧本→分镜表 / 审片建议）卖的就是「只动嘴不改画面」。那只写在
    // 提示词里是**软约束**—— 模型照样输出 dd-scene 时用户实测人物就被摆上去了。这里补一道
    // 硬门控：选了顾问技能，任何场景都不自动落地，只在对话里留分镜卡让用户自己点「应用」。
    // 与 autoApply 关掉时同样不标哨兵：切回操作组，最近那条场景仍能补上。
    if (activeSkill?.group === 'advise') return;
    const visible = oneReplyPerUserTurn(chat.messages);
    for (let i = visible.length - 1; i >= 0; i--) {
      const m = visible[i];
      if (m.role !== 'assistant') continue;
      // 灵感提案（dd-proposals）是给用户点选的，绝不自动应用 —— 交给下方卡片。
      if (parseDirectorProposals(m.text)) continue;
      const intent = parseDirectorSceneIntent(m.text);
      if (!intent) {
        // 有块但解析不出来：以前是**静默丢弃**（实测用户对着不动的白模台不知道发生了什么）。
        // 现在明确报错并停在这一条 —— 最新那条带场景的回复才是用户刚提的要求，
        // 不该回退去应用更早的旧块。
        // 流式半截也含 type 字符串，但围栏还没关上。这时报「JSON 不完整」是误报。
        const fenceClosed = (m.text.match(/```/g) ?? []).length >= 2;
        if (
          fenceClosed
          && hasDirectorSceneBlock(m.text)
          && processedSceneMsgRef.current !== `bad:${m.id}`
        ) {
          processedSceneMsgRef.current = `bad:${m.id}`;
          toast.error(t('node.directorDesk.assistantSceneUnparsed'));
        }
        return;
      }
      if (processedSceneMsgRef.current === m.id) return; // 最近一条已处理过
      processedSceneMsgRef.current = m.id;
      // 记下是哪条消息落的画面 —— 只有它的卡片显示「已应用/撤销」。
      setAppliedSceneMsgId(m.id);
      onSceneIntent(intent);
      return;
    }
  }, [chat.messages, chat.busy, onSceneIntent, t, autoApply, activeSkill]);

  const canSend = chat.connected && draft.trim().length > 0;
  /**
   * 发送时把导演台上下文作为 `transportText` 一起送出 —— 用户看到的仍是自己那句话，
   * agent 拿到的是「上下文 + 用户原话」。
   */
  const submit = useCallback(() => {
    if (!canSend) return;
    const text = draft.trim();
    const prefix = target
      ? buildDirectorDeskAgentContext(
          {
            project: target.project,
            nodeId: target.nodeId,
            upstreamSummary,
            sceneSummary,
          },
          engine,
        )
      : '';
    // 上下文 + 技能指令（常驻基础层 + 可选专业技能）+ 用户原话；用户可见的仍只是原话。
    const parts = prefix ? [prefix, buildDirectorDeskSkillPrompt(skillId, engine)] : [];
    const outbound = parts.length ? `${parts.join('\n\n')}\n\n用户：${text}` : text; // i18n-exempt
    if (chat.send(text, [], outbound)) {
      setDraft('');
      // 自己的动作要看到回应：即使用户刚上翻过历史，发消息后也贴回底部。
      atBottomRef.current = true;
      setShowScrollToBottom(false);
    }
  }, [canSend, chat, draft, target, upstreamSummary, sceneSummary, skillId, engine]);

  /**
   * 「生成背景」：把输入框里的描述交给后端那条**文生全景**路由（走项目配置的 360
   * 模型），产物落在 `director_desk_panorama/<本节点>/`。这里是**发起**，
   * 换背景由 `DirectorDeskNode` 在任务完成时做（它按 node id 认领结果）。
   *
   * 刻意不做「每条消息都自动生成」：多数消息只是想聊两句，自动生成既烧钱又不对。
   */
  const generateBackground = useCallback(async () => {
    const description = draft.trim();
    if (!target || !canGenerateBackground || !description || generating) return;
    setGenerating(true);
    try {
      await api
        .post(`api/v1/projects/${target.project}/freezone/director-desk-panorama`, {
          json: { description, node_id: target.nodeId },
        })
        .json();
      setDraft('');
      toast.success(t('node.directorDesk.assistantGenerateQueued'));
      // 对话里留一条记录。这个面板长得像对话，用户点了按钮却什么都不出现会以为没生效；
      // 走 appendNotification（项目既有机制，写进本节点自己的 scope），不会触发模型。
      void chat.appendNotification(
        t('node.directorDesk.assistantGenerateQueuedChat', { description }),
      );
    } catch (error) {
      toast.error(
        t('node.directorDesk.assistantGenerateFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setGenerating(false);
    }
  }, [canGenerateBackground, chat, draft, generating, t, target]);

  const initializing =
    !chat.historyReady && chat.messages.length === 0 && (chat.connecting || chat.connected);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-transparent">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.08] px-3 py-2">
        <span className="flex items-center gap-1.5 text-[12px] leading-5 text-white/85">
          {chat.connected ? (
            <span className="size-1.5 rounded-full bg-emerald-300/90" />
          ) : (
            <Loader2 className="size-3.5 animate-spin text-white/50" />
          )}
          {t('node.directorDesk.assistantTitle')}
        </span>
        {/*
          作用域提示常驻：用户需要知道这段对话只属于当前节点。它是产品承诺，
          也是这个面板与「项目助手」唯一的区别所在。
        */}
        <span
          className="truncate text-[12px] leading-5 text-white/40"
          title={t('node.directorDesk.assistantScopeHint')}
        >
          {t('node.directorDesk.assistantScopeHint')}
        </span>
        {/*
          「允许改动画面」：开 = agent 说完直接摆好；关 = 只出卡片、你自己点应用。
          与「清空」并排放在头部 —— 都是面板级开关，不占输入区的宽度。
        */}
        {onSceneIntent && (
          <button
            type="button"
            onClick={toggleAutoApply}
            aria-pressed={autoApply}
            title={t('node.directorDesk.card.autoApplyTitle')}
            className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] leading-4 transition-colors hover:bg-white/[0.1] ${
              autoApply ? 'text-cyan-100/85' : 'text-white/45 hover:text-white/85'
            }`}
          >
            {autoApply ? <Zap className="size-3.5" /> : <ZapOff className="size-3.5" />}
            {autoApply
              ? t('node.directorDesk.card.autoApply')
              : t('node.directorDesk.card.autoApplyOff')}
          </button>
        )}
        {/*
          「清空重来」：破坏性，所以同一按钮点两次（第一次变「确认清空？」，3 秒超时）+
          走宿主通道不经过模型。宿主执行前会存撤销快照，误点了还能退回来。
        */}
        {onSceneIntent && (
          <button
            type="button"
            onClick={handleResetScene}
            title={t('node.directorDesk.card.resetTitle')}
            className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] leading-4 transition-colors ${
              resetArmed
                ? 'bg-amber-400/[0.18] text-amber-100'
                : 'text-white/45 hover:bg-white/[0.1] hover:text-white/85'
            }`}
          >
            <RotateCcw className="size-3.5" />
            {resetArmed
              ? t('node.directorDesk.card.resetConfirm')
              : t('node.directorDesk.card.reset')}
          </button>
        )}
        {onRequestClose && (
          <button
            type="button"
            onClick={onRequestClose}
            aria-label={t('node.directorDesk.close')}
            className="ml-auto flex size-6 items-center justify-center rounded-md text-white/60 transition-colors hover:bg-white/[0.1] hover:text-white/90"
          >
            <X className="size-3.5" />
          </button>
        )}      </div>

      <div className="relative min-h-0 flex-1">
      <div
        ref={listRef}
        onScroll={syncBottomState}
        className="h-full space-y-4 overflow-y-auto overflow-x-hidden px-3 py-3 [overflow-anchor:none] [scrollbar-gutter:stable]"
      >
        {initializing && (
          <p className="text-[12px] leading-5 text-white/55">
            {t('node.directorDesk.assistantSyncing')}
          </p>
        )}

        {!initializing && chat.messages.length === 0 && !chat.streamText && (
          <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-3">
            <p className="text-[12px] leading-5 text-white/70">
              {t('node.directorDesk.assistantEmpty')}
            </p>
            {/*
              示例指令：点一下**填进输入框**而不是直接发 —— 用户还能改两个字再说，
              比"点一下就烧一次模型"更可控。
            */}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {EXAMPLE_PROMPTS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setDraft(t(`node.directorDesk.${key}`))}
                  className="rounded-full border border-white/[0.12] bg-white/[0.04] px-2.5 py-1 text-[12px] leading-4 text-white/70 transition-colors hover:border-cyan-300/30 hover:bg-cyan-300/[0.08] hover:text-cyan-100"
                >
                  {t(`node.directorDesk.${key}`)}
                </button>
              ))}
            </div>
          </div>
        )}

        {oneReplyPerUserTurn(chat.messages).map((message) => {
          const streamingThis = message.role === 'assistant'
            && chat.busy
            && (
              (Boolean(chat.activeTurnId) && message.turnId === chat.activeTurnId)
              || message.id === chat.messages[chat.messages.length - 1]?.id
            );
          const proposals = !streamingThis && message.role === 'assistant'
            ? parseDirectorProposals(message.text)
            : null;
          // 提案消息里的 scene 是给用户点选的（下面那张提案卡），不再叠一张自动卡。
          // 出字过程中不挂场景卡，避免半截 JSON 让列表一跳一跳。
          const sceneIntent =
            !streamingThis && message.role === 'assistant' && !proposals
              ? parseDirectorSceneIntent(message.text)
              : null;
          const visibleText = streamingThis
            ? hideOpenFence(message.text)
            : message.text;
          return (
            <div key={message.id} className="space-y-2">
              <MessageBubble
                // 流式期间用纯文本。Markdown 每帧重解析会把逐字输出拖成一顿一顿。
                streaming={streamingThis}
                // 用户消息里可能带着发给模型的上下文块，显示前剥掉；提案 JSON 也剥掉，改用卡片。
                message={{
                  ...message,
                  text: stripDirectorProposals(
                    stripDirectorSceneIntent(stripDirectorDeskAgentContext(visibleText)),
                  ),
                }}
                variant="freezone"
                pinned={chat.pinnedIds.has(message.id)}
                onDelete={chat.deleteMessage}
                onTogglePin={chat.togglePin}
                onOpenDetail={setDetail}
                onOpenMedia={setMedia}
              />
              {sceneIntent && (
                <DirectorSceneCard
                  intent={sceneIntent}
                  applied={appliedSceneMsgId === message.id}
                  onApply={() => {
                    setAppliedSceneMsgId(message.id);
                    onSceneIntent?.(sceneIntent);
                  }}
                  onUndo={onUndoScene}
                />
              )}
              {proposals && (
                <div className="space-y-1.5">
                  {proposals.map((proposal, index) => {
                    const key = `${message.id}:${index}`;
                    const applied = appliedProposals.has(key);
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => pickProposal(key, proposal)}
                        className="flex w-full flex-col items-start gap-0.5 rounded-lg border border-white/[0.1] bg-white/[0.03] px-3 py-2 text-left transition hover:border-white/25 hover:bg-white/[0.06]"
                      >
                        <span className="flex w-full items-center justify-between gap-2 text-[12px] font-medium text-white/85">
                          {proposal.title}
                          <span className="shrink-0 text-[12px] text-white/45">
                            {applied
                              ? t('node.directorDesk.proposalApplied')
                              : t('node.directorDesk.proposalApply')}
                          </span>
                        </span>
                        <span className="text-[12px] leading-4 text-white/55">{proposal.summary}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {chat.streamText && (
          <MessageBubble
            message={streamMessage(chat.streamText)}
            variant="freezone"
            streaming
            pinned={false}
            onDelete={() => undefined}
            onTogglePin={() => undefined}
            onOpenDetail={setDetail}
            onOpenMedia={setMedia}
          />
        )}

        {chat.busy && !chat.streamText && (
          <p className="flex items-center gap-1.5 text-[12px] leading-5 text-white/55">
            <Loader2 className="size-3.5 animate-spin" />
            {t('node.directorDesk.assistantWaiting')}
          </p>
        )}

        {chat.error && (
          <p role="alert" className="text-[12px] leading-5 text-amber-300">
            {chat.error}
          </p>
        )}

      </div>
        {showScrollToBottom && (
          <button
            type="button"
            onClick={() => scrollToBottom('smooth')}
            title={t('node.directorDesk.assistantScrollToBottom')}
            aria-label={t('node.directorDesk.assistantScrollToBottom')}
            className="absolute bottom-3 left-1/2 z-10 flex size-7 -translate-x-1/2 items-center justify-center rounded-full border border-white/[0.14] bg-[#1b1b1b]/92 text-white/75 shadow-lg backdrop-blur transition-colors hover:bg-[#242424] hover:text-white"
          >
            <ArrowDown className="size-3.5" />
          </button>
        )}
      </div>

      <div className="shrink-0 border-t border-white/[0.08] p-3">
        {target && (
          <div className="relative mb-2">
            {/*
              「导演台操作专家」是常驻基础层（每次都注入，不在这个列表里选）。
              这里选的是**叠加**在它之上的一个可选专业技能；默认不选（仅基础层）。
            */}
            <button
              type="button"
              onClick={() => setSkillMenuOpen((v) => !v)}
              aria-haspopup="listbox"
              aria-expanded={skillMenuOpen}
              className="flex w-full items-center gap-1.5 rounded-md border border-white/[0.1] bg-white/[0.04] px-2 py-1.5 text-[12px] leading-5 text-white/85 transition-colors hover:bg-white/[0.07]"
            >
              {activeSkill ? (
                <activeSkill.icon className="size-3.5 shrink-0 text-cyan-200/90" />
              ) : (
                <Sparkles className="size-3.5 shrink-0 text-white/45" />
              )}
              <span className="truncate">
                {activeSkill ? t(activeSkill.nameKey) : t('node.directorDesk.skills.pickLabel')}
              </span>
              <ChevronDown className="ml-auto size-3.5 shrink-0 text-white/40" />
            </button>
            {skillMenuOpen && (
              <>
                {/* 点空白处关掉菜单 */}
                <button
                  type="button"
                  aria-hidden
                  tabIndex={-1}
                  className="fixed inset-0 z-40 cursor-default"
                  onClick={() => setSkillMenuOpen(false)}
                />
                <ul
                  role="listbox"
                  aria-label={t('node.directorDesk.skills.menuTitle')}
                  className="absolute bottom-full left-0 z-50 mb-1 max-h-80 w-full overflow-y-auto rounded-lg border border-white/[0.12] bg-[#151515] p-1 shadow-xl"
                >
                  {/* 「通用」= 清空专业技能，只留常驻基础层 */}
                  <li>
                    <button
                      type="button"
                      role="option"
                      aria-selected={activeSkill === null}
                      onClick={() => {
                        selectSkill(null);
                        setSkillMenuOpen(false);
                      }}
                      className={`flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-white/[0.06] ${
                        activeSkill === null ? 'bg-cyan-300/[0.1]' : ''
                      }`}
                    >
                      <Sparkles className="mt-0.5 size-4 shrink-0 text-white/45" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="text-[12px] font-medium leading-5 text-white/90">
                            {t('node.directorDesk.skills.none.name')}
                          </span>
                          {activeSkill === null && <Check className="size-3 shrink-0 text-cyan-300" />}
                        </span>
                        <span className="mt-0.5 block text-[12px] leading-4 text-white/50">
                          {t('node.directorDesk.skills.none.desc')}
                        </span>
                      </span>
                    </button>
                  </li>
                  {/*
                    按「会改画面 / 只动嘴」两组渲染（用户要的那条轴）。
                    组标题用 role="presentation" 平铺 —— 嵌套 listbox 会破坏可访问性语义。
                  */}
                  {SKILL_GROUP_ORDER.map((group) => {
                    const groupSkills = skills.filter((skill) => skill.group === group);
                    if (groupSkills.length === 0) return null;
                    return (
                      <Fragment key={group}>
                        <li
                          role="presentation"
                          className="px-2 pb-0.5 pt-1.5 text-[12px] leading-4 tracking-wide text-white/35"
                        >
                          {t(
                            group === 'operate'
                              ? 'node.directorDesk.skills.groupOperate'
                              : 'node.directorDesk.skills.groupAdvise',
                          )}
                        </li>
                        {groupSkills.map((skill) => {
                          const selected = skill.id === activeSkill?.id;
                          return (
                            <li key={skill.id}>
                              <button
                                type="button"
                                role="option"
                                aria-selected={selected}
                                onClick={() => {
                                  selectSkill(skill.id);
                                  setSkillMenuOpen(false);
                                }}
                                className={`flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-white/[0.06] ${
                                  selected ? 'bg-cyan-300/[0.1]' : ''
                                }`}
                              >
                                <skill.icon className="mt-0.5 size-4 shrink-0 text-cyan-200/90" />
                                <span className="min-w-0 flex-1">
                                  <span className="flex items-center gap-1.5">
                                    <span className="text-[12px] font-medium leading-5 text-white/90">
                                      {t(skill.nameKey)}
                                    </span>
                                    {selected && (
                                      <Check className="size-3 shrink-0 text-cyan-300" />
                                    )}
                                  </span>
                                  <span className="mt-0.5 block text-[12px] leading-4 text-white/50">
                                    {t(skill.descKey)}
                                  </span>
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            rows={2}
            placeholder={t('node.directorDesk.assistantPlaceholder')}
            aria-label={t('node.directorDesk.assistantPlaceholder')}
            className="min-h-0 flex-1 resize-none rounded-md border border-white/[0.1] bg-white/[0.04] px-2.5 py-2 text-[12px] leading-5 text-white/90 outline-none placeholder:text-white/35 focus:border-cyan-300/40"
          />
          {target && canGenerateBackground && (
            <button
              type="button"
              onClick={() => {
                void generateBackground();
              }}
              disabled={generating || draft.trim().length === 0}
              title={t('node.directorDesk.assistantGenerate')}
              className="flex size-8 shrink-0 items-center justify-center rounded-md bg-white/[0.08] text-white/80 transition-colors hover:bg-white/[0.14] disabled:opacity-40"
            >
              {generating ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
            </button>
          )}
          {chat.busy ? (
            <button
              type="button"
              onClick={chat.abort}
              aria-label={t('node.directorDesk.assistantStop')}
              className="flex size-8 shrink-0 items-center justify-center rounded-md bg-white/[0.08] text-white/80 transition-colors hover:bg-white/[0.14]"
            >
              <Square className="size-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              aria-label={t('node.directorDesk.assistantSend')}
              className="flex size-8 shrink-0 items-center justify-center rounded-md bg-cyan-300/[0.16] text-cyan-100 transition-colors hover:bg-cyan-300/[0.24] disabled:opacity-40"
            >
              <Send className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/*
        媒体详情走 superchat 那套**真实弹层**（tags / sections / 候选 / 下载），
        不是面板里自制的那层壳 —— 同一份 ui_spec 在项目助手和这里应该长得一样。
      */}
      <SpecMediaDetailModal
        detail={media}
        onClose={() => setMedia(null)}
        onOpenMedia={setMedia}
      />

      {/*
        消息详情：完整结构 + raw JSON。1:1 复用项目助手那个面板（`alwaysVisible`
        因为窄栏里没有 xl 断点），覆盖式展示 —— 440px 侧栏里并排会挤死主列。
      */}
      {detail && (
        <div className="absolute inset-y-0 right-0 z-20 flex w-full max-w-[340px] flex-col bg-[#111111] shadow-2xl">
          <MessageDetailPanel
            message={detail}
            onClose={() => setDetail(null)}
            onOpenMedia={setMedia}
            alwaysVisible
          />
        </div>
      )}
    </div>
  );
}

/**
 * 服务端一轮只落一条助手消息，界面上却还会留着流式占位。
 * 占位和落库文本经常对不上（一个是半截，一个是改写后的全文），按文本折叠会漏。
 * 导演台在两条用户消息之间只显示最长的那条助手回复。
 */
function oneReplyPerUserTurn(messages: ChatMessage[]): ChatMessage[] {
  const visible: ChatMessage[] = [];
  let betweenUsers: ChatMessage[] = [];
  const flush = () => {
    const replies = betweenUsers.filter((message) => message.role === 'assistant');
    const folded: ChatMessage[] = [];
    for (const message of replies) {
      const duplicate = folded.find((previous) =>
        previous.text.includes(message.text) || message.text.includes(previous.text),
      );
      if (!duplicate) {
        folded.push(message);
        continue;
      }
      const previousOk = Boolean(parseDirectorSceneIntent(duplicate.text));
      const nextOk = Boolean(parseDirectorSceneIntent(message.text));
      const winner = nextOk && !previousOk
        ? message
        : previousOk && !nextOk
          ? duplicate
          : message.text.length >= duplicate.text.length ? message : duplicate;
      folded[folded.indexOf(duplicate)] = winner;
    }
    let replyIndex = 0;
    for (const message of betweenUsers) {
      if (message.role !== 'assistant') {
        visible.push(message);
        continue;
      }
      const kept = folded[replyIndex];
      replyIndex += 1;
      if (kept === message) visible.push(message);
    }
    betweenUsers = [];
  };
  for (const message of messages) {
    if (message.role === 'user') {
      flush();
      visible.push(message);
    } else {
      betweenUsers.push(message);
    }
  }
  flush();
  return visible;
}

/** 流式输出时藏起还没闭合的代码块，避免 JSON 一边长一边把列表撑跳。 */
function hideOpenFence(text: string): string {
  const fences = text.split('```').length - 1;
  if (fences % 2 === 0) return text;
  const cut = text.lastIndexOf('```');
  return cut >= 0 ? text.slice(0, cut).trimEnd() : text;
}

function streamMessage(text: string): ChatMessage {
  return { id: 'director-desk-stream', role: 'assistant', text, timestamp: Date.now() };
}
