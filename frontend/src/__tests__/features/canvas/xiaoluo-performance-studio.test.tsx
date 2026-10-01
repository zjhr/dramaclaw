import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NEUTRAL_CHARACTER_PERFORMANCE } from "@/features/canvas/domain/characterPerformance";
import { XiaoLuoPerformanceStudio } from "@/features/canvas/components/XiaoLuoPerformanceStudio";
import { useEmotionStore } from "@/features/canvas/reference/xiaoluo/store/useEmotionStore";

vi.mock("@/features/canvas/reference/xiaoluo/components/MannequinHeadViewport", () => ({
  MannequinHeadViewport: () => <div data-testid="xiaoluo-mannequin-head-viewport" />,
}));

describe("XiaoLuo performance bridge", () => {
  it("maps a matrix click into the existing performance callback", () => {
    const onChange = vi.fn();
    render(
      <XiaoLuoPerformanceStudio
        performance={NEUTRAL_CHARACTER_PERFORMANCE}
        keyframes={[]}
        section="emotion"
        onChange={onChange}
      />,
    );
    const cells = within(screen.getByRole("grid", { name: "XiaoLuo emotion matrix" })).getAllByRole("gridcell");
    expect(cells).toHaveLength(25);
    fireEvent.click(cells[24]);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ valence: 1, arousal: -1 }), []);
    expect(useEmotionStore.getState().activePresetId).toBe("preset-20");
    const presets = screen.getByRole("region", { name: "25个演员情绪预设" });
    expect(within(presets).getByRole("button", { pressed: true })).toHaveTextContent("赛博麻木");
  });

  it("moves the matrix selection when a preset is chosen", () => {
    const onChange = vi.fn();
    render(
      <XiaoLuoPerformanceStudio
        performance={NEUTRAL_CHARACTER_PERFORMANCE}
        keyframes={[]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "黑化癫狂" }));
    expect(useEmotionStore.getState().activePresetId).toBe("preset-25");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ valence: 1, arousal: 1 }), expect.any(Array));
  });

  it("uses one upstream mannequin preview beside the emotion matrix", () => {
    render(
      <XiaoLuoPerformanceStudio
        performance={NEUTRAL_CHARACTER_PERFORMANCE}
        keyframes={[]}
        section="emotion"
        onChange={vi.fn()}
      />,
    );
    const preview = screen.getByTestId("xiaoluo-main-preview");
    const matrix = screen.getByRole("grid", { name: "XiaoLuo emotion matrix" });
    expect(preview.compareDocumentPosition(matrix) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByTestId("xiaoluo-mannequin-head-viewport")).toHaveLength(1);
  });

  it("bridges source facial controls to one DramaClaw update without initialization feedback", async () => {
    const onChange = vi.fn();
    render(
      <XiaoLuoPerformanceStudio
        performance={NEUTRAL_CHARACTER_PERFORMANCE}
        keyframes={[]}
        section="face"
        onChange={onChange}
      />,
    );
    expect(screen.getByText("精密面部微控参数 (FACIAL CONTROLS)")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    await act(async () => {
      useEmotionStore.getState().setFacialState({
        ...useEmotionStore.getState().facialState,
        eyebrow: { ...useEmotionStore.getState().facialState.eyebrow, height: 25 },
      });
    });
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ brows: 0.5 }), expect.any(Array));
  });
});
