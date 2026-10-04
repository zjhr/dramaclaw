#!/usr/bin/env python3
"""宿主侧：跑一段 **AI 生成的 bpy 脚本** → 过护栏 → 导出未压缩 GLB。

护栏本体在 `ai_guard.py`（Blender 内部跑）。本脚本负责 Blender 进程本身的事：
找 Blender、限时、禁网环境、重试，以及把结果收敛成一份可机读的 JSON。

用法：
    python3 scripts/blender/ai_model.py \
        --script /tmp/prop.py --out frontend/public/previs-models/chair.glb \
        --kind chair --expect-parts 5

    python3 scripts/blender/ai_model.py --kinds          # 列出真实尺寸表里的道具类别

## 为什么不再只有「模板 + 参数」

旧立场是「不把 AI 生成的 Python 喂给 Blender（安全与质量都不可控）」。这条现在
不成立了，理由见 `ai_guard.py` 的模块 docstring：可执行率挂上 agent harness 后到
0.986~1.000（3DCodeBench），而残余缺陷是**几何不成立**（disconnected / floating
components），那是可测量、可拒绝、可重试的。所以放开的前提是下面这些护栏，不是裸跑。

## 重试策略

护栏失败时把**结构化原因**（不是自然语言抱怨）回喂给调用方，让它重写脚本；
超过 `--max-attempts` 仍然不过就返回非零退出码，**调用方必须如实告诉主人
「这个做不了，建议加一个固定模板」**，不许把坏模型塞进场景。
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ensure_blender import find_blender  # noqa: E402
from real_sizes import REAL_HEIGHTS  # noqa: E402

GUARD = Path(__file__).resolve().parent / "ai_guard.py"

# 需求要求「Blender headless 单次上限（比如 60 秒）」。
DEFAULT_TIMEOUT = 60

# 传给 Blender 的环境：禁网（无代理）+ 不读用户 site-packages。
SANDBOX_ENV = {
    "no_proxy": "*",
    "NO_PROXY": "*",
    "http_proxy": "",
    "https_proxy": "",
    "PYTHONNOUSERSITE": "1",
}

#: `CREATE_NEW_PROCESS_GROUP`（winbase.h，`0x00000200`）。`subprocess` 只在 Windows 上
#: 从 `_winapi` 导出它，所以这里给字面量。
CREATE_NEW_PROCESS_GROUP = 0x00000200

#: `taskkill` 自己的超时。
TASKKILL_TIMEOUT_SECONDS = 10


def is_windows() -> bool:
    return os.name == "nt"


def process_group_kwargs() -> dict:
    """子进程「自成组」的启动参数。**两个平台不是同一个参数。**

    POSIX 用 `start_new_session=True`（`setsid`）。**Windows 上它是个 no-op** ——
    CPython 的 Windows `_execute_child` 形参名直接写作 `unused_start_new_session`，
    传了不报错也不生效；而且 `os.killpg` / `os.getpgid` 来自 C 的 `posix` 模块，
    Windows 上根本不存在（`AttributeError`），`signal.SIGKILL` 同样只在 Unix 有。
    所以 Windows 必须用 `creationflags=CREATE_NEW_PROCESS_GROUP`。
    """
    if is_windows():
        return {"creationflags": CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def kill_tree(proc: subprocess.Popen) -> str:
    """杀掉整个进程组 / 整棵进程树，返回实际生效的手段。

    只 `proc.kill()` 的话，Blender fork 出去的子进程会活下来继续占 CPU 与临时目录，
    **超时就等于没超时**。Windows 上没有 POSIX 进程组，靠 `taskkill /T` 按父子
    关系收子树。返回 `"fallback-proc-kill"` 表示组手段不可用、只杀了直接子进程
    —— 那是降级，如实报出来。
    """
    if is_windows():
        try:
            done = subprocess.run(  # noqa: S603 — argv 列表，无 shell
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                capture_output=True,
                timeout=TASKKILL_TIMEOUT_SECONDS,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            done = None
        if done is not None and done.returncode == 0:
            return "taskkill"
    else:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            return "killpg"
        except (ProcessLookupError, PermissionError, OSError):
            pass
    try:
        proc.kill()
    except (OSError,):  # pragma: no cover — 进程已消失
        pass
    return "fallback-proc-kill"


def _parse_report(stdout: str) -> dict | None:
    """从 Blender stdout 里取末行的 `AI_MODEL_OK {...}` / `AI_MODEL_FAIL {...}`。"""
    for line in reversed(stdout.splitlines()):
        line = line.strip()
        for marker in ("AI_MODEL_OK ", "AI_MODEL_FAIL "):
            if line.startswith(marker):
                try:
                    return json.loads(line[len(marker):])
                except json.JSONDecodeError:
                    return None
    return None


def run_once(blender: str, script: Path, out: Path, kind: str | None,
             expect_parts: int | None, timeout: int, real_height: float | None) -> dict:
    """跑一次，返回 `{ok, report, exitCode, timedOut}`。"""
    argv = [
        blender, "-b", "--factory-startup",     # 不加载用户 add-on / 偏好 / 启动脚本
        "-noaudio",
        "-P", str(GUARD), "--",
        "--script", str(script), "--out", str(out),
    ]
    if kind:
        argv += ["--kind", kind]
    if expect_parts is not None:
        argv += ["--expect-parts", str(expect_parts)]
    if real_height is not None:
        argv += ["--real-height", str(real_height)]

    env = {**os.environ, **SANDBOX_ENV}
    # 不用 `subprocess.run(timeout=)`：它超时只 kill 直接子进程，Blender fork 出去
    # 的子进程会活下来继续占 CPU。改用 Popen 自己管超时，才能在超时点上收整组。
    try:
        proc = subprocess.Popen(
            argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            env=env, **process_group_kwargs(),
        )
    except OSError as exc:
        return {"ok": False, "report": {"reason": "blender-launch-failed", "error": str(exc)},
                "exitCode": None, "timedOut": False, "stdout": "", "stderr": ""}

    killed_by = ""
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        killed_by = kill_tree(proc)
        try:
            stdout, stderr = proc.communicate(timeout=TASKKILL_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:  # pragma: no cover — kill 后仍不退，极少见
            stdout, stderr = "", ""
        # 失败不留半成品：下游必须只看到「要么完整 GLB，要么什么都没有」。
        try:
            out.unlink(missing_ok=True)
        except OSError:
            pass
        return {"ok": False,
                "report": {"reason": "timeout", "limitSeconds": timeout,
                           "killedBy": killed_by},
                "exitCode": None, "timedOut": True,
                "stdout": (stdout or "")[-4000:], "stderr": (stderr or "")[-2000:]}

    report = _parse_report(stdout) or {
        "reason": "no-report",
        "tail": (stdout or stderr or "")[-800:],
    }
    ok = proc.returncode == 0 and report.get("reason") is None
    return {
        "ok": ok,
        "report": report,
        "exitCode": proc.returncode,
        "timedOut": False,
        "stdout": (stdout or "")[-4000:],
        "stderr": (stderr or "")[-2000:],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="AI 生成 bpy 脚本 → 护栏 → 未压缩 GLB")
    parser.add_argument("--script", help="AI 生成的 bpy 脚本路径")
    parser.add_argument("--out", help="输出 .glb 路径")
    parser.add_argument("--kind", help="道具类别（查真实尺寸表，如 table/chair/vase）")
    parser.add_argument("--real-height", type=float, help="显式真实高度（米），覆盖 --kind")
    parser.add_argument("--expect-parts", type=int, help="预期连通分量数，不符即失败")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help=f"单次上限秒（默认 {DEFAULT_TIMEOUT}）")
    parser.add_argument("--max-attempts", type=int, default=1, help="重试次数（每次都要换脚本内容）")
    parser.add_argument("--blender", help="显式指定 Blender 可执行文件")
    parser.add_argument("--kinds", action="store_true", help="列出真实尺寸表支持的类别")
    args = parser.parse_args()

    if args.kinds:
        print(json.dumps(REAL_HEIGHTS, ensure_ascii=False, indent=2))
        return 0

    if not args.script or not args.out:
        parser.error("需要 --script 与 --out")

    blender, source = find_blender(args.blender)
    if blender is None:
        # 环境缺失要说清楚，不该假装跑过，也不该在这里偷偷下载几百 MB。
        print(json.dumps({"ok": False, "reason": "blender-unavailable", "source": source,
                          "hint": "用 --blender <路径> 或 DRAMACLAW_BLENDER 指定；"
                                  "或先跑 ensure_blender.py --allow-download"},
                         ensure_ascii=False))
        return 2

    script, out = Path(args.script).resolve(), Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    attempt, result = 0, None
    for attempt in range(1, max(1, args.max_attempts) + 1):
        result = run_once(str(blender), script, out, args.kind, args.expect_parts,
                          args.timeout, args.real_height)
        if result["ok"]:
            break
        # 失败就不留半成品：下游必须只看到「要么完整 GLB，要么什么都没有」。
        out.unlink(missing_ok=True)

    if result is None:
        print(json.dumps({"ok": False, "reason": "no-attempt"}))
        return 2

    payload = {
        "ok": result["ok"],
        "attempts": attempt,
        "exitCode": result["exitCode"],
        "timedOut": result["timedOut"],
        "out": str(out) if result["ok"] else None,
        "report": result["report"],
    }
    print(json.dumps(payload, ensure_ascii=False))
    if not result["ok"]:
        print("调用方必须如实告知用户失败原因；不要把不完整模型放进场景。", file=sys.stderr)
        return 3
    if result["report"].get("normalization", {}).get("bboxAfter"):
        print(f"GLB 大小: {out.stat().st_size} 字节", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())