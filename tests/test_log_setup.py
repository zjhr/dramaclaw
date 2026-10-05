"""`log_setup` 的行为约束。

这些断言盯的是「日志到底能不能被人看见」：改动很小，但一旦被回退，症状是
排查问题时完全看不到线索，而不是任何报错，所以很容易悄悄坏掉。
"""

from __future__ import annotations

import io
import logging

import pytest

from novelvideo.utils import log_setup


def _reset() -> None:
    """把模块级幂等开关和 root handler 都还原，让每个用例从干净状态开始。"""
    log_setup._CONFIGURED = False
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)


@pytest.fixture(autouse=True)
def _clean_root() -> None:
    previous_level = logging.getLogger().level
    _reset()
    yield
    _reset()
    logging.getLogger().setLevel(previous_level)


def _stream_handlers() -> list[logging.Handler]:
    """只数我们自己那类 handler。

    pytest 会往 root 挂 ``LogCaptureHandler`` 来实现 ``caplog``，那是测试
    夹具、不是产品行为。断言要针对「产品有没有重复挂」，所以先把它们排除。
    """
    return [h for h in logging.getLogger().handlers if isinstance(h, logging.StreamHandler)]


def test_configure_gives_root_a_handler() -> None:
    log_setup.configure_logging()
    assert _stream_handlers(), "root logger 没有 handler，日志会走无格式的 lastResort"


def test_configure_is_idempotent() -> None:
    log_setup.configure_logging()
    before = len(_stream_handlers())
    log_setup.configure_logging()
    log_setup.configure_logging()
    assert len(_stream_handlers()) == before, "重复配置会让同一条日志打印多次"


def test_recorded_line_carries_time_level_and_origin() -> None:
    """格式必须能定位事件顺序与出处，裸行做不到这件事。"""
    stream = io.StringIO()
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter(log_setup._FORMAT, datefmt=log_setup._DATE_FORMAT))
    root.addHandler(handler)
    log_setup._CONFIGURED = True

    logging.getLogger("novelvideo.director_desk.ai_host").warning("stream dropped before body")

    line = stream.getvalue()
    assert "novelvideo.director_desk.ai_host" in line, "缺模块名，无法定位出处"
    assert "WARNING" in line, "缺级别"
    assert "stream dropped before body" in line
    # 时间戳是 yyyy-mm-dd 开头
    assert line[:4].isdigit(), f"缺时间戳：{line!r}"


def test_level_defaults_to_info(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LOG_LEVEL", raising=False)
    assert log_setup._resolve_level() == logging.INFO


def test_level_env_var_is_honoured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOG_LEVEL", "debug")
    assert log_setup._resolve_level() == logging.DEBUG


def test_unknown_level_falls_back_to_info(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOG_LEVEL", "chatty")
    assert log_setup._resolve_level() == logging.INFO


def test_existing_handler_is_not_duplicated(monkeypatch: pytest.MonkeyPatch) -> None:
    """宿主（测试夹具、嵌入式用法）已配过时，不覆盖也不追加。"""
    stream = io.StringIO()
    preset = logging.StreamHandler(stream)
    logging.getLogger().addHandler(preset)
    before = list(logging.getLogger().handlers)
    try:
        log_setup.configure_logging()
        assert logging.getLogger().handlers == before
    finally:
        if preset in logging.getLogger().handlers:
            logging.getLogger().removeHandler(preset)