# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""聊天入站 scope 的错误映射契约。

用户侧表现：body 里 scope 拼错一个字段（未知 kind、directorDesk id 不是
``<project>/<node>``），**HTTP 路由必须回 400 并带上可读原因，而不是 500**。

`ChatScope.from_payload` 对这类输入抛的是裸 `ValueError`。路由层如果不接住，
FastAPI 会把它当成未处理异常 → 500「Internal Server Error」：客户端只是拼错了
一个字段，却看到「服务器内部错误」，排查方向直接跑偏（实测过：`ui-events` 传
`{"kind":"bogusKind"}` 返回 500）。

WS 侧没有状态码可用：让 ValueError 冒出去，整条连接会被 Starlette 异常关闭，
用户看到的是「聊天突然断了」而不是「这条消息的 scope 有问题」。所以 WS 必须回
一帧 ``error`` 并留在连接里。

本文件锁的行为：
1. 五个 REST 入口（cancel / notifications / director-desk-restore / ui-events /
   permission-result）对非法 scope 统一回 400；
2. WS 的 scope 解析助手对非法 scope 回 error 帧并返回 None（调用方 continue）；
3. 合法 scope 不受影响（避免「为了报错把正常路径也堵了」）。
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from novelvideo.api.routes import chat as chat_routes


class _CaptureWebSocket:
    """只记账 `send_json` 的最小 socket 替身。"""

    def __init__(self) -> None:
        self.sent: list[dict[str, object]] = []

    async def send_json(self, payload: dict[str, object]) -> None:
        self.sent.append(payload)


def _unknown_kind_scope() -> dict[str, object]:
    return {"kind": "bogusKind", "id": "project-1"}


def _malformed_desk_scope() -> dict[str, object]:
    # 合法形态是 `<project>/<node>`；这个会穿目录边界，必须被挡下。
    return {"kind": chat_routes.DIRECTOR_DESK_SCOPE_KIND, "id": "../evil/node"}


@pytest.mark.parametrize(
    "scope_factory",
    [_unknown_kind_scope, _malformed_desk_scope],
    ids=["unknown-kind", "malformed-directorDesk-id"],
)
@pytest.mark.asyncio
async def test_cancel_chat_turn_rejects_bad_scope_with_400(
    monkeypatch: pytest.MonkeyPatch, scope_factory
) -> None:
    # 只有 codex 后端才会解析 scope；其它后端进来先短路返回。
    monkeypatch.setattr(
        chat_routes.chat_service, "get_chat_backend_name", lambda: "codex"
    )
    payload = chat_routes.CancelChatTurnRequest(
        scope=chat_routes.ChatScopePayload(**scope_factory()),
        turn_id="turn-1",
    )

    with pytest.raises(HTTPException) as excinfo:
        await chat_routes.cancel_chat_turn(
            user={"username": "alice"}, payload=payload
        )

    assert excinfo.value.status_code == 400


@pytest.mark.parametrize(
    "scope_factory",
    [_unknown_kind_scope, _malformed_desk_scope],
    ids=["unknown-kind", "malformed-directorDesk-id"],
)
@pytest.mark.asyncio
async def test_append_chat_notification_rejects_bad_scope_with_400(
    scope_factory,
) -> None:
    payload = chat_routes.ChatNotificationIn(
        scope=chat_routes.ChatScopePayload(**scope_factory()),
        text="随便一条通知",
    )

    with pytest.raises(HTTPException) as excinfo:
        await chat_routes.append_chat_notification(
            payload=payload, user={"username": "alice"}
        )

    assert excinfo.value.status_code == 400
    # 报错文案要指向真正的原因，否则前端只能显示「服务器内部错误」。
    assert excinfo.value.detail


@pytest.mark.parametrize(
    "scope_factory",
    [_unknown_kind_scope, _malformed_desk_scope],
    ids=["unknown-kind", "malformed-directorDesk-id"],
)
@pytest.mark.asyncio
async def test_restore_director_desk_chat_rejects_bad_scope_with_400(
    scope_factory,
) -> None:
    payload = chat_routes.DirectorDeskRestoreIn(
        scope=chat_routes.ChatScopePayload(**scope_factory()),
        messages=[],
    )

    with pytest.raises(HTTPException) as excinfo:
        await chat_routes.restore_director_desk_chat(
            payload=payload, user={"username": "alice"}
        )

    assert excinfo.value.status_code == 400


@pytest.mark.parametrize(
    "scope_factory",
    [_unknown_kind_scope, _malformed_desk_scope],
    ids=["unknown-kind", "malformed-directorDesk-id"],
)
@pytest.mark.asyncio
async def test_append_chat_ui_event_rejects_bad_scope_with_400(scope_factory) -> None:
    payload = chat_routes.ChatUiEventIn(
        scope=chat_routes.ChatScopePayload(**scope_factory()),
        turn_id="turn-1",
        event={},
    )

    with pytest.raises(HTTPException) as excinfo:
        await chat_routes.append_chat_ui_event(
            payload=payload, user={"username": "alice"}
        )

    assert excinfo.value.status_code == 400


@pytest.mark.parametrize(
    "scope_factory",
    [_unknown_kind_scope, _malformed_desk_scope],
    ids=["unknown-kind", "malformed-directorDesk-id"],
)
@pytest.mark.asyncio
async def test_resolve_agent_permission_rejects_bad_scope_with_400(
    scope_factory,
) -> None:
    payload = chat_routes.AgentPermissionResultIn(
        scope=chat_routes.ChatScopePayload(**scope_factory()),
        request_id="req-1",
        option_id="allow",
    )

    with pytest.raises(HTTPException) as excinfo:
        await chat_routes.resolve_agent_permission(
            payload=payload, user={"username": "alice"}
        )

    assert excinfo.value.status_code == 400


@pytest.mark.parametrize(
    "scope_factory",
    [_unknown_kind_scope, _malformed_desk_scope],
    ids=["unknown-kind", "malformed-directorDesk-id"],
)
@pytest.mark.asyncio
async def test_ws_scope_helper_sends_error_frame_and_returns_none(
    scope_factory,
) -> None:
    websocket = _CaptureWebSocket()

    scope = await chat_routes._scope_from_ws_event_or_error_frame(
        websocket, chat_routes.ChatScopePayload(**scope_factory())
    )

    assert scope is None, "非法 scope 不能让调用方继续往下走"
    assert websocket.sent, "必须回一帧 error，而不是把连接异常关掉"
    frame = websocket.sent[0]
    assert frame["type"] == "error"
    assert "invalid scope" in str(frame["message"])


@pytest.mark.asyncio
async def test_ws_scope_helper_passes_through_valid_scope() -> None:
    websocket = _CaptureWebSocket()

    scope = await chat_routes._scope_from_ws_event_or_error_frame(
        websocket,
        chat_routes.ChatScopePayload(kind="project", id="project-1"),
    )

    assert scope is not None
    assert scope.kind == "project"
    assert scope.project_id == "project-1"
    assert websocket.sent == [], "合法 scope 不该产生任何错误帧"


@pytest.mark.asyncio
async def test_ws_scope_helper_accepts_valid_director_desk_scope() -> None:
    websocket = _CaptureWebSocket()

    scope = await chat_routes._scope_from_ws_event_or_error_frame(
        websocket,
        chat_routes.ChatScopePayload(
            kind=chat_routes.DIRECTOR_DESK_SCOPE_KIND, id="project-1/node-1"
        ),
    )

    assert scope is not None
    assert scope.project_id == "project-1"
    assert scope.conversation_key == "node-1"
    assert websocket.sent == []
