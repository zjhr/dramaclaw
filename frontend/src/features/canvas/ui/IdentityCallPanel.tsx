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
      className="flex max-h-[72vh] flex-col gap-3 overflow-y-auto rounded-[12px] border border-white/10 bg-[#141414] p-4 text-white shadow-xl"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-medium">{t("node.identityCall.title")}</h2>
        <button type="button" className="text-sm text-white/70" onClick={onClose} aria-label={t("node.identityCall.close")}>
          <X className="size-4" />
        </button>
      </div>
      <p className="text-sm leading-5 text-white/70">{t("node.identityCall.hint")}</p>
      {looks.isLoading ? <div className="text-sm text-white/60">{t("node.identityCall.loading")}</div> : null}
      {looks.isError ? <div className="text-sm text-red-300">{t("node.identityCall.loadFailed")}</div> : null}
      {!looks.isLoading && rows.length === 0 ? (
        <div className="text-sm text-white/60">{t("node.identityCall.empty")}</div>
      ) : null}
      <ul className="flex flex-col gap-1">
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
                className={`flex w-full items-center justify-between rounded-[8px] px-3 py-2 text-left text-sm ${
                  active ? "bg-white text-black" : "bg-white/5 text-white hover:bg-white/10"
                }`}
              >
                <span>
                  {row.character_name}
                  <span className={active ? "text-black/50" : "text-white/50"}> · {row.identity_name}</span>
                </span>
                {active ? <span>{order + 1}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      {plan.notes.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm leading-5 text-white/75">
          {plan.notes.map((note, index) => (
            <li key={`${note.code}-${index}`}>{noteText(t, note)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
