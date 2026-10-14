# Fork ↔ 官方同步维护手册

> 本文件只存在于 `merge/*` 分支，**不在 `main` 上** —— 原因见 §1 的不变量。

## 1. 不变量（先记住这张表）

| 分支 | 角色 | 不变量 |
|---|---|---|
| `main` | 官方的**纯镜像** | 必须与 `upstream/main` 一致；**不放任何本地改动** |
| `merge/upstream-*` | 合并成果（官方 + 本地功能） | 本地功能的唯一主线；部署/开发用这条 |
| `backup/pre-upstream-*` | 合并前的本地尖端 | 只读，救火用 |

`main` 是否还干净，一条命令判（**应当没有输出**）：

```bash
git diff --stat main upstream/main
```

## 2. 远端与跟踪配置

| remote | 仓库 | 用途 |
|---|---|---|
| `origin` | `github.com/zjhr/dramaclaw` | 你自己的 fork：**推送目标** |
| `upstream` | `github.com/dramaclaw/dramaclaw` | 官方：只读，拉取来源 |

`main` 的跟踪配置（`git config --get-regexp '^branch\.main\.'`）：

```ini
branch.main.remote     = upstream      # 比对/拉取看官方
branch.main.merge      = refs/heads/main
branch.main.pushRemote = origin        # 但 push 走自己的 fork，避免误推官方仓库
```

三条缺一不可：少了 `pushRemote`，在 `main` 上 `git push` 会默认指向**官方仓库**。

## 3. 首次推送清单

⚠️ **顺序不能换。** `origin/main` 现在是旧的本地尖端，**不是**官方提交的祖先，所以最后一步必须是 force；一旦先 force 覆盖，`origin/main` 上那 45 个本地提交就失去引用了。

```bash
# 1) 先保命：把本地工作分支推上去
git push -u origin backup/pre-upstream-594
git push -u origin merge/upstream-594

# 2) 确认 GitHub 上真的能看到这两个分支（别跳过）
git ls-remote --heads origin

# 3) 最后才把 main 覆盖成官方镜像
git push --force-with-lease origin main
```

`--force-with-lease` 比 `--force` 安全：远端 `main` 若被别人动过，它会**拒绝**推送而不是覆盖。

推完自检：

```bash
git fetch origin
git rev-list --left-right --count main...origin/main   # 期望：0	0
```

## 4. 日常：官方又更新了怎么办

```bash
git fetch upstream
git switch -c merge/upstream-<新号>
git merge upstream/main
```

冲突处理原则（本仓库约定）：

1. **官方是基线** —— 结构、命名、抽象按官方来，本地功能**适配过去**，不要反过来让官方迁就本地；
2. 本地独有功能整块保留：导演台（`directorDesk` scope / `src/novelvideo/director_desk/` / `frontend/public/director-desk-v2/`）、提示词画廊、风格图墙、自定义渠道（`UpstreamModelField` + `provider-channels`）、逐轮网关凭据（`HermesTurnAuthorization` / `PER_TURN_CREDENTIAL_PLACEHOLDER`）；
3. 边界参照：`hermes_sdk` 保留本地 `session/resume`（官方 `session/load` 在本地不工作，`tests/test_hermes_workspace.py` 有据）。

验收通过后提升 `main`：

```bash
git switch main
git merge --ff-only upstream/main      # main 只前进到官方
git push --force-with-lease origin main
```

> `main` 上**永远不要** merge 本地功能分支 —— 那是 `merge/*` 的职责。

## 5. 验收命令

```bash
# 后端全量（test_chat_runtime_history 需要 openai_codex，本机装不上）
.venv/bin/pytest tests/ -q -p no:cacheprovider --ignore=tests/test_chat_runtime_history.py

# 前端类型检查 —— 必须带 -p：根 tsconfig.json 是 files:[] 的空壳，裸 tsc --noEmit 什么都不查
cd frontend && npx tsc --noEmit -p tsconfig.app.json --skipLibCheck

# 前端生产构建（tsc -b + vite build）
cd frontend && pnpm build

# 后端风格门禁（CI 用的就是它，规则集冻结在 E4/E7/E9/F）
.venv/bin/ruff check <改动文件>
```

用 `.venv/bin/...` 而不是 `uv run`：本机无外网时 `uv run` 会尝试 `uv sync` 然后失败。

## 6. 本机环境坑（会被误判成「合并坏了」）

| 现象 | 真因 | 处理 |
|---|---|---|
| 期望 `brainclaw` 却拿到 `DC-freezone-text-writer-LLM` | `.env:179` 的 `FREEZONE_TEXT_WRITER_MODEL=DC-...` 覆盖了官方新默认 | 删掉该行或改回 `brainclaw` |
| `test_cognee_config` / `test_m06_route_contracts` 之类失败 | `state/local/settings.db` 里残留旧的 `custom_newapi_embedding_model` 等配置 | 用隔离 state 跑：`NOVELVIDEO_STATE_DIR=/tmp/emptystate`，或清理本地库 |
| 网关探测一直挂住，报 `Invalid port: ':1]'` | shell 里 `NO_PROXY` 含 `[::1]`，httpx 解析失败 | `unset HTTP_PROXY HTTPS_PROXY NO_PROXY no_proxy` |
| vitest 全量报 `No such built-in module: node:` | 官方 `src/__tests__/helpers/i18n-fixtures.ts` 在 jsdom 下 import `node:fs`（本机 node v24 + vitest 4 才暴露） | 合并前分支**同样失败**，属既有环境问题，不要记到合并账上 |
| `uv sync` / `uv run` 报 `failed to open file ~/.cache/uv/...` | uv 缓存目录权限 + 无外网 | 直接用 `.venv/bin/*` |
| 网关二进制起不来：`failed to open log file` / `readonly database` | 在只写工作区的沙箱里跑，`gateway` 目录不可写 | 正常终端里 `./start.sh` 即可；或把 DB 副本放到可写目录 |

**关键判据**：拿合并前的分支起一个 worktree 同跑一遍，两边都失败的即为既有问题 ——

```bash
git worktree add --detach /tmp/base-wt backup/pre-upstream-594
ln -sfn "$PWD/frontend/node_modules" /tmp/base-wt/frontend/node_modules
cd /tmp/base-wt && /Users/mac/ai/dramaclaw/.venv/bin/pytest <文件> -q
```

（worktree 里没有 `.env`、没有 `state/`，所以上表前两类环境失败会「消失」—— 这正好用来判断它们是不是环境相关。）

## 7. 事故回滚

```bash
git reflog show main                 # main 的每次移动都在；"Reset to ..." 那行是上一次
git switch -C main <旧 sha>
git push --force-with-lease origin main
```

本地工作分支的备份是 `backup/pre-upstream-594`；它若也被弄坏，`git reflog show backup/pre-upstream-594` 还能捞。

## 8. 快速冒烟（起真实服务）

只验「合并后能不能跑」，不依赖真实 LLM key 的最小流程：

```bash
# 后端（CE 模式 + 隔离 state）
ST_EDITION=ce ST_CONTROL_PLANE_DSN= ST_REDIS_URL= \
NOVELVIDEO_STATE_DIR=/tmp/smoke-state \
  .venv/bin/novelvideo api --port 8780

curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8780/healthz      # 200
# 路由是否都在（含本地独有）：director-desk / prompt-gallery 应出现在列表里
curl -s http://localhost:8780/openapi.json | grep -c 'director-desk'

# 前端
cd frontend && pnpm dev --port 5173 --strictPort
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/api/v1/config # 200（dev server 代理）
```

依据：本项目对 `main` 的定位是「与官方保持一致的纯镜像」，所有本地能力都经过 `merge/*` 分支承载，因此合并的正确性必须靠**两边同跑的对照**来判断，而不是靠单边绿。

---

_快照（2026-10-14）：`main` = `ddf34d15`（= `upstream/main`）、`merge/upstream-594` = `b01d9373`、`backup/pre-upstream-594` = `3ba1d663`。_
