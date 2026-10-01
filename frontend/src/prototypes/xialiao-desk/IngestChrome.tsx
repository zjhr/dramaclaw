// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

import { useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, FileText, FishSymbol, Info, Play, X } from "lucide-react";
import { SKILL_GROUPS, SOURCE, type Desk } from "./desk";

export function IngestPageFrame({
  desk,
  warning,
  toolbar,
  below,
  aside,
  records,
}: {
  desk: Desk;
  warning?: ReactNode;
  toolbar?: ReactNode;
  below?: ReactNode;
  aside?: ReactNode;
  records?: ReactNode;
}) {
  const blocked = desk.status === "blocked" || desk.status === "repairing";
  const busy = desk.status === "importing";
  const done = desk.status === "imported";
  const canStart = desk.canImport && !busy && !done;
  const showWork = desk.hasWork;
  const [inputMode, setInputMode] = useState<"upload" | "paste">("upload");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fileRemoved, setFileRemoved] = useState(false);
  const [specOpen, setSpecOpen] = useState(false);

  return (
    <div className="dark flex h-dvh flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b border-border/30 bg-background px-9 py-5">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <FishSymbol className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight">虾料</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">上传剧本，开启你的创意之旅</p>
        </div>
        {records}
      </header>
      <div className={`flex min-h-0 flex-1 ${aside ? "" : "overflow-y-auto"}`}>
        <div className={`min-w-0 flex-1 px-6 pb-24 pt-10 ${aside ? "overflow-y-auto" : ""}`}>
        <div className={`mx-auto w-full space-y-6 ${aside ? "max-w-3xl" : "max-w-[1080px]"}`}>
          <section className="rounded-2xl bg-white/[0.05] p-4">
            <div className="flex h-[188px] items-center justify-center">
              {inputMode === "upload" && fileRemoved ? (
                <button type="button" onClick={() => setFileRemoved(false)} className="rounded-lg border border-dashed border-white/15 px-6 py-8 text-sm text-muted-foreground">
                  文件已移除。点这里放回《夜雨归人》
                </button>
              ) : inputMode === "upload" ? (
                <div className="relative w-full max-w-[320px] rounded-lg bg-sky-500/20 px-5 py-4 pr-12 text-left">
                  <button
                    type="button"
                    aria-label="移除文件"
                    onClick={() => setFileRemoved(true)}
                    className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full border border-white/10 bg-black/25 text-foreground/70 transition-colors hover:bg-black/40 hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                  <p className="truncate text-sm font-medium">夜雨归人</p>
                  <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
                    <FileText className="size-4 text-sky-400" />
                    <span>TXT</span>
                    <span className="text-foreground/30">·</span>
                    <span>2.4 KB</span>
                  </div>
                </div>
              ) : (
                <textarea
                  aria-label="粘贴文本"
                  defaultValue={SOURCE.paragraphs.join("\n\n")}
                  className="h-[156px] w-full resize-none rounded-lg border border-white/10 bg-transparent px-3 py-2 text-sm leading-6 outline-none focus:border-white/20"
                />
              )}
            </div>
            <div className="mt-1.5 min-h-4 px-1 text-xs leading-4 text-muted-foreground">
              {warning ??
                (blocked ? (
                  <div className="space-y-2">
                    <span className="flex items-start gap-1.5">
                      <AlertTriangle className="mt-px size-3.5 shrink-0 text-destructive" />
                      <span>没有识别到场景头，系统无法判断每个场景从哪里开始。</span>
                      <button type="button" onClick={() => setDetailsOpen((open) => !open)} className="shrink-0 text-foreground/80 underline-offset-2 hover:underline">
                        {detailsOpen ? "收起" : "详情"}
                      </button>
                    </span>
                    {detailsOpen && (
                      <div className="xialiao-rise grid grid-cols-3 gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2">
                        <Stat label="场景头" value="没有" />
                        <Stat label="章节" value="1 章" />
                        <Stat label="正文" value="更像小说" />
                      </div>
                    )}
                  </div>
                ) : (
                  <span className="flex items-center gap-1.5 text-foreground/80">
                    <CheckCircle2 className="size-3.5 text-primary" />
                    <span>{desk.notice ?? "工作稿已有场景头。原文件夜雨归人.txt 仍在。"}</span>
                  </span>
                ))}
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-3 px-1">
              <div className="inline-flex h-8 items-center rounded-[8px] border border-white/10 p-1 text-xs">
                <ToggleChip active={inputMode === "upload"} onClick={() => setInputMode("upload")}>上传文件</ToggleChip>
                <ToggleChip active={inputMode === "paste"} onClick={() => setInputMode("paste")}>粘贴文本</ToggleChip>
              </div>
              <FakeSelect options={["精品剧", "解说剧"]} />
              <FakeSelect options={["电影感", "动漫", "写实"]} />
              <FakeSelect options={["东亚", "欧美", "不指定"]} />
              <button type="button" onClick={() => setSpecOpen((open) => !open)} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
                <Info className="size-3.5" />
                <span className="underline-offset-4 hover:underline">{specOpen ? "收起格式规范" : "精品剧格式规范"}</span>
              </button>
              {specOpen && (
                <p className="basis-full text-xs leading-5 text-muted-foreground">
                  每一场写成「地点 日/夜 内或外」，下一行写「角色：台词」。没有这些，精品剧无法分场。
                </p>
              )}
              {toolbar}
              <div className="ml-auto flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setSaved(true)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-white/10 px-3 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  <CheckCircle2 className={`size-3.5 ${saved ? "text-primary" : ""}`} />
                  {saved ? "已保存" : "保存设置"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (desk.canAppend) desk.append();
                    else desk.startImport();
                  }}
                  disabled={!canStart && !desk.canAppend}
                  className="h-8 min-w-[148px] rounded-[8px] bg-primary px-3 text-xs text-primary-foreground transition-colors hover:bg-primary/85 active:bg-primary/75 disabled:opacity-40"
                >
                  <span className="grid w-full grid-cols-[12px_64px_auto] items-center gap-1.5">
                    <Play className="size-3 fill-current" />
                    <span className="text-center">{busy ? "处理中" : done ? "已导入" : desk.canAppend ? "追加新集" : "开始导入"}</span>
                    <span className="text-right text-primary-foreground/70">12</span>
                  </span>
                </button>
              </div>
            </div>
          </section>
          {showWork && <WorkPreview desk={desk} />}
          {below}
        </div>
        </div>
        {aside ? (
          <aside className="flex min-h-0 w-[min(640px,48vw)] shrink-0 flex-col border-l border-border/70 bg-background">
            {aside}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm text-foreground">{value}</p>
    </div>
  );
}

function ToggleChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-6 rounded-[6px] px-2.5 ${active ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
    >
      {children}
    </button>
  );
}

function WorkPreview({ desk }: { desk: Desk }) {
  const lines = desk.repairedLines().filter((line) => line.trim().length > 0);
  return (
    <section className="xialiao-rise overflow-hidden rounded-lg border border-white/[0.08]">
      <div className="flex items-center justify-between border-b border-white/[0.05] px-4 py-2.5">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">小说结构预览</p>
        <p className="text-xs text-muted-foreground">2 场 · 工作稿</p>
      </div>
      <div className="grid grid-cols-[4rem_1fr_4.5rem] border-b border-white/[0.05] px-4 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <span>序号</span>
        <span>标题</span>
        <span className="text-right">字数</span>
      </div>
      {["巷口木门 夜 内", "巷口 夜 外"].map((title, index) => (
        <div key={title} className="grid grid-cols-[4rem_1fr_4.5rem] px-4 py-2.5 text-sm">
          <span className="tabular-nums text-muted-foreground">{index + 1}</span>
          <span>{title}</span>
          <span className="text-right tabular-nums text-muted-foreground">{index === 0 ? "146" : "40"}</span>
        </div>
      ))}
      <pre className="whitespace-pre-wrap border-t border-white/[0.05] px-4 py-3 font-sans text-sm leading-6 text-foreground/90">
        {lines.slice(0, 12).join("\n")}
      </pre>
    </section>
  );
}

export function SkillPicker({ desk }: { desk: Desk }) {
  return (
    <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <p className="text-xs text-muted-foreground">参考技能，可多选。写出来的仍是章节或场次稿。</p>
      {SKILL_GROUPS.map((group) => (
        <div key={group.label} className="flex flex-wrap items-center gap-1.5">
          <span className="w-8 text-xs text-muted-foreground">{group.label}</span>
          {group.items.map((name) => {
            const on = desk.skills.includes(name);
            return (
              <button
                key={name}
                type="button"
                aria-pressed={on}
                onClick={() => desk.toggleSkill(name)}
                className={`h-6 rounded-[6px] px-2 text-xs transition-colors ${on ? "bg-foreground text-background" : "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"}`}
              >
                {name}
              </button>
            );
          })}
        </div>
      ))}
      <p className="text-xs leading-5 text-muted-foreground">{desk.skillNote}</p>
    </div>
  );
}

export function ZeroFields({ desk }: { desk: Desk }) {
  if (desk.zeroStep === "draft") {
    return (
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">新文件，不覆盖 {SOURCE.file}</p>
        <pre className="xialiao-rise whitespace-pre-wrap font-sans text-sm leading-6">{desk.zeroLines().join("\n")}</pre>
        <SkillPicker desk={desk} />
      </div>
    );
  }
  return (
    <form
      className="xialiao-rise space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        desk.writeFirst();
      }}
    >
      <p className="text-sm text-muted-foreground">从零写不读取 {SOURCE.file}。先补齐四项，再选这一章要用的技能。</p>
      <div className="grid gap-2 sm:grid-cols-4">
        <label className="text-xs text-muted-foreground">
          体裁
          <select
            aria-label="体裁"
            value={desk.brief.kind}
            onChange={(event) => desk.setBrief({ ...desk.brief, kind: event.target.value as "短剧" | "小说" })}
            className="mt-1 h-8 w-full rounded-[8px] border border-white/10 bg-transparent px-2 text-sm text-foreground"
          >
            <option>短剧</option>
            <option>小说</option>
          </select>
        </label>
        <label className="text-xs text-muted-foreground sm:col-span-2">
          题材
          <input
            aria-label="题材"
            value={desk.brief.premise}
            onChange={(event) => desk.setBrief({ ...desk.brief, premise: event.target.value })}
            className="mt-1 h-8 w-full rounded-[8px] border border-white/10 bg-transparent px-2 text-sm text-foreground"
          />
        </label>
        <label className="text-xs text-muted-foreground">
          主角 / 篇幅
          <span className="mt-1 flex gap-1">
            <input
              aria-label="主角"
              value={desk.brief.lead}
              onChange={(event) => desk.setBrief({ ...desk.brief, lead: event.target.value })}
              className="h-8 min-w-0 flex-1 rounded-[8px] border border-white/10 bg-transparent px-2 text-sm text-foreground"
            />
            <input
              aria-label="篇幅"
              value={desk.brief.count}
              onChange={(event) => desk.setBrief({ ...desk.brief, count: event.target.value })}
              className="h-8 w-14 rounded-[8px] border border-white/10 bg-transparent px-2 text-sm text-foreground"
            />
          </span>
        </label>
      </div>
      <SkillPicker desk={desk} />
      <button type="submit" className="h-8 rounded-[8px] bg-primary px-3 text-xs text-primary-foreground">
        写第 1 {desk.brief.kind === "小说" ? "章" : "集"}
      </button>
    </form>
  );
}

function FakeSelect({ options }: { options: string[] }) {
  const [value, setValue] = useState(options[0]);
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-white/10 px-3 text-xs transition-colors hover:border-white/20"
      >
        {value}
        <ChevronDown className="size-3 text-muted-foreground" />
      </button>
      {open && (
        <div className="ask-pop absolute left-0 top-9 z-10 min-w-full rounded-[8px] border border-white/10 bg-popover p-1 shadow-lg">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                setValue(option);
                setOpen(false);
              }}
              className={`block w-full rounded-[6px] px-2 py-1.5 text-left text-xs hover:bg-white/[0.06] ${option === value ? "text-foreground" : "text-muted-foreground"}`}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
