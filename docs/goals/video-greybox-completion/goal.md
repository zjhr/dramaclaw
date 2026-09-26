# 视频转白模管线收尾与验证

## Objective

分两阶段达成主人要的完整 outcome：

**阶段一（当前 tranche）**：完成「视频转白模」功能的剩余接线——后端任务注册（6 文件）与前端入口（3 处），然后**自己执行分层测试**，产出可复现的**证据报告**。

**阶段二（已排队）**：白模验收后，依优先级完成其余 4 项功能缺口（片段重拍 → 视频延长 → 角色库跨项目 → 多语言口型）。

完成标准不是"代码写完"，是"测试命令真实跑通且产物通过验收"。

## Original Request

> 继续完成后续工作，并且自己测试，最后拿到证据报告结果

## Intake Summary

- Input shape: `existing_plan`
- Audience: 主人（自用）
- Authority: `requested`
- Proof type: `test`（辅以 artifact）
- Completion proof: L1/L2 单测命令输出通过 + 端到端产出白模 mp4 + `ffprobe` 验收（时长≈源、有音轨）+ 证据报告落盘
- Goal oracle: 分层验证命令真实执行通过；端到端产物通过 ffprobe 与目视验收
- Likely misfire: ① 代码全部写完但零验证（当前沙箱无 python、无网络，极易发生）；② 端点接通了但前端没入口，主人无法使用；③ 跑通但音轨丢失或时长不符
- Blind spots considered: 沙箱 python 缺失（实测 exit 127）与网络不可达 → 「自己测试」可能只能部分在沙箱内完成，需真实环境补验；白模为纯本地渲染，不依赖 agnes 模型能力边界；音轨用 `-map 1:a?` + `-shortest` 处理无声源
- Existing plan facts: 计划文件 `/Users/mac/.claude/plans/sprightly-beaming-riddle.md`（2026-09-20 已复核 16 锚点 + 修正 3 处，账本在文末附录）；memory `dramaclaw-greybox-plan` 记录进度与实现决策

## 已有进度（计划事实，不得推翻只能验证）

| 层 | 文件 | 状态 |
|---|---|---|
| L1 渲染层 | `src/novelvideo/generators/greybox_render.py` | 已写（含 4 组 assert 自检，未跑） |
| L2 深度层 | `src/novelvideo/generators/greybox_depth.py` | 已写（依赖探测未跑） |
| 3a runner | `src/novelvideo/freezone/jobs.py::run_freezone_video_greybox` | 已写 |
| 3b 后端注册 | runners/freezone.py、schemas.py、routes/freezone.py、routes/tasks.py | **待做（T003/T004）** |
| 3c 前端 | api/ops.ts、ui/NodeActionToolbar.tsx、三语 translation.json | **待做（T005）** |
| 测试证据 | L1/L2/L3 | **待做（T006）** |

## 阶段二排队的功能（T007-T010，各带核心思路与已知约束）

| 任务 | 功能 | 人天 | 核心思路（来自 memory `dramaclaw-feature-backlog`，到阶段需 Judge 细化） |
|---|---|---|---|
| T007 | **片段重拍**（P0） | 2-4 | 只重生成 `[t1,t2]` 中段，首尾用边界帧锚定，ffmpeg 拼回。compose 端点已支持 `source_start/source_end` 区间裁剪；确定省钱项（省 70-80% 重跑费用）。注意：keyframe 模式与参考图互斥是模型无关约束 |
| T008 | **视频延长** | 1-2 | 尾帧续接：上段尾帧当首帧再生成一段，循环 concat。`return_last_frame`/`last_frame_path`/`first_frame` 模式/ffmpeg concat 全部现成；每次多长由模型 `maxDuration` 定（agnes 12s），不写死 |
| T009 | **角色库跨项目** | 3-5 | 抄 `sync_global_props` 的 `is_global_asset` 范式 + `STATE_DIR/_shared/` 全局层。自用不需要 7000 预置角色，只要跨项目复用自捏主演；注意资产路径复制/重名/级联删除 |
| T010 | **多语言 + 口型** | 2-3 | 口型走模型原生（`spoken_dialogue.py` 逐字注入 prompt），不接外部 lip-sync；真缺口是语种（`AssetLanguage` 硬编码 zh/en 且是资产文案语言不是台词语言）→ 目标语种参数 + 台词翻译 + prompt 注入 |

四项共同设计原则：**模型无关**——功能只读能力目录声明（`maxDuration`/`referenceVideoMax`/`supportedModes` 等），换模型自动适配，主人当前 agnes 配置下降级运行但不缺席。

顺手小项（5 分钟，可并入任一 Worker 切片）：`FREEZONE_NEWAPI_VIDEO_BACKENDS` 白名单（`freezone/video_node.py:112`）补 `seedance-2.5`。

## Goal Oracle

```text
L1 （沙箱必过）: PYTHONDONTWRITEBYTECODE=1 ./.venv/bin/python src/novelvideo/generators/greybox_render.py
                 → "greybox_render self-check OK"
L2a（沙箱必过）: PYTHONDONTWRITEBYTECODE=1 ./.venv/bin/python src/novelvideo/generators/greybox_depth.py
                 → 依赖就绪；哑模型形状契约断言 ndim==2 (H,W)（T011 修复后）
L2b（环境门槛）: HTTPS_PROXY=http://127.0.0.1:7897 ./.venv/bin/python -c "load+predict 单帧断言"
                 → 代理死则 SKIP + 复跑命令，禁止假过
L3 合成腿（沙箱必过）: ffmpeg testsrc+sine 合成源 → 抽帧 → jobs.py 同款合帧 → ffprobe 时长±1s + 音轨 + 分辨率
L3 真实腿（环境门槛）: 真实视频 → 端点 → ffprobe 时长≈源(容差1s) + 音轨 + 分辨率；目视项为主人体检
```

> 解释器必须显式 `./.venv/bin/python`：本机裸 `python` 是 mise 3.14.0 且**无项目 editable 安装**，字面执行必 `ModuleNotFoundError: novelvideo`，属环境假阴性。验收标准不变，仅消除误判（T002 裁决）。

PM 必须持续把任务 receipt 对照此 oracle。计划、发现、单个小切片通过都不算完成；只有终审把 receipt 与验证证据映射回原始 outcome 才可记 `full_outcome_complete: true`。

## Goal Kind

`existing_plan`

## Current Tranche

连续执行到全部 5 项功能完成：先完成白模（Scout 盘点测试环境 → Judge 锁 oracle → 三个 Worker 垂直切片 → 分层测试 + 证据报告），随后按优先级推进 T007-T010 四个功能包，每包遵循「Judge 细化 → Worker 实施 → 验证」节奏。任一切片在沙箱内不可验证时，标记 blocked 并继续其余本地工作，不得停板。

## Non-Negotiable Constraints

- 功能代码只读能力目录声明，不写死模型名/数字（白模本身纯本地，天然满足）
- 不改动现有 video op（upscale/erase/compose）任何代码路径；`FREEZONE_LEAF_EGRESS` 只增键不改旧条目
- 端点入队显式 `queue_kind="video"`（默认 `ffmpeg` 是轻活道；`world` 每用户仅 1 槽）
- 前端不做配置浮层，参数全走请求体（计划明确的 ponytail 决策）
- i18n 三语扁平叶子键数对齐（实测当前各 6387 键，顶层 `len()` 只有 64 的旧检查无效）
- 破坏性操作（删除、reset、push）需主人明确批准

## Stop Rule

仅当终审证明原始 outcome 完整达成才停：剩余接线完成 + 分层测试证据在档 + 证据报告产出。沙箱内不可执行的验证项，须有明确的环境阻塞 receipt 与真实环境复跑命令，不得假装通过。
