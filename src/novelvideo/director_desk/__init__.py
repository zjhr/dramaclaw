"""导演台（`mangfufu/director-desk`）的 Python 后端切片。

模块边界：

- {@link novelvideo.director_desk.tool_transport}：后端 ↔ 画布 iframe 的工具调用与事件传输。
- {@link novelvideo.director_desk.ai_host}：agent 循环、模型协议、会话持久化。
- {@link novelvideo.director_desk.skill_store}：技能包落盘与校验。
- {@link novelvideo.director_desk.routes}：导演台专用 HTTP 端点。

上行的 `director_*` 工具依然跑在浏览器 iframe 的渲染进程里（`ctx.engine` 被工具层用了
二十来处，搬不到 Python 侧），所以本包**不实现任何 `director_*` 工具**，只负责把模型
的意图送到画布、把结果取回来。
"""

from __future__ import annotations

__all__ = ["get_skill_store", "get_tool_transport"]
