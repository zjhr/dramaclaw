"""导演台专用路由。

挂在 ``/api/v1/director-desk`` 下。**刻意不碰** ``/api/v1/chat``：那条 WebSocket 是
产品对话的主干，回归面覆盖整个聊天体验，而收益只是导演台节点的工具面——风险不对等。

## 端点一览

### 会话与工具面（画布 iframe 调）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/ai/session` | 握手登记 node_id 会话，带上工具清单与内置技能 |
| POST | `/ai/session/close` | 关窗注销 |
| POST | `/ai/poll` | 长轮询取走待执行的工具调用与事件 |
| POST | `/ai/tool-result` | 按 request_id 回填工具结果 |

### AI 面板（iframe 通过宿主画布调）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/ai/profiles` | 渠道列表（脱敏） |
| POST | `/ai/configure` | 新增 / 更新 / 删除渠道 |
| POST | `/ai/channel-models` | 按地址 + 密钥试拉上游模型列表（**不落存储**，面板向导用） |
| POST | `/ai/profile-models` | 按**渠道 id** 读它的上游模型列表（密钥不出后端；结果按渠道缓存） |
| POST | `/ai/profile-model` | 给渠道定下模型（写 `settings.model`，对 `/ai/run` 立刻生效） |
| POST | `/ai/channel-quick-create` | 按地址 + 密钥 + 模型建渠道（向导最后一步，落全局 settings 库） |
| POST | `/ai/test` | 连通测试 |
| POST | `/ai/run` | 发起一次任务（**立即返回**，进度走 poll 的事件流） |
| POST | `/ai/stop` | 停止 |
| POST | `/ai/conversation` | 读当前对话 |
| POST | `/ai/conversation/new` | 重置对话 |
| POST | `/skills` | 技能面板动作 |

### MCP（外部客户端 + 上游面板的 MCP 区）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/mcp/tool` | 外部 MCP 客户端调用一次 `director_*` 工具 |
| POST | `/ai/mcp` | MCP 通道状态（`#ai-mcp` 面板） |
| POST | `/ai/mcp/config` | 生成可复制的客户端连接配置 |
| POST | `/ai/update` | 软件更新状态（自托管部署恒为 unsupported） |

密钥只在后端：``/ai/profiles`` 与 ``/ai/configure`` 的回包里只有 ``hasKey`` 布尔，
没有明文。``/ai/channel-models`` 与 ``/ai/channel-quick-create`` 同理 —— 前者只回模型
ID，后者的回包形状与 ``/ai/configure`` 一致。``/ai/profile-models`` 连请求体都不收
密钥（渠道的密钥留在后端），回包同样只有模型 ID。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from novelvideo.director_desk.ai_host import (
    ProfileError,
    ProviderError,
    ToolContract,
    get_ai_service,
)
from novelvideo.director_desk.mcp_tools import (
    DirectorDeskMcpError,
    call_director_desk_tool,
    mcp_client_config,
    mcp_endpoint_state,
    register_node,
    unregister_node,
    update_state,
)
from novelvideo.director_desk.skill_store import (
    SkillError,
    get_skill_store,
    handle_skill_request,
    set_builtin_skill,
)
from novelvideo.director_desk.tool_transport import (
    NoActiveSessionError,
    TransportError,
    get_tool_transport,
)

router = APIRouter()

#: 长轮询挂起上限。前端会立刻续上，所以这个值决定不了交互延迟。
POLL_WAIT_SECONDS = 30.0


# ── 请求体 ──────────────────────────────────────────────────────────────────


class SessionOpen(BaseModel):
    nodeId: str
    """宿主画布节点 id。工程按节点隔离，工具面也按节点隔离。"""

    contract: dict[str, Any] = Field(default_factory=dict)
    builtinSkill: dict[str, Any] | None = None


class SessionClose(BaseModel):
    nodeId: str
    sessionId: str = ""


class PollRequest(BaseModel):
    nodeId: str
    sessionId: str
    wait: float = 25.0


class ToolResult(BaseModel):
    nodeId: str
    requestId: str
    result: dict[str, Any] = Field(default_factory=dict)


class NodeRequest(BaseModel):
    nodeId: str


class ConfigureRequest(BaseModel):
    id: str = ""
    removeId: str = ""
    name: str = ""
    protocol: str = ""
    baseUrl: str = ""
    model: str = ""
    key: str = ""
    stream: bool = True
    maxTokens: int = 0
    maxRounds: int = 64


class ChannelModelsRequest(BaseModel):
    """向导第 2 步：只带地址与密钥，**不落任何存储**。

    刻意不接受 ``model``/``protocol``：模型是这一步拉回来的结果，让调用方能自己挑
    就不该由这里替它选。
    """

    baseUrl: str = ""
    key: str = ""


class ProfileModelsRequest(BaseModel):
    """读一条**已存在**渠道的上游模型列表。

    不收地址与密钥：面板选完渠道就该能选模型，而渠道的地址与密钥只存在于后端
    （``/ai/profiles`` 只回 ``hasKey``）。让前端把密钥再传回来等于把明文密钥搬进
    前端内存一次。
    """

    profileId: str
    refresh: bool = False


class SelectModelRequest(BaseModel):
    """给一条渠道定下要用的模型。存进 ``settings.model``，立刻对 ``/ai/run`` 生效。"""

    profileId: str
    model: str


class QuickChannelRequest(BaseModel):
    """向导第 4 步：按地址 + 密钥 + 模型建一个渠道，落回全局 settings 库。"""

    baseUrl: str = ""
    key: str = ""
    model: str = ""
    name: str = ""


class RunRequest(NodeRequest):
    profileId: str
    prompt: str
    sessionId: str = ""
    useSelection: bool = False
    mode: str = "execute"
    context: str = ""
    """画布侧面板附带的额外上下文（上游素材摘要、技能指令、选区说明）。

    与 ``prompt`` 分开是因为 ``prompt`` 是**用户原话**，会原样落进 :class:`Conversation`
    并被两个面板同时显示。上下文是给模型的输入、不是用户说的话，混进去会让共享历史里
    冒出 ``[导演台上下文]`` 这种内部文本 —— 正是旧面板在 Hermes 链路上的那个老毛病。

    iframe 侧的面板不传这个字段：它自己就是主入口，上下文由循环自己读工程快照生成。
    """


class TestRequest(BaseModel):
    profileId: str


class SkillRequest(BaseModel):
    action: str
    id: str = ""
    enabled: bool | None = None
    # `None` 而不是 `""`：空路径在上游是「读技能入口文件」，用空串会变成一次显式的
    # 路径校验，面板读别的文件时就对不上了。
    path: str | None = None
    url: str = ""
    files: list[dict[str, Any]] = Field(default_factory=list)


class McpToolRequest(BaseModel):
    """外部 MCP 客户端的一次工具调用。

    ``nodeId`` 可省略：只开了一扇导演台窗口时按「唯一活跃节点」解析。不唯一时后端
    报错并列出候选 —— 猜错节点等于把写入落到别的导演台上。
    """

    nodeId: str = ""
    name: str
    args: dict[str, Any] = Field(default_factory=dict)


class McpConfigRequest(BaseModel):
    client: str = "stdio"
    apiUrl: str = ""


# ── 会话与工具面 ────────────────────────────────────────────────────────────


@router.post("/ai/session")
def open_session(payload: SessionOpen) -> dict[str, Any]:
    """握手登记。

    工具清单与内置技能都从这里上来：事实来源在 iframe 里（上游
    ``src/automation/contract.ts`` 与 ``builtin-skill.json``），后端不抄第二份。
    """
    transport = get_tool_transport()
    try:
        contract = ToolContract.from_payload(payload.contract)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        session = transport.open_session(payload.nodeId)
    except TransportError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    set_builtin_skill(payload.builtinSkill)
    get_ai_service().set_contract(payload.nodeId, contract)
    # MCP 工具名白名单与传输层会话在同一个端点登记：两张表必须同时长出/同时消失，
    # 否则会有一段时间「会话在但白名单空」，外部调用全部被判成非法工具名。
    register_node(payload.nodeId, contract.names)
    return {"sessionId": session.session_id, "nodeId": session.node_id}


@router.post("/ai/session/close")
def close_session(payload: SessionClose) -> dict[str, Any]:
    transport = get_tool_transport()
    closed = transport.close_session(payload.nodeId, payload.sessionId or None)
    unregister_node(payload.nodeId)
    get_ai_service().clear_contract(payload.nodeId)
    return {"closed": closed}


@router.post("/ai/poll")
async def poll(payload: PollRequest) -> dict[str, Any]:
    """长轮询：有活立刻返回，没活挂起到 ``wait`` 秒。

    工具调用与 agent 事件走同一个回包 —— 事件本来就要排队给 UI 看，单开一条通道
    只会让「模型说完一句话」这件事多一个 HTTP 往返。
    """
    try:
        return await get_tool_transport().poll(
            payload.nodeId, payload.sessionId, min(payload.wait, POLL_WAIT_SECONDS)
        )
    except NoActiveSessionError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/ai/tool-result")
def tool_result(payload: ToolResult) -> dict[str, Any]:
    matched = get_tool_transport().submit_result(payload.nodeId, payload.requestId, payload.result)
    # 没配上不是错误：调用可能已经超时收尾（`execution: 'unknown'`），回填它只会
    # 写进一张已经没人等的表。安静丢弃比让画布弹错更对。
    return {"accepted": matched}


# ── AI 面板 ─────────────────────────────────────────────────────────────────


@router.post("/ai/profiles")
def profiles() -> dict[str, Any]:
    return {"channels": get_ai_service().profiles()}


@router.post("/ai/configure")
def configure(payload: ConfigureRequest) -> dict[str, Any]:
    try:
        channels = get_ai_service().configure(payload.model_dump())
    except ProfileError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"channels": channels}


@router.post("/ai/channel-models")
async def channel_models(payload: ChannelModelsRequest) -> dict[str, Any]:
    """按接口地址 + 密钥试拉上游模型列表（面板「极简新建」向导的第 2 步）。

    回包里只有模型 ID，没有密钥，也没有其它任何上游信息。
    """
    try:
        models = await get_ai_service().fetch_models(payload.baseUrl, payload.key)
    except ProfileError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"models": models}


@router.post("/ai/profile-models")
async def profile_models(payload: ProfileModelsRequest) -> dict[str, Any]:
    """按渠道 id 读它的上游模型列表（面板「选完渠道 → 选模型」那一步）。

    回包里只有模型 ID。既不接受也不返回密钥 —— 渠道的地址与密钥只存在于后端
    （见 :meth:`Channel.public`）。结果按渠道缓存，切渠道来回不会重复打上游。
    """
    try:
        models = await get_ai_service().list_models(payload.profileId, refresh=payload.refresh)
    except ProfileError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"profileId": payload.profileId, "models": models}


@router.post("/ai/profile-model")
def profile_model(payload: SelectModelRequest) -> dict[str, Any]:
    """给渠道定下模型。

    写的是 ``settings.model``（导演台自己的字段），不碰 ``type`` / ``upstreamKey`` /
    ``baseUrl``。回包里只有脱敏后的渠道列表 —— ``hasKey`` 仍是布尔。
    """
    try:
        channels = get_ai_service().select_model(payload.profileId, payload.model)
    except ProfileError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"channels": channels}


@router.post("/ai/channel-quick-create")
def channel_quick_create(payload: QuickChannelRequest) -> dict[str, Any]:
    """向导的最后一步：建一个渠道。

    落点与 :meth:`DirectorDeskAiService.quick_channel` 内部一致 —— 全局
    ``model_gateway_settings``，不新建任何 per-node 存储。回包只有 ``hasKey``，
    明文密钥不出后端（见 :meth:`Channel.public`）。
    """
    try:
        channels, channel_id = get_ai_service().quick_channel(
            base_url=payload.baseUrl,
            key=payload.key,
            model=payload.model,
            name=payload.name,
        )
    except ProfileError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"channels": channels, "channelId": channel_id}


@router.post("/ai/test")
async def test(payload: TestRequest) -> dict[str, Any]:
    try:
        return {"result": await get_ai_service().test(payload.profileId)}
    except ProfileError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/ai/run")
async def run(payload: RunRequest) -> dict[str, Any]:
    """发起任务并**立即返回 runId**。

    不在这里等循环跑完：一次任务可以跑几十轮、好几分钟，HTTP 长挂在中间代理上会被
    掐断。进度走 ``/ai/poll`` 的事件流，面板据此更新。
    """
    import asyncio

    service = get_ai_service()
    transport = get_tool_transport()
    try:
        snapshot = service.conversation(payload.nodeId)
    except ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    def fail(error: BaseException) -> None:
        """把**前置校验**失败也送进事件流。

        ``run()`` 的一批前置检查（没选渠道、对话已切换、工具清单没就绪）是在进入
        循环之前抛的，而它们已经在后台 task 里了。不补这一下，面板点「发送」会
        什么都看不到 —— 一个静默失败比一条错误提示难查得多。

        必须是**同步**函数：done_callback 不是 async，在里面调协程只会得到一个
        永远没人 await 的 coroutine。
        """
        transport.push_event(
            payload.nodeId,
            {
                "type": "error",
                "sessionId": snapshot["sessionId"],
                "text": str(error) + " 对话已保留，可继续。",
            },
        )

    task = asyncio.create_task(
        service.run(
            node_id=payload.nodeId,
            profile_id=payload.profileId,
            prompt=payload.prompt,
            session_id=payload.sessionId,
            use_selection=payload.useSelection,
            mode=payload.mode,
            context=payload.context,
        )
    )
    task.add_done_callback(
        lambda done: None if done.cancelled() or done.exception() is None else fail(done.exception())
    )
    return {"accepted": True, "sessionId": snapshot["sessionId"]}


@router.post("/ai/stop")
def stop(payload: NodeRequest) -> dict[str, Any]:
    return {"stopped": get_ai_service().stop(payload.nodeId or None)}


@router.post("/ai/conversation")
def conversation(payload: NodeRequest) -> dict[str, Any]:
    try:
        return {"conversation": get_ai_service().conversation(payload.nodeId)}
    except ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/ai/conversation/new")
async def new_conversation(payload: NodeRequest) -> dict[str, Any]:
    try:
        return {"conversation": await get_ai_service().new_conversation(payload.nodeId)}
    except ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ── 技能 ────────────────────────────────────────────────────────────────────


@router.post("/skills")
async def skills(payload: SkillRequest) -> dict[str, Any]:
    # 上游是 `skillHost.isBusy() + host.isRunning()`：任务在跑时不许改技能，因为
    # 本轮已经把启用的技能清单注进上下文了。这里的运行态按节点记，所以用「有没有
    # 任何节点在跑」这个更粗的口径 —— 宁可多挡一次，也不要让模型拿着过期的清单干活。
    if get_ai_service().is_running() and payload.action not in {"list", "read", "open"}:
        raise HTTPException(status_code=409, detail="请先结束当前 AI 任务，再修改启用的技能")
    try:
        return await handle_skill_request(
            get_skill_store(), payload.model_dump(exclude_none=True)
        )
    except SkillError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ── MCP ─────────────────────────────────────────────────────────────────────


@router.post("/mcp/tool")
async def mcp_tool(payload: McpToolRequest) -> dict[str, Any]:
    """外部 MCP 客户端驱动导演台 18 个工具的唯一入口。

    工具执行**不在这里**：请求经 :mod:`novelvideo.director_desk.tool_transport` 派发到
    画布 iframe，由那边的 ``toolService`` 完成（它依赖 Three.js 的 ``ctx.engine``）。
    本端点只做节点解析、工具名白名单与失败分类。

    回包**永远是 200**：``execution: 'not-started'`` / ``'unknown'`` 是要喂回模型的
    分类，套一层 HTTP 错误码只会让插件侧把它压成一行异常文本。
    """
    try:
        return await call_director_desk_tool(payload.nodeId, payload.name, payload.args)
    except DirectorDeskMcpError as exc:
        # 参数问题：还没派发任何东西，400 让调用方立刻改参数，而不是重试。
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/ai/mcp")
def mcp_state(payload: NodeRequest) -> dict[str, Any]:
    return {"mcp": mcp_endpoint_state(payload.nodeId)}


@router.post("/ai/mcp/config")
def mcp_config(payload: McpConfigRequest) -> dict[str, Any]:
    try:
        text = mcp_client_config(payload.client, payload.apiUrl)
    except DirectorDeskMcpError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"config": {"client": payload.client, "text": text}}


@router.post("/ai/update")
def update() -> dict[str, Any]:
    return {"update": update_state()}