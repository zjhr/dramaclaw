import React, { useRef, useState, useCallback } from 'react';
import type { CharacterPerformance } from '@/features/canvas/domain/canvasNodes';
import { useEmotionStore } from '../store/useEmotionStore';
import { deriveEmotionLabelFromVector } from '../data/presets';
import { Mars, ScanFace, Venus } from 'lucide-react';
import { MannequinHeadViewport } from './MannequinHeadViewport';
import { FacialParameterPanel } from './FacialParameterPanel';
import { EmotionPresets } from './EmotionPresets';
import { PromptGenerator } from './PromptGenerator';
import { EmotionTimeline } from './EmotionTimeline';

export const MinimalMatrixStudio: React.FC<{
  performance?: CharacterPerformance;
  onSelect?: (valence: number, arousal: number) => void;
  matrixOnly?: boolean;
}> = ({ performance, onSelect, matrixOnly = false }) => {
  const {
    vector,
    setVector,
    activeCharacter,
    characters,
    setActiveCharacterId,
    facialState,
  } = useEmotionStore();

  const [showMesh, setShowMesh] = useState(false);

  const effectiveVector = performance
    ? { valence: performance.valence * 100, arousal: performance.arousal * 100, distance: vector.distance }
    : vector;
  const emotionInfo = deriveEmotionLabelFromVector(effectiveVector);
  const mannequinGender = activeCharacter.gender === '女' ? 'female' : 'male';

  const handleGenderChange = (gender: '男' | '女') => {
    const matchingCharacter = characters.find((character) => character.gender === gender);
    if (matchingCharacter) setActiveCharacterId(matchingCharacter.id);
  };

  // Map 5x5 Grid Positions
  // Grid Cols: 0 -> Valence -100 (亲近), 1 -> -50, 2 -> 0, 3 -> 50, 4 -> +100 (疏离)
  // Grid Rows: 0 -> Arousal +100 (激动), 1 -> 50, 2 -> 0, 3 -> -50, 4 -> -100 (平静)

  // Determine current active grid indices (0 to 4)
  const activeCol = Math.max(0, Math.min(4, Math.round((effectiveVector.valence + 100) / 50)));
  const activeRow = Math.max(0, Math.min(4, Math.round((100 - effectiveVector.arousal) / 50)));

  const matrixRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleSelectGrid = (row: number, col: number) => {
    const newValence = Math.round((col - 2) * 50);
    const newArousal = Math.round((2 - row) * 50);
    const nextVector = { valence: newValence, arousal: newArousal, distance: 0 };
    setVector(nextVector);
    if (onSelect) onSelect(newValence / 100, newArousal / 100);
  };

  const handlePointerUpdate = useCallback(
    (e: React.PointerEvent<HTMLDivElement> | PointerEvent) => {
      if (!matrixRef.current) return;
      const rect = matrixRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));

      const col = Math.max(0, Math.min(4, Math.floor((x / rect.width) * 5)));
      const row = Math.max(0, Math.min(4, Math.floor((y / rect.height) * 5)));

      handleSelectGrid(row, col);
    },
    [onSelect, setVector, vector.distance]
  );

  if (matrixOnly) {
    return (
      <div className="flex flex-col items-center gap-2">
        <div className="flex items-center justify-between gap-3 text-xs text-white/60">
          <span>−1 · {performance?.valence.toFixed(2) ?? (vector.valence / 100).toFixed(2)} · +1</span>
          <span>+1 · {performance?.arousal.toFixed(2) ?? (vector.arousal / 100).toFixed(2)} · −1</span>
        </div>
        <div
          role="grid"
          aria-label="XiaoLuo emotion matrix"
          className="grid aspect-square w-full max-w-[280px] grid-cols-5 grid-rows-5 items-center justify-items-center gap-2 rounded-md border border-white/10 bg-[#12131a] p-3"
        >
          {[0, 1, 2, 3, 4].flatMap((row) => [0, 1, 2, 3, 4].map((col) => {
            const active = row === activeRow && col === activeCol;
            return (
              <button
                key={`${row}-${col}`}
                type="button"
                role="gridcell"
                aria-label={`Valence ${((col - 2) * 0.5).toFixed(1)}, arousal ${((2 - row) * 0.5).toFixed(1)}`}
                aria-pressed={active}
                onClick={() => {
                  const valence = (col - 2) * 0.5;
                  const arousal = (2 - row) * 0.5;
                  if (onSelect) onSelect(valence, arousal);
                  else setVector({ valence: valence * 100, arousal: arousal * 100, distance: vector.distance });
                }}
                className={`aspect-square w-full rounded-full transition-colors ${active ? "bg-white shadow-[0_0_18px_rgba(255,255,255,0.65)]" : "bg-white/15 hover:bg-white/40"}`}
              />
            );
          }))}
        </div>
      </div>
    );
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    setIsDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    handlePointerUpdate(e);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDragging) {
      handlePointerUpdate(e);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    setIsDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
  };

  return (
    <div className="@container grid h-full min-h-0 grid-rows-[minmax(0,2fr)_auto_minmax(200px,0.55fr)] gap-3 overflow-hidden">
      <div className="grid h-full min-h-0 grid-cols-1 gap-3 overflow-hidden @[960px]:grid-cols-[minmax(0,1.45fr)_minmax(0,0.8fr)_minmax(0,0.95fr)]">
          <div className="flex h-full min-h-0 items-center justify-center overflow-hidden">
            <div data-testid="xiaoluo-main-preview" className="relative aspect-square h-full max-h-full max-w-full overflow-hidden rounded-[10px] border border-border-dark bg-bg-dark shadow-inner">
              <button
                type="button"
                aria-pressed={showMesh}
                onClick={() => setShowMesh((current) => !current)}
                className={`absolute right-3 top-3 z-20 flex items-center gap-1.5 rounded-md border px-2.5 py-2 text-xs font-semibold shadow-lg backdrop-blur-md transition-all ${
                  showMesh
                    ? 'border-accent/50 bg-accent/20 text-text-dark'
                    : 'border-white/10 bg-black/45 text-text-muted hover:bg-white/10 hover:text-text-dark'
                }`}
              >
                <ScanFace className="h-3.5 w-3.5" />
                {showMesh ? '隐藏网格' : '显示网格'}
              </button>

              {/* Realistic clay mannequin with dynamic facial morphing */}
              <MannequinHeadViewport
                facialState={facialState}
                gender={mannequinGender}
                emotionName={emotionInfo.subtitle}
                showMesh={showMesh}
              />
            <div className="absolute inset-x-2 bottom-2 flex items-center justify-between gap-2 rounded-md bg-black/55 px-2 py-1 backdrop-blur-sm">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 text-xs font-medium tracking-wider text-white/70">
                  情绪定位
                </span>
                <span className="truncate text-lg font-extrabold tracking-wide text-white">
                  {emotionInfo.title}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1 rounded-md border border-border-dark bg-bg-dark/80 p-0.5 text-xs text-text-muted">
                <span className="flex items-center gap-1 px-1.5 font-medium text-text-muted">
                  <ScanFace className="h-3.5 w-3.5" />
                  模型
                </span>
                <button
                  type="button"
                  aria-pressed={mannequinGender === 'male'}
                  onClick={() => handleGenderChange('男')}
                  className={`flex items-center gap-1 rounded-md px-1.5 py-1 font-semibold transition-all ${
                    mannequinGender === 'male'
                      ? 'bg-accent text-white shadow-sm'
                      : 'text-text-muted hover:bg-white/10 hover:text-text-dark'
                  }`}
                >
                  <Mars className="h-3.5 w-3.5" />
                  男性
                </button>
                <button
                  type="button"
                  aria-pressed={mannequinGender === 'female'}
                  onClick={() => handleGenderChange('女')}
                  className={`flex items-center gap-1 rounded-md px-1.5 py-1 font-semibold transition-all ${
                    mannequinGender === 'female'
                      ? 'bg-accent text-white shadow-sm'
                      : 'text-text-muted hover:bg-white/10 hover:text-text-dark'
                  }`}
                >
                  <Venus className="h-3.5 w-3.5" />
                  女性
                </button>
              </div>
            </div>
            </div>
          </div>

          <div data-testid="xiaoluo-emotion-layout" className="flex h-full min-h-0 flex-col overflow-hidden">
            <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 overflow-hidden rounded-[10px] border border-border-dark bg-surface-dark p-3">
              
              {/* Matrix Label: Top (激动) */}
              <div className="text-center font-bold text-text-muted text-sm tracking-wider py-1 select-none">
                激动
              </div>

              {/* Middle Row containing Left Label (亲近), 5x5 Grid, and Right Label (疏离) */}
              <div className="flex w-full items-center justify-center gap-2">
                {/* Left Label: 亲近 */}
                <div className="w-10 text-center font-bold text-text-muted text-sm tracking-wider select-none shrink-0">
                  亲近
                </div>

                {/* 5x5 Matrix Area */}
                <div
                  ref={matrixRef}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  role="grid"
                  aria-label="XiaoLuo emotion matrix"
                  className="aspect-square h-auto max-h-full w-full min-h-0 flex-1 bg-bg-dark rounded-[10px] border border-border-dark p-3 grid grid-cols-5 grid-rows-5 gap-2 items-center justify-items-center cursor-pointer select-none touch-none shadow-inner"
                >
                  {[0, 1, 2, 3, 4].map((r) =>
                    [0, 1, 2, 3, 4].map((c) => {
                      const isSelected = r === activeRow && c === activeCol;
                      const isCrosshair = r === activeRow || c === activeCol;

                      return (
                        <div
                          key={`${r}-${c}`}
                          role="gridcell"
                          aria-label={`Valence ${((c - 2) * 0.5).toFixed(1)}, arousal ${((2 - r) * 0.5).toFixed(1)}`}
                          onClick={() => handleSelectGrid(r, c)}
                          className="w-full h-full flex items-center justify-center relative group"
                        >
                          {isSelected ? (
                            /* Large Glowing White Center Dot */
                            <div className="w-5 h-5 rounded-full bg-white shadow-[0_0_18px_rgba(255,255,255,1)] transform scale-125 transition-all duration-150 relative z-10 flex items-center justify-center">
                              <div className="w-2 h-2 rounded-full bg-slate-900/20" />
                            </div>
                          ) : isCrosshair ? (
                            /* Active Crosshair Dot (Glowing Medium White) */
                            <div className="w-3.5 h-3.5 rounded-full bg-white/90 shadow-[0_0_8px_rgba(255,255,255,0.6)] transition-all duration-150" />
                          ) : (
                            /* Muted Off-grid Dot */
                            <div className="w-2.5 h-2.5 rounded-full bg-slate-700/60 group-hover:bg-slate-500 transition-all duration-150" />
                          )}
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Right Label: 疏离 */}
                <div className="w-10 text-center font-bold text-text-muted text-sm tracking-wider select-none shrink-0">
                  疏离
                </div>
              </div>

              {/* Matrix Label: Bottom (平静) */}
              <div className="text-center font-bold text-text-muted text-sm tracking-wider py-1 select-none">
                平静
              </div>
            </div>
          </div>
        <PromptGenerator />
      </div>
      <EmotionPresets />
      <div className="grid h-full min-h-0 grid-cols-1 items-stretch gap-3 @[720px]:grid-cols-2">
        <FacialParameterPanel />
        <EmotionTimeline />
      </div>
    </div>
  );
};
