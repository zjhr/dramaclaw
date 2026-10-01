import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useEmotionStore } from '../store/useEmotionStore';
import {
  Download,
  Film,
  GripVertical,
  MoveHorizontal,
  Pause,
  Play,
  Plus,
  Trash2,
  Video,
} from 'lucide-react';
import type { EmotionKeyframe } from '../types';
import { VideoRecorderModal } from './VideoRecorderModal';

const TIMELINE_DURATION = 30;
const MIN_KEYFRAME_GAP = 0.2;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const keyframeTitle = (label: string) =>
  label.replace(/^\d+(?:\.\d+)?s\s*/, '');

export const EmotionTimeline: React.FC = () => {
  const [isVideoModalOpen, setIsVideoModalOpen] = useState(false);
  const [selectedKeyframeId, setSelectedKeyframeId] = useState<string | null>(null);
  const [draggingKeyframeId, setDraggingKeyframeId] = useState<string | null>(null);
  const [dragTime, setDragTime] = useState<number | null>(null);
  const {
    keyframes,
    currentTime,
    setCurrentTime,
    isPlayingTimeline,
    setIsPlayingTimeline,
    addKeyframe,
    updateKeyframe,
    removeKeyframe,
  } = useEmotionStore();

  const trackRef = useRef<HTMLDivElement>(null);
  const animFrameRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  const currentTimeRef = useRef(currentTime);
  const dragTimeRef = useRef<number | null>(null);
  const dragStartXRef = useRef(0);
  const didDragRef = useRef(false);

  const selectedKeyframe = useMemo(
    () => keyframes.find((keyframe) => keyframe.id === selectedKeyframeId) ?? null,
    [keyframes, selectedKeyframeId]
  );

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  // A single uninterrupted requestAnimationFrame loop prevents the playhead
  // from being cancelled and recreated on every rendered frame.
  useEffect(() => {
    if (!isPlayingTimeline) {
      if (animFrameRef.current !== null) cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
      lastTimeRef.current = null;
      return;
    }

    lastTimeRef.current = performance.now();
    const loop = (now: number) => {
      const previous = lastTimeRef.current ?? now;
      const delta = Math.min((now - previous) / 1000, 0.1);
      let nextTime = currentTimeRef.current + delta;
      if (nextTime >= TIMELINE_DURATION) nextTime %= TIMELINE_DURATION;

      currentTimeRef.current = nextTime;
      lastTimeRef.current = now;
      setCurrentTime(nextTime);
      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);
    return () => {
      if (animFrameRef.current !== null) cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
      lastTimeRef.current = null;
    };
  }, [isPlayingTimeline, setCurrentTime]);

  const handleExportAnimationCurve = () => {
    const jsonStr = JSON.stringify(keyframes, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `emotion-timeline-curve-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const getDraggedTime = (keyframeId: string, pointerX: number) => {
    const track = trackRef.current;
    if (!track) return 0;

    const rect = track.getBoundingClientRect();
    const rawTime = ((pointerX - rect.left) / rect.width) * TIMELINE_DURATION;
    const ordered = [...keyframes].sort((a, b) => a.time - b.time);
    const index = ordered.findIndex((keyframe) => keyframe.id === keyframeId);
    const previous = index > 0 ? ordered[index - 1] : null;
    const next = index >= 0 && index < ordered.length - 1 ? ordered[index + 1] : null;
    const min = previous ? previous.time + MIN_KEYFRAME_GAP : 0;
    const max = next ? next.time - MIN_KEYFRAME_GAP : TIMELINE_DURATION;

    return clamp(Math.round(rawTime * 10) / 10, min, max);
  };

  const startKeyframeDrag = (
    event: React.PointerEvent<HTMLButtonElement>,
    keyframe: EmotionKeyframe
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setIsPlayingTimeline(false);
    setSelectedKeyframeId(keyframe.id);
    setDraggingKeyframeId(keyframe.id);
    setDragTime(keyframe.time);
    dragTimeRef.current = keyframe.time;
    dragStartXRef.current = event.clientX;
    didDragRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveKeyframe = (
    event: React.PointerEvent<HTMLButtonElement>,
    keyframe: EmotionKeyframe
  ) => {
    if (draggingKeyframeId !== keyframe.id) return;
    event.preventDefault();

    if (Math.abs(event.clientX - dragStartXRef.current) > 2) didDragRef.current = true;
    const nextTime = getDraggedTime(keyframe.id, event.clientX);
    dragTimeRef.current = nextTime;
    setDragTime(nextTime);
    currentTimeRef.current = nextTime;
    setCurrentTime(nextTime);
  };

  const finishKeyframeDrag = (
    event: React.PointerEvent<HTMLButtonElement>,
    keyframe: EmotionKeyframe
  ) => {
    if (draggingKeyframeId !== keyframe.id) return;
    event.preventDefault();
    event.stopPropagation();

    const nextTime = dragTimeRef.current ?? keyframe.time;
    if (didDragRef.current) {
      updateKeyframe(keyframe.id, {
        time: nextTime,
        label: `${nextTime.toFixed(1)}s ${keyframeTitle(keyframe.label)}`,
      });
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDraggingKeyframeId(null);
    setDragTime(null);
    dragTimeRef.current = null;
  };

  const handleTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const nextTime = clamp(
      ((event.clientX - rect.left) / rect.width) * TIMELINE_DURATION,
      0,
      TIMELINE_DURATION
    );
    setIsPlayingTimeline(false);
    setCurrentTime(nextTime);
  };

  const handleDeleteSelected = () => {
    if (!selectedKeyframe || keyframes.length <= 1) return;
    removeKeyframe(selectedKeyframe.id);
    setSelectedKeyframeId(null);
  };

  return (
    <section aria-label="表演动画时间轴" className="flex h-full min-h-0 flex-col gap-2 overflow-hidden rounded-[10px] border border-border-dark bg-surface-dark p-3 text-text-dark">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Film className="h-3.5 w-3.5 shrink-0 text-accent" />
          <h2 className="truncate text-xs font-semibold text-text-dark">表演动画时间轴</h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setIsVideoModalOpen(true)}
            className="flex items-center gap-1 rounded-md border border-red-400/35 bg-red-500/15 px-2.5 py-1 text-xs font-semibold text-red-200 transition-colors hover:bg-red-500/25"
            title="录制微表情动画成 WebM 视频"
          >
            <Video className="h-3.5 w-3.5" />
            <span>录制视频</span>
          </button>

          <button
            type="button"
            onClick={handleExportAnimationCurve}
            className="flex items-center gap-1 rounded-md border border-border-dark bg-bg-dark/60 px-2.5 py-1 text-xs font-medium text-text-muted transition-colors hover:bg-white/[0.06] hover:text-text-dark"
            title="导出动画时间轴 JSON"
          >
            <Download className="h-3.5 w-3.5 text-accent" />
            <span className="hidden sm:inline">导出曲线</span>
          </button>

          <button
            type="button"
            onClick={() => addKeyframe()}
            className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-accent/80"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>添加关键帧</span>
          </button>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          aria-label={isPlayingTimeline ? '暂停时间轴' : '播放时间轴'}
          onClick={() => setIsPlayingTimeline(!isPlayingTimeline)}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-white shadow-sm transition-all hover:bg-accent/80 active:scale-95"
        >
          {isPlayingTimeline ? (
            <Pause className="h-4 w-4" />
          ) : (
            <Play className="ml-0.5 h-4 w-4" />
          )}
        </button>

        <div className="flex w-[112px] min-w-[112px] shrink-0 items-center justify-center rounded-md border border-border-dark bg-bg-dark/60 py-1 font-mono text-xs font-semibold tabular-nums text-text-dark">
          {currentTime.toFixed(2)}s / 30.0s
        </div>

        <div className="relative flex flex-1 items-center">
          <input
            type="range"
            min="0"
            max={TIMELINE_DURATION}
            step="0.01"
            value={currentTime}
            aria-label="时间轴播放位置"
            onPointerDown={() => setIsPlayingTimeline(false)}
            onChange={(event) => setCurrentTime(Number(event.target.value))}
            className="h-2 w-full cursor-pointer"
          />
        </div>
      </div>

      <div
        ref={trackRef}
        onPointerDown={handleTrackPointerDown}
        className="relative min-h-0 w-full flex-1 touch-none select-none overflow-hidden rounded-md border border-border-dark bg-bg-dark/60"
      >
        <div className="pointer-events-none absolute inset-x-3 bottom-1 flex items-end justify-between font-mono text-xs font-medium text-text-muted">
          <span>0s</span>
          <span>5s</span>
          <span>10s</span>
          <span>15s</span>
          <span>20s</span>
          <span>25s</span>
          <span>30s</span>
        </div>

        <div className="pointer-events-none absolute inset-x-0 top-[28px] h-px bg-border-dark" />

        {keyframes.map((keyframe) => {
          const displayedTime =
            draggingKeyframeId === keyframe.id && dragTime !== null ? dragTime : keyframe.time;
          const leftPercent = clamp((displayedTime / TIMELINE_DURATION) * 100, 1, 99);
          const isSelected = selectedKeyframeId === keyframe.id;
          const isActive = Math.abs(currentTime - displayedTime) < 0.12;
          const isDragging = draggingKeyframeId === keyframe.id;

          return (
            <div
              key={keyframe.id}
              className={`absolute top-2 z-10 flex -translate-x-1/2 flex-col items-center transition-[left] ${
                isDragging ? 'z-30 duration-0' : 'duration-150'
              }`}
              style={{ left: `${leftPercent}%` }}
            >
              <button
                type="button"
                aria-label={`关键帧 ${keyframe.label}，按住可拖动`}
                title="按住并左右拖动关键帧"
                onPointerDown={(event) => startKeyframeDrag(event, keyframe)}
                onPointerMove={(event) => moveKeyframe(event, keyframe)}
                onPointerUp={(event) => finishKeyframeDrag(event, keyframe)}
                onPointerCancel={(event) => finishKeyframeDrag(event, keyframe)}
                onClick={(event) => {
                  event.stopPropagation();
                  if (didDragRef.current) {
                    didDragRef.current = false;
                    return;
                  }
                  setSelectedKeyframeId(keyframe.id);
                  setCurrentTime(keyframe.time);
                }}
                className={`group flex h-8 w-8 touch-none items-center justify-center rounded-full border-2 bg-surface-dark shadow-sm transition-all active:cursor-grabbing ${
                  isSelected || isDragging
                    ? 'cursor-grab border-accent ring-4 ring-accent/20'
                    : isActive
                      ? 'cursor-grab border-warning'
                      : 'cursor-grab border-border-dark hover:border-accent/70 hover:shadow-md'
                }`}
              >
                <span
                  className={`h-3.5 w-3.5 rotate-45 rounded-[2px] ${
                    isActive ? 'bg-warning' : 'bg-accent'
                  }`}
                />
              </button>

              <span className="mt-1 flex max-w-32 items-center gap-1 whitespace-nowrap rounded-md border border-border-dark bg-surface-dark px-1.5 py-0.5 font-mono text-xs font-semibold text-text-dark shadow-sm">
                <GripVertical className="h-2.5 w-2.5 text-text-muted" />
                <span className="text-accent">{displayedTime.toFixed(1)}s</span>
                <span className="max-w-20 truncate">{keyframeTitle(keyframe.label)}</span>
              </span>
            </div>
          );
        })}

        <div
          className="pointer-events-none absolute inset-y-0 z-20 w-[2px] bg-warning transition-[left] duration-75"
          style={{ left: `${(currentTime / TIMELINE_DURATION) * 100}%` }}
        >
          <div className="-ml-[3px] -mt-0.5 h-2 w-2 rounded-full bg-warning shadow-sm" />
        </div>
      </div>

      <div className="flex min-h-8 shrink-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border-dark bg-bg-dark/60 px-2 py-1">
        {selectedKeyframe ? (
          <>
            <div className="flex min-w-0 items-center gap-2 text-xs text-text-muted">
              <MoveHorizontal className="h-4 w-4 shrink-0 text-accent" />
              <span className="shrink-0 font-semibold text-text-dark">已选关键帧</span>
              <span className="truncate">
                {selectedKeyframe.time.toFixed(1)}s · {keyframeTitle(selectedKeyframe.label)}
              </span>
              <span className="hidden text-text-muted sm:inline">拖动上方圆形手柄可调整位置</span>
            </div>
            <button
              type="button"
              onClick={handleDeleteSelected}
              disabled={keyframes.length <= 1}
              className="flex items-center gap-1.5 rounded-md border border-red-400/35 bg-red-500/10 px-2.5 py-1.5 text-xs font-semibold text-red-200 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
              title={keyframes.length <= 1 ? '至少保留一个关键帧' : '删除所选关键帧'}
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除关键帧
            </button>
          </>
        ) : (
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <MoveHorizontal className="h-4 w-4 text-accent" />
            点击关键帧进行选择；按住圆形手柄左右拖动可改变时间位置
          </div>
        )}
      </div>

      <VideoRecorderModal
        isOpen={isVideoModalOpen}
        onClose={() => setIsVideoModalOpen(false)}
      />
    </section>
  );
};
