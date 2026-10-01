import { describe, expect, it } from "vitest";
import { NEUTRAL_CHARACTER_PERFORMANCE } from "@/features/canvas/domain/characterPerformance";
import { deriveCharacterFacePose } from "@/features/canvas/preview/characterFaceScene";

describe("character face preview pose", () => {
  it("maps brows, eyes, mouth, and jaw controls to separate visible geometry changes", () => {
    const neutral = deriveCharacterFacePose(NEUTRAL_CHARACTER_PERFORMANCE);
    expect(deriveCharacterFacePose({ ...NEUTRAL_CHARACTER_PERFORMANCE, brows: 1 })).not.toMatchObject({ browY: neutral.browY, browTilt: neutral.browTilt });
    expect(deriveCharacterFacePose({ ...NEUTRAL_CHARACTER_PERFORMANCE, eyes: 1 })).not.toMatchObject({ eyeHeight: neutral.eyeHeight, lidHeight: neutral.lidHeight });
    expect(deriveCharacterFacePose({ ...NEUTRAL_CHARACTER_PERFORMANCE, mouth: -1 })).not.toMatchObject({ mouthTilt: neutral.mouthTilt, mouthWidth: neutral.mouthWidth });
    expect(deriveCharacterFacePose({ ...NEUTRAL_CHARACTER_PERFORMANCE, jaw: 1 })).not.toMatchObject({ mouthHeight: neutral.mouthHeight, jawDrop: neutral.jawDrop });
    expect(deriveCharacterFacePose({ ...NEUTRAL_CHARACTER_PERFORMANCE, jaw: -1 }).jawDrop).not.toBe(neutral.jawDrop);
  });

  it("bounds extreme values to the supported control range", () => {
    expect(deriveCharacterFacePose({ ...NEUTRAL_CHARACTER_PERFORMANCE, eyes: 10 }).eyeHeight)
      .toBe(deriveCharacterFacePose({ ...NEUTRAL_CHARACTER_PERFORMANCE, eyes: 1 }).eyeHeight);
  });
});
