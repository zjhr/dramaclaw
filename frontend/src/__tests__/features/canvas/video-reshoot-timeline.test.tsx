// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { VideoReshootTimeline } from "@/features/canvas/ui/VideoReshootTimeline";
import { apiCall } from "@/api/client";
import { submitFreezoneVideoReshoot } from "@/api/ops";

// i18n 在测试里用真实词条太重，mock 成 key 回显即可（断言 key 存在性）。
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && "value" in opts ? `${key}:${String(opts.value)}` : key,
  }),
}));

// apiCall 走 ky + 相对 URL，测试里没有 baseURL 可解析；按仓库既有范式换成 spy，
// 顺带让 body 断言直接看 json 参数（不需要真的发请求）。
vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, apiCall: vi.fn() };
});

function setup(overrides: Partial<Parameters<typeof VideoReshootTimeline>[0]> = {}) {
  const onChange = vi.fn();
  const props = {
    durationSeconds: 10,
    startSeconds: 0,
    endSeconds: 10,
    onChange,
    ...overrides,
  };
  const view = render(<VideoReshootTimeline {...props} />);
  return { onChange, unmount: view.unmount };
}

describe("VideoReshootTimeline", () => {
  it("renders duration, two handles and the second labels", () => {
    setup();
    const root = screen.getByTestId("reshoot-timeline");
    expect(root).toBeTruthy();
    const handles = screen.getAllByRole("slider");
    expect(handles).toHaveLength(2);
    // 起/止贴在各自手柄上，用 data-testid 定位，别用文本查询——它们和下面的
    // 总时长行共用同一批 i18n key，文本查询会撞上多个节点。
    expect(screen.getByTestId("reshoot-start-label").textContent).toBe(
      "node.reshootTimeline.startLabel:0.0",
    );
    expect(screen.getByTestId("reshoot-end-label").textContent).toBe(
      "node.reshootTimeline.endLabel:10.0",
    );
    expect(screen.getByText("node.reshootTimeline.spanLabel:10.0")).toBeTruthy();
  });

  it("anchors each label to its own handle, not to the middle of the track", () => {
    // 回归：labelStyle 曾经在中段分支里写死 left: '50%'，两个标签都被摆到轨道正中，
    // 看着像"起止都在这"，比不显示还误导。起点 2/10=20%、终点 6/10=60%。
    setup({ durationSeconds: 10, startSeconds: 2, endSeconds: 6 });
    const start = screen.getByTestId("reshoot-start-label");
    const end = screen.getByTestId("reshoot-end-label");
    expect(start.style.left).toBe("20%");
    expect(end.style.left).toBe("60%");
  });

  it("flips the labels inward when a handle is within 10% of either end", () => {
    // 贴着轨道两端时居中会被 overflow-hidden 裁掉，改成左对齐/右对齐。
    setup({ durationSeconds: 10, startSeconds: 0, endSeconds: 10 });
    const start = screen.getByTestId("reshoot-start-label");
    const end = screen.getByTestId("reshoot-end-label");
    expect(start.style.left).toBe("0%");
    expect(start.style.transform).toBe("");
    expect(end.style.left).toBe("100%");
    expect(end.style.transform).toBe("translateX(-100%)");
  });

  it("shows a paused frame at each end and follows both handles", () => {
    // 两端各一张静帧，分别钉在当前起点和终点。改哪一端，只有那一张跟着走。
    const props = { durationSeconds: 10, onChange: vi.fn(), videoUrl: "/static/projects/proj/a.mp4" };
    const view = render(<VideoReshootTimeline {...props} startSeconds={1} endSeconds={6} />);
    const start = screen.getByTestId("reshoot-start-frame") as HTMLVideoElement;
    const end = screen.getByTestId("reshoot-end-frame") as HTMLVideoElement;
    expect(start.tagName).toBe("VIDEO");
    expect(end.tagName).toBe("VIDEO");
    expect(start.currentTime).toBe(1);
    expect(end.currentTime).toBe(6);
    expect(screen.getByText("node.reshootTimeline.startFrame")).toBeTruthy();
    expect(screen.getByText("node.reshootTimeline.endFrame")).toBeTruthy();

    view.rerender(<VideoReshootTimeline {...props} startSeconds={2} endSeconds={6} />);
    expect(start.currentTime).toBe(2);
    expect(end.currentTime).toBe(6);

    view.rerender(<VideoReshootTimeline {...props} startSeconds={2} endSeconds={8} />);
    expect(start.currentTime).toBe(2);
    expect(end.currentTime).toBe(8);
  });

  it("stays paused when a handle is grabbed", () => {
    const play = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: play });
    const capture = Element.prototype.setPointerCapture;
    Element.prototype.setPointerCapture = vi.fn();

    try {
      setup({ videoUrl: "/static/projects/proj/a.mp4", startSeconds: 1, endSeconds: 6 });
      fireEvent.pointerDown(screen.getAllByRole("slider")[0], { pointerId: 1 });
      expect(play).not.toHaveBeenCalled();
      expect(screen.queryByTestId("reshoot-playhead")).toBeNull();
      expect(screen.queryByText("node.reshootTimeline.preview")).toBeNull();
    } finally {
      Element.prototype.setPointerCapture = capture;
    }
  });

  it("keyboard ArrowRight steps the start handle by 0.1s", async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ startSeconds: 1, endSeconds: 6 });
    const [startHandle] = screen.getAllByRole("slider");
    startHandle.focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledWith(1.1, 6);
  });

  it("keyboard ArrowLeft on end never shrinks the span below 4s", async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ startSeconds: 1, endSeconds: 5 });
    const endHandle = screen.getAllByRole("slider")[1];
    endHandle.focus();
    await user.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    expect(onChange).toHaveBeenCalled();
    for (const call of onChange.mock.calls) {
      expect(call[1] - call[0]).toBeGreaterThanOrEqual(4);
    }
    expect(onChange).toHaveBeenLastCalledWith(1, 5);
  });

  it("expands a too-short range to 4 seconds", () => {
    const { onChange } = setup({ durationSeconds: 10, startSeconds: 1, endSeconds: 2 });
    expect(onChange).toHaveBeenCalledWith(1, 5);
  });

  it("pulls the start back when the end is already near the video end", () => {
    const { onChange } = setup({ durationSeconds: 10, startSeconds: 8, endSeconds: 9 });
    expect(onChange).toHaveBeenCalledWith(6, 10);
  });

  it("keeps a source shorter than 4 seconds as the whole clip", () => {
    const { onChange } = setup({ durationSeconds: 3, startSeconds: 0, endSeconds: 2 });
    expect(onChange).toHaveBeenCalledWith(0, 3);
  });

  it("clamps end to duration and start to 0", async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ durationSeconds: 5, startSeconds: 0, endSeconds: 5 });
    const startHandle = screen.getAllByRole("slider")[0];
    startHandle.focus();
    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenCalledWith(0, 5);
    const endHandle = screen.getAllByRole("slider")[1];
    endHandle.focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledWith(0, 5);
  });

  it("unknown duration shows the hint and no handles", () => {
    setup({ durationSeconds: null });
    expect(screen.getByText("node.reshootTimeline.unknownDuration")).toBeTruthy();
    expect(screen.queryAllByRole("slider")).toHaveLength(0);
  });

  it("disabled handles are not focusable", () => {
    setup({ disabled: true });
    const handles = screen.getAllByRole("slider");
    expect(handles.every((h) => (h as HTMLButtonElement).disabled)).toBe(true);
  });

  it("renders a dense thumbnail strip when given a video url", () => {
    // 给了 videoUrl 就在轨道上铺缩略图槽位——选区要对着画面内容选，不是对着
    // 空条选。槽位数刻意 >8：8 张时每条 10s 视频每格代表 1.25s，画面差异小到
    // 分不清选的是哪一段。jsdom 抓不到真帧，槽位仍是空背景，但数量必须在。
    setup({ videoUrl: "/static/projects/proj/a.mp4" });
    expect(screen.getByTestId("reshoot-strip")).toBeTruthy();
    const cells = screen.getByTestId("reshoot-strip").children;
    expect(cells.length).toBeGreaterThan(8);
  });

  it("omits the strip when no video url is given", () => {
    setup();
    expect(screen.queryByTestId("reshoot-strip")).toBeNull();
  });

  it("renders edge frames beside the track and keeps the selection as a highlight", () => {
    const first = setup();
    expect(screen.getByTestId("reshoot-selection")).toBeTruthy();
    expect(screen.queryByTestId("reshoot-edge-frames")).toBeNull();
    first.unmount();

    setup({ videoUrl: "/static/projects/proj/a.mp4", startSeconds: 1, endSeconds: 6 });
    const frames = screen.getByTestId("reshoot-edge-frames");
    const start = screen.getByTestId("reshoot-start-frame");
    const end = screen.getByTestId("reshoot-end-frame");
    expect(frames.contains(start)).toBe(true);
    expect(frames.contains(end)).toBe(true);
    expect(screen.getByTestId("reshoot-selection").contains(start)).toBe(false);
    expect(screen.queryByTestId("reshoot-preview-toggle")).toBeNull();
  });
});

describe("submitFreezoneVideoReshoot payload", () => {
  it("maps camelCase to snake_case", async () => {
    const call = vi.mocked(apiCall).mockReset();
    call.mockResolvedValue({ task_key: "k", task_type: "freezone_video_reshoot" } as never);

    await submitFreezoneVideoReshoot("proj", {
      sourceUrl: "http://x/a.mp4",
      startSeconds: 1.5,
      endSeconds: 3.5,
      prompt: "p",
      resolution: "1080p",
      generateAudio: true,
    });

    const [path, init] = call.mock.calls[0] as unknown as [
      string,
      { method: string; json: Record<string, unknown> },
    ];
    expect(path).toBe("projects/proj/freezone/video/reshoot");
    expect(init.method).toBe("POST");
    expect(init.json).toMatchObject({
      source_url: "http://x/a.mp4",
      start_seconds: 1.5,
      end_seconds: 3.5,
      prompt: "p",
      resolution: "1080p",
      generate_audio: true,
    });
    expect(Object.keys(init.json)).not.toContain("startSeconds");
  });

  it("首尾帧是并排大图，时间跟着手柄走", () => {
    setup({ videoUrl: "/static/a.mp4", startSeconds: 2, endSeconds: 8 });
    const frames = screen.getByTestId("reshoot-edge-frames");
    expect(frames.className).toContain("grid-cols-2");
    const start = screen.getByTestId("reshoot-start-frame");
    const end = screen.getByTestId("reshoot-end-frame");
    expect(start.parentElement?.className).toContain("h-64");
    expect(end.parentElement?.className).toContain("h-64");
    expect(start.parentElement?.className).toContain("w-full");
    expect((start as HTMLVideoElement).currentTime).toBe(2);
    expect((end as HTMLVideoElement).currentTime).toBe(8);
  });

  it("有视频时播放片段按钮可用；没视频时禁用", () => {
    const { unmount } = setup({ videoUrl: "/static/a.mp4" });
    const button = screen.getByTestId("reshoot-play");
    expect(button).not.toBeDisabled();
    expect(button.textContent).toContain("node.reshootTimeline.playPreview");
    unmount();
    setup({});
    expect(screen.getByTestId("reshoot-play")).toBeDisabled();
  });

  it("播放片段只覆盖选区，播完就停", () => {
    const play = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: play,
    });
    setup({ videoUrl: "/static/a.mp4", startSeconds: 2, endSeconds: 6 });
    fireEvent.click(screen.getByTestId("reshoot-play"));
    expect(play).toHaveBeenCalled();
    const preview = screen.getByTestId("reshoot-preview-video") as HTMLVideoElement;
    expect(preview.className).toContain("inset-0");
    expect(screen.getByTestId("reshoot-edge-frames").contains(preview)).toBe(true);

    preview.currentTime = 6;
    fireEvent.timeUpdate(preview);
    expect(screen.getByTestId("reshoot-preview-video").className).toContain("opacity-0");
    expect(screen.queryByTestId("reshoot-playhead")).toBeNull();
  });
});
