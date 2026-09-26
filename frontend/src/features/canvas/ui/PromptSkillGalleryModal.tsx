// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useState } from 'react';
import { Wand2 } from 'lucide-react';
import {
  NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS,
  NODE_INLINE_ICON_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { useTranslation } from 'react-i18next';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface VideoPromptSkill {
  id: string;
  title: string;
  summary: string;
  instruction: string;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  coverUrl?: string;
}

const SKILL_URL = '/prompt-gallery/video-skills.json';

export function PromptSkillGalleryModal({
  open,
  selectedId,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  selectedId?: string | null;
  onOpenChange: (open: boolean) => void;
  onSelect: (skill: VideoPromptSkill | null) => void;
}) {
  const { t } = useTranslation();
  const [skills, setSkills] = useState<VideoPromptSkill[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [keyword, setKeyword] = useState('');
  const [sourceId, setSourceId] = useState('all');

  useEffect(() => {
    if (!open || skills.length > 0) return;
    let cancelled = false;
    setStatus('loading');
    void fetch(SKILL_URL)
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<VideoPromptSkill[]>;
      })
      .then((rows) => {
        if (cancelled) return;
        setSkills(Array.isArray(rows) ? rows : []);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [open, skills.length]);

  const sources = useMemo(() => {
    const names = new Map<string, string>();
    for (const skill of skills) names.set(skill.sourceId, skill.sourceName);
    return [...names.entries()];
  }, [skills]);

  const visible = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    return skills.filter((skill) => {
      if (sourceId !== 'all' && skill.sourceId !== sourceId) return false;
      if (!query) return true;
      return `${skill.title} ${skill.summary} ${skill.sourceName}`.toLowerCase().includes(query);
    });
  }, [keyword, skills, sourceId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-3 sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-amber-200" />
            {t('canvas.promptSkill.title')}
          </DialogTitle>
          <DialogDescription>{t('canvas.promptSkill.description')}</DialogDescription>
        </DialogHeader>
        <input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={t('canvas.promptSkill.search')}
          className="h-8 rounded-[8px] border border-amber-200/20 bg-black/30 px-3 text-xs outline-none placeholder:text-text-muted/70"
        />
        <div className="flex flex-wrap gap-1.5">
          <SourceChip active={sourceId === 'all'} label={t('canvas.promptGallery.allSources')} onClick={() => setSourceId('all')} />
          {sources.map(([id, name]) => (
            <SourceChip key={id} active={sourceId === id} label={name} onClick={() => setSourceId(id)} />
          ))}
        </div>
        <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
          {status === 'loading' ? (
            <p className="py-8 text-center text-xs text-text-muted">{t('canvas.promptSkill.loading')}</p>
          ) : status === 'error' ? (
            <p className="py-8 text-center text-xs text-text-muted">{t('canvas.promptSkill.failed')}</p>
          ) : (
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => {
                  onSelect(null);
                  onOpenChange(false);
                }}
                className="flex w-full items-center justify-between rounded-[8px] border border-white/10 px-3 py-2 text-left text-xs text-text-muted hover:bg-white/[0.04]"
              >
                {t('canvas.promptSkill.none')}
              </button>
              {visible.length === 0 ? (
                <p className="py-8 text-center text-xs text-text-muted">{t('canvas.promptSkill.empty')}</p>
              ) : (
                visible.map((skill) => {
                  const active = skill.id === selectedId;
                  return (
                    <button
                      key={skill.id}
                      type="button"
                      onClick={() => {
                        onSelect(skill);
                        onOpenChange(false);
                      }}
                      className={
                        active
                          ? 'flex w-full gap-3 rounded-[8px] border border-amber-200/50 bg-amber-300/10 p-2 text-left'
                          : 'flex w-full gap-3 rounded-[8px] border border-white/10 bg-white/[0.03] p-2 text-left hover:border-amber-200/30 hover:bg-amber-300/[0.06]'
                      }
                    >
                      <SkillCover src={skill.coverUrl} alt={skill.title} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium text-text-dark">{skill.title}</span>
                          <span className="shrink-0 text-xs text-amber-100/70">{skill.sourceName}</span>
                        </span>
                        {skill.summary ? (
                          <span className="mt-1 block text-xs leading-5 text-text-muted">{skill.summary}</span>
                        ) : null}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SkillCover({ src, alt }: { src?: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return <span className="h-16 w-24 shrink-0 rounded-[6px] bg-white/[0.06]" />;
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="h-16 w-24 shrink-0 rounded-[6px] object-cover"
    />
  );
}

function SourceChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? 'rounded-full border border-amber-200/50 bg-amber-300/15 px-2.5 py-1 text-xs text-amber-50'
          : 'rounded-full border border-white/10 px-2.5 py-1 text-xs text-text-muted hover:border-white/25'
      }
    >
      {label}
    </button>
  );
}

export function PromptSkillChip({
  title,
  onOpen,
}: {
  title?: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const label = title
    ? `${t('canvas.promptSkill.chip')}：${title}`
    : t('canvas.promptSkill.chipTitle');
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={Boolean(title)}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      className={`${NODE_INLINE_ICON_BUTTON_CLASS} ${
        title ? 'bg-amber-300/15 text-amber-50 hover:bg-amber-300/25 hover:text-amber-50' : ''
      } ${title ? NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS : ''}`}
    >
      <Wand2 className="h-4 w-4" />
    </button>
  );
}

