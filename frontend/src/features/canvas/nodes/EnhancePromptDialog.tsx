// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  FreezonePromptDialect,
  FreezonePromptStrength,
} from "@/api/ops";

const STRENGTHS: FreezonePromptStrength[] = [
  "conservative",
  "standard",
  "aggressive",
];

/**
 * 方言显示名。模型名保持原文不翻译——创作者点名的就是执行端上的那个模型，
 * 译成中文反而对不上。
 */
const DIALECT_LABELS: Record<FreezonePromptDialect, string> = {
  image: "Image · 通用图片",
  "audio-music": "Audio · 音乐",
  "video-generic": "Video · 通用视频",
  "seedance-2.0": "Seedance 2.0",
  "seedance-2.5": "Seedance 2.5",
  "minimax-h3": "MiniMax H3",
  "agnes-2.5": "Agnes Video 2.5",
};

export interface EnhancePromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 可选方言。图片节点只给 image，视频节点给视频侧那几套。 */
  dialects: FreezonePromptDialect[];
  defaultDialect: FreezonePromptDialect;
  /** 强化请求进行中：禁用重复提交。 */
  busy?: boolean;
  onConfirm: (
    dialect: FreezonePromptDialect,
    strength: FreezonePromptStrength,
  ) => void;
}

function ChoiceButton({
  active,
  label,
  hint,
  onClick,
}: {
  active: boolean;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        active
          ? "rounded-[6px] border border-primary/60 bg-primary/12 px-2.5 py-1.5 text-left text-xs text-text-dark"
          : "rounded-[6px] border border-white/12 bg-white/[0.04] px-2.5 py-1.5 text-left text-xs text-text-dark/80 transition-colors hover:border-white/25 hover:bg-white/[0.08]"
      }
    >
      <span className="block font-medium">{label}</span>
      {hint && (
        <span className="mt-0.5 block text-[11px] text-text-muted/90">{hint}</span>
      )}
    </button>
  );
}

export function EnhancePromptDialog({
  open,
  onOpenChange,
  dialects,
  defaultDialect,
  busy = false,
  onConfirm,
}: EnhancePromptDialogProps) {
  const { t } = useTranslation();
  const [dialect, setDialect] = useState<FreezonePromptDialect>(defaultDialect);
  const [strength, setStrength] = useState<FreezonePromptStrength>("standard");

  // 每次打开都回到调用方给的默认方言：节点可能刚换了目标模型，沿用上一次的选择
  // 会静默套错方言，而套错方言产出的正文执行端读不懂。
  useEffect(() => {
    if (open) setDialect(defaultDialect);
  }, [open, defaultDialect]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t("node.promptEnhance.title")}</DialogTitle>
          <DialogDescription>
            {t("node.promptEnhance.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <section>
            <div className="mb-1.5 text-xs font-semibold text-text-dark/72">
              {t("node.promptEnhance.dialect")}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {dialects.map((value) => (
                <ChoiceButton
                  key={value}
                  active={value === dialect}
                  label={DIALECT_LABELS[value]}
                  onClick={() => setDialect(value)}
                />
              ))}
            </div>
          </section>

          <section>
            <div className="mb-1.5 text-xs font-semibold text-text-dark/72">
              {t("node.promptEnhance.strength")}
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {STRENGTHS.map((value) => (
                <ChoiceButton
                  key={value}
                  active={value === strength}
                  label={t(`node.promptEnhance.strengthOption.${value}`)}
                  hint={t(`node.promptEnhance.strengthHint.${value}`)}
                  onClick={() => setStrength(value)}
                />
              ))}
            </div>
          </section>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t("node.promptEnhance.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onConfirm(dialect, strength)}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {t("node.promptEnhance.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
