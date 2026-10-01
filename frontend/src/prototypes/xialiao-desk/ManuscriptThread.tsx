// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { SkillPicker } from "./IngestChrome";
import { HOOKS, type Desk, type HookId } from "./desk";

interface Bubble {
  id: string;
  role: "user" | "agent";
  text: string;
}

const EDIT_OPEN: Bubble = {
  id: "edit-open",
  role: "agent",
  text: "夜雨归人.txt 已上传。精品剧没有场景头，开始导入还点不了。说「一键修复」，我把工作稿收成场次，原文件留下。",
};

const ZERO_OPEN: Bubble = {
  id: "zero-open",
  role: "agent",
  text: "从零写不读取夜雨归人.txt。先说四项：小说还是短剧、题材一句话、主角、大约几章或几集。技能可以多选，写出来的仍是章节或场次稿。",
};

export function ManuscriptThread({ desk }: { desk: Desk }) {
  const [editLog, setEditLog] = useState<Bubble[]>([EDIT_OPEN]);
  const [zeroLog, setZeroLog] = useState<Bubble[]>([ZERO_OPEN]);
  const [draft, setDraft] = useState("");
  const told = useRef(false);
  const log = desk.mode === "zero" ? zeroLog : editLog;
  const setLog = desk.mode === "zero" ? setZeroLog : setEditLog;

  useEffect(() => {
    if (!desk.hasWork || told.current) return;
    told.current = true;
    setEditLog((items) => [
      ...items,
      {
        id: "ready",
        role: "agent",
        text: `工作稿已经换上，左边的开始导入可以点了。原文件还在。\n\n第1集\n\n${desk.repairedLines().slice(2, 12).join("\n")}`,
      },
    ]);
  }, [desk]);

  const push = (role: Bubble["role"], text: string) => {
    setLog((items) => [...items, { id: `${desk.mode}-${items.length}-${role}`, role, text }]);
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    push("user", text);
    if (desk.mode === "edit" && /删章|加情节|分镜表|另一篇/.test(text)) {
      push("agent", "这句改不了当前稿。可以改说法，不能删章、加情节，也不能出分镜。");
      return;
    }
    if (desk.mode === "zero") {
      if (desk.zeroStep === "brief") {
        desk.writeFirst();
        push("agent", `第 1 ${desk.brief.kind === "小说" ? "章" : "集"}写好了，作为新文件放在左边，不盖掉夜雨归人.txt。${desk.skillNote}\n\n第1集\n\n${desk.zeroLines().slice(2, 10).join("\n")}`);
      } else {
        push("agent", "四项可以改。已经写好的章不动，下一章按你刚说的来。");
      }
      return;
    }
    push("agent", "可以。我改的是工作稿，原文件不动。");
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">虾导</p>
          <p className="truncate text-xs text-muted-foreground">
            {desk.mode === "zero" ? "从零写，不读已上传的文件" : "正在看 夜雨归人.txt"}
          </p>
        </div>
        <div className="inline-flex h-8 shrink-0 items-center rounded-[8px] border border-white/10 p-1 text-xs">
          <button
            type="button"
            onClick={() => desk.setMode("edit")}
            className={`h-6 rounded-[6px] px-2.5 ${desk.mode === "edit" ? "bg-foreground text-background" : "text-muted-foreground"}`}
          >
            改当前稿
          </button>
          <button
            type="button"
            onClick={() => desk.setMode("zero")}
            className={`h-6 rounded-[6px] px-2.5 ${desk.mode === "zero" ? "bg-foreground text-background" : "text-muted-foreground"}`}
          >
            从零写
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
        {log.map((bubble) =>
          bubble.role === "user" ? (
            <div key={bubble.id} className="xialiao-rise flex justify-end">
              <div className="max-w-[82%] whitespace-pre-wrap break-words rounded-[14px] bg-white/[0.07] px-4 py-2.5 text-sm leading-6">
                {bubble.text}
              </div>
            </div>
          ) : (
            <AgentReply key={bubble.id} text={bubble.text} />
          ),
        )}
        {desk.status === "repairing" && desk.mode === "edit" && (
          <p className="text-sm text-muted-foreground">正在收成场次稿…</p>
        )}
      </div>
      <form
        className="shrink-0 px-4 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.022]">
          {desk.mode === "edit" ? (
            <div className="flex flex-wrap gap-1.5 px-4 pt-3">
              <Chip
                disabled={desk.status !== "blocked"}
                onClick={() => {
                  if (desk.hasWork) return;
                  push("user", "一键修复");
                  desk.repair();
                }}
              >
                一键修复
              </Chip>
              <Chip
                disabled={!desk.hasWork}
                onClick={() => {
                  desk.wash();
                  push("user", "洗稿");
                  push("agent", "只改了对白的说法，场景头和人名没动。");
                }}
              >
                洗稿
              </Chip>
              {HOOKS.map((id) => (
                <Chip
                  key={id}
                  disabled={!desk.hasWork}
                  onClick={() => {
                    desk.chooseHook(id as HookId);
                    push("user", `爆款开头用${id}`);
                    push("agent", "只换了第一场的写法，场景头还在。");
                  }}
                >
                  {id}
                </Chip>
              ))}
            </div>
          ) : (
            <div className="px-3 pt-3">
              <SkillPicker desk={desk} />
            </div>
          )}
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={desk.mode === "zero" ? "短剧，雨夜茶馆，林晚，8集" : "让第一场的说法再短一点"}
            rows={2}
            className="max-h-[140px] min-h-14 w-full resize-none bg-transparent px-5 py-4 text-sm leading-6 outline-none placeholder:text-muted-foreground/70"
          />
          <div className="flex items-center justify-end px-3 py-2">
            <button
              type="submit"
              disabled={draft.trim().length === 0}
              aria-label="发送"
              className="flex size-8 items-center justify-center rounded-full bg-white text-black transition-colors hover:bg-white/90 disabled:bg-white/30 disabled:text-black/45"
            >
              <ArrowUp className="size-[18px]" />
            </button>
          </div>
        </div>
        <p className="mt-3 text-center text-xs leading-4 text-white/25">改当前稿和从零写各记一份对话。原文件留在虾料里。</p>
      </form>
    </div>
  );
}

function AgentReply({ text }: { text: string }) {
  const parts = text.split(/\n\n第1集\n\n/);
  return (
    <div className="xialiao-rise space-y-3">
      <p className="whitespace-pre-wrap break-words text-sm leading-6">{parts[0]}</p>
      {parts[1] && (
        <div className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
          <div className="border-b border-white/[0.06] px-3 py-2 text-xs text-muted-foreground">场次稿</div>
          <pre className="whitespace-pre-wrap px-3 py-3 font-sans text-sm leading-6">{`第1集\n\n${parts[1]}`}</pre>
        </div>
      )}
    </div>
  );
}

function Chip({ children, onClick, disabled }: { children: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="h-6 rounded-[6px] bg-white/[0.07] px-2 text-xs disabled:opacity-40"
    >
      {children}
    </button>
  );
}
