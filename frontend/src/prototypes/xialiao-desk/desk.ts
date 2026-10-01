// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

import { useEffect, useState } from "react";

export const HOOKS = ["通用", "反转", "反差", "铺垫", "设定", "主题"] as const;
export type HookId = (typeof HOOKS)[number];

export const SOURCE = {
  file: "夜雨归人.txt",
  title: "夜雨归人",
  project: "精品剧",
  paragraphs: [
    "第1章 雨夜",
    "林晚推开巷口的木门时，雨水已经顺着发梢滴进衣领。柜台后的人抬起头，看了她一眼，又低下去擦杯子。",
    "「还是老位置。」她说。",
    "那人把一杯热茶推过来。「三年了，你还是这句。」",
    "林晚握住杯子，指节发白。「我回来，不是为了喝茶。」",
    "门外有人踩灭了一支烟。火光灭掉的瞬间，巷子里只剩下雨。",
  ],
};

const HOOK_OPENING: Record<HookId, string> = {
  通用: "△ 三年没进这扇门的人，推门时雨水先落在柜台上。店主擦杯子的手停了一停。",
  反转: "△ 全巷子都说林晚不会再回来。木门一开，雨水先落进门槛，她站在原处。",
  反差: "△ 林晚把伞收得极稳，衣领却已经湿透。店主抬头，又立刻低下去。",
  铺垫: "△ 茶是热的，门是旧的。林晚进门时，雨水还挂在她没说出口的那句话上。",
  设定: "△ 这家茶馆只认老位置。林晚推门进来，店主已经把杯子转正。",
  主题: "△ 她回来的第一件事不是坐下。雨水滴进衣领，木门在她身后合上。",
};

export const SKILL_GROUPS = [
  {
    label: "写法",
    items: ["默认通用", "剧情反转", "勾人反差", "情绪牵引", "爆点澎湃", "设定结构", "穿越重生", "深挖仿写", "洗稿", "改性格", "换角色"],
  },
] as const;

export type SkillName = (typeof SKILL_GROUPS)[number]["items"][number];

export type ZeroKind = "短剧" | "小说";

export interface ZeroBrief {
  kind: ZeroKind;
  premise: string;
  lead: string;
  count: string;
}

const EMPTY_NAMES = { 林晚: "", 店主: "" };

export function useDesk() {
  const [mode, setMode] = useState<"edit" | "zero">("edit");
  const [status, setStatus] = useState<
    "blocked" | "repairing" | "ready" | "importing" | "imported"
  >("blocked");
  const [hook, setHook] = useState<HookId | null>(null);
  const [hookOpen, setHookOpen] = useState(false);
  const [washed, setWashed] = useState(false);
  const [names, setNames] = useState(EMPTY_NAMES);
  const [appliedNames, setAppliedNames] = useState(EMPTY_NAMES);
  const [castOpen, setCastOpen] = useState(false);
  const [dirtyOld, setDirtyOld] = useState(false);
  const [extra, setExtra] = useState(false);
  const [appended, setAppended] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [brief, setBrief] = useState<ZeroBrief>({
    kind: "短剧",
    premise: "雨夜回到旧茶馆，把三年前没问完的那句话问完",
    lead: "林晚",
    count: "8",
  });
  const [zeroStep, setZeroStep] = useState<"brief" | "draft">("brief");
  const [hasWork, setHasWork] = useState(false);
  const [skills, setSkills] = useState<SkillName[]>(["剧情反转"]);
  const [projectType, setProjectType] = useState<"精品剧" | "解说剧">("精品剧");
  const [pendingType, setPendingType] = useState<"精品剧" | "解说剧" | null>(null);
  const [promoted, setPromoted] = useState(false);
  const [gender, setGender] = useState({ 林晚: false, 店主: false });
  const [appliedGender, setAppliedGender] = useState({ 林晚: false, 店主: false });
  const [genderOpen, setGenderOpen] = useState(false);
  const [imitation, setImitation] = useState<string | null>(null);
  const [imitationSaved, setImitationSaved] = useState(false);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    if (status !== "repairing") return;
    const timer = window.setTimeout(() => {
      setHasWork(true);
      setStatus("ready");
    }, 640);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    if (status !== "importing") return;
    const timer = window.setTimeout(() => {
      setStatus("imported");
      setNotice(
        mode === "zero"
          ? "已导入第 1 集。后面的集写完后用追加，不重建已有结果。"
          : "已用工作稿开始导入。原文件夜雨归人.txt 仍留在列表里。",
      );
    }, 700);
    return () => window.clearTimeout(timer);
  }, [mode, status]);

  const displayName = (name: "林晚" | "店主") => {
    if (name === "林晚" && appliedGender.林晚) return appliedNames.林晚.trim() || "林晏";
    if (name === "店主" && appliedGender.店主) return appliedNames.店主.trim() || "店主娘";
    return appliedNames[name].trim() || name;
  };

  const repairedLines = () => {
    const lead = displayName("林晚");
    const host = displayName("店主");
    const wash = (line: string) =>
      washed
        ? line
            .replace("还是老位置", "位子还是原来那个")
            .replace("我回来，不是为了喝茶", "我这次回来，茶不是目的")
            .replace("三年了，你还是这句", "都三年了，开口还是这一句")
        : line;
    const opening = (
      hook != null
        ? HOOK_OPENING[hook]
        : "△ 林晚推开木门，雨水顺着发梢滴进衣领。店主抬眼，又低下去擦杯子。"
    ).split("林晚").join(lead).split("店主").join(host);
    if (projectType === "解说剧" && !promoted) {
      return [
        "第1章 雨夜",
        "",
        `${lead}推开巷口的木门，雨水顺着发梢滴进衣领。${host}抬眼，又低下去擦杯子。`,
        "",
        wash(`${lead}说，还是老位置。${host}把热茶推过来，说三年了，开口还是这一句。`),
        "",
        wash(`${lead}握住杯子。我回来，不是为了喝茶。门外有人踩灭了一支烟。`),
        ...(extra ? ["", "第2章", "", `${lead}停在熄掉的烟旁，没有回头。`] : []),
      ];
    }
    const episodeTwo = extra
      ? [
          "",
          "第2集",
          "",
          "茶馆柜台 夜 内",
          `人物：${lead}、${host}`,
          "",
          "△ 热茶的白气挡住了半张脸。门外的烟已经灭了。",
          "",
          `${lead}：门外那个人，是你让他等的。`,
          "",
          `${host}：我只负责把杯子转正。`,
        ]
      : [];
    return [
      "第1集",
      "",
      "巷口木门 夜 内",
      `人物：${lead}、${host}`,
      "",
      opening,
      "",
      wash(`${lead}：还是老位置。`),
      "",
      wash(`${host}：三年了，你还是这句。`),
      "",
      `△ ${lead}握住杯子，指节发白。`,
      "",
      wash(`${lead}：我回来，不是为了喝茶。`),
      "",
      "巷口 夜 外",
      `人物：${lead}`,
      "",
      dirtyOld
        ? "△ 门外那支烟被踩灭。这一句是后来改的，旧集正文已经和导入时不同。"
        : "△ 门外有人踩灭一支烟。火光灭掉，巷子里只剩下雨。",
      ...episodeTwo,
    ];
  };

  const hasSkill = (name: SkillName) => skills.includes(name);
  const zeroLines = () => {
    const lead = brief.lead.trim() || "林晚";
    const premise = brief.premise.trim() || "把没问完的那句话问完";
    const twist = hasSkill("剧情反转") || hasSkill("爆点澎湃");
    const contrast = hasSkill("勾人反差");
    const wash = hasSkill("洗稿");
    const opening = twist
      ? `全巷子都说${lead}不会再回来。${premise}。`
      : contrast
        ? `${lead}把伞收得很稳，衣领却湿透了。${premise}。`
        : `${lead}走进旧茶馆。${premise}。`;
    const picture = "杯子里的热气升起来。";
    const spoken = wash ? "位子还是原来那个。我把那句话带来了。" : "我把那句话带来了。";
    if (brief.kind === "小说") {
      return [
        "第1章",
        "",
        `${opening}${picture}屋里没有人先开口。`,
        "",
        `${lead}坐下时才发现杯子是热的。有人知道她会在这个雨夜回来。`,
        "",
        `她说：「${spoken}」`,
      ];
    }
    const more = extra
      ? ["", "第2集", "", "旧巷 夜 外", `人物：${lead}`, "", `△ ${lead}停在熄掉的烟旁，没有回头。`]
      : [];
    return [
      "第1集",
      "",
      "旧茶馆 夜 内",
      `人物：${lead}`,
      "",
      `△ ${opening}${picture}`,
      "",
      `${lead}：${spoken}`,
      "",
      "△ 门外有人把烟踩灭。",
      ...more,
    ];
  };
  const skillNote =
    skills.length === 0
      ? "还没选参考技能。这一章只按四项来写。"
      : `这一章用了 ${skills.join("、")}。文件仍是${brief.kind === "小说" ? "小说章节" : "短剧场次稿"}。`;

  const canImport =
    (mode === "edit" && hasWork && status !== "importing" && status !== "imported") ||
    (mode === "zero" && zeroStep === "draft" && status !== "importing" && status !== "imported");

  const canAppend =
    status === "imported" && extra && !dirtyOld && !appended;

  const appendStop =
    status === "imported" && extra && dirtyOld
      ? "旧集正文和导入时不同，追加已停。要更新旧集，用重新导入。"
      : null;

  return {
    mode,
    status,
    hook,
    hookOpen,
    washed,
    names,
    castOpen,
    dirtyOld,
    extra,
    appended,
    notice,
    brief,
    zeroStep,
    hasWork,
    projectType,
    pendingType,
    promoted,
    gender,
    genderOpen,
    imitation,
    imitationSaved,
    showSource,
    skills,
    skillNote,
    toggleSkill: (name: SkillName) => {
      setSkills((current) =>
        current.includes(name) ? current.filter((item) => item !== name) : [...current, name],
      );
    },
    setMode: (next: "edit" | "zero") => {
      setMode(next);
      setNotice(null);
      setHookOpen(false);
      setCastOpen(false);
    },
    setBrief,
    setNames,
    setHookOpen,
    setCastOpen,
    setGender,
    setGenderOpen,
    setShowSource,
    setProjectType: (next: "精品剧" | "解说剧") => {
      if (next === projectType) return;
      if (hasWork || status === "imported") {
        setPendingType(next);
        return;
      }
      setProjectType(next);
    },
    confirmType: () => {
      if (!pendingType) return;
      setProjectType(pendingType);
      setPendingType(null);
      setNotice(`项目类型已改成${pendingType}。这次会按新类型重新导入。`);
    },
    cancelType: () => setPendingType(null),
    applyGender: () => {
      setAppliedGender(gender);
      setGenderOpen(false);
      setNotice("已按对照表改了勾选的人，没勾的保持原样。场景头里的地点没动。");
    },
    imitate: () => {
      setImitation("雨夜的边境哨站。林晚推开铁门，热茶换成了一盏将灭的灯。她还是那句：我回来，不是为了喝茶。");
      setImitationSaved(false);
      setNotice("深挖仿写另成一篇，还没进文件列表，也不会开始导入。");
    },
    saveImitation: () => {
      setImitationSaved(true);
      setNotice("仿写已存成新文件，不覆盖夜雨归人.txt，也没有开始导入。");
    },
    promoteDrama: () => {
      setPromoted(true);
      setProjectType("精品剧");
      setHasWork(true);
      setStatus("ready");
      setNotice("已收成精品剧场次稿。确认后会把项目类型改成精品剧并开始导入。");
    },
    repair: () => {
      if (status !== "blocked") return;
      setStatus("repairing");
      setNotice(null);
    },
    chooseHook: (id: HookId) => {
      setHook(id);
      setHookOpen(false);
      setNotice(`爆款开头已换成「${id}」，只动了第一场的写法。`);
    },
    wash: () => {
      setWashed(true);
      setNotice("洗稿只改了对白的说法，场景头和人名没动。");
    },
    applyCast: () => {
      setAppliedNames(names);
      setCastOpen(false);
      setNotice("已按对照表替换填了新名的角色，空着的名字保持原样。");
    },
    startImport: () => {
      if (!canImport) return;
      setStatus("importing");
      setNotice(null);
    },
    writeFirst: () => {
      if (!brief.premise.trim() || !brief.lead.trim() || !brief.count.trim()) return;
      setZeroStep("draft");
      setStatus("ready");
      setExtra(false);
      setDirtyOld(false);
      setAppended(false);
      setNotice(null);
    },
    writeNext: () => {
      if (status !== "imported") return;
      setExtra(true);
      setNotice("新的一集已写进同一份文件。已有的集没有改。");
    },
    append: () => {
      if (!canAppend) return;
      setAppended(true);
      setNotice("已追加新的一集。已做好的集、角色和视频保持原样。");
    },
    markDirty: () => setDirtyOld(true),
    repairedLines,
    zeroLines,
    canImport,
    canAppend,
    appendStop,
  };
}

export type Desk = ReturnType<typeof useDesk>;
