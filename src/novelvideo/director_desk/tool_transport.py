"""导演台工具调用的传输层。

## 为什么需要它

agent 循环跑在后端（模型密钥、配额、会话历史都在这一侧），而 18 个 ``director_*``
工具跑在浏览器 iframe 的渲染进程里（`vendor/director-desk/src/automation/service.ts`
用的是 Three.js 的 `ctx.engine`，搬不到 Python 侧）。两段互不可达，中间只能有一层
显式配对的传输。

上游 Electron 用的是 `webContents.send('director-tool-call')` + `pending` 表；网页宿主
没有这条 IPC，于是这里给同一套语义一个 HTTP 形状：

```
后端 → 画布    POST /api/v1/director-desk/ai/poll      长轮询取走待执行的调用与事件
画布 → 后端    POST /api/v1/director-desk/ai/tool-result  按 request_id 回填结果
画布 → 后端    POST /api/v1/director-desk/ai/session      握手时登记 node_id 会话
画布 → 后端    POST /api/v1/director-desk/ai/session/close 关窗时注销
```

配对键是 ``request_id``（uuid4），与上游 `director_media.import` 的 `requestId`
语义一致。事件走同一条长轮询的回包，不另开通道：模型每个 token 一次 HTTP 太贵，
而事件本来就要排队给 UI 看。

## 没有活跃会话时的语义

工具调用最怕「等超时」——模型会以为写入失败，然后重放一次写入。所以这里照搬上游
`ai-conversation.cjs` 的分类，**立刻**失败而不是静默等待：

- 会话不存在（弹窗没开／已关）：``execution: 'not-started'``，调用根本没派发出去。
- 调用已派发但结果没回来（超时／关窗）：``execution: 'unknown'``，明确提示先读状态
  再决定，不要直接重放写入。

两者都不抛裸异常给调用方 —— 调用方（agent 循环）会把它们当成工具返回塞回模型上下文，
模型据此自己收敛。
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any

_log = logging.getLogger(__name__)

__all__ = [
    "DirectorDeskToolTransport",
    "NoActiveSessionError",
    "TransportError",
    "get_tool_transport",
]

# 上游 `integration.cjs` 的工具回话超时是 60s。这里照抄：短了会把真的慢工具误判成
# 「结果未知」，长了只是让一次停摆的会话多挂一分钟。
TOOL_CALL_TIMEOUT_S = 60.0

# 长轮询挂起上限。前端会立刻重发下一个 poll，所以这个值只决定「服务端多久回收一次
# 挂起的协程」，不影响延迟。
POLL_WAIT_MAX_S = 30.0

# 单个节点同时排队的工具调用上限。iframe 卡死时队列不能无限涨：排到上限说明画布已经
# 不接活了，此时按「未派发」失败比让模型对着一个死窗口空转更诚实。
MAX_QUEUED_CALLS = 64

# 单次 poll 最多回传多少条事件。模型一轮的 `text` 增量可能有几百条，一次全给会让回包
# 变大到需要分页，反而把「低延迟」这个目的做没了。
MAX_EVENTS_PER_POLL = 200


class TransportError(RuntimeError):
    """传输层的一般性失败（队列已满、会话串号等）。"""


class NoActiveSessionError(TransportError):
    """该 node_id 没有可用的画布会话 —— 调用不会被派发出去。"""


@dataclass(frozen=True)
class ToolCallRequest:
    """一次待执行的工具调用。``request_id`` 是唯一的配对键。"""

    request_id: str
    node_id: str
    name: str
    args: dict[str, Any]


@dataclass
class _PendingCall:
    node_id: str
    future: asyncio.Future[dict[str, Any]]


@dataclass
class DirectorDeskSession:
    """一条已握手的画布会话。

    ``session_id`` 每次重新打开 iframe 都换新 —— 旧窗口的 poll 回包因此不可能配到
    新窗口上，省掉「谁才是当前会话」的一整类竞态。
    """

    node_id: str
    session_id: str
    created_at: float
    wakeup: asyncio.Event = field(default_factory=asyncio.Event)
    calls: deque[ToolCallRequest] = field(default_factory=deque)
    events: deque[dict[str, Any]] = field(default_factory=deque)

    def touch(self) -> None:
        self.wakeup.set()


class DirectorDeskToolTransport:
    """``request_id`` 配对的请求/回包 + 事件队列。

    全类只在事件循环单线程里跑，关键区段内没有 ``await``，所以不需要额外的锁；真要
    加锁反而会让「取走调用」与「等结果」之间出现新的交错点。
    """

    def __init__(
        self,
        *,
        tool_timeout: float = TOOL_CALL_TIMEOUT_S,
        poll_wait_max: float = POLL_WAIT_MAX_S,
    ) -> None:
        self._sessions: dict[str, DirectorDeskSession] = {}
        self._pending: dict[str, _PendingCall] = {}
        self._tool_timeout = float(tool_timeout)
        self._poll_wait_max = float(poll_wait_max)

    # ── 会话登记 ────────────────────────────────────────────────────────────

    def open_session(self, node_id: str) -> DirectorDeskSession:
        """登记（或顶替）某个节点的会话，返回新的会话。

        同一 ``node_id`` 重复登记就是「用户重试 / 关窗重开」：旧会话立刻失效，它的
        在途调用按 ``unknown`` 收尾——旧 iframe 可能还活着但已经没人 poll 了。
        """
        key = str(node_id or "").strip()
        if not key:
            raise TransportError("导演台会话缺少 node_id")
        self._close_session_locked(key, reason="导演台会话已被新的窗口取代")
        session = DirectorDeskSession(
            node_id=key, session_id=str(uuid.uuid4()), created_at=time.monotonic()
        )
        self._sessions[key] = session
        return session

    def close_session(self, node_id: str, session_id: str | None = None) -> bool:
        """注销会话。``session_id`` 给了就只注销匹配的那条，防旧窗口误关新窗口。"""
        key = str(node_id or "").strip()
        session = self._sessions.get(key)
        if session is None:
            return False
        if session_id and session.session_id != session_id:
            return False
        return self._close_session_locked(key, reason="导演台窗口已关闭，工具结果未知")

    def is_active(self, node_id: str) -> bool:
        return str(node_id or "").strip() in self._sessions

    def _close_session_locked(self, node_id: str, *, reason: str) -> bool:
        session = self._sessions.pop(node_id, None)
        if session is None:
            return False
        session.calls.clear()
        session.events.clear()
        for request_id in [
            rid for rid, item in self._pending.items() if item.node_id == node_id
        ]:
            self._resolve(
                request_id,
                {"ok": False, "execution": "unknown", "error": reason},
            )
        return True

    # ── 后端 → 画布：工具调用 ───────────────────────────────────────────────

    async def call(
        self, node_id: str, name: str, args: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """派发一次工具调用并等待结果。

        返回值就是上游约定的 ``{ok, data|error, execution?}`` 回话形状，调用方不需要
        区分「传输失败」和「工具自己失败」——两者都该喂回模型。
        """
        key = str(node_id or "").strip()
        session = self._sessions.get(key)
        if session is None:
            raise NoActiveSessionError(
                f"导演台 {key} 没有活跃会话，请在画布上打开该导演台节点"
            )
        if not str(name or "").strip():
            raise TransportError("工具调用缺少工具名")
        if len(session.calls) >= MAX_QUEUED_CALLS:
            raise TransportError("导演台没有在取工具调用，请检查画布窗口是否卡住")

        request_id = str(uuid.uuid4())
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = _PendingCall(node_id=key, future=future)
        session.calls.append(
            ToolCallRequest(
                request_id=request_id, node_id=key, name=str(name), args=args or {}
            )
        )
        session.touch()
        _log.debug("director desk tool queued node=%s name=%s request=%s", key, name, request_id)
        try:
            return await asyncio.wait_for(future, self._tool_timeout)
        except (asyncio.TimeoutError, TimeoutError):
            _log.warning("director desk tool timed out node=%s name=%s request=%s", key, name, request_id)
            return {
                "ok": False,
                "execution": "unknown",
                "error": "工具响应超时，请先查询状态，不要直接重复写入",
            }
        finally:
            self._pending.pop(request_id, None)

    def submit_result(
        self, node_id: str, request_id: str, result: dict[str, Any]
    ) -> bool:
        """画布回填一次工具调用的结果。``False`` 表示没有配对的在途调用（已超时/已作废）。"""
        key = str(node_id or "").strip()
        pending = self._pending.get(str(request_id or ""))
        if pending is None or pending.node_id != key:
            _log.debug("director desk tool result unmatched node=%s request=%s", key, request_id)
            return False
        _log.debug(
            "director desk tool result node=%s request=%s ok=%s",
            key,
            request_id,
            bool(result.get("ok")) if isinstance(result, dict) else False,
        )
        return self._resolve(str(request_id), result)

    def _resolve(self, request_id: str, result: dict[str, Any]) -> bool:
        pending = self._pending.pop(request_id, None)
        if pending is None:
            return False
        if not pending.future.done():
            pending.future.set_result(result)
        return True

    def pending_count(self, node_id: str | None = None) -> int:
        if node_id is None:
            return len(self._pending)
        key = str(node_id or "").strip()
        return sum(1 for item in self._pending.values() if item.node_id == key)

    # ── 后端 → 画布：事件 ───────────────────────────────────────────────────

    def push_event(self, node_id: str, event: dict[str, Any]) -> bool:
        """把一条 agent 事件排给画布。没有会话时返回 ``False``（事件无处可去）。"""
        session = self._sessions.get(str(node_id or "").strip())
        if session is None:
            return False
        session.events.append(dict(event))
        session.touch()
        return True

    # ── 画布 → 后端：长轮询 ─────────────────────────────────────────────────

    async def poll(
        self, node_id: str, session_id: str, wait: float = POLL_WAIT_MAX_S
    ) -> dict[str, Any]:
        """取走待执行的工具调用与积压事件。

        有活就立刻返回，没有活就挂起到 ``wait`` 秒。有新调用/新事件时
        {@link DirectorDeskSession.touch} 会把挂起的协程叫醒，所以延迟不受 ``wait`` 影响。
        """
        key = str(node_id or "").strip()
        session = self._sessions.get(key)
        if session is None or session.session_id != str(session_id or ""):
            raise NoActiveSessionError(f"导演台 {key} 没有匹配的活跃会话")

        wait = max(0.0, min(float(wait), self._poll_wait_max))
        deadline = time.monotonic() + wait
        while True:
            session.wakeup.clear()
            payload = self._drain(session)
            if payload["calls"] or payload["events"]:
                _log.debug(
                    "director desk poll node=%s calls=%s events=%s",
                    key,
                    len(payload["calls"]),
                    len(payload["events"]),
                )
                return payload
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return {"calls": [], "events": []}
            try:
                await asyncio.wait_for(session.wakeup.wait(), remaining)
            except (asyncio.TimeoutError, TimeoutError):
                return {"calls": [], "events": []}

    def _drain(self, session: DirectorDeskSession) -> dict[str, Any]:
        calls = [
            {
                "request_id": call.request_id,
                "name": call.name,
                "args": call.args,
            }
            for call in list(session.calls)[:MAX_QUEUED_CALLS]
        ]
        # 必须从 deque 本体上弹出。`del list(deque)[:n]` 切的是临时副本，会留下一个
        # 永远排不空的队列 —— poll 于是不断把同一个调用重发给画布。
        for _ in calls:
            session.calls.popleft()
        events = list(session.events)[:MAX_EVENTS_PER_POLL]
        for _ in events:
            session.events.popleft()
        return {"calls": calls, "events": events}


_TRANSPORT = DirectorDeskToolTransport()


def get_tool_transport() -> DirectorDeskToolTransport:
    """进程级传输层单例。

    端点与 agent 循环必须共用同一个实例：``pending`` 表跨两侧配对，拆成两份就永远
    配不上。
    """
    return _TRANSPORT
