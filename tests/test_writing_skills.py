from __future__ import annotations

import pytest

from novelvideo.ingest.writing_skills import (
    WritingSkillError,
    WritingSkillStore,
    build_suggestion_prompt,
    generate_question,
    new_skill_id,
)


@pytest.fixture
def store(tmp_path) -> WritingSkillStore:
    return WritingSkillStore(tmp_path)


def test_builtin_skills_carry_question_and_suggestions(store: WritingSkillStore):
    skills = store.list()

    assert [skill.id for skill in skills][:3] == ["reversal", "contrast", "emotion"]
    sweet = next(skill for skill in skills if skill.id == "sweet")
    assert sweet.builtin is True
    assert sweet.question.endswith("？")
    assert len(sweet.suggestions) == 3


def test_prompts_for_follows_selection_order_and_skips_unknown(store: WritingSkillStore):
    lines = store.prompts_for(["sweet", "不存在", "reversal"])

    assert len(lines) == 2
    assert "甜宠" in lines[0]
    assert "剧情反转" in lines[1]


@pytest.mark.asyncio
async def test_custom_skill_round_trips_through_disk(store: WritingSkillStore, tmp_path):
    skill = await store.create(
        name="规则怪谈",
        description="规则本身就是敌人",
        prompt="规则怪谈：把规则写死，并让人物违反其中一条。",
        question="这条规则卡住了谁？",
        suggestions=["夜里十点后不能开灯"],
    )

    assert skill.builtin is False
    await store.update(skill.id, name="规则怪谈2", description="改过的说明")

    reopened = WritingSkillStore(tmp_path)
    customs = [item for item in reopened.list() if not item.builtin]
    assert len(customs) == 1
    assert customs[0].name == "规则怪谈2"
    assert customs[0].description == "改过的说明"
    assert customs[0].question == "这条规则卡住了谁？"
    assert customs[0].suggestions == ("夜里十点后不能开灯",)


@pytest.mark.asyncio
async def test_builtin_skill_cannot_be_deleted_but_can_be_restored(store: WritingSkillStore):
    with pytest.raises(WritingSkillError, match="内置技能不能删除"):
        await store.remove("sweet")

    await store.update("sweet", prompt="改过的甜宠提示词")
    assert store.get("sweet").prompt == "改过的甜宠提示词"

    await store.restore("sweet")
    assert store.get("sweet").prompt != "改过的甜宠提示词"


@pytest.mark.asyncio
async def test_custom_skill_can_be_deleted(store: WritingSkillStore):
    skill = await store.create(name="临时写法", description="", prompt="提示词")

    await store.remove(skill.id)

    assert store.get(skill.id) is None


@pytest.mark.asyncio
async def test_duplicate_name_is_rejected(store: WritingSkillStore):
    await store.create(name="规则怪谈", description="", prompt="提示词")

    with pytest.raises(WritingSkillError, match="已经有同名技能"):
        await store.create(name="规则怪谈", description="", prompt="提示词")


@pytest.mark.asyncio
async def test_blank_name_and_prompt_are_rejected(store: WritingSkillStore):
    with pytest.raises(WritingSkillError, match="请填写技能名称"):
        await store.create(name="  ", description="", prompt="提示词")
    with pytest.raises(WritingSkillError, match="请填写提示词"):
        await store.create(name="有名字", description="", prompt="")


def test_corrupted_library_reports_instead_of_crashing(tmp_path):
    (tmp_path / "writing-skills.json").write_text("{ 不是 json", encoding="utf-8")

    with pytest.raises(WritingSkillError, match="技能库"):
        WritingSkillStore(tmp_path).list()


def test_suggestion_prompt_carries_kind_and_avoided_lines():
    prompt = build_suggestion_prompt(
        name="甜宠",
        description="细节说话",
        prompt="甜宠：宠要用细节。",
        kind="短剧",
        context="已选甜宠",
        avoid=["她借住在他家"],
    )

    assert "成稿类型：短剧" in prompt
    assert "不要使用下面这些已有的句子" in prompt
    assert "她借住在他家" in prompt


@pytest.mark.asyncio
async def test_generate_question_parses_json_from_fenced_output():
    async def runner(prompt: str, effort: str) -> str:
        return (
            "好的，这是结果：\n```json\n"
            '{"question": "这一集要推翻什么？", "suggestions": ["观众以为他怕", "观众以为她赢"]}\n'
            "```"
        )

    question, suggestions = await generate_question(
        runner, name="反转", description="", prompt="反转：推翻判断"
    )

    assert question == "这一集要推翻什么？"
    assert suggestions == ("观众以为他怕", "观众以为她赢")


@pytest.mark.asyncio
async def test_generate_question_returns_empty_on_bad_output():
    async def runner(prompt: str, effort: str) -> str:
        return "我不知道"

    assert await generate_question(runner, name="x", description="", prompt="p") == ("", ())


def test_new_skill_id_is_slug_based_but_unique():
    assert new_skill_id("规则怪谈").startswith("s-")
    assert new_skill_id("规则怪谈") != new_skill_id("规则怪谈")
    assert new_skill_id("Rules!").startswith("rules-")