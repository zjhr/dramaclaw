# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab

"""提示词画廊 AI 搜索路由契约。"""

from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from novelvideo.api.auth import get_api_user
from novelvideo.api.routes import prompt_gallery


def _client(*, authenticated: bool = True) -> TestClient:
    app = FastAPI()
    app.include_router(prompt_gallery.router, prefix="/api/v1")

    if authenticated:
        app.dependency_overrides[get_api_user] = lambda: {
            "id": "user-alice",
            "username": "alice",
        }
    else:

        def reject_request():
            raise HTTPException(
                status_code=401, detail="Missing session or agent token"
            )

        app.dependency_overrides[get_api_user] = reject_request

    return TestClient(app)


def test_ai_search_requires_authentication():
    with _client(authenticated=False) as client:
        response = client.post(
            "/api/v1/prompt-gallery/ai-search",
            json={"query": "雨夜里的赛博朋克城市追逐", "media_kind": "video"},
        )

    assert response.status_code == 401
    assert response.json() == {
        "detail": "Missing session or agent token",
    }


def test_ai_search_validates_request_and_returns_response_envelope(
    monkeypatch: pytest.MonkeyPatch,
):
    seen: dict[str, str] = {}

    async def fake_expand(query: str, *, media_kind: str = ""):
        seen["query"] = query
        seen["media_kind"] = media_kind
        return {
            "terms": ["rainy night chase"],
            "tags": ["cinematic"],
            "strategy": "ai",
        }

    monkeypatch.setattr(prompt_gallery, "expand_prompt_search", fake_expand)

    with _client() as client:
        response = client.post(
            "/api/v1/prompt-gallery/ai-search",
            json={"query": "  雨夜追逐  ", "media_kind": "video"},
        )
        invalid = client.post(
            "/api/v1/prompt-gallery/ai-search",
            json={"query": "", "media_kind": "audio"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "data": {
            "terms": ["rainy night chase"],
            "tags": ["cinematic"],
            "strategy": "ai",
        },
    }
    assert seen == {"query": "  雨夜追逐  ", "media_kind": "video"}
    assert invalid.status_code == 422
