"""session 恢复契约：hermes 用 ``session/resume``（fork），不是 ``session/load``。

原上游版本按 ``session/load`` 写。实测（见 ``test_hermes_workspace.py`` 的
2026-09-18 记录）：``session/load`` 对任何 id（包括 hermes 从没见过的）都回
``{"result": {}}``，随后对该 id 的 ``session/prompt`` 立刻 ``stopReason: refusal``，
一次模型调用都不发。所以这里改成断言 ``session/resume`` 的行为：

- 恢复拿不到可用的 fork id → 回落到 ``session/new``；
- 恢复成功（响应里带新的 ``acpSessionId``）→ 采用返回的 fork id，不建新会话。
"""

from pathlib import Path

import pytest

from novelvideo.chat.hermes_sdk import HermesSdkThread


def _thread(session_id: str) -> HermesSdkThread:
    return HermesSdkThread(
        cli_path=Path("/unused"),
        cwd=Path("/tmp"),
        env={},
        model=None,
        username="local",
        session_id=session_id,
    )


@pytest.mark.parametrize("result", [{}, None, {"error": {"code": -32600}}])
async def test_unusable_resume_result_creates_new_session(monkeypatch, result):
    """恢复结果里没有可用的 fork id 时，回落到 session/new。"""
    thread = _thread("missing")
    methods: list[str] = []

    async def send(method, params):  # noqa: ARG001
        methods.append(method)
        return len(methods)

    async def read(req_id, timeout):  # noqa: ARG001
        if req_id == 1:
            return ({"id": req_id, "result": result}, [])
        return ({"id": req_id, "result": {"sessionId": "fresh"}}, [])

    monkeypatch.setattr(thread, "_send", send)
    monkeypatch.setattr(thread, "_read_until_id", read)
    await thread._ensure_session()

    assert methods == ["session/resume", "session/new"]
    assert thread.id == "fresh"


async def test_resume_adopts_the_forked_session_id(monkeypatch):
    """恢复成功时采用响应里返回的新 acpSessionId（fork 语义）。"""
    thread = _thread("existing")
    methods: list[str] = []

    async def send(method, params):  # noqa: ARG001
        methods.append(method)
        return 1

    async def read(req_id, timeout):  # noqa: ARG001
        return (
            {
                "id": req_id,
                "result": {
                    "_meta": {
                        "hermes": {
                            "sessionProvenance": {"acpSessionId": "forked-session"}
                        }
                    }
                },
            },
            [],
        )

    monkeypatch.setattr(thread, "_send", send)
    monkeypatch.setattr(thread, "_read_until_id", read)
    await thread._ensure_session()

    assert methods == ["session/resume"]
    assert thread.id == "forked-session"
