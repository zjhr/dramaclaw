import type { CharacterPerformance } from "@/features/canvas/domain/canvasNodes";
import type { IdentityCallSelection } from "@/features/canvas/domain/identityCallPlan";
import type { CharacterPerformanceKeyframe } from "@/features/canvas/domain/canvasNodes";

export const NEUTRAL_CHARACTER_PERFORMANCE: CharacterPerformance = {
  valence: 0,
  arousal: 0,
  brows: 0,
  eyes: 0,
  mouth: 0,
  jaw: 0,
};

const CONTROLS: Array<[keyof CharacterPerformance, string]> = [
  ["valence", "valence"],
  ["arousal", "arousal"],
  ["brows", "brows"],
  ["eyes", "eyes"],
  ["mouth", "mouth"],
  ["jaw", "jaw"],
];

export function normalizeCharacterPerformance(value: unknown): CharacterPerformance {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const normalized = { ...NEUTRAL_CHARACTER_PERFORMANCE };
  for (const [key] of CONTROLS) {
    const number = Number(source[key]);
    const fallback = NEUTRAL_CHARACTER_PERFORMANCE[key];
    normalized[key] = Number.isFinite(number) ? Math.min(1, Math.max(-1, number)) : fallback;
  }
  return normalized;
}

export function describeCharacterPerformance(value: unknown): string {
  const state = normalizeCharacterPerformance(value);
  const affect = state.valence < -0.2 ? "negative" : state.valence > 0.2 ? "positive" : "neutral";
  const energy = state.arousal < -0.2 ? "subdued" : state.arousal > 0.2 ? "energetic" : "steady";
  const face = [
    state.brows > 0.2 ? "raised brows" : state.brows < -0.2 ? "furrowed brows" : "relaxed brows",
    state.eyes > 0.2 ? "wide eyes" : state.eyes < -0.2 ? "narrowed eyes" : "relaxed eyes",
    state.mouth > 0.2 ? "smiling mouth" : state.mouth < -0.2 ? "downturned mouth" : "relaxed mouth",
    state.jaw > 0.2 ? "open jaw" : state.jaw < -0.2 ? "tight jaw" : "relaxed jaw",
  ];
  return `Current performance: ${affect} affect, ${energy} energy, ${face.join(", ")}.`;
}

export function appendPerformancePrompts(
  prompt: string,
  identities: IdentityCallSelection[],
  performances: Record<string, CharacterPerformance> | undefined,
  timelines?: Record<string, CharacterPerformanceKeyframe[]>,
): string {
  const lines = identities.flatMap((identity) => {
    const frames = timelines?.[identity.identityId];
    const byTime = new Map<number, CharacterPerformance>();
    for (const frame of Array.isArray(frames) ? frames : []) {
      if (!Number.isFinite(frame?.timeMs) || frame.timeMs < 0) continue;
      byTime.set(Math.round(frame.timeMs), normalizeCharacterPerformance(frame.performance));
    }
    const keyframes = [...byTime.entries()].sort(([a], [b]) => a - b);
    if (keyframes.length > 0) {
      return keyframes.map(([timeMs, performance]) => {
        const seconds = (timeMs / 1000).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
        return `${identity.characterName} at ${seconds}s: ${describeCharacterPerformance(performance)}`;
      });
    }
    const performance = performances?.[identity.identityId];
    return performance ? [`${identity.characterName}: ${describeCharacterPerformance(performance)}`] : [];
  });
  return [...(prompt ? [prompt] : []), ...lines].join("\n\n");
}

export function buildImagePerformancePrompt(
  prompt: string,
  identity: IdentityCallSelection | undefined,
  performances: Record<string, CharacterPerformance> | undefined,
): string {
  const performance = identity ? performances?.[identity.identityId] : undefined;
  return appendPerformancePrompts(
    prompt,
    performance && identity ? [identity] : [],
    performance && identity ? { [identity.identityId]: performance } : undefined,
  );
}

export function buildVideoPerformancePrompt(
  prompt: string,
  identities: IdentityCallSelection[],
  performances: Record<string, CharacterPerformance> | undefined,
  timelines: Record<string, CharacterPerformanceKeyframe[]> | undefined,
): string {
  return appendPerformancePrompts(prompt, identities, performances, timelines);
}
