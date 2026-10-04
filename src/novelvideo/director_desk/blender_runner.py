"""导演台的 Blender 执行服务：把 **AI 写的 bpy 脚本** 变成一个可导进工程的 GLB。

## 为什么需要它

上游那 18 个 `director_*` 工具**一个执行能力都没有**（本仓 `ai_host.py` /
`mcp_tools.py` / `routes.py` / `skill_store.py` 里的 `subprocess` / `os.system` /
`popen` 命中数为 0）。所以第三档阶梯（AI 现场建模）此前只能停在「把脚本交给用户
手动跑」。本模块补上这一段：AI 交脚本，后端真跑，GLB 落地。

## 立场：完全自由 + 护栏

主人明确选了「AI 可以写任意 bpy 脚本，后端直接跑」。这不是模板化拼装，也不做语法
白名单。这里**不加**任何以「更安全」为名的伪装限制；护栏里的每一项都是为了让产出
**可用**，不是为了限制 AI 的自由度：

| 护栏 | 在哪 | 为什么是「可用性」而不是「限制」 |
| --- | --- | --- |
| 连通分量 / 悬空检查 | `ai_guard.py` | 悬空件在渲染里是错的，放进场景等于交付一个坏模型 |
| 尺度硬归一化 | `ai_guard.py` | AI 记不对尺寸（桌高写成 1.2m），归一化让这件事**不可能**出错 |
| 面数预算 | `ai_guard.py` | 失控细分会把整场演出拖垮 |
| 禁网 | `ai_guard.py` | bpy 脚本没有正当联网需求；这是防外泄，不是防创作 |
| 超时 | 本模块 | 死循环脚本会挂住整个导演台 |
| `shell=False` | 本模块 | 脚本内容是**数据**，交给 shell 解释等于让数据变成命令 |
| 路径不逃逸 | 本模块 | 输出只允许落在导演台自己的模型目录里 |
| 失败不落盘 | 本模块 + `ai_guard.py` | 下游必须只看到「要么完整 GLB，要么什么都没有」 |

**内存上限在 macOS 上不生效**（`RLIMIT_AS` / `RLIMIT_DATA` 都是 `ValueError`：未授权
进程不能把 hard limit 从 unlimited 往下压）。护栏照实把它报成
`memoryCapped: "unsupported-on-this-platform"`，本模块原样透传，不谎报。真正兜住
内存的是超时与面数预算。

## 进程形状

`subprocess.run` 的形状照抄本仓先例 `director_world/block_world_builder.py:507`
（argv 列表、`capture_output`、`timeout`、显式 `env`），但换成
`asyncio.create_subprocess_exec` —— 因为要求是**超时后杀掉整个进程组**（Blender
会 fork），而 `subprocess.run(timeout=)` 只杀直接子进程。

分组与终止按平台分支，**两套都要**（Blender 在 Windows 上同样会 fork）：

| | POSIX | Windows |
| --- | --- | --- |
| 分组 | `start_new_session=True`（`setsid`，新会话） | `creationflags=CREATE_NEW_PROCESS_GROUP`（新进程组） |
| 杀整棵 | `os.killpg(os.getpgid(pid), SIGKILL)` | `taskkill /PID <pid> /T /F`（`/T` = 含子树） |

`start_new_session` 是 **POSIX-only**（CPython 的 Windows `_execute_child` 形参名直接
写作 `unused_start_new_session`），传了**静默不生效**；而 `os.killpg` / `os.getpgid`
来自 `posix` 模块，Windows 上根本不存在（`AttributeError`），`signal.SIGKILL` 同样只在
Unix 有。所以 Windows 上必须换 `creationflags` + `taskkill`，`proc.kill()` 只作为最后
兜底。分组参数由 `process_group_kwargs()` 给出、终止由 `kill_tree()` 执行，两者的
平台分支都由 `tests/test_director_desk_blender_runner.py` 在 macOS 上直接断言。

`shell` 参数在这里**不存在**：`create_subprocess_exec` 压根没有这个参数，argv 是
列表，元字符没有解释的机会（POSIX 上 `shell=True` 传列表时只把 `args[0]` 当命令
行，脚本路径根本到不了 Blender；Windows 上 argv 列表由 `subprocess` 的
`list2cmdline` 负责加引号，含空格的路径不会被拆词）。

每次跑在独立临时目录里（`cwd` 与脚本落盘都在那儿），跑完无论成败都删掉 —— 脚本写坏
的文件不会留在仓库里。
"""

from __future__ import annotations

import asyncio
import base64
import itertools
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

__all__ = [
    "BlenderRunnerError",
    "CREATE_NEW_PROCESS_GROUP",
    "GLB_MIME",
    "MAX_INLINE_GLTF_BYTES",
    "MAX_SCRIPT_BYTES",
    "MAX_TIMEOUT_SECONDS",
    "RunResult",
    "blender_available",
    "guard_path",
    "is_windows",
    "kill_phrase",
    "kill_tree",
    "model_root",
    "parse_guard_report",
    "process_group_kwargs",
    "resolve_out_path",
    "run_ai_model",
    "slugify",
    "taskkill_argv",
    "unique_out_path",
]


# ── 阈值 ────────────────────────────────────────────────────────────────────

#: 脚本正文上限。够写一个几百行的道具生成器，也够挡住「把整个数据集塞进来」。
MAX_SCRIPT_BYTES = 512_000

#: 单次执行的默认秒数，与 `scripts/blender/ai_model.py` 的 `DEFAULT_TIMEOUT` 一致。
DEFAULT_TIMEOUT_SECONDS = 60

#: 上限的硬顶。请求可以调小，调不大 —— 一个跑十几分钟才「成功」的道具对预演没意义。
MAX_TIMEOUT_SECONDS = 300

#: 导演台模型目录（相对 `config.STATE_DIR`）。GLB 只允许落在这里。
MODEL_DIRNAME = "models"

#: glTF 二进制的 MIME。上游 `automation/service.ts` 的 `director_media import` 认它。
GLB_MIME = "model/gltf-binary"

#: 允许把 GLB 内联成 data URL 的上限 —— **这是导入路径的真实约束，不是风格选择**。
#:
#: 网页版 `director_media{action:'import'}` 明确拒绝 `path`（`service.ts:60`：「本机路径
#: 导入需要桌面版」），只收 `data:` base64。GLB 是二进制，base64 之后要穿过对话历史，
#: 1.5 MB 已经接近模型上下文吃得下的量。超了就**如实报错**，不给一个导不进去的路径。
MAX_INLINE_GLTF_BYTES = 1_500_000

#: 传给 Blender 的环境：禁代理 + 不读用户 site-packages。与 `ai_model.py` 的
#: `SANDBOX_ENV` 同源。语言级禁网在 `ai_guard.py` 里做。
SANDBOX_ENV = {
    "no_proxy": "*",
    "NO_PROXY": "*",
    "http_proxy": "",
    "https_proxy": "",
    "PYTHONNOUSERSITE": "1",
}

_SLUG_RE = re.compile(r"[^a-z0-9]+")
_UNIQUE = itertools.count(1)


class BlenderRunnerError(ValueError):
    """参数不合法（脚本太长、输出路径逃逸…）。路由把它翻成 400。"""


# ── 路径 ────────────────────────────────────────────────────────────────────


def guard_path() -> Path:
    """护栏脚本（Blender 内部执行）。它与宿主同目录，导入 `real_sizes` 靠这一行。

    解析顺序：``DRAMACLAW_BLENDER_GUARD`` 覆盖 → 仓库根的 ``scripts/blender``。
    仓库根取模块位置上溯（``src/novelvideo/director_desk/`` 上溯 3 层），因为
    ``scripts/`` 是仓库级开发工具，不随 Python 包安装。
    """
    override = os.environ.get("DRAMACLAW_BLENDER_GUARD")
    if override:
        return Path(override).expanduser()
    return Path(__file__).resolve().parents[3] / "scripts" / "blender" / "ai_guard.py"


def scripts_dir() -> Path:
    return guard_path().parent


def model_root() -> Path:
    """导演台模型目录。不存在时创建 —— 这是它**唯一**允许写 GLB 的地方。"""
    from novelvideo import config

    root = Path(config.STATE_DIR) / "director_desk" / MODEL_DIRNAME
    root.mkdir(parents=True, exist_ok=True)
    return root


def resolve_out_path(out_path: str | Path) -> Path:
    """把请求里的输出路径解析成 ``model_root()`` 下的一个 ``.glb`` 绝对路径。

    **相对路径按模型目录解析，绝对路径必须已经在模型目录里。** ``..``、符号链接
    指出去、``~`` 展开，全部在 ``resolve()`` 之后由 ``is_relative_to`` 一次性挡住 ——
    判定点只有这一处，不做「拼起来看着像在里面」那种字符串检查。
    """
    root = model_root().resolve()
    raw = str(out_path or "").strip()
    if not raw:
        raise BlenderRunnerError("缺少输出文件名")
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    resolved = candidate.resolve()
    if resolved == root or not resolved.is_relative_to(root):
        raise BlenderRunnerError(f"输出路径必须位于导演台模型目录内：{root}")
    if resolved.suffix.lower() != ".glb":
        raise BlenderRunnerError("输出文件必须是 .glb")
    return resolved


def slugify(name: str, *, fallback: str = "model") -> str:
    """把 AI 给的显示名压成安全的文件名主干（ASCII、小写、连字符）。

    中文名会被整个压掉，所以 fallback 一定要补位 —— 否则 ``name:"桌子"`` 会生成
    ``model.glb`` 这种每次都撞名的文件。
    """
    ascii_only = str(name or "").strip().lower().encode("ascii", "ignore").decode("ascii")
    slug = _SLUG_RE.sub("-", ascii_only).strip("-")[:60]
    return slug or fallback


def unique_out_path(name: str = "") -> Path:
    """给一次执行分配一个不会撞名的输出路径。"""
    stem = slugify(name, fallback="blender")
    return resolve_out_path(f"{stem}-{os.getpid()}-{next(_UNIQUE)}.glb")


# ── Blender 定位 ────────────────────────────────────────────────────────────


def find_blender() -> tuple[Path | None, str]:
    """复用 ``scripts/blender/ensure_blender.py`` 的查找顺序，不抄第二份。

    抄一份的后果是两条查找链各自漂移：用户在 ``DRAMACLAW_BLENDER`` 里配好路径，
    手动那条命令能跑、导演台这条不能。
    """
    directory = str(scripts_dir())
    if directory not in sys.path:
        sys.path.insert(0, directory)
    from ensure_blender import find_blender as locate  # noqa: PLC0415 — 按仓库布局解析

    return locate(None)


def blender_available() -> tuple[bool, str]:
    """(能否跑, 来源)。面板与技能说明用它给一句前置提示。"""
    path, source = find_blender()
    return (path is not None, source)


# ── 结果 ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RunResult:
    """一次执行的结果。**能直接喂给 AI**：``message`` 是人话，其余是结构化证据。"""

    ok: bool
    #: 失败码前缀，与 `ai_guard.py` 的 `AI_MODEL_FAIL` 原因一一对应；成功为空串。
    reason: str = ""
    #: 给 AI 看的一句话。**失败时必须如实说做不了**，不许粉饰。
    message: str = ""
    #: 护栏报告原文（`AI_MODEL_OK` / `AI_MODEL_FAIL` 后面那段 JSON）。
    guard_report: dict[str, Any] = field(default_factory=dict)
    out_path: Path | None = None
    exit_code: int | None = None
    timed_out: bool = False
    elapsed_ms: int = 0
    size_bytes: int = 0
    blender: str = ""
    blender_source: str = ""
    #: 脚本跑挂时的最后一段 stderr。**只回尾部**：Blender 的启动日志有几百行。
    stderr_tail: str = ""

    def public(self, *, inline: bool = False) -> dict[str, Any]:
        """回给 HTTP 调用方 / 模型的形状。

        ``inline=True`` 时附上 ``data``（base64 data URL）—— 网页版
        ``director_media import`` 不收本机路径，这是唯一的过河方式。
        """
        payload: dict[str, Any] = {
            "ok": self.ok,
            "message": self.message,
            "elapsedMs": self.elapsed_ms,
            "exitCode": self.exit_code,
            "timedOut": self.timed_out,
            "guardReport": self.guard_report,
        }
        if not self.ok:
            payload["reason"] = self.reason
            if self.stderr_tail:
                payload["stderr"] = self.stderr_tail
            return payload
        payload["name"] = self.out_path.name if self.out_path else ""
        payload["resourcePath"] = str(self.out_path) if self.out_path else ""
        payload["bytes"] = self.size_bytes
        if inline:
            payload["data"] = self.data_url()
        return payload

    def data_url(self) -> str:
        """GLB → ``data:model/gltf-binary;base64,…``。文件不在或超限则抛。"""
        if self.out_path is None or not self.out_path.is_file():
            raise BlenderRunnerError("没有可导入的 GLB")
        size = self.out_path.stat().st_size
        if size > MAX_INLINE_GLTF_BYTES:
            raise BlenderRunnerError(
                f"模型 {size} 字节超过可内联上限 {MAX_INLINE_GLTF_BYTES} 字节；"
                "简化造型（减少细分与零件数）后重试"
            )
        encoded = base64.b64encode(self.out_path.read_bytes()).decode("ascii")
        return f"data:{GLB_MIME};base64,{encoded}"


# ── 护栏输出解析 ────────────────────────────────────────────────────────────

_MARKERS = ("AI_MODEL_OK ", "AI_MODEL_FAIL ")


def parse_guard_report(stdout: str) -> dict[str, Any] | None:
    """从 Blender stdout 里取末行的 ``AI_MODEL_OK {...}`` / ``AI_MODEL_FAIL {...}``。

    倒着扫：Blender 启动横幅与导出器日志都在前面，报告永远是最后一行。抄
    ``scripts/blender/ai_model.py`` 的形状，两边对同一份输出给同一个答案。
    """
    for line in reversed((stdout or "").splitlines()):
        line = line.strip()
        for marker in _MARKERS:
            if line.startswith(marker):
                try:
                    parsed = json.loads(line[len(marker) :])
                except json.JSONDecodeError:
                    return None
                return parsed if isinstance(parsed, dict) else None
    return None


# ── 进程组 ──────────────────────────────────────────────────────────────────

#: ``CREATE_NEW_PROCESS_GROUP``。``subprocess`` 只在 Windows 上从 ``_winapi`` 导出它，
#: 这里给出字面量，好让 Windows 分支在 macOS 上也能被测试覆盖（值见 Microsoft
#: Process Creation Flags 文档，``0x00000200``）。
CREATE_NEW_PROCESS_GROUP = 0x00000200

#: ``taskkill`` 自己的超时。杀进程的动作不该再挂住调用方。
TASKKILL_TIMEOUT_SECONDS = 10


def is_windows() -> bool:
    """当前平台是不是 Windows。抽成函数是为了让 Windows 分支可在 macOS 上被测。"""
    return os.name == "nt"


def process_group_kwargs() -> dict[str, Any]:
    """子进程「自成组」的 ``create_subprocess_exec`` 参数。

    POSIX 用 ``start_new_session=True``（``setsid``）。**Windows 上这个参数是
    no-op** —— CPython 的 Windows ``_execute_child`` 形参名就叫
    ``unused_start_new_session``，传了不报错也不生效；所以那边必须用
    ``creationflags=CREATE_NEW_PROCESS_GROUP``。少了这一步，Blender fork 出去的
    子进程在 Windows 上根本收不回来。
    """
    if is_windows():
        return {"creationflags": CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def taskkill_argv(pid: int) -> list[str]:
    """杀整棵进程树的 Windows 命令行。``/T`` = 含子进程，``/F`` = 强杀。

    argv 列表而非命令行字符串：不走 shell，pid 是我们自己给的整数，
    没有插值空间。
    """
    return ["taskkill", "/PID", str(pid), "/T", "/F"]


def kill_tree(proc: asyncio.subprocess.Process) -> str:
    """杀掉**整个进程组 / 整棵进程树**，返回实际生效的手段（便于诊断与测试）。

    只 ``proc.kill()`` 的话，Blender fork 出去的子进程会活下来继续占 CPU 与临时
    目录，**超时就等于没超时**。而「整组」在两个平台上不是同一个东西：

    - POSIX：``start_new_session=True`` 让 Blender 自成会话组，``os.getpgid``
      拿到的就是那个组 id，``killpg`` 一次收干净。``os.killpg`` / ``os.getpgid``
      来自 C 的 ``posix`` 模块，Windows 上**不存在**。
    - Windows：``taskkill /T`` 按父子关系收子树，``.killpg`` 那套用不了。
      ``signal.SIGKILL`` 在 Windows 上也不存在（只有 ``SIGTERM``/``SIGBREAK``
      等少数几个），所以不能照抄 POSIX 那行。

    返回 ``"killpg"`` / ``"taskkill"`` 表示整组已收；返回 ``"fallback-proc-kill"``
    表示组手段不可用、只杀了直接子进程 —— 这是降级，如实报出来而不是假装到位。
    """
    if is_windows():
        try:
            done = subprocess.run(  # noqa: S603 — argv 列表，无 shell
                taskkill_argv(proc.pid),
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
    # 兜底：taskkill 不可用 / 组已消失时，至少不能让直接子进程跑飞。
    try:
        proc.kill()
    except (ProcessLookupError, OSError):
        pass
    return "fallback-proc-kill"


async def _kill_group(proc: asyncio.subprocess.Process) -> str:
    """终止 Blender 并回收它。返回 :func:`kill_tree` 的手段名。"""
    how = kill_tree(proc)
    try:
        await asyncio.wait_for(proc.wait(), timeout=5)
    except (asyncio.TimeoutError, TimeoutError):
        pass
    return how


#: 终止手段 → 人话。写进超时消息里，让「杀干净了」和「只杀了直接子进程」在回包上
#: 区分得开 —— 后者是降级，不能报成前者。
_KILL_PHRASES = {
    "killpg": "杀掉整个进程组",
    "taskkill": "杀掉整个进程树",
    "fallback-proc-kill": "只杀掉 Blender 主进程（进程组终止不可用，子进程可能残留）",
    "": "终止 Blender",
}


def kill_phrase(how: str) -> str:
    return _KILL_PHRASES.get(how, _KILL_PHRASES[""])


def _remove_output(path: Path) -> bool:
    """删掉一次执行的产物，**失败不抛**。

    ``missing_ok=True`` 只挡「文件不存在」。**Windows 上被杀掉的 Blender 可能还
    攥着 ``.glb`` 的句柄**，此时 ``unlink`` 抛 ``PermissionError``；POSIX 上
    unlink 立刻生效所以永远走不到这里。清理失败必须如实返回 ``False``，而不是把
    整个请求炸成 500 —— 但**也绝不能谎称删掉了**：调用方据此决定能不能保证
    「失败不落盘」。
    """
    try:
        path.unlink(missing_ok=True)
        return True
    except OSError:
        return False


#: 临时目录重试次数。Windows 上被 kill 的 Blender 释放句柄要几十到几百毫秒，
#: 一次 ``rmtree`` 撞上就可能整棵目录都留下。
_WORKDIR_ATTEMPTS = 5
_WORKDIR_RETRY_SECONDS = 0.1


def _remove_workdir(workdir: Path) -> bool:
    """删掉本次执行的临时目录。**删不掉就如实返回 ``False``**，不假装清干净了。"""
    for attempt in range(_WORKDIR_ATTEMPTS):
        shutil.rmtree(workdir, ignore_errors=True)
        if not workdir.exists():
            return True
        if attempt < _WORKDIR_ATTEMPTS - 1:
            time.sleep(_WORKDIR_RETRY_SECONDS)
    return not workdir.exists()


# ── 主流程 ──────────────────────────────────────────────────────────────────


async def run_ai_model(
    script: str,
    *,
    out_path: Path,
    timeout: int = DEFAULT_TIMEOUT_SECONDS,
    kind: str | None = None,
    expect_parts: int | None = None,
    real_height: float | None = None,
) -> RunResult:
    """跑一段 AI 写的 bpy 脚本，过护栏，导出未压缩 GLB。

    ``out_path`` 必须能通过 :func:`resolve_out_path`（在导演台模型目录内）。
    失败**一定**不留下半成品：护栏判失败时 ``out`` 会被显式删掉（护栏自己不导出，
    这一删防的是「上一次同名文件残留」与「导出中途异常」两种情况）。
    """
    out = resolve_out_path(out_path)
    source = str(script or "")
    if not source.strip():
        raise BlenderRunnerError("Blender 脚本为空")
    if len(source.encode("utf-8")) > MAX_SCRIPT_BYTES:
        raise BlenderRunnerError(f"脚本超过 {MAX_SCRIPT_BYTES} 字节上限")
    limit = max(1, min(int(timeout or DEFAULT_TIMEOUT_SECONDS), MAX_TIMEOUT_SECONDS))
    if expect_parts is not None and not (1 <= int(expect_parts) <= 64):
        raise BlenderRunnerError("expectParts 需在 1~64 之间")
    if real_height is not None and not (0.01 <= float(real_height) <= 20.0):
        raise BlenderRunnerError("realHeight 需在 0.01~20 米之间")

    blender, blender_source = find_blender()
    if blender is None:
        return RunResult(
            ok=False,
            reason="blender-unavailable",
            message=(
                "本机没有可用的 Blender，无法生成模型"
                f"（查找来源：{blender_source}）。请装 Blender 4.5.x 或设置 DRAMACLAW_BLENDER。"
            ),
            blender_source=blender_source,
        )
    guard = guard_path()
    if not guard.is_file():
        return RunResult(
            ok=False,
            reason="guard-missing",
            message=f"护栏脚本缺失：{guard}",
            blender=str(blender),
            blender_source=blender_source,
        )

    # 上一次同名文件必须先清掉：否则「这次失败」会被上一次的成功产物冒充。
    # Windows 上上一次被 kill 掉的 Blender 可能还攥着句柄，unlink 会 PermissionError；
    # 那种情况下**必须如实拒绝执行**，不能带着一个删不掉的旧文件往下跑。
    if not _remove_output(out) and out.exists():
        return RunResult(
            ok=False,
            reason="output-locked",
            message=(
                f"上一次残留的模型删不掉（可能仍被进程占用）：{out}。"
                "请关掉占用它的程序后重试。"
            ),
            blender=str(blender),
            blender_source=blender_source,
        )
    workdir = Path(tempfile.mkdtemp(prefix="dramaclaw-blender-"))
    started = time.monotonic()
    try:
        script_path = workdir / "ai_model.py"
        script_path.write_text(source, encoding="utf-8")

        argv = [
            str(blender),
            "-b",  # batch：没有 UI
            "--factory-startup",  # 不加载用户 add-on / 偏好 / 启动脚本
            "-noaudio",
            "-P",
            str(guard),
            "--",
            "--script",
            str(script_path),
            "--out",
            str(out),
        ]
        if kind:
            argv += ["--kind", str(kind)]
        if expect_parts is not None:
            argv += ["--expect-parts", str(int(expect_parts))]
        if real_height is not None:
            argv += ["--real-height", str(float(real_height))]

        env = {**os.environ, **SANDBOX_ENV}
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                cwd=str(workdir),
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                # 超时要能收掉整个进程组 / 进程树，参数按平台不同（见 process_group_kwargs）
                **process_group_kwargs(),
            )
        except (OSError, ValueError) as exc:
            return RunResult(
                ok=False,
                reason="blender-launch-failed",
                message=f"无法启动 Blender：{exc}",
                blender=str(blender),
                blender_source=blender_source,
                elapsed_ms=int((time.monotonic() - started) * 1000),
            )

        timed_out = False
        killed_by = ""
        stdout = ""
        stderr = ""
        try:
            try:
                raw_out, raw_err = await asyncio.wait_for(proc.communicate(), timeout=limit)
            except (asyncio.TimeoutError, TimeoutError):
                timed_out = True
                killed_by = await _kill_group(proc)
                stdout, stderr = "", ""
            else:
                stdout = (raw_out or b"").decode("utf-8", "replace")
                stderr = (raw_err or b"").decode("utf-8", "replace")
        finally:
            # 用户按「停止」时 `communicate()` 被 CancelledError 打断，Blender 进程
            # 不会自己消失 —— 不在这里补一刀，导演台会攒下一堆跑飞的 headless Blender。
            if proc.returncode is None:
                killed_by = await _kill_group(proc)

        elapsed = int((time.monotonic() - started) * 1000)
        if timed_out:
            _remove_output(out)
            return RunResult(
                ok=False,
                reason="timeout",
                message=(
                    f"Blender 超过 {limit} 秒仍未结束，已{kill_phrase(killed_by)}，未产出模型。"
                ),
                guard_report={
                    "reason": "timeout",
                    "limitSeconds": limit,
                    "killedBy": killed_by or "unknown",
                },
                exit_code=None,
                timed_out=True,
                elapsed_ms=elapsed,
                blender=str(blender),
                blender_source=blender_source,
            )

        report = parse_guard_report(stdout) or {
            "reason": "no-report",
            "tail": (stdout or stderr or "")[-800:],
        }
        ok = proc.returncode == 0 and report.get("reason") is None
        if ok and not out.is_file():
            # 护栏说成功却没有文件：当成失败，绝不把不存在的路径交给下游。
            ok = False
            report = {"reason": "missing-output", "tail": (stdout or stderr or "")[-800:]}
        if not ok and not _remove_output(out) and out.exists():
            # 删不掉就不能装作删掉了：下游会看到「本次失败但目录里有个同名 GLB」，
            # 那是「失败不落盘」这条护栏最容易被绕过的地方。如实标出来。
            report = {**report, "cleanupFailed": True, "cleanupPath": str(out)}

        size = out.stat().st_size if ok else 0
        return RunResult(
            ok=ok,
            reason="" if ok else str(report.get("reason") or "blender-failed"),
            message=_result_message(ok, report, size=size),
            guard_report=report,
            out_path=out if ok else None,
            exit_code=proc.returncode,
            timed_out=False,
            elapsed_ms=elapsed,
            size_bytes=size,
            blender=str(report.get("blender") or blender),
            blender_source=blender_source,
            stderr_tail="" if ok else (stderr or "")[-1500:],
        )
    finally:
        # 无论成败都不留临时目录：脚本往 cwd 里写的垃圾文件不该堆在临时目录里。
        # Windows 上刚被 kill 的进程释放句柄有延迟，所以重试几次再放弃。
        _remove_workdir(workdir)


def _result_message(ok: bool, report: Mapping[str, Any], *, size: int) -> str:
    """把护栏报告压成一句给 AI 的话。**失败时必须点出具体哪几个件、什么高度。**"""
    if ok:
        box = (report.get("normalization") or {}).get("bboxAfter") or []
        dims = " × ".join(f"{v:g}" for v in box) if box else "尺寸未知"
        return f"护栏通过，已导出 GLB（{size} 字节，归一化后 {dims} 米）。"
    reason = str(report.get("reason") or "blender-failed")
    if reason.startswith("floating-parts"):
        floating = report.get("floating") or []
        where = "、".join(
            f"#{f.get('index')} 位于 z={f.get('minZ')}~{f.get('maxZ')}m" for f in floating[:6]
        )
        return f"{reason}：{where}。把这些零件挪到与主体接触的位置后重试。"
    if reason.startswith("component-count"):
        return (
            f"{reason}（期望 {report.get('expectParts')}，实际 {report.get('componentCount')}）。"
            "重数一遍零件，或调整 expectParts。"
        )
    if reason == "ai-script-error":
        return f"脚本自己抛异常：{report.get('error')}。按 traceback 改脚本后重试。"
    if reason == "face-budget":
        return (
            f"{reason}：{report.get('faces')} 面超过上限 {report.get('limit')}。"
            "降细分或改用更简单的基本体。"
        )
    if reason == "network-blocked":
        return f"{reason}（{report.get('attr')}）。bpy 脚本不需要联网，去掉这部分。"
    if reason == "no-report":
        return f"Blender 没有给出护栏报告，尾部输出：{str(report.get('tail', ''))[-300:]}"
    return f"护栏拒绝：{reason}。"
