// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp, Download, Loader2, PencilLine, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { downloadUrlAsFile } from "@/lib/browserDownload";
import { p } from "@/lib/api-path";
import {
  type ManuscriptActionRequest,
  type ManuscriptActionResult,
  type ManuscriptCharacterMapping,
  type UploadResult,
  type WriteFirstRequest,
  type WritingSkill,
  type WritingSkillBrief,
} from "@/lib/queries/ingest";
import {
  WritingSkillQuietPicker,
  skillName,
  type WritingSkillBridge,
} from "@/features/ingest/writing-skill-library";
import type { SpineTemplate } from "@/types/project";

type Role = "agent" | "user";
type Step = "path" | "kind" | "premise" | "lead" | "count" | "skills" | "chat";
type ThreadId = "edit" | "zero";
type Kind = "novel" | "drama" | "ad";
/** 另写一篇的五个台阶：选体裁 → 多选写法 → 一次问一题 → 复述 → 开写。 */
type ZeroStep = "kind" | "skills" | "ask" | "recap" | "chat";
type Msg = {
  id: string;
  role: Role;
  text?: string;
  key?: string;
  vars?: Record<string, string>;
  details?: string[];
  downloadFilename?: string;
  viewText?: string;
  warnings?: string[];
};

/** 提问队列里的一问一答。question 为空的写法在复述里标「按写法补」。 */
type AskItem = {
  skillId: string;
  question: string;
  suggestions: string[];
  answer: string;
};

type ThinkingEffort = "none" | "low" | "medium" | "high";
const THINKING_EFFORTS: readonly ThinkingEffort[] = ["none", "low", "medium", "high"];
const HOOK_STYLES = [
  "default",
  "reversal",
  "contrast",
  "emotion",
  "burst",
  "setting",
  "rebirth",
] as const;

/** 三种成稿：卷数和落盘格式都定死在这里，前端不再问。 */
const KINDS: readonly { id: Kind; unitKey: string; titleKey: string; detailKey: string }[] = [
  { id: "drama", unitKey: "ingest.askFirst.unitEpisode", titleKey: "ingest.askFirst.drama", detailKey: "ingest.askFirst.dramaDetail" },
  { id: "novel", unitKey: "ingest.askFirst.unitChapter", titleKey: "ingest.askFirst.comic", detailKey: "ingest.askFirst.comicDetail" },
  { id: "ad", unitKey: "ingest.askFirst.unitEpisode", titleKey: "ingest.askFirst.ad", detailKey: "ingest.askFirst.adDetail" },
];

const COUNT_PRESETS: Record<Kind, readonly string[]> = {
  drama: ["4", "8", "12"],
  novel: ["6", "12", "24"],
  ad: [],
};
const DEFAULT_COUNT: Record<Kind, string> = { drama: "8", novel: "12", ad: "1" };

const STEPS: readonly Step[] = ["path", "kind", "premise", "lead", "count", "skills", "chat"];
const OPEN_EDIT: Msg = { id: "edit-open", role: "agent", key: "ingest.askFirst.question" };
const OPEN_ZERO: Msg = { id: "zero-open", role: "agent", key: "ingest.askFirst.zeroOpen" };

type Persisted = {
  active: ThreadId;
  editStep: Step;
  zeroStep: ZeroStep;
  editMessages: Msg[];
  zeroMessages: Msg[];
  kind: Kind;
  count: string;
  picked: string[];
  queue: AskItem[];
  askIndex: number;
  hasWork: boolean;
  writtenFile: string;
  writtenUnit: number;
};

function isSkillId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStep(value: unknown): value is Step {
  return typeof value === "string" && (STEPS as readonly string[]).includes(value);
}

function isZeroStep(value: unknown): value is ZeroStep {
  return (
    typeof value === "string" && ["kind", "skills", "ask", "recap", "chat"].includes(value)
  );
}

function defaultState(): Persisted {
  return {
    active: "edit",
    editStep: "path",
    zeroStep: "kind",
    editMessages: [OPEN_EDIT],
    zeroMessages: [OPEN_ZERO],
    kind: "drama",
    count: DEFAULT_COUNT.drama,
    picked: [],
    queue: [],
    askIndex: 0,
    hasWork: false,
    writtenFile: "",
    writtenUnit: 0,
  };
}

function parseVars(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const vars: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") vars[key] = item;
  }
  return Object.keys(vars).length > 0 ? vars : undefined;
}

function parseMessage(value: unknown, index: number, thread: ThreadId): Msg | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<Msg>;
  if (item.role !== "agent" && item.role !== "user") return null;
  const key = typeof item.key === "string" && item.key.startsWith("ingest.askFirst.") ? item.key : undefined;
  const text = typeof item.text === "string" ? item.text : undefined;
  if (!key && text === undefined) return null;
  return {
    id: typeof item.id === "string" && item.id ? item.id : `${thread}-${index}`,
    role: item.role,
    key,
    text,
    vars: parseVars(item.vars),
    downloadFilename:
      typeof item.downloadFilename === "string" ? item.downloadFilename : undefined,
    viewText: typeof item.viewText === "string" ? item.viewText : undefined,
    warnings: Array.isArray(item.warnings)
      ? item.warnings.filter((line): line is string => typeof line === "string")
      : undefined,
  };
}

function parseSaved(value: unknown): Persisted | null {
  if (!value || typeof value !== "object") return null;
  const saved = value as Partial<Persisted>;
  if ((saved.active !== "edit" && saved.active !== "zero") || !isStep(saved.editStep)) {
    return null;
  }
  if (!isZeroStep(saved.zeroStep)) return null;
  if (!Array.isArray(saved.editMessages) || !Array.isArray(saved.zeroMessages)) return null;
  const editMessages = saved.editMessages
    .map((item, index) => parseMessage(item, index, "edit"))
    .filter((item): item is Msg => item !== null);
  const zeroMessages = saved.zeroMessages
    .map((item, index) => parseMessage(item, index, "zero"))
    .filter((item): item is Msg => item !== null);
  const picked = Array.isArray(saved.picked)
    ? saved.picked.filter((item): item is string => isSkillId(item))
    : [];
  const queue = Array.isArray(saved.queue)
    ? saved.queue
        .map((item): AskItem | null => {
          if (!item || typeof item !== "object") return null;
          const row = item as Partial<AskItem>;
          if (typeof row.skillId !== "string" || !row.skillId) return null;
          return {
            skillId: row.skillId,
            question: typeof row.question === "string" ? row.question : "",
            suggestions: Array.isArray(row.suggestions)
              ? row.suggestions.filter((line): line is string => typeof line === "string")
              : [],
            answer: typeof row.answer === "string" ? row.answer : "",
          };
        })
        .filter((item): item is AskItem => item !== null)
    : [];
  const kind: Kind =
    saved.kind === "novel" || saved.kind === "ad" || saved.kind === "drama" ? saved.kind : "drama";
  return {
    active: saved.active,
    editStep: saved.editStep,
    zeroStep: saved.zeroStep,
    editMessages: editMessages.length > 0 ? editMessages : [OPEN_EDIT],
    zeroMessages: zeroMessages.length > 0 ? zeroMessages : [OPEN_ZERO],
    kind,
    count: typeof saved.count === "string" && saved.count ? saved.count : DEFAULT_COUNT[kind],
    picked,
    queue,
    askIndex:
      typeof saved.askIndex === "number" && saved.askIndex > 0 ? Math.floor(saved.askIndex) : 0,
    hasWork: saved.hasWork === true,
    writtenFile: typeof saved.writtenFile === "string" ? saved.writtenFile : "",
    writtenUnit: typeof saved.writtenUnit === "number" && saved.writtenUnit > 0 ? Math.floor(saved.writtenUnit) : 0,
  };
}

function messageText(
  message: Msg,
  t: (key: string, vars?: Record<string, string>) => string,
): string {
  if (message.key) return t(message.key, message.vars);
  return message.text ?? "";
}

export function AskFirstPanel({
  projectId,
  filename,
  hasManuscript,
  formatBlocked,
  onRepair,
  headerChoices = [],
  onChooseHeader,
  spineTemplate = "drama",
  onManuscriptAction,
  onSaveImitation,
  onWriteFirst,
  onManuscriptFileChanged,
  skillLibrary,
  retainConversation = true,
  className = "mt-6",
}: {
  projectId: string;
  filename: string;
  hasManuscript: boolean;
  formatBlocked: boolean;
  onRepair?: (
    report: (line: string, details?: string[]) => void,
    reasoningEffort: ThinkingEffort,
  ) => Promise<string | void>;
  headerChoices?: string[];
  onChooseHeader?: (
    header: string,
    report: (line: string, details?: string[]) => void,
    reasoningEffort: ThinkingEffort,
  ) => Promise<string | void>;
  spineTemplate?: SpineTemplate;
  onManuscriptAction?: (request: ManuscriptActionRequest) => Promise<ManuscriptActionResult>;
  onSaveImitation?: (request: {
    filename: string;
    content: string;
    spine_template: SpineTemplate;
  }) => Promise<UploadResult>;
  onWriteFirst?: (request: WriteFirstRequest) => Promise<{
    upload: UploadResult;
    quality_issues?: string[];
  }>;
  onManuscriptFileChanged?: (upload: UploadResult) => void;
  /** 写法库的入口：开问、换一批、编辑、新增、删除、恢复默认都走它。 */
  skillLibrary?: WritingSkillBridge;
  /** Null while the page is still checking whether this project already has a manuscript. */
  retainConversation?: boolean | null;
  className?: string;
}) {
  const { t } = useTranslation();
  const storageKey = `dramaclaw-ask-first:${projectId}`;
  const scroller = useRef<HTMLDivElement>(null);
  const decidedKey = useRef<string | null>(null);
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const [active, setActive] = useState<ThreadId>("edit");
  const [editStep, setEditStep] = useState<Step>("path");
  const [zeroStep, setZeroStep] = useState<ZeroStep>("kind");
  const [draft, setDraft] = useState("");
  const [pinned, setPinned] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("drama");
  const [count, setCount] = useState(DEFAULT_COUNT.drama);
  const [picked, setPicked] = useState<string[]>([]);
  const [queue, setQueue] = useState<AskItem[]>([]);
  const [askIndex, setAskIndex] = useState(0);
  const [askDraft, setAskDraft] = useState("");
  const [library, setLibrary] = useState<WritingSkill[]>([]);
  const [adBrief, setAdBrief] = useState<WritingSkillBrief | null>(null);
  const [libraryState, setLibraryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [reshuffling, setReshuffling] = useState(false);
  const [hasWork, setHasWork] = useState(false);
  const [writtenFile, setWrittenFile] = useState("");
  const [writtenUnit, setWrittenUnit] = useState(0);
  const [thinking, setThinking] = useState<ThinkingEffort>("none");
  const [repairing, setRepairing] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessageId, setActionMessageId] = useState<string | null>(null);
  const [hookStylesOpen, setHookStylesOpen] = useState(false);
  const [mappingAction, setMappingAction] = useState<"cast" | "gender" | null>(null);
  const [mappings, setMappings] = useState<ManuscriptCharacterMapping[]>([]);
  const [imitationDraft, setImitationDraft] = useState("");
  const [imitationSaving, setImitationSaving] = useState(false);
  const [previewKind, setPreviewKind] = useState<"imitate" | "adapt">("imitate");
  const [expandedView, setExpandedView] = useState<string | null>(null);
  const [repairMessageId, setRepairMessageId] = useState<string | null>(null);
  const repairLock = useRef(false);
  const [editMessages, setEditMessages] = useState<Msg[]>([OPEN_EDIT]);
  const [zeroMessages, setZeroMessages] = useState<Msg[]>([OPEN_ZERO]);
  const canEditCurrentWork =
    hasWork && filename.toLowerCase().endsWith(".xialiao.txt") && !formatBlocked;

  useEffect(() => {
    if (retainConversation === null) return;
    if (decidedKey.current === storageKey) return;
    decidedKey.current = storageKey;
    let next = defaultState();
    if (!retainConversation) {
      sessionStorage.removeItem(storageKey);
    } else {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        try {
          next = parseSaved(JSON.parse(raw)) ?? defaultState();
        } catch {
          sessionStorage.removeItem(storageKey);
        }
      }
    }
    setActive(next.active);
    setEditStep(next.editStep);
    setZeroStep(next.zeroStep);
    setEditMessages(next.editMessages);
    setZeroMessages(next.zeroMessages);
    setKind(next.kind);
    setCount(next.count);
    setPicked(next.picked);
    setQueue(next.queue);
    setAskIndex(next.askIndex);
    setWrittenFile(next.writtenFile);
    setWrittenUnit(next.writtenUnit);
    setHasWork(
      next.hasWork || next.editMessages.some((message) => Boolean(message.downloadFilename)),
    );
    setDraft("");
    setPinned(null);
    setReadyKey(storageKey);
  }, [retainConversation, storageKey]);

  useEffect(() => {
    if (readyKey !== storageKey) return;
    const payload: Persisted = {
      active,
      editStep,
      zeroStep,
      editMessages,
      zeroMessages,
      kind,
      count,
      picked,
      queue,
      askIndex,
      hasWork,
      writtenFile,
      writtenUnit,
    };
    sessionStorage.setItem(storageKey, JSON.stringify(payload));
  }, [
    readyKey,
    storageKey,
    active,
    editStep,
    zeroStep,
    editMessages,
    zeroMessages,
    kind,
    count,
    picked,
    queue,
    askIndex,
    hasWork,
    writtenFile,
    writtenUnit,
  ]);

  const messages = active === "edit" ? editMessages : zeroMessages;
  const step = active === "edit" ? editStep : zeroStep;
  const sent = messages.filter((message) => message.role === "user");
  const unit = t(KINDS.find((item) => item.id === kind)?.unitKey ?? "ingest.askFirst.unitEpisode");

  useEffect(() => {
    let cancelled = false;
    if (!skillLibrary) {
      setLibraryState("error");
      return;
    }
    setLibraryState("loading");
    void skillLibrary
      .load()
      .then((data) => {
        if (cancelled) return;
        setLibrary(data.skills);
        setAdBrief(data.ad_brief);
        setLibraryState("ready");
      })
      .catch(() => {
        if (!cancelled) setLibraryState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [skillLibrary]);

  useEffect(() => {
    const node = scroller.current;
    if (!node || typeof node.scrollTo !== "function") return;
    node.scrollTo({ top: node.scrollHeight });
  }, [messages, step, active]);

  const push = (
    role: Role,
    payload: { text?: string; key?: string; vars?: Record<string, string> },
    thread: ThreadId = active,
  ) => {
    const setMessages = thread === "edit" ? setEditMessages : setZeroMessages;
    setMessages((items) => [
      ...items,
      { id: `${thread}-${items.length}-${role}`, role, ...payload },
    ]);
  };

  const chooseNew = () => {
    setActive("zero");
    setZeroMessages((items) =>
      items.some((item) => item.role === "user" && item.key === "ingest.askFirst.newPiece")
        ? items
        : [...items, { id: `zero-user-${items.length}`, role: "user", key: "ingest.askFirst.newPiece" }],
    );
  };

  // ── 另写一篇：体裁 → 多选写法 → 一次问一题 → 复述 ──────────────────

  /** 换体裁或重选写法都会换掉整条队列，已答的一并清掉：半套答案比全错答案干净。 */
  const resetQueue = (next: ZeroStep, nextKind?: Kind) => {
    setQueue([]);
    setAskIndex(0);
    setAskDraft("");
    setZeroStep(next);
    if (nextKind) {
      setKind(nextKind);
      setCount(DEFAULT_COUNT[nextKind]);
    }
  };

  const chooseKind = (next: Kind) => {
    resetQueue("skills", next);
    push("user", { key: KINDS.find((item) => item.id === next)?.titleKey ?? "ingest.askFirst.drama" });
  };

  const toggleSkill = (id: string) =>
    setPicked((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );

  /** 点「开始问」才把当前选中的写法锁成队列，之后按选中顺序一次问一个。 */
  const startAsking = () => {
    const own: AskItem[] = picked
      .map((id) => library.find((skill) => skill.id === id))
      .filter((skill): skill is WritingSkill => Boolean(skill))
      .map((skill) => ({
        skillId: skill.id,
        question: skill.question,
        suggestions: [...skill.suggestions],
        answer: "",
      }));
    // 广告不问篇幅（锁死 1 集），但必须先知道在卖什么：自带的那一问排在最前面。
    const items = kind === "ad" && adBrief ? [{ ...adBrief, skillId: adBrief.id, answer: "" }, ...own] : own;
    setQueue(items);
    setAskIndex(0);
    setAskDraft("");
    setZeroStep(items.length > 0 ? "ask" : "recap");
  };

  const answerCurrent = () => {
    const text = askDraft.trim();
    if (!text) return;
    setQueue((items) => items.map((item, index) => (index === askIndex ? { ...item, answer: text } : item)));
    setAskDraft("");
    const next = askIndex + 1;
    setAskIndex(next);
    if (next >= queue.length) setZeroStep("recap");
  };


  /** 「换一批」只换屏幕上这三句，写法库不动。 */
  const reshuffleCurrent = async () => {
    const item = queue[askIndex];
    if (!item || !skillLibrary || reshuffling) return;
    setReshuffling(true);
    try {
      const result = await skillLibrary.reshuffle({
        id: item.skillId,
        question: item.question,
        avoid: item.suggestions,
        kind,
        context: queue
          .slice(0, askIndex)
          .map((row) => `${row.question} ${row.answer}`)
          .join("\n"),
      });
      setQueue((items) =>
        items.map((row, index) => (index === askIndex ? { ...row, suggestions: result.suggestions } : row)),
      );
    } catch {
      // 换一批不通就留着原来这三句，但要让人知道失败了。
      toast.error(t("ingest.askFirst.reshuffleFailed"));
    } finally {
      setReshuffling(false);
    }
  };

  const sceneHeaderLine = /^[\u4e00-\u9fffA-Za-z0-9·《》、 ]{2,40}\s+(?:日|夜|白天|深夜|黄昏|清晨|凌晨|上午|下午|傍晚|夜晚)\s+(?:内|外)$/;

  const chooseHeader = async (header: string) => {
    if (!onChooseHeader || repairLock.current) return;
    repairLock.current = true;
    const progressId = `edit-header-${Date.now()}`;
    setRepairing(true);
    setRepairMessageId(progressId);
    setEditMessages((items) => [
      ...items,
      { id: `${progressId}-user`, role: "user", text: header },
      { id: progressId, role: "agent", text: t("ingest.askFirst.repairApplyingHeader") },
    ]);
    try {
      const downloadFilename = await onChooseHeader(
        header,
        (line, details) => reportRepair(progressId, line, details),
        thinking,
      );
      attachRepairDownload(progressId, downloadFilename);
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : t("ingest.askFirst.repairFailed");
      reportRepair(progressId, message, callsFromError(error));
    } finally {
      repairLock.current = false;
      setRepairing(false);
      setRepairMessageId(null);
    }
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (active === "edit" && headerChoices.length > 0) {
      if (sceneHeaderLine.test(text)) {
        void chooseHeader(text);
        return;
      }
      push("user", { text });
      push("agent", { key: "ingest.askFirst.repairHeaderAdvice" });
      return;
    }
    push("user", { text });
    if (active === "zero" && writtenUnit > 0 && /继续|下一[集章]|写第/.test(text)) {
      void askWrite(writtenUnit + 1, text);
      return;
    }
    if (
      active === "edit" &&
      /删章|删除(?:这|那|第)?[0-9一二三四五六七八九十]*章|删掉(?:这|那|第)?[0-9一二三四五六七八九十]*章|把第?[0-9一二三四五六七八九十]+章删|去掉第?[0-9一二三四五六七八九十]*章|加情节|增加情节|分镜|重写成另一|改成另一部/.test(
        text,
      )
    ) {
      push("agent", { key: "ingest.askFirst.rejectEdit" });
      return;
    }
    push("agent", { key: active === "zero" ? "ingest.askFirst.ackZero" : "ingest.askFirst.ackEdit" });
  };

  const jumpTo = (id: string) => {
    const root = scroller.current;
    const target = root?.querySelector<HTMLElement>(`[data-msg="${id}"]`);
    if (!root || !target || typeof root.scrollTo !== "function") return;
    root.scrollTo({ top: target.offsetTop - 8, behavior: "smooth" });
    setPinned(id);
  };

  const callsFromError = (error: unknown): string[] | undefined => {
    if (!error || typeof error !== "object" || !("calls" in error)) return undefined;
    const calls = (error as { calls?: unknown }).calls;
    if (!Array.isArray(calls)) return undefined;
    const lines = calls.filter((line): line is string => typeof line === "string" && line.trim() !== "");
    return lines.length > 0 ? lines : undefined;
  };

  const reportRepair = (id: string, line: string, details?: string[]) => {
    setEditMessages((items) =>
      items.map((item) =>
        item.id === id
          ? {
              ...item,
              text: line,
              key: undefined,
              details: details?.length ? [...(item.details ?? []), ...details] : item.details,
            }
          : item,
      ),
    );
  };

  const attachRepairDownload = (id: string, downloadFilename: string | void) => {
    if (!downloadFilename) return;
    setHasWork(true);
    setEditMessages((items) =>
      items.map((item) => (item.id === id ? { ...item, downloadFilename } : item)),
    );
  };

  const runRepair = async () => {
    if (!onRepair || repairLock.current) return;
    repairLock.current = true;
    const progressId = `edit-repair-${Date.now()}`;
    setRepairing(true);
    setRepairMessageId(progressId);
    setEditMessages((items) => [
      ...items,
      { id: `${progressId}-user`, role: "user", key: "ingest.askFirst.repair" },
      { id: progressId, role: "agent", text: t("ingest.askFirst.repairWorkingStart") },
    ]);
    try {
      const downloadFilename = await onRepair(
        (line, details) => reportRepair(progressId, line, details),
        thinking,
      );
      attachRepairDownload(progressId, downloadFilename);
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : t("ingest.askFirst.repairFailed");
      reportRepair(progressId, message, callsFromError(error));
    } finally {
      repairLock.current = false;
      setRepairing(false);
      setRepairMessageId(null);
    }
  };

  const runManuscriptAction = async (
    action: ManuscriptActionRequest["action"],
    style?: string,
  ) => {
    if (!canEditCurrentWork || actionBusy || repairing) return;
    setActionBusy(true);
    setHookStylesOpen(false);
    const progressId = `edit-action-${Date.now()}`;
    setActionMessageId(progressId);
    const actionKey =
      action === "cast_preview" || action === "cast_apply"
        ? "cast"
        : action === "gender_preview" || action === "gender_apply"
          ? "gender"
          : action;
    setEditMessages((items) => [
      ...items,
      { id: `${progressId}-user`, role: "user", key: `ingest.askFirst.${actionKey}` },
      { id: progressId, role: "agent", text: t(`ingest.askFirst.${actionKey}Working`) },
    ]);
    try {
      if (!onManuscriptAction) throw new Error(t("ingest.askFirst.actionFailed"));
      const data = await onManuscriptAction({
        filename,
        action,
        spine_template: spineTemplate,
        style,
        mappings: action.endsWith("_apply") ? mappings : undefined,
        reasoning_effort: thinking,
      });
      if (data.mappings) {
        setMappingAction(action === "cast_preview" ? "cast" : "gender");
        setMappings(data.mappings);
        setImitationDraft("");
        reportRepair(progressId, t("ingest.askFirst.mappingReady", { count: data.mappings.length }), data.calls);
      } else if ((action === "imitate" || action === "adapt") && data.content) {
        setImitationDraft(data.content);
        setPreviewKind(action);
        const excerpt = data.content.slice(0, 700);
        const readyKey = action === "adapt" ? "ingest.askFirst.adaptReady" : "ingest.askFirst.imitateReady";
        reportRepair(
          progressId,
          `${t(readyKey)}\n\n${excerpt}${data.content.length > excerpt.length ? "…" : ""}`,
          data.calls,
        );
      } else if (data.upload) {
        setMappingAction(null);
        setMappings([]);
        setImitationDraft("");
        onManuscriptFileChanged?.(data.upload);
        reportRepair(progressId, t("ingest.askFirst.actionDone", { filename: data.upload.filename }), data.calls);
        attachRepairDownload(progressId, data.upload.filename);
      } else {
        reportRepair(progressId, t("ingest.askFirst.actionDoneGeneric"), data.calls);
      }
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : t("ingest.askFirst.actionFailed");
      reportRepair(progressId, message, callsFromError(error));
    } finally {
      setActionBusy(false);
      setActionMessageId(null);
    }
  };

  const updateMapping = (
    index: number,
    update: Partial<ManuscriptCharacterMapping>,
  ) => {
    setMappings((current) =>
      current.map((row, rowIndex) => rowIndex === index ? { ...row, ...update } : row),
    );
  };

  const saveImitationDraft = async () => {
    if (!imitationDraft || imitationSaving || !canEditCurrentWork) return;
    setImitationSaving(true);
    try {
      if (!onSaveImitation) throw new Error(t("ingest.askFirst.actionFailed"));
      const adapting = previewKind === "adapt";
      const upload = await onSaveImitation({
        filename,
        content: imitationDraft,
        spine_template: adapting ? "drama" : spineTemplate,
        ...(adapting ? { suffix: "改编短剧", target_template: "drama", validate: false } : {}),
      });
      setImitationDraft("");
      setEditMessages((items) => [
        ...items,
        {
          id: `edit-imitation-saved-${Date.now()}`,
          role: "agent",
          text: t("ingest.askFirst.imitateSaved", { filename: upload.filename }),
          downloadFilename: upload.filename,
        },
      ]);
    } catch (error) {
      setEditMessages((items) => [
        ...items,
        {
          id: `edit-imitation-save-error-${Date.now()}`,
          role: "agent",
          text: error instanceof Error && error.message ? error.message : t("ingest.askFirst.actionFailed"),
        },
      ]);
    } finally {
      setImitationSaving(false);
    }
  };

  const askWrite = async (
    nextUnit: number,
    note?: string,
    userMessage?: { key: string; vars?: Record<string, string> },
  ) => {
    if (actionBusy) return;
    const progressId = `zero-write-${Date.now()}`;
    const continuing = nextUnit > 1;
    setActionBusy(true);
    setActionMessageId(progressId);
    if (userMessage) push("user", userMessage);
    setZeroMessages((items) => [
      ...items,
      {
        id: progressId,
        role: "agent",
        text: t(
          continuing ? "ingest.askFirst.writeNextRunning" : "ingest.askFirst.writeRunning",
          { next: nextUnit, unit },
        ),
      },
    ]);
    setZeroStep("chat");
    try {
      if (!onWriteFirst) throw new Error(t("ingest.askFirst.actionFailed"));
      const data = await onWriteFirst({
        kind,
        premise: "",
        lead: "",
        count,
        skills: queue.map((item) => item.skillId).filter((id) => id !== adBrief?.id),
        answers: queue.map((item) => ({
          skill_id: item.skillId,
          question: item.question,
          answer: item.answer,
          filled_by_skill: !item.question,
        })),
        reasoning_effort: thinking,
        ...(continuing
          ? { filename: writtenFile, episode: nextUnit, note: note ?? "" }
          : {}),
      });
      const written = data.upload.episode ?? nextUnit;
      const viewText =
        data.upload.chapters?.find((chapter) => chapter.number === written)?.content ??
        data.upload.chapters?.[data.upload.chapters.length - 1]?.content ??
        "";
      const quality = data.quality_issues ?? [];
      setWrittenFile(data.upload.filename);
      setWrittenUnit(written);
      setHasWork(true);
      onManuscriptFileChanged?.(data.upload);
      setZeroMessages((items) =>
        items.map((item) =>
          item.id === progressId
            ? {
                ...item,
                text: t(
                  continuing ? "ingest.askFirst.writeNextDone" : "ingest.askFirst.writeDone",
                  { next: written, unit, filename: data.upload.filename },
                ),
                warnings: quality.length ? quality : undefined,
                viewText: viewText || undefined,
                downloadFilename: data.upload.filename,
              }
            : item,
        ),
      );
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : t("ingest.askFirst.actionFailed");
      // 第 1 稿没写出来就退回复述：用户还能改答案再点一次，不用从头走一遍。
      if (!continuing) setZeroStep("recap");
      setZeroMessages((items) =>
        items.map((item) =>
          item.id === progressId ? { ...item, text: message, key: undefined } : item,
        ),
      );
    } finally {
      setActionBusy(false);
      setActionMessageId(null);
    }
  };

  return (
    <section
      data-testid="ask-first-panel"
      className={`${className} [&_button]:transition-transform [&_button]:duration-150 [&_button]:ease-[cubic-bezier(0.23,1,0.32,1)] [&_button:not(:disabled)]:cursor-pointer [&_button:disabled]:cursor-not-allowed [&_button:active:not(:disabled)]:scale-[0.97] motion-reduce:[&_button]:transition-none motion-reduce:[&_button:active]:scale-100`}
    >
      <div className={`grid items-start gap-4 ${hasWork ? "lg:grid-cols-[minmax(0,1fr)_240px]" : ""}`}>
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
          <div className="border-b border-white/10 px-5 py-3">
            <p className="text-sm font-medium">{t("ingest.askFirst.title")}</p>
            <p className="text-xs text-muted-foreground">
              {active === "zero"
                ? t("ingest.askFirst.writingNew")
                : t("ingest.askFirst.editing", { name: filename })}
            </p>
          </div>
          <div className="flex min-h-0">
            {sent.length > 0 && (
              <aside className="flex w-8 shrink-0 flex-col items-center gap-1 border-r border-white/10 py-2">
                {sent.map((message) => {
                  const label = messageText(message, t);
                  return (
                    <div key={message.id} className="group relative">
                      <button
                        type="button"
                        aria-label={label}
                        onClick={() => jumpTo(message.id)}
                        className="flex size-7 items-center justify-center"
                      >
                        <span
                          className={`absolute bottom-1 left-0 top-1 w-0.5 ${pinned === message.id ? "bg-foreground" : "bg-transparent group-hover:bg-white/50"}`}
                        />
                        <PencilLine className="size-3.5 text-muted-foreground" />
                      </button>
                      <div className="pointer-events-none absolute left-full top-1/2 z-20 ml-2 hidden w-max max-w-64 -translate-y-1/2 rounded-md border border-white/10 bg-popover px-2.5 py-1.5 text-xs leading-5 shadow-lg group-hover:block group-focus-within:block">
                        {label}
                      </div>
                    </div>
                  );
                })}
              </aside>
            )}
            <div ref={scroller} className="relative max-h-72 min-w-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              {active === "edit" && headerChoices.length > 0 && !repairing && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">{t("ingest.askFirst.headerChoices")}</p>
                  <OptionRow
                    items={headerChoices.map((choice) => ({
                      title: choice,
                      detail: t("ingest.askFirst.headerChoiceHint"),
                      onClick: () => {
                        void chooseHeader(choice);
                      },
                    }))}
                  />
                </div>
              )}
              {messages.map((message) =>
                message.role === "user" ? (
                  <div key={message.id} data-msg={message.id} className="flex justify-end">
                    <div
                      className={`max-w-[36rem] rounded-[14px] px-4 py-2.5 text-sm leading-6 ${pinned === message.id ? "bg-primary/20" : "bg-white/[0.07]"}`}
                    >
                      {messageText(message, t)}
                    </div>
                  </div>
                ) : (
                  <div
                    key={message.id}
                    role={
                      (repairing && message.id === repairMessageId) ||
                      (actionBusy && message.id === actionMessageId)
                        ? "status"
                        : undefined
                    }
                    aria-busy={
                      (repairing && message.id === repairMessageId) ||
                      (actionBusy && message.id === actionMessageId)
                        ? true
                        : undefined
                    }
                    className="flex max-w-3xl items-start gap-2 text-sm leading-6"
                  >
                    {((repairing && message.id === repairMessageId) ||
                      (actionBusy && message.id === actionMessageId)) && (
                      <Loader2 className="mt-1 size-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none" />
                    )}
                    <div className="min-w-0">
                      {messageText(message, t)}
                      {message.details && message.details.length > 0 && (
                        <details className="mt-2 text-xs text-muted-foreground">
                          <summary className="cursor-pointer">{t("ingest.askFirst.callDetails")}</summary>
                          <ul className="mt-1 space-y-1">
                            {message.details.map((line) => (
                              <li key={line}>{line}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                      {message.warnings && message.warnings.length > 0 && (
                        <details className="mt-2 text-xs text-muted-foreground">
                          <summary className="cursor-pointer">{t("ingest.askFirst.qualityNotes")}</summary>
                          <ul className="mt-1 space-y-1">
                            {message.warnings.map((line) => (
                              <li key={line}>{line}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                      {message.viewText && (
                        <div className="mt-2">
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedView(expandedView === message.id ? null : message.id)
                            }
                            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/10 px-3 text-xs hover:border-white/20"
                          >
                            {expandedView === message.id
                              ? t("ingest.askFirst.viewResultHide")
                              : t("ingest.askFirst.viewResultShow")}
                          </button>
                          {expandedView === message.id && (
                            <pre className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-xl border border-white/10 bg-black/20 p-3 text-sm leading-6">
                              {message.viewText}
                            </pre>
                          )}
                        </div>
                      )}
                      {message.downloadFilename && (
                        <button
                          type="button"
                          onClick={() => {
                            const downloadFilename = message.downloadFilename;
                            if (!downloadFilename) return;
                            const url = `/${p`api/v1/projects/${projectId}/files/uploads/${downloadFilename}`}`;
                            void downloadUrlAsFile(url, downloadFilename);
                          }}
                          className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-full border border-white/10 px-3 text-xs hover:border-white/20"
                        >
                          <Download className="size-3.5" />
                          {t("ingest.askFirst.downloadWorkingCopy")}
                        </button>
                      )}
                    </div>
                  </div>
                ),
              )}
            </div>
          </div>
          <div className="space-y-3 border-t border-white/10 px-4 py-3">
            {active === "edit" && step === "path" && (
              <div className="grid gap-2 sm:grid-cols-2">
                <Choice
                  title={t("ingest.askFirst.handleThis")}
                  detail={
                    hasManuscript
                      ? formatBlocked
                        ? t("ingest.askFirst.handleBlocked")
                        : t("ingest.askFirst.handleReady")
                      : t("ingest.askFirst.handleNeedFile")
                  }
                  disabled={!hasManuscript}
                  onClick={() => {
                    push("user", { key: "ingest.askFirst.handleThis" });
                    push("agent", { key: "ingest.askFirst.handled" });
                    setEditStep("chat");
                  }}
                />
                <Choice
                  title={t("ingest.askFirst.newPiece")}
                  detail={t("ingest.askFirst.newPieceDetail")}
                  onClick={chooseNew}
                />
              </div>
            )}
            {active === "edit" && editStep !== "path" && (
              <button
                type="button"
                onClick={chooseNew}
                className="flex h-8 w-full items-center justify-between gap-3 rounded-full border border-white/15 px-3 text-left"
              >
                <span className="shrink-0 whitespace-nowrap text-sm">{t("ingest.askFirst.switchToNew")}</span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {t("ingest.askFirst.switchToNewDetail")}
                </span>
              </button>
            )}
            {active === "zero" && (
              <button
                type="button"
                onClick={() => setActive("edit")}
                className="flex h-8 w-full items-center justify-between gap-3 rounded-full border border-white/15 px-3 text-left"
              >
                <span className="shrink-0 whitespace-nowrap text-sm">{t("ingest.askFirst.backToEdit")}</span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {t("ingest.askFirst.backToEditDetail", { name: filename })}
                </span>
              </button>
            )}
            {active === "zero" && zeroStep === "kind" && (
              <div className="grid gap-2 sm:grid-cols-3">
                {KINDS.map((item) => (
                  <Choice
                    key={item.id}
                    title={t(item.titleKey)}
                    detail={t(item.detailKey)}
                    onClick={() => chooseKind(item.id)}
                  />
                ))}
              </div>
            )}
            {active === "zero" && zeroStep === "skills" && (
              <div className="space-y-3">
                {libraryState === "loading" && (
                  <p className="text-xs text-muted-foreground">{t("ingest.askFirst.skillLoading")}</p>
                )}
                {libraryState === "error" && (
                  <p className="text-xs text-red-300">{t("ingest.askFirst.skillLoadFailed")}</p>
                )}
                {skillLibrary && (
                  <WritingSkillQuietPicker
                    api={{
                      skills: library,
                      picked,
                      pickedSkills: picked
                        .map((id) => library.find((skill) => skill.id === id))
                        .filter((skill): skill is WritingSkill => Boolean(skill)),
                      toggle: toggleSkill,
                      remove: (id) =>
                        setLibrary((items) => items.filter((skill) => skill.id !== id)),
                      edit: (id, patch) =>
                        setLibrary((items) =>
                          items.map((skill) => (skill.id === id ? { ...skill, ...patch } : skill)),
                        ),
                      add: (skill) =>
                        setLibrary((items) =>
                          items.some((item) => item.id === skill.id) ? items : [...items, skill],
                        ),
                    }}
                    bridge={skillLibrary}
                    kind={kind}
                    onAsk={startAsking}
                  />
                )}
              </div>
            )}
            {active === "zero" && zeroStep === "ask" && queue[askIndex] && (
              <div className="space-y-3">
                <p className="text-sm leading-6">
                  {queue[askIndex].question || t("ingest.askFirst.skillNoQuestionHint")}
                </p>
                <div className="space-y-1.5">
                  {queue[askIndex].suggestions.map((line, index) => (
                    <button
                      key={line}
                      type="button"
                      onClick={() => setAskDraft(line)}
                      className="flex w-full items-start gap-2 rounded-xl border border-white/10 px-3 py-2 text-left text-sm leading-6 hover:border-white/20"
                    >
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t("ingest.askFirst.suggestionIndex", { index: index + 1 })}
                      </span>
                      <span className="min-w-0">{line}</span>
                      {index === 0 && (
                        <span className="ml-auto shrink-0 text-xs text-primary">
                          {t("ingest.askFirst.suggestionRecommended")}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={askDraft}
                    onChange={(event) => setAskDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        answerCurrent();
                      }
                    }}
                    placeholder={t("ingest.askFirst.placeholderAnswer")}
                    className="h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.022] px-3 text-sm outline-none placeholder:text-muted-foreground/70 focus-visible:border-primary"
                  />
                  <button
                    type="button"
                    disabled={!askDraft.trim()}
                    onClick={answerCurrent}
                    className="h-9 rounded-full bg-primary px-4 text-sm text-primary-foreground disabled:opacity-40"
                  >
                    {askIndex + 1 < queue.length
                      ? t("ingest.askFirst.answerAndNext")
                      : t("ingest.askFirst.answerAndRecap")}
                  </button>
                  <button
                    type="button"
                    disabled={reshuffling}
                    onClick={() => void reshuffleCurrent()}
                    className="h-9 rounded-full border border-white/10 px-3 text-sm disabled:opacity-40"
                  >
                    {reshuffling ? (
                      <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                    ) : (
                      t("ingest.askFirst.reshuffle")
                    )}
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => resetQueue("skills")}
                    className="h-8 rounded-full border border-white/10 px-3 text-xs"
                  >
                    {t("ingest.askFirst.reselectSkills")}
                  </button>
                  <button
                    type="button"
                    onClick={() => resetQueue("kind")}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/10 px-3 text-xs"
                  >
                    <RotateCcw className="size-3.5" />
                    {t("ingest.askFirst.changeKind")}
                  </button>
                </div>
              </div>
            )}
            {active === "zero" && zeroStep === "recap" && (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">{t("ingest.askFirst.recapTitle")}</p>
                <dl className="space-y-1.5 text-sm leading-6">
                  <div className="flex gap-2">
                    <dt className="shrink-0 text-muted-foreground">{t("ingest.askFirst.recapKind")}</dt>
                    <dd>{t(KINDS.find((item) => item.id === kind)?.titleKey ?? "ingest.askFirst.drama")}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="shrink-0 text-muted-foreground">{t("ingest.askFirst.skillListLabel")}</dt>
                    <dd className="min-w-0">
                      {picked.length > 0
                        ? picked
                            .map((id) => library.find((skill) => skill.id === id))
                            .filter((skill): skill is WritingSkill => Boolean(skill))
                            .map((skill) => skillName(skill, t))
                            .join("、")
                        : t("ingest.askFirst.recapNoSkills")}
                    </dd>
                  </div>
                </dl>
                {queue.map((item) => (
                  <label key={item.skillId} className="block space-y-1 text-xs text-muted-foreground">
                    <span>
                      {item.question || t("ingest.askFirst.recapBySkill", {
                        name: skillName(
                          library.find((skill) => skill.id === item.skillId) ?? {
                            id: item.skillId,
                            name: item.skillId,
                            description: "",
                            prompt: "",
                            question: "",
                            suggestions: [],
                            builtin: false,
                          },
                          t,
                        ),
                      })}
                    </span>
                    {item.question ? (
                      <input
                        value={item.answer}
                        onChange={(event) =>
                          setQueue((items) =>
                            items.map((row) =>
                              row.skillId === item.skillId ? { ...row, answer: event.target.value } : row,
                            ),
                          )
                        }
                        className="h-8 w-full rounded-lg border border-white/10 bg-black/20 px-2 text-sm text-foreground outline-none focus-visible:border-primary"
                      />
                    ) : (
                      <p className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-sm text-muted-foreground">
                        {t("ingest.askFirst.recapFilledBySkill")}
                      </p>
                    )}
                  </label>
                ))}
                {kind === "ad" ? (
                  <p className="text-xs text-muted-foreground">{t("ingest.askFirst.adLockedLength")}</p>
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">
                      {t(kind === "novel" ? "ingest.askFirst.countNovel" : "ingest.askFirst.countDrama", {
                        count: count,
                      })}
                    </span>
                    {COUNT_PRESETS[kind].map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setCount(value)}
                        className={`h-8 rounded-full border px-3 text-sm ${count === value ? "border-primary bg-primary/15 text-primary" : "border-white/10"}`}
                      >
                        {value}
                      </button>
                    ))}
                    <input
                      value={count}
                      onChange={(event) => setCount(event.target.value.replace(/[^\d]/g, ""))}
                      inputMode="numeric"
                      aria-label={t("ingest.askFirst.recapCountLabel")}
                      className="h-8 w-16 rounded-lg border border-white/10 bg-black/20 px-2 text-center text-sm outline-none focus-visible:border-primary"
                    />
                  </div>
                )}
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => void askWrite(1)}
                    className="h-8 rounded-full bg-primary px-3 text-sm text-primary-foreground disabled:opacity-40"
                  >
                    {kind === "ad"
                      ? t("ingest.askFirst.writeAd")
                      : t("ingest.askFirst.writeFirst", { unit })}
                  </button>
                  <button
                    type="button"
                    onClick={() => resetQueue("skills")}
                    className="h-8 rounded-full border border-white/10 px-3 text-xs"
                  >
                    {t("ingest.askFirst.reselectSkills")}
                  </button>
                  <button
                    type="button"
                    onClick={() => resetQueue("kind")}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/10 px-3 text-xs"
                  >
                    <RotateCcw className="size-3.5" />
                    {t("ingest.askFirst.changeKind")}
                  </button>
                </div>
              </div>
            )}
            {active === "zero" && zeroStep === "chat" && writtenUnit > 0 && kind !== "ad" && (
              <button
                type="button"
                disabled={actionBusy}
                onClick={() =>
                  void askWrite(writtenUnit + 1, undefined, {
                    key: "ingest.askFirst.writeNextUser",
                    vars: { next: String(writtenUnit + 1), unit },
                  })
                }
                className="h-8 rounded-full bg-primary px-3 text-sm text-primary-foreground disabled:opacity-40"
              >
                {t("ingest.askFirst.writeNext", { next: writtenUnit + 1, unit })}
              </button>
            )}
            {active === "edit" && editStep === "chat" && (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">{t("ingest.askFirst.editTools")}</p>
                <OptionRow
                  items={[
                    {
                      title: t("ingest.askFirst.repair"),
                      detail: repairing
                        ? t("ingest.askFirst.repairing")
                        : hasWork
                          ? t("ingest.askFirst.repairRecheckHint")
                          : t("ingest.askFirst.repairHint"),
                      busy: repairing,
                      disabled: !hasManuscript || repairing || actionBusy,
                      onClick: () => {
                        if (onRepair) {
                          void runRepair();
                          return;
                        }
                        push("user", { key: "ingest.askFirst.repair" });
                        push("agent", { key: "ingest.askFirst.repairPending" });
                      },
                    },
                    {
                      title: t("ingest.askFirst.hook"),
                      detail: t("ingest.askFirst.hookHint"),
                      disabled: !canEditCurrentWork || actionBusy || repairing,
                      onClick: () => setHookStylesOpen((open) => !open),
                    },
                    {
                      title: t("ingest.askFirst.wash"),
                      detail: t("ingest.askFirst.washHint"),
                      disabled: !canEditCurrentWork || actionBusy || repairing,
                      onClick: () => void runManuscriptAction("wash"),
                    },
                    {
                      title: t("ingest.askFirst.cast"),
                      detail: t("ingest.askFirst.castHint"),
                      disabled: !canEditCurrentWork || actionBusy || repairing,
                      onClick: () => void runManuscriptAction("cast_preview"),
                    },
                    {
                      title: t("ingest.askFirst.gender"),
                      detail: t("ingest.askFirst.genderHint"),
                      disabled: !canEditCurrentWork || actionBusy || repairing,
                      onClick: () => void runManuscriptAction("gender_preview"),
                    },
                    {
                      title: t("ingest.askFirst.imitate"),
                      detail: t("ingest.askFirst.imitateHint"),
                      disabled: !canEditCurrentWork || actionBusy || repairing,
                      onClick: () => void runManuscriptAction("imitate"),
                    },
                    {
                      title: t("ingest.askFirst.adapt"),
                      detail: t("ingest.askFirst.adaptHint"),
                      disabled: !canEditCurrentWork || actionBusy || repairing,
                      onClick: () => void runManuscriptAction("adapt"),
                    },
                  ]}
                />
                {!canEditCurrentWork && (
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t("ingest.askFirst.actionsNeedWorkingCopy")}
                  </p>
                )}
                {hookStylesOpen && (
                  <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.025] p-3">
                    <p className="text-xs text-muted-foreground">{t("ingest.askFirst.chooseHookStyle")}</p>
                    <OptionRow
                      items={HOOK_STYLES.map((style) => ({
                        title: t(`ingest.askFirst.hookStyles.${style}`),
                        detail: t(`ingest.askFirst.hookStyleHints.${style}`),
                        disabled: actionBusy,
                        onClick: () => void runManuscriptAction("hook", style),
                      }))}
                    />
                  </div>
                )}
                {mappingAction && (
                  <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.025] p-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium">
                        {t(mappingAction === "cast" ? "ingest.askFirst.castMappingTitle" : "ingest.askFirst.genderMappingTitle")}
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setMappingAction(null);
                          setMappings([]);
                        }}
                        className="text-xs text-muted-foreground hover:text-foreground"
                      >
                        {t("common.cancel")}
                      </button>
                    </div>
                    <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
                      {mappings.map((row, index) => (
                        <div key={`${row.original}-${index}`} className="grid gap-2 rounded-lg border border-white/10 p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                          <div className="min-w-0">
                            {mappingAction === "gender" && (
                              <label className="mb-1 flex items-center gap-2 text-xs">
                                <input
                                  type="checkbox"
                                  checked={row.selected}
                                  onChange={(event) => updateMapping(index, { selected: event.target.checked })}
                                  disabled={actionBusy}
                                />
                                {t("ingest.askFirst.convertCharacter", { gender: t(`ingest.askFirst.genders.${row.gender}`) })}
                              </label>
                            )}
                            <p className="truncate text-sm font-medium">{row.original}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {row.aliases.length ? row.aliases.join("、") : t("ingest.askFirst.noAliases")}
                            </p>
                          </div>
                          <div className="grid gap-1.5">
                            <label className="text-xs text-muted-foreground">
                              {t("ingest.askFirst.suggestedName")}
                              <input
                                value={row.replacement}
                                onChange={(event) => updateMapping(index, { replacement: event.target.value })}
                                disabled={actionBusy}
                                className="mt-1 h-8 w-full rounded-lg border border-white/10 bg-black/20 px-2 text-sm text-foreground outline-none focus-visible:border-primary"
                              />
                            </label>
                            <label className="text-xs text-muted-foreground">
                              {t("ingest.askFirst.suggestedAliases")}
                              <input
                                value={row.replacement_aliases.join("，")}
                                onChange={(event) => updateMapping(index, {
                                  replacement_aliases: event.target.value.split(/[，,]/).map((item) => item.trim()).filter(Boolean),
                                })}
                                disabled={actionBusy}
                                className="mt-1 h-8 w-full rounded-lg border border-white/10 bg-black/20 px-2 text-sm text-foreground outline-none focus-visible:border-primary"
                              />
                            </label>
                          </div>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      disabled={actionBusy || (mappingAction === "gender" && !mappings.some((row) => row.selected && row.replacement.trim()))}
                      onClick={() => void runManuscriptAction(mappingAction === "cast" ? "cast_apply" : "gender_apply")}
                      className="h-8 rounded-full bg-primary px-3 text-sm text-primary-foreground disabled:opacity-40"
                    >
                      {mappingAction === "cast" ? t("ingest.askFirst.applyCast") : t("ingest.askFirst.applyGender")}
                    </button>
                  </div>
                )}
                {imitationDraft && (
                  <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.025] p-3">
                    <p className="text-sm font-medium">
                      {t(previewKind === "adapt" ? "ingest.askFirst.adaptPreviewTitle" : "ingest.askFirst.imitatePreviewTitle")}
                    </p>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {t(previewKind === "adapt" ? "ingest.askFirst.adaptPreviewHint" : "ingest.askFirst.imitatePreviewHint")}
                    </p>
                    <button
                      type="button"
                      disabled={imitationSaving || actionBusy}
                      onClick={() => void saveImitationDraft()}
                      className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/10 px-3 text-xs hover:border-white/20 disabled:opacity-40"
                    >
                      {imitationSaving && <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />}
                      {t("ingest.askFirst.saveImitation")}
                    </button>
                  </div>
                )}
              </div>
            )}
            {step === "chat" && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">{t("ingest.askFirst.thinkingLabel")}</p>
                <div className="flex flex-wrap gap-1.5">
                  {THINKING_EFFORTS.map((effort) => (
                    <button
                      key={effort}
                      type="button"
                      aria-pressed={thinking === effort}
                      disabled={repairing || actionBusy}
                      onClick={() => setThinking(effort)}
                      className={`h-8 rounded-full border px-3 text-sm disabled:opacity-40 ${thinking === effort ? "border-primary bg-primary/15 text-primary" : "border-white/10"}`}
                    >
                      {t(`ingest.askFirst.thinking.${effort}`)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {step === "chat" && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  send();
                }}
                className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.022]"
              >
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  rows={2}
                  placeholder={t("ingest.askFirst.placeholderChat")}
                  className="min-h-14 w-full resize-none bg-transparent px-4 py-3 text-sm leading-6 outline-none placeholder:text-muted-foreground/70"
                />
                <div className="flex justify-end px-3 py-2">
                  <button
                    type="submit"
                    disabled={!draft.trim()}
                    aria-label={t("ingest.askFirst.send")}
                    className="flex size-8 items-center justify-center rounded-full bg-white text-black disabled:bg-white/30 disabled:text-black/45"
                  >
                    <ArrowUp className="size-[18px]" />
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
        {hasWork && (
          <aside className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-sm font-medium">{t("ingest.askFirst.outline")}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("ingest.askFirst.outlineNote")}</p>
          </aside>
        )}
      </div>
    </section>
  );
}

function Choice({
  title,
  detail,
  onClick,
  disabled = false,
}: {
  title: string;
  detail: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-xl border border-white/10 px-4 py-3 text-left hover:border-white/20 disabled:opacity-40"
    >
      <span className="block text-sm font-medium">{title}</span>
      <span className="mt-1 block text-xs leading-5 text-muted-foreground">{detail}</span>
    </button>
  );
}

function OptionRow({
  items,
}: {
  items: Array<{
    title: string;
    detail: string;
    onClick?: () => void;
    disabled?: boolean;
    active?: boolean;
    busy?: boolean;
  }>;
}) {
  const [hint, setHint] = useState("");
  const shown =
    hint ||
    items.find((item) => item.active)?.detail ||
    items.find((item) => !item.disabled)?.detail ||
    items[0]?.detail ||
    "";
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span key={item.title} className="inline-flex" onMouseEnter={() => setHint(item.detail)}>
            <button
              type="button"
              disabled={item.disabled}
              aria-pressed={item.active}
              onFocus={() => setHint(item.detail)}
              onClick={item.onClick}
              className={`inline-flex h-8 items-center rounded-full border px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-40 ${item.active ? "border-primary bg-primary/15 text-primary" : "border-white/10"}`}
            >
              {item.busy && (
                <Loader2 className="mr-1.5 size-3.5 animate-spin motion-reduce:animate-none" />
              )}
              {item.title}
            </button>
          </span>
        ))}
      </div>
      <p className="mt-2 min-h-5 text-xs leading-5 text-muted-foreground">{shown}</p>
    </div>
  );
}
