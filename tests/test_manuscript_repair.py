from __future__ import annotations

import asyncio

import pytest

from novelvideo.cognee.chapter_detector import ChapterDetector
from novelvideo.official_defaults import DEFAULT_TEXT_MODEL_BY_ENV
from novelvideo.ingest.manuscript_repair import (
    ChapterPlan,
    assemble_manuscript,
    advance_manuscript_repair,
    clean_model_text,
    ensure_heading,
    fresh_progress,
    _is_channel_selection_failure,
    repair_model_settings,
    repair_upstream_should_retry,
    run_repair_with_fallback,
    run_repair_with_retry,
)
from novelvideo.utils.screenplay_quality import build_import_format_check


PROSE = "第1章 雨夜\n林晚走进雨里，低声说你来了。\n\n第2章 茶馆\n店主把茶碗推过来。"
SCREENPLAY = "第1章 雨夜\n巷口 夜 内\n林晚：你来了。"


def test_ensure_heading_removes_repeated_copy_of_current_chapter_heading():
    heading = "第6章 军报记者来采访了！"
    generated = (
        "第6章 line, then:\n营区 日 外\n江晨走进营区。\n第6章 title\n江晨停下脚步。"
    )

    cleaned = ensure_heading(generated, heading)

    assert cleaned.splitlines()[0] == heading
    assert (
        sum(
            ChapterDetector()._match_chapter(line.strip()) == 6
            for line in cleaned.splitlines()
        )
        == 1
    )
    assert len(ChapterDetector().detect(cleaned)) == 1
    assert "江晨走进营区。" in cleaned
    assert "江晨停下脚步。" in cleaned


def test_assemble_manuscript_normalizes_saved_completed_chapters():
    heading = "第6章 军报记者来采访了！"
    plan = ChapterPlan(
        number=6,
        heading=heading,
        chunks=[],
        mode="narrated",
        original=f"{heading}\n原始正文。",
    )
    progress = {
        "chapters": {
            "6": {
                "done": True,
                "text": (
                    "第6章 line, then:\n营区 日 外\n江晨走进营区。\n"
                    "第6章 title\n江晨停下脚步。"
                ),
            }
        }
    }

    assembled = assemble_manuscript([plan], progress)

    assert assembled.startswith(heading)
    assert len(ChapterDetector().detect(assembled)) == 1
    assert "江晨走进营区。" in assembled
    assert "江晨停下脚步。" in assembled


def test_clean_model_text_keeps_the_last_screenplay_after_reasoning():
    raw = (
        "第1章 军宣新星\n"
        "The user wants me to convert this chapter.\n"
        "文工团办公室 日 内\n"
        "周薄森：欢迎。\n"
        "\n"
        "第1章 军宣新星\n"
        "文工团副团长办公室 日 内\n"
        "周薄森：江晨同志，欢迎你加入我们文工团。\n"
    )

    cleaned = clean_model_text(raw)

    assert cleaned.startswith("第1章 军宣新星\n文工团副团长办公室 日 内")
    assert "The user wants" not in cleaned
    assert "文工团办公室 日 内" not in cleaned


def test_clean_model_text_drops_a_single_reasoning_preamble():
    raw = "第4章 向前进\nThe user wants me to convert this.\n幕前 日 内\n旁白：确实！\n"

    cleaned = clean_model_text(raw)

    assert cleaned == "第4章 向前进\n幕前 日 内\n旁白：确实！"


def test_clean_model_text_extracts_final_version_after_an_embedded_heading():
    heading = "第1章 雨夜"
    raw = (
        f"{heading}\n巷口 夜 外\n旧版内容。\n"
        f"Write final output now.{heading}\n巷口 夜 外\n最终版内容。"
    )

    cleaned = clean_model_text(raw, heading=heading)

    assert cleaned == f"{heading}\n巷口 夜 外\n最终版内容。"


def test_clean_model_text_uses_repeated_scene_header_after_reasoning():
    heading = "第2章 采访"
    raw = (
        f"{heading}\n办公室 日 内\n旧版内容。\n"
        "One more check: keep the original dialogue.\n"
        "办公室 日 内\n最终版内容。"
    )

    cleaned = clean_model_text(raw, heading=heading)

    assert cleaned == f"{heading}\n办公室 日 内\n最终版内容。"


def test_clean_model_text_rejects_reasoning_without_a_safe_final_boundary():
    raw = (
        "第3章 争议\n抖手评论区 日 外\n吴伟看向手机。\n"
        "Order issue: move this line later."
    )

    with pytest.raises(ValueError, match="无法安全分离"):
        clean_model_text(raw, heading="第3章 争议")


def test_clean_model_text_preserves_english_lyrics_from_the_source():
    raw = "第4章 歌声\n舞台 日 内\n江晨（歌声）：And I will dream of you."

    assert clean_model_text(raw, heading="第4章 歌声", source_text=raw) == raw


def test_clean_model_text_drops_reasoning_lines_inside_the_final_draft():
    raw = (
        "第1章 军宣新星\n"
        "The user wants me to convert this chapter.\n"
        "文工团副团长办公室 日 内\n"
        "Let me check the names again.\n"
        "周薄森：江晨同志，欢迎你加入我们文工团。\n"
    )

    cleaned = clean_model_text(raw)

    assert cleaned == (
        "第1章 军宣新星\n"
        "文工团副团长办公室 日 内\n"
        "周薄森：江晨同志，欢迎你加入我们文工团。"
    )


def test_clean_model_text_leaves_a_normal_chapter_alone():
    raw = "第1章 试探\n办公室 日 内\n甲：好。"

    assert clean_model_text(raw) == raw


def test_repair_thinking_levels():
    assert repair_model_settings("high") == {"openai_reasoning_effort": "high"}
    assert repair_model_settings("nope") == {"openai_reasoning_effort": "none"}
    assert repair_model_settings(None) == {"openai_reasoning_effort": "none"}


def test_manuscript_repair_defaults_to_the_single_channel_alias():
    assert DEFAULT_TEXT_MODEL_BY_ENV["MANUSCRIPT_REPAIR_MODEL"] == "DC-cognee-LLM"


class _StatusError(Exception):
    def __init__(self, status_code: int, body: dict | None = None) -> None:
        super().__init__(f"status {status_code}")
        self.status_code = status_code
        self.body = body


def test_proxy_timeout_is_retried_and_a_bad_request_is_not():
    assert repair_upstream_should_retry(_StatusError(524)) is True
    assert repair_upstream_should_retry(_StatusError(400)) is False
    assert repair_upstream_should_retry(_StatusError(404)) is False
    assert (
        repair_upstream_should_retry(_StatusError(404, {"type": "model_not_found"}))
        is True
    )
    assert (
        repair_upstream_should_retry(_StatusError(500, {"code": "do_request_failed"}))
        is True
    )
    assert (
        repair_upstream_should_retry(
            ValueError("Expecting value: line 1 column 133 (char 132)")
        )
        is True
    )
    assert repair_upstream_should_retry(TimeoutError("timed out")) is True
    assert repair_upstream_should_retry(ValueError("正文短了太多")) is False


def test_upstream_transport_errors_are_transient_not_channel_selection_failures():
    model_not_found = _StatusError(404, {"type": "model_not_found"})
    upstream_eof = _StatusError(500, {"code": "do_request_failed"})

    assert _is_channel_selection_failure(model_not_found) is True
    assert _is_channel_selection_failure(upstream_eof) is False
    assert repair_upstream_should_retry(upstream_eof) is True


class _OneStream:
    def __init__(self, output: object) -> None:
        self.output = output

    async def __aenter__(self) -> "_OneStream":
        return self

    async def __aexit__(self, *_args: object) -> bool:
        return False

    async def get_output(self) -> object:
        if isinstance(self.output, BaseException):
            raise self.output
        return self.output


class _ScriptedAgent:
    def __init__(self, outputs: list[object]) -> None:
        self.outputs = outputs
        self.prompts: list[str] = []

    def run_stream(self, prompt: str) -> _OneStream:
        self.prompts.append(prompt)
        return _OneStream(self.outputs[len(self.prompts) - 1])


@pytest.mark.asyncio
async def test_streamed_repair_retries_a_proxy_timeout_once():
    agent = _ScriptedAgent(
        [_StatusError(524), "第1章 雨夜\n巷口 夜 内\n林晚：你来了。"]
    )

    text = await run_repair_with_retry(agent, "第1章")

    assert text.startswith("第1章")
    assert agent.prompts == ["第1章", "第1章"]


@pytest.mark.asyncio
async def test_streamed_repair_retries_channel_selection_failures_until_success():
    agent = _ScriptedAgent(
        [
            _StatusError(404, {"type": "model_not_found"}),
            _StatusError(500, {"code": "do_request_failed"}),
            "第1章 雨夜\n巷口 夜 内\n林晚：你来了。",
        ]
    )

    text = await run_repair_with_retry(agent, "第1章")

    assert text.startswith("第1章")
    assert agent.prompts == ["第1章", "第1章", "第1章"]


@pytest.mark.asyncio
async def test_model_not_found_falls_back_to_a_known_channel_alias():
    calls: list[str] = []
    primary_agent = _ScriptedAgent([_StatusError(404, {"type": "model_not_found"})])

    async def primary(prompt: str) -> str:
        calls.append("primary")
        return await run_repair_with_retry(
            primary_agent,
            prompt,
            channel_retry_attempts=1,
            transient_retry_attempts=1,
        )

    async def fallback(_prompt: str) -> str:
        calls.append("fallback")
        return "第1章 雨夜\n巷口 夜 内\n林晚：你来了。"

    result = await run_repair_with_fallback("第1章", primary, fallback)

    assert result.startswith("第1章")
    assert calls == ["primary", "fallback"]
    assert primary_agent.prompts == ["第1章"]


@pytest.mark.asyncio
async def test_upstream_eof_falls_back_after_one_primary_attempt():
    calls: list[str] = []
    primary_agent = _ScriptedAgent([_StatusError(500, {"code": "do_request_failed"})])

    async def primary(prompt: str) -> str:
        calls.append("primary")
        return await run_repair_with_retry(
            primary_agent,
            prompt,
            channel_retry_attempts=1,
            transient_retry_attempts=1,
        )

    async def fallback(_prompt: str) -> str:
        calls.append("fallback")
        return SCREENPLAY

    result = await run_repair_with_fallback("第1章", primary, fallback)

    assert result == SCREENPLAY
    assert calls == ["primary", "fallback"]
    assert primary_agent.prompts == ["第1章"]


@pytest.mark.asyncio
async def test_upstream_eof_retries_are_bounded_without_a_fallback():
    agent = _ScriptedAgent(
        [_StatusError(500, {"code": "do_request_failed"}) for _ in range(4)]
    )

    with pytest.raises(_StatusError):
        await run_repair_with_retry(agent, "第1章")

    assert agent.prompts == ["第1章", "第1章"]


@pytest.mark.asyncio
async def test_streamed_repair_does_not_retry_a_rejected_request():
    agent = _ScriptedAgent([_StatusError(400), "不应该再打一次"])

    with pytest.raises(_StatusError):
        await run_repair_with_retry(agent, "第1章")

    assert agent.prompts == ["第1章"]


@pytest.mark.asyncio
async def test_repairs_the_whole_manuscript_in_one_model_call():
    calls: list[str] = []

    async def runner(prompt: str) -> str:
        calls.append(prompt)
        if "茶馆" in prompt:
            return "第2章 茶馆\n茶馆 日 内\n店主：坐。"
        return "第1章 雨夜\n巷口 夜 内\n林晚：你来了。"

    progress = fresh_progress("drama")
    finished = await advance_manuscript_repair(
        PROSE, progress, spine_template="drama", runner=runner
    )

    assert finished.error is None
    assert finished.done is True
    assert finished.completed_chapters == [1, 2]
    assert len(calls) == 2
    assert all("第1章" not in call or "第2章" not in call for call in calls)
    assert "巷口 夜 内" in finished.assembled
    assert "茶馆 日 内" in finished.assembled
    check = build_import_format_check(
        finished.assembled,
        has_chapters=True,
        require_scene_headers=True,
    )
    assert check["scene_header_status"] != "missing"


@pytest.mark.asyncio
async def test_advance_normalizes_saved_chapters_without_calling_the_model():
    original = "第1章 雨夜\n原始正文。"
    progress = fresh_progress("narrated")
    progress["chapters"]["1"] = {
        "done": True,
        "text": "第1章 line, then:\n正文第一段。\n第1章 title\n正文第二段。",
    }

    async def runner(_prompt: str) -> str:
        raise AssertionError("已完成章节不应重新调用模型")

    result = await advance_manuscript_repair(
        original,
        progress,
        spine_template="narrated",
        runner=runner,
    )

    assert result.done is True
    assert result.completed_chapters == [1]
    assert len(ChapterDetector().detect(result.assembled)) == 1
    assert progress["chapters"]["1"]["text"].startswith("第1章 雨夜")
    assert "第1章 title" not in progress["chapters"]["1"]["text"]


@pytest.mark.asyncio
async def test_two_chapters_do_not_finish_a_longer_manuscript():
    async def runner(prompt: str) -> str:
        title = next(
            line
            for line in reversed(prompt.splitlines())
            if line.startswith("第") and "章" in line
        )
        number = title.split("章", 1)[0]
        return f"{number}章 某处\n房间 日 内\n甲：好。"

    source = "\n\n".join(f"第{number}章 某处\n甲走进来。" for number in range(1, 6))
    progress = fresh_progress("drama")
    first = await advance_manuscript_repair(
        source, progress, spine_template="drama", runner=runner
    )

    assert first.done is False
    assert first.completed_chapters == [1, 2]
    assert progress["chapters"]["3"]["done"] is False


@pytest.mark.asyncio
async def test_repair_limits_parallel_chapter_requests_to_two():
    active = 0
    peak = 0

    async def runner(prompt: str) -> str:
        nonlocal active, peak
        title = next(
            line
            for line in prompt.splitlines()
            if line.startswith("第") and "章" in line
        )
        number = title.split("章", 1)[0]
        active += 1
        peak = max(peak, active)
        try:
            await asyncio.sleep(0.01)
            return f"{number}章 某处\n房间 日 内\n甲：好。"
        finally:
            active -= 1

    source = "\n\n".join(f"第{number}章 某处\n甲走进来。" for number in range(1, 6))
    result = await advance_manuscript_repair(
        source,
        fresh_progress("drama"),
        spine_template="drama",
        runner=runner,
    )

    assert result.error is None
    assert peak == 2


@pytest.mark.asyncio
async def test_missing_scene_header_asks_the_user_to_choose():
    async def runner(_prompt: str) -> str:
        return "第1章 雨夜\n林晚走进茶馆，说你来了。"

    progress = fresh_progress("drama")
    source = "第1章 雨夜\n林晚走进茶馆。"
    waiting = await advance_manuscript_repair(
        source, progress, spine_template="drama", runner=runner
    )

    assert waiting.needs_choice is True
    assert waiting.completed_chapters == []
    assert "茶馆 夜 内" in (waiting.choices or [])
    assert progress["chapters"]["1"]["awaiting_header"] is True
    assert "林晚走进茶馆" in progress["chapters"]["1"]["draft"]

    chosen = await advance_manuscript_repair(
        source,
        progress,
        spine_template="drama",
        runner=runner,
        chosen_header="茶馆 夜 内",
    )
    assert chosen.error is None
    assert chosen.completed_chapters == [1]
    assert "茶馆 夜 内" in chosen.assembled
    assert "你来了" in chosen.assembled


@pytest.mark.asyncio
async def test_restart_repairs_a_finished_chapter_again():
    calls = 0

    async def runner(_prompt: str) -> str:
        nonlocal calls
        calls += 1
        return SCREENPLAY

    progress = fresh_progress("drama")
    source = "第1章 雨夜\n林晚走进雨里。"
    await advance_manuscript_repair(
        source, progress, spine_template="drama", runner=runner
    )
    assert progress["chapters"]["1"]["done"] is True

    again = await advance_manuscript_repair(
        source,
        progress,
        spine_template="drama",
        runner=runner,
        restart=True,
    )

    assert again.completed_chapters == [1]
    assert calls == 2
