// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";

import { render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AskFirstPanel } from "@/features/ingest/ask-first-panel";
import type { WritingSkillBridge } from "@/features/ingest/writing-skill-library";
import type { WritingSkill, WritingSkillLibrary } from "@/lib/queries/ingest";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "zh",
    interpolation: { escapeValue: false },
    resources: {
      zh: {
        translation: JSON.parse(readFileSync("public/locales/zh/translation.json", "utf8")),
      },
      en: {
        translation: JSON.parse(readFileSync("public/locales/en/translation.json", "utf8")),
      },
    },
  });
});

beforeEach(async () => {
  sessionStorage.clear();
  await i18n.changeLanguage("zh");
});

const BUILTIN_SKILLS: WritingSkill[] = [
  {
    id: "reversal",
    name: "reversal",
    description: "",
    prompt: "剧情反转",
    question: "这一集要推翻观众前面的哪一个判断？",
    suggestions: ["观众以为他低头忍让", "观众以为真千金受苦"],
    builtin: true,
  },
  {
    id: "sweet",
    name: "sweet",
    description: "",
    prompt: "甜宠",
    question: "两人现在卡住的关系是什么？",
    suggestions: ["她借住在他家", "他单恋她三年"],
    builtin: true,
  },
];

const AD_BRIEF = {
  id: "ad-brief",
  name: "广告提案",
  description: "卖什么",
  question: "这条广告卖什么，看完要人做什么？",
  suggestions: ["卖一款续航三十天的耳机", "卖一杯三秒出锅的拌面"],
};

function stubLibrary(overrides: Partial<WritingSkillBridge> = {}): WritingSkillBridge {
  const library: WritingSkillLibrary = { skills: BUILTIN_SKILLS, ad_brief: AD_BRIEF };
  return {
    load: async () => library,
    save: async (params) => ({
      skill: {
        id: params.id ?? "rules",
        name: params.name,
        description: params.description,
        prompt: params.prompt,
        question: params.question,
        suggestions: params.suggestions,
        builtin: false,
      },
      regenerated: params.regenerate,
    }),
    remove: async () => undefined,
    restore: async (id) => ({ skill: BUILTIN_SKILLS.find((s) => s.id === id)! }),
    reshuffle: async () => ({ question: "", suggestions: ["换出来的第一句", "换出来的第二句"] }),
    ...overrides,
  };
}

function renderPanel(props: Partial<ComponentProps<typeof AskFirstPanel>> = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <AskFirstPanel
        projectId="demo"
        filename="夜雨归人.txt"
        hasManuscript
        formatBlocked
        skillLibrary={stubLibrary()}
        {...props}
      />
    </I18nextProvider>,
  );
}

/** 从「另写一篇」一路点到指定台阶，供多条用例复用。 */
async function walkTo(
  user: ReturnType<typeof userEvent.setup>,
  steps: Array<string | RegExp>,
) {
  await user.click(screen.getByRole("button", { name: /另写一篇/ }));
  for (const step of steps) {
    await user.click(screen.getByRole("button", { name: step }));
  }
}

describe("AskFirstPanel", () => {
  it("opens with one question and hides the outline, the edit tools, and the message rail", () => {
    renderPanel();

    expect(screen.getByText("你想先处理这篇，还是另写一篇？")).toBeInTheDocument();
    expect(screen.queryByText("大纲")).not.toBeInTheDocument();
    expect(screen.queryByText("改这篇")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /先处理这篇/ })).toBeEnabled();
    expect(document.querySelector("[data-msg]")).toBeNull();
  });

  it("drops the saved conversation when this visit has not started import", async () => {
    sessionStorage.setItem(
      "dramaclaw-ask-first:demo",
      JSON.stringify({
        active: "edit",
        editStep: "chat",
        zeroStep: "kind",
        editMessages: [
          { id: "edit-open", role: "agent", key: "ingest.askFirst.question" },
          { id: "u1", role: "user", text: "先处理这篇" },
          {
            id: "a1",
            role: "agent",
            text: "一键修复还没接到生成接口，正文还没改。原文仍在。",
          },
        ],
        zeroMessages: [{ id: "zero-open", role: "agent", key: "ingest.askFirst.zeroOpen" }],
        kind: "drama",
        count: "8",
        picked: [],
        queue: [],
        askIndex: 0,
        hasWork: false,
      }),
    );

    renderPanel({ hasManuscript: false, filename: "未命名", retainConversation: false });

    expect(screen.getByText("你想先处理这篇，还是另写一篇？")).toBeInTheDocument();
    expect(screen.queryByText("一键修复还没接到生成接口，正文还没改。原文仍在。")).not.toBeInTheDocument();
    expect(screen.queryByText("改这篇")).not.toBeInTheDocument();
    await waitFor(() => {
      const raw = sessionStorage.getItem("dramaclaw-ask-first:demo");
      expect(raw).toBeTruthy();
      expect(raw).not.toContain("还没接到生成接口");
      expect(JSON.parse(raw ?? "").editStep).toBe("path");
    });
  });

  it("keeps the saved conversation when a manuscript is already on this visit", () => {
    sessionStorage.setItem(
      "dramaclaw-ask-first:demo",
      JSON.stringify({
        active: "edit",
        editStep: "chat",
        zeroStep: "kind",
        editMessages: [
          { id: "edit-open", role: "agent", key: "ingest.askFirst.question" },
          { id: "u1", role: "user", text: "先处理这篇" },
        ],
        zeroMessages: [{ id: "zero-open", role: "agent", key: "ingest.askFirst.zeroOpen" }],
        kind: "drama",
        count: "8",
        picked: [],
        queue: [],
        askIndex: 0,
        hasWork: false,
      }),
    );

    renderPanel({ retainConversation: true });

    expect(screen.getAllByText("先处理这篇").length).toBeGreaterThan(0);
    expect(screen.getByText("改这篇")).toBeInTheDocument();
  });

  it("keeps editing this piece unavailable until a manuscript exists", () => {
    renderPanel({ hasManuscript: false, filename: "未命名" });

    expect(screen.getByRole("button", { name: /先处理这篇/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /另写一篇/ })).toBeEnabled();
  });

  it("shows edit tools only on the uploaded piece, and does not pretend a rewrite finished", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: /先处理这篇/ }));

    expect(screen.getByText("改这篇")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "一键修复" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "洗稿" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "一键修复" }));

    await user.type(screen.getByPlaceholderText("接着说，或让某一句再短一点"), "把第三章删掉");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(screen.getByText("这句改不了当前稿。可以改说法，不能删章、加情节，也不能出分镜。")).toBeInTheDocument();

    expect(screen.getByText("一键修复还没接到生成接口，正文还没改。原文仍在。")).toBeInTheDocument();
    expect(screen.queryByText("大纲")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /改选另写一篇/ }));

    expect(screen.queryByText("改这篇")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^长篇漫剧/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^广告/ })).toBeInTheDocument();
    expect(
      screen.getByText("这篇不读已上传的文件。先定成稿：短剧、长篇漫剧，还是广告？"),
    ).toBeInTheDocument();
  });

  it("keeps the chapter call log when repair fails", async () => {
    const user = userEvent.setup();
    const failed = new Error("上游返回 404") as Error & { calls?: string[] };
    failed.calls = ["第 2 章调用失败：status_code: 404"];
    renderPanel({
      onRepair: async () => {
        throw failed;
      },
    });

    await user.click(screen.getByRole("button", { name: /先处理这篇/ }));
    await user.click(screen.getByRole("button", { name: "一键修复" }));

    expect(await screen.findByText("上游返回 404")).toBeInTheDocument();
    expect(screen.getByText("调用明细")).toBeInTheDocument();
    expect(screen.getByText("第 2 章调用失败：status_code: 404")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭" })).toHaveAttribute("aria-pressed", "true");
  });

  it("asks the repair callback to write a working copy", async () => {
    const user = userEvent.setup();
    const onRepair = vi.fn(async (report: (line: string) => void) => {
      report("收好了。工作稿是《夜雨.xialiao.txt》，原文还在。可以开始导入。");
    });
    renderPanel({ onRepair });

    await user.click(screen.getByRole("button", { name: /先处理这篇/ }));
    await user.click(screen.getByRole("button", { name: "一键修复" }));

    expect(onRepair).toHaveBeenCalledOnce();
    expect(screen.getByText(/工作稿是《夜雨.xialiao.txt》/)).toBeInTheDocument();
    expect(screen.queryByText(/还没接到生成接口/)).not.toBeInTheDocument();
  });

it("asks one question per selected style, then writes episode one through the API", async () => {
    const user = userEvent.setup();
    const onWriteFirst = vi.fn().mockResolvedValue({
      upload: {
        filename: "第 1 集-她借住在他家.txt",
        size: 1200,
        count: 1,
        chapters: [],
        format_check: { level: "pass" },
      },
    });
    renderPanel({ onWriteFirst });

    await walkTo(user, [/^短剧/]);
    expect(screen.getByText("技能 · 已选 0 项")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /选择技能/ }));
    const sheet = within(screen.getByRole("dialog", { name: "选择技能" }));
    await user.click(sheet.getByRole("button", { name: /^剧情反转/ }));
    await user.click(sheet.getByRole("button", { name: "好" }));
    await user.click(screen.getByRole("button", { name: "开始问" }));

    expect(screen.getByText("这一集要推翻观众前面的哪一个判断？")).toBeInTheDocument();
    expect(screen.getByText("观众以为他低头忍让")).toBeInTheDocument();
    expect(screen.getByText("推荐")).toBeInTheDocument();

    await user.click(screen.getByText("观众以为他低头忍让"));
    await user.click(screen.getByRole("button", { name: "答完，看复述" }));

    expect(screen.getByText("这是要写的东西。对了就开写，不对就改。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "写第 1 集" }));

    expect(onWriteFirst).toHaveBeenCalledWith({
      kind: "drama",
      premise: "",
      lead: "",
      count: "8",
      skills: ["reversal"],
      answers: [
        {
          skill_id: "reversal",
          question: "这一集要推翻观众前面的哪一个判断？",
          answer: "观众以为他低头忍让",
          filled_by_skill: false,
        },
      ],
      reasoning_effort: "none",
    });
    expect(
      await screen.findByText(/第 1 集写好了，已存成《第 1 集-她借住在他家.txt》/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载这份稿" })).toBeInTheDocument();
    expect(screen.getByText("大纲")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "写第 2 集" })).toBeEnabled();
  });

  it("queues every selected skill and marks a skill without a question as filled by the skill", async () => {
    const user = userEvent.setup();
    const onWriteFirst = vi.fn().mockResolvedValue({
      upload: { filename: "第 1 集.txt", size: 900, count: 1, chapters: [], format_check: { level: "pass" } },
    });
    renderPanel({
      onWriteFirst,
      skillLibrary: stubLibrary({
        load: async () => ({
          skills: [
            { ...BUILTIN_SKILLS[0]!, suggestions: [] },
            { ...BUILTIN_SKILLS[1]!, question: "" },
          ],
          ad_brief: AD_BRIEF,
        }),
      }),
    });

    await walkTo(user, [/^短剧/]);
    await user.click(screen.getByRole("button", { name: /选择技能/ }));
    let sheet = within(screen.getByRole("dialog", { name: "选择技能" }));
    await user.click(sheet.getByRole("button", { name: /^剧情反转/ }));
    await user.click(sheet.getByRole("button", { name: /^甜宠/ }));
    await user.click(sheet.getByRole("button", { name: "好" }));
    await user.click(screen.getByRole("button", { name: "开始问" }));

    // 第一条有固定问题，只给了自己打的字。
    await user.type(screen.getByPlaceholderText("写一句具体的，或者点上面那句"), "观众以为他在忍");
    await user.click(screen.getByRole("button", { name: "答完，下一问" }));

    // 第二条没生成出问题：照样要答，只是标记为按写法补。
    expect(screen.getByText("这条技能没有固定的问题，模型会按提示词自己补。")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("写一句具体的，或者点上面那句"), "她借住在他家");
    await user.click(screen.getByRole("button", { name: "答完，看复述" }));

    expect(screen.getByText("按该技能自行补齐")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "写第 1 集" }));

    expect(onWriteFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        skills: ["reversal", "sweet"],
        answers: [
          expect.objectContaining({
            skill_id: "reversal",
            answer: "观众以为他在忍",
            filled_by_skill: false,
          }),
          expect.objectContaining({
            skill_id: "sweet",
            answer: "她借住在他家",
            filled_by_skill: true,
          }),
        ],
      }),
    );
  });

  it("goes straight to the recap when no skill is picked, and still locks the ad's own question", async () => {
    const user = userEvent.setup();
    renderPanel();

    await walkTo(user, [/^短剧/]);
    await user.click(screen.getByRole("button", { name: "开始问" }));
    expect(screen.getByText("这是要写的东西。对了就开写，不对就改。")).toBeInTheDocument();
    expect(screen.getByText("没选技能")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "改体裁" }));
    await user.click(screen.getByRole("button", { name: /^广告/ }));
    await user.click(screen.getByRole("button", { name: "开始问" }));

    expect(screen.getByText(AD_BRIEF.question)).toBeInTheDocument();
    await user.click(screen.getByText(AD_BRIEF.suggestions[0]!));
    await user.click(screen.getByRole("button", { name: "答完，看复述" }));

    expect(screen.getByText("广告锁死 1 集，不改。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始写广告" })).toBeInTheDocument();
  });

  it("reshuffles only the three suggestions on screen", async () => {
    const user = userEvent.setup();
    const reshuffle = vi.fn().mockResolvedValue({
      question: "这一集要推翻观众前面的哪一个判断？",
      suggestions: ["换出来的第一句", "换出来的第二句"],
    });
    renderPanel({ skillLibrary: stubLibrary({ reshuffle }) });

    await walkTo(user, [/^短剧/]);
    await user.click(screen.getByRole("button", { name: /选择技能/ }));
    const sheet = within(screen.getByRole("dialog", { name: "选择技能" }));
    await user.click(sheet.getByRole("button", { name: /^剧情反转/ }));
    await user.click(sheet.getByRole("button", { name: "好" }));
    await user.click(screen.getByRole("button", { name: "开始问" }));
    await user.click(screen.getByRole("button", { name: "换一批" }));

    expect(reshuffle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "reversal", avoid: BUILTIN_SKILLS[0]!.suggestions }),
    );
    expect(await screen.findByText("换出来的第一句")).toBeInTheDocument();
    expect(screen.queryByText("观众以为他低头忍让")).not.toBeInTheDocument();
  });

  it("keeps the library off the page until the sheet is opened, and picks from inside it", async () => {
    const user = userEvent.setup();
    renderPanel();

    await walkTo(user, [/^短剧/]);

    // 屏上只有一行：已选的零项加一个入口。库里的名字一个都不摆。
    expect(screen.getByText("技能 · 已选 0 项")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "甜宠" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /选择技能/ }));

    const sheet = within(screen.getByRole("dialog", { name: "选择技能" }));
    const row = sheet.getByRole("button", { name: /^剧情反转/ });
    expect(row).toHaveAttribute("aria-pressed", "false");

    await user.click(row);
    expect(sheet.getByRole("button", { name: /^剧情反转/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("技能 · 已选 1 项")).toBeInTheDocument();
  });

  it("filters inside the sheet and only starts asking on request", async () => {
    const user = userEvent.setup();
    const onWriteFirst = vi.fn();
    renderPanel({ onWriteFirst });

    await walkTo(user, [/^短剧/]);
    await user.click(screen.getByRole("button", { name: /选择技能/ }));
    const sheet = within(screen.getByRole("dialog", { name: "选择技能" }));
    // 内置写法的名字只存在于 i18n 词条里，搜索必须搜显示值而不是后端字段。
    await user.type(screen.getByPlaceholderText("搜索技能…"), "宠");
    expect(sheet.getByRole("button", { name: /^甜宠/ })).toBeInTheDocument();
    expect(sheet.queryByRole("button", { name: /^剧情反转/ })).not.toBeInTheDocument();

    await user.click(sheet.getByRole("button", { name: /^甜宠/ }));
    await user.click(sheet.getByRole("button", { name: "好" }));

    // 还没点「开始问」，一个请求都不该发。
    expect(onWriteFirst).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "开始问" }));

    expect(screen.getByText("两人现在卡住的关系是什么？")).toBeInTheDocument();
  });

  it("warns before a changed prompt regenerates the question, then saves", async () => {
    const user = userEvent.setup();
    const save = vi.fn().mockResolvedValue({
      skill: { ...BUILTIN_SKILLS[1]!, name: "甜宠", question: "这一问被重新生成" },
      regenerated: true,
    });
    renderPanel({ skillLibrary: stubLibrary({ save }) });

    await walkTo(user, [/^短剧/]);
    await user.click(screen.getByRole("button", { name: /选择技能/ }));
    const sheet = within(screen.getByRole("dialog", { name: "选择技能" }));
    await user.click(sheet.getByRole("button", { name: "编辑「甜宠」" }));

    await user.type(sheet.getByLabelText("发给模型的提示词"), "：用细节说话");
    expect(
      screen.getByText(/提示词改了，保存时会重新生成这一问和三句灵感/),
    ).toBeInTheDocument();

    await user.click(sheet.getByRole("button", { name: "保存" }));
    expect(screen.getByText("重新生成会覆盖下面这一问和三句灵感，继续吗？")).toBeInTheDocument();

    await user.click(
      within(screen.getByRole("dialog", { name: "选择技能" })).getByRole("button", {
        name: "重新生成并保存",
      }),
    );

    expect(await screen.findByText(/已生成这一问和三句灵感/)).toBeInTheDocument();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sweet", prompt: "甜宠：用细节说话", regenerate: true }),
    );
  });

  it("adds a skill from inside the sheet, and the model writes its question", async () => {
    const user = userEvent.setup();
    const save = vi.fn().mockResolvedValue({
      skill: {
        id: "rules",
        name: "规则怪谈",
        description: "规则是敌人",
        prompt: "规则怪谈：",
        question: "这条规则卡住了谁？",
        suggestions: ["夜里十点后不能开灯"],
        builtin: false,
      },
      regenerated: true,
    });
    renderPanel({ skillLibrary: stubLibrary({ save }) });

    await walkTo(user, [/^短剧/]);
    await user.click(screen.getByRole("button", { name: /＋ 新增一条/ }));
    const sheet = within(screen.getByRole("dialog", { name: "选择技能" }));
    await user.type(sheet.getByLabelText("名称"), "规则怪谈");
    await user.type(sheet.getByLabelText("发给模型的提示词"), "先立规则，再让人违反其中一条。");
    await user.click(sheet.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(await screen.findByText(/已生成这一问和三句灵感/)).toBeInTheDocument();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ name: "规则怪谈", prompt: "先立规则，再让人违反其中一条。" }),
    );
  });

  it("continues with episode two in the same file", async () => {
    const user = userEvent.setup();
    const onWriteFirst = vi
      .fn()
      .mockResolvedValueOnce({
        upload: { filename: "第 1 集.txt", size: 1200, episode: 1, count: 1, chapters: [], format_check: { level: "pass" } },
      })
      .mockResolvedValueOnce({
        upload: { filename: "第 1 集.txt", size: 2400, episode: 2, count: 2, chapters: [], format_check: { level: "pass" } },
      });
    renderPanel({ onWriteFirst });

    await walkTo(user, [/^短剧/]);
    await user.click(screen.getByRole("button", { name: "开始问" }));
    await user.click(screen.getByRole("button", { name: "写第 1 集" }));
    expect(await screen.findByText(/第 1 集写好了/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "写第 2 集" }));

    expect(onWriteFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ filename: "第 1 集.txt", episode: 2 }),
    );
    expect(await screen.findByText(/第 2 集写好了，已续在《第 1 集.txt》/)).toBeInTheDocument();
  });

  it("continues from free text that asks for the next episode", async () => {
    const user = userEvent.setup();
    const onWriteFirst = vi
      .fn()
      .mockResolvedValueOnce({
        upload: { filename: "第 1 集.txt", size: 1200, episode: 1, count: 1, chapters: [], format_check: { level: "pass" } },
      })
      .mockResolvedValue({
        upload: { filename: "第 1 集.txt", size: 2400, episode: 2, count: 2, chapters: [], format_check: { level: "pass" } },
      });
    renderPanel({ onWriteFirst });

    await walkTo(user, [/^短剧/]);
    await user.click(screen.getByRole("button", { name: "开始问" }));
    await user.click(screen.getByRole("button", { name: "写第 1 集" }));
    expect(await screen.findByText(/第 1 集写好了/)).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("接着说，或让某一句再短一点"), "继续，这集加一个反派");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(onWriteFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ episode: 2, note: "继续，这集加一个反派" }),
    );
  });

  it("reports a write-first failure in the conversation and keeps the recap open", async () => {
    const user = userEvent.setup();
    const onWriteFirst = vi.fn().mockRejectedValue(new Error("改稿模型没有可用通道。"));
    renderPanel({ onWriteFirst });

    await walkTo(user, [/^短剧/]);
    await user.click(screen.getByRole("button", { name: "开始问" }));
    await user.click(screen.getByRole("button", { name: "写第 1 集" }));

    expect(await screen.findByText("改稿模型没有可用通道。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "写第 1 集" })).toBeEnabled();
  });

  it("uses the English labels when the interface language is English", async () => {
    await i18n.changeLanguage("en");
    renderPanel();

    expect(screen.getByText("Work on this piece first, or write a new one?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Write a new one/ })).toBeEnabled();
    expect(screen.queryByText("你想先处理这篇，还是另写一篇？")).not.toBeInTheDocument();
  });
});
