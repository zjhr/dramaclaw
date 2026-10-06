# T002 · 接入架构决策

任务类型：Judge（只读决策）
时间：2026-10-03
决策：`approved`，四个决策点全部收敛，无需主人拍板

---

## 0. 一句话结论

**vendored 全量改造 + 工具层双通道（postMessage 给宿主 / MCP 给 agent）+ AI 宿主循环搬进 DramaClaw 后端。** 最小改动面 4 处约 30 行，**不需要动上游 `main.ts`**，不依赖 `import.meta.env.DEV`。

---

## 1. Judge 补上的三个决定性事实（T001 未覆盖）

### 1.1 `window.directorDesktop` 是完整声明的接口，注入 shim 即可绕过禁用分支

`src/automation/desktop-types.ts:9-29` 声明了 19 个方法（全部可选签名）：

```ts
interface Window { directorDesktop?: {
    skills?(data: SkillRequest): Promise<DesktopResult<SkillResult>>;
    files?(action: 'locations'|'choose'|'save-project'|'save-export', data?): Promise<...>;
    onSaveBeforeClose?(cb: () => Promise<boolean>): () => void;
    update?(action: 'state'|'save'|'check'|'download'|'install'|'page', data?): Promise<...>;
    onUpdate?(cb): () => void;
    profiles(): Promise<DesktopResult<Channel[]>>;
    conversation(): Promise<DesktopResult<ConversationSnapshot>>;
    newConversation(): Promise<DesktopResult<ConversationSnapshot>>;
    configure(data: Record<string, unknown>): Promise<DesktopResult<Channel[]>>;
    test(id: string): Promise<DesktopResult>;
    run(data: Record<string, unknown>): Promise<DesktopResult>;
    stop(): Promise<DesktopResult>;
    mcp(enabled?: boolean): Promise<...>;
    mcpLan(enabled?: boolean): Promise<...>;
    copyMcp(client?, useLan?): Promise<DesktopResult>;
    copyText?(text: string): Promise<DesktopResult>;
    resetMcp(): Promise<...>;
    onEvent(cb: (event: AgentEvent) => void): () => void;
    onTool(cb: (name, args) => Promise<unknown>): () => void;
} }
```

`ai-panel.ts:82` 的禁用分支**只看它是否为真值**。这意味着「让面板不灰」不需要改上游 UI 一行。

**PM 修正**：Judge 表述为「注入真值 shim 即整块面板复活」不完整。19 个方法里 `onTool`/`files` 属工具通道，`profiles`/`run`/`stop`/`test`/`onEvent`/`skills` 属 AI 通道，后者必须有真实实现（`run` 要真的驱动 agent 循环，`skills` 要真的落盘）才有意义。空壳 shim 会让面板从「灰掉」变成「点了没反应」，那是更糟的 UX。

→ 已在 `worker_package.pm_amendment` 中固化：AI 通道方法必须显式返回明确失败。

### 1.2 上游无 vite.config，dist 走绝对 `/assets/`（PM 已独立复核）

```
$ ls vite.config.*
ls: vite.config.*: No such file or directory

$ node -e "console.log(require('./package.json').scripts.build)"
tsc --noEmit && vite build

$ grep -oE '(src|href)="[^"]*"' index.html
href="/favicon.svg"
src="/src/main.ts"
```

宿主 `frontend/dist/assets` 与上游 dist 同名，且 nginx `location /assets/` 已被宿主占用。**不改 `base` 就是静默 404，且 dev 看不出来。**

### 1.3 nginx 是 prod-only 的 iframe 杀手

`location /` 带 `X-Frame-Options: DENY` + CSP `script-src 'self' '<sha256>'` + `frame-ancestors 'none'`。dev 无这些头所以本地能跑，prod 必挂。新路径必须自开 location 段并给独立 CSP 与 `frame-ancestors 'self'`。

---

## 2. 四个决策点

### 决策 1：接入路径 = (a) vendored 全量改造

选 (a) 而非纯产物方案：**内置技能包由 `prebuild` 的 `build-builtin-skill.mjs` 从 `skills/director-desk/` 生成 `builtin-skill.json` 再注入 `createSkillStore`**。纯产物方案拿不到生成步骤，就得手工维护 70KB JSON，且每次跟版都要重做——那是 (b) 的真实代价。

(a) 的负担只是照抄 MONOFORM 已验证的 `npm ci && npm run build && cp -r dist/.`。

**最小改动面 = 4 处，约 30 行，全在新增文件里：**

| 文件 | 改动 |
|---|---|
| `frontend/vendor/director-desk/vite.config.ts` | 新建，~6 行，`base: './'` |
| `frontend/vendor/director-desk/index.html` | +1 行 shim script |
| `frontend/vendor/director-desk/src/host-bridge.ts` | 新建，实现 19 方法接口 |
| `src/main.ts` | **0 行** |

`main.ts` 不动的机制：shim 在 `main.ts` 模块执行前同步装好 `window.directorDesktop`，`main.ts:318` 的 `window.directorDesktop?.onTool(...)` 自动接上 `toolService`。

**不碰 `import.meta.env.DEV` 门禁、不暴露 `__director`**：宿主桥走 `window.directorDesktop` 这条上游本就打算给宿主用的通道，`__director` 是调试口，prod 不需要它。这同时满足「不得依赖 `import.meta.env.DEV`」。

### 决策 2：工具层暴露 = (c) 双通道，共用一个 toolService

不是两套工具实现。

- **宿主 UI → postMessage**：复用 `directorDeskBridge.ts` 的 requestId / pending 表 / 来源校验形状
- **外部 agent → MCP 工具 `director_desk_call`**：经 DramaClaw 已有 MCP 链路

MCP server 在 Node、iframe 在浏览器，两者不通，**桥是唯一通路**：

```
agent
 → dramaclaw_mcp.py
 →(HTTP) 后端 director_desk 路由
 →(WS /chat/ws，已存在且已鉴权)
 → 浏览器宿主
 →(postMessage) iframe toolService.call
 → 原路返回
```

**调用跳数：agent 工具调用 = WS 下行 1 跳 + postMessage 1 跳 = 2 跳到达工具，回程同样 2 跳。**

成立前提是 WS 已在跑：`chat.py` 的 `/chat/ws` 逐用户一条、`_authenticate_ws` 已鉴权。agent 通道不需要新建传输层，只需在该 WS 上多发一种帧。

**否决 iframe 内起 MCP server**：只能走 stdio/HTTP 暴露给外部进程，等于把 Node 运行时和 Electron 依赖拖回浏览器侧，且与已有 MCP 链路重复。

超时沿用上游 60s 语义与 `execution: 'unknown'` 的页面重载保护。

### 决策 3：MONOFORM 分支 = (c) 部分复用

新节点主链路完全走 director 引擎。`engine: 'monoform'` 分支从 `directorDeskSkills.ts` 默认位撤下，但**保留代码与分支开关**。

**这不违反「完全替换」**——约束原文是「新导演台节点的主链路不得指向 MONOFORM」，主链路换了即达标。保留分支是为了不破坏既有 MONOFORM 节点里已存的工程（`.director` 单向迁移不可逆）。

**语音气泡**：不靠保留双轨保住，而是**移植成 director 侧的一个表现层**。`speechBubble.js` 的定位/朝向/时长逻辑与引擎无关，改为读 `director_read` 返回的拍点与角色，在导演台 UI 上叠加渲染气泡。能力不丢，代价是新增一层渲染代码。

**`applyDirectorSceneIntent` 的接法**：旧函数是「拿已有工程整体覆盖」（`(project, intent) -> DeskProject`），新接口是「对当前工程施加增量操作」（`director_apply(operations[])`）。正确接法是弃用它的返回值语义，新增 `toDirectorOperations(intent) -> Operation[]` 调 `director_apply`；`applyDirectorSceneIntent` 降级为 MONOFORM 分支专用。

**工程真值永远在 iframe 里，宿主不再持有 `DeskProject` 副本。**

### 决策 4：AI 宿主位置 = (d) 混合

**内置面板的 agent 循环搬进 DramaClaw 后端**（不是 iframe 直连，也不是复用 Hermes），**工具执行一律留在 iframe**。

**不复用 Hermes**：`hermes_sdk.py` 里 `_DIRECTOR_DESK_TOOLS` 白名单刻意只留 `dramaclaw_post/get/...` 五条写入口，设计上就是防 agent 穿透。而面板要的是上游那套 execute/discuss 双模式 + `isDiscussionToolCall` 二次校验 + `REVISION_CONFLICT` 断轮语义。复用 Hermes 等于把 DramaClaw 的安全边界拆了。

**不能 iframe 直连模型**：密钥不能进浏览器。

循环体照搬 `ai-host.cjs`（纯 fetch + 纯 JSON，T001 已证不依赖 electron），落点 `src/novelvideo/director_desk/ai_host.py`；`callTool` 一律经 WS 回 iframe。

---

## 3. 架构分层

```
┌─ 浏览器标签页 ────────────────────────────────────────────────┐
│  React 画布                                                   │
│   └─ DirectorDeskNode（宿主壳：弹窗 / iframe / 尺寸 / 会话）  │
│        │① iframe src=/director-desk-v2/?node_id=…            │
│        │  ② postMessage 桥 directorDeskBridge.ts（扩展 4 action）│
│        ▼                                                      │
│   ┌─ iframe（同源 /director-desk-v2/）────────────────────┐    │
│   │  host-bridge.ts ← 注入 window.directorDesktop（19 方法）│   │
│   │  main.ts:317 toolService ── 18 个 director_* 工具        │   │
│   │  engine (three.js) ─ spatial/stride/path_surface 采样     │   │
│   │  AI 面板 / 技能面板 / 提示词面板（上游原生 UI，不改）      │   │
│   └──────────────┬──────────────────────────────────────────┘   │
│   WebSocket /chat/ws（既有，已鉴权）──┐                         │
└─────────────────────────────────────┼──────────────────────────┘
                                      │ ③ 工具调用帧（backend→browser）
┌─ DramaClaw 后端（Python）────────────▼──────────────────────────┐
│  api/routes/director_desk.py   ← 新增：导演台专用路由           │
│  director_desk/ai_host.py      ← 新增：agent 循环（搬 ai-host） │
│  director_desk/skill_store.py  ← 新增：技能落盘（搬 store.cjs） │
│  model_gateway_settings.py     ← 既有：全局渠道/密钥            │
│  chat/hermes_pool.py + dramaclaw_mcp.py ← 既有：MCP stdio      │
│  freezone/canvas_store.py      ← 既有：按 node_id 落盘         │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. 宿主桥协议

复用既有 `storyai:director-desk-*` 消息名与 requestId 配对表，**新增 4 个 action 全走同一个 `storyai:director-desk:request` / `:response` 通道，不新开协议**：

| action | 请求 | 响应 | 用途 |
|---|---|---|---|
| `tool.call` | `{ name, args }` | `{ok, data\|error, revision}` | 调 `toolService.call`。**工具面唯一入口，宿主 UI 与 agent 共用** |
| `project.save` | `{ document }` | `{ok, ref}` | 落 `.director` 到该 node（保存相对节点） |
| `project.load` | `{}` | `{ok, document}` | 回灌工程（关重开恢复） |
| `skills.sync` | `{ entries }` | `{ok}` | 技能清单/启用态同步给宿主展示 |

**与现有 `directorDeskBridge.ts` 的差异**：现有 8 个 action 是「宿主问导演台要什么」，新增 4 个里 `tool.call` 是**宿主驱动导演台动作**——方向反转，且它是本目标的核心。

白名单纪律照旧：`ACTIONS` 常量 + capabilities 双向声明 + origin 与 contentWindow 双校验。

---

## 5. 三个落点

### 配置全局

- **模型渠道与密钥**：`src/novelvideo/model_gateway_settings.py`（既有全局单例 `get_model_gateway_settings` / `save_newapi_provider_channels`）。**不新建 `ai-channels.json`**——那是上游 Electron 的 per-user 文件，与「配置全局、跨节点共享」冲突。
- **自定义技能**：新增 `src/novelvideo/director_desk/skill_store.py`，落 `<director_desk_root>/skills/`，**不放项目目录**（跨工程跨节点共享，这是「全局」的另一半）。沿用上游包格式（`SKILL.md` + 相对路径附件），`MAX_FILES 1000` / `MAX_BYTES 50MB` 不变。

### 保存相对节点

- `.director` 工程：`DirectorDeskNodeData.directorProjectRef`（既有字段，`nodeRegistry.ts:600-620` 已有 `directorProjectRef: null`）→ 项目资产 URL，随画布 JSON 存/取。模式与 `canvas_store.py:33/49/60` 已验证的 node_id 落盘一致，删节点清库。
- 对话：沿用 `chat.py:165` restore 与 `<state>/director-desk-chat/<node_id>/`，**不动**。

### 生产可用

新路径自开 `location ^~ /director-desk-v2/` 段，给独立 CSP 与 `frame-ancestors 'self'`。

---

## 6. PM 对 Judge 的修正

| 项 | Judge 表述 | PM 修正 | 理由 |
|---|---|---|---|
| shim 边界 | 「注入真值 shim 即整块面板复活，无需改上游 UI 一行」 | 只绕过禁用分支。19 方法中 `onTool`/`files` 属工具通道需真实实现；`run`/`profiles`/`test`/`stop`/`onEvent`/`skills` 属 AI 通道，本切片必须显式返回明确失败 | 空壳 shim 让面板从「灰掉」变「点了没反应」，是更糟的 UX |
| 上游 dist 路径 | 「dist 资源是绝对 `/assets/`」 | 已独立复核确认（无 vite.config、index.html 用绝对路径） | 影响 verify 必须含反向 grep |
| 切片范围 | 第 1 块交付后主人能用工具 | 不变，但需明示 **AI 面板此时仍降级**，属预期且由第 2 块承接 | 避免主人误以为五层已全通 |

---

## 7. 切片序列（5 块）

| # | 内容 | 做完主人能做什么 |
|---|---|---|
| **1** | vendored + 宿主桥 + nginx + 一条真实工具链路 | 打开节点跑上游原生导演台，发一次 `director_apply` 场景真被改并落盘，重开还在 |
| 2 | AI 宿主：后端 agent 循环 + 真实 shim 的 AI 通道 + 技能落盘 | 在**上游原生 AI 面板**里发指令，看到场景被改 |
| 3 | MCP 工具面：注册 `director_desk_call` + WS 工具调用帧 | Hermes 能真实驱动 18 个工具并落盘 |
| 4 | dd-scene 迁移：`toDirectorOperations` + engine 收敛 + 语音气泡移植 | 现有 agent 对话链路直接驱动新导演台 |
| 5 | 提示词双稿贯通 + 清账（license 992 条死条目、补 monoform、nginx 补段、注释更新） | 提示词产出可用，账目干净 |

每块做完都有可验证的主人视角价值，不是 micro-slice。

---

## 8. 风险

| 风险 | 缓解 |
|---|---|
| base 漏改 → 资源 404 | 新写 vite.config 设 `base:'./'`，verify 含**反向** grep 断言无绝对 `/assets/` |
| CSP 阻断 iframe（prod-only 最隐蔽故障） | 新路径自开 location 段 + 独立 CSP + `frame-ancestors 'self'`，不得只改前端 |
| shim 装晚了 → 18 工具静默失联 | shim 在 main.ts 模块执行前同步安装，verify 断言产物含 `directorDesktop` |
| 引擎工具在无浏览器会话时空转 | 后端对无活跃会话返回明确错误（沿用 `execution:'unknown'` 语义），不得静默超时 |
| 语音气泡移植超预期 | 第 4 块内单独处理，不阻塞前四块 |
| 跟版成本（上游单人维护、4 提交者） | `PATCHES.md` 逐条记补丁（照 MONOFORM 格式），锁 v0.4.10 |