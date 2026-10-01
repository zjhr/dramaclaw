// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

import { useEffect, useRef, useState } from "react";
import { ArrowUp, PencilLine } from "lucide-react";
import { IngestPageFrame, SkillPicker } from "./IngestChrome";
import { HOOKS, SOURCE, useDesk, type Desk, type HookId } from "./desk";

function useCompleteDesk() {
  const desk = useDesk();
  const [draft, setDraft] = useState("");
  const [editLog, setEditLog] = useState<string[]>([
    "夜雨归人.txt 已上传。没有场景头，开始导入还点不了。可以一键修复、换开头、洗稿、换角色、改性格，或深挖仿写。",
  ]);
  const [zeroLog, setZeroLog] = useState<string[]>([
    "从零写不读取已上传的文件。补齐体裁、题材、主角和篇幅，再选写法技能。",
  ]);
  const log = desk.mode === "zero" ? zeroLog : editLog;
  const say = (text: string) => {
    const setLog = desk.mode === "zero" ? setZeroLog : setEditLog;
    setLog((items) => [...items, text]);
  };
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    say(`你：${text}`);
    if (desk.mode === "edit" && /删章|加情节|分镜表/.test(text)) {
      say("这句改不了当前稿。可以改说法，不能删章、加情节，也不能出分镜。");
      return;
    }
    if (desk.mode === "zero" && desk.zeroStep === "brief") {
      desk.writeFirst();
      say(`第 1 ${desk.brief.kind === "小说" ? "章" : "集"}已写入新文件。${desk.skillNote}`);
      return;
    }
    say(desk.mode === "zero" ? "已写章节保持不动，后面按你刚说的来。" : "改的是工作稿，原文件不动。");
  };
  return { desk, draft, setDraft, log, say, send };
}

type Complete = ReturnType<typeof useCompleteDesk>;

function ModeSwitch({ desk }: { desk: Desk }) {
  return (
    <div className="inline-flex h-8 items-center rounded-[8px] border border-white/10 p-1 text-xs">
      <button type="button" onClick={() => desk.setMode("edit")} className={`h-6 rounded-[6px] px-2.5 ${desk.mode === "edit" ? "bg-foreground text-background" : "text-muted-foreground"}`}>改当前稿</button>
      <button type="button" onClick={() => desk.setMode("zero")} className={`h-6 rounded-[6px] px-2.5 ${desk.mode === "zero" ? "bg-foreground text-background" : "text-muted-foreground"}`}>从零写</button>
    </div>
  );
}

function Actions({ desk, say }: { desk: Desk; say: (text: string) => void }) {
  if (desk.mode === "zero") return <SkillPicker desk={desk} />;
  return (
    <div className="flex flex-wrap gap-1.5">
      <Mini disabled={desk.status !== "blocked"} onClick={() => { say("你：一键修复"); desk.repair(); }}>一键修复</Mini>
      <Mini disabled={!desk.hasWork} onClick={() => desk.setHookOpen(!desk.hookOpen)}>{`爆款开头${desk.hook ? ` · ${desk.hook}` : ""}`}</Mini>
      <Mini disabled={!desk.hasWork} onClick={() => { desk.wash(); say("洗稿只改了对白说法，场景头和人名没动。"); }}>洗稿</Mini>
      <Mini disabled={!desk.hasWork} onClick={() => desk.setCastOpen(!desk.castOpen)}>换角色</Mini>
      <Mini disabled={!desk.hasWork} onClick={() => desk.setGenderOpen(!desk.genderOpen)}>改性格</Mini>
      <Mini onClick={() => { desk.imitate(); say("深挖仿写放在旁边，还没存成文件。"); }}>深挖仿写</Mini>
      {desk.projectType === "解说剧" && <Mini onClick={desk.promoteDrama}>收成精品剧</Mini>}
    </div>
  );
}

function Panels({ desk }: { desk: Desk }) {
  return (
    <div className="space-y-3">
      {desk.hookOpen && desk.hasWork && (
        <div className="flex flex-wrap gap-1.5">
          {HOOKS.map((id) => (
            <Mini key={id} onClick={() => desk.chooseHook(id as HookId)}>{id}</Mini>
          ))}
        </div>
      )}
      {desk.castOpen && (
        <div className="space-y-2 rounded-xl border border-white/10 p-3">
          <p className="text-xs text-muted-foreground">换角色。空着的名字保持原样，别称跟着主名。</p>
          {(Object.keys(desk.names) as Array<keyof typeof desk.names>).map((name) => (
            <label key={name} className="block text-xs text-muted-foreground">
              {name}
              <input value={desk.names[name]} placeholder="新名字，可空" onChange={(event) => desk.setNames({ ...desk.names, [name]: event.target.value })} className="mt-1 h-8 w-full rounded-[8px] border border-white/10 bg-transparent px-2 text-sm text-foreground" />
            </label>
          ))}
          <Mini onClick={desk.applyCast}>应用到工作稿</Mini>
        </div>
      )}
      {desk.genderOpen && (
        <div className="space-y-2 rounded-xl border border-white/10 p-3 text-sm">
          <p className="text-xs text-muted-foreground">改性格是整段性别对调。没勾的人不转。</p>
          {(Object.keys(desk.gender) as Array<keyof typeof desk.gender>).map((name) => (
            <label key={name} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={desk.gender[name]} onChange={(event) => desk.setGender({ ...desk.gender, [name]: event.target.checked })} />
              {name}{name === "林晚" ? " → 林晏" : " → 店主娘"}
            </label>
          ))}
          <Mini onClick={desk.applyGender}>确认对调</Mini>
        </div>
      )}
      {desk.imitation && (
        <div className="rounded-xl border border-white/10 p-3">
          <p className="text-xs text-muted-foreground">深挖仿写 · 另一篇 · {desk.imitationSaved ? "已存成新文件" : "尚未入库"}</p>
          <p className="mt-2 text-sm leading-6">{desk.imitation}</p>
          {!desk.imitationSaved && <button type="button" onClick={desk.saveImitation} className="mt-2 text-sm text-primary">存成新文件</button>}
        </div>
      )}
      {desk.pendingType && (
        <div className="rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm leading-6">
          改成{desk.pendingType}会按新类型重新导入。
          <span className="ml-2">
            <button type="button" onClick={desk.confirmType} className="text-primary">确认</button>
            <button type="button" onClick={desk.cancelType} className="ml-3 text-muted-foreground">取消</button>
          </span>
        </div>
      )}
      {desk.zeroStep === "draft" && (
        <div className="rounded-xl border border-white/10 p-3 text-sm">
          <p className="text-xs text-muted-foreground">{desk.brief.kind === "短剧" ? "人物卡 · 从下一集生效" : "已出场的人名"}</p>
          <p className="mt-1">{desk.brief.lead}{desk.brief.kind === "短剧" ? " · 回来问旧话的人 · 话少，手劲大" : ""}</p>
        </div>
      )}
      {desk.appendStop && <p className="text-xs leading-5 text-amber-200/90">{desk.appendStop}</p>}
      {desk.notice && <p className="text-xs leading-5 text-muted-foreground">{desk.notice}</p>}
    </div>
  );
}

function ScriptBlock({ desk }: { desk: Desk }) {
  const text = desk.showSource || !desk.hasWork ? SOURCE.paragraphs.join("\n\n") : desk.repairedLines().join("\n");
  const zero = desk.mode === "zero" && desk.zeroStep === "draft" ? desk.zeroLines().join("\n") : null;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{zero ? "新文件" : desk.showSource || !desk.hasWork ? "原文" : desk.projectType === "解说剧" && !desk.promoted ? "解说稿" : "场次工作稿"}</p>
        {desk.hasWork && desk.mode === "edit" && (
          <button type="button" onClick={() => desk.setShowSource(!desk.showSource)} className="text-xs text-primary">
            {desk.showSource ? "看工作稿" : "看原文"}
          </button>
        )}
      </div>
      <pre className="whitespace-pre-wrap font-sans text-sm leading-6">{zero ?? text}</pre>
    </div>
  );
}

function Tail({ model }: { model: Complete }) {
  const { desk } = model;
  return (
    <div className="space-y-3">
      {desk.mode === "zero" && desk.zeroStep === "brief" && (
        <form className="grid gap-2 sm:grid-cols-4" onSubmit={(event) => { event.preventDefault(); model.send(); }}>
          <select aria-label="体裁" value={desk.brief.kind} onChange={(event) => desk.setBrief({ ...desk.brief, kind: event.target.value as "短剧" | "小说" })} className="h-8 rounded-[8px] border border-white/10 bg-transparent px-2 text-sm">
            <option>短剧</option>
            <option>小说</option>
          </select>
          <input aria-label="题材" value={desk.brief.premise} onChange={(event) => desk.setBrief({ ...desk.brief, premise: event.target.value })} className="h-8 rounded-[8px] border border-white/10 bg-transparent px-2 text-sm sm:col-span-2" />
          <span className="flex gap-1">
            <input aria-label="主角" value={desk.brief.lead} onChange={(event) => desk.setBrief({ ...desk.brief, lead: event.target.value })} className="h-8 min-w-0 flex-1 rounded-[8px] border border-white/10 bg-transparent px-2 text-sm" />
            <input aria-label="篇幅" value={desk.brief.count} onChange={(event) => desk.setBrief({ ...desk.brief, count: event.target.value })} className="h-8 w-14 rounded-[8px] border border-white/10 bg-transparent px-2 text-sm" />
          </span>
        </form>
      )}
      <div className="flex flex-wrap gap-2">
        <Mini onClick={() => desk.setProjectType(desk.projectType === "精品剧" ? "解说剧" : "精品剧")}>{`项目：${desk.projectType}`}</Mini>
        {desk.status === "imported" && !desk.extra && <Mini onClick={desk.writeNext}>{`再写一${desk.mode === "zero" && desk.brief.kind === "小说" ? "章" : "集"}`}</Mini>}
        {desk.status === "imported" && desk.extra && <Mini onClick={desk.markDirty}>{desk.dirtyOld ? "旧正文已改过" : "改一处旧正文"}</Mini>}
        {desk.canAppend && <Mini onClick={desk.append}>{desk.mode === "zero" && desk.brief.kind === "小说" ? "追加新章" : "追加新集"}</Mini>}
      </div>
    </div>
  );
}

function Composer({ model }: { model: Complete }) {
  return (
    <form onSubmit={(event) => { event.preventDefault(); model.send(); }}>
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.022]">
        <div className="space-y-3 px-4 pt-3">
          <Actions desk={model.desk} say={model.say} />
          <Panels desk={model.desk} />
          <Tail model={model} />
        </div>
        <textarea value={model.draft} onChange={(event) => model.setDraft(event.target.value)} rows={2} placeholder={model.desk.mode === "zero" ? "短剧，雨夜茶馆，林晚，8集" : "让第一场的说法再短一点"} className="min-h-14 w-full resize-none bg-transparent px-5 py-3 text-sm leading-6 outline-none placeholder:text-muted-foreground/70" />
        <div className="flex justify-end px-3 py-2">
          <button type="submit" disabled={model.draft.trim().length === 0} aria-label="发送" className="flex size-8 items-center justify-center rounded-full bg-white text-black disabled:bg-white/30 disabled:text-black/45">
            <ArrowUp className="size-[18px]" />
          </button>
        </div>
      </div>
    </form>
  );
}

function Log({ model }: { model: Complete }) {
  return (
    <div className="space-y-3">
      {model.log.map((line) => (
        <p key={line} className="xialiao-rise whitespace-pre-wrap text-sm leading-6">{line}</p>
      ))}
      <ScriptBlock desk={model.desk} />
    </div>
  );
}

export function SplitView() {
  const model = useCompleteDesk();
  return (
    <IngestPageFrame
      desk={model.desk}
      aside={
        <div className="flex h-full min-h-0 flex-col">
          <header className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
            <p className="text-sm font-medium">虾导</p>
            <ModeSwitch desk={model.desk} />
          </header>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
            <Log model={model} />
          </div>
          <div className="shrink-0 px-4 pb-4">
            <Composer model={model} />
          </div>
        </div>
      }
    />
  );
}

export function TalkView() {
  const model = useCompleteDesk();
  return (
    <IngestPageFrame
      desk={model.desk}
      toolbar={<ModeSwitch desk={model.desk} />}
      below={
        <section className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
          <div className="border-b border-white/10 px-4 py-3">
            <p className="text-sm font-medium">虾导</p>
            <p className="text-xs text-muted-foreground">{model.desk.mode === "zero" ? "从零写，不读已上传的文件" : `正在看 ${SOURCE.file}`}</p>
          </div>
          <div className="max-h-[420px] overflow-y-auto px-4 py-4">
            <Log model={model} />
          </div>
          <div className="border-t border-white/10 px-4 py-3">
            <Composer model={model} />
          </div>
        </section>
      }
    />
  );
}

export function ScriptView() {
  const model = useCompleteDesk();
  return (
    <IngestPageFrame
      desk={model.desk}
      toolbar={<ModeSwitch desk={model.desk} />}
      below={
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">稿面</p>
            <ScriptBlock desk={model.desk} />
            <div className="mt-4"><Panels desk={model.desk} /></div>
          </section>
          <section className="flex min-h-[420px] flex-col overflow-hidden rounded-2xl border border-white/10">
            <div className="border-b border-white/10 px-4 py-3">
              <p className="text-sm font-medium">虾导</p>
              <p className="text-xs text-muted-foreground">对着上面这份虾料稿说话</p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4"><Log model={model} /></div>
            <div className="border-t border-white/10 px-3 py-3"><Composer model={model} /></div>
          </section>
        </div>
      }
    />
  );
}

export function SheetView() {
  const model = useCompleteDesk();
  return (
    <>
      <IngestPageFrame desk={model.desk} toolbar={<ModeSwitch desk={model.desk} />} below={<div className="h-[42vh]" />} />
      <section className="fixed inset-x-0 bottom-0 z-20 mx-auto flex h-[42vh] w-full max-w-[1080px] flex-col rounded-t-2xl border border-white/10 bg-background">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div>
            <p className="text-sm font-medium">虾导</p>
            <p className="text-xs text-muted-foreground">从虾料页底部拉开，上面的文件卡还在</p>
          </div>
          <ModeSwitch desk={model.desk} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3"><Log model={model} /></div>
        <div className="shrink-0 px-3 pb-3"><Composer model={model} /></div>
      </section>
    </>
  );
}

export function InlineView() {
  const model = useCompleteDesk();
  return (
    <IngestPageFrame
      desk={model.desk}
      toolbar={<ModeSwitch desk={model.desk} />}
      below={
        <div className="space-y-4 px-1">
          <p className="text-xs text-muted-foreground">虾导写在这一页里，不再另开一块对话窗。</p>
          <Log model={model} />
          <Composer model={model} />
        </div>
      }
    />
  );
}

export function StepsView() {
  const model = useCompleteDesk();
  const [step, setStep] = useState(0);
  const steps = ["上传", "改稿", "导入"];
  return (
    <IngestPageFrame
      desk={model.desk}
      toolbar={
        <div className="inline-flex h-8 items-center rounded-[8px] border border-white/10 p-1 text-xs">
          {steps.map((label, index) => (
            <button key={label} type="button" onClick={() => setStep(index)} className={`h-6 rounded-[6px] px-2.5 ${step === index ? "bg-foreground text-background" : "text-muted-foreground"}`}>
              {index + 1} {label}
            </button>
          ))}
        </div>
      }
      below={
        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          {step === 0 && (
            <div className="space-y-3">
              <p className="text-sm leading-6">文件在上面的虾料卡里。格式不过时，下一步才打开虾导。</p>
              <ModeSwitch desk={model.desk} />
              <button type="button" onClick={() => setStep(1)} className="h-8 rounded-[8px] bg-primary px-3 text-xs text-primary-foreground">去改稿</button>
            </div>
          )}
          {step === 1 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium">虾导</p>
                <ModeSwitch desk={model.desk} />
              </div>
              <Log model={model} />
              <Composer model={model} />
            </div>
          )}
          {step === 2 && (
            <div className="space-y-3">
              <p className="text-sm leading-6">看完工作稿，用上面的开始导入。要加长，先回到改稿再写下一集。</p>
              <ScriptBlock desk={model.desk} />
              <button type="button" onClick={() => setStep(1)} className="text-sm text-primary">回到改稿</button>
            </div>
          )}
        </section>
      }
    />
  );
}

export function GuideView() {
  const model = useCompleteDesk();
  const [more, setMore] = useState(false);
  return (
    <IngestPageFrame
      desk={model.desk}
      below={
        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <p className="text-lg font-semibold leading-7">这篇更像小说，系统还分不出每一场从哪里开始。</p>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">原文会留下。我可以先把它收成能导入的稿，你再决定要不要改开头、换人或另写一篇。</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" disabled={model.desk.status !== "blocked"} onClick={() => { model.say("你：先帮我收成能导入的稿"); model.desk.repair(); }} className="h-10 rounded-[10px] bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-40">
              {model.desk.status === "repairing" ? "正在收…" : "先帮我收成能导入的稿"}
            </button>
            <button type="button" onClick={() => model.desk.setMode("zero")} className="h-10 rounded-[10px] border border-white/10 px-4 text-sm">我要另写一篇</button>
          </div>
          <button type="button" onClick={() => setMore((open) => !open)} className="mt-4 text-sm text-muted-foreground">{more ? "收起其他改法" : "其他改法"}</button>
          {more && (
            <div className="mt-3 space-y-3">
              <ModeSwitch desk={model.desk} />
              <Composer model={model} />
            </div>
          )}
          {model.desk.hasWork && <div className="mt-4"><ScriptBlock desk={model.desk} /></div>}
        </section>
      }
    />
  );
}

export function CompareView() {
  const model = useCompleteDesk();
  return (
    <IngestPageFrame
      desk={model.desk}
      toolbar={<ModeSwitch desk={model.desk} />}
      below={
        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <p className="text-lg font-semibold">先看一句会变成什么样</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">左边是你上传的句子，右边是收成场次后的第一场。满意再让整篇跟着变。</p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-white/10 p-3">
              <p className="text-xs text-muted-foreground">现在</p>
              <p className="mt-2 text-sm leading-6">林晚推开巷口的木门时，雨水已经顺着发梢滴进衣领。「还是老位置。」她说。</p>
            </div>
            <div className="rounded-xl border border-primary/40 bg-primary/10 p-3">
              <p className="text-xs text-primary">收成后</p>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6">巷口木门 夜 内{"\n"}林晚：还是老位置。{"\n"}△ 雨水顺着发梢滴进衣领。</p>
            </div>
          </div>
          <div className="mt-4"><Composer model={model} /></div>
        </section>
      }
    />
  );
}

type AskMsg = { id: string; role: "agent" | "user"; text: string };
type AskStep = "path" | "kind" | "premise" | "lead" | "count" | "skills" | "chat";

export function AskView() {
  const desk = useDesk();
  const scroller = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<"edit" | "zero">("edit");
  const [editStep, setEditStep] = useState<AskStep>("path");
  const [zeroStep, setZeroStep] = useState<AskStep>("kind");
  const [draft, setDraft] = useState("");
  const [pinned, setPinned] = useState<string | null>(null);
  const [editMessages, setEditMessages] = useState<AskMsg[]>([
    { id: "edit-open", role: "agent", text: "你想先处理这篇，还是另写一篇？" },
  ]);
  const [zeroMessages, setZeroMessages] = useState<AskMsg[]>([
    { id: "zero-open", role: "agent", text: "这篇不读取已上传的文件。先选一种：小说，还是短剧？" },
  ]);
  const messages = active === "edit" ? editMessages : zeroMessages;
  const step = active === "edit" ? editStep : zeroStep;
  const setStep = active === "edit" ? setEditStep : setZeroStep;

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, step, active]);

  const push = (role: AskMsg["role"], text: string) => {
    const setMessages = active === "edit" ? setEditMessages : setZeroMessages;
    setMessages((items) => [...items, { id: `${active}-${items.length}-${role}`, role, text }]);
  };

  const openRecord = (id: "edit" | "zero") => {
    setActive(id);
    desk.setMode(id === "edit" ? "edit" : "zero");
  };

  const choosePath = (path: "fix" | "new") => {
    if (path === "fix") {
      desk.setMode("edit");
      push("user", "先处理这篇");
      push("agent", "好。原文留着。我可以把它收成能导入的稿，收完大纲会列在右边。");
      setEditStep("chat");
      return;
    }
    desk.setMode("zero");
    setActive("zero");
    setZeroMessages((items) =>
      items.some((item) => item.role === "user" && item.text === "另写一篇")
        ? items
        : [...items, { id: `zero-user-${items.length}`, role: "user", text: "另写一篇" }],
    );
  };

  const chooseKind = (kind: "小说" | "短剧") => {
    desk.setBrief({ ...desk.brief, kind });
    push("user", kind);
    push("agent", kind === "小说" ? "用一句话说说这篇小说讲什么。不用写完整开头。" : "用一句话说说这部短剧讲什么。不用写成分场。");
    setStep("premise");
  };

  const answerCount = (count: string) => {
    desk.setBrief({ ...desk.brief, count });
    push("user", desk.brief.kind === "小说" ? `${count} 章` : `${count} 集`);
    push("agent", "这章可以选几种写法，能多选，也可以先不选。选好后我就写第 1 章，大纲出现在右边。");
    setStep("skills");
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (step === "premise") {
      desk.setBrief({ ...desk.brief, premise: text });
      push("user", text);
      push("agent", "主角怎么称呼？一个名字就行。");
      setStep("lead");
      return;
    }
    if (step === "lead") {
      desk.setBrief({ ...desk.brief, lead: text });
      push("user", text);
      push("agent", desk.brief.kind === "小说" ? "大约写几章？选一个就行，之后还能改。" : "大约写几集？选一个就行，之后还能改。");
      setStep("count");
      return;
    }
    push("user", text);
    if (desk.mode === "edit" && /删章|加情节|分镜表/.test(text)) {
      push("agent", "这句改不了当前稿。可以改说法，不能删章、加情节，也不能出分镜。");
      return;
    }
    push("agent", desk.mode === "zero" ? "已写的章节留着。后面按你刚说的来。" : "改的是工作稿，原文件不动。");
  };

  const counts = desk.brief.kind === "小说" ? ["6", "12", "24"] : ["4", "8", "12"];

  const sent = messages.filter((message) => message.role === "user");
  const jumpTo = (id: string) => {
    const root = scroller.current;
    const target = root?.querySelector<HTMLElement>(`[data-msg="${id}"]`);
    if (!root || !target) return;
    root.scrollTo({ top: target.offsetTop - 8, behavior: "smooth" });
    setPinned(id);
  };

  return (
    <div className="ask-ui">
    <IngestPageFrame
      desk={desk}
      below={
        <div className={`grid items-start gap-4 ${desk.hasWork || (desk.mode === "zero" && desk.zeroStep === "draft") ? "lg:grid-cols-[minmax(0,1fr)_240px]" : ""}`}>
          <section className="flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
            <div className="border-b border-white/10 px-5 py-3">
              <p className="text-sm font-medium">虾导</p>
              <p className="text-xs text-muted-foreground">{active === "zero" ? "另写一篇" : "处理《夜雨归人》"}</p>
            </div>
            <div className="flex min-h-0">
            {sent.length > 0 && (
            <aside className="flex w-8 shrink-0 flex-col items-center gap-1 border-r border-white/10 py-2">
              {sent.map((message) => (
                <div key={message.id} className="group relative">
                  <button
                    type="button"
                    aria-label={message.text}
                    onClick={() => jumpTo(message.id)}
                    className="flex size-7 items-center justify-center"
                  >
                    <span className={`absolute bottom-1 left-0 top-1 w-0.5 ${pinned === message.id ? "bg-foreground" : "bg-transparent group-hover:bg-white/50"}`} />
                    <PencilLine className="size-3.5 text-muted-foreground" />
                  </button>
                  <div className="pointer-events-none absolute left-full top-1/2 z-20 ml-2 hidden w-max max-w-64 -translate-y-1/2 rounded-md bg-zinc-800 px-2.5 py-1.5 text-xs leading-5 text-zinc-100 shadow-lg group-hover:block group-focus-within:block">
                    {message.text}
                  </div>
                </div>
              ))}
            </aside>
            )}
            <div ref={scroller} className="relative max-h-72 min-w-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              {messages.map((message) =>
                message.role === "user" ? (
                  <div key={message.id} data-msg={message.id} className="xialiao-rise flex justify-end">
                    <div className={`max-w-[36rem] rounded-[14px] px-4 py-2.5 text-sm leading-6 ${pinned === message.id ? "bg-primary/20" : "bg-white/[0.07]"}`}>{message.text}</div>
                  </div>
                ) : (
                  <p key={message.id} className="xialiao-rise max-w-3xl text-sm leading-6">{message.text}</p>
                ),
              )}
            </div>
            </div>
            <div className="space-y-3 border-t border-white/10 px-4 py-3">
              {step === "path" && active === "edit" && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Choice onClick={() => choosePath("fix")} title="先处理这篇" detail="收成能导入的稿，原文留下。" />
                  <Choice onClick={() => choosePath("new")} title="另写一篇" detail="不读已上传的文件。" />
                </div>
              )}
              {active === "edit" && step !== "path" && (
                <button type="button" onClick={() => choosePath("new")} className="flex h-8 w-full items-center justify-between gap-3 rounded-full border border-white/15 px-3 text-left">
                  <span className="text-sm">改选另写一篇</span>
                  <span className="truncate text-xs text-muted-foreground">不读已上传的文件，刚才的对话还留着</span>
                </button>
              )}
              {active === "zero" && (
                <button type="button" onClick={() => openRecord("edit")} className="flex h-8 w-full items-center justify-between gap-3 rounded-full border border-white/15 px-3 text-left">
                  <span className="text-sm">回到处理这篇</span>
                  <span className="truncate text-xs text-muted-foreground">回到《夜雨归人》，另写的内容还留着</span>
                </button>
              )}
              {step === "kind" && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Choice onClick={() => chooseKind("小说")} title="小说" detail="分章叙述，按解说剧导入。" />
                  <Choice onClick={() => chooseKind("短剧")} title="短剧" detail="一场一场写，按精品剧导入。" />
                </div>
              )}
              {step === "count" && (
                <div className="flex flex-wrap gap-2">
                  {counts.map((count) => (
                    <button key={count} type="button" onClick={() => answerCount(count)} className="h-10 rounded-[10px] border border-white/10 px-4 text-sm">
                      {count} {desk.brief.kind === "小说" ? "章" : "集"}
                    </button>
                  ))}
                </div>
              )}
              {step === "skills" && (
                <button
                  type="button"
                  onClick={() => {
                    desk.writeFirst();
                    push("user", "就按这些写第 1 " + (desk.brief.kind === "小说" ? "章" : "集"));
                    push("agent", "写好了。大纲在右边，这篇是新文件，没有盖掉《夜雨归人》。");
                    setStep("chat");
                  }}
                  className="h-10 rounded-[10px] bg-primary px-4 text-sm font-medium text-primary-foreground"
                >
                  写第 1 {desk.brief.kind === "小说" ? "章" : "集"}
                </button>
              )}
              {step === "chat" && active === "edit" && (
                <div className="space-y-3">
                <p className="text-xs text-muted-foreground">改这篇</p>
                <OptionRow
                  items={[
                    { title: "一键修复", detail: "收成能导入的稿，原文不覆盖。", disabled: desk.status !== "blocked", onClick: () => { push("user", "一键修复"); desk.repair(); push("agent", "收好了。大纲在右边，原文还在。"); } },
                    { title: desk.hook ? `开头 · ${desk.hook}` : "爆款开头", detail: "只改第一场怎么开头，后面的场不动。", disabled: !desk.hasWork && desk.zeroStep !== "draft", onClick: () => desk.setHookOpen(!desk.hookOpen) },
                    { title: "洗稿", detail: "对白换一种说法，人名和场景头不动。", disabled: !desk.hasWork && desk.zeroStep !== "draft", onClick: () => { desk.wash(); push("user", "洗稿"); push("agent", "只改了对白说法。"); } },
                    { title: "换角色", detail: "先出对照表。空着的名字不换。", disabled: !desk.hasWork && desk.zeroStep !== "draft", onClick: () => desk.setCastOpen(!desk.castOpen) },
                    { title: "改性格", detail: "性别对调。先勾要转的人，没勾的不动。", disabled: !desk.hasWork && desk.zeroStep !== "draft", onClick: () => desk.setGenderOpen(!desk.genderOpen) },
                    { title: "深挖仿写", detail: "按这篇的写法另写一个故事，点存成新文件才入库。", onClick: () => { desk.imitate(); push("user", "深挖仿写"); push("agent", "仿写放在下面，还没存成文件。"); } },
                    ...(desk.projectType === "解说剧" ? [{ title: "收成精品剧", detail: "把叙述正文收成一场一场的剧本。", onClick: () => { desk.promoteDrama(); push("agent", "已收成精品剧场次稿。"); } }] : []),
                    { title: desk.projectType, detail: desk.projectType === "精品剧" ? "现在按精品剧，要有场景头。点一下改成解说剧。" : "现在按解说剧，保持叙述。点一下改成精品剧。", onClick: () => desk.setProjectType(desk.projectType === "精品剧" ? "解说剧" : "精品剧") },
                    ...(desk.status === "imported" && !desk.extra ? [{ title: `再写一${desk.brief.kind === "小说" ? "章" : "集"}`, detail: "加在同一份文件末尾，已经写好的不改。", onClick: desk.writeNext }] : []),
                    ...(desk.status === "imported" && desk.extra ? [{ title: desk.dirtyOld ? "旧正文已改过" : "改一处旧正文", detail: "改了已经导入的章节，追加会停住。", onClick: desk.markDirty }] : []),
                    ...(desk.canAppend ? [{ title: desk.brief.kind === "小说" ? "追加新章" : "追加新集", detail: "只把新写的送进项目，已经做好的集和视频不动。", onClick: desk.append }] : []),
                  ]}
                />
                </div>
              )}
              {active === "zero" && (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">写法，可多选</p>
                  <OptionRow items={skillItems(desk)} />
                </div>
              )}
              {(step === "chat" || (active === "zero" && desk.zeroStep === "draft")) && <Panels desk={desk} />}
              {(step === "chat" || step === "premise" || step === "lead") && (
                <form onSubmit={(event) => { event.preventDefault(); send(); }} className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.022]">
                  <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={2} placeholder={step === "premise" ? "例如：雨夜回到旧茶馆，把没问完的话问完" : step === "lead" ? "例如：林晚" : "接着说，或让某一句再短一点"} className="min-h-14 w-full resize-none bg-transparent px-4 py-3 text-sm leading-6 outline-none placeholder:text-muted-foreground/70" />
                  <div className="flex justify-end px-3 py-2">
                    <button type="submit" disabled={draft.trim().length === 0} aria-label="发送" className="flex size-8 items-center justify-center rounded-full bg-white text-black disabled:bg-white/30 disabled:text-black/45"><ArrowUp className="size-[18px]" /></button>
                  </div>
                </form>
              )}
            </div>
          </section>
          <OutlineCard desk={desk} />
        </div>
      }
    />
    </div>
  );
}

const SKILL_HELP: Record<string, string> = {
  默认通用: "开头同时用几种抓人结构，适合还没想好用哪一种。",
  剧情反转: "先给一个结果，马上翻过来。",
  勾人反差: "用前后不一样的地方把人勾住。",
  情绪牵引: "先把情绪铺开，再进入故事。",
  爆点澎湃: "开头就上最猛的冲突。",
  设定结构: "先讲清这个世界的规则，再写人。",
  穿越重生: "用穿越或重生带来的身份差来写。",
  深挖仿写: "学这篇的写法，但写成另一个故事。",
  洗稿: "意思不变，换成另一种说法。",
  改性格: "把选中的人做性别对调。",
  换角色: "只换人名，情节不动。",
};

function skillItems(desk: Desk) {
  return Object.entries(SKILL_HELP).map(([name, detail]) => {
    const skill = name as (typeof desk.skills)[number];
    return {
      title: name,
      detail,
      active: desk.skills.includes(skill),
      onClick: () => desk.toggleSkill(skill),
    };
  });
}

function OptionRow({ items }: { items: Array<{ title: string; detail: string; onClick: () => void; disabled?: boolean; active?: boolean }> }) {
  const [hint, setHint] = useState(items.find((item) => item.active)?.detail ?? items[0]?.detail ?? "");
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <button
            key={item.title}
            type="button"
            disabled={item.disabled}
            onMouseEnter={() => setHint(item.detail)}
            onFocus={() => setHint(item.detail)}
            onClick={item.onClick}
            className={`h-8 rounded-full border px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-40 ${item.active ? "border-primary bg-primary/15 text-primary" : "border-white/10 text-foreground"}`}
          >
            {item.title}
          </button>
        ))}
      </div>
      <p className="mt-2 min-h-5 text-xs leading-5 text-muted-foreground">{hint}</p>
    </div>
  );
}

function Choice({ title, detail, onClick }: { title: string; detail: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded-xl border border-white/10 px-4 py-3 text-left transition-colors hover:border-white/20 hover:bg-white/[0.04]">
      <span className="block text-sm font-medium">{title}</span>
      <span className="mt-1 block text-xs leading-5 text-muted-foreground">{detail}</span>
    </button>
  );
}

function OutlineCard({ desk }: { desk: Desk }) {
  const fresh = desk.mode === "zero" && desk.zeroStep === "draft";
  const narrated = desk.projectType === "解说剧" && !desk.promoted;
  const items = fresh
    ? [{ title: `第1${desk.brief.kind === "小说" ? "章" : "集"}`, note: desk.brief.premise }, ...(desk.extra ? [{ title: `第2${desk.brief.kind === "小说" ? "章" : "集"}`, note: "续写" }] : [])]
    : desk.hasWork
      ? narrated
        ? [{ title: "第1章 雨夜", note: "叙述正文" }, ...(desk.extra ? [{ title: "第2章", note: "续写" }] : [])]
        : [{ title: "第1集 · 巷口木门 夜 内", note: "第一场" }, { title: "第1集 · 巷口 夜 外", note: "第二场" }, ...(desk.extra ? [{ title: "第2集", note: "续写" }] : [])]
      : [];
  if (items.length === 0) return null;
  return (
    <aside className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <p className="text-sm font-medium">大纲</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">只列章节，正文还在对话里。</p>
      <ol className="mt-4 space-y-3">
        {items.map((item, index) => (
          <li key={item.title} className="flex gap-3">
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-white/[0.07] text-xs tabular-nums">{index + 1}</span>
            <span>
              <span className="block text-sm">{item.title}</span>
              <span className="block text-xs leading-5 text-muted-foreground">{item.note}</span>
            </span>
          </li>
        ))}
      </ol>
    </aside>
  );
}

function Mini({ children, onClick, disabled }: { children: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className="h-7 rounded-[6px] bg-white/[0.07] px-2.5 text-xs disabled:opacity-40">
      {children}
    </button>
  );
}
