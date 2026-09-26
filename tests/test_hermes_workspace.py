"""Unit tests for novelvideo.chat.hermes_workspace."""

from __future__ import annotations

import pytest
import yaml

from novelvideo import config as app_config
from novelvideo.chat import hermes_sdk
from novelvideo.chat import hermes_workspace as hw
from novelvideo.model_gateway_settings import (
    save_custom_newapi_gateway,
    save_official_newapi_key,
)


def _enabled_toolsets(config: str) -> list[str]:
    lines = config.splitlines()
    values: list[str] = []
    in_block = False
    for line in lines:
        if line.strip() == "enabled_toolsets:":
            in_block = True
            continue
        if in_block:
            if line.startswith("  - "):
                values.append(line.split("#", 1)[0].replace("  - ", "", 1).strip())
                continue
            if line and not line.startswith(" "):
                break
    return values


def _dramaclaw_provider(config: dict) -> dict:
    return next(
        item
        for item in config["custom_providers"]
        if item.get("name") == "dramaclaw"
    )


@pytest.fixture
def isolated_workspace(tmp_path, monkeypatch):
    """Redirect DRAMACLAW_ROOT/state and repo-pinned skills to a tmp tree."""
    repo_root = tmp_path / "repo"
    state_root = repo_root / "state"
    state_root.mkdir(parents=True)
    monkeypatch.setattr(hw, "DRAMACLAW_ROOT", repo_root)
    monkeypatch.setattr(app_config, "STATE_DIR", str(state_root))
    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_root))
    for key in (
        "NEWAPI_API_KEY",
        "NEWAPI_BASE_URL",
        "MODEL_GATEWAY_RUNTIME_VERSION",
        "OPENAI_API_KEY",
        "OPENAI_API_BASE",
        "OPENAI_BASE_URL",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.delenv("MODEL_GATEWAY_MODE", raising=False)
    monkeypatch.delenv("ST_HERMES_SKILLS", raising=False)
    monkeypatch.delenv("HERMES_MODEL", raising=False)
    monkeypatch.delenv("HERMES_MODEL_DEFAULT", raising=False)
    monkeypatch.delenv("DRAMACLAW_HERMES_MODEL", raising=False)
    monkeypatch.delenv("HERMES_MODEL_PROVIDER", raising=False)
    monkeypatch.delenv("HERMES_MODEL_BASE_URL", raising=False)
    monkeypatch.delenv("HERMES_MODEL_API_MODE", raising=False)
    monkeypatch.delenv("HERMES_MODEL_CONTEXT_LENGTH", raising=False)
    yield repo_root


@pytest.fixture
def repo_skills(isolated_workspace):
    """Create a fake repo .hermes/skills tree."""
    skills = isolated_workspace / ".hermes" / "skills"
    skills.mkdir(parents=True)
    for name in ("json-render", "dramaclaw", "other-skill"):
        (skills / name).mkdir()
        (skills / name / "SKILL.md").write_text(f"# {name}\n")
    return skills


@pytest.fixture
def repo_plugins(isolated_workspace):
    """Create a fake repo .hermes/plugins tree."""
    plugins = isolated_workspace / ".hermes" / "plugins"
    plugins.mkdir(parents=True)
    for name in ("dramaclaw", "other-plugin"):
        (plugins / name).mkdir()
        (plugins / name / "plugin.yaml").write_text(f"name: {name}\n")
    return plugins


def test_fresh_create_layout(isolated_workspace, repo_skills, repo_plugins):
    home = hw.ensure_user_hermes_workspace("admin")
    assert home.exists()
    assert (home / "config.yaml").exists()
    assert (home / ".env").exists()
    assert (home / "tmp").is_dir()
    assert (home / "skills" / "_user").is_dir()
    # Default allowlist should be symlinked in.
    assert (home / "skills" / "dramaclaw").is_symlink()
    assert not (home / "skills" / "json-render").exists()
    assert not (home / "skills" / "other-skill").exists()
    plugin_link = home / "plugins" / "dramaclaw"
    assert plugin_link.is_symlink()
    assert not (home / "plugins" / "other-plugin").exists()
    config = (home / "config.yaml").read_text()
    assert _enabled_toolsets(config) == ["hermes-acp", "memory"]
    assert "    - dramaclaw" in config
    assert "你是虾导" in (home / "SOUL.md").read_text()
    memory = (home / "memories" / "MEMORY.md").read_text()
    assert "虾导在 DramaClaw 会话中面向用户自称“虾导”" in memory
    assert "我是虾导，DramaClaw 的小说转视频创作助手。" not in memory


def test_hermes_initialize_timeout_allows_cold_start():
    assert hermes_sdk.INITIALIZE_TIMEOUT == 30.0


def test_hermes_stream_timeout_allows_long_active_turns():
    assert hermes_sdk.STREAM_IDLE_TIMEOUT == 300.0
    assert hermes_sdk.STREAM_TOTAL_TIMEOUT == 1800.0
    assert (
        hermes_sdk._refresh_stream_idle_deadline(
            now=100.0,
            total_deadline=1800.0,
        )
        == 400.0
    )
    assert (
        hermes_sdk._refresh_stream_idle_deadline(
            now=1700.0,
            total_deadline=1800.0,
        )
        == 1800.0
    )


@pytest.mark.asyncio
async def test_hermes_stream_timeout_retires_worker_before_completion(monkeypatch):
    thread = hermes_sdk.HermesSdkThread.__new__(hermes_sdk.HermesSdkThread)
    thread.id = "hermes-session"
    closed = []

    async def fake_close():
        closed.append(True)

    monkeypatch.setattr(thread, "close", fake_close)

    event = await thread._stream_timeout_event("turn-timeout")

    assert closed == [True]
    assert event.type == "complete"
    assert event.thread_id == "hermes-session"
    assert event.turn_id == "turn-timeout"
    assert event.text == "(hermes timed out)"


def test_hermes_detects_content_filter_finish_reason():
    payload = {
        "result": {
            "body": [
                {
                    "finish_reason": "content_filter",
                    "provider_details": {"finish_reason": "content_filter"},
                }
            ]
        }
    }

    assert hermes_sdk._has_content_filter_signal(payload)


def test_hermes_detects_content_filter_error_text():
    payload = {"error": {"message": "Content filter triggered. Finish reason: 'content_filter'"}}

    assert hermes_sdk._has_content_filter_signal(payload)


def test_hermes_classifies_dramaclaw_write_tools():
    assert hermes_sdk._is_dramaclaw_write_tool("dramaclaw_generate_script")
    assert hermes_sdk._is_dramaclaw_write_tool("dramaclaw_start_single_video")
    assert not hermes_sdk._is_dramaclaw_write_tool("dramaclaw_pipeline_status")
    assert not hermes_sdk._is_dramaclaw_write_tool("dramaclaw_get_task")


def test_hermes_allows_read_tools_after_write_task():
    assert not hermes_sdk._should_stop_after_write_tool(
        "dramaclaw_generate_script",
        "dramaclaw_pipeline_status",
    )
    assert not hermes_sdk._should_stop_after_write_tool(
        "dramaclaw_generate_script",
        "dramaclaw_get_task",
    )


def test_hermes_stops_second_write_tool_after_write_task():
    assert hermes_sdk._should_stop_after_write_tool(
        "dramaclaw_generate_script",
        "dramaclaw_start_single_video",
    )


def test_hermes_detects_failed_tool_update():
    assert hermes_sdk._is_failed_tool_update({"status": "failed"})
    assert hermes_sdk._is_failed_tool_update({"result": {"ok": False}})
    assert not hermes_sdk._is_failed_tool_update({"status": "completed"})


def test_hermes_does_not_mark_read_task_failure_as_first_write_failure():
    assert not hermes_sdk._should_mark_first_write_failed(
        "dramaclaw_generate_script",
        "dramaclaw_get_task",
        {"result": {"status": "failed", "error": "render failed"}},
    )
    assert hermes_sdk._should_mark_first_write_failed(
        "dramaclaw_generate_script",
        "dramaclaw_generate_script",
        {"result": {"ok": False, "error": "identity_plan_required"}},
    )


def test_state_root_prefers_env(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    assert hw._state_root() == tmp_path / "state"


def test_state_root_falls_back_to_repo(monkeypatch, tmp_path):
    monkeypatch.setattr(hw, "DRAMACLAW_ROOT", tmp_path / "repo")
    monkeypatch.delenv("NOVELVIDEO_STATE_DIR", raising=False)

    assert hw._state_root() == tmp_path / "repo" / "state"


def test_fresh_config_uses_model_env_but_keeps_newapi_transport(
    isolated_workspace, repo_skills, repo_plugins, monkeypatch
):
    save_official_newapi_key(api_key="root-key", activate=True)
    (isolated_workspace / ".env").write_text(
        "\n".join(
            [
                "NEWAPI_API_KEY=root-key",
                "HERMES_MODEL=gemini-3.5-flash",
                "HERMES_MODEL_PROVIDER=openrouter",
                "HERMES_MODEL_BASE_URL=http://newapi.local/v1",
                "HERMES_MODEL_API_MODE=responses",
                "HERMES_MODEL_CONTEXT_LENGTH=65536",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    home = hw.ensure_user_hermes_workspace("admin")
    config = (home / "config.yaml").read_text(encoding="utf-8")

    assert "  default: gemini-3.5-flash" in config
    parsed = yaml.safe_load(config)
    assert parsed["model"]["provider"] == "custom:dramaclaw"
    assert parsed["model"]["default"] == "gemini-3.5-flash"
    assert parsed["model"]["context_length"] == 65536
    assert "api_key" not in parsed["model"]
    provider = _dramaclaw_provider(parsed)
    assert provider == {
        "name": "dramaclaw",
        "base_url": app_config.OFFICIAL_NEWAPI_BASE_URL,
        "key_env": "NEWAPI_API_KEY",
        "api_mode": "responses",
    }


def test_existing_config_syncs_endpoint_without_persisting_rotated_key(
    isolated_workspace, repo_skills, repo_plugins
):
    save_custom_newapi_gateway(
        base_url="http://old-gateway/v1",
        api_key="old-key",
        activate=True,
    )
    home = hw.ensure_user_hermes_workspace("admin")
    config_path = home / "config.yaml"
    first = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    assert "api_key" not in first["model"]
    assert _dramaclaw_provider(first)["base_url"] == "http://old-gateway/v1"
    assert "old-key" not in config_path.read_text(encoding="utf-8")

    config = config_path.read_text(encoding="utf-8") + "\ncustom_block:\n  keep: true\n"
    config_path.write_text(config, encoding="utf-8")
    save_custom_newapi_gateway(
        base_url="http://new-gateway/v1",
        api_key="rotated-key",
        activate=True,
    )

    hw.ensure_user_hermes_workspace("admin")
    parsed = yaml.safe_load(config_path.read_text(encoding="utf-8"))

    assert "api_key" not in parsed["model"]
    assert _dramaclaw_provider(parsed)["base_url"] == "http://new-gateway/v1"
    assert _dramaclaw_provider(parsed)["key_env"] == "NEWAPI_API_KEY"
    assert "rotated-key" not in config_path.read_text(encoding="utf-8")
    assert parsed["custom_block"]["keep"] is True
    assert _enabled_toolsets(config_path.read_text(encoding="utf-8")) == [
        "hermes-acp",
        "memory",
    ]

    hw.ensure_user_hermes_workspace("admin")
    reparsed = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    assert reparsed["enabled_toolsets"] == ["hermes-acp", "memory"]


def test_hermes_uses_settings_db_newapi_before_root_env(
    isolated_workspace, repo_skills, repo_plugins
):
    (isolated_workspace / ".env").write_text(
        "NEWAPI_API_KEY=root-key\nNEWAPI_BASE_URL=http://root-gateway/v1\n",
        encoding="utf-8",
    )
    save_custom_newapi_gateway(
        base_url="http://custom-gateway/v1",
        api_key="custom-key",
        activate=True,
    )

    home = hw.ensure_user_hermes_workspace("admin")
    parsed = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    env_text = (home / ".env").read_text(encoding="utf-8")

    assert "api_key" not in parsed["model"]
    assert _dramaclaw_provider(parsed)["base_url"] == "http://custom-gateway/v1"
    assert _dramaclaw_provider(parsed)["key_env"] == "NEWAPI_API_KEY"
    assert "custom-key" not in (home / "config.yaml").read_text(encoding="utf-8")
    assert "OPENAI_API_KEY" not in env_text
    assert "root-key" not in env_text


def test_idempotent_rerun(isolated_workspace, repo_skills, repo_plugins):
    home1 = hw.ensure_user_hermes_workspace("admin")
    cfg_text = (home1 / "config.yaml").read_text(encoding="utf-8")
    # Touch user .env so we can verify it is NOT overwritten
    (home1 / ".env").write_text("# user customized\nOPENROUTER_API_KEY=secret\n")

    home2 = hw.ensure_user_hermes_workspace("admin")
    assert home2 == home1
    # config.yaml content not regenerated (we only write config changes when needed)
    assert (home1 / "config.yaml").read_text(encoding="utf-8") == cfg_text
    # .env preserved
    assert "OPENROUTER_API_KEY=secret" in (home1 / ".env").read_text()


def test_fresh_workspace_does_not_persist_newapi_key(
    isolated_workspace, repo_skills, repo_plugins, monkeypatch
):
    (isolated_workspace / ".env").write_text(
        "NEWAPI_API_KEY=test-newapi-key\n",
        encoding="utf-8",
    )
    save_official_newapi_key(api_key="test-newapi-key", activate=True)

    home = hw.ensure_user_hermes_workspace("admin")
    env_text = (home / ".env").read_text(encoding="utf-8")
    config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))

    assert "api_key" not in config["model"]
    assert _dramaclaw_provider(config)["key_env"] == "NEWAPI_API_KEY"
    assert "test-newapi-key" not in (home / "config.yaml").read_text(encoding="utf-8")
    assert "OPENAI_API_KEY" not in env_text


def test_existing_inline_key_is_removed_automatically(
    isolated_workspace, repo_skills, repo_plugins
):
    save_official_newapi_key(api_key="current-key", activate=True)
    home = isolated_workspace / "state" / "admin" / ".hermes"
    home.mkdir(parents=True)
    (home / "config.yaml").write_text(
        """model:
  default: legacy-model
  provider: custom
  base_url: https://legacy.example/v1
  api_key: legacy-key
custom_providers:
  - name: user-provider
    base_url: https://user.example/v1
    key_env: USER_PROVIDER_KEY
""",
        encoding="utf-8",
    )

    hw.ensure_user_hermes_workspace("admin")
    text = (home / "config.yaml").read_text(encoding="utf-8")
    config = yaml.safe_load(text)

    assert config["model"]["provider"] == "custom:dramaclaw"
    assert "api_key" not in config["model"]
    assert "legacy-key" not in text
    assert any(
        item.get("name") == "user-provider"
        for item in config["custom_providers"]
    )
    assert _dramaclaw_provider(config)["key_env"] == "NEWAPI_API_KEY"


def test_existing_env_is_preserved(
    isolated_workspace, repo_skills, repo_plugins, monkeypatch
):
    (isolated_workspace / ".env").write_text(
        "NEWAPI_API_KEY=root-key\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("NEWAPI_API_KEY", "root-key")
    home = isolated_workspace / "state" / "admin" / ".hermes"
    home.mkdir(parents=True)
    (home / ".env").write_text("OPENAI_API_KEY=user-key\n", encoding="utf-8")

    hw.ensure_user_hermes_workspace("admin")
    env_text = (home / ".env").read_text(encoding="utf-8")

    assert "OPENAI_API_KEY=user-key" in env_text


def test_legacy_config_gets_default_plugin_block(isolated_workspace, repo_skills, repo_plugins):
    home = isolated_workspace / "state" / "admin" / ".hermes"
    home.mkdir(parents=True)
    (home / "config.yaml").write_text("enabled_toolsets:\n  - dramaclaw\n")

    hw.ensure_user_hermes_workspace("admin")

    config = (home / "config.yaml").read_text()
    parsed = yaml.safe_load(config)
    assert _enabled_toolsets(config) == ["hermes-acp"]
    assert "plugins:\n  enabled:\n    - dramaclaw" in config
    assert parsed["model"]["default"] == "DC-hermes-LLM"
    assert parsed["model"]["provider"] == "custom:dramaclaw"
    assert _dramaclaw_provider(parsed)["key_env"] == "NEWAPI_API_KEY"


def test_legacy_identity_context_is_migrated(isolated_workspace, repo_skills, repo_plugins):
    home = isolated_workspace / "state" / "admin" / ".hermes"
    memories = home / "memories"
    memories.mkdir(parents=True)
    (home / "SOUL.md").write_text(hw._OLD_SOUL_PREFIX + "\n", encoding="utf-8")
    (memories / "MEMORY.md").write_text(hw._OLD_MEMORY_LINE + "\n", encoding="utf-8")

    hw.ensure_user_hermes_workspace("admin")

    soul = (home / "SOUL.md").read_text(encoding="utf-8")
    memory = (memories / "MEMORY.md").read_text(encoding="utf-8")
    assert "你是虾导" in soul
    assert "You are Hermes Agent" not in soul
    assert "我是虾导，DramaClaw 的小说转视频创作助手。" not in memory
    assert "DramaClaw 管理的虾导会话" in memory
    assert "DramaClaw 管理的 Hermes 会话" not in memory


def test_stale_symlinks_removed(isolated_workspace, repo_skills, repo_plugins):
    home = hw.ensure_user_hermes_workspace("admin")
    stale = home / "skills" / "json-render"
    stale.symlink_to(repo_skills / "json-render", target_is_directory=True)

    # Re-run; stale non-allowlisted symlink should be removed
    hw.ensure_user_hermes_workspace("admin")
    assert not (home / "skills" / "json-render").exists()
    assert (home / "skills" / "dramaclaw").is_symlink()  # still there


def test_stale_plugin_symlinks_removed(isolated_workspace, repo_skills, repo_plugins):
    home = hw.ensure_user_hermes_workspace("admin")
    import shutil

    shutil.rmtree(repo_plugins / "dramaclaw")
    hw.ensure_user_hermes_workspace("admin")
    assert not (home / "plugins" / "dramaclaw").exists()


def test_no_repo_skills_dir(isolated_workspace):
    """Missing repo .hermes/skills should not crash; just no skill links."""
    home = hw.ensure_user_hermes_workspace("admin")
    assert home.exists()
    assert (home / "skills").is_dir()
    # _user/ should still be there
    assert (home / "skills" / "_user").is_dir()
    # but no symlinks
    assert not any(p.is_symlink() for p in (home / "skills").iterdir())


def test_user_skill_dir_not_clobbered(isolated_workspace, repo_skills, repo_plugins):
    home = hw.ensure_user_hermes_workspace("admin")
    # user_skill ends up at _user — should still be writable / preserved
    user_skill = home / "skills" / "_user" / "my-favorite"
    user_skill.mkdir()
    (user_skill / "SKILL.md").write_text("# my favorite hack\n")
    hw.ensure_user_hermes_workspace("admin")
    assert (user_skill / "SKILL.md").read_text() == "# my favorite hack\n"


def test_chmod_700(isolated_workspace, repo_skills, repo_plugins):
    import os
    import stat

    home = hw.ensure_user_hermes_workspace("admin")
    mode = stat.S_IMODE(home.stat().st_mode)
    if os.name == "nt":
        # Windows has no POSIX permission bits; directories report 0o777.
        assert mode & stat.S_IRWXU == stat.S_IRWXU, f"unexpected mode {oct(mode)}"
    else:
        # On filesystems that support chmod, should be 0o700
        assert mode in (0o700, 0o755, 0o775), f"unexpected mode {oct(mode)}"


# --- session 恢复（2026-09-18 实测 hermes 的 ACP 行为）-----------------------
#
# 实测：hermes **不**跨进程恢复 session/load —— 对任何 id（包括它自己从没见过的）
# 都回 `{"result": {}}`，随后对该 id 的 `session/prompt` 立刻 `stopReason: refusal`，
# 一次模型调用都不发。真正能恢复的是 `session/resume`，而且它是 fork：必须采用响应里
# 返回的新 `acpSessionId`，用原来那个 id 去 prompt 同样被 refusal。
#
# 线上症状：面板显示 "(hermes returned no content)"，网关日志里一条请求都没有。


def test_hermes_resume_adopts_the_forked_session_id():
    resp = {
        "result": {
            "_meta": {
                "hermes": {
                    "sessionProvenance": {
                        "acpSessionId": "forked-session",
                        "currentHermesSessionId": "forked-session",
                    }
                }
            }
        }
    }

    assert hermes_sdk._resumed_session_id(resp) == "forked-session"


@pytest.mark.parametrize(
    "resp",
    [
        {"result": {}},  # session/load 的“成功”
        {"error": {"message": "boom"}},
        None,
        {},
    ],
)
def test_hermes_resume_id_absent_when_nothing_was_resumed(resp):
    """空的 `{"result": {}}` 必须判为“没恢复”，否则线程会钉在死 session 上。"""
    assert hermes_sdk._resumed_session_id(resp) == ""


def _resume_thread(monkeypatch, resume_response):
    """构造一个只有 `_ensure_session` 需要的字段的线程，并记录发出的 ACP 方法。"""
    thread = hermes_sdk.HermesSdkThread.__new__(hermes_sdk.HermesSdkThread)
    thread.id = "dead-session"
    thread._is_new = False
    thread._cwd = "/tmp"
    thread._proc = object()
    sent: list[str] = []

    async def fake_send(method, params):
        sent.append(method)
        return len(sent)

    async def fake_read_until_id(req_id, timeout):
        if sent[-1] == "session/resume":
            return resume_response, []
        return {"result": {"sessionId": "fresh-session"}}, []

    monkeypatch.setattr(thread, "_send", fake_send)
    monkeypatch.setattr(thread, "_read_until_id", fake_read_until_id)
    return thread, sent


@pytest.mark.asyncio
async def test_hermes_empty_resume_response_falls_back_to_session_new(monkeypatch):
    """回归：把空 resume 当成功曾经让每一轮都变成 refusal + 无内容。"""
    thread, sent = _resume_thread(monkeypatch, {"result": {}})

    await thread._ensure_session()

    assert sent == ["session/resume", "session/new"]
    assert thread.id == "fresh-session"


@pytest.mark.asyncio
async def test_hermes_successful_resume_keeps_the_returned_id(monkeypatch):
    thread, sent = _resume_thread(
        monkeypatch,
        {
            "result": {
                "_meta": {"hermes": {"sessionProvenance": {"acpSessionId": "forked-session"}}}
            }
        },
    )

    await thread._ensure_session()

    assert sent == ["session/resume"]
    assert thread.id == "forked-session"
