"""导演台分镜来源：显式限定项目 beat 与画布单上游资料，拒绝静默换来源。"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from pydantic import ValidationError

from novelvideo.director_desk import routes


def _beat(number: int, text: str, duration: float = 8.2) -> dict[str, Any]:
    """原始项目字段与 beat_view 共享口径，画布输入采用同一形状。"""
    return {"beat_number": number, "visual_description": text, "duration_seconds": duration,
            "scene_ref": {"scene_id": "咖啡馆"}, "audio_type": "silence", "video_prompt": "暖黄灯光"}


class _Store:
    def __init__(self) -> None:
        self.beats = {1: [_beat(1, "林晚推门"), _beat(2, "她回头"), _beat(3, "餐桌特写")],
                      2: [_beat(1, "车内雨夜")]}
        self.requests: list[int] = []

    async def count_beats_by_episode(self) -> dict[int, int]:
        return {episode: len(beats) for episode, beats in self.beats.items()}

    async def list_episodes(self) -> list[SimpleNamespace]:
        """画布关联正常镜头前，项目必须存在对应的剧集记录。"""
        return [SimpleNamespace(number=number) for number in self.beats]

    async def get_beats_as_dicts(self, episode: int) -> list[dict[str, Any]]:
        self.requests.append(episode)
        return self.beats[episode]


@pytest.fixture
def store(monkeypatch: pytest.MonkeyPatch) -> _Store:
    import novelvideo.api.deps as deps

    current = _Store()

    class _Scope:
        async def __aenter__(self) -> _Store:
            return current

        async def __aexit__(self, *args: Any) -> None:
            return None

    async def resolve(*args: Any, **kwargs: Any) -> Any:
        return type("Project", (), {"ctx": object(), "username": "local", "project_name": "test"})()

    monkeypatch.setattr(deps, "resolve_project_scope", resolve)
    monkeypatch.setattr(deps, "sqlite_store_for_context_scope", lambda *args, **kwargs: _Scope())
    return current


async def test_project_source_returns_only_explicit_beats(store: _Store) -> None:
    response = await routes.storyboard(routes.StoryboardRequest(
        project="test", episode=1, beatNumbers=[1, 3], beat=3, sourceName="画布上游：咖啡馆镜组",
    ), user={"username": "local"})
    data = response["data"]
    assert [view["beat_number"] for view in data["beats"]] == [1, 3]
    assert data["selected"] == 3
    assert "画布上游：咖啡馆镜组" in data["context"]
    assert "餐桌特写" in data["context"]
    assert "她回头" not in data["context"]
    assert store.requests == [1]


@pytest.mark.parametrize("selection", [
    {"episode": 99}, {"episode": 1, "beat": 99},
    {"episode": 1, "beatNumbers": [1, 99]}, {"episode": 1, "beatNumbers": [1], "beat": 2},
])
async def test_missing_explicit_episode_or_beat_is_not_replaced(store: _Store, selection: dict[str, Any]) -> None:
    with pytest.raises(HTTPException) as failure:
        await routes.storyboard(routes.StoryboardRequest(project="test", **selection), user={"username": "local"})
    assert failure.value.status_code == 404
    if selection.get("episode") == 99:
        assert store.requests == []


async def test_empty_explicit_subset_does_not_fall_back_to_all_project_beats(store: _Store) -> None:
    data = (await routes.storyboard(routes.StoryboardRequest(
        project="test", episode=1, beatNumbers=[], sourceName="空镜组",
    ), user={"username": "local"}))["data"]
    assert data["beats"] == []
    assert data["selected"] is None
    assert data["context"] == ""


@pytest.fixture
async def persisted_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """只在临时库复现无剧集的测试残留，不写用户项目。"""
    import novelvideo.api.deps as deps
    from novelvideo.sqlite_store import SQLiteStore

    current = SQLiteStore(
        "local/storyboard-regression",
        output_dir=str(tmp_path / "output"),
        state_dir=str(tmp_path / "state"),
    )

    class _Scope:
        async def __aenter__(self) -> SQLiteStore:
            return current

        async def __aexit__(self, *args: Any) -> None:
            return None

    async def resolve(*args: Any, **kwargs: Any) -> Any:
        return SimpleNamespace(ctx=object(), username="local", project_name="storyboard-regression")

    monkeypatch.setattr(deps, "resolve_project_scope", resolve)
    monkeypatch.setattr(deps, "sqlite_store_for_context_scope", lambda *args, **kwargs: _Scope())
    try:
        db = await current._ensure_db()
        await db.execute(
            "INSERT INTO beats (episode_number, beat_number, visual_description, audio_type) "
            "VALUES (1, 1, ?, 'silence')",
            ("没有对应剧集的验收残留",),
        )
        await db.commit()
        yield current
    finally:
        await current.close()


async def test_project_catalogue_ignores_orphan_beats(persisted_store, caplog) -> None:
    """数据库存在镜头不代表存在可由项目页面访问的剧集。"""
    assert await persisted_store.list_episodes() == []
    assert await persisted_store.count_beats_by_episode() == {1: 1}

    data = (await routes.storyboard(
        routes.StoryboardRequest(project="test"), user={"username": "local"},
    ))["data"]

    assert data == {"episode": 0, "episodes": [], "beats": [], "context": ""}
    assert "无对应剧集" in caplog.text
    # 读取过滤不能顺带删除或改写原始数据。
    assert await persisted_store.count_beats_by_episode() == {1: 1}


@pytest.mark.parametrize("selection", [{"episode": 1}, {"beat": 1}, {"episode": 1, "beatNumbers": [1]}])
async def test_explicit_orphan_shot_is_rejected(persisted_store, selection: dict[str, Any]) -> None:
    """历史选中编号及上游编号均不能重新启用孤立镜头。"""
    with pytest.raises(HTTPException) as failure:
        await routes.storyboard(
            routes.StoryboardRequest(project="test", **selection), user={"username": "local"},
        )
    assert failure.value.status_code == 404


async def test_catalogue_requires_persisted_episode_without_hiding_valid_shots(persisted_store) -> None:
    """同库混有真实剧集与孤立镜头时，只向目录和模型送真实剧集。"""
    db = await persisted_store._ensure_db()
    await db.execute("INSERT INTO episodes (number, title) VALUES (2, '可见的真实剧集')")
    await db.execute(
        "INSERT INTO beats (episode_number, beat_number, visual_description, audio_type) "
        "VALUES (2, 1, ?, 'silence')",
        ("真实剧集的第一条镜头",),
    )
    # 最大编号也可能是孤立记录，不能把它当作默认的最新剧集。
    await db.execute(
        "INSERT INTO beats (episode_number, beat_number, visual_description, audio_type) "
        "VALUES (3, 1, ?, 'silence')",
        ("另一条验收残留",),
    )
    await db.commit()

    data = (await routes.storyboard(
        routes.StoryboardRequest(project="test"), user={"username": "local"},
    ))["data"]

    assert data["episode"] == 2
    assert data["episodes"] == [2]
    assert [beat["synopsis"] for beat in data["beats"]] == ["真实剧集的第一条镜头"]
    assert "真实剧集的第一条镜头" in data["context"]
    assert "验收残留" not in data["context"]


@pytest.mark.parametrize("fields", [
    {"beatNumbers": [0]}, {"beatNumbers": [-1]}, {"beatNumbers": [True]},
    {"beatNumbers": [1] * 201}, {"sourceName": "名" * 201},
])
def test_project_source_shape_is_bounded(fields: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        routes.StoryboardRequest(project="test", **fields)


async def test_canvas_source_uses_supplied_beats_without_reading_project_store() -> None:
    payload = routes.CanvasStoryboardRequest(
        sourceName="画布上游：角色镜头",
        beats=[_beat(1, "镜头一推门"), _beat(2, "镜头二回头", 5.0)], beat=2,
    )
    response = await routes.canvas_storyboard(payload, user={"username": "local"})
    data = response["data"]
    assert data["episode"] == 0
    assert data["episodes"] == []
    assert [view["beat_number"] for view in data["beats"]] == [1, 2]
    assert data["selected"] == 2
    assert data["beats"][1]["duration_seconds"] == 5.0
    assert "画布上游：角色镜头" in data["context"]
    assert "镜头二回头" in data["context"]
    assert '"targetDuration":5.0' in data["context"]


async def test_canvas_selected_missing_is_404() -> None:
    with pytest.raises(HTTPException) as failure:
        await routes.canvas_storyboard(routes.CanvasStoryboardRequest(
            sourceName="镜头一", beats=[_beat(1, "推门")], beat=2,
        ), user={"username": "local"})
    assert failure.value.status_code == 404


async def test_canvas_image_only_source_keeps_reference_without_fetching_image(monkeypatch: pytest.MonkeyPatch) -> None:
    """只有参考图也能建立分镜卡片与来源上下文，链接关联不伪装成视觉分析。"""
    def network_forbidden(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("分镜归一化不能请求参考图或其他网络资源")

    monkeypatch.setattr(httpx, "AsyncClient", network_forbidden)
    monkeypatch.setattr(httpx, "Client", network_forbidden)
    monkeypatch.setattr(httpx, "get", network_forbidden)
    image_url = "https://images.example/storyboard.jpg?frame=2"
    payload = routes.CanvasStoryboardRequest(sourceName="分格图片", beats=[{
        "beat_number": 1, "reference_image_url": image_url,
    }])
    data = (await routes.canvas_storyboard(payload, user={"username": "local"}))["data"]
    assert data["selected"] == 1
    assert len(data["beats"]) == 1
    assert data["beats"][0]["reference_image_url"] == image_url
    assert data["beats"][0]["synopsis"] == ""
    assert image_url in data["context"]
    assert "分格图片" in data["context"]
    assert "未对图片做视觉分析" in data["context"]
    assert "只有图片链接，尚无画面描述" in data["context"]


@pytest.mark.parametrize("beats", [
    [_beat(0, "错误编号")], [_beat(-1, "错误编号")], [_beat(True, "错误编号")],
    [_beat(1, "第一条"), _beat(1, "重复编号")],
    [_beat(1, "错误时长", float("nan"))], [_beat(1, "错误时长", float("inf"))],
    [_beat(1, "错误时长", -1)], [_beat(1, "错误时长", True)],
    [_beat(1, "错误时长", 10 ** 1000)],
    [{**_beat(1, "错误场景"), "scene_ref": "场景字符串"}],
    [{**_beat(1, "错误概要"), "visual_description": ["数组"]}],
    [{**_beat(1, "错误参考图"), "reference_image_url": ["数组"]}],
])
def test_canvas_beats_require_valid_unique_numbers_and_raw_field_shape(beats: list[dict[str, Any]]) -> None:
    with pytest.raises(ValidationError):
        routes.CanvasStoryboardRequest(sourceName="上游", beats=beats)


def test_canvas_limit_and_name_limit() -> None:
    with pytest.raises(ValidationError):
        routes.CanvasStoryboardRequest(sourceName="上游", beats=[_beat(i + 1, "镜头") for i in range(201)])
    with pytest.raises(ValidationError):
        routes.CanvasStoryboardRequest(sourceName="名" * 201, beats=[])


async def test_canvas_route_auth_and_http_response() -> None:
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1/director-desk")

    async def reject() -> dict[str, Any]:
        raise HTTPException(status_code=401, detail="请登录")

    app.dependency_overrides[routes._api_user] = reject
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        denied = await client.post("/api/v1/director-desk/storyboard/canvas", json={"sourceName": "上游", "beats": []})
        assert denied.status_code == 401
        app.dependency_overrides[routes._api_user] = lambda: {"username": "local"}
        response = await client.post("/api/v1/director-desk/storyboard/canvas", json={"sourceName": "单个镜头", "beats": [_beat(1, "推门")]})
        assert response.status_code == 200
        assert response.json()["data"]["selected"] == 1
        assert "单个镜头" in response.json()["data"]["context"]
