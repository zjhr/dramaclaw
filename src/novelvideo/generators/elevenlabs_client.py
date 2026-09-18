"""ElevenLabs 官方 API 客户端（不经 NewAPI 网关）。

语音与音乐的合成都走网关渠道（ChannelTypeElevenLabs）；这里只保留**网关接不了**
的三件事：

- 音色克隆：要上传参考音频（multipart）并配合项目侧的样本哈希缓存；
- 模型列表：``GET /v1/models``，用于设置页的连接自检；
- 音效回退：没配媒体模型映射时音效走官方 API（``/v1/sound-generation``）。

认证用 ``xi-api-key``，端点是 ``https://api.elevenlabs.io``。这里只做纯粹的
HTTP 调用（端点、认证、参数映射、二进制落盘、错误包装）；egress 闸门与计费由
调用方（``novelvideo.freezone.audio_node``）处理——那两件事本来就有现成实现，
塞进来会变成第二份真相。

组织模式（``egress_context.is_organization``）下一律拒绝：组织的出网流量必须
过网关闸门，这条与 ``IndexTTS2FalClient`` 的口径一致。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from novelvideo.egress_context import (
    TrustedEgressContext,
    ambient_organization_egress_context,
)
from novelvideo.model_gateway_settings import get_effective_elevenlabs_config


class ElevenLabsError(RuntimeError):
    """ElevenLabs 调用失败。``status`` 为 0 表示请求根本没发出去。"""

    def __init__(self, message: str, *, status: int = 0) -> None:
        super().__init__(message)
        self.status = status


def _error_text(response: Any) -> str:
    """从 ElevenLabs 的错误响应里取一句人话。

    它失败时返回 JSON ``{"detail": {...}}``，但网关/代理层也可能返回 HTML，
    所以先试 JSON，拿不到就截断原始文本。
    """
    try:
        payload = response.json()
    except Exception:
        return str(getattr(response, "text", "") or "")[:500]
    if isinstance(payload, dict):
        detail = payload.get("detail")
        if isinstance(detail, str):
            return detail
        if isinstance(detail, dict):
            message = detail.get("message") or detail.get("status")
            if isinstance(message, str) and message.strip():
                return message.strip()
        message = payload.get("message")
        if isinstance(message, str) and message.strip():
            return message.strip()
    return json.dumps(payload, ensure_ascii=False)[:500]


class ElevenLabsClient:
    """ElevenLabs 直连客户端。

    未配置 key 时 ``enabled`` 为假，调用方据此走原路径而不是在这里抛错——
    "没配 key" 是正常状态，不是异常。
    """

    def __init__(
        self,
        *,
        purpose: str = "",
        api_key: str | None = None,
        base_url: str | None = None,
        timeout_seconds: float | None = None,
        egress_context: TrustedEgressContext | None = None,
    ) -> None:
        """``purpose`` 是链路名（``speech`` / ``sfx``），用于日志与准入判断。

        省略 ``purpose`` 时 ``enabled`` 恒为假——调用方必须显式说明自己在哪条
        链路上，否则一个漏传参数的调用点会静默绕过检查。

        该不该走 ElevenLabs 由**媒体模型映射**（provider 字段）决定，不由这里
        的开关决定；本客户端只负责"key 在不在、能不能发出去"。
        """
        from novelvideo import config as _config

        effective = get_effective_elevenlabs_config()
        self.purpose = str(purpose or "").strip().lower()
        self.api_key = (
            api_key if api_key is not None else effective.api_key
        ).strip()
        self.base_url = (
            base_url if base_url is not None else effective.base_url
        ).strip().rstrip("/")
        self.timeout_seconds = float(
            timeout_seconds
            if timeout_seconds is not None
            else _config.ELEVENLABS_TIMEOUT_SECONDS
        )
        if egress_context is None:
            egress_context = ambient_organization_egress_context()
        self.egress_context = egress_context

    @property
    def enabled(self) -> bool:
        """该客户端是否可用：调用方说明了链路名，且 key 就位。"""
        return bool(self.api_key) and bool(self.purpose)

    def _assert_usable(self) -> None:
        """直连前的准入检查。组织模式直接拒，与 IndexTTS2FalClient 同口径。"""
        context = self.egress_context
        if context is not None:
            if (
                type(context) is not TrustedEgressContext
                or not context.is_organization
            ):
                raise ElevenLabsError("ORG_EGRESS_DENIED")
            # 走到这里说明确实是组织上下文：直连一律拒绝。
            raise ElevenLabsError("ORG_EGRESS_DENIED")
        if not self.api_key:
            raise ElevenLabsError("ELEVENLABS_API_KEY not set")

    def _headers(self, *, json_body: bool = True) -> dict[str, str]:
        headers = {"xi-api-key": self.api_key, "Accept": "audio/*"}
        if json_body:
            headers["Content-Type"] = "application/json"
        return headers

    async def _post_audio(
        self,
        path: str,
        *,
        body: dict[str, Any],
        output_path: Path,
        query: dict[str, str] | None = None,
        params: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """POST 一个返回音频流的端点并落盘。"""
        import httpx

        self._assert_usable()
        url = f"{self.base_url}{path}"
        target = Path(output_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.post(
                    url,
                    headers=self._headers(),
                    json=body,
                    params={**(query or {}), **(params or {})},
                )
        except httpx.HTTPError as exc:
            raise ElevenLabsError(f"elevenlabs request failed: {exc}") from exc
        if response.status_code >= 400:
            raise ElevenLabsError(
                f"elevenlabs {path} failed: {_error_text(response)}",
                status=response.status_code,
            )
        content = response.content
        if not content:
            raise ElevenLabsError(f"elevenlabs {path} returned empty audio")
        target.write_bytes(content)
        return {
            "output_path": str(target),
            "size": len(content),
            "content_type": response.headers.get("content-type", ""),
        }

    async def list_models(self) -> list[dict[str, Any]]:
        """列出账号可用的模型：``GET /v1/models``。

        只读探测，不消耗额度。返回项含 ``model_id`` / ``name`` / ``can_do_text_to_speech``
        等能力标记，调用方据此区分音乐与 TTS 模型。
        """
        import httpx

        self._assert_usable()
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(
                    f"{self.base_url}/v1/models",
                    headers={"xi-api-key": self.api_key, "Accept": "application/json"},
                )
        except httpx.HTTPError as exc:
            raise ElevenLabsError(f"elevenlabs list models failed: {exc}") from exc
        if response.status_code >= 400:
            raise ElevenLabsError(
                f"elevenlabs /v1/models failed: {_error_text(response)}",
                status=response.status_code,
            )
        try:
            payload = response.json()
        except Exception as exc:
            raise ElevenLabsError("elevenlabs list models returned no JSON") from exc
        items = payload if isinstance(payload, list) else payload.get("models")
        if not isinstance(items, list):
            return []
        return [item for item in items if isinstance(item, dict)]

    async def clone_voice(
        self,
        *,
        sample_path: str | Path,
        name: str,
        description: str = "",
        remove_background_noise: bool = True,
    ) -> str:
        """克隆音色：``POST /v1/voices/add``，返回 voice_id。

        即时克隆，无需训练队列。样本上限 10MB，超限时由调用方先裁剪——
        在这里静默截断等于给模型一个半截样本，克隆质量会悄悄劣化。
        """
        import httpx

        self._assert_usable()
        sample = Path(sample_path)
        if not sample.exists():
            raise ElevenLabsError(f"voice sample not found: {sample}")
        size = sample.stat().st_size
        if size > 10 * 1024 * 1024:
            raise ElevenLabsError(
                f"voice sample exceeds the 10MB limit ({size} bytes): {sample.name}"
            )
        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.post(
                    f"{self.base_url}/v1/voices/add",
                    headers=self._headers(json_body=False),
                    data={
                        "name": str(name or "DramaClaw Voice").strip(),
                        "description": str(description or "").strip(),
                        "remove_background_noise": (
                            "true" if remove_background_noise else "false"
                        ),
                    },
                    files={
                        "files": (
                            sample.name,
                            sample.read_bytes(),
                            "application/octet-stream",
                        )
                    },
                )
        except httpx.HTTPError as exc:
            raise ElevenLabsError(f"elevenlabs voice clone failed: {exc}") from exc
        if response.status_code >= 400:
            raise ElevenLabsError(
                f"elevenlabs /v1/voices/add failed: {_error_text(response)}",
                status=response.status_code,
            )
        try:
            voice_id = str(response.json().get("voice_id") or "").strip()
        except Exception as exc:
            raise ElevenLabsError("elevenlabs voice clone returned no JSON") from exc
        if not voice_id:
            raise ElevenLabsError("elevenlabs voice clone returned an empty voice_id")
        return voice_id

    async def generate_sound_effect(
        self,
        *,
        text: str,
        output_path: str | Path,
        duration_seconds: float | None = None,
        prompt_influence: float = 0.3,
    ) -> dict[str, Any]:
        """音效生成：``POST /v1/sound-generation``。"""
        clean_text = str(text or "").strip()
        if not clean_text:
            raise ElevenLabsError("sound effect prompt is empty")
        body: dict[str, Any] = {
            "text": clean_text,
            "prompt_influence": float(prompt_influence),
        }
        if duration_seconds is not None:
            body["duration_seconds"] = float(duration_seconds)
        return await self._post_audio(
            "/v1/sound-generation",
            body=body,
            output_path=Path(output_path),
        )
