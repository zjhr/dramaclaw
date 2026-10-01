import { useEffect, useRef } from "react";
import type { CharacterPerformance, CharacterPerformanceKeyframe } from "@/features/canvas/domain/canvasNodes";
import { MinimalMatrixStudio } from "@/features/canvas/reference/xiaoluo/components/MinimalMatrixStudio";
import type { FacialState, EmotionKeyframe } from "@/features/canvas/reference/xiaoluo/types";
import { useEmotionStore } from "@/features/canvas/reference/xiaoluo/store/useEmotionStore";
import { facialStateForVector, findNearestPreset } from "@/features/canvas/reference/xiaoluo/data/presets";

type Section = "face" | "emotion" | "timeline";
type StudioChange = (performance: CharacterPerformance, keyframes: CharacterPerformanceKeyframe[]) => void;

function toFacialState(value: CharacterPerformance): FacialState {
  // 用最近命名预设的授权表情作基底，保证与情绪定位标签一致；手动滑杆仍在下方覆盖。
  const vectorFacial = facialStateForVector({
    valence: value.valence * 100,
    arousal: value.arousal * 100,
    distance: 0,
  });
  const hasOverride = (number: number) => Math.abs(number) > 0.001;
  const eyesOverride = hasOverride(value.eyes);
  const browsOverride = hasOverride(value.brows);
  const mouthOverride = hasOverride(value.mouth);
  const jawOverride = hasOverride(value.jaw);

  return {
    eye: {
      ...vectorFacial.eye,
      openness: eyesOverride ? value.eyes * 50 : vectorFacial.eye.openness,
    },
    eyebrow: {
      ...vectorFacial.eyebrow,
      tension: browsOverride ? Math.abs(value.brows) * 100 : vectorFacial.eyebrow.tension,
      height: browsOverride ? value.brows * 50 : vectorFacial.eyebrow.height,
    },
    mouth: {
      ...vectorFacial.mouth,
      curve: mouthOverride ? value.mouth * 100 : vectorFacial.mouth.curve,
      tension: mouthOverride ? Math.abs(value.mouth) * 100 : vectorFacial.mouth.tension,
      state: mouthOverride
        ? value.mouth > 0.2
          ? "smile"
          : value.mouth < -0.2
            ? "pressed lips"
            : "neutral"
        : vectorFacial.mouth.state,
    },
    face: {
      ...vectorFacial.face,
      muscleTension: jawOverride ? Math.abs(value.jaw) * 100 : vectorFacial.face.muscleTension,
    },
  };
}

function fromFacialState(base: CharacterPerformance, facial: FacialState): CharacterPerformance {
  return { ...base, eyes: facial.eye.openness / 50, brows: facial.eyebrow.height / 50, mouth: facial.mouth.curve / 100, jaw: facial.face.muscleTension / 100 };
}

function toSourceFrame(frame: CharacterPerformanceKeyframe, index: number): EmotionKeyframe {
  return {
    id: `drama-${index}-${frame.timeMs}`,
    time: frame.timeMs / 1000,
    emotionVector: { valence: frame.performance.valence * 100, arousal: frame.performance.arousal * 100, distance: 0 },
    facialState: toFacialState(frame.performance),
    label: `${(frame.timeMs / 1000).toFixed(1)}s`,
  };
}

export function XiaoLuoPerformanceStudio({
  section,
  performance,
  keyframes,
  onChange,
}: {
  section?: Section;
  performance: CharacterPerformance;
  keyframes: CharacterPerformanceKeyframe[];
  onChange: StudioChange;
}) {
  const input = useRef({ performance, keyframes, onChange });
  input.current = { performance, keyframes, onChange };
  const keyframeSignature = JSON.stringify(keyframes);

  useEffect(() => {
    const current = input.current;
    const vector = { valence: current.performance.valence * 100, arousal: current.performance.arousal * 100, distance: 0 };
    const previousVector = useEmotionStore.getState().vector;
    const emotionMoved = previousVector.valence !== vector.valence || previousVector.arousal !== vector.arousal;
    useEmotionStore.setState({
      vector,
      facialState: toFacialState(current.performance),
      keyframes: current.keyframes.map(toSourceFrame),
      currentTime: 0,
      ...(emotionMoved ? { activePresetId: findNearestPreset(vector).id } : {}),
    } as never);
    let previous = useEmotionStore.getState();
    return useEmotionStore.subscribe((next) => {
      if (next.vector === previous.vector && next.facialState === previous.facialState && next.keyframes === previous.keyframes) return;
      previous = next;
      const base = input.current.performance;
      const mapped = fromFacialState({ ...base, valence: next.vector.valence / 100, arousal: next.vector.arousal / 100 }, next.facialState);
      const mappedFrames = (next.keyframes as EmotionKeyframe[]).map((frame) => ({
        timeMs: Math.round(frame.time * 1000),
        performance: fromFacialState({ ...base, valence: frame.emotionVector.valence / 100, arousal: frame.emotionVector.arousal / 100 }, frame.facialState),
      }));
      input.current.onChange(mapped, mappedFrames);
    });
  }, [performance.valence, performance.arousal, performance.brows, performance.eyes, performance.mouth, performance.jaw, keyframeSignature]);

  const selectEmotion = (valence: number, arousal: number) => {
    // 矩阵选择代表一次新的情绪定位，清掉上一轮滑块写入的覆盖值，
    // 让新的 valence/arousal 重新驱动完整面部状态。
    onChange({ ...performance, valence, arousal, brows: 0, eyes: 0, mouth: 0, jaw: 0 }, keyframes);
  };

  return (
    <div data-testid="xiaoluo-performance-studio" data-section={section} className="xiaoluo-performance-surface h-full min-h-0 min-w-0">
      <MinimalMatrixStudio
        performance={performance}
        onSelect={selectEmotion}
      />
    </div>
  );
}
