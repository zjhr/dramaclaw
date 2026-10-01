// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NEUTRAL_CHARACTER_PERFORMANCE } from "@/features/canvas/domain/characterPerformance";
import { CharacterPerformanceEditor } from "@/features/canvas/components/CharacterPerformanceEditor";
import { IdentityCallPanel } from "@/features/canvas/ui/IdentityCallPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/features/canvas/components/XiaoLuoPerformanceStudio", () => ({
  XiaoLuoPerformanceStudio: () => (
    <div data-testid="xiaoluo-performance-studio">
      <div data-testid="xiaoluo-main-preview">上游 3D 预览</div>
      <div role="grid" aria-label="XiaoLuo emotion matrix">
        {Array.from({ length: 25 }, (_, index) => <div key={index} role="gridcell" />)}
      </div>
      <button type="button">面部微表情解剖</button>
      <button type="button">25个演员情绪预设</button>
      <button type="button">AI Prompt生成</button>
      <button type="button">表演动画时间轴</button>
    </div>
  ),
}));
vi.mock("@/features/canvas/reference/xiaoluo/components/MannequinHeadViewport", () => ({
  MannequinHeadViewport: () => <div data-testid="xiaoluo-mannequin-head-viewport" />,
}));
vi.mock("@/lib/queries/characters", () => ({
  useIdentityLooks: () => ({
    data: { ok: true, data: [
      { character_name: "林夏", identity_id: "hidden-lin", identity_name: "日常", face_url: "", three_view_url: "", expression_grid_url: "", voice_url: "" },
      { character_name: "阿景", identity_id: "hidden-jing", identity_name: "战斗", face_url: "", three_view_url: "", expression_grid_url: "", voice_url: "" },
    ] },
    isLoading: false,
    isError: false,
  }),
}));

const identities = [
  { characterName: "林夏", identityId: "lin-xia" },
  { characterName: "阿景", identityId: "a-jing" },
];

describe("CharacterPerformanceEditor", () => {
  it("uses the upstream workbench with one bound identity at a time", () => {
    render(
      <CharacterPerformanceEditor
        identities={identities}
        performances={{}}
        durationSec={8}
        onChange={vi.fn()}
      />,
    );

    const editor = screen.getByTestId("character-performance-editor");
    const identityControls = within(editor).getByRole("tablist", { name: "node.performance.identityTabs" });
    const studio = within(editor).getByTestId("xiaoluo-performance-studio");
    const preview = within(studio).getByTestId("xiaoluo-main-preview");
    expect(within(studio).getAllByTestId("xiaoluo-main-preview")).toHaveLength(1);
    expect(preview.compareDocumentPosition(identityControls) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(within(editor).queryByTestId("face-preview")).not.toBeInTheDocument();
    expect(studio).not.toHaveAttribute("data-section", "face");
    expect(within(studio).getByRole("grid", { name: "XiaoLuo emotion matrix" })).toBeInTheDocument();
    expect(within(studio).getByRole("button", { name: "面部微表情解剖" })).toBeInTheDocument();
    expect(within(studio).getByRole("button", { name: "25个演员情绪预设" })).toBeInTheDocument();
    expect(within(studio).getByRole("button", { name: "AI Prompt生成" })).toBeInTheDocument();
    expect(within(studio).getByRole("button", { name: "表演动画时间轴" })).toBeInTheDocument();
  });

  it("switches the current identity without rendering all identities' controls together", () => {
    const onChange = vi.fn();
    render(
      <CharacterPerformanceEditor
        identities={identities}
        performances={{
          "lin-xia": { ...NEUTRAL_CHARACTER_PERFORMANCE, mouth: 0.25 },
          "a-jing": { ...NEUTRAL_CHARACTER_PERFORMANCE, mouth: -0.5 },
        }}
        onChange={onChange}
      />,
    );

    expect(screen.getByRole("tab", { name: "林夏" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "阿景" }));
    expect(screen.getByRole("tab", { name: "阿景" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("xiaoluo-performance-studio")).not.toHaveAttribute("data-section", "emotion");
    expect(screen.getByRole("grid", { name: "XiaoLuo emotion matrix" })).toBeInTheDocument();
    expect(screen.queryByText("face-preview")).not.toBeInTheDocument();
  });

  it("keeps a clear empty-identity state", () => {
    render(
      <CharacterPerformanceEditor identities={[]} performances={{}} onChange={vi.fn()} />,
    );

    expect(screen.getByText("node.performance.empty")).toBeInTheDocument();
    expect(screen.getByText("node.performance.disclaimer")).toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "node.performance.editorSections.label" })).not.toBeInTheDocument();
  });
});

describe("IdentityCallPanel", () => {
  it("keeps character choices compact and never exposes internal identity ids", () => {
    render(
      <IdentityCallPanel
        project="demo"
        selected={[]}
        imageCap={4}
        audioCap={1}
        onChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const list = screen.getByRole("list", { name: "node.identityCall.characterList" });
    expect(list).toHaveClass("grid-cols-2");
    expect(within(list).getByRole("button", { name: "林夏" })).toBeInTheDocument();
    expect(within(list).queryByText("hidden-lin")).not.toBeInTheDocument();
    expect(within(list).queryByText("hidden-jing")).not.toBeInTheDocument();
  });
});
