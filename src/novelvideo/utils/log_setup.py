"""进程级日志配置。

**为什么需要这个模块**：Python 的 root logger 默认既没有 handler、level 又是
``WARNING``。没有 handler 时，``logging`` 会退化到 ``lastResort`` —— 一个
**无格式**的 stderr handler：只有裸消息，没有时间戳、没有级别、没有模块名。
而 uvicorn 的默认 ``LOGGING_CONFIG`` 只配了 ``uvicorn`` / ``uvicorn.error`` /
``uvicorn.access`` 三个 logger，不会给 root 补 handler。

结果：项目里所有 ``logging.getLogger(__name__)`` 的调用（包括
``novelvideo.api.app`` 自己那几处 ``logger.info`` / ``logger.exception``，
以及导演台模块的失败日志）要么完全不可见，要么以无法定位时间的裸行形式打到
stderr。排查问题时既不知道事件顺序，也不知道出自哪个模块。

这里在应用启动时给 root 挂一个带格式的 handler，级别由 ``LOG_LEVEL`` 决定
（默认 ``INFO``，设 ``LOG_LEVEL=DEBUG`` 打开逐轮细节）。刻意不碰 uvicorn 自己的
logger —— 它们已经配好了，重复配置会让启动日志出现两遍。
"""

from __future__ import annotations

import logging
import os
import sys

#: 进程内只配置一次。``create_app()`` 可能在测试里被反复调用，重复挂 handler
#: 会让同一条日志打印多次。
_CONFIGURED = False

#: 日志行格式。``%(asctime)s`` 给顺序，``%(name)s`` 给出处，缺一个就无法定位。
_FORMAT = "%(asctime)s %(levelname)-7s %(name)s | %(message)s"

#: ``asctime`` 默认带毫秒和逗号，排查时秒级就够；去掉逗号纯粹为了对齐。
_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


def _resolve_level() -> int:
    """读 ``LOG_LEVEL``，认不出就退回 ``INFO``。"""
    raw = os.environ.get("LOG_LEVEL", "").strip().upper()
    if not raw:
        return logging.INFO
    return getattr(logging, raw, logging.INFO)


def configure_logging() -> None:
    """给 root logger 挂一个 stderr handler。幂等。

    调用点是应用工厂（``novelvideo.api.app.create_app``）的最前面，这样任何
    在导入期或 startup 阶段打的日志都已经在有效配置下。
    """
    global _CONFIGURED
    if _CONFIGURED:
        return

    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter(_FORMAT, datefmt=_DATE_FORMAT))

    root = logging.getLogger()
    # 已经有 handler 说明宿主（测试夹具、嵌入式用法）配过了，不覆盖。
    if not root.handlers:
        root.addHandler(handler)
    root.setLevel(_resolve_level())

    _CONFIGURED = True
