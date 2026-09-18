// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft,
  ChevronDown,
  Copy,
  ExternalLink,
  ImageOff,
  RefreshCw,
  Search,
  WifiOff,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { useEscapeToClose } from '@/hooks/use-escape-to-close';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { useDeferredImage } from '@/features/canvas/hooks/useDeferredImage';
import { usePromptGallery } from '@/features/canvas/hooks/usePromptGallery';
import { PromptTagPanel } from '@/features/canvas/ui/PromptTagPanel';
import {
  ALL_SOURCES,
  collectPromptSources,
  collectPromptTags,
  filterPromptItems,
  findPromptSource,
  type PromptItem,
} from '@/features/canvas/domain/promptGallery';

/**
 * 提示词画廊。
 *
 * 和「风格图墙」是两套东西：图墙选的是拼到提示词后面的风格修饰符，这里选的是
 * 一整条可以独立成立的画面/视频描述，选中即填进输入框。所以不复用
 * StyleGalleryModal —— 那个组件的每条数据都绑着 assetBase 和 styleTemplateId，
 * 数据形状和动作语义都对不上，硬塞进去要给它加一堆分支。
 *
 * 数据全部来自第三方 raw 文件，所以有三条硬规矩：
 * 1. 拉不到的源如实标出来（`failures`），不假装它不存在；
 * 2. 每条都带出处链接，CC BY 系的归属要求必须在 UI 上可见；
 * 3. 图片走 `referrerPolicy="no-referrer"`，别把用户当前地址泄给第三方 CDN。
 */

const MODAL_CLASS =
  'relative flex w-[min(1180px,94vw)] flex-col overflow-hidden rounded-[10px] border border-white/[0.12] bg-[#15161b]/96 shadow-[0_18px_48px_rgba(0,0,0,0.45)] backdrop-blur-md';
const LIST_SIZE_CLASS = 'h-[min(760px,86vh)]';

/** 单次渲染上限。上千条源全量挂进 DOM 会明显掉帧，够看就行。 */
const PAGE_SIZE = 60;

/**
 * 标签区怎么收敛。上游合起来能到 500+ 个标签，其中四成只挂在一条上 —— 全铺出来
 * 没人看得过来。取三层：内联只摊开最高频的 TAG_SHORTCUTS 个当快捷入口（零点击），
 * 其余全在「更多」弹层里（可搜可多选），卡片上的标签则提供浏览时的入口。
 */
const TAG_SHORTCUTS = 8;
/** 卡片上一次最多显示几个标签，超出的折成 +N。 */
const CARD_TAGS = 4;

export interface PromptGalleryModalProps {
  /** 套用：把正文填进调用方的输入框。 */
  onApply: (item: PromptItem) => void;
  onClose: () => void;
}

export function PromptGalleryModal({ onApply, onClose }: PromptGalleryModalProps) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const [keyword, setKeyword] = useState('');
  const [sourceId, setSourceId] = useState<string>(ALL_SOURCES);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagPanelOpen, setTagPanelOpen] = useState(false);
  const tagAnchorRef = useRef<HTMLDivElement | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // 打开即拉取。此前节点渲染时不会碰这些源（约 3.5MB）。
  const { items, isLoading, isRefreshing, failures, hasAnySuccess, offlineCount, refetch } =
    usePromptGallery(true);

  const detail = detailId ? items.find((item) => item.id === detailId) ?? null : null;

  // 从最上面那层开始吃 Esc：标签弹层 → 详情 → 整个弹窗。反过来会让用户
  // 只是想把弹层收起来，结果整个画廊关了。
  useEscapeToClose(true, () => {
    if (tagPanelOpen) setTagPanelOpen(false);
    else if (detailId) setDetailId(null);
    else onClose();
  });

  const availableSources = useMemo(() => collectPromptSources(items), [items]);
  // 全量标签（按频次降序）。内联只摊开前几个当快捷入口，其余都在弹层里。
  const tagStats = useMemo(() => collectPromptTags(items), [items]);
  const toggleTag = useCallback((tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((entry) => entry !== tag) : [...prev, tag],
    );
  }, []);
  const shortcuts = useMemo(
    // 已选中的不重复占位 —— 上面那颗已选 chip 就是它。
    () =>
      tagStats
        .slice(0, TAG_SHORTCUTS)
        .map((entry) => entry.tag)
        .filter((tag) => !selectedTags.includes(tag)),
    [tagStats, selectedTags],
  );
  const filtered = useMemo(
    () => filterPromptItems(items, { keyword, sourceId, tags: selectedTags }),
    [items, keyword, sourceId, selectedTags],
  );
  const visible = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount],
  );

  // 换筛选条件就回到第一页，否则「上一轮滚出来的 300 条」会跟着新条件带过来。
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [keyword, sourceId, selectedTags]);

  const copy = async (item: PromptItem) => {
    try {
      await navigator.clipboard.writeText(item.prompt);
      toast.success(t('canvas.promptGallery.copied'));
    } catch {
      // 非安全上下文 / 剪贴板被拒。让用户自己去详情页手选，不假装成功。
      toast.error(t('canvas.promptGallery.copyFailed'));
    }
  };

  const apply = (item: PromptItem) => {
    onApply(item);
    toast.success(t('canvas.promptGallery.applied'));
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/55"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`${MODAL_CLASS} ${LIST_SIZE_CLASS}`}
        role="dialog"
        aria-modal="true"
        aria-label={t('canvas.promptGallery.title')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {detail ? (
          <DetailPane
            item={detail}
            onBack={() => setDetailId(null)}
            onClose={onClose}
            onCopy={copy}
            onApply={apply}
          />
        ) : (
          <>
            <div className="flex shrink-0 items-center gap-2 px-4 pt-4 pr-12">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-muted" />
                <input
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder={t('canvas.promptGallery.search')}
                  aria-label={t('canvas.promptGallery.search')}
                  className="h-8 w-full rounded-[6px] border border-white/[0.10] bg-white/[0.04] pl-8 pr-3 text-sm text-text-dark placeholder:text-text-muted focus:border-white/[0.24] focus:outline-none"
                />
              </div>
              <button
                type="button"
                onClick={refetch}
                disabled={isRefreshing}
                title={t('canvas.promptGallery.refreshTitle')}
                aria-label={t('canvas.promptGallery.refresh')}
                className="flex size-8 shrink-0 items-center justify-center rounded-[6px] text-text-muted transition-colors hover:bg-white/[0.08] hover:text-text-dark disabled:opacity-50"
              >
                <RefreshCw className={`size-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
              </button>
              <button
                type="button"
                onClick={onClose}
                aria-label={t('common.close')}
                className="absolute right-4 top-4 flex size-7 items-center justify-center rounded-md text-text-muted/90 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
              >
                <X className="size-4" />
              </button>
            </div>

            <FilterRow
              label={t('canvas.promptGallery.sourceLabel')}
              options={[
                { key: ALL_SOURCES, label: t('canvas.promptGallery.allSources') },
                // 只列真有内容的源。清单里配了但一条都没解析出来的源不进筛选栏,
                // 免得点进去是一片空白 —— 那种源的信息在 failures 那行里。
                ...availableSources.map((id) => ({
                  key: id,
                  label: findPromptSource(id)?.name ?? id,
                })),
              ]}
              selected={sourceId}
              onSelect={setSourceId}
            />

            {tagStats.length > 0 ? (
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-[11px] font-medium uppercase tracking-widest text-text-muted">
                  {t('canvas.promptGallery.tagLabel')}
                </span>

                <div className="ui-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pb-0.5">
                  {/* 已选永远排最前且带 ✕：无论它是不是高频，选中态都得看得见、取消得掉。 */}
                  <AnimatePresence initial={false}>
                    {selectedTags.map((tag) => (
                      <motion.button
                        key={tag}
                        type="button"
                        layout={!reducedMotion}
                        initial={reducedMotion ? false : { opacity: 0, scale: 0.94 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={reducedMotion ? undefined : { opacity: 0, scale: 0.94 }}
                        transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
                        onClick={() => toggleTag(tag)}
                        aria-label={t('canvas.promptGallery.removeTagAria', { tag })}
                        className="flex h-7 shrink-0 items-center gap-1 rounded-[6px] bg-white/[0.14] px-2.5 text-xs font-medium text-text-dark"
                      >
                        {tag}
                        <X className="size-3 text-text-dark/45" />
                      </motion.button>
                    ))}
                  </AnimatePresence>

                  {selectedTags.length > 0 && shortcuts.length > 0 ? (
                    <span className="h-4 w-px shrink-0 bg-white/[0.14]" aria-hidden="true" />
                  ) : null}

                  {shortcuts.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => toggleTag(tag)}
                      className="h-7 shrink-0 rounded-[6px] px-2.5 text-xs font-medium text-text-dark/62 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
                    >
                      {tag}
                    </button>
                  ))}

                  <div className="shrink-0" ref={tagAnchorRef}>
                    <button
                      type="button"
                      onClick={() => setTagPanelOpen((value) => !value)}
                      aria-expanded={tagPanelOpen}
                      className={`flex h-7 shrink-0 items-center gap-1 rounded-[6px] px-2.5 text-xs font-medium transition-colors ${
                        tagPanelOpen
                          ? 'bg-white/[0.14] text-text-dark'
                          : 'text-cyan-100/70 hover:bg-white/[0.08] hover:text-cyan-100'
                      }`}
                    >
                      {t('canvas.promptGallery.moreTags')}
                      <ChevronDown
                        className={`size-3 transition-transform ${tagPanelOpen ? 'rotate-180' : ''}`}
                      />
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            <PromptTagPanel
              open={tagPanelOpen}
              onClose={() => setTagPanelOpen(false)}
              anchorRef={tagAnchorRef}
              tags={tagStats}
              selected={selectedTags}
              onToggle={toggleTag}
              onClear={() => setSelectedTags([])}
            />

            {/* 离线兜底：这些源用的是上次成功拉取的缓存，内容可能不是最新的。
                必须说出来 —— 否则用户会以为看到的就是当前上游的样子。 */}
            {offlineCount > 0 ? (
              <div className="flex shrink-0 items-center gap-2 px-4 pt-2 text-[11px] leading-5 text-sky-300/90">
                <WifiOff className="size-3 shrink-0" />
                <span>{t('canvas.promptGallery.offline', { n: offlineCount })}</span>
                <button
                  type="button"
                  onClick={refetch}
                  disabled={isRefreshing}
                  className="shrink-0 rounded border border-sky-300/30 px-1.5 py-0.5 font-medium transition-colors hover:bg-sky-300/10 disabled:opacity-50"
                >
                  {t('canvas.promptGallery.retryFetch')}
                </button>
              </div>
            ) : null}

            {failures.length > 0 ? (
              <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pt-2 text-[11px] leading-5 text-amber-300/85">
                <span>
                  {t('canvas.promptGallery.sourceFailed', { n: failures.length })}
                  {failures.map((failure) => ` · ${failure.sourceName}`).join('')}
                </span>
                {offlineCount === 0 ? (
                  <button
                    type="button"
                    onClick={refetch}
                    disabled={isRefreshing}
                    className="shrink-0 rounded border border-amber-300/30 px-1.5 py-0.5 font-medium transition-colors hover:bg-amber-300/10 disabled:opacity-50"
                  >
                    {t('canvas.promptGallery.retryFetch')}
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="mt-2 flex shrink-0 items-center justify-between px-4 pb-2 text-[11px] text-text-muted">
              <span>{t('canvas.promptGallery.resultCount', { n: filtered.length })}</span>
            </div>

            <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pb-4 [scrollbar-gutter:stable]">
              {isLoading ? (
                <div className="flex h-40 items-center justify-center text-xs text-text-muted">
                  {t('canvas.promptGallery.loading')}
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex h-40 items-center justify-center text-xs text-text-muted">
                  {hasAnySuccess
                    ? t('canvas.promptGallery.empty')
                    : t('canvas.promptGallery.allFailed')}
                </div>
              ) : (
                <>
                  {/* 瀑布流用 CSS columns。上游图片比例不一（GitHub/Twitter 附件），
                      固定比例的网格会把它们统一裁掉一截；columns 让每张按原比例站位。
                      代价是阅读顺序变成纵向的（先填满第一列），对画廊可以接受。 */}
                  <div className="columns-2 gap-3 sm:columns-3 xl:columns-4">
                    {visible.map((item) => (
                      <div key={item.id} className="mb-3 break-inside-avoid">
                        <PromptCard
                          item={item}
                          onOpen={() => setDetailId(item.id)}
                          onCopy={() => void copy(item)}
                          onTagClick={toggleTag}
                          activeTags={selectedTags}
                        />
                      </div>
                    ))}
                  </div>
                  {visible.length < filtered.length ? (
                    <div className="mt-4 flex justify-center">
                      <button
                        type="button"
                        onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
                        className="h-8 rounded-[6px] border border-white/[0.12] px-4 text-xs text-text-dark transition-colors hover:bg-white/[0.08]"
                      >
                        {t('canvas.promptGallery.loadMore', {
                          n: filtered.length - visible.length,
                        })}
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * 一行横向滚动的筛选 chips。目前只给「来源」用 —— 标签那行因为要放已选项、快捷项
 * 和弹层入口，结构不一样，单独写在主组件里。
 */
function FilterRow({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: Array<{ key: string; label: string }>;
  selected: string;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 px-4 pt-2">
      <span className="shrink-0 text-[11px] font-medium uppercase tracking-widest text-text-muted">
        {label}
      </span>
      <div className="ui-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pb-0.5">
        {options.map((option) => {
          const isActive = option.key === selected;
          return (
            <button
              key={option.key}
              type="button"
              onClick={() => onSelect(option.key)}
              className={`h-7 shrink-0 rounded-[6px] px-2.5 text-xs font-medium transition-colors ${
                isActive
                  ? 'bg-white/[0.14] text-text-dark'
                  : 'text-text-dark/62 hover:bg-white/[0.08] hover:text-text-dark'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 封面本体：只管画，不管交互。
 *
 * 交互留给调用方 —— 卡片那里封面正好包在一颗 button 里（点开详情），而 button
 * 里再放一颗「取图」按钮是非法结构。所以这里只按状态选外观，点谁由外层决定。
 */
function RemoteCover({
  src,
  alt,
  className,
  pending = false,
  loading = false,
  pendingLabel,
}: {
  src: string;
  alt: string;
  className: string;
  /** 大图源尚未取图：画占位块。取图失败时也走这里，靠 pendingLabel 说明。 */
  pending?: boolean;
  /** 正在取。 */
  loading?: boolean;
  pendingLabel?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (pending || !src || failedSrc === src) {
    // 占位块不跟随传入的 className：瀑布流下传进来的是 h-auto，没图撑高度
    // 会塌成一条线。固定一个 16:9 的框，和大多数上游图的比例一致。
    return (
      <div
        role="img"
        aria-label={alt}
        className="flex aspect-video w-full flex-col items-center justify-center gap-1.5 bg-white/[0.06] text-text-muted"
      >
        <ImageOff className={`size-4 ${loading ? 'animate-pulse' : ''}`} />
        {pendingLabel ? (
          <span className="px-2 text-center text-[11px] leading-tight">
            {pendingLabel}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      // 不让第三方 CDN 拿到用户当前地址与来源页。
      referrerPolicy="no-referrer"
      onError={() => setFailedSrc(src)}
      className={className}
    />
  );
}

/**
 * 封面 + 按需取图。
 *
 * 图已经取到 / 本来就是小图，就直接显示；否则画占位块并让外层点击去取。
 * `defer` 只在 `deferImage` 的源上打开（wuyoscar 那 442MB 原图）。
 */
function useCoverState(item: PromptItem) {
  const { t } = useTranslation();
  // 非 defer 源传空串，hook 整体 no-op，不会多探一次缓存。
  const deferred = useDeferredImage(item.deferImage ? item.coverUrl : '');
  const awaiting = Boolean(item.deferImage) && !deferred.src;
  const pendingLabel = deferred.isLoading
    ? t('canvas.promptGallery.loadingImage')
    : deferred.error
      ? t('canvas.promptGallery.loadImageFailed')
      : t('canvas.promptGallery.loadImage');
  return { deferred, awaiting, src: deferred.src || item.coverUrl, pendingLabel };
}

function PromptCard({
  item,
  onOpen,
  onCopy,
  onTagClick,
  activeTags,
}: {
  item: PromptItem;
  onOpen: () => void;
  onCopy: () => void;
  /** 点卡片上的标签即按它筛 —— 浏览时看到什么筛什么。 */
  onTagClick: (tag: string) => void;
  activeTags: string[];
}) {
  const { t } = useTranslation();
  const { deferred, awaiting, src, pendingLabel } = useCoverState(item);
  // 图还没取到时，封面这颗按钮的职责是「取图」而不是「进详情」。一颗按钮两种
  // 职责，而不是在 button 里再塞一颗 —— 那是非法结构。
  const coverLabel = awaiting
    ? t('canvas.promptGallery.loadImageAria', { title: item.title })
    : t('canvas.promptGallery.detailAria', { title: item.title });
  const shown = item.tags.slice(0, CARD_TAGS);
  const overflow = item.tags.length - shown.length;

  return (
    <div className="group relative overflow-hidden rounded-[12px] border border-white/[0.10] bg-white/[0.04] shadow-[0_14px_34px_rgba(0,0,0,0.22)] transition-[border-color,box-shadow] duration-300 ease-out hover:border-cyan-100/40 hover:shadow-[0_20px_44px_rgba(0,0,0,0.34),0_0_24px_rgba(103,232,249,0.08)] focus-within:border-cyan-100/40">
      {/* 封面区。渐变遮罩只盖这一块 —— 下面的标签条要看得清。 */}
      <div className="relative">
        <button
          type="button"
          onClick={awaiting ? deferred.load : onOpen}
          aria-label={coverLabel}
          className="block w-full cursor-pointer text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[rgb(var(--accent-rgb))]"
        >
          <RemoteCover
            src={src}
            alt={item.title}
            className="block h-auto w-full"
            pending={awaiting}
            loading={deferred.isLoading}
            pendingLabel={awaiting ? pendingLabel : undefined}
          />
        </button>
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/88 via-black/30 to-transparent" />
        {item.mediaKind === 'video' ? (
          <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white/90">
            {t('canvas.promptGallery.videoBadge')}
          </span>
        ) : null}
        <div className="pointer-events-none absolute bottom-2.5 left-3 right-14 truncate text-xs font-medium text-white/92">
          {item.title}
        </div>
        {/* 常驻可见而不是 hover 才出：opacity-0 没有 focus 变体时，键盘 Tab
            聚焦上去按钮照样透明，这个入口对键盘用户等于不存在。 */}
        <button
          type="button"
          onClick={onCopy}
          aria-label={t('canvas.promptGallery.copyAria', { title: item.title })}
          className="absolute bottom-2 right-2 h-6 rounded-[6px] bg-white/[0.16] px-2 text-[11px] font-medium text-white transition-colors hover:bg-white/[0.28] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--accent-rgb))]"
        >
          {t('canvas.promptGallery.copy')}
        </button>
      </div>

      {shown.length > 0 ? (
        <div className="flex flex-wrap gap-1 px-2.5 pb-2.5 pt-2">
          {shown.map((tag) => {
            const active = activeTags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                onClick={() => onTagClick(tag)}
                aria-pressed={active}
                className={`max-w-full truncate rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                  active
                    ? 'bg-cyan-200/85 text-black'
                    : 'bg-white/[0.08] text-text-dark/70 hover:bg-white/[0.16] hover:text-text-dark'
                }`}
              >
                {tag}
              </button>
            );
          })}
          {overflow > 0 ? (
            <span className="rounded px-1 py-0.5 text-[10px] text-text-muted">+{overflow}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DetailPane({
  item,
  onBack,
  onClose,
  onCopy,
  onApply,
}: {
  item: PromptItem;
  onBack: () => void;
  onClose: () => void;
  onCopy: (item: PromptItem) => Promise<void>;
  onApply: (item: PromptItem) => void;
}) {
  const { t } = useTranslation();
  const source = findPromptSource(item.sourceId);
  const { deferred, awaiting, src, pendingLabel } = useCoverState(item);
  // 首图用 src 而不是 item.coverUrl：defer 源取到图后 src 是本地 object URL。
  const images = [src, ...item.referenceImageUrls].filter(
    (url, index, all) => url && all.indexOf(url) === index,
  );

  return (
    <>
      <div className="flex h-12 shrink-0 items-center justify-between px-4">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            aria-label={t('common.back')}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-text-muted/90 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
          >
            <ArrowLeft className="size-4" />
          </button>
          <span className="truncate text-sm font-medium text-text-dark">{item.title}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-text-muted/90 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden p-4 pt-0">
        <div className="ui-scrollbar grid min-h-0 flex-1 content-start gap-2 overflow-y-auto">
          {awaiting ? (
            // 详情区的容器是 div 不是 button，这里放按钮是合法结构。
            <button
              type="button"
              onClick={deferred.load}
              aria-label={t('canvas.promptGallery.loadImageAria', { title: item.title })}
              className="block w-full cursor-pointer rounded-[8px] border border-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--accent-rgb))]"
            >
              <RemoteCover
                src=""
                alt={item.title}
                className="w-full"
                pending
                loading={deferred.isLoading}
                pendingLabel={pendingLabel}
              />
            </button>
          ) : images.length > 0 ? (
            images.map((url) => (
              <RemoteCover
                key={url}
                src={url}
                alt={item.title}
                className="w-full rounded-[8px] border border-white/[0.08] object-contain"
              />
            ))
          ) : (
            <div className="flex h-40 items-center justify-center rounded-[8px] border border-white/[0.08] bg-white/[0.03] text-xs text-text-muted">
              {t('canvas.promptGallery.noCover')}
            </div>
          )}
        </div>

        <div className="flex w-[360px] shrink-0 flex-col gap-3">
          {item.description ? (
            <p className="ui-scrollbar max-h-20 shrink-0 overflow-y-auto text-xs leading-relaxed text-text-dark/72">
              {item.description}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-1.5">
            {item.tags.map((entry) => (
              <span
                key={entry}
                className="rounded bg-white/[0.08] px-1.5 py-0.5 text-[10px] text-text-dark/80"
              >
                {entry}
              </span>
            ))}
          </div>

          <textarea
            readOnly
            value={item.prompt}
            aria-label={t('canvas.promptGallery.promptLabel')}
            className="ui-scrollbar min-h-0 flex-1 resize-none rounded-[8px] border border-white/[0.08] bg-white/[0.03] p-3 text-xs leading-relaxed text-text-dark/85 focus:outline-none"
          />

          <div className="shrink-0 space-y-2">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void onCopy(item)}
                className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[6px] border border-white/[0.14] text-sm font-medium text-text-dark transition-colors hover:bg-white/[0.08]"
              >
                <Copy className="size-3.5" />
                {t('canvas.promptGallery.copy')}
              </button>
              <button
                type="button"
                onClick={() => onApply(item)}
                className="h-8 flex-1 rounded-[6px] bg-white/[0.92] text-sm font-medium text-black transition-colors hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--accent-rgb))]"
              >
                {t('canvas.promptGallery.apply')}
              </button>
            </div>

            {/* 出处与许可是 CC BY 系的硬要求，不是装饰。 */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-text-muted">
              <span>{item.sourceName}</span>
              {source ? <span>· {source.license}</span> : null}
              {item.author ? (
                <span>{t('canvas.promptGallery.byAuthor', { author: item.author })}</span>
              ) : null}
              {item.sourceUrl ? (
                <a
                  href={item.sourceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-0.5 text-text-dark/70 underline decoration-white/20 underline-offset-2 hover:text-text-dark"
                >
                  {t('canvas.promptGallery.origin')}
                  <ExternalLink className="size-2.5" />
                </a>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
