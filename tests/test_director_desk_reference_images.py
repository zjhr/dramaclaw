"""画布参考图片：实际图像校验、三协议请求、来源切换与会话恢复。"""

from __future__ import annotations

import asyncio
import base64
import json
from io import BytesIO
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from PIL import Image

from novelvideo.director_desk import reference_images, routes
from novelvideo.director_desk.ai_host import DirectorDeskAiService, ProviderError, ToolContract
from novelvideo.director_desk.reference_images import normalize_reference_images

NODE = "image-node"


def picture(fmt: str = "PNG", color: str = "red", size: tuple[int, int] = (8, 4)) -> str:
    """使用可真正解码的图片，不用伪 base64 绕过生产验证。"""
    buffer = BytesIO()
    Image.new("RGB", size, color).save(buffer, format=fmt)
    mime = reference_images._FORMATS[fmt]
    return f"data:{mime};base64,{base64.b64encode(buffer.getvalue()).decode()}"


@pytest.mark.parametrize("fmt", ["PNG", "JPEG", "WEBP", "GIF"])
def test_supported_image_formats_are_decodable(fmt: str) -> None:
    value = picture(fmt)
    assert normalize_reference_images([value]) == [value]


@pytest.mark.parametrize("value", ["https://example.com/image.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,%%%", "data:image/png;base64,", "data:image/png;base64,YWJj"])
def test_links_invalid_base64_and_non_images_are_rejected(value: str) -> None:
    with pytest.raises(ValueError, match="参考图片"):
        normalize_reference_images([value])


def test_mime_mismatch_multiple_images_and_size_limits(monkeypatch: pytest.MonkeyPatch) -> None:
    value = picture()
    with pytest.raises(ValueError, match="格式"):
        normalize_reference_images([value.replace("image/png", "image/jpeg")])
    with pytest.raises(ValueError, match="一张"):
        normalize_reference_images([value, value])
    with pytest.raises(ValueError, match="尺寸"):
        normalize_reference_images([picture(size=(4001, 4000))])
    raw_size = len(base64.b64decode(value.split(",")[1]))
    monkeypatch.setattr(reference_images, "MAX_REFERENCE_IMAGE_BYTES", raw_size)
    assert normalize_reference_images([value]) == [value]
    monkeypatch.setattr(reference_images, "MAX_REFERENCE_IMAGE_BYTES", raw_size - 1)
    with pytest.raises(ValueError, match="过大"):
        normalize_reference_images([value])
    monkeypatch.setattr(reference_images, "MAX_REFERENCE_DATA_URL_CHARS", len(value) - 1)
    with pytest.raises(ValueError, match="过大"):
        normalize_reference_images([value])


def test_corrupt_png_crc_becomes_a_readable_validation_error() -> None:
    value = picture()
    raw = bytearray(base64.b64decode(value.split(",")[1]))
    # 损坏 IDAT 校验码，Pillow.verify 会抛 SyntaxError，接口仍须返回普通输入错误。
    start = raw.index(b"IDAT")
    length = int.from_bytes(raw[start - 4:start], "big")
    raw[start + 4 + length] ^= 1
    broken = "data:image/png;base64," + base64.b64encode(raw).decode()
    with pytest.raises(ValueError, match="无法解码"):
        normalize_reference_images([broken])


class ImageTransport:
    """只替换 iframe 工具执行；模型请求与对话持久化仍走真实服务。"""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.events: list[dict[str, Any]] = []

    async def call(self, _node: str, name: str, _args: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(name)
        return {"ok": True, "revision": 1, "data": {"entityCount": 1}}

    def push_event(self, _node: str, event: dict[str, Any]) -> None:
        self.events.append(event)


def service_for(tmp_path: Path, protocol: str = "chat", status: int = 200) -> tuple[DirectorDeskAiService, list[dict[str, Any]], ImageTransport]:
    """捕获真正送入 HTTP 层的 JSON，三协议均用自身正常回包形状。"""
    requests: list[dict[str, Any]] = []
    layer = ImageTransport()

    def model(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        if status != 200:
            return httpx.Response(status, json={"error": "image input unsupported"})
        # 图像请求必须提交真正的阶段报告；协议测试继续走完整生产循环。
        image_report = {"status": "clarify", "observation": "参考图是红色画面。", "questions": ["希望演示什么动作？"], "plan": ""}
        has_image = "data:image/" in json.dumps(requests[-1])
        if protocol == "responses":
            reply = {"status": "completed", "output": [{"type": "function_call", "id": "fc-1", "call_id": "image-1", "name": "director_image_previs", "arguments": json.dumps(image_report)}] if has_image else [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "测试回复"}]}]}
        elif protocol == "anthropic":
            has_image = any(isinstance(message.get("content"), list) and any(block.get("type") == "image" for block in message["content"]) for message in requests[-1]["messages"])
            reply = {"stop_reason": "tool_use" if has_image else "end_turn", "content": [{"type": "tool_use", "id": "image-1", "name": "director_image_previs", "input": image_report}] if has_image else [{"type": "text", "text": "测试回复"}]}
        else:
            message: dict[str, Any] = {"role": "assistant", "content": "测试回复"}
            if has_image:
                message["tool_calls"] = [{"id": "image-1", "type": "function", "function": {"name": "director_image_previs", "arguments": json.dumps(image_report)}}]
            reply = {"choices": [{"message": message, "finish_reason": "tool_calls" if has_image else "stop"}]}
        return httpx.Response(200, json=reply)

    service = DirectorDeskAiService(
        data_dir=tmp_path, transport=layer,  # type: ignore[arg-type]
        load_profiles=lambda: [{"id": "vision", "name": "测试识图渠道", "protocol": protocol,
                                "base_url": "https://model.example/v1", "model": "vision-test",
                                "key": "test-key", "stream": False, "max_tokens": 4096}],
        save_profiles=lambda _profiles: None, http_transport=httpx.MockTransport(model),
    )
    read = {"name": "director_read", "description": "读取", "inputSchema": {"type": "object"}}
    service.set_contract(NODE, ToolContract.from_payload({"definitions": [read], "discussion": [read]}))
    return service, requests, layer


@pytest.mark.parametrize("protocol", ["chat", "responses", "anthropic"])
async def test_real_run_sends_decodable_image_blocks_in_each_protocol(tmp_path: Path, protocol: str) -> None:
    service, requests, layer = service_for(tmp_path, protocol)
    value = picture()
    try:
        result = await service.run(node_id=NODE, profile_id="vision", prompt="按参考画面安排构图", images=[value])
        assert result.get("stopped") is not True
        body = requests[0]
        content = next(message["content"] for message in body["input" if protocol == "responses" else "messages"] if message["role"] == "user")
        block = content[1]
        if protocol == "anthropic":
            assert block["type"] == "image" and block["source"]["media_type"] == "image/png"
            encoded = block["source"]["data"]
        else:
            assert block["type"] == ("input_image" if protocol == "responses" else "image_url")
            url = block["image_url"] if protocol == "responses" else block["image_url"]["url"]
            encoded = url.split(",", 1)[1]
        with Image.open(BytesIO(base64.b64decode(encoded))) as decoded:
            assert decoded.size == (8, 4)
            assert decoded.getpixel((0, 0)) == (255, 0, 0)
        assert any("参考图片已附上" in event.get("text", "") for event in layer.events)
        assert "base64," not in json.dumps(service.conversation(NODE), ensure_ascii=False)
    finally:
        service.close()


async def test_new_history_restart_and_source_change_keep_only_current_image(tmp_path: Path) -> None:
    service, requests, _layer = service_for(tmp_path)
    red, blue = picture(), picture(color="blue")
    await service.run(node_id=NODE, profile_id="vision", prompt="红图任务", images=[red])
    old = service.conversation(NODE)["sessionId"]
    await service.new_conversation(NODE)
    await service.run(node_id=NODE, profile_id="vision", prompt="蓝图任务", images=[blue])
    assert red not in json.dumps(requests[-1])
    await service.select_conversation(NODE, old)
    service.close()
    service, requests, _layer = service_for(tmp_path)
    try:
        restored = service._conversation(NODE)
        assert restored.id == old
        assert red in json.dumps(restored.messages(service._channel("vision")))
        await service.run(node_id=NODE, profile_id="vision", prompt="已换成文字来源", images=[])
        assert red not in json.dumps(requests[-1]) and blue not in json.dumps(requests[-1])
        await service.run(node_id=NODE, profile_id="vision", prompt="现在换成蓝图", images=[blue])
        assert red not in json.dumps(requests[-1])
        blocks = [message["content"] for message in requests[-1]["messages"] if isinstance(message["content"], list)]
        assert len(blocks) == 1 and blocks[0][1]["image_url"]["url"] == blue
    finally:
        service.close()


@pytest.mark.parametrize("status", [400, 415, 422])
async def test_channel_rejection_is_explicit_and_never_retried_without_image(tmp_path: Path, status: int) -> None:
    service, requests, layer = service_for(tmp_path, status=status)
    try:
        result = await service.run(node_id=NODE, profile_id="vision", prompt="按图摆放", images=[picture()])
        assert result["stopped"] is True
        assert len(requests) == 1
        errors = [event["text"] for event in layer.events if event["type"] == "error"]
        assert "支持图像输入" in errors[0] and "图片未被识读" in errors[0]
        assert layer.calls == ["director_read"]
    finally:
        service.close()


async def test_invalid_image_fails_before_run_registration_or_tool_call(tmp_path: Path) -> None:
    service, requests, layer = service_for(tmp_path)
    try:
        with pytest.raises(ProviderError, match="实际图像输入"):
            await service.run(node_id=NODE, profile_id="vision", prompt="按图摆放", images=["/static/missing.png"])
        assert not service.is_running(NODE) and not requests and not layer.calls
        assert service.conversation(NODE)["messages"] == []
    finally:
        service.close()


async def test_run_route_preserves_images_and_rejects_invalid_attachments(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    service, requests, _layer = service_for(tmp_path)
    monkeypatch.setattr(routes, "get_ai_service", lambda: service)
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1/director-desk")
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            invalid = await client.post("/api/v1/director-desk/ai/run", json={"nodeId": NODE, "prompt": "按图摆放", "images": ["https://example.com/p.png"]})
            assert invalid.status_code == 422 and not requests
            value = picture()
            accepted = await client.post("/api/v1/director-desk/ai/run", json={"nodeId": NODE, "profileId": "vision", "prompt": "按图摆放", "images": [value]})
            assert accepted.status_code == 200
            # 路由立即回包；只在局部测试中等后台真实循环结算。
            for _ in range(50):
                if requests and not service.is_running(NODE):
                    break
                await asyncio.sleep(0.01)
            assert requests[0]["messages"][-1]["content"][1]["image_url"]["url"] == value
    finally:
        service.close()
