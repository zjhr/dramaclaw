# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""外部 MCP 客户端驱动导演台：`director_desk_call` 的工具面与安全边界。

这块地基本身在 T007 的传输层测试里（配对、超时、无会话）。这里只钉 **T008 新增的
那一层**：节点解析、工具名白名单、`not-started` / `unknown` 的分类，以及它在
`.hermes/plugins/dramaclaw` 里被 scope 白名单放行的方式。

「工具真跑在 iframe 里」这件事在这里**测不到**（那需要一扇真的浏览器窗口），所以下面
只断言到传输层派发为止 —— 派发出去的 `request_id` 能被 poll 走，才算这层没接错。
"""

from __future__ import annotations

import asyncio
import json

import pytest

from novelvideo.chat import dramaclaw_mcp
from novelvideo.director_desk import mcp_tools
from novelvideo.director_desk.mcp_tools import (
    DirectorDeskMcpError,
    call_director_desk_tool,
    mcp_client_config,
    mcp_endpoint_state,
    register_node,
    unregister_node,
)
from novelvideo.director_desk.routes import (
    SessionClose,
    SessionOpen,
    close_session,
    open_session,
)
from novelvideo.director_desk.tool_transport import get_tool_transport

plugin = dramaclaw_mcp.PLUGIN

CONTRACT = {
    "definitions": [
        {"name": "director_read"},
        {"name": "director_apply"},
    ],
    "discussion": [{"name": "director_read"}],
}


@pytest.fixture(autouse=True)
def clean_state():
    """登记表与传输层都是进程级单例，测试之间必须清干净。"""
    mcp_tools.clear_nodes()
    yield
    mcp_tools.clear_nodes()


def _open(node_id: str = "node-a") -> str:
    """走真实的 ``/ai/session`` 端点：登记表与传输层会话必须同一个入口长出来。"""
    return open_session(SessionOpen(nodeId=node_id, contract=CONTRACT))["sessionId"]


# ── 注册与 scope 白名单 ─────────────────────────────────────────────────────


def test_director_desk_call_is_registered_in_the_plugin_toolset() -> None:
    names = [name for name, _schema, _handler in plugin.TOOLS]
    assert "director_desk_call" in names
    assert "director_desk_call" in plugin._DIRECTOR_DESK_TOOLS


def test_director_desk_call_is_exposed_by_the_stdio_mcp_server() -> None:
    """Hermes 与 Claude/Codex 走的是同一个 TOOLS 索引，不能只在一边可见。"""
    assert "director_desk_call" in dramaclaw_mcp.TOOLS
    schema = dramaclaw_mcp.TOOLS["director_desk_call"][0]
    assert schema["parameters"]["required"] == ["name"]


def test_director_desk_scope_registers_the_new_tool(monkeypatch) -> None:
    monkeypatch.setenv("DRAMACLAW_CHAT_SCOPE", "directorDesk")
    assert plugin._allowed_tool_names() is plugin._DIRECTOR_DESK_TOOLS

    registered: list[str] = []

    class Ctx:
        def register_tool(self, **kwargs):
            registered.append(kwargs["name"])

    plugin.register(Ctx())

    assert "director_desk_call" in registered
    # 防穿透没被顺手拆掉：能改项目资产的工具仍然不注册。
    assert "dramaclaw_generate_script" not in registered
    assert "dramaclaw_post" in registered


def test_other_scopes_keep_the_full_toolset(monkeypatch) -> None:
    for scope in ("", "project", "home"):
        monkeypatch.setenv("DRAMACLAW_CHAT_SCOPE", scope)
        assert plugin._allowed_tool_names() is None

    monkeypatch.delenv("DRAMACLAW_CHAT_SCOPE", raising=False)
    registered: list[str] = []

    class Ctx:
        def register_tool(self, **kwargs):
            registered.append(kwargs["name"])

    plugin.register(Ctx())

    # 非导演台作用域下新工具照样注册 —— 项目助手与外部 MCP 客户端都靠它。
    assert "director_desk_call" in registered
    assert "dramaclaw_generate_script" in registered


# ── 写路径守卫：白名单不放宽，也不塌成前缀通配 ──────────────────────────────


def test_director_desk_scope_allows_only_the_two_node_scoped_paths(monkeypatch) -> None:
    monkeypatch.setenv("DRAMACLAW_CHAT_SCOPE", "directorDesk")

    plugin._guard_chat_scope_write("POST", "/api/v1/projects/p/freezone/director-desk-panorama")
    plugin._guard_chat_scope_write("POST", "/api/v1/director-desk/mcp/tool")

    for path in (
        "/api/v1/projects/p/scripts/generate",
        "/api/v1/projects/p/episodes/1/compose",
        "/api/v1/director-desk/ai/run",  # 同前缀，但不是工具面
        "/api/v1/director-desk/mcp/tool/extra",
        "/api/v1/director-desk/mcp",
    ):
        with pytest.raises(PermissionError):
            plugin._guard_chat_scope_write("POST", path)

    # 只读路由不受影响。
    plugin._guard_chat_scope_write("GET", "/api/v1/projects/p/episodes/1/script")


def test_plugin_handler_cannot_be_redirected_to_another_path(monkeypatch) -> None:
    """`args` 里的任何字段都不能改写目标路径。"""
    monkeypatch.setenv("DRAMACLAW_CHAT_SCOPE", "directorDesk")
    seen: list[tuple] = []

    def fake_request(method, path, **kwargs):
        seen.append((method, path, kwargs.get("body")))
        return {"ok": True, "data": {}}

    monkeypatch.setattr(plugin, "_request", fake_request)
    plugin._handle_director_desk_call(
        {
            "name": "director_read",
            "path": "/api/v1/projects/p/scripts/generate",
            "args": {"path": "/etc/passwd"},
        }
    )

    method, path, body = seen[0]
    assert (method, path) == ("POST", "/api/v1/director-desk/mcp/tool")
    assert body == {"nodeId": "", "name": "director_read", "args": {"path": "/etc/passwd"}}


def test_plugin_handler_rejects_non_director_tool_names(monkeypatch) -> None:
    monkeypatch.setattr(plugin, "_request", lambda *a, **k: pytest.fail("不该发出请求"))
    payload = json.loads(plugin._handle_director_desk_call({"name": "dramaclaw_post"}))
    assert payload["ok"] is False
    assert "not a director desk tool" in payload["error"]


def test_plugin_handler_uses_a_timeout_above_the_transport_one() -> None:
    """先掐 HTTP 的话，模型认不出「结果未知」，就会重放写入。"""
    from novelvideo.director_desk.tool_transport import TOOL_CALL_TIMEOUT_S

    assert plugin.DIRECTOR_DESK_TOOL_HTTP_TIMEOUT_SECONDS > TOOL_CALL_TIMEOUT_S


# ── 无活跃会话：立刻失败，不静默超时 ─────────────────────────────────────────


async def test_call_without_open_node_reports_not_started() -> None:
    result = await call_director_desk_tool("node-missing", "director_read", {})

    assert result["ok"] is False
    assert result["execution"] == "not-started"
    assert "可以安全重试" in result["error"]
    assert get_tool_transport().pending_count() == 0


async def test_closed_node_reports_not_started_without_waiting() -> None:
    session_id = _open()
    close_session(SessionClose(nodeId="node-a", sessionId=session_id))

    task = asyncio.create_task(call_director_desk_tool("node-a", "director_read", {}))
    result = await asyncio.wait_for(task, timeout=1.0)

    assert result["execution"] == "not-started"


async def test_timeout_reports_unknown_not_not_started() -> None:
    """已派发但结果没回来 —— 与 not-started 分开，否则模型会安全地重放写入。"""
    _open()
    transport = get_tool_transport()
    original = transport._tool_timeout
    transport._tool_timeout = 0.05
    try:
        result = await call_director_desk_tool("node-a", "director_apply", {"operations": []})
    finally:
        transport._tool_timeout = original

    assert result["ok"] is False
    assert result["execution"] == "unknown"
    assert "不要直接重复写入" in result["error"]


async def test_window_closed_mid_flight_reports_unknown() -> None:
    session_id = _open()
    task = asyncio.create_task(call_director_desk_tool("node-a", "director_apply", {}))
    await asyncio.sleep(0)
    # 让画布把调用取走（模拟 iframe 已接到），再关窗。
    await get_tool_transport().poll("node-a", session_id, wait=0.1)
    close_session(SessionClose(nodeId="node-a"))

    result = await asyncio.wait_for(task, timeout=1.0)
    assert result["execution"] == "unknown"


# ── 工具名白名单：不许借这个工具打任意后端路径 ───────────────────────────────


async def test_foreign_tool_name_is_rejected_even_without_a_session() -> None:
    """参数形状问题不该报成 not-started —— 那会让人去开窗口重试，然后撞上同一个错。"""
    with pytest.raises(DirectorDeskMcpError):
        await call_director_desk_tool("node-a", "dramaclaw_generate_script", {})


async def test_unknown_tool_name_is_rejected_before_dispatch() -> None:
    """长得像导演台工具，但这一版上游没报它 —— 白名单说了算。"""
    _open()

    with pytest.raises(DirectorDeskMcpError) as caught:
        await call_director_desk_tool("node-a", "director_scan", {})

    assert "不是导演台" in str(caught.value)
    assert get_tool_transport().pending_count() == 0


async def test_tool_names_come_from_the_iframe_contract_not_a_python_copy() -> None:
    """白名单随该节点自报的清单走：上游少报一个，这里就立刻少认一个。"""
    session_id = open_session(
        SessionOpen(
            nodeId="node-b",
            contract={"definitions": [{"name": "director_read"}], "discussion": []},
        )
    )["sessionId"]

    task = asyncio.create_task(call_director_desk_tool("node-b", "director_read", {}))
    polled = await get_tool_transport().poll("node-b", session_id, wait=1.0)
    get_tool_transport().submit_result(
        "node-b", polled["calls"][0]["request_id"], {"ok": True, "data": {}}
    )
    assert (await asyncio.wait_for(task, timeout=1.0))["ok"] is True

    with pytest.raises(DirectorDeskMcpError):
        await call_director_desk_tool("node-b", "director_apply", {})


# ── 节点解析 ────────────────────────────────────────────────────────────────


async def test_single_open_node_resolves_without_node_id() -> None:
    session_id = _open()

    task = asyncio.create_task(call_director_desk_tool("", "director_read", {}))
    polled = await get_tool_transport().poll("node-a", session_id, wait=1.0)
    assert polled["calls"][0]["name"] == "director_read"
    get_tool_transport().submit_result("node-a", polled["calls"][0]["request_id"], {"ok": True})

    assert (await task)["ok"] is True


async def test_several_open_nodes_refuse_to_guess() -> None:
    """猜错节点等于把 A 导演台的写入落到 B 上。"""
    _open("node-a")
    _open("node-b")

    with pytest.raises(DirectorDeskMcpError) as caught:
        await call_director_desk_tool("", "director_read", {})

    assert "node-a" in str(caught.value) and "node-b" in str(caught.value)


async def test_call_dispatches_with_node_name_and_args() -> None:
    session_id = _open()
    task = asyncio.create_task(
        call_director_desk_tool("node-a", "director_apply", {"operations": [{"operation": "add"}]})
    )
    polled = await get_tool_transport().poll("node-a", session_id, wait=1.0)

    call = polled["calls"][0]
    assert call["name"] == "director_apply"
    assert call["args"] == {"operations": [{"operation": "add"}]}
    get_tool_transport().submit_result(
        "node-a",
        call["request_id"],
        {"ok": True, "revision": 12, "data": {"summary": "ok"}},
    )

    assert await task == {"ok": True, "revision": 12, "data": {"summary": "ok"}}


async def test_args_must_be_an_object() -> None:
    _open()
    with pytest.raises(DirectorDeskMcpError):
        await call_director_desk_tool("node-a", "director_read", ["not", "a", "dict"])


# ── HTTP 契约：状态码必须能把「参数错」与「结果未知」分开 ─────────────────────


@pytest.fixture
async def client():
    """走真实路由的 ASGI 客户端。

    必须与测试共用**同一个事件循环**：传输层的在途调用是 ``get_running_loop()`` 上建的
    future，跨循环 ``set_result`` 不会唤醒等待方，用同步 ``TestClient`` 测就会永远超时。
    """
    import httpx
    from fastapi import FastAPI

    from novelvideo.director_desk.routes import router

    app = FastAPI()
    app.include_router(router, prefix="/api/v1/director-desk")
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://desk") as http:
        yield http


async def test_endpoint_returns_200_for_not_started(client) -> None:
    """失败分类要原样喂回模型；套上 HTTP 错误码只会让插件侧把它压成一行异常文本。"""
    response = await client.post(
        "/api/v1/director-desk/mcp/tool", json={"nodeId": "node-a", "name": "director_read"}
    )

    assert response.status_code == 200
    assert response.json()["execution"] == "not-started"


async def test_endpoint_rejects_a_foreign_tool_name_with_400(client) -> None:
    response = await client.post(
        "/api/v1/director-desk/mcp/tool", json={"nodeId": "node-a", "name": "evil"}
    )

    assert response.status_code == 400
    assert "director_" in response.json()["detail"]


async def test_endpoint_round_trips_through_the_router(client) -> None:
    """后端派发 → 画布 poll 取走 → 回填 → MCP 拿到 {ok, revision, data}。"""
    session_id = _open()
    body = {"nodeId": "node-a", "name": "director_apply", "args": {"operations": []}}
    task = asyncio.create_task(client.post("/api/v1/director-desk/mcp/tool", json=body))

    polled = await get_tool_transport().poll("node-a", session_id, wait=2.0)
    assert polled["calls"][0]["name"] == "director_apply"

    await client.post(
        "/api/v1/director-desk/ai/tool-result",
        json={
            "nodeId": "node-a",
            "requestId": polled["calls"][0]["request_id"],
            "result": {"ok": True, "revision": 7, "data": {"summary": "ok"}},
        },
    )
    response = await asyncio.wait_for(task, timeout=2.0)

    assert response.status_code == 200
    assert response.json() == {"ok": True, "revision": 7, "data": {"summary": "ok"}}


async def test_panel_endpoints_answer_the_ai_mcp_section(client) -> None:
    """`ai-panel.ts:104` 把 profiles() 与 mcp() 放在同一个 Promise.all 里，任一失败都会
    让渠道列表永不刷新，所以 mcp 无参时必须是 200 + enabled。"""
    session_id = _open()

    state = await client.post("/api/v1/director-desk/ai/mcp", json={"nodeId": "node-a"})
    assert state.status_code == 200
    assert state.json()["mcp"]["enabled"] is True

    config = await client.post(
        "/api/v1/director-desk/ai/mcp/config",
        json={"client": "claude-code", "apiUrl": "http://127.0.0.1:8000"},
    )
    assert json.loads(config.json()["config"]["text"])["mcpServers"]["dramaclaw"]["args"] == [
        "-m",
        "novelvideo.chat.dramaclaw_mcp",
    ]

    update = await client.post("/api/v1/director-desk/ai/update", json={})
    # `update-panel.ts` 直接读 next.config.url，字段少一个就会踩空。
    assert set(update.json()["update"]) >= {"currentVersion", "mode", "phase", "config"}
    assert update.json()["update"]["mode"] == "unsupported"

    await client.post(
        "/api/v1/director-desk/ai/session/close",
        json={"nodeId": "node-a", "sessionId": session_id},
    )
    closed = await client.post("/api/v1/director-desk/ai/mcp", json={"nodeId": "node-a"})
    assert closed.json()["mcp"]["enabled"] is False


# ── 面板的 MCP 状态 ─────────────────────────────────────────────────────────


def test_mcp_state_is_enabled_only_for_an_open_node() -> None:
    assert mcp_endpoint_state("node-a") == {
        "enabled": False,
        "url": "",
        "lanEnabled": False,
        "lanUrl": "",
        "lanIp": "",
        "lanPort": 0,
    }

    _open()
    state = mcp_endpoint_state("node-a")
    assert state["enabled"] is True
    assert "stdio" in state["url"]


def test_mcp_state_drops_when_the_window_closes() -> None:
    session_id = _open()
    close_session(SessionClose(nodeId="node-a", sessionId=session_id))

    assert mcp_endpoint_state("node-a")["enabled"] is False


def test_client_config_points_at_the_stdio_server() -> None:
    for client in ("http", "claude-code", "claude-desktop", "stdio"):
        payload = json.loads(mcp_client_config(client, "http://127.0.0.1:8000"))
        server = payload["mcpServers"]["dramaclaw"]
        assert server["args"] == ["-m", "novelvideo.chat.dramaclaw_mcp"]
        assert server["env"]["DRAMACLAW_API_URL"] == "http://127.0.0.1:8000"
        # 键名要留着：省掉它会让人以为不用鉴权。
        assert "DRAMACLAW_AGENT_TOKEN" in server["env"]

    with pytest.raises(DirectorDeskMcpError):
        mcp_client_config("insiders")


def test_unregister_is_idempotent() -> None:
    register_node("node-x", ["director_read"])
    assert unregister_node("node-x") is True
    assert unregister_node("node-x") is False


def test_register_rejects_a_blank_node_id() -> None:
    with pytest.raises(DirectorDeskMcpError):
        register_node("  ", ["director_read"])
