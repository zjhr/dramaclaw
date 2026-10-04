"""外部 MCP 客户端（Hermes / Claude / Codex …）驱动导演台的工具面。

## 为什么是这一层

MCP 客户端与导演台之间隔着三段互不可达的东西：MCP 客户端在**别的进程**里（stdio），
18 个 ``director_*`` 工具在**浏览器 iframe 的渲染进程**里（它们依赖 Three.js 的
``ctx.engine`` 做空间采样），中间还夹着一个模型不可见的 HTTP 端点层。于是形态只能是
「协议适配」：本模块只负责

1. **找到目标节点** —— 外部客户端不知道画布 nodeId，这里解析；
2. **校验工具名** —— 只放行该节点 iframe 握手时自报的 ``director_*`` 工具，
   不给「借这个工具打任意后端路径」留缝；
3. **把调用交给传输层** —— :mod:`novelvideo.director_desk.tool_transport` 派发到
   iframe，由那里的 ``toolService`` 真正执行。

**这里一行工具逻辑都没有。** 与上游 AI 面板（T007）走的是同一个
``tool_transport``、同一套 ``toolService``，两条 agent 通路不是两套实现。

## 无活跃会话时的语义

照搬上游 ``ai-conversation.cjs:7-13``，**立刻**分类失败而不是静默超时：

- 会话不存在（弹窗没开 / 已关）→ ``execution: 'not-started'``，调用根本没派发；
- 已派发但结果没回来（超时 / 关窗）→ ``execution: 'unknown'``，提示先读状态再决定，
  不要直接重放写入。

超时的那个分类由传输层自己产出（见 ``tool_transport.TOOL_CALL_TIMEOUT_S``），本模块
原样透传，不做二次包装。

## 节点登记表的来处

:func:`register_node` 由 :mod:`novelvideo.director_desk.routes` 的 ``/ai/session`` 调用，
和传输层的 ``open_session`` 在**同一个端点、同一次请求**里登记，两张表因此不会漂移。
不直接去读传输层或 ai_service 的私有会话表：那张表的键就是节点 id，但那是它们的内部
表示，不是本模块的契约。
"""

from __future__ import annotations

import importlib.metadata
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from novelvideo.director_desk.tool_transport import (
    NoActiveSessionError,
    TransportError,
    get_tool_transport,
)

__all__ = [
    "MCP_TOOL_NAME",
    "DirectorDeskMcpError",
    "call_director_desk_tool",
    "clear_nodes",
    "list_active_nodes",
    "mcp_client_config",
    "mcp_endpoint_state",
    "register_node",
    "unregister_node",
    "update_state",
]

#: 插件侧注册的工具名（``.hermes/plugins/dramaclaw`` 与 stdio MCP server 共用这一个）。
MCP_TOOL_NAME = "director_desk_call"

#: 传输层把「工具自己失败」与「传输失败」合成同一种回话形状，两者的区别只在
#: ``execution`` 字段上。调用方（外部 agent）据此决定能不能安全重试。
_MCP_STDIO_MODULE = "novelvideo.chat.dramaclaw_mcp"

#: 上游 ``ai-mcp.ts`` 的客户端下拉项。四者共用同一份 stdio 配置，只是落点不同。
_MCP_CLIENTS = frozenset({"http", "claude-code", "claude-desktop", "stdio"})

#: 工具名前缀。这条路由**不接受**任意 path，也不接受任意工具名：能落到这里的名字必须
#: 先长得像导演台工具，再由该节点 iframe 自报的清单复核一遍。前缀与白名单是两件事 ——
#: 前缀挡住「根本不是导演台的东西」，白名单挡住「上游这一版没有它」。
_DIRECTOR_TOOL_PREFIX = "director_"


class DirectorDeskMcpError(ValueError):
    """请求本身不合法（工具名不在白名单、节点不明确）。

    这是 400 而不是 ``execution`` 分类：调用方**还没派发**任何东西，错误在参数校验
    阶段就该暴露，混进 ``execution: 'unknown'`` 里会让模型以为「可能已经写进去了」。
    """


@dataclass(frozen=True)
class RegisteredNode:
    """一个已握手的导演台节点。``tool_names`` 是 iframe 自报的工具清单。"""

    node_id: str
    tool_names: frozenset[str]


_NODES: dict[str, RegisteredNode] = {}


# ── 节点登记表 ───────────────────────────────────────────────────────────────


def register_node(node_id: str, tool_names: Any) -> RegisteredNode:
    """登记（或顶替）一个节点的 MCP 可见工具面。

    工具名清单来自 iframe 的 ``ai.describe``，**不在 Python 侧抄一份**：那是 18 个
    工具、上游随时会改的契约，抄一份只会在某次升级后静默漂移。
    """
    key = str(node_id or "").strip()
    if not key:
        raise DirectorDeskMcpError("导演台会话缺少 nodeId")
    names = {
        str(item).strip()
        for item in (tool_names or ())
        if isinstance(item, str) and item.strip()
    }
    node = RegisteredNode(node_id=key, tool_names=frozenset(names))
    _NODES[key] = node
    return node


def unregister_node(node_id: str) -> bool:
    """注销节点。关窗时调用，让后续调用立刻拿到 ``not-started`` 而不是等超时。"""
    return _NODES.pop(str(node_id or "").strip(), None) is not None


def clear_nodes() -> None:
    """清空登记表。测试与后端重启语义用。"""
    _NODES.clear()


def list_active_nodes() -> list[str]:
    """当前登记在册、且传输层确有会话的节点 id（排序，保证输出稳定）。"""
    transport = get_tool_transport()
    return sorted(key for key in _NODES if transport.is_active(key))


# ── 调用派发 ────────────────────────────────────────────────────────────────


def _resolve_node(node_id: str) -> RegisteredNode | None:
    """解析目标节点。

    省略 ``node_id`` 时按「唯一活跃节点」解析 —— 绝大多数时候用户只开一扇导演台窗口，
    让外部 agent 去猜画布 UUID 是没有必要的负担。**不唯一就报错并列出候选**：猜错节点
    等于把 A 导演台的写入落到 B 上，这比失败糟糕得多。
    """
    key = str(node_id or "").strip()
    if key:
        return _NODES.get(key)
    active = list_active_nodes()
    if len(active) == 1:
        return _NODES[active[0]]
    if not active:
        return None
    raise DirectorDeskMcpError(
        "同时有多个导演台窗口在打开，请显式指定 nodeId。候选："
        + ", ".join(active)
    )


def _normalize_args(args: Any) -> dict[str, Any]:
    if args is None:
        return {}
    if not isinstance(args, dict):
        raise DirectorDeskMcpError("args 必须是对象")
    return args


async def call_director_desk_tool(
    node_id: str,
    name: str,
    args: Any = None,
    *,
    transport: Any = None,
) -> dict[str, Any]:
    """把一次外部 MCP 调用派发到 iframe 里的 ``toolService``。

    返回值就是 ``{ok, revision?, data?, execution?, error?}``。**不抛裸异常**：
    ``not-started`` / ``unknown`` 是要给模型看的分类，抛出去就只剩一句异常文本，
    模型据此重放写入的概率反而更高。
    """
    tool = str(name or "").strip()
    if not tool:
        raise DirectorDeskMcpError(f"{MCP_TOOL_NAME} 缺少工具名（name）")
    # 形状检查放在解析节点**之前**：这不是「先开个窗口再说」的问题，而是调用方把参数
    # 写错了。报成 not-started 会让人去开窗口重试，然后撞上同一个错。
    if not tool.startswith(_DIRECTOR_TOOL_PREFIX):
        raise DirectorDeskMcpError(
            f"{tool} 不是导演台工具；这条路由只接受 {_DIRECTOR_TOOL_PREFIX}* 工具名"
        )
    payload = _normalize_args(args)

    node = _resolve_node(node_id)
    if node is None:
        return _not_started(
            str(node_id or "").strip(),
            "导演台没有活跃会话，请在画布上打开该导演台节点",
        )
    if tool not in node.tool_names:
        raise DirectorDeskMcpError(
            f"{tool} 不是导演台 {node.node_id} 登记的工具。"
            "可用的工具只有该节点 iframe 自报的那批 director_* 工具。"
        )

    layer = transport if transport is not None else get_tool_transport()
    try:
        return await layer.call(node.node_id, tool, payload)
    except NoActiveSessionError as exc:
        return _not_started(node.node_id, str(exc))
    except TransportError as exc:
        return {"ok": False, "execution": "unknown", "error": str(exc)}


def _not_started(node_id: str, reason: str) -> dict[str, Any]:
    return {
        "ok": False,
        "execution": "not-started",
        "error": reason
        + (f"（nodeId={node_id}）" if node_id else "")
        + "；调用没有派发出去，可以安全重试。",
    }


# ── MCP 面板状态 ─────────────────────────────────────────────────────────────


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def app_version() -> str:
    """后端版本号。取不到时如实返回空串，不拿前端占位版本糊弄。"""
    try:
        return importlib.metadata.version("supertale-ce")
    except Exception:  # noqa: BLE001 - 源码树运行 / 包未安装
        return ""


def _stdio_command() -> dict[str, Any]:
    return {
        "command": sys.executable,
        "args": ["-m", _MCP_STDIO_MODULE],
        "cwd": str(_repo_root()),
    }


def mcp_endpoint_state(node_id: str) -> dict[str, Any]:
    """AI 面板 ``#ai-mcp`` 需要的状态。

    ``enabled`` 的含义是「**这个节点**现在能被外部 MCP 客户端驱动」，也就是后端有活跃
    会话。它不是「上游那台本机 HTTP 服务在不在跑」—— DramaClaw 侧根本不存在那台服务，
    MCP 是 stdio，由客户端自己拉起。局域网通道同理，网页部署没有那个概念：如实报关，
    不要给一个填上去也连不通的地址。
    """
    key = str(node_id or "").strip()
    enabled = bool(key) and key in _NODES and get_tool_transport().is_active(key)
    return {
        "enabled": enabled,
        "url": f"stdio · {Path(sys.executable).name} -m {_MCP_STDIO_MODULE}" if enabled else "",
        "lanEnabled": False,
        "lanUrl": "",
        "lanIp": "",
        "lanPort": 0,
    }


def mcp_client_config(client: str, api_url: str = "") -> str:
    """给 MCP 客户端复制用的连接配置（JSON 文本）。

    传输只有 stdio 一种，所以四种客户端（http / claude-code / claude-desktop / stdio）
    的差别只是**这段 JSON 贴到哪儿**，内容一致 —— 上游 ``ai-mcp.ts`` 的
    ``descriptions`` 也是这么写的。``DRAMACLAW_AGENT_TOKEN`` 留空值而不是省略：客户端
    拿到配置就该看得见要填什么，省略键名会让人以为不用鉴权。
    """
    which = str(client or "stdio").strip() or "stdio"
    if which not in _MCP_CLIENTS:
        raise DirectorDeskMcpError(f"未知的 MCP 客户端类型: {client}")
    server = {
        **_stdio_command(),
        "env": {
            "DRAMACLAW_API_URL": str(api_url or "").strip(),
            "DRAMACLAW_AGENT_TOKEN": "",
        },
    }
    return json.dumps({"mcpServers": {"dramaclaw": server}}, ensure_ascii=False, indent=2)


def update_state() -> dict[str, Any]:
    """上游 ``update-panel.ts`` 需要的 ``UpdateState``。

    DramaClaw 是自托管部署：没有 Electron 自动更新器，也没有「发现新版本就下载」的
    下载页。如实报 ``mode: 'unsupported'``，面板会渲染「当前平台请从下载页获取新版」
    而不是每次打开设置都弹一条错误 —— 前者是事实，后者是噪音。字段一个不少，省得面板
    在 ``next.config.url`` 上踩空。
    """
    version = app_version()
    return {
        "currentVersion": version or "unknown",
        "mode": "unsupported",
        "phase": "current",
        "version": "",
        "notes": "",
        "percent": 0,
        "message": "DramaClaw 是自托管部署，软件更新由部署方负责。",
        "checkedAt": "",
        "source": "",
        "canDownload": False,
        "config": {"url": "", "automatic": False, "source": "auto"},
    }