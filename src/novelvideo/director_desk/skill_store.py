"""导演台技能包的落盘与校验。

移植自上游 `desktop/skills/{package,store,github,host}.cjs`。Web 端去掉了一处硬
Electron 依赖：上游 `host.cjs:1` 的 ``{dialog, shell}``（选目录 / 用系统文件管理器打开
目录）。替换成「浏览器上传文件 → 路由收包 → `install`」，`open` 动作则显式失败——
网页宿主拿不到本机路径，静默成功才是真的坏。

## 不变的部分

- 上限：``MAX_FILES = 1000``、``MAX_BYTES = 50MB``。
- 包格式：根部 ``SKILL.md``（YAML frontmatter）+ 相对路径附件。
- 存储：``skills/index.json`` + 每技能一个独占目录，原子写（``.tmp`` + ``rename``，
  ``mode=0o600``），读附件时 ``realpath`` 二次确认没跑出包目录。
- 导入三种来源：文件夹 / zip 解包结果 / GitHub 目录树。

技能**不碰 AI 渠道密钥**（上游的 ``safeStorage`` 只管渠道），所以本模块没有密钥概念。
"""

from __future__ import annotations

import asyncio
import logging
import hashlib
import json
import os
import re
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence
from urllib.parse import quote, unquote, urlsplit

import httpx
import yaml

_log = logging.getLogger(__name__)

__all__ = [
    "MAX_BYTES",
    "MAX_FILES",
    "BuiltinSkill",
    "SkillError",
    "SkillFile",
    "SkillPackage",
    "SkillStore",
    "files_from_payload",
    "get_skill_store",
    "github_package",
    "handle_skill_request",
    "package_from_folder",
    "relative_file",
    "set_builtin_skill",
    "skill_package",
]

MAX_BYTES = 50 * 1024 * 1024
MAX_FILES = 1000

#: 单次 GitHub 拉取允许的额外请求数（目录树遍历 + 逐文件下载）。
GITHUB_MAX_REQUESTS = MAX_FILES + 100
GITHUB_TIMEOUT_S = 120.0

_SKIP_DIRS = {".git", "node_modules", "__pycache__"}
_WINDOWS_RESERVED = re.compile(r"^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)", re.I)
_BAD_SEGMENT_CHARS = re.compile(r"[<>:\"|?*\x00-\x1f]")
#: 索引与目录名必须是 uuid —— 目录名会拼进文件路径，非 uuid 一律拒绝。
_ID_RE = re.compile(r"^[0-9a-f-]{36}$")
#: GitHub 的 owner / repo 字符集。
_NAME_RE = re.compile(r"^[a-z0-9_.-]+$", re.I)


class SkillError(ValueError):
    """技能包或技能操作不合法。对用户可见的中文原因直接写在 message 里。"""


@dataclass(frozen=True)
class SkillFile:
    path: str
    data: bytes


@dataclass(frozen=True)
class BuiltinSkill:
    """上游 ``src/automation/builtin-skill.json`` 的形状。

    内容不在本仓复制一份：宿主握手时从 iframe 里读上来（那边才是事实来源），所以
    升级 vendored 导演台不会让这里留一份过期副本。
    """

    name: str
    version: str
    instructions: str
    references: dict[str, str]

    @classmethod
    def from_payload(cls, payload: Any) -> "BuiltinSkill | None":
        if not isinstance(payload, dict):
            return None
        name = str(payload.get("name") or "").strip()
        version = str(payload.get("version") or "").strip()
        instructions = str(payload.get("instructions") or "")
        if not name or not version or not instructions:
            return None
        raw_references = payload.get("references")
        references = {
            str(key): str(value)
            for key, value in (raw_references or {}).items()
            if isinstance(raw_references, dict)
        } if isinstance(raw_references, dict) else {}
        return cls(name=name, version=version, instructions=instructions, references=references)

    @property
    def files(self) -> list[str]:
        return ["SKILL.md", *self.references.keys()]


@dataclass(frozen=True)
class SkillPackage:
    name: str
    description: str
    version: str
    files: tuple[SkillFile, ...]
    size: int
    instructions: str
    entry: str


def relative_file(value: Any) -> str:
    """校验并返回一个包内相对路径。

    上游 ``package.cjs`` 的 ``relativeFile`` 逐条照抄：反斜杠、空段、``.``/``..``、
    控制字符、结尾的 ``.`` 或空格、Windows 保留名全部拒绝。路径逃逸在**写入前**就
    被挡住，落盘时再由 :func:`_resolve_inside` 兜一层 ``realpath``。
    """
    if not isinstance(value, str) or not value:
        raise SkillError("技能文件路径无效")
    if len(value) > 500 or "\\" in value:
        raise SkillError("技能文件路径无效")
    for segment in value.split("/"):
        if (
            not segment
            or segment in {".", ".."}
            or _BAD_SEGMENT_CHARS.search(segment)
            or segment.endswith(".")
            or segment.endswith(" ")
            or _WINDOWS_RESERVED.match(segment)
        ):
            raise SkillError("技能文件路径无效")
    return value


def _failsafe_metadata(text: str) -> tuple[dict[str, Any], str]:
    """切 frontmatter，返回 (元数据, 正文)。

    上游用 ``yaml.FAILSAFE_SCHEMA``（只认字符串/序列/映射），这里用 ``safe_load``：
    语义更松一点（``version: 1.0`` 会解析成 float 而非字符串），但换来了不构造任意
    Python 对象。取值处一律再 ``str()``，落库形状与上游一致。
    """
    header = re.match(r"^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)", text)
    if not header:
        return {}, text
    try:
        loaded = yaml.safe_load(header.group(1))
    except yaml.YAMLError as exc:
        raise SkillError("SKILL.md 的 YAML 信息格式错误") from exc
    if loaded is None:
        loaded = {}
    if not isinstance(loaded, dict):
        raise SkillError("SKILL.md 的 YAML 信息格式错误")
    return loaded, text[header.end():]


def skill_package(files: Sequence[SkillFile]) -> SkillPackage:
    """校验一个技能包并算出它的 ``version``。

    ``version`` 是内容哈希（上游取 sha256 前 20 位）：技能内容变了版本就变，于是
    「本版本已读，不必重读」这条判断不会在内容被改后误命中。
    """
    if not isinstance(files, (list, tuple)) or not files:
        raise SkillError("技能包需要文件，最多 1000 个")
    if len(files) > MAX_FILES:
        raise SkillError("技能包需要文件，最多 1000 个")

    names: set[str] = set()
    size = 0
    for item in files:
        if not isinstance(item, SkillFile):
            raise SkillError("技能文件内容无效")
        relative_file(item.path)
        key = item.path.lower()
        if key in names:
            raise SkillError("技能包内文件名重复")
        names.add(key)
        if not isinstance(item.data, (bytes, bytearray)):
            raise SkillError("技能文件内容无效")
        size += len(item.data)
        if size > MAX_BYTES:
            raise SkillError("技能包超过 50 MB")

    entry = next((f for f in files if f.path.lower() == "skill.md"), None)
    if entry is None:
        raise SkillError("所选目录根部没有 SKILL.md，请选择具体技能目录")

    try:
        text = entry.data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise SkillError("SKILL.md 需要 UTF-8 文本") from exc
    if "\0" in text or not text.strip():
        raise SkillError("SKILL.md 需要 UTF-8 文本")

    metadata, body = _failsafe_metadata(text)
    heading = re.search(r"^#\s+(.+)$", body, re.MULTILINE)
    name = str(metadata.get("name") or (heading.group(1) if heading else "") or "自定义技能").strip()
    description = str(metadata.get("description") or "").strip()
    if not name or len(name) > 200 or len(description) > 5000:
        raise SkillError("技能名称或描述过长")

    digest = hashlib.sha256()
    for item in sorted(files, key=lambda f: f.path):
        digest.update(json.dumps([item.path, len(item.data)], separators=(",", ":")).encode("utf-8"))
        digest.update(item.data)
    return SkillPackage(
        name=name,
        description=description,
        version=digest.hexdigest()[:20],
        files=tuple(files),
        size=size,
        instructions=text,
        entry=entry.path,
    )


def _resolve_inside(root: Path, relative: str) -> Path:
    """把包内相对路径解析成绝对路径，并确认它没有跑出 ``root``。

    ``relative_file`` 已经挡掉了字面量逃逸，这里防的是**符号链接**：技能目录里放一个
    指向别处的 ``SKILL.md`` 时，只有 realpath 比较才看得出来。
    """
    target = (root / relative).resolve()
    root_resolved = root.resolve()
    if target == root_resolved or root_resolved not in target.parents:
        raise SkillError("技能附件不能指向包外文件")
    return target


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
    os.replace(temp, path)


class SkillStore:
    """技能目录的读写。

    :param root: ``skills/`` 的父目录，本模块在其下建 ``skills/``。
    :param builtin_provider: 返回当前内置技能的回调；返回 ``None`` 表示宿主还没把
        上游的 ``builtin-skill.json`` 报上来（例如画布没打开过）。
    """

    def __init__(
        self,
        root: Path | str,
        *,
        builtin_provider: Callable[[], BuiltinSkill | None] | None = None,
        packaged_skills: Mapping[str, SkillPackage] | None = None,
    ) -> None:
        self._root = Path(root)
        self._skills_root = self._root / "skills"
        self._index = self._skills_root / "index.json"
        self._builtin_provider = builtin_provider
        #: 随软件提供的项目补充技能直接读包内容，仅将启用偏好写入索引。
        self._packaged_skills = dict(packaged_skills or {})
        self._state: dict[str, Any] = {
            "version": 1,
            "builtinEnabled": True,
            "entries": [],
        }
        self._lock = asyncio.Lock()
        self._load_error = ""
        self._load()

    # ── 索引 ────────────────────────────────────────────────────────────────

    def _load(self) -> None:
        try:
            payload = json.loads(self._index.read_text("utf-8"))
        except FileNotFoundError:
            return
        except (OSError, json.JSONDecodeError):
            # 上游对损坏索引是抛错（「原文件已保留」），但那时索引只影响技能面板；
            # 这里选择记下来并让 list/enable 报出来，避免整个模块 import 就炸。
            self._load_error = "无法读取本机技能目录，原文件已保留"
            return
        if not _valid_state(payload):
            self._load_error = "技能目录损坏"
            return
        self._state = payload

    def _assert_loaded(self) -> None:
        if self._load_error:
            raise SkillError(self._load_error)

    def _persist(self, state: dict[str, Any]) -> None:
        _atomic_write(
            self._index,
            json.dumps(state, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        )
        self._state = state

    def _builtin(self) -> BuiltinSkill | None:
        return self._builtin_provider() if self._builtin_provider else None

    def _builtin_entry(self) -> dict[str, Any] | None:
        builtin = self._builtin()
        if builtin is None:
            return None
        return {
            "id": "builtin",
            "name": builtin.name,
            "description": "导演台操作、空间规则与配套提示词",
            "version": builtin.version,
            "enabled": bool(self._state["builtinEnabled"]),
            "builtin": True,
            "source": "随软件内置",
            "files": builtin.files,
        }

    # ── 读 ──────────────────────────────────────────────────────────────────

    async def list(self, enabled_only: bool = False) -> list[dict[str, Any]]:
        async with self._lock:
            self._assert_loaded()
            entries = [e for e in self._builtin_entry_list()]
            entries.extend(self._packaged_entry(id) for id in self._packaged_skills)
            entries.extend(
                {
                    **{k: v for k, v in entry.items() if k != "folder"},
                    "builtin": False,
                }
                for entry in self._state["entries"]
            )
        if enabled_only:
            entries = [e for e in entries if e.get("enabled")]
        return entries

    def _builtin_entry_list(self) -> list[dict[str, Any]]:
        entry = self._builtin_entry()
        return [entry] if entry else []

    def _packaged_entry(self, id: str) -> dict[str, Any]:
        """补充技能独立列出，版本跟随软件内容，禁用偏好跨重启保留。"""
        pack = self._packaged_skills[id]
        return {
            "id": id,
            "name": pack.name,
            "description": pack.description,
            "version": pack.version,
            "enabled": self._state.get("packagedEnabled", {}).get(id, True),
            "builtin": True,
            "source": "随软件内置 · 本项目补充",
            "files": [item.path for item in pack.files],
        }

    async def read(
        self,
        *,
        id: str = "builtin",
        path: str | None = None,
        known_version: str | None = None,
        allow_disabled: bool = False,
    ) -> dict[str, Any]:
        """读技能正文或附件。``known_version`` 命中时只回摘要，不重复回正文。"""
        async with self._lock:
            self._assert_loaded()
            if id == "builtin":
                builtin = self._builtin()
                if builtin is None:
                    raise SkillError("内置技能尚未就绪，请先打开画布上的导演台节点")
                entry = self._builtin_entry() or {}
                files = builtin.files
                name, version, enabled = builtin.name, builtin.version, bool(entry.get("enabled"))
            elif id in self._packaged_skills:
                entry = self._packaged_entry(id)
                files = entry["files"]
                name, version, enabled = entry["name"], entry["version"], entry["enabled"]
            else:
                record = self._entry_for(id)
                files = list(record["files"])
                name, version, enabled = (
                    record["name"],
                    record["version"],
                    bool(record["enabled"]),
                )

            if not enabled and not allow_disabled:
                raise SkillError("此技能已停用，请遵循用户当前启用的技能")

            file = relative_file(path or "SKILL.md")
            if file not in files:
                raise SkillError("技能中没有这个文件")
            if known_version == version and path is None:
                return {
                    "id": id,
                    "name": name,
                    "version": version,
                    "enabled": enabled,
                    "unchanged": True,
                    "files": files,
                }

            if id == "builtin":
                text = (
                    builtin.instructions  # type: ignore[union-attr]
                    if file == "SKILL.md"
                    else (builtin.references or {}).get(file, "")  # type: ignore[union-attr]
                )
            elif id in self._packaged_skills:
                text = next(item.data for item in self._packaged_skills[id].files if item.path == file).decode("utf-8")
            else:
                text = self._read_entry_file(record, file)  # type: ignore[possibly-undefined]

        return {
            "id": id,
            "name": name,
            "version": version,
            "enabled": enabled,
            "unchanged": False,
            "path": file,
            "instructions": text,
            "files": files,
        }

    def _read_entry_file(self, record: dict[str, Any], file: str) -> str:
        folder = record["folder"]
        if not isinstance(folder, str) or not _ID_RE.match(folder):
            raise SkillError("技能目录无效")
        root = self._skills_root.resolve() / folder
        target = _resolve_inside(root, file)
        try:
            data = target.read_bytes()
        except OSError as exc:
            _log.warning("director desk skill read failed path=%s exc=%s", file, type(exc).__name__)
            raise SkillError("该文件是二进制附件，请在技能目录中查看") from exc
        if b"\0" in data:
            raise SkillError("该文件是二进制附件，请在技能目录中查看")
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise SkillError("该文件是二进制附件，请在技能目录中查看") from exc

    # ── 写 ──────────────────────────────────────────────────────────────────

    def _entry_for(self, id: str) -> dict[str, Any]:
        for entry in self._state["entries"]:
            if entry["id"] == id:
                return entry
        raise SkillError("技能不存在")

    def folder(self, id: str) -> Path:
        """技能在磁盘上的目录。目录名由本模块生成，不是用户输入。"""
        record = self._entry_for(id)
        return self._skills_root / str(record["folder"])

    async def install(
        self,
        pack: SkillPackage,
        source: str = "本地导入",
        replace_id: str | None = None,
    ) -> None:
        """装一个技能包。每次修订都占一个新目录，回滚时旧目录整个删掉。"""
        async with self._lock:
            self._assert_loaded()
            previous = self._entry_for(replace_id) if replace_id else None
            folder = str(uuid.uuid4())
            destination = self._skills_root / folder
            try:
                for item in pack.files:
                    relative_file(item.path)
                    target = _resolve_inside(destination, item.path)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(item.data)
                entry = {
                    "id": previous["id"] if previous else str(uuid.uuid4()),
                    "folder": folder,
                    "name": pack.name,
                    "description": pack.description,
                    "version": pack.version,
                    "enabled": bool(previous["enabled"]) if previous else True,
                    "source": source,
                    "files": [f.path for f in pack.files],
                    "entry": pack.entry,
                }
                self._persist(
                    {
                        **self._state,
                        "entries": [
                            e for e in self._state["entries"] if e["id"] != entry["id"]
                        ]
                        + [entry],
                    }
                )
            except BaseException:
                _log.error("director desk skill install failed name=%s", pack.name)
                shutil.rmtree(destination, ignore_errors=True)
                raise
            if previous:
                shutil.rmtree(
                    self._skills_root / str(previous["folder"]), ignore_errors=True
                )

    async def install_folder(
        self, folder: Path, source: str = "本地导入", replace_id: str | None = None
    ) -> None:
        """从磁盘目录重新导入（`reload` 动作用）。先整包校验，再谈落盘。"""
        pack = package_from_folder(folder)
        await self.install(pack, source, replace_id)

    async def enable(self, id: str, enabled: bool) -> None:
        async with self._lock:
            self._assert_loaded()
            if not isinstance(enabled, bool):
                raise SkillError("技能开关无效")
            if id == "builtin":
                self._persist({**self._state, "builtinEnabled": enabled})
                return
            if id in self._packaged_skills:
                self._persist({**self._state, "packagedEnabled": {**self._state.get("packagedEnabled", {}), id: enabled}})
                return
            self._entry_for(id)
            self._persist(
                {
                    **self._state,
                    "entries": [
                        {**e, "enabled": enabled} if e["id"] == id else e
                        for e in self._state["entries"]
                    ],
                }
            )

    async def remove(self, id: str) -> None:
        async with self._lock:
            self._assert_loaded()
            if id == "builtin" or id in self._packaged_skills:
                raise SkillError("内置技能可以停用，随软件保留")
            entry = self._entry_for(id)
            self._persist(
                {
                    **self._state,
                    "entries": [e for e in self._state["entries"] if e["id"] != id],
                }
            )
            folder = str(entry["folder"])
            if _ID_RE.match(folder):
                shutil.rmtree(self._skills_root / folder, ignore_errors=True)

    # ── 模型侧入口 ──────────────────────────────────────────────────────────

    async def tool(self, args: Any = None) -> dict[str, Any]:
        """``director_skill`` 工具。只认 list / read 两个只读动作。

        参数校验逐条对齐上游：键名白名单、值必须全是字符串、``action`` 只允许两个
        只读值。写操作（安装、开关）不经过模型，只经过技能面板。
        """
        if not isinstance(args, dict) or any(
            key not in {"action", "id", "path", "knownVersion"} for key in args
        ):
            raise SkillError("技能查询参数无效")
        if any(not isinstance(value, str) for value in args.values()):
            raise SkillError("技能查询参数无效")
        action = args.get("action")
        if action and action not in {"list", "read"}:
            raise SkillError("技能查询参数无效")
        if action == "list":
            return {"skills": await self.list(True)}
        return await self.read(
            id=args.get("id", "builtin"),
            path=args.get("path"),
            known_version=args.get("knownVersion"),
        )


def _valid_state(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    if payload.get("version") != 1 or not isinstance(payload.get("builtinEnabled"), bool):
        return False
    preferences = payload.get("packagedEnabled", {})
    if not isinstance(preferences, dict) or any(not isinstance(key, str) or not isinstance(value, bool) for key, value in preferences.items()):
        return False
    entries = payload.get("entries")
    if not isinstance(entries, list):
        return False
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            return False
        if not isinstance(entry.get("id"), str) or not _ID_RE.match(entry["id"]):
            return False
        if not isinstance(entry.get("folder"), str) or not _ID_RE.match(entry["folder"]):
            return False
        if not isinstance(entry.get("name"), str) or not isinstance(entry.get("enabled"), bool):
            return False
        if not isinstance(entry.get("files"), list):
            return False
        if entry["id"] in seen:
            return False
        seen.add(entry["id"])
    return True


def package_from_folder(folder: Path | str) -> SkillPackage:
    """把一个本地目录打成技能包（``import`` 的文件夹来源、``reload`` 用）。"""
    root = Path(folder)
    if root.is_symlink():
        raise SkillError("请选择实际技能文件或目录")
    if not root.exists():
        raise SkillError("请选择技能文件或目录")
    if root.is_file():
        return skill_package([SkillFile(path="SKILL.md", data=_read_bounded(root))])

    files: list[SkillFile] = []
    size = 0

    def walk(directory: Path, prefix: str = "") -> None:
        nonlocal size
        for child in sorted(directory.iterdir(), key=lambda p: p.name):
            if child.name in _SKIP_DIRS:
                continue
            if child.is_symlink():
                raise SkillError("技能目录包含符号链接，请移除链接后导入")
            relative = relative_file(prefix + child.name)
            if child.is_dir():
                walk(child, relative + "/")
            elif child.is_file():
                data = _read_bounded(child)
                size += len(data)
                if size > MAX_BYTES or len(files) >= MAX_FILES:
                    raise SkillError("技能包超过 50 MB 或 1000 个文件")
                files.append(SkillFile(path=relative, data=data))
            else:
                raise SkillError("请选择技能文件或目录")

    walk(root)
    return skill_package(files)


def _read_bounded(path: Path) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise SkillError("技能文件无效或超过 50 MB")
    if path.stat().st_size > MAX_BYTES:
        raise SkillError("技能文件无效或超过 50 MB")
    return path.read_bytes()


# ── GitHub 来源 ────────────────────────────────────────────────────────────


def _github_source(value: str) -> dict[str, str]:
    """把 GitHub 链接拆成 owner / repo / ref / 目录。

    只认公开的 ``https://github.com/...``，且不许带账号、端口、查询或片段 —— 那些
    字段在浏览器的凭据里另有用途，出现在下载链接里只会让用户分辨不出是哪条规则拦的。
    """
    raw = str(value or "").strip()
    if not raw:
        raise SkillError("请输入 GitHub 技能目录链接")
    try:
        parts = urlsplit(raw)
    except ValueError as exc:
        raise SkillError("请输入 GitHub 技能目录链接") from exc
    if (
        parts.scheme != "https"
        or parts.hostname != "github.com"
        or parts.port
        or parts.username
        or parts.password
        or parts.query
        or parts.fragment
    ):
        raise SkillError("请使用公开 github.com 仓库或技能目录的 HTTPS 链接")

    decoded = [unquote(segment) for segment in parts.path.split("/") if segment]
    owner = decoded[0] if len(decoded) > 0 else ""
    repo = decoded[1] if len(decoded) > 1 else ""
    mode = decoded[2] if len(decoded) > 2 else ""
    ref = decoded[3] if len(decoded) > 3 else ""
    rest = decoded[4:]
    if not _NAME_RE.match(owner) or not _NAME_RE.match(repo):
        raise SkillError("GitHub 链接格式无效")
    if mode and mode not in {"tree", "blob"}:
        raise SkillError("GitHub 链接格式无效")
    if mode and not ref:
        raise SkillError("GitHub 链接格式无效")

    points_at_skill = mode == "blob" and bool(re.search(r"/SKILL\.md$", parts.path, re.I))
    if mode == "blob" and not points_at_skill:
        raise SkillError("文件链接需要指向 SKILL.md")
    folder = "/".join(rest[:-1] if points_at_skill else rest)
    if folder:
        relative_file(folder)
    return {
        "owner": owner,
        "repo": re.sub(r"\.git$", "", repo),
        "ref": ref,
        "folder": folder,
        "url": raw,
    }


async def github_package(url: str, *, client: httpx.AsyncClient | None = None) -> SkillPackage:
    """按 GitHub 目录树 API 拉一个技能目录下来并校验。

    逐文件用 raw Accept 头下载，并对单个响应做 ``MAX_BYTES`` 截断 —— 目录树 JSON 里
    报的 ``size`` 只是提示，真正的闸门在读到的字节数上。
    """
    source = _github_source(url)
    owned = client is None
    # trust_env=False：和 ai_host 同一个理由。技能包从 GitHub 拉，走本地代理
    # 既无必要也会把 github.com 的证书验证搅乱（见 ai_host 里的完整说明）。
    http = client or httpx.AsyncClient(follow_redirects=False, timeout=30.0, trust_env=False)
    files: list[SkillFile] = []
    state = {"bytes": 0, "requests": 0}
    try:

        async def request(relative: str, *, raw: bool = False) -> bytes:
            state["requests"] += 1
            if state["requests"] > GITHUB_MAX_REQUESTS:
                raise SkillError("技能目录过大，请选择更具体的技能目录")
            encoded = "/".join(_quote(segment) for segment in relative.split("/") if segment)
            target = (
                f"https://api.github.com/repos/{_quote(source['owner'])}/"
                f"{_quote(source['repo'])}/contents/{encoded}"
            )
            if source["ref"]:
                target += "?ref=" + _quote(source["ref"])
            try:
                response = await http.get(
                    target,
                    headers={
                        "Accept": (
                            "application/vnd.github.raw+json"
                            if raw
                            else "application/vnd.github+json"
                        )
                    },
                )
            except httpx.HTTPError as exc:
                raise SkillError("GitHub 下载失败，请检查网络后重试") from exc
            if response.status_code >= 400:
                raise SkillError(
                    "GitHub 访问额度暂时受限，可下载后本地导入"
                    if response.status_code in {403, 429}
                    else f"GitHub 下载失败（{response.status_code}），请检查公开仓库和技能目录链接"
                )
            data = response.content
            if len(data) > MAX_BYTES or (raw and state["bytes"] + len(data) > MAX_BYTES):
                raise SkillError("技能包超过 50 MB")
            if raw:
                state["bytes"] += len(data)
            return data

        async def walk(folder: str, prefix: str = "") -> None:
            entries = json.loads((await request(folder)).decode("utf-8"))
            if not isinstance(entries, list) or len(entries) >= MAX_FILES:
                raise SkillError("请选择包含 SKILL.md 的具体技能目录")
            if not prefix and not any(
                isinstance(e, dict)
                and str(e.get("name", "")).lower() == "skill.md"
                and e.get("type") == "file"
                for e in entries
            ):
                raise SkillError("目录中没有 SKILL.md，请使用具体技能目录链接")
            for item in entries:
                if not isinstance(item, dict):
                    raise SkillError("GitHub 返回了无效文件名")
                name = str(item.get("name") or "")
                if name in _SKIP_DIRS:
                    continue
                relative_file(name)
                if "/" in name:
                    raise SkillError("GitHub 返回了无效文件名")
                relative = prefix + name
                remote = (folder + "/" if folder else "") + name
                kind = item.get("type")
                if kind == "dir":
                    await walk(remote, relative + "/")
                    continue
                if (
                    kind != "file"
                    or item.get("submodule_git_url")
                    or int(item.get("size") or 0) > MAX_BYTES
                ):
                    raise SkillError("技能目录包含不支持的链接、子模块或超大文件")
                if len(files) >= MAX_FILES:
                    raise SkillError("技能文件超过 1000 个")
                files.append(SkillFile(path=relative, data=await request(remote, raw=True)))

        await walk(source["folder"])
    finally:
        if owned:
            await http.aclose()
    return skill_package(files)


def _quote(value: str) -> str:
    return quote(value, safe="")


def files_from_payload(items: Any) -> list[SkillFile]:
    """把路由收到的 ``{path, dataBase64}`` 列表转成 :class:`SkillFile`。"""
    import base64

    if not isinstance(items, list):
        raise SkillError("技能文件内容无效")
    files: list[SkillFile] = []
    for item in items:
        if not isinstance(item, dict):
            raise SkillError("技能文件内容无效")
        raw = item.get("data")
        if not isinstance(raw, str):
            raise SkillError("技能文件内容无效")
        try:
            data = base64.b64decode(raw, validate=True)
        except (ValueError, TypeError) as exc:
            raise SkillError("技能文件内容无效") from exc
        files.append(SkillFile(path=str(item.get("path") or ""), data=data))
    return files


# ── 技能面板请求 ────────────────────────────────────────────────────────────

#: `open` 在网页宿主里没有对应概念（拿不到本机路径），显式失败而不是假装打开。
_ACTIONS = {"list", "read", "enable", "remove", "import", "github", "reload"}


async def handle_skill_request(store: "SkillStore", data: Any) -> dict[str, Any]:
    """技能面板的一次请求（上游 ``skills/host.cjs`` 的 ``handle``）。

    ``kind`` 只在 ``import`` 用：``file`` 是单份 ``SKILL.md``，``folder`` 是整棵目录。
    选文件/选目录的对话框在 Electron 里，网页端由浏览器上传顶替。
    """
    if not isinstance(data, Mapping):
        raise SkillError("技能操作参数无效")
    action = str(data.get("action") or "")
    skill_id = str(data.get("id") or "")
    if action not in _ACTIONS:
        if action == "open":
            raise SkillError("网页版导演台无法打开本机技能目录，请在文件管理器中查看")
        raise SkillError("未知技能操作")

    if action == "list":
        return {"skills": await store.list()}
    if action == "read":
        return await store.read(id=skill_id or "builtin", path=data.get("path"), allow_disabled=True)
    if action == "open":
        raise SkillError("网页版导演台无法打开本机技能目录，请在文件管理器中查看")

    if action == "enable":
        await store.enable(skill_id, data.get("enabled"))
    elif action == "remove":
        await store.remove(skill_id)
    elif action == "import":
        pack = skill_package(files_from_payload(data.get("files")))
        await store.install(pack, "本地导入", skill_id or None)
    elif action == "github":
        pack = await github_package(str(data.get("url") or ""))
        await store.install(pack, str(data.get("url") or ""), skill_id or None)
    elif action == "reload":
        entry = next((e for e in await store.list() if e["id"] == skill_id), None)
        if entry is None or entry.get("builtin"):
            raise SkillError("请选择自定义技能")
        await store.install_folder(store.folder(skill_id), str(entry.get("source") or ""), skill_id)
    return {"skills": await store.list()}


# ── 进程级实例 ──────────────────────────────────────────────────────────────

_BUILTIN: BuiltinSkill | None = None
_STORE: "SkillStore | None" = None


def set_builtin_skill(payload: Any) -> BuiltinSkill | None:
    """宿主握手时把上游 ``builtin-skill.json`` 报上来。

    内容不复制进本仓：vendored 导演台升级后内置技能会变，而这里是运行时读到的，
    不会留下一份需要人工同步的过期副本。
    """
    global _BUILTIN
    builtin = BuiltinSkill.from_payload(payload)
    if builtin is not None:
        _BUILTIN = builtin
    return _BUILTIN


def get_builtin_skill() -> BuiltinSkill | None:
    return _BUILTIN


def _default_root() -> Path:
    from novelvideo import config

    return Path(config.STATE_DIR) / "director_desk"


def get_skill_store() -> "SkillStore":
    """进程级技能库单例。"""
    global _STORE
    if _STORE is None:
        folder = Path(__file__).parent / "skill_packages" / "image-previs"
        _STORE = SkillStore(
            _default_root(), builtin_provider=get_builtin_skill,
            packaged_skills={"image-previs": package_from_folder(folder)},
        )
    return _STORE


def reset_skill_store_for_tests() -> None:
    """测试用：丢掉单例与内置技能。生产代码不该调用。"""
    global _STORE, _BUILTIN
    _STORE = None
    _BUILTIN = None
