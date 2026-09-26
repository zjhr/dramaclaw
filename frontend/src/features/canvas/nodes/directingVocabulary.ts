// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) ClaymoreLab
//
// 导演术语单一事实源。
//
// 为什么单独成文件：7 个技能的提示词都要列镜头清单，手抄七份迟早漂移。这里结构化
// 存一份，`buildCameraMovePrompt()` 由它生成 —— 以后加镜头只改这一个文件。
//
// 两条硬纪律：
// 1. **只写引擎真做得到的**。`NOT_IMPLEMENTED` 里那几项在提示词里被显式禁用 ——
//    上次「换背景」空承诺的教训（agent 答应了、画面没变、用户对着不动的导演台发呆）。
// 2. **几何数学不进 LLM**：agent 只从 `id` 里选，采样/插值全在翻译层
//    （`monoformScenePatch.ts` 的 `buildMonoformCameraTrack`）。

export type DirectingTerm = {
  /** 与 dd-scene 的 `camera.move` 取值一致。 */
  id: string;
  en: string;
  zh: string;
  /** 用户可能的口语说法（检索/命中用）。 */
  aliases: string[];
  /** 什么时候用 —— 按**剧情功能**选运动，不是按好看选。 */
  when: string;
  /** 暴露给 agent 的参数（其余都由翻译层定）。 */
  params: string[];
  /** 频率约束（防止整片都在动）。 */
  frequency: string;
  /** 竖屏（9:16）适配。 */
  vertical: string;
};

export const DIRECTING_TERMS: DirectingTerm[] = [
  {
    id: 'static', en: 'static shot', zh: '固定机位', aliases: ['不动', '定住', '静止'],
    when: '让观众看清信息或对话；也是"连续三个运动镜头后该砍一刀"的那个静止选项',
    params: [], frequency: '不限', vertical: '最安全',
  },
  {
    id: 'dolly-in', en: 'dolly in', zh: '推近', aliases: ['推', '靠近一点', '推近'],
    when: '情绪收紧、意识到某件事；从环境收到人物',
    params: ['duration', 'start'], frequency: '一场戏 1-2 次', vertical: '很好用（纵深运动不受窄画幅限制）',
  },
  {
    id: 'dolly-out', en: 'dolly out', zh: '拉远', aliases: ['拉', '退一点', '拉远'],
    when: '收尾、抽离、揭示环境或孤立感',
    params: ['duration', 'start'], frequency: '一场戏 ≤2 次', vertical: '很好用',
  },
  {
    id: 'orbit-left', en: 'orbit left', zh: '向左环绕', aliases: ['绕着他转', '环绕', '转一圈'],
    when: '关系张力、对峙；把两个人放在同一空间里转',
    params: ['duration', 'start'], frequency: '一场戏 ≤1 次', vertical: '可用（弧线比纯横移更立体）',
  },
  {
    id: 'orbit-right', en: 'orbit right', zh: '向右环绕', aliases: ['反向环绕', '绕另一边'],
    when: '同上，方向相反（换轴时注意别跨轴线）',
    params: ['duration', 'start'], frequency: '一场戏 ≤1 次', vertical: '可用',
  },
  {
    id: 'pan-left', en: 'pan left', zh: '左摇', aliases: ['摇过去', '扫一眼左'],
    when: '跟随视线或揭示画外信息；机位不动只转视线',
    params: ['duration', 'start'], frequency: '不限', vertical: '一般（窄画幅摇出来的内容少）',
  },
  {
    id: 'pan-right', en: 'pan right', zh: '右摇', aliases: ['摇过去', '扫一眼右'],
    when: '同上，方向相反',
    params: ['duration', 'start'], frequency: '不限', vertical: '一般',
  },
  {
    id: 'crane-up', en: 'crane up', zh: '升起', aliases: ['升起来', '摇臂升起', '上升'],
    when: '开场建立空间、结尾抽离；从人物升到环境',
    params: ['duration', 'start'], frequency: '一段 ≤1 次', vertical: '可用（垂直运动是竖屏的优势）',
  },
  {
    id: 'crane-down', en: 'crane down', zh: '降下', aliases: ['降下来', '压下来', '降'],
    when: '从环境收到人物、压迫感、进入场景',
    params: ['duration', 'start'], frequency: '一段 ≤1 次', vertical: '可用',
  },
  {
    id: 'rail-left', en: 'rail/truck left', zh: '左移', aliases: ['横移', '平移过去', '滑过去'],
    when: '跟随走动的人、并列展示空间关系（轨道/滑轨感）',
    params: ['duration', 'start'], frequency: '一段 ≤2 次', vertical: '**窄画幅下效果弱**，默认降级为跟随或纵深运动',
  },
  {
    id: 'rail-right', en: 'rail/truck right', zh: '右移', aliases: ['横移', '平移过去'],
    when: '同上，方向相反',
    params: ['duration', 'start'], frequency: '一段 ≤2 次', vertical: '同上',
  },
  {
    id: 'handheld', en: 'handheld', zh: '手持', aliases: ['晃一点', '纪录片那样', '手持感'],
    when: '混乱、纪实、紧张、失去控制 —— **必须有理由**，不是"看起来更酷"',
    params: ['duration', 'start'], frequency: '整片 ≤1 段', vertical: '可用（小幅抖动在近景里更明显）',
  },
  {
    id: 'zoom-in', en: 'zoom in', zh: '变焦推', aliases: ['拉近焦距', '变焦'],
    when: '强调细节、突然注意某物；机位不动只改焦距（与推轨的质感不同）',
    params: ['duration', 'start'], frequency: '≤2 次', vertical: '可用',
  },
  {
    id: 'zoom-out', en: 'zoom out', zh: '变焦拉', aliases: ['拉远焦距', '变焦拉'],
    when: '揭示、抽离；同上，机位不动',
    params: ['duration', 'start'], frequency: '≤2 次', vertical: '可用',
  },
  {
    id: 'pov', en: 'POV shot', zh: '主观镜头', aliases: ['用他的眼睛看', '第一人称', '主观'],
    when: '让观众进入角色视角；需要场景里有角色（没角色会退回静态机位）',
    params: ['duration', 'start'], frequency: '短（1~3s）为宜', vertical: '很好用（主观视角天然适合竖屏）',
  },
  {
    id: 'over-shoulder', en: 'over-the-shoulder', zh: '越肩', aliases: ['从他肩膀后面拍', '过肩', '越肩'],
    when: '对话、对峙；竖屏双人对白的**首选**（比横向并排更省画幅）',
    params: ['duration', 'start'], frequency: '对话场景可反复用', vertical: '**推荐**（竖屏对话标配）',
  },
];

/**
 * 明确**不实现**的术语 —— 引擎缺对应能力，做出来是假的。提示词里要显式禁止，
 * 否则 agent 会继续承诺（这是"换背景"那次的教训）。
 */
export const NOT_IMPLEMENTED: Array<{ id: string; zh: string; why: string }> = [
  {
    id: 'rack-focus',
    zh: '移焦 / 跟焦',
    why: '数据模型里没有对焦距离、引擎也没有景深（DOF）—— 做出来是假的',
  },
  {
    id: 'whip-pan',
    zh: '甩镜',
    why: '引擎没有运动模糊，甩镜的灵魂（糊成色条）出不来，只剩"快摇"',
  },
  {
    id: 'real-dof',
    zh: '真实景深 / 镜头呼吸 / 光晕',
    why: '引擎没有相机光学模型',
  },
];

/**
 * 由上面的表生成「镜头清单」提示词片段 —— 技能提示词调它，不手抄。
 * 语言刻意保持中文稳定（这是给**模型**的指令，不进 i18n）。
 */
export function buildCameraMovePrompt(): string {
  const lines = DIRECTING_TERMS.map(
    (term) => `  ${term.id} = ${term.zh}（${term.aliases.join(' / ')}）：${term.when}${term.frequency !== '不限' ? `；频率：${term.frequency}` : ''}`,
  );
  const banned = NOT_IMPLEMENTED.map((item) => `${item.zh}(${item.id}: ${item.why})`);
  return [
    '可用的镜头运动（**只能从这里选**，不要自创 id）：',
    ...lines,
    `⚠️ 做不到的（用户问到就直说做不了，不要承诺）：${banned.join('；')}。`,
  ].join('\n');
}
