import React, { useState } from 'react';
import { useEmotionStore } from '../store/useEmotionStore';
import { EMOTION_PRESETS } from '../data/presets';
import { BookmarkCheck, Search } from 'lucide-react';

const categories = [
  { id: 'all', name: '全部' },
  { id: 'calm', name: '平静' },
  { id: 'positive', name: '正向' },
  { id: 'negative', name: '负向' },
  { id: 'advanced', name: '高级' },
] as const;

export const EmotionPresets: React.FC = () => {
  const { activePresetId, applyPreset } = useEmotionStore();
  const [activeTab, setActiveTab] = useState<(typeof categories)[number]['id']>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredPresets = EMOTION_PRESETS.filter((preset) => {
    const matchesTab = activeTab === 'all' || preset.category === activeTab;
    const query = searchQuery.trim().toLowerCase();
    const matchesSearch = query.length === 0
      || preset.name.includes(searchQuery.trim())
      || preset.nameEn.toLowerCase().includes(query)
      || preset.description.includes(searchQuery.trim());
    return matchesTab && matchesSearch;
  });

  return (
    <section aria-label="25个演员情绪预设" className="flex shrink-0 flex-col gap-1.5 rounded-[10px] border border-border-dark bg-surface-dark px-3 py-2 text-text-dark">
      <div className="flex flex-wrap items-center gap-2">
        <BookmarkCheck className="h-3.5 w-3.5 shrink-0 text-accent" />
        <h2 className="shrink-0 text-xs font-semibold">情绪预设</h2>
        <select
          aria-label="预设分类"
          value={activeTab}
          onChange={(event) => setActiveTab(event.target.value as (typeof categories)[number]['id'])}
          className="h-8 rounded-md border border-border-dark bg-bg-dark px-2 text-xs text-text-dark focus:border-accent focus:outline-none"
        >
          {categories.map((category) => (
            <option key={category.id} value={category.id}>{category.name}</option>
          ))}
        </select>
        <div className="relative min-w-[140px] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="搜索情绪预设"
            aria-label="搜索情绪预设"
            className="h-8 w-full rounded-md border border-border-dark bg-bg-dark py-0 pl-7 pr-2 text-xs text-text-dark placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
        </div>
      </div>
      {filteredPresets.length === 0 ? (
        <p className="text-xs text-text-muted">没有匹配的预设</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {filteredPresets.map((preset) => {
            const selected = activePresetId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                aria-pressed={selected}
                onClick={() => applyPreset(preset.id)}
                className={`inline-flex h-8 items-center rounded-md border px-2.5 text-xs font-medium whitespace-nowrap ${
                  selected
                    ? 'border-accent bg-accent text-white'
                    : 'border-border-dark bg-bg-dark/60 text-text-dark hover:border-accent/50'
                }`}
              >
                {preset.name}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
};
