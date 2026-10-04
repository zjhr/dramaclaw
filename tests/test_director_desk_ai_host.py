"""agent 循环：讨论模式二次校验、断轮、重试上限、轮数上限、密钥不出后端。

这些测试全部走**真循环**（`DirectorDeskAiService.run`），只把 HTTP 层换成
``httpx.MockTransport``、工具层换成传输层的真实配对。理由：REVISION_CONFLICT 断轮和
非法 JSON 重试这类语义，一旦在测试里自己重新实现一遍，测的就不是生产代码了。
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
    INVALID_ARGUMENT_RETRIES,
    Channel,
    DirectorDeskAiService,
    ProfileError,
    ToolContract,
    append_result,
    complete,
    endpoint,
    is_discussion_tool_call,
    missing_result,
    request_body,
    validate_profile,
)
from novelvideo.director_desk.tool_transport import DirectorDeskToolTransport

NODE = "node-ai"
BASE_URL = "https://api.example.com/v1"


def channel(**overrides: Any) -> Channel:
    """测试渠道。

    ``max_tokens`` 默认给一个确定值：0 会触发「自动探测输出上限」，那一步会真的发
    ``/models`` 请求，测试里既慢又不确定。
    """
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
MEDIA_TOOL = {"name": "director_media", "description": "media", "inputSchema": {"type": "object"}}
SCENE_TOOL = {"name": "director_scene", "description": "scene", "inputSchema": {"type": "object"}}

FULL_CONTRACT = ToolContract.from_payload(
    {"definitions": [READ_TOOL, APPLY_TOOL, MEDIA_TOOL, SCENE_TOOL], "discussion": [READ_TOOL]}
)


# ── 模型替身 ────────────────────────────────────────────────────────────────


class ModelStub:
    """按顺序回放预写的模型回包，并记录每次收到的请求体。

    渠道默认 ``stream: true``（面板上的默认值，也是真实上游行为），所以请求体里
    ``stream`` 为真时把整包 completion 摊成 SSE delta 帧返回 —— 这样 agent 循环的
    常用路径走的就是真正的流式解析，而不是被测试偷换成一次性 JSON。
    """

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
        frames = "".join(f"data: {json.dumps(frame)}\n\n" for frame in _as_sse_frames(payload))
        return httpx.Response(
            200,
            content=(frames + "data: [DONE]\n\n").encode("utf-8"),
            headers={"content-type": "text/event-stream"},
        )


def _as_sse_frames(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """把一次非流式 completion 摊成 chat 协议的 delta 帧。"""
    if "choices" not in payload:
        return [payload]  # responses / anthropic 形态的用例各自单独覆盖
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
    if payload.get("usage"):
        frames[-1]["usage"] = payload["usage"]
    return frames


def tool_turn(call_id: str, name: str, args: dict[str, Any]) -> dict[str, Any]:
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": None,
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


def multi_tool_turn(calls: list[tuple[str, str, dict[str, Any]]]) -> dict[str, Any]:
    """一轮里同时点多个工具 —— 断轮语义只有在这种形态下才观察得到。"""
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(args)},
                        }
                        for call_id, name, args in calls
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ]
    }


def text_turn(text: str) -> dict[str, Any]:
    return {"choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": "stop"}]}


def invalid_arguments_turn() -> dict[str, Any]:
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "c1",
                            "type": "function",
                            "function": {"name": "director_apply", "arguments": "{not json"},
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ]
    }


class Harness:
    """跑循环的最小环境：真服务 + 真传输层 + 可脚本的模型 + 一个自动应答泵。

    循环一上来就会自动读一次工程快照，所以工具面必须**并发**地应答，否则第一
    次 ``director_read`` 会一路等到 60 秒超时。泵就是画布 iframe 的替身。
    """

    def __init__(
        self,
        tmp_path: Path,
        replies: list[Any],
        *,
        channel_profile: Channel | None = None,
        result_for: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
        contract: ToolContract = FULL_CONTRACT,
        with_session: bool = True,
    ) -> None:
        self.stub = ModelStub(replies)
        self.transport = DirectorDeskToolTransport()
        self.service = DirectorDeskAiService(
            transport=self.transport,
            data_dir=tmp_path,
            load_profiles=lambda: [asdict(channel_profile)] if channel_profile else [],
            save_profiles=lambda _profiles: None,
            http_transport=httpx.MockTransport(self.stub),
        )
        self.result_for = result_for or (lambda _call: {"ok": True, "data": {}})
        self.dispatched: list[dict[str, Any]] = []
        self.events_seen: list[dict[str, Any]] = []
        # 工具清单与有没有会话是两件事：契约握手过但窗口已关，是完全可能的中间态。
        self.service.set_contract(NODE, contract)
        self.session = self.transport.open_session(NODE) if with_session else None

    async def _pump(self, run_task: asyncio.Task[Any]) -> None:
        while not run_task.done():
            polled = await self.transport.poll(NODE, self.session.session_id, wait=0.2)
            self.events_seen.extend(polled["events"])
            for call in polled["calls"]:
                self.dispatched.append(call)
                self.transport.submit_result(NODE, call["request_id"], self.result_for(call))
        self.events_seen.extend(
            (await self.transport.poll(NODE, self.session.session_id, wait=0.0))["events"]
        )

    async def run(self, **kwargs: Any) -> dict[str, Any]:
        """启动循环并把工具应答泵跑起来，返回循环结果。"""
        task = asyncio.create_task(self.service.run(node_id=NODE, **kwargs))
        pump = asyncio.create_task(self._pump(task))
        result = await task
        await pump
        return result

    async def drain(self) -> list[dict[str, Any]]:
        """排空积压事件。事件和工具调用走同一条 poll，断言必须连 poll 一起消费。"""
        if self.session is not None:
            self.events_seen.extend(
                (await self.transport.poll(NODE, self.session.session_id, wait=0.0))["events"]
            )
        return list(self.events_seen)

    def errors(self) -> list[str]:
        return [e["text"] for e in self.events_seen if e["type"] == "error"]

    def dispatched_names(self) -> list[str]:
        return [c["name"] for c in self.dispatched]


def build(tmp_path: Path, replies: list[Any], **kwargs: Any) -> Harness:
    return Harness(tmp_path, replies, channel_profile=channel(), **kwargs)


# ── 讨论模式的执行层二次校验 ────────────────────────────────────────────────


async def test_discuss_mode_blocks_a_write_tool_before_dispatch(tmp_path: Path) -> None:
    harness = build(tmp_path, [tool_turn("c1", "director_apply", {"operations": []})])

    result = await harness.run(profile_id="p1", prompt="改一下", mode="discuss")

    assert result["stopped"] is True
    assert "当前模式不允许的工具操作" in harness.errors()[0]
    # 关键断言：模型点的那个写工具**一次都没被派发**到画布。
    assert "director_apply" not in harness.dispatched_names()


async def test_discuss_mode_blocks_a_write_action_on_a_mixed_tool(tmp_path: Path) -> None:
    harness = build(tmp_path, [tool_turn("c1", "director_media", {"action": "import", "data": "data:..."})])

    await harness.run(profile_id="p1", prompt="导入", mode="discuss")

    assert "当前模式不允许的工具操作" in harness.errors()[0]
    assert "director_media" not in harness.dispatched_names()


async def test_discuss_mode_still_allows_reads(tmp_path: Path) -> None:
    harness = build(
        tmp_path, [tool_turn("c1", "director_read", {"sections": ["entities"]}), text_turn("看过了")]
    )

    result = await harness.run(profile_id="p1", prompt="看看", mode="discuss")

    assert "stopped" not in result
    assert harness.dispatched_names().count("director_read") == 2  # 快照 + 模型那一轮


def test_is_discussion_tool_call_matches_the_upstream_policy() -> None:
    assert is_discussion_tool_call("director_read", {"sections": ["entities"]}) is True
    assert is_discussion_tool_call("director_apply", {}) is False
    assert is_discussion_tool_call("director_media", {"action": "list"}) is True
    # 参数级白名单：读动作 + 多带一个 revision 就不放行了。
    assert is_discussion_tool_call("director_media", {"action": "list", "revision": 1}) is False
    assert is_discussion_tool_call("director_media", {"action": "import"}) is False
    assert is_discussion_tool_call("director_scene", {"action": "read"}) is True
    assert is_discussion_tool_call("director_scene", {"action": "create"}) is False
    assert is_discussion_tool_call("director_scene", "not-an-object") is False


# ── REVISION_CONFLICT 断轮 ──────────────────────────────────────────────────


async def test_revision_conflict_breaks_the_tool_loop_but_keeps_the_task(tmp_path: Path) -> None:
    harness = build(
        tmp_path,
        [tool_turn("c1", "director_apply", {"operations": []}), text_turn("重读之后改好了")],
        result_for=lambda call: (
            {"ok": False, "error": "REVISION_CONFLICT: stale"} if call["name"] == "director_apply" else {"ok": True, "data": {}}
        ),
    )

    result = await harness.run(profile_id="p1", prompt="加个角色")

    # 冲突之后**没有**被判死：模型下一轮重读状态并自己修好了。
    assert "stopped" not in result
    assert [e["type"] for e in harness.events_seen].count("done") == 1


async def test_revision_conflict_leaves_the_rest_of_the_turn_unstarted(tmp_path: Path) -> None:
    harness = build(
        tmp_path,
        [
            multi_tool_turn(
                [
                    ("c1", "director_apply", {"operations": []}),
                    ("c2", "director_apply", {"operations": []}),
                ]
            ),
            text_turn("重新读过了"),
        ],
        result_for=lambda call: (
            {"ok": False, "error": "REVISION_CONFLICT: stale"}
            if call["name"] == "director_apply"
            else {"ok": True, "data": {}}
        ),
    )

    await harness.run(profile_id="p1", prompt="改两处")

    # 一个 REVISION_CONFLICT 就断轮：同一轮里的第二个 apply 根本没派发出去。
    assert harness.dispatched_names() == ["director_read", "director_apply"]

    # 下一轮模型看到的是 not-started，而不是一个假的成功。
    second_request = harness.stub.requests[1]
    tool_messages = [m for m in second_request["messages"] if m.get("role") == "tool"]
    assert any("not-started" in m["content"] for m in tool_messages)


def test_missing_result_classifies_started_and_unstarted_calls() -> None:
    turn = {"calls": [{"id": "a"}, {"id": "b"}], "started": ["a"]}

    assert missing_result(turn, {"id": "a"})["result"]["execution"] == "unknown"
    assert missing_result(turn, {"id": "b"})["result"]["execution"] == "not-started"
    assert "不要直接重放写入" in missing_result(turn, {"id": "a"})["result"]["error"]


# ── 非法工具参数 ────────────────────────────────────────────────────────────


async def test_invalid_tool_arguments_retry_caps_at_two_then_stops(tmp_path: Path) -> None:
    harness = build(
        tmp_path, [invalid_arguments_turn(), invalid_arguments_turn(), invalid_arguments_turn(), text_turn("放弃")]
    )

    result = await harness.run(profile_id="p1", prompt="改")

    statuses = [e.get("text") for e in harness.events_seen if e["type"] == "status"]
    retries = [s for s in statuses if s and "正在重新生成" in s]
    # 2 次重试，第 3 次直接停 —— 不无限烧 token。
    assert len(retries) == INVALID_ARGUMENT_RETRIES
    assert f"（1/{INVALID_ARGUMENT_RETRIES}）" in retries[0]
    assert "连续返回无效工具参数" in harness.errors()[0]
    assert result["stopped"] is True
    assert harness.dispatched_names() == ["director_read"]  # 只有任务开始时的快照


async def test_invalid_tool_arguments_retry_succeeds_on_the_second_try(tmp_path: Path) -> None:
    harness = build(
        tmp_path,
        [invalid_arguments_turn(), invalid_arguments_turn(), tool_turn("c1", "director_read", {}), text_turn("好了")],
    )

    result = await harness.run(profile_id="p1", prompt="读一下")

    assert "stopped" not in result
    # 纠正消息必须真的进了下一轮的上下文，否则重试只是白跑一次。
    retry_request = harness.stub.requests[2]
    assert any("不是合法 JSON 对象" in m.get("content", "") for m in retry_request["messages"])


# ── 轮数 ────────────────────────────────────────────────────────────────────


async def test_max_rounds_stops_the_task_after_the_limit(tmp_path: Path) -> None:
    harness = Harness(
        tmp_path,
        [tool_turn(f"c{i}", "director_read", {}) for i in range(4)],
        channel_profile=channel(max_rounds=2),
    )

    result = await harness.run(profile_id="p1", prompt="一直读")

    assert result["stopped"] is True
    assert "轮限制" in harness.errors()[0]


async def test_max_rounds_zero_means_unlimited(tmp_path: Path) -> None:
    replies = [tool_turn(f"c{i}", "director_read", {}) for i in range(12)] + [text_turn("终于停了")]
    harness = Harness(tmp_path, replies, channel_profile=channel(max_rounds=0))

    result = await harness.run(profile_id="p1", prompt="一直读")

    assert "stopped" not in result
    assert [e["type"] for e in harness.events_seen].count("done") == 1


# ── 密钥不出后端 ────────────────────────────────────────────────────────────


def test_public_channel_shape_never_carries_the_key() -> None:
    public = channel(key="sk-super-secret-value").public()

    assert public["hasKey"] is True
    assert "key" not in public
    assert "sk-super-secret-value" not in json.dumps(public, ensure_ascii=False)


def test_configure_returns_only_masked_channels(tmp_path: Path) -> None:
    saved: list[dict[str, Any]] = []
    service = DirectorDeskAiService(
        data_dir=tmp_path, load_profiles=lambda: [], save_profiles=lambda profiles: saved.extend(profiles)
    )

    channels = service.configure(
        {
            "name": "我的渠道",
            "protocol": "chat",
            "baseUrl": BASE_URL,
            "model": "model-x",
            "key": "sk-super-secret-value",
        }
    )

    assert len(channels) == 1
    assert channels[0]["hasKey"] is True
    assert "sk-super-secret-value" not in json.dumps(channels, ensure_ascii=False)
    # 明文只落在保存出去的那一份里（全局 settings 库），不进对外形状。
    assert saved[0]["key"] == "sk-super-secret-value"
    assert "sk-super-secret-value" not in json.dumps(service.profiles(), ensure_ascii=False)


def test_configure_keeps_the_previous_key_for_the_same_destination(tmp_path: Path) -> None:
    service = DirectorDeskAiService(
        data_dir=tmp_path, load_profiles=lambda: [], save_profiles=lambda _p: None
    )
    created = service.configure(
        {"id": "fixed", "name": "n", "protocol": "chat", "baseUrl": BASE_URL, "model": "m", "key": "sk-1"}
    )

    updated = service.configure(
        {"id": "fixed", "name": "n2", "protocol": "chat", "baseUrl": BASE_URL, "model": "m2", "key": ""}
    )

    assert created[0]["id"] == updated[0]["id"] == "fixed"
    assert updated[0]["model"] == "m2"
    assert updated[0]["hasKey"] is True


def test_configure_requires_a_key_for_a_new_destination(tmp_path: Path) -> None:
    service = DirectorDeskAiService(
        data_dir=tmp_path, load_profiles=lambda: [], save_profiles=lambda _p: None
    )

    with pytest.raises(ProfileError, match="API 密钥"):
        service.configure({"protocol": "chat", "baseUrl": BASE_URL, "model": "m", "key": ""})


def test_configure_removes_a_channel_without_its_key(tmp_path: Path) -> None:
    service = DirectorDeskAiService(
        data_dir=tmp_path, load_profiles=lambda: [], save_profiles=lambda _p: None
    )
    service.configure({"id": "fixed", "protocol": "chat", "baseUrl": BASE_URL, "model": "m", "key": "sk-1"})

    remaining = service.configure({"removeId": "fixed"})

    assert remaining == []
    assert service.profiles() == []


def test_profiles_never_expose_a_key_after_a_reload(tmp_path: Path) -> None:
    stored = [asdict(channel(key="sk-stored-secret"))]
    service = DirectorDeskAiService(
        data_dir=tmp_path, load_profiles=lambda: stored, save_profiles=lambda _p: None
    )

    channels = service.profiles()

    assert channels[0]["hasKey"] is True
    assert "sk-stored-secret" not in json.dumps(channels, ensure_ascii=False)


# ── 渠道校验 ────────────────────────────────────────────────────────────────


def test_validate_profile_enforces_the_protocol_allowlist() -> None:
    with pytest.raises(ProfileError, match="有效接口协议"):
        validate_profile({"protocol": "grpc", "baseUrl": BASE_URL, "model": "m"})


def test_validate_profile_requires_https_for_remote_hosts() -> None:
    with pytest.raises(ProfileError, match="HTTPS"):
        validate_profile({"protocol": "chat", "baseUrl": "http://api.example.com/v1", "model": "m"})
    # 本地回环允许明文。
    assert validate_profile({"protocol": "chat", "baseUrl": "http://127.0.0.1:11434/v1", "model": "m"})


def test_validate_profile_rejects_credentials_and_query_in_the_url() -> None:
    with pytest.raises(ProfileError, match="账号、查询参数或片段"):
        validate_profile({"protocol": "chat", "baseUrl": "https://u:p@api.example.com/v1", "model": "m"})
    with pytest.raises(ProfileError, match="账号、查询参数或片段"):
        validate_profile({"protocol": "chat", "baseUrl": "https://api.example.com/v1?k=1", "model": "m"})


def test_endpoint_appends_the_protocol_suffix_once() -> None:
    chat = validate_profile({"protocol": "chat", "baseUrl": BASE_URL, "model": "m"})
    full = validate_profile({"protocol": "chat", "baseUrl": BASE_URL + "/chat/completions", "model": "m"})

    assert endpoint(chat) == BASE_URL + "/chat/completions"
    assert endpoint(full) == BASE_URL + "/chat/completions"


def test_anthropic_requires_an_explicit_output_limit() -> None:
    profile = validate_profile({"protocol": "anthropic", "baseUrl": "https://api.example.com", "model": "m"})

    with pytest.raises(ProfileError, match="最大输出额度"):
        request_body(profile, "sys", [], [], 0, True)


# ── 协议形状 ────────────────────────────────────────────────────────────────


async def test_anthropic_uses_x_api_key_and_message_tool_results() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["headers"] = dict(request.headers)
        seen["body"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(
            200,
            json={
                "content": [{"type": "text", "text": "ok"}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 3, "output_tokens": 1},
            },
        )

    anthropic = validate_profile({"protocol": "anthropic", "baseUrl": "https://api.example.com", "model": "claude-x"})
    result = await complete(
        anthropic,
        "sk-anthropic",
        "sys",
        [{"role": "user", "content": "hi"}],
        [],
        max_tokens=128,
        stream=False,
        transport=httpx.MockTransport(handler),
    )

    assert seen["url"] == "https://api.example.com/messages"
    assert seen["headers"]["x-api-key"] == "sk-anthropic"
    assert seen["headers"]["anthropic-version"] == "2023-06-01"
    assert seen["body"]["max_tokens"] == 128
    assert result["text"] == "ok"

    messages: list[Any] = []
    append_result("anthropic", messages, {"role": "assistant", "content": []}, [{"id": "t1", "result": {"ok": True}}])
    assert messages[-1]["content"][0]["type"] == "tool_result"


async def test_responses_protocol_uses_instructions_and_function_call_output() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "done"}],
                    }
                ],
                "usage": {"input_tokens": 1},
            },
        )

    responses = validate_profile({"protocol": "responses", "baseUrl": BASE_URL, "model": "gpt-x"})
    result = await complete(
        responses,
        "sk-r",
        "sys",
        [{"role": "user", "content": "hi"}],
        [],
        max_tokens=256,
        stream=False,
        transport=httpx.MockTransport(handler),
    )

    assert seen["url"] == BASE_URL + "/responses"
    assert seen["body"]["instructions"] == "sys"
    assert seen["body"]["store"] is False
    assert result["text"] == "done"

    messages: list[Any] = []
    append_result("responses", messages, [{"role": "assistant", "content": []}], [{"id": "t1", "result": {"ok": True}}])
    assert messages[-1]["type"] == "function_call_output"


async def test_streaming_chat_reassembles_split_tool_arguments() -> None:
    frames = [
        {"choices": [{"delta": {"content": "我"}}]},
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {"index": 0, "id": "c1", "function": {"name": "director_read", "arguments": '{"sec'}}
                        ]
                    }
                }
            ]
        },
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {"index": 0, "function": {"arguments": 'tions":' '["entities"]}'}}
                        ]
                    }
                }
            ]
        },
        {"choices": [{"delta": {}, "finish_reason": "tool_calls"}], "usage": {"total_tokens": 9}},
    ]
    body = "".join(f"data: {json.dumps(frame)}\n\n" for frame in frames) + "data: [DONE]\n\n"

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body.encode("utf-8"), headers={"content-type": "text/event-stream"})

    texts: list[str] = []
    chat = validate_profile({"protocol": "chat", "baseUrl": BASE_URL, "model": "m"})
    result = await complete(
        chat,
        "sk",
        "sys",
        [{"role": "user", "content": "hi"}],
        [READ_TOOL],
        max_tokens=64,
        stream=True,
        on_text=texts.append,
        transport=httpx.MockTransport(handler),
    )

    assert texts == ["我"]
    assert result["calls"] == [{"id": "c1", "name": "director_read", "args": {"sections": ["entities"]}}]
    assert result["usage"] == {"total_tokens": 9}


async def test_a_truncated_model_reply_never_executes_tools(tmp_path: Path) -> None:
    harness = build(
        tmp_path,
        [
            {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "c1",
                                    "type": "function",
                                    "function": {"name": "director_apply", "arguments": "{}"},
                                }
                            ],
                        },
                        "finish_reason": "length",
                    }
                ]
            },
            text_turn("重来"),
        ],
    )

    result = await harness.run(profile_id="p1", prompt="改")

    assert "达到输出额度而截断" in harness.errors()[0]
    assert "director_apply" not in harness.dispatched_names()
    assert result["stopped"] is True


# ── 无会话 ──────────────────────────────────────────────────────────────────


async def test_run_without_a_session_reports_not_started(tmp_path: Path) -> None:
    harness = Harness(
        tmp_path,
        [text_turn("工程是空的")],
        channel_profile=channel(),
        with_session=False,
    )

    result = await asyncio.wait_for(harness.service.run(node_id=NODE, profile_id="p1", prompt="读一下"), timeout=5)

    assert "stopped" not in result
    # 快照那一次 director_read 立刻拿到 not-started，而不是干等 60 秒。
    # 它不进 tool 消息 —— 和上游一样，任务开始时读的快照是拼进用户条目里的。
    assert harness.dispatched_names() == []
    user_message = next(m for m in harness.stub.requests[0]["messages"] if m["role"] == "user")
    assert "not-started" in user_message["content"]


async def test_run_without_a_tool_contract_refuses_before_touching_the_model(tmp_path: Path) -> None:
    stub = ModelStub([text_turn("x")])
    transport = DirectorDeskToolTransport()
    service = DirectorDeskAiService(
        transport=transport,
        data_dir=tmp_path,
        load_profiles=lambda: [asdict(channel())],
        save_profiles=lambda _p: None,
        http_transport=httpx.MockTransport(stub),
    )
    transport.open_session(NODE)

    with pytest.raises(Exception, match="工具清单"):
        await service.run(node_id=NODE, profile_id="p1", prompt="改一下")

    assert stub.requests == []


# ── 停止与并发 ──────────────────────────────────────────────────────────────


async def test_stop_aborts_a_task_waiting_on_a_tool(tmp_path: Path) -> None:
    harness = build(tmp_path, [tool_turn("c1", "director_read", {})])
    task = asyncio.create_task(harness.service.run(node_id=NODE, profile_id="p1", prompt="读"))
    # 取走快照调用但**不回填**：任务正卡在等画布，这时点停止才是真实场景。
    await harness.transport.poll(NODE, harness.session.session_id, wait=1.0)

    assert harness.service.stop(NODE) is True
    result = await asyncio.wait_for(task, timeout=5)

    assert result["stopped"] is True
    assert any("已停止" in e["text"] for e in await harness.drain() if e["type"] == "error")


async def test_second_concurrent_run_is_refused(tmp_path: Path) -> None:
    harness = build(tmp_path, [tool_turn("c1", "director_read", {})])
    task = asyncio.create_task(harness.service.run(node_id=NODE, profile_id="p1", prompt="读"))
    await harness.transport.poll(NODE, harness.session.session_id, wait=1.0)

    with pytest.raises(Exception, match="已有 AI 任务"):
        await harness.service.run(node_id=NODE, profile_id="p1", prompt="再来一次")

    harness.service.stop(NODE)
    await asyncio.wait_for(task, timeout=5)


async def test_an_oversized_prompt_is_refused_before_any_request(tmp_path: Path) -> None:
    harness = build(tmp_path, [])

    with pytest.raises(Exception, match="20000"):
        await harness.service.run(node_id=NODE, profile_id="p1", prompt="x" * 20_001)

    assert harness.stub.requests == []


async def test_a_stale_session_id_is_refused(tmp_path: Path) -> None:
    harness = build(tmp_path, [])

    with pytest.raises(Exception, match="对话已切换"):
        await harness.service.run(node_id=NODE, profile_id="p1", prompt="改", session_id="someone-elses-session")


# ── 快照与选区 ──────────────────────────────────────────────────────────────


async def test_selection_scope_injects_the_snapshot_and_the_boundary_note(tmp_path: Path) -> None:
    harness = build(tmp_path, [text_turn("ok")])

    await harness.run(profile_id="p1", prompt="只改这个", use_selection=True)

    first_request = harness.stub.requests[0]
    user_message = next(m for m in first_request["messages"] if m["role"] == "user")
    assert "selection" in user_message["content"]
    assert "片段之外保留原安排" in user_message["content"]
    assert harness.dispatched_names() == ["director_read"]


async def test_a_task_always_opens_with_an_engine_snapshot(tmp_path: Path) -> None:
    harness = build(tmp_path, [text_turn("ok")])

    await harness.run(profile_id="p1", prompt="加个角色")

    assert harness.dispatched_names() == ["director_read"]
    user_message = next(m for m in harness.stub.requests[0]["messages"] if m["role"] == "user")
    assert "工程快照" in user_message["content"]