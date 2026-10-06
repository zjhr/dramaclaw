// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, PencilIcon, Plus, RotateCcw, Trash2, X } from "lucide-react";

import type {
  SkillSuggestionsResult,
  WriteKind,
  WritingSkill,
  WritingSkillLibrary,
  WritingSkillSave,
  WritingSkillSaveResult,
} from "@/lib/queries/ingest";

/**
 * 写法库在页面里的全部入口。开问、换一批、编辑、新增、删除、恢复默认都走这里，
 * 面板本身不直接碰接口。
 */
export interface WritingSkillBridge {
  load: () => Promise<WritingSkillLibrary>;
  save: (params: WritingSkillSave) => Promise<WritingSkillSaveResult>;
  remove: (id: string) => Promise<unknown>;
  restore: (id: string) => Promise<{ skill: WritingSkill }>;
  reshuffle: (params: {
    id: string;
    question: string;
    avoid: string[];
    kind: WriteKind | "";
    context: string;
  }) => Promise<SkillSuggestionsResult>;
}

type Translate = (key: string, opts?: { defaultValue?: string }) => string;

/** 内置写法的名称与说明走 i18n（id 就是词条键），新增的用用户自己写的字。 */
export function skillName(skill: WritingSkill, t: Translate): string {
  if (!skill.builtin) return skill.name;
  return t(`ingest.askFirst.skills.${skill.id}.title`, { defaultValue: skill.name });
}

export function skillDetail(skill: WritingSkill, t: Translate): string {
  if (!skill.builtin) return skill.description;
  return t(`ingest.askFirst.skills.${skill.id}.detail`, { defaultValue: skill.description });
}

export type SkillPickerApi = {
  skills: WritingSkill[];
  picked: string[];
  toggle: (id: string) => void;
  remove: (id: string) => void;
  edit: (id: string, patch: Partial<WritingSkill>) => void;
  add: (skill: WritingSkill) => void;
  pickedSkills: WritingSkill[];
};

/**
 * 幕布式技能选择器：屏上只留一行——已选的几条加一个入口。
 * 整份技能库、搜索、编辑都在浮层里，需要的时候才打开。
 */
export function WritingSkillQuietPicker({
  api,
  bridge,
  kind,
  onAsk,
}: {
  api: SkillPickerApi;
  bridge: WritingSkillBridge;
  kind: WriteKind | "";
  onAsk: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [autoAdd, setAutoAdd] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t("ingest.askFirst.skillPickerLabel", { count: api.picked.length })}
          <span className="text-muted-foreground/60">
            {t("ingest.askFirst.skillPickerTotal", { total: api.skills.length })}
          </span>
        </p>
        <button
          type="button"
          onClick={onAsk}
          className="h-8 rounded-full bg-primary px-4 text-sm text-primary-foreground"
        >
          {t("ingest.askFirst.startAsking")}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {api.pickedSkills.map((skill) => (
          <span
            key={skill.id}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-primary bg-primary/15 pl-3 pr-1.5 text-sm text-primary"
          >
            {skillName(skill, t)}
            <button
              type="button"
              aria-label={t("ingest.askFirst.skillDrop", { name: skillName(skill, t) })}
              onClick={() => api.toggle(skill.id)}
              className="flex size-5 items-center justify-center rounded-full hover:bg-primary/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        {api.picked.length === 0 && (
          <span className="text-xs text-muted-foreground">
            {t("ingest.askFirst.skillNonePicked")}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => {
            setAutoAdd(false);
            setOpen(true);
          }}
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/15 px-3 text-sm hover:border-white/25"
        >
          {t("ingest.askFirst.skillOpenSheet")}
          <span className="text-xs text-muted-foreground">
            {t("ingest.askFirst.skillOpenSheetHint", { total: api.skills.length })}
          </span>
        </button>
        <button
          type="button"
          onClick={() => {
            setAutoAdd(true);
            setOpen(true);
          }}
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/15 px-3 text-sm hover:border-white/25"
        >
          <Plus className="size-3.5" />
          {t("ingest.askFirst.skillAdd")}
        </button>
      </div>

      {open && (
        <SkillSheet
          api={api}
          bridge={bridge}
          kind={kind}
          autoAdd={autoAdd}
          onClose={() => {
            setOpen(false);
            setAutoAdd(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * 技能库浮层。挑选、搜索、编辑、新增、删除、恢复默认全在这里发生——
 * 选择页本身不留地方给管理动作。
 */
function SkillSheet({
  api,
  bridge,
  kind,
  autoAdd,
  onClose,
}: {
  api: SkillPickerApi;
  bridge: WritingSkillBridge;
  kind: WriteKind | "";
  /** 从「＋ 新增一条」进来时直接摊开新建表单。 */
  autoAdd: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  // 一份草稿、一个入口：id 为空就是新建，摆在列表顶上；有 id 就摊在它自己那一行下面。
  const [editing, setEditing] = useState<Draft | null>(autoAdd ? emptyDraft() : null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  // 按屏幕上显示的字过滤：内置写法的 name 是 id、description 是空的，搜中文只能搜到 i18n 词条。
  const keyword = query.trim();
  const hits = api.skills.filter(
    (skill) =>
      !keyword ||
      skillName(skill, t).includes(keyword) ||
      skillDetail(skill, t).includes(keyword),
  );

  const run = async (task: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : t("ingest.askFirst.skillActionFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  const reshuffle = (current: Draft) =>
    run(async () => {
      const result = await bridge.reshuffle({
        id: current.id ?? "",
        question: current.question,
        avoid: current.suggestions.filter(Boolean),
        kind,
        context: "",
      });
      setEditing({
        ...current,
        question: result.question || current.question,
        suggestions: [...result.suggestions, "", "", ""].slice(0, 3),
      });
    });

  const save = (current: Draft, regenerate: boolean) =>
    run(async () => {
      const saved = await bridge.save({
        ...(current.id ? { id: current.id } : {}),
        // 内置写法的名称与说明是 i18n 词条，没动过就别写回去锁死一种语言。
        name: current.nameDirty ? current.name : "",
        description: current.descriptionDirty ? current.description : "",
        prompt: current.prompt,
        question: current.question,
        suggestions: current.suggestions.filter(Boolean),
        regenerate,
        kind,
        context: "",
      });
      api.add(saved.skill);
      if (!api.picked.includes(saved.skill.id)) api.toggle(saved.skill.id);
      setEditing(null);
      setNotice(
        saved.regenerated
          ? t("ingest.askFirst.skillGenerated")
          : t("ingest.askFirst.skillSaved"),
      );
    });

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/56 px-4 pt-[12vh] backdrop-blur-sm motion-safe:animate-[proto-fade-in_var(--duration-base)_var(--ease-out-quint)]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={t("ingest.askFirst.skillSheetTitle")}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-[560px] overflow-hidden rounded-2xl border border-white/10 bg-[#111315] shadow-[0_24px_64px_rgba(0,0,0,0.5)] motion-safe:animate-[proto-sheet-in_var(--duration-base)_var(--ease-out-quint)]"
      >
        <div className="border-b border-white/10 p-3">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("ingest.askFirst.skillSearch")}
            className="h-9 w-full rounded-lg border border-white/10 bg-black/30 px-3 text-sm outline-none placeholder:text-muted-foreground/60 focus-visible:border-primary"
          />
        </div>

        <div className="max-h-[min(52vh,460px)] space-y-1 overflow-y-auto p-2">
          {editing && !editing.id && (
            <EditorBlock
              draft={editing}
              busy={busy}
              onChange={setEditing}
              onCollapse={() => setEditing(null)}
              onSave={() => void save(editing, promptChanged(editing))}
              onReshuffle={() => void reshuffle(editing)}
            />
          )}

          {hits.map((skill) => {
            const on = api.picked.includes(skill.id);
            const open = editing?.id === skill.id;
            return (
              <div key={skill.id} className="rounded-lg">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => api.toggle(skill.id)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-white/[0.04]"
                  >
                    <span
                      className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                        on ? "border-primary bg-primary text-primary-foreground" : "border-white/25"
                      }`}
                    >
                      {on && <Check className="size-3" />}
                    </span>
                    <span className="shrink-0 text-sm">{skillName(skill, t)}</span>
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {skillDetail(skill, t)}
                    </span>
                  </button>
                  <SkillPencil
                    label={t("ingest.askFirst.skillEditNamed", { name: skillName(skill, t) })}
                    onClick={() => setEditing(open ? null : toDraft(skill, t))}
                  />
                </div>
                {open && editing && (
                  <div className="px-2 pb-2 motion-safe:animate-[proto-row-in_var(--duration-fast)_var(--ease-out-quint)]">
                    <EditorBlock
                      draft={editing}
                      busy={busy}
                      onChange={setEditing}
                      onCollapse={() => setEditing(null)}
                      onSave={() => void save(editing, promptChanged(editing))}
                      onReshuffle={() => void reshuffle(editing)}
                    >
                      {skill.builtin ? (
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={t("ingest.askFirst.skillRestore")}
                          title={t("ingest.askFirst.skillRestore")}
                          onClick={() =>
                            void run(async () => {
                              const back = await bridge.restore(skill.id);
                              api.edit(skill.id, back.skill);
                              setEditing(null);
                              setNotice(t("ingest.askFirst.skillRestored"));
                            })
                          }
                          className="flex size-8 items-center justify-center rounded-full border border-white/10 text-muted-foreground hover:border-white/25 hover:text-foreground disabled:opacity-40"
                        >
                          <RotateCcw className="size-3.5" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={t("ingest.askFirst.skillDelete")}
                          title={t("ingest.askFirst.skillDelete")}
                          onClick={() =>
                            void run(async () => {
                              await bridge.remove(skill.id);
                              api.remove(skill.id);
                              setEditing(null);
                              setNotice(t("ingest.askFirst.skillDeleted"));
                            })
                          }
                          className="flex size-8 items-center justify-center rounded-full border border-white/10 text-muted-foreground hover:border-white/25 hover:text-foreground disabled:opacity-40"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </EditorBlock>
                  </div>
                )}
              </div>
            );
          })}

          {hits.length === 0 && !editing && (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              {t("ingest.askFirst.skillNoMatch")}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-white/10 p-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setNotice("");
              setError("");
              setEditing(emptyDraft());
            }}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/15 px-3 text-sm hover:border-white/25 disabled:opacity-40"
          >
            <Plus className="size-3.5" />
            {t("ingest.askFirst.skillAdd")}
          </button>
          <span className="min-w-0 flex-1 truncate text-center text-xs text-muted-foreground">
            {error ? (
              <span className="text-red-300">{error}</span>
            ) : notice ? (
              <span className="text-primary">{notice}</span>
            ) : (
              t("ingest.askFirst.sheetSelected", { count: api.picked.length })
            )}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-full bg-primary px-4 text-sm text-primary-foreground"
          >
            {t("ingest.askFirst.sheetConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 草稿 ────────────────────────────────────────────────────────────────────

type Draft = {
  id?: string;
  /** 名称与说明只有用户真的动过才回写。 */
  nameDirty: boolean;
  descriptionDirty: boolean;
  name: string;
  description: string;
  prompt: string;
  question: string;
  suggestions: string[];
  originalPrompt: string;
};

function toDraft(skill: WritingSkill, t: Translate): Draft {
  return {
    id: skill.id,
    nameDirty: false,
    descriptionDirty: false,
    name: skillName(skill, t),
    description: skillDetail(skill, t),
    prompt: skill.prompt,
    question: skill.question,
    suggestions: skill.suggestions.length > 0 ? [...skill.suggestions] : ["", "", ""],
    originalPrompt: skill.prompt,
  };
}

function emptyDraft(): Draft {
  return {
    nameDirty: true,
    descriptionDirty: true,
    name: "",
    description: "",
    prompt: "",
    question: "",
    suggestions: ["", "", ""],
    originalPrompt: "",
  };
}

function promptChanged(draft: Draft): boolean {
  return draft.prompt.trim() !== draft.originalPrompt.trim();
}

function EditorBlock({
  draft,
  busy,
  onChange,
  onCollapse,
  onSave,
  onReshuffle,
  children,
}: {
  draft: Draft;
  busy: boolean;
  onChange: (draft: Draft) => void;
  onCollapse: () => void;
  onSave: () => void;
  onReshuffle: () => void;
  /** 行内编辑才有的动作：恢复默认、删除。 */
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  // 提示词变了，保存会重写这一问和三句灵感：先问一句，别把人改过的字默默冲掉。
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="rounded-lg border border-primary/50 bg-primary/[0.05] p-2">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {draft.id ? t("ingest.askFirst.skillEditTitle") : t("ingest.askFirst.skillAddTitle")}
        </p>
        <button
          type="button"
          aria-label={t("ingest.askFirst.skillCollapse")}
          onClick={onCollapse}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <DraftFields draft={draft} onChange={onChange} />
      {draft.id && promptChanged(draft) && (
        <p className="mt-2 text-xs leading-5 text-amber-300/90">
          {t("ingest.askFirst.skillPromptChangedHint")}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {confirming ? (
          <>
            <span className="text-xs text-muted-foreground">
              {t("ingest.askFirst.skillRegenerateConfirm")}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={onSave}
              className="h-8 rounded-full bg-primary px-3 text-sm text-primary-foreground disabled:opacity-40"
            >
              {t("ingest.askFirst.skillRegenerate")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
              className="h-8 rounded-full border border-white/10 px-3 text-sm text-muted-foreground hover:border-white/25 hover:text-foreground"
            >
              {t("common.cancel")}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              // 新建没有「旧字」可覆盖，只有改已有技能才需要先问一句。
              onClick={() =>
                draft.id && promptChanged(draft) ? setConfirming(true) : onSave()
              }
              className="h-8 rounded-full bg-primary px-3 text-sm text-primary-foreground disabled:opacity-40"
            >
              {busy && (
                <Loader2 className="mr-1.5 size-3.5 animate-spin motion-reduce:animate-none" />
              )}
              {t("ingest.askFirst.skillSave")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onReshuffle}
              className="h-8 rounded-full border border-white/10 px-3 text-sm text-muted-foreground hover:border-white/25 hover:text-foreground disabled:opacity-40"
            >
              {t("ingest.askFirst.skillReshuffle")}
            </button>
            {children}
          </>
        )}
      </div>
    </div>
  );
}

const inputClass =
  "h-8 w-full rounded-lg border border-white/10 bg-black/25 px-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:border-primary";

function DraftFields({
  draft,
  onChange,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="block space-y-1 text-xs text-muted-foreground">
        <span>{t("ingest.askFirst.skillName")}</span>
        <input
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value, nameDirty: true })}
          className={inputClass}
        />
      </label>
      <label className="block space-y-1 text-xs text-muted-foreground">
        <span>{t("ingest.askFirst.skillDescription")}</span>
        <input
          value={draft.description}
          onChange={(event) =>
            onChange({ ...draft, description: event.target.value, descriptionDirty: true })
          }
          className={inputClass}
        />
      </label>
      <label className="block space-y-1 text-xs text-muted-foreground sm:col-span-2">
        <span>{t("ingest.askFirst.skillPrompt")}</span>
        <textarea
          value={draft.prompt}
          onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
          rows={3}
          className={`${inputClass} h-auto py-2 leading-6`}
        />
      </label>
      <label className="block space-y-1 text-xs text-muted-foreground sm:col-span-2">
        <span>{t("ingest.askFirst.skillQuestion")}</span>
        <input
          value={draft.question}
          onChange={(event) => onChange({ ...draft, question: event.target.value })}
          className={inputClass}
        />
      </label>
      {draft.suggestions.slice(0, 3).map((line, index) => (
        <input
          key={index}
          value={line}
          placeholder={t("ingest.askFirst.skillSuggestionSlot", { index: index + 1 })}
          onChange={(event) =>
            onChange({
              ...draft,
              suggestions: draft.suggestions.map((item, i) =>
                i === index ? event.target.value : item,
              ),
            })
          }
          className={`${inputClass} sm:col-span-2`}
        />
      ))}
    </div>
  );
}

function SkillPencil({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-white/10 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <PencilIcon className="size-3.5" />
    </button>
  );
}