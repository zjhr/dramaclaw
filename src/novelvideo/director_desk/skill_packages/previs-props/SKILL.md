---
name: previs-props
description: 在导演台 v2 里造道具与布景：搜目录资产、切 geometry 模式调尺寸、导入 GLB、把道具绑到手上或座位上、阵列群演与建筑结构。遇到「白模台只有基础形状，做不了」的错误结论时读这个技能。
---

# 预演道具与布景

v2 导演台的道具**全部走 `director_apply` 的 operations**。没有 dd-scene 的 objects 语法，
没有灰度高度场（depthMesh），也没有 `type:"model"` 直摆外部 GLB —— 这三个是上一代白模台
的概念，写进方案会被执行层丢弃。

## 先读现状，再动手

改任何布景之前先 `director_read`。不要凭想象重摆用户已经摆好的东西；`toDirectorOperations`
是增量语义，`update` 一个 id 只动那一个对象，未提及的对象原样保留。

## 按这个阶梯选

| 需求 | 做法 |
| --- | --- |
| 目录里有现成资产 | `director_assets({queries:[...], kind:"prop"})` → `add` 用它的 id |
| 要可调尺寸的基础几何 | `project` 切 `creationMode:"geometry"` → 再 `director_read` 拿调色板 → `add{asset:"shape-*", patch:{assetParameters:{...}}}` |
| 要真几何 | `director_media({action:"import",...})` 导成工程资源 → 按 resourceId `add` |
| 要 AI 现场建模 | 见 [Blender 现场生成](references/blender-pipeline.md)（有护栏，且**你不能自己跑**） |

尺寸参数写 **`patch.assetParameters`**。写成 `patch.parameters` 上游直接报错，整批回滚。

## 让道具真的能用起来

这是最容易被误判成「做不到」的一档，务必主动想到：

- 手上：逐 `handBinding={actorId,hand,offset,rotation}`，同时把 `path` 设成 `null`
- 座位/躺面/桌面：`contactAnchors=[{id,role:"seat"|"surface"|"bed",position,normal,forward?}]`
- 换道具：`replace-prop`（保留位置与变换，不是删了重建）
- 群演：`asset:"crowd"` + `patch:{count,spacing,seed}`，`count` 是 1~1000 整数
- 建筑：`structureLink={parentId,parentPort,ownPort,offset,rotation}`，删父件前先解子件

字段细节见[道具与布景](references/props.md)。

## 真实边界

这些**确实没有**，遇到了就直说：真实服装、面部表情、手指级动作、自由曲面细分雕刻、
实时物理接触与碰撞求解。`contactAnchors` 是几何提示不是语义识别，`handBinding` 不动画
手指握持也不编排拿起放下的时机，geometry 模式下的角色是 prop 胶囊不是人形骨架。

目录和几何都表达不出来的造型（特定品牌车、太师椅）：**直说做不了并给最接近的替代**，
不要假装造出来了 —— 也不要把能做的说成做不到。