# ShotRecipe Production Pipeline

## Objective

建立一个镜头生产配方 (ShotRecipe) 系统，让角色造型、表情、白模、续写、重拍和质量检查串成可迭代、可比较、可溯源的生产闭环。

## Original Request

"帮我创建goalbuddy" — 基于前两个 round 的分析，创建一个 GoalBuddy board，驱动实现镜头生产配方系统。

## Intake Summary

- Input shape: `specific` (user provided a detailed plan in chat history)
- Audience: 主人 / 开发团队
- Authority: `requested`
- Proof type: `artifact` + `demo`
- Completion proof: 用户可以在镜头工作台中完成一次完整闭环：创建镜头 → 选角色/场景/风格 → 调整妆容表情 → 设置节拍 → 导出白模 → 预检 → 生成正式视频 → 质量检查 → 续写/重拍 → 新版本保留完整溯源 → 原版本可恢复
- Goal oracle: 从头到尾跑一次 e2e demo，检查每个环节是否保留 parent_version_id、prompt_delta、model_snapshot、cost_ledger 等溯源字段；检查白模节点和正式视频节点有来源关系；检查质量报告返回 risks 而非绝对评分
- Likely misfire: 堆积很多独立功能但无法串起来；或者把模型不支持的能力伪装成已实现
- Blind spots considered:
  - 模型能力边界会降级，必须显示给用户
  - 不需要设计积分机制
  - 已有模块（Freezone、CharacterIdentity、Monoform、Director Desk）可以复用，避免重复开发
- Existing plan facts: 来自对微信文章《Seedance 2.5上线了》的分析，提出的 P0 任务包括 ShotRecipe + CharacterLookDecision + Preflight

## Goal Oracle

The oracle for this goal is:

`End-to-end demo walkthrough: user creates a shot recipe, binds character look decisions, exports whitebox, runs preflight, renders, reshoots a segment, and verifies all versions retain full lineage (parent_id, prompt_delta, model_snapshot, cost_ledger). Whitebox node has explicit source edge to final render. Quality report returns structured risks, not a single score.`

The PM must keep comparing task receipts to this oracle. Planning, discovery, a passing tiny slice, or a clean-looking board is not enough.

## Goal Kind

`specific`

## Current Tranche

**Phase 1: 建立镜头配方和版本底座** — 先完成 ShotRecipe 数据模型、CharacterLookDecision、角色/场景/风格/音频的版本引用、父子版本关系、成本和模型能力快照，确保失败任务不覆盖父版本。

## Non-Negotiable Constraints

- 失败任务不能覆盖父版本
- 模型不支持的能力不能伪装为已实现
- 复用现有模块（Freezone、CharacterIdentity、Monoform、Director Desk）
- 不设计积分机制

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

## Slice Sizing

Safe means bounded, explicit, verified, and reversible. It does not mean tiny.

A good task is the largest safe useful slice.

Small is not the goal. Useful is the goal.