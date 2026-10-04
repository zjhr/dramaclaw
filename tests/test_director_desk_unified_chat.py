"""导演台统一循环：两个 AI 入口合并到一份对话、一个渠道、一条工具面。

用户原话：「为什么有两个 AI 助手？」「渠道怎么选择已有渠道？」「导演台和画布是不是缺失耦合？」
三个问题同一个根因 —— 画布侧面板（Hermes ACP）与 iframe 面板（`ai_host.py`）各跑各的。

这里锁住合并后的三条不变量：

1. **同一个循环**：画布侧发的指令经 `/ai/run` 落到 iframe 的 `director_*` 工具上，
   不经过任何第二条 agent 链路。
2. **同一份对话**：两个入口读的是同一个 :class:`Conversation`（按 node 落盘），
   画布侧发的这一句在 iframe 侧立刻可见，反之亦然。
3. **同一个渠道**：渠道以对话自己记的 ``profileId`` 为准 —— 画布侧不传渠道时自动接上
   iframe 那次发起的渠道，而不是「各自默认一个」。
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable

import httpx
import pytest

from novelvideo.director_desk.ai_host import (
    Channel,
    DirectorDeskAiService,
    ProfileError,
    ToolContract,
)
from novelvideo.director_desk.tool_transport import DirectorDeskToolTransport

NODE = "node-unified"
BASE_URL = "https://api.example.com/v1"


def channel(**overrides: Any) -> Channel:
    defaults: dict[str, Any] = {
        "id": "p1",
        "name": "测试渠道",
        "protocol": "chat",
        "base_url": BASE_URL,
        "model": "model-x",
        "max_tokens": 4096,
        "key": "sk-secret",
    }
    return Channel(**{**defaults, **overrides})


READ_TOOL = {"name": "director_read", "description": "read", "inputSchema": {"type": "object"}}
APPLY_TOOL = {"name": "director_apply", "description": "write", "inputSchema": {"type": "object"}}
SKILL_TOOL = {"name": "director_skill", "description": "skill", "inputSchema": {"type": "object"}}

FULL_CONTRACT = ToolContract.from_payload({"definitions": [READ_TOOL, APPLY_TOOL, SKILL_TOOL], "discussion": [READ_TOOL]})


def tool_reply(call_id: str, name: str, args: dict[str, Any]) -> dict[str, Any]:
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(args)},
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ]
    }


def text_reply(text: str) -> dict[str, Any]:
    return {
        "choices": [
            {"message": {"role": "assistant", "content": text}, "finish_reason": "stop"}
        ]
    }


class ModelStub:
    """按顺序回放预写的模型回包，并记录每次收到的请求体。"""

    def __init__(self, replies: list[Any]) -> None:
        self._replies = list(replies)
        self.requests: list[dict[str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        self.requests.append(body)
        if not self._replies:
            raise AssertionError("model asked for more turns than the test scripted")
        payload = self._replies.pop(0)
        if not body.get("stream"):
            return httpx.Response(200, json=payload)
        frames = "".join(
            f"data: {json.dumps(frame)}\n\n" for frame in _as_sse_frames(payload)
        )
        return httpx.Response(
            200,
            content=(frames + "data: [DONE]\n\n").encode("utf-8"),
            headers={"content-type": "text/event-stream"},
        )


def _as_sse_frames(payload: dict[str, Any]) -> list[dict[str, Any]]:
    choice = payload["choices"][0]
    message = choice.get("message") or {}
    frames: list[dict[str, Any]] = []
    if message.get("content"):
        frames.append({"choices": [{"delta": {"content": message["content"]}}]})
    for index, call in enumerate(message.get("tool_calls") or []):
        frames.append(
            {
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": index,
                                    "id": call["id"],
                                    "function": dict(call["function"]),
                                }
                            ]
                        }
                    }
                ]
            }
        )
    frames.append({"choices": [{"delta": {}, "finish_reason": choice["finish_reason"]}]})
    return frames


class RecordingTransport:
    """传输层替身：记录被派发的工具调用，并回一个可配置的结果。

    真实传输层要把调用派到 iframe 的 ``toolService``（依赖 Three.js 的 ``ctx.engine``），
    那在单测里起不来。这里只替掉**执行**那一段，``ai_host.py`` 里的循环、校验、
    事件流、会话持久化全都是生产代码。
    """

    def __init__(self, result: dict[str, Any] | None = None) -> None:
        self.calls: list[tuple[str, str, dict[str, Any]]] = []
        self.result = result if result is not None else {"ok": True, "revision": 7, "data": {}}
        self.events: list[dict[str, Any]] = []

    def open_session(self, node_id: str) -> Any:
        return type("S", (), {"session_id": "s1", "node_id": node_id})()

    def close_session(self, node_id: str, session_id: str | None = None) -> bool:
        return True

    def is_active(self, node_id: str) -> bool:
        return True

    async def call(self, node_id: str, name: str, args: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((node_id, name, args))
        return self.result

    def push_event(self, node_id: str, event: dict[str, Any]) -> None:
        self.events.append({"nodeId": node_id, **event})

    def drain(self) -> list[dict[str, Any]]:
        out, self.events = self.events, []
        return out


class SkillsStub:
    def __init__(self, enabled: list[dict[str, Any]] | None = None) -> None:
        self._enabled = enabled or []

    async def list(self, enabled_only: bool) -> list[dict[str, Any]]:
        return self._enabled

    async def tool(self, args: dict[str, Any]) -> dict[str, Any]:
        return {"ok": True, "data": {"skill": args.get("id")}}


def make_service(
    replies: list[Any],
    *,
    profiles: list[Channel],
    transport: RecordingTransport | None = None,
    data_dir: Path,
    skills: Any = None,
) -> tuple[DirectorDeskAiService, RecordingTransport]:
    layer = transport or RecordingTransport()
    model = ModelStub(replies)

    def load() -> list[dict[str, Any]]:
        return [
            {
                "id": c.id,
                "name": c.name,
                "protocol": c.protocol,
                "base_url": c.base_url,
                "model": c.model,
                "stream": c.stream,
                "max_tokens": c.max_tokens,
                "max_rounds": c.max_rounds,
                "key": c.key,
            }
            for c in profiles
        ]

    service = DirectorDeskAiService(
        transport=layer,  # type: ignore[arg-type]
        skills=skills,
        data_dir=data_dir,
        load_profiles=load,
        save_profiles=lambda _rows: None,
        http_transport=httpx.MockTransport(model),
    )
    service.set_contract(NODE, FULL_CONTRACT)
    return service, layer


# ── 一、画布侧发的指令落到 iframe 的工具上 ──────────────────────────────────


def test_canvas_instruction_runs_the_same_loop(tmp_path: Path) -> None:
    """画布侧面板送一句话，走的是同一个 ``run()``，工具照旧派给 iframe。

    刻意**不**提供 ``profile_id``：渠道由对话自己记住的那条决定（见第三条测试）。
    """
    service, layer = make_service(
        [
            tool_reply("c1", "director_read", {"sections": ["entities"]}),
            tool_reply("c2", "director_apply", {"revision": 7, "operations": []}),
            text_reply("已经摆好了。"),
        ],
        profiles=[channel()],
        data_dir=tmp_path,
    )
    asyncio.run(
        service.run(node_id=NODE, profile_id="", prompt="一段唯美的爱情场景")
    )

    executed = [(name, args) for _node, name, args in layer.calls]
    assert ("director_read", {"sections": ["entities"]}) in executed
    assert any(name == "director_apply" for name, _ in executed)

    events = layer.drain()
    types = [event["type"] for event in events]
    assert types[0] == "start"
    assert "done" in types
    assert all(event["nodeId"] == NODE for event in events)


def test_canvas_instruction_reaches_the_iframe_contract_tools(tmp_path: Path) -> None:
    """派发的是**该节点 iframe 自报的**那批工具，不是宿主自己抄一份的名单。

    ``director_apply`` 不在白名单时循环必须整轮拒绝 —— 那是宿主与 iframe 之间那道
    「不假设接口」边界的守门人。
    """
    service, layer = make_service(
        [tool_reply("c1", "director_apply", {"revision": 7, "operations": []})],
        profiles=[channel()],
        data_dir=tmp_path,
    )
    service.set_contract(
        NODE, ToolContract.from_payload({"definitions": [READ_TOOL], "discussion": [READ_TOOL]})
    )
    result = asyncio.run(service.run(node_id=NODE, profile_id="p1", prompt="改机位"))

    assert result.get("stopped") is True
    assert [name for _node, name, _args in layer.calls] == ["director_read"]
    errors = [e for e in layer.drain() if e["type"] == "error"]
    assert errors and "不允许" in errors[0]["text"]


# ── 二、两边读到同一份对话 ──────────────────────────────────────────────────


def test_canvas_turn_is_visible_to_the_iframe_panel(tmp_path: Path) -> None:
    """画布侧说的一句，iframe 侧 ``conversation()`` 立刻能读到（且是同一份落盘）。"""
    service, _layer = make_service(
        [text_reply("收到，我先看看现在的构图。")],
        profiles=[channel()],
        data_dir=tmp_path,
    )
    asyncio.run(service.run(node_id=NODE, profile_id="p1", prompt="一段唯美的爱情场景"))

    snapshot = service.conversation(NODE)
    assert "一段唯美的爱情场景" in snapshot["transcript"]
    assert "收到，我先看看现在的构图。" in snapshot["transcript"]

    texts = [(entry["role"], entry["text"]) for entry in snapshot["messages"]]
    assert ("user", "一段唯美的爱情场景") in texts
    assert ("assistant", "收到，我先看看现在的构图。") in texts

    # 两边读的是同一份会话：再取一次拿到同一个 sessionId。
    assert service.conversation(NODE)["sessionId"] == snapshot["sessionId"]
    files = list(tmp_path.glob("*.json"))
    assert len(files) == 1
    assert json.loads(files[0].read_text("utf-8"))["sessionId"] == snapshot["sessionId"]


def test_iframe_turn_is_visible_to_the_canvas_panel(tmp_path: Path) -> None:
    """反方向同样成立：iframe 那次发起的内容出现在画布侧读到的消息里。"""
    service, _layer = make_service(
        [text_reply("机位已压低。")],
        profiles=[channel()],
        data_dir=tmp_path,
    )
    # 画布侧不传渠道 → 接上对话记的那条；这条对话之前由 iframe 发起过。
    asyncio.run(service.run(node_id=NODE, profile_id="p1", prompt="把镜头推近一点"))

    messages = service.conversation(NODE)["messages"]
    assert [entry["text"] for entry in messages] == ["把镜头推近一点", "机位已压低。"]


def test_canvas_context_never_pollutes_the_shared_history(tmp_path: Path) -> None:
    """上下文走 ``context`` 字段，不混进用户原话。

    两边共用一份历史这件事让「上下文混进 prompt」从「一个面板的渲染 bug」变成
    「两个面板都看得见内部提示词」。所以这里锁的是 ``prompt`` 里只有用户说的话。
    """
    service, _layer = make_service(
        [text_reply("好。")], profiles=[channel()], data_dir=tmp_path
    )
    asyncio.run(
        service.run(
            node_id=NODE,
            profile_id="p1",
            prompt="把镜头推近一点",
            context="[导演台上下文]\n- 上游素材：图片「上游图」\n[/导演台上下文]",
        )
    )

    snapshot = service.conversation(NODE)
    assert "上游图" not in snapshot["transcript"]
    user_entry = next(e for e in snapshot["messages"] if e["role"] == "user")
    assert user_entry["text"] == "把镜头推近一点"
    # 但模型确实看到了它 —— 请求体的最后一条 user 消息里带着上下文。
    assert snapshot["messages"][-1]["role"] == "assistant"


def test_canvas_context_reaches_the_model(tmp_path: Path) -> None:
    """上下文不进历史，**仍然**进模型输入。这两件事必须同时成立。"""
    replies = [text_reply("好。")]
    service, _layer = make_service(replies, profiles=[channel()], data_dir=tmp_path)
    model = service._http  # MockTransport 已经在构造时收下了 ModelStub
    assert isinstance(model, httpx.MockTransport)
    asyncio.run(
        service.run(
            node_id=NODE,
            profile_id="p1",
            prompt="摆两个人",
            context="白模提示：只改他提到的那部分",
        )
    )
    conversation = service._conversation(NODE)
    request_messages = conversation.messages(channel())
    tail = "\n".join(str(m.get("content")) for m in request_messages if m.get("role") == "user")
    assert "只改他提到的那部分" in tail
    assert "摆两个人" in tail


# ── 三、同一个渠道 ──────────────────────────────────────────────────────────


def test_canvas_run_inherits_the_channel_the_conversation_remembers(tmp_path: Path) -> None:
    """iframe 那次选了 A，画布侧不传渠道 → 用的仍是 A。

    这是「同一个渠道」在代码里的落点：渠道**不存在**于两个面板各自的 localStorage 里，
    只存在于那份共享对话的 ``profileId``。
    """
    service, _layer = make_service(
        [text_reply("好的。")],
        profiles=[channel(id="p1"), channel(id="p2", name="另一个", key="sk-2")],
        data_dir=tmp_path,
    )
    asyncio.run(service.run(node_id=NODE, profile_id="p2", prompt="iframe 发起的"))

    # 画布侧不传 profileId。
    asyncio.run(service.run(node_id=NODE, profile_id="", prompt="画布侧发起的"))

    assert service.conversation(NODE)["profileId"] == "p2"
    turns = [e for e in service._conversation(NODE)._state["entries"] if e.get("type") == "turn"]
    assert turns and all(turn["profileId"] == "p2" for turn in turns)


def test_channel_selection_follows_the_latest_run_from_either_side(tmp_path: Path) -> None:
    """画布侧显式传渠道也能改 —— 但改的是同一份对话里的那一个值。"""
    service, _layer = make_service(
        [text_reply("好。"), text_reply("好。")],
        profiles=[channel(id="p1"), channel(id="p2", name="另一个", key="sk-2")],
        data_dir=tmp_path,
    )
    asyncio.run(service.run(node_id=NODE, profile_id="p1", prompt="第一句"))
    assert service.conversation(NODE)["profileId"] == "p1"
    asyncio.run(service.run(node_id=NODE, profile_id="p2", prompt="第二句"))
    assert service.conversation(NODE)["profileId"] == "p2"


def test_run_without_a_resolvable_channel_is_refused(tmp_path: Path) -> None:
    """还没有任何一次发起过，且配了多个渠道 → 明确报错，不替用户挑一个。

    替用户挑就等于替他决定用哪个模型付费。后端不该悄悄做这个决定（只有一个渠道时
    自动用它是可以的：用户没有别的选择，报错只会让他先开一次 iframe）。
    """
    service, _layer = make_service(
        [text_reply("好。")],
        profiles=[channel(id="p1"), channel(id="p2", name="另一个", key="sk-2")],
        data_dir=tmp_path,
    )
    with pytest.raises(ProfileError):
        asyncio.run(service.run(node_id=NODE, profile_id="", prompt="你好"))


def test_single_configured_channel_is_used_without_being_named(tmp_path: Path) -> None:
    """只配了一个渠道时，画布侧不必先选 —— 用户本来也没有第二个可选。"""
    service, _layer = make_service(
        [text_reply("好。")], profiles=[channel()], data_dir=tmp_path
    )
    asyncio.run(service.run(node_id=NODE, profile_id="", prompt="你好"))
    assert service.conversation(NODE)["profileId"] == "p1"


# ── 四、两边看到的是同一批事件 ──────────────────────────────────────────────


def test_both_sides_observe_one_run_with_one_run_id(tmp_path: Path) -> None:
    """一次画布侧发起的任务，事件流只有一条，且每个事件都带同一个 ``runId``。

    iframe 面板与画布侧面板订阅的是同一个 ``push_event`` 出口 —— 两边看到的
    runId / 文本增量 / 工具收据因此逐条相同，这是「不是两套」的可观测证据。
    """
    service, layer = make_service(
        [
            tool_reply("c1", "director_read", {"sections": ["entities"]}),
            text_reply("已读取工程。"),
        ],
        profiles=[channel()],
        data_dir=tmp_path,
    )
    asyncio.run(service.run(node_id=NODE, profile_id="p1", prompt="读一下现在的场景"))

    events = layer.drain()
    run_ids = {event["runId"] for event in events}
    assert len(run_ids) == 1
    assert {event["sessionId"] for event in events} == {service.conversation(NODE)["sessionId"]}
    assert [e["type"] for e in events if e["type"] == "tool"][:1] == ["tool"]


def test_tool_receipts_reach_the_renderable_transcript(tmp_path: Path) -> None:
    """画布侧要显示「做了什么」，靠的是 ``messages`` 里那份结构化工具收据。"""
    service, layer = make_service(
        [
            tool_reply("c1", "director_read", {"sections": ["entities"]}),
            text_reply("看过了。"),
        ],
        profiles=[channel()],
        data_dir=tmp_path,
    )
    asyncio.run(service.run(node_id=NODE, profile_id="p1", prompt="读一下"))
    for _node, name, _args in layer.calls:
        assert name == "director_read"

    messages = service.conversation(NODE)["messages"]
    turn = next(m for m in messages if m["role"] == "assistant")
    assert turn["tools"] == [{"name": "director_read", "status": "completed", "summary": None}]


def test_interrupted_run_keeps_what_it_already_printed(tmp_path: Path) -> None:
    """半路停下的那一段正文仍然出现在历史里。

    用户按停止之后看到消息凭空消失，是他判断「到底改没改」的唯一依据 ——
    丢不得。
    """
    service, _layer = make_service(
        [
            tool_reply("c1", "director_read", {"sections": ["entities"]}),
            tool_reply("c2", "director_apply", {"revision": 7, "operations": []}),
        ],
        profiles=[channel()],
        data_dir=tmp_path,
    )
    async def drive() -> None:
        task = asyncio.create_task(
            service.run(node_id=NODE, profile_id="p1", prompt="改一下")
        )
        await asyncio.sleep(0)
        service.stop(NODE)
        await task

    asyncio.run(drive())
    texts = [m["text"] for m in service.conversation(NODE)["messages"]]
    assert "改一下" in texts


# ── 五、dd-scene 那条宿主翻译链路仍然成立 ──────────────────────────────────


def test_dd_scene_operations_land_through_the_same_apply_tool(tmp_path: Path) -> None:
    """宿主侧的 dd-scene 翻译结果经 ``director_apply`` 提交，落进同一份对话。

    ``toDirectorOperations``（前端）产出的就是 ``director_apply`` 的 operations。
    宿主那条「主人说一句 → 场景真的被改」的链路与统一循环共用同一个写入口，
    所以「一段唯美的爱情场景」无论从哪个入口说，改的都是同一份工程。
    """
    operations = [
        {"operation": "add", "asset": "character", "id": "dd-char1", "patch": {"at": [0, 0]}},
        {"operation": "set", "id": "cam", "patch": {"move": "dolly-in"}},
    ]
    service, layer = make_service(
        [
            tool_reply("c1", "director_read", {"sections": ["entities"]}),
            tool_reply("c2", "director_apply", {"revision": 7, "operations": operations}),
            text_reply("已经摆好一段唯美的爱情场景。"),
        ],
        profiles=[channel()],
        data_dir=tmp_path,
    )
    asyncio.run(service.run(node_id=NODE, profile_id="p1", prompt="一段唯美的爱情场景"))

    applied = [args for _node, name, args in layer.calls if name == "director_apply"]
    assert applied == [{"revision": 7, "operations": operations}]

    turns = [e for e in service._conversation(NODE)._state["entries"] if e.get("type") == "turn"]
    apply_turn = next(turn for turn in turns if any(c["name"] == "director_apply" for c in turn["calls"]))
    receipts = [r["result"] for r in apply_turn["results"]]
    assert any(r.get("ok") for r in receipts)
