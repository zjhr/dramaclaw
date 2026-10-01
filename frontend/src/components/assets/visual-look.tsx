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
