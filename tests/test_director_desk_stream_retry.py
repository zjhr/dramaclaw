"""流在收到负载前被掐断才重试；已吐字 / 已拼工具 / 4xx 不重试，密钥不进日志。"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import httpx
import pytest

from novelvideo.director_desk.ai_host import (
    STREAM_INTERRUPT_RETRIES,
    DirectorDeskAiService,
    ProviderError,
    ToolContract,
    _read_stream,
    complete,
    validate_profile,
)
from novelvideo.director_desk.tool_transport import DirectorDeskToolTransport

SECRET = "sk-test-DO-NOT-LOG-9f3a"
BASE = "https://api.example.com/v1"


def _profile() -> object:
    return validate_profile(
        {
            "protocol": "chat",
            "baseUrl": BASE,
            "model": "deepseek-v4.1-flash",
            "name": "sharellm",
            "maxTokens": 64,
            "stream": True,
        }
    )


def _sse(frames: list[dict]) -> bytes:
    body = "".join(f"data: {json.dumps(frame, ensure_ascii=False)}\n\n" for frame in frames)
    return body.encode("utf-8")


def _ok_frame() -> list[dict]:
    return [
        {"choices": [{"delta": {"content": "好"}}]},
        {"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {"total_tokens": 3}},
    ]


async def test_empty_stream_drop_retries_then_succeeds(caplog: pytest.LogCaptureFixture) -> None:
    hits = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == f"Bearer {SECRET}"
        hits["n"] += 1
        if hits["n"] <= STREAM_INTERRUPT_RETRIES:
            return httpx.Response(200, content=b"", headers={"content-type": "text/event-stream"})
        return httpx.Response(200, content=_sse(_ok_frame()), headers={"content-type": "text/event-stream"})

    caplog.set_level(logging.DEBUG)
    result = await complete(
        _profile(),  # type: ignore[arg-type]
        SECRET,
        "系统提示不要进全文日志",
        [{"role": "user", "content": "hi"}],
        [],
        transport=httpx.MockTransport(handler),
    )

    assert hits["n"] == STREAM_INTERRUPT_RETRIES + 1
    assert result["text"] == "好"
    text = caplog.text
    assert SECRET not in text
    assert "Bearer" not in text
    assert "retry 1/2" in text


async def test_mid_stream_text_is_not_retried() -> None:
    hits = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        hits["n"] += 1
        return httpx.Response(
            200,
            content=_sse([{"choices": [{"delta": {"content": "半截"}}]}]),
            headers={"content-type": "text/event-stream"},
        )

    with pytest.raises(ProviderError, match="连接中断，未执行不完整的工具调用") as caught:
        await complete(
            _profile(),  # type: ignore[arg-type]
            SECRET,
            "sys",
            [{"role": "user", "content": "hi"}],
            [],
            transport=httpx.MockTransport(handler),
        )

    assert hits["n"] == 1
    assert "已重试" not in str(caught.value)
    assert caught.value.retryable is False


async def test_tool_delta_then_drop_does_not_dispatch_the_tool(tmp_path: Path) -> None:
    """工具分片已经在流里，但 complete() 没返回，run() 不会派发，也不会再请求一次。"""
    hits = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        hits["n"] += 1
        frame = {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call-1",
                                "function": {"name": "director_apply", "arguments": "{}"},
                            }
                        ]
                    }
                }
            ]
        }
        return httpx.Response(
            200,
            content=_sse([frame]),
            headers={"content-type": "text/event-stream"},
        )

    from dataclasses import asdict

    from novelvideo.director_desk.ai_host import Channel

    channel = Channel(
        id="p1",
        name="sharellm",
        protocol="chat",
        base_url=BASE,
        model="deepseek-v4.1-flash",
        max_tokens=64,
        key=SECRET,
    )
    transport = DirectorDeskToolTransport()
    service = DirectorDeskAiService(
        transport=transport,
        data_dir=tmp_path,
        load_profiles=lambda: [asdict(channel)],
        save_profiles=lambda _profiles: None,
        http_transport=httpx.MockTransport(handler),
    )
    service.set_contract(
        "node-1",
        ToolContract.from_payload(
            {
                "definitions": [
                    {"name": "director_read", "description": "r", "inputSchema": {"type": "object"}},
                    {"name": "director_apply", "description": "w", "inputSchema": {"type": "object"}},
                ],
                "discussion": [],
            }
        ),
    )
    session = transport.open_session("node-1")

    import asyncio

    task = asyncio.create_task(
        service.run(node_id="node-1", profile_id="p1", prompt="改场景")
    )
    dispatched: list[str] = []
    while not task.done():
        polled = await transport.poll("node-1", session.session_id, wait=0.2)
        for call in polled["calls"]:
            dispatched.append(call["name"])
            transport.submit_result("node-1", call["request_id"], {"ok": True, "data": {}})
    result = await task

    assert result["stopped"] is True
    assert hits["n"] == 1
    assert dispatched == ["director_read"]
    assert "director_apply" not in dispatched


async def test_http_4xx_is_not_retried() -> None:
    hits = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        hits["n"] += 1
        return httpx.Response(429, json={"error": "slow down"})

    with pytest.raises(ProviderError, match="API 请求失败") as caught:
        await complete(
            _profile(),  # type: ignore[arg-type]
            SECRET,
            "sys",
            [{"role": "user", "content": "hi"}],
            [],
            transport=httpx.MockTransport(handler),
        )

    assert hits["n"] == 1
    assert "已重试" not in str(caught.value)
    assert caught.value.retryable is False


async def test_retry_limit_message(caplog: pytest.LogCaptureFixture) -> None:
    hits = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        hits["n"] += 1
        return httpx.Response(200, content=b"", headers={"content-type": "text/event-stream"})

    caplog.set_level(logging.DEBUG)
    with pytest.raises(ProviderError, match=f"已重试 {STREAM_INTERRUPT_RETRIES} 次仍失败") as caught:
        await complete(
            _profile(),  # type: ignore[arg-type]
            SECRET,
            "sys",
            [{"role": "user", "content": "hi"}],
            [],
            transport=httpx.MockTransport(handler),
        )

    assert hits["n"] == STREAM_INTERRUPT_RETRIES + 1
    assert caught.value.retryable is False
    assert SECRET not in caplog.text


async def test_transport_error_after_a_text_delta_is_not_retryable() -> None:
    class _Cut:
        async def aiter_lines(self):
            yield 'data: {"choices":[{"delta":{"content":"半"}}]}'
            raise httpx.RemoteProtocolError("peer closed")

    with pytest.raises(ProviderError, match="连接中断") as caught:
        await _read_stream(_Cut(), "chat", lambda _t: None, lambda _k: None)  # type: ignore[arg-type]

    assert caught.value.retryable is False
