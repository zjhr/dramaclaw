from __future__ import annotations

import httpx
import pytest
import respx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo import config
from novelvideo.api.routes import model_gateway
from novelvideo.model_gateway_settings import (
    get_model_gateway_settings,
    save_custom_newapi_gateway,
    save_official_newapi_key,
    save_relayclaw_brainclaw_key,
)
from novelvideo.official_defaults import OFFICIAL_NEWAPI_BASE_URL


ENDPOINT = "/model-gateway/custom/brainclaw/models"
GATEWAY = "https://gateway.example/v1"
SECRET = "sk-discovery-test-secret"


@pytest.fixture
def discovery_client(monkeypatch, tmp_path):
    """只使用临时配置和模拟网关，不读取开发机上的真实凭据。"""
    monkeypatch.setattr(config, "STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")
    save_custom_newapi_gateway(base_url="http://local-media:3000", api_key="sk-media")
    save_relayclaw_brainclaw_key(base_url=GATEWAY, api_key=SECRET, model="saved-model")
    app = FastAPI()
    app.include_router(model_gateway.router)
    with TestClient(app) as client:
        yield client


@respx.mock
def test_discovery_uses_saved_key_and_does_not_save_configuration(discovery_client):
    route = respx.get(f"{GATEWAY}/models").respond(
        200,
        json={"data": [
            {"id": " provider/model "}, {"id": "provider/model"}, "other-model",
            {"id": ""}, {"id": "bad model"}, {"id": "x" * 257},
            {"id": "bad\x00model"}, {"id": 123}, None,
        ]},
    )
    before = get_model_gateway_settings()
    response = discovery_client.post(ENDPOINT, json={"newApiBaseUrl": GATEWAY + "/"})
    assert response.status_code == 200
    assert response.json() == {"ok": True, "data": {"models": ["provider/model", "other-model"]}}
    assert route.calls[0].request.headers["Authorization"] == f"Bearer {SECRET}"
    assert get_model_gateway_settings() == before
    assert SECRET not in response.text


@respx.mock
def test_discovery_uses_unsaved_endpoint_and_key(discovery_client):
    route = respx.get("http://127.0.0.1:8317/v1/models").respond(200, json={"data": []})
    before = get_model_gateway_settings()
    response = discovery_client.post(ENDPOINT, json={
        "newApiBaseUrl": "http://127.0.0.1:8317", "newApiApiKey": " sk-unsaved-key ",
    })
    assert response.status_code == 200
    assert response.json()["data"]["models"] == []
    assert route.calls[0].request.headers["Authorization"] == "Bearer sk-unsaved-key"
    assert get_model_gateway_settings() == before


@respx.mock
def test_discovery_does_not_send_saved_key_to_changed_endpoint(discovery_client):
    response = discovery_client.post(ENDPOINT, json={"newApiBaseUrl": "https://other.example/v1"})
    assert response.status_code == 400
    assert not respx.calls
    assert SECRET not in response.text


@respx.mock
def test_discovery_can_use_official_key_only_for_official_endpoint(discovery_client):
    save_official_newapi_key(api_key="sk-official-key")
    route = respx.get(f"{OFFICIAL_NEWAPI_BASE_URL}/models").respond(200, json={"data": []})
    response = discovery_client.post(ENDPOINT, json={"newApiBaseUrl": OFFICIAL_NEWAPI_BASE_URL})
    assert response.status_code == 200
    assert route.calls[0].request.headers["Authorization"] == "Bearer sk-official-key"
    assert "sk-official-key" not in response.text


@respx.mock
@pytest.mark.parametrize("url", ["", "file:///tmp/models", "https://user:pass@example.com", "https://example.com?key=secret", "https://example.com#fragment", "http://example.com:bad"])
def test_discovery_rejects_invalid_endpoints(discovery_client, url):
    response = discovery_client.post(ENDPOINT, json={"newApiBaseUrl": url, "newApiApiKey": SECRET})
    assert response.status_code == 400
    assert not respx.calls


@respx.mock
@pytest.mark.parametrize("status,body", [(401, {"error": SECRET}), (500, {"error": SECRET}), (200, {"unexpected": SECRET}), (302, {})])
def test_discovery_errors_are_secret_free_and_redirects_are_not_followed(discovery_client, status, body):
    route = respx.get(f"{GATEWAY}/models").respond(status, json=body, headers={"Location": "https://other.example/models"})
    response = discovery_client.post(ENDPOINT, json={})
    assert response.status_code == 502
    assert SECRET not in response.text
    assert route.call_count == len(respx.calls) == 1


@respx.mock
def test_discovery_timeout_is_secret_free(discovery_client):
    respx.get(f"{GATEWAY}/models").mock(side_effect=httpx.ReadTimeout(SECRET))
    response = discovery_client.post(ENDPOINT, json={})
    assert response.status_code == 504
    assert SECRET not in response.text


@respx.mock
def test_discovery_still_requires_ce_management(discovery_client, monkeypatch):
    monkeypatch.setenv("ST_EDITION", "ee")
    response = discovery_client.post(ENDPOINT, json={})
    assert response.status_code == 403
    assert not respx.calls
