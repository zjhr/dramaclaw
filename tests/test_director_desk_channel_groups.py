"""导演台 AI 面板的渠道列表：放开过滤 + 按能力分组。

主人报的 bug 是「我配置了那么多个都没有显示」。根因是 `load_profiles()` 里的
`provider.startswith("director-desk-")`：全局库里 14 条渠道只有 1 条带这个前缀，
其余 13 条全产品生产渠道（图片 / 视频 / 音频 / 文本）被一刀切掉，面板只剩 1 条。

这里钉住三件事：

1. **不再按前缀过滤**，只有真的用不了的（没有 ``baseUrl``、没有密钥）才排除。
2. **分组依据是设置库里主人自己写下的配置**，不是 provider 名字。名字是骗人的：
   同一个 ``https://yyds.chybenzun.top`` 上既有文本模型（``yyds``）也有图片模型
   （``yyds-image``）。
3. **明文密钥绝不进回包**，且导演台不得改写借来的生产渠道。

分组下拉的分组完整性由 `frontend/src/__tests__/features/canvas/` 之外的
`tests/test_director_desk_channel_groups.py::test_grouped_dropdown_has_no_empty_group`
从分组下拉的同一份数据形状上核对。
"""

from __future__ import annotations

import json
from typing import Any, Iterator

import pytest

from novelvideo.director_desk import ai_host
from novelvideo.director_desk.ai_host import (
    CHANNEL_KIND_ORDER,
    DirectorDeskAiService,
    ProfileError,
    channel_kind_index,
    load_profiles,
)
from novelvideo.director_desk.routes import profiles as profiles_route

SECRET = "sk-do-not-leak"

#: 全局库里那 14 条渠道的真实形状（`state/local/settings.db` 实测）。
#: 注意 ``yyds`` 与 ``yyds-image`` 指着同一个 baseUrl —— 名字分不了它们，
#: 能分开它们的是 ``custom_newapi_media_model_mappings`` 里的 provider 归属。
REAL_CHANNELS: list[dict[str, Any]] = [
    {"provider": "kuaileshifu", "baseUrl": "https://wisart.kuaileshifu.com"},
    {
        "provider": "director-desk-f1491a1d-cf79-4232-9593-118c97a86082",
        "baseUrl": "http://127.0.0.1:18780/v1",
        "settings": {
            "name": "T010 real gateway",
            "protocol": "chat",
            "model": "DC-cognee-LLM",
            "stream": True,
            "maxTokens": 0,
            "maxRounds": 64,
        },
    },
    {"provider": "elevenlabs", "baseUrl": "https://api.elevenlabs.io"},
    {"provider": "fal_ai", "baseUrl": "https://api.agnes-ai.cn"},
    {"provider": "image-mlgb7", "baseUrl": "https://image.mlgb7.com"},
    {"provider": "openai", "baseUrl": "https://yyds.chybenzun.top"},
    {"provider": "senseaudio", "baseUrl": "https://api.senseaudio.cn"},
    {"provider": "sharellm", "baseUrl": "https://sharellm.net"},
    # 空 baseUrl：siliconflow 走官方 API，导演台直连上游没有地址可用。
    {"provider": "siliconflow", "baseUrl": ""},
    {"provider": "stepfun", "baseUrl": "https://api.stepfun.com/step_plan"},
    {"provider": "yyds", "baseUrl": "https://yyds.chybenzun.top"},
    {"provider": "yyds-grokimage", "baseUrl": "https://yyds.chybenzun.top"},
    {"provider": "yyds-hunheimage", "baseUrl": "https://yyds.chybenzun.top"},
    {"provider": "yyds-image", "baseUrl": "https://yyds.chybenzun.top"},
]

#: 主人配的媒体模型映射（实测聚合结果，只保留 provider 与 mediaType 两列）。
REAL_MEDIA_MAPPINGS: dict[str, dict[str, str]] = {
    "gpt-image-2": {"provider": "image-mlgb7", "mediaType": "image"},
    "gemini-3.1-flash-image-sm": {"provider": "yyds-hunheimage", "mediaType": "image"},
    "grok-imagine": {"provider": "yyds-grokimage", "mediaType": "image"},
    "wisart": {"provider": "kuaileshifu", "mediaType": "image"},
    "agnes-video-2.5-flash": {"provider": "fal_ai", "mediaType": "video"},
    "eleven-tts": {"provider": "elevenlabs", "mediaType": "audio"},
    "sense-sfx": {"provider": "senseaudio", "mediaType": "audio"},
    "step-tts": {"provider": "stepfun", "mediaType": "audio"},
}


class _FakeSettings:
    """``runtime_settings`` 的内存替身（与 ``test_director_desk_channel_wizard.py`` 同范式）。"""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, **overrides: str) -> None:
        self.rows: dict[str, str] = {
            "custom_newapi_provider_channels": json.dumps(
                [
                    {
                        "provider": row["provider"],
                        "type": 1,
                        "upstreamKey": SECRET,
                        "baseUrl": row["baseUrl"],
                        "priority": 0,
                        "settings": row.get("settings", {}),
                    }
                    for row in REAL_CHANNELS
                ],
                ensure_ascii=False,
            ),
            "custom_newapi_media_model_mappings": json.dumps(REAL_MEDIA_MAPPINGS, ensure_ascii=False),
            **overrides,
        }
        monkeypatch.setattr(
            "novelvideo.model_gateway_settings._read_all", lambda: dict(self.rows)
        )
        monkeypatch.setattr(
            "novelvideo.model_gateway_settings._write_many",
            lambda values: self.rows.update({str(k): str(v) for k, v in values.items()}),
        )
        monkeypatch.setattr(
            "novelvideo.model_gateway_settings._uses_ce_gateway_settings", lambda: True
        )


@pytest.fixture
def store(monkeypatch: pytest.MonkeyPatch) -> Iterator[_FakeSettings]:
    fake = _FakeSettings(monkeypatch)
    yield fake
    ai_host.reset_ai_service_for_tests()


# ── 1. 放开过滤 ─────────────────────────────────────────────────────────────


def test_load_profiles_returns_borrowed_channels(store: _FakeSettings) -> None:
    """14 条里 13 条该出现：只剩那个空 baseUrl 的 siliconFlow 被排除。"""
    rows = load_profiles()
    providers = {row["provider"] for row in rows}

    assert len(rows) == 13
    assert "openai" in providers and "elevenlabs" in providers
    assert "image-mlgb7" in providers and "yyds-image" in providers
    # 主人报 bug 时面板上只有那一条导演台渠道。现在它是 13 条里的一条。
    assert "director-desk-f1491a1d-cf79-4232-9593-118c97a86082" in providers
    assert len([p for p in providers if not p.startswith(ai_host._CHANNEL_PREFIX)]) == 12


def test_channels_without_usable_destination_are_still_excluded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """没有 baseUrl 或没有密钥的渠道确实用不了，不能混进下拉。"""
    _FakeSettings(
        monkeypatch,
        custom_newapi_provider_channels=json.dumps(
            [
                {"provider": "no-url", "type": 1, "upstreamKey": SECRET, "baseUrl": ""},
                {"provider": "no-key", "type": 1, "upstreamKey": "", "baseUrl": "https://x.test"},
                {"provider": "fine", "type": 1, "upstreamKey": SECRET, "baseUrl": "https://x.test"},
            ]
        ),
    )

    assert [row["provider"] for row in load_profiles()] == ["fine"]


def test_profiles_route_returns_every_channel(store: _FakeSettings) -> None:
    ai_host._AI_SERVICE = DirectorDeskAiService()

    payload = profiles_route()

    assert len(payload["channels"]) == 13


# ── 2. 分组依据 ─────────────────────────────────────────────────────────────


def test_kind_comes_from_config_not_provider_names(store: _FakeSettings) -> None:
    """分类必须跟着 ``custom_newapi_media_model_mappings`` 走。"""
    assert channel_kind_index() == {
        "image-mlgb7": "image",
        "yyds-hunheimage": "image",
        "yyds-grokimage": "image",
        "kuaileshifu": "image",
        "fal_ai": "video",
        "elevenlabs": "audio",
        "senseaudio": "audio",
        "stepfun": "audio",
    }


def test_kind_follows_settings_when_provider_names_disagree(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """改配置就改分组 —— 证明规则读的是配置，而不是 ``if "image" in provider``。"""
    _FakeSettings(
        monkeypatch,
        custom_newapi_media_model_mappings=json.dumps(
            # `openai` 被配成图片渠道，`image-mlgb7` 被配成文本渠道 —— 与名字相反。
            {"gpt-image-2": {"provider": "openai", "mediaType": "image"}},
            ensure_ascii=False,
        ),
    )

    kinds = {row["provider"]: row["kind"] for row in load_profiles()}

    assert kinds["openai"] == "image"
    assert kinds["image-mlgb7"] == "text"


def test_same_base_url_splits_text_from_image(store: _FakeSettings) -> None:
    """``yyds`` 与 ``yyds-image`` 同址不同类 —— 名字分不了，配置能分。"""
    kinds = {row["provider"]: row["kind"] for row in load_profiles()}

    base_urls = {row["provider"]: row["base_url"] for row in load_profiles()}
    assert base_urls["yyds"] == base_urls["yyds-image"] == "https://yyds.chybenzun.top"
    assert kinds["yyds"] == "text"
    assert kinds["yyds-image"] == "text"


def test_embedding_provider_is_not_a_chat_channel(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """向量模型同样不能当对话用：被配置声明过就不能悄悄算成文本。"""
    _FakeSettings(
        monkeypatch,
        custom_newapi_embedding_model=json.dumps(
            {
                "provider": "sharellm",
                "upstreamModel": "Qwen3-Embedding-4B",
                "dimension": 1024,
            },
            ensure_ascii=False,
        ),
    )

    kinds = {row["provider"]: row["kind"] for row in load_profiles()}

    assert kinds["sharellm"] == "embedding"


def test_unconfigured_provider_defaults_to_text(store: _FakeSettings) -> None:
    """没有任何配置依据的 provider 按文本处理：宁可多列，不要猜成图片后藏起来。"""
    kinds = {row["provider"]: row["kind"] for row in load_profiles()}

    assert kinds["openai"] == "text"
    assert kinds["sharellm"] == "text"


# ── 3. 分组下拉的完整性 ──────────────────────────────────────────────────────


def test_grouped_dropdown_has_no_empty_group(store: _FakeSettings) -> None:
    """按 ``CHANNEL_KIND_ORDER`` 分组后，每组至少一条。

    与 ``ai-panel.ts`` 的 ``renderChannelOptions`` 是同一份规则（顺序取后端常量，
    空组不渲染）。前端那份按同一顺序实现，两边不一致时这条会先红。
    """
    grouped: dict[str, list[dict[str, Any]]] = {kind: [] for kind in CHANNEL_KIND_ORDER}
    for row in load_profiles():
        grouped.setdefault(row["kind"], []).append(row)

    assert all(grouped[kind] for kind in CHANNEL_KIND_ORDER), {
        kind: len(rows) for kind, rows in grouped.items()
    }
    assert sum(len(rows) for rows in grouped.values()) == 13


def test_dropdown_label_hides_internal_provider_id(store: _FakeSettings) -> None:
    """借来的渠道显示 provider 名，导演台自己的渠道不把 uuid 露出去。"""
    by_id = {row["id"]: row for row in load_profiles()}

    assert by_id["openai"]["name"] == "openai"
    assert by_id["elevenlabs"]["name"] == "elevenlabs"
    assert by_id["f1491a1d-cf79-4232-9593-118c97a86082"]["name"] == "T010 real gateway"
    assert not any("director-desk-" in row["name"] for row in load_profiles())


# ── 4. 密钥与写回 ───────────────────────────────────────────────────────────


def test_plaintext_key_never_reaches_the_response(store: _FakeSettings) -> None:
    """``/ai/profiles`` 的回包里没有明文密钥，也没有 provider 原名。"""
    ai_host._AI_SERVICE = DirectorDeskAiService()

    payload = profiles_route()
    raw = json.dumps(payload, ensure_ascii=False)

    assert SECRET not in raw
    assert payload["channels"][0]["hasKey"] is True
    for channel in payload["channels"]:
        assert "key" not in channel
        assert "provider" not in channel
        assert channel["kind"] in CHANNEL_KIND_ORDER


def test_configure_response_also_hides_the_key(store: _FakeSettings) -> None:
    ai_host._AI_SERVICE = DirectorDeskAiService()

    channels = ai_host._AI_SERVICE.configure(
        {
            "name": "本机导演台",
            "protocol": "chat",
            "baseUrl": "https://127.0.0.1:18780/v1",
            "model": "DC-cognee-LLM",
            "key": SECRET,
        }
    )

    assert SECRET not in json.dumps(channels, ensure_ascii=False)


def test_saving_does_not_rewrite_borrowed_production_channels(store: _FakeSettings) -> None:
    """导演台存一次自己的渠道，不得把借来的生产渠道覆盖成对话配置。"""
    service = DirectorDeskAiService()
    service.configure(
        {
            "name": "本机导演台",
            "protocol": "chat",
            "baseUrl": "https://127.0.0.1:18780/v1",
            "model": "DC-cognee-LLM",
            "key": SECRET,
        }
    )

    from novelvideo.model_gateway_settings import get_newapi_provider_channels

    saved = {row["provider"]: row for row in get_newapi_provider_channels()}
    # 借来的渠道一条不少、一字未改。
    assert len(saved) == 15
    assert saved["image-mlgb7"]["settings"] == {}
    assert saved["openai"]["settings"] == {}
    assert saved["elevenlabs"]["upstreamKey"] == SECRET


def test_borrowed_channel_cannot_be_deleted_from_the_panel(store: _FakeSettings) -> None:
    """在面板里删一条借来的渠道 = 砍掉主人整条上游，必须拦。"""
    service = DirectorDeskAiService()

    with pytest.raises(ProfileError):
        service.configure({"removeId": "openai"})

    from novelvideo.model_gateway_settings import get_newapi_provider_channels

    assert any(row["provider"] == "openai" for row in get_newapi_provider_channels())


def test_editing_a_borrowed_channel_keeps_its_provider(store: _FakeSettings) -> None:
    """改名不该让它退化成 ``director-desk-openai``，跟原渠道分裂成两条。"""
    service = DirectorDeskAiService()
    service.configure(
        {
            "id": "openai",
            "name": "我的对话网关",
            "protocol": "chat",
            "baseUrl": "https://yyds.chybenzun.top",
            "model": "gpt-4o",
            "key": SECRET,
        }
    )

    from novelvideo.model_gateway_settings import get_newapi_provider_channels

    providers = [row["provider"] for row in get_newapi_provider_channels()]
    assert "openai" in providers
    assert "director-desk-openai" not in providers