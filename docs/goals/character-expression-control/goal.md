# 角色表演控制台端到端接入

## 目标

在 DramaClaw 中交付角色表演控制台：按镜头和身份编辑情绪及面部参数，提供通用 3D 人头预览，跨画布保存并恢复状态，并把静帧状态与视频关键帧转换后接入图像和视频生成请求。

## 原始请求

“我想把角色表情功能改为这种形式，你看可不可以？”参考项目：https://github.com/zhurui0523/XiaoLuo-emotion-director-studio。用户随后要求给计划，并通过 GoalBuddy 准备实施目标。

## 输入摘要

- Input shape: `existing_plan`
- Audience: DramaClaw 创作者
- Authority: `requested`
- Proof type: `demo`
- Completion proof: 按浏览器演示确认状态可编辑、跨画布保存/恢复、进入静帧与视频请求，通用 3D 人头响应控制且明确不代表最终角色；现有身份造型和参考图流程仍有效。
- Goal oracle: 浏览器演示、重载前后状态对比、图像与视频提交请求中的表演提示证据，以及最终 Judge 审查收据。
- Likely misfire: 只复刻面板外观而未持久化或接入生成请求；将通用人头预览误认为最终角色；只输出抽象情绪词而无具体表演细节。
- Blind spots considered: 角色基础外观与镜头表演必须分离；多角色轨迹需按镜头和身份隔离；第三方模型和源码授权需核实；生成模型不保证按时间点精确执行微表情；参考图顺序和数量限制需保持。
- Existing plan facts: 保留身份级 `look.expression` 和现有表情九宫格；新增按镜头/身份保存的情绪坐标、眼眉口等控制值及视频关键帧；静帧提交当前状态，视频将关键帧转成带时间点的表演提示；包含通用 3D 人头实时预览并说明它不代表最终角色。

## 验收 Oracle

The oracle for this goal is:

`浏览器演示显示：设置表演状态后刷新或重新打开画布，状态仍绑定在原镜头与身份；静帧与视频请求均携带对应的具体表演提示，视频关键帧按时间顺序序列化；通用 3D 人头随面部控制变化；角色脸图、三视图、表情九宫格参考仍正常发送。`

PM 必须持续用该 Oracle 对照任务回执。只有计划、勘察、单个小切片通过或看板整洁，都不足以完成目标。最终 Judge/PM 审查必须将回执和验证结果映射到 Oracle，并记录 `full_outcome_complete: true`。

## 目标类型

`existing_plan`

## 当前阶段

持续完成完整工作流：Scout 核实画布状态、生成请求、3D 渲染与资产授权边界；Judge 确认数据契约和 Worker 切片；实施后验证控制、持久化、按身份隔离的视频关键帧、提示词序列化和通用 3D 预览，直到最终 Oracle 全部通过。

## 不可妥协的约束

- 不修改身份级 `look.expression`、角色脸图、三视图和表情九宫格的既有语义；表演状态是另一层数据。
- 表演状态必须按镜头和身份隔离，可持久化、恢复；静帧用当前状态，视频用时间轴状态。
- 通用 3D 人头只作为控制预览，不宣称复刻最终生成角色；除非授权和模型能力得到验证，不复制参考仓库源码或 FaceCap 资产。
- 将数值参数转换为可见的眼神、眉部、嘴部、肌肉张力和呼吸描述；不把向模型发送提示词说成精确运动保证。
- 保留当前身份参考图顺序、模型参考图上限和旧画布兼容性。
- 探索代码结构时按仓库要求使用 `codebase-memory`；再次读取 GitHub 参考仓库时使用 `agent-reach`。这些工具只在执行阶段按需调用。

## 验证清单

- 本目标的前端门禁：定向 Vitest 用例，以及 `pnpm --dir frontend build`。
- 若改动后端请求或提示词契约，再运行对应的定向 `uv run pytest`；仅在改动涉及相应验收模块时运行 CE 验收脚本。
- 准备阶段未运行项目测试或构建；既有套件基线未知，不记录为通过或失败。

## 停止规则

只有最终审查证明原始目标全部完成后才能停止。

若目标是可用软件或自动化，且仍有安全的 Worker 任务可执行，不得停在计划、勘察或 Judge 选任务阶段。

若更大的用户目标仍有安全的本地后续工作，不得在单个 Worker 切片验证通过后停止。继续推进收益最高的安全切片，只有遇到阶段、风险、验证被拒、需求歧义或最终验收时才进入审查。

不要按重复文件、表格、路由或辅助函数逐个创建 Worker/Judge 任务；相同形态的工作应合并成一个完整切片并整体审查。

## Slice Sizing

安全意味着范围明确、可验证、可逆，不代表切片必须很小。

任务应取最大且安全、有效的工作切片。

目标是交付有用结果，而不是拆得越小越好。

Worker 应完成整个分配切片，Judge 应审查整个切片；若任务虽安全却不能推动目标，PM 应重新调整看板。

仅在问题孤立、风险高、范围未知或小任务能解锁更大切片时才使用微型任务。若微型任务重复出现、没有行为变化、只增加包装层/契约/证明文件，或回避实际里程碑，则应重新整合。

若切片需要用户输入、凭据、生产访问、破坏性操作或策略决定，不要因此停止所有工作。为该切片记录阻塞回执，建立最小的安全后续任务或替代方案，并继续其他能推动目标且不具破坏性的本地工作。

若只差用户提供明确的审批语句，且没有其他安全本地工作，则询问一次后暂停。阻塞回执中保留精确的 `required_reply`，设置 `waiting_for_user_approval: true`、`goal.status: blocked` 和 `active_task: null`；用户回复前不要重复催问。

## 看板健康

PM 负责看板健康状态。若看板过期、信息误导、离线或状态不一致，运行随附校验器：

```bash
node /Users/mac/.codex/plugins/cache/goalbuddy/goalbuddy/0.4.3/skills/goal-prep/scripts/check-goal-state.mjs docs/goals/character-expression-control
```

若本地看板运行中，应将 `state.yaml` 与实时看板核对。除非活动 Worker 或 PM 任务明确允许修改产品文件，否则只能修复 GoalBuddy 控制文件。

## 权威看板

机器状态以此文件为准：

`docs/goals/character-expression-control/state.yaml`

若本章程与 `state.yaml` 不一致，任务状态、活动任务、回执、验证新鲜度和完成状态均以 `state.yaml` 为准。

## 执行命令

```text
Codex: /goal Follow docs/goals/character-expression-control/goal.md.
Claude Code: /goalbuddy Follow docs/goals/character-expression-control/goal.md.
```

## PM 执行循环

每次继续执行 `/goal` 时：

1. 阅读本章程，并在技能包可用时遵循 GoalBuddy 执行契约（`goal-prep/references/goal-execution.md`）。
2. 阅读 `state.yaml`。
3. 技能包提供更新检查器时运行它；若有新版本，记录提醒但不阻塞目标。
4. 重新核对原始请求、输入类型、授权、验收证据、盲点、已有方案和可能的误完成方式。
5. 只处理当前活动任务。
6. 按任务类型使用 Scout、Judge、Worker 或 PM。
7. 为每项已完成、阻塞或升级的任务写入简洁回执。
8. 更新看板。
9. 若仍有安全本地工作，选择下一项最大可逆 Worker 切片并继续，除非遇到阻塞。
10. 若建议需要成为仓库产物，创建已获授权的 issue/PR，或询问维护者是否需要创建。
11. 在阶段、风险、验证被拒、需求歧义和最终完成时审查，不要习惯性逐个审查小任务。
12. 结束本轮前运行 `node /Users/mac/.codex/plugins/cache/goalbuddy/goalbuddy/0.4.3/skills/goal-prep/scripts/check-can-stop.mjs docs/goals/character-expression-control`。若返回非零，说明仍有安全工作需继续。只有此门禁通过，且 Judge/PM 的最终回执已将验证证据映射到原始目标并记录 `full_outcome_complete: true`，或校验器确认精确的审批等待终态后，才能结束。

Issue 和 PR 只是辅助产物。`state.yaml` 始终是唯一权威状态；每项外部产物决策都必须记入任务回执。
