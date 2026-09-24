# PM 决策记录：vendored MONOFORM 不进 git 跟踪

**日期**: 2026-09-24
**决策人**: 主人（PM 提议，主人裁定选项 2「保持现状」）

## 背景

T010（白模导出 unblock 切片）按 T007 Judge 裁定的「受控 augment 路径」修改了 vendored
MONOFORM 源码，产出：

- `frontend/vendor/monoform/src/App.jsx` — 抽出 `renderExportArtifact` 单一实现，新增
  `export.video` / `export.frame` 两个 postMessage action，`ACTIONS` 数组同步扩展，
  `PROTOCOL_VERSION` 1→2
- `frontend/vendor/monoform/PATCHES.md` — 追加第 3 条宿主补丁记录
- `frontend/public/monoform-desk/` — 重建同步的 bundle（`index.html` 指向新 hash）

## 发现的问题

`frontend/vendor/` 与 `frontend/public/monoform-desk/` **均未被 git 跟踪**：

```
git check-ignore -v frontend/vendor/monoform/src/App.jsx
→ .gitignore:80:/frontend/vendor/
git ls-files frontend/public/monoform-desk/ → 0
```

- `.gitignore:80` 的 `/frontend/vendor/` 是本 session 早期（commit feb392e0）由 PM 依主人
  指示加入的。
- `frontend/public/monoform-desk/` 的未跟踪状态**早于本 session**（PM 未改动其跟踪状态）。
- 后果：T010 的全部工作成果无法提交，换机器或合并上游 MONOFORM 新版本时会丢失。
  其中 `PATCHES.md` 是「本仓对 MONOFORM 做了哪些补丁、合并上游时如何重放」的唯一文档，
  丢失代价最高。

## 既有仓库约定（供对照）

| 目录 | 体积 | 跟踪状态 |
| --- | --- | --- |
| `frontend/public/director-desk/` | 80M / 992 文件 | **已跟踪**（含 `UPSTREAM.md`） |
| `frontend/public/monoform-desk/` | 17M / 18 文件 | 未跟踪（早于本 session） |

即本仓既有约定是把 desk bundle 提交进仓；MONOFORM 侧未跟踪是先前缺口。
`frontend/vite.config.ts:104` 引用「见其 UPSTREAM.md」，但 monoform-desk 下并无该文件。

## 主人裁定

**选项 2：保持现状。** 不修改 `.gitignore`，不把 vendored MONOFORM 源码或 bundle 纳入跟踪。

## 对 goal 的影响（final audit 必读）

- 白模导出链路在**本地磁盘上可用**（bundle 已重建、`capabilities.get` 实见
  `export.video`/`export.frame`、`protocolVersion:2`），T011 的宿主侧接回不受影响。
- 但该能力**不在版本控制内**：无法通过 git 复现、无法在另一台机器检出、合并上游
  MONOFORM 时会被覆盖且无补丁记录可依。
- 因此 goal oracle 中的「whitebox node has explicit source edge to final render」若最终
  达成，其**可复现性证据只能来自本地工作区**，不能来自 git 历史。final audit 必须
  如实标注这一点，不得因为「本地能跑」就宣称完全达成。
- 若未来要恢复可复现性：把 `.gitignore` 的 `/frontend/vendor/` 改为只忽略
  `node_modules/` 与 `dist/`（`frontend/vendor/monoform/.gitignore` 已忽略这两者），
  即可放行约 340K 的源码 + `PATCHES.md`。
