import React, { useState } from 'react';
import { useEmotionStore } from '../store/useEmotionStore';
import { Check, Copy, Expand, Wand2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const promptSections = [
  { id: 'emotion', label: '单帧微表情', key: 'emotionPrompt' },
  { id: 'video', label: '单帧视频', key: 'videoMotionPrompt' },
  { id: 'timeline', label: '时间轴', key: 'timelineMotionPrompt' },
] as const;

export const PromptGenerator: React.FC = () => {
  const { generatedPrompts, generatePrompts, isGeneratingPrompts } = useEmotionStore();
  const [activeSection, setActiveSection] = useState<(typeof promptSections)[number]['id']>('emotion');
  const [copiedSection, setCopiedSection] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const section = promptSections.find((item) => item.id === activeSection) ?? promptSections[0];
  const text = generatedPrompts[section.key] || '尚未生成';

  const copyText = (value: string, id: string) => {
    void navigator.clipboard.writeText(value);
    setCopiedSection(id);
    window.setTimeout(() => setCopiedSection(null), 2000);
  };

  return (
    <section aria-label="AI Prompt生成" className="flex h-full min-h-0 flex-col gap-2 overflow-hidden rounded-[10px] border border-border-dark bg-surface-dark p-3 text-text-dark">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">提示词</h2>
        <button
          type="button"
          onClick={() => setPromptOpen(true)}
          className="ml-auto flex items-center gap-1 text-xs text-text-muted hover:text-text-dark"
        >
          <Expand className="h-3.5 w-3.5" />
          查看
        </button>
        <button
          type="button"
          onClick={() => copyText(text, section.id)}
          className="flex items-center gap-1 text-xs text-text-muted hover:text-text-dark"
        >
          {copiedSection === section.id ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
          {copiedSection === section.id ? '已复制' : '复制'}
        </button>
        <button
          type="button"
          onClick={() => generatePrompts()}
          disabled={isGeneratingPrompts}
          className="flex h-7 items-center gap-1 rounded-md border border-accent/35 bg-accent/10 px-2.5 text-xs font-semibold text-accent hover:bg-accent/20 disabled:opacity-50"
        >
          <Wand2 className="h-3.5 w-3.5" />
          {isGeneratingPrompts ? '生成中' : '同步'}
        </button>
      </div>
      <div role="tablist" aria-label="提示词类型" className="flex shrink-0 gap-1">
        {promptSections.map((item) => {
          const selected = item.id === section.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setActiveSection(item.id)}
              className={`h-8 flex-1 rounded-md border px-2 text-xs font-medium ${
                selected
                  ? 'border-accent bg-accent text-white'
                  : 'border-border-dark bg-bg-dark/60 text-text-muted hover:text-text-dark'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <div className="ui-scrollbar min-h-0 flex-1 overflow-y-scroll rounded-md border border-border-dark bg-bg-dark px-3 py-2 text-sm leading-6 text-text-dark">
        <div className="whitespace-pre-wrap select-all">{text}</div>
      </div>
      <Dialog open={promptOpen} onOpenChange={setPromptOpen}>
        <DialogContent
          className="z-[120] flex max-h-[min(720px,80vh)] w-[min(720px,calc(100%-2rem))] max-w-none flex-col sm:max-w-none"
          overlayClassName="z-[120]"
        >
          <DialogHeader>
            <DialogTitle>{section.label}</DialogTitle>
          </DialogHeader>
          <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap text-sm leading-6 text-text-dark">
            {text}
          </div>
        </DialogContent>
      </Dialog>
      {generatedPrompts.directorNotes ? (
        <p className="line-clamp-2 shrink-0 text-xs leading-5 text-text-dark">
          <span className="font-semibold text-accent">导演提示 </span>
          {generatedPrompts.directorNotes}
        </p>
      ) : null}
    </section>
  );
};
