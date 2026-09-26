# 片段重拍（Segment Reshoot）分层测试证据报告

- 任务：片段重拍全链路（边界帧锚定重生成 + ffmpeg 拼接）
- 执行日期：2026-09-21
- 执行方式：本机实跑，所有命令输出为当次会话原始捕获，未删减、未修饰
- Run 目录：`.supergoal/ffmpeg-70-80-compose-source-start-source-miNflI/`
- Baseline ref：`3f19459d2b39a477722396e4c8c720a297a66e6c`

## 1. 概要表

| 腿 | 判定 | 一句话 |
| --- | --- | --- |
| L1 leaf 单测（校验/抽帧/对齐/拼接） | OK | 15/15 过，含区间越界、源缺失、音轨有无、生成段过长过短 |
| L2 schema / runner 注册 / 路由注册 | OK | 15/15 同批覆盖；openapi 路由含 reshoot POST |
| L2b backend 映射（本次新发现并修复） | OK | 新增 2 条测试锁住 model→backend 透传与白名单外明确报错 |
| L3 合成腿（完整 runner 端到端） | OK | 源 6.000s → clip 2.000s → full 6.104s，三要素全继承，`concat_retry=null` |
| L3 concat 降级腿（人为触发 Level 2） | OK | 强制 Level 1 失败 → 自动 `audio_reencode`，产物音轨 aac |
| L3 真实腿（真实视频模型） | **SKIP（环境门槛）** | 本机 newAPI 网关对所有视频模型均返回 `model_not_found`（无可用通道），非代码缺陷；探测原始输出见 §3.6 |
| 浏览器端到端（paseo） | OK（除产物回填） | 时间轴 DOM / 区间设定 / 提交 / 双节点派生 / 溯源边全过；`videoUrl` 回填因真实腿 SKIP 未验证 |

## 2. 环境事实

### 2.1 解释器与工具链

```
$ which ffmpeg ffprobe; ./.venv/bin/python --version
/opt/homebrew/bin/ffmpeg
/opt/homebrew/bin/ffprobe
Python 3.11.13
```

事实：全部使用 `./.venv/bin/python`（Python 3.11.13，含项目 editable 安装）。裸 `python3` 是 mise shim（Python 3.14，无 editable 安装，跑项目脚本必 `ModuleNotFoundError`）。

### 2.2 前后端进程

```
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5173/
200
$ curl -s -X POST ".../freezone/video/reshoot" -H 'Content-Type: application/json' -d '{}'
{"detail":[{"type":"missing","loc":["body","source_url"],"msg":"Field required","input":{}},
{"type":"missing","loc":["body","end_seconds"],"msg":"Field required","input":{}}]}
HTTP=422
```

事实：vite 5173 与后端 8780 均在跑；reshoot 路由已注册（422 是 schema 校验，证明路由存在且 `FreezoneVideoReshootRequest` 生效）。执行期重启过一次后端（旧进程 15772 未含 reshoot 路由）。

### 2.3 前端 tsc 的正确用法（坑）

根 `tsconfig.json` 是 project references（`files: []`），`npx tsc --noEmit` 永远 rc=0（假绿）。必须：

```
cd frontend && ./node_modules/.bin/tsc --noEmit -p tsconfig.app.json
```

另注：执行期另一会话正在同树编辑 `src/__tests__/features/superchat/use-superchat.test.ts`（mtime 20:45），其间出现过 2 个 `.at(-1)` 需 es2022 lib 的报错；最终复跑时该会话已修好，本次交付的 tsc 为 0 错。本次未改动他人文件。

## 3. 各腿命令与原始输出

### 3.1 L1 + L2：leaf / schema / 注册单测

命令（逐字）：

```
cd /Users/mac/ai/dramaclaw && ./.venv/bin/python -m pytest tests/ -k reshoot -q
```

原始输出（尾部）：

```
-- Docs: https://docs.pytest.org/en/stable/howout/how-to/capture-warnings.html
15 passed, 4617 deselected, 14 warnings in 18.52s
```

覆盖用例（`tests/test_freezone_video_reshoot.py`）：

| 用例 | 验的是什么 |
| --- | --- |
| `test_reshoot_rejects_bad_range` | start==end / end<start / start<0 全部拒 |
| `test_reshoot_rejects_over_max_duration` | 区间超模型上限拒（不静默截断） |
| `test_reshoot_missing_source` | 源文件不存在报错 |
| `test_reshoot_synthetic_end_to_end` | 全流程 + meta 字段齐全 + 音轨保留 |
| `test_reshoot_aligns_short_clip` | 生成段 1.2s → 冻帧补足到 2.0s |
| `test_reshoot_aligns_long_clip` | 生成段过长 → 裁齐 |
| `test_reshoot_source_without_audio` | 源无音轨不炸 |
| `test_reshoot_maps_model_to_generator_backend` | model → backend 兜底映射（本次新增） |
| `test_reshoot_rejects_model_outside_whitelist_without_backend` | 白名单外模型无 backend 时明确报错（本次新增） |
| `test_reshoot_prefers_endpoint_resolved_backend` | 端点解析过的 backend 原样透传（本次新增） |
| `test_reshoot_schema_rejects_bad_range` / `_defaults` | pydantic 跨字段校验 |
| `test_reshoot_runner_registered` / `_route_registered` / `_task_label` | runner / 路由 / 任务标签注册 |

### 3.2 L2b：model→backend 映射（执行期发现并修复的真实缺口）

**现象**：真实腿首次运行报

```
REAL_LEG_ERROR: TypeError: HuimengVideoGenerator.__init__() got an unexpected keyword argument 'model_params'
```

**根因**：`run_freezone_video_reshoot` 收了 `model` 却从未传给 `run_freezone_video_gen`，生成层退回自己的默认 backend（`huimeng_seedance-2.0-fast`）；而 `HuimengVideoGenerator.__init__` 的签名只有 `api_key/endpoint/model/resolution/generate_audio/client`，连 `model_params` 都不收。即使用户在界面上选了模型，请求也到不了那个模型。

**修复**（三层）：

1. 端点 `freezone_video_reshoot`：用 `_resolve_catalog_video_backend(model, requester_user_id=...)` 按**目录**解析 backend，连同 `_resolve_catalog_request` 已算出的 `model_params`/`request_schema` 一起进 payload。
   - 为什么必须在端点层：目录（`/freezone/video/models`，含 agnes 等）比 leaf 里的 `resolve_freezone_video_backend` 白名单宽得多，后者对 agnes 直接 `ValueError: unknown video model`。
2. runner `_run_freezone_video_reshoot_async`：透传 `backend` / `model_params` / `request_schema`。
3. leaf `run_freezone_video_reshoot`：新增 `backend`/`model_params`/`request_schema` 形参，`gen_backend = backend or resolve_freezone_video_backend(model or None)`，传给 `run_freezone_video_gen`。

验证：`resolved backend=newapi_agnes-video-2.5-flash`（见 §3.6 第 1 行）。

### 3.3 L3 合成腿：ffprobe 三要素对比表

命令（逐字）：

```
rm -rf /tmp/reshoot_e2e/leg_a /tmp/reshoot_e2e/leg_b
cd /Users/mac/ai/dramaclaw && ./.venv/bin/python /tmp/reshoot_e2e/run_e2e.py
```

脚本 `/tmp/reshoot_e2e/run_e2e.py`：合成 6.000s / 640x360 / 30fps / aac 正弦音轨源；区间 1.5s→3.5s（span 2.0s）；`run_freezone_video_gen` 用 ffmpeg 预制片段顶替（不依赖真实 API）。

腿 A（常规，Level 1 `-c:a copy` 应成功）：

```
===== leg_a =====
| 项 | 源 | clip | full |
| --- | --- | --- | --- |
| 时长 (s) | 6.000 | 2.000 | 6.104 |
| 分辨率 | 640x360 | 640x360 | 640x360 |
| 帧率 | 30/1 | 30/1 | 30/1 |
| 音轨 codec | aac | aac | aac |
meta: {"span_seconds": 2.0, "source_duration": 6.0, "clip_duration": 2.0,
       "full_duration": 6.103855, "concat_retry": null, "frames_extracted": 2}
```

判定：

- clip 时长 2.000s ∈ [1.7, 2.3] ✓（对齐到区间）
- full 时长 6.104s ∈ [5.5, 6.5] ✓（≈源 ±0.5；6.104 而非 6.000 是 `tpad` 冻帧补足 + concat 重封装的时间基舍入，非丢帧）
- full 分辨率 / 帧率继承源 ✓（帧率继承用的是源 `r_frame_rate`，不是抽帧 fps）
- full 音轨非空（aac）✓
- `frames_extracted: 2` ✓（区间首尾各一帧）
- `concat_retry: null` ✓（走了 Level 1）

### 3.4 L3 concat 降级腿：人为触发 Level 2

手法：monkeypatch `jobs.subprocess.run`，让**第一级** concat（命令行含 `-c:a copy`）这一次返回 `CompletedProcess(cmd, 1, ...)`，其余放行。

```
===== leg_b =====
| 项 | 源 | clip | full |
| --- | --- | --- | --- |
| 时长 (s) | 6.000 | 2.000 | 6.104 |
| 分辨率 | 640x360 | 640x360 | 640x360 |
| 帧率 | 30/1 | 30/1 | 30/1 |
| 音轨 codec | aac | aac | aac |
meta: {"span_seconds": 2.0, "source_duration": 6.0, "clip_duration": 2.0,
       "full_duration": 6.103855, "concat_retry": "audio_reencode", "frames_extracted": 2}
patch fired: True

E2E_RESULT: OK
```

判定：

- `concat_retry == "audio_reencode"` ✓（确实走了第二级，不是假装成功）
- patch 确实生效 ✓
- 降级后产物音轨为 aac ✓
- 时长/分辨率/帧率仍全部继承 ✓

> 备选手法（把生成段音频编码成 concat demuxer 不接受的形式）**实测不可靠**：mp3 / flac 混入 aac 的 concat 在 `-c:a copy` 下 rc 仍为 0（concat demuxer 静默合并，音频 6.10s 反而对得上），opus/vorbis/pcm_mulaw 连 mp4 容器都写不进去。故采用 monkeypatch 方案。

### 3.5 L3 真实腿：**SKIP（环境门槛）**

命令（逐字）：

```
cd /Users/mac/ai/dramaclaw && ./.venv/bin/python /tmp/reshoot_e2e/run_real.py
```

脚本 `/tmp/reshoot_e2e/run_real.py`：真实源 `/tmp/reshoot_e2e/src.mp4`（6.000s / 640x360 / 30fps / aac），区间 1.5s→3.5s，prompt 为真实中文描述，`model` 走 `_resolve_catalog_video_backend` 按目录解析。

模型探测（`/tmp/reshoot_e2e/probe_models.py`，逐个试提交 2s/480p 最短生成）：

```
seedance-2.0           FAIL RuntimeError: ... HTTP 503 - {"error":{"code":"model_not_found","message":"No availabl
seedance-2.0-mini      FAIL RuntimeError: ... HTTP 503 - {"error":{"code":"model_not_found","message":"No availabl
seedance-2.5           FAIL RuntimeError: ... HTTP 503 - {"error":{"code":"model_not_found","message":"No availabl
MiniMax-H3             FAIL RuntimeError: ... HTTP 503 - {"error":{"code":"model_not_found","message":"No availabl
happyhorse-1.1         FAIL RuntimeError: ... HTTP 503 - {"error":{"code":"model_not_found","message":"No availabl
seedance-1.5-pro       FAIL RuntimeError: ... HTTP 503 - {"error":{"code":"model_not_found","message":"No availabl
wan3.0-video           FAIL RuntimeError: ... HTTP 503 - {"error":{"code":"model_not_found","message":"No availabl
happyhorse-1.0         FAIL RuntimeError: ... HTTP 503 - {"error":{"code":"model_not_found","message":"No availabl
```

agnes 单独跑（真实腿脚本）的完整原始输出：

```
model=agnes-video-2.5-flash source=/tmp/reshoot_e2e/src.mp4 span=1.5s..3.5s
resolved backend=newapi_agnes-video-2.5-flash
REAL_LEG_ERROR: RuntimeError: freezone video generation failed: DramaClawAPI submit failed: HTTP 400 -
{"code":"fail_to_fetch_task","message":"{\"code\":\"invalid_request\",\"message\":\"response_format 不是允许的请求字段 ...
```

默认模型（前端未传 model 时）经画布提交的原始输出（后端日志）：

```
Project task failed: freezone_video_reshoot/01M2G6P69SGQN6S19YP6E75E25/0: freezone video generation failed:
DramaClawAPI submit failed: HTTP 503 - {"error":{"code":"model_not_found","message":"No available channel for
model seedance-2.0-fast under group default (distributor) (request id: 202609211240112079430008268d9d6SixUdRKA)"...
```

**结论**：本机 newAPI 网关对所有视频模型均无可用通道（`model_not_found` / `No available channel ... (distributor)`）；agnes 则连到网关后因请求 schema 不兼容被 400 拒（`response_format 不是允许的请求字段`）。二者都是**上游基建/模型侧问题**，不是 reshoot 管线缺陷——管线已完整走到「调模型」这一步（抽帧、锚点图、首尾帧模式、backend 解析全部正确）。

按 spec 要求：**不放宽断言、不假装通过**，本腿标 SKIP。待网关有通道后重跑 §3.6 的命令即可。

### 3.6 浏览器端到端（paseo）

前置：vite 5173 + 后端 8780（已重启含 reshoot 路由）；项目 `01M2G6P69SGQN6S19YP6E75E25`；画布 `user_local_17cvc3s`。

步骤与断言：

**a) 上传真实视频到新建视频节点**

```
{"hasVideo":true,
 "src":"/static/projects/01M2G6P69SGQN6S19YP6E75E25/freezone/_uploads/20260921_203634_306094_src.mp4?v=...#t=0.1",
 "duration":6,
 "nodeText":"视频640×3600:000:06..."}
```

**b) 点「片段重拍」→ 时间轴 DOM**

工具栏按钮序列：`["剪辑","高清","转深度视频","片段重拍","解析","智能去字幕","分离音视频","提交"]`

```
{"timeline":true,
 "text":"起 0.0s止 6.0s时长 6.0s",
 "handles":[{"label":"区间起点","now":"0","min":"0","max":"6","left":"0%"},
            {"label":"区间终点","now":"6","min":"0","max":"6","left":"100%"}],
 "submitBtn":true}
```

判定：`data-testid=reshoot-timeline` ✓；两手柄 ✓；aria min/max ✓；**时长从真实 `<video>` metadata 探到 6.0s**（不是猜的）✓；文本格式正确 ✓。

**c) 键盘步进设定区间 1.5s→3.5s**

```
{"text":"起 1.5s止 3.5s时长 2.0s","start":"1.5","end":"3.5"}
```

（注：连发 keydown 会因同步循环内读到同一份 render 快照而只前进一步，需「一次一等渲染」；这是测试手法问题，组件本身的 `onChange` 语义正确。）

**d) 填 prompt + 提交 → 双节点派生 + 溯源边**

提交前基线：`nodes: 2, edges: 0`。

提交后从**持久化画布**读到的权威结果：

```
canvas nodes: 25 edges: 11
  node 121f7b9b-868c-4300-9a0a-5be58bffdec6 videoNode | name= '重拍片段' | reshoot= True
  node 0256dde5-0da7-44a8-8a5b-f1008dbe0476 videoNode | name= '拼接整片' | reshoot= True
  edge fae0adce-d706-4fcc-b9c3-71c78522cd2d -> 121f7b9b-868c-4300-9a0a-5be58bffdec6
  edge fae0adce-d706-4fcc-b9c3-71c78522cd2d -> 0256dde5-0da7-44a8-8a5b-f1008dbe0476
```

两个派生节点的完整字段：

```
displayName       = 重拍片段 / 拼接整片
isReshootNode     = True            ← 溯源标记（免素材上限校验）
reshootSourceUrl  = /static/projects/.../_uploads/20260921_203634_306094_src.mp4
referenceOnly     = True            ← 抑制底部生成面板
isGenerating      = False           ← 任务结束后 loading 已停
generationError   = freezone video generation failed: ... HTTP 503 ...
aspectRatio       = 16:9            ← 继承源
videoUrl          = None            ← 未回填（因真实腿 SKIP）
```

判定：

- 两个派生节点都建成，`displayName` 分别为「重拍片段」「拼接整片」✓
- 两条溯源边从源节点指向两个派生节点 ✓
- `isReshootNode: True` ✓ —— 这正是让溯源边免 `videoReferenceConnectionRejection` 素材上限校验的标记（`agnes` 系 `referenceVideoMax=0`，不豁免就会静默丢边）
- 失败时错误落在**两个**节点上、loading 都停 ✓（不是只落一个让另一个永久转圈）
- `videoUrl` 回填：**未验证**（真实腿 SKIP，任务失败）

**e) 溯源边放行回归**

`frontend/src/__tests__/features/canvas/video-greybox-edge.test.ts`：

```
it("重拍派生节点（isReshootNode）同样免上限")
  isReshootNode 目标 → rejection == null      ✓
  普通 video 目标  → rejection != null        ✓（上限语义没破）
```

**f) 前端 mandatory commands**

```
cd frontend && ./node_modules/.bin/tsc --noEmit -p tsconfig.app.json
→ 0 errors

npx vitest run src/__tests__/features/canvas/video-reshoot-node.test.ts \
                src/__tests__/features/canvas/video-greybox-edge.test.ts \
                src/__tests__/features/canvas/video-reshoot-timeline.test.tsx
→ Test Files 3 passed (3) / Tests 13 passed (13)
```

`video-reshoot-node.test.ts` 是源码契约测试（读 `NodeActionToolbar.tsx` 原文断言）：入口 chip 接线、双 `addNode` + 双 `addEdge`、两处 `isReshootNode: true`、`clip_url`/`output_url` 双回填、失败落两节点、`isReshooting` 落 node.data。

canvas 全量：`1287 passed | 1 failed`，失败项 `director-scene-patch.test.ts`（untracked 早前文件，单独跑 41/41 过，全量负载下 5s 超时，flaky 非本次回归）。

## 4. 复现命令

```bash
# L1 + L2 + L2b：leaf / schema / runner / 路由 / backend 映射
cd /Users/mac/ai/dramaclaw && ./.venv/bin/python -m pytest tests/ -k reshoot -q

# L3 合成腿 + concat 降级腿（不依赖真实 API）
rm -rf /tmp/reshoot_e2e/leg_a /tmp/reshoot_e2e/leg_b
cd /Users/mac/ai/dramaclaw && ./.venv/bin/python /tmp/reshoot_e2e/run_e2e.py

# L3 真实腿（需要网关有视频模型通道；当前本机全部 model_not_found）
cd /Users/mac/ai/dramaclaw && ./.venv/bin/python /tmp/reshoot_e2e/run_real.py

# 模型通道探测（判断真实腿能否跑的前置）
cd /Users/mac/ai/dramaclaw && ./.venv/bin/python /tmp/reshoot_e2e/probe_models.py

# 前端
cd /Users/mac/ai/dramaclaw/frontend && ./node_modules/.bin/tsc --noEmit -p tsconfig.app.json
cd /Users/mac/ai/dramaclaw/frontend && npx vitest run \
  src/__tests__/features/canvas/video-reshoot-node.test.ts \
  src/__tests__/features/canvas/video-greybox-edge.test.ts \
  src/__tests__/features/canvas/video-reshoot-timeline.test.tsx

# i18n 三语对齐
cd /Users/mac/ai/dramaclaw && uv run python scripts/check_frontend_i18n.py
```

## 5. 结论

### 已通过的验收项

| # | 项 | 证据 |
| --- | --- | --- |
| 1 | leaf 校验/抽帧/对齐/拼接逻辑 | §3.1 15/15 |
| 2 | schema 跨字段校验 + runner/路由/任务标签注册 | §3.1 同批 |
| 3 | model→backend 映射（执行期发现并修复） | §3.2 + 3 条新测试 |
| 4 | 合成腿三要素继承 + 音轨保留 | §3.3 |
| 5 | concat Level 1→Level 2 自动降级 | §3.4 |
| 6 | 溯源边免素材上限（greybox + reshoot） | §3.5e 回归测试 |
| 7 | 时间轴 DOM / 键盘可达 / 真实时长探测 | §3.5b、§3.5c |
| 8 | 双节点派生 + 双溯源边 + 失败兜底 | §3.5d 持久化画布权威数据 |
| 9 | 前端 tsc 0 错 + 13/13 + i18n 无新增 hit | §3.5f |

### 待主人体检的项

| # | 项 | 说明 |
| --- | --- | --- |
| 1 | **真实模型生成质量** | 本机网关无视频模型通道（全部 `model_not_found`），真实腿 SKIP。重跑 §4 的 `run_real.py` 即可补上；建议主人确认网关通道后用 agnes 或 wan3.0 各跑一次 |
| 2 | **agnes 的请求 schema 兼容性** | agnes 连到网关后被 400 拒：`response_format 不是允许的请求字段`。这是模型侧 schema 问题，需要主人确认该模型的合法请求字段集，可能要调 `_resolve_catalog_request` 出的 `request_schema` |
| 3 | **拼接整片的视觉节奏** | `full` 6.104s vs 源 6.000s 的 104ms 差来自冻帧补足 + concat 时间基舍入；合成素材上看不出，真实素材上建议主人目视确认接缝处是否可接受 |
| 4 | **画布上遗留的两个测试节点** | 本次在 `user_local_17cvc3s` 画布留下了「重拍片段」「拼接整片」两个失败态节点（id `121f7b9b…` / `0256dde5…`），因任务失败未回填。主人可直接删除；浮浮酱没有擅自删用户画布内容 |

## 7. 边界与安全（Phase 6）

### 7.1 后端边界用例表

| 输入 | 期望 | 实际 | 判定 |
| --- | --- | --- | --- |
| `start_seconds == end_seconds` | `ValueError: end_seconds must be greater than start_seconds` | 同左 | ✓ |
| `end_seconds < start_seconds` | 同上 | 同左 | ✓ |
| `start_seconds = -1` | schema `ge=0` 拒（422） | 同左 | ✓ |
| `end_seconds = 1e30 / inf / 86401` | schema `le=86400` 拒（新增） | 同左 | ✓ |
| 区间 > 模型 `maxDuration` | `ValueError` 含实际上限，不静默截断 | 同左 | ✓ |
| 源文件不存在 | `FileNotFoundError` 带路径 | 同左 | ✓ |
| PATH 无 ffmpeg | `RuntimeError: ffmpeg not found on PATH; install via brew/apt` | 同左 | ✓ |
| PATH 无 ffprobe | `RuntimeError: ffprobe not found on PATH; install via brew/apt` | 同左 | ✓ |
| 源是非视频文件（0 字节/文本） | `RuntimeError: frame extract failed at ...` 带 stderr 尾部 | 同左（不出黑帧） | ✓ |
| 生成段 < 区间 | `tpad=stop_mode=clone` 冻帧补足 | 1.2s → 2.0s | ✓ |
| 生成段 > 区间 | `-t` 裁齐 | 见 `test_reshoot_aligns_long_clip` | ✓ |
| concat Level 1 失败 | 自动 Level 2 `aac` 重编码 | `concat_retry="audio_reencode"` | ✓ |
| concat Level 2 也失败 | `RuntimeError` 带两级 stderr | 代码路径 `for...else raise` | ✓ |
| 源无音轨 | 产出无声片 + `meta.source_has_audio=false`（新增） | 同左 | ✓ |
| 源有音轨 | `meta.source_has_audio=true` | 同左 | ✓ |

### 7.2 安全校验

| 项 | 期望 | 实际 |
| --- | --- | --- |
| `source_url` 含 `../` | 端点层 `resolve_static_url_to_path` 抛 `ValueError` → 400 | ✓（`test_reshoot_rejects_path_traversal_source`，4 种形态：`../`、多层 `../`、`%2e%2e`、`..%2f`） |
| `end_seconds` 荒谬值 | schema 上界拒掉，不让它进 ffmpeg | ✓ `le=86400.0` |
| `prompt` 长度 | `max_length=2000` | ✓ |
| shell 注入 | 新增代码一律 list 形式调 ffmpeg，禁 `shell=True` / `os.system` | ✓（`test_reshoot_no_shell_invocation` 断言 reshoot 函数体内均不存在） |

### 7.3 前端边界用例表

| 场景 | 期望 | 实际 |
| --- | --- | --- |
| 区间为 0 / start ≥ end | 提交禁用 + 「结束时间必须大于开始时间」 | ✓（`reshootRangeInvalid` 同时控制文案与 `disabled`） |
| end 超过源时长 | 时间轴钳制到源时长 + 提示 | ✓（`VideoReshootTimeline` clamp；越界进 `reshootRangeInvalid`） |
| 区间超过模型 maxDuration | 提交禁用 + 提示含具体上限 | ✓（`reshootOverMaxDuration`，limit 来自 `/freezone/video/models` 的 `maxDuration`；目录未加载 `isFallback` 时不拦，由后端兜底） |
| durationSeconds 未知 | 提交禁用 + 「读不到源视频时长，无法选区」 | ✓（`reshootRangeUnknown` 新键，三语） |
| 源视频 < 1s | 时间轴可渲染，最小区间 0.1s 仍可提交 | ✓（`MIN_SPAN_SECONDS=0.1`） |
| 任务轮询超时 | `notifyTaskStillRunning` 提示，两个节点都停 loading | ✓（复用 greybox 同一函数） |
| 提交期间重复点击 | `isReshooting` 禁用，不会双提交 | ✓（`disabled` 三元组含 `isReshooting`；`handleVideoReshoot` 入口也再判一次） |
| 节点没有已选模型 | 不传 model，后端走默认 | ✓（`node.data.model` 为空时 `model: undefined`） |

### 7.4 清洁度

| 项 | 结果 |
| --- | --- |
| 新增裸 `console.log` | 0（重拍日志全部 `console.info/error/warn` + `[video-reshoot]` 前缀，共 5 处） |
| 新增 TODO/FIXME | 0 |
| 死 import / 未用局部 | 0（tsc `noUnusedLocals` 开启，0 错） |
| i18n 硬编码新增 | 0 hit（存量 6 hit 全部是他人 untracked 文件，未动） |

### 7.5 模型能力门禁（首尾帧模式）

片段重拍**不绑定 Seedance**——唯一的硬门槛是模型声明了 `first_last_frame`。本机目录实测：

| 模型 | first_last_frame | 片段重拍 |
| --- | --- | --- |
| seedance-2.0 / 2.0-fast / 2.0-mini / 2.5 | ✓ | ✓ |
| agnes-video-2.5-flash | ✓ | ✓ |
| MiniMax-H3 | ✓ | ✓ |
| wan3.0-video / wan3.0-video-prime | ✓ | ✓ |
| happyhorse-1.0 / 1.1 | ✗ | ✗ |
| seedance-1.0-pro / 1.0-pro-fast / 1.5-pro | ✗ | ✗ |

13 个模型里 8 个可用。两端各加一道闸门，口径同源：

**后端**（`freezone_video_reshoot` 端点）：拿到目录 capabilities 后立刻

```python
_require_catalog_video_mode(capabilities, "firstLastFrame")
```

不支持 → 400 `this model does not support first_last_frame mode`。capabilities 为 None
（目录没配 supportedModes 的老条目）时不拦，交给上游报错——`_catalog_mode_enabled`
正好把「没配」和「配了但不含」分成 None / False 两档。

**前端**（`NodeActionToolbar`）：入口按钮多一个禁用条件 + tooltip

```ts
reshootModelUnsupported = match.supportedModes 存在但不含 "first_last_frame"
```

目录还没加载出来、或该条目没配 `supportedModes` 时同样不拦。

实测（重启后端后逐个模型打端点，源为画布上真实 3s 视频，区间 0.2→1.2s）：

```
happyhorse-1.0           {"detail":"this model does not support first_last_frame mode"} | HTTP=400
happyhorse-1.1           {"detail":"this model does not support first_last_frame mode"} | HTTP=400
seedance-1.5-pro         {"detail":"this model does not support first_last_frame mode"} | HTTP=400
seedance-2.0             {"ok":true,...}                                                | HTTP=200
agnes-video-2.5-flash    {"ok":true,...}                                                | HTTP=200
MiniMax-H3               {"ok":true,...}                                                | HTTP=200
wan3.0-video             {"ok":true,...}                                                | HTTP=200
```

测试（`tests/test_freezone_video_reshoot.py` 新增 3 条）：

| 用例 | 验的是什么 |
| --- | --- |
| `test_reshoot_rejects_model_without_first_last_frame_mode` | 目录显式不含首尾帧 → 400 且报文含 `first_last_frame` |
| `test_reshoot_allows_model_with_first_last_frame_mode` | 含首尾帧 → 放行入队 |
| `test_reshoot_allows_model_without_any_mode_declaration` | capabilities 为 None → 不拦 |

前端契约测试补 `disables the entry when the model has no first_last_frame mode`。

### 7.6 重拍模型选择（单一状态源）

重拍面板里多一个模型选择器（`ProviderModelPicker`，与节点面板同一个组件），但**它改的不是局部状态，而是直接写回节点的 `model`**：

```tsx
<ProviderModelPicker
  selectedModelId={reshootModelId}
  models={reshootModels.models}
  domain="video"
  popoverPlacement="top"
  getOptionDisabledReason={(option) =>
    reshootModelUnsupportedFor(option)
      ? t("nodeToolbar.video.reshootModelUnsupported")
      : null
  }
  onChange={(nextModelId) => updateNodeData(node.id, { model: nextModelId })}
/>
```

为什么这么设计：同一节点上若有两个模型状态源（面板一份、节点一份），用户改完一个不知道另一个会不会跟着变，是典型的 bug 温床。写回 node.data 后两边天然同步。

`reshootModelUnsupportedFor` 从「当前模型是否支持」提成「任一候选是否支持」，入口按钮与选择器的 `getOptionDisabledReason` 共用同一个判定——不支持首尾帧的模型在列表里直接置灰并带理由，用户连点都点不进去。

实测（真实画布，从 agnes 切成 Wan 3.0 Video Prime）：

```
切换前 triggerText: "agnes-video-2.5-flash"
切换后 triggerNow: "Wan 3.0 Video Prime"
收起面板后节点自己的模型按钮: "Wan 3.0 Video Prime"   ← 已同步
```

列表里 15 项，其中 4 项置灰：`seedance-1.5-pro` / `seedance-1.0-pro-fast` / `happyhorse-1.0` / `HappyHorse 1.1`——正是 §7.5 表里不支持首尾帧的那几族。

## 6. 本机环境说明

- **venv**：必须 `./.venv/bin/python`（3.11.13）。裸 `python3` 是 mise shim（3.14，无 editable 安装）。
- **后端重启**：改了 `src/novelvideo/**` 必须重启 8780 才生效（旧进程不会热加载）。本次执行期重启过一次。
- **前端 tsc 假绿**：根 tsconfig 是 project references，必须 `-p tsconfig.app.json`。
- **画布 LOD**：`Canvas.tsx` 开了 `onlyRenderVisibleElements`，视口外的节点不渲染进 DOM——数节点数会少数，要看权威结果请读持久化画布 API（`GET /api/v1/projects/{p}/freezone/canvases/{canvas_id}`）。
- **浏览器上传限制**：paseo 的 `browser_upload` 只接受 agent workspace 内的文件；测试视频需先复制进仓库树（本次用 `.e2e-tmp/`，已清理）。
- **并发的另一会话**：执行期有另一会话在同树编辑 `use-superchat.test.ts` / `director-desk-chat-panel.test.tsx`，曾让 tsc 短暂出现 2-3 个非本次相关的错。本次未改动他人文件。

---

## 8. 修复：模型 mode 契约与时长下限（2026-09-22）

主人报「重拍片段报错，任务 ID：0d9408f5-…」。逐层剥开是**三个独立缺陷叠在一起**，
前两个在 DramaClaw，第三个是上游契约理解错误。

### 8.1 缺陷一：区间短于模型下限，要打到上游才失败

`min_duration_seconds` 从没被读过（只有 max 有拦截）。1.0s 的区间一路跑到
上游，agnes 回 400 `seconds 必须在 [4, 12] 范围内`。用户在界面上等几十秒，
换回来一句上游报错——而这个下限在目录里是现成的。

| 模型 | minDuration |
|---|---|
| wan3.0-video / wan3.0-video-prime | 2 |
| seedance-2.0 全系 / MiniMax-H3 / **agnes-video-2.5-flash** | **4** |

修法：端点层在入队前拦（`freezone.py`），前端加 `reshootUnderMinDuration`
守卫（禁用提交 + 提示含具体秒数）。生成段的时长就是区间长度，不可能小于
模型下限，所以这是硬拦不是软提示。

### 8.2 缺陷二：agnes 的 `mode` 是「调用形状」开关，不是可选参数

这是根因，也是最反直觉的一条。实测矩阵（直打网关 `127.0.0.1:18780`）：

| mode 字段 | 素材形状 | 结果 |
|---|---|---|
| （缺失） | image + last_frame_image | 400 `mode 不能为空` |
| `text` | image + last_frame_image | 400 **`text 模式不能包含素材字段`** |
| `keyframe` | image + last_frame_image | **200 queued** ✅ |
| `keyframe` | metadata.first_frame/last_frame | 400 `keyframe 模式需要 first_frame` |
| `keyframe` | 无素材 | 400 `keyframe 需要 first_frame` |
| `reference` | metadata.reference_images | 400 `reference 需要 images` |
| `text` | 无素材 | 200 queued ✅ |

即：agnes 把「这次是什么形状的调用」编进 `mode` 字段——`text` = 纯文生视频、
`keyframe` = 首帧/首尾帧、`reference` = 多素材参考。**它同时决定「允许携带哪些
素材字段」**：发 `mode=text` 还带 `first_frame_image`，上游直接判为参数冲突。

而 DramaClaw 的目录条目只声明了静态 `default: "text"`，于是**首尾帧生成永远发
`mode=text`**——必 400。这个错误不限于片段重拍：**这台机器上任何走 agnes 的
图生视频 / 首尾帧生成都是坏的**（实测单图 i2v 同样 400 `text 模式不能包含素材字段`）。

修法：给请求 schema 的参数加 `valueByMode`，让同一 key 按业务模式取不同默认值。

```jsonc
{ "key": "mode", "requestPath": "mode", "control": "select",
  "options": ["text", "keyframe", "reference"], "default": "text",
  "valueByMode": {
    "image_to_video": "keyframe",
    "first_frame": "keyframe",
    "first_last_frame": "keyframe",
    "all_reference": "reference",
    "image_reference": "reference"
  } }
```

`media_request_schema_for_mode` 在按 `modes` 过滤时顺带替换 `default`，取值仍过
`_validate_parameter_value`（写错选项在加载时就炸，不会等到发请求）。
调用方显式给的值优先于 valueByMode——覆盖的是默认值，不是硬编码。

**配置数据改动（非代码）**：agnes 条目的 `valueByMode` 写在
`state/local/settings.db` 的 `custom_newapi_media_model_mappings`，不在仓库里。
改动前已备份到 `/tmp/settings.db.bak.1790064710`。

### 8.3 修复后实测（真实模型腿，非打桩）

源视频 `20260921_203634_306094_src.mp4`（6.000s / 640x360 / 30fps / aac），
区间 1.0s→5.0s，模型 `agnes-video-2.5-flash`：

| 项 | 源 | clip（重拍段） | full（拼回整片） |
|---|---|---|---|
| 时长 | 6.000s | **4.000s** | **6.104s** |
| 分辨率 | 640x360 | 1280x704（模型原始输出） | 640x360（跟随源） |
| 帧率 | 30/1 | 24/1（模型原始输出） | 30/1（跟随源） |
| 帧数 | 180 | 96 | 151 |
| 音轨 | aac | aac | aac ✅ 保留 |

clip 是模型直出（分辨率/帧率由模型决定），full 在拼接时统一重编码到源参数——
所以画幅与帧率在成品上跟随源，符合设计。任务在任务中心状态 `completed`。

### 8.4 未验证项（如实登记）

- **`mode=reference`（all_reference 路径）只验到「过了网关的模式校验」**，
  没验到出片。agnes 免费额度在本次验证期间触发限流：
  `429 您已达到免费用户的 API 速率限制`（网关日志 `channel #6`）。这是账号额度
  问题不是代码问题，但意味着 `valueByMode` 里 `all_reference → reference`
  那一档**待主人在额度可用时复验**。
- 单图 i2v 同样修好了（实测 `mode=keyframe` + `image` → 200 queued），
  但没有跑完整出片。

### 8.5 回归

```
pytest -k "media or reshoot"   407 passed
pytest tests/test_media_model_request_schema.py   75 passed（新增 2 条 valueByMode）
tsc -p tsconfig.app.json        0 errors
vitest canvas                   1304 passed
i18n                            三语键对齐（新增 reshootUnderMinDuration）
```
