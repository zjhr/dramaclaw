// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ReactNode } from "react";

import {
  LOOK_ACCESSORIES,
  LOOK_BODIES,
  LOOK_CLOTHING,
  LOOK_EYEBROWS,
  LOOK_EYES,
  LOOK_FACE_SHAPES,
  LOOK_HAIR,
  LOOK_LIPS,
  LOOK_MAKEUP,
  LOOK_NOSES,
  LOOK_STYLES,
} from "@/features/canvas/domain/identityLookCatalog";
import { cn } from "@/lib/utils";

export type VisualOption = {
  id: string;
  glyph?: ReactNode;
  image?: string;
  label?: string;
};

function Frame({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 48 48" className="size-8" aria-hidden>
      {children}
    </svg>
  );
}

function bodyGlyph(kind: "slim" | "regular" | "tall" | "small" | "full" | "strong") {
  const shoulder = kind === "strong" ? 18 : kind === "slim" ? 8 : kind === "full" ? 14 : 11;
  const hip = kind === "full" ? 16 : kind === "slim" ? 7 : kind === "strong" ? 12 : 10;
  const height = kind === "tall" ? 30 : kind === "small" ? 20 : 26;
  const y = 46 - height;
  return (
    <Frame>
      <circle cx="24" cy={y - 4} r="4" fill="currentColor" />
      <path
        d={`M${24 - shoulder} ${y + 4} Q24 ${y} ${24 + shoulder} ${y + 4} L${24 + hip} 44 Q24 46 ${24 - hip} 44 Z`}
        fill="currentColor"
      />
    </Frame>
  );
}

function faceGlyph(kind: "oval" | "round" | "square" | "heart") {
  const d =
    kind === "round"
      ? "M24 8 a12 14 0 1 0 0.1 0"
      : kind === "square"
        ? "M14 12 h20 v22 a4 4 0 0 1 -4 4 h-12 a4 4 0 0 1 -4 -4 Z"
        : kind === "heart"
          ? "M24 40 C12 30 10 18 18 14 C22 12 24 16 24 16 C24 16 26 12 30 14 C38 18 36 30 24 40 Z"
          : "M24 8 C16 8 12 16 12 24 C12 34 17 40 24 40 C31 40 36 34 36 24 C36 16 32 8 24 8 Z";
  return (
    <Frame>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2" />
    </Frame>
  );
}

function eyeGlyph(kind: "almond" | "round" | "phoenix" | "narrow") {
  const d =
    kind === "round"
      ? "M8 24 h10 a5 5 0 1 0 0.1 0 M30 24 h10 a5 5 0 1 0 0.1 0"
      : kind === "phoenix"
        ? "M6 28 Q16 16 26 24 M22 24 Q32 16 42 28"
        : kind === "narrow"
          ? "M6 24 H22 M26 24 H42"
          : "M6 24 Q16 16 26 24 Q16 32 6 24 M22 24 Q32 16 42 24 Q32 32 22 24";
  return (
    <Frame>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2" />
    </Frame>
  );
}

function hairGlyph(kind: "long" | "short" | "pony" | "curl" | "bun" | "bald") {
  if (kind === "bald") {
    return (
      <Frame>
        <circle cx="24" cy="26" r="12" fill="none" stroke="currentColor" strokeWidth="2" />
      </Frame>
    );
  }
  return (
    <Frame>
      <circle cx="24" cy="22" r="8" fill="currentColor" />
      {kind === "long" ? <path d="M16 24 v16 M32 24 v16" stroke="currentColor" strokeWidth="3" /> : null}
      {kind === "pony" ? <path d="M30 16 q10 8 4 18" fill="none" stroke="currentColor" strokeWidth="3" /> : null}
      {kind === "curl" ? <path d="M14 28 q-6 8 2 12 M34 28 q6 8 -2 12" fill="none" stroke="currentColor" strokeWidth="2" /> : null}
      {kind === "bun" ? <circle cx="24" cy="10" r="4" fill="currentColor" /> : null}
    </Frame>
  );
}

function swatch(color: string, mark?: "lip" | "smoke" | "scratch") {
  return (
    <Frame>
      <circle cx="24" cy="24" r="14" fill={color} />
      {mark === "lip" ? <path d="M16 28 Q24 34 32 28" fill="none" stroke="#9f1239" strokeWidth="2" /> : null}
      {mark === "smoke" ? <path d="M14 20 H22 M26 20 H34" stroke="#111" strokeWidth="3" /> : null}
      {mark === "scratch" ? <path d="M16 16 L30 32" stroke="#7f1d1d" strokeWidth="2" /> : null}
    </Frame>
  );
}

function clothGlyph(kind: "shirt" | "suit" | "dress" | "school" | "hanfu" | "armor") {
  const d =
    kind === "dress"
      ? "M16 14 L24 20 L32 14 L38 40 H10 Z"
      : kind === "hanfu"
        ? "M12 16 H36 L32 40 H16 Z M20 16 v24 M28 16 v24"
        : kind === "armor"
          ? "M14 16 H34 V28 H30 V40 H18 V28 H14 Z"
          : kind === "school"
            ? "M16 16 H32 L36 40 H12 Z M24 16 v24"
            : kind === "suit"
              ? "M14 16 L24 24 L34 16 V40 H14 Z"
              : "M16 18 H32 L34 40 H14 Z";
  return (
    <Frame>
      <path d={d} fill="currentColor" />
    </Frame>
  );
}

export function genderGlyph(kind: "男" | "女") {
  return (
    <Frame>
      <circle cx="24" cy="16" r="6" fill="currentColor" />
      {kind === "女" ? (
        <path d="M18 24 H30 L34 42 H14 Z" fill="currentColor" />
      ) : (
        <path d="M18 24 H30 V34 H34 V38 H30 V42 H18 V38 H14 V34 H18 Z" fill="currentColor" />
      )}
    </Frame>
  );
}

export function ageGlyph(kind: "child" | "youth" | "middle" | "elder") {
  const height = kind === "child" ? 16 : kind === "elder" ? 22 : kind === "youth" ? 26 : 24;
  return (
    <Frame>
      <circle cx="24" cy={40 - height} r={kind === "child" ? 4 : 5} fill="currentColor" />
      <path d={`M20 ${44 - height} H28 V42 H20 Z`} fill="currentColor" />
    </Frame>
  );
}

const BODY_KIND = {
  纤细: "slim",
  标准: "regular",
  高挑: "tall",
  娇小: "small",
  丰满: "full",
  壮实: "strong",
  瘦高: "tall",
  少年: "small",
  儿童: "small",
  老年: "regular",
} as const;

const FACE_KIND = {
  鹅蛋脸: "oval",
  圆脸: "round",
  方脸: "square",
  长脸: "oval",
  瓜子脸: "heart",
  菱形脸: "heart",
} as const;

const EYE_KIND = {
  杏眼: "almond",
  圆眼: "round",
  丹凤眼: "phoenix",
  细长眼: "narrow",
  下垂眼: "almond",
  双眼皮: "round",
  单眼皮: "narrow",
} as const;

const HAIR_KIND = {
  黑长直: "long",
  黑短发: "short",
  长卷发: "curl",
  波浪卷: "curl",
  马尾: "pony",
  双马尾: "pony",
  丸子头: "bun",
  寸头: "short",
  中分: "long",
  侧分: "long",
  齐刘海: "short",
  盘发: "bun",
  白发: "long",
  金发: "long",
  棕发: "curl",
  红发: "long",
  银发: "short",
  光头: "bald",
} as const;

const CLOTH_KIND = ["shirt", "suit", "dress", "school", "hanfu", "armor"] as const;

function photos(folder: string, ids: readonly string[]): VisualOption[] {
  return ids.map((id) => ({
    id,
    image: `/look-options/${folder}/${encodeURIComponent(id)}.jpg`,
  }));
}

export const VISUAL_BODY = photos("body", LOOK_BODIES);
export const VISUAL_FACE = photos("face", LOOK_FACE_SHAPES);
export const VISUAL_EYES = photos("eyes", LOOK_EYES);
export const VISUAL_EYEBROWS = photos("brows", LOOK_EYEBROWS);
export const VISUAL_NOSE = photos("nose", LOOK_NOSES);
export const VISUAL_LIPS = photos("lips", LOOK_LIPS);
export const VISUAL_HAIR = photos("hair", LOOK_HAIR);
export const VISUAL_MAKEUP = photos("makeup", LOOK_MAKEUP);
export const VISUAL_CLOTHING = photos("clothing", LOOK_CLOTHING);
export const VISUAL_ACCESSORIES = photos("accessories", LOOK_ACCESSORIES);
export const VISUAL_STYLE = photos("style", LOOK_STYLES);
export const VISUAL_EXPRESSION = photos("expression", [
  "平静",
  "微笑",
  "大笑",
  "愤怒",
  "悲伤",
  "哭泣",
  "震惊",
  "恐惧",
  "冷笑",
] as const);

export function VisualPick({
  label,
  options,
  selected,
  onPick,
  light = false,
  multiple = false,
}: {
  label: string;
  options: VisualOption[];
  selected: string | string[];
  onPick: (id: string) => void;
  light?: boolean;
  multiple?: boolean;
}) {
  const chosen = Array.isArray(selected) ? selected : selected ? [selected] : [];
  return (
    <div>
      <div className={cn("mb-2 text-sm", light ? "text-neutral-500" : "text-muted-foreground")}>{label}</div>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const active = chosen.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={active}
              onClick={() => onPick(option.id)}
              className={cn(
                "flex w-[4.5rem] flex-col items-center gap-1 rounded-xl px-1 py-1.5 text-xs",
                light
                  ? active
                    ? "bg-neutral-900 text-white"
                    : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
                  : active
                    ? "bg-white text-neutral-900"
                    : "bg-white/5 text-foreground hover:bg-white/10",
              )}
            >
              {option.image ? (
                <img
                  src={option.image}
                  alt=""
                  className="aspect-square w-14 shrink-0 rounded-lg object-cover object-center"
                />
              ) : (
                option.glyph
              )}
              <span className="leading-4">{option.label ?? option.id}</span>
            </button>
          );
        })}
      </div>
      {multiple ? null : null}
    </div>
  );
}

export function composeCharacterFace(parts: {
  face: string;
  eyes: string;
  hair: string;
  makeup: string;
  expression: string;
}): string {
  return [
    parts.face ? `脸型：${parts.face}` : "",
    parts.eyes ? `眼睛：${parts.eyes}` : "",
    parts.hair ? `发型：${parts.hair}` : "",
    parts.makeup ? `妆容：${parts.makeup}` : "",
    parts.expression ? `表情：${parts.expression}` : "",
  ]
    .filter(Boolean)
    .join("；");
}

export function parseCharacterFace(text: string): {
  face: string;
  eyes: string;
  hair: string;
  makeup: string;
  expression: string;
  custom: boolean;
} {
  const face = text.match(/脸型：([^；]+)/)?.[1] ?? "";
  const eyes = text.match(/眼睛：([^；]+)/)?.[1] ?? "";
  const hair = text.match(/发型：([^；]+)/)?.[1] ?? "";
  const makeup = text.match(/妆容：([^；]+)/)?.[1] ?? "";
  const expression = text.match(/表情：([^；]+)/)?.[1] ?? "";
  const known = composeCharacterFace({ face, eyes, hair, makeup, expression });
  return {
    face,
    eyes,
    hair,
    makeup,
    expression,
    custom: text.trim().length > 0 && text.trim() !== known,
  };
}
