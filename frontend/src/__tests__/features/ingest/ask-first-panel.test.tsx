// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";

import { render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AskFirstPanel } from "@/features/ingest/ask-first-panel";

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

function renderPanel(props: Partial<ComponentProps<typeof AskFirstPanel>> = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <AskFirstPanel
        projectId="demo"
        filename="夜雨归人.txt"
        hasManuscript
        formatBlocked
        {...props}
      />
    </I18nextProvider>,
  );
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
        premise: "",
        lead: "",
        count: "",
        skills: ["reversal"],
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
        premise: "",
        lead: "",
        count: "",
        skills: ["reversal"],
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
    expect(screen.getByText("写法，可多选")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "剧情反转" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("这篇不读取已上传的文件。先选一种：小说，还是短剧？")).toBeInTheDocument();
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

  it("asks the four new-piece questions one at a time, then writes episode one through the API", async () => {
    const user = userEvent.setup();
    const onWriteFirst = vi.fn().mockResolvedValue({
      upload: {
        filename: "第 1 集-雨夜问完那句话.txt",
        size: 1200,
        count: 1,
        chapters: [],
        format_check: { level: "pass" },
      },
    });
    renderPanel({ onWriteFirst });

    await user.click(screen.getByRole("button", { name: /另写一篇/ }));
    await user.click(screen.getByRole("button", { name: /短剧/ }));
    await user.type(screen.getByPlaceholderText(/雨夜回到旧茶馆/), "雨夜问完那句话");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await user.type(screen.getByPlaceholderText("例如：林晚"), "林晚");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await user.click(screen.getByRole("button", { name: "8 集" }));
    await user.click(screen.getByRole("button", { name: "写第 1 集" }));

    expect(onWriteFirst).toHaveBeenCalledWith({
      kind: "drama",
      premise: "雨夜问完那句话",
      lead: "林晚",
      count: "8",
      skills: ["reversal"],
      reasoning_effort: "none",
    });
    expect(
      await screen.findByText(/第 1 集写好了，已存成《第 1 集-雨夜问完那句话.txt》/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载这份稿" })).toBeInTheDocument();
    expect(screen.getByText("大纲")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "写第 1 集" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "写第 2 集" })).toBeEnabled();
  });

  it("continues with episode two in the same file", async () => {
    const user = userEvent.setup();
    const onWriteFirst = vi
      .fn()
      .mockResolvedValueOnce({
        upload: {
          filename: "第 1 集-雨夜问完那句话.txt",
          size: 1200,
          episode: 1,
          count: 1,
          chapters: [],
          format_check: { level: "pass" },
        },
      })
      .mockResolvedValueOnce({
        upload: {
          filename: "第 1 集-雨夜问完那句话.txt",
          size: 2400,
          episode: 2,
          count: 2,
          chapters: [],
          format_check: { level: "pass" },
        },
      });
    renderPanel({ onWriteFirst });

    await user.click(screen.getByRole("button", { name: /另写一篇/ }));
    await user.click(screen.getByRole("button", { name: /短剧/ }));
    await user.type(screen.getByPlaceholderText(/雨夜回到旧茶馆/), "雨夜问完那句话");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await user.type(screen.getByPlaceholderText("例如：林晚"), "林晚");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await user.click(screen.getByRole("button", { name: "8 集" }));
    await user.click(screen.getByRole("button", { name: "写第 1 集" }));
    expect(await screen.findByText(/第 1 集写好了/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "写第 2 集" }));

    expect(onWriteFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ filename: "第 1 集-雨夜问完那句话.txt", episode: 2 }),
    );
    expect(
      await screen.findByText(/第 2 集写好了，已续在《第 1 集-雨夜问完那句话.txt》/),
    ).toBeInTheDocument();
  });

  it("continues from free text that asks for the next episode", async () => {
    const user = userEvent.setup();
    const onWriteFirst = vi
      .fn()
      .mockResolvedValueOnce({
        upload: {
          filename: "第 1 集-雨夜问完那句话.txt",
          size: 1200,
          episode: 1,
          count: 1,
          chapters: [],
          format_check: { level: "pass" },
        },
      })
      .mockResolvedValue({
        upload: {
          filename: "第 1 集-雨夜问完那句话.txt",
          size: 2400,
          episode: 2,
          count: 2,
          chapters: [],
          format_check: { level: "pass" },
        },
      });
    renderPanel({ onWriteFirst });

    await user.click(screen.getByRole("button", { name: /另写一篇/ }));
    await user.click(screen.getByRole("button", { name: /短剧/ }));
    await user.type(screen.getByPlaceholderText(/雨夜回到旧茶馆/), "雨夜问完那句话");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await user.type(screen.getByPlaceholderText("例如：林晚"), "林晚");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await user.click(screen.getByRole("button", { name: "8 集" }));
    await user.click(screen.getByRole("button", { name: "写第 1 集" }));
    expect(await screen.findByText(/第 1 集写好了/)).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("接着说，或让某一句再短一点"), "继续，这集加一个反派");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(onWriteFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ episode: 2, note: "继续，这集加一个反派" }),
    );
    expect(
      await screen.findByText(/第 2 集写好了，已续在《第 1 集-雨夜问完那句话.txt》/),
    ).toBeInTheDocument();
  });

  it("reports a write-first failure in the conversation and keeps the button", async () => {
    const user = userEvent.setup();
    const onWriteFirst = vi.fn().mockRejectedValue(new Error("改稿模型没有可用通道。"));
    renderPanel({ onWriteFirst });

    await user.click(screen.getByRole("button", { name: /另写一篇/ }));
    await user.click(screen.getByRole("button", { name: /短剧/ }));
    await user.type(screen.getByPlaceholderText(/雨夜回到旧茶馆/), "雨夜问完那句话");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await user.type(screen.getByPlaceholderText("例如：林晚"), "林晚");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await user.click(screen.getByRole("button", { name: "8 集" }));
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
