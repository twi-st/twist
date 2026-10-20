import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { getCardBySlug, type SlugCard } from '../lib/anime';
import { useStore } from '../lib/store';
import { useSlugPosters } from '../lib/useSlugPosters';
import { Artwork } from './Artwork';

/**
 * "Continue watching" on the home page: a horizontal shelf of the episodes the
 * viewer left part-way through, newest first.
 *
 * It is a slideshow in the sense that matters here — one row you can page
 * through, with arrows and scroll-snap — rather than an auto-advancing banner:
 * the shelf is a list of things to resume, and moving on its own would take the
 * choice away from the reader.
 */
const CARD_WIDTH = 208;

export const ContinueWatching = () => {
  const { progress, settings } = useStore();
  const scroller = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  // One entry per title: the most recently watched unfinished episode.
  const recent = (() => {
    const bySlug = new Map<string, (typeof progress)[number]>();
    for (const entry of progress) {
      if (entry.completed) continue;
      const current = bySlug.get(entry.slug);
      if (!current || entry.updatedAt > current.updatedAt) bySlug.set(entry.slug, entry);
    }
    return [...bySlug.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
  })();

  const posters = useSlugPosters(recent.map((entry) => entry.slug));
  const titles = useSlugTitles(recent.map((entry) => entry.slug), settings.titleLanguage);

  const updateArrows = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    setCanLeft(node.scrollLeft > 4);
    setCanRight(node.scrollLeft + node.clientWidth < node.scrollWidth - 4);
  }, []);

  useEffect(() => {
    updateArrows();
    const node = scroller.current;
    if (!node) return;
    node.addEventListener('scroll', updateArrows, { passive: true });
    window.addEventListener('resize', updateArrows);
    return () => {
      node.removeEventListener('scroll', updateArrows);
      window.removeEventListener('resize', updateArrows);
    };
  }, [updateArrows, recent.length]);

  const page = (direction: 1 | -1) => {
    const node = scroller.current;
    if (!node) return;
    node.scrollBy({ left: direction * node.clientWidth * 0.85, behavior: 'smooth' });
  };

  if (recent.length === 0) return null;

  return (
    <section className="relative mt-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-body text-xs font-bold uppercase tracking-wide text-twist-red">
          Continue watching
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => page(-1)}
            disabled={!canLeft}
            aria-label="Previous"
            className="flex h-6 w-6 items-center justify-center rounded bg-twist-800 text-twist-lightgray transition duration-200 hover:text-gray-100 disabled:opacity-30"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => page(1)}
            disabled={!canRight}
            aria-label="Next"
            className="flex h-6 w-6 items-center justify-center rounded bg-twist-800 text-twist-lightgray transition duration-200 hover:text-gray-100 disabled:opacity-30"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>

      <div
        ref={scroller}
        className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {recent.map((entry) => {
          const percent = Math.min(
            100,
            Math.round((entry.currentTime / Math.max(entry.duration, 1)) * 100)
          );
          return (
            <Link
              key={`${entry.slug}-${entry.episode}`}
              href={`/${entry.slug}/watch/${entry.episode}`}
              style={{ width: CARD_WIDTH }}
              className="group shrink-0 snap-start overflow-hidden rounded-lg border border-twist-800 bg-twist-800/40 transition duration-200 hover:border-twist-gray"
            >
              <div className="relative aspect-video w-full overflow-hidden bg-twist-900">
                <Artwork
                  sources={[posters[entry.slug]]}
                  alt=""
                  className="absolute inset-0 h-full w-full opacity-85 transition duration-200 group-hover:opacity-100"
                />
                <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1.5 py-0.5 font-body text-[10px] tabular-nums text-white">
                  EP {entry.episode}
                </span>
                <span className="absolute inset-x-0 bottom-0 h-0.5 bg-white/25">
                  <span className="block h-full bg-twist-red" style={{ width: `${percent}%` }} />
                </span>
              </div>
              <div className="p-2">
                <span className="block truncate font-body text-xs text-gray-300 transition-colors duration-200 group-hover:text-gray-100">
                  {titles[entry.slug] ?? entry.slug.replace(/-/g, ' ')}
                </span>
                <span className="mt-0.5 block font-body text-[10px] tabular-nums text-twist-lightgray">
                  {percent}% watched · resume
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
};

/**
 * Real titles for stored slugs. The shelf renders with the slug text first and
 * swaps in the catalogue's title when it resolves, so it never blocks the page.
 */
const useSlugTitles = (slugs: string[], language: string) => {
  const key = slugs.join(',');
  const [titles, setTitles] = useState<Record<string, string>>({});

  useEffect(() => {
    const list = key ? key.split(',') : [];
    if (list.length === 0) return;
    let active = true;
    void Promise.all(
      list.map(async (slug) => [slug, await getCardBySlug(slug)] as const)
    ).then((entries) => {
      if (!active) return;
      setTitles((prev) => {
        const next = { ...prev };
        for (const [slug, card] of entries) {
          if (card) next[slug] = titleOfCard(card, language);
        }
        return next;
      });
    });
    return () => {
      active = false;
    };
  }, [key, language]);

  return titles;
};

const titleOfCard = (card: SlugCard, language: string) =>
  language === 'english' ? card.english || card.title : card.title;
