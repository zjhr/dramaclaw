"""ElevenLabs 音色克隆与 voice_id 缓存。

项目的音色解析产出的是**参考音频文件**（``FreezoneVoiceRefResolution.audio_path``），
而 ElevenLabs 要的是 **voice_id**。这里补上中间那层：拿样本音频克隆一次，把
voice_id 按样本的 sha256 缓存起来复用。

缓存必须按 sha256、不能按音色名：同一个角色换过样本后名字没变而音频变了，
按名字缓存会静默沿用旧声音——那是最难排查的一类问题，听起来"能用"，只是
人不对。

缓存位置与用户音色同级（``{OUTPUT_DIR}/{username}/_account/freezone/audio/voices``），
因为一个用户的音色通常跨项目复用，按项目缓存会重复克隆、白白占满账号的
音色配额。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from novelvideo.generators.elevenlabs_client import ElevenLabsClient


def elevenlabs_voice_index_path(username: str) -> Path:
    # 延迟导入：`audio_node` 会用本模块做 TTS 直连分支，模块级互相 import 会成环。
    from novelvideo.freezone.audio_node import user_audio_voices_dir

    return user_audio_voices_dir(username) / "elevenlabs_voices.json"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_voice_records(username: str) -> dict[str, dict]:
    """读缓存索引。任何损坏都当作空——缓存丢了只是多克隆一次，不该让任务失败。"""
    path = elevenlabs_voice_index_path(username)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    records = data.get("voices") if isinstance(data, dict) else None
    if not isinstance(records, dict):
        return {}
    return {
        str(key): value
        for key, value in records.items()
        if isinstance(value, dict) and value.get("voice_id")
    }


def load_cached_voice_id(username: str, sha256: str) -> str:
    digest = str(sha256 or "").strip()
    if not digest:
        return ""
    return str(load_voice_records(username).get(digest, {}).get("voice_id") or "")


def store_voice_id(
    username: str, *, sha256: str, voice_id: str, name: str
) -> None:
    digest = str(sha256 or "").strip()
    clean_voice = str(voice_id or "").strip()
    if not digest or not clean_voice:
        return
    path = elevenlabs_voice_index_path(username)
    records = load_voice_records(username)
    records[digest] = {
        "voice_id": clean_voice,
        "name": str(name or "").strip(),
        "created_at": _utc_now(),
    }
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"voices": records}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception:
        # 写缓存失败不该让已经成功的克隆作废——本次仍可用返回的 voice_id。
        pass


async def resolve_elevenlabs_voice_id(
    client: ElevenLabsClient,
    *,
    username: str,
    sample_path: Path,
    sha256: str,
    name: str,
) -> str:
    """拿到样本对应的 voice_id：先查缓存，未命中才克隆。"""
    cached = load_cached_voice_id(username, sha256)
    if cached:
        return cached
    voice_id = await client.clone_voice(
        sample_path=sample_path,
        name=name,
        description="DramaClaw cloned voice",
    )
    store_voice_id(username, sha256=sha256, voice_id=voice_id, name=name)
    return voice_id
