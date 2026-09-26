#!/usr/bin/env python3
"""确保有一份可用的 Blender —— 便携版下载到**机器级共享缓存**，全机只下一次。

查找顺序（命中即用，绝不重复下载）：
  1. `--blender` 参数 / `DRAMACLAW_BLENDER` 环境变量（用户显式指定，也用于离线机器）
  2. PATH 里的 `blender`
  3. macOS 的 `/Applications/Blender.app`
  4. 机器级共享缓存 `~/.cache/dramaclaw/blender/`

全都没命中才**懒触发**下载官方便携包（sha256 校验），**不写系统目录、不改 PATH、不要管理员权限**。
本脚本**只负责"确保有"**，模板生成与 GLB 导出见同目录 `build_template.py`。

用法：
    python3 scripts/blender/ensure_blender.py            # 打印可执行路径
    python3 scripts/blender/ensure_blender.py --json     # 机器可读（含来源与版本）
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

# 版本**锁死**：不自动升级（升级会再下一份新的，用户应该知情）。
BLENDER_SERIES = "Blender4.5"
BASE_URL = f"https://download.blender.org/release/{BLENDER_SERIES}/"
CACHE_DIR = Path(os.environ.get("DRAMACLAW_BLENDER_CACHE", "~/.cache/dramaclaw/blender")).expanduser()
USER_AGENT = "DramaClaw/1.0 (blender-ensure)"


def _machine_suffix() -> str:
    """本机该下哪个包（与官方发布命名一致）。"""
    system = platform.system()
    machine = platform.machine().lower()
    arm = "arm" in machine or machine == "aarch64"
    if system == "Darwin":
        return "macos-arm64.dmg" if arm else "macos-x64.dmg"
    if system == "Windows":
        return "windows-arm64.zip" if arm else "windows-x64.zip"
    return "linux-arm64.tar.xz" if arm else "linux-x64.tar.xz"


def _cached_blender() -> Path | None:
    """共享缓存里已解好的 Blender（不触发下载）。"""
    if not CACHE_DIR.is_dir():
        return None
    roots = sorted(CACHE_DIR.glob("blender-*"), reverse=True)
    for root in roots:
        for candidate in _executable_candidates(root):
            if candidate.is_file():
                return candidate
    return None


def _executable_candidates(root: Path) -> tuple[Path, ...]:
    """
    三种官方包解包后的可执行路径（结构都实测过，不是猜的）：

    - macOS dmg    → `<root>/Blender.app/Contents/MacOS/Blender`（本机已解包证实）
    - Linux tar.xz → `<root>/blender-<版本>-linux-<架构>/blender`
                      （`blender-launcher` 脚本里 `BF_PROGRAM="blender"`，与 launcher 同级；
                       顶层是版本目录，流式读 tar 头部证实）
    - Windows zip  → `<root>/blender-<版本>-windows-<架构>/blender.exe`
                      （官方 zip 顶层是版本目录，读中央目录 6312 条条目证实）
    """
    return (
        root / "Blender.app" / "Contents" / "MacOS" / "Blender",
        root / "blender",
        root / "blender.exe",
        # Windows zip 与 Linux tar.xz 解包后顶层都是**版本目录**
        # （`blender-<ver>-windows-<arch>/blender.exe`、`blender-<ver>-linux-<arch>/blender`），
        # 名字由下载时的包名决定，用 glob 兜住。
        *sorted(root.glob("blender-*-windows-*/blender.exe")),
        *sorted(root.glob("blender-*-linux-*/blender")),
    )


def find_blender(override: str | None = None) -> tuple[Path | None, str]:
    """返回 (可执行路径, 来源)。来源用于诊断输出，也是"绝不会重复下载"的证据。"""
    if override:
        path = Path(override).expanduser()
        return (path, "override") if path.exists() else (None, "override-missing")
    env = os.environ.get("DRAMACLAW_BLENDER")
    if env:
        path = Path(env).expanduser()
        return (path, "env") if path.exists() else (None, "env-missing")
    found = shutil.which("blender")
    if found:
        return Path(found), "path"
    mac = Path("/Applications/Blender.app/Contents/MacOS/Blender")
    if mac.is_file():
        return mac, "applications"
    cached = _cached_blender()
    if cached:
        return cached, "cache"
    return None, "none"


def _download(url: str, target: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response, target.open("wb") as out:
        shutil.copyfileobj(response, out)


def _verify_sha256(package: Path, expected: str) -> None:
    digest = hashlib.sha256()
    with package.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    if digest.hexdigest() != expected:
        package.unlink(missing_ok=True)
        raise RuntimeError(f"sha256 校验失败（已删除下载物）：期望 {expected}，实际 {digest.hexdigest()}")


def download_blender() -> Path:
    """下载并解好一份便携版到共享缓存。**只在全都没命中时调用。**"""
    suffix = _machine_suffix()
    listing = urllib.request.urlopen(
        urllib.request.Request(BASE_URL, headers={"User-Agent": USER_AGENT}), timeout=60
    ).read().decode("utf-8", "replace")
    versions = set(re.findall(r"blender-(\d+\.\d+\.\d+)-" + re.escape(suffix), listing))
    if not versions:
        raise RuntimeError(f"在 {BASE_URL} 找不到 {suffix} 的包（网络或发布变更？）")
    version = max(versions, key=lambda v: tuple(int(p) for p in v.split(".")))
    name = f"blender-{version}-{suffix}"
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    package = CACHE_DIR / name
    if not package.exists():
        print(f"[ensure-blender] 下载 {name} …", file=sys.stderr)
        _download(BASE_URL + name, package)
    checksum_file = CACHE_DIR / f"blender-{version}.sha256"
    if not checksum_file.exists():
        _download(BASE_URL + f"blender-{version}.sha256", checksum_file)
    expected = ""
    for line in checksum_file.read_text(encoding="utf-8", errors="replace").splitlines():
        if name in line:
            expected = line.split()[0].strip()
            break
    if not expected:
        raise RuntimeError(f"{checksum_file.name} 里没有 {name} 的校验值")
    _verify_sha256(package, expected)

    root = CACHE_DIR / f"blender-{version}"
    root.mkdir(exist_ok=True)
    if package.suffix == ".zip":
        # Windows 便携 zip：解包后保留顶层版本目录（`blender-<ver>-windows-<arch>/`），
        # `_executable_candidates` 会进去找 blender.exe。
        shutil.unpack_archive(str(package), str(root))
    elif package.suffix == ".dmg":
        mount = CACHE_DIR / "_mnt"
        mount.mkdir(exist_ok=True)
        subprocess.run(["hdiutil", "attach", str(package), "-nobrowse", "-mountpoint", str(mount)], check=True)
        try:
            apps = list(mount.glob("Blender.app"))
            if not apps:
                raise RuntimeError("DMG 里没有 Blender.app")
            shutil.copytree(apps[0], root / "Blender.app", dirs_exist_ok=True, symlinks=True)
        finally:
            subprocess.run(["hdiutil", "detach", str(mount)], check=False)
    else:
        # Linux tar.xz：`shutil.unpack_archive` 对它可用（3.12+ 起注册了 xz 处理）。
        shutil.unpack_archive(str(package), str(root))

    found, source = find_blender()
    if not found:
        raise RuntimeError(f"解包后仍找不到可执行文件（缓存目录 {CACHE_DIR}）")
    print(f"[ensure-blender] 就绪：{found}（来源 {source}）", file=sys.stderr)
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description="确保有可用的 Blender（命中即不下载）")
    parser.add_argument("--blender", help="显式指定 Blender 可执行文件路径")
    parser.add_argument("--json", action="store_true", help="输出 JSON（路径/来源/版本）")
    parser.add_argument("--allow-download", action="store_true",
                        help="全都没命中时允许下载（不给这个开关就只报告，便于离线预检）")
    args = parser.parse_args()

    path, source = find_blender(args.blender)
    if path is None and args.allow_download:
        path = download_blender()
        source = "downloaded"
    if path is None:
        payload = {"ok": False, "source": source, "cache": str(CACHE_DIR)}
        print(json.dumps(payload) if args.json else f"未找到 Blender（{source}）", file=sys.stderr)
        return 1

    version = ""
    try:
        version = subprocess.run(
            [str(path), "--version"], capture_output=True, text=True, timeout=60
        ).stdout.splitlines()[0]
    except Exception:  # noqa: BLE001 — 版本只是诊断信息，拿不到不影响可用性
        pass
    if args.json:
        print(json.dumps({"ok": True, "path": str(path), "source": source, "version": version}))
    else:
        print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
