# T003 — v2 导演台 vendored 构建 + 宿主桥 + 真实工具通道

Worker receipt 的长说明。命令与结果以 receipt 为准，这里只记判断与证据。

## 做了什么

1. `frontend/vendor/director-desk/` = 上游 mangfufu/director-desk v0.4.10（不含 `.git`、
   `node_modules`、`dist`、`tests/`）。
2. 新增 `vite.config.ts`（`base: './'`）与 `src/host-bridge.ts`；`index.html` 在
   `main.ts` 之前插一行外链 module script 装载宿主桥。
3. 产物发布到 `frontend/public/director-desk-v2/`（25 个文件，已 `git add`）。
4. `directorDeskBridge.ts` 加 4 个 action + **双向** request/response（`project.save` 是
   子 → 宿主）；新增 `directorDeskV2Session.ts`；`DirectorDeskNode.tsx` 的 iframe 指向
   新路径，保存改走 `tool.call director_export {kind:'project'}`，回灌改走 `project.load`。
5. `nginx.conf.template` 加三段（`= /director-desk-v2` 301、`^~ …/assets/` immutable、
   `^~ /director-desk-v2/` 独立 CSP + SAMEORIGIN）；`vite.config.ts` 的 `vendoredDesks`
   改成 `["director-desk-v2", "monoform-desk"]`。
6. `license-inventory.csv` 加 25 行；新增 `tests/test_director_desk_v2_bridge.py`（11 例）。

## 关键设计：为什么不用改上游 `main.ts` 也能调工具

`main.ts:318` 执行 `window.directorDesktop?.onTool((name, args) => toolService.call(name, args))`。
桥的 `onTool(cb)` 把这个 `cb` 存下来 —— `cb` **本身就是调用 `toolService` 的函数引用**。
宿主发 `tool.call` 时桥反过来调 `cb(name, args)`，工具真的跑在 Three.js 渲染进程里。
`ctx.engine` 被工具层用了 20 处，本来也搬不出去。

落盘同理走的是上游自己的保存链：
`tool.call{director_export,kind:'project'}` → `ctx.saveProject()` → `saveProjectFile()`
→ `window.directorDesktop.files('save-project',{name,content})` → 桥翻成子 → 宿主的
`project.save` → 宿主上传 → `data.directorProjectRef`。

## 浏览器实测（非 dev server，同源静态服务 + ego-browser）

iframe 里跑的是上游原生导演台（`title=光影舞台 · 导演台`，2 个 canvas，完整中文 UI）：

```
READY proto=2  handshake ms=2039
capabilities.get → actions=["capabilities.get","tool.call","project.load","skills.sync"] nodeId="e2e-check"
tool.call director_help → ok=true（真实 toolService 回话）
tool.call director_read → ok=true result.revision=1790992236180214（真实场景 revision）
tool.call director_export{kind:'project'} → CHILD->HOST project.save kind=project bytes=24088
                                            HOST<-CHILD ok=true → result={"status":"save-requested"}
skills.sync → {"synced":false,"received":0}（本切片占位）
```

即目标里那条「宿主 → postMessage → toolService.call → 落盘 → 回灌」链路已真实跑通。

## 未通过项：`npx vitest run director-desk`（29 failed）

**不是产品回归，是被本切片替换掉的旧契约的测试。** 失败分布：

| 文件 | 失败 | 原因 |
| --- | --- | --- |
| `director-desk-bridge.test.ts` | 2 | **改动前就是红的**：T010 把协议兼容窗口放宽到 v1..v2，测试仍断言 `protocolVersion: 2` 的响应要被丢弃 |
| `director-desk-node.test.tsx` | 4 | 断言 `src` 含 `/director-desk/` 与 `instanceId` |
| `director-desk-hardening.test.tsx` | 12 | 选择器 `iframe[src^="/director-desk/"]` 选不中 `/director-desk-v2/`，`waitFor` 全部 5s 超时 |
| `director-desk-project.test.tsx` | 9 | 断言保存走 `project.get`、回灌走 `session` 消息 |
| `director-desk-feedback.test.tsx` | 2 | 同 `instanceId` / `project.get` 断言 |

修这些必须动 `frontend/src/__tests__/features/canvas/`，**不在 allowed_files**。
任务书预设的例外只覆盖「No test files found」，没覆盖「旧测试断言的是刚被替换的契约」。

## 另一处踩坑：vendor 的 `tests/` 会污染宿主 vitest

`frontend/vitest.config.ts` 的 `exclude` 没有 `frontend/vendor/`，所以把上游 `tests/`
（98 个 `node --experimental-strip-types` 用例）放进去后，宿主 `npx vitest run director-desk`
会多收 96 个文件并全部跑挂（97 → 101 failing files）。`frontend/vitest.config.ts` 同样不在
allowed_files，所以在 vendor 侧解决：**不 vendor `tests/`**（上游 `npm run build` 的
`tsc --noEmit` 不受影响，`src` 已提供输入）。记在 `PATCHES.md` 第 0 条。

## 已知遗留

- `canvasNodes.ts:731-736` 的注释仍指向已删的 `frontend/public/director-desk/`；
  该文件不在 allowed_files，未改。
- `DirectorDeskNode.tsx` 里 `handleSceneIntent`（localStorage 注入）与 `restoreProjectSnapshot`
  的 v1 分支已不再有子应用对应面（v2 用 IndexedDB），AI 助手的场景注入会在第 2 块切片重接。
- `license-inventory.csv` 里仍有 992 行指向已删的 `frontend/public/director-desk/`，本切片未清理。