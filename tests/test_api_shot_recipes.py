"""Phase 1 后端垂直切片：ShotRecipe 持久化 + 最小 REST API。

断言三件事（Judge 要求）：
a. 失败版本只追加新行，父版本行永不重写；
b. version 记录字段齐全：parent_version_id / prompt_delta / model_snapshot / cost_ledger；
c. 模型能力目录取不到时 model_snapshot.capabilities_known=false，不得伪装成已支持。
"""

from __future__ import annotations

import json
import shutil
import subprocess
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo.api.deps import ProjectResolution
from novelvideo.api.routes import shot_recipes as shot_recipes_route
from novelvideo.freezone import shot_recipe_store as store
from novelvideo.freezone.video_node import resolve_freezone_video_backend

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


def _ensure_recipe(client: TestClient) -> None:
    """建配方（已存在则忽略）——一个测试里可能需要两条独立的版本链。"""
    response = client.post(
        "/api/v1/projects/proj_demo/shot-recipes",
        json={"recipe_id": RECIPE},
    )
    assert response.status_code in {200, 409}, response.text


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


# --------------------------------------------------------------------------
# T009：rendering slice —— ready 版本接真实 freezone 视频生成
# --------------------------------------------------------------------------

VIDEO_MODEL = "video_x"
# 渲染切片把 model_id 当不透明标签，真实后端仍由既有解析器决定：这里用一个
# 既有可用后端，避免测试把「哪些模型存在」钉死成契约。
RENDER_BACKEND = resolve_freezone_video_backend(None)
CATALOG_ENTRY = {
    "catalogId": "video_x",
    "id": "video_x",
    "apiModel": "video_x",
    "minDuration": 2,
    "maxDuration": 12,
    "referenceImageMax": 4,
    "supportedModes": ["text_to_video"],
    "resolutionOptions": ["720p", "1080p"],
    "ratioOptions": ["16:9", "9:16"],
}
# T019：带参考素材模式的目录条目。画布上游有素材时渲染会切到 image_to_video /
# all_reference，模型必须声明它们（没声明就 400，正是本切片要保证的）。
REFERENCE_CATALOG_ENTRY = {
    **CATALOG_ENTRY,
    "supportedModes": ["text_to_video", "image_to_video", "all_reference"],
    "referenceVideoMax": 2,
    "referenceAudioMax": 1,
}


def _use_video_catalog(monkeypatch, entry=CATALOG_ENTRY) -> None:
    from novelvideo.api.routes import freezone

    async def fake_catalog(media_type, *, requester_user_id):
        del media_type, requester_user_id
        return [entry]

    monkeypatch.setattr(freezone, "_scoped_media_model_catalog", fake_catalog)


class _FakeTaskBackend:
    """Stand-in for get_task_backend(): records the call, never generates anything."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def enqueue_project_task(
        self,
        ctx,
        *,
        task_type: str,
        product_surface: str,
        queue_kind: str = "default",
        episode: int = 0,
        beat_num: int | None = None,
        scope: str | None = None,
        payload: dict | None = None,
    ):
        from novelvideo.ports.tasks import QueuedTask

        self.calls.append(
            {
                "task_type": task_type,
                "product_surface": product_surface,
                "queue_kind": queue_kind,
                "episode": episode,
                "beat_num": beat_num,
                "scope": scope,
                "payload": dict(payload or {}),
                "project_id": getattr(ctx, "project_id", ""),
            }
        )
        return QueuedTask(
            task_state=SimpleNamespace(task_id=f"task-{len(self.calls)}"),
            backend="fake",
        )


def _use_fake_task_backend(monkeypatch) -> _FakeTaskBackend:
    import novelvideo.ports as ports

    backend = _FakeTaskBackend()
    monkeypatch.setattr(ports, "get_task_backend", lambda: backend)
    return backend


def _ready_version(
    test_client: TestClient, *, source_refs: dict | None = None, **body
) -> dict:
    """Create a recipe + one ready version bound to a known model."""
    _ensure_recipe(test_client)
    status, payload = _append_version(
        test_client,
        prompt="皇帝登基，俯拍",
        status="ready",
        model_id=VIDEO_MODEL,
        resolution="1080p",
        source_refs=source_refs if source_refs is not None else {},
        **body,
    )
    assert status == 200, payload
    return payload["data"]


def _render(test_client: TestClient, version_id: str, **body) -> tuple[int, dict]:
    response = test_client.post(
        f"/api/v1/projects/proj_demo/shot-recipes/{RECIPE}"
        f"/versions/{version_id}/render",
        json={"model_id": VIDEO_MODEL, "video_backend": RENDER_BACKEND, **body},
    )
    return response.status_code, response.json()


def _lines(state_dir) -> list[str]:
    return _recipe_file(state_dir).read_text(encoding="utf-8").splitlines()


def test_render_submits_task_and_appends_version_with_real_cost_ledger(
    client, monkeypatch
) -> None:
    """(e) 成功渲染：payload 带 recipe_id/version_id，版本行 append 真实 cost_ledger。"""
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch, total_cost=73)
    backend = _use_fake_task_backend(monkeypatch)
    test_client, state_dir = client
    ready = _ready_version(
        test_client, source_refs={"canvas_id": "canvas_a", "node_id": "node_1"}
    )
    before = _lines(state_dir)

    status, body = _render(
        test_client, ready["version_id"], duration_seconds=6, resolution="1080p"
    )
    assert status == 200, body
    data = body["data"]
    assert data["recipe_id"] == RECIPE
    assert data["version_id"] == ready["version_id"]
    assert data["job_id"] and data["job_id"].startswith("job_")
    assert data["task_id"] == "task-1"
    assert data["status"] == "rendering"
    assert data["cost_ledger"]["quoted"] is True
    assert data["cost_ledger"]["total_cost"] == 73
    assert data["cost_ledger"]["source"] == "generation_credit_quote"

    # 任务层的形状：freezone_video_gen / freezone / video / episode 0
    assert len(backend.calls) == 1
    call = backend.calls[0]
    assert call["task_type"] == "freezone_video_gen"
    assert call["product_surface"] == "freezone"
    assert call["queue_kind"] == "video"
    assert call["episode"] == 0
    assert call["scope"] == data["job_id"]
    payload = call["payload"]
    assert payload["recipe_id"] == RECIPE
    assert payload["version_id"] == ready["version_id"]
    assert payload["job_id"] == data["job_id"]
    # canvas/node 只来自 source_refs，没有画布 node data 参与
    assert payload["canvas_id"] == "canvas_a"
    assert payload["node_id"] == "node_1"
    assert payload["source_refs"] == {"canvas_id": "canvas_a", "node_id": "node_1"}
    assert payload["billing"]["feature_key"] == "freezone.video_generate"

    # 版本行写回走 append：ready 那一行逐字节未变，只多一行 rendering
    after = _lines(state_dir)
    assert len(after) == len(before) + 1
    assert all(line in after for line in before)
    rendering = [line for line in after if '"status":"rendering"' in line]
    assert len(rendering) == 1
    record = json.loads(rendering[0])
    assert record["version_id"] == ready["version_id"]
    assert record["prompt_delta"]["mode"] == "delta"
    assert record["model_snapshot"]["capabilities_known"] is True
    assert record["model_snapshot"]["maxDuration"] == 12
    assert record["cost_ledger"]["total_cost"] == 73
    assert record["source_refs"]["job_id"] == data["job_id"]

    # 读回的是「每版最新一行」：ready 行还在文件里（上面已断言逐字节未变），
    # 但当前状态是 rendering，且带上了 job_id —— 版本号不因状态变化而新开
    stored = _get(test_client)["versions"]
    assert [item["version_id"] for item in stored] == ["v1"]
    assert stored[0]["status"] == "rendering"
    assert stored[0]["parent_version_id"] == "v1"
    assert stored[0]["lineage"] == ["v1"]
    assert stored[0]["source_refs"]["job_id"] == data["job_id"]


def test_render_requires_ready_status_and_does_not_touch_any_line(
    client, monkeypatch
) -> None:
    """(a) 非 ready → 409，且任何行都未被改动。"""
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)
    backend = _use_fake_task_backend(monkeypatch)
    test_client, state_dir = client
    _create(test_client)
    _status, draft = _append_version(
        test_client, prompt="草稿", status="draft", model_id=VIDEO_MODEL
    )
    before = _lines(state_dir)

    status, body = _render(test_client, draft["data"]["version_id"])
    assert status == 409
    assert "not ready to render" in body["detail"]
    assert "draft" in body["detail"]
    assert backend.calls == []
    assert _lines(state_dir) == before


def test_render_refuses_when_capabilities_cannot_be_resolved(
    client, monkeypatch
) -> None:
    """(b) 目录取不到 → capabilities_known=false 显式拒绝，不按已支持继续。"""
    from novelvideo.api.routes import freezone

    async def no_catalog(media_type, *, requester_user_id):
        del media_type, requester_user_id
        return None

    monkeypatch.setattr(freezone, "_scoped_media_model_catalog", no_catalog)
    _fake_quote_port(monkeypatch)
    backend = _use_fake_task_backend(monkeypatch)
    test_client, state_dir = client
    # 版本可以照旧追加（那时降级成 capabilities_known=false），但渲染必须拒绝
    _create(test_client)
    _status, version = _append_version(
        test_client, prompt="模型不可见", status="ready", model_id="ghost-model"
    )
    assert version["data"]["model_snapshot"]["capabilities_known"] is False
    before = _lines(state_dir)

    status, body = _render(
        test_client, version["data"]["version_id"], model_id="ghost-model"
    )
    assert status == 409
    assert "capabilities_known=false" in body["detail"]
    assert backend.calls == []
    assert _lines(state_dir) == before


def test_render_rejects_out_of_range_duration_with_boundary(
    client, monkeypatch
) -> None:
    """(c) duration 越界 → 400 并给出边界值。"""
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)
    backend = _use_fake_task_backend(monkeypatch)
    test_client, state_dir = client
    ready = _ready_version(test_client)
    before = _lines(state_dir)

    status, body = _render(test_client, ready["version_id"], duration_seconds=99)
    assert status == 400
    assert "99 > 12" in body["detail"]

    status, body = _render(test_client, ready["version_id"], duration_seconds=1)
    assert status == 400
    assert "1 < 2" in body["detail"]

    status, body = _render(
        test_client, ready["version_id"], duration_seconds=6, resolution="4320p"
    )
    assert status == 400
    assert "4320p" in body["detail"]
    assert "720p, 1080p" in body["detail"]

    assert backend.calls == []
    assert _lines(state_dir) == before


def test_render_is_idempotent_per_version_and_reports_existing_job(
    client, monkeypatch
) -> None:
    """(d) 已有 source_refs.job_id → 409 并附既有 job_id，不重复入队。"""
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)
    backend = _use_fake_task_backend(monkeypatch)
    test_client, state_dir = client
    ready = _ready_version(
        test_client, source_refs={"canvas_id": "canvas_a", "job_id": "job_existing"}
    )
    before = _lines(state_dir)

    status, body = _render(test_client, ready["version_id"])
    assert status == 409
    assert "job_existing" in body["detail"]
    assert backend.calls == []
    assert _lines(state_dir) == before

    # 渲染成功后，同一个版本再次渲染同样 409，并带上这次真正入队的 job_id。
    # 注意这只承诺「版本级一次性提交」：任务层 reserve_task_for_project 的去重
    # 只在 submitting/queued/running 生效，任务跑完之后同一 job_id 的 scope 仍可
    # 再次入队，所以这里不宣称永久幂等。
    _status, other = _append_version(
        test_client, prompt="第二版", status="ready", model_id=VIDEO_MODEL
    )
    assert _status == 200, other
    status, body = _render(test_client, other["data"]["version_id"])
    assert status == 200, body
    first_job_id = body["data"]["job_id"]
    assert len(backend.calls) == 1

    status, body = _render(test_client, other["data"]["version_id"])
    assert status == 409
    assert first_job_id in body["detail"]
    assert len(backend.calls) == 1


def test_render_404s_for_unknown_recipe_and_version(client, monkeypatch) -> None:
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)
    backend = _use_fake_task_backend(monkeypatch)
    test_client, _state_dir = client
    _create(test_client)

    response = test_client.post(
        "/api/v1/projects/proj_demo/shot-recipes/recipe_missing/versions/v1/render",
        json={"model_id": VIDEO_MODEL, "video_backend": RENDER_BACKEND},
    )
    assert response.status_code == 404

    status, body = _render(test_client, "v99")
    assert status == 404
    assert "version not found" in body["detail"]
    assert backend.calls == []


def test_render_propagates_task_backend_errors_as_503(
    client, monkeypatch
) -> None:
    """后端启动失败 → 503，且不留下任何渲染行。"""
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)

    class ExplodingBackend(_FakeTaskBackend):
        async def enqueue_project_task(self, *args, **kwargs):
            raise RuntimeError("task backend down")

    import novelvideo.ports as ports

    monkeypatch.setattr(ports, "get_task_backend", lambda: ExplodingBackend())
    test_client, state_dir = client
    ready = _ready_version(test_client)
    before = _lines(state_dir)

    status, body = _render(test_client, ready["version_id"])
    assert status == 503
    assert "task backend down" in body["detail"]
    assert _lines(state_dir) == before


# --------------------------------------------------------------------------
# T012：渲染终态回写 —— 任务终态写回版本行，中间态一行不改
# --------------------------------------------------------------------------


class _FakeTaskManager:
    """Stand-in for get_task_manager(): returns a TaskState, or None."""

    def __init__(self, task=None) -> None:
        self.task = task
        self.calls: list[dict] = []

    def get_task_for_project(
        self,
        ctx,
        task_type,
        episode,
        beat_num=None,
        scope=None,
    ):
        self.calls.append(
            {
                "task_type": task_type,
                "episode": episode,
                "beat_num": beat_num,
                "scope": scope,
                "project_id": getattr(ctx, "project_id", ""),
            }
        )
        return self.task


def _task_state(*, status: str, result: dict | None = None, error: str = ""):
    from novelvideo.task_state import TaskState

    return TaskState(
        task_id="task-1",
        task_type="freezone_video_gen",
        status=status,
        episode=0,
        result=result,
        error=error,
    )


def _use_fake_task_manager(monkeypatch, task) -> _FakeTaskManager:
    """替换任务状态读取 seam（函数内导入，故 patch 模块属性即生效）。"""
    import novelvideo.task_state as task_state

    manager = _FakeTaskManager(task)
    monkeypatch.setattr(task_state, "get_task_manager", lambda: manager)
    return manager


def _sync(test_client: TestClient, version_id: str) -> tuple[int, dict]:
    response = test_client.post(
        f"/api/v1/projects/proj_demo/shot-recipes/{RECIPE}"
        f"/versions/{version_id}/sync"
    )
    return response.status_code, response.json()


def _rendering_version(
    test_client: TestClient, *, job_id: str = "job_render01", **body
) -> tuple[str, dict]:
    """ready 版本走完 render，拿到一条 rendering 行（源引用里带 job_id）。"""
    ready = _ready_version(
        test_client,
        source_refs={"canvas_id": "canvas_a", "node_id": "node_1"},
        **body,
    )
    status, rendered = _render(test_client, ready["version_id"], duration_seconds=6)
    assert status == 200, rendered
    assert rendered["data"]["status"] == "rendering"
    return ready["version_id"], rendered["data"]


def test_sync_completed_task_advances_version_and_writes_artifact_url(
    client, monkeypatch
) -> None:
    """(a) 终态 completed → 版本推进为 completed，产物 url 写回 source_refs。"""
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch, total_cost=73)
    _use_fake_task_backend(monkeypatch)
    manager = _use_fake_task_manager(
        monkeypatch,
        _task_state(
            status="completed",
            result={
                "job_id": "job_1",
                "output_path": "/state/freezone/outputs/freezone_video_gen/job_1.mp4",
                "output_url": "/static/projects/proj_demo/freezone/video/job_1.mp4",
            },
        ),
    )
    test_client, state_dir = client
    version_id, rendered = _rendering_version(test_client)
    before = _lines(state_dir)

    # 定位参数必须与入队一致：同 task_type / episode=0 / scope=job_id
    status, body = _sync(test_client, version_id)
    assert status == 200, body
    data = body["data"]
    assert data["task_found"] is True
    assert data["task_status"] == "completed"
    assert data["changed"] is True
    assert data["status"] == "completed"
    assert data["artifact_url"] == "/static/projects/proj_demo/freezone/video/job_1.mp4"
    assert data["error"] is None

    assert manager.calls == [
        {
            "task_type": "freezone_video_gen",
            "episode": 0,
            "beat_num": None,
            "scope": rendered["job_id"],
            "project_id": "proj_demo",
        }
    ]

    # 父行（ready / rendering）逐字节未变，只多一条终态行
    after = _lines(state_dir)
    assert len(after) == len(before) + 1
    assert all(line in after for line in before)
    completed = [line for line in after if '"status":"completed"' in line]
    assert len(completed) == 1
    record = json.loads(completed[0])
    assert record["version_id"] == version_id
    assert record["source_refs"]["artifact_url"] == (
        "/static/projects/proj_demo/freezone/video/job_1.mp4"
    )
    assert record["source_refs"]["job_id"] == rendered["job_id"]
    assert record["source_refs"]["node_id"] == "node_1"
    # 四字段齐备：终态行不是「只有状态的壳」
    for field in (
        "parent_version_id",
        "prompt_delta",
        "model_snapshot",
        "cost_ledger",
    ):
        assert record[field] not in (None, {}), field
    assert record["parent_version_id"] == version_id
    assert record["prompt_delta"]["prompt"] == "皇帝登基，俯拍"
    assert record["prompt_delta"]["changes"]["render"]["task_status"] == "completed"
    assert record["model_snapshot"]["capabilities_known"] is True
    assert record["model_snapshot"]["maxDuration"] == 12
    assert record["cost_ledger"]["quoted"] is True
    assert record["cost_ledger"]["total_cost"] == 73
    assert record["look_decision_ids"] == []

    stored = _get(test_client)["versions"]
    assert [item["version_id"] for item in stored] == [version_id]
    assert stored[0]["status"] == "completed"
    assert stored[0]["source_refs"]["artifact_url"].endswith("job_1.mp4")
    assert stored[0]["lineage"] == [version_id]

    # 幂等：同一终态再 sync 不写第二行
    status, body = _sync(test_client, version_id)
    assert status == 200
    assert body["data"]["changed"] is False
    assert body["data"]["status"] == "completed"
    assert _lines(state_dir) == after


def test_sync_failed_task_writes_failed_status_and_error(
    client, monkeypatch
) -> None:
    """(b) 终态 failed → 版本推进为 failed，原因写回 source_refs.error。"""
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)
    _use_fake_task_backend(monkeypatch)
    _use_fake_task_manager(
        monkeypatch,
        _task_state(status="failed", error="视频生成后端超时"),
    )
    test_client, state_dir = client
    version_id, _rendered = _rendering_version(test_client)
    before = _lines(state_dir)

    status, body = _sync(test_client, version_id)
    assert status == 200, body
    data = body["data"]
    assert data["status"] == "failed"
    assert data["error"] == "视频生成后端超时"
    assert data["artifact_url"] is None
    assert data["changed"] is True

    after = _lines(state_dir)
    assert len(after) == len(before) + 1
    assert all(line in after for line in before)
    record = json.loads([line for line in after if '"status":"failed"' in line][0])
    assert record["source_refs"]["error"] == "视频生成后端超时"
    assert "artifact_url" not in record["source_refs"]
    assert record["parent_version_id"] == version_id
    assert record["model_snapshot"] and record["cost_ledger"]
    assert record["prompt_delta"]["mode"] == "delta"

    assert _get(test_client)["versions"][0]["status"] == "failed"


def test_sync_cancelled_task_advances_to_cancelled(
    client, monkeypatch
) -> None:
    """cancelled 也是终态（store.VERSION_STATUSES 里就有），但绝不能算成功。"""
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)
    _use_fake_task_backend(monkeypatch)
    _use_fake_task_manager(monkeypatch, _task_state(status="cancelled"))
    test_client, state_dir = client
    version_id, _rendered = _rendering_version(test_client)
    before = _lines(state_dir)

    status, body = _sync(test_client, version_id)
    assert status == 200, body
    assert body["data"]["status"] == "cancelled"
    assert body["data"]["artifact_url"] is None
    assert "cancelled" in body["data"]["error"]
    assert body["data"]["status"] != "completed"
    assert _get(test_client)["versions"][0]["status"] == "cancelled"

    after = _lines(state_dir)
    assert len(after) == len(before) + 1
    assert all(line in after for line in before)

    # 任务自称 completed 却没有产物 → 不算成功
    _use_fake_task_manager(
        monkeypatch, _task_state(status="completed", result={"job_id": "job_1"})
    )
    _status, other = _append_version(
        test_client, prompt="第二版", status="ready", model_id=VIDEO_MODEL
    )
    assert _status == 200, other
    rendered = _render(test_client, other["data"]["version_id"], duration_seconds=6)
    assert rendered[0] == 200, rendered
    status, body = _sync(test_client, other["data"]["version_id"])
    assert status == 200, body
    assert body["data"]["status"] == "failed"
    assert "without an artifact url" in body["data"]["error"]


def test_sync_does_not_touch_any_line_while_task_is_running(
    client, monkeypatch
) -> None:
    """(c) 中间态 submitting/queued/running → 一行都不改。"""
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)
    backend = _use_fake_task_backend(monkeypatch)
    manager = _use_fake_task_manager(monkeypatch, _task_state(status="running"))
    test_client, state_dir = client
    version_id, _rendered = _rendering_version(test_client)
    before = _lines(state_dir)

    for status_word in ("submitting", "queued", "running"):
        manager.task = _task_state(status=status_word)
        code, body = _sync(test_client, version_id)
        assert code == 200, body
        assert body["data"]["changed"] is False
        assert body["data"]["status"] == "rendering"
        assert body["data"]["task_status"] == status_word
        assert _lines(state_dir) == before

    assert backend.calls and len(backend.calls) == 1
    assert _get(test_client)["versions"][0]["status"] == "rendering"


def test_sync_missing_task_keeps_rendering_and_never_fakes_completed(
    client, monkeypatch
) -> None:
    """(d) 任务查不到 → 保留 rendering 并如实回报，不得伪造成 completed。"""
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)
    _use_fake_task_backend(monkeypatch)
    manager = _use_fake_task_manager(monkeypatch, None)
    test_client, state_dir = client
    version_id, _rendered = _rendering_version(test_client)
    before = _lines(state_dir)

    status, body = _sync(test_client, version_id)
    assert status == 200, body
    assert body["data"]["task_found"] is False
    assert body["data"]["changed"] is False
    assert body["data"]["status"] == "rendering"
    assert body["data"]["source_refs"]["job_id"] == manager.calls[0]["scope"]
    assert _lines(state_dir) == before
    assert _get(test_client)["versions"][0]["status"] == "rendering"


def test_sync_without_job_id_is_a_noop(client, monkeypatch) -> None:
    """没渲染过的版本没有任务可对账：不动行，也不报错。"""
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)
    _use_fake_task_backend(monkeypatch)
    manager = _use_fake_task_manager(monkeypatch, _task_state(status="completed"))
    test_client, state_dir = client
    ready = _ready_version(test_client)
    before = _lines(state_dir)

    status, body = _sync(test_client, ready["version_id"])
    assert status == 200, body
    assert body["data"]["job_id"] == ""
    assert body["data"]["task_found"] is False
    assert body["data"]["changed"] is False
    assert manager.calls == []
    assert _lines(state_dir) == before


def test_sync_404s_for_unknown_recipe_and_version(client, monkeypatch) -> None:
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)
    _use_fake_task_backend(monkeypatch)
    _use_fake_task_manager(monkeypatch, _task_state(status="completed"))
    test_client, _state_dir = client
    _create(test_client)

    response = test_client.post(
        "/api/v1/projects/proj_demo/shot-recipes/recipe_missing"
        "/versions/v1/sync"
    )
    assert response.status_code == 404

    status, body = _sync(test_client, "v99")
    assert status == 404
    assert "version not found" in body["detail"]


def test_sync_reports_unreadable_task_state_as_503(client, monkeypatch) -> None:
    """任务状态读不到：503 显式失败，不留半条终态行。"""
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)
    _use_fake_task_backend(monkeypatch)

    class ExplodingManager(_FakeTaskManager):
        def get_task_for_project(self, *args, **kwargs):
            raise RuntimeError("task db locked")

    import novelvideo.task_state as task_state

    monkeypatch.setattr(task_state, "get_task_manager", lambda: ExplodingManager())
    test_client, state_dir = client
    version_id, _rendered = _rendering_version(test_client)
    before = _lines(state_dir)

    status, body = _sync(test_client, version_id)
    assert status == 503
    assert "task db locked" in body["detail"]
    assert _lines(state_dir) == before
    assert _get(test_client)["versions"][0]["status"] == "rendering"


# --------------------------------------------------------------------------
# T013：渲染预检 —— 入队之前的结构化结论，且预检端点只读
# --------------------------------------------------------------------------


def _preflight(test_client: TestClient, version_id: str, **body) -> tuple[int, dict]:
    response = test_client.post(
        f"/api/v1/projects/proj_demo/shot-recipes/{RECIPE}"
        f"/versions/{version_id}/preflight",
        json={"video_backend": RENDER_BACKEND, **body},
    )
    return response.status_code, response.json()


def _preflight_without_body(test_client: TestClient, version_id: str) -> tuple[int, dict]:
    """不带请求体的预检：请求体本身必须是可选的。"""
    response = test_client.post(
        f"/api/v1/projects/proj_demo/shot-recipes/{RECIPE}"
        f"/versions/{version_id}/preflight"
    )
    return response.status_code, response.json()


def _checks(report: dict) -> dict[str, dict]:
    return {row["id"]: row for row in report["checks"]}


def _write_canvas(state_dir, canvas_id: str, *, canvas_project=None, **node_data) -> None:
    """在 state_dir 下写一份画布（与 canvas_store 的落盘位置一致）。"""
    from novelvideo.freezone import canvas_store

    payload = canvas_store.default_canvas_payload(project_id="proj_demo")
    payload["nodes"] = [
        {
            "id": "node_1",
            "type": "videoNode",
            "position": {"x": 0, "y": 0},
            "data": dict(node_data),
        }
    ]
    root = canvas_project or state_dir
    path = canvas_store.canvas_path(root, canvas_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def _canvas_node(node_id: str, node_type: str, **data) -> dict:
    return {
        "id": node_id,
        "type": node_type,
        "position": {"x": 0, "y": 0},
        "data": dict(data),
    }


def _canvas_edge(source: str, target: str) -> dict:
    """画布 edges 的真实形状（state/*/freezone/canvases/*.json 实测）。"""
    return {
        "id": f"edge-{source}-{target}",
        "source": source,
        "target": target,
        "sourceHandle": "source",
        "targetHandle": "target",
        "type": "disconnectableEdge",
    }


def _write_canvas_graph(
    state_dir, canvas_id: str, nodes: list[dict], edges: list[dict] | None = None
) -> None:
    """写一份带 edges 的画布：白模节点 → 派生 video 节点的来源边就是这么落的。"""
    from novelvideo.freezone import canvas_store

    payload = canvas_store.default_canvas_payload(project_id="proj_demo")
    payload["nodes"] = list(nodes)
    payload["edges"] = list(edges or [])
    path = canvas_store.canvas_path(state_dir, canvas_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def _write_asset(state_dir, rel: str) -> None:
    path = state_dir / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"fake-bytes")


def test_preflight_reports_structured_checks_and_writes_nothing(
    client, monkeypatch
) -> None:
    """(1)(3) 报告是结构化 check 列表；预检是只读的（一行都不写）。"""
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch, total_cost=42)
    backend = _use_fake_task_backend(monkeypatch)
    test_client, state_dir = client
    _write_canvas(
        state_dir,
        "canvas_a",
        videoUrl="/static/projects/proj_demo/freezone/_uploads/clip.mp4",
    )
    _write_asset(state_dir, "freezone/_uploads/clip.mp4")
    ready = _ready_version(
        test_client, source_refs={"canvas_id": "canvas_a", "node_id": "node_1"}
    )
    before_bytes = _recipe_file(state_dir).read_bytes()

    status, body = _preflight(
        test_client, ready["version_id"], model_id=VIDEO_MODEL, duration_seconds=6
    )
    assert status == 200, body
    report = body["data"]
    assert report["recipe_id"] == RECIPE
    assert report["version_id"] == ready["version_id"]
    assert report["ok"] is True
    assert report["blocking"] == []
    assert report["checked_at"]
    # 结构化 check 列表，不是单一分数 / 单一布尔
    assert [row["id"] for row in report["checks"]] == list(store.PREFLIGHT_CHECK_IDS)
    for row in report["checks"]:
        assert set(row) == {"id", "status", "detail"}
        assert row["status"] in store.PREFLIGHT_CHECK_STATUSES
        assert row["detail"]
    checks = _checks(report)
    assert checks["model_capabilities"]["status"] == "pass"
    assert checks["billing"]["status"] == "pass"
    assert "42" in checks["billing"]["detail"]
    assert checks["look_decisions"]["status"] == "pass"
    assert checks["source_refs"]["status"] == "pass"
    # 四类检查都取到了真实事实，没有任何 warn
    assert report["warnings"] == []

    # 只读：文件字节数与内容逐字节未变，也没有入队任何任务
    assert _recipe_file(state_dir).read_bytes() == before_bytes
    assert backend.calls == []

    # 请求体是可选的：不传参数也要能拿到结构化结论（模型/时长回退到版本冻结值）
    code, empty_body = _preflight_without_body(test_client, ready["version_id"])
    assert code == 200, empty_body
    assert [row["id"] for row in empty_body["data"]["checks"]] == list(
        store.PREFLIGHT_CHECK_IDS
    )
    assert _recipe_file(state_dir).read_bytes() == before_bytes


def test_preflight_warns_instead_of_passing_on_unreadable_facts(
    client, monkeypatch
) -> None:
    """(2) 读不到的事实一律 warn：目录 / identity / 素材 / 报价都不许报 pass。"""
    from novelvideo.api.routes import freezone

    async def no_catalog(media_type, *, requester_user_id):
        del media_type, requester_user_id
        return None

    monkeypatch.setattr(freezone, "_scoped_media_model_catalog", no_catalog)
    _fake_quote_port(monkeypatch, raises=True)
    _use_identity_library(monkeypatch, [], unavailable=True)
    backend = _use_fake_task_backend(monkeypatch)
    test_client, state_dir = client

    _create(test_client)
    _status, decision = _bind_look_decision(test_client, identity_id="谢铮_皇帝")
    assert _status == 200, decision
    assert decision["data"]["identity_known"] is False

    status, version = _append_version(
        test_client,
        prompt="模型不可见且素材缺失",
        status="ready",
        model_id="ghost-model",
        source_refs={"canvas_id": "canvas_missing", "node_id": "node_1"},
        look_decision_ids=[decision["data"]["decision_id"]],
    )
    assert status == 200, version
    before_bytes = _recipe_file(state_dir).read_bytes()

    code, body = _preflight(test_client, version["data"]["version_id"])
    assert code == 200, body
    report = body["data"]
    checks = _checks(report)
    # 目录查不到 → warn（不是 pass，也不是 block）
    assert checks["model_capabilities"]["status"] == "warn"
    assert "capabilities_known=false" in checks["model_capabilities"]["detail"]
    # identity_known=false → warn，沿用 identityUnknown 口径
    assert checks["look_decisions"]["status"] == "warn"
    assert "identity library unavailable" in checks["look_decisions"]["detail"]
    # 画布不存在 → warn
    assert checks["source_refs"]["status"] == "warn"
    assert "not found" in checks["source_refs"]["detail"]
    # 报价拿不到 → warn，reason 原样带上，且不出现编造的价格
    assert checks["billing"]["status"] == "warn"
    assert "credit quote unavailable" in checks["billing"]["detail"]
    assert not any(ch.isdigit() for ch in checks["billing"]["detail"])    # 没有任何 warn 被升级成 pass，也没有 block（预检不阻止调用方）
    assert report["ok"] is True
    assert sorted(report["warnings"]) == [
        "billing",
        "look_decisions",
        "model_capabilities",
        "source_refs",
    ]
    # 同一份预检在路由层也是只读的
    assert _recipe_file(state_dir).read_bytes() == before_bytes
    assert backend.calls == []


def test_preflight_blocks_on_out_of_range_knobs_and_missing_look_decision(
    client, monkeypatch
) -> None:
    """(2) 越界参数与丢失的造型决策是 block；render 端点据此 409。"""
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)
    backend = _use_fake_task_backend(monkeypatch)
    test_client, state_dir = client
    ready = _ready_version(
        test_client,
        source_refs={"canvas_id": "canvas_a", "node_id": "node_1"},
        look_decision_ids=["look_ghost"],
    )
    before = _lines(state_dir)

    status, body = _preflight(
        test_client,
        ready["version_id"],
        model_id=VIDEO_MODEL,
        duration_seconds=99,
        resolution="4320p",
        aspect_ratio="1:1",
    )
    assert status == 200, body
    report = body["data"]
    checks = _checks(report)
    assert report["ok"] is False
    assert checks["model_capabilities"]["status"] == "block"
    assert "99 > 12" in checks["model_capabilities"]["detail"]
    assert "4320p" in checks["model_capabilities"]["detail"]
    assert "1:1" in checks["model_capabilities"]["detail"]
    # 版本绑定的造型决策在配方里找不到 → block
    assert checks["look_decisions"]["status"] == "block"
    assert "look_ghost" in checks["look_decisions"]["detail"]
    assert sorted(report["blocking"]) == ["look_decisions", "model_capabilities"]
    # 预检本身绝不 409，也不写行
    assert _lines(state_dir) == before
    assert backend.calls == []

    # 同一份 preflight 接进 render：存在 block → 409，detail 带 block 的 check id 与 detail
    code, rendered = _render(
        test_client, ready["version_id"], duration_seconds=6, resolution="1080p"
    )
    assert code == 409, rendered
    assert "preflight blocked" in rendered["detail"]
    assert "look_decisions" in rendered["detail"]
    assert "look_ghost" in rendered["detail"]
    assert backend.calls == []
    assert _lines(state_dir) == before


def test_render_proceeds_with_warnings_only(client, monkeypatch) -> None:
    """(4) warn 不阻止渲染：只进报告。"""
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)
    backend = _use_fake_task_backend(monkeypatch)
    test_client, state_dir = client
    # 目录可用（能力 check 会 pass），但 source_refs 既无画布也无素材 → warn
    ready = _ready_version(test_client)
    before = _lines(state_dir)

    status, body = _preflight(test_client, ready["version_id"], model_id=VIDEO_MODEL)
    assert status == 200, body
    assert body["data"]["warnings"] == ["source_refs"]
    assert body["data"]["blocking"] == []

    code, rendered = _render(test_client, ready["version_id"], duration_seconds=6)
    assert code == 200, rendered
    assert rendered["data"]["status"] == "rendering"
    assert len(backend.calls) == 1
    assert len(_lines(state_dir)) == len(before) + 1


def test_preflight_404s_for_unknown_recipe_and_version(client, monkeypatch) -> None:
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)
    _use_fake_task_backend(monkeypatch)
    test_client, _state_dir = client
    _create(test_client)

    response = test_client.post(
        "/api/v1/projects/proj_demo/shot-recipes/recipe_missing"
        "/versions/v1/preflight",
        json={},
    )
    assert response.status_code == 404

    status, body = _preflight(test_client, "v99")
    assert status == 404
    assert "version not found" in body["detail"]


def test_preflight_check_schema_is_owned_by_the_store() -> None:
    """报告的 schema 只有 store 一个 owner：未知状态 / 缺 id 会被拒绝。"""
    with pytest.raises(ValueError):
        store.build_preflight_check(check_id="x", status="maybe")
    with pytest.raises(ValueError):
        store.build_preflight_check(check_id="", status="pass")

    report = store.build_preflight_report(
        recipe_id="r",
        version_id="v1",
        checks=[
            {"id": "a", "status": "warn", "detail": "could not read"},
            {"id": "b", "status": "block", "detail": "out of range"},
        ],
    )
    assert report["ok"] is False
    assert report["blocking"] == ["b"]
    assert report["warnings"] == ["a"]
    assert store.preflight_block_reason(report) == "b: out of range"


# --------------------------------------------------------------------------
# T014：版本质量报告 —— 结构化风险清单，且报告端点只读、不落盘、没有总分
# --------------------------------------------------------------------------


def _quality(test_client: TestClient, version_id: str) -> tuple[int, dict]:
    response = test_client.get(
        f"/api/v1/projects/proj_demo/shot-recipes/{RECIPE}"
        f"/versions/{version_id}/quality"
    )
    return response.status_code, response.json()


def _risks(report: dict) -> dict[str, dict]:
    return {row["id"]: row for row in report["risks"]}


def _severities(report: dict) -> list[str]:
    return [row["severity"] for row in report["risks"]]


def test_quality_report_is_structured_risks_and_writes_nothing(
    client, monkeypatch
) -> None:
    """(1)(3) 报告是结构化 risk 列表（不是分数）；质量端点只读、不入队。"""
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch, total_cost=42)
    backend = _use_fake_task_backend(monkeypatch)
    _use_identity_library(
        monkeypatch, [_character("谢铮", [_identity(identity_id="谢铮_皇帝")])]
    )
    test_client, state_dir = client
    _create(test_client)
    _status, decision = _bind_look_decision(test_client, identity_id="谢铮_皇帝")
    assert _status == 200, decision
    _status, payload = _append_version(
        test_client,
        prompt="皇帝登基，俯拍",
        status="ready",
        model_id=VIDEO_MODEL,
        resolution="1080p",
        source_refs={"canvas_id": "canvas_a", "node_id": "node_1"},
        look_decision_ids=[decision["data"]["decision_id"]],
    )
    assert _status == 200, payload
    ready = payload["data"]
    before_bytes = _recipe_file(state_dir).read_bytes()

    status, body = _quality(test_client, ready["version_id"])
    assert status == 200, body
    report = body["data"]
    # 报告的字段就是这些：没有 score / rating / total 这类总分字段
    assert set(report) == {
        "recipe_id",
        "version_id",
        "risks",
        "counts",
        "risk_ids",
        "checked_at",
    }
    assert report["recipe_id"] == RECIPE
    assert report["version_id"] == ready["version_id"]
    assert report["checked_at"]
    # 造型绑定齐、报价已记录、没有渲染终态事实 → 只剩「这条版本没有拿到报价」这一条
    # info（_ready_version 的 model_id 解析不到 video backend，ledger 如实记 quoted=false）。
    # 也就是说：干净的版本报告接近空，但**不是**因为把读不到的事实省略掉了。
    assert report["risk_ids"] == ["cost_unknown"]
    assert report["counts"] == {"critical": 0, "warning": 0, "info": 1}
    assert report["risks"][0]["detail"] == "video backend unavailable"

    # 只读：文件逐字节未变，也没有入队任何任务
    assert _recipe_file(state_dir).read_bytes() == before_bytes
    assert backend.calls == []

    # 再次调用报告不变（可重算 → 不落盘，没有第二次调用拿到缓存/新事实的问题）
    again_status, again = _quality(test_client, ready["version_id"])
    assert again_status == 200
    assert again["data"]["risk_ids"] == report["risk_ids"]
    assert _recipe_file(state_dir).read_bytes() == before_bytes


def test_quality_report_covers_every_deterministic_risk_id(
    client, monkeypatch
) -> None:
    """(2) 每一类可确定性判读的风险都能从 store 既有事实算出来，且严重度分档正确。"""
    _use_video_catalog(monkeypatch)
    # 报价拿不到：cost_unknown 的 info 必须出现，且**不得**编造任何数字
    _fake_quote_port(monkeypatch, raises=True)
    _use_identity_library(
        monkeypatch,
        [
            _character(
                "谢铮",
                [
                    _identity(identity_id="谢铮_皇帝"),
                    _identity(identity_id="谢铮_和尚"),
                ],
            )
        ],
    )
    backend = _use_fake_task_backend(monkeypatch)
    test_client, state_dir = client
    _create(test_client)

    _status, emperor = _bind_look_decision(
        test_client, identity_id="谢铮_皇帝", version_id="v1"
    )
    assert _status == 200, emperor
    _status, monk = _bind_look_decision(
        test_client, identity_id="谢铮_和尚", version_id="v2"
    )
    assert _status == 200, monk

    # v1：已取消的拍摄（无 error / 无产物）——父版本没成立
    _status, first = _append_version(
        test_client,
        prompt="皇帝登基",
        status="cancelled",
        model_id=VIDEO_MODEL,
        duration_seconds=6,
        resolution="1080p",
        look_decision_ids=[emperor["data"]["decision_id"]],
    )
    assert _status == 200, first
    v1 = first["data"]["version_id"]

    # v2：换人（同角色换 identity）+ 引用不存在的决策 + 空 delta + 模型/时长/画幅漂移
    #     + 渲染失败（后端原话）
    _status, second = _append_version(
        test_client,
        parent_version_id=v1,
        prompt="重拍",
        changes={},
        status="failed",
        model_id="video_y",
        duration_seconds=8,
        resolution="720p",
        look_decision_ids=[monk["data"]["decision_id"], "look_ghost"],
        source_refs={"job_id": "job_2", "error": "backend returned 502"},
    )
    assert _status == 200, second
    v2 = second["data"]["version_id"]

    # v3：父版本在配方里解析不到 + completed 却没有产物 + 零条造型绑定
    # 路由层不接受未知父版本（400），所以这条「谱系断裂」只能由 store 直接写出来
    # ——历史行 / 被墓碑隐藏的父版本正是这样产生的。
    store.append_version_record(
        project_dir=state_dir,
        recipe_id=RECIPE,
        record=store.build_version_record(
            version_id="v3",
            parent_version_id="v99",
            prompt_delta=store.build_prompt_delta(
                prompt="孤儿版本", changes={"orphan": True}, has_parent=True
            ),
            model_snapshot=store.build_model_snapshot(model_id=VIDEO_MODEL),
            cost_ledger=store.build_cost_ledger(reason="credit quote unavailable"),
            status="completed",
            model_id=VIDEO_MODEL,
        ),
    )
    v3 = "v3"

    # v4：角色库不可用 → identity_known=false（显式降级，不是「角色不存在」）
    _use_identity_library(monkeypatch, [], unavailable=True)
    _status, ghost = _bind_look_decision(test_client, identity_id="谢铮_皇帝")
    assert _status == 200, ghost
    assert ghost["data"]["identity_known"] is False
    _status, fourth = _append_version(
        test_client,
        parent_version_id=v2,
        prompt="身份读不到",
        changes={"camera": "low_angle"},
        status="draft",
        model_id=VIDEO_MODEL,
        look_decision_ids=[ghost["data"]["decision_id"]],
    )
    assert _status == 200, fourth
    v4 = fourth["data"]["version_id"]

    before_bytes = _recipe_file(state_dir).read_bytes()

    status, body = _quality(test_client, v2)
    assert status == 200, body
    report = body["data"]
    rows = _risks(report)
    assert set(rows) == {
        "look_identity_drift",
        "look_decision_missing",
        "prompt_delta_missing",
        "parent_not_completed",
        "model_changed",
        "duration_drift",
        "resolution_drift",
        "render_failed",
        "cost_unknown",
    }
    # 严重度分档：换人 / 引用了不存在的决策 / 渲染失败是 critical
    assert rows["look_identity_drift"]["severity"] == "critical"
    assert rows["look_decision_missing"]["severity"] == "critical"
    assert rows["render_failed"]["severity"] == "critical"
    # 谱系与模型不一致是 warning
    assert rows["prompt_delta_missing"]["severity"] == "warning"
    assert rows["parent_not_completed"]["severity"] == "warning"
    assert rows["model_changed"]["severity"] == "warning"
    # 漂移与计费不可知是 info
    assert rows["duration_drift"]["severity"] == "info"
    assert rows["resolution_drift"]["severity"] == "info"
    assert rows["cost_unknown"]["severity"] == "info"

    # detail 是给人看的话，evidence 必须能指回具体版本 / 决策（报告可审计）
    assert "look_ghost" in rows["look_decision_missing"]["detail"]
    assert rows["look_decision_missing"]["evidence"]["version_id"] == v2
    drift = rows["look_identity_drift"]["evidence"]
    assert drift["character_name"] == "谢铮"
    assert drift["identity_id"] == "谢铮_和尚"
    assert drift["parent_identity_id"] == "谢铮_皇帝"
    assert drift["parent_version_id"] == v1
    assert rows["model_changed"]["evidence"]["model_id"] == "video_y"
    assert rows["model_changed"]["evidence"]["parent_model_id"] == VIDEO_MODEL
    # 渲染失败用的是后端原话，不是我们编的文案
    assert rows["render_failed"]["detail"] == "backend returned 502"
    assert rows["render_failed"]["evidence"]["error"] == "backend returned 502"
    # 漂移两侧的数值都要在
    assert rows["duration_drift"]["evidence"]["parent_duration_seconds"] == 6
    assert rows["duration_drift"]["evidence"]["duration_seconds"] == 8
    assert rows["resolution_drift"]["evidence"]["parent_resolution"] == "1080p"
    assert rows["resolution_drift"]["evidence"]["resolution"] == "720p"
    # 报价拿不到：只记 info + ledger 原话，绝不出现编造的价格
    assert (
        rows["cost_unknown"]["detail"] == rows["cost_unknown"]["evidence"]["reason"]
    )
    assert not any(ch.isdigit() for ch in rows["cost_unknown"]["detail"])

    # counts 由 risks 派生；展示顺序由重到轻
    assert report["counts"] == {
        "critical": 3,
        "warning": 3,
        "info": 3,
    }
    assert _severities(report) == ["critical"] * 3 + ["warning"] * 3 + ["info"] * 3
    assert report["risk_ids"] == [row["id"] for row in report["risks"]]

    # v3：父版本解析不到 / 完成却没产物 / 零条造型绑定
    status, third_report = _quality(test_client, v3)
    assert status == 200, third_report
    third_rows = _risks(third_report["data"])
    assert set(third_rows) == {
        "lineage_gap",
        "artifact_missing",
        "no_look_decisions",
        "cost_unknown",
    }
    assert third_rows["lineage_gap"]["severity"] == "critical"
    assert third_rows["lineage_gap"]["evidence"]["parent_version_id"] == "v99"
    assert third_rows["artifact_missing"]["severity"] == "warning"
    assert third_rows["no_look_decisions"]["severity"] == "warning"

    # v4：identity_known=false → warning（读不到就是读不到，不静默变干净）
    status, fourth_report = _quality(test_client, v4)
    assert status == 200, fourth_report
    fourth_rows = _risks(fourth_report["data"])
    assert fourth_rows["look_identity_unknown"]["severity"] == "warning"
    assert fourth_rows["look_identity_unknown"]["evidence"]["version_id"] == v4
    assert "look_decision_missing" not in fourth_rows

    # 全 13 条风险 id 都真的能从既有事实算出来（不是纸面契约）
    observed: set[str] = set()
    for version_id in (v1, v2, v3, v4):
        code, payload = _quality(test_client, version_id)
        assert code == 200, payload
        observed |= set(_risks(payload["data"]))
    assert observed == set(store.QUALITY_RISK_IDS)

    # 只读：四次报告都没有写任何一行，也没有入队
    assert _recipe_file(state_dir).read_bytes() == before_bytes
    assert backend.calls == []


def test_quality_report_has_no_score_field_anywhere(client, monkeypatch) -> None:
    """(3) oracle 硬要求：报告里绝不出现总分 / 评分 / 评级字段。"""
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)
    test_client, _state_dir = client
    ready = _ready_version(test_client, look_decision_ids=["look_ghost"])

    status, body = _quality(test_client, ready["version_id"])
    assert status == 200, body
    report = body["data"]
    assert report["risks"], "这条版本必须至少报出引用了不存在的决策"
    forbidden = ("score", "rating", "grade", "total", "average", "points")
    assert not any(
        word in key.lower() for key in report for word in forbidden
    ), set(report)
    for row in report["risks"]:
        assert set(row) == {"id", "severity", "detail", "evidence"}
        assert not any(word in key.lower() for key in row for word in forbidden)


def test_quality_404s_for_unknown_recipe_and_version(client, monkeypatch) -> None:
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)
    test_client, _state_dir = client
    _create(test_client)

    response = test_client.get(
        "/api/v1/projects/proj_demo/shot-recipes/recipe_missing"
        "/versions/v1/quality"
    )
    assert response.status_code == 404

    status, body = _quality(test_client, "v99")
    assert status == 404
    assert "version not found" in body["detail"]


def test_quality_self_parent_render_row_is_not_a_phantom_drift(
    client, monkeypatch
) -> None:
    """渲染 / 回写会在同一 version_id 上写 ``parent_version_id == version_id``。

    这不是「父版本是 rendering」——把它当成父版本会拿自己跟自己比，凭空产出
    parent_not_completed 之类的风险。报告必须把自指指针排除掉。
    """
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)
    _use_fake_task_backend(monkeypatch)
    test_client, _state_dir = client
    ready = _ready_version(test_client)
    status, rendered = _render(test_client, ready["version_id"], duration_seconds=6)
    assert status == 200, rendered
    assert rendered["data"]["parent_version_id"] == ready["version_id"]

    code, body = _quality(test_client, ready["version_id"])
    assert code == 200, body
    ids = set(_risks(body["data"]))
    assert "lineage_gap" not in ids
    assert "parent_not_completed" not in ids
    assert "duration_drift" not in ids
    assert "resolution_drift" not in ids


def test_quality_schema_is_owned_by_the_store() -> None:
    """报告 schema 只有 store 一个 owner：非法 id / 严重度 / 空 evidence 一律拒绝。"""
    with pytest.raises(ValueError):
        store.build_quality_risk(
            risk_id="not_a_risk", severity="warning", detail="x", evidence={"a": 1}
        )
    with pytest.raises(ValueError):
        store.build_quality_risk(
            risk_id="render_failed", severity="block", detail="x", evidence={"a": 1}
        )
    # evidence 不是可选装饰：报告必须能指回具体记录，散文不算
    with pytest.raises(ValueError):
        store.build_quality_risk(
            risk_id="render_failed", severity="critical", detail="x"
        )

    report = store.build_quality_report(
        recipe_id="r",
        version_id="v1",
        risks=[
            {
                "id": "render_failed",
                "severity": "critical",
                "detail": "backend returned 502",
                "evidence": {"version_id": "v1", "error": "backend returned 502"},
            },
            {
                "id": "cost_unknown",
                "severity": "info",
                "detail": "credit quote unavailable",
                "evidence": {"version_id": "v1"},
            },
        ],
    )
    assert report["counts"] == {"critical": 1, "warning": 0, "info": 1}
    assert report["risk_ids"] == ["render_failed", "cost_unknown"]
    assert set(store.QUALITY_RISK_SEVERITIES) == {"critical", "warning", "info"}


# --------------------------------------------------------------------------
# T015：片段重拍接线 —— 一次重拍产出带完整 lineage 的新子版本，并复用既有 sync
# --------------------------------------------------------------------------

# 重拍只有「首尾帧锚定」这一条生成路径，所以测试目录条目必须声明该模式。
RESHOOT_CATALOG_ENTRY = {
    **CATALOG_ENTRY,
    "supportedModes": ["text_to_video", "first_last_frame"],
}
# 源版本成片（重拍的默认素材）：项目内静态地址。
SOURCE_URL = "/static/projects/proj_demo/freezone/_uploads/source.mp4"
SOURCE_ASSET_REL = "freezone/_uploads/source.mp4"


def _use_reshoot_catalog(monkeypatch, entry=RESHOOT_CATALOG_ENTRY) -> None:
    _use_video_catalog(monkeypatch, entry)


def _reshoot(test_client: TestClient, version_id: str, **body) -> tuple[int, dict]:
    response = test_client.post(
        f"/api/v1/projects/proj_demo/shot-recipes/{RECIPE}"
        f"/versions/{version_id}/reshoot",
        json={
            "model_id": VIDEO_MODEL,
            "video_backend": RENDER_BACKEND,
            "start_seconds": 1.0,
            "end_seconds": 5.0,
            "prompt": "把这段改成夜戏",
            **body,
        },
    )
    return response.status_code, response.json()


def _completed_version(
    test_client: TestClient, *, source_refs: dict | None = None, **body
) -> dict:
    """建配方 + 一条 completed 且带 artifact_url 的版本（重拍源版本）。"""
    _ensure_recipe(test_client)
    status, payload = _append_version(
        test_client,
        prompt="皇帝登基，俯拍",
        status="completed",
        model_id=VIDEO_MODEL,
        duration_seconds=8,
        resolution="1080p",
        source_refs=(
            source_refs
            if source_refs is not None
            else {"canvas_id": "canvas_a", "artifact_url": SOURCE_URL}
        ),
        **body,
    )
    assert status == 200, payload
    return payload["data"]


def test_reshoot_appends_child_version_with_full_lineage_and_payload(
    client, monkeypatch
) -> None:
    """(a)(b)(3) 一次重拍 = 一条新子版本行，四字段齐备，源版本行逐字节不变。"""
    _use_reshoot_catalog(monkeypatch)
    _fake_quote_port(monkeypatch, total_cost=31)
    backend = _use_fake_task_backend(monkeypatch)
    test_client, state_dir = client
    _write_asset(state_dir, SOURCE_ASSET_REL)
    source = _completed_version(
        test_client,
        source_refs={
            "canvas_id": "canvas_a",
            "node_id": "node_1",
            "job_id": "job_render01",
            "task_type": "freezone_video_gen",
            "artifact_url": SOURCE_URL,
        },
        look_decision_ids=["look_1"],
    )
    before = _lines(state_dir)

    status, body = _reshoot(test_client, source["version_id"])
    assert status == 200, body
    data = body["data"]
    assert data["recipe_id"] == RECIPE
    assert data["source_version_id"] == source["version_id"]
    assert data["version_id"] == "v2"
    assert data["job_id"].startswith("job_")
    assert data["task_type"] == "freezone_video_reshoot"
    assert data["status"] == "rendering"
    assert data["parent_version_id"] == source["version_id"]
    assert data["start_seconds"] == 1.0
    assert data["end_seconds"] == 5.0
    assert data["duration_seconds"] == 4.0
    # 计费按生成段计价：报价拿到的就是既有 get_credit_quote 的结果
    assert data["cost_ledger"]["quoted"] is True
    assert data["cost_ledger"]["total_cost"] == 31
    assert data["cost_ledger"]["source"] == "generation_credit_quote"

    # 任务层形状：freezone_video_reshoot / freezone / video / episode 0 / scope=新 job
    assert len(backend.calls) == 1
    call = backend.calls[0]
    assert call["task_type"] == "freezone_video_reshoot"
    assert call["product_surface"] == "freezone"
    assert call["queue_kind"] == "video"
    assert call["episode"] == 0
    assert call["scope"] == data["job_id"]
    payload = call["payload"]
    # 与 runners/freezone.py::_run_freezone_video_reshoot_async 逐键对齐：少一个键
    # runner 就 KeyError（end_seconds 更是必读）。
    assert set(payload) == {
        "job_id",
        "source_path",
        "start_seconds",
        "end_seconds",
        "prompt",
        "model",
        "backend",
        "model_params",
        "request_schema",
        "duration_seconds",
        "resolution",
        "generate_audio",
        "camera_template_id",
        "max_duration_seconds",
    }
    assert payload["job_id"] == data["job_id"]
    assert payload["source_path"] == str(state_dir / SOURCE_ASSET_REL)
    assert payload["start_seconds"] == 1.0
    assert payload["end_seconds"] == 5.0
    assert payload["duration_seconds"] == 4
    assert payload["max_duration_seconds"] == 12
    assert payload["model"] == VIDEO_MODEL
    assert payload["resolution"] == "1080p"

    # 父行逐字节不变，只多一条 rendering 子版本行
    after = _lines(state_dir)
    assert len(after) == len(before) + 1
    assert all(line in after for line in before)
    child = json.loads([line for line in after if '"status":"rendering"' in line][0])
    assert child["version_id"] == "v2"
    assert child["parent_version_id"] == source["version_id"]
    assert child["prompt_delta"]["mode"] == "delta"
    assert child["prompt_delta"]["prompt"] == "把这段改成夜戏"
    segment = child["prompt_delta"]["changes"][store.RESHOOT_SEGMENT_KEY]
    assert segment["source_version_id"] == source["version_id"]
    assert segment["job_id"] == data["job_id"]
    assert segment["duration_seconds"] == 4.0
    assert child["model_snapshot"]["capabilities_known"] is True
    assert child["model_snapshot"]["maxDuration"] == 12
    assert child["cost_ledger"]["total_cost"] == 31
    assert child["source_refs"]["job_id"] == data["job_id"]
    assert child["source_refs"]["task_type"] == "freezone_video_reshoot"
    assert child["source_refs"]["reshoot_of"] == source["version_id"]
    # 源版本的引用（含它的 artifact_url 与渲染 job）原样继承
    assert child["source_refs"]["artifact_url"] == SOURCE_URL
    assert child["look_decision_ids"] == ["look_1"]
    assert child["duration_seconds"] == 4.0

    # 读回：新子版本出现在链上，lineage 指向源版本
    stored = {item["version_id"]: item for item in _get(test_client)["versions"]}
    assert set(stored) == {"v1", "v2"}
    assert stored["v2"]["lineage"] == ["v1", "v2"]
    assert stored["v1"]["status"] == "completed"
    assert stored["v1"]["source_refs"]["artifact_url"] == SOURCE_URL

    # 幂等：同一源版本再重拍 → 409 并附既有 job_id，一行都不写
    status, again = _reshoot(test_client, source["version_id"])
    assert status == 409
    assert data["job_id"] in again["detail"]
    assert len(backend.calls) == 1
    assert _lines(state_dir) == after


def test_reshoot_sync_reaches_terminal_state_through_existing_flow(
    client, monkeypatch
) -> None:
    """(4) 重拍版本走既有 sync：task_type 取自版本，主产物键 output_url 被收口。"""
    _use_reshoot_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)
    _use_fake_task_backend(monkeypatch)
    manager = _use_fake_task_manager(
        monkeypatch,
        _task_state(
            status="completed",
            result={
                "job_id": "job_reshoot1",
                "output_path": "/state/freezone/_outputs/freezone_video_reshoot/job_1_full.mp4",
                "output_url": "/static/projects/proj_demo/freezone/video/job_1_full.mp4",
                "clip_url": "/static/projects/proj_demo/freezone/video/job_1_clip.mp4",
            },
        ),
    )
    test_client, state_dir = client
    _write_asset(state_dir, SOURCE_ASSET_REL)
    source = _completed_version(test_client)
    status, body = _reshoot(test_client, source["version_id"])
    assert status == 200, body
    child_id = body["data"]["version_id"]
    before = _lines(state_dir)

    code, synced = _sync(test_client, child_id)
    assert code == 200, synced
    data = synced["data"]
    assert data["task_found"] is True
    assert data["changed"] is True
    assert data["status"] == "completed"
    # 主产物键是 output_url，artifact_url_from_result 已认它——sync 逻辑一行未改
    assert data["artifact_url"] == (
        "/static/projects/proj_demo/freezone/video/job_1_full.mp4"
    )
    # 查任务用的 task_type 取自版本自己记下的那个，不是硬编码的渲染类型
    assert manager.calls[-1]["task_type"] == "freezone_video_reshoot"
    assert manager.calls[-1]["scope"] == body["data"]["job_id"]

    after = _lines(state_dir)
    assert len(after) == len(before) + 1
    assert all(line in after for line in before)
    terminal = json.loads([line for line in after if '"status":"completed"' in line][-1])
    assert terminal["version_id"] == child_id
    assert terminal["parent_version_id"] == source["version_id"]
    for field in (
        "parent_version_id",
        "prompt_delta",
        "model_snapshot",
        "cost_ledger",
    ):
        assert terminal[field] not in (None, {}), field
    assert terminal["source_refs"]["artifact_url"].endswith("job_1_full.mp4")

    # 渲染版本的 sync 行为零变化：task_type 仍回退到 freezone_video_gen
    render_manager = _use_fake_task_manager(monkeypatch, _task_state(status="running"))
    ready = _ready_version(test_client)
    rendered = _render(test_client, ready["version_id"], duration_seconds=6)
    assert rendered[0] == 200, rendered
    code, _ = _sync(test_client, ready["version_id"])
    assert code == 200
    assert render_manager.calls[-1]["task_type"] == "freezone_video_gen"


def test_reshoot_guards_write_nothing_on_every_failure_path(
    client, monkeypatch
) -> None:
    """(a)(c) 守卫失败路径一行都不写：非 completed / 无素材 / 区间非法 / 外链 / 越界。"""
    _use_reshoot_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)
    backend = _use_fake_task_backend(monkeypatch)
    test_client, state_dir = client
    _create(test_client)
    _status, ready = _append_version(
        test_client, prompt="未渲染", status="ready", model_id=VIDEO_MODEL
    )
    assert _status == 200, ready
    before = _lines(state_dir)

    # 状态：ready（未出片）→ 409 并带实际 status
    status, body = _reshoot(test_client, ready["data"]["version_id"])
    assert status == 409
    assert "not completed" in body["detail"]
    assert "ready" in body["detail"]

    # 素材：completed 但没有 artifact_url，且请求也没给 source_url → 409
    _status, no_asset = _append_version(
        test_client,
        prompt="没有产物",
        status="completed",
        model_id=VIDEO_MODEL,
        source_refs={"canvas_id": "canvas_a"},
    )
    assert _status == 200, no_asset
    status, body = _reshoot(test_client, no_asset["data"]["version_id"])
    assert status == 409
    assert "no source video" in body["detail"]

    # 素材：外链（非项目内路径）→ 400，不静默放行
    status, body = _reshoot(
        test_client,
        no_asset["data"]["version_id"],
        source_url="https://evil.example.com/x.mp4",
    )
    assert status == 400

    # 区间：end <= start → 400，与既有 freezone reshoot 口径一致
    _write_asset(state_dir, SOURCE_ASSET_REL)
    _status, completed = _append_version(
        test_client,
        prompt="已出片",
        status="completed",
        model_id=VIDEO_MODEL,
        source_refs={"canvas_id": "canvas_a", "artifact_url": SOURCE_URL},
    )
    assert _status == 200, completed
    source = completed["data"]
    before = _lines(state_dir)
    status, body = _reshoot(
        test_client, source["version_id"], start_seconds=5.0, end_seconds=5.0
    )
    assert status == 400
    assert "end_seconds must be greater than start_seconds" in body["detail"]

    # 区间越界：短于 minDuration → 400 并给出边界，不静默截断
    status, body = _reshoot(
        test_client, source["version_id"], start_seconds=0.0, end_seconds=1.0
    )
    assert status == 400
    assert "shorter than model min duration" in body["detail"]
    assert "2" in body["detail"]
    # 区间超上限 → 400 并给出边界
    status, body = _reshoot(
        test_client, source["version_id"], start_seconds=0.0, end_seconds=20.0
    )
    assert status == 400
    assert "exceeds model max duration" in body["detail"]
    assert "12" in body["detail"]

    # 所有失败路径加起来：一行都没写，也没有入队
    assert backend.calls == []
    assert _lines(state_dir) == before


def test_reshoot_refuses_models_without_first_last_frame_mode(
    client, monkeypatch
) -> None:
    """模型未声明 firstLastFrame → 400（这是重拍唯一的生成路径）。"""
    _use_reshoot_catalog(
        monkeypatch, entry={**CATALOG_ENTRY, "supportedModes": ["text_to_video"]}
    )
    _fake_quote_port(monkeypatch)
    backend = _use_fake_task_backend(monkeypatch)
    test_client, state_dir = client
    _write_asset(state_dir, SOURCE_ASSET_REL)
    source = _completed_version(test_client)
    before = _lines(state_dir)

    status, body = _reshoot(test_client, source["version_id"])
    assert status == 400
    assert "first_last_frame" in body["detail"]
    assert backend.calls == []
    assert _lines(state_dir) == before


def test_reshoot_refuses_when_capabilities_cannot_be_resolved(
    client, monkeypatch
) -> None:
    """目录取不到 → capabilities_known=false 显式拒绝，不按已支持继续。"""
    from novelvideo.api.routes import freezone

    async def no_catalog(media_type, *, requester_user_id):
        del media_type, requester_user_id
        return None

    monkeypatch.setattr(freezone, "_scoped_media_model_catalog", no_catalog)
    _fake_quote_port(monkeypatch)
    backend = _use_fake_task_backend(monkeypatch)
    test_client, state_dir = client
    _write_asset(state_dir, SOURCE_ASSET_REL)
    source = _completed_version(test_client)
    before = _lines(state_dir)

    status, body = _reshoot(test_client, source["version_id"], model_id="ghost-model")
    assert status == 409
    assert "capabilities_known=false" in body["detail"]
    assert backend.calls == []
    assert _lines(state_dir) == before


def test_reshoot_propagates_task_backend_errors_as_503(client, monkeypatch) -> None:
    """后端启动失败 → 503，且不留下任何新版本行。"""
    _use_reshoot_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)

    class ExplodingBackend(_FakeTaskBackend):
        async def enqueue_project_task(self, *args, **kwargs):
            raise RuntimeError("task backend down")

    import novelvideo.ports as ports

    monkeypatch.setattr(ports, "get_task_backend", lambda: ExplodingBackend())
    test_client, state_dir = client
    _write_asset(state_dir, SOURCE_ASSET_REL)
    source = _completed_version(test_client)
    before = _lines(state_dir)

    status, body = _reshoot(test_client, source["version_id"])
    assert status == 503
    assert "task backend down" in body["detail"]
    assert _lines(state_dir) == before


def test_reshoot_404s_for_unknown_recipe_and_version(client, monkeypatch) -> None:
    _use_reshoot_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)
    _use_fake_task_backend(monkeypatch)
    test_client, _state_dir = client
    _create(test_client)

    response = test_client.post(
        "/api/v1/projects/proj_demo/shot-recipes/recipe_missing"
        "/versions/v1/reshoot",
        json={"model_id": VIDEO_MODEL, "start_seconds": 1.0, "end_seconds": 5.0},
    )
    assert response.status_code == 404

    status, body = _reshoot(test_client, "v99")
    assert status == 404
    assert "version not found" in body["detail"]


def test_reshoot_segment_schema_is_owned_by_the_store() -> None:
    """重拍描述符的 schema 只有 store 一个 owner：非法输入 raise，不写畸形描述符。"""
    with pytest.raises(ValueError):
        store.build_reshoot_segment(
            source_version_id="",
            start_seconds=1.0,
            end_seconds=5.0,
            source_url=SOURCE_URL,
            job_id="job_1",
        )
    with pytest.raises(ValueError):
        store.build_reshoot_segment(
            source_version_id="v1",
            start_seconds=1.0,
            end_seconds=5.0,
            source_url="",
            job_id="job_1",
        )
    with pytest.raises(ValueError):
        store.build_reshoot_segment(
            source_version_id="v1",
            start_seconds=5.0,
            end_seconds=5.0,
            source_url=SOURCE_URL,
            job_id="job_1",
        )

    segment = store.build_reshoot_segment(
        source_version_id="v1",
        start_seconds=1.0,
        end_seconds=5.0,
        source_url=SOURCE_URL,
        job_id="job_1",
    )
    assert segment == {
        "kind": store.RESHOOT_SEGMENT_KEY,
        "source_version_id": "v1",
        "start_seconds": 1.0,
        "end_seconds": 5.0,
        "duration_seconds": 4.0,
        "source_url": SOURCE_URL,
        "job_id": "job_1",
    }


# --------------------------------------------------------------------------
# T019：渲染消费画布上游参考素材（白模视频 → 成片）
# --------------------------------------------------------------------------


GREYBOX_URL = "/static/projects/proj_demo/freezone/_uploads/greybox.mp4"
GREYBOX_POSTER_URL = "/static/projects/proj_demo/freezone/_uploads/greybox.png"
IMAGE_REF_URL = "/static/projects/proj_demo/freezone/_uploads/ref.png"


def _greybox_canvas(state_dir, *, canvas_id: str = "canvas_a") -> None:
    """白模节点 →（派生）video 节点这条真实来源边；渲染节点就是它的下游那个 video 节点。"""
    _write_canvas_graph(
        state_dir,
        canvas_id,
        [
            _canvas_node(
                "desk_1",
                "videoNode",
                videoUrl=GREYBOX_URL,
                previewImageUrl=GREYBOX_POSTER_URL,
                isGreyboxNode=True,
            ),
            _canvas_node("node_1", "videoNode"),
        ],
        [_canvas_edge("desk_1", "node_1")],
    )


def test_render_consumes_upstream_greybox_video_as_reference(
    client, monkeypatch
) -> None:
    """白模视频真的进了生成任务：reference_items 带它、模式切 all_reference、计费如实。"""
    _use_video_catalog(monkeypatch, entry=REFERENCE_CATALOG_ENTRY)
    _fake_quote_port(monkeypatch)
    backend = _use_fake_task_backend(monkeypatch)
    test_client, state_dir = client
    _greybox_canvas(state_dir)
    _write_asset(state_dir, "freezone/_uploads/greybox.mp4")
    ready = _ready_version(
        test_client, source_refs={"canvas_id": "canvas_a", "node_id": "node_1"}
    )
    before = _lines(state_dir)

    status, body = _render(
        test_client, ready["version_id"], duration_seconds=6, resolution="1080p"
    )
    assert status == 200, body
    payload = backend.calls[0]["payload"]
    # 参考条目形状与 ShotReference 一致：{type,path,role}，path 是项目内路径
    assert payload["reference_items"] == [
        {
            "type": "video",
            "path": (state_dir / "freezone/_uploads/greybox.mp4").as_posix(),
            "role": "画布参考",
        }
    ]
    # 只收视频一条：同一节点的预览海报是缩略图，不能当第二条参考
    assert payload["gen_mode"] == "all_reference"
    assert payload["requested_gen_mode"] == "allReference"
    # 计费反映真实情况
    assert payload["billing"]["video_input_present"] is True
    assert payload["billing"]["operation"] == "allReference"
    assert payload["billing"]["feature_key"] == "freezone.video_generate"
    # 版本行记下消费到的参考节点 id（下一片据此建「白模节点 → 渲染节点」的显式边）
    assert body["data"]["source_refs"]["reference_node_ids"] == ["desk_1"]
    rendering = [
        json.loads(line) for line in _lines(state_dir) if '"status":"rendering"' in line
    ]
    assert len(rendering) == 1
    assert rendering[0]["source_refs"]["reference_node_ids"] == ["desk_1"]
    assert rendering[0]["source_refs"]["job_id"] == body["data"]["job_id"]
    # 父行逐字节未变，只多一行
    assert all(line in _lines(state_dir) for line in before)
    assert len(_lines(state_dir)) == len(before) + 1


def test_render_uses_image_to_video_for_image_only_references(
    client, monkeypatch
) -> None:
    """只有图片参考 → imageToVideo；没有视频参考时 video_input_present 仍为 False。"""
    _use_video_catalog(monkeypatch, entry=REFERENCE_CATALOG_ENTRY)
    _fake_quote_port(monkeypatch)
    backend = _use_fake_task_backend(monkeypatch)
    test_client, state_dir = client
    _write_canvas_graph(
        state_dir,
        "canvas_a",
        [
            _canvas_node("img_1", "imageGenNode", imageUrl=IMAGE_REF_URL),
            _canvas_node("node_1", "videoNode"),
        ],
        [_canvas_edge("img_1", "node_1")],
    )
    _write_asset(state_dir, "freezone/_uploads/ref.png")
    ready = _ready_version(
        test_client, source_refs={"canvas_id": "canvas_a", "node_id": "node_1"}
    )

    status, body = _render(
        test_client, ready["version_id"], duration_seconds=6, resolution="1080p"
    )
    assert status == 200, body
    payload = backend.calls[0]["payload"]
    assert [item["type"] for item in payload["reference_items"]] == ["image"]
    assert payload["gen_mode"] == "image_to_video"
    assert payload["requested_gen_mode"] == "imageToVideo"
    assert payload["billing"]["video_input_present"] is False
    assert payload["billing"]["operation"] == "imageToVideo"


def test_render_without_references_stays_text_to_video_and_records_none(
    client, monkeypatch
) -> None:
    """无参考（画布上没连上游素材）行为与切片前一致：text_to_video + 空参考。"""
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)
    backend = _use_fake_task_backend(monkeypatch)
    test_client, state_dir = client
    ready = _ready_version(
        test_client, source_refs={"canvas_id": "canvas_a", "node_id": "node_1"}
    )

    status, body = _render(
        test_client, ready["version_id"], duration_seconds=6, resolution="1080p"
    )
    assert status == 200, body
    payload = backend.calls[0]["payload"]
    assert payload["reference_items"] == []
    assert payload["gen_mode"] == "text_to_video"
    assert payload["requested_gen_mode"] == "textToVideo"
    assert payload["billing"]["video_input_present"] is False
    assert payload["billing"]["operation"] == "textToVideo"
    rendering = [
        json.loads(line) for line in _lines(state_dir) if '"status":"rendering"' in line
    ]
    assert rendering[0]["source_refs"]["reference_node_ids"] == []


def test_render_refuses_mode_the_model_does_not_declare(client, monkeypatch) -> None:
    """有视频参考但模型没声明 all_reference → 400，绝不静默降级回 text_to_video。"""
    _use_video_catalog(monkeypatch)
    _fake_quote_port(monkeypatch)
    backend = _use_fake_task_backend(monkeypatch)
    test_client, state_dir = client
    _greybox_canvas(state_dir)
    _write_asset(state_dir, "freezone/_uploads/greybox.mp4")
    ready = _ready_version(
        test_client, source_refs={"canvas_id": "canvas_a", "node_id": "node_1"}
    )
    before = _lines(state_dir)

    status, body = _render(
        test_client, ready["version_id"], duration_seconds=6, resolution="1080p"
    )
    assert status == 400, body
    assert "does not support all_reference mode" in body["detail"]
    assert backend.calls == []
    assert _lines(state_dir) == before


def test_render_refuses_unresolvable_reference_assets(client, monkeypatch) -> None:
    """画布上的参考素材解析不到（文件不在项目里）→ 400，不放行也不写行。"""
    _use_video_catalog(monkeypatch, entry=REFERENCE_CATALOG_ENTRY)
    _fake_quote_port(monkeypatch)
    backend = _use_fake_task_backend(monkeypatch)
    test_client, state_dir = client
    _write_canvas_graph(
        state_dir,
        "canvas_a",
        [
            _canvas_node("desk_1", "videoNode", videoUrl=GREYBOX_URL),
            _canvas_node("node_1", "videoNode"),
        ],
        [_canvas_edge("desk_1", "node_1")],
    )
    # 故意不写 greybox.mp4：素材丢了
    ready = _ready_version(
        test_client, source_refs={"canvas_id": "canvas_a", "node_id": "node_1"}
    )
    before = _lines(state_dir)

    status, body = _render(
        test_client, ready["version_id"], duration_seconds=6, resolution="1080p"
    )
    assert status == 400, body
    assert "reference assets rejected" in body["detail"]
    assert "file not found" in body["detail"]
    assert backend.calls == []
    assert _lines(state_dir) == before


def test_render_refuses_more_references_than_the_catalog_allows(
    client, monkeypatch
) -> None:
    """条数上限用目录声明收口：超限 400 并给出上限值。"""
    _use_video_catalog(
        monkeypatch, entry={**REFERENCE_CATALOG_ENTRY, "referenceVideoMax": 1}
    )
    _fake_quote_port(monkeypatch)
    backend = _use_fake_task_backend(monkeypatch)
    test_client, state_dir = client
    _write_canvas_graph(
        state_dir,
        "canvas_a",
        [
            _canvas_node(
                "desk_1",
                "videoNode",
                videoUrl="/static/projects/proj_demo/freezone/_uploads/a.mp4",
            ),
            _canvas_node(
                "desk_2",
                "videoNode",
                videoUrl="/static/projects/proj_demo/freezone/_uploads/b.mp4",
            ),
            _canvas_node("node_1", "videoNode"),
        ],
        [_canvas_edge("desk_1", "node_1"), _canvas_edge("desk_2", "node_1")],
    )
    _write_asset(state_dir, "freezone/_uploads/a.mp4")
    _write_asset(state_dir, "freezone/_uploads/b.mp4")
    ready = _ready_version(
        test_client, source_refs={"canvas_id": "canvas_a", "node_id": "node_1"}
    )
    before = _lines(state_dir)

    status, body = _render(
        test_client, ready["version_id"], duration_seconds=6, resolution="1080p"
    )
    assert status == 400, body
    assert "too many video references: 2 > 1" in body["detail"]
    assert backend.calls == []
    assert _lines(state_dir) == before


def test_preflight_reports_upstream_references_and_effective_mode(
    client, monkeypatch
) -> None:
    """预检按同一份判读报告上游参考与真实模式，且依然只读。"""
    _use_video_catalog(monkeypatch, entry=REFERENCE_CATALOG_ENTRY)
    _fake_quote_port(monkeypatch)
    backend = _use_fake_task_backend(monkeypatch)
    test_client, state_dir = client
    _greybox_canvas(state_dir)
    _write_asset(state_dir, "freezone/_uploads/greybox.mp4")
    ready = _ready_version(
        test_client, source_refs={"canvas_id": "canvas_a", "node_id": "node_1"}
    )
    before_bytes = _recipe_file(state_dir).read_bytes()

    status, body = _preflight(test_client, ready["version_id"], model_id=VIDEO_MODEL)
    assert status == 200, body
    report = body["data"]
    checks = _checks(report)
    assert report["warnings"] == []
    assert report["blocking"] == []
    # 模式检查判的是这次渲染真会用的模式，不是恒定的 text_to_video
    assert checks["model_capabilities"]["status"] == "pass"
    assert "mode=all_reference" in checks["model_capabilities"]["detail"]
    # 素材检查升级成「能解析出参考」的真实判读
    assert checks["source_refs"]["status"] == "pass"
    assert "1 video" in checks["source_refs"]["detail"]
    assert "desk_1" in checks["source_refs"]["detail"]
    assert checks["source_refs"]["detail"].endswith("gen_mode=all_reference")
    # 只读：不写行、不入队
    assert _recipe_file(state_dir).read_bytes() == before_bytes
    assert backend.calls == []


def test_preflight_warns_on_broken_upstream_reference_without_blocking(
    client, monkeypatch
) -> None:
    """上游参考解析不到 → warn（不是 pass，也不是 block）：预检自己不阻止调用方。"""
    _use_video_catalog(monkeypatch, entry=REFERENCE_CATALOG_ENTRY)
    _fake_quote_port(monkeypatch)
    backend = _use_fake_task_backend(monkeypatch)
    test_client, state_dir = client
    _write_canvas_graph(
        state_dir,
        "canvas_a",
        [
            _canvas_node("desk_1", "videoNode", videoUrl=GREYBOX_URL),
            _canvas_node("node_1", "videoNode"),
        ],
        [_canvas_edge("desk_1", "node_1")],
    )
    ready = _ready_version(
        test_client, source_refs={"canvas_id": "canvas_a", "node_id": "node_1"}
    )
    before_bytes = _recipe_file(state_dir).read_bytes()

    status, body = _preflight(test_client, ready["version_id"], model_id=VIDEO_MODEL)
    assert status == 200, body
    report = body["data"]
    checks = _checks(report)
    assert checks["source_refs"]["status"] == "warn"
    assert "file not found" in checks["source_refs"]["detail"]
    assert report["ok"] is True
    assert report["blocking"] == []
    assert report["warnings"] == ["source_refs"]
    assert _recipe_file(state_dir).read_bytes() == before_bytes
    assert backend.calls == []


def test_canvas_reference_resolution_ignores_nodes_without_media() -> None:
    """一跳上游遍历：没有素材的上游节点不算参考，同一 URL 只收一条。"""
    payload = {
        "nodes": [
            _canvas_node("text_1", "textAnnotationNode", content="旁白"),
            _canvas_node("desk_1", "videoNode", videoUrl=GREYBOX_URL),
            _canvas_node("desk_2", "videoNode", videoUrl=GREYBOX_URL),
            _canvas_node("node_1", "videoNode"),
            _canvas_node("downstream_1", "videoNode"),
        ],
        "edges": [
            _canvas_edge("text_1", "node_1"),
            _canvas_edge("desk_1", "node_1"),
            _canvas_edge("desk_2", "node_1"),
            _canvas_edge("node_1", "downstream_1"),
        ],
    }
    candidates = shot_recipes_route._canvas_reference_candidates(payload, "node_1")
    assert candidates == [("video", GREYBOX_URL, "desk_1")]


# --------------------------------------------------------------------------
# T021：API 级全链路 e2e demo（oracle final_proof 的 e2e receipt）
#
#   create → bind look decision → preflight → render → sync(completed)
#     → reshoot（源版本 = 上一步 render+sync 真产出的那条）→ sync(completed)
#     → quality → lineage
#
# 只有 task backend 与 task manager 是假的：render / sync / reshoot / preflight /
# quality 全部走真实 HTTP 端点，版本行全部由生产代码写出。本片要补的是
# render → sync → reshoot 这条缝——源版本不是 append 出来的 completed 行，而是
# render 入队 + sync 回写真产出的那条，且它的 artifact_url 指向磁盘上真实存在的
# 文件（源素材缺失时 reshoot 会按设计 404，那正是这条缝的证明点）。
# --------------------------------------------------------------------------

# 目录条目必须同时满足两步：渲染吃视频参考（all_reference）、重拍走首尾帧锚定
# （first_last_frame）。两个模式都要声明——没声明就 400，正是既有设计。
E2E_CATALOG_ENTRY = {
    **REFERENCE_CATALOG_ENTRY,
    "supportedModes": [
        "text_to_video",
        "image_to_video",
        "all_reference",
        "first_last_frame",
    ],
}

GREYBOX_ASSET_REL = "freezone/_uploads/greybox.mp4"
RENDER_ARTIFACT_REL = "freezone/video/e2e_render.mp4"
RENDER_ARTIFACT_URL = "/static/projects/proj_demo/freezone/video/e2e_render.mp4"
RESHOOT_ARTIFACT_REL = "freezone/video/e2e_reshoot.mp4"
RESHOOT_ARTIFACT_URL = "/static/projects/proj_demo/freezone/video/e2e_reshoot.mp4"


def _write_demo_video(state_dir, rel: str) -> int:
    """在项目里落一段真能解码的 mp4，返回字节数。

    ffmpeg 在就用它生成 1 秒片，否则写最小占位字节。这不是装饰：reshoot 会把源版本
    的 ``artifact_url`` 解析成项目内路径并要求文件存在，所以假 manager 的 result
    必须指向磁盘上真实的文件。
    """
    path = state_dir / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        subprocess.run(
            [
                ffmpeg,
                "-y",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=320x240:d=1",
                "-pix_fmt",
                "yuv420p",
                "-r",
                "24",
                str(path),
            ],
            check=True,
            capture_output=True,
        )
    else:
        path.write_bytes(b"\x00\x00\x00\x18ftypmp42" + bytes(64))
    return path.stat().st_size


def _version_lines(state_dir, version_id: str) -> list[str]:
    """某一版本的全部行（append-only 的保持性断言要用逐字节比较）。"""
    return [
        line
        for line in _lines(state_dir)
        if str(json.loads(line).get("version_id") or "") == version_id
    ]


def test_e2e_demo_full_pipeline_render_sync_reshoot_lineage(
    client, monkeypatch
) -> None:
    """一条流程串起全链路，产物是 final_proof 要的 lineage trace（打印成 receipt）。"""
    _use_video_catalog(monkeypatch, E2E_CATALOG_ENTRY)
    _fake_quote_port(monkeypatch, total_cost=42)
    backend = _use_fake_task_backend(monkeypatch)
    _use_identity_library(
        monkeypatch, [_character("谢铮", [_identity(identity_id="谢铮_皇帝")])]
    )
    test_client, state_dir = client

    # ---- 1) create recipe --------------------------------------------
    assert _create(test_client)["recipe_id"] == RECIPE

    # ---- 2) bind look decision（按 identity_id 解析真实角色库）--------
    status, decision = _bind_look_decision(test_client, identity_id="谢铮_皇帝")
    assert status == 200, decision
    look_id = decision["data"]["decision_id"]
    assert decision["data"]["identity_known"] is True

    # ---- 3) 画布：白模来源边 desk_1 → node_1 + 真实素材文件 -----------
    _greybox_canvas(state_dir)
    greybox_bytes = _write_demo_video(state_dir, GREYBOX_ASSET_REL)
    assert greybox_bytes > 0

    # ---- 4) ready 版本绑定渲染节点与造型决策 --------------------------
    ready = _ready_version(
        test_client,
        source_refs={"canvas_id": "canvas_a", "node_id": "node_1"},
        look_decision_ids=[look_id],
    )
    v1 = ready["version_id"]
    assert v1 == "v1"
    lines_before_preflight = _lines(state_dir)

    # ---- 5) preflight：入队之前先回答「这条配方能不能渲染」-------------
    status, body = _preflight(
        test_client, v1, duration_seconds=6, resolution="1080p"
    )
    assert status == 200, body
    preflight = body["data"]
    assert preflight["ok"] is True, preflight["blocking"]
    checks = _checks(preflight)
    assert set(checks) == set(store.PREFLIGHT_CHECK_IDS)
    assert checks[store.PREFLIGHT_CHECK_SOURCE_REFS]["status"] == "pass"
    assert "desk_1" in checks[store.PREFLIGHT_CHECK_SOURCE_REFS]["detail"]
    assert checks[store.PREFLIGHT_CHECK_LOOK_DECISIONS]["status"] == "pass"
    assert checks[store.PREFLIGHT_CHECK_BILLING]["status"] == "pass"
    # 预检只读：一行未写、一个任务未入队
    assert _lines(state_dir) == lines_before_preflight
    assert backend.calls == []

    # ---- 6) render：白模视频真的作为参考素材进了生成任务 ---------------
    status, body = _render(test_client, v1, duration_seconds=6, resolution="1080p")
    assert status == 200, body
    rendered = body["data"]
    render_job = rendered["job_id"]
    render_call = backend.calls[0]
    payload = render_call["payload"]
    assert render_call["task_type"] == "freezone_video_gen"
    assert render_call["product_surface"] == "freezone"
    assert render_call["queue_kind"] == "video"
    assert render_call["episode"] == 0
    assert render_call["scope"] == render_job
    assert payload["recipe_id"] == RECIPE
    assert payload["version_id"] == v1
    assert payload["reference_items"] == [
        {
            "type": "video",
            "path": (state_dir / GREYBOX_ASSET_REL).as_posix(),
            "role": "画布参考",
        }
    ]
    assert payload["gen_mode"] == "all_reference"
    assert payload["billing"]["video_input_present"] is True
    assert payload["billing"]["operation"] == "allReference"
    assert payload["billing"]["feature_key"] == "freezone.video_generate"
    assert rendered["status"] == "rendering"
    assert rendered["source_refs"]["reference_node_ids"] == ["desk_1"]
    assert rendered["cost_ledger"]["quoted"] is True
    assert rendered["cost_ledger"]["total_cost"] == 42
    render_bytes = _write_demo_video(state_dir, RENDER_ARTIFACT_REL)
    assert render_bytes > 0

    # ---- 7) sync：任务终态回写，v1 拿到真产物 --------------------------
    _use_fake_task_manager(
        monkeypatch,
        _task_state(
            status="completed",
            result={
                "job_id": render_job,
                "output_path": str(state_dir / RENDER_ARTIFACT_REL),
                "output_url": RENDER_ARTIFACT_URL,
            },
        ),
    )
    status, body = _sync(test_client, v1)
    assert status == 200, body
    assert body["data"]["task_found"] is True
    assert body["data"]["changed"] is True
    assert body["data"]["status"] == "completed"
    assert body["data"]["artifact_url"] == RENDER_ARTIFACT_URL
    v1_lines = _version_lines(state_dir, v1)
    # 源版本确实来自 render→sync，而不是 append 出来的一条 completed 行：
    # ready / rendering / completed 三行俱在，才有下面这次重拍。
    assert [json.loads(line)["status"] for line in v1_lines] == [
        "ready",
        "rendering",
        "completed",
    ]
    # render 后那行带 reference_node_ids，但**没有** artifact_url：产物要等任务终态，
    # 提前写一个 url 就是伪造产物。artifact_url 与 reference_node_ids 同时在终态行上。
    rendering_line = json.loads(v1_lines[1])
    assert rendering_line["source_refs"]["reference_node_ids"] == ["desk_1"]
    assert "artifact_url" not in rendering_line["source_refs"]
    v1_completed = json.loads(v1_lines[-1])
    assert v1_completed["status"] == "completed"
    assert v1_completed["source_refs"]["artifact_url"] == RENDER_ARTIFACT_URL
    assert v1_completed["source_refs"]["reference_node_ids"] == ["desk_1"]
    assert v1_completed["source_refs"]["job_id"] == render_job
    for field in (
        "parent_version_id",
        "prompt_delta",
        "model_snapshot",
        "cost_ledger",
    ):
        assert v1_completed[field] not in (None, {}), field
    assert v1_completed["prompt_delta"]["changes"]["render"]["task_status"] == (
        "completed"
    )
    assert v1_completed["model_snapshot"]["capabilities_known"] is True
    assert v1_completed["cost_ledger"]["quoted"] is True
    # 源版本成片真的在磁盘上——这是下面重拍不 404 的前提
    assert (state_dir / RENDER_ARTIFACT_REL).is_file()
    # append-only：之前写的每一行都还在
    assert all(line in _lines(state_dir) for line in lines_before_preflight)

    # ---- 8) reshoot：源版本就是上一步 render+sync 真产出的那条 --------
    status, body = _reshoot(
        test_client,
        v1,
        start_seconds=1.0,
        end_seconds=5.0,
        prompt="把这段改成夜戏",
    )
    assert status == 200, body
    reshoot = body["data"]
    v2 = reshoot["version_id"]
    reshoot_job = reshoot["job_id"]
    assert reshoot["source_version_id"] == v1
    assert reshoot["parent_version_id"] == v1
    assert reshoot["status"] == "rendering"
    assert v2 != v1
    assert len(backend.calls) == 2
    reshoot_call = backend.calls[1]
    assert reshoot_call["task_type"] == "freezone_video_reshoot"
    assert reshoot_call["scope"] == reshoot_job
    # 这条断言就是本片的核心：素材路径来自 v1 的 artifact_url，且文件真实存在
    assert reshoot_call["payload"]["source_path"] == str(
        state_dir / RENDER_ARTIFACT_REL
    )
    assert reshoot_call["payload"]["start_seconds"] == 1.0
    assert reshoot_call["payload"]["end_seconds"] == 5.0
    assert reshoot_call["payload"]["duration_seconds"] == 4
    # 父版本行逐字节不变
    assert _version_lines(state_dir, v1) == v1_lines

    # ---- 9) sync：重拍也走到终态 --------------------------------------
    reshoot_bytes = _write_demo_video(state_dir, RESHOOT_ARTIFACT_REL)
    assert reshoot_bytes > 0
    _use_fake_task_manager(
        monkeypatch,
        _task_state(
            status="completed",
            result={
                "job_id": reshoot_job,
                "output_path": str(state_dir / RESHOOT_ARTIFACT_REL),
                "output_url": RESHOOT_ARTIFACT_URL,
            },
        ),
    )
    status, body = _sync(test_client, v2)
    assert status == 200, body
    assert body["data"]["status"] == "completed"
    assert body["data"]["artifact_url"] == RESHOOT_ARTIFACT_URL
    v2_lines = _version_lines(state_dir, v2)
    v2_completed = json.loads(v2_lines[-1])
    assert v2_completed["version_id"] == v2
    assert v2_completed["parent_version_id"] == v1
    assert v2_completed["source_refs"]["reshoot_of"] == v1
    assert v2_completed["source_refs"]["artifact_url"] == RESHOOT_ARTIFACT_URL
    for field in (
        "parent_version_id",
        "prompt_delta",
        "model_snapshot",
        "cost_ledger",
    ):
        assert v2_completed[field] not in (None, {}), field
    assert v2_completed["prompt_delta"]["mode"] == "delta"
    assert (
        v2_completed["prompt_delta"]["changes"][store.RESHOOT_SEGMENT_KEY][
            "source_version_id"
        ]
        == v1
    )
    assert v2_completed["model_snapshot"]["capabilities_known"] is True
    assert v2_completed["cost_ledger"]["quoted"] is True
    # 重拍没有额外提交任务，也没有额外写出 v1 的行
    assert len(backend.calls) == 2
    assert _version_lines(state_dir, v1) == v1_lines

    # ---- 10) quality：结构化风险清单（不是分数）------------------------
    status, body = _quality(test_client, v1)
    assert status == 200, body
    v1_report = body["data"]
    assert set(v1_report) == {
        "recipe_id",
        "version_id",
        "risks",
        "counts",
        "risk_ids",
        "checked_at",
    }
    assert "score" not in v1_report
    assert v1_report["counts"]["critical"] == 0
    assert v1_report["risk_ids"] == []

    status, body = _quality(test_client, v2)
    assert status == 200, body
    v2_report = body["data"]
    assert v2_report["counts"]["critical"] == 0
    # 重拍只换了 4 秒片段（父版本 6 秒）：唯一的风险是如实记下的时长漂移
    assert v2_report["risk_ids"] == [store.QUALITY_RISK_DURATION_DRIFT]
    drift = _risks(v2_report)[store.QUALITY_RISK_DURATION_DRIFT]
    assert drift["severity"] == "info"
    assert float(drift["evidence"]["parent_duration_seconds"]) == 6.0
    assert float(drift["evidence"]["duration_seconds"]) == 4.0
    # 质量报告只读：没有入队新任务
    assert len(backend.calls) == 2

    # ---- 11) 读回：lineage trace --------------------------------------
    stored = {item["version_id"]: item for item in _get(test_client)["versions"]}
    assert set(stored) == {v1, v2}
    assert stored[v1]["status"] == "completed"
    assert stored[v1]["lineage"] == [v1]
    assert stored[v1]["source_refs"]["artifact_url"] == RENDER_ARTIFACT_URL
    assert stored[v2]["status"] == "completed"
    assert stored[v2]["lineage"] == [v1, v2]
    assert stored[v2]["source_refs"]["artifact_url"] == RESHOOT_ARTIFACT_URL
    assert stored[v2]["source_refs"]["reference_node_ids"] == ["desk_1"]

    print(
        "E2E_DEMO_RECEIPT "
        + json.dumps(
            {
                "recipe_id": RECIPE,
                "canvas_edge": "desk_1 -> node_1",
                "greybox_asset": {
                    "rel": GREYBOX_ASSET_REL,
                    "bytes": greybox_bytes,
                },
                "look_decision": {
                    "decision_id": look_id,
                    "identity_id": decision["data"]["identity_id"],
                    "identity_known": decision["data"]["identity_known"],
                },
                "preflight": {
                    "ok": preflight["ok"],
                    "blocking": preflight["blocking"],
                    "warnings": preflight["warnings"],
                    "checks": {
                        key: value["status"] for key, value in checks.items()
                    },
                    "source_refs_detail": checks["source_refs"]["detail"],
                },
                "render": {
                    "version_id": v1,
                    "job_id": render_job,
                    "task": {
                        key: render_call[key]
                        for key in (
                            "task_type",
                            "product_surface",
                            "queue_kind",
                            "episode",
                            "scope",
                        )
                    },
                    "payload": {
                        key: payload[key]
                        for key in (
                            "gen_mode",
                            "requested_gen_mode",
                            "aspect_ratio",
                            "resolution",
                            "duration_seconds",
                            "backend",
                            "catalog_id",
                        )
                    },
                    "reference_items": payload["reference_items"],
                    "video_input_present": payload["billing"][
                        "video_input_present"
                    ],
                    "reference_node_ids": rendered["source_refs"][
                        "reference_node_ids"
                    ],
                    "artifact": {
                        "rel": RENDER_ARTIFACT_REL,
                        "url": RENDER_ARTIFACT_URL,
                        "bytes": render_bytes,
                    },
                },
                "reshoot": {
                    "source_version_id": v1,
                    "version_id": v2,
                    "job_id": reshoot_job,
                    "task": {
                        key: reshoot_call[key]
                        for key in ("task_type", "queue_kind", "scope")
                    },
                    "source_path": reshoot_call["payload"]["source_path"],
                    "segment": {
                        key: reshoot_call["payload"][key]
                        for key in (
                            "start_seconds",
                            "end_seconds",
                            "duration_seconds",
                            "max_duration_seconds",
                        )
                    },
                    "artifact": {
                        "rel": RESHOOT_ARTIFACT_REL,
                        "url": RESHOOT_ARTIFACT_URL,
                        "bytes": reshoot_bytes,
                    },
                },
                "quality": {
                    v1: {"risk_ids": v1_report["risk_ids"]},
                    v2: {
                        "risk_ids": v2_report["risk_ids"],
                        "detail": drift["detail"],
                    },
                },
                "lineage_trace": {
                    v1: stored[v1]["lineage"],
                    v2: stored[v2]["lineage"],
                },
                # JSONL 原文的逐行投影：每行的 lineage 四字段 + 溯源键
                "file_lines": [
                    {
                        "version_id": row.get("version_id"),
                        "parent_version_id": row.get("parent_version_id"),
                        "status": row.get("status"),
                        "prompt_delta_mode": (row.get("prompt_delta") or {}).get(
                            "mode"
                        ),
                        "capabilities_known": (
                            row.get("model_snapshot") or {}
                        ).get("capabilities_known"),
                        "cost_quoted": (row.get("cost_ledger") or {}).get(
                            "quoted"
                        ),
                        "cost_total": (row.get("cost_ledger") or {}).get(
                            "total_cost"
                        ),
                        "job_id": (row.get("source_refs") or {}).get("job_id"),
                        "artifact_url": (row.get("source_refs") or {}).get(
                            "artifact_url"
                        ),
                        "reference_node_ids": (row.get("source_refs") or {}).get(
                            "reference_node_ids"
                        ),
                    }
                    for row in (json.loads(line) for line in _lines(state_dir))
                    if row.get("version_id")
                ],
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
