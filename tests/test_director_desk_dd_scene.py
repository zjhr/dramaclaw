# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""dd-scene → v2 `director_apply` 的迁移层。

这块是 T009 的核心：DramaClaw 的 agent 对话链路产出 ```dd-scene 块，而 v2 导演台的
接口语义与 MONOFORM 白模台**相反** ——

    MONOFORM：拿已有工程**整体覆盖**（applyDirectorSceneIntent → localStorage）
    v2     ：对当前工程施加一批**增量操作**（toDirectorOperations → director_apply）

沿用旧语义会做两件错事：写一个 v2 根本不读的 localStorage 键，以及把用户在 v2 里
手摆的物一起抹掉。

## 为什么这个测试要拉起 node

参数形状**不靠字段名猜**。测试用 `--experimental-strip-types` 把上游自己的
`validateToolInput` / `applyOperations` / `assertProject` 拉起来，把本仓翻译层产出的
操作数组原样喂进去：

- `validateToolInput`（`automation/validate.ts`）—— JSON Schema 那一层，
  字段名拼错 / 类型不对 / 多余键都在这里被拒；
- `applyOperations + assertProject`（`automation/edits.ts` + `model.ts`）—— 语义那一层，
  资产 id 存不存在、关节名合不合法、id 会不会重复、notes 的 actorId 指不指得到人，
  全在这里。

这两层分开的原因值得记下来：`validateToolInput` **不管 id 重复**，
`assertProject` 才管（`model.ts:256`）。只跑前一层会漏掉「agent 连着两轮说同样的话」
这类只在第二轮才炸的问题 —— 本文件里的 `test_synthetic_ids_do_not_collide_across_turns`
就是被它抓出来的。

翻译层本身是纯 TS（`frontend/src/features/canvas/nodes/directorScenePatch.ts`，无任何
import），node 的类型擦除能直接吃，所以测试不需要先构建前端。
"""

from __future__ import annotations

import json
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
FRONTEND_SRC = REPO / "frontend" / "src" / "features" / "canvas" / "nodes"
VENDOR_SRC = REPO / "frontend" / "vendor" / "director-desk" / "src"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None,
    reason="验证上游参数形状需要 node（--experimental-strip-types）",
)

# `.gitignore:104` 把 `/frontend/vendor/` 整个排除了 —— vendored 上游源码是**本地构建
# 输入**，不入库。所以本文件里所有「拉起上游代码」的用例在没 vendor 的机器上跑不了
# （fresh clone 会整文件跳过）。这是仓库现状，不是本切片引入的；入库的那一份是
# `frontend/public/director-desk-v2/` 的构建产物，由 test_speech_bubble_bundle_* 钉住。
requires_vendor = pytest.mark.skipif(
    not VENDOR_SRC.is_dir(),
    reason="frontend/vendor/ 未入库（.gitignore 排除），本机没有 vendored 上游源码",
)


# ── node 侧的驱动脚本 ───────────────────────────────────────────────────────────
#
# 一次调用做完全部事：翻译 → 上游校验 → 上游 apply → 回读结果。
# 拆成多次调用会让「翻译用的工程状态」与「apply 的工程状态」不同步，
# 反而测不出跨轮次的 id 冲突。

_HARNESS = """
const NODES = %(nodes)s;
const B = %(vendor)s;
const PATCH = %(patch)s;

const { toDirectorOperations, readDirectorPromptDrafts, writeDirectorPromptDraft,
        directorPromptField, DIRECTOR_PROMPT_MODES } =
  await import(PATCH);
const { validateToolInput } = await import(`${B}/automation/validate.ts`);
const { applyOperations } = await import(`${B}/automation/edits.ts`);
const { assertProject } = await import(`${B}/model.ts`);
const { createScene } = await import(`${B}/scenes.ts`);

const emptyProduction = () => ({ fixedPrompt: '', sceneReferenceIds: [], notes: [] });
let project = createScene('blank');
const cameraId = () => project.entities.find((e) => e.kind === 'camera')?.id;
const ids = () => project.entities.map((e) => e.id);
const errors = [];

function runCase(c) {
  const translation = toDirectorOperations(
    c.intent,
    'production' in c ? c.production : emptyProduction(),
    c.useCamera === false ? undefined : cameraId(),
    c.occupied ?? ids(),
  );
  const record = { name: c.name, operations: translation.operations,
                   dropped: translation.dropped, speech: translation.speech,
                   characters: translation.characters.map((x) => ({ id: x.id, name: x.name })) };
  if (!translation.operations.length) { record.applied = false; return record; }
  // 第一层：JSON Schema。
  try {
    validateToolInput('director_apply', { revision: 1, requestId: 'r-' + c.name, operations: translation.operations });
  } catch (error) {
    record.schemaError = String(error.message ?? error);
    return record;
  }
  // 第二层：真实语义。跨轮次时把本轮结果提交进工程。
  try {
    if (c.commit) project = applyOperations(project, translation.operations);
    else { applyOperations(project, translation.operations); }
    record.applied = true;
  } catch (error) {
    record.applyError = String(error.message ?? error);
  }
  return record;
}

const results = NODES.map(runCase);

// 回读工程，供断言「既有数据没被抹掉」。
const result = {
  cases: results,
  production: project.production ?? null,
  entities: project.entities.map((e) => ({ id: e.id, kind: e.kind, asset: e.asset, name: e.name,
                                          position: e.position, rotation: e.rotation, color: e.color,
                                          path: e.path ?? null, pose: e.pose, poseKeys: e.poseKeys,
                                          clips: e.clips })),
  // 提示词双稿的合并语义（纯函数，不碰工程）。
  prompt: {
    fieldReference: directorPromptField('reference-video'),
    fieldTextOnly: directorPromptField('text-only'),
    modes: DIRECTOR_PROMPT_MODES,
    readEmpty: readDirectorPromptDrafts(undefined),
    readBoth: readDirectorPromptDrafts({ promptText: 'A', textOnlyPrompt: 'B', promptMode: 'text-only', fixedPrompt: 'F' }),
    switchModeKeepsBoth: writeDirectorPromptDraft(
      { promptText: 'A', textOnlyPrompt: 'B', fixedPrompt: 'F', sceneReferenceIds: [], notes: [] },
      { mode: 'text-only' }),
    writeOneKeepsOther: writeDirectorPromptDraft(
      { promptText: 'A', textOnlyPrompt: 'B', fixedPrompt: 'F', sceneReferenceIds: [], notes: [] },
      { referenceVideo: 'A2' }),
  },
};

if (errors.length) throw new Error(errors.join('\\n'));
process.stdout.write(JSON.stringify(result));
"""


@pytest.fixture(scope="module")
def desk() -> dict:
    """跑一遍 node 驱动，返回上游校验后的结构化结果。"""
    harness = _HARNESS % {
        "nodes": json.dumps(_CASES, ensure_ascii=False),
        "vendor": json.dumps(VENDOR_SRC.as_posix()),
        "patch": json.dumps((FRONTEND_SRC / "directorScenePatch.ts").as_posix()),
    }
    script = Path("/tmp/dramaclaw-dd-scene-harness.mjs")
    script.write_text(textwrap.dedent(harness), encoding="utf-8")
    proc = subprocess.run(
        ["node", "--experimental-strip-types", str(script)],
        capture_output=True,
        text=True,
        cwd=REPO,
        timeout=180,
    )
    assert proc.returncode == 0, f"node harness failed:\n{proc.stderr[-4000:]}"
    return json.loads(proc.stdout)


# ── 用例表（一个 node 进程里顺序跑，模拟 agent 连着说话）────────────────────────

_CASES = [
    {
        "name": "character",
        "commit": True,
        "intent": {
            "type": "director-desk-scene",
            "characters": [{
                "name": "甲", "at": [1, 2], "facing": 90, "color": "#ff0000",
                "pose": "stand", "controls": {"leftArm.pitch": -40, "leftElbow.bend": 30},
            }],
        },
    },
    {
        "name": "route",
        "commit": True,
        "intent": {
            "type": "director-desk-scene",
            "characters": [{"name": "乙", "route": [[-2.5, 1], [0, 0]], "routeDuration": 4, "start": 1}],
        },
    },
    {
        "name": "performance",
        "commit": True,
        "intent": {
            "type": "director-desk-scene",
            "characters": [{
                "name": "丙",
                "performance": [
                    {"t": 0, "controls": {"head.pitch": 12}},
                    {"t": 2, "controls": {"head.pitch": -8}},
                    {"t": 2, "controls": {"head.pitch": 5}},   # 与上一拍同秒 → 必须丢
                    {"t": 4, "controls": {"head.yaw": 30}},
                ],
            }],
        },
    },
    {
        "name": "props",
        "commit": True,
        "intent": {
            "type": "director-desk-scene",
            "objects": [
                {"type": "table", "at": [0, 0], "rotationY": 45, "scale": [1.7, 1, 1.1], "name": "桌"},
                {"type": "window", "at": [1, 0]},        # v2 目录无对应项 → 丢弃并记账
                {"type": "depthMesh", "at": [2, 0]},     # v2 无「灰度高度场」概念 → 丢弃
                {"type": "model", "at": [3, 0]},          # GLB 需先 import，不是 add 能表达的
            ],
        },
    },
    {
        "name": "camera",
        "commit": True,
        "intent": {
            "type": "director-desk-scene",
            "duration": 12,
            "camera": {"move": "orbit-left", "duration": 8, "start": 0.5},
        },
    },
    {
        "name": "lines",
        "commit": True,
        "production": {
            "fixedPrompt": "固定提示词头",
            "sceneReferenceIds": [],
            "notes": [{
                "id": "old-1", "start": 0, "end": 1, "actorId": "",
                "story": "旧拍点", "emotion": "", "dialogue": "", "action": "",
            }],
            "promptText": "参考视频稿", "textOnlyPrompt": "纯文本稿", "promptMode": "text-only",
        },
        "intent": {
            "type": "director-desk-scene",
            "characters": [{
                "name": "丁", "at": [0, 1],
                "lines": [
                    {"text": "我在这儿等你", "start": 0.5, "end": 2.5},
                    {"text": "   ", "start": 3, "end": 4},      # 纯空白 → 丢弃
                    {"text": "走吧", "start": 5, "end": 4},     # end <= start → 丢弃
                ],
            }],
        },
    },
    {
        # 纯增量：target 指向上一轮已建的角色，其余字段原样保留。
        "name": "target-update",
        "commit": True,
        "occupied": ["dd-char1"],
        "intent": {
            "type": "director-desk-scene",
            "characters": [{"target": "dd-char1", "at": [-3, 2], "facing": 180}],
        },
    },
    {
        "name": "missing-target",
        "commit": False,
        "intent": {
            "type": "director-desk-scene",
            "characters": [{"target": "查无此对象", "at": [0, 0]}],
        },
    },
    {
        "name": "reset",
        "commit": False,
        "intent": {"type": "director-desk-scene", "reset": True},
    },
    {
        # 连着三轮同样的「摆两个人」：合成 id 必须每轮都避开已占用的。
        "name": "turn-again-1", "commit": True,
        "intent": {"type": "director-desk-scene", "characters": [
            {"name": "戊", "at": [0, 3]}, {"name": "己", "at": [1, 3]}]},
    },
    {
        "name": "turn-again-2", "commit": True,
        "intent": {"type": "director-desk-scene", "characters": [
            {"name": "庚", "at": [0, 4]}, {"name": "辛", "at": [1, 4]}]},
    },
    {
        "name": "turn-again-3", "commit": True,
        "intent": {"type": "director-desk-scene", "characters": [
            {"name": "壬", "at": [0, 5]}, {"name": "癸", "at": [1, 5]}]},
    },
]


def _case(desk: dict, name: str) -> dict:
    for case in desk["cases"]:
        if case["name"] == name:
            return case
    raise AssertionError(f"用例 {name} 没跑出来")


# ── 1. 角色 / 道具 / 运镜 的映射 ───────────────────────────────────────────────


@requires_vendor
def test_character_maps_to_add_with_pose(desk):
    """角色 → add(human-adult)，位置/朝向/颜色/姿势落到上游真正认的字段上。"""
    case = _case(desk, "character")
    assert not case.get("schemaError"), case.get("schemaError")
    assert not case.get("applyError"), case.get("applyError")

    add = next(op for op in case["operations"] if op["operation"] == "add")
    assert add["asset"] == "human-adult"
    assert add["name"] == "甲"
    # MONOFORM 的 at:[x,z] → v2 的三维 position，y 恒为 0。
    assert add["position"] == [1.0, 0.0, 2.0]
    # facing 是度，v2 的 rotation 是弧度（model.ts:163 的 v3() + motion-presets 用弧度）。
    assert add["patch"]["rotation"][1] == pytest.approx(1.5707963, abs=1e-6)
    assert add["patch"]["color"] == "#ff0000"
    # MONOFORM 骨骼名 → v2 关节名（只有这 11 个能过 poseValid）。
    assert add["patch"]["pose"] == {"leftArm": -40.0, "leftElbow": 30.0}
    assert case["dropped"] == []


@requires_vendor
def test_route_maps_to_path_with_absolute_seconds(desk):
    """route → path.points；v2 的 point.time 是绝对秒数（不是 MONOFORM 的序号）。"""
    case = _case(desk, "route")
    assert not case.get("applyError"), case.get("applyError")
    add = next(op for op in case["operations"] if op["operation"] == "add")
    points = add["patch"]["path"]["points"]
    assert [p["position"] for p in points] == [[-2.5, 0.0, 1.0], [0.0, 0.0, 0.0]]
    assert points[0]["time"] == 1.0            # start
    assert points[1]["time"] == pytest.approx(5.0)  # start + routeDuration


@requires_vendor
def test_performance_beats_map_to_pose_keys(desk):
    """performance 拍点 → poseKeys；同秒的重复拍点必须丢掉（model.ts:274 会拒绝）。"""
    case = _case(desk, "performance")
    assert not case.get("applyError"), case.get("applyError")
    add = next(op for op in case["operations"] if op["operation"] == "add")
    keys = add["patch"]["poseKeys"]
    assert [k["time"] for k in keys] == [0.0, 2.0, 4.0]
    assert keys[0]["pose"] == {"head": 12.0}
    assert keys[1]["pose"] == {"head": -8.0}
    assert keys[2]["pose"] == {"headYaw": 30.0}
    assert any("重复" in d for d in case["dropped"])


@requires_vendor
def test_props_map_to_real_catalog_assets(desk):
    """道具 → v2 资产目录里真实存在的 id；目录没有的类型丢弃并如实记账。"""
    case = _case(desk, "props")
    assert not case.get("applyError"), case.get("applyError")
    add = next(op for op in case["operations"] if op["operation"] == "add")
    assert add["asset"] == "furniture-table"
    assert add["name"] == "桌"
    assert add["patch"]["rotation"][1] == pytest.approx(0.7853982, abs=1e-6)
    assert add["patch"]["scale"] == [1.7, 1.0, 1.1]
    # 上游没有 window / roof / 灰度高度场 / 直接摆 GLB 这几项 —— 必须报出来而不是静默。
    for token in ("window", "depthMesh", "model"):
        assert any(token in d for d in case["dropped"]), case["dropped"]


@requires_vendor
def test_camera_maps_to_camera_motion(desk):
    """运镜 → camera-motion{id:cameraId, asset:preset}；id 必填是硬约束。"""
    case = _case(desk, "camera")
    assert not case.get("applyError"), case.get("applyError")
    move = next(op for op in case["operations"] if op["operation"] == "camera-motion")
    assert move["asset"] == "arc"
    # orbit-left → arc 且 side=-1（v2 的环绕方向由 patch.side 表达，不是负 asset）。
    assert move["patch"]["side"] == -1
    assert move["time"] == 0.5
    assert move["duration"] == 8.0
    # 顶层 duration → project patch，而不是独立操作。
    project_op = next(op for op in case["operations"] if op["operation"] == "project")
    assert project_op["patch"]["duration"] == 12.0


@requires_vendor
def test_camera_move_vocabulary_is_mapped_to_real_presets(desk):
    """16 个 DirectorCameraMove 必须都能对上 v2 的 CAMERA_PRESETS，不留悬空 id。"""
    proc = subprocess.run(
        ["node", "--experimental-strip-types", "-e", textwrap.dedent(f"""
            const B = {json.dumps(VENDOR_SRC.as_posix())};
            const {{ CAMERA_PRESETS }} = await import(`${{B}}/cinematography/motion-presets.ts`);
            const {{ toDirectorOperations }} = await import(
                {json.dumps((FRONTEND_SRC / 'directorScenePatch.ts').as_posix())});
            const moves = ['dolly-in','dolly-out','orbit-left','orbit-right','pan-left','pan-right',
              'crane-up','crane-down','rail-left','rail-right','zoom-in','zoom-out',
              'handheld','pov','over-shoulder','static'];
            const bad = [];
            for (const move of moves) {{
              const t = toDirectorOperations(
                {{ type:'director-desk-scene', camera:{{ move, duration: 4 }} }},
                undefined, 'cam-1', []);
              const op = t.operations.find((o) => o.operation === 'camera-motion');
              if (!op || !Object.hasOwn(CAMERA_PRESETS, op.asset)) bad.push(move);
            }}
            process.stdout.write(JSON.stringify(bad));
        """)],
        capture_output=True, text=True, cwd=REPO, timeout=120,
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    assert json.loads(proc.stdout) == []


# ── 2. 语音气泡：台词 → production.notes 拍点 ──────────────────────────────────


@requires_vendor
def test_lines_become_production_notes_with_actor_binding(desk):
    """台词 → notes 拍点：定位靠 actorId、时长靠 start/end、台词靠 dialogue。"""
    case = _case(desk, "lines")
    assert not case.get("applyError"), case.get("applyError")
    assert len(case["speech"]) == 1
    line = case["speech"][0]
    assert line["text"] == "我在这儿等你"
    assert (line["start"], line["end"]) == (0.5, 2.5)
    # actorId 必须是这一轮真正建出来的实体 id —— 气泡靠它把气泡挂到头顶。
    assert line["actorId"] == case["characters"][0]["id"]

    note_ops = [op for op in case["operations"] if op["operation"] == "notes"]
    assert len(note_ops) == 1, "台词必须整批走一条 notes 操作"
    notes = note_ops[0]["value"]["notes"]
    spoken = [n for n in notes if n["dialogue"]]
    assert len(spoken) == 1
    assert spoken[0]["dialogue"] == "我在这儿等你"
    assert spoken[0]["start"] == 0.5 and spoken[0]["end"] == 2.5
    # 空白台词与时长非正的台词被丢弃并记账。
    assert any("台词为空或时长非正" in d for d in case["dropped"])


@requires_vendor
def test_notes_round_trip_preserves_existing_drafts_and_notes(desk):
    """`notes` 是完整替换：既有拍点、两份提示词文稿、promptMode 一个都不能少。"""
    production = desk["production"]
    assert production["fixedPrompt"] == "固定提示词头"
    assert production["promptText"] == "参考视频稿"
    assert production["textOnlyPrompt"] == "纯文本稿"
    assert production["promptMode"] == "text-only"
    old = [n for n in production["notes"] if n["id"] == "old-1"]
    assert len(old) == 1 and old[0]["story"] == "旧拍点", "旧拍点被清空了"
    assert any(n["dialogue"] == "我在这儿等你" for n in production["notes"])


# ── 3. 跨轮次：合成 id 不能撞 ─────────────────────────────────────────────────


@requires_vendor
def test_synthetic_ids_do_not_collide_across_turns(desk):
    """回归：合成 id 按批内序号生成，不避开已占用 id 就会让第二轮整批回滚。

    这个 bug 只在 `assertProject`（`model.ts:256` 的 `ids.has(e.id)`）里暴露，
    `validateToolInput` 查不出来 —— 所以这里断言的是 apply 结果，不是 schema。
    """
    ids = [case["characters"][0]["id"] for case in
           (_case(desk, "turn-again-1"), _case(desk, "turn-again-2"), _case(desk, "turn-again-3"))]
    for case in ids:
        assert case is not None
    assert len(set(ids)) == 3, f"三轮的合成 id 撞了：{ids}"
    for name in ("turn-again-1", "turn-again-2", "turn-again-3"):
        case = _case(desk, name)
        assert not case.get("applyError"), case.get("applyError")

    # 第一轮的 dd-char1 在第三轮之后仍然只有一条实体。
    engine_ids = [e["id"] for e in desk["entities"]]
    assert len(engine_ids) == len(set(engine_ids)), "工程里出现了重复 id"


@requires_vendor
def test_target_update_is_incremental(desk):
    """target 增量修改只覆盖显式给的字段，其余（颜色/姿势）原样保留。"""
    case = _case(desk, "target-update")
    assert not case.get("applyError"), case.get("applyError")
    op = case["operations"][0]
    assert op["operation"] == "update"
    assert op["id"] == "dd-char1"
    assert op["patch"]["position"] == [-3.0, 0.0, 2.0]
    assert "color" not in op["patch"], "增量不该顺手改写用户没提到的颜色"

    entity = next(e for e in desk["entities"] if e["id"] == "dd-char1")
    assert entity["color"] == "#ff0000", "甲的颜色被抹掉了"
    assert entity["pose"] == {"leftArm": -40.0, "leftElbow": 30.0}
    assert entity["position"] == [-3.0, 0.0, 2.0]


@requires_vendor
def test_missing_target_is_reported_not_silently_skipped(desk):
    case = _case(desk, "missing-target")
    assert any("工程里没有这个对象" in d for d in case["dropped"]), case["dropped"]


@requires_vendor
def test_reset_is_refused_with_reason(desk):
    """v2 没有「清空画布」；翻译层不造 remove 批次，但要说明为什么。"""
    case = _case(desk, "reset")
    assert case["operations"] == []
    assert any("reset" in d for d in case["dropped"])


# ── 4. engine 分支收敛，MONOFORM 分支仍在且可达 ──────────────────────────────


def test_engine_default_is_director_and_monofrom_branch_is_reachable():
    """默认 engine 必须是 director，且 monoform 分支的代码与调用点都还在。"""
    skills = (FRONTEND_SRC / "directorDeskSkills.ts").read_text(encoding="utf-8")
    panel = (FRONTEND_SRC / "DirectorDeskChatPanel.tsx").read_text(encoding="utf-8")
    node = (FRONTEND_SRC / "DirectorDeskNode.tsx").read_text(encoding="utf-8")

    # 默认值全部是 'director'（TS 的默认参数写法）。
    assert "engine: DirectorDeskEngine = 'director'" in skills
    assert "engine: DirectorDeskEngine = 'director'," in panel
    assert "engine = 'director'," in panel
    # 导演台节点不传 engine → 走默认的 director。
    assert 'engine="monoform"' not in node

    # monoform 分支仍在且可达：面板按 engine 分流。
    assert "if (engine === 'monoform') onSceneIntent?.(intent);" in panel
    assert "Boolean(onDirectorScene ?? onSceneIntent)" in panel
    # v2 主链路：director 引擎优先走 onDirectorScene（→ director_apply 增量操作），
    # onSceneIntent 只是还没迁完的宿主的兼容垫片。
    assert "else (onDirectorScene ?? onSceneIntent)?.(intent);" in panel
    # MONOFORM 的节点仍显式传 engine="monoform"（既有工程要能打开）。
    monoform_node = FRONTEND_SRC / "MonoformDeskNode.tsx"
    assert monoform_node.exists(), "MONOFORM 节点被删了 —— 既有工程打不开"
    assert 'engine="monoform"' in monoform_node.read_text(encoding="utf-8")


def test_monofrom_local_storage_path_still_exists():
    """MONOFORM 的整体覆盖路径必须原样保留（.director 是单向不可逆迁移）。"""
    patch = (FRONTEND_SRC / "directorScenePatch.ts").read_text(encoding="utf-8")
    node = (FRONTEND_SRC / "DirectorDeskNode.tsx").read_text(encoding="utf-8")
    assert "export function applyDirectorSceneIntent(" in patch
    assert "export function applyDirectorSceneToStorage(" in node
    assert "applyDirectorSceneToStorage" in node, "MONOFORM 注入胶水被删了"


# ── 5. 既有 MONOFORM 工程的可读性（回灌路径没被破坏） ─────────────────────────


@requires_vendor
def test_existing_monofrom_project_still_readable(desk):
    """MONOFORM 工程（objects/cameras 那套结构）不能被 v2 迁移层碰到。

    这里用真实的 MONOFORM 工程形状跑一遍 `applyDirectorSceneIntent`：确认它仍然
    只改它该改的字段，其余原样带回 —— v2 的迁移没有污染它。
    """
    proc = subprocess.run(
        ["node", "--experimental-strip-types", "-e", textwrap.dedent(f"""
            const P = {json.dumps((FRONTEND_SRC / 'directorScenePatch.ts').as_posix())};
            const {{ applyDirectorSceneIntent }} = await import(P);
            // 一个「既有 MONOFORM 工程」：用户手摆了一个道具 + 一台固定机位。
            const project = {{
              objects: [
                {{ id: 'user_prop_1', name: '用户摆的道具', kind: 'primitive', type: 'box',
                   transform: {{ position: [5, 1, 5], rotation: [0,0,0], scale: [1,1,1] }} }},
                {{ id: 'aigen_char_1', name: '上一轮的角色', kind: 'character',
                   transform: {{ position: [1,0,0], rotation: [0,0,0], scale: [1,1,1] }} }},
              ],
              cameras: [{{ id: 'cam_main', name: '主机位', transform: {{ position: [0,1.7,7], rotation:[0,0,0], scale:[1,1,1] }}, target: [0,1,0], fov: 50 }}],
              duration: 10, fps: 24,
            }};
            const next = applyDirectorSceneIntent(project, {{
              type: 'director-desk-scene',
              characters: [{{ at: [0, 0], name: '新角色' }}],
              camera: {{ move: 'orbit-left', duration: 6 }},
            }});
            process.stdout.write(JSON.stringify({{
              keptProp: next.objects.find((o) => o.id === 'user_prop_1'),
              keptPropPosition: next.objects.find((o) => o.id === 'user_prop_1').transform.position,
              cameraName: next.cameras[0].name,
              cameraFov: next.cameras[0].fov,
              duration: next.duration,
              fps: next.fps,
              keyframes: next.cameras[0].motionPath.keyframes.length,
              originalUnmutated: project.objects.length,
            }}));
        """)],
        capture_output=True, text=True, cwd=REPO, timeout=120,
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    out = json.loads(proc.stdout)

    # 用户手摆的道具原样保留（位置也没动）。
    assert out["keptProp"] is not None, "MONOFORM 的既有道具被删了"
    assert out["keptPropPosition"] == [5, 1, 5]
    # 机位与工程设置仍在，且运镜被追加成 motionPath。
    assert out["cameraName"] == "主机位"
    assert out["cameraFov"] == 50
    assert out["keyframes"] == 4            # orbit-left 的 0/30/60/90 四拍
    assert out["duration"] == 10 and out["fps"] == 24
    # 入参没被就地改写（纯函数）。
    assert out["originalUnmutated"] == 2


# ── 6. 提示词工程产出层：两份文稿独立，切换模式不自动改写 ─────────────────────


@requires_vendor
def test_prompt_drafts_are_independent(desk):
    """两份文稿各自独立保留；切模式只改 promptMode，不搬运任何一份。"""
    prompt = desk["prompt"]
    assert prompt["fieldReference"] == "promptText"
    assert prompt["fieldTextOnly"] == "textOnlyPrompt"
    assert prompt["modes"] == ["reference-video", "text-only"]

    # 缺省模式 = 参考视频（上游 selectedPromptMode 的口径）。
    assert prompt["readEmpty"] == {
        "mode": "reference-video", "referenceVideo": "", "textOnly": "", "fixedPrompt": "",
    }
    # 两份同时读出来，调用方自己挑显示哪一份。
    assert prompt["readBoth"] == {
        "mode": "text-only", "referenceVideo": "A", "textOnly": "B", "fixedPrompt": "F",
    }

    # 切到纯文本：两份文稿原封不动。
    switched = prompt["switchModeKeepsBoth"]
    assert switched["promptMode"] == "text-only"
    assert switched["promptText"] == "A"
    assert switched["textOnlyPrompt"] == "B"
    assert switched["fixedPrompt"] == "F"

    # 改一份：另一份不动。
    written = prompt["writeOneKeepsOther"]
    assert written["promptText"] == "A2"
    assert written["textOnlyPrompt"] == "B"


@requires_vendor
def test_prompt_draft_fields_survive_a_notes_commit(desk):
    """走真实 `director_apply notes` 之后，两份文稿仍在工程里。"""
    production = desk["production"]
    assert production["promptText"] and production["textOnlyPrompt"]


# ── 7. 语音气泡的渲染层（vendor 侧） ─────────────────────────────────────────


def test_speech_bubble_overlay_is_mounted_in_the_desk():
    """气泡叠加层必须在 vendored 导演台里挂上，否则台词只落在时间轴上看不到。

    注意 `.gitignore:104` 把 `/frontend/vendor/` 整个排除了 —— vendored 源码是**本地
    构建输入**，不入库。所以这条用例在有源码的机器上才跑得起来；只有入库的构建产物
    才是任何人 clone 下来都有的东西，那部分由下一条钉住。
    """
    overlay = VENDOR_SRC / "ui" / "speech-bubbles.ts"
    if not overlay.exists():
        pytest.skip("frontend/vendor/ 未入库（.gitignore 排除），本机没有 vendored 源码可查")
    events = (VENDOR_SRC / "ui" / "events.ts").read_text(encoding="utf-8")
    assert "mountSpeechBubbles(ctx)" in events, "叠加层没有挂载点"
    source = overlay.read_text(encoding="utf-8")
    # 气泡数据来源必须是 v2 的 production.notes（不是另造一份状态）。
    assert "production?.notes" in source
    # 定位靠 actorId 找实体，头顶投影到镜头画布。
    assert "actorId" in source and "entityPosition" in source
    # 淡入淡出与 MONOFORM 同口径。
    assert "SPEECH_FADE_SECONDS" in source


def test_speech_bubble_bundle_is_built_into_public_assets():
    """产物里必须真的带上气泡代码（源码改了但没同步构建是最常见的漏）。

    这是**入库的那一份**：`frontend/public/director-desk-v2/` 受版本控制，任何人
    clone 下来都带着它 —— 气泡能力随它走，不依赖被 gitignore 的 vendored 源码。
    """
    assets = REPO / "frontend" / "public" / "director-desk-v2" / "assets"
    assert assets.is_dir(), "director-desk-v2 产物缺失"
    hits = [
        p for p in assets.iterdir()
        if "speech-bubble" in p.read_text(encoding="utf-8", errors="ignore")
    ]
    assert hits, "构建产物里找不到气泡代码，需要重新 npm run build 并同步"
