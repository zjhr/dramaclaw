// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

import { useIdentityLooks, type IdentityLookRow } from "@/lib/queries/characters";
import {
  planIdentityCall,
  type IdentityCallNote,
  type IdentityCallSelection,
  type IdentityLookAsset,
} from "@/features/canvas/domain/identityCallPlan";

function toAsset(row: IdentityLookRow): IdentityLookAsset {
  return {
    characterName: row.character_name,
    identityId: row.identity_id,
    identityName: row.identity_name,
    faceUrl: row.face_url || "",
    threeViewUrl: row.three_view_url || "",
    expressionGridUrl: row.expression_grid_url || "",
    voiceUrl: row.voice_url || "",
  };
}

function noteText(t: (key: string, options?: Record<string, unknown>) => string, note: IdentityCallNote): string {
  switch (note.code) {
    case "modeNoImage":
      return t("node.identityCall.modeNoImage");
    case "modeNoAudio":
      return t("node.identityCall.modeNoAudio");
    case "missingFace":
      return t("node.identityCall.missingFace", { name: note.name });
    case "droppedFace":
      return t("node.identityCall.droppedFace", { name: note.name });
    case "missingThreeView":
      return t("node.identityCall.missingThreeView", { name: note.name });
    case "droppedThreeView":
      return t("node.identityCall.droppedThreeView", { name: note.name });
    case "missingGrid":
      return t("node.identityCall.missingGrid", { name: note.name });
    case "droppedGrid":
      return t("node.identityCall.droppedGrid", { name: note.name });
    case "missingVoice":
      return t("node.identityCall.missingVoice", { name: note.name });
    case "droppedVoice":
      return t("node.identityCall.droppedVoice", { name: note.name });
    case "reshootKeepsFrames":
      return t("node.identityCall.reshootKeepsFrames");
  }
}

export function IdentityCallPanel({
  project,
  selected,
  imageCap,
  audioCap,
  onChange,
  onClose,
}: {
  project: string;
  selected: IdentityCallSelection[];
  imageCap: number | null;
  audioCap: number | null;
  onChange: (next: IdentityCallSelection[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const looks = useIdentityLooks(project, true);
  const rows = looks.data?.ok ? looks.data.data : [];
  const assets = useMemo(() => rows.map(toAsset), [rows]);
  const plan = useMemo(
    () => planIdentityCall(selected, assets, imageCap, audioCap),
    [assets, audioCap, imageCap, selected],
  );

  const toggle = (row: IdentityLookRow) => {
    const exists = selected.some(
      (item) => item.characterName === row.character_name && item.identityId === row.identity_id,
    );
    if (exists) {
      onChange(
        selected.filter(
          (item) =>
            !(item.characterName === row.character_name && item.identityId === row.identity_id),
        ),
      );
      return;
    }
    onChange([
      ...selected,
      { characterName: row.character_name, identityId: row.identity_id },
    ]);
  };

  return (
    <div
      data-testid="identity-call-panel"
      className="flex shrink-0 flex-col gap-2 overflow-visible rounded-[10px] border border-white/10 bg-[#17191f] p-3 text-white shadow-none"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">{t("node.identityCall.title")}</h2>
        <button type="button" className="rounded-full p-1 text-sm text-white/70 hover:bg-white/10" onClick={onClose} aria-label={t("node.identityCall.close")}>
          <X className="size-4" />
        </button>
      </div>
      {looks.isLoading ? <div className="text-xs text-white/60">{t("node.identityCall.loading")}</div> : null}
      {looks.isError ? <div role="alert" className="text-xs text-red-300">{t("node.identityCall.loadFailed")}</div> : null}
      {!looks.isLoading && rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-white/10 px-2 py-2 text-xs text-white/60">{t("node.identityCall.empty")}</div>
      ) : null}
      <ul aria-label={t("node.identityCall.characterList")} className="grid grid-cols-2 gap-1">
        {rows.map((row) => {
          const order = selected.findIndex(
            (item) => item.characterName === row.character_name && item.identityId === row.identity_id,
          );
          const active = order >= 0;
          return (
            <li key={`${row.character_name}:${row.identity_id}`}>
              <button
                type="button"
                onClick={() => toggle(row)}
                aria-pressed={active}
                className={`flex min-w-0 items-center justify-between rounded-full border px-2.5 py-1.5 text-left text-xs transition-colors ${
                  active ? "border-accent bg-accent text-white" : "border-white/10 bg-white/5 text-white hover:bg-white/10"
                }`}
              >
                <span className="min-w-0 truncate" title={row.identity_name}>{row.character_name}</span>
                {active ? <span className="ml-1 shrink-0 font-mono text-xs">{order + 1}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      <details className="rounded-md border border-white/10 bg-black/10">
        <summary className="cursor-pointer list-none px-2 py-1.5 text-xs text-white/60 marker:hidden">
          本镜角色说明
        </summary>
        <div className="border-t border-white/10 px-2 py-2">
          <p className="text-xs leading-4 text-white/60">{t("node.identityCall.hint")}</p>
          {plan.notes.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1 text-xs leading-4 text-white/70">
              {plan.notes.map((note, index) => (
                <li key={`${note.code}-${index}`}>{noteText(t, note)}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </details>
    </div>
  );
}
