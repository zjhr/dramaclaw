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
| POST | `/ai/conversation/new` | 归档当前对话并新建 |
| POST | `/ai/conversation/history` | 当前节点的历史会话列表 |
| POST | `/ai/conversation/select` | 切回当前节点的一份历史会话 |
| POST | `/ai/blender/status` | 本机能否跑 AI 建模（Blender 路径、护栏路径、可用 kind） |
| POST | `/ai/blender/run` | 跑一段 AI 写的 bpy 脚本 → 护栏 → GLB |
| POST | `/ai/blender/tool` | 同上，但回**工具结果**形状并内联 base64 |
| POST | `/storyboard` | 项目分镜目录 + 选中镜头的上下文文本（**唯一带鉴权**的端点，见下） |
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

``/storyboard`` 是这批里唯一挂 ``get_api_user`` 的：其余端点只碰导演台自己的工程
（同一台机器上的一次会话），而它读的是**项目数据** —— 剧本、旁白、角色名。
"""

from __future__ import annotations

import logging
import math
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from novelvideo.director_desk.ai_director_desk_context import (
    beat_view,
    build_storyboard_context,
    storyboard_episodes_with_beats,
)
from novelvideo.director_desk.ai_host import (
    BLENDER_KINDS,
    BLENDER_TOOL_NAME,
    ProfileError,
    ProviderError,
    ToolContract,
    get_ai_service,
    run_blender_tool,
)
from novelvideo.director_desk.blender_runner import (
    BlenderRunnerError,
    blender_available,
    guard_path,
    resolve_out_path,
    run_ai_model,
    unique_out_path,
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
from novelvideo.director_desk.reference_images import normalize_reference_images
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


class ConversationSelectRequest(NodeRequest):
    """会话 ID 只允许引用本节点归档，服务层再次校验其路径安全与归属。"""

    sessionId: str = Field(min_length=1, max_length=160)


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

    images: list[str] = Field(default_factory=list, max_length=1)
    """当前关联来源中选中的真实图片，独立于用户原话与文字上下文。"""

    imagePrevisConfirmation: str = Field(default="", max_length=100)
    """用户点击确认的方案编号，后端核对活动会话、图片、模型与来源。"""

    @field_validator("images")
    @classmethod
    def valid_images(cls, images: list[str]) -> list[str]:
        return normalize_reference_images(images)


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


class BlenderRunRequest(BaseModel):
    """把一段 AI 写的 bpy 脚本交给后端跑护栏，产出 GLB。

    ``script`` 就是 AI 给的那份原文，后端不解析、不改写、不做白名单 —— 这是主人
    明确选的「完全自由」。护栏（悬空 / 连通分量 / 尺度 / 面数 / 禁网）与宿主侧的
    超时、`shell=False`、路径不逃逸在 :mod:`novelvideo.director_desk.blender_runner`。
    """

    script: str
    """完整可执行的 bpy 脚本。不接受占位符或伪代码。"""

    name: str = ""
    """道具显示名，也用作 GLB 文件名主干。"""

    kind: str = ""
    """真实尺寸表里的类别，护栏据此做尺度硬归一化。"""

    expectParts: int | None = None
    """预期连通分量数。不符即失败 —— 逼 AI 先想清楚自己写了几个零件。"""

    realHeight: float | None = None
    """显式真实高度（米）。`kind` 之外的类别用它。"""

    timeoutSeconds: int = 60
    """单次上限秒。会再被硬顶（300s）夹一次。"""

    out: str = ""
    """GLB 文件名 / 路径。留空自动生成；给出时必须落在导演台模型目录内。"""

    inline: bool = True
    """成功时是否内联 base64 data URL。

    网页版 `director_media import` 不收本机路径，所以**默认内联** —— 这不是
    可选项，是导入链路的唯一通路。GLB 超过上限时如实报错，不给导不进去的路径。
    """


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
            images=payload.images,
            image_previs_confirmation=payload.imagePrevisConfirmation,
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


@router.post("/ai/conversation/history")
def conversation_history(payload: NodeRequest) -> dict[str, Any]:
    try:
        return {"conversations": get_ai_service().conversation_history(payload.nodeId)}
    except ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/ai/conversation/select")
async def select_conversation(payload: ConversationSelectRequest) -> dict[str, Any]:
    try:
        return {"conversation": await get_ai_service().select_conversation(payload.nodeId, payload.sessionId)}
    except ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ── Blender 执行 ────────────────────────────────────────────────────────────


@router.post("/ai/blender/status")
def blender_status() -> dict[str, Any]:
    """本机能不能跑 AI 建模。技能面板与排查用，不产生任何副作用。"""
    available, source = blender_available()
    return {
        "available": available,
        "source": source,
        "guard": str(guard_path()),
        "tool": BLENDER_TOOL_NAME,
        "kinds": list(BLENDER_KINDS),
    }


@router.post("/ai/blender/run")
async def blender_run(payload: BlenderRunRequest) -> dict[str, Any]:
    """跑一段 AI 写的 bpy 脚本 → 护栏 → GLB。

    **回包永远是 200**，成功失败都由 ``ok`` 说。护栏判失败（悬空、分量数不符、
    脚本抛异常、超时）是这条链路的**正常结果**，套 HTTP 错误码只会让调用方把它
    当成「服务挂了」而看不到 ``guardReport`` 里那几条具体是哪几个零件、什么高度。

    只有**参数不合法**（空脚本、路径逃逸、未知 kind）才是 400 —— 那种重试也没用，
    得先改参数。
    """
    kind = payload.kind.strip() or None
    if kind and kind not in BLENDER_KINDS:
        raise HTTPException(
            status_code=400,
            detail=f"kind={kind} 不在真实尺寸表里；用其中之一或不传 kind 并给 realHeight",
        )
    try:
        out_path = resolve_out_path(payload.out) if payload.out else unique_out_path(payload.name)
        result = await run_ai_model(
            payload.script,
            out_path=out_path,
            timeout=payload.timeoutSeconds,
            kind=kind,
            expect_parts=payload.expectParts,
            real_height=payload.realHeight,
        )
    except BlenderRunnerError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return result.public(inline=payload.inline)


@router.post("/ai/blender/tool")
async def blender_tool(payload: BlenderRunRequest) -> dict[str, Any]:
    """与 :func:`blender_run` 同一个执行体，但回**工具结果**的形状并内联 base64。

    给不想自己拼 ``director_media`` 入参的调用方用（面板按钮、外部编排）。
    ``{"ok": false, ...}`` 时 ``error`` 是给模型看的那句话。

    参数非法**不抛 400**：工具结果本身就是「模型要读的文字」，套一层 HTTP 状态码
    只会让调用方拿不到那句话。
    """
    try:
        data = await run_blender_tool(
            {
                "script": payload.script,
                "name": payload.name,
                "kind": payload.kind,
                "expectParts": payload.expectParts,
                "realHeight": payload.realHeight,
                "timeoutSeconds": payload.timeoutSeconds or 60,
            }
        )
    except BlenderRunnerError as exc:
        data = {"ok": False, "reason": "invalid-arguments", "message": str(exc)}
    if not data.get("ok"):
        return {"ok": False, "error": data.get("message") or "Blender 执行失败", "data": data}
    return {"ok": True, "data": data}


# ── 分镜上下文 ──────────────────────────────────────────────────────────────


#: 分镜编号保持整数语义；布尔值或浮点编号不作为画布来源定位依据。
PositiveBeatNumber = Annotated[int, Field(gt=0, strict=True)]


class StoryboardRequest(BaseModel):
    """读项目分镜，供导演台面板选镜头与拼上下文。

    ``episode`` 留空时取「最后一个有分镜的集」。宿主不该猜当前是第几集：项目里
    可能只有第 3 集有分镜，猜成第 1 集会静默给出一份空目录。
    """

    project: str
    episode: int = Field(default=0, ge=0)
    beat: int = Field(default=0, ge=0)
    beatNumbers: list[PositiveBeatNumber] | None = Field(default=None, max_length=200)
    """指定上游镜组时只读取这些编号；空列表保持空来源，不回落整集。"""

    sourceName: str = Field(default="", max_length=200)
    """画布来源的可读名，仅作为数据标签，不构成工具指令。"""


class CanvasStoryboardRequest(BaseModel):
    """一个画布上游的原始分镜数据，和 beat_view 的项目字段共用口径。"""

    sourceName: str = Field(default="", max_length=200)
    beats: list[dict[str, Any]] = Field(max_length=200)
    beat: PositiveBeatNumber | None = None

    @field_validator("beats")
    @classmethod
    def valid_beats(cls, beats: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """拒绝不稳定编号、非有限时长与明显错误字段，保留未消费的上游数据。"""
        numbers: set[int] = set()
        text_fields = ("synopsis", "visual_description", "video_prompt", "keyframe_prompt", "narration_segment",
                       "dialogue", "narration", "time_of_day", "speaker", "audio_type", "reference_image_url")
        for index, beat in enumerate(beats):
            number = beat.get("beat_number")
            if type(number) is not int or number <= 0 or number in numbers:
                raise ValueError(f"beats[{index}].beat_number 必须是唯一的正整数")
            numbers.add(number)
            duration = beat.get("duration_seconds")
            if duration is not None:
                try:
                    valid_duration = type(duration) in (int, float) and math.isfinite(duration) and duration >= 0
                except OverflowError:
                    valid_duration = False
                if not valid_duration:
                    raise ValueError(f"beats[{index}].duration_seconds 必须是有限的非负秒数")
            if beat.get("scene_ref") is not None and not isinstance(beat["scene_ref"], dict):
                raise ValueError(f"beats[{index}].scene_ref 必须是场景对象或空值")
            for field in text_fields:
                if beat.get(field) is not None and not isinstance(beat[field], str):
                    raise ValueError(f"beats[{index}].{field} 必须是文本或空值")
        return beats


async def _api_user(request: Request) -> dict:
    """``novelvideo.api.auth.get_api_user`` 的等价依赖，签名逐字对齐。

    导入推迟到调用时：``novelvideo.api.__init__`` 挂的就是本模块，顶部导入会形成
    「routes → api → routes」的环，先于 ``novelvideo.api`` 导入本模块的地方（测试、
    MCP 工具）会拿到半初始化的模块。
    """
    from novelvideo.api.auth import get_api_user  # noqa: PLC0415

    return await get_api_user(request)


@router.post("/storyboard")
async def storyboard(payload: StoryboardRequest, user: dict = Depends(_api_user)) -> dict[str, Any]:
    """当前项目的分镜目录 + 选中镜头的上下文文本。

    **鉴权与 ``/ai/*`` 那批端点不同**：那批是本机单用户、只碰导演台自己的工程；
    这里读的是项目数据（剧本、旁白、角色），所以要过 ``get_api_user`` +
    ``resolve_project_scope``，而不是裸挂。
    """
    from novelvideo.api.deps import (  # noqa: PLC0415
        resolve_project_scope,
        sqlite_store_for_context_scope,
        sqlite_store_scope,
    )

    resolved = await resolve_project_scope(payload.project, user, required_role="viewer")
    scope = (
        sqlite_store_for_context_scope(resolved.ctx, load_graph_state=False)
        if resolved.ctx
        else sqlite_store_scope(resolved.username, resolved.project_name)
    )
    async with scope as store:
        counts = await store.count_beats_by_episode()
        # 目录必须与虾镜的剧集入口一致：单独残留在 beats 表的验收或历史记录
        # 没有可访问的剧集来源，不能仅因数据库里有行就混进卡片和模型上下文。
        # 此 scope 未加载图状态，需从 SQLite 读剧集，不能使用空的内存缓存。
        episode_numbers = {episode.number for episode in await store.list_episodes()}
        beat_episodes = storyboard_episodes_with_beats(counts)
        available = [number for number in beat_episodes if number in episode_numbers]
        orphaned = [number for number in beat_episodes if number not in episode_numbers]
        if orphaned:
            logging.getLogger(__name__).warning(
                "导演台忽略无对应剧集的分镜记录: project=%s episodes=%s",
                resolved.project_name, orphaned,
            )
        if payload.episode and payload.episode not in available:
            raise HTTPException(status_code=404, detail="指定剧集不存在或没有分镜，请检查虾镜或画布上游来源")
        if not available:
            if payload.beat or payload.beatNumbers:
                raise HTTPException(status_code=404, detail="指定分镜不存在，请检查画布上游来源")
            return {"ok": True, "data": {"episode": 0, "episodes": [], "beats": [], "context": ""}}
        episode = payload.episode or available[-1]
        beats = await store.get_beats_as_dicts(episode)

    if payload.beatNumbers is not None:
        available_numbers = {int(beat.get("beat_number") or 0) for beat in beats}
        wanted = set(payload.beatNumbers)
        if wanted - available_numbers:
            raise HTTPException(status_code=404, detail="画布上游指定的分镜不存在，请重新关联来源")
        beats = [beat for beat in beats if int(beat.get("beat_number") or 0) in wanted]
    views = [beat_view(beat, episode=episode) for beat in beats]
    views = [view for view in views if view["beat_number"]]
    if payload.beat and not any(view["beat_number"] == payload.beat for view in views):
        raise HTTPException(status_code=404, detail="选中分镜不属于当前来源，请重新选择")
    selected = payload.beat or (views[0]["beat_number"] if views else None)
    return {
        "ok": True,
        "data": {
            "episode": episode,
            "episodes": available,
            "beats": views,
            "selected": selected,
            "context": build_storyboard_context(beats, episode=episode, selected=selected, source_name=payload.sourceName or None),
        },
    }


@router.post("/storyboard/canvas")
async def canvas_storyboard(payload: CanvasStoryboardRequest, user: dict = Depends(_api_user)) -> dict[str, Any]:
    """只归一化一个已关联的画布上游，不扫描或自动回落到项目分镜。"""
    views = [beat_view(beat, episode=0) for beat in payload.beats]
    if payload.beat is not None and not any(view["beat_number"] == payload.beat for view in views):
        raise HTTPException(status_code=404, detail="选中分镜不属于当前画布来源，请重新选择")
    selected = payload.beat or (views[0]["beat_number"] if views else None)
    return {"ok": True, "data": {
        "episode": 0, "episodes": [], "beats": views, "selected": selected,
        "context": build_storyboard_context(payload.beats, episode=0, selected=selected, source_name=payload.sourceName or None),
    }}


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
