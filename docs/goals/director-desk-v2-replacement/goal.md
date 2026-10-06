# 导演台 v2 完全替换（mangfufu/director-desk 接入 DramaClaw）

## Objective

把 DramaClaw 画布上的白模导演台节点**完全替换**为 `mangfufu/director-desk`（v0.4.10，MIT），并让其**全部五层 AI 能力**在 DramaClaw 内可用：内置 AI 对话面板、18 个 `director_*` 工具、内置技能包、自定义技能管理、提示词工程产出。

同时满足主人给定的三条产品约束：导演台是**画布节点**、配置**全局**、保存**相对节点**。

替换完成后 MONOFORM 白模台从主链路移除（vendor 与产物在终审通过后再清）。

## Original Request

> 目标是完全的新项目替换，并且agent功能正常支持，原新项目的ai能力和skill这些都需要接入兼容文我的项目，你可以通过改造接入，兼容使用它的ai面板，和自定义技能管理等等（一至五大点功能），注意，它是一个节点，配置是全局，保存是相对节点。你自己评估架构设计，UI/UX高保真，做到合理，方便灵活使用。

## Intake Summary

- Input shape: `existing_plan`（上一会话已完成上游深度取证 + 五层 AI 能力清单 + 能力对比表）
- Audience: 主人（DramaClaw 自用）
- Authority: `approved`（「完全的新项目替换」为明确授权）
- Proof type: `demo` + `test`
- Completion proof: 浏览器里打开新导演台节点 → 内置 AI 面板真实对话并改动了场景 → 自定义技能可导入/启用/读取 → DramaClaw agent 通道真实跑通一次工具调用 → 节点保存后重开工程工程还在 → 渠道与模型配置跨节点共享 → `tsc --noEmit` 与相关 vitest 全绿 → 三个第三方素材许可门通过
- Goal oracle: **浏览器端到端走查 + 自动化验证 + 一份 receipt→证据映射**。具体四条可机械复跑的断言：
  1. `frontend` `npx tsc --noEmit` 退出 0
  2. 导演台相关 vitest 套件全绿（含新增）
  3. 浏览器实操：新节点能打开、能对话、能改场景、能存能重开
  4. agent 通道一次真实工具调用成功并落盘工程
- Likely misfire:
  1. **只嵌入没接 agent** → 变成「能看的展品」，主人手动能用但 Hermes 驱动不了
  2. **只接 agent 没做面板/技能** → 变成「只有 agent 能用」，主人手动开不了
  3. **配置/保存语义做反** → 第二个节点配置丢失，或多个节点工程互相串
  4. **dev 能跑 prod 挂** → `main.ts:345` 的 `import.meta.env.DEV` 门禁挡住 `__director`
  5. **丢掉 MONOFORM 独有价值直接删** → 语音气泡消失且无替代
  6. **只做到能编译就宣布完成** → 无浏览器证据
- Blind spots:
  - 上游 AI 面板 / MCP / 自定义技能管理三者**全部绑 Electron**（`safeStorage`、`ipcMain`、`window.directorDesktop`），Web 版需自建宿主层
  - nginx 缺 `/monoform-desk/` 配置段是**已存在的生产 bug**，新路径 `/director-desk-v2/` 必须配齐且旧的 bug 要记入板
  - 上游纯中文，无 en/vi
  - 素材许可门（Quaternius CC0-1.0 + 代码 MIT），逐条过 `license-inventory.csv`
  - 单人维护项目（4 提交者、主体 1 人），fork 后需自跟版本
  - 多导演台节点同时打开的工程/会话隔离
  - 已有 MONOFORM 节点的用户数据迁移
  - DramaClaw 自身 `dd-scene` 协议与 `director_*` 操作数组的映射表
- Existing plan facts:
  - 上游 `mangfufu/director-desk` v0.4.10，MIT，329★，2026-09-29 仍在推，纯原生 TypeScript，无 CDN 依赖，实测构建 5.3MB/4.8s
  - 18 个 `director_*` 工具定义在 `src/automation/contract.ts`；`createToolService` 在 `src/main.ts:317` **无条件**创建，不依赖 Electron
  - `src/main.ts:345-348` 的 `window.__director` 宿主 API 被 `if (import.meta.env.DEV)` 门禁包住，生产构建不暴露（去掉是一行）
  - MCP server 本体是纯 `node:http`（`desktop/mcp-server.cjs`），只有 `callTool` 经 Electron IPC 打到渲染进程 → 可自建宿主绕过
  - `.director` 是纯 UTF-8 JSON v3；`skills/director-desk/scripts/project-tool.mjs` 离线 `apply` 接受与在线相同的操作数组，**不需要 revision/requestId**，Node 22+，不联网不填 key
  - DramaClaw 已有 proven vendored 流程：`frontend/vendor/monoform/` + `PATCHES.md` + `frontend/public/monoform-desk/`，走 `frontend/vite.config.ts` 的 `vendoredDesks`
  - `frontend/public/director-desk/`（80MB 死代码）已在本会话 `git rm`，nginx 与 vite 引用已清
  - 已有 `directorDeskSkills.ts` 内含 `engine: 'director' | 'monoform'` 分叉设计，`director` 分支正是为此预留
  - 上游内置技能包结构：SKILL.md 27 行 + 6 个 references（project-format 25.9KB / prompt-writing 16.5KB / camera 9.2KB / editing 7KB / media 5KB / online-workflow 4.2KB）
  - 目标 node 形态：**节点**、配置**全局**、保存**相对节点**

## Goal Oracle

本目标的 oracle 是：

> 在浏览器里打开一个全新导演台节点，用内置 AI 面板发出真实指令并看到场景被改动；导入并启用一个自定义技能并被 AI 实际读取；用 DramaClaw 现有 agent 通道真实驱动一次 `director_apply` 并落盘；关闭重开工程后该节点的工程完整恢复、而渠道与模型配置跨节点共享；`tsc --noEmit` 与导演台测试套件全绿。

PM 必须持续把任务 receipt 对照这条 oracle。规划、发现、单个切片通过、或看板看起来干净都不构成完成。只有终审 receipt 把 receipt 与验证映射回这条 oracle 并记录 `full_outcome_complete: true`，目标才算完成。

## Goal Kind

`existing_plan`

## Current Tranche

替换的**完整**主人 outcome 就是本目标本体：五层 AI 能力全部接入、agent 功能正常、节点/全局配置/相对节点保存语义正确、UI/UX 高保真、MONOFORM 从主链路移除。默认连续执行：先验证上游计划事实（哪些能力真的可搬到 Web 版、DramaClaw 现有 agent 协议形状、现有 vendored 构建链），再按依赖顺序连续交付最大可验证切片，直到完整 outcome 达成。

## Non-Negotiable Constraints

- **完全替换**：新导演台节点的主链路不得再指向 MONOFORM；旧 vendor/产物在终审通过后清理
- **五层 AI 能力全部接入**：AI 对话面板、18 个工具、内置技能包、自定义技能管理、提示词工程产出，一层都不能少
- **节点形态**：导演台是画布节点，遵循 DramaClaw 现有节点契约（尺寸、选中、属性面板、端口）
- **配置全局**：模型渠道、密钥、自定义技能属于全局设置，跨节点共享，不随节点复制
- **保存相对节点**：`.director` 工程数据挂在节点上，随工程存/取，不进全局
- **agent 兼容**：现有 Hermes ACP / `dd-scene` 链路必须继续可用，且要能用上比离线 JSON 更强的在线工具能力
- **UI/UX 高保真**：不得出现降级、灰掉、裸 iframe、样式割裂的界面
- **许可合规**：所有第三方素材逐条过 DramaClaw 的 `license-inventory` 硬门
- **生产可用**：dev 与 prod 行为一致，不得依赖 `import.meta.env.DEV`
- **不破坏既有**：360 导演台、自建 3GS 取景器、聊天归档路由 `api/v1/chat/director-desk/restore` 一律不动

## Stop Rule

只有终审证明完整主人 outcome 完成才停。

主人要的是能用的软件，不是方案。规划、发现、Judge 选型都不是终点。

单个验证通过的 Worker 切片之后，继续推进下一块最大的可逆本地切片，直到完整 outcome 达成，除非到了阶段、风险、被拒验证、歧义或终审边界。

不要为重复同形的文件/表格/路由/助手函数逐个建 Worker/Judge 对。把同形工作打包成一个 Worker 切片，整体评审。

不要因为某个切片需要主人输入、凭证、生产访问、破坏性操作或策略决定就停止。把那个切片标 blocked 并留 receipt，然后继续所有能推进目标的本地非破坏性工作。

## Slice Sizing

Safe means bounded, explicit, verified, and reversible. It does not mean tiny.

Worker 应当交付**可用的纵向切片**：一条真正跑通的浏览器到工程的链路，一个真的能对话的导演台面板，一个真的能落盘的 agent 通道。

连续的 micro-slice（只加 helper / 只加类型 / 只加测试 / 只写文档）在破坏里程碑时必须停下重新看板。

## Board Health

```bash
node /Users/mac/.claude/skills/goal-prep/scripts/check-goal-state.mjs docs/goals/director-desk-v2-replacement
```

## Canonical Board

`docs/goals/director-desk-v2-replacement/state.yaml`

## Run Command

```text
Claude Code: /goalbuddy Follow docs/goals/director-desk-v2-replacement/goal.md.
```

## PM Loop

1. 读本 charter 与 `state.yaml`
2. 跑 `check-update.mjs`（有新版提一句，不阻塞）
3. 复核 intake：原始请求、input shape、authority、proof、blind spots、likely misfire
4. 只做 active task
5. 按任务卡分派 Scout / Judge / Worker / PM
6. 写紧凑 receipt
7. 更新 board
8. 有安全本地工作就继续下一块最大可逆 Worker 切片
9. 需要落成 issue/PR 的问题不要消失在对话里
10. 只在阶段/风险/被拒验证/歧义/终审边界评审
11. 结束本轮前跑 `check-can-stop.mjs`，非零就继续