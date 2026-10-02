"""模型传输兼容层：非流式优先、失败切流式、记住可用方式。

这套东西解决的是「同一个模型在不同渠道上流式/非流式不一定都通」。实测同一提示词、
同一渠道：非流式 7 次全成，流式 4 次全空流。所以既不能写死非流式（会把必须流式
的渠道打死），也不能写死流式（会把现在这些打死），只能两种都试并记住结果。
"""

from __future__ import annotations

import pytest

from novelvideo import model_transport_compat as compat


class _UnexpectedModelBehavior(Exception):
    """与 pydantic_ai 抛的同名异常：兼容层按类名判定，测试里用替身。"""


class _NotATransportFailure(Exception):
    pass


@pytest.fixture(autouse=True)
def _clean_preferences():
    compat.reset_transport_preferences()
    yield
    compat.reset_transport_preferences()


def _transport_error() -> Exception:
    # 类名必须与 pydantic_ai 的 UnexpectedModelBehavior 一致：兼容层按名字判定
    # 「响应没送达」，避免把别的异常也拖去重试。
    cls = type("UnexpectedModelBehavior", (_UnexpectedModelBehavior,), {})
    return cls("Invalid response from openai chat completions endpoint, expected JSON data")


async def test_prefers_non_streaming_on_first_call() -> None:
    """没有偏好时先试非流式：本地网关上它明显更稳。"""
    seen: list[bool] = []

    async def call(mode: bool) -> str:
        seen.append(mode)
        return "ok"

    result = await compat.run_with_transport_compat(
        capability="vision", model_name="m", call=call
    )
    assert result == "ok"
    assert seen == [False], "第一次必须是非流式"


async def test_switches_to_streaming_on_transport_failure() -> None:
    """非流式返回空响应时，用流式重试一次。"""
    seen: list[bool] = []

    async def call(mode: bool) -> str:
        seen.append(mode)
        if not mode:
            raise _transport_error()
        return "from-stream"

    result = await compat.run_with_transport_compat(
        capability="vision", model_name="m", call=call
    )
    assert result == "from-stream"
    assert seen == [False, True]


async def test_remembers_the_working_transport() -> None:
    """第二次直接走学到的那条路，不再试错。"""
    seen: list[bool] = []

    async def call(mode: bool) -> str:
        seen.append(mode)
        if not mode:
            raise _transport_error()
        return "ok"

    await compat.run_with_transport_compat(
        capability="vision", model_name="m", call=call
    )
    assert seen == [False, True]
    assert compat.known_transport_preferences() == {("vision", "m"): True}

    seen.clear()
    await compat.run_with_transport_compat(
        capability="vision", model_name="m", call=call
    )
    assert seen == [True], "第二次应当直接走流式"


async def test_preference_is_scoped_per_capability_and_model() -> None:
    """同一画布上多个 Agent 共用模型名时不能串味。"""

    async def failing_non_stream(mode: bool) -> str:
        if not mode:
            raise _transport_error()
        return "ok"

    await compat.run_with_transport_compat(
        capability="vision", model_name="shared", call=failing_non_stream
    )
    assert compat.known_transport_preferences() == {("vision", "shared"): True}

    # 另一个能力用同一个模型名，缓存不该命中流式偏好。
    seen: list[bool] = []

    async def call(mode: bool) -> str:
        seen.append(mode)
        return "ok"

    await compat.run_with_transport_compat(
        capability="text-enhance", model_name="shared", call=call
    )
    assert seen == [False], "能力不同的调用不该复用另一条路的偏好"


async def test_does_not_retry_non_transport_errors() -> None:
    """请求本身有问题（4xx、字段校验失败）不重试：换传输方式也救不了，
    重试只会把一个错误变成两个错误、让上层看到错的那个。"""
    seen: list[bool] = []

    async def call(mode: bool) -> str:
        seen.append(mode)
        raise _NotATransportFailure("HTTP 400 bad request")

    with pytest.raises(_NotATransportFailure):
        await compat.run_with_transport_compat(
            capability="vision", model_name="m", call=call
        )
    assert seen == [False], "非传输层错误只能试一次"


async def test_raises_first_error_when_both_transports_fail() -> None:
    """两种方式都挂时抛第一次那个：它才是调用方要看的根因。"""

    async def call(mode: bool) -> str:
        raise _transport_error()

    with pytest.raises(_UnexpectedModelBehavior) as excinfo:
        await compat.run_with_transport_compat(
            capability="vision", model_name="m", call=call
        )
    assert "expected JSON data" in str(excinfo.value)


async def test_stale_preference_is_replaced_when_it_stops_working() -> None:
    """缓存说流式能用、但渠道恢复成只走非流式时，要更新缓存而不是永远撞墙。"""
    seen: list[bool] = []

    async def learn_stream(mode: bool) -> str:
        if not mode:
            raise _transport_error()
        return "ok"

    await compat.run_with_transport_compat(
        capability="vision", model_name="m", call=learn_stream
    )
    assert compat.known_transport_preferences() == {("vision", "m"): True}

    seen.clear()

    async def now_non_stream_fails(mode: bool) -> str:
        seen.append(mode)
        if mode:
            raise _transport_error()
        return "ok"

    result = await compat.run_with_transport_compat(
        capability="vision", model_name="m", call=now_non_stream_fails
    )
    assert result == "ok"
    assert seen == [True, False]
    assert compat.known_transport_preferences() == {("vision", "m"): False}


async def test_streaming_fallback_really_runs_the_stream_path() -> None:
    """切换到流式时必须真的跑通流式，不能只是把异常换个地方抛。

    这里用真实的 pydantic_ai 流式接口走一遍：之前一版把 `async for chunk in
    agent.run_stream(...)` 写成了直接迭代 `run_stream()` 的返回值，于是切换发生时
    抛 `'async for' requires an object with __aiter__ method`——非流式能过、
    一切换就炸，比不回退还糟。
    """
    from novelvideo.freezone.text_node import run_agent_with_transport_compat

    class _FakeStream:
        def __init__(self, text: str) -> None:
            self._text = text

        async def get_output(self) -> str:
            return self._text

    class _FakeStreamCtx:
        def __init__(self, text: str) -> None:
            self._text = text

        async def __aenter__(self) -> _FakeStream:
            return _FakeStream(self._text)

        async def __aexit__(self, *_exc: object) -> bool:
            return False

    class _FakeAgent:
        output_type = str

        def __init__(self, *, non_stream_fails: bool) -> None:
            self._non_stream_fails = non_stream_fails

        async def run(self, _payload: object) -> object:
            if self._non_stream_fails:
                raise _transport_error()
            return type("R", (), {"output": "non-stream-text"})()

        def run_stream(self, _payload: object) -> _FakeStreamCtx:
            return _FakeStreamCtx("stream-text")

    agent = _FakeAgent(non_stream_fails=True)
    result = await run_agent_with_transport_compat(
        agent,  # type: ignore[arg-type]
        "payload",
        capability="text-writer",
        model_name="m",
    )
    assert result.output == "stream-text", "流式分支必须真的取到输出"
    assert compat.known_transport_preferences() == {("text-writer", "m"): True}


def test_only_unexpected_model_behavior_counts_as_transport_failure() -> None:
    """类型判定不能只看文案——别的异常类里出现同样字样也不该被拖去重试。"""

    class UnexpectedModelBehavior(Exception):
        pass

    ok = UnexpectedModelBehavior("Invalid response, expected JSON data")
    assert compat._is_transport_failure(ok) is True

    other = Exception("Invalid response, expected JSON data")
    assert compat._is_transport_failure(other) is False

    wrong_reason = type("UnexpectedModelBehavior", (Exception,), {})(
        "response contained 3 validation errors"
    )
    assert compat._is_transport_failure(wrong_reason) is False
