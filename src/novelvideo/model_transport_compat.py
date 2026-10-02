"""模型传输兼容层：同一个模型在不同渠道上，流式与非流式不一定都通。

## 为什么要这层

组织身份下 `create_request_scoped_gateway_model` 会走 `request_stream`，于是
pydantic-ai 把请求发成流式。本地 NewAPI 网关有渠道的流式响应会提前 EOF，网关
记下 `stream ended: reason=eof` 并回一个空体，客户端在
`OpenAIChatModel._process_response` 因为拿到的不是 `chat.ChatCompletion` 而抛
`UnexpectedModelBehavior('… expected JSON data')`。实测同一套提示词、同一渠道：

|传输方式 | 次数 | 结果 |
| --- | --- | --- |
| 非流式 | 7 | 全成功（143-257 tokens） |
| 流式 | 4 | 全失败（0 tokens） |

但反过来也有必须流式才能用的渠道。所以**不能写死任何一种**——写死非流式会把那些
渠道打死，写死流式会把现在这些打死。

## 做法

先按缓存偏好发；没有偏好时先试非流式。命中
`expected JSON data` / 空响应这类**传输层**失败（非提示词问题），立刻用另一种
方式重试一次，成功就把偏好记进内存缓存，后续同一组合直接走对的那条路。

缓存是进程内的：重启后重新试一次即可，换渠道会自动重新学。刻意不落库——写进
项目设置会让一次网络抖动把「这个渠道必须流式」固化下来，渠道恢复后反而继续踩坑。

## 为什么可以拿这个错误当切换信号

`expected JSON data` 抛在 `_process_response` 的类型判定上：上游回了空体或非
JSON。这是响应根本没送达，与提示词内容无关，重试是安全的。反过来，HTTP 4xx/5xx
或 `_validate_completion` 的字段校验失败都属于「请求本身有问题」，不在这里重试，
让上层按原样报错。
"""

from __future__ import annotations

import threading
from typing import Any, Awaitable, Callable

# 传输方式：False=非流式，True=流式。
TransportMode = bool

# 命中这些文案才认为「传输层失败、换一种方式值得再试」。**必须全小写**：
# 判定时会把异常消息也转成小写，标记里留着大写就永远匹配不上。
_TRANSPORT_FAILURE_MARKERS = (
    "expected json data",
    "unexpected end of json input",
    "empty response",
    "no choices",
)

# (能力标签, 模型名) -> 传输偏好。用能力标签而不是节点 id：同一模型在画布上可能
# 被多个节点调用，按 id 记会学到一堆互不相干的偏好。
_MODE_PREFERENCES: dict[tuple[str, str], TransportMode] = {}
_PREFERENCE_LOCK = threading.Lock()


def _is_transport_failure(error: BaseException) -> bool:
    """判断异常是不是「响应没送达」而非「请求有问题」。

    按类型名而不是 `isinstance`：pydantic-ai 的 `UnexpectedModelBehavior` 在多个
    子模块里各自定义，运行时不一定能直接 import 到同一个类。沿 MRO 找名字可以
    兼容子类（测试替身、以及将来 pydantic-ai 给它加子类）。
    """
    names = {klass.__name__ for klass in type(error).__mro__}
    if "UnexpectedModelBehavior" not in names:
        return False
    message = str(error).lower()
    return any(marker in message for marker in _TRANSPORT_FAILURE_MARKERS)


def _get_preference(capability: str, model_name: str) -> TransportMode | None:
    with _PREFERENCE_LOCK:
        return _MODE_PREFERENCES.get((capability, model_name))


def _set_preference(capability: str, model_name: str, mode: TransportMode) -> None:
    with _PREFERENCE_LOCK:
        _MODE_PREFERENCES[(capability, model_name)] = mode


def reset_transport_preferences() -> None:
    """清空学到的偏好。仅供测试与「渠道配置变了要重新学」使用。"""
    with _PREFERENCE_LOCK:
        _MODE_PREFERENCES.clear()


def known_transport_preferences() -> dict[tuple[str, str], TransportMode]:
    """当前缓存内容的快照，仅供测试与诊断使用。"""
    with _PREFERENCE_LOCK:
        return dict(_MODE_PREFERENCES)


async def run_with_transport_compat(
    *,
    capability: str,
    model_name: str,
    call: Callable[[TransportMode], Awaitable[Any]],
) -> Any:
    """发一次模型调用，按需在流式/非流式之间自动切换。

    `call` 收到目标传输方式并执行；两种方式都失败时把**第一次**的异常抛出去——
    那才是调用方真正想看到的根因。
    """
    preferred = _get_preference(capability, model_name)
    order: list[TransportMode]
    if preferred is None:
        # 没有偏好先试非流式：本地网关上它明显更稳，流式留给那些非流式不通的渠道。
        order = [False, True]
    else:
        order = [preferred, not preferred]

    first_error: BaseException | None = None
    for index, mode in enumerate(order):
        try:
            result = await call(mode)
        except BaseException as error:  # noqa: BLE001 — 需要按类型分流后重抛
            if first_error is None:
                first_error = error
            if not _is_transport_failure(error) or index == len(order) - 1:
                raise
            # 传输层失败：换另一种方式再试一次，成功就把偏好记下来。
            continue
        if index > 0:
            _set_preference(capability, model_name, mode)
        elif preferred is not None and mode != preferred:
            # 缓存里的偏好这次失效了（渠道换了/恢复了），更新掉。
            _set_preference(capability, model_name, mode)
        return result

    # 两种方式都失败：抛出第一次的异常，那是最接近根因的一次。
    assert first_error is not None
    raise first_error
