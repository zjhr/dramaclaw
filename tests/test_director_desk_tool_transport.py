"""传输层：配对、无会话语义、事件流。

这几条是整套 AI 面板的地基。配对错一次的症状是「有时灵有时不灵」，无会话时静默超时
的症状更糟 —— 模型会以为写入失败然后重放。所以这里逐条钉死语义，而不是只测「能通」。
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from tempfile import mktemp

import pytest

from novelvideo.director_desk.tool_transport import (
    DirectorDeskToolTransport,
    NoActiveSessionError,
    TransportError,
)


async def test_call_round_trip_pairs_by_request_id() -> None:
    transport = DirectorDeskToolTransport()
    session = transport.open_session("node-a")

    call = asyncio.create_task(transport.call("node-a", "director_read", {"sections": ["entities"]}))
    polled = await transport.poll("node-a", session.session_id, wait=1.0)

    assert len(polled["calls"]) == 1
    request = polled["calls"][0]
    assert request["name"] == "director_read"
    assert request["args"] == {"sections": ["entities"]}
    assert transport.submit_result("node-a", request["request_id"], {"ok": True, "data": {"revision": 7}})

    assert await call == {"ok": True, "data": {"revision": 7}}
    assert transport.pending_count() == 0


async def test_no_active_session_reports_not_started_without_waiting() -> None:
    transport = DirectorDeskToolTransport()

    with pytest.raises(NoActiveSessionError):
        await transport.call("node-missing", "director_apply", {"operations": []})

    # 关键不是抛不抛，而是**立刻**：模型看到这个分类才知道没派发出去，可以安全重试。
    assert transport.pending_count() == 0


async def test_closed_session_fails_in_flight_call_as_unknown() -> None:
    transport = DirectorDeskToolTransport()
    session = transport.open_session("node-b")
    call = asyncio.create_task(transport.call("node-b", "director_apply", {"operations": []}))
    await transport.poll("node-b", session.session_id, wait=1.0)

    assert transport.close_session("node-b", session.session_id) is True

    # 已派发的调用回填 'unknown'，不是 'not-started'：它可能已经在引擎里生效了。
    result = await call
    assert result["ok"] is False
    assert result["execution"] == "unknown"
    assert "已关闭" in result["error"]


async def test_tool_timeout_reports_unknown_not_not_started() -> None:
    transport = DirectorDeskToolTransport(tool_timeout=0.05)
    transport.open_session("node-c")

    result = await transport.call("node-c", "director_apply", {"operations": []})

    assert result == {
        "ok": False,
        "execution": "unknown",
        "error": "工具响应超时，请先查询状态，不要直接重复写入",
    }
    assert transport.pending_count() == 0


async def test_reopening_session_invalidates_the_previous_one() -> None:
    transport = DirectorDeskToolTransport()
    first = transport.open_session("node-d")
    stale_call = asyncio.create_task(transport.call("node-d", "director_apply", {}))
    await transport.poll("node-d", first.session_id, wait=1.0)

    second = transport.open_session("node-d")

    assert second.session_id != first.session_id
    assert (await stale_call)["execution"] == "unknown"
    # 旧窗口的 poll 不能再取走新窗口的活。
    with pytest.raises(NoActiveSessionError):
        await transport.poll("node-d", first.session_id, wait=0.1)


async def test_poll_returns_immediately_when_a_call_is_queued() -> None:
    transport = DirectorDeskToolTransport()
    session = transport.open_session("node-e")
    poll = asyncio.create_task(transport.poll("node-e", session.session_id, wait=30.0))
    await asyncio.sleep(0)

    task = asyncio.create_task(transport.call("node-e", "director_media", {"action": "list"}))
    polled = await asyncio.wait_for(poll, timeout=1.0)

    assert polled["calls"][0]["name"] == "director_media"
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_poll_times_out_with_empty_payload() -> None:
    transport = DirectorDeskToolTransport()
    session = transport.open_session("node-f")

    payload = await transport.poll("node-f", session.session_id, wait=0.05)

    assert payload == {"calls": [], "events": []}


async def test_events_travel_on_the_same_poll_as_calls() -> None:
    transport = DirectorDeskToolTransport()
    session = transport.open_session("node-g")
    poll = asyncio.create_task(transport.poll("node-g", session.session_id, wait=30.0))
    await asyncio.sleep(0)

    assert transport.push_event("node-g", {"type": "text", "text": "hello"}) is True
    payload = await asyncio.wait_for(poll, timeout=1.0)

    assert payload["events"] == [{"type": "text", "text": "hello"}]
    assert payload["calls"] == []


async def test_events_without_a_session_have_nowhere_to_go() -> None:
    transport = DirectorDeskToolTransport()

    assert transport.push_event("node-h", {"type": "done"}) is False


async def test_queue_overflow_is_rejected_before_dispatch() -> None:
    transport = DirectorDeskToolTransport()
    transport.open_session("node-i")

    tasks = []
    for index in range(64):
        tasks.append(asyncio.create_task(transport.call("node-i", "director_read", {"n": index})))
    await asyncio.sleep(0)

    with pytest.raises(TransportError):
        await transport.call("node-i", "director_read", {})

    for task in tasks:
        task.cancel()
    transport.close_session("node-i")


async def test_stale_tool_result_is_dropped_instead_of_raising() -> None:
    transport = DirectorDeskToolTransport()
    session = transport.open_session("node-j")
    call = asyncio.create_task(transport.call("node-j", "director_read", {}))
    polled = await transport.poll("node-j", session.session_id, wait=1.0)
    request_id = polled["calls"][0]["request_id"]
    transport.close_session("node-j", session.session_id)
    await call

    # 超时之后迟到的回包不能写进一张已经没人等的表，也不能把画布搞崩。
    assert transport.submit_result("node-j", request_id, {"ok": True}) is False


async def test_a_drained_queue_does_not_hand_the_same_call_out_twice() -> None:
    transport = DirectorDeskToolTransport()
    session = transport.open_session("node-l")
    call = asyncio.create_task(transport.call("node-l", "director_read", {"round": 1}))

    first = await transport.poll("node-l", session.session_id, wait=1.0)
    transport.submit_result("node-l", first["calls"][0]["request_id"], {"ok": True})
    assert await call == {"ok": True}

    # 队列必须真的排空：留着就会把同一个 request_id 无限重发给画布，
    # 而回填早已完成 —— 症状是「工具被无限重复执行」。
    second = await transport.poll("node-l", session.session_id, wait=0.05)
    assert second == {"calls": [], "events": []}


async def test_events_are_drained_exactly_once() -> None:
    transport = DirectorDeskToolTransport()
    session = transport.open_session("node-m")
    transport.push_event("node-m", {"type": "text", "text": "a"})

    first = await transport.poll("node-m", session.session_id, wait=1.0)
    second = await transport.poll("node-m", session.session_id, wait=0.05)

    assert [e["text"] for e in first["events"]] == ["a"]
    assert second["events"] == []


async def test_open_session_rejects_a_blank_node_id() -> None:
    transport = DirectorDeskToolTransport()

    with pytest.raises(TransportError):
        transport.open_session("   ")


async def test_close_session_ignores_a_mismatched_session_id() -> None:
    transport = DirectorDeskToolTransport()
    transport.open_session("node-k")

    assert transport.close_session("node-k", "not-the-current-session") is False
    assert transport.is_active("node-k") is True


# ── 端点层 ────────────────────────────────────────────────────────────────────
#
# 上面的用例直接打传输层。真正跑在浏览器里的那条路是「路由 + 传输层」，所以这里用
# ASGI 传输走一遍：握手 → 长轮询取调用 → 回填结果 → 事件回流。端点形状或前缀改了，
# 这一条会红，而传输层的单测不会。
#
# 用 `httpx.ASGITransport` 而不是 `TestClient`：后者在自己的线程事件循环里同步执行
# 请求，会把测试自己的循环卡住 —— 而工具调用正是从测试循环里派发的，于是必然死锁。


@pytest.fixture
async def client(monkeypatch: pytest.MonkeyPatch):
    import httpx
    from fastapi import FastAPI

    import novelvideo.director_desk.ai_host as ai_host
    import novelvideo.director_desk.routes as routes

    transport = DirectorDeskToolTransport(tool_timeout=2.0)
    service = ai_host.DirectorDeskAiService(
        transport=transport,
        data_dir=Path(mktemp("director-desk")),
        load_profiles=lambda: [],
        save_profiles=lambda _p: None,
    )
    monkeypatch.setattr(routes, "get_tool_transport", lambda: transport)
    monkeypatch.setattr(routes, "get_ai_service", lambda: service)
    monkeypatch.setattr(ai_host, "get_tool_transport", lambda: transport)

    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1/director-desk")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://director-desk.test"
    ) as http:
        yield http, transport, service


READ_CONTRACT = {
    "definitions": [{"name": "director_read", "inputSchema": {"type": "object"}}],
    "discussion": [{"name": "director_read", "inputSchema": {"type": "object"}}],
}


async def open_session(http, node_id: str = "node-e2e") -> str:
    response = await http.post(
        "/api/v1/director-desk/ai/session",
        json={"nodeId": node_id, "contract": READ_CONTRACT},
    )
    assert response.status_code == 200
    return response.json()["sessionId"]


async def test_endpoints_serve_a_full_tool_round_trip(client) -> None:
    http, transport, _service = client
    session_id = await open_session(http)

    # 派发用传输层发起，回填走端点：这一段就是浏览器画布那一侧的动作序列。
    call = asyncio.create_task(transport.call("node-e2e", "director_read", {}))
    polled = await http.post(
        "/api/v1/director-desk/ai/poll",
        json={"nodeId": "node-e2e", "sessionId": session_id, "wait": 1.0},
    )
    assert polled.status_code == 200
    request_id = polled.json()["calls"][0]["request_id"]

    filled = await http.post(
        "/api/v1/director-desk/ai/tool-result",
        json={
            "nodeId": "node-e2e",
            "requestId": request_id,
            "result": {"ok": True, "data": {"revision": 3}},
        },
    )
    assert filled.json() == {"accepted": True}
    assert await call == {"ok": True, "data": {"revision": 3}}


async def test_agent_events_travel_back_on_the_same_poll(client) -> None:
    http, transport, _service = client
    session_id = await open_session(http)
    transport.push_event("node-e2e", {"type": "done", "timing": {"rounds": 1}})

    events = await http.post(
        "/api/v1/director-desk/ai/poll",
        json={"nodeId": "node-e2e", "sessionId": session_id, "wait": 0.5},
    )

    assert [e["type"] for e in events.json()["events"]] == ["done"]


async def test_closing_the_session_ends_the_transport(client) -> None:
    http, transport, _service = client
    session_id = await open_session(http)

    closed = await http.post(
        "/api/v1/director-desk/ai/session/close",
        json={"nodeId": "node-e2e", "sessionId": session_id},
    )

    assert closed.json() == {"closed": True}
    assert transport.is_active("node-e2e") is False


async def test_poll_without_a_matching_session_is_a_conflict(client) -> None:
    http, _transport, _service = client

    response = await http.post(
        "/api/v1/director-desk/ai/poll",
        json={"nodeId": "node-ghost", "sessionId": "nope", "wait": 0.1},
    )

    assert response.status_code == 409
    assert "活跃会话" in response.json()["detail"]


async def test_session_open_rejects_an_empty_tool_contract(client) -> None:
    http, _transport, _service = client

    response = await http.post(
        "/api/v1/director-desk/ai/session",
        json={"nodeId": "node-e2e", "contract": {"definitions": []}},
    )

    assert response.status_code == 400


async def test_run_reports_a_missing_channel_as_an_error_event(client) -> None:
    http, _transport, _service = client
    session_id = await open_session(http)

    accepted = await http.post(
        "/api/v1/director-desk/ai/run",
        json={"nodeId": "node-e2e", "profileId": "missing", "prompt": "改一下"},
    )
    assert accepted.status_code == 200

    # run() 的前置校验抛在后台 task 里；不补这一下的话面板点了发送什么也看不到。
    payload = (
        await http.post(
            "/api/v1/director-desk/ai/poll",
            json={"nodeId": "node-e2e", "sessionId": session_id, "wait": 2.0},
        )
    ).json()
    errors = [e for e in payload["events"] if e["type"] == "error"]
    assert errors and "请先配置并选择渠道" in errors[0]["text"]
