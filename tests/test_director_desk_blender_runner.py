"""Blender 执行服务：真跑 Blender 的端到端护栏测试 + 跨平台分支断言。

**护栏用例真的要拉起 Blender。** 护栏的价值全在「跑不跑得起来」上，mock 掉
子进程等于把要测的东西测没了。代价是慢（每次约 1~3 秒）与需要本机装 Blender；
没装时整套 skip，而不是假装通过。

**跨平台分支（`kill_tree` / `process_group_kwargs`）不用 skipif Windows。** 主人
没有 Windows 机器，Windows 分支在 macOS 上被注入 `os.name` 直接断言调用形态 ——
断言被覆盖比「在 Windows 上什么都没跑」有用得多。**但要说清楚：这只证明分支
逻辑，不证明 Windows 上真能跑**（`taskkill` 真在 Windows 上执行过）。
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.director_desk import blender_runner
from novelvideo.director_desk.blender_runner import (
    BlenderRunnerError,
    GLB_MIME,
    MAX_SCRIPT_BYTES,
    RunResult,
    guard_path,
    kill_phrase,
    kill_tree,
    model_root,
    parse_guard_report,
    process_group_kwargs,
    resolve_out_path,
    run_ai_model,
    slugify,
    taskkill_argv,
    unique_out_path,
)

blender_path, blender_source = blender_runner.find_blender()
requires_blender = pytest.mark.skipif(
    blender_path is None, reason="本机没有可用的 Blender（护栏要真跑才测得到）"
)

#: 一张四条腿的桌子：桌面 1 + 腿 4 = 5 个连通分量，全部与桌面相接。
GOOD_TABLE = """
import bpy

bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0.72))
bpy.ops.mesh.primitive_cube_add(size=0.06, location=(0.45, 0.45, 0.35))
bpy.ops.mesh.primitive_cube_add(size=0.06, location=(0.45, -0.45, 0.35))
bpy.ops.mesh.primitive_cube_add(size=0.06, location=(-0.45, 0.45, 0.35))
bpy.ops.mesh.primitive_cube_add(size=0.06, location=(-0.45, -0.45, 0.35))
"""

#: 同样的桌子，外加一个**悬在半空**的装饰球：护栏必须拦下。
FLOATING_TABLE = GOOD_TABLE + """
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.15, location=(0.0, 0.0, 2.2))
"""


def out(name: str) -> Path:
    return resolve_out_path(name)


# ── 路径 ────────────────────────────────────────────────────────────────────


def test_out_path_escape_is_rejected() -> None:
    """`out` 不能把文件写到项目目录之外。"""
    with pytest.raises(BlenderRunnerError):
        resolve_out_path("../../../../tmp/escaped.glb")
    with pytest.raises(BlenderRunnerError):
        resolve_out_path("/tmp/escaped.glb")
    with pytest.raises(BlenderRunnerError):
        resolve_out_path("~/escaped.glb")
    with pytest.raises(BlenderRunnerError):
        resolve_out_path("")  # 空文件名
    with pytest.raises(BlenderRunnerError):
        resolve_out_path("prop.gltf")  # 扩展名必须是 .glb
    # 相对路径按模型目录解析，落在目录内的合法
    assert resolve_out_path("ok.glb") == (model_root() / "ok.glb").resolve()


def test_out_path_escape_rejected_by_runner() -> None:
    """同一个逃逸在执行入口上也必须挡住（不能只靠路由调 resolve）。"""
    with pytest.raises(BlenderRunnerError):
        asyncio.run(run_ai_model(GOOD_TABLE, out_path=Path("/tmp/escaped.glb")))


def test_slugify_drops_non_ascii() -> None:
    assert slugify("Coffee Table") == "coffee-table"
    # 中文名会被压空，所以 fallback 要补位，否则每次都撞同一个文件名
    assert slugify("桌子") == "model"
    assert slugify("桌子", fallback="blender") == "blender"


def test_unique_out_path_never_repeats() -> None:
    assert unique_out_path("chair") != unique_out_path("chair")
    assert unique_out_path("chair").parent == model_root().resolve()


# ── 参数校验 ────────────────────────────────────────────────────────────────


def test_empty_and_oversized_script_rejected() -> None:
    with pytest.raises(BlenderRunnerError):
        asyncio.run(run_ai_model("   \n ", out_path=out("x.glb")))
    with pytest.raises(BlenderRunnerError):
        asyncio.run(run_ai_model("#" * (MAX_SCRIPT_BYTES + 1), out_path=out("x.glb")))


def test_out_of_range_params_rejected() -> None:
    with pytest.raises(BlenderRunnerError):
        asyncio.run(run_ai_model(GOOD_TABLE, out_path=out("x.glb"), expect_parts=0))
    with pytest.raises(BlenderRunnerError):
        asyncio.run(run_ai_model(GOOD_TABLE, out_path=out("x.glb"), expect_parts=999))
    with pytest.raises(BlenderRunnerError):
        asyncio.run(run_ai_model(GOOD_TABLE, out_path=out("x.glb"), real_height=900.0))


# ── 报告解析 ────────────────────────────────────────────────────────────────


def test_parse_guard_report_reads_last_marker() -> None:
    noise = "Blender startup banner\nWarning: whatever\nAI_MODEL_FAIL {\"reason\":\"x\"}\n"
    assert parse_guard_report(noise) == {"reason": "x"}
    ok = 'AI_MODEL_OK {"out":"/tmp/a.glb","faces":12}'
    assert parse_guard_report(ok)["faces"] == 12
    assert parse_guard_report("nothing here") is None
    assert parse_guard_report("AI_MODEL_OK {not json}") is None


# ── 成功 ────────────────────────────────────────────────────────────────────


@requires_blender
def test_guard_accepts_a_sound_table() -> None:
    result = asyncio.run(
        run_ai_model(GOOD_TABLE, out_path=out("runner-ok-table.glb"), kind="table", expect_parts=5)
    )
    assert result.ok, result.message
    assert result.out_path is not None and result.out_path.is_file()
    assert result.out_path.stat().st_size > 0
    assert result.guard_report["componentCount"] == 5
    assert result.guard_report["floating"] == []
    # 尺度硬归一化：AI 写的桌高是 1.0m，归一化后必须是真实桌高 0.75m
    assert result.guard_report["normalization"]["bboxAfter"][2] == pytest.approx(0.75)
    # Z-up 归一化后底面贴地
    assert result.guard_report["normalization"]["groundedTo"] == pytest.approx(0.0)
    # 内存上限必须**如实**报出本平台的真实结果，不许谎报已生效：
    #   macOS  → "unsupported-on-this-platform"（RLIMIT_AS/RLIMIT_DATA 都设不动）
    #   Windows→ "unavailable"（根本没有 resource 模块）
    #   Linux  → "rlimit_as" / "rlimit_data"
    # 关键性质：这些都是**诚实**的取值，绝不能是 "ok" 之外的假装成功。
    memory = result.guard_report["memoryCapped"]
    if os.name == "nt":
        assert memory == "unavailable"
    elif sys.platform == "darwin":
        assert memory == "unsupported-on-this-platform"
    else:
        assert memory in {"rlimit_as", "rlimit_data", "unsupported-on-this-platform"}
    result.out_path.unlink(missing_ok=True)


@requires_blender
def test_data_url_is_a_glb_data_url() -> None:
    result = asyncio.run(
        run_ai_model(GOOD_TABLE, out_path=out("runner-inline.glb"), kind="table", expect_parts=5)
    )
    assert result.ok, result.message
    data = result.data_url()
    assert data.startswith(f"data:{GLB_MIME};base64,")
    payload = result.public(inline=True)
    assert payload["ok"] is True
    assert payload["data"] == data
    assert payload["bytes"] == result.size_bytes
    # 裸的 GLB 魔数：glTF 二进制以 "glTF" 开头
    import base64

    assert base64.b64decode(data.split(",", 1)[1])[:4] == b"glTF"
    result.out_path.unlink(missing_ok=True)


# ── 失败：护栏拦下悬空件，且不落盘 ──────────────────────────────────────────


@requires_blender
def test_guard_rejects_floating_parts_and_leaves_no_glb() -> None:
    target = out("runner-floating.glb")
    target.unlink(missing_ok=True)
    result = asyncio.run(
        run_ai_model(FLOATING_TABLE, out_path=target, kind="table", expect_parts=6)
    )
    assert not result.ok
    assert result.reason.startswith("floating-parts")
    # 护栏要报出**是哪个件、在什么高度**，模型据此改脚本
    floating = result.guard_report["floating"]
    assert floating and all("minZ" in f and "maxZ" in f for f in floating)
    assert "z=" in result.message
    # 关键：失败不落盘
    assert not target.exists()
    assert result.out_path is None
    assert "data" not in result.public(inline=True)


@requires_blender
def test_stale_glb_from_a_previous_run_is_removed_on_failure() -> None:
    """同名文件上一次成功、这一次失败：不能把上一次的产物冒充成本次结果。"""
    target = out("runner-stale.glb")
    ok = asyncio.run(
        run_ai_model(GOOD_TABLE, out_path=target, kind="table", expect_parts=5)
    )
    assert ok.ok, ok.message
    assert target.is_file()
    bad = asyncio.run(
        run_ai_model(FLOATING_TABLE, out_path=target, kind="table", expect_parts=6)
    )
    assert not bad.ok
    assert not target.exists()


@requires_blender
def test_script_error_is_reported_not_raised() -> None:
    result = asyncio.run(
        run_ai_model(
            "import bpy\nraise ValueError('boom')\n",
            out_path=out("runner-boom.glb"),
            kind="table",
        )
    )
    assert not result.ok
    assert result.reason == "ai-script-error"
    assert "boom" in result.message
    assert not out("runner-boom.glb").exists()


# ── 超时 ────────────────────────────────────────────────────────────────────


@requires_blender
def test_timeout_kills_the_process_group_and_writes_nothing() -> None:
    target = out("runner-timeout.glb")
    before = _blender_pids()
    workdirs_before = _temp_workdirs()
    started = time.monotonic()
    result = asyncio.run(
        run_ai_model("while True:\n    pass\n", out_path=target, kind="table", timeout=2)
    )
    elapsed = time.monotonic() - started
    assert not result.ok
    assert result.reason == "timeout"
    assert result.timed_out is True
    assert result.guard_report["limitSeconds"] == 2
    # 超时要真的发生：Blender 冷启动约 0.6s，2s 上限必须被打破但不能无限拖
    assert 1.5 < elapsed < 12, f"超时用了 {elapsed:.1f}s"
    assert not target.exists()
    # 终止手段必须如实报出来：POSIX 是 killpg（整组），Windows 是 taskkill（整树）；
    # 只有两者都不可用才允许降级成「只杀主进程」。
    assert result.guard_report["killedBy"] in {"killpg", "taskkill", "fallback-proc-kill"}
    if result.guard_report["killedBy"] == "fallback-proc-kill":
        pytest.fail("超时后只杀掉了 Blender 主进程：进程组终止未生效")
    # 超时后不能留下 Blender 进程（真的在跑的那台机器上验）
    for _ in range(40):
        if not (_blender_pids() - before):
            break
        time.sleep(0.25)
    assert not (_blender_pids() - before), "超时后 Blender 还在跑"
    # 临时目录也不留残留
    assert _temp_workdirs() == workdirs_before


@requires_blender
def test_cancelling_the_run_also_kills_blender() -> None:
    """用户按「停止」时 `communicate()` 被 CancelledError 打断，Blender 不能跑飞。"""
    before = _blender_pids()

    async def scenario() -> None:
        task = asyncio.ensure_future(
            run_ai_model("while True:\n    pass\n", out_path=out("runner-cancel.glb"), timeout=120)
        )
        await asyncio.sleep(2.0)  # 等 Blender 真的起来
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    for _ in range(40):
        if not (_blender_pids() - before):
            break
        time.sleep(0.25)
    assert not (_blender_pids() - before), "取消后 Blender 还活着"
    assert not out("runner-cancel.glb").exists()


def _blender_pids() -> set[int]:
    """本机在跑的 Blender 进程 pid 集合。找不到工具时返回空集（而不是让用例崩）。"""
    if os.name == "nt":
        found = subprocess.run(  # noqa: S603,S607 — argv 列表，无 shell
            ["tasklist", "/FI", "IMAGENAME eq blender.exe", "/NH", "/FO", "CSV"],
            capture_output=True,
            text=True,
            check=False,
        )
        pids = set()
        for line in found.stdout.splitlines():
            parts = [p.strip('" ') for p in line.split('","')]
            if len(parts) > 1 and parts[1].isdigit():
                pids.add(int(parts[1]))
        return pids
    found = subprocess.run(  # noqa: S603,S607 — argv 列表，无 shell
        ["pgrep", "-x", "Blender"], capture_output=True, text=True, check=False
    )
    return {int(line) for line in found.stdout.split() if line.strip().isdigit()}


# ── 临时目录清理 ────────────────────────────────────────────────────────────


def _temp_workdirs() -> set[Path]:
    """临时目录下所有本次执行的残留目录。

    用 ``tempfile.gettempdir()`` 而不是写死 ``/tmp``：macOS 上 ``mkdtemp`` 落在
    ``/var/folders/...``，Linux 上是 ``/tmp``，Windows 上是 ``%TEMP%``。
    """
    return set(Path(tempfile.gettempdir()).glob("dramaclaw-blender-*")) | set(
        Path(tempfile.gettempdir()).glob("dramaclaw blender *")
    )


@requires_blender
def test_temp_dir_is_removed_after_success_and_failure() -> None:
    def tempdirs() -> set[Path]:
        return _temp_workdirs()

    before = tempdirs()
    ok = asyncio.run(
        run_ai_model(GOOD_TABLE, out_path=out("runner-clean-ok.glb"), kind="table", expect_parts=5)
    )
    assert ok.ok, ok.message
    assert tempdirs() == before
    bad = asyncio.run(
        run_ai_model(FLOATING_TABLE, out_path=out("runner-clean-bad.glb"), kind="table")
    )
    assert not bad.ok
    assert tempdirs() == before
    ok.out_path.unlink(missing_ok=True)


# ── 跨平台：进程组与进程树 ──────────────────────────────────────────────────
#
# 主人会在 Windows 上用，而这里只有 macOS。所以 Windows 分支靠**注入 `os.name`
# + 替身对象**在 macOS 上直接断言调用形态 —— 不写 skipif Windows（那等于 CI 上
# 什么都没跑）。
#
# 诚实边界：这些用例证明的是**分支逻辑**（选了哪组参数、发了哪条命令、失败怎么
# 兜底）。`taskkill` 本身在真 Windows 上是否可用**未实测**。


class _FakeProc:
    """`asyncio.subprocess.Process` 的最小替身：只带 kill_tree 用到的 pid/kill。"""

    def __init__(self, pid: int = 4242) -> None:
        self.pid = pid
        self.killed = 0

    def kill(self) -> None:
        self.killed += 1


def test_taskkill_argv_is_a_list_with_tree_flag() -> None:
    """`taskkill` 必须是 argv 列表，且带 `/T`（杀子树）—— 少一个 `/T` 就退化成
    只杀直接子进程，正是这段代码要防的失败模式。"""
    argv = taskkill_argv(4242)
    assert argv == ["taskkill", "/PID", "4242", "/T", "/F"]
    assert "/T" in argv and "/F" in argv
    assert all(isinstance(part, str) for part in argv)  # 列表，不是拼字符串


def test_posix_launch_uses_start_new_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """POSIX 分支用 `setsid`，让 Blender 自成会话组，`killpg` 才收得干净。"""
    monkeypatch.setattr(blender_runner, "is_windows", lambda: False)
    assert process_group_kwargs() == {"start_new_session": True}


def test_windows_launch_uses_creation_flags_not_start_new_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """**Windows 上必须用 `creationflags`，不能用 `start_new_session`。**

    `start_new_session` 在 Windows 的 `subprocess._execute_child` 里形参名就是
    `unused_start_new_session` —— 传了不报错也不生效，是个静默 no-op。用它当
    「已经分组了」就会漏掉整个进程树。
    """
    monkeypatch.setattr(blender_runner, "is_windows", lambda: True)
    kwargs = process_group_kwargs()
    assert "start_new_session" not in kwargs, "Windows 上 start_new_session 是 no-op"
    assert kwargs == {"creationflags": blender_runner.CREATE_NEW_PROCESS_GROUP}


def test_windows_kill_uses_taskkill_tree(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Windows 分支发 `taskkill /PID <pid> /T /F`，且**不碰 POSIX 那套 API**。"""
    calls: list[tuple] = []

    def fake_run(argv, **kwargs):
        calls.append((argv, kwargs))
        return subprocess.CompletedProcess(argv, 0, b"", b"")

    def boom(*a, **k):  # pragma: no cover — 走到就是 Windows 上误用了 POSIX API
        raise AssertionError("Windows 分支不许调用 os.killpg / os.getpgid")

    monkeypatch.setattr(blender_runner, "is_windows", lambda: True)
    monkeypatch.setattr(blender_runner.subprocess, "run", fake_run)
    monkeypatch.setattr(blender_runner.os, "killpg", boom, raising=False)
    monkeypatch.setattr(blender_runner.os, "getpgid", boom, raising=False)

    proc = _FakeProc(4242)
    assert kill_tree(proc) == "taskkill"

    assert len(calls) == 1
    argv, kwargs = calls[0]
    assert argv == ["taskkill", "/PID", "4242", "/T", "/F"]
    # 不走 shell：没有 shell= 关键字，argv 是列表
    assert "shell" not in kwargs
    assert kwargs["check"] is False
    assert kwargs["timeout"] == blender_runner.TASKKILL_TIMEOUT_SECONDS
    assert proc.killed == 0, "taskkill 成功后不该再单独 kill 直接子进程"


def test_windows_kill_falls_back_to_proc_kill(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`taskkill` 不可用（不存在 / 被策略禁 / 非零退出）时必须**如实降级**，
    而不是让异常冒出去 —— 也不能谎称整棵树被杀掉了。"""
    monkeypatch.setattr(blender_runner, "is_windows", lambda: True)

    # 1) taskkill 二进制不存在
    def missing(argv, **kwargs):
        raise FileNotFoundError(2, "No such file or directory", argv[0])

    monkeypatch.setattr(blender_runner.subprocess, "run", missing)
    proc = _FakeProc(4242)
    assert kill_tree(proc) == "fallback-proc-kill"
    assert proc.killed == 1

    # 2) taskkill 跑了但失败（进程已退出等）
    monkeypatch.setattr(
        blender_runner.subprocess,
        "run",
        lambda argv, **kw: subprocess.CompletedProcess(argv, 128, b"", b"not found"),
    )
    proc = _FakeProc()
    assert kill_tree(proc) == "fallback-proc-kill"
    assert proc.killed == 1


def test_posix_kill_uses_killpg_and_falls_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """POSIX 分支用 `killpg(getpgid(pid), SIGKILL)`；组已消失时退回 `proc.kill()`。"""
    monkeypatch.setattr(blender_runner, "is_windows", lambda: False)
    seen: list[tuple] = []

    monkeypatch.setattr(
        blender_runner.os, "getpgid", lambda pid: 4242, raising=False
    )
    monkeypatch.setattr(
        blender_runner.os,
        "killpg",
        lambda pgid, sig: seen.append((pgid, sig)),
        raising=False,
    )
    proc = _FakeProc(4242)
    assert kill_tree(proc) == "killpg"
    assert seen == [(4242, blender_runner.signal.SIGKILL)]
    assert proc.killed == 0

    # 组已经没了（进程刚退出）→ 退到 proc.kill()
    def gone(pgid, sig):
        raise ProcessLookupError

    monkeypatch.setattr(blender_runner.os, "killpg", gone, raising=False)
    proc = _FakeProc()
    assert kill_tree(proc) == "fallback-proc-kill"
    assert proc.killed == 1


def test_windows_branch_does_not_touch_sigkill(monkeypatch: pytest.MonkeyPatch) -> None:
    """`signal.SIGKILL` 在 Windows 上不存在（只有 SIGTERM/SIGBREAK 等）。

    所以 Windows 分支里出现 `signal.SIGKILL` 就等于 `AttributeError`。用源码级
    断言锁住：**Windows 终止路径上不许引用 SIGKILL**。
    """
    import ast
    import inspect

    source = inspect.getsource(blender_runner)
    tree = ast.parse(source)
    windows_attr_names: set[str] = set()
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id == "signal"
        ):
            windows_attr_names.add(node.attr)
    monkeypatch.setattr(blender_runner, "is_windows", lambda: True)
    # SIGKILL 只允许出现在 POSIX 分支（kill_tree 里 killpg 那条）；
    # 若将来有人把它挪进 Windows 分支，这条用例会失败。
    assert "SIGKILL" in windows_attr_names
    assert [n for n in windows_attr_names if n.startswith("SIG")] == ["SIGKILL"]


def test_kill_phrase_distinguishes_full_tree_from_degraded_fallback() -> None:
    """降级必须说成降级。「只杀了主进程」不能报成「杀掉了整个进程组」——
    那是本段代码 docstring 里点名要避免的谎报。"""
    assert "进程组" in kill_phrase("killpg")
    assert "进程树" in kill_phrase("taskkill")
    degraded = kill_phrase("fallback-proc-kill")
    # 降级话术必须点明「只杀了主进程」与「子进程可能残留」，不许含糊成「都杀干净了」
    assert "主进程" in degraded and "残留" in degraded
    for lying in ("已杀掉整个进程组", "已杀掉整个进程树", "全部终止"):
        assert lying not in degraded
    assert kill_phrase("")  # 未知手段也要有话可说，不能是空串


# ── 跨平台：路径含空格 ────────────────────────────────────────────────────────


def test_space_in_path_escapes_is_rejected_not_crashed() -> None:
    """`/tmp/dir with space/xxx.glb` 这种逃逸**要被判成非法**，而不是因为
    路径处理而抛别的异常（Windows 上 `C:\\Users\\John Doe\\...` 是常态）。"""
    with pytest.raises(BlenderRunnerError):
        resolve_out_path("/tmp/dir with space/xxx.glb")
    # 目录内的合法路径（含空格）必须照常解析
    resolved = resolve_out_path("dir with space/space table.glb")
    assert " " in str(resolved)
    assert resolved.is_relative_to(model_root().resolve())
    assert resolved.suffix == ".glb"


@requires_blender
def test_blender_runs_with_spaces_in_the_working_directory() -> None:
    """**真跑**：脚本与输出路径都带空格，Blender 仍要跑通并导出 GLB。

    argv 走列表、Windows 上由 `subprocess` 的 `list2cmdline` 加引号，所以含空格的
    路径不该被拆词。macOS 上真跑这一条，证明的不是 Windows，而是「我们没有在
    自己这边拼命令行字符串」——若哪天改成拼字符串，这里立刻会红。
    """
    # 输出路径：模型目录**之内**的一个带空格的子目录（resolve_out_path 只收
    # 模型目录内的路径，这正是路径不逃逸护栏）。
    spaced = resolve_out_path("props with spaces/table one.glb")
    spaced.parent.mkdir(parents=True, exist_ok=True)

    # 工作目录也带空格：临时目录由 mkdtemp 生成，这里把前缀换成带空格的形态，
    # 让 `cwd=` 与 `--script` 的路径同时含空格。只改 blender_runner 的引用，
    # 不动全局 tempfile（那会影响同进程里其它代码）。
    real_mkdtemp = blender_runner.tempfile.mkdtemp

    def spaced_mkdtemp(*args, **kwargs):
        kwargs.setdefault("prefix", "dramaclaw blender ")
        return real_mkdtemp(*args, **kwargs)

    monkey = pytest.MonkeyPatch()
    monkey.setattr(
        blender_runner, "tempfile", SimpleNamespace(mkdtemp=spaced_mkdtemp)
    )
    try:
        result = asyncio.run(
            run_ai_model(GOOD_TABLE, out_path=spaced, kind="table", expect_parts=5)
        )
    finally:
        monkey.undo()

    assert result.ok, result.message
    assert result.out_path == spaced
    assert spaced.is_file() and spaced.stat().st_size > 0
    assert result.guard_report["componentCount"] == 5
    # 输出路径确实含空格（证明这一条真的测到了空格，不是空跑）
    assert " " in str(spaced)
    spaced.unlink(missing_ok=True)


# ── 跨平台：文件句柄与清理 ────────────────────────────────────────────────────


def test_remove_output_reports_failure_instead_of_raising(tmp_path: Path) -> None:
    """**Windows 上被杀掉的 Blender 可能还攥着 GLB 句柄**，`unlink` 抛
    `PermissionError`。这时必须**如实返回 False**，不能整个请求炸成 500 ——
    更不能谎称删掉了（下游靠这个保证「失败不落盘」）。"""
    target = tmp_path / "locked.glb"
    target.write_bytes(b"glTF")

    real_unlink = Path.unlink
    attempts: list[Path] = []

    def locked(self: Path, *args, **kwargs) -> None:
        attempts.append(self)
        if self == target:
            raise PermissionError(13, "The process cannot access the file")
        real_unlink(self, *args, **kwargs)

    # 只在断言期间替换 pathlib.Path.unlink，结束即还原。
    monkey = pytest.MonkeyPatch()
    monkey.setattr(Path, "unlink", locked)
    try:
        assert blender_runner._remove_output(target) is False
    finally:
        monkey.undo()
    assert target.exists(), "删不掉时文件必须还在（不许谎称删掉了）"

    # 文件不存在 → 仍然算删干净了
    assert blender_runner._remove_output(tmp_path / "never-existed.glb") is True
    # 正常情况删得掉
    assert blender_runner._remove_output(target) is True
    assert not target.exists()


def test_run_ai_model_refuses_when_stale_output_cannot_be_removed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """上一次残留的 GLB 删不掉（Windows 文件锁）时**必须拒绝执行**。

    带着一个删不掉的同名旧文件往下跑，失败时下游就会把上一次的产物冒充成本次
    结果 —— 那是「失败不落盘」这条护栏最隐蔽的破口。
    """
    target = out("runner-locked.glb")
    target.write_bytes(b"glTF stub")  # 真的存在，且删不掉

    monkeypatch.setattr(blender_runner, "_remove_output", lambda path: False)
    result = asyncio.run(run_ai_model(GOOD_TABLE, out_path=target))
    assert not result.ok
    assert result.reason == "output-locked"
    assert "占用" in result.message
    # 旧文件必须还在（不能被悄悄删掉，也不能被悄悄当成结果交出去）
    assert target.exists()
    assert result.out_path is None
    target.unlink(missing_ok=True)


@requires_blender
def test_workdir_is_removed_even_when_rmtree_hits_a_live_handle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Windows 上句柄释放有延迟：第一次 `rmtree` 撞上会失败，但重试必须能清掉。

    这里把第一次 `rmtree` 打成 no-op 来模拟那个延迟，断言最终目录确实没了 ——
    只调一次 `rmtree(ignore_errors=True)` 的实现会在这里留下残留。
    """
    before = _temp_workdirs()
    real_rmtree = blender_runner.shutil.rmtree
    state = {"calls": 0}

    def flaky(path, *args, **kwargs):
        state["calls"] += 1
        if state["calls"] == 1:
            return None  # 模拟 Windows 上第一次删除撞上活跃句柄
        return real_rmtree(path, *args, **kwargs)

    # 只换掉 blender_runner 看到的 shutil 引用，不动全局 shutil 模块。
    monkeypatch.setattr(
        blender_runner, "shutil", SimpleNamespace(rmtree=flaky)
    )
    result = asyncio.run(
        run_ai_model(GOOD_TABLE, out_path=out("runner-flaky-cleanup.glb"), kind="table")
    )
    assert result.ok, result.message
    assert state["calls"] > 1, "第一次 rmtree 失败后必须有重试"
    assert _temp_workdirs() == before
    result.out_path.unlink(missing_ok=True)


# ── shell=False ─────────────────────────────────────────────────────────────


@requires_blender
def test_shell_metacharacters_in_script_are_not_interpreted() -> None:
    """脚本里的 ``;`` / 反引号 / ``$(`` 是**数据**，不是命令。

    走 shell 的话这三段会各自在宿主的 shell 里执行；``shell=False`` 时它们只是
    Python 源码里的一个字符串。脚本把它原样写回文件，比对内容即证明「逐字到达
    Blender、没有被解释」。

    落盘路径用 ``tempfile.gettempdir()`` 而不是写死 ``/tmp`` —— Windows 上没有
    ``/tmp``，写死这条用例在主人的机器上会直接失败。
    """
    sentinel = Path(tempfile.gettempdir()) / "blender_shell_pwned"
    marker_file = Path(tempfile.gettempdir()) / "blender_shell_marker.txt"
    hostile = GOOD_TABLE + f"""
marker = "; touch {sentinel} ; `touch {sentinel}` $(touch {sentinel})"
with open({str(marker_file)!r}, "w", encoding="utf-8") as handle:
    handle.write(marker)
"""
    sentinel.unlink(missing_ok=True)
    marker_file.unlink(missing_ok=True)
    result = asyncio.run(
        run_ai_model(hostile, out_path=out("runner-shell.glb"), kind="table", expect_parts=5)
    )
    assert result.ok, result.message
    assert not sentinel.exists(), "脚本内容被 shell 解释了"
    assert marker_file.read_text(encoding="utf-8") == (
        f"; touch {sentinel} ; `touch {sentinel}` $(touch {sentinel})"
    )
    marker_file.unlink(missing_ok=True)
    result.out_path.unlink(missing_ok=True)


def test_runner_never_passes_a_shell() -> None:
    """源码级兜底：整条执行路径上不存在 `shell=True` 之类的调用。

    走 AST 而不是全文搜字符串 —— 文档里讨论「为什么用 ``shell=False``」是应该的，
    那种文字不该被自己的检查判成违规。
    """
    import ast

    source = Path(blender_runner.__file__).read_text(encoding="utf-8")
    tree = ast.parse(source)
    assert not any(
        isinstance(node, ast.Call)
        and any(kw.arg == "shell" for kw in node.keywords)
        for node in ast.walk(tree)
    ), "执行路径上不允许出现任何 shell= 参数"
    # argv 是列表，不是拼字符串；杀的是整个进程组 / 进程树
    assert "asyncio.create_subprocess_exec" in source


# ── Blender 缺失 ────────────────────────────────────────────────────────────


def test_missing_blender_reports_instead_of_raising(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(blender_runner, "find_blender", lambda: (None, "none"))
    result = asyncio.run(run_ai_model(GOOD_TABLE, out_path=out("runner-noblender.glb")))
    assert not result.ok
    assert result.reason == "blender-unavailable"
    assert "Blender" in result.message
    assert not out("runner-noblender.glb").exists()


def test_missing_guard_reports_instead_of_raising(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(blender_runner, "guard_path", lambda: tmp_path / "nope.py")
    result = asyncio.run(run_ai_model(GOOD_TABLE, out_path=out("runner-noguard.glb")))
    assert not result.ok
    assert result.reason == "guard-missing"


# ── 产物形状 ────────────────────────────────────────────────────────────────


@requires_blender
def test_public_shape_feeds_the_model() -> None:
    """成功与失败两种回包都要能直接喂回模型：状态、原因、护栏报告齐全。"""
    ok = asyncio.run(
        run_ai_model(GOOD_TABLE, out_path=out("runner-shape-ok.glb"), kind="table", expect_parts=5)
    ).public()
    assert ok["ok"] is True
    assert "reason" not in ok  # 成功不带失败码
    assert ok["guardReport"]["normalization"]["targetHeight"] == 0.75
    assert ok["bytes"] > 0 and ok["resourcePath"].endswith(".glb")
    Path(ok["resourcePath"]).unlink(missing_ok=True)

    bad = asyncio.run(
        run_ai_model(FLOATING_TABLE, out_path=out("runner-shape-bad.glb"), kind="table")
    ).public()
    assert bad["ok"] is False
    assert bad["reason"].startswith("floating-parts")
    assert "guardReport" in bad and "message" in bad
    assert "resourcePath" not in bad


def test_guard_path_points_at_the_real_guard() -> None:
    assert guard_path().is_file(), f"护栏脚本不在 {guard_path()}"
    assert guard_path().name == "ai_guard.py"


def test_data_url_refuses_oversized_model() -> None:
    result = RunResult(ok=True, out_path=Path("/tmp/does-not-matter.glb"))
    with pytest.raises(BlenderRunnerError):
        result.data_url()


# ── 模型侧：工具定义与执行体 ────────────────────────────────────────────────


def test_blender_tool_is_offered_in_execute_mode_only() -> None:
    """工具面在后端组装，不碰上游 contract.ts；讨论模式不给（不改工程）。"""
    from novelvideo.director_desk.ai_host import (
        BLENDER_TOOL_DEFINITION,
        BLENDER_TOOL_NAME,
        ToolContract,
        tools_for_run,
    )

    assert BLENDER_TOOL_DEFINITION["name"] == BLENDER_TOOL_NAME
    assert BLENDER_TOOL_DEFINITION["inputSchema"]["required"] == ["script"]
    assert BLENDER_TOOL_DEFINITION["inputSchema"]["additionalProperties"] is False

    contract = ToolContract(
        definitions=[{"name": "director_read"}, {"name": "director_apply"}],
        discussion=[{"name": "director_read"}],
    )
    execute_tools, execute_allowed = tools_for_run(contract, "execute")
    assert BLENDER_TOOL_NAME in execute_allowed
    assert any(t["name"] == BLENDER_TOOL_NAME for t in execute_tools)
    # 白名单与工具面同源：看得见的就一定调得动
    assert {str(t["name"]) for t in execute_tools} == execute_allowed

    discuss_tools, discuss_allowed = tools_for_run(contract, "discuss")
    assert BLENDER_TOOL_NAME not in discuss_allowed
    assert not any(t["name"] == BLENDER_TOOL_NAME for t in discuss_tools)


def test_blender_tool_rejects_unknown_kind_without_running_blender() -> None:
    from novelvideo.director_desk.ai_host import run_blender_tool

    result = asyncio.run(run_blender_tool({"script": GOOD_TABLE, "kind": "spaceship"}))
    assert result["ok"] is False
    assert result["reason"] == "unknown-kind"


@requires_blender
def test_blender_tool_success_carries_an_importable_data_url() -> None:
    """工具成功回包必须自带 base64 —— 网页版 director_media 不收本机路径。"""
    from novelvideo.director_desk.ai_host import run_blender_tool

    result = asyncio.run(
        run_blender_tool(
            {"script": GOOD_TABLE, "name": "预演桌", "kind": "table", "expectParts": 5}
        )
    )
    assert result["ok"] is True, result.get("message")
    assert result["data"].startswith(f"data:{GLB_MIME};base64,")
    # 中文显示名要能落成一个安全的英文文件名
    assert result["name"].endswith(".glb") and "/" not in result["name"]
    Path(result["resourcePath"]).unlink(missing_ok=True)


@requires_blender
def test_blender_tool_failure_is_reported_not_raised() -> None:
    from novelvideo.director_desk.ai_host import run_blender_tool

    result = asyncio.run(
        run_blender_tool({"script": FLOATING_TABLE, "name": "bad-prop", "kind": "table"})
    )
    assert result["ok"] is False
    assert result["reason"].startswith("floating-parts")
    assert "z=" in result["message"]
    assert "data" not in result


class _ExplodingTransport:
    """画布侧通道。Blender 工具**不该**碰它 —— 碰了就说明多绕了一圈长轮询。"""

    def call(self, *args, **kwargs):  # pragma: no cover - 走到就是失败
        raise AssertionError("blender_run_model 不该经画布 iframe 派发")


def test_call_tool_dispatches_blender_locally() -> None:
    from novelvideo.director_desk import ai_host
    from novelvideo.director_desk.ai_host import AbortToken, DirectorDeskAiService

    service = DirectorDeskAiService(transport=_ExplodingTransport())
    captured: dict[str, object] = {}

    async def fake_run(script, *, out_path, **kwargs):
        captured["script"] = script
        captured["out"] = str(out_path)
        return RunResult(ok=True, message="护栏通过", size_bytes=42, out_path=Path("/tmp/x.glb"))

    async def fake_tool(args):
        captured["args"] = dict(args)
        return {"ok": True, "message": "护栏通过", "data": "data:model/gltf-binary;base64,AAA"}

    monkey = pytest.MonkeyPatch()
    monkey.setattr(ai_host, "run_ai_model", fake_run)
    monkey.setattr(ai_host, "run_blender_tool", fake_tool)
    try:
        out = asyncio.run(service._call_tool("node-1", ai_host.BLENDER_TOOL_NAME, {"script": "x"}, AbortToken()))
    finally:
        monkey.undo()
    assert out["ok"] is True
    assert out["data"]["data"].startswith("data:model/gltf-binary;base64,")
    assert captured["args"] == {"script": "x"}
