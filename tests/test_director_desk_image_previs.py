"""图片共创必须经过识图与方案确认，模型不能绕过执行限制。"""

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from novelvideo.director_desk import routes
from novelvideo.director_desk.ai_host import (
    DirectorDeskAiService,
    ProviderError,
    ToolContract,
    RunAborted,
)
from novelvideo.director_desk.image_previs import report_state
from novelvideo.director_desk.skill_store import SkillStore, package_from_folder
from test_director_desk_reference_images import ImageTransport, NODE, picture


def make_service(
    tmp_path: Path, replies: list[dict[str, Any]], *, skills: SkillStore | None = None
):
    """用真实循环和持久化，仅替换远程模型与 iframe。"""
    transport = ImageTransport()
    requests: list[dict[str, Any]] = []

    def model(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        reply = replies.pop(0)
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": reply,
                        "finish_reason": "tool_calls"
                        if reply.get("tool_calls")
                        else "stop",
                    }
                ]
            },
        )

    service = DirectorDeskAiService(
        skills=skills,
        data_dir=tmp_path,
        transport=transport,
        load_profiles=lambda: [
            {
                "id": "vision",
                "name": "测试渠道",
                "protocol": "chat",
                "base_url": "https://example.test/v1",
                "model": "vision-model",
                "key": "test-key",
                "stream": False,
                "max_tokens": 4096,
            }
        ],
        save_profiles=lambda _: None,
        http_transport=httpx.MockTransport(model),
    )
    read = {
        "name": "director_read",
        "description": "读工程",
        "inputSchema": {"type": "object"},
    }
    apply = {
        "name": "director_apply",
        "description": "改工程",
        "inputSchema": {"type": "object"},
    }
    service.set_contract(
        NODE,
        ToolContract.from_payload({"definitions": [read, apply], "discussion": [read]}),
    )
    return service, transport, requests


async def test_independent_skill_is_loaded_and_disabled_skill_stops_before_model(
    tmp_path: Path,
):
    """技能开关是真实执行边界；停用后不请求模型、不读写场景，确认也不能绕过。"""
    folder = (
        Path(__file__).resolve().parents[1]
        / "src/novelvideo/director_desk/skill_packages/image-previs"
    )
    pack = package_from_folder(folder)
    store = SkillStore(tmp_path / "skills", packaged_skills={"image-previs": pack})
    service, layer, requests = make_service(
        tmp_path / "conversations", [report()], skills=store
    )
    try:
        await service.run(
            node_id=NODE, profile_id="vision", prompt="先讨论图片", images=[picture()]
        )
        assert (
            "本轮自动使用的独立技能 image-previs"
            in requests[0]["messages"][0]["content"]
        )
        assert pack.instructions in requests[0]["messages"][0]["content"]
        plan_id = service.conversation(NODE)["imagePrevis"]["planId"]
        previous_calls = list(layer.calls)
        await store.enable("image-previs", False)
        for confirmation in ("", plan_id):
            with pytest.raises(ProviderError, match="技能未启用"):
                await service.run(
                    node_id=NODE,
                    profile_id="vision",
                    prompt="继续",
                    images=[picture()],
                    image_previs_confirmation=confirmation,
                )
        assert len(requests) == 1 and layer.calls == previous_calls
        assert not service.is_running(NODE)
    finally:
        service.close()


def call(name: str, args: dict[str, Any]) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": "",
        "tool_calls": [
            {
                "id": "call-1",
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(args)},
            }
        ],
    }


def report(status: str = "plan") -> dict[str, Any]:
    return call(
        "director_image_previs",
        {
            "status": status,
            "observation": "画面中左侧是红色圆形，右侧是蓝色方形。",
            "questions": ["希望运动多久？"] if status == "clarify" else [],
            "plan": "持续 6 秒，圆形向方形移动，摄影机平稳推近。"
            if status == "plan"
            else "",
        },
    )


async def test_image_request_cannot_write_before_consensus(tmp_path: Path):
    service, layer, requests = make_service(
        tmp_path, [call("director_apply", {"operations": []})]
    )
    try:
        result = await service.run(
            node_id=NODE,
            profile_id="vision",
            prompt="让图中物体相遇",
            images=[picture()],
        )
        assert result["stopped"] is True
        assert layer.calls == ["director_read"]
        assert "director_apply" not in [
            tool["function"]["name"] for tool in requests[0]["tools"]
        ]
        assert any(
            "确认" in event.get("text", "")
            for event in layer.events
            if event["type"] == "error"
        )
    finally:
        service.close()


async def test_report_creates_persisted_plan_and_only_exact_confirmation_executes(
    tmp_path: Path,
):
    service, layer, _ = make_service(
        tmp_path,
        [
            report(),
            call("director_apply", {"operations": []}),
            {"role": "assistant", "content": "预演已完成。"},
        ],
    )
    try:
        await service.run(
            node_id=NODE,
            profile_id="vision",
            prompt="物体相遇，6秒，推近",
            images=[picture()],
        )
        state = service.conversation(NODE)["imagePrevis"]
        assert state["stage"] == "ready" and state["planId"] and state["plan"]
        assert layer.calls == ["director_read"]
        await service.run(
            node_id=NODE,
            profile_id="vision",
            prompt="确认这版方案，开始预演",
            images=[picture()],
            image_previs_confirmation=state["planId"],
        )
        assert "director_apply" in layer.calls
        assert service.conversation(NODE)["imagePrevis"]["stage"] == "complete"
    finally:
        service.close()


async def test_source_change_rejects_old_plan_before_any_request(tmp_path: Path):
    service, layer, requests = make_service(tmp_path, [report()])
    try:
        await service.run(
            node_id=NODE, profile_id="vision", prompt="6秒推近", images=[picture()]
        )
        plan = service.conversation(NODE)["imagePrevis"]["planId"]
        with pytest.raises(ProviderError, match="重新"):
            await service.run(
                node_id=NODE,
                profile_id="vision",
                prompt="确认",
                images=[picture(color="blue")],
                image_previs_confirmation=plan,
            )
        assert len(requests) == 1 and layer.calls == ["director_read"]
    finally:
        service.close()


async def test_unsupported_vision_stops_with_change_model_action(tmp_path: Path):
    service, layer, requests = make_service(tmp_path, [report("unsupported")])
    try:
        result = await service.run(
            node_id=NODE, profile_id="vision", prompt="按图预演", images=[picture()]
        )
        assert result["stopped"] is True and len(requests) == 1
        assert layer.calls == ["director_read"]
        assert service.conversation(NODE)["imagePrevis"]["stage"] == "unsupported"
        assert any(
            "更换" in event.get("text", "")
            for event in layer.events
            if event["type"] == "error"
        )
    finally:
        service.close()


async def test_unstructured_answer_never_claims_completed_previs(tmp_path: Path):
    service, layer, _ = make_service(
        tmp_path, [{"role": "assistant", "content": "好的，制作完了。"}]
    )
    try:
        result = await service.run(
            node_id=NODE, profile_id="vision", prompt="按图预演", images=[picture()]
        )
        assert result["stopped"] is True
        assert service.conversation(NODE)["imagePrevis"]["stage"] == "unsupported"
        assert layer.calls == ["director_read"]
        assert not any(event["type"] == "done" for event in layer.events)
        assert any("未提交识图结果" in event.get("text", "") for event in layer.events)
    finally:
        service.close()


async def test_confirmation_without_scene_commit_cannot_claim_previs_complete(
    tmp_path: Path,
):
    service, layer, _ = make_service(
        tmp_path, [report(), {"role": "assistant", "content": "制作完成"}]
    )
    try:
        await service.run(
            node_id=NODE, profile_id="vision", prompt="6秒推近", images=[picture()]
        )
        plan_id = service.conversation(NODE)["imagePrevis"]["planId"]
        result = await service.run(
            node_id=NODE,
            profile_id="vision",
            prompt="确认",
            images=[picture()],
            image_previs_confirmation=plan_id,
        )
        assert result["stopped"] is True
        assert service.conversation(NODE)["imagePrevis"]["stage"] == "interrupted"
        assert "director_apply" not in layer.calls
        assert any("预演尚未生成" in event.get("text", "") for event in layer.events)
    finally:
        service.close()


async def test_revision_invalidates_old_plan_and_requires_new_confirmation(
    tmp_path: Path,
):
    service, layer, requests = make_service(tmp_path, [report(), report("clarify")])
    try:
        await service.run(
            node_id=NODE, profile_id="vision", prompt="6秒推近", images=[picture()]
        )
        plan_id = service.conversation(NODE)["imagePrevis"]["planId"]
        await service.run(
            node_id=NODE, profile_id="vision", prompt="改成8秒", images=[picture()]
        )
        state = service.conversation(NODE)["imagePrevis"]
        assert state["stage"] == "clarifying" and state["questions"]
        assert not state["planId"]
        with pytest.raises(ProviderError, match="重新"):
            await service.run(
                node_id=NODE,
                profile_id="vision",
                prompt="确认",
                images=[picture()],
                image_previs_confirmation=plan_id,
            )
        assert len(requests) == 2 and "director_apply" not in layer.calls
    finally:
        service.close()


@pytest.mark.parametrize("change", ["context", "model", "session", "discuss"])
async def test_confirmation_cannot_cross_context_model_session_or_mode(
    tmp_path: Path, change: str
):
    service, layer, requests = make_service(tmp_path, [report()])
    try:
        await service.run(
            node_id=NODE, profile_id="vision", prompt="6秒推近", images=[picture()]
        )
        plan_id = service.conversation(NODE)["imagePrevis"]["planId"]
        options: dict[str, Any] = {}
        if change == "context":
            options["context"] = "换成另一条分镜要求"
        elif change == "model":
            service.select_model("vision", "other-vision-model")
        elif change == "session":
            await service.new_conversation(NODE)
        else:
            options["mode"] = "discuss"
        with pytest.raises(ProviderError):
            await service.run(
                node_id=NODE,
                profile_id="vision",
                prompt="确认",
                images=[picture()],
                image_previs_confirmation=plan_id,
                **options,
            )
        assert len(requests) == 1 and layer.calls == ["director_read"]
    finally:
        service.close()


async def test_persisted_plan_restores_after_restart_and_cannot_be_replayed(
    tmp_path: Path,
):
    service, _, _ = make_service(tmp_path, [report()])
    await service.run(
        node_id=NODE, profile_id="vision", prompt="6秒推近", images=[picture()]
    )
    plan_id = service.conversation(NODE)["imagePrevis"]["planId"]
    service.close()
    service, layer, requests = make_service(
        tmp_path,
        [
            call("director_apply", {"operations": []}),
            {"role": "assistant", "content": "执行结束"},
        ],
    )
    try:
        assert service.conversation(NODE)["imagePrevis"]["planId"] == plan_id
        await service.run(
            node_id=NODE,
            profile_id="vision",
            prompt="确认",
            images=[picture()],
            image_previs_confirmation=plan_id,
        )
        assert "director_apply" in layer.calls
        with pytest.raises(ProviderError, match="重新"):
            await service.run(
                node_id=NODE,
                profile_id="vision",
                prompt="再确认",
                images=[picture()],
                image_previs_confirmation=plan_id,
            )
        assert len(requests) == 2
    finally:
        service.close()


async def test_user_stop_marks_execution_interrupted_in_saved_state(tmp_path: Path):
    service, layer, _ = make_service(
        tmp_path, [report(), call("director_apply", {"operations": []})]
    )
    original_call = layer.call

    async def interrupted_call(node: str, name: str, args: dict[str, Any]):
        if name == "director_apply":
            service.stop(NODE)
            raise RunAborted()
        return await original_call(node, name, args)

    try:
        await service.run(
            node_id=NODE, profile_id="vision", prompt="6秒推近", images=[picture()]
        )
        plan_id = service.conversation(NODE)["imagePrevis"]["planId"]
        layer.call = interrupted_call
        result = await service.run(
            node_id=NODE,
            profile_id="vision",
            prompt="确认",
            images=[picture()],
            image_previs_confirmation=plan_id,
        )
        assert result["stopped"] is True
        assert service.conversation(NODE)["imagePrevis"]["stage"] == "interrupted"
        assert not service.is_running(NODE)
        assert any(
            event["type"] == "image-previs"
            and event["imagePrevis"]["stage"] == "interrupted"
            for event in layer.events
        )
    finally:
        service.close()


async def test_report_cannot_be_batched_with_engine_write_even_when_confirmed(
    tmp_path: Path,
):
    mixed = report("unsupported")
    mixed["tool_calls"].extend(call("director_apply", {"operations": []})["tool_calls"])
    service, layer, _ = make_service(tmp_path, [report(), mixed])
    try:
        await service.run(
            node_id=NODE, profile_id="vision", prompt="6秒推近", images=[picture()]
        )
        plan_id = service.conversation(NODE)["imagePrevis"]["planId"]
        result = await service.run(
            node_id=NODE,
            profile_id="vision",
            prompt="确认",
            images=[picture()],
            image_previs_confirmation=plan_id,
        )
        assert result["stopped"] is True and "director_apply" not in layer.calls
    finally:
        service.close()


async def test_run_route_preserves_confirmation_for_real_execution(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    service, layer, _ = make_service(
        tmp_path,
        [
            report(),
            call("director_apply", {"operations": []}),
            {"role": "assistant", "content": "执行结束"},
        ],
    )
    monkeypatch.setattr(routes, "get_ai_service", lambda: service)
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1/director-desk")
    try:
        await service.run(
            node_id=NODE, profile_id="vision", prompt="6秒推近", images=[picture()]
        )
        plan_id = service.conversation(NODE)["imagePrevis"]["planId"]
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                "/api/v1/director-desk/ai/run",
                json={
                    "nodeId": NODE,
                    "profileId": "vision",
                    "prompt": "确认",
                    "images": [picture()],
                    "imagePrevisConfirmation": plan_id,
                },
            )
            assert response.status_code == 200
            for _ in range(100):
                if service.conversation(NODE)["imagePrevis"]["stage"] == "complete":
                    break
                await asyncio.sleep(0.01)
            assert service.conversation(NODE)["imagePrevis"]["stage"] == "complete"
            assert "director_apply" in layer.calls
    finally:
        service.close()


@pytest.mark.parametrize("bad_status", [[], {}, 0])
def test_invalid_model_report_status_is_a_validation_error(bad_status: Any):
    with pytest.raises(ValueError, match="状态"):
        report_state(
            {},
            {"status": bad_status, "observation": "图像", "questions": [], "plan": ""},
        )
