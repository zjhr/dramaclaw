import * as pc from "playcanvas";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { CharacterPerformance } from "@/features/canvas/domain/canvasNodes";
import { createCharacterFaceScene } from "./characterFaceScene";

export function CharacterFacePreview({ performance }: { performance: CharacterPerformance }) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<ReturnType<typeof createCharacterFaceScene> | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let app: pc.Application | null = null;
    try {
      app = new pc.Application(canvas, {
        graphicsDeviceOptions: { antialias: true, alpha: false, powerPreference: "low-power" },
      });
      app.setCanvasFillMode(pc.FILLMODE_NONE);
      app.setCanvasResolution(pc.RESOLUTION_AUTO);
      const activeApp = app;
      const resize = () => {
        const bounds = canvas.parentElement?.getBoundingClientRect();
        if (bounds && bounds.width > 0 && bounds.height > 0) {
          activeApp.graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
          activeApp.resizeCanvas(bounds.width, bounds.height);
        }
      };
      resize();
      const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
      if (observer && canvas.parentElement) observer.observe(canvas.parentElement);
      sceneRef.current = createCharacterFaceScene(app);
      app.start();
      return () => {
        observer?.disconnect();
        sceneRef.current?.destroy();
        sceneRef.current = null;
        activeApp.destroy();
      };
    } catch {
      app?.destroy();
      return;
    }
  }, []);

  useEffect(() => {
    sceneRef.current?.update(performance);
  }, [performance]);

  return (
    <div className="flex w-full min-w-0 flex-col items-center">
      <div className="relative aspect-video h-[180px] w-full max-w-[320px] overflow-hidden rounded-md border border-white/10 bg-[#12151b]">
        <canvas ref={canvasRef} aria-label={t("node.performance.preview.canvasLabel")} className="block h-full w-full" />
        <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/55 px-2 py-1 text-xs text-white/70">{t("node.performance.preview.label")}</span>
      </div>
      <p className="mt-1 w-full max-w-[320px] text-xs leading-4 text-white/60">{t("node.performance.preview.disclaimer")}</p>
    </div>
  );
}
