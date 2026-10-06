"""节点内多会话：新对话归档、切回继续、重启恢复与失败时的活动会话保护。"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI

from novelvideo.director_desk import ai_host, routes
from novelvideo.director_desk.ai_host import (
    AbortToken,
    DirectorDeskAiService,
    ProviderError,
    ToolContract,
)

NODE = "history-node"


class _Transport:
    """只替换 iframe 的工具执行边界，循环与持久化使用生产实现。"""

    async def call(self, _node: str, _name: str, _args: dict[str, Any]) -> dict[str, Any]:
        return {"ok": True, "revision": 1, "data": {"entityCount": 1}}

    def push_event(self, _node: str, _event: dict[str, Any]) -> None:
        return None


class _HeldSnapshotTransport(_Transport):
    """让真实 run 暂停在第一次工具读取，用事件确定任务登记后的准备阶段。"""

    def __init__(self) -> None:
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.events: list[dict[str, Any]] = []

    async def call(self, node: str, name: str, args: dict[str, Any]) -> dict[str, Any]:
        self.entered.set()
        await self.release.wait()
        return await super().call(node, name, args)

    def push_event(self, _node: str, event: dict[str, Any]) -> None:
        self.events.append(event)


def _service(
    tmp_path: Path,
    requests: list[dict[str, Any]] | None = None,
    *,
    tool_first: bool = False,
) -> DirectorDeskAiService:
    """真实 agent 循环使用本地模型替身，禁止网络请求和运行态目录写入。"""

    pending_tool = tool_first

    def model(request: httpx.Request) -> httpx.Response:
        nonlocal pending_tool
        if requests is not None:
            requests.append(json.loads(request.content))
        if pending_tool:
            # 历史续接必须保留真实循环执行的工具收据，不能只验证普通文字消息。
            pending_tool = False
            return httpx.Response(200, json={"choices": [{
                "message": {"role": "assistant", "content": "先读取当前场景。", "tool_calls": [{
                    "id": "history-read", "type": "function",
                    "function": {"name": "director_read", "arguments": '{"section":"entities"}'},
                }]},
                "finish_reason": "tool_calls",
            }]})
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"role": "assistant", "content": "已记录当前任务。"}, "finish_reason": "stop"}],
            },
        )

    service = DirectorDeskAiService(
        data_dir=tmp_path,
        transport=_Transport(),  # type: ignore[arg-type]
        load_profiles=lambda: [
            {"id": profile, "name": profile, "protocol": "chat", "base_url": "https://model.example/v1",
             "model": "test-model", "key": "test-key", "stream": False, "max_tokens": 4096}
            for profile in ("p1", "p2")
        ],
        save_profiles=lambda _profiles: None,
        http_transport=httpx.MockTransport(model),
    )
    read = {"name": "director_read", "description": "读场景", "inputSchema": {"type": "object"}}
    service.set_contract(NODE, ToolContract.from_payload({"definitions": [read], "discussion": [read]}))
    return service


async def _start(service: DirectorDeskAiService, text: str, profile: str = "p1") -> str:
    """直接追加用户消息供异常测试布置会话；核心验收另跑完整 run。"""
    conversation = service._conversation(NODE)
    await conversation.start(service._channel(profile), text)
    return conversation.id


async def _change(service: DirectorDeskAiService, action: str, archived: str) -> dict[str, Any]:
    """切换测试统一走服务入口，节点首尾空白也必须使用同一把短锁。"""
    if action == "new":
        return await service.new_conversation(f" {NODE} ")
    return await service.select_conversation(f" {NODE} ", archived)


def _observe_change(
    service: DirectorDeskAiService, action: str, monkeypatch: pytest.MonkeyPatch,
) -> asyncio.Event:
    """只观测进入持久化操作，仍等待生产 Conversation 保存锁并执行原始写入。"""
    conversation = service._conversation(NODE)
    method = "reset" if action == "new" else "activate"
    change = getattr(conversation, method)
    entered = asyncio.Event()

    async def observed(*args: Any) -> dict[str, Any]:
        entered.set()
        return await change(*args)

    monkeypatch.setattr(conversation, method, observed)
    return entered


async def _clean_tasks(tasks: list[asyncio.Task[Any]]) -> None:
    """断言失败也取消事件屏障前的任务，避免污染后续测试的事件循环。"""
    for task in tasks:
        if not task.done():
            task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


async def test_new_history_select_continue_and_restart_keep_full_conversations(tmp_path: Path) -> None:
    requests: list[dict[str, Any]] = []
    service = _service(tmp_path, requests, tool_first=True)
    result = await service.run(node_id=NODE, profile_id="p1", prompt="咖啡馆第一场，安排推门与回头")
    assert result.get("stopped") is not True
    original = service.conversation(NODE)
    tools = [tool for message in original["messages"] for tool in message.get("tools", [])]
    assert len(tools) == 1
    assert tools[0]["name"] == "director_read"
    assert tools[0]["status"] == "completed"
    await service._conversation(NODE).notice("上一轮工具失败，可继续修正。")

    fresh = await service.new_conversation(NODE)
    assert fresh["sessionId"] != original["sessionId"]
    assert fresh["messages"] == []
    assert fresh["profileId"] == "p1"
    history = service.conversation_history(NODE)
    assert len(history) == 2
    assert {row["sessionId"] for row in history} == {fresh["sessionId"], original["sessionId"]}
    assert next(row for row in history if row["current"])["sessionId"] == fresh["sessionId"]
    old = next(row for row in history if row["sessionId"] == original["sessionId"])
    assert old["title"] == "咖啡馆第一场，安排推门与回头"
    assert isinstance(old["updatedAt"], int)
    assert old["profileId"] == "p1"

    result = await service.run(node_id=NODE, profile_id="p2", prompt="独立的新任务，车内雨夜")
    assert result.get("stopped") is not True
    selected = await service.select_conversation(NODE, original["sessionId"])
    assert "咖啡馆第一场" in selected["transcript"]
    assert "上一轮工具失败" in selected["transcript"]
    assert "车内雨夜" not in selected["transcript"]
    assert selected["profileId"] == "p1"
    assert selected["messages"] == original["messages"]
    result = await service.run(node_id=NODE, profile_id="", prompt="继续修正回头动作", session_id=original["sessionId"])
    assert result.get("stopped") is not True
    model_history = json.dumps(requests[-1]["messages"], ensure_ascii=False)
    assert "咖啡馆第一场" in model_history
    assert "已记录当前任务。" in model_history
    assert "上一轮工具失败" in model_history
    assert "继续修正回头动作" in model_history
    assert "车内雨夜" not in model_history
    tool_message = next(message for message in requests[-1]["messages"] if message.get("role") == "tool")
    assert tool_message["tool_call_id"] == "history-read"
    assert json.loads(tool_message["content"])["data"] == {"entityCount": 1}
    tool_turn = next(message for message in requests[-1]["messages"] if message.get("tool_calls"))
    assert json.loads(tool_turn["tool_calls"][0]["function"]["arguments"]) == {"section": "entities"}

    service.close()
    restarted = _service(tmp_path)
    assert restarted.conversation(NODE)["sessionId"] == original["sessionId"]
    assert "继续修正回头动作" in restarted.conversation(NODE)["transcript"]
    assert len(restarted.conversation_history(NODE)) == 2
    second = await restarted.select_conversation(NODE, fresh["sessionId"])
    assert second["profileId"] == "p2"
    assert "车内雨夜" in second["transcript"]
    assert "咖啡馆第一场" not in second["transcript"]


async def test_legacy_single_conversation_is_archived_without_losing_entries(tmp_path: Path) -> None:
    service = _service(tmp_path)
    session_id = str(uuid4())
    legacy = {"version": 1, "sessionId": session_id, "profileId": "p2", "entries": [
        {"type": "user", "text": "旧版会话任务"}, {"type": "notice", "text": "流中断，已提交操作保留"},
    ]}
    path = service._conversation_path(NODE)
    path.write_text(json.dumps(legacy, ensure_ascii=False))
    expected_updated = int(path.stat().st_mtime * 1000)
    old = service.conversation_history(NODE)[0]
    assert old == {"sessionId": session_id, "profileId": "p2", "title": "旧版会话任务", "updatedAt": expected_updated, "current": True}

    await service.new_conversation(NODE)
    restored = await service.select_conversation(NODE, session_id)
    assert "旧版会话任务" in restored["transcript"]
    assert "流中断" in restored["transcript"]
    assert restored["profileId"] == "p2"


@pytest.mark.parametrize("session_id", ["../history", "a/b", "a\\b", "..", "/absolute", "a\x00b"])
async def test_select_rejects_unsafe_session_ids_without_changing_current(tmp_path: Path, session_id: str) -> None:
    service = _service(tmp_path)
    await _start(service, "当前任务")
    original = service.conversation(NODE)
    with pytest.raises(ProviderError, match="会话"):
        await service.select_conversation(NODE, session_id)
    assert service.conversation(NODE) == original
    assert len(service.conversation_history(NODE)) == 1


async def test_session_ids_are_scoped_to_their_node(tmp_path: Path) -> None:
    service = _service(tmp_path)
    original = await _start(service, "属于第一个节点")
    await service.new_conversation(NODE)
    other = service.conversation("other-node")
    with pytest.raises(ProviderError, match="不存在|此节点"):
        await service.select_conversation("other-node", original)
    assert service.conversation("other-node") == other
    assert all(row["sessionId"] != original for row in service.conversation_history("other-node"))


async def test_unknown_safe_session_id_cannot_replace_current(tmp_path: Path) -> None:
    service = _service(tmp_path)
    await _start(service, "当前任务")
    original = service.conversation(NODE)
    with pytest.raises(ProviderError, match="不存在"):
        await service.select_conversation(NODE, str(uuid4()))
    assert service.conversation(NODE) == original


async def test_history_file_id_must_match_the_requested_session(tmp_path: Path) -> None:
    service = _service(tmp_path)
    archived = await _start(service, "历史任务")
    await service.new_conversation(NODE)
    original = service.conversation(NODE)
    path = service._conversation(NODE)._history_path(archived)
    state = json.loads(path.read_text("utf-8"))
    state["sessionId"] = str(uuid4())
    path.write_text(json.dumps(state))
    with pytest.raises(ProviderError, match="ID 不匹配"):
        await service.select_conversation(NODE, archived)
    assert service.conversation(NODE) == original


async def test_running_node_rejects_new_and_select_even_with_whitespace(tmp_path: Path) -> None:
    service = _service(tmp_path)
    archived = await _start(service, "第一次任务")
    await service.new_conversation(NODE)
    original = service.conversation(NODE)
    service._running[NODE] = AbortToken()

    with pytest.raises(ProviderError, match="先停止"):
        await service.new_conversation(f" {NODE} ")
    with pytest.raises(ProviderError, match="先停止"):
        await service.select_conversation(f" {NODE} ", archived)
    assert service.conversation(NODE) == original
    assert len(service.conversation_history(NODE)) == 2


@pytest.mark.parametrize("action", ["new", "select"])
async def test_run_preparing_snapshot_rejects_switch_without_waiting_for_model(tmp_path: Path, action: str) -> None:
    """准备阶段已登记运行；会话操作要立即拒绝，不能一直等整场模型任务结束。"""
    requests: list[dict[str, Any]] = []
    service = _service(tmp_path, requests)
    archived = await _start(service, "归档任务")
    await service.new_conversation(NODE)
    current = await _start(service, "当前旧任务")
    held = _HeldSnapshotTransport()
    service._transport = held  # type: ignore[assignment]
    task = asyncio.create_task(service.run(
        node_id=f" {NODE} ", profile_id="p1", prompt="准备中的新指令", session_id=current,
    ))
    try:
        await asyncio.wait_for(held.entered.wait(), timeout=1)
        assert service.is_running(NODE)
        assert requests == []
        with pytest.raises(ProviderError, match="先停止"):
            await asyncio.wait_for(_change(service, action, archived), timeout=1)
        assert service.conversation(NODE)["sessionId"] == current
        held.release.set()
        result = await asyncio.wait_for(task, timeout=2)
        assert result.get("stopped") is not True
        assert result["sessionId"] == current
        assert {event["sessionId"] for event in held.events} == {current}
        active = json.loads(service._conversation_path(NODE).read_text("utf-8"))
        assert active["sessionId"] == current
        assert any(entry.get("text") == "准备中的新指令" for entry in active["entries"])
        assert "准备中的新指令" not in service._conversation(NODE)._history_path(archived).read_text("utf-8")
    finally:
        held.release.set()
        await _clean_tasks([task])
        service.close()


@pytest.mark.parametrize("action", ["new", "select"])
@pytest.mark.parametrize("explicit_old_session", [False, True])
async def test_run_waits_for_switch_persistence_and_cannot_write_as_old_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, action: str, explicit_old_session: bool,
) -> None:
    """切换等待真实保存锁时，run 必须等到切换落盘，再读取会话并校验旧 ID。"""
    requests: list[dict[str, Any]] = []
    service = _service(tmp_path, requests)
    archived = await _start(service, "归档任务")
    await service.new_conversation(NODE)
    current = await _start(service, "当前旧任务")
    conversation = service._conversation(NODE)
    switch_entered = _observe_change(service, action, monkeypatch)
    attempting = asyncio.Event()
    tasks: list[asyncio.Task[Any]] = []

    async def queued_run() -> dict[str, Any]:
        attempting.set()
        return await service.run(
            node_id=NODE, profile_id="", prompt="切换后任务",
            session_id=current if explicit_old_session else None,
        )

    try:
        async with conversation._lock:
            change = asyncio.create_task(_change(service, action, archived))
            tasks.append(change)
            await asyncio.wait_for(switch_entered.wait(), timeout=1)
            run = asyncio.create_task(queued_run())
            tasks.append(run)
            await asyncio.wait_for(attempting.wait(), timeout=1)
            assert not run.done()
            assert not service.is_running(NODE)
            assert conversation.id == current
            assert requests == []
        changed = await asyncio.wait_for(change, timeout=2)
        changed_id = changed["sessionId"]
        assert changed_id == archived if action == "select" else changed_id not in {current, archived}
        if explicit_old_session:
            with pytest.raises(ProviderError, match="对话已切换"):
                await asyncio.wait_for(run, timeout=2)
            assert requests == []
        else:
            result = await asyncio.wait_for(run, timeout=2)
            assert result.get("stopped") is not True
            assert result["sessionId"] == changed_id
            assert "切换后任务" in json.dumps(requests[-1]["messages"], ensure_ascii=False)
            assert "当前旧任务" not in json.dumps(requests[-1]["messages"], ensure_ascii=False)
        active = json.loads(service._conversation_path(NODE).read_text("utf-8"))
        assert active["sessionId"] == changed_id
        assert "切换后任务" not in conversation._history_path(current).read_text("utf-8")
        assert not service.is_running(NODE)
    finally:
        await _clean_tasks(tasks)
        service.close()


@pytest.mark.parametrize("action", ["new", "select"])
async def test_cancelled_switch_releases_node_lock_and_keeps_active_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, action: str,
) -> None:
    """取消持久化等待不改活动文件，之后同节点仍可正常启动任务。"""
    service = _service(tmp_path)
    archived = await _start(service, "归档任务")
    await service.new_conversation(NODE)
    current = await _start(service, "当前旧任务")
    path = service._conversation_path(NODE)
    before = path.read_bytes()
    entered = _observe_change(service, action, monkeypatch)
    tasks: list[asyncio.Task[Any]] = []
    try:
        async with service._conversation(NODE)._lock:
            task = asyncio.create_task(_change(service, action, archived))
            tasks.append(task)
            await asyncio.wait_for(entered.wait(), timeout=1)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert path.read_bytes() == before
        assert service.conversation(NODE)["sessionId"] == current
        result = await asyncio.wait_for(service.run(
            node_id=NODE, profile_id="", prompt="取消后继续", session_id=current,
        ), timeout=2)
        assert result.get("stopped") is not True
        assert result["sessionId"] == current
    finally:
        await _clean_tasks(tasks)
        service.close()


async def test_node_switch_lock_does_not_block_another_nodes_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """一个节点等保存时，另一个节点的工具、模型和持久化仍可完成。"""
    service = _service(tmp_path)
    await _start(service, "等待保存的节点")
    entered = _observe_change(service, "new", monkeypatch)
    service.set_contract("other-node", service._contracts[NODE])
    tasks: list[asyncio.Task[Any]] = []
    try:
        async with service._conversation(NODE)._lock:
            task = asyncio.create_task(service.new_conversation(NODE))
            tasks.append(task)
            await asyncio.wait_for(entered.wait(), timeout=1)
            result = await asyncio.wait_for(service.run(
                node_id="other-node", profile_id="p1", prompt="另一个节点的独立任务",
            ), timeout=2)
            assert result.get("stopped") is not True
            assert not task.done()
            assert "另一个节点的独立任务" in service.conversation("other-node")["transcript"]
        await asyncio.wait_for(task, timeout=1)
    finally:
        await _clean_tasks(tasks)
        service.close()


async def test_run_validation_failure_releases_node_lock(tmp_path: Path) -> None:
    """登记之前的校验失败也必须释放短锁，不把节点永久卡在准备状态。"""
    service = _service(tmp_path)
    current = await _start(service, "当前任务")
    with pytest.raises(ProviderError, match="请输入"):
        await service.run(node_id=NODE, profile_id="", prompt=" \n", session_id=current)
    assert not service.is_running(NODE)
    fresh = await asyncio.wait_for(service.new_conversation(NODE), timeout=1)
    assert fresh["sessionId"] != current
    service.close()


async def test_stop_and_is_running_normalize_node_id_and_reject_explicit_blank(tmp_path: Path) -> None:
    """实际任务可用含空白的节点 ID 停止；空字符串或全空白均不能变成全停。"""
    service = _service(tmp_path)
    held = _HeldSnapshotTransport()
    service._transport = held  # type: ignore[assignment]
    task = asyncio.create_task(service.run(node_id=f" {NODE} ", profile_id="p1", prompt="等待场景读取"))
    try:
        await asyncio.wait_for(held.entered.wait(), timeout=1)
        assert service.is_running()
        assert service.is_running(f" \n{NODE}\t ")
        for blank in ("", " \n\t "):
            assert service.is_running(blank) is False
            assert service.stop(blank) is False
        assert service.is_running(NODE)
        assert not task.done()
        assert service.stop(f" \n{NODE}\t ") is True
        result = await asyncio.wait_for(task, timeout=2)
        assert result["stopped"] is True
        assert not service.is_running()
        assert "已停止" in service.conversation(NODE)["transcript"]
    finally:
        held.release.set()
        await _clean_tasks([task])
        service.close()


@pytest.mark.parametrize("failure", ["archive", "active"])
async def test_new_write_failure_keeps_active_session_and_disk(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str) -> None:
    service = _service(tmp_path)
    await _start(service, "保存失败也不能抹掉当前任务")
    original = service.conversation(NODE)
    path = service._conversation_path(NODE)
    raw = path.read_bytes()
    write = ai_host._atomic_write

    def broken(target: Path, data: bytes) -> None:
        if (target == path) == (failure == "active"):
            raise OSError("disk full")
        write(target, data)

    monkeypatch.setattr(ai_host, "_atomic_write", broken)
    with pytest.raises(ProviderError, match="保存失败|未切换"):
        await service.new_conversation(NODE)
    assert service.conversation(NODE) == original
    assert path.read_bytes() == raw
    assert _service(tmp_path).conversation(NODE) == original
    monkeypatch.setattr(ai_host, "_atomic_write", write)
    result = await asyncio.wait_for(service.run(
        node_id=NODE, profile_id="", prompt="写入恢复后继续", session_id=original["sessionId"],
    ), timeout=2)
    assert result.get("stopped") is not True
    assert result["sessionId"] == original["sessionId"]


@pytest.mark.parametrize("failure", ["archive", "active"])
async def test_select_write_failure_keeps_active_session_and_target_history(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str) -> None:
    service = _service(tmp_path)
    archived = await _start(service, "历史任务")
    await service.new_conversation(NODE)
    await _start(service, "当前第二次任务")
    original = service.conversation(NODE)
    path = service._conversation_path(NODE)
    raw = path.read_bytes()
    write = ai_host._atomic_write

    def broken(target: Path, data: bytes) -> None:
        if (target == path) == (failure == "active"):
            raise OSError("disk full")
        write(target, data)

    monkeypatch.setattr(ai_host, "_atomic_write", broken)
    with pytest.raises(ProviderError, match="保存失败|未切换"):
        await service.select_conversation(NODE, archived)
    assert service.conversation(NODE) == original
    assert path.read_bytes() == raw
    monkeypatch.setattr(ai_host, "_atomic_write", write)
    selected = await asyncio.wait_for(service.select_conversation(NODE, archived), timeout=1)
    assert "历史任务" in selected["transcript"]


async def test_corrupt_archive_is_preserved_and_cannot_replace_current(tmp_path: Path) -> None:
    service = _service(tmp_path)
    archived = await _start(service, "历史任务")
    await service.new_conversation(NODE)
    original = service.conversation(NODE)
    archive = service._conversation(NODE)._history_path(archived)
    archive.write_text("{broken-json", encoding="utf-8")
    with pytest.raises(ProviderError, match="无法读取|损坏"):
        await service.select_conversation(NODE, archived)
    assert service.conversation(NODE) == original
    assert archive.read_text("utf-8") == "{broken-json"
    assert len(service.conversation_history(NODE)) == 1


async def test_new_keeps_unreadable_original_as_backup(tmp_path: Path) -> None:
    service = _service(tmp_path)
    path = service._conversation_path(NODE)
    path.write_bytes(b"{original-damaged-file")
    with pytest.raises(ProviderError, match="无法读取"):
        service.conversation(NODE)
    fresh = await service.new_conversation(NODE)
    assert fresh["messages"] == []
    backups = list(service._conversation(NODE)._history_dir.glob("*.bak"))
    assert len(backups) == 1
    assert backups[0].read_bytes() == b"{original-damaged-file"


async def test_http_history_and_selection_contract(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    service = _service(tmp_path)
    archived = await _start(service, "接口可读的历史任务")
    await service.new_conversation(NODE)
    monkeypatch.setattr(routes, "get_ai_service", lambda: service)
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1/director-desk")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        listing = await client.post("/api/v1/director-desk/ai/conversation/history", json={"nodeId": NODE})
        assert listing.status_code == 200
        assert len(listing.json()["conversations"]) == 2
        selected = await client.post("/api/v1/director-desk/ai/conversation/select", json={"nodeId": NODE, "sessionId": archived})
        assert selected.status_code == 200
        assert selected.json()["conversation"]["sessionId"] == archived
        assert "接口可读的历史任务" in selected.json()["conversation"]["transcript"]

        service._running[NODE] = AbortToken()
        rejected = await client.post("/api/v1/director-desk/ai/conversation/select", json={"nodeId": NODE, "sessionId": archived})
        assert rejected.status_code == 400
        assert "先停止" in rejected.json()["detail"]
