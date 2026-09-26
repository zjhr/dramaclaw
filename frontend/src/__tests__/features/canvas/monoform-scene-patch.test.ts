// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * MONOFORM 场景翻译层（宿主侧纯函数）。验 dd-scene intent → MONOFORM 工程结构的映射：
 * 角色（位置/朝向/姿势）、物品（默认值照抄 addPrimitive）、走位动画轨、相机运镜轨、
 * start 编排、角色替换保留道具、以及「必须同时 patch 活动 shot」这条踩过坑的回归。
 */
import { describe, expect, it } from "vitest";
import romanceResponse from "./fixtures/romance-performance.intent.json";

import { DIRECTOR_SCENE_INTENT_TYPE, type DirectorSceneIntent } from "@/features/canvas/nodes/directorScenePatch";
import {
  applyMonoformSceneIntent,
  buildMonoformActionTrack,
  buildMonoformCameraTrack,
  buildMonoformCharacter,
  buildMonoformCharacterTrack,
  buildMonoformJoints,
  expandMonoformPerformanceBeat,
  buildMonoformProp,
  summarizeMonoformProject,
  trackPositionAt,
} from "@/features/canvas/nodes/monoformScenePatch";

describe("buildMonoformCharacter", () => {
  it("at[x,z] → position[x,0,z]，facing 度 → rotation.y 弧度", () => {
    const obj = buildMonoformCharacter({ at: [1.5, -2], facing: 90 }, 0);
    expect(obj.type).toBe("person");
    expect(obj.position).toEqual([1.5, 0, -2]);
    expect(obj.rotation[1]).toBeCloseTo(Math.PI / 2, 5);
    expect(obj.rotation[0]).toBe(0);
    expect(obj.scale).toEqual([1, 1, 1]);
  });

  it("姿势名映射：stand→idle / t-pose→tpose / 同名直传 / 缺省 idle", () => {
    expect(buildMonoformCharacter({ pose: "stand" }, 0).pose).toBe("idle");
    expect(buildMonoformCharacter({ pose: "t-pose" }, 0).pose).toBe("tpose");
    expect(buildMonoformCharacter({ pose: "walk" }, 0).pose).toBe("walk");
    expect(buildMonoformCharacter({}, 0).pose).toBe("idle");
  });

  it("无 at 时按序号错开，避免重叠", () => {
    const a = buildMonoformCharacter({}, 0).position[0];
    const b = buildMonoformCharacter({}, 1).position[0];
    expect(a).not.toBe(b);
  });

  it("route 首点作起点（at 缺省时）", () => {
    const obj = buildMonoformCharacter({ route: [[3, 4], [5, 6]] }, 0);
    expect(obj.position).toEqual([3, 0, 4]);
  });
});

describe("真实爱情演出回归：造型、轴线与共同时间", () => {
  // fixture 原样取自实测模型回复；起始工程保留当时会污染新戏的拥抱骨骼。
  const intent = romanceResponse as DirectorSceneIntent;
  const original = () => ({
    settings: { fps: 24, durationSeconds: 15 },
    objects: [
      { id: "aigen_char_1", name: "林晚", type: "person", position: [-0.35, 0, -0.3], rotation: [0, Math.PI / 2, 0], scale: [1.2, 1.2, 1.2], pose: "stand_relaxed", joints: { mixamorigLeftShoulder: [-80 * Math.PI / 180, 0, 0], mixamorigLeftForeArm: [-115 * Math.PI / 180, 0, 0] } },
      { id: "aigen_char_2", name: "沈青", type: "person", position: [0.35, 0, -0.3], rotation: [0, -Math.PI / 2, 0], pose: "stand_relaxed", joints: { mixamorigRightShoulder: [-80 * Math.PI / 180, 0, 0] } },
      { id: "user_tree", type: "tree", position: [0, 1.3, -2] },
    ],
  });
  type ActionKey = { frame: number; position: number[]; scale: number[]; joints?: Record<string, number[]> };
  type CameraKey = { frame: number; position: number[]; target: number[]; focalLength: number };

  it("完整重编不再带入旧拥抱，保留演员身份/站位/比例和手摆道具", () => {
    const before = original();
    const next = applyMonoformSceneIntent(before, intent);
    const track = next.objectKeyframes?.aigen_char_1 as ActionKey[];
    for (const key of track) {
      expect(key.joints?.mixamorigLeftShoulder).toBeUndefined();
      expect(key.joints?.mixamorigLeftForeArm).toBeUndefined();
      expect(key.position).toEqual([-0.35, 0, -0.3]);
      expect(key.scale).toEqual([1.2, 1.2, 1.2]);
    }
    expect(track[0].joints?.mixamorigHead[0]).toBeCloseTo(14 * Math.PI / 180);
    expect(next.objects?.[0].joints).toEqual({});
    expect(next.objects?.[2]).toEqual(before.objects[2]);
    expect(before.objects[0].joints?.mixamorigLeftShoulder?.[0]).toBeCloseTo(-80 * Math.PI / 180);
  });

  it("明确 edit 或 poseBase=current 时继续保留手工姿态", () => {
    for (const edit of [
      { ...intent, mode: "edit" as const },
      { ...intent, mode: "compose" as const, characters: intent.characters!.map((character) => ({ ...character, poseBase: "current" as const })) },
    ]) {
      const next = applyMonoformSceneIntent(original(), edit);
      expect((next.objectKeyframes?.aigen_char_1 as ActionKey[])[0].joints?.mixamorigLeftForeArm?.[0]).toBeCloseTo(-115 * Math.PI / 180);
    }
    expect(applyMonoformSceneIntent(original(), { ...intent, mode: "edit" }).settings?.durationSeconds).toBe(15);
  });

  it("原回复的 6.5 秒收手与迟到反打被排进同一段 7 秒，三机都无 15 秒空尾", () => {
    const next = applyMonoformSceneIntent(original(), intent);
    expect(next.settings?.durationSeconds).toBe(7);
    for (const shot of next.shots ?? []) expect(shot.durationSeconds).toBe(7);
    const reaction = next.shots?.[2].keyframes as CameraKey[];
    expect(reaction[0].frame).toBe(72);
    expect(reaction[reaction.length - 1].frame).toBe(168);
    const deliberateTail = applyMonoformSceneIntent(original(), { ...intent, mode: "compose", duration: 11 });
    expect((deliberateTail.shots?.[2].keyframes as CameraKey[])[0].frame).toBe(156);
    expect(deliberateTail.settings?.durationSeconds).toBe(11);
  });

  it("正反打全程位于主镜头同侧，并给目标人物头顶留出画幅", () => {
    const next = applyMonoformSceneIntent(original(), intent);
    for (const shot of next.shots!.slice(1)) {
      for (const key of shot.keyframes as CameraKey[]) {
        expect(key.position[2]).toBeGreaterThan(-0.3);
        // 与引擎相同的 24mm 传感器；人物头顶相对光轴的角度小于半视角。
        const person = key.target[0] < 0 ? original().objects[0] : original().objects[1];
        const headY = 1.8 * (person.scale?.[1] ?? 1);
        const groundDistance = Math.hypot(key.position[0] - key.target[0], key.position[2] - key.target[2]);
        const aim = Math.atan2(key.target[1] - key.position[1], groundDistance);
        const head = Math.atan2(headY - key.position[1], groundDistance);
        expect(Math.abs(head - aim)).toBeLessThan(Math.atan(12 / key.focalLength) * 0.96);
      }
    }
  });

  it("重编单镜头会移除旧覆盖列表；只动镜头保持原演出与时长", () => {
    const previous = applyMonoformSceneIntent(original(), intent);
    const one = applyMonoformSceneIntent(previous, { ...intent, mode: "compose", shots: undefined, camera: { move: "dolly-in", duration: 4 } });
    expect(one.shots).toHaveLength(1);
    const cameraOnly = applyMonoformSceneIntent(previous, { type: DIRECTOR_SCENE_INTENT_TYPE, camera: { move: "dolly-out", duration: 4 } });
    expect(cameraOnly.objectKeyframes).toEqual(previous.objectKeyframes);
    expect(cameraOnly.settings).toEqual(previous.settings);
  });

  it("只声明 neutral 也清掉该演员旧轨，并同步共享演员的机位，其他人的演出保留", () => {
    const previous = applyMonoformSceneIntent(original(), intent);
    const next = applyMonoformSceneIntent(previous, {
      type: DIRECTOR_SCENE_INTENT_TYPE, mode: "edit", characters: [{ target: "aigen_char_1", poseBase: "neutral" }],
    });
    expect(next.objectKeyframes?.aigen_char_1).toBeUndefined();
    expect(next.objectKeyframes?.aigen_char_2).toEqual(previous.objectKeyframes?.aigen_char_2);
    for (const shot of next.shots!) expect(shot.objectKeyframes?.aigen_char_1).toBeUndefined();
    expect(next.objects?.[0].joints).toEqual({});
  });
});

describe("台词气泡", () => {
  it("把有效台词写到角色上，并丢掉空句和倒序时间", () => {
    const obj = buildMonoformCharacter({
      name: "林晚",
      lines: [
        { text: "  ", start: 0, end: 1 },
        { text: "你还记得那棵树吗", start: 1.2, end: 3.4 },
        { text: "倒序", start: 4, end: 3 },
      ],
    }, 0);
    expect(obj.lines).toEqual([{ text: "你还记得那棵树吗", start: 1.2, end: 3.4 }]);
  });

  it("增量改朝向时保留台词，显式空数组才清掉", () => {
    const first = applyMonoformSceneIntent({}, {
      type: DIRECTOR_SCENE_INTENT_TYPE,
      characters: [
        { name: "林晚", at: [1, 0], lines: [{ text: "你还记得那棵树吗", start: 1.2, end: 3.4 }] },
        { name: "沈青", at: [-1, 0], lines: [{ text: "记得", start: 3.4, end: 5 }] },
      ],
    });
    const kept = applyMonoformSceneIntent(first, {
      type: DIRECTOR_SCENE_INTENT_TYPE,
      characters: [{ target: "林晚", facing: 90 }],
    });
    const lin = (kept.objects as Array<{ name?: string; lines?: unknown; rotation: number[] }>)
      .find((item) => item.name === "林晚");
    expect(lin?.lines).toEqual([{ text: "你还记得那棵树吗", start: 1.2, end: 3.4 }]);
    expect(lin?.rotation[1]).toBeCloseTo(Math.PI / 2);
    const cleared = applyMonoformSceneIntent(kept, {
      type: DIRECTOR_SCENE_INTENT_TYPE,
      characters: [{ target: "林晚", lines: [] }],
    });
    const silent = (cleared.objects as Array<{ name?: string; lines?: unknown }>)
      .find((item) => item.name === "林晚");
    expect(silent?.lines).toEqual([]);
    expect(summarizeMonoformProject(first)).toContain("台词1.2-3.4「你还记得那棵树吗」");
  });

  it("多机位复制同一份台词", () => {
    const next = applyMonoformSceneIntent({}, {
      type: DIRECTOR_SCENE_INTENT_TYPE,
      characters: [
        { name: "林晚", at: [1, 0], lines: [{ text: "你还记得那棵树吗", start: 1.2, end: 3.4 }] },
        { name: "沈青", at: [-1, 0], lines: [{ text: "记得", start: 3.4, end: 5 }] },
      ],
      shots: [
        { name: "全景", camera: { move: "static", size: "wide" } },
        { name: "反打", camera: { move: "over-shoulder", subject: "林晚", focus: "沈青" } },
      ],
    });
    for (const shot of next.shots ?? []) {
      const lines = (shot.objects as Array<{ name?: string; lines?: { text: string }[] }>)
        .filter((item) => item.lines)
        .map((item) => item.lines?.[0]?.text);
      expect(lines).toEqual(["你还记得那棵树吗", "记得"]);
    }
  });
});

describe("相机按演员身份与动作曲线取景", () => {
  const scene = (extra: Partial<DirectorSceneIntent>): DirectorSceneIntent => ({ type: DIRECTOR_SCENE_INTENT_TYPE, mode: "edit", ...extra });
  it("有一个人静止时不把别人的轨误配给他，质心包含静止演员", () => {
    const next = applyMonoformSceneIntent({}, scene({
      characters: [{ name: "静止", at: [-2, 0] }, { name: "走动", route: [[0, 0], [4, 0]], routeDuration: 4 }],
      camera: { move: "dolly-in", duration: 4 },
    }));
    const keys = next.keyframes as { target: number[] }[];
    expect(keys[0].target[0]).toBe(-1);
    expect(keys[keys.length - 1].target[0]).toBe(1);
  });

  it("越肩的 focus 可选择第三人，并按 smooth 表演位置跟随，反打仍同侧", () => {
    const next = applyMonoformSceneIntent({}, scene({
      characters: [
        { name: "前景", at: [-1, 0], facing: 90 },
        { name: "路人", at: [8, 8] },
        { name: "目标", performance: [{ t: 0, at: [1, 0] }, { t: 4, at: [3, 0] }] },
      ],
      shots: [
        { camera: { move: "over-shoulder", subject: "前景", focus: "目标", duration: 4, axisSide: "negative" } },
        { camera: { move: "over-shoulder", subject: "目标", focus: "前景", duration: 4 } },
      ],
    }));
    const keys = next.shots?.[0].keyframes as { frame: number; target: number[]; position: number[] }[];
    expect(keys.find((key) => key.frame === 24)?.target[0]).toBeCloseTo(1 + 2 * 0.15625);
    expect(keys[keys.length - 1].target[0]).toBe(3);
    for (const shot of next.shots!) {
      for (const key of shot.keyframes as { position: number[] }[]) expect(key.position[2]).toBeLessThan(0);
    }
  });

  it("点头循环不再误报走位，摘要提供非零旧姿态和动作时间", () => {
    const text = summarizeMonoformProject({
      settings: { fps: 24 },
      objects: [{ id: "p", type: "person", pose: "agree", joints: { mixamorigLeftForeArm: [-2, 0, 0] } }],
      objectKeyframes: { p: [{ frame: 0, pose: "agree", continuousMotion: true }, { frame: 72, pose: "agree" }] },
    });
    expect(text).not.toContain("有走位动画");
    expect(text).toContain("有动作关键帧");
    expect(text).toContain("LeftForeArm[-115,0,0]");
    expect(text).toContain("节拍[0,3]秒");
  });
});

describe("applyMonoformSceneIntent", () => {
  const intent = (chars: unknown[]) => ({
    type: DIRECTOR_SCENE_INTENT_TYPE,
    characters: chars,
  }) as Parameters<typeof applyMonoformSceneIntent>[1];

  it("角色替换所有 person，保留非 person（道具/粗模）", () => {
    const project = {
      objects: [
        { id: "old-person", type: "person", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        { id: "prop-box", type: "box", position: [1, 0, 1], rotation: [0, 0, 0], scale: [1, 1, 1] },
      ],
    };
    const next = applyMonoformSceneIntent(project, intent([{ at: [0, 0], facing: -90 }, { at: [1, 0], facing: 90 }]));
    const persons = next.objects!.filter((o) => o.type === "person");
    const boxes = next.objects!.filter((o) => o.type === "box");
    expect(persons).toHaveLength(2); // 旧 person 被换成 2 个新的
    expect(boxes).toHaveLength(1); // 道具保留
    expect(boxes[0].id).toBe("prop-box");
    expect(next).not.toBe(project); // 不改入参
  });

  it("无角色时原样返回（不误删道具）", () => {
    const project = { objects: [{ id: "prop", type: "box", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }] };
    expect(applyMonoformSceneIntent(project, intent([]))).toBe(project);
  });

  // 回归：MONOFORM 的 normalizeShot 以 shot.objects 优先、顶层只是 fallback，
  // 最终渲染用 activeShot.objects。只改顶层会被 shot 内旧对象覆盖（实测 scene.apply
  // 返回 ok 但画面不变）。必须同时替换活动 shot 的 objects。
  it("同时 patch 活动 shot 的 objects（否则注入被 shot 内旧对象覆盖）", () => {
    const project = {
      activeShotId: "shot-01",
      objects: [{ id: "old", type: "person", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }],
      shots: [
        { id: "shot-00", objects: [{ id: "other-shot-person", type: "person" }] },
        { id: "shot-01", objects: [{ id: "old", type: "person" }] },
      ],
    };
    const next = applyMonoformSceneIntent(project, intent([{ at: [-1, 0], facing: 90 }, { at: [1, 0], facing: -90 }]));
    const activeShot = next.shots!.find((s) => s.id === "shot-01")!;
    expect(activeShot.objects!.filter((o) => o.type === "person")).toHaveLength(2); // 活动 shot 也被换成 2 个
    expect(next.objects!.filter((o) => o.type === "person")).toHaveLength(2); // 顶层同步
    // 非活动 shot 不动
    const otherShot = next.shots!.find((s) => s.id === "shot-00")!;
    expect(otherShot.objects![0].id).toBe("other-shot-person");
  });

  it("activeShotId 匹配不到时退到首个 shot（与 normalize 兜底一致）", () => {
    const project = {
      activeShotId: "nonexistent",
      objects: [{ id: "old", type: "person" }],
      shots: [{ id: "shot-a", objects: [{ id: "old", type: "person" }] }],
    };
    const next = applyMonoformSceneIntent(project, intent([{ at: [0, 0] }]));
    expect(next.shots![0].objects!.filter((o) => o.type === "person")).toHaveLength(1);
    expect(next.shots![0].objects![0].id).toBe("aigen_char_1");
  });
});

/**
 * 「一句话出片」新增的三块能力：物品摆放 / 人物走位动画 / 相机运镜 + start 编排。
 * 断言的是**展开后的工程结构**（帧号、坐标、姿势、continuousMotion）—— 这些是
 * MONOFORM 的 objectAtFrame / cameraAtFrame 真正消费的字段，写错就等于白摆。
 */
describe("buildMonoformProp", () => {
  it("默认值照抄 addPrimitive：尺寸/抬升/配色/名字", () => {
    const table = buildMonoformProp({ type: "table", at: [1, 2] }, 0)!;
    expect(table.id).toBe("aigen_prop_1");
    expect(table.type).toBe("table");
    expect(table.position).toEqual([1, 0.5, 2]); // 桌面默认抬升 0.5
    expect(table.scale).toEqual([1.7, 1, 1.1]);
    expect(table.name).toBe("桌子");
    const tree = buildMonoformProp({ type: "tree", at: [0, 0] }, 1)!;
    expect(tree.position[1]).toBe(1.3); // 树抬到 1.3
    expect(tree.color).toBe("#9ca68d");
    const plane = buildMonoformProp({ type: "plane", at: [0, 0] }, 2)!;
    expect(plane.position[1]).toBe(0.02);
    expect(plane.scale).toEqual([2, 1, 2]);
  });

  it("覆盖值生效：y / rotationY / scale / color / name", () => {
    const p = buildMonoformProp(
      { type: "box", at: [1, 1], y: 0.9, rotationY: 45, scale: [2, 2, 2], color: "#ff0000", name: "道具" },
      0,
    )!;
    expect(p.position).toEqual([1, 0.9, 1]);
    expect(p.rotation[1]).toBeCloseTo(Math.PI / 4, 5);
    expect(p.scale).toEqual([2, 2, 2]);
    expect(p.color).toBe("#ff0000");
    expect(p.name).toBe("道具");
  });

  it("未知类型丢弃（agent 拼错词也不会把工程写坏）", () => {
    expect(buildMonoformProp({ type: "dragon" as never }, 0)).toBeNull();
  });
});

describe("buildMonoformCharacterTrack（走位动画）", () => {
  it("路点 → 关键帧：帧号按 start/routeDuration 铺开、朝向取行进方向", () => {
    const keys = buildMonoformCharacterTrack([[-2.5, 1], [0, 0]], { routeDuration: 4 }, 24);
    expect(keys[0].frame).toBe(0);
    expect(keys[1].frame).toBe(96); // 4s * 24fps
    expect(keys[0].position).toEqual([-2.5, 0, 1]);
    expect(keys[1].position).toEqual([0, 0, 0]);
    // 朝向 = atan2(dx, dz)（0 = 面向 +z）
    expect(keys[0].rotation[1]).toBeCloseTo(Math.atan2(2.5, -1), 6);
    expect(keys[0].pose).toBe("walk");
    expect(keys[0].continuousMotion).toBe(true); // 没这个就不播走路循环
  });

  it("start 让起步延后；终点补静止帧把循环停住", () => {
    const keys = buildMonoformCharacterTrack([[0, 0], [2, 0]], { routeDuration: 2, start: 1.5 }, 24);
    expect(keys[0].frame).toBe(0);
    expect(keys[0].interpolation).toBe("hold");
    expect(keys[0].continuousMotion).toBe(false);
    expect(keys[1].frame).toBe(36); // 1.5s * 24fps 后才起步
    const last = keys[keys.length - 1];
    expect(last.pose).toBe("idle"); // 到站收动作
    expect(last.continuousMotion).toBe(false);
    expect(last.position).toEqual([2, 0, 0]);
  });

  it("pose=run 时用跑步循环", () => {
    const keys = buildMonoformCharacterTrack([[0, 0], [3, 0]], { pose: "run" }, 24);
    expect(keys[0].pose).toBe("run");
    expect(keys[keys.length - 1].pose).toBe("idle");
  });

  it("增量路线延迟期间保持原站位，镜头也跟随等待中的演员", () => {
    const next = applyMonoformSceneIntent({
      settings: { fps: 24 },
      objects: [{ id: "actor", type: "person", position: [5, 0, 5], rotation: [0, 1, 0], scale: [1.2, 1.2, 1.2] }],
    }, {
      type: DIRECTOR_SCENE_INTENT_TYPE,
      characters: [{ target: "actor", route: [[-2, 0], [2, 0]], start: 2, routeDuration: 4 }],
      camera: { move: "dolly-in", duration: 2 },
    });
    const keys = next.objectKeyframes?.actor as ReturnType<typeof buildMonoformCharacterTrack>;
    expect(keys[0]).toMatchObject({ frame: 0, position: [5, 0, 5], rotation: [0, 1, 0], interpolation: "hold", continuousMotion: false });
    expect(keys[1]).toMatchObject({ frame: 48, position: [-2, 0, 0], continuousMotion: true, scale: [1.2, 1.2, 1.2] });
    const camera = next.keyframes as { frame: number; target: number[] }[];
    for (const key of camera.filter((key) => key.frame < 48)) {
      expect([key.target[0], key.target[2]]).toEqual([5, 5]);
    }
    expect(camera[camera.length - 1].target[0]).toBe(-2);
  });
});

describe("buildMonoformActionTrack（演出动作关键帧）", () => {
  it.each(["agree", "headShake", "wave", "walk", "run"])("%s 的演出轨启用循环，并允许显式定格", (pose) => {
    const keys = buildMonoformActionTrack({ performance: [
      { t: 0, pose }, { t: 2, pose }, { t: 4, pose, continuousMotion: false },
    ] }, 24)!;
    expect(keys.map((key) => key.continuousMotion)).toEqual([true, true, false]);
  });

  it("同一姿势上的定格状态会延续到下一拍，换动作才恢复它的默认循环", () => {
    const keys = buildMonoformActionTrack({ performance: [
      { t: 0, pose: "wave", continuousMotion: false }, { t: 1, controls: { "head.pitch": 10 } }, { t: 2, pose: "agree" },
    ] }, 24)!;
    expect(keys.map((key) => key.continuousMotion)).toEqual([false, false, true]);
  });

  it("演出缺省值继承角色及上一拍，骨骼只更新明确给出的轴", () => {
    const current = {
      position: [3, 0.4, -2], rotation: [0, Math.PI / 2, 0], scale: [1.2, 1.2, 1.2],
      joints: { mixamorigHead: [0, 0.3, 0], mixamorigRightArm: [0.5, 0, 0] },
    };
    const keys = buildMonoformActionTrack({ performance: [
      { t: 0 }, { t: 2, at: [4, -1], facing: 60, controls: { "head.pitch": 20 } }, { t: 4 },
    ] }, 24, current)!;
    expect(keys[0].position).toEqual([3, 0.4, -2]);
    expect(keys[0].rotation[1]).toBeCloseTo(Math.PI / 2);
    expect(keys[2].position).toEqual([4, 0.4, -1]);
    expect(keys[2].rotation[1]).toBeCloseTo(Math.PI / 3);
    expect(keys[2].scale).toEqual([1.2, 1.2, 1.2]);
    expect(keys[2].joints?.mixamorigHead).toEqual([20 * Math.PI / 180, 0.3, 0]);
    expect(keys[2].joints?.mixamorigRightArm).toEqual([0.5, 0, 0]);
    expect(current.joints.mixamorigHead).toEqual([0, 0.3, 0]);
  });

  it("单拍补帧仍保留已有演员位置与造型", () => {
    const keys = buildMonoformActionTrack({ performance: [{ t: 2, pose: "wave" }] }, 24, {
      position: [3, 0, -2], rotation: [0, Math.PI / 2, 0], joints: { mixamorigHead: [0.2, 0, 0] },
    })!;
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key.position).toEqual([3, 0, -2]);
      expect(key.rotation[1]).toBeCloseTo(Math.PI / 2);
      expect(key.joints?.mixamorigHead).toEqual([0.2, 0, 0]);
    }
  });

  it("微调保留手动补录的混合基姿、相位和根偏移，重新选动作才释放", () => {
    const poseBlend = { from: { pose: "idle", poseTime: 0.2 }, to: { pose: "wave", poseTime: 0.4 }, amount: 0.5 };
    const keys = buildMonoformActionTrack({ poseBase: "current", performance: [
      { t: 0 }, { t: 2, controls: { "head.pitch": 10 } }, { t: 4, pose: "agree" },
    ] }, 24, { pose: "idle", poseTime: 0.3, poseBlend, rigRoot: [0, 0.2, 0] })!;
    expect(keys[0].poseBlend).toEqual(poseBlend);
    expect(keys[1].poseBlend).toEqual(poseBlend);
    expect(keys[1].poseTime).toBe(0.3);
    expect(keys[1].continuousMotion).toBe(false);
    expect(keys[1].rigRoot).toEqual([0, 0.2, 0]);
    expect(keys[2].poseBlend).toBeUndefined();
    expect(keys[2].poseTime).toBeUndefined();
  });

  it("performance 的每一拍都会落成角色关键帧，并保留骨骼控制", () => {
    const keys = buildMonoformActionTrack(
      {
        at: [-0.5, 0],
        facing: 90,
        performance: [
          { t: 0, pose: "idle", controls: { "head.pitch": 0 } },
          { t: 2, pose: "idle", controls: { "head.pitch": -25, "rightShoulder.pitch": 35 } },
          { t: 4, pose: "agree", controls: { "head.pitch": 10 } },
        ],
      },
      24,
    );
    expect(keys).toHaveLength(3);
    expect(keys?.map((key) => key.frame)).toEqual([0, 48, 96]);
    expect(keys?.[1].position).toEqual([-0.5, 0, 0]);
    expect(keys?.[1].joints?.mixamorigHead?.[0]).toBeCloseTo((-25 * Math.PI) / 180, 6);
    expect(keys?.[2].pose).toBe("agree");
  });

  it("只有一个动作拍时自动补起始拍，controls 也会产生两帧", () => {
    const one = buildMonoformActionTrack(
      { at: [0, 0], performance: [{ t: 1.5, pose: "wave" }] },
      24,
    );
    expect(one?.map((key) => key.frame)).toEqual([0, 36]);
    const controls = buildMonoformActionTrack(
      { controls: { "leftShoulder.spread": -70, "rightShoulder.spread": 70 } },
      24,
    );
    expect(controls).toHaveLength(2);
    expect(controls?.[1].joints?.mixamorigLeftShoulder?.[2]).toBeCloseTo((-70 * Math.PI) / 180, 6);
  });

  it("高层动作词展开成左右镜像的细节，不要求模型直写骨骼轴", () => {
    const reach = expandMonoformPerformanceBeat({ action: "伸手", side: "left", intensity: 1 });
    expect(reach.controls).toMatchObject({
      "leftArm.pitch": -42,
      "leftForeArm.pitch": -18,
      "leftElbow.bend": 24,
    });
    expect(reach.controls["rightArm.pitch"]).toBeUndefined();

    const settle = expandMonoformPerformanceBeat({ action: "收势", side: "both" });
    expect(settle.controls).toMatchObject({
      "leftArm.pitch": 0,
      "rightArm.pitch": 0,
      "leftElbow.bend": 0,
      "rightElbow.bend": 0,
      "head.pitch": 0,
    });
    expect(expandMonoformPerformanceBeat({ action: "招手" }).pose).toBe("wave");
  });

  it("动作拍与显式 controls 合并，显式角度覆盖动作默认值", () => {
    const keys = buildMonoformActionTrack({ performance: [
      { t: 0, action: "伸手", side: "right" },
      { t: 1.5, action: "伸手", side: "right", intensity: 0.8, controls: { "rightElbow.bend": 40 } },
      { t: 3, action: "收手", side: "right" },
    ] }, 24)!;
    // 右臂真实 GLB 的局部 Y 方向与左臂相反；语义层仍统一用负值表示前抬。
    const peakReach = keys.find((key) => key.frame === 36)!;
    const withdraw = keys.find((key) => key.frame === 72)!;
    expect(keys[0].joints?.mixamorigRightArm?.[1]).toBeCloseTo((42 * Math.PI) / 180, 5);
    expect(peakReach.joints?.mixamorigRightElbow).toBeUndefined();
    expect(peakReach.joints?.mixamorigRightForeArm?.[1]).toBeCloseTo((40 * Math.PI) / 180, 5);
    expect(withdraw.joints?.mixamorigRightArm?.[1]).toBe(0);
    expect(withdraw.joints?.mixamorigRightForeArm?.[1]).toBe(0);
  });

  it("高级舞步同时落到重心、腿部、躯干和转身，而不是只摆手", () => {
    const step = expandMonoformPerformanceBeat({ action: "向左迈", intensity: 1 });
    expect(step.positionOffset?.[0]).toBeLessThan(-0.4);
    expect(step.controls).toMatchObject({
      "hips.roll": -8,
      "torso.roll": -5,
      "leftUpLeg.pitch": -28,
      "leftLeg.pitch": 18,
      "leftFoot.pitch": -12,
    });

    const turn = expandMonoformPerformanceBeat({ action: "向右转", intensity: 0.8 });
    expect(turn.facingOffset).toBeCloseTo(36);
    expect(turn.controls).toMatchObject({ "hips.yaw": 14.4, "head.yaw": 19.2 });

    const dip = expandMonoformPerformanceBeat({ action: "下沉" });
    expect(dip.controls["leftUpLeg.pitch"]).toBeLessThan(-40);
    expect(dip.controls["rightUpLeg.pitch"]).toBeLessThan(-40);
    expect(dip.controls["leftLeg.pitch"]).toBeGreaterThan(20);
    expect(dip.controls["rightLeg.pitch"]).toBeGreaterThan(20);

    const raise = expandMonoformPerformanceBeat({ action: "上举双臂" });
    expect(raise.controls["leftArm.pitch"]).toBe(-118);
    expect(raise.controls["rightArm.pitch"]).toBe(-118);
    expect(raise.controls["leftArm.roll"]).toBe(42);
    expect(raise.controls["rightArm.roll"]).toBe(-42);
  });

  it("一拍可以叠加脚步与上肢，并支持更细的舞蹈动作词", () => {
    const combo = expandMonoformPerformanceBeat({
      actions: ["向右迈", "挥臂"],
      side: "right",
      intensity: 1,
    });
    expect(combo.positionOffset?.[0]).toBeGreaterThan(0.35);
    expect(combo.controls["rightUpLeg.pitch"]).toBe(-28);
    expect(combo.controls["rightArm.pitch"]).toBe(-62);
    expect(combo.controls["rightElbow.bend"]).toBe(28);

    const naturalCompound = expandMonoformPerformanceBeat({ action: "向右迈并挥臂", side: "right" });
    expect(naturalCompound.positionOffset?.[0]).toBeGreaterThan(0.35);
    expect(naturalCompound.controls["rightArm.pitch"]).toBe(-62);

    const lunge = expandMonoformPerformanceBeat({ action: "弓步", side: "left" });
    expect(lunge.positionOffset?.[1]).toBeGreaterThan(0.3);
    expect(lunge.controls["leftUpLeg.pitch"]).toBeLessThan(-30);
    expect(lunge.controls["torso.pitch"]).toBeLessThan(-5);

    const track = buildMonoformActionTrack({ performance: [
      { t: 0, pose: "idle" },
      { t: 1, actions: ["交叉步", "手臂绕环"], side: "left" },
      { t: 2, action: "收势", side: "both" },
    ] }, 24)!;
    const cross = track.find((key) => key.frame === 24)!;
    const settled = track.find((key) => key.frame === 48)!;
    expect(cross.position[0]).toBeLessThan(-0.2);
    expect(cross.joints?.mixamorigLeftArm).toBeTruthy();
    expect(settled.joints?.mixamorigLeftArm?.[1]).toBe(0);
  });

  it("高层舞步默认按人物朝向累积位置与转身，显式 at/facing 仍优先", () => {
    const keys = buildMonoformActionTrack({
      at: [0, 0], facing: 0,
      performance: [
        { t: 0, action: "向右迈", side: "right" },
        { t: 1, action: "向右转", intensity: 1 },
        { t: 2, action: "向前迈" },
        { t: 3, at: [4, 5], facing: 15, action: "收势" },
      ],
    }, 24)!;
    const step = keys.find((key) => key.frame === 0)!;
    const turned = keys.find((key) => key.frame === 24)!;
    const forward = keys.find((key) => key.frame === 48)!;
    const settled = keys.find((key) => key.frame === 72)!;
    expect(step.position[0]).toBeGreaterThan(0.4);
    expect(turned.rotation[1]).toBeCloseTo(Math.PI / 4);
    // 转身后向前应沿 45° 朝向移动，而不是继续沿世界 +Z。
    expect(forward.position[0]).toBeGreaterThan(turned.position[0]);
    expect(forward.position[2]).toBeGreaterThan(turned.position[2]);
    expect(settled.position).toEqual([4, 0, 5]);
    expect(settled.rotation[1]).toBeCloseTo((15 * Math.PI) / 180);
    expect(settled.pose).toBe("idle");
    expect(settled.continuousMotion).toBe(false);
  });

  it("舞蹈重拍可用 hold 保持准备姿态，再在落点切入主动作", () => {
    const keys = buildMonoformActionTrack({ performance: [
      { t: 0, action: "下沉", interpolation: "hold" },
      { t: 0.75, action: "向右转", interpolation: "linear" },
      { t: 1.5, action: "收势" },
    ] }, 24)!;
    expect(keys.map((key) => key.interpolation)).toEqual(["hold", "linear", "smooth"]);
  });

  it("间隔够长时先补一拍身体领先的准备，峰值仍落在原节拍", () => {
    const keys = buildMonoformActionTrack({ performance: [
      { t: 0, pose: "idle" },
      { t: 1.6, action: "伸手", side: "right" },
    ] }, 24)!;
    expect(keys.map((key) => key.frame)).toEqual([0, Math.round(1.15 * 24), 38]);
    const lead = keys[1];
    const peak = keys[2];
    const leadArm = Math.abs(lead.joints?.mixamorigRightArm?.[1] ?? 0);
    const peakArm = Math.abs(peak.joints?.mixamorigRightArm?.[1] ?? 0);
    expect(leadArm).toBeGreaterThan(0);
    expect(leadArm).toBeLessThan(peakArm);
    expect(Math.abs(lead.joints?.mixamorigSpine1?.[1] ?? 0)).toBeGreaterThan(0);
    expect(Math.abs(lead.joints?.mixamorigHead?.[1] ?? 0)).toBeGreaterThan(leadArm * 0.2);
  });

  it("争吵、告别、潜行和惊吓用各自的动作，不掉进舞步", () => {
    const accuse = expandMonoformPerformanceBeat({ action: "指责", side: "right", intensity: 1 });
    expect(accuse.positionOffset?.[1]).toBeGreaterThan(0.15);
    expect(accuse.controls["rightArm.pitch"]).toBeLessThan(-60);
    const cover = expandMonoformPerformanceBeat({ action: "捂脸" });
    expect(cover.controls["head.pitch"]).toBeGreaterThan(10);
    expect(cover.controls["leftElbow.bend"]).toBeGreaterThan(60);
    const sneak = expandMonoformPerformanceBeat({ action: "潜行", side: "left" });
    expect(sneak.pose).toBe("crouch");
    expect(sneak.controls["head.yaw"]).toBeLessThan(0);
    const flinch = expandMonoformPerformanceBeat({ action: "护住", intensity: 1 });
    expect(flinch.positionOffset?.[1]).toBeLessThan(0);
    const freeze = expandMonoformPerformanceBeat({ action: "愣住" });
    expect(freeze.continuousMotion).toBe(false);
  });

  it("对打出招会停住再接下一步，镜头不锁在一个人身上", () => {
    const keys = buildMonoformActionTrack({
      performance: [
        { t: 0, pose: "idle", interpolation: "hold" },
        { t: 1, action: "直拳", side: "right", interpolation: "linear" },
        { t: 2.4, action: "格挡" },
      ],
    }, 24)!;
    const punch = keys.find((key) => key.frame === 24)!;
    const between = keys.filter((key) => key.frame > 24 && key.frame < Math.round(2.4 * 24));
    expect(between.length).toBeGreaterThan(8);
    expect(between.every((key) => key.interpolation === "linear")).toBe(true);
    const mid = between[Math.floor(between.length / 2)];
    expect(mid.joints?.mixamorigRightArm?.[1]).not.toBeCloseTo(punch.joints?.mixamorigRightArm?.[1] ?? 0, 2);
    const scene = applyMonoformSceneIntent(
      { settings: { fps: 24 } },
      {
        type: DIRECTOR_SCENE_INTENT_TYPE,
        characters: [
          { name: "甲", at: [-0.6, 0], facing: 90, performance: [{ t: 1, action: "直拳" }] },
          { name: "乙", at: [0.6, 0], facing: -90, performance: [{ t: 1, action: "格挡" }] },
        ],
        shots: [{ name: "侧面", camera: { move: "static", size: "wide", focus: "甲", duration: 4 } }],
      },
    );
    const shot = (scene.shots as Array<{ camera?: { target?: number[] } }>)[0];
    const targetX = shot.camera?.target?.[0] ?? 99;
    expect(Math.abs(targetX)).toBeLessThan(0.2);
  });

  it("对打连续出拳也不会让两个人的身体叠在一起", () => {
    const next = applyMonoformSceneIntent(
      { settings: { fps: 24 } },
      {
        type: DIRECTOR_SCENE_INTENT_TYPE,
        characters: [
          {
            name: "甲", at: [-0.55, 0], facing: 90,
            performance: [
              { t: 0, pose: "stand_relaxed" },
              { t: 1, action: "直拳", side: "right" },
              { t: 2, action: "直拳", side: "right" },
              { t: 3, action: "进步" },
            ],
          },
          {
            name: "乙", at: [0.55, 0], facing: -90,
            performance: [
              { t: 0, pose: "stand_relaxed" },
              { t: 1, action: "直拳", side: "right" },
              { t: 2, action: "格挡" },
              { t: 3, action: "直拳", side: "right" },
            ],
          },
        ],
      },
    );
    const tracks = next.objectKeyframes as Record<string, Parameters<typeof trackPositionAt>[0]>;
    const maxFrame = Math.max(...Object.values(tracks).flatMap((track) => track.map((key) => key.frame)));
    let closest = Infinity;
    for (let frame = 0; frame <= maxFrame; frame += 2) {
      const [ax, az] = trackPositionAt(tracks.aigen_char_1, frame);
      const [bx, bz] = trackPositionAt(tracks.aigen_char_2, frame);
      closest = Math.min(closest, Math.hypot(ax - bx, az - bz));
    }
    expect(closest).toBeGreaterThan(0.8);
  });

  it("功夫站得过远时收到大约 1.1 米，停顿不再播循环站立", () => {
    const idlePunch = buildMonoformActionTrack({
      performance: [
        { t: 0, pose: "idle" },
        { t: 1, actions: ["直拳"], side: "right" },
        { t: 2.2, pose: "idle" },
      ],
    }, 24)!;
    expect(idlePunch.every((key) => key.continuousMotion !== true)).toBe(true);
    const next = applyMonoformSceneIntent(
      { settings: { fps: 24 } },
      {
        type: DIRECTOR_SCENE_INTENT_TYPE,
        characters: [
          {
            name: "甲", at: [-1.6, 0], facing: 90,
            performance: [
              { t: 0, pose: "idle" },
              { t: 1, actions: ["直拳"], side: "right" },
              { t: 2.2, at: [-1.4, 0], pose: "idle" },
            ],
          },
          {
            name: "乙", at: [1.6, 0], facing: -90,
            performance: [
              { t: 0, pose: "idle" },
              { t: 1, actions: ["格挡"] },
            ],
          },
        ],
      },
    );
    const tracks = next.objectKeyframes as Record<string, Parameters<typeof trackPositionAt>[0]>;
    const gap = (frame: number) => {
      const [ax, az] = trackPositionAt(tracks.aigen_char_1, frame);
      const [bx, bz] = trackPositionAt(tracks.aigen_char_2, frame);
      return Math.hypot(ax - bx, az - bz);
    };
    expect(gap(0)).toBeCloseTo(1.1, 1);
    expect(gap(24)).toBeGreaterThan(0.8);
    expect(gap(24)).toBeLessThan(1.45);
    expect(gap(Math.round(2.2 * 24))).toBeGreaterThan(0.8);
    expect(gap(Math.round(2.2 * 24))).toBeLessThan(1.45);
    for (const track of Object.values(tracks)) {
      expect(track.every((key) => key.continuousMotion !== true)).toBe(true);
    }
  });

  it("功夫每次出招前先蓄势，不足六个回合就补到六次攻防", () => {
    const chamber = expandMonoformPerformanceBeat({ action: "蓄势", side: "right", intensity: 1 });
    expect(chamber.controls["rightElbow.bend"]).toBeGreaterThan(70);
    expect(chamber.controls["rightArm.pitch"]).toBeGreaterThan(-70);
    expect(chamber.positionOffset?.[1]).toBeLessThan(0);
    const keys = buildMonoformActionTrack({
      performance: [
        { t: 0, pose: "idle" },
        { t: 1.2, action: "直拳", side: "right" },
      ],
    }, 24)!;
    const punchFrame = Math.round(1.2 * 24);
    const punch = keys.find((key) => key.frame === punchFrame)!;
    const windup = keys.filter((key) => key.frame < punchFrame).reduce((best, key) => (
      Math.abs(key.joints?.mixamorigRightForeArm?.[1] ?? 0) > Math.abs(best.joints?.mixamorigRightForeArm?.[1] ?? 0) ? key : best
    ));
    expect(keys.filter((key) => key.frame > 0 && key.frame < punchFrame).length).toBeGreaterThan(4);
    expect(Math.abs(windup.joints?.mixamorigRightForeArm?.[1] ?? 0)).toBeGreaterThan(Math.abs(punch.joints?.mixamorigRightForeArm?.[1] ?? 0));
    const next = applyMonoformSceneIntent(
      { settings: { fps: 24 } },
      {
        type: DIRECTOR_SCENE_INTENT_TYPE,
        mode: "compose",
        duration: 8,
        characters: [
          {
            name: "甲", at: [-0.55, 0], facing: 90,
            performance: [
              { t: 0, pose: "idle" },
              { t: 1.2, action: "直拳", side: "right" },
              { t: 3, action: "摆拳", side: "left" },
              { t: 5, action: "前踢", side: "right" },
              { t: 7.2, action: "收势" },
            ],
          },
          {
            name: "乙", at: [0.55, 0], facing: -90,
            performance: [
              { t: 0, pose: "idle" },
              { t: 1.2, action: "格挡" },
              { t: 3, action: "闪避", side: "right" },
              { t: 5, action: "退步" },
              { t: 7.2, action: "收势" },
            ],
          },
        ],
      },
    );
    expect(next.settings?.durationSeconds).toBeGreaterThan(9);
    const tracks = next.objectKeyframes as Record<string, Parameters<typeof trackPositionAt>[0]>;
    const maxFrame = Math.max(...Object.values(tracks).flatMap((track) => track.map((key) => key.frame)));
    expect(maxFrame / 24).toBeGreaterThan(9);
    let closest = Infinity;
    for (let frame = 0; frame <= maxFrame; frame += 2) {
      const [ax, az] = trackPositionAt(tracks.aigen_char_1, frame);
      const [bx, bz] = trackPositionAt(tracks.aigen_char_2, frame);
      closest = Math.min(closest, Math.hypot(ax - bx, az - bz));
    }
    expect(closest).toBeGreaterThan(0.8);
    const edited = applyMonoformSceneIntent(
      { settings: { fps: 24 } },
      {
        type: DIRECTOR_SCENE_INTENT_TYPE,
        mode: "edit",
        characters: [
          { name: "甲", at: [-0.55, 0], facing: 90, performance: [{ t: 0, pose: "idle" }, { t: 1, action: "直拳" }] },
          { name: "乙", at: [0.55, 0], facing: -90, performance: [{ t: 0, pose: "idle" }, { t: 1, action: "格挡" }] },
        ],
      },
    );
    const editedTracks = edited.objectKeyframes as Record<string, { frame: number }[]>;
    const editedMax = Math.max(...Object.values(editedTracks).flatMap((track) => track.map((key) => key.frame)));
    expect(editedMax).toBeLessThan(48);
  });

  it("功夫出招向前送到身前，格挡和闪避是接招而不是另一套舞", () => {
    const punch = expandMonoformPerformanceBeat({ action: "直拳", side: "right", intensity: 1 });
    expect(punch.positionOffset?.[1]).toBeGreaterThan(0.1);
    expect(punch.positionOffset?.[1]).toBeLessThan(0.25);
    expect(punch.controls["rightArm.pitch"]).toBeLessThan(-70);
    expect(punch.controls["leftElbow.bend"]).toBeGreaterThan(40);
    const block = expandMonoformPerformanceBeat({ action: "格挡", intensity: 1 });
    expect(block.positionOffset?.[1]).toBeLessThan(0);
    expect(block.controls["leftElbow.bend"]).toBeGreaterThan(50);
    expect(block.controls["rightElbow.bend"]).toBeGreaterThan(50);
    const dodge = expandMonoformPerformanceBeat({ action: "闪避", side: "left", intensity: 1 });
    expect(dodge.positionOffset?.[0]).toBeLessThan(-0.3);
  });

  it("看向会带动头、颈和躯干，收势把头的侧倾也收回", () => {
    const look = expandMonoformPerformanceBeat({ action: "看向", side: "left" });
    expect(look.controls["head.yaw"]).toBeLessThan(-15);
    expect(look.controls["torso.yaw"]).toBeLessThan(-10);
    expect(look.controls["neck.yaw"]).toBeLessThan(0);
    const settle = expandMonoformPerformanceBeat({ action: "收势" });
    expect(settle.controls["head.roll"]).toBe(0);
    expect(settle.controls["neck.yaw"]).toBe(0);
  });
});

describe("buildMonoformCameraTrack（运镜）", () => {
  const persons = [{ type: "person", position: [-1, 0, 0] }, { type: "person", position: [1, 0, 0] }];

  it("orbit：在质心周围采样圆弧，target 恒为质心（视线跟着人）", () => {
    const keys = buildMonoformCameraTrack({ move: "orbit-right", duration: 6 }, persons, 24);
    const last = keys.length - 1;
    expect(keys[0].frame).toBe(0);
    expect(keys[last].frame).toBe(144); // 6s * 24fps
    expect(keys[0].position[0]).toBeCloseTo(0, 5); // sin(0) = 0
    expect(keys[0].position[2]).toBeCloseTo(5, 5); // cos(0) * 半径
    expect(keys[last].position[0]).toBeCloseTo(5, 5); // 转 90° 到侧面
    expect(keys[last].position[2]).toBeCloseTo(0, 5);
    for (const k of keys) expect(k.target).toEqual([0, 1.5, 0]);
    expect(keys[0].focalLength).toBe(50);
  });

  it("dolly-in：从远处推到近处；dolly-out 反向", () => {
    const inKeys = buildMonoformCameraTrack({ move: "dolly-in", duration: 4 }, persons, 24);
    expect(inKeys[0].position[2]).toBeCloseTo(7.25, 5);
    expect(inKeys[inKeys.length - 1].position[2]).toBeCloseTo(3.1, 5);
    const outKeys = buildMonoformCameraTrack({ move: "dolly-out", duration: 4 }, persons, 24);
    expect(outKeys[0].position[2]).toBeCloseTo(3.1, 5);
    expect(outKeys[outKeys.length - 1].position[2]).toBeCloseTo(7.25, 5);
  });

  it("pan：机位不动、视线落点横向平移（摇镜）", () => {
    const keys = buildMonoformCameraTrack({ move: "pan-left", duration: 3 }, persons, 24);
    expect(keys[0].position).toEqual(keys[keys.length - 1].position); // 机位固定
    // 方向约定（本阶段统一）：相机在 +z 看向 -z 时「屏幕右 = 世界 +x」，
    // 所以 pan-left 从 +x 侧摇向 -x 侧，与 rail-left/right 同一套。
    // 原来这条断言是 -1.1 → +1.1、注释却写「起手看向 +x 侧」—— 数值与注释相反，
    // 说明当初约定没定清；这里连同 pan 的实现一起对齐。
    expect(keys[0].target[0]).toBeCloseTo(1.1, 5);
    expect(keys[keys.length - 1].target[0]).toBeCloseTo(-1.1, 5);
  });

  it("start：整个运动整体后移", () => {
    const keys = buildMonoformCameraTrack({ move: "orbit-right", duration: 4, start: 2 }, persons, 24);
    expect(keys[0].frame).toBe(48);
    expect(keys[keys.length - 1].frame).toBe(144);
  });

  it("move 缺省/static → 空轨（= 静态机位）", () => {
    expect(buildMonoformCameraTrack({ move: "static" }, persons, 24)).toEqual([]);
    expect(buildMonoformCameraTrack(undefined, persons, 24)).toEqual([]);
  });
});

describe("applyMonoformSceneIntent — 物品 / 动画 / 运镜 / 编排", () => {
  // 把局部字段补全成合法 intent 的小工具（type 必须对，否则连解析器都不认）。
  const scene = (partial: Record<string, unknown>) =>
    ({ type: DIRECTOR_SCENE_INTENT_TYPE, ...partial }) as Parameters<typeof applyMonoformSceneIntent>[1];

  it("物品替换只动上一批 AI 物品，用户手摆的保留", () => {
    const project = {
      objects: [
        { id: "aigen_prop_1", type: "box", position: [0, 0.5, 0] },
        { id: "user-table", type: "table", position: [3, 0.5, 3] },
      ],
    };
    const next = applyMonoformSceneIntent(project, scene({ objects: [{ type: "chair", at: [1, 0] }] }));
    const ids = next.objects!.map((o) => o.id);
    expect(ids).toContain("user-table"); // 用户手摆的不动
    expect(ids).toContain("aigen_prop_1"); // 新批次顶掉旧序号（同 id，类型已变，见下）
    expect(next.objects!.find((o) => o.id === "aigen_prop_1")!.type).toBe("chair");
    expect(next.objects!.filter((o) => o.type === "table")).toHaveLength(1); // 旧的 AI 物品没留下
  });

  it("角色带 route 时建轨、清掉上一批 AI 角色的旧轨（不残留旧路线）", () => {
    const project = {
      objects: [{ id: "aigen_char_1", type: "person", position: [0, 0, 0] }],
      objectKeyframes: { aigen_char_1: [{ frame: 0 }], "user-person": [{ frame: 0 }] },
      settings: { fps: 24 },
    };
    const next = applyMonoformSceneIntent(
      project,
      scene({ characters: [{ route: [[0, 0], [2, 0]], routeDuration: 2 }] }),
    );
    const tracks = next.objectKeyframes as Record<string, unknown[]>;
    expect(tracks["user-person"]).toHaveLength(1); // 用户角色的轨不动
    expect(tracks.aigen_char_1).toHaveLength(3); // 2 个路点 + 1 个静止帧
  });

  it("运镜写进顶层 keyframes，并**同时**写活动 shot（否则被 shot 覆盖）", () => {
    const project = {
      activeShotId: "shot-01",
      objects: [{ id: "p", type: "person", position: [0, 0, 0] }],
      shots: [{ id: "shot-01", objects: [] }, { id: "shot-02", objects: [] }],
    };
    const next = applyMonoformSceneIntent(project, scene({ camera: { move: "orbit-right", duration: 6 } }));
    expect((next.keyframes as unknown[]).length).toBeGreaterThan(9);
    expect((next.shots![0].keyframes as unknown[]).length).toBe(
      (next.keyframes as unknown[]).length,
    );
    expect((next.shots![1].keyframes as unknown[] | undefined) ?? null).toBeNull(); // 非活动 shot 不动
    expect(next.camera!.position).toEqual((next.keyframes as { position: number[] }[])[0].position);
  });

  it("静态机位把旧运镜清成空轨（否则旧运动还在跑）", () => {
    const project = {
      keyframes: [{ frame: 0, position: [9, 9, 9] }],
      camera: { position: [0, 2.4, 5], focalLength: 50, aspectRatio: "9:16" },
      objects: [{ id: "p", type: "person", position: [1, 0, 1] }],
    };
    const next = applyMonoformSceneIntent(project, scene({ camera: { move: "static" } }));
    expect(next.keyframes).toEqual([]);
    expect(next.camera!.aspectRatio).toBe("9:16"); // 画幅是用户的设置，不被摆场景改掉
    expect(next.camera!.position).toEqual([1, 1.6, 6]); // 质心 [1,1] 前方 5m，平视眼高
    expect(next.camera!.target).toEqual([1, 1.5, 1]);
  });

  it("近景把机位拉近并换长焦，俯拍才抬高机位", () => {
    const close = applyMonoformSceneIntent(
      { objects: [{ id: "p", type: "person", position: [0, 0, 0] }] },
      scene({ camera: { move: "static", size: "close", height: "eye" } }),
    );
    expect(close.camera!.position).toEqual([0, 1.6, 2.4]);
    expect(close.camera!.focalLength).toBe(70);
    const high = applyMonoformSceneIntent(
      { objects: [{ id: "p", type: "person", position: [0, 0, 0] }] },
      scene({ camera: { move: "static", size: "medium", height: "high" } }),
    );
    expect(high.camera!.position?.[1]).toBe(3.4);
  });

  it("镜头跟着走动的人：视线落点取该帧人物位置", () => {
    const project = { settings: { fps: 24 } };
    const next = applyMonoformSceneIntent(
      project,
      scene({
        characters: [{ at: [-3, 0], route: [[-3, 0], [3, 0]], routeDuration: 4 }],
        camera: { move: "dolly-in", duration: 4, start: 4 },
      }),
    );
    const keys = next.keyframes as { frame: number; target: number[] }[];
    // 相机 4s 后才动，此时角色已走到终点 x=3 → 落点应该跟到 3，而不是出发点
    expect(keys[0].frame).toBe(96);
    expect(keys[0].target[0]).toBeCloseTo(3, 5);
  });

  it("三块都给时一次成型：人 + 物品 + 运镜同一份工程", () => {
    const next = applyMonoformSceneIntent(
      { settings: { fps: 24 } },
      scene({
        characters: [{ at: [-1, 0], facing: 90 }, { at: [1, 0], facing: -90 }],
        objects: [{ type: "table", at: [0, 2] }],
        camera: { move: "orbit-left", duration: 6 },
      }),
    );
    expect(next.objects!.filter((o) => o.type === "person")).toHaveLength(2);
    expect(next.objects!.filter((o) => o.id === "aigen_prop_1")).toHaveLength(1);
    expect((next.keyframes as unknown[]).length).toBeGreaterThan(9);
  });

  it("电影级单镜头演出同时写角色动作轨与相机轨", () => {
    const next = applyMonoformSceneIntent(
      { settings: { fps: 24 } },
      scene({
        characters: [
          {
            name: "林晚",
            at: [-0.6, 0],
            facing: 90,
            performance: [
              { t: 0, pose: "idle", controls: { "head.pitch": 0 } },
              { t: 2, pose: "agree", controls: { "head.pitch": -18 } },
            ],
          },
          {
            name: "周宁",
            at: [0.6, 0],
            facing: -90,
            performance: [
              { t: 0, pose: "idle" },
              { t: 2, pose: "idle", controls: { "rightShoulder.pitch": 30 } },
            ],
          },
        ],
        camera: { move: "dolly-in", duration: 4, size: "medium", height: "eye" },
      }),
    );
    const tracks = next.objectKeyframes as Record<string, unknown[]>;
    expect(tracks.aigen_char_1).toHaveLength(2);
    expect(tracks.aigen_char_2).toHaveLength(2);
    expect((next.keyframes as unknown[]).length).toBeGreaterThan(1);
    // 明确写 camera 表示单镜头，不能被翻译层擅自扩成三台。
    expect(next.shots).toBeUndefined();
  });

  it("重编整场并选择单镜头时，替换旧场景的多机位", () => {
    const next = applyMonoformSceneIntent({
      activeShotId: "old-2", shots: [{ id: "old-1" }, { id: "old-2" }],
    }, scene({
      characters: [{ performance: [{ t: 0 }, { t: 3, controls: { "head.pitch": -12 } }] }],
      camera: { move: "dolly-in", duration: 3 },
    }));
    expect(next.shots).toHaveLength(1);
    expect(next.shots?.[0].objectKeyframes).toEqual(next.objectKeyframes);
    expect(next.shots?.[0].keyframes).toEqual(next.keyframes);
    const actor = next.objects?.find((o) => o.type === "person");
    const track = next.objectKeyframes?.aigen_char_1 as { position: number[] }[];
    expect(track[0].position).toEqual(actor?.position);
  });

  it.each(["performance", "route"] as const)("点名更新 %s 后共享演员的所有机位一致，独立对象与相机保留", (kind) => {
    const original = applyMonoformSceneIntent({}, scene({
      characters: [{ name: "甲", at: [3, -2], facing: 90 }],
      shots: [
        { name: "全景", camera: { move: "static", size: "wide" } },
        { name: "推进", camera: { move: "dolly-in", duration: 4 } },
        { name: "侧面", camera: { move: "rail-left", duration: 4 } },
      ],
    }));
    original.shots?.[1].objects?.push({ id: "private-prop", type: "box" });
    const next = applyMonoformSceneIntent(original, scene({ characters: [{
      target: "aigen_char_1",
      ...(kind === "performance"
        ? { performance: [{ t: 0, pose: "idle" }, { t: 2, pose: "wave" }] }
        : { route: [[3, -2], [4, -2]] as [number, number][] }),
    }] }));
    expect(next.shots).toHaveLength(3);
    for (let i = 0; i < 3; i += 1) {
      expect(next.shots?.[i].objectKeyframes?.aigen_char_1).toEqual(next.objectKeyframes?.aigen_char_1);
      expect(next.shots?.[i].objects?.find((o) => o.id === "aigen_char_1")).toEqual(next.objects?.[0]);
      expect(next.shots?.[i].camera).toEqual(original.shots?.[i].camera);
      expect(next.shots?.[i].keyframes).toEqual(original.shots?.[i].keyframes);
    }
    expect(next.shots?.[1].objects?.find((o) => o.id === "private-prop")).toBeTruthy();
    const track = next.objectKeyframes?.aigen_char_1 as { position: number[]; rotation: number[] }[];
    expect(track[0].position).toEqual([3, 0, -2]);
    expect(track[0].rotation[1]).toBeCloseTo(Math.PI / 2);
  });

  it("仅增加镜头也保留原有表演轨，并让新机位跟随演员位置", () => {
    const original = applyMonoformSceneIntent({}, scene({ characters: [{
      name: "甲", at: [0, 0], performance: [{ t: 0, at: [0, 0] }, { t: 2, at: [3, 0] }],
    }] }));
    const next = applyMonoformSceneIntent(original, scene({ shots: [
      { name: "推进", camera: { move: "dolly-in", start: 2, duration: 3 } },
      { name: "拉远", camera: { move: "dolly-out", start: 2, duration: 3 } },
    ] }));
    for (const shot of next.shots ?? []) {
      expect(shot.objectKeyframes).toEqual(original.objectKeyframes);
      const keys = shot.keyframes as { target: number[] }[];
      expect(keys[0].target[0]).toBe(3);
    }
  });
});

describe("summarizeMonoformProject — 给 agent 的现状摘要", () => {
  it("人物/物品/镜头各一行，人物带位置朝向姿势与是否在动", () => {
    const text = summarizeMonoformProject({
      objects: [
        {
          id: "aigen_char_1",
          name: "甲",
          type: "person",
          pose: "walk",
          position: [-2, 0, 0.5],
          rotation: [0, Math.PI / 2, 0],
        },
        { id: "aigen_prop_1", name: "桌子", type: "table", position: [0, 0.5, 2.2] },
      ],
      objectKeyframes: { aigen_char_1: [{ frame: 0 }, { frame: 72 }] },
      camera: { position: [0, 2.4, 3.2], focalLength: 85 },
      keyframes: [],
    });

    expect(text).toContain("[白模台当前场景]");
    // 朝向报的是**度数**（模型读得懂），内部存的是弧度。
    expect(text).toContain("人物 aigen_char_1「甲」 站[-2,0.5] 面向90° 姿势walk（有走位动画）");
    expect(text).toContain("物品 aigen_prop_1「桌子」 类型table 位置[0,2.2]");
    expect(text).toContain("镜头 位置[0,2.4,3.2] 焦距85mm 静止");
  });

  it("相机有关键帧轨时报「有运镜」，不再说静止", () => {
    const text = summarizeMonoformProject({
      camera: { position: [0, 2.4, 3.2], focalLength: 50 },
      keyframes: [{ frame: 0 }, { frame: 72 }, { frame: 216 }],
    });
    expect(text).toContain("有运镜（3 个关键帧）");
    expect(text).not.toContain("静止");
  });

  it("空工程返回空串（不喂一段空上下文给模型）", () => {
    expect(summarizeMonoformProject({})).toBe("");
  });

  it("对象过多时折叠成一行（守住 token 预算）", () => {
    const project = {
      objects: Array.from({ length: 35 }, (_, i) => ({
        id: `aigen_char_${i}`,
        type: "person",
        position: [i, 0, 0],
        rotation: [0, 0, 0],
      })),
    };
    const text = summarizeMonoformProject(project);

    expect(text.split("\n").filter((line) => line.startsWith("- 人物")).length).toBe(20);
    expect(text).toContain("另有 15 个对象未列出");
  });
});

describe("reset — 清空重来", () => {
  const resetIntent: DirectorSceneIntent = { type: DIRECTOR_SCENE_INTENT_TYPE, reset: true };

  it("清对象与动画轨，保留相机位姿与 settings（没有相机就没视角）", () => {
    const project = {
      objects: [{ id: "aigen_char_1", type: "person" }, { id: "user_1", type: "table" }],
      objectKeyframes: { aigen_char_1: [{ frame: 0 }] },
      keyframes: [{ frame: 0 }],
      camera: { position: [0, 2.4, 3.2], focalLength: 85 },
      settings: { fps: 24, duration: 15 },
    };
    const next = applyMonoformSceneIntent(project, resetIntent);

    expect(next.objects).toEqual([]);
    expect(next.objectKeyframes).toEqual({});
    expect(next.keyframes).toEqual([]);
    expect(next.camera).toEqual({ position: [0, 2.4, 3.2], focalLength: 85 });
    expect(next.settings).toEqual({ fps: 24, duration: 15 });
  });

  it("活动 shot 里的对象也一起清（只清顶层等于没清，normalizeShot 以 shot.* 优先）", () => {
    const project = {
      activeShotId: "s2",
      objects: [{ id: "top" }],
      shots: [
        { id: "s1", objects: [{ id: "a" }], keyframes: [{ frame: 1 }] },
        { id: "s2", objects: [{ id: "b" }], objectKeyframes: { x: [{}] } },
      ],
    };
    const next = applyMonoformSceneIntent(project, resetIntent);
    const shots = next.shots as Array<Record<string, unknown>>;

    expect(shots[1].objects).toEqual([]);
    expect(shots[1].objectKeyframes).toEqual({});
    // 非活动 shot 不碰
    expect(shots[0].objects).toEqual([{ id: "a" }]);
  });

  it("reset 优先于其他字段（用户说「清空」时不该顺手又摆点东西）", () => {
    const next = applyMonoformSceneIntent(
      { objects: [{ id: "old" }] },
      { ...resetIntent, characters: [{ at: [1, 1] }] },
    );
    expect(next.objects).toEqual([]);
  });
});

describe("增量模式（元素带 target）", () => {
  const base = () => ({
    objects: [
      {
        id: "aigen_char_1",
        name: "甲",
        type: "person",
        pose: "idle",
        position: [-2, 0, 0],
        rotation: [0, 1.5708, 0],
        scale: [1, 1, 1],
        color: "#e8e3d8",
      },
      {
        id: "aigen_char_2",
        name: "乙",
        type: "person",
        pose: "walk",
        position: [2, 0, 0],
        rotation: [0, -1.5708, 0],
        scale: [1, 1, 1],
        color: "#e8e3d8",
      },
      { id: "user_prop_1", name: "用户手摆的桌子", type: "table", position: [0, 0.5, 3] },
    ],
    objectKeyframes: { aigen_char_2: [{ frame: 0 }, { frame: 72 }] },
    settings: { fps: 24 },
  });
  type Obj = Record<string, unknown>;

  it("命中 id：只改那一个，其他对象逐字段不变（含只覆盖显式给了的字段）", () => {
    const project = base();
    const before = JSON.parse(JSON.stringify(project));
    const next = applyMonoformSceneIntent(project, {
      type: DIRECTOR_SCENE_INTENT_TYPE,
      characters: [{ target: "aigen_char_1", at: [-3, 1] }],
    });
    const objs = next.objects as Obj[];

    expect(objs).toHaveLength(3); // 没删任何东西
    expect(objs[0].position).toEqual([-3, 0, 1]); // 甲动了
    expect(objs[0].pose).toBe("idle"); // 姿势**没被重置**（关键：没说就不动）
    expect(objs[0].rotation).toEqual(before.objects[0].rotation); // 朝向也没动
    expect(objs[1]).toEqual(before.objects[1]); // 乙完全没变
    expect(objs[2]).toEqual(before.objects[2]); // 用户手摆的也没变
  });

  it("用 name 也能命中", () => {
    const next = applyMonoformSceneIntent(base(), {
      type: DIRECTOR_SCENE_INTENT_TYPE,
      characters: [{ target: "乙", facing: 0 }],
    });
    const objs = next.objects as Obj[];
    expect((objs[1].rotation as number[])[1]).toBeCloseTo(0);
  });

  it("匹配不到时追加为新对象，其余原样", () => {
    const next = applyMonoformSceneIntent(base(), {
      type: DIRECTOR_SCENE_INTENT_TYPE,
      characters: [{ target: "查无此人", at: [5, 5] }],
    });
    const objs = next.objects as Obj[];
    expect(objs).toHaveLength(4);
    expect(objs[3].position).toEqual([5, 0, 5]);
    expect(objs[0].position).toEqual([-2, 0, 0]);
  });

  it("未提及对象的动画轨保留", () => {
    const next = applyMonoformSceneIntent(base(), {
      type: DIRECTOR_SCENE_INTENT_TYPE,
      characters: [{ target: "aigen_char_1", at: [0, 0] }],
    });
    const tracks = next.objectKeyframes as Record<string, unknown[]>;
    expect(tracks.aigen_char_2).toHaveLength(2); // 乙的走位轨没被清掉
  });

  it("命中且给了 route：只重建它自己的轨", () => {
    const next = applyMonoformSceneIntent(base(), {
      type: DIRECTOR_SCENE_INTENT_TYPE,
      characters: [{ target: "aigen_char_1", route: [[-3, 0], [0, 0]], routeDuration: 2 }],
    });
    const tracks = next.objectKeyframes as Record<string, unknown[]>;
    expect(Array.isArray(tracks.aigen_char_1)).toBe(true);
    expect(tracks.aigen_char_2).toHaveLength(2);
  });

  it("物品也能增量（用 id 命中，y 用该类型的默认抬升）", () => {
    const next = applyMonoformSceneIntent(base(), {
      type: DIRECTOR_SCENE_INTENT_TYPE,
      objects: [{ type: "table", target: "user_prop_1", at: [1, 1] }],
    });
    const objs = next.objects as Obj[];
    expect(objs).toHaveLength(3);
    expect(objs[2].position).toEqual([1, 0.5, 1]); // table 的默认 y = 0.5
  });

  it("增量同时写活动 shot（normalizeShot 以 shot.* 优先）", () => {
    const project = {
      ...base(),
      activeShotId: "s1",
      shots: [{ id: "s1", objects: base().objects }],
    };
    const next = applyMonoformSceneIntent(project, {
      type: DIRECTOR_SCENE_INTENT_TYPE,
      objects: [{ type: "table", target: "user_prop_1", at: [1, 1] }],
    });
    const shots = next.shots as Array<{ objects: Obj[] }>;
    expect(shots[0].objects).toHaveLength(3);
    expect(shots[0].objects[2].position).toEqual([1, 0.5, 1]);
  });

  it("一个 target 都没有时保持整批替换（向后兼容）", () => {
    const next = applyMonoformSceneIntent(base(), {
      type: DIRECTOR_SCENE_INTENT_TYPE,
      characters: [{ at: [7, 7] }],
    });
    const objs = next.objects as Obj[];
    expect(objs.filter((o) => o.type === "person")).toHaveLength(1); // 两个 AI 角色被替换成一个
    expect(objs.filter((o) => o.id === "user_prop_1")).toHaveLength(1); // 用户手摆的保留
  });
});

describe("导演级运镜的几何", () => {
  const persons = [
    { id: "p1", type: "person", position: [0, 0, 0], rotation: [0, 0, 0] }, // yaw 0 → 面向 +z
    { id: "p2", type: "person", position: [2, 0, 0], rotation: [0, Math.PI, 0] },
  ];
  const run = (move: string, extra: Record<string, unknown> = {}) =>
    buildMonoformCameraTrack({ move, duration: 4, ...extra } as never, persons, 24, []);

  it("crane-up：y 单调上升，水平位置固定（纯升降）", () => {
    const keys = run("crane-up");
    expect(keys.length).toBeGreaterThanOrEqual(2);
    const ys = keys.map((k) => k.position[1]);
    ys.forEach((y, i) => {
      if (i > 0) expect(y).toBeGreaterThanOrEqual(ys[i - 1]);
    });
    expect(ys[ys.length - 1]).toBeGreaterThan(ys[0]);
    expect(new Set(keys.map((k) => k.position[0])).size).toBe(1); // 水平不动
  });

  it("crane-down 与 crane-up 反向", () => {
    const up = run("crane-up");
    const down = run("crane-down");
    expect(down[0].position[1]).toBeGreaterThan(down[down.length - 1].position[1]);
    expect(up[0].position[1]).toBeLessThan(down[0].position[1]);
  });

  it("rail-right：x 单调增加、y 固定（纯横移）", () => {
    const keys = run("rail-right");
    const xs = keys.map((k) => k.position[0]);
    xs.forEach((x, i) => {
      if (i > 0) expect(x).toBeGreaterThanOrEqual(xs[i - 1]);
    });
    expect(new Set(keys.map((k) => k.position[1])).size).toBe(1);
  });

  it("pan-right 的落点 / rail-right 的机位都往 +x 走（两个「右」同义）", () => {
    const pan = run("pan-right");
    const rail = run("rail-right");
    const panXs = pan.map((k) => k.target?.[0] ?? 0);
    const railXs = rail.map((k) => k.position[0]);
    expect(panXs[panXs.length - 1]).toBeGreaterThan(panXs[0]);
    expect(railXs[railXs.length - 1]).toBeGreaterThan(railXs[0]);
  });

  it("handheld：同一 intent 两次调用逐字节相同（确定性，否则重放会变）", () => {
    expect(JSON.stringify(run("handheld"))).toBe(JSON.stringify(run("handheld")));
  });

  it("zoom-in：机位完全不动、焦距单调变长", () => {
    const keys = run("zoom-in");
    expect(new Set(keys.map((k) => JSON.stringify(k.position))).size).toBe(1);
    const focals = keys.map((k) => k.focalLength as number);
    focals.forEach((f, i) => {
      if (i > 0) expect(f).toBeGreaterThanOrEqual(focals[i - 1]);
    });
    expect(focals[focals.length - 1]).toBeGreaterThan(focals[0]);
  });

  it("pov：机位在角色眼高、目标落在他朝向前方", () => {
    const keys = run("pov");
    expect(keys[0].position[1]).toBeCloseTo(1.55, 2);
    expect(keys[0].position[0]).toBeCloseTo(0, 5); // 角色在原点
    expect(keys[0].target?.[2] ?? 0).toBeGreaterThan(0); // yaw 0 → 前方 +z
  });

  it("over-shoulder 的 subject 决定站在谁身后", () => {
    const persons = [
      { id: "a", name: "甲", type: "person", position: [-1, 0, 0], rotation: [0, Math.PI / 2, 0] },
      { id: "b", name: "乙", type: "person", position: [1, 0, 0], rotation: [0, -Math.PI / 2, 0] },
    ];
    const behindFirst = buildMonoformCameraTrack({ move: "over-shoulder", subject: "甲" }, persons, 24);
    const behindSecond = buildMonoformCameraTrack({ move: "over-shoulder", subject: "乙" }, persons, 24);
    expect(behindFirst[0].position[0]).toBeLessThan(-1);
    expect(behindSecond[0].position[0]).toBeGreaterThan(1);
    expect(behindFirst[0].target?.[0]).toBeCloseTo(1, 2);
    expect(behindSecond[0].target?.[0]).toBeCloseTo(-1, 2);
  });

  it("两人戏没写镜头时不自动凑成三台", () => {
    const next = applyMonoformSceneIntent(
      {},
      {
        type: DIRECTOR_SCENE_INTENT_TYPE,
        characters: [
          { name: "林晚", at: [-1.2, 0], facing: 90 },
          { name: "周宁", at: [1.2, 0], facing: -90 },
        ],
      },
    );
    expect(next.shots ?? []).toHaveLength(0);
    expect(next.objects?.filter((object) => object.type === "person")).toHaveLength(2);
  });

  it("工程里已经有两台时，不再用默认覆盖替换镜头列表", () => {
    const next = applyMonoformSceneIntent(
      {
        activeShotId: "shot-01",
        shots: [{ id: "shot-01", name: "已有甲" }, { id: "shot-02", name: "已有乙" }],
      },
      {
        type: DIRECTOR_SCENE_INTENT_TYPE,
        characters: [
          { name: "甲", at: [-1, 0], facing: 90 },
          { name: "乙", at: [1, 0], facing: -90 },
        ],
      },
    );
    expect(next.shots).toHaveLength(2);
    expect(next.shots?.[0].name).toBe("已有甲");
    expect(next.shots?.[1].name).toBe("已有乙");
  });

  it("shots 写成多条镜头，第一条成为当前机位", () => {
    const next = applyMonoformSceneIntent(
      {},
      {
        type: DIRECTOR_SCENE_INTENT_TYPE,
        characters: [
          { name: "甲", at: [-1, 0], facing: 90 },
          { name: "乙", at: [1, 0], facing: -90 },
        ],
        shots: [
          { name: "甲越肩", camera: { move: "over-shoulder", subject: "甲", size: "medium", height: "eye" } },
          { name: "乙反打", camera: { move: "over-shoulder", subject: "乙", size: "medium", height: "eye" } },
        ],
      },
    );
    expect(next.shots).toHaveLength(2);
    expect(next.activeShotId).toBe("aigen_shot_1");
    expect(next.shots?.[0].name).toBe("甲越肩");
    expect(next.shots?.[1].name).toBe("乙反打");
    const firstX = (next.shots?.[0].camera as { position: number[] }).position[0];
    const secondX = (next.shots?.[1].camera as { position: number[] }).position[0];
    expect(firstX).toBeLessThan(0);
    expect(secondX).toBeGreaterThan(0);
    expect(next.shots?.[0].objects).toHaveLength(2);
    expect(next.shots?.[1].objects).toHaveLength(2);
  });

  it("增量改人时 shots 不会被丢掉", () => {
    const next = applyMonoformSceneIntent(
      {
        objects: [{ id: "aigen_char_1", type: "person", name: "甲", position: [0, 0, 0] }],
      },
      {
        type: DIRECTOR_SCENE_INTENT_TYPE,
        characters: [{ target: "aigen_char_1", at: [-1, 0], facing: 90 }],
        shots: [
          { name: "甲越肩", camera: { move: "over-shoulder", subject: "甲", size: "medium", height: "eye" } },
          { name: "乙反打", camera: { move: "static", size: "wide", height: "eye" } },
        ],
      },
    );
    expect(next.shots).toHaveLength(2);
    expect(next.activeShotId).toBe("aigen_shot_1");
  });

  it("over-shoulder：按两人的关系轴站后侧，不跟错误的角色朝向翻到轴线另一边", () => {
    const keys = run("over-shoulder");
    expect(keys[0].position[0]).toBeLessThan(0); // 对面在 +x → 机位在 -x 后侧
    expect(keys[0].position[2]).toBeGreaterThan(0);
    expect(keys[0].target?.[0] ?? 0).toBeCloseTo(2, 2); // 第二个人在 +x
  });

  it("没角色时 pov / over-shoulder 退回单帧静态机位且不抛错", () => {
    expect(() => buildMonoformCameraTrack({ move: "pov" } as never, [], 24, [])).not.toThrow();
    expect(buildMonoformCameraTrack({ move: "pov" } as never, [], 24, []).length).toBe(1);
    expect(buildMonoformCameraTrack({ move: "over-shoulder" } as never, [], 24, []).length).toBe(1);
  });
});

describe("逐骨骼造型（controls → joints）", () => {
  it("度数按实际骨骼轴转换，肘弯曲不能写进沿骨长轴的 X", () => {
    const joints = buildMonoformJoints({
      "head.pitch": 90, // → mixamorigHead 的 X 轴，π/2
      "leftShoulder.spread": -85, // → LeftShoulder 的 Z 轴
      "rightElbow.bend": 45, // → RightForeArm 的 Y 轴
      "leftElbow.bend": 45, // 左肘需要镜像方向
    })!;

    expect(joints.mixamorigHead[0]).toBeCloseTo(Math.PI / 2, 5);
    expect(joints.mixamorigHead[1]).toBe(0);
    expect(joints.mixamorigLeftShoulder[2]).toBeCloseTo((-85 * Math.PI) / 180, 5);
    expect(joints.mixamorigRightForeArm[0]).toBe(0);
    expect(joints.mixamorigRightForeArm[1]).toBeCloseTo((45 * Math.PI) / 180, 5);
    expect(joints.mixamorigLeftForeArm[1]).toBeCloseTo((-45 * Math.PI) / 180, 5);
  });

  it("同一个骨骼的多个轴合并进同一个三元组", () => {
    const joints = buildMonoformJoints({ "head.pitch": 10, "head.yaw": 20, "head.roll": 30 })!;
    const head = joints.mixamorigHead;
    expect(head[0]).toBeCloseTo((10 * Math.PI) / 180, 5);
    expect(head[1]).toBeCloseTo((20 * Math.PI) / 180, 5);
    expect(head[2]).toBeCloseTo((30 * Math.PI) / 180, 5);
  });

  it("白名单外的关节名静默丢弃，不抛错", () => {
    const joints = buildMonoformJoints({
      "leftPinky3.bend": 30, // 手指不在白名单
      "tail.wag": 45, // 根本没有这根
      "head.pitch": 10, // 合法的那根要留下
    })!;
    expect(Object.keys(joints)).toEqual(["mixamorigHead"]);
  });

  it("键名容错：大小写 / 下划线 / 连字符都能认", () => {
    const joints = buildMonoformJoints({
      "Left_Shoulder.Spread": 30,
      "HEAD-PITCH": 10,
    })!;
    expect(joints.mixamorigLeftShoulder[2]).toBeCloseTo((30 * Math.PI) / 180, 5);
    expect(joints.mixamorigHead[0]).toBeCloseTo((10 * Math.PI) / 180, 5);
  });

  it("角度 clamp 到 ±180，非数丢弃", () => {
    const joints = buildMonoformJoints({
      "head.pitch": 400,
      "head.yaw": Number.NaN,
    })!;
    expect(joints.mixamorigHead[0]).toBeCloseTo(Math.PI, 5); // 400 → 180
    expect(joints.mixamorigHead[1]).toBe(0); // NaN 丢弃
  });

  it("没有 controls / 空对象时返回 null（不写空的 joints 字段）", () => {
    expect(buildMonoformJoints(undefined)).toBeNull();
    expect(buildMonoformJoints({})).toBeNull();
    expect(buildMonoformJoints({ "tail.wag": 30 })).toBeNull();
  });

  it("角色带 controls 时产出 joints；带 route 时丢弃 controls（走路是循环剪辑，会打架）", () => {
    const withControls = buildMonoformCharacter(
      { at: [0, 0], controls: { "leftShoulder.spread": -85 } },
      0,
    );
    expect(withControls.joints?.mixamorigLeftShoulder[2]).toBeCloseTo((-85 * Math.PI) / 180, 5);

    const withRoute = buildMonoformCharacter(
      {
        at: [0, 0],
        controls: { "leftShoulder.spread": -85 },
        route: [[0, 0], [2, 2]],
        routeDuration: 3,
      },
      0,
    );
    expect(withRoute.joints).toBeUndefined();
  });

  it("没给 controls 的角色不带 joints 字段（保持既有形状）", () => {
    expect(buildMonoformCharacter({ at: [0, 0] }, 0).joints).toBeUndefined();
  });
});

describe("depthMesh（灰度高度场）与拼装", () => {
  type Obj = Record<string, unknown>;

  it("depthMesh 按 MONOFORM 契约构建（depthMapUrl + depthSettings），值域被 clamp", () => {
    const prop = buildMonoformProp(
      {
        type: "depthMesh",
        at: [2, -1],
        depthMapUrl: "  /assets/terrain.png  ",
        depth: { density: 999, fov: 5, near: 0.1, far: 100, invert: true },
      },
      0,
    )!;

    expect(prop.type).toBe("depthMesh");
    expect(prop.depthMapUrl).toBe("/assets/terrain.png"); // trim 过、原样保留
    const settings = prop.depthSettings as Record<string, unknown>;
    expect(settings.density).toBe(128); // clamp 上界
    expect(settings.fov).toBe(20); // clamp 下界
    expect(settings.invert).toBe(true);
    expect(prop.position).toEqual([2, 0, -1]); // 地形默认贴地（不是 0.5）
  });

  it("没给 depthMapUrl 的 depthMesh 被丢弃（渲染不出东西）", () => {
    expect(buildMonoformProp({ type: "depthMesh", at: [0, 0] }, 0)).toBeNull();
    expect(buildMonoformProp({ type: "depthMesh", depthMapUrl: "   " }, 0)).toBeNull();
  });

  it("拼装：一次给多个粗模，相对位置与朝向与 intent 一致", () => {
    const next = applyMonoformSceneIntent(
      {},
      {
        type: DIRECTOR_SCENE_INTENT_TYPE,
        objects: [
          { type: "table", at: [0, 0] },
          { type: "chair", at: [-0.9, 0.35], rotationY: 90 },
          { type: "chair", at: [0.9, 0.35], rotationY: -90 },
        ],
      },
    );
    const objs = next.objects as Obj[];

    expect(objs).toHaveLength(3);
    expect(objs[0].position).toEqual([0, 0.5, 0]); // 桌子默认抬升 0.5
    expect(objs[1].position).toEqual([-0.9, 0.5, 0.35]);
    expect((objs[1].rotation as number[])[1]).toBeCloseTo(Math.PI / 2, 5);
    expect(objs[2].position).toEqual([0.9, 0.5, 0.35]);
    expect((objs[2].rotation as number[])[1]).toBeCloseTo(-Math.PI / 2, 5);
  });

  it("深度地形与粗模可以同时出现（都在 objects 里）", () => {
    const next = applyMonoformSceneIntent(
      {},
      {
        type: DIRECTOR_SCENE_INTENT_TYPE,
        objects: [
          { type: "depthMesh", depthMapUrl: "/a.png" },
          { type: "tree", at: [1, 1] },
        ],
      },
    );
    const objs = next.objects as Obj[];
    expect(objs.map((o) => o.type)).toEqual(["depthMesh", "tree"]);
  });

  it("model 类型按 MONOFORM 契约构建（type:'model' + url，URL trim 后原样保留）", () => {
    const prop = buildMonoformProp(
      { type: "model", modelUrl: "  /previs-models/rail.glb  ", at: [1, 2], rotationY: 45 },
      0,
    )!;
    expect(prop.type).toBe("model");
    expect(prop.url).toBe("/previs-models/rail.glb");
    expect(prop.position).toEqual([1, 0, 2]);
    expect((prop.rotation as number[])[1]).toBeCloseTo(Math.PI / 4, 5);
  });

  it("没给 modelUrl 的 model 被丢弃", () => {
    expect(buildMonoformProp({ type: "model", at: [0, 0] }, 0)).toBeNull();
    expect(buildMonoformProp({ type: "model", modelUrl: "   " }, 0)).toBeNull();
  });
});

describe("相机关键帧的平滑度（用户实测「运镜不够流畅」）", () => {
  const persons = [{ type: "person", position: [-1, 0, 0] }, { type: "person", position: [1, 0, 0] }];

  // 根因：MONOFORM 对**每个关键帧段各自**做 smoothstep（vendor App.jsx 的
  // segmentAmount → ease）。只发 5 个点 = 一段一停的「加速-减速-加速」。
  // 修法是把全局 ease 烘进采样点、插值改 linear。这三条守的就是这个契约。
  it("关键帧用 linear（缓动已烘进采样点，不能被引擎再逐段缓一次）", () => {
    const keys = buildMonoformCameraTrack({ move: "crane-up", duration: 6 }, persons, 24);
    expect(keys.length).toBeGreaterThan(9);
    for (const k of keys) expect(k.interpolation).toBe("linear");
  });

  it("采样密度随时长走：6s@24fps 至少 25 个点（0.2s 一个）", () => {
    const keys = buildMonoformCameraTrack({ move: "orbit-right", duration: 6 }, persons, 24);
    expect(keys.length).toBeGreaterThanOrEqual(25);
    expect(new Set(keys.map((k) => k.frame)).size).toBe(keys.length); // 帧不重复
  });

  it("t=1/4 处确实缓过（ease(0.25)=0.156 ≠ 线性 0.25）—— 证明 ease 烘进去了", () => {
    const keys = buildMonoformCameraTrack({ move: "crane-up", duration: 6 }, persons, 24);
    const low = 1.4;
    const high = 5.5;
    const at = (t: number) => {
      const i = Math.round(t * (keys.length - 1));
      return keys[i].position[1];
    };
    // 缓动的脚印：前 1/4 只走了 15.6% 的路（线性会走 25%）。
    expect(at(0.25)).toBeCloseTo(low + (high - low) * 0.15625, 3);
    expect(at(0.25)).toBeLessThan(low + (high - low) * 0.25);
    expect(at(0.5)).toBeCloseTo((low + high) / 2, 5); // 中点仍是中点（smoothstep 对称）
    expect(keys[0].position[1]).toBeCloseTo(low, 5); // 首帧仍是起点
    expect(keys[keys.length - 1].position[1]).toBeCloseTo(high, 5); // 末帧仍是终点
  });

  it("首末帧与旧版一致（端点语义没变，只是中间加密）", () => {
    const keys = buildMonoformCameraTrack({ move: "orbit-right", duration: 6 }, persons, 24);
    expect(keys[0].frame).toBe(0);
    expect(keys[keys.length - 1].frame).toBe(144);
    expect(keys[keys.length - 1].position[0]).toBeCloseTo(5, 5);
  });
});
