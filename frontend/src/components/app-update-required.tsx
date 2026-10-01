// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  attemptAutomaticChunkReload,
  forceChunkReload,
  navigateToProjectList,
} from "@/lib/chunk-load-recovery";

export function AppUpdateRequired() {
  const { t } = useTranslation();

  useEffect(() => {
    if (!attemptAutomaticChunkReload()) navigateToProjectList();
  }, []);

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-background/92 px-6 text-foreground backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-white/[0.045] p-8 text-center shadow-2xl shadow-black/30">
        <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-full bg-primary/15 text-xl text-primary">
          <RefreshCw className="size-6" aria-hidden="true" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">
          {t("app.updateRequired.title")}
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {t("app.updateRequired.description")}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            className="inline-flex h-10 items-center justify-center rounded-lg border border-white/15 px-5 text-sm font-medium text-foreground transition hover:bg-white/[0.08]"
            onClick={() => navigateToProjectList()}
          >
            {t("app.updateRequired.projects")}
          </button>
          <button
            type="button"
            className="inline-flex h-10 items-center justify-center rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
            onClick={forceChunkReload}
          >
            {t("app.updateRequired.refresh")}
          </button>
        </div>
      </div>
    </div>
  );
}
