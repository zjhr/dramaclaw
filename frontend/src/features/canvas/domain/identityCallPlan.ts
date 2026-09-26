/** 一条视频选中的身份，按选中顺序把脸、三视图、表情九宫格和声线送进生成。 */

export type IdentityLookAsset = {
  characterName: string;
  identityId: string;
  identityName: string;
  faceUrl: string;
  threeViewUrl: string;
  expressionGridUrl: string;
  voiceUrl: string;
};

export type IdentityCallSelection = {
  characterName: string;
  identityId: string;
};

export type IdentityCallNote =
  | { code: "modeNoImage" }
  | { code: "modeNoAudio" }
  | { code: "missingFace"; name: string }
  | { code: "droppedFace"; name: string }
  | { code: "missingThreeView"; name: string }
  | { code: "droppedThreeView"; name: string }
  | { code: "missingGrid"; name: string }
  | { code: "droppedGrid"; name: string }
  | { code: "missingVoice"; name: string }
  | { code: "droppedVoice"; name: string }
  | { code: "reshootKeepsFrames" };

export type IdentityCallPlan = {
  imageUrls: string[];
  voiceUrls: { url: string; label: string }[];
  notes: IdentityCallNote[];
};

function findAsset(
  assets: IdentityLookAsset[],
  selection: IdentityCallSelection,
): IdentityLookAsset | undefined {
  return assets.find(
    (asset) =>
      asset.characterName === selection.characterName &&
      asset.identityId === selection.identityId,
  );
}

function takeUntilCap(
  items: { url: string; label: string; dropped: IdentityCallNote }[],
  cap: number,
): { kept: { url: string; label: string }[]; notes: IdentityCallNote[] } {
  const kept = items.slice(0, Math.max(0, cap)).map(({ url, label }) => ({ url, label }));
  const notes = items.slice(Math.max(0, cap)).map((item) => item.dropped);
  return { kept, notes };
}

export function planIdentityCall(
  order: IdentityCallSelection[],
  assets: IdentityLookAsset[],
  imageCap: number | null,
  audioCap: number | null,
): IdentityCallPlan {
  const people = order
    .map((selection) => findAsset(assets, selection))
    .filter((asset): asset is IdentityLookAsset => Boolean(asset));
  const notes: IdentityCallNote[] = [];

  let imageUrls: string[] = [];
  if (imageCap === null) {
    if (people.length > 0) notes.push({ code: "modeNoImage" });
  } else {
    const faces: { url: string; label: string; dropped: IdentityCallNote }[] = [];
    const threes: { url: string; label: string; dropped: IdentityCallNote }[] = [];
    const grids: { url: string; label: string; dropped: IdentityCallNote }[] = [];
    for (const person of people) {
      const name = person.identityName
        ? `${person.characterName}·${person.identityName}`
        : person.characterName;
      if (person.faceUrl) {
        faces.push({
          url: person.faceUrl,
          label: name,
          dropped: { code: "droppedFace", name },
        });
      } else {
        notes.push({ code: "missingFace", name });
      }
      if (person.threeViewUrl) {
        threes.push({
          url: person.threeViewUrl,
          label: name,
          dropped: { code: "droppedThreeView", name },
        });
      } else {
        notes.push({ code: "missingThreeView", name });
      }
      if (person.expressionGridUrl) {
        grids.push({
          url: person.expressionGridUrl,
          label: name,
          dropped: { code: "droppedGrid", name },
        });
      } else {
        notes.push({ code: "missingGrid", name });
      }
    }
    const ordered = [...faces, ...threes, ...grids];
    const taken = takeUntilCap(ordered, imageCap);
    imageUrls = taken.kept.map((item) => item.url);
    notes.push(...taken.notes);
  }

  let voiceUrls: { url: string; label: string }[] = [];
  if (audioCap === null || audioCap <= 0) {
    if (people.length > 0) notes.push({ code: "modeNoAudio" });
  } else {
    const voices: { url: string; label: string; dropped: IdentityCallNote }[] = [];
    for (const person of people) {
      const name = person.identityName
        ? `${person.characterName}·${person.identityName}`
        : person.characterName;
      if (person.voiceUrl) {
        voices.push({
          url: person.voiceUrl,
          label: name,
          dropped: { code: "droppedVoice", name },
        });
      } else {
        notes.push({ code: "missingVoice", name });
      }
    }
    const taken = takeUntilCap(voices, audioCap);
    voiceUrls = taken.kept;
    notes.push(...taken.notes);
  }

  return { imageUrls, voiceUrls, notes };
}

export function mergeCappedUrls(preferred: string[], rest: string[], cap: number): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const url of [...preferred, ...rest]) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    merged.push(url);
    if (merged.length >= cap) break;
  }
  return merged;
}
