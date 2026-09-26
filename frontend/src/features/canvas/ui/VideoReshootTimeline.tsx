// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { mediaNeedsCrossOrigin } from '@/features/canvas/application/imageData';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';

/**
 * 最小可选区间（秒）。模型生成段大多有 4 秒硬下限，时间轴直接锁死，
 * 不能再拖成更短的一段。源片本身短于 4 秒时，下限退成整段时长。
 */
const MIN_SPAN_SECONDS = 4;
/** 手柄拖拽/键盘步进精度。 */
const STEP_SECONDS = 0.1;

/**
 * 轨道上铺多少张缩略图。
 *
 * 8 张实测不够看：一条 10s 的视频每张代表 1.25s，画面差异很小，用户根本分不清
 * 选中的是哪一段。14 张把单张覆盖压到 0.7s 左右，配合更宽的抽帧宽度才看得清。
 */
const STRIP_FRAME_COUNT = 14;
/** 缩略图宽。320 起步——160 宽的图拉到 14 格轨道上会糊成一片色块。 */
const STRIP_FRAME_WIDTH = 320;

/** 把秒数量化到 0.1s 步进，避免浮点漂移累积出 1.2000000000000002。 */function quantize(seconds: number): number {
  return Math.round(seconds * 10) / 10;
}

/** 把任意值夹进 [min, max] 并量化。 */
function clampQuantized(value: number, min: number, max: number): number {
  return quantize(Math.min(Math.max(value, min), max));
}

/**
 * 沿时间轴均匀抽 N 帧，返回 dataURL 数组（拿不到就返回空数组）。
 *
 * 复用「剪辑」面板那套离屏 <video> + <canvas> 管道，两个必须点：
 * - 跨域 CDN 媒体要 `crossOrigin='anonymous'`，否则画进 canvas 会污染、
 *   `toDataURL` 直接抛（见 videoFrameCapture 的同款注释）。
 * - 等 `loadeddata` 再开始 seek，否则第一帧画的是黑缓冲。
 */
async function captureStripFrames(src: string, count: number): Promise<string[]> {
  return await new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    if (mediaNeedsCrossOrigin(src)) video.crossOrigin = 'anonymous';

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      resolve([]);
      return;
    }

    const cleanup = () => {
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        // ignored
      }
    };

    video.addEventListener('error', () => {
      cleanup();
      resolve([]);
    });

    video.addEventListener(
      'loadeddata',
      () => {
        const duration = video.duration;
        if (!Number.isFinite(duration) || duration <= 0) {
          cleanup();
          resolve([]);
          return;
        }
        const targetWidth = STRIP_FRAME_WIDTH;
        const ratio = video.videoHeight / Math.max(video.videoWidth, 1);
        canvas.width = targetWidth;
        canvas.height = Math.max(1, Math.round(targetWidth * ratio));

        const frames: string[] = [];
        let index = 0;
        const seekNext = () => {
          if (index >= count) {
            cleanup();
            resolve(frames);
            return;
          }
          const at = (duration * (index + 0.5)) / count;
          video.currentTime = Math.min(at, Math.max(0, duration - 0.05));
        };
        video.addEventListener('seeked', () => {
          try {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            frames.push(canvas.toDataURL('image/jpeg', 0.6));
          } catch {
            // 单帧污染不该让整条带子消失，已抓到的照常返回。
          }
          index += 1;
          seekNext();
        });
        seekNext();
      },
      { once: true },
    );

    video.src = src;
    try {
      video.load();
    } catch {
      // ignored — 赋 src 本身就会发起加载
    }
  });
}


/**
 * 取视频某一秒的 dataURL，失败返回 null。拖动过程中连续调用，内部按 URL 去抖。
 */
export function useVideoStripFrames(videoUrl: string | null | undefined): string[] {
  const [frames, setFrames] = useState<string[]>([]);

  useEffect(() => {
    if (!videoUrl) {
      setFrames([]);
      return;
    }
    let cancelled = false;
    const resolved = resolveImageDisplayUrl(videoUrl);
    if (!resolved) return;
    void captureStripFrames(resolved, STRIP_FRAME_COUNT).then((next) => {
      if (!cancelled) setFrames(next);
    });
    return () => {
      cancelled = true;
    };
  }, [videoUrl]);

  return frames;
}

/** 源片短于 4 秒时，下限就是整段，否则锁在 4 秒。 */
function minimumSpan(duration: number): number {
  return Math.min(MIN_SPAN_SECONDS, duration);
}

/**
 * 把区间收进 [0, duration]，并且保证不短于 minimumSpan。
 * moving 是这次被用户挪动的那一端：先夹这一端，实在放不下再推另一端。
 */
function clampRange(
  start: number,
  end: number,
  duration: number,
  moving: 'start' | 'end',
): [number, number] {
  const minSpan = minimumSpan(duration);
  let nextStart = quantize(Math.max(0, Math.min(start, duration)));
  let nextEnd = quantize(Math.max(0, Math.min(end, duration)));
  if (nextEnd < nextStart) {
    if (moving === 'start') nextStart = nextEnd;
    else nextEnd = nextStart;
  }
  if (nextEnd - nextStart >= minSpan - 0.001) return [nextStart, nextEnd];
  if (moving === 'start') {
    nextStart = quantize(Math.max(0, nextEnd - minSpan));
    if (nextEnd - nextStart < minSpan - 0.001) {
      nextEnd = quantize(Math.min(duration, nextStart + minSpan));
    }
  } else {
    nextEnd = quantize(Math.min(duration, nextStart + minSpan));
    if (nextEnd - nextStart < minSpan - 0.001) {
      nextStart = quantize(Math.max(0, nextEnd - minSpan));
    }
  }
  return [nextStart, nextEnd];
}

/**
 * 暂停在某一秒上的静帧。调节手柄时只改 currentTime，不调用 play()。
 * 贴着片尾时往回让 0.04s，否则 currentTime === duration 画不出最后一帧。
 */
function EdgeFrame({
  src,
  seconds,
  label,
  testId,
}: {
  src: string;
  seconds: number;
  label: string;
  testId: string;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const seek = () => {
      video.pause();
      const mediaDuration = video.duration;
      const max =
        Number.isFinite(mediaDuration) && mediaDuration > 0
          ? Math.max(0, mediaDuration - 0.04)
          : seconds;
      const at = Math.min(Math.max(0, seconds), max);
      if (Math.abs(video.currentTime - at) >= 0.03) {
        try {
          video.currentTime = at;
        } catch {
          // 元数据还没到，loadedmetadata 会再来一次。
        }
      }
    };
    seek();
    video.addEventListener('loadedmetadata', seek);
    return () => video.removeEventListener('loadedmetadata', seek);
  }, [seconds, src]);

  return (
    <div className="relative h-64 w-full overflow-hidden rounded-md border border-white/15 bg-black">
      <video
        ref={ref}
        src={src}
        muted
        playsInline
        preload="metadata"
        className="nodrag pointer-events-none h-full w-full object-contain"
        data-testid={testId}
      />
      <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/70 px-1.5 text-center text-[12px] leading-5 text-white">
        {label}
      </span>
    </div>
  );
}

export interface VideoReshootTimelineProps {
  /** 源视频总时长（秒）。null = 未知，禁用提交并提示。 */
  durationSeconds: number | null;
  startSeconds: number;
  endSeconds: number;
  onChange: (start: number, end: number) => void;
  disabled?: boolean;
  /** 源视频地址。给了就在轨道上铺缩略图带 + 手柄旁显示锚点预览。 */
  videoUrl?: string | null;
}

/**
 * 片段重拍的时间轴选择器：一条铺满缩略图的轨道 + 两个可拖手柄。
 *
 * 用 pointer events + setPointerCapture 而不是 click——拖拽中指针移出手柄
 * 甚至移出轨道都不能丢事件，否则手柄会"粘"在鼠标上。键盘（左右方向键）
 * 同步支持，可访问性基线。
 *
 * 轨道铺缩略图而不是空条：选区要对着"这一段里人物在干什么"来选，光看秒数
 * 是选不准的。轨道上方并排两张大静帧，分别停在当前起点和终点；拖哪一端，
 * 对应的那一帧就换到那个时刻。默认暂停，拖动手柄不会开播。
 * 「播放片段」用同一块画面只放选中区间，放到终点就停。
 */
export function VideoReshootTimeline({
  durationSeconds,
  startSeconds,
  endSeconds,
  onChange,
  disabled = false,
  videoUrl = null,
}: VideoReshootTimelineProps) {
  const { t } = useTranslation();
  // 手柄层的 ref。手柄不能放在 overflow-hidden 的轨道里——0% / 100% 时圆钮中心
  // 压在时间轴端点上，半个圆钮落在轨道外，会被裁掉一半。所以手柄单独铺在一层不裁剪
  // 的姐妹层上，跟轨道像素对齐；拖拽换算也用这一层的宽度。
  const handleLayerRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<'start' | 'end' | null>(null);
  const stripFrames = useVideoStripFrames(videoUrl);

  const unknown = durationSeconds === null || !(durationSeconds > 0);
  const duration = unknown ? 0 : (durationSeconds as number);
  const span = Math.max(0, endSeconds - startSeconds);

  const emit = useCallback(
    (nextStart: number, nextEnd: number) => {
      onChange(quantize(nextStart), quantize(nextEnd));
    },
    [onChange],
  );

  // 外部带进来的区间若短于 4 秒，展开到下限。空区间（还没选）不动，
  // 交给工具栏在展开时铺满整段。
  useEffect(() => {
    if (unknown || !(endSeconds > startSeconds)) return;
    const [nextStart, nextEnd] = clampRange(startSeconds, endSeconds, duration, 'end');
    if (nextStart === quantize(startSeconds) && nextEnd === quantize(endSeconds)) return;
    onChange(nextStart, nextEnd);
  }, [unknown, duration, startSeconds, endSeconds, onChange]);

  // 指针在轨道上的比例 → 秒数。用 handleLayerRef（而不是 trackRef）的宽度换算：
  // 手柄内缩了 HANDLE_INSET_PX，轨道可视区比手柄活动区宽 2×inset；拿轨道宽算，
  // 拖到 0% 会停在 inset 像素之外，起止点永远压不到真正的头尾。
  const secondsFromClientX = useCallback(
    (clientX: number): number => {
      const layer = handleLayerRef.current;
      if (!layer || duration <= 0) return 0;
      const rect = layer.getBoundingClientRect();
      if (rect.width <= 0) return 0;
      const ratio = (clientX - rect.left) / rect.width;
      return clampQuantized(ratio * duration, 0, duration);
    },
    [duration],
  );

  useEffect(() => {
    if (!dragging) return;

    const move = (event: PointerEvent) => {
      const at = secondsFromClientX(event.clientX);
      const [nextStart, nextEnd] = clampRange(
        dragging === 'start' ? at : startSeconds,
        dragging === 'end' ? at : endSeconds,
        duration,
        dragging,
      );
      emit(nextStart, nextEnd);
    };
    const up = () => setDragging(null);

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [dragging, emit, endSeconds, startSeconds, secondsFromClientX]);

  const onHandleKeyDown = (which: 'start' | 'end') => (event: React.KeyboardEvent) => {
    if (disabled || unknown) return;
    const delta = event.key === 'ArrowRight' ? STEP_SECONDS
      : event.key === 'ArrowLeft' ? -STEP_SECONDS
      : 0;
    if (delta === 0) return;
    event.preventDefault();
    const [nextStart, nextEnd] = clampRange(
      which === 'start' ? startSeconds + delta : startSeconds,
      which === 'end' ? endSeconds + delta : endSeconds,
      duration,
      which,
    );
    emit(nextStart, nextEnd);
  };

  if (unknown) {
    return (
      <div className="text-[11px] text-text-dim" data-testid="reshoot-timeline">
        {t('node.reshootTimeline.unknownDuration')}
      </div>
    );
  }

  const startPct = duration > 0 ? (startSeconds / duration) * 100 : 0;
  const endPct = duration > 0 ? (endSeconds / duration) * 100 : 100;

  // 手柄做成"整条白边 + 中间圆钮"：整条边让区域起点/终点一眼可见（原来只有
  // 一个小圆点悬在轨道中央，看不出边界在哪），圆钮保留可抓的着力点——16px 是
  // 手还能稳稳抓住的下限，抓着它拖动时白条就是落在哪条边上的答案。
  // 白条加一圈暗投影：缩略图里有亮帧时，3px 的纯白细线会直接糊在画面里。
  const handleClass =
    'pointer-events-auto group absolute inset-y-0 z-20 w-[3px] -translate-x-1/2 bg-white ' +
    'shadow-[0_0_4px_rgba(0,0,0,0.85)] ' +
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--accent-rgb))] ' +
    'cursor-ew-resize disabled:cursor-not-allowed';
  const handleKnobClass =
    'pointer-events-none absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 ' +
    'rounded-full border border-white/70 bg-white shadow';

  // 手柄标签：把「起 X.Xs / 止 X.Xs」贴在各自那条边上。原先只在轨道下面列一行
  // 文字，哪个数是起点、哪条边是终点还得自己对。定位全交给 labelStyle，类里不写
  // left/translate——贴边分支的 inline 值跟类里的反向位移叠加会把标签推离手柄。
  const labelClass =
    'pointer-events-none absolute top-0 z-20 whitespace-nowrap rounded-sm bg-black/70 px-1 ' +
    'text-[10px] leading-4 text-white';
  // 中段用 translateX(-50%) 让标签**中心**压在手柄上：absolute 的 left 百分比是让
  // 左边缘落在那里，而手柄靠 -translate-x-1/2 让中心落在那里，不补这半个宽度就对不齐。
  const labelStyle = (pct: number): CSSProperties => {
    // 贴边时改成左对齐/右对齐：选区只剩零点几秒时，居中会把标签顶出轨道被裁掉。
    if (pct < 10) return { left: '0%' };
    if (pct > 90) return { left: '100%', transform: 'translateX(-100%)' };
    return { left: `${pct}%`, transform: 'translateX(-50%)' };
  };

  // —— 播放片段：只放选中的那一段，并且把画面铺在首尾帧那一块上。
  //
  // 用一个自己的静音 <video> 当主时钟，不套 useComposePlayback：那个 hook 是为
  // 「多条片段拼成的时间线」写的墙钟，单视频场景里 `video.currentTime` 本身就是
  // 最准的时钟。拖动手柄不会走到这里。
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const previewToken = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [playheadPct, setPlayheadPct] = useState<number | null>(null);

  const stopPreview = useCallback(() => {
    previewToken.current += 1;
    previewRef.current?.pause();
    setPlaying(false);
    setPlayheadPct(null);
  }, []);

  const startPreview = useCallback(() => {
    const el = previewRef.current;
    if (!el) return;
    const token = previewToken.current + 1;
    previewToken.current = token;
    const limit =
      Number.isFinite(el.duration) && el.duration > 0 ? el.duration : duration;
    const at = Math.min(Math.max(0, startSeconds), Math.max(0, limit - 0.05));

    const start = () => {
      if (previewToken.current !== token) return;
      setPlaying(true);
      void el.play().catch(() => {
        if (previewToken.current !== token) return;
        setPlaying(false);
        setPlayheadPct(null);
      });
    };

    const seekThenStart = () => {
      if (previewToken.current !== token) return;
      const onSeeked = () => {
        el.removeEventListener('seeked', onSeeked);
        start();
      };
      el.addEventListener('seeked', onSeeked);
      try {
        el.currentTime = at;
      } catch {
        el.removeEventListener('seeked', onSeeked);
        el.addEventListener(
          'loadedmetadata',
          () => {
            el.removeEventListener('seeked', onSeeked);
            seekThenStart();
          },
          { once: true },
        );
        return;
      }
      // jsdom 和已经停在这一帧上的播放器会同步改 currentTime，不会再派 seeked。
      if (Math.abs(el.currentTime - at) < 0.08) {
        el.removeEventListener('seeked', onSeeked);
        start();
      }
    };

    seekThenStart();
  }, [duration, startSeconds]);

  const togglePreview = useCallback(() => {
    if (playing) {
      stopPreview();
      return;
    }
    startPreview();
  }, [playing, startPreview, stopPreview]);

  // 拖手柄 / 换片 / 被禁用时停掉试看：播放头停在旧选区里会误导人。
  useEffect(() => {
    stopPreview();
  }, [startSeconds, endSeconds, videoUrl, disabled, stopPreview]);

  return (
    <div className="select-none" data-testid="reshoot-timeline">
      <div>
      {/* 首尾帧并排铺满面板：40px 的小条看不清入点/出点。播放时同一块区域换成
          选中片段的画面，放到终点就停，不会把后面的片子也放出来。 */}
      {videoUrl && (
        <div className="relative mb-2 grid grid-cols-2 gap-2" data-testid="reshoot-edge-frames">
          <EdgeFrame
            src={videoUrl}
            seconds={startSeconds}
            label={t('node.reshootTimeline.startFrame')}
            testId="reshoot-start-frame"
          />
          <EdgeFrame
            src={videoUrl}
            seconds={endSeconds}
            label={t('node.reshootTimeline.endFrame')}
            testId="reshoot-end-frame"
          />
          {/* 不用 display:none：部分浏览器会把隐藏 video 直接暂停。 */}
          <video
            ref={previewRef}
            src={videoUrl}
            muted
            playsInline
            preload="metadata"
            className={
              playing
                ? 'absolute inset-0 z-10 h-full w-full rounded-md bg-black object-contain'
                : 'pointer-events-none absolute h-px w-px opacity-0'
            }
            onClick={(event) => {
              event.stopPropagation();
              if (playing) stopPreview();
            }}
            onTimeUpdate={(event) => {
              if (!playing) return;
              const el = event.currentTarget;
              const at = el.currentTime;
              // seek 还没落到选区里时，旧的 currentTime 会落在终点之后，不能据此停播。
              if (at < startSeconds - 0.2) return;
              if (at >= endSeconds - 0.02) {
                stopPreview();
                return;
              }
              if (duration > 0) setPlayheadPct((at / duration) * 100);
            }}
            onEnded={stopPreview}
            data-testid="reshoot-preview-video"
          />
        </div>
      )}
      <div className="relative min-w-0">
      <div className="relative h-16 w-full overflow-hidden rounded-md border border-white/10 bg-white/5">
        {/* 缩略图带：把原片铺在轨道上，选区直接对着画面内容选。
            没给 videoUrl 就不铺——空视频号铺 8 个空槽只会让轨道显得更脏。 */}
        {videoUrl && (
          <div className="absolute inset-0 flex" data-testid="reshoot-strip">
            {Array.from({ length: STRIP_FRAME_COUNT }).map((_, index) => (
              <div
                key={index}
                className="h-full flex-1 bg-white/5"
                style={{
                  backgroundImage: stripFrames[index]
                    ? `url(${stripFrames[index]})`
                    : undefined,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                }}
              />
            ))}
          </div>
        )}

        {/* 选中区间高亮。起止画面在上方两张大图里，这里只标范围。 */}
        <div
          className="absolute inset-y-0 rounded-sm border-x-2 border-white bg-[rgb(var(--accent-rgb)/0.22)]"
          style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
          data-testid="reshoot-selection"
        />
        {/* 选区外的压暗，跟「剪辑」面板同一套视觉语言 */}
        <div
          className="pointer-events-none absolute inset-y-0 left-0 bg-black/55"
          style={{ width: `${startPct}%` }}
        />
        <div
          className="pointer-events-none absolute inset-y-0 right-0 bg-black/55"
          style={{ width: `${100 - endPct}%` }}
        />

        {/* 播放头：只在试看时出现，扫过选区就停。琥珀色是为了和选区的白边、
            手柄的白色区分开——三条白线叠在一起谁也认不出哪条是播放头。 */}
        {playheadPct !== null && (
          <div
            className="pointer-events-none absolute inset-y-0 z-30 w-[2px] -translate-x-1/2 bg-amber-300 shadow-[0_0_4px_rgba(0,0,0,0.8)]"
            style={{ left: `${playheadPct}%` }}
            data-testid="reshoot-playhead"
          />
        )}
      </div>

      {/* 手柄层：盖在轨道上的透明姐妹层，唯一区别是它不裁剪——0%/100% 时圆钮的
          半个身位落在轨道外，放在 overflow-hidden 里会被削掉。给它套一层同样宽度的
          transparent border，padding box 就和轨道的 padding box 严丝合缝，
          left: x% 落在同一像素上。 */}
      <div
        ref={handleLayerRef}
        className="pointer-events-none absolute inset-x-0 top-0 h-16 rounded-md border border-transparent"
        data-testid="reshoot-handle-layer"
      >
        <button
          type="button"
          role="slider"
          aria-label={t('node.reshootTimeline.startHandle')}
          aria-valuenow={startSeconds}
          aria-valuemin={0}
          aria-valuemax={duration}
          disabled={disabled}
          className={handleClass}
          style={{ left: `${startPct}%` }}
          onPointerDown={(event) => {
            if (disabled) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging('start');
          }}
          onKeyDown={onHandleKeyDown('start')}
        >
          <span className={handleKnobClass} />
        </button>
        <button
          type="button"
          role="slider"
          aria-label={t('node.reshootTimeline.endHandle')}
          aria-valuenow={endSeconds}
          aria-valuemin={0}
          aria-valuemax={duration}
          disabled={disabled}
          className={handleClass}
          style={{ left: `${endPct}%` }}
          onPointerDown={(event) => {
            if (disabled) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging('end');
          }}
          onKeyDown={onHandleKeyDown('end')}
        >
          <span className={handleKnobClass} />
        </button>

        {/* 数字标签是手柄层的直接子元素，不是按钮的子元素：按钮只有 3px 宽、还带
            -translate-x-1/2，标签放里面会被这 1.5px 的偏移带歪。挂在层上，left: x%
            就是边界本身，起止点对齐不用算按钮宽度。 */}
        <span
          className={`${labelClass} z-20`}
          data-testid="reshoot-start-label"
          style={labelStyle(startPct)}
        >
          {t('node.reshootTimeline.startLabel', { value: startSeconds.toFixed(1) })}
        </span>
        <span
          className={`${labelClass} z-20`}
          data-testid="reshoot-end-label"
          style={labelStyle(endPct)}
        >
          {t('node.reshootTimeline.endLabel', { value: endSeconds.toFixed(1) })}
        </span>
      </div>
      </div>
      </div>

      <button
        type="button"
        disabled={disabled || !videoUrl}
        onClick={(event) => {
          event.stopPropagation();
          togglePreview();
        }}
        aria-pressed={playing}
        className="mt-2 flex h-8 w-full items-center justify-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3 text-[12px] text-text-main transition-colors hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="reshoot-play"
      >
        {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        {playing
          ? t('node.reshootTimeline.pausePreview')
          : t('node.reshootTimeline.playPreview')}
        <span className="tabular-nums text-text-dim">
          {startSeconds.toFixed(1)}–{endSeconds.toFixed(1)}s
        </span>
      </button>

      {/* 起/止已经贴在手柄上了，这里只留一句总时长。 */}
      <div className="mt-1 flex items-center gap-2 text-[12px] text-text-dim">
        <span>{t('node.reshootTimeline.spanLabel', { value: span.toFixed(1) })}</span>
      </div>
    </div>
  );
}

/**
 * 取源视频时长（秒）：优先节点存的 durationMs，没有就现拉 <video> metadata。
 * 两条路都失败返回 null——调用方据此禁用提交，而不是猜一个时长。
 */
export function useVideoDurationSeconds(
  videoUrl: string | null | undefined,
  durationMs?: number | null,
): number | null {
  const [probed, setProbed] = useState<number | null>(null);

  useEffect(() => {
    if (typeof durationMs === 'number' && durationMs > 0) {
      setProbed(durationMs / 1000);
      return;
    }
    if (!videoUrl) {
      setProbed(null);
      return;
    }
    let cancelled = false;
    const video = document.createElement('video');
    video.preload = 'metadata';
    const onLoaded = () => {
      if (!cancelled && Number.isFinite(video.duration) && video.duration > 0) {
        setProbed(video.duration);
      }
    };
    const onError = () => {
      if (!cancelled) setProbed(null);
    };
    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('error', onError);
    video.src = videoUrl;
    return () => {
      cancelled = true;
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
      video.src = '';
    };
  }, [videoUrl, durationMs]);

  if (typeof durationMs === 'number' && durationMs > 0) {
    return durationMs / 1000;
  }
  return probed;
}
