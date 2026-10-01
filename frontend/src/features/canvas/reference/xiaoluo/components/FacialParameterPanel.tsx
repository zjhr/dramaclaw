import React, { useState } from 'react';
import { useEmotionStore } from '../store/useEmotionStore';
import { Sliders, Sparkles } from 'lucide-react';

function ControlField({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5">
      <span className="truncate text-xs font-medium text-white/80">{label}</span>
      <span className="font-mono text-xs font-semibold tabular-nums text-cyan-200">{value}</span>
      <div className="col-span-2">{children}</div>
    </label>
  );
}

const rangeClass = 'h-5 w-full cursor-pointer';
const selectClass = 'h-7 w-full appearance-none rounded-md border border-white/10 bg-white/[0.08] px-2 text-xs font-medium text-white/85 focus:border-cyan-300/60 focus:outline-none';

export const FacialParameterPanel: React.FC = () => {
  const {
    facialState,
    updateEyeParam,
    updateEyebrowParam,
    updateMouthParam,
    updateFaceParam,
  } = useEmotionStore();
  const [autoAddPrompt, setAutoAddPrompt] = useState(true);

  return (
    <section aria-label="面部微表情解剖" className="flex h-full min-h-0 flex-col gap-2 rounded-[10px] border border-white/10 bg-[#17191f] p-2.5 text-white">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Sliders className="h-3.5 w-3.5 shrink-0 text-cyan-300" />
          <h2 title="精密面部微控参数 (FACIAL CONTROLS)" className="truncate text-xs font-semibold text-white/90">精密面部微控参数 (FACIAL CONTROLS)</h2>
        </div>
        <button
          type="button"
          aria-pressed={autoAddPrompt}
          aria-label="生成时自动加入微表情提示词"
          onClick={() => setAutoAddPrompt(!autoAddPrompt)}
          className={`flex h-6 w-10 shrink-0 items-center rounded-full px-0.5 ${autoAddPrompt ? 'bg-cyan-400' : 'bg-white/25'}`}
        >
          <Sparkles className="sr-only" />
          <span className={`h-5 w-5 rounded-full bg-white shadow-md ${autoAddPrompt ? 'translate-x-4' : 'translate-x-0'}`} />
        </button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-3 content-between gap-x-4">
        <ControlField label="睁眼程度" value={`${facialState.eye.openness}%`}>
          <input type="range" min="-50" max="50" value={facialState.eye.openness} onChange={(e) => updateEyeParam('openness', parseInt(e.target.value))} className={rangeClass} />
        </ControlField>
        <ControlField label="视线强度" value={`${facialState.eye.focus}`}>
          <input type="range" min="0" max="100" value={facialState.eye.focus} onChange={(e) => updateEyeParam('focus', parseInt(e.target.value))} className={rangeClass} />
        </ControlField>
        <ControlField label="眉毛紧张度" value={`${facialState.eyebrow.tension}%`}>
          <input type="range" min="0" max="100" value={facialState.eyebrow.tension} onChange={(e) => updateEyebrowParam('tension', parseInt(e.target.value))} className={rangeClass} />
        </ControlField>
        <ControlField label="眉毛高度" value={`${Math.round(facialState.eyebrow.height)}`}>
          <input type="range" min="-50" max="50" value={facialState.eyebrow.height} onChange={(e) => updateEyebrowParam('height', parseInt(e.target.value))} className={rangeClass} />
        </ControlField>
        <ControlField label="嘴角弧度" value={`${Math.round(facialState.mouth.curve)}`}>
          <input type="range" min="-100" max="100" value={facialState.mouth.curve} onChange={(e) => updateMouthParam('curve', parseInt(e.target.value))} className={rangeClass} />
        </ControlField>
        <ControlField label="肌肉紧绷" value={`${facialState.face.muscleTension}%`}>
          <input type="range" min="0" max="100" value={facialState.face.muscleTension} onChange={(e) => updateFaceParam('muscleTension', parseInt(e.target.value))} className={rangeClass} />
        </ControlField>
        <ControlField label="头部倾斜" value={`${Math.round(facialState.face.headTilt)}°`}>
          <input type="range" min="-30" max="30" value={facialState.face.headTilt} onChange={(e) => updateFaceParam('headTilt', parseInt(e.target.value))} className={rangeClass} />
        </ControlField>
        <ControlField label="眼神视线" value="">
          <select value={facialState.eye.direction} onChange={(e) => updateEyeParam('direction', e.target.value as never)} className={selectClass}>
            <option value="direct gaze">直视镜头</option>
            <option value="avoid gaze">回避眼神</option>
            <option value="cold stare">冷酷凝视</option>
            <option value="soft gaze">温柔眼神</option>
            <option value="down">垂眸低头</option>
            <option value="up">仰视</option>
          </select>
        </ControlField>
        <ControlField label="嘴部状态" value="">
          <select value={facialState.mouth.state} onChange={(e) => updateMouthParam('state', e.target.value as never)} className={selectClass}>
            <option value="neutral">自然闭合</option>
            <option value="smile">微笑扬起</option>
            <option value="pressed lips">紧抿唇线</option>
            <option value="slight opening">微张吸气</option>
            <option value="trembling">嘴唇颤抖</option>
          </select>
        </ControlField>
      </div>
    </section>
  );
};
