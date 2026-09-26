from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest


def _load_plugin_module():
    tools_module = types.ModuleType("tools")
    registry_module = types.ModuleType("tools.registry")
    registry_module.tool_error = lambda value: value
    registry_module.tool_result = lambda value: value
    sys.modules.setdefault("tools", tools_module)
    sys.modules.setdefault("tools.registry", registry_module)

    path = Path(__file__).resolve().parents[1] / ".hermes" / "plugins" / "dramaclaw" / "__init__.py"
    spec = importlib.util.spec_from_file_location("test_dramaclaw_plugin", path)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_dramaclaw_plugin_adds_chat_error_without_replacing_task_error():
    plugin = _load_plugin_module()
    raw_error = "Content filter triggered. Finish reason: 'content_filter'"

    result = plugin._with_chat_error_hints(
        {
            "ok": True,
            "data": [
                {
                    "status": "failed",
                    "error": raw_error,
                    "metadata": {"provider_response_id": "resp_123"},
                }
            ],
        }
    )

    task = result["data"][0]
    assert task["error"] == raw_error
    assert task["chat_error"] == plugin.TEXT_CONTENT_FILTER_CHAT_ERROR
    assert "Do not quote the raw provider JSON" in task["agent_instruction"]


def test_dramaclaw_plugin_adds_voice_prereq_chat_error():
    plugin = _load_plugin_module()
    raw_error = "Beat 03 解说声线缺失：项目解说人声线未配置，请上传或录制解说人音频"

    result = plugin._with_chat_error_hints(
        {
            "status_code": 200,
            "ok": False,
            "code": "voice_prereq_required",
            "error": raw_error,
        }
    )

    assert result["error"] == raw_error
    assert "配音任务没有成功启动" in result["chat_error"]
    assert "虾塘" in result["chat_error"]
    assert raw_error in result["chat_error"]
    assert "Do not start another tool" in result["agent_instruction"]


def test_dramaclaw_plugin_adds_render_prereq_chat_error():
    plugin = _load_plugin_module()
    raw_error = (
        "Render 重生未生成可用图片（mode=1x1_2-3, beats=[1, 2, 3]）："
        "Render 模式需要草图但未找到覆盖 beat 1-1 的草图"
    )

    result = plugin._with_chat_error_hints(
        {
            "ok": True,
            "data": [
                {
                    "status": "failed",
                    "error": raw_error,
                }
            ],
        }
    )

    task = result["data"][0]
    assert task["error"] == raw_error
    assert "Render 任务没有生成可用图片" in task["chat_error"]
    assert "虾塘" in task["chat_error"]
    assert raw_error in task["chat_error"]
    assert "Do not start another tool" in task["agent_instruction"]


# --- 导演台 scope 的工具隔离 -------------------------------------------------
#
# 产品承诺：「agent 可以引用外部节点信息，**修改生成只作用于当前节点**」。
# 插件原本把 34 个工具无条件注册给所有 scope，agent 手里握着
# dramaclaw_generate_script / compose_episode 这些能改整个项目的家伙 —— 只靠
# 提示词约束等于没约束（模型不听话就穿透）。下面锁的是结构性保证。


def _fake_ctx():
    registered: list[str] = []

    def _register_tool(**kwargs):
        registered.append(kwargs["name"])

    return types.SimpleNamespace(register_tool=_register_tool), registered


def test_director_desk_registers_only_the_locked_down_tools(monkeypatch):
    plugin = _load_plugin_module()
    monkeypatch.setenv("DRAMACLAW_CHAT_SCOPE", "directorDesk")
    ctx, registered = _fake_ctx()

    plugin.register(ctx)

    assert set(registered) == {
        "dramaclaw_post",
        "dramaclaw_get",
        "dramaclaw_get_task",
        "dramaclaw_list_tasks",
        "dramaclaw_pipeline_status",
    }
    for banned in (
        "dramaclaw_generate_script",
        "dramaclaw_generate_sketches",
        "dramaclaw_compose_episode",
        "dramaclaw_plan_episodes",
        "dramaclaw_patch",
        "dramaclaw_delete",
    ):
        assert banned not in registered, f"{banned} 不该出现在导演台的工具集里"


def test_project_scope_keeps_the_full_toolset(monkeypatch):
    """项目助手不受影响 —— 少一个工具都是功能回归。"""
    plugin = _load_plugin_module()
    monkeypatch.setenv("DRAMACLAW_CHAT_SCOPE", "project")
    ctx, registered = _fake_ctx()

    plugin.register(ctx)

    assert len(registered) == len(plugin.TOOLS)
    assert "dramaclaw_generate_script" in registered


def test_director_desk_write_is_locked_to_the_node_panorama_route(monkeypatch):
    """工具白名单挡不住通用 HTTP 工具（`dramaclaw_post` 能打任意路由），
    所以写操作还要再卡一道路径白名单。"""
    plugin = _load_plugin_module()
    monkeypatch.setenv("DRAMACLAW_CHAT_SCOPE", "directorDesk")

    plugin._guard_chat_scope_write(
        "POST", "/api/v1/projects/p1/freezone/director-desk-panorama"
    )
    plugin._guard_chat_scope_write("GET", "/api/v1/projects/p1/episodes")

    for method, path in (
        ("POST", "/api/v1/projects/p1/episodes/plan"),
        ("PATCH", "/api/v1/projects/p1/characters/x"),
        ("DELETE", "/api/v1/projects/p1/tasks/t1"),
    ):
        with pytest.raises(PermissionError):
            plugin._guard_chat_scope_write(method, path)


def test_other_scopes_are_not_write_restricted(monkeypatch):
    plugin = _load_plugin_module()
    monkeypatch.setenv("DRAMACLAW_CHAT_SCOPE", "project")

    # 不抛 = 放行
    plugin._guard_chat_scope_write("POST", "/api/v1/projects/p1/episodes/plan")


def test_missing_chat_scope_keeps_the_old_unrestricted_behaviour(monkeypatch):
    """没注入作用域时（老 worker / 非 app 启动）保持全量，不退化成受限。"""
    plugin = _load_plugin_module()
    monkeypatch.delenv("DRAMACLAW_CHAT_SCOPE", raising=False)
    ctx, registered = _fake_ctx()

    plugin.register(ctx)

    assert len(registered) == len(plugin.TOOLS)
