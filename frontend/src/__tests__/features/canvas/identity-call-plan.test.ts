import { describe, expect, it } from "vitest";

import { planIdentityCall, type IdentityLookAsset } from "@/features/canvas/domain/identityCallPlan";

const xiaomei: IdentityLookAsset = {
  characterName: "小美",
  identityId: "xiaomei_base",
  identityName: "基础形象",
  faceUrl: "face-a",
  threeViewUrl: "three-a",
  expressionGridUrl: "grid-a",
  voiceUrl: "voice-a",
};

const aqiang: IdentityLookAsset = {
  characterName: "阿强",
  identityId: "aqiang_base",
  identityName: "基础形象",
  faceUrl: "face-b",
  threeViewUrl: "",
  expressionGridUrl: "grid-b",
  voiceUrl: "",
};

describe("planIdentityCall", () => {
  it("sends faces first, then turnarounds, then expression sheets", () => {
    const plan = planIdentityCall(
      [
        { characterName: "小美", identityId: "xiaomei_base" },
        { characterName: "阿强", identityId: "aqiang_base" },
      ],
      [aqiang, xiaomei],
      3,
      1,
    );
    expect(plan.imageUrls).toEqual(["face-a", "face-b", "three-a"]);
    expect(plan.voiceUrls.map((item) => item.url)).toEqual(["voice-a"]);
    expect(plan.notes).toEqual([
      { code: "missingThreeView", name: "阿强·基础形象" },
      { code: "droppedGrid", name: "小美·基础形象" },
      { code: "droppedGrid", name: "阿强·基础形象" },
      { code: "missingVoice", name: "阿强·基础形象" },
    ]);
  });

  it("sends only the first face when the mode accepts one image", () => {
    const plan = planIdentityCall(
      [
        { characterName: "小美", identityId: "xiaomei_base" },
        { characterName: "阿强", identityId: "aqiang_base" },
      ],
      [xiaomei, aqiang],
      1,
      0,
    );
    expect(plan.imageUrls).toEqual(["face-a"]);
    expect(plan.voiceUrls).toEqual([]);
    expect(plan.notes.some((note) => note.code === "modeNoAudio")).toBe(true);
    expect(plan.notes.some((note) => note.code === "droppedFace")).toBe(true);
  });

  it("does not send images when the mode has no image slot", () => {
    const plan = planIdentityCall(
      [{ characterName: "小美", identityId: "xiaomei_base" }],
      [xiaomei],
      null,
      null,
    );
    expect(plan.imageUrls).toEqual([]);
    expect(plan.notes.map((note) => note.code)).toEqual(["modeNoImage", "modeNoAudio"]);
  });
});
