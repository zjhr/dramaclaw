from __future__ import annotations

import csv
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

NGINX_TEMPLATE = REPO_ROOT / "frontend" / "docker" / "nginx.conf.template"
VITE_CONFIG = REPO_ROOT / "frontend" / "vite.config.ts"
VENDOR_INDEX_HTML = REPO_ROOT / "frontend" / "vendor" / "director-desk" / "index.html"
VENDOR_HOST_BRIDGE = REPO_ROOT / "frontend" / "vendor" / "director-desk" / "src" / "host-bridge.ts"
PUBLIC_DIR = REPO_ROOT / "frontend" / "public" / "director-desk-v2"
LICENSE_INVENTORY = REPO_ROOT / "license-inventory.csv"
HOST_BRIDGE_PROTOCOL = (
    REPO_ROOT / "frontend" / "src" / "features" / "canvas" / "nodes" / "directorDeskBridge.ts"
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def nginx_blocks(text: str) -> dict[str, str]:
    """按 `location <specifier> {` 取出每个 location 块的原文，键是完整 specifier。

    配平大括号时跳过双引号内的内容：`location ~ "^/assets/...{1,64}/logo$"` 里的
    `{1,64}` 不是块开始，把它当结构会一路吞到文件末尾。
    """
    blocks: dict[str, str] = {}
    pattern = re.compile(r"^\s*location\s+((?:=\s+|\^~\s+|~\*?\s+)?\S+)\s*\{", re.MULTILINE)
    for match in pattern.finditer(text):
        depth = 1
        index = match.end()
        in_quotes = False
        while index < len(text) and depth:
            char = text[index]
            if char == '"':
                in_quotes = not in_quotes
            elif not in_quotes and char == "{":
                depth += 1
            elif not in_quotes and char == "}":
                depth -= 1
            index += 1
        blocks[match.group(1).strip('"')] = text[match.start() : index]
    return blocks


def test_vendored_dir_exists_with_base_relative_vite_config() -> None:
    assert (REPO_ROOT / "frontend" / "vendor" / "director-desk" / "package.json").is_file()
    assert (REPO_ROOT / "frontend" / "vendor" / "director-desk" / "LICENSE").is_file()

    vite_config = read(REPO_ROOT / "frontend" / "vendor" / "director-desk" / "vite.config.ts")

    # 绝对 base 会让产物引用宿主自己的 /assets/，nginx 会用宿主那份去取 → 静默白屏。
    assert re.search(r"base:\s*['\"]\./['\"]", vite_config)
    assert "base: '/'" not in vite_config


def test_vendor_index_html_loads_host_bridge_before_main() -> None:
    index_html = read(VENDOR_INDEX_HTML)

    bridge_at = index_html.find("src/host-bridge.ts")
    main_at = index_html.find("src/main.ts")

    # main.ts:318 在顶层注册 onTool；桥晚一步装上，18 个 director_* 工具全部静默失联。
    assert bridge_at != -1
    assert main_at != -1
    assert bridge_at < main_at
    # 外链 module script 而不是内联 classic script：内联会被宿主 CSP 的 script-src 'self' 拦下。
    assert 'type="module" src="/src/host-bridge.ts"' in index_html


def test_host_bridge_ai_and_mcp_capabilities_are_real_implementations() -> None:
    bridge = read(VENDOR_HOST_BRIDGE)

    def declaration(capability: str) -> str:
        match = re.search(rf"^[ \t]*{capability}:[ \t]*(.+)$", bridge, re.MULTILINE)
        assert match, f"host-bridge 未声明 {capability}"
        return match.group(1)

    # AI 通道：全部转给宿主，模型在后端跑（T007）。
    ai_channel = {
        "profiles": "agentCall('profiles')",
        "conversation": "agentCall('conversation')",
        "newConversation": "agentCall('newConversation')",
        "configure": "agentCall('configure'",
        "test": "agentCall('test'",
        "stop": "agentCall('stop'",
    }
    # MCP 通道：请求宿主真实状态与连接配置（T008）。
    mcp_channel = {
        "run": "requestRun(",
        "skills": "requestSkills(",
        "mcp": "requestMcpState(",
        "mcpLan": "requestMcpLan(",
        "copyMcp": "requestCopyMcp(",
        "resetMcp": "requestResetMcp(",
        "update": "requestUpdate(",
    }

    # 这些能力在 T003 时是显式失败占位；T007/T008 已接成真实现。这里钉死
    # 「不再是 unavailable 占位」，防回退成空壳——空壳比不装桥更糟：
    # 无桥时 ai-panel.ts:82 会把面板置灰，空壳则变成点了没反应。
    for capability, expected in {**ai_channel, **mcp_channel}.items():
        line = declaration(capability)
        assert expected in line, capability
        assert "unavailable(" not in line, capability

    # 工具层仍挂在 onTool 上：取最后一个注册回调去调真实 toolService。
    assert "onTool" in bridge
    assert re.search(r"toolCallbacks\[toolCallbacks\.length - 1\]", bridge)


def test_host_bridge_files_declares_explicit_failure_for_browser_host_capabilities() -> None:
    bridge = read(VENDOR_HOST_BRIDGE)

    # 网页宿主拿不到本机路径：`locations` / `choose` / 未知文件动作必须显式失败，
    # 不能假装成功。但 `save-project` / `save-export` 是真的：宿主把字节存进项目
    # 资产（工程）或触发下载（导出）。
    assert re.search(
        r"return unavailable\(action === 'locations' \|\| action === 'choose'",
        bridge,
    )
    assert "save-project" in bridge
    assert "save-export" in bridge

    # 统一失败文案仍在：只剩文件目录这一类真正未接的能力在用。
    assert "将在下一阶段接入" in bridge


def test_nginx_serves_director_desk_v2_with_framable_policy() -> None:
    blocks = nginx_blocks(read(NGINX_TEMPLATE))

    assert "= /director-desk-v2" in blocks, sorted(blocks)
    assert "^~ /director-desk-v2/" in blocks, sorted(blocks)
    root_block = blocks["^~ /director-desk-v2/"]
    redirect_block = blocks["= /director-desk-v2"]

    # 相对 base 的产物只在 URL 带尾斜杠时解析得对。
    assert "return 301 /director-desk-v2/;" in redirect_block

    # frame-ancestors 'none' / X-Frame-Options DENY 会连父窗口一起拒掉：
    # dev 下没有这些头所以一切正常，prod 里节点白屏。
    assert "frame-ancestors 'self'" in root_block
    assert "frame-ancestors 'none'" not in root_block
    assert 'X-Frame-Options "SAMEORIGIN"' in root_block
    assert 'X-Frame-Options "DENY"' not in root_block

    # three.js worker 与视频导出都走 createObjectURL。
    assert "worker-src 'self' blob:" in root_block
    assert "media-src 'self' data: blob:" in root_block
    # 外链 module script 的桥不能在 CSP 下需要 unsafe-inline。
    assert "script-src 'self'" in root_block
    assert "unsafe-inline" not in root_block.split("script-src", 1)[1].split(";", 1)[0]
    assert "unsafe-eval" not in root_block


def test_nginx_hashed_subapp_assets_are_immutable_and_never_fall_back_to_spa() -> None:
    blocks = nginx_blocks(read(NGINX_TEMPLATE))

    assets_block = blocks["^~ /director-desk-v2/assets/"]

    assert "try_files $uri =404;" in assets_block
    assert "immutable" in assets_block


def test_site_wide_csp_still_refuses_framing() -> None:
    """新增的子应用段不能顺手把宿主自己的 frame-ancestors 'none' 放松掉。"""
    blocks = nginx_blocks(read(NGINX_TEMPLATE))

    root_block = blocks["/"]

    assert "frame-ancestors 'none'" in root_block
    assert 'X-Frame-Options "DENY"' in root_block


def test_vite_dev_server_serves_the_v2_subpath_and_drops_the_deleted_desk() -> None:
    config = read(VITE_CONFIG)
    listed = re.search(r'const vendoredDesks = \[([^\]]*)\]', config)

    assert listed, "vendoredDesks 列表找不到了"
    entries = set(re.findall(r'"([^"]+)"', listed.group(1)))

    assert "director-desk-v2" in entries
    # 上一轮清理漏了这处死引用：'director-desk' 目录早已不存在。
    assert "director-desk" not in entries
    # MONOFORM 已随导演台 v2 替换整体下线（vendor + 产物 + nginx 段 + 许可条目
    # 全部移除），vendoredDesks 只剩 v2 一个子应用。留下它会让 dev server 继续
    # 为一个不存在的目录重写 URL。
    assert "monoform-desk" not in entries
    assert entries == {"director-desk-v2"}


def test_host_protocol_bridge_declares_the_four_v2_actions() -> None:
    bridge = read(HOST_BRIDGE_PROTOCOL)

    for action in ("tool.call", "project.save", "project.load", "skills.sync"):
        assert f"'{action}'" in bridge, action
    # 复用既有通道，不新开协议。
    assert "storyai:director-desk:request" in bridge
    assert "storyai:director-desk:response" in bridge


def test_license_inventory_covers_every_published_v2_artifact() -> None:
    assert PUBLIC_DIR.is_dir(), "构建产物没有同步到 frontend/public/director-desk-v2/"

    published = {
        str(path.relative_to(REPO_ROOT)).replace("\\", "/")
        for path in PUBLIC_DIR.rglob("*")
        if path.is_file()
    }
    assert published, "产物目录是空的"

    with LICENSE_INVENTORY.open(newline="", encoding="utf-8") as handle:
        inventory = {row["path"]: row for row in csv.DictReader(handle)}

    missing = sorted(published - set(inventory))
    assert not missing, f"license-inventory.csv 漏了 {len(missing)} 条：{missing[:5]}"

    for path in sorted(published):
        row = inventory[path]
        assert row["license_expression"], path
        assert row["evidence"], path
        assert "director-desk" in row["evidence"], path


def test_published_index_html_uses_relative_asset_urls() -> None:
    """绝对 /assets/ 或 /favicon 引用会被宿主 location 吞掉，dev 正常、prod 白屏。"""
    index_html = read(PUBLIC_DIR / "index.html")

    assert 'src="./assets/' in index_html
    assert not re.search(r'(?:src|href)="/(?:assets|favicon)', index_html)
    assert "director-desk" not in index_html.split("<script", 1)[0]


def test_published_bundle_contains_the_host_bridge_shim() -> None:
    assets = sorted((PUBLIC_DIR / "assets").glob("*.js"))

    assert assets, "产物里没有 js chunk"
    assert any("directorDesktop" in path.read_text(encoding="utf-8", errors="ignore") for path in assets)