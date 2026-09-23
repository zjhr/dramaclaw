"""Phase 1 后端垂直切片：ShotRecipe 持久化 + 最小 REST API。

断言三件事（Judge 要求）：
a. 失败版本只追加新行，父版本行永不重写；
b. version 记录字段齐全：parent_version_id / prompt_delta / model_snapshot / cost_ledger；
c. 模型能力目录取不到时 model_snapshot.capabilities_known=false，不得伪装成已支持。
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo.api.deps import ProjectResolution
from novelvideo.api.routes import shot_recipes as shot_recipes_route
from novelvideo.freezone import shot_recipe_store as store

RECIPE = "recipe_demo01"


@pytest.fixture()
def client(monkeypatch, tmp_path):
    from novelvideo.api.auth import get_api_user

    state_dir = tmp_path / "state"
    state_dir.mkdir(parents=True, exist_ok=True)

    ctx = SimpleNamespace(
        project_id="proj_demo",
        owner_username="alice",
        project_name="demo",
        output_dir=str(state_dir),
        state_dir=str(state_dir),
        runtime_dir=str(state_dir / "_runtime"),
        requester_user_id="u-alice",
    )

    async def fake_resolve(project, user, *, required_role="viewer", media_read=False):
        del project, user, required_role, media_read
        return ProjectResolution(
            ctx=ctx,
            username="alice",
            project_name="demo",
            project_dir=state_dir,
            output_dir=str(state_dir),
            state_dir=str(state_dir),
            runtime_dir=str(state_dir / "_runtime"),
        )

    monkeypatch.setattr(shot_recipes_route, "resolve_project_scope", fake_resolve)

    app = FastAPI()
    app.include_router(shot_recipes_route.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: {"id": "u-alice", "username": "alice"}
    return TestClient(app), state_dir


def _fake_quote_port(monkeypatch, *, total_cost: int = 42, raises: bool = False) -> None:
    """Stand in for the real credit_quote port (registered by app bootstrap)."""
    import novelvideo.ports as ports
    from novelvideo.ports.credit_quote import CreditQuote

    class FakeQuote:
        async def generation_credit_quote(self, **kwargs):
            if raises:
                raise RuntimeError("quote backend down")
            return CreditQuote(
                total_cost=total_cost,
                display=str(total_cost),
                unit="call",
                unit_cost=total_cost,
                quantity=int(kwargs.get("quantity") or 1),
            )

    monkeypatch.setattr(ports, "get_credit_quote", lambda: FakeQuote())


def _create(client: TestClient, **body) -> dict:
    response = client.post(
        "/api/v1/projects/proj_demo/shot-recipes",
        json={"recipe_id": RECIPE, **body},
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]


def _append_version(client: TestClient, **body) -> tuple[int, dict]:
    response = client.post(
        f"/api/v1/projects/proj_demo/shot-recipes/{RECIPE}/versions",
        json={"duration_seconds": 5, **body},
    )
    return response.status_code, response.json()


def _get(client: TestClient) -> dict:
    response = client.get(f"/api/v1/projects/proj_demo/shot-recipes/{RECIPE}")
    assert response.status_code == 200, response.text
    return response.json()["data"]


def _recipe_file(state_dir, recipe_id: str = RECIPE):
    return store.shot_recipe_path(state_dir, recipe_id)


def _identity(**kwargs):
    from novelvideo.models import CharacterIdentity

    return CharacterIdentity(
        identity_id=kwargs.pop("identity_id", "谢铮_皇帝"),
        character_name=kwargs.pop("character_name", "谢铮"),
        identity_name=kwargs.pop("identity_name", "皇帝"),
        **kwargs,
    )


def _character(name: str, identities: list):
    from novelvideo.models import NovelCharacter

    return NovelCharacter(
        name=name,
        identities_json=json.dumps([item.model_dump() for item in identities]),
    )


def _use_identity_library(monkeypatch, characters, *, unavailable: bool = False) -> None:
    """替换角色库读取 seam：让 identity 解析逻辑可测，不依赖真实 SQLite 数据。"""
    from novelvideo.api.routes import characters as characters_route

    @asynccontextmanager
    async def fake_scope(project, user, *, required_role="editor", load_graph_state=True):
        del project, user, required_role, load_graph_state
        if unavailable:
            raise RuntimeError("character library unavailable")

        class FakeStore:
            async def list_characters(self):
                return list(characters)

        yield (None, "alice", "demo", None, None, FakeStore())

    monkeypatch.setattr(characters_route, "_character_project_scope", fake_scope)


def _bind_look_decision(test_client: TestClient, **body) -> tuple[int, dict]:
    response = test_client.post(
        f"/api/v1/projects/proj_demo/shot-recipes/{RECIPE}/look-decisions",
        json=body,
    )
    return response.status_code, response.json()


# --------------------------------------------------------------------------
# (b) 字段齐全：建配方 → 绑定造型决策 → 追加版本 → 读回完整溯源
# --------------------------------------------------------------------------


def test_version_records_carry_full_lineage_fields(client, monkeypatch) -> None:
    _fake_quote_port(monkeypatch)
    _use_identity_library(
        monkeypatch, [_character("谢铮", [_identity(identity_id="谢铮_皇帝")])]
    )
    test_client, _state_dir = client
    _create(test_client, title="镜头 1", canvas_id="canvas_a", node_id="node_1")

    first = test_client.post(
        f"/api/v1/projects/proj_demo/shot-recipes/{RECIPE}/look-decisions",
        json={
            "identity_id": "谢铮_皇帝",
            "character_name": "谢铮",
            "overrides": {"face_prompt": "冷峻", "costume_image": "/uploads/robe.png"},
            "source_refs": {"canvas_id": "canvas_a", "node_id": "node_1"},
        },
    )
    assert first.status_code == 200, first.text
    decision = first.json()["data"]
    assert decision["identity_id"] == "谢铮_皇帝"
    assert set(decision["overrides"]) == {"face_prompt", "costume_image"}

    status, v1 = _append_version(
        test_client,
        prompt="皇帝登基，俯拍",
        status="completed",
        model_id="",
        look_decision_ids=[decision["decision_id"]],
        source_refs={"job_id": "job_1"},
    )
    assert status == 200, v1

    status, v2 = _append_version(
        test_client,
        parent_version_id=v1["data"]["version_id"],
        prompt="皇帝登基，仰拍",
        changes={"camera": "low_angle"},
        status="draft",
    )
    assert status == 200, v2

    recipe = _get(test_client)
    assert recipe["recipe"]["recipe_id"] == RECIPE
    assert len(recipe["look_decisions"]) == 1

    versions = {record["version_id"]: record for record in recipe["versions"]}
    assert set(versions) == {"v1", "v2"}

    first_version = versions["v1"]
    assert first_version["parent_version_id"] is None
    assert first_version["prompt_delta"]["mode"] == "full"
    assert first_version["prompt_delta"]["prompt"] == "皇帝登基，俯拍"
    assert first_version["model_snapshot"]["capabilities_known"] is False
    assert first_version["cost_ledger"]["quoted"] is True
    assert first_version["cost_ledger"]["total_cost"] == 42
    assert first_version["cost_ledger"]["source"] == "generation_credit_quote"
    assert first_version["status"] == "completed"
    assert first_version["source_refs"] == {"job_id": "job_1"}
    assert first_version["look_decision_ids"] == [decision["decision_id"]]
    assert first_version["recorded_at"]
    assert first_version["lineage"] == ["v1"]

    second_version = versions["v2"]
    assert second_version["parent_version_id"] == "v1"
    assert second_version["prompt_delta"]["mode"] == "delta"
    assert second_version["prompt_delta"]["changes"] == {"camera": "low_angle"}
    assert second_version["lineage"] == ["v1", "v2"]

    listed = test_client.get("/api/v1/projects/proj_demo/shot-recipes")
    assert listed.status_code == 200
    assert [item["recipe_id"] for item in listed.json()["data"]] == [RECIPE]


def test_version_record_is_the_single_schema_owner(client) -> None:
    """缺字段的构造会被 store 拒绝——版本字段是硬契约，不是可选装饰。"""
    with pytest.raises(ValueError):
        store.build_version_record(
            version_id="v1",
            parent_version_id=None,
            prompt_delta=store.build_prompt_delta(prompt="p", has_parent=False),
            model_snapshot=store.build_model_snapshot(),
            cost_ledger=store.build_cost_ledger(),
            status="not_a_status",
        )


# --------------------------------------------------------------------------
# (a) 失败版本不覆盖父版本
# --------------------------------------------------------------------------


def test_failed_version_appends_and_never_rewrites_parent(client) -> None:
    test_client, state_dir = client
    _create(test_client)

    _status, v1 = _append_version(test_client, prompt="第一版", status="completed")
    parent_id = v1["data"]["version_id"]

    path = _recipe_file(state_dir)
    before_lines = path.read_text(encoding="utf-8").splitlines()
    parent_line_before = next(
        line for line in before_lines if f'"version_id":"{parent_id}"' in line
    )

    status, failed = _append_version(
        test_client,
        parent_version_id=parent_id,
        prompt="重拍失败",
        status="failed",
    )
    assert status == 200, failed
    assert failed["data"]["status"] == "failed"
    assert failed["data"]["parent_version_id"] == parent_id

    after_lines = path.read_text(encoding="utf-8").splitlines()
    # 只多了一行：失败版本是追加，不是重写
    assert len(after_lines) == len(before_lines) + 1
    # 父版本那一行逐字节未变
    assert parent_line_before in after_lines
    assert json.loads(parent_line_before)["status"] == "completed"

    versions = _get(test_client)["versions"]
    assert [record["status"] for record in versions] == ["completed", "failed"]
    assert versions[0]["status"] == "completed"
    assert versions[1]["parent_version_id"] == parent_id

    # 追加式墓碑：删除失败版本也不改写任何历史行
    response = test_client.delete(
        f"/api/v1/projects/proj_demo/shot-recipes/{RECIPE}/versions/{failed['data']['version_id']}"
    )
    assert response.status_code == 200, response.text
    tombstoned = path.read_text(encoding="utf-8").splitlines()
    assert parent_line_before in tombstoned
    remaining = _get(test_client)["versions"]
    assert [record["status"] for record in remaining] == ["completed"]


def test_unknown_parent_version_is_rejected(client) -> None:
    test_client, _state_dir = client
    _create(test_client)
    status, body = _append_version(
        test_client, parent_version_id="v99", prompt="x", status="draft"
    )
    assert status == 400
    assert "parent_version_id" in body["detail"]


# --------------------------------------------------------------------------
# (c) 能力不可得 → capabilities_known=false
# --------------------------------------------------------------------------


def test_capabilities_unknown_marks_capabilities_known_false(client, monkeypatch) -> None:
    from novelvideo.api.routes import freezone

    async def no_catalog(media_type, *, requester_user_id):
        del media_type, requester_user_id
        return None

    monkeypatch.setattr(freezone, "_scoped_media_model_catalog", no_catalog)

    test_client, _state_dir = client
    _create(test_client)
    status, body = _append_version(
        test_client, prompt="模型不可见", model_id="ghost-model", status="draft"
    )
    assert status == 200, body

    snapshot = body["data"]["model_snapshot"]
    assert snapshot["capabilities_known"] is False
    assert snapshot["model_id"] == "ghost-model"
    assert snapshot["maxDuration"] is None
    assert snapshot["minDuration"] is None
    assert snapshot["supportedModes"] == []
    assert snapshot["resolutionOptions"] == []
    assert snapshot["referenceImageMax"] is None


def test_capabilities_known_freezes_catalog_subset(client, monkeypatch) -> None:
    from novelvideo.api.routes import freezone

    entry = {
        "catalogId": "video_x",
        "id": "video_x",
        "apiModel": "video_x",
        "minDuration": 2,
        "maxDuration": 12,
        "referenceImageMax": 4,
        "supportedModes": ["text_to_video", "image_to_video"],
        "resolutionOptions": ["720p", "1080p"],
    }

    async def fake_catalog(media_type, *, requester_user_id):
        del media_type, requester_user_id
        return [entry]

    monkeypatch.setattr(freezone, "_scoped_media_model_catalog", fake_catalog)

    test_client, _state_dir = client
    _create(test_client)
    status, body = _append_version(
        test_client, prompt="能力已知", model_id="video_x", status="ready"
    )
    assert status == 200, body

    snapshot = body["data"]["model_snapshot"]
    assert snapshot["capabilities_known"] is True
    assert snapshot["catalog_id"] == "video_x"
    assert snapshot["maxDuration"] == 12
    assert snapshot["referenceImageMax"] == 4
    assert snapshot["supportedModes"] == ["text_to_video", "image_to_video"]
    assert snapshot["resolutionOptions"] == ["720p", "1080p"]


# --------------------------------------------------------------------------
# 造型决策只引用角色库，不复制
# --------------------------------------------------------------------------


def test_look_decision_only_references_identity_and_overrides_shot_fields(
    client, monkeypatch
) -> None:
    _use_identity_library(
        monkeypatch, [_character("谢铮", [_identity(identity_id="谢铮_和尚")])]
    )
    test_client, _state_dir = client
    _create(test_client)

    ok = test_client.post(
        f"/api/v1/projects/proj_demo/shot-recipes/{RECIPE}/look-decisions",
        json={
            "identity_id": "谢铮_和尚",
            "overrides": {
                "face_prompt": "光头",
                "appearance_details": "僧袍",
                "costume_image": "/uploads/kasaya.png",
                "reference_images": ["/uploads/a.png"],
                "voice": "ref_audio_1",
            },
        },
    )
    assert ok.status_code == 200, ok.text
    data = ok.json()["data"]
    assert set(data["overrides"]) == set(store.LOOK_DECISION_OVERRIDE_KEYS)
    # 决策里只有引用 + 覆盖，没有角色库副本
    assert "portrait_image" not in data["overrides"]

    bad = test_client.post(
        f"/api/v1/projects/proj_demo/shot-recipes/{RECIPE}/look-decisions",
        json={"identity_id": "谢铮_和尚", "overrides": {"portrait_image": "/x.png"}},
    )
    assert bad.status_code == 400
    assert "unknown look decision overrides" in bad.json()["detail"]

    missing_identity = test_client.post(
        f"/api/v1/projects/proj_demo/shot-recipes/{RECIPE}/look-decisions",
        json={"identity_id": ""},
    )
    assert missing_identity.status_code == 422


# --------------------------------------------------------------------------
# T004：绑定真实角色库 + 身份快照 / 显式降级
# --------------------------------------------------------------------------


def test_binding_unknown_identity_is_404_not_silently_accepted(
    client, monkeypatch
) -> None:
    _use_identity_library(monkeypatch, [_character("谢铮", [_identity()])])
    test_client, _state_dir = client
    _create(test_client)

    status, body = _bind_look_decision(
        test_client, identity_id="查无此人_幽灵", character_name="查无此人"
    )
    assert status == 404
    assert "character identity not found" in body["detail"]
    # 静默接受的话这里会多出一条 look_decision——配方里必须一条都没有
    assert _get(test_client)["look_decisions"] == []


def test_binding_known_identity_freezes_snapshot_and_base_vs_override_diff(
    client, monkeypatch
) -> None:
    identity = _identity(
        identity_id="谢铮_皇帝",
        face_prompt="剑眉薄唇",
        appearance_details="玄色常服",
        costume_image="/uploads/default_robe.png",
        reference_images=["/uploads/ref_1.png"],
        reference_audio_path="voice/xz_ref.wav",
    )
    _use_identity_library(monkeypatch, [_character("谢铮", [identity])])
    test_client, _state_dir = client
    _create(test_client)

    status, body = _bind_look_decision(
        test_client,
        identity_id="谢铮_皇帝",
        overrides={
            "face_prompt": "登基妆，冷峻",
            "costume_image": "/uploads/dragon_robe.png",
        },
    )
    assert status == 200, body
    data = body["data"]
    assert data["identity_known"] is True

    snapshot = data["identity_snapshot"]
    assert snapshot["identity_known"] is True
    assert snapshot["identity_id"] == "谢铮_皇帝"
    # 基线字段全部来自 CharacterIdentity（溯源用），不是请求体抄来的
    assert snapshot["face_prompt"] == "剑眉薄唇"
    assert snapshot["appearance_details"] == "玄色常服"
    assert snapshot["costume_image"] == "/uploads/default_robe.png"
    assert snapshot["reference_images"] == ["/uploads/ref_1.png"]
    assert snapshot["voice"] == "voice/xz_ref.wav"
    assert snapshot["known_at"]
    # 决策本身仍只有引用 + 覆盖，没有角色库副本字段
    assert "portrait_image" not in data
    assert set(data["overrides"]) == {"face_prompt", "costume_image"}
    # character_name 缺省时从身份解析补齐
    assert data["character_name"] == "谢铮"

    diff = data["look_diff"]
    assert set(diff) == {"identity_locked", "shot_variable"}
    assert set(diff["identity_locked"]) == set(store.IDENTITY_LOCKED_KEYS)
    assert set(diff["shot_variable"]) == set(store.SHOT_VARIABLE_KEYS)
    assert diff["identity_locked"]["face_prompt"] == {
        "base": "剑眉薄唇",
        "override": "登基妆，冷峻",
        "changed": True,
    }
    assert diff["shot_variable"]["costume_image"] == {
        "base": "/uploads/default_robe.png",
        "override": "/uploads/dragon_robe.png",
        "changed": True,
    }
    # 没被覆盖的字段：base 保留，override 为空且标记未变
    assert diff["identity_locked"]["reference_images"] == {
        "base": ["/uploads/ref_1.png"],
        "override": None,
        "changed": False,
    }
    assert diff["shot_variable"]["voice"] == {
        "base": "voice/xz_ref.wav",
        "override": None,
        "changed": False,
    }
    assert diff["shot_variable"]["appearance_details"]["changed"] is False

    stored = _get(test_client)["look_decisions"][0]
    assert stored["identity_known"] is True
    assert stored["identity_snapshot"]["face_prompt"] == "剑眉薄唇"


def test_identity_library_unavailable_degrades_to_identity_known_false(
    client, monkeypatch
) -> None:
    _use_identity_library(monkeypatch, [], unavailable=True)
    test_client, _state_dir = client
    _create(test_client)

    status, body = _bind_look_decision(test_client, identity_id="谢铮_皇帝")
    assert status == 200, body
    data = body["data"]
    # 显式降级：既不抛错，也不伪装成已解析
    assert data["identity_known"] is False
    snapshot = data["identity_snapshot"]
    assert snapshot["identity_known"] is False
    assert snapshot["reason"] == "character library unavailable"
    assert snapshot["face_prompt"] is None
    assert snapshot["reference_images"] is None
    # 引用照旧记录，只是没有基线可比
    assert data["identity_id"] == "谢铮_皇帝"
    assert data["look_diff"]["identity_locked"]["face_prompt"] == {
        "base": None,
        "override": None,
        "changed": False,
    }


def test_cost_ledger_records_unavailable_quote_instead_of_faking_one(
    client, monkeypatch
) -> None:
    _fake_quote_port(monkeypatch, raises=True)
    test_client, _state_dir = client
    _create(test_client)
    status, body = _append_version(
        test_client, prompt="报价不可用", status="draft"
    )
    assert status == 200, body
    ledger = body["data"]["cost_ledger"]
    assert ledger["quoted"] is False
    assert "credit quote unavailable" in ledger["reason"]
    assert "total_cost" not in ledger


def test_unknown_recipe_is_404(client) -> None:
    test_client, _state_dir = client
    response = test_client.get("/api/v1/projects/proj_demo/shot-recipes/recipe_missing")
    assert response.status_code == 404


def test_recipe_id_cannot_escape_the_state_dir(client) -> None:
    test_client, _state_dir = client
    response = test_client.get("/api/v1/projects/proj_demo/shot-recipes/..%2f..%2fetc")
    assert response.status_code in {400, 404}
