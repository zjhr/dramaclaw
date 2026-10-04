"""接口地址的「多候选」策略。

## 为什么要多候选

同一种 OpenAI 兼容服务，主人填的接口地址有的带 ``/v1`` 有的不带：

- ``https://api.deepseek.com/v1`` —— ``/models`` 挂在 ``/v1/models``
- ``https://sharellm.net`` —— ``/models`` 挂在 ``/v1/models``，而 ``/models`` 那一层
  会被上游的防护挡成 **403**（实测：Cloudflare 的 "Just a moment..."）

只按「填了什么就拼什么」实现，后一条会被显示成「密钥不对」—— 而密钥是对的，主人
会去反复换密钥，永远修不好。挨个候选试、第一个通的算数，才是对的那件事。

覆盖：

1. 候选**集合**对不对（尤其不该出现 ``/v1/v1``、不该把 ``/models`` 再拼一层）。
2. 第一条不通时会不会**真的**退到下一条，并把模型读回来。
3. 全不通时，错误里有没有**每个候选的实测状态码**。
4. 明文密钥不出现在任何回给前端的字串里（错误文案是最容易漏的一条）。
5. ``complete`` / ``automatic_output_limit`` 用的是同一套候选，且探测缓存会随策略
   一起失效（否则修好之后还得等满一小时）。
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Iterator

import httpx
import pytest

from novelvideo.director_desk import ai_host
from novelvideo.director_desk.ai_host import (
    _METADATA_CACHE,
    _METADATA_CACHE_VERSION,
    Channel,
    ProviderError,
    automatic_output_limit,
    complete,
    endpoint_candidates,
    fetch_channel_models,
    metadata_candidates,
    models_endpoint,
    models_endpoint_candidates,
)

#: 主人库里真实存在的那个地址：带 ``/v1`` 的与不带 ``/v1`` 的都在用。
BARE = "https://sharellm.net"
WITH_V1 = "https://api.deepseek.com/v1"
SECRET = "sk-do-not-leak-2f8a"


def asyncio_run(awaitable: Any) -> Any:
    return asyncio.run(awaitable)


def shown(url: str) -> str:
    """错误文案里的地址形状：去掉 ``https://``（见 ai_host 的 ``_short_url``）。"""
    return url.split("://", 1)[-1]


def chat(base_url: str, **overrides: Any) -> Channel:
    defaults: dict[str, Any] = {
        "id": "p1",
        "name": "测试渠道",
        "protocol": "chat",
        "base_url": base_url,
        "model": "model-x",
        "max_tokens": 4096,
        "key": SECRET,
    }
    return Channel(**{**defaults, **overrides})


def models_body(*ids: str) -> dict[str, Any]:
    return {"object": "list", "data": [{"id": name, "object": "model"} for name in ids]}


class _Recorder:
    """记下每一次真实请求的 URL，好断言「到底试了哪几个」。"""

    def __init__(self, respond_with: Any) -> None:
        self.urls: list[str] = []
        self._respond_with = respond_with

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.urls.append(str(request.url))
        return self._respond_with(request)

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)


@pytest.fixture(autouse=True)
def _clean_metadata_cache() -> Iterator[None]:
    """探测缓存是模块级的，跨用例留着会让「只打一次」这类断言变得不可信。"""
    _METADATA_CACHE.clear()
    yield
    _METADATA_CACHE.clear()


# ── 候选集合 ────────────────────────────────────────────────────────────────


def test_bare_base_gets_a_v1_fallback_candidate() -> None:
    """不带 ``/v1`` 的地址必须有一个 ``/v1/models`` 候选（这就是 bug1 的修法）。"""
    candidates = models_endpoint_candidates(BARE)

    assert f"{BARE}/v1/models" in candidates
    # 先按主人填的字面试：猜错只多一次 403，而结果按渠道缓存 15 分钟。
    assert candidates == [f"{BARE}/models", f"{BARE}/v1/models"]


def test_base_that_already_has_v1_never_gets_v1_v1() -> None:
    candidates = (
        *models_endpoint_candidates(WITH_V1),
        *endpoint_candidates(chat(WITH_V1)),
        *metadata_candidates(WITH_V1, "model-x"),
    )

    assert set(candidates) == {
        f"{WITH_V1}/models",
        f"{WITH_V1}/chat/completions",
        f"{WITH_V1}/models/model-x",
    }
    assert not any("/v1/v1" in url for url in candidates), candidates


def test_base_that_already_is_models_is_used_as_is() -> None:
    base = "https://api.example.com/v1/models"

    assert models_endpoint_candidates(base) == [base]
    assert models_endpoint(base) == base


def test_trailing_slash_is_normalized() -> None:
    assert models_endpoint_candidates(f"{WITH_V1}/") == [f"{WITH_V1}/models"]


def test_a_full_endpoint_is_never_rewritten() -> None:
    full = "https://api.example.com/v1/chat/completions"

    assert endpoint_candidates(chat(full)) == [full]


def test_metadata_candidates_try_the_model_before_the_list() -> None:
    """单模型详情里的上限字段最全，列表里常常只有一个 ``context_length``。"""
    candidates = metadata_candidates(BARE, "glm-5.3-flash")

    assert candidates[0] == f"{BARE}/models/glm-5.3-flash"
    assert candidates[1] == f"{BARE}/v1/models/glm-5.3-flash"
    assert f"{BARE}/v1/models" in candidates
    # 模型名要转义：有的模型 id 带斜杠，不转义会打到另一个地址上。
    assert f"{WITH_V1}/models/org%2Fmodel" in metadata_candidates(WITH_V1, "org/model")


def test_models_endpoint_returns_the_first_candidate() -> None:
    """单地址版保持原语义，给「就想要一个地址」的调用方用。"""

    assert models_endpoint(BARE) == f"{BARE}/models"
    assert models_endpoint(WITH_V1) == f"{WITH_V1}/models"


# ── 真的退到下一个候选 ──────────────────────────────────────────────────────


def test_bare_base_falls_back_to_v1_and_returns_models() -> None:
    """bug1 的验收形状：不带 ``/v1`` 的地址，403 之后退到 ``/v1`` 读回模型。"""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/models":
            return httpx.Response(200, json=models_body("glm-5.3-flash", "gpt-6.1-sol"))
        return httpx.Response(403, text="Just a moment...")

    recorder = _Recorder(handler)
    models = asyncio_run(fetch_channel_models(BARE, SECRET, transport=recorder.transport))

    assert models == ["glm-5.3-flash", "gpt-6.1-sol"]
    assert recorder.urls == [f"{BARE}/models", f"{BARE}/v1/models"]


def test_a_working_first_candidate_costs_exactly_one_request() -> None:
    """猜对了就停：不能为了「稳妥」把每条渠道的每次探测都打成两倍。"""
    recorder = _Recorder(lambda request: httpx.Response(200, json=models_body("m")))

    asyncio_run(fetch_channel_models(WITH_V1, SECRET, transport=recorder.transport))

    assert recorder.urls == [f"{WITH_V1}/models"]


def test_a_200_that_is_not_a_model_list_also_falls_through() -> None:
    """网关首页回 200 + HTML 是常见形态，不能当成「这个渠道没有模型」。"""
    recorder = _Recorder(
        lambda request: httpx.Response(200, json={"error": "not a model list"})
        if request.url.path == "/models"
        else httpx.Response(200, json=models_body("m"))
    )

    models = asyncio_run(fetch_channel_models(BARE, SECRET, transport=recorder.transport))

    assert models == ["m"]
    assert recorder.urls == [f"{BARE}/models", f"{BARE}/v1/models"]


# ── 失败时要说人话 ──────────────────────────────────────────────────────────


def test_failure_names_every_candidate_and_its_status() -> None:
    """只丢一个 403 等于让主人猜 —— 是密钥错还是地址少写了一层。"""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404 if request.url.path == "/models" else 403)

    with pytest.raises(ProviderError) as caught:
        asyncio_run(fetch_channel_models(BARE, SECRET, transport=httpx.MockTransport(handler)))

    message = str(caught.value)
    assert f"{shown(BARE)}/models → 404" in message
    assert f"{shown(BARE)}/v1/models → 403" in message
    assert "/v1" in message


def test_a_key_rejected_by_every_candidate_says_so() -> None:
    """全是鉴权失败时，结论要明确落在密钥上，而不是含糊地说「读不到」。"""
    recorder = _Recorder(lambda request: httpx.Response(401, json={"error": "bad key"}))

    with pytest.raises(ProviderError) as caught:
        asyncio_run(fetch_channel_models(BARE, SECRET, transport=recorder.transport))

    assert "密钥" in str(caught.value)
    assert len(recorder.urls) == 2


def test_a_server_error_is_not_blamed_on_the_key() -> None:
    recorder = _Recorder(lambda request: httpx.Response(503, text="upstream down"))

    with pytest.raises(ProviderError) as caught:
        asyncio_run(fetch_channel_models(WITH_V1, SECRET, transport=recorder.transport))

    assert "服务商" in str(caught.value)


def test_a_timeout_on_every_candidate_is_reported_as_a_timeout() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(ProviderError) as caught:
        asyncio_run(fetch_channel_models(BARE, SECRET, transport=httpx.MockTransport(handler)))

    assert "超时" in str(caught.value)


def test_a_refused_connection_names_the_address() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    with pytest.raises(ProviderError) as caught:
        asyncio_run(fetch_channel_models(BARE, SECRET, transport=httpx.MockTransport(handler)))

    assert "连不上" in str(caught.value)
    assert shown(BARE) in str(caught.value)


# ── 密钥不出后端 ────────────────────────────────────────────────────────────


def test_no_failure_message_ever_carries_the_key() -> None:
    """错误文案是唯一一条能把密钥带去「用户看得见的地方」的路径。"""
    for status in (401, 403, 404, 500, 502):
        for payload in ({"error": "x"}, {"data": []}, {"data": "not a list"}):
            recorder = _Recorder(lambda request: httpx.Response(status, json=payload))
            with pytest.raises(ProviderError) as caught:
                asyncio_run(fetch_channel_models(BARE, SECRET, transport=recorder.transport))
            assert SECRET not in str(caught.value), (status, payload)


def test_the_key_is_only_ever_sent_as_a_header() -> None:
    """顺带钉住：密钥不进 URL —— 进 URL 就会被网关日志、代理和浏览器历史记下来。"""
    recorder = _Recorder(lambda request: httpx.Response(200, json=models_body("m")))

    asyncio_run(fetch_channel_models(BARE, SECRET, transport=recorder.transport))

    assert all(SECRET not in url for url in recorder.urls)


# ── complete 与 complete 的发消息地址 ──────────────────────────────────────


def test_complete_falls_back_to_the_v1_endpoint() -> None:
    """bug2：不带 ``/v1`` 的渠道，发消息也必须能落到 ``/v1/chat/completions``。"""
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/chat/completions":
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]},
            )
        return httpx.Response(403, text="Just a moment...")

    recorder = _Recorder(handler)
    result = asyncio_run(
        complete(
            chat(BARE), SECRET, "sys", [{"role": "user", "content": "hi"}], [],
            stream=False, transport=recorder.transport,
        )
    )

    assert result["text"] == "ok"
    assert recorder.urls == [f"{BARE}/chat/completions", f"{BARE}/v1/chat/completions"]


def test_complete_does_not_retry_a_server_error() -> None:
    """5xx 说明地址是对的：再打一遍只是把同一个失败放大成两次，还多烧一次额度。"""
    recorder = _Recorder(lambda request: httpx.Response(503, text="upstream down"))

    with pytest.raises(ProviderError):
        asyncio_run(
            complete(
                chat(BARE), SECRET, "sys", [{"role": "user", "content": "hi"}], [],
                stream=False, transport=recorder.transport,
            )
        )

    assert recorder.urls == [f"{BARE}/chat/completions"]


def test_complete_failure_names_both_attempts_and_no_key() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404 if request.url.path.endswith("/chat/completions") and not request.url.path.startswith("/v1") else 401)

    with pytest.raises(ProviderError) as caught:
        asyncio_run(
            complete(
                chat(BARE), SECRET, "sys", [{"role": "user", "content": "hi"}], [],
                stream=False, transport=httpx.MockTransport(handler),
            )
        )

    message = str(caught.value)
    assert f"{shown(BARE)}/chat/completions → 404" in message
    assert f"{shown(BARE)}/v1/chat/completions → 401" in message
    assert SECRET not in message


# ── 输出上限探测 ────────────────────────────────────────────────────────────


def test_output_limit_probe_reaches_the_v1_candidate() -> None:
    """bug2 的另一半：``automatic_output_limit`` 之前只试 ``{base}/models/...``。"""
    recorder = _Recorder(
        lambda request: httpx.Response(
            200, json={"id": "model-x", "max_output_tokens": 65536}
        )
        if request.url.path == "/v1/models/model-x"
        else httpx.Response(403, text="Just a moment...")
    )

    limit = asyncio_run(
        automatic_output_limit(chat(BARE, max_tokens=0), SECRET, transport=recorder.transport)
    )

    assert limit == 65536
    assert recorder.urls == [f"{BARE}/models/model-x", f"{BARE}/v1/models/model-x"]


def test_the_metadata_cache_key_carries_the_strategy_version() -> None:
    """策略一改就必须让旧条目失效。

    键不带版本的话，修好之前那次「探测不到 → 上限 None」的坏结果还会被当成命中，
    主人修好地址后仍要白等一小时。版本号进键 = 旧条目自然作废，不用手动清。

    这里直接往缓存里塞一条**旧版本**的坏结果，再探测一次：它必须不被读到。
    """
    import hashlib

    import time

    stale_key = json.dumps(
        [
            _METADATA_CACHE_VERSION - 1,
            BARE,
            "chat",
            "model-x",
            hashlib.sha256(SECRET.encode("utf-8")).hexdigest(),
        ],
        separators=(",", ":"),
    )
    _METADATA_CACHE[stale_key] = (time.time(), None, "")
    recorder = _Recorder(
        lambda request: httpx.Response(200, json={"id": "model-x", "max_output_tokens": 4096})
        if request.url.path == "/v1/models/model-x"
        else httpx.Response(404)
    )

    limit = asyncio_run(
        automatic_output_limit(chat(BARE, max_tokens=0), SECRET, transport=recorder.transport)
    )

    assert limit == 4096, "旧版本的坏缓存被当成了命中"
    assert recorder.urls, "读到了旧版本条目就不会再打上游"
    assert _METADATA_CACHE[stale_key][1] is None, "旧条目应留在原地等它被挤出，而不是被改写"


def test_the_metadata_cache_still_short_circuits_within_one_strategy() -> None:
    """缓存本身没坏：同一策略下第二次不该再打上游。"""
    recorder = _Recorder(
        lambda request: httpx.Response(200, json={"id": "model-x", "max_output_tokens": 4096})
    )
    profile = chat(BARE, max_tokens=0)

    first = asyncio_run(automatic_output_limit(profile, SECRET, transport=recorder.transport))
    hits = len(recorder.urls)
    second = asyncio_run(automatic_output_limit(profile, SECRET, transport=recorder.transport))

    assert first == second == 4096
    assert len(recorder.urls) == hits, "第二次不该再打上游"


def test_the_metadata_cache_records_which_candidate_won() -> None:
    """记下命中的地址，排查时一眼能看出主人填的是哪一类地址。"""
    recorder = _Recorder(
        lambda request: httpx.Response(200, json={"id": "model-x", "max_output_tokens": 4096})
        if request.url.path == "/v1/models/model-x"
        else httpx.Response(404)
    )

    asyncio_run(automatic_output_limit(chat(BARE, max_tokens=0), SECRET, transport=recorder.transport))

    assert [entry[2] for entry in _METADATA_CACHE.values()] == [f"{BARE}/v1/models/model-x"]
    assert _METADATA_CACHE_VERSION >= 2


# ── 路由层：脱敏的形状没有被这次改动碰到 ────────────────────────────────────


def test_the_route_layer_still_never_echoes_the_key() -> None:
    """``/ai/profile-models`` 走的是这条链路，密钥从头到尾不该出现在回包里。"""
    from novelvideo.director_desk.routes import ProfileModelsRequest, profile_models

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=models_body("m"))

    ai_host.reset_ai_service_for_tests()
    service = ai_host.DirectorDeskAiService(
        http_transport=httpx.MockTransport(handler),
        load_profiles=lambda: [
            {
                "id": "sharellm", "name": "sharellm", "protocol": "chat",
                "base_url": BARE, "model": "m", "key": SECRET,
            }
        ],
        save_profiles=lambda rows: None,
    )
    ai_host._AI_SERVICE = service
    try:
        payload = asyncio_run(profile_models(ProfileModelsRequest(profileId="sharellm")))
        assert payload == {"profileId": "sharellm", "models": ["m"]}
        assert SECRET not in json.dumps(payload, ensure_ascii=False)
    finally:
        ai_host.reset_ai_service_for_tests()
