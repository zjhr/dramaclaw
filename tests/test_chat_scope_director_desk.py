# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""导演台对话的作用域契约。

用户对导演台 AI 对话的要求是「只作用于导演台，不影响其他」。落地方式是把这段
对话放进**自己的 scope**：存储与项目主对话物理隔离，但 scope 里仍带着项目 id，
所以 agent 的工具照常拿得到项目上下文（能读上游节点、读剧集资产）。

这个测试锁三件事：
1. 存储隔离 —— 导演台每个节点一本自己的对话库，且与项目主对话库不同；
2. 上下文保留 —— 同一个 scope 能解出真实项目 id，`project_dir` 仍是项目目录；
3. 不回归 —— project / home / asset / task 四条既有路径的解析逐字不变。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from novelvideo.api.routes.chat import _scope_conversation_dirs
from novelvideo.chat.store import (
    DIRECTOR_DESK_SCOPE_KIND,
    ChatScope,
    chat_store,
)
from novelvideo.project_context import ProjectContext


def _project_ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="01PROJ",
        project_name="agent_test",
        owner_type="user",
        owner_id="u1",
        owner_username="u1",
        requester_user_id="u1",
        requester_username="u1",
        requester_principals=(),
        effective_role="owner",
        home_node_id="node-local",
        output_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        is_home_node=True,
    )


def _desk_scope(node_id: str = "e0f4b9d3-4311-4401-b4e8-95b2a8b4c084") -> ChatScope:
    return ChatScope.from_payload(
        {"kind": DIRECTOR_DESK_SCOPE_KIND, "id": f"01PROJ/{node_id}"}
    )


class TestScopeParsing:
    def test_splits_project_and_node(self) -> None:
        scope = _desk_scope()
        assert scope.kind == "directorDesk"
        assert scope.project_id == "01PROJ"
        assert scope.conversation_key == "e0f4b9d3-4311-4401-b4e8-95b2a8b4c084"

    def test_project_scope_helpers_unchanged(self) -> None:
        scope = ChatScope(kind="project", id="01PROJ")
        assert scope.project_id == "01PROJ"
        # 项目对话没有「隔离键」—— 它就该落在项目自己的库里。
        assert scope.conversation_key is None

    @pytest.mark.parametrize("kind", ["home", "asset", "task"])
    def test_other_kinds_have_no_project(self, kind: str) -> None:
        scope = ChatScope(kind=kind, id=None if kind == "home" else "x")
        assert scope.project_id is None

    @pytest.mark.parametrize(
        "bad_id",
        [
            "../../etc/passwd",  # 路径穿越
            "01PROJ/a/b",  # 多一段
            "01PROJ",  # 少一段
            "01PROJ/..",  # 通配段
            "01PROJ/node;rm -rf",  # 非法字符
            "01PROJ/node with space",
            "",
        ],
    )
    def test_rejects_ids_that_could_escape_the_state_dir(self, bad_id: str) -> None:
        """id 会被当路径分量用，所以必须在入口卡死 —— 这是新增的攻击面。"""
        with pytest.raises(ValueError):
            ChatScope.from_payload({"kind": DIRECTOR_DESK_SCOPE_KIND, "id": bad_id})


class TestStorageIsolation:
    def test_desk_db_is_not_the_project_db(self, tmp_path: Path) -> None:
        desk = chat_store.db_for("u1", _desk_scope())
        project = chat_store.db_for("u1", ChatScope(kind="project", id="01PROJ"))
        assert desk != project
        assert "_directorDesk" in desk.parts
        assert desk.name == "chat.db"

    def test_each_node_gets_its_own_db(self) -> None:
        a = chat_store.db_for("u1", _desk_scope("node-a"))
        b = chat_store.db_for("u1", _desk_scope("node-b"))
        assert a != b
        assert a.parent.name == "node-a"
        assert b.parent.name == "node-b"

    def test_conversation_dirs_swap_state_but_keep_project_dir(
        self, tmp_path: Path
    ) -> None:
        """隔离靠换 state 目录（对话库落在那儿），项目目录必须原样保留。"""
        ctx = _project_ctx(tmp_path)
        project_dir, project_state_dir = _scope_conversation_dirs(
            ChatScope(kind="project", id="01PROJ"), ctx
        )
        desk_dir, desk_state_dir = _scope_conversation_dirs(_desk_scope("node-a"), ctx)

        # 项目对话：逐字不变
        assert Path(project_dir) == ctx.output_dir
        assert Path(project_state_dir) == ctx.state_dir
        # 导演台对话：换 state 子目录，项目目录不变
        assert Path(desk_dir) == ctx.output_dir
        assert Path(desk_state_dir) != ctx.state_dir
        assert Path(desk_state_dir).is_relative_to(ctx.state_dir)
        assert Path(desk_state_dir).parent.name == "director-desk-chat"

    def test_two_nodes_do_not_share_a_state_dir(self, tmp_path: Path) -> None:
        ctx = _project_ctx(tmp_path)
        _, a = _scope_conversation_dirs(_desk_scope("node-a"), ctx)
        _, b = _scope_conversation_dirs(_desk_scope("node-b"), ctx)
        assert a != b
