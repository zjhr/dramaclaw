"""导演台 AI 面板的「选渠道 → 选模型」。

主人报的 bug 是「选择渠道没有选择模型」：13 条渠道里只有 ``T010 real gateway``
一个带模型名，其余 12 条只显示渠道名。根因是这些是**网关型渠道** —— 一条渠道后面
挂着一堆模型，``settings`` 整个是 ``{}``，模型那一格本来就空着，而导演台只能显示
``settings.model``。

这里钉住四件事：

1. **能按渠道 id 读到它的上游模型列表**（密钥不出后端）。
2. **列表按渠道缓存**，切换渠道不重复打上游；换密钥自动失效。
3. **选中的模型存下来并生效**（``/ai/run`` 用它），存在导演台自己的目录里。
4. **选模型绝不能改写生产渠道** —— 尤其不能抹掉 ``type``（``elevenlabs=65`` 这些）。

第 4 条是这份测试存在的最主要理由：写回全局 settings 必须经过 ``save_profiles``，
而那条路带 ``"type": 0``，一次选模型就能静默弄坏整条生产链。
"""

from __future__ import annotations

import json
from typing import Any, Iterator

import httpx
import pytest

from novelvideo.director_desk import ai_host
from novelvideo.director_desk.ai_host import (
    DirectorDeskAiService,
    ProviderError,
)
from novelvideo.director_desk.routes import (
    ProfileModelsRequest,
    SelectModelRequest,
    profile_model as profile_model_route,
    profile_models as profile_models_route,
)

SECRET = "sk-do-not-leak"

#: 主人真实库里那 12 条网关型渠道的形状（``settings`` 整个是 ``{}``，实测）。
#: ``type`` 的取值就是那些「类型标记」：elevenlabs=65 / fal_ai=61 / senseaudio=64 /
#: siliconflow=40 / 其余多为 1 —— 写回时一旦变成 0，整条链静默损坏。
GATEWAY_CHANNELS: list[dict[str, Any]] = [
    {"provider": "openai", "type": 1, "baseUrl": "https://yyds.chybenzun.top"},
    {"provider": "sharellm", "type": 1, "baseUrl": "https://sharellm.net"},
    {"provider": "image-mlgb7", "type": 1, "baseUrl": "https://image.mlgb7.com"},
    {"provider": "elevenlabs", "type": 65, "baseUrl": "https://api.elevenlabs.io"},
    {"provider": "fal_ai", "type": 61, "baseUrl": "https://api.agnes-ai.cn"},
    {"provider": "senseaudio", "type": 64, "baseUrl": "https://api.senseaudio.cn"},
    {
        "provider": "director-desk-t010",
        "type": 0,
        "baseUrl": "http://127.0.0.1:18780/v1",
        # 唯一一条本来就带模型名的：导演台自己建的渠道。
        "settings": {"name": "T010 real gateway", "protocol": "chat", "model": "DC-cognee-LLM"},
    },
]

UPSTREAM_MODELS = ["DC-cognee-LLM", "gpt-4o-mini", "qwen3-max"]


class _FakeSettings:
    """``runtime_settings`` 的内存替身（与 ``test_director_desk_channel_groups.py`` 同范式）。"""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, **overrides: str) -> None:
        self.rows: dict[str, str] = {
            "custom_newapi_provider_channels": json.dumps(
                [
                    {
                        "provider": row["provider"],
                        "type": row["type"],
                        "upstreamKey": SECRET,
                        "baseUrl": row["baseUrl"],
                        "priority": 0,
                        "settings": row.get("settings", {}),
                    }
                    for row in GATEWAY_CHANNELS
                ],
                ensure_ascii=False,
            ),
            "custom_newapi_media_model_mappings": json.dumps(
                {"gpt-image-2": {"provider": "image-mlgb7", "mediaType": "image"}},
                ensure_ascii=False,
            ),
            **overrides,
        }
        self.writes: list[dict[str, str]] = []
        monkeypatch.setattr(
            "novelvideo.model_gateway_settings._read_all", lambda: dict(self.rows)
        )
        monkeypatch.setattr(
            "novelvideo.model_gateway_settings._write_many",
            lambda values: (
                self.writes.append(dict(values)),
                self.rows.update({str(k): str(v) for k, v in values.items()}),
            )[1],
        )
        monkeypatch.setattr(
            "novelvideo.model_gateway_settings._uses_ce_gateway_settings", lambda: True
        )


class _FakeUpstream:
    """上游 ``/models`` 的 httpx 替身，顺带记录被打了多少次。"""

    def __init__(self, payload: Any = None, status: int = 200) -> None:
        self.payload = (
            payload if payload is not None else {"data": [{"id": m} for m in UPSTREAM_MODELS]}
        )
        self.status = status
        self.calls: list[str] = []

    def transport(self) -> httpx.MockTransport:
        def handler(request: httpx.Request) -> httpx.Response:
            self.calls.append(str(request.url))
            return httpx.Response(self.status, json=self.payload)

        return httpx.MockTransport(handler)


def _upstream(payload: Any = None, status: int = 200) -> _FakeUpstream:
    return _FakeUpstream(payload, status)


@pytest.fixture
def store(monkeypatch: pytest.MonkeyPatch) -> Iterator[_FakeSettings]:
    fake = _FakeSettings(monkeypatch)
    yield fake
    ai_host.reset_ai_service_for_tests()


@pytest.fixture
def service(store: _FakeSettings, tmp_path: Any) -> DirectorDeskAiService:
    return DirectorDeskAiService(data_dir=tmp_path, http_transport=_upstream().transport())


# ── 1. 按渠道 id 读模型列表 ─────────────────────────────────────────────────


async def test_list_models_uses_the_channels_own_key(
    service: DirectorDeskAiService, store: _FakeSettings
) -> None:
    """12 条网关型渠道里随便一条都能读出模型列表 —— 请求不带用户敲的密钥，用渠道自己那条。"""
    models = await service.list_models("openai")

    assert models == UPSTREAM_MODELS
    # 只回模型 ID，不回密钥。
    assert SECRET not in json.dumps(models, ensure_ascii=False)


async def test_list_models_route_returns_ids_only(
    service: DirectorDeskAiService, store: _FakeSettings
) -> None:
    """路由层：请求体不接受密钥，回包里也没有。"""
    ai_host._AI_SERVICE = service

    payload = await profile_models_route(ProfileModelsRequest(profileId="openai"))

    assert payload["profileId"] == "openai"
    assert payload["models"] == UPSTREAM_MODELS
    assert SECRET not in json.dumps(payload, ensure_ascii=False)
    # 端点不接受密钥字段：多传一个也会被 pydantic 丢掉，而不是被存下来。
    payload = await profile_models_route(
        ProfileModelsRequest(profileId="openai", refresh=True, key=SECRET)  # type: ignore[call-arg]
    )
    assert SECRET not in json.dumps(payload, ensure_ascii=False)


async def test_unknown_channel_is_a_readable_error(
    service: DirectorDeskAiService, store: _FakeSettings
) -> None:
    from novelvideo.director_desk.ai_host import ProfileError

    with pytest.raises(ProfileError):
        await service.list_models("nope")


# ── 2. 缓存 ─────────────────────────────────────────────────────────────────


async def test_models_are_cached_per_channel(store: _FakeSettings, tmp_path: Any) -> None:
    """来回切渠道不该重复打上游 —— 用户在渠道下拉上会切很多次。"""
    http = _upstream()
    service = DirectorDeskAiService(data_dir=tmp_path, http_transport=http.transport())

    await service.list_models("openai")
    await service.list_models("openai")
    await service.list_models("openai")

    assert len(http.calls) == 1
    assert http.calls[0] == "https://yyds.chybenzun.top/models"


async def test_refresh_bypasses_the_cache(store: _FakeSettings, tmp_path: Any) -> None:
    """面板上的「刷新列表」必须真的重拉一次，否则新上的模型永远看不见。"""
    http = _upstream()
    service = DirectorDeskAiService(data_dir=tmp_path, http_transport=http.transport())

    await service.list_models("openai")
    await service.list_models("openai", refresh=True)

    assert len(http.calls) == 2


async def test_cache_expires(store: _FakeSettings, tmp_path: Any) -> None:
    """TTL 到了就重拉。缓存不是永久的。"""
    http = _upstream()
    service = DirectorDeskAiService(data_dir=tmp_path, http_transport=http.transport())

    await service.list_models("openai")
    service._model_cache = {
        key: (value[0] - ai_host.MODEL_CACHE_TTL_SECONDS - 1.0, value[1])
        for key, value in service._model_cache.items()
    }
    await service.list_models("openai")

    assert len(http.calls) == 2


async def test_cache_key_covers_the_key(store: _FakeSettings, tmp_path: Any) -> None:
    """换过密钥的渠道不该命中旧列表 —— 指纹进缓存键。"""
    http = _upstream()
    service = DirectorDeskAiService(data_dir=tmp_path, http_transport=http.transport())
    await service.list_models("openai")

    service._profiles = [ai_host.replace(c, key="sk-rotated") for c in service._profiles]
    await service.list_models("openai")

    assert len(http.calls) == 2


# ── 3. 选中的模型存下来并生效 ───────────────────────────────────────────────


def test_selected_model_reaches_the_channel_list(
    service: DirectorDeskAiService, store: _FakeSettings
) -> None:
    """选完之后下拉里那条渠道要显示「渠道名 · 模型」。"""
    channels = service.select_model("openai", "qwen3-max")

    picked = next(c for c in channels if c["id"] == "openai")
    assert picked["model"] == "qwen3-max"
    assert service._channel("openai").model == "qwen3-max"


def test_selected_model_survives_a_restart(store: _FakeSettings, tmp_path: Any) -> None:
    """存了就要真的存下来：换一个 service 实例（= 重启后）仍然记得。"""
    DirectorDeskAiService(data_dir=tmp_path).select_model("openai", "qwen3-max")

    reborn = DirectorDeskAiService(data_dir=tmp_path)

    assert reborn._channel("openai").model == "qwen3-max"


def test_selected_model_is_what_run_uses(
    service: DirectorDeskAiService, store: _FakeSettings
) -> None:
    """``/ai/run`` 走的渠道必须带着选中的模型 —— 空模型会让上游直接拒。

    :meth:`DirectorDeskAiService.run` 解析渠道的那一步就是 ``_channel(profile_id)``，
    所以「``_channel`` 拿到的 model 非空且等于选中的那个」就是「run 用的是它」。
    """
    service.select_model("openai", "qwen3-max")

    channel = service._channel("openai")

    assert channel.model == "qwen3-max"
    assert service._profiles[0].model in {"", "qwen3-max"}
    # 空模型是真的会打出去的（``request_body`` 直接取 ``profile.model``），
    # 所以这条断言钉住的是「run 之前它已经被填上了」，而不是「填不填都行」。
    assert (
        ai_host.request_body(
            channel, "hi", [{"role": "user", "content": "hi"}], [], 0, False
        )["model"]
        == "qwen3-max"
    )


def test_select_model_route_keeps_the_key_hidden(
    service: DirectorDeskAiService, store: _FakeSettings
) -> None:
    ai_host._AI_SERVICE = service

    payload = profile_model_route(SelectModelRequest(profileId="openai", model="gpt-4o-mini"))

    assert SECRET not in json.dumps(payload, ensure_ascii=False)
    assert next(c for c in payload["channels"] if c["id"] == "openai")["model"] == "gpt-4o-mini"


def test_empty_model_is_rejected(service: DirectorDeskAiService, store: _FakeSettings) -> None:
    from novelvideo.director_desk.ai_host import ProfileError

    with pytest.raises(ProfileError):
        service.select_model("openai", "   ")


# ── 4. 选模型不得改写生产渠道 ───────────────────────────────────────────────


def test_selecting_a_model_never_writes_the_gateway_store(
    service: DirectorDeskAiService, store: _FakeSettings
) -> None:
    """**这条是本文件的核心。**

    选一次模型之后，全局 settings 库里那 6 条渠道的每一个字段都必须逐字节不变 ——
    ``type`` 尤其（``elevenlabs=65`` / ``fal_ai=61`` / ``senseaudio=64``）。
    """
    before = json.loads(store.rows["custom_newapi_provider_channels"])

    service.select_model("openai", "qwen3-max")
    service.select_model("elevenlabs", "eleven-tts")

    after = json.loads(store.rows["custom_newapi_provider_channels"])
    assert after == before
    # 一次写都没有发生 —— 不是「写了同样的值」，是根本没走那条路。
    assert store.writes == []


def test_type_markers_survive(store: _FakeSettings, tmp_path: Any) -> None:
    """逐条核对类型标记。导演台的覆盖表存在自己的目录里，与 settings 库无关。"""
    service = DirectorDeskAiService(data_dir=tmp_path)
    for provider, model in (
        ("openai", "qwen3-max"),
        ("sharellm", "qwen3-max"),
        ("image-mlgb7", "gpt-image-2"),
        ("elevenlabs", "eleven-tts"),
        ("fal_ai", "agnes-video"),
        ("senseaudio", "sense-sfx"),
    ):
        service.select_model(provider, model)

    from novelvideo.model_gateway_settings import get_newapi_provider_channels

    saved = {row["provider"]: row for row in get_newapi_provider_channels()}

    assert saved["elevenlabs"]["type"] == 65
    assert saved["fal_ai"]["type"] == 61
    assert saved["senseaudio"]["type"] == 64
    assert saved["openai"]["type"] == 1
    # 生产渠道的 settings 仍然是空的 —— 导演台的模型选择没有渗进去。
    assert saved["openai"]["settings"] == {}
    assert saved["elevenlabs"]["settings"] == {}
    # 密钥与地址也一个字没动。
    assert saved["openai"]["upstreamKey"] == SECRET
    assert saved["openai"]["baseUrl"] == "https://yyds.chybenzun.top"


def test_override_never_overwrites_a_settings_supplied_model(
    store: _FakeSettings, tmp_path: Any
) -> None:
    """``T010 real gateway`` 的模型是设置库里带来的，覆盖表不该把它冲掉。"""
    reborn = DirectorDeskAiService(data_dir=tmp_path)
    reborn.select_model("openai", "qwen3-max")

    again = DirectorDeskAiService(data_dir=tmp_path)

    assert again._channel("t010").model == "DC-cognee-LLM"


def test_unwritable_data_dir_is_reported(store: _FakeSettings, tmp_path: Any) -> None:
    """存不住必须说出来 —— 静默失败会让用户以为已经固定了模型。"""
    from novelvideo.director_desk.ai_host import ProfileError

    blocked = tmp_path / "blocked"
    blocked.mkdir()
    blocked.chmod(0o500)
    service = DirectorDeskAiService(data_dir=blocked)
    try:
        with pytest.raises(ProfileError):
            service.select_model("openai", "qwen3-max")
    finally:
        blocked.chmod(0o700)


async def test_upstream_failure_is_surfaced_as_502(store: _FakeSettings, tmp_path: Any) -> None:
    """拉不到模型要说出来，不能静默给一个空下拉。"""
    from fastapi import HTTPException

    service = DirectorDeskAiService(data_dir=tmp_path, http_transport=_upstream(status=401).transport())
    ai_host._AI_SERVICE = service

    with pytest.raises(HTTPException) as raised:
        await profile_models_route(ProfileModelsRequest(profileId="openai"))

    assert raised.value.status_code == 502
    assert "密钥" in str(raised.value.detail)


async def test_provider_error_is_not_swallowed(store: _FakeSettings, tmp_path: Any) -> None:
    service = DirectorDeskAiService(data_dir=tmp_path, http_transport=_upstream(status=401).transport())

    with pytest.raises(ProviderError):
        await service.list_models("openai")