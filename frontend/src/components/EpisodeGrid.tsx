/**
 * The episode grid, shared by the info page and the watch page.
 *
 * One page of episodes at a time (100, fetched in Kitsu-sized chunks), packed
 * left-to-right, at most three rows tall with a themed scrollbar. Episodes
 * that have not aired yet are never listed — currently airing shows get a
 * card with the next episode's air time instead.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { getEpisodePage, type EpisodeEntry } from '../lib/anime';

const PAGE_SIZE = 100;
/** Kitsu serves 20 per request; 5 of those fill a page. */
const REQUESTS_PER_PAGE = 5;
/** Narrowest a chip may get; the grid stretches the columns to fill the row. */
const CHIP_MIN_PX = 64;

/** Tooltip for an episode that has not aired yet. */
const airDateLabel = (value?: string) => {
  if (!value) return null;
  const when = new Date(value);
  return Number.isNaN(when.getTime())
    ? null
    : `Airs ${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
};

export const NextEpisodeCard = ({
  nextEpisode,
}: {
  nextEpisode: { number: number; airsAt: number } | null | undefined;
}) => {
  if (!nextEpisode) return null;

  const when = new Date(nextEpisode.airsAt);
  if (Number.isNaN(when.getTime())) return null;

  const absolute = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(when);

  const hours = Math.max(0, Math.round((when.getTime() - Date.now()) / 3_600_000));
  const relative =
    hours < 1 ? 'airing now' : hours < 48 ? `in ${hours} hour${hours === 1 ? '' : 's'}` : `in ${Math.round(hours / 24)} days`;

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-twist-800 bg-twist-800/40 px-3 py-2.5">
      <span className="font-body text-xs text-gray-200">
        Episode {nextEpisode.number} airs{' '}
        <span className="font-bold text-twist-red">{absolute}</span>
      </span>
      <span className="font-body text-[11px] text-twist-lightgray">
        {relative} · your local time
      </span>
    </div>
  );
};

const pageNumbers = (page: number, pages: number): (number | '…')[] => {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1);
  const window = new Set<number>([1, pages, page, page - 1, page + 1]);
  const sorted = [...window].filter((value) => value >= 1 && value <= pages).sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  let previous = 0;
  for (const value of sorted) {
    if (previous && value - previous > 1) out.push('…');
    out.push(value);
    previous = value;
  }
  return out;
};

export const EpisodeGrid = ({
  slug,
  total,
  nextEpisode,
  completed,
  current,
  focus: initialFocus,
  onSelect,
}: {
  slug: string;
  total?: number | null;
  /** Next episode to air (from the title's detail) — later episodes show disabled. */
  nextEpisode?: number | null;
  completed: Set<number>;
  /** Present on the watch page: highlighted with a play icon. */
  current?: number;
  /** Episode the pager should open on (the last watched one). */
  focus?: number;
  /** When given, chips call it; otherwise they link to the watch page. */
  onSelect?: (episode: number) => void;
}) => {
  const pageOf = (episode?: number) =>
    episode && episode > 0 ? Math.max(1, Math.ceil(episode / PAGE_SIZE)) : 1;

  const [focus, setFocus] = useState<number | undefined>(initialFocus);
  const [page, setPage] = useState(() => pageOf(initialFocus));
  const [find, setFind] = useState('');
  const [state, setState] = useState<{
    key: string;
    items: EpisodeEntry[];
    total: number | null;
    /** Load time, so air dates are compared without reading the clock in render. */
    now: number;
  } | null>(null);

  // Re-focus (and re-page) when the episode being watched changes, without an
  // effect: React's documented "adjust state during render" pattern.
  if (initialFocus !== focus) {
    setFocus(initialFocus);
    setPage(pageOf(initialFocus));
  }

  const key = `${slug}:${page}`;
  const loading = state?.key !== key;

  useEffect(() => {
    let active = true;
    const offset = (page - 1) * PAGE_SIZE;

    getEpisodePage(slug, offset, REQUESTS_PER_PAGE)
      .then((result) => {
        if (!active) return;
        // Unaired episodes stay listed (disabled) so the upcoming ones are visible.
        setState({
          key: `${slug}:${page}`,
          items: result.items,
          total: result.total ?? total ?? null,
          now: Date.now(),
        });
      })
      .catch(() => {
        if (active) setState({ key: `${slug}:${page}`, items: [], total: total ?? null, now: Date.now() });
      });

    return () => {
      active = false;
    };
  }, [slug, page, total]);

  const items = state?.key === key ? state.items : [];
  const now = state?.key === key ? state.now : 0;

  // The planned total (from the title's detail) beats what the provider lists,
  // so an airing title still shows its unaired tail on the page.
  const totals = [state?.key === key ? state.total : null, total ?? null].filter(
    (value): value is number => typeof value === 'number' && value > 0
  );
  const known = totals.length > 0 ? Math.max(...totals) : null;
  const pages = known ? Math.max(1, Math.ceil(known / PAGE_SIZE)) : 1;

  const byNumber = new Map(items.map((entry) => [entry.number, entry]));
  const nextEpisodeNumber = nextEpisode && nextEpisode > 0 ? nextEpisode : null;

  // When the next episode is known, draw the whole page range so the unaired
  // ones appear (disabled) instead of being absent; otherwise draw what we got.
  const numbers: number[] = [];
  if (nextEpisodeNumber && known) {
    const last = Math.min(page * PAGE_SIZE, known);
    for (let number = (page - 1) * PAGE_SIZE + 1; number <= last; number += 1) numbers.push(number);
  } else {
    for (const entry of items) numbers.push(entry.number);
  }

  const isAired = (number: number, entry?: EpisodeEntry) => {
    if (nextEpisodeNumber != null && number >= nextEpisodeNumber) return false;
    if (!entry?.airedAt) return true;
    return Date.parse(entry.airedAt) <= now;
  };

  // A numeric search jumps to that episode's page; text filters titles.
  const numeric = Number(find.trim());
  const searchingText = find.trim() !== '' && !Number.isInteger(numeric);
  const visible = searchingText
    ? numbers.filter((number) =>
        `${number} ${byNumber.get(number)?.title ?? ''}`
          .toLowerCase()
          .includes(find.trim().toLowerCase())
      )
    : numbers;

  const onFindChange = (value: string) => {
    setFind(value);
    const number = Number(value.trim());
    if (Number.isInteger(number) && number >= 1) setPage(Math.max(1, Math.ceil(number / PAGE_SIZE)));
  };

  const boxRef = useRef<HTMLDivElement>(null);

  // Bring the found / focused episode into view once its page has loaded.
  useEffect(() => {
    const target = Number.isInteger(numeric) && numeric >= 1 ? numeric : focus;
    if (!target || state?.key !== key) return;
    boxRef.current
      ?.querySelector(`[data-episode="${target}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [focus, key, numeric, state]);

  return (
    <div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="font-body text-[11px] text-twist-lightgray">
          {known ? `${known} episodes` : 'Episodes'}
        </span>
        <label className="relative">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-twist-lightgray"
          >
            <circle cx="11" cy="11" r="7" />
            <path strokeLinecap="round" d="m20 20-3.5-3.5" />
          </svg>
          <input
            value={find}
            onChange={(event) => onFindChange(event.target.value)}
            placeholder="Find episode…"
            aria-label="Find episode"
            className="h-8 w-40 rounded bg-twist-800 pl-7 pr-2 font-body text-xs text-gray-200 placeholder-twist-lightgray border border-transparent transition duration-200 focus:border-twist-red focus:outline-none"
          />
        </label>
      </div>

      <div className="mt-2 w-full">
        <div
          ref={boxRef}
          className="episode-scroll grid max-h-[124px] content-start gap-2 overflow-y-auto"
          style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${CHIP_MIN_PX}px, 1fr))` }}
        >
          {loading && items.length === 0
            ? Array.from({ length: 12 }, (_, index) => (
                <div key={index} className="h-9 w-full animate-pulse rounded bg-twist-800" />
              ))
            : visible.map((number) => {
                const entry = byNumber.get(number);
                const label = entry?.title ?? `Episode ${number}`;

                // Not aired yet: a dashed, dimmed chip that cannot be opened.
                if (!isAired(number, entry)) {
                  return (
                    <span
                      key={number}
                      data-episode={number}
                      aria-disabled="true"
                      title={airDateLabel(entry?.airedAt) ?? `Episode ${number} · not aired yet`}
                      className="flex h-9 w-full cursor-not-allowed items-center justify-center rounded border border-dashed border-twist-700/70 bg-twist-800/40"
                    >
                      <span className="font-body text-xs text-twist-lightgray">{number}</span>
                    </span>
                  );
                }

                const done = completed.has(number);
                const isCurrent = number === current;
                const chip = (
                  <span
                    className={`flex h-9 w-full items-center justify-center rounded border transition duration-200 ease-in-out hover:border-twist-gray ${
                      done
                        ? 'border-twist-red bg-twist-red/10'
                        : isCurrent
                          ? 'border-twist-gray bg-twist-800'
                          : 'border-transparent bg-twist-800'
                    }`}
                  >
                    <span
                      className={`font-body text-xs ${done ? 'text-twist-red' : 'text-twist-white'}`}
                    >
                      {isCurrent ? (
                        <svg viewBox="0 0 24 24" className="h-5 w-5" aria-label="Now playing">
                          <path d="M8 5v14l11-7z" fill="currentColor" />
                        </svg>
                      ) : (
                        number
                      )}
                    </span>
                  </span>
                );

                return onSelect ? (
                  <button
                    key={number}
                    type="button"
                    data-episode={number}
                    onClick={() => onSelect(number)}
                    title={label}
                  >
                    {chip}
                  </button>
                ) : (
                  <Link
                    key={number}
                    href={`/${slug}/watch/${number}`}
                    data-episode={number}
                    title={label}
                  >
                    {chip}
                  </Link>
                );
              })}
        </div>
      </div>

      {searchingText && visible.length === 0 && (
        <p className="mt-2 font-body text-[11px] text-twist-lightgray">
          No episode on this page matches “{find.trim()}”.
        </p>
      )}

      {pages > 1 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={page === 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
            className="h-7 rounded bg-twist-800 px-2 font-body text-[11px] text-gray-300 transition duration-200 hover:border-twist-gray disabled:cursor-not-allowed disabled:opacity-40"
          >
            ‹ Prev
          </button>
          {pageNumbers(page, pages).map((value, index) =>
            value === '…' ? (
              <span key={`gap-${index}`} className="px-1 font-body text-[11px] text-twist-lightgray">
                …
              </span>
            ) : (
              <button
                key={value}
                type="button"
                onClick={() => setPage(value)}
                aria-current={value === page ? 'page' : undefined}
                className={`h-7 min-w-7 rounded px-1.5 font-body text-[11px] transition duration-200 ${
                  value === page
                    ? 'bg-twist-red text-gray-100'
                    : 'bg-twist-800 text-twist-lightgray hover:border-twist-gray hover:text-gray-200'
                }`}
              >
                {value}
              </button>
            )
          )}
          <button
            type="button"
            disabled={page === pages}
            onClick={() => setPage((value) => Math.min(pages, value + 1))}
            className="h-7 rounded bg-twist-800 px-2 font-body text-[11px] text-gray-300 transition duration-200 hover:border-twist-gray disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next ›
          </button>
        </div>
      )}
    </div>
  );
};
