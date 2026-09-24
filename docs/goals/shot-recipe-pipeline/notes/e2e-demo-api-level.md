# API 级全链路 e2e demo receipt（ShotRecipe pipeline）

**日期**: 2026-09-24
**任务**: T021（API 级全链路 e2e demo 切片）
**测试**: `tests/test_api_shot_recipes.py::test_e2e_demo_full_pipeline_render_sync_reshoot_lineage`
**复现**: `./.venv/bin/python -m pytest tests/test_api_shot_recipes.py -q -k e2e_demo -s`
（`-s` 才会打印本文件引用的 `E2E_DEMO_RECEIPT {...}` 收据；不带 `-s` 时 pytest 照常捕获）

`job_id` / `decision_id` 由 `store.new_shot_job_id()` / `new_look_decision_id()` 每次随机生成，
重新运行会得到不同的 id——下面记录的是 2026-09-24 那次运行的实测值（测试本身只断言
「版本行/任务 payload 用的是返回的那个 id」，不钉死具体串）。

## 本 e2e 的成片由假 task backend 产出，真实模型成片为 owner 级可选、尚未发生

以下是**必须显式声明**的边界，不得把本 receipt 读成「真的渲染了一次视频」：

- **假的**：`get_task_backend()`（`_use_fake_task_backend`，只记录入队调用、不生成任何东西）
  与 `get_task_manager()`（`_use_fake_task_manager`，返回一个由测试构造的 `TaskState`）。
  两段「成片」是测试自己用 ffmpeg 落盘的 1 秒黑场 mp4（各 2321 字节），不是模型产物。
- **真的**：`create` / `POST .../look-decisions` / `POST .../preflight` / `POST .../render`
  / `POST .../sync` / `POST .../reshoot` / `GET .../quality` / `GET .../shot-recipes/{id}`
  全部经真实 HTTP 端点（`TestClient` + 真实 FastAPI 路由）；每一行版本记录都由生产代码
  （`shot_recipe_store` 的单一 schema owner + append 路径）写出。
- **没有被跳过的一步**：`render → sync → reshoot` 这条缝此前从未在一条流程里跑过——
  既有重拍测试用 `_completed_version` 直接 append 一条 `status=completed` 的版本行来造源
  版本。本 e2e 的源版本是**上一步 render 入队 + sync 终态回写真产出的那条**：它有
  `ready / rendering / completed` 三行（测试逐行断言），`completed` 行带渲染 job 的
  `artifact_url`，且该 url 指向磁盘上真实存在的文件——**否则 reshoot 会按设计 404**。
- **没有真实模型成片**：本环境无任何离线/桩式视频生成后端，真实生成需要上游
  relay/gateway 额度与主人授权（owner 级 blocker，见 T020 `e2e_demo_form.owner_blockers`）。
  本 receipt 不构成「渲染链路已被真实模型验证」的证据。

## 画布 fixture：白模来源边 desk_1 → node_1 + 真实素材文件

`_greybox_canvas(state_dir)` 写的是画布真实 schema（`state/*/freezone/canvases/*.json` 实测形状）：

```json
{"nodes": [
  {"id": "desk_1", "type": "videoNode",
   "data": {"videoUrl": "/static/projects/proj_demo/freezone/_uploads/greybox.mp4",
            "previewImageUrl": "/static/projects/proj_demo/freezone/_uploads/greybox.png",
            "isGreyboxNode": true}},
  {"id": "node_1", "type": "videoNode", "data": {}}
 ],
 "edges": [{"id": "edge-desk_1-node_1", "source": "desk_1", "target": "node_1",
            "sourceHandle": "source", "targetHandle": "target",
            "type": "disconnectableEdge"}]}
```

`node_1` 是绑定节点（版本的 `source_refs.node_id`），`desk_1` 是它的一跳上游白模节点。
素材文件真实落盘：`freezone/_uploads/greybox.mp4`（1 秒真 mp4，2321 字节，ffmpeg 生成）。

## 逐版本行：lineage 原文（JSONL 逐行投影）

`<state_dir>/freezone/_shot_recipes/recipe_demo01.jsonl` 实际写出的行（append-only，
按写入顺序；`recipe` 头行未列入）：

| # | version_id | parent_version_id | status | prompt_delta.mode | capabilities_known | cost.quoted / total_cost | job_id | artifact_url | source_refs.reference_node_ids |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `v1` | `null` | `ready` | `full` | `true` | `false` / – | – | – | – |
| 2 | `v1` | `v1` | `rendering` | `delta` | `true` | `true` / 42 | `job_37ad36862fdb` | – | `["desk_1"]` |
| 3 | `v1` | `v1` | `completed` | `delta` | `true` | `true` / 42 | `job_37ad36862fdb` | `/static/projects/proj_demo/freezone/video/e2e_render.mp4` | `["desk_1"]` |
| 4 | `v2` | `v1` | `rendering` | `delta` | `true` | `true` / 42 | `job_c98eca3a215e` | `/static/projects/proj_demo/freezone/video/e2e_render.mp4`（继承自源版本） | `["desk_1"]` |
| 5 | `v2` | `v1` | `completed` | `delta` | `true` | `true` / 42 | `job_c98eca3a215e` | `/static/projects/proj_demo/freezone/video/e2e_reshoot.mp4` | `["desk_1"]` |

读回的 lineage trace（`GET /projects/proj_demo/shot-recipes/recipe_demo01`）：

```json
{"v1": ["v1"], "v2": ["v1", "v2"]}
```

- 版本链：`v1`（render+sync 真产出）→ `v2.parent_version_id == v1`（reshoot 子版本）。
- 第 1 行的 `cost_ledger.quoted=false` 是如实记录：append 版本时 `resolve_freezone_video_backend("video_x")`
  解析不出后端，账本记「video backend unavailable」而不是编一个数字；渲染那一步报价成功才
  是 `quoted=true / total_cost=42`（数字来自被替换的假报价端口 `_fake_quote_port(total_cost=42)`）。
- 第 2/4 行的 `parent_version_id` 是自指或源版本——那是既有「同一版本的状态迁移」记法，
  不是新版本号；上面的 `ready` 那一行仍在文件里且逐字节未变（测试用逐字节比较断言）。

## 每步 payload / 响应的关键值

### 1) bind look decision（真实角色库路径，identity 解析不到即 404）

```json
{"decision_id": "look_23b70debd7c2", "identity_id": "谢铮_皇帝", "identity_known": true}
```

### 2) preflight（`POST .../versions/v1/preflight`，只读：一行未写、一个任务未入队）

```json
{"ok": true, "blocking": [], "warnings": [],
 "checks": {"billing": "pass", "look_decisions": "pass",
            "model_capabilities": "pass", "source_refs": "pass"},
 "source_refs_detail": "canvas node 'node_1' resolves 1 upstream reference asset(s) (1 video) from node(s) desk_1; gen_mode=all_reference"}
```

### 3) render（`POST .../versions/v1/render`，任务层形状 + payload）

```json
{"version_id": "v1", "job_id": "job_37ad36862fdb",
 "task": {"task_type": "freezone_video_gen", "product_surface": "freezone",
          "queue_kind": "video", "episode": 0, "scope": "job_37ad36862fdb"},
 "payload": {"gen_mode": "all_reference", "requested_gen_mode": "allReference",
             "aspect_ratio": "16:9", "resolution": "1080p",
             "duration_seconds": 6, "backend": "newapi_seedance-2.0-fast",
             "catalog_id": "video_x"},
 "reference_items": [{"type": "video", "role": "画布参考",
                      "path": "<state_dir>/freezone/_uploads/greybox.mp4"}],
 "video_input_present": true,
 "reference_node_ids": ["desk_1"]}
```

即：白模来源边上游的那段视频**真的进了生成任务的 payload**（`reference_items`），模式按目录
能力切到 `all_reference`，计费参数如实带 `video_input_present=True`，版本行记下消费到的
上游节点 `["desk_1"]`。`capabilities_known=true`（假目录条目声明了 `all_reference`）。

### 4) sync（`POST .../versions/v1/sync`，假 manager 报 completed）

终态行写回 `artifact_url = /static/projects/proj_demo/freezone/video/e2e_render.mp4`，
该文件真实存在（2321 字节）。

### 5) reshoot（`POST .../versions/v1/reshoot`，源版本 = v1 的 completed 行）

```json
{"source_version_id": "v1", "version_id": "v2", "job_id": "job_c98eca3a215e",
 "task": {"task_type": "freezone_video_reshoot", "queue_kind": "video",
          "scope": "job_c98eca3a215e"},
 "segment": {"start_seconds": 1.0, "end_seconds": 5.0,
             "duration_seconds": 4, "max_duration_seconds": 12},
 "source_path": "<state_dir>/freezone/video/e2e_render.mp4"}
```

`source_path` 由**源版本的 `artifact_url`** 解析而来，且文件真实存在——这就是
`render → sync → reshoot` 这条缝接通的实证；若 sync 没有把真产物写回版本行，这一步会
按设计 404（`shot_recipes.py:1997-1998`）。

### 6) sync（`POST .../versions/v2/sync`）

终态行写回 `artifact_url = /static/projects/proj_demo/freezone/video/e2e_reshoot.mp4`
（2321 字节真 mp4）。

## quality 风险摘要（结构化 risks，不是分数）

| 版本 | risk_ids | 说明 |
|---|---|---|
| `v1` | `[]` | 造型决策齐备且 identity 已知、谱系无缺口、渲染 completed 且有 artifact_url、报价已记录 → 无风险项 |
| `v2` | `["duration_drift"]` | severity `info`，`duration differs from the parent version: 6 -> 4.0`——重拍只换了 4 秒片段（父版本 6 秒），如实记下漂移 |

报告字段固定为 `{recipe_id, version_id, risks, counts, risk_ids, checked_at}`，**无 score/rating
等总分字段**；端点只读（未入队任何任务）。

## 假件清单（本 receipt 的边界）

| 环节 | 真假 | 说明 |
|---|---|---|
| `create` / `look-decisions` / `preflight` / `render` / `sync` / `reshoot` / `quality` / `GET` | 真 | 真实 HTTP 端点 + 生产代码写版本行 |
| 白模素材 / 两段成片 mp4 | 真文件、假内容 | ffmpeg 生成的 1 秒黑场片（2321 字节），由测试落盘 |
| 目录能力（`video_x`） | 假 | `_use_video_catalog(monkeypatch, E2E_CATALOG_ENTRY)`；条目声明 `text_to_video / image_to_video / all_reference / first_last_frame` |
| 报价 | 假 | `_fake_quote_port(total_cost=42)`；只记录，不扣费 |
| 角色库 | 假 | `_use_identity_library`，提供一条 `谢铮_皇帝` 的 identity |
| task backend | 假 | `_use_fake_task_backend`：只记录入队调用，不生成 |
| task manager | 假 | `_use_fake_task_manager`：返回测试构造的 `TaskState`（task_id 恒为 `task-1`，是假件常量，不是真实任务 id） |

未联网、未调用任何真实模型、未新增任何积分/扣费/余额/账本机制、未改任何 `src/` 生产代码。
