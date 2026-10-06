# T001 · 上游 AI 能力实测 + DramaClaw 侧落点地图

任务类型：Scout（只读）
时间：2026-10-03
执行者：Scout subagent（上游侧）+ PM（DramaClaw 侧复核与架构判定）

---

## 0. 一句话结论

**上游 18 个 `director_*` 工具与渲染引擎强耦合，无法搬到 DramaClaw 后端；工具层必须留在 iframe 内的浏览器里，宿主经 postMessage 桥调用。** 这与 MONOFORM 现有的 `directorDeskBridge.ts` 是同一形状，宿主侧改造可复用既有模式。

上一会话的三条假设中有两条被实测证伪（导出路径、DEV 门禁范围），一条被降级（技能存储耦合度）。

---

## 1. 上游构建实测

```bash
cd /tmp && git clone --depth 1 https://github.com/mangfufu/director-desk.git mdf-desk
cd mdf-desk && npm ci --no-audit --no-fund && npm run build
```

结果：exit 0，`✓ built in 517ms`，`dist` 5.3MB。最大单项 `humanoid-v1-DqkEQiwj.js` 2.80MB（gzip 981KB），`index` chunk 1.06MB（gzip 387KB），共 17 个 chunk。

postbuild 三步全过：
- `Built versioned embedded director skill`
- `Privacy check passed: 25 allowlisted web files`

运行时依赖仅 `mediabunny` 1.55.7 + `three` 0.185.1，均已打进 dist。

> 上游自己维护了一份「哪些文件可进 Web 产物」的白名单（25 项），可直接作为 vendored 白名单参考。

---

## 2. 五层能力逐项实测

### A. 18 个工具在生产产物中完整存活

实测：
```bash
grep -ohE "director_[a-z_]+" dist/assets/*.js | sort -u | wc -l   # = 18
```

清单：`director_apply / assets / continuity / export / help / history / job / media / motions / nodes / path_surface / read / scene / skill / spatial / stride / view`

源头对照 `src/automation/contract.ts` 同为 18 个字符串字面量，两边完全一致。**生产构建零裁剪。**

工具定义源头：`src/automation/contract.ts`（`FULL_TOOL_DEFINITIONS` 17 个 + `director_help` 1 个）

统一返回信封（`src/automation/service.ts:221-224`）：
```ts
{ ok: true, data: ... }  |  { ok: false, error, revision }
```
写操作通过 `sequence` Promise 链串行化，保证不交错。

### B. `__director` 宿主 API 被 DEV 门禁整块剔除

源码位置：
- `src/main.ts:317` — `const toolService = createToolService(uiContext);` **顶层无条件执行**，不在门禁内
- `src/main.ts:318` — `window.directorDesktop?.onTool(...)` 可选链
- `src/main.ts:345` — `if (import.meta.env.DEV) {`
- `src/main.ts:347` — `Object.assign(window, { __director: {...} })` 全部 9 个方法（`callTool / getProject / getDocument / getEngine / setTime / setPreview / replaceProject / signature / exportForTest`）都在此块内

实测：
```bash
grep -oE ".{0,60}__director.{0,120}" dist/assets/*.js   # 无输出
```

**生产产物中 `__director` 字符串 0 命中。**

> 修正上一会话结论：门禁挡住的是调试口本身，工具服务与工具层完全保留。

### C. 内置 AI 面板在 Web 版降级

`src/ui/ai-panel.ts:10` — `const bridge = window.directorDesktop;`（Web 下 undefined）

`src/ui/ai-panel.ts:82` — 无 bridge 时把除 `ai-close` / `ai-collapse` / `ai-scene-prompt` / `ai-scope-toggle` 及带 `data-aiView` 元素外的**全部 `input,select,textarea,button` 置 `disabled`**。面板外壳与查看类视图仍活着，模型选择/发送/测试/通道配置全死。

**关键利好（降低改造难度的核心事实）：**
- `desktop/ai-host.cjs` 与 `desktop/providers.cjs` **都不 `require('electron')`**
- `safeStorage` 是**入参**不是内部 require：`createAIHost({ directory, safeStorage, definitions, ... })`，由 `desktop/integration.cjs:28` 从 electron 解构后注入
- `providers.cjs` 只用 `fetch`（`:125`）、`performance`
- 协议白名单 `['chat', 'responses', 'anthropic']`（`providers.cjs:26`）
- endpoint 后缀映射（`providers.cjs:37`）：`chat → /chat/completions`、`responses → /responses`、`anthropic → /messages`
- Anthropic 走 `x-api-key` + `anthropic-version: 2023-06-01`（`providers.cjs:122`）
- 三种协议各有 SSE 解析与 `tool_result` 回填分支（`:134 / :148 / :149`）

> AI 宿主逻辑是纯 fetch + 纯 JSON，**可直接搬到 DramaClaw 后端 Node 侧**。

agent 循环（`desktop/ai-host.cjs`）：
- `maxRounds` 默认 64，可设 0 为无限轮
- 双模式：`execute`（全工具）/ `discuss`（只读 13 工具），且**执行层二次校验** `isDiscussionToolCall`（`contract.ts:53-60`）
- 非法 JSON 重试上限 2 次（`ai-host.cjs` `invalidArguments > 2` 抛错）
- `REVISION_CONFLICT` → `break` 出本轮工具循环，让下一轮重读最新状态

### D. MCP 的 Electron 耦合程度

调用链：
```
desktop/mcp-host.cjs:24
  → desktop/mcp-server.cjs:6  startMcp(definitions, call, version, {port, token})
  → desktop/integration.cjs:22-23  window.webContents.send('director-tool-call', {id,name,args})  // 60s 超时
  → desktop/preload.cjs:21-22  ipcRenderer.on('director-tool-call') → 渲染侧 toolService.call
  → 'director-tool-result' → desktop/integration.cjs:32  resultHandler
  → 渲染侧入口 src/main.ts:318
```

MCP server 仅 42 行（`desktop/mcp-server.cjs`），除 `call` 外的全部附加逻辑：
- `import { timingSafeEqual } from 'node:crypto'`（`:2`）
- `StreamableHTTPServerTransport`（`:4`，`:26` 无 session，JSON 响应）
- host / origin 校验 + `Bearer ${token}` 定长比较，不等长直接 403（`:11-12`）
- `desktop/integration.cjs:64-65` 页面重载/关闭时把 pending 全部 reject 成 `execution: 'unknown'`，提示模型「不要直接重复写入」

`desktop/tools-contract.cjs` 需由 `scripts/prepare-desktop.mjs:52`（esbuild，platform node）从 `contract.ts` 生成。

> **传输层与工具语义完全解耦。** 但工具执行依赖 `ctx.engine`（见第 5 节），所以这层不能搬到 Node 后端，只能在 iframe 内。

### E. 技能管理

Web 降级文案（`src/ui/ai-skills-panel.ts:70`）：
> `'自定义技能管理在桌面版使用。网页版可导入外部 AI 按技能生成的工程。'`
> 紧接 `disabled()`

存储（`desktop/skills/store.cjs`）：
- `createSkillStore({ directory, builtin })`（`:6-7`），root = `path.join(directory, 'skills')`，index = `root/index.json`
- 原子写 `{mode: 0o600}` + rename（`:24`）
- realpath 防目录逃逸（`:75-79`）
- **纯 fs/JSON，不依赖 `safeStorage`**（`safeStorage` 只用于 AI 渠道 API key，`ai-host.cjs:29-30`）

硬 Electron 依赖仅一处（`desktop/skills/host.cjs:1`）：
```js
const { dialog, shell } = require('electron')
```
import 需系统文件选择框、open 需 `shell.openPath`。

限制（`desktop/skills/package.cjs:6`）：`MAX_BYTES = 50MB`、`MAX_FILES = 1000`
路径校验 `:13/:20/:52/:61`；无 `SKILL.md` 报错 `:61`

GitHub 安装（`desktop/skills/github.cjs`）：走 GitHub REST 目录树 API 逐文件下载并校验 size，目录遍历请求数上限 `MAX_FILES+100`（`:19`），`https://github.com` 独占（`:5`），支持 `/blob/.../SKILL.md` 与目录链接两种形态（`:9-10`）

> **改造面小**：fs → DramaClaw 后端文件系统 + multipart 上传；dialog/shell → `input[type=file]` / `webkitdirectory` + 后端打开目录。包格式（SKILL.md + 相对路径附件）无需改。

### F. 导出路径（上一会话结论被证伪）

`director_export` 工具（`src/automation/service.ts:203-217`）在所有 kind 下**都不碰** `window.directorDesktop`：

| kind | 实现 |
|---|---|
| `project` | `ctx.saveProject()` → `{status:'save-requested'}` |
| `screenshot` | `await ctx.snapshot()` → `{status:'save-requested'}` |
| `bundle` | `createZip(...)` → `download(zip, name+'-制作素材包.zip')` |
| `video` / `depth-video` | `exportVideo(ctx.engine, {...})` → `download(blob, name+'.mp4')` |

`download`（`src/storage.ts:39`）是纯浏览器 `<a download>` 触发器：
```ts
const url = URL.createObjectURL(blob), a = document.createElement('a');
a.href = url; a.download = name; a.click();
```

**真正会在 Web 版抛 `桌面文件服务不可用` 的是另一条路径** `src/exporting/delivery.ts:35-36`（批量导出交付，落盘必须经 desktop files 服务）。这是**交付面板**，不是 agent 工具。

另：`src/ui/video-panel.ts:97` 用 `window.directorDesktop?.files` 决定是否显示「默认目录」选项，Web 下静默降级（无报错）。

> 实现时需区分对待：`director_export` Web 可用，`delivery.ts` 需另接。

### G. 技能包内容清单

| 文件 | 行数 | 字节 |
|---|---|---|
| `SKILL.md` | 27 | 2502 |
| `references/camera.md` | 40 | 9245 |
| `references/editing.md` | 38 | 7001 |
| `references/media.md` | 21 | 4950 |
| `references/online-workflow.md` | 31 | 4164 |
| `references/project-format.md` | 178 | 25895 |
| `references/prompt-writing.md` | 123 | 16548 |
| **合计** | **458** | **70305** |

另有 `LICENSE` (1103B)、`assets/`、`scripts/project-tool.mjs`。

`src/automation/builtin-skill.json` 73023B / 13 行（单行 JSON），由 prebuild 钩子 `scripts/build-builtin-skill.mjs` 从该目录打包生成，经 `createSkillStore({ builtin })` 注入。

> **vendored 构建必须保留 prebuild 钩子，否则内置技能包缺失。**

提示词双稿（`src/production/prompts.ts`）：
```ts
:6  export const promptModes = ['reference-video', 'text-only']
:8  export const promptField = mode => mode === 'text-only' ? 'textOnlyPrompt' : 'promptText'
```
消费端 `src/ui/production-panel.ts:78` 写 `project.production[promptField(promptMode)]`；`:138` 切模式时 `ctx.change(() => { production.promptMode = mode }, false)`

### H. 许可与素材来源

- 根 `LICENSE` = MIT，`Copyright (c) 2026 DirectorDesk contributors`；`package.json` 亦标 `"license": "MIT"`
- 动作库：`src/animation/library/NOTICE.txt:1-6` — **Quaternius Universal Animation Library, Standard collection**，`License: CC0-1.0 (public-domain dedication)`；`:8-12` 说明是十选一裁剪衍生版（white materials、重命名解剖节点、删除未用动作与 UV）
- **上游仓库内无 `license-inventory.csv` 或等价清单**，第三方声明只有 `NOTICE.txt` 一处 + `desktop/licenses/`（构建期目录）
- `src/storage.ts` 的 `download()` 是纯本地 blob 触发器，**模型/资产无自动远程下载路径**

> 三方均为宽松许可（MIT + CC0-1.0），商用无障碍。

### I. vendored 可行性

**宿主已预留路径**：`frontend/vite.config.ts:108`
```ts
const vendoredDesks = ["director-desk", "monoform-desk"];
```

DramaClaw 现有流程（`frontend/vendor/monoform/PATCHES.md`）：源码 vendored + PATCHES.md 逐条记补丁 + `pnpm build` + `cp -r dist/. ../../public/monoform-desk/`

上游构建链比 MONOFORM 更标准（`tsc --noEmit && vite build`，prebuild/postbuild 三个 node 脚本），适用于同一套流程。

---

## 3. 架构判定：工具层不能搬到后端（PM 复核，非 Scout 结论）

Scout 建议「自建 HTTP 端点直调 `createToolService().call()` 可 100% 复刻全部 18 个工具功能」。**PM 复核后否决这一条。**

`src/automation/service.ts` 对 `ctx` 的能力引用统计：

| ctx 成员 | 引用次数 |
|---|---|
| `ctx.project` | 20 |
| **`ctx.engine`** | **20** |
| `ctx.scenes` | 18 |
| `ctx.busy` | 11 |
| `ctx.updateTimeUI` | 7 |
| `ctx.history` | 4 |
| `ctx.time` / `ctx.playing` | 3 / 5 |
| `ctx.change` / `ctx.draft` | 2 / 2 |
| 其余（`snapshot` `saveProject` `selectEntity` `seek` `revision` `renderCameras` `applyDocument` `switchScene` `act` `preview`） | 各 1 |

`ctx.engine` 是 Three.js 渲染引擎。绑定实例的实测证据：

- `service.ts:113-115` — `ctx.engine.sample(time)` / `ctx.engine.externalModels.nodes(...)`：真实采样与模型节点查询
- `service.ts:57-58` — `ctx.engine.surfaces.textures.statistics()` / `ctx.engine.surfaces.describe(root)`
- `service.ts:134` — `pathSurfaceModels(ctx.engine)`：路径贴面检查需要真实网格
- `service.ts:137` — `ctx.engine.externalModels.estimateStride(entity, clipId)`：步幅测量需要已加载骨架
- `service.ts:154-155` — `ctx.engine.externalModels.prepare(after)` / `assertReady(after)`
- `service.ts:179` — `ctx.engine.spatialReport(...)`：空间查询需要遮挡射线
- `service.ts:185` — `scanSpatialRange(ctx.engine, ...)`
- `service.ts:212` — `exportVideo(ctx.engine, {...})`：导出需要渲染

**另有 DOM 依赖**：`service.ts:87 / :196` 使用 `document.createElement('button')`。

### 判定

**工具层必须活在 iframe 的浏览器渲染进程内，与渲染引擎同域。** 宿主（DramaClaw）不能在后端调它，只能经 postMessage 桥向 iframe 请求。

这与 MONOFORM 现有的 `directorDeskBridge.ts`（17.8KB，协议白名单 + postMessage）是同一形状，宿主侧改造可复用既有模式。

MCP 那层的价值也随之明确：**若要让 DramaClaw 的 agent 走 MCP 协议，MCP server 进程必须能驱动 iframe**，而不是在 Node 后端重建工具层。这是 Judge 决策点。

---

## 4. DramaClaw 侧落点（PM 实测）

### 4.1 既有删除的完整性与一处漏网

上一会话 `git rm` 了 `frontend/public/director-desk/`（992 文件 / 80MB）。

| 配置 | 状态 |
|---|---|
| `frontend/docker/nginx.conf.template` | 已删 `location ^~ /director-desk/` 整段（diff 确认，`git diff` 有输出） |
| `frontend/vite.config.ts:108` | **未改**。`vendoredDesks = ["director-desk", "monoform-desk"]` 仍指向已删目录（`git diff frontend/vite.config.ts` 为空） |
| `license-inventory.csv` | 仍保留 992 行 `frontend/public/director-desk/*` 条目 |

### 4.2 nginx 缺 `/monoform-desk/` 配置段（既有生产 bug）

```bash
grep -nE "^\s*location" frontend/docker/nginx.conf.template
# 46:  location / {          ← 全局，含 X-Frame-Options: DENY (line 59)
# 86:  location ~ org-brand logo
# 103: location /assets/
# 115: location /api/
# 141: location /static/
# 163: location = /healthz

grep -c "monoform" frontend/docker/nginx.conf.template   # = 0
```

**MONOFORM 节点在生产环境的 iframe 会被全局 `X-Frame-Options: DENY` 挡住。** 本地 dev 无安全头所以能跑。此 bug 独立于本次替换，但新路径 `/director-desk-v2/` 必须配齐自己的 location 段。

### 4.3 许可清单既有红（与本次删除无关）

```bash
.venv/bin/python -m pytest tests/test_p0b_compliance_generator.py::test_license_inventory_covers_current_git_index -q
# 1 failed
```

失败项为一批 `git ls-files` 有但 inventory 无的路径（`src/novelvideo/ingest/*.py`、`tests/test_zero_write.py` 等）。抽查 3 个：

| 文件 | 是否在 HEAD |
|---|---|
| `src/novelvideo/ingest/zero_write.py` | 在 HEAD → **既有红** |
| `tests/test_zero_write.py` | 在 HEAD → **既有红** |
| `tests/test_chat_scope_director_desk.py` | 在 HEAD → **既有红** |

> 该测试只检查「git 有而 inventory 无」，不检查反向。删除 992 个文件不会让 `missing` 增加，故本次删除未加剧此红。但 inventory 中的 992 条 director-desk 行已成死条目，需在清理阶段一并处理。

注：`license-inventory.csv` 中 **monoform 条目数为 0** —— 现有 vendored MONOFORM 未登记，是既有缺口。

### 4.4 节点类型与注册

- `frontend/src/features/canvas/domain/canvasNodes.ts:27` — `directorDesk: 'directorDeskNode'`
- `canvasNodes.ts:736` — `export interface DirectorDeskNodeData extends NodeDisplayData`
- `canvasNodes.ts:799` — 联合类型成员
- `canvasNodes.ts:731-736` 注释：节点本身只是一层壳，真正的编辑器在 `frontend/public/director-desk/`
- `nodeRegistry.ts:600-620` — `directorDeskNodeDefinition`，含 `directorProjectRef: null`
- `nodeRegistry.ts:696` 注册、`:846/:849`（某数组）、`:906/:909`（另一数组）

> 注释仍指向已删目录，需随替换更新。

### 4.5 `engine` 分叉已在设计中

`frontend/src/features/canvas/nodes/directorDeskSkills.ts`：
```ts
:59   export type DirectorDeskEngine = 'director' | 'monoform';
:513  engine: DirectorDeskEngine = 'director',
:517  engine === 'monoform' && (id === 'cinematic-camera' || id === 'action-blocking')
:526  engine: DirectorDeskEngine = 'director',
:528  const base = engine === 'monoform' ? MONOFORM_BASE_SKILL : DIRECTOR_DESK_BASE_SKILL;
:534  export function deskSkillsForEngine(engine: DirectorDeskEngine = 'director')
:535  return engine === 'monoform' ? MONOFORM_DESK_SKILLS : DIRECTOR_DESK_SKILLS;
```

> `director` 分支已预留但当前无对应实现。新项目落地后这是技能表的首选接入点。

文件规模：
| 文件 | 字节 |
|---|---|
| `DirectorDeskChatPanel.tsx` | 63216 |
| `DirectorDeskNode.tsx` | 59557 |
| `directorDeskSkills.ts` | 47201 |
| `MonoformDeskNode.tsx` | 39804 (892 行) |
| `directorScenePatch.ts` | 31778 |
| `directorDeskBridge.ts` | 17814 |
| `monoformCameraBeats.ts` | 14101 |
| `monoformScenePatch.ts` | 114058 |
| `DirectorSceneCard.tsx` | 6227 |

### 4.6 agent 协议：dd-scene

`DirectorDeskChatPanel.tsx` 中的词汇构造：
- `:190` 360 导演台（UE 人偶 + 运镜动画）的 dd-scene 词汇
- `:206` MONOFORM 的 dd-scene 词汇 — 三块：`characters`（人）/ `objects`（物品/粗模）/ `camera`（运镜）
- `:159` 按 `engine === 'monoform'` 分支给 agent 的写权限说明
- `:402` 「允许改动画面」总开关（默认开）；关掉后 agent 的 dd-scene 只渲染成卡片
- `:490` agent 回复里输出 ```dd-scene 块 → 解析成 intent → 宿主注入导演台
- `:501` 硬门：提示词是软约束，模型照样输出 dd-scene 时实测人物就被摆上去了

`directorScenePatch.ts` 导出面：
```
:16   DIRECTOR_SCENE_INTENT_TYPE = 'director-desk-scene'
:46   DirectorSceneCharacterIntent
:99   DirectorSceneLine
:108  DirectorScenePerformanceBeat
:137  DirectorSceneCameraIntent
:170  DirectorSceneCameraBeat
:189  DirectorScenePropType
:198  DirectorSceneDepthSettings
:213  DirectorScenePropIntent
:250  DirectorSceneIntent
:275  DIRECTOR_PROPOSALS_TYPE = 'director-desk-proposals'
:281  DirectorProposal
:294  DirectorSceneCardData
:302  summarizeDirectorSceneIntent(intent) -> DirectorSceneCardData
:400  DeskProject
:561  buildCameraKeyframes(cam, move)
:605  applyDirectorSceneIntent(project, intent) -> DeskProject
:741  hasDirectorSceneBlock(text)
:750  parseDirectorSceneIntent(text)
:761  stripDirectorSceneIntent(text)
:772  parseDirectorProposals(text)
:787  stripDirectorProposals(text)
```

> 映射落点明确：`applyDirectorSceneIntent` 是 `DirectorSceneIntent → DeskProject` 的翻译函数。新项目需要的是 `DirectorSceneIntent → director_apply operations[]`。函数签名 `(project, intent)` 暗示旧实现也产出了完整工程（`DeskProject`），这与「已有 project 对象」而非「operations 数组」匹配。

### 4.7 「保存相对节点」的后端落点已存在

`src/novelvideo/api/routes/chat.py:165` — `POST /chat/director-desk/restore`
- scope 必须是 `directorDesk` 且带 `project_id`（`:176-177`）
- 服务端目录：`<project>/<state>/director-desk-chat/<conversation_key>/`（`:441`）

`src/novelvideo/chat/store.py:6` 注释：
> directorDesk scope: one director-desk **node**'s own conversation. It lives ...

`src/novelvideo/freezone/canvas_store.py`：
- `:33` `_director_desk_node_ids(payload)` — 从画布 payload 提取导演台节点 id 集合
- `:49` `_purge_removed_director_desk_chats(project_dir, existing, payload)`
- `:60` 注释：对话库在 `<state>/director-desk-chat/<node_id>/`
- `:812 / :871` 保存画布时触发清理

> **对话已按 node_id 落盘，且删节点会清库。** 「保存相对节点」的语义在对话侧已完整实现，可直接复用为 `.director` 工程数据的落点模式。

恢复逻辑（`chat.py:165-215`）：删节点清库后，撤销把节点加回来时从 IndexedDB 暂存重放（上限 50 条，文本截 20000 字），库里已有内容则跳过。

### 4.8 全景能力命中（勿误删）

`src/novelvideo/api/routes/freezone.py:5171` — `GET /projects/{project}/freezone/director-desk-panorama`
`:5184` 注释「不碰项目场景资产」，产物落在 `director_desk_panorama/<node_id>/<job_id>`

> 这是活代码，与被删的静态目录无关。

---

## 5. 待修项与决策点

### 待修（已确认，非阻塞架构决策）

| # | 项 | 证据 |
|---|---|---|
| F1 | `vite.config.ts:108` `vendoredDesks` 含死路径 `"director-desk"` | `git diff` 为空 |
| F2 | `license-inventory.csv` 992 条 director-desk 死条目 | `grep -c` = 992 |
| F3 | `canvasNodes.ts:731-736` 注释指向已删目录 | 源码 |
| F4 | nginx 缺 `/monoform-desk/` 段（既有生产 bug） | `grep -c monoform` = 0 |
| F5 | `license-inventory.csv` 无 monoform 条目（既有缺口） | `grep -c monoform` = 0 |
| F6 | 合规测试 `test_license_inventory_covers_current_git_index` 既有红（与本任务无关） | pytest failed，抽查项均在 HEAD |

### 决策点（交 T002 Judge）

1. **接入路径**：vendored 全量改造（含 prebuild 钩子 + postMessage 桥）／ 静态产物 + 自建 shim ／ 混合
2. **工具层暴露方式**：iframe 内 postMessage 桥 ／ iframe 内自建 MCP server（stdio 桥给外部 agent）／ 双通道
3. **`monoformScenePatch.ts` 114KB 的复用边界**：保留 MONOFORM 分支还是整体替换
4. **AI 宿主位置**： DramaClaw 后端 Node 侧跑 `ai-host.cjs` + `providers.cjs` 逻辑 ／ 复用现有 Hermes ACP ／ 前端 iframe 内直连模型

---

## 6. 结论对 oracle 的映射

| Oracle 断言 | 当前状态 |
|---|---|
| 新节点能打开 | 未开始。路径已预留（`vite.config.ts:108`），产物未构建 |
| 内置 AI 面板真实对话并改动场景 | 未开始。面板 Web 降级已确认；`ai-host.cjs` 可搬（纯 fetch）已确认 |
| 自定义技能导入/启用/被读取 | 未开始。存储层纯 fs 已确认可改造；硬依赖仅 dialog/shell |
| agent 真实驱动 `director_apply` 并落盘 | 未开始。工具层必须在 iframe 内已确认 |
| 关重开工程恢复 | 未开始。`chat.py` 的 node 级对话落盘可作为模式参考 |
| 配置跨节点共享 | 未开始。`ai-host.cjs:10` 的 `ai-channels.json` 是全局语义，可平移 |
| `tsc --noEmit` 退出 0 | 上游侧通过（build 内含 `tsc --noEmit`）；DramaClaw 侧本会话未跑 |
| 导演台 vitest 全绿 | 本会话未跑 |

**进度：T001 完成，未产生实现。工作包 0 / 全部 oracle 断言。**

---

## 7. 证据可信度声明

- 第 1–2 节：Scout 实测（构建、grep、wc）
- 第 3 节：PM 直接读 `service.ts` 统计 `ctx.*` 引用，否决 Scout 的架构建议
- 第 4 节：PM 实测 DramaClaw 侧（git diff、grep、pytest、源码定位）
- Scout 自身未能回答「工具层能否脱离浏览器」这一问题，此判定由 PM 补齐