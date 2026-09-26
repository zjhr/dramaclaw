// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 分镜卡：把 dd-scene 变成对话里可读、可复查的一行行。
 *
 * 用户实测反馈「没有卡片」—— agent 摆了场景，气泡里只剩自然语言，看不到它到底
 * 摆了什么、也没法重新应用或退回。这个文件守的就是那三件事。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DirectorSceneCard } from "@/features/canvas/nodes/DirectorSceneCard";
import type { DirectorCameraMove, DirectorSceneIntent } from "@/features/canvas/nodes/directorScenePatch";

const SCENE: DirectorSceneIntent = {
  type: "director-desk-scene",
  characters: [
    {
      name: "甲",
      at: [-2, 0],
      route: [
        [-2, 0],
        [0, 0],
      ],
      routeDuration: 3,
    },
  ],
  objects: [{ type: "table" }],
  camera: { move: "orbit-right", duration: 8, start: 4 },
};

describe("DirectorSceneCard", () => {
  it("渲染人话摘要：角色 / 物品 / 镜头 / 节拍", () => {
    render(<DirectorSceneCard intent={SCENE} applied={false} onApply={() => undefined} />);

    expect(screen.getByText("分镜")).toBeTruthy();
    expect(screen.getByText("甲")).toBeTruthy();
    expect(screen.getByText("桌子")).toBeTruthy();
    expect(screen.getByText(/向右环绕 · 8 秒/)).toBeTruthy();
    expect(screen.getByText(/0s 走位 · 4s 运镜/)).toBeTruthy();
  });

  it("未应用：只有「应用」，没有撤销入口", () => {
    render(
      <DirectorSceneCard intent={SCENE} applied={false} onApply={() => undefined} onUndo={() => undefined} />,
    );

    expect(screen.getByText("待应用")).toBeTruthy();
    expect(screen.getByText("应用")).toBeTruthy();
    expect(screen.queryByText("撤销")).toBeNull();
  });

  it("已应用：重新应用与撤销都接上回调", () => {
    const onApply = vi.fn();
    const onUndo = vi.fn();
    render(<DirectorSceneCard intent={SCENE} applied onApply={onApply} onUndo={onUndo} />);

    expect(screen.getByText("已应用")).toBeTruthy();
    fireEvent.click(screen.getByText("重新应用"));
    expect(onApply).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("撤销"));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("宿主不支持快照（没给 onUndo）时不出现撤销", () => {
    render(<DirectorSceneCard intent={SCENE} applied onApply={() => undefined} />);

    expect(screen.getByText("已应用")).toBeTruthy();
    expect(screen.queryByText("撤销")).toBeNull();
  });

  // Phase 3 加了 9 个新运镜 id，但 CAMERA_MOVE_LABEL / move.* 只覆盖了原来的 7 个 ——
  // 新运镜会静默落回「静止」，卡片在骗人（明明在动）。这条守住「每个 id 都有中文标签」。
  it.each([
    ["crane-up", "摇臂上升"],
    ["crane-down", "摇臂下降"],
    ["rail-left", "左横移"],
    ["rail-right", "右横移"],
    ["handheld", "手持"],
    ["zoom-in", "变焦推近"],
    ["zoom-out", "变焦拉远"],
    ["pov", "主观镜头"],
    ["over-shoulder", "越肩"],
  ])("新运镜 %s 显示自己的标签，不落回「静止」", (move, label) => {
    render(
      <DirectorSceneCard
        intent={{ ...SCENE, camera: { move: move as DirectorCameraMove, duration: 6 } }}
        applied={false}
        onApply={() => undefined}
      />,
    );

    expect(screen.getByText(new RegExp(label))).toBeTruthy();
    expect(screen.queryByText(/静止/)).toBeNull();
  });
});
