// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslation } from "react-i18next";
import { useCanvasStore } from "@/stores/canvasStore";
import { extractUpstreamImages } from "@/features/canvas/application/graphImageResolver";
import type { CanvasNode } from "@/features/canvas/domain/canvasNodes";

/**
 * 画布图片总览：列出当前画布上所有能当参考素材的节点，点哪张加哪张。
 *
 * 刻意做成只读总览而不是「进画布点选」：画布目前是单选（store 只有
 * `selectedNodeId`，没有多选），要让「点图即加入」就得改画布的点击行为，
 * 那会连带影响选中、拖拽、框选的手感。总览只在弹窗里读 store，不碰画布交互。
 */
export interface CanvasImageOverviewProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (urls: string[]) => void;
  /** 已经选进参考素材的 URL：已在列表里的显示为已选，不重复计入。 */
  selectedUrls: string[];
  /** 还能再选几张；到顶后未选中的置灰。 */
  remaining: number;
}

interface PickableImage {
  nodeId: string;
  url: string;
  label: string;
}

export function CanvasImageOverview({
  open,
  onClose,
  onConfirm,
  selectedUrls,
  remaining,
}: CanvasImageOverviewProps) {
  const { t } = useTranslation();
  const nodes = useCanvasStore((state) => state.nodes);
  const [picked, setPicked] = useState<string[]>([]);

  // 打开时清掉上一次的临时选择：弹窗关掉就丢弃，不留半截状态。
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) setPicked([]);
  }

  const pickable = useMemo<PickableImage[]>(() => {
    const seen = new Set<string>();
    const out: PickableImage[] = [];
    for (const node of nodes) {
      for (const url of extractUpstreamImages(node as CanvasNode)) {
        if (seen.has(url)) continue;
        seen.add(url);
        out.push({
          nodeId: node.id,
          url,
          label: node.data?.displayName || t("nodeToolbar.video.continueReferenceUnnamed"),
        });
      }
    }
    return out;
  }, [nodes, t]);

  const alreadyPicked = new Set([...selectedUrls, ...picked]);
  const newCount = picked.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-[760px]"
        data-testid="video-continue-canvas-overview"
      >
        <DialogTitle className="flex flex-wrap items-center justify-between gap-3 pr-8">
          <span>{t("nodeToolbar.video.continueReferenceCanvasTitle")}</span>
          <span className="text-[12px] font-normal text-text-dim">
            {t("nodeToolbar.video.continueReferenceCanvasCount", {
              count: newCount,
              max: remaining,
            })}
          </span>
        </DialogTitle>

        {pickable.length === 0 ? (
          <p className="rounded-md border border-white/10 bg-white/5 px-3 py-4 text-[12px] text-text-dim">
            {t("nodeToolbar.video.continueReferenceCanvasEmpty")}
          </p>
        ) : (
          <div className="grid max-h-[52vh] grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-5">
            {pickable.map((item) => {
              const inList = alreadyPicked.has(item.url);
              const disabled = !inList && newCount >= remaining;
              return (
                <button
                  key={item.url}
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    setPicked((prev) =>
                      prev.includes(item.url)
                        ? prev.filter((url) => url !== item.url)
                        : [...prev, item.url],
                    )
                  }
                  className={`group relative overflow-hidden rounded-md border text-left transition-colors ${
                    inList
                      ? "border-cyan-300/60"
                      : "border-white/12 hover:border-white/30"
                  } disabled:cursor-not-allowed disabled:opacity-40`}
                  data-testid="video-continue-canvas-image"
                >
                  <img
                    src={item.url}
                    alt={item.label}
                    className="aspect-square w-full object-cover"
                  />
                  <span className="block truncate px-1.5 py-1 text-[12px] text-text-dim">
                    {item.label}
                  </span>
                  {inList && (
                    <span className="absolute right-1 top-1 rounded-full bg-cyan-400/90 px-1.5 py-[1px] text-[12px] text-black">
                      {t("nodeToolbar.video.continueReferencePicked")}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/15 px-3 py-1 text-[12px] text-text-main transition-colors hover:bg-white/10"
          >
            {t("nodeToolbar.video.continueCancel")}
          </button>
          <button
            type="button"
            disabled={newCount === 0}
            onClick={() => {
              onConfirm(picked);
              onClose();
            }}
            className="rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[12px] text-text-main transition-colors hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="video-continue-canvas-confirm"
          >
            {t("nodeToolbar.video.continueReferenceCanvasConfirm", {
              count: newCount,
            })}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
