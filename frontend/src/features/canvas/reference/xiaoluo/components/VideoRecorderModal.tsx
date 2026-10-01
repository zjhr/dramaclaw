import React, { useState, useRef, useEffect } from 'react';
import { useEmotionStore } from '../store/useEmotionStore';
import { Video, Download, X, RefreshCw, Check, Loader2 } from 'lucide-react';

interface VideoRecorderModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const VideoRecorderModal: React.FC<VideoRecorderModalProps> = ({ isOpen, onClose }) => {
  const { currentTime, setCurrentTime, isPlayingTimeline, setIsPlayingTimeline } = useEmotionStore();

  const [duration, setDuration] = useState<number>(30); // seconds
  const [resolution, setResolution] = useState<number>(720); // 720x720
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordingProgress, setRecordingProgress] = useState<number>(0);
  const [recordedTime, setRecordedTime] = useState<number>(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [fileSizeMB, setFileSizeMB] = useState<string>('0');

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isCancelledRef = useRef<boolean>(false);

  useEffect(() => {
    if (!isOpen) {
      // Clean up video URL on close
      if (videoUrl) {
        URL.revokeObjectURL(videoUrl);
        setVideoUrl(null);
      }
      setIsRecording(false);
      setRecordingProgress(0);
      setRecordedTime(0);
      isCancelledRef.current = true;
    } else {
      isCancelledRef.current = false;
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const drawWebGLFrame = (
    sourceCanvas: HTMLCanvasElement,
    targetCanvas: HTMLCanvasElement
  ) => {
    const ctx = targetCanvas.getContext('2d');
    if (!ctx || sourceCanvas.width <= 0 || sourceCanvas.height <= 0) return;

    const radialGrad = ctx.createRadialGradient(
      targetCanvas.width / 2,
      targetCanvas.height * 0.45,
      targetCanvas.width * 0.08,
      targetCanvas.width / 2,
      targetCanvas.height / 2,
      targetCanvas.width * 0.72
    );
    radialGrad.addColorStop(0, '#25262b');
    radialGrad.addColorStop(0.58, '#17181c');
    radialGrad.addColorStop(1, '#0d0e12');
    ctx.fillStyle = radialGrad;
    ctx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);

    const scale = Math.min(
      targetCanvas.width / sourceCanvas.width,
      targetCanvas.height / sourceCanvas.height
    );
    const drawWidth = sourceCanvas.width * scale;
    const drawHeight = sourceCanvas.height * scale;
    const drawX = (targetCanvas.width - drawWidth) / 2;
    const drawY = (targetCanvas.height - drawHeight) / 2;
    ctx.drawImage(sourceCanvas, drawX, drawY, drawWidth, drawHeight);
  };

  const handleStartRecording = async () => {
    const sourceCanvas = document.querySelector(
      'canvas[data-mannequin-canvas="true"]'
    ) as HTMLCanvasElement | null;
    if (!sourceCanvas || !canvasRef.current) {
      alert('无法获取 3D 模型画面，请确认模型已经加载完成。');
      return;
    }

    // Reset previous states
    if (videoUrl) {
      URL.revokeObjectURL(videoUrl);
      setVideoUrl(null);
    }

    const canvas = canvasRef.current;
    canvas.width = resolution;
    canvas.height = resolution;

    const originalTime = currentTime;
    const originalPlaying = isPlayingTimeline;
    setIsPlayingTimeline(false); // Pause manual playback

    setIsRecording(true);
    setRecordingProgress(0);
    setRecordedTime(0);
    isCancelledRef.current = false;

    // Check media recorder mime support
    let mimeType = 'video/webm';
    if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) {
      mimeType = 'video/webm;codecs=vp9';
    } else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) {
      mimeType = 'video/webm;codecs=vp8';
    } else if (MediaRecorder.isTypeSupported('video/mp4')) {
      mimeType = 'video/mp4';
    }

    const stream = canvas.captureStream(30); // 30 FPS stream
    const chunks: Blob[] = [];
    const mediaRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5000000 });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
      }
    };

    mediaRecorder.start(100);

    const fps = 30;
    const timeStep = 1 / fps;
    const totalFrames = Math.floor(duration * fps);

    for (let frame = 0; frame <= totalFrames; frame++) {
      if (isCancelledRef.current) {
        mediaRecorder.stop();
        setIsRecording(false);
        setCurrentTime(originalTime);
        return;
      }

      const t = Math.min(duration, frame * timeStep);
      setCurrentTime(t);
      setRecordedTime(t);
      setRecordingProgress(Math.round((frame / totalFrames) * 100));

      // Let React update the timeline state and Three.js render the next frame.
      await new Promise((r) => setTimeout(r, 34));

      // Draw frame to canvas
      drawWebGLFrame(sourceCanvas, canvas);
    }

    // Finish recording
    mediaRecorder.stop();

    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      setVideoUrl(url);
      setFileSizeMB((blob.size / (1024 * 1024)).toFixed(2));
      setIsRecording(false);
      setCurrentTime(originalTime);
      setIsPlayingTimeline(originalPlaying);
    };
  };

  const handleDownload = () => {
    if (!videoUrl) return;
    const a = document.createElement('a');
    a.href = videoUrl;
    a.download = `expression-acting-animation-${duration}s.webm`;
    a.click();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="flex w-full max-w-2xl flex-col overflow-hidden rounded-[14px] border border-border-dark bg-surface-dark text-text-dark shadow-2xl">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-border-dark bg-bg-dark/45 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="rounded-md bg-accent p-2 text-white shadow-sm">
              <Video className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-text-dark">微表情表演视频录制 (VIDEO RECORDING)</h3>
              <p className="text-xs text-text-muted">将当前的表情动画与时间轴运动轨迹导出为 WebM 视频</p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={isRecording}
            className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-white/[0.06] hover:text-text-dark disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Content */}
        <div className="p-6 flex flex-col gap-5">
          {/* Settings Row */}
          {!isRecording && !videoUrl && (
            <div className="grid grid-cols-1 gap-4 rounded-[10px] border border-border-dark bg-bg-dark/45 p-4 sm:grid-cols-2">
              {/* Duration selection */}
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-text-muted">
                  录制时长 (Duration)
                </label>
                <div className="grid grid-cols-4 gap-1.5">
                  {[5, 10, 15, 30].map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDuration(d)}
                      className={`py-1.5 rounded-lg text-xs font-bold transition-all border ${
                        duration === d
                          ? 'border-accent bg-accent text-white shadow-sm'
                          : 'border-border-dark bg-surface-dark text-text-muted hover:bg-white/[0.06]'
                      }`}
                    >
                      {d}s
                    </button>
                  ))}
                </div>
              </div>

              {/* Resolution selection */}
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-text-muted">
                  视频清晰度 (Resolution)
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: '高清 720p', val: 720 },
                    { label: '超清 1080p', val: 1080 },
                  ].map((res) => (
                    <button
                      key={res.val}
                      type="button"
                      onClick={() => setResolution(res.val)}
                      className={`py-1.5 rounded-lg text-xs font-bold transition-all border ${
                        resolution === res.val
                          ? 'border-accent bg-accent text-white shadow-sm'
                          : 'border-border-dark bg-surface-dark text-text-muted hover:bg-white/[0.06]'
                      }`}
                    >
                      {res.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Canvas or Video Preview Area */}
          <div className="relative w-full aspect-square max-h-[340px] bg-[#101116] rounded-2xl overflow-hidden flex items-center justify-center border border-slate-800 shadow-inner group">
            {/* Realtime Canvas rendering during recording */}
            <canvas
              ref={canvasRef}
              className={`w-full h-full object-contain ${videoUrl ? 'hidden' : 'block'}`}
            />

            {/* Rendered Video Result */}
            {videoUrl && (
              <video
                src={videoUrl}
                controls
                autoPlay
                loop
                className="w-full h-full object-contain"
              />
            )}

            {/* Recording overlay indicator */}
            {isRecording && (
              <div className="absolute top-3 left-3 bg-red-600 text-white px-3 py-1 rounded-full text-xs font-mono font-bold flex items-center gap-2 shadow-lg animate-pulse">
                <div className="w-2 h-2 rounded-full bg-white" />
                <span>REC {recordedTime.toFixed(1)}s / {duration}.0s</span>
              </div>
            )}
          </div>

          {/* Progress Bar when recording */}
          {isRecording && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between font-mono text-xs font-semibold text-text-muted">
                <span className="flex items-center gap-1.5 font-semibold text-accent">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  正在逐帧渲染并录制微表情动画...
                </span>
                <span>{recordingProgress}%</span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full border border-border-dark bg-bg-dark">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-150"
                  style={{ width: `${recordingProgress}%` }}
                />
              </div>
            </div>
          )}

          {/* Completed Video Info */}
          {videoUrl && (
            <div className="flex items-center justify-between rounded-[10px] border border-emerald-400/25 bg-emerald-500/10 p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-emerald-600 text-white">
                  <Check className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-xs font-semibold text-emerald-200">视频录制完成！</h4>
                  <p className="text-xs text-emerald-200/75">
                    格式: WebM | 时长: {duration}s | 分辨率: {resolution}x{resolution} | 大小: {fileSizeMB} MB
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center justify-end gap-3 mt-1">
            {!isRecording && !videoUrl && (
              <button
                onClick={handleStartRecording}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-accent py-3 text-sm font-semibold text-white shadow-lg shadow-accent/20 transition-colors hover:bg-accent/80 active:scale-[0.99]"
              >
                <Video className="w-4 h-4" />
                <span>开始生成录制视频 ({duration}s)</span>
              </button>
            )}

            {isRecording && (
              <button
                onClick={() => {
                  isCancelledRef.current = true;
                  setIsRecording(false);
                }}
                className="w-full rounded-md border border-red-400/35 bg-red-500/10 py-2.5 text-xs font-semibold text-red-200 transition-colors hover:bg-red-500/20"
              >
                取消录制
              </button>
            )}

            {videoUrl && (
              <div className="flex items-center gap-3 w-full">
                <button
                  onClick={handleStartRecording}
                  className="flex items-center justify-center gap-1.5 rounded-md border border-border-dark bg-bg-dark/60 px-4 py-2.5 text-xs font-semibold text-text-muted transition-colors hover:bg-white/[0.06] hover:text-text-dark"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>重新录制</span>
                </button>
                <button
                  onClick={handleDownload}
                  className="flex flex-1 items-center justify-center gap-2 rounded-md bg-emerald-600 py-2.5 text-xs font-semibold text-white shadow-md shadow-emerald-600/20 transition-colors hover:bg-emerald-700"
                >
                  <Download className="w-4 h-4" />
                  <span>导出下载 WebM 视频文件</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
