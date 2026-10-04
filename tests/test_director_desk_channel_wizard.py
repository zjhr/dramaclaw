"""导演台 AI 面板的「极简新建渠道」向导。

覆盖三件面板真正依赖的事：

1. 按「接口地址 + 密钥」直连上游拉回模型列表（不经 NewAPI 网关 ——
   导演台的渠道本来就是直连调模型的，让查列表也依赖网关会把门槛从「填两栏」
   抬成「先配好网关」）。
2. 拉不通时给用户看得懂的**中文**提示，不泄漏 httpx 异常类型或 stack trace。
3. 建出来的渠道真的进了全局 ``get_newapi_provider_channels()``，且明文密钥
   只留在后端（回包里只有 ``hasKey``）。

端点按真函数直接调（与 `tests/test_director_desk_mcp_tools.py` 同一范式）：
HTTP 层换成 ``httpx.MockTransport``，settings 库换成内存字典，其余走生产代码。
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Iterator

import httpx
import pytest
from fastapi import HTTPException

from novelvideo.director_desk import ai_host
from novelvideo.director_desk.ai_host import (
    DirectorDeskAiService,
    ProviderError,
    guess_protocol,
    models_endpoint,
)
from novelvideo.director_desk.routes import (
    ChannelModelsRequest,
    QuickChannelRequest,
    channel_models,
    channel_quick_create,
)

ROUTES_SOURCE = (
    Path(__file__).resolve().parents[1] / "src/novelvideo/director_desk/routes.py"
).read_text(encoding="utf-8")

BASE_URL = "https://api.deepseek.com/v1"
SECRET = "sk-do-not-leak"


def asyncio_run(awaitable: Any) -> Any:
    return asyncio.run(awaitable)


# ── 替身 ────────────────────────────────────────────────────────────────────


class _FakeSettings:
    """``runtime_settings`` 的内存替身。

    导演台渠道搭的是全局 settings 库（`save_profiles` 走
    ``save_newapi_provider_channels``），要证明「建完真的落进去了」就得让
    ``get_model_gateway_settings()`` 读到我们写的东西 —— 打桩整个保存函数
    等于把要验证的那半段也一起打桩掉了。
    """

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.rows: dict[str, str] = {}
        monkeypatch.setattr(
            "novelvideo.model_gateway_settings._read_all", lambda: dict(self.rows)
        )
        monkeypatch.setattr(
            "novelvideo.model_gateway_settings._write_many", self._write_many
        )
        monkeypatch.setattr(
            "novelvideo.model_gateway_settings._uses_ce_gateway_settings", lambda: True
        )

    def _write_many(self, values: dict[str, str]) -> None:
        self.rows.update({str(k): str(v) for k, v in values.items()})

    def channels(self) -> list[dict[str, Any]]:
        from novelvideo.model_gateway_settings import get_newapi_provider_channels

        return get_newapi_provider_channels()


@pytest.fixture
def settings_store(monkeypatch: pytest.MonkeyPatch) -> Iterator[_FakeSettings]:
    store = _FakeSettings(monkeypatch)
    yield store
    ai_host.reset_ai_service_for_tests()


def install_service(
    handler: Any, *, load: Any = None, save: Any = None
) -> DirectorDeskAiService:
    """把进程级单例换成带 MockTransport 的服务，端点因此走生产链路。

    默认**不**注入 load/save —— 要验的正是「渠道落进了全局 settings 库」，把保存
    打桩掉等于把要验证的那半段一起打桩掉了。
    """
    ai_host.reset_ai_service_for_tests()
    service = DirectorDeskAiService(
        http_transport=httpx.MockTransport(handler),
        **({"load_profiles": load} if load else {}),
        **({"save_profiles": save} if save else {}),
    )
    ai_host._AI_SERVICE = service
    return service


def models_body(*ids: str) -> dict[str, Any]:
    return {"object": "list", "data": [{"id": name, "object": "model"} for name in ids]}


def respond(status: int, payload: Any) -> Any:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=payload)

    return handler


def raises(exc: Exception) -> Any:
    def handler(request: httpx.Request) -> httpx.Response:
        raise exc

    return handler


def failure_from(call: Any) -> HTTPException:
    with pytest.raises(HTTPException) as caught:
        call()
    return caught.value


# ── 地址与协议 ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("base", "expected"),
    [
        ("https://api.deepseek.com/v1", "https://api.deepseek.com/v1/models"),
        ("https://api.deepseek.com/v1/", "https://api.deepseek.com/v1/models"),
        ("https://api.deepseek.com/v1/models", "https://api.deepseek.com/v1/models"),
    ],
)
def test_models_endpoint_appends_only_when_missing(base: str, expected: str) -> None:
    assert models_endpoint(base) == expected


@pytest.mark.parametrize(
    ("base", "protocol"),
    [
        ("https://api.deepseek.com/v1", "chat"),
        ("https://api.openai.com/v1", "chat"),
        ("https://api.anthropic.com/v1", "anthropic"),
    ],
)
def test_guess_protocol_needs_no_user_choice(base: str, protocol: str) -> None:
    assert guess_protocol(base) == protocol


# ── 第 2 步：拉模型列表 ─────────────────────────────────────────────────────


def test_channel_models_returns_fetched_list() -> None:
    install_service(respond(200, models_body("deepseek-chat", "deepseek-reasoner")))

    result = asyncio_run(channel_models(ChannelModelsRequest(baseUrl=BASE_URL, key=SECRET)))

    assert result["models"] == ["deepseek-chat", "deepseek-reasoner"]


def test_channel_models_dedupes_and_sorts() -> None:
    install_service(respond(200, models_body("zeta", "alpha", "alpha")))

    result = asyncio_run(channel_models(ChannelModelsRequest(baseUrl=BASE_URL, key=SECRET)))

    assert result["models"] == ["alpha", "zeta"]


def test_channel_models_reads_ollama_style_shape() -> None:
    """Ollama / 部分网关回 ``{models:[{name}]}``，不该被判成「看不懂」。"""
    install_service(respond(200, {"models": [{"name": "qwen2.5"}, {"name": "llama3"}]}))

    result = asyncio_run(channel_models(ChannelModelsRequest(baseUrl=BASE_URL, key=SECRET)))

    assert result["models"] == ["llama3", "qwen2.5"]


def test_channel_models_probes_the_models_endpoint_with_the_key() -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization", "")
        return httpx.Response(200, json=models_body("m"))

    install_service(handler)
    asyncio_run(channel_models(ChannelModelsRequest(baseUrl=BASE_URL, key=SECRET)))

    assert seen["url"] == "https://api.deepseek.com/v1/models"
    assert seen["auth"] == f"Bearer {SECRET}"


def test_channel_models_uses_anthropic_header_on_anthropic_host() -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["api_key"] = request.headers.get("x-api-key", "")
        seen["version"] = request.headers.get("anthropic-version", "")
        return httpx.Response(200, json={"data": [{"id": "claude-opus-5"}]})

    install_service(handler)
    result = asyncio_run(
        channel_models(ChannelModelsRequest(baseUrl="https://api.anthropic.com/v1", key=SECRET))
    )

    assert result["models"] == ["claude-opus-5"]
    assert seen["api_key"] == SECRET
    assert seen["version"] == "2023-06-01"


def test_channel_models_does_not_touch_the_settings_store(settings_store: _FakeSettings) -> None:
    """试拉列表是**只读**的：问模型名不该顺手写一条渠道进全局库。"""
    install_service(respond(200, models_body("m")))

    asyncio_run(channel_models(ChannelModelsRequest(baseUrl=BASE_URL, key=SECRET)))

    assert settings_store.channels() == []


# ── 第 2 步的失败：每一条都得说人话 ────────────────────────────────────────


@pytest.mark.parametrize(
    ("handler", "needle"),
    [
        (respond(401, {"error": "invalid api key"}), "密钥"),
        (respond(403, {"error": "forbidden"}), "密钥"),
        (respond(404, {"error": "not found"}), "/v1"),
        (respond(500, {"error": "boom"}), "服务商"),
        (respond(200, {"data": []}), "模型"),
        (respond(200, {"error": "not a model list"}), "模型"),
        (raises(httpx.ConnectError("connection refused")), "连不上"),
        (raises(httpx.ReadTimeout("slow")), "超时"),
    ],
)
def test_channel_models_failures_are_readable_chinese(
    settings_store: _FakeSettings, handler: Any, needle: str
) -> None:
    install_service(handler)

    failure = failure_from(
        lambda: asyncio_run(channel_models(ChannelModelsRequest(baseUrl=BASE_URL, key=SECRET)))
    )

    assert failure.status_code in (400, 502)
    detail = str(failure.detail)
    assert needle in detail
    assert "Traceback" not in detail
    for leaked in ("httpx.", "HTTPStatusError", "ConnectError", "ReadTimeout", "newapi"):
        assert leaked not in detail


def test_channel_models_reports_a_non_json_reply_as_not_a_model_list(
    settings_store: _FakeSettings,
) -> None:
    """填成网页首页地址是新手最常见的错 —— 说清楚「这不是模型列表」。"""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html>hello</html>")

    install_service(handler)

    failure = failure_from(
        lambda: asyncio_run(channel_models(ChannelModelsRequest(baseUrl=BASE_URL, key=SECRET)))
    )

    assert failure.status_code == 502
    assert "不是模型列表" in str(failure.detail)


def test_channel_models_requires_a_key(settings_store: _FakeSettings) -> None:
    install_service(respond(200, models_body("m")))

    failure = failure_from(
        lambda: asyncio_run(channel_models(ChannelModelsRequest(baseUrl=BASE_URL, key="  ")))
    )

    assert failure.status_code == 400
    assert "密钥" in str(failure.detail)


def test_channel_models_requires_a_usable_address(settings_store: _FakeSettings) -> None:
    install_service(respond(200, models_body("m")))

    failure = failure_from(
        lambda: asyncio_run(
            channel_models(ChannelModelsRequest(baseUrl="http://api.example.com/v1", key=SECRET))
        )
    )

    assert failure.status_code == 400
    assert "HTTPS" in str(failure.detail)


def test_channel_models_error_never_echoes_the_key(settings_store: _FakeSettings) -> None:
    install_service(respond(401, {"error": "invalid api key"}))

    failure = failure_from(
        lambda: asyncio_run(channel_models(ChannelModelsRequest(baseUrl=BASE_URL, key=SECRET)))
    )

    assert SECRET not in str(failure.detail)


# ── 第 4 步：建渠道 ────────────────────────────────────────────────────────


def test_quick_channel_lands_in_the_global_provider_channels(
    settings_store: _FakeSettings,
) -> None:
    install_service(respond(200, models_body("deepseek-chat")))

    result = channel_quick_create(
        QuickChannelRequest(baseUrl=BASE_URL, key=SECRET, model="deepseek-chat")
    )

    stored = settings_store.channels()
    assert len(stored) == 1
    assert stored[0]["provider"] == f"director-desk-{result['channelId']}"
    assert stored[0]["upstreamKey"] == SECRET
    assert stored[0]["baseUrl"] == BASE_URL
    assert stored[0]["settings"]["model"] == "deepseek-chat"


def test_quick_channel_response_exposes_only_has_key(settings_store: _FakeSettings) -> None:
    install_service(respond(200, models_body("deepseek-chat")))

    result = channel_quick_create(
        QuickChannelRequest(baseUrl=BASE_URL, key=SECRET, model="deepseek-chat")
    )

    serialized = json.dumps(result, ensure_ascii=False)
    assert SECRET not in serialized
    assert result["channels"][0]["hasKey"] is True
    assert "key" not in result["channels"][0]
    assert result["channels"][0]["remembered"] is True


def test_quick_channel_names_itself_after_the_host(settings_store: _FakeSettings) -> None:
    """向导只问地址与密钥；渠道名默认取主机名，不该再多问一栏。"""
    install_service(respond(200, models_body("m")))

    result = channel_quick_create(
        QuickChannelRequest(baseUrl=BASE_URL, key=SECRET, model="m")
    )

    assert result["channels"][0]["name"] == "api.deepseek.com"


def test_quick_channel_picks_the_anthropic_protocol_for_anthropic_hosts(
    settings_store: _FakeSettings,
) -> None:
    install_service(respond(200, {"data": [{"id": "claude-opus-5"}]}))

    channel_quick_create(
        QuickChannelRequest(
            baseUrl="https://api.anthropic.com/v1", key=SECRET, model="claude-opus-5"
        )
    )

    assert settings_store.channels()[0]["settings"]["protocol"] == "anthropic"


def test_quick_channel_keeps_unrelated_providers(settings_store: _FakeSettings) -> None:
    """导演台渠道只是搭全局 provider channel 的便车，不能把用户配好的其它渠道抹掉。"""
    from novelvideo.model_gateway_settings import save_newapi_provider_channels

    save_newapi_provider_channels(
        [{"provider": "deepseek", "type": 1, "upstreamKey": "sk-existing", "baseUrl": BASE_URL}]
    )
    install_service(respond(200, models_body("m")))

    channel_quick_create(QuickChannelRequest(baseUrl=BASE_URL, key=SECRET, model="m"))

    providers = {channel["provider"] for channel in settings_store.channels()}
    assert "deepseek" in providers
    assert any(p.startswith("director-desk-") for p in providers)


def test_quick_channel_returns_the_new_channel_id(settings_store: _FakeSettings) -> None:
    install_service(respond(200, models_body("m")))

    first = channel_quick_create(QuickChannelRequest(baseUrl=BASE_URL, key=SECRET, model="m"))
    second = channel_quick_create(
        QuickChannelRequest(baseUrl="https://api.openai.com/v1", key="sk-2", model="gpt-4o")
    )

    assert first["channelId"]
    assert second["channelId"]
    assert first["channelId"] != second["channelId"]
    assert {c["id"] for c in second["channels"]} >= {first["channelId"], second["channelId"]}


@pytest.mark.parametrize(
    ("payload", "needle"),
    [
        (QuickChannelRequest(baseUrl=BASE_URL, key="", model="m"), "密钥"),
        (QuickChannelRequest(baseUrl=BASE_URL, key=SECRET, model="  "), "模型"),
        (QuickChannelRequest(baseUrl="not-a-url", key=SECRET, model="m"), "地址"),
        (QuickChannelRequest(baseUrl="http://api.example.com/v1", key=SECRET, model="m"), "HTTPS"),
    ],
)
def test_quick_channel_rejects_incomplete_input_without_writing(
    settings_store: _FakeSettings, payload: QuickChannelRequest, needle: str
) -> None:
    install_service(respond(200, models_body("m")))

    failure = failure_from(lambda: channel_quick_create(payload))

    assert failure.status_code == 400
    assert needle in str(failure.detail)
    assert settings_store.channels() == []


def test_quick_channel_refuses_while_a_task_is_running(settings_store: _FakeSettings) -> None:
    """改渠道会让在途任务的模型凭空换掉 —— 与 `configure` 同一把锁。"""
    service = install_service(respond(200, models_body("m")))
    service._running["other"] = ai_host.AbortToken()

    failure = failure_from(
        lambda: channel_quick_create(QuickChannelRequest(baseUrl=BASE_URL, key=SECRET, model="m"))
    )

    assert failure.status_code == 400
    assert "停止" in str(failure.detail)


# ── 面板文案口径 ────────────────────────────────────────────────────────────


def test_routes_module_does_not_leak_gateway_jargon_into_the_panel() -> None:
    """向导的两个端点只说「地址 / 密钥 / 模型」。"""
    wizard_block = ROUTES_SOURCE.split("class ChannelModelsRequest", 1)[1]
    for jargon in ("newapi", "NewAPI", "provider-channels", "channel-types"):
        assert jargon not in wizard_block


def test_wizard_endpoints_take_no_node_id() -> None:
    """渠道是全局的 —— 两个端点的请求体里都没有 nodeId。"""
    assert "nodeId" not in ChannelModelsRequest.model_fields
    assert "nodeId" not in QuickChannelRequest.model_fields


def test_fetch_models_surfaces_provider_errors_as_provider_errors(
    settings_store: _FakeSettings,
) -> None:
    """服务层直调时抛的也是可读异常，不是 httpx 异常。"""
    service = install_service(respond(500, {"error": "boom"}))

    with pytest.raises(ProviderError) as caught:
        asyncio_run(service.fetch_models(BASE_URL, SECRET))

    assert "服务商" in str(caught.value)
    assert SECRET not in str(caught.value)