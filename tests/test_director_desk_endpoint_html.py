"""「网关首页被当成 API 接受」这条路径的回归测试。

背景：有的网关把官网挂在根路径、真正的 OpenAI 兼容接口在 ``/v1``（实测
``yyds.chybenzun.top`` 就是这样）。拼错的那一层回的是 **200 + text/html**，
不是 403/404 —— 于是 ``endpoint_candidates`` 认定「第一个候选通了」，拿着
HTML 去解 SSE，得到空流，报错是 ``stream dropped before body``。症状看着像
模型或网络坏了，真正的原因藏在更早一层：地址少写了一层。
"""

from __future__ import annotations

import httpx
import pytest

from novelvideo.director_desk.ai_host import (
    _is_html,
    complete,
    endpoint_candidates,
    root_url_candidates,
)

HTML_PAGE = "<!doctype html><html><head><title>AI API Gateway</title></head></html>"


class _Stream:
    """只够请求循环用到的响应替身。"""

    def __init__(self, headers: dict[str, str], body: bytes, status_code: int = 200) -> None:
        self.headers = headers
        self.status_code = status_code
        self._body = body

    async def aread(self) -> bytes:
        return self._body

    async def aiter_lines(self):  # noqa: ANN201 - 测试替身
        for line in self._body.decode().splitlines():
            yield line


class _Ctx:
    def __init__(self, response: _Stream) -> None:
        self._response = response

    async def __aenter__(self) -> _Stream:
        return self._response

    async def __aexit__(self, *_exc: object) -> None:
        return None


def _fake_stream(status: int, headers: dict[str, str], body: bytes) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, content=body, headers=headers)

    return httpx.MockTransport(handler)


class _StreamClient:
    """让 ``client.stream(...)`` 返回可 ``aread`` 的替身。"""

    def __init__(self, status: int, headers: dict[str, str], body: bytes) -> None:
        self._response = _Stream(headers, body)

    def stream(self, *_a: object, **_kw: object) -> _Ctx:
        return _Ctx(self._response)


def test_is_html_only_flags_html() -> None:
    for content_type in ("text/html", "text/html; charset=utf-8"):
        response = httpx.Response(200, headers={"content-type": content_type})
        assert _is_html(response) is True, content_type
    for content_type in ("application/json", "text/event-stream", "application/x-ndjson"):
        response = httpx.Response(200, headers={"content-type": content_type})
        assert _is_html(response) is False, content_type


def test_missing_content_type_is_treated_as_api() -> None:
    """没写 content-type 的接口不能被误杀 —— 误杀会让人以为地址错了。"""
    assert _is_html(httpx.Response(200, headers={})) is False


def test_root_candidates_keep_both_spellings() -> None:
    assert root_url_candidates("https://gw.example") == [
        "https://gw.example",
        "https://gw.example/v1",
    ]
    assert root_url_candidates("https://gw.example/v1") == ["https://gw.example/v1"]


def test_endpoint_candidates_try_filled_then_v1() -> None:
    from novelvideo.director_desk.ai_host import Channel

    profile = Channel(
        id="p1",
        name="openai",
        protocol="chat",
        base_url="https://gw.example",
        model="m",
        max_tokens=8,
        key="k",
    )
    assert endpoint_candidates(profile) == [
        "https://gw.example/chat/completions",
        "https://gw.example/v1/chat/completions",
    ]


@pytest.mark.asyncio
async def test_html_first_candidate_falls_through_to_v1(monkeypatch: pytest.MonkeyPatch) -> None:
    """第一个候选回 HTML 时，必须换到 /v1 那个，而不是拿 HTML 去解 SSE。"""
    import novelvideo.director_desk.ai_host as module

    seen: list[str] = []

    class _Client:
        def __init__(self, **_kw: object) -> None:
            pass

        async def __aenter__(self) -> "_Client":
            return self

        async def __aexit__(self, *_exc: object) -> None:
            return None

        def stream(self, _method: str, url: str, **_kw: object):
            seen.append(url)
            if "/v1/" in url:
                # chat 协议要等 finish_reason 才算收完（见 _StreamReader.raw）。
                body = (
                    b'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n'
                    b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
                    b"data: [DONE]\n\n"
                )
                return _Ctx(
                    _Stream({"content-type": "text/event-stream"}, body)
                )
            return _Ctx(
                _Stream({"content-type": "text/html; charset=utf-8"}, HTML_PAGE.encode())
            )

    monkeypatch.setattr(module.httpx, "AsyncClient", lambda **_kw: _Client())

    profile = module.validate_profile(
        {
            "protocol": "chat",
            "baseUrl": "https://gw.example",
            "model": "m",
            "name": "openai",
            "maxTokens": 8,
            "stream": True,
        }
    )
    result = await complete(profile, "k", "sys", [{"role": "user", "content": "hi"}], [])

    assert seen == [
        "https://gw.example/chat/completions",
        "https://gw.example/v1/chat/completions",
    ], "HTML 响应没有触发换候选"
    assert result["text"] == "ok"