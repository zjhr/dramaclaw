"""技能包校验与落盘。

上限、frontmatter、路径逃逸这三条是安全边界，不只是「体验」：技能包是从用户上传和
GitHub 拉来的，写盘路径一旦能逃出技能目录就是任意文件写。
"""

from __future__ import annotations


from pathlib import Path

import httpx
import pytest

from novelvideo.director_desk import skill_store
from novelvideo.director_desk.skill_store import (
    MAX_BYTES,
    MAX_FILES,
    BuiltinSkill,
    SkillError,
    SkillFile,
    SkillPackage,
    SkillStore,
    files_from_payload,
    github_package,
    handle_skill_request,
    package_from_folder,
    relative_file,
    set_builtin_skill,
    skill_package,
)

SKILL_MD = """---
name: 我的导演技能
description: 讲清楚怎么摆位
version: 3
---

# 导演技能

先站位，再走位。
"""


def make_store(tmp_path: Path, *, builtin: BuiltinSkill | None = None) -> SkillStore:
    return SkillStore(tmp_path, builtin_provider=lambda: builtin)


# ── 路径 ────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "path",
    [
        "../escape.md",
        "a/../b.md",
        "/abs.md",
        "a//b.md",
        "./a.md",
        "a\\b.md",
        "nul.md",
        "COM1.txt",
        "trailing.",
        "trailing ",
        "with\x00null.md",
        "",
        "x" * 501,
    ],
)
def test_relative_file_rejects_escaping_and_reserved_paths(path: str) -> None:
    with pytest.raises(SkillError):
        relative_file(path)


def test_relative_file_accepts_ordinary_relative_paths() -> None:
    assert relative_file("references/camera.md") == "references/camera.md"


# ── 包校验 ──────────────────────────────────────────────────────────────────


def test_package_requires_skill_md_at_the_root() -> None:
    with pytest.raises(SkillError, match="没有 SKILL.md"):
        skill_package([SkillFile(path="references/camera.md", data=b"# camera")])


def test_package_rejects_nested_skill_md_as_the_entry() -> None:
    with pytest.raises(SkillError, match="没有 SKILL.md"):
        skill_package([SkillFile(path="nested/SKILL.md", data=SKILL_MD.encode())])


def test_package_rejects_more_than_max_files() -> None:
    files = [SkillFile(path="SKILL.md", data=SKILL_MD.encode())]
    files += [SkillFile(path=f"ref-{i}.md", data=b"x") for i in range(MAX_FILES)]

    with pytest.raises(SkillError, match="1000"):
        skill_package(files)


def test_package_rejects_more_than_max_bytes(monkeypatch: pytest.MonkeyPatch) -> None:
    # 真的造 50MB 测试太慢，把上限调小来验证同一条守卫；MAX_BYTES 本身另有一条断言。
    monkeypatch.setattr(skill_store, "MAX_BYTES", 64)
    with pytest.raises(SkillError, match="50 MB"):
        skill_package([SkillFile(path="SKILL.md", data=b"x" * 65)])


def test_max_limits_are_the_upstream_ones() -> None:
    assert MAX_FILES == 1000
    assert MAX_BYTES == 50 * 1024 * 1024


def test_package_rejects_case_insensitive_duplicate_names() -> None:
    with pytest.raises(SkillError, match="文件名重复"):
        skill_package([SkillFile(path="SKILL.md", data=SKILL_MD.encode()), SkillFile(path="skill.MD", data=b"x")])


def test_package_rejects_binary_skill_md() -> None:
    with pytest.raises(SkillError, match="UTF-8"):
        skill_package([SkillFile(path="SKILL.md", data=b"\x00\xff\xfe binary")])


def test_package_version_follows_content_hash() -> None:
    first = skill_package([SkillFile(path="SKILL.md", data=SKILL_MD.encode())])
    same = skill_package([SkillFile(path="SKILL.md", data=SKILL_MD.encode())])
    changed = skill_package([SkillFile(path="SKILL.md", data=(SKILL_MD + "改\n").encode())])

    assert first.version == same.version
    assert first.version != changed.version


def test_package_reads_frontmatter_name_and_falls_back_to_heading() -> None:
    pack = skill_package([SkillFile(path="SKILL.md", data=SKILL_MD.encode())])
    heading_only = skill_package(
        [SkillFile(path="SKILL.md", data="# 只有标题\n\n正文\n".encode())]
    )

    assert pack.name == "我的导演技能"
    assert pack.description == "讲清楚怎么摆位"
    assert heading_only.name == "只有标题"


def test_package_rejects_broken_frontmatter() -> None:
    broken = "---\nname: [unclosed\n---\n\n正文\n"
    with pytest.raises(SkillError, match="YAML"):
        skill_package([SkillFile(path="SKILL.md", data=broken.encode())])


# ── 落盘 ────────────────────────────────────────────────────────────────────


async def test_install_writes_files_and_lists_the_skill(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    pack = skill_package(
        [
            SkillFile(path="SKILL.md", data=SKILL_MD.encode()),
            SkillFile(path="references/camera.md", data="# camera".encode()),
        ]
    )

    await store.install(pack, "本地导入")
    entries = await store.list()

    assert len(entries) == 1
    installed = entries[0]
    assert installed["name"] == "我的导演技能"
    assert installed["builtin"] is False
    assert installed["files"] == ["SKILL.md", "references/camera.md"]

    body = await store.read(id=installed["id"], path="references/camera.md")
    assert body["instructions"] == "# camera"


async def test_install_refuses_to_escape_the_skill_directory(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    # 绕过 skill_package 直接构造一个逃逸路径，模拟落盘环节被绕过的情况。
    hostile = SkillPackage(
        name="x",
        description="",
        version="v0",
        files=(SkillFile(path="../../../../tmp/pwned.md", data=b"x"),),
        size=1,
        instructions="x",
        entry="../../../../tmp/pwned.md",
    )

    with pytest.raises(SkillError):
        await store.install(hostile, "本地导入")

    assert not Path("/tmp/pwned.md").exists()


async def test_read_rejects_a_path_outside_the_declared_files(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    pack = skill_package([SkillFile(path="SKILL.md", data=SKILL_MD.encode())])
    await store.install(pack, "本地导入")
    skill_id = (await store.list())[0]["id"]

    with pytest.raises(SkillError, match="没有这个文件"):
        await store.read(id=skill_id, path="other.md")
    with pytest.raises(SkillError, match="路径无效"):
        await store.read(id=skill_id, path="../../secrets.json")


async def test_read_follows_no_symlink_out_of_the_package(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    pack = skill_package(
        [
            SkillFile(path="SKILL.md", data=SKILL_MD.encode()),
            SkillFile(path="link.md", data=b"placeholder"),
        ]
    )
    await store.install(pack, "本地导入")
    skill_id = (await store.list())[0]["id"]
    folder = store.folder(skill_id)
    secret = tmp_path / "secret.txt"
    secret.write_text("top secret", encoding="utf-8")

    link = folder / "link.md"
    link.unlink()
    link.symlink_to(secret)

    with pytest.raises(SkillError, match="包外文件"):
        await store.read(id=skill_id, path="link.md")


async def test_remove_deletes_the_installed_folder(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    await store.install(skill_package([SkillFile(path="SKILL.md", data=SKILL_MD.encode())]), "本地导入")
    skill_id = (await store.list())[0]["id"]
    folder = store.folder(skill_id)

    await store.remove(skill_id)

    assert not folder.exists()
    assert await store.list() == []


async def test_builtin_skill_cannot_be_removed_but_can_be_disabled(tmp_path: Path) -> None:
    builtin = BuiltinSkill(
        name="director-desk", version="v1", instructions="# built-in", references={"references/camera.md": "# cam"}
    )
    store = make_store(tmp_path, builtin=builtin)

    entries = await store.list()
    assert entries[0]["id"] == "builtin"
    assert entries[0]["builtin"] is True
    assert "references/camera.md" in entries[0]["files"]

    with pytest.raises(SkillError, match="内置技能"):
        await store.remove("builtin")

    await store.enable("builtin", False)
    assert (await store.list())[0]["enabled"] is False
    # 停用后模型侧读不到，但面板侧（allow_disabled）仍然读得到。
    with pytest.raises(SkillError, match="已停用"):
        await store.read()
    assert (await store.read(allow_disabled=True))["version"] == "v1"


async def test_tool_rejects_write_shaped_arguments(tmp_path: Path) -> None:
    store = make_store(tmp_path)

    with pytest.raises(SkillError, match="技能查询参数无效"):
        await store.tool({"action": "install"})
    with pytest.raises(SkillError, match="技能查询参数无效"):
        await store.tool({"action": "read", "enabled": "true"})


async def test_known_version_short_circuits_the_instructions(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    pack = skill_package([SkillFile(path="SKILL.md", data=SKILL_MD.encode())])
    await store.install(pack, "本地导入")
    skill_id = (await store.list())[0]["id"]

    first = await store.tool({"action": "read", "id": skill_id})
    again = await store.tool({"action": "read", "id": skill_id, "knownVersion": pack.version})

    assert first["unchanged"] is False and "instructions" in first
    assert again["unchanged"] is True and "instructions" not in again


# ── 文件夹与面板 ────────────────────────────────────────────────────────────


def test_package_from_folder_walks_and_parses_frontmatter(tmp_path: Path) -> None:
    skill_dir = tmp_path / "my-skill"
    (skill_dir / "references").mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(SKILL_MD, encoding="utf-8")
    (skill_dir / "references" / "camera.md").write_text("# camera", encoding="utf-8")
    (skill_dir / "node_modules").mkdir()
    (skill_dir / "node_modules" / "junk.md").write_text("junk", encoding="utf-8")

    pack = package_from_folder(skill_dir)

    assert pack.name == "我的导演技能"
    assert sorted(f.path for f in pack.files) == ["SKILL.md", "references/camera.md"]


def test_package_from_folder_rejects_symlinks(tmp_path: Path) -> None:
    skill_dir = tmp_path / "s"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(SKILL_MD, encoding="utf-8")
    (skill_dir / "link.md").symlink_to(tmp_path / "elsewhere.md")

    with pytest.raises(SkillError, match="符号链接"):
        package_from_folder(skill_dir)


async def test_skill_panel_import_then_reload(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    import base64

    encoded = base64.b64encode(SKILL_MD.encode()).decode()

    result = await handle_skill_request(store, {"action": "import", "files": [{"path": "SKILL.md", "data": encoded}]})
    assert len(result["skills"]) == 1
    skill_id = result["skills"][0]["id"]

    folder = store.folder(skill_id)
    (folder / "SKILL.md").write_text(SKILL_MD + "本地改动\n", encoding="utf-8")
    reloaded = await handle_skill_request(store, {"action": "reload", "id": skill_id})

    assert reloaded["skills"][0]["version"] != result["skills"][0]["version"]
    # 每个修订占一个新目录：旧目录必须整个消失，否则重装会越攒越多。
    assert not folder.exists()
    assert (store.folder(skill_id) / "SKILL.md").exists()


async def test_skill_panel_open_fails_loudly_on_the_web(tmp_path: Path) -> None:
    store = make_store(tmp_path)

    with pytest.raises(SkillError, match="无法打开本机技能目录"):
        await handle_skill_request(store, {"action": "open", "id": "builtin"})


def test_files_from_payload_rejects_non_base64(tmp_path: Path) -> None:
    with pytest.raises(SkillError):
        files_from_payload([{"path": "SKILL.md", "data": "not base64!!"}])


# ── GitHub ──────────────────────────────────────────────────────────────────


def _github_transport(tree: dict, files: dict) -> httpx.MockTransport:
    """模拟 GitHub contents API：目录返回 JSON 列表，文件返回 raw 字节。"""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path.split("/contents/", 1)
        relative = path[1] if len(path) > 1 else ""
        if relative in files:
            return httpx.Response(200, content=files[relative])
        if relative in tree:
            return httpx.Response(200, json=tree[relative])
        return httpx.Response(404)

    return httpx.MockTransport(handler)


async def test_github_package_downloads_and_validates() -> None:
    transport = _github_transport(
        {
            "skills": [
                {"name": "SKILL.md", "type": "file", "size": len(SKILL_MD)},
                {"name": "camera.md", "type": "file", "size": 6},
            ]
        },
        {"skills/SKILL.md": SKILL_MD.encode(), "skills/camera.md": b"# cam\n"},
    )
    async with httpx.AsyncClient(transport=transport) as client:
        pack = await github_package("https://github.com/owner/repo/tree/main/skills", client=client)

    assert pack.name == "我的导演技能"
    assert sorted(f.path for f in pack.files) == ["SKILL.md", "camera.md"]


async def test_github_package_rejects_a_directory_without_skill_md() -> None:
    transport = _github_transport({"": [{"name": "readme.md", "type": "file", "size": 3}]}, {})
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(SkillError, match="没有 SKILL.md"):
            await github_package("https://github.com/owner/repo", client=client)


async def test_github_package_walks_nested_directories() -> None:
    transport = _github_transport(
        {
            "skills": [
                {"name": "SKILL.md", "type": "file", "size": 1},
                {"name": "references", "type": "dir"},
            ],
            "skills/references": [{"name": "camera.md", "type": "file", "size": 1}],
        },
        {"skills/SKILL.md": SKILL_MD.encode(), "skills/references/camera.md": b"# cam"},
    )
    async with httpx.AsyncClient(transport=transport) as client:
        pack = await github_package("https://github.com/owner/repo/tree/main/skills", client=client)

    assert sorted(f.path for f in pack.files) == ["SKILL.md", "references/camera.md"]


@pytest.mark.parametrize(
    "url",
    [
        "http://github.com/o/r/tree/main",
        "https://gitlab.com/o/r/tree/main",
        "https://github.com/o/r/tree/main?x=1",
        "https://user:pw@github.com/o/r",
    ],
)
async def test_github_source_rejects_non_public_urls(url: str) -> None:
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _r: httpx.Response(200))) as client:
        with pytest.raises(SkillError):
            await github_package(url, client=client)


def test_set_builtin_skill_accepts_the_upstream_payload() -> None:
    builtin = set_builtin_skill(
        {
            "name": "director-desk",
            "version": "sha256:x",
            "instructions": "# i",
            "references": {"references/media.md": "# m"},
        }
    )

    assert builtin is not None
    assert builtin.files == ["SKILL.md", "references/media.md"]
    # 无效载荷不清空已有值：一次坏握手不该把内置技能弄没。
    assert set_builtin_skill({"name": ""}) is builtin


async def test_installed_skills_survive_a_restart(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    await store.install(skill_package([SkillFile(path="SKILL.md", data=SKILL_MD.encode())]), "本地导入")
    skill_id = (await store.list())[0]["id"]

    reopened = make_store(tmp_path)

    assert [e["id"] for e in await reopened.list()] == [skill_id]
    assert (await reopened.read(id=skill_id))["version"]