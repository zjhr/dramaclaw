import { useEffect, useState } from "react";
import type { CharacterPerformance, CharacterPerformanceKeyframe } from "@/features/canvas/domain/canvasNodes";
import type { IdentityCallSelection } from "@/features/canvas/domain/identityCallPlan";
import { useTranslation } from "react-i18next";
import { XiaoLuoPerformanceStudio } from "@/features/canvas/components/XiaoLuoPerformanceStudio";

export function CharacterPerformanceEditor({
  identities,
  performances,
  timelines = {},
  durationSec: _durationSec = 0,
  onChange,
}: {
  identities: IdentityCallSelection[];
  performances: Record<string, CharacterPerformance>;
  timelines?: Record<string, CharacterPerformanceKeyframe[]>;
  durationSec?: number;
  onChange: (identityId: string, value: CharacterPerformance, keyframes?: CharacterPerformanceKeyframe[]) => void;
}) {
  const { t } = useTranslation();
  const [selectedIdentityId, setSelectedIdentityId] = useState(identities[0]?.identityId ?? "");
  const selectedIdentity = identities.find((identity) => identity.identityId === selectedIdentityId)
    ?? identities[0];
  const keyframes = selectedIdentity ? timelines[selectedIdentity.identityId] ?? [] : [];
  const current = selectedIdentity ? performances[selectedIdentity.identityId] ?? {
    valence: 0, arousal: 0, brows: 0, eyes: 0, mouth: 0, jaw: 0,
  } : { valence: 0, arousal: 0, brows: 0, eyes: 0, mouth: 0, jaw: 0 };

  useEffect(() => {
    if (!identities.some((identity) => identity.identityId === selectedIdentityId)) {
      setSelectedIdentityId(identities[0]?.identityId ?? "");
    }
  }, [identities, selectedIdentityId]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-hidden rounded-[10px] border border-white/10 bg-[#17191f] p-3 text-white" data-testid="character-performance-editor">
      <div className="shrink-0">
        <h3 className="text-sm font-medium text-white/90">{t("node.performance.title")}</h3>
      </div>
      {selectedIdentity ? (
        <>
          {identities.length > 1 ? (
            <div role="tablist" aria-label={t("node.performance.identityTabs")} className="flex gap-1 overflow-x-auto">
              {identities.map((identity) => (
                <button
                  key={identity.identityId}
                  type="button"
                  role="tab"
                  aria-selected={selectedIdentity.identityId === identity.identityId}
                  className="tap-chip shrink-0"
                  onClick={() => setSelectedIdentityId(identity.identityId)}
                >
                  {identity.characterName}
                </button>
              ))}
            </div>
          ) : null}

          <div className="min-h-0 flex-1">
          <XiaoLuoPerformanceStudio
            performance={current}
            keyframes={keyframes}
            onChange={(value, frames) => onChange(selectedIdentity.identityId, value, frames)}
          />
          </div>
        </>
      ) : (
        <>
          <p className="text-xs leading-5 text-white/60">{t("node.performance.disclaimer")}</p>
          <p className="text-xs text-white/50">{t("node.performance.empty")}</p>
        </>
      )}
    </section>
  );
}
