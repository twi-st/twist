import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import {
  AUDIO_OPTIONS,
  EMPTY_BROWSE,
  FORMAT_OPTIONS,
  ORIGIN_OPTIONS,
  SEASON_OPTIONS,
  SORT_OPTIONS,
  STATUS_OPTIONS,
  browseAnime,
  genreOptions,
  getAnimeDetail,
  tagOptions,
  yearOptions,
  type AnimeCard,
  type BrowseQuery,
  type OptionGroup,
} from '../lib/anime';
import { useStore } from '../lib/store';
import { readBrowseParams } from '../lib/browse';
import { Shell } from './Shell';
import { ContinueWatching } from './ContinueWatching';
import { Artwork } from './Artwork';

/** Kitsu caps page[limit] at 20. */
const PAGE_SIZE = 20;
/** Pause after the last keystroke before hitting the providers. */
const SEARCH_DEBOUNCE_MS = 400;

const FilterSelect = ({
  label,
  value,
  options,
  onChange,
  anyLabel,
}: {
  label: string;
  value: string;
  options: OptionGroup[];
  onChange: (value: string) => void;
  anyLabel?: string;
}) => (
  <label className="flex min-w-0 flex-col gap-1">
    <span className="font-body text-[10px] font-bold uppercase tracking-wide text-twist-lightgray">
      {label}
    </span>
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="min-w-0 rounded border border-twist-700 bg-twist-900 px-2 py-1.5 font-body text-xs text-gray-200 transition duration-200 focus:border-twist-red focus:outline-none"
    >
      {anyLabel !== undefined && <option value="">{anyLabel}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  </label>
);

const FilterInput = ({
  label,
  value,
  placeholder,
  listId,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  listId?: string;
  onChange: (value: string) => void;
}) => (
  <label className="flex min-w-0 flex-col gap-1">
    <span className="font-body text-[10px] font-bold uppercase tracking-wide text-twist-lightgray">
      {label}
    </span>
    <input
      value={value}
      list={listId}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className="min-w-0 rounded border border-twist-700 bg-twist-900 px-2 py-1.5 font-body text-xs text-gray-200 placeholder-twist-lightgray transition duration-200 focus:border-twist-red focus:outline-none"
    />
  </label>
);

/** Real poster with a graceful fallback while it loads / when missing. */
/** Cover art, trying every provider URL before drawing the app mark. */
const Poster = ({ card, className }: { card: AnimeCard; className: string }) => (
  <Artwork
    sources={[card.poster, ...(card.posters ?? [])]}
    alt={card.title}
    className={className}
  />
);

/** "24 eps", or "2/24 eps" while a title is still airing (aired/total). */
const episodesLabel = (card: AnimeCard) => {
  if (!card.episodes) return null;
  if (card.airedEpisodes != null && card.airedEpisodes < card.episodes) {
    return `${card.airedEpisodes}/${card.episodes} eps`;
  }
  return `${card.episodes} eps`;
};



const SkeletonCard = () => (
  <div className="overflow-hidden rounded-lg border border-twist-800 bg-twist-800/40">
    <div className="aspect-[3/4] w-full animate-pulse bg-twist-800" />
    <div className="space-y-2 p-2.5">
      <div className="h-3 w-3/4 animate-pulse rounded bg-twist-800" />
      <div className="h-2.5 w-1/2 animate-pulse rounded bg-twist-800" />
    </div>
  </div>
);

export const MainPage = () => {
  const { settings, updateSettings } = useStore();
  const viewMode = settings.viewMode;
  /** Titles follow the Romaji/English preference. */
  const pick = (card: AnimeCard) =>
    settings.titleLanguage === 'english' ? card.english || card.title : card.title;

  const [searchTerm, setSearchTerm] = useState('');
  const [filters, setFilters] = useState<BrowseQuery>(EMPTY_BROWSE);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // The list is a single snapshot keyed by the query it belongs to, so
  // "loading" and "error" are derived instead of stored (and no effect has to
  // poke state synchronously).
  const [browse, setBrowse] = useState<{
    key: string;
    items: AnimeCard[];
    next: number | null;
    total: number | null;
  } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** True when several auto-loads in a row brought nothing new (sparse filters). */
  const [stalledKey, setStalledKey] = useState<string | null>(null);
  const hollowLoads = useRef(0);
  const [retryToken, setRetryToken] = useState(0);
  const urlReady = useRef(false);

  const [hovered, setHovered] = useState<AnimeCard | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const cursor = useRef({ x: 0, y: 0 });
  const sentinelRef = useRef<HTMLDivElement>(null);
  /** Warm the info page while the card is hovered, so clicking is instant. */
  const prefetchTimer = useRef<number | undefined>(undefined);

  const [genreChoices, setGenreChoices] = useState<OptionGroup[]>([]);
  const [tagChoices, setTagChoices] = useState<OptionGroup[]>([]);
  const years = useMemo(() => yearOptions(), []);

  // A genre arriving from a link may not be in the (popular-only) option
  // list — keep it selectable instead of silently showing "Any".
  const genreSelectOptions = useMemo(() => {
    if (filters.genre && !genreChoices.some((option) => option.value === filters.genre)) {
      return [{ value: filters.genre, label: filters.genre.replace(/-/g, ' ') }, ...genreChoices];
    }
    return genreChoices;
  }, [filters.genre, genreChoices]);

  // Real filter options from the providers (cached in the data layer).
  useEffect(() => {
    let active = true;
    genreOptions()
      .then((options) => active && setGenreChoices(options))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  // The tag list is only needed once the panel is opened.
  useEffect(() => {
    if (!advancedOpen) return;
    let active = true;
    tagOptions()
      .then((options) => active && setTagChoices(options))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [advancedOpen]);

  // Links from elsewhere, the title bar and the back button all put the query
  // in the URL; the list follows it rather than keeping a second copy.
  /* eslint-disable react-hooks/set-state-in-effect -- one-shot sync with the URL */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initial = readBrowseParams(params);

    urlReady.current = true;
    if (JSON.stringify(initial) === JSON.stringify(EMPTY_BROWSE)) return;

    setSearchTerm(initial.query);
    setFilters(initial);
    setAdvancedOpen(
      Boolean(
        initial.genre ||
          initial.tag ||
          initial.studio ||
          initial.character ||
          initial.staff ||
          initial.origin ||
          initial.year ||
          initial.season ||
          initial.format ||
          initial.status ||
          initial.audio
      )
    );
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // The title bar navigates with a new query string while this page stays
  // mounted: adopt it so the list actually changes.
  useEffect(() => {
    const onPop = () => {
      if (window.location.pathname !== '/') return;
      const next = readBrowseParams(new URLSearchParams(window.location.search));
      setSearchTerm(next.query);
      setFilters(next);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // The filters live in the address bar, so a filtered view can be shared.
  useEffect(() => {
    if (!urlReady.current) return;

    const id = window.setTimeout(() => {
      const params = new URLSearchParams();
      const set = (key: string, value: string) => {
        if (value) params.set(key, value);
      };
      set('q', searchTerm.trim());
      set('genre', filters.genre);
      set('tags', filters.tag);
      set('year', filters.year);
      set('season', filters.season);
      set('format', filters.format);
      set('status', filters.status);
      set('studio', filters.studio);
      set('character', filters.character);
      set('staff', filters.staff);
      set('origin', filters.origin);
      set('audio', filters.audio);
      if (filters.sort !== EMPTY_BROWSE.sort) params.set('sort', filters.sort);

      const query = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    }, 500);

    return () => window.clearTimeout(id);
  }, [filters, searchTerm]);

  const activeCount = Object.entries(filters).filter(
    ([key, value]) => key !== 'sort' && key !== 'query' && value
  ).length;

  const setFilter = (key: keyof BrowseQuery) => (value: string) =>
    setFilters((prev) => ({ ...prev, [key]: value }));

  // Debounced search term — the rest of the panel applies immediately.
  const [debouncedTerm, setDebouncedTerm] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedTerm(searchTerm.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchTerm]);

  const activeQuery = useMemo<BrowseQuery>(
    () => ({ ...filters, query: debouncedTerm }),
    [filters, debouncedTerm]
  );

  /** Identifies the snapshot the visible list belongs to. */
  const queryKey = useMemo(
    () => `${JSON.stringify(activeQuery)}#${retryToken}`,
    [activeQuery, retryToken]
  );

  // First page whenever the query changes.
  useEffect(() => {
    let active = true;
    hollowLoads.current = 0;

    browseAnime(activeQuery, 0, PAGE_SIZE)
      .then((page) => {
        if (!active) return;
        setFailedKey(null);
        setBrowse({ key: queryKey, items: page.items, next: page.next, total: page.total });
      })
      .catch(() => {
        if (!active) return;
        setFailedKey(queryKey);
      });

    return () => {
      active = false;
    };
  }, [activeQuery, queryKey]);

  const current = browse?.key === queryKey ? browse : null;
  const items = current?.items ?? [];
  const nextOffset = current?.next ?? null;
  const total = current?.total ?? null;
  const error = failedKey === queryKey ? 'Could not load titles — check your connection and try again.' : null;
  const loading = current === null && error === null;
  const stalled = stalledKey === queryKey;

  const loadMore = useCallback(async () => {
    if (!current || current.next === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await browseAnime(activeQuery, current.next, PAGE_SIZE);
      let fresh = 0;
      setBrowse((prev) => {
        if (!prev || prev.key !== queryKey) return prev;
        const known = new Set(prev.items.map((card) => card.ref));
        const added = page.items.filter((card) => !known.has(card.ref));
        fresh = added.length;
        return { ...prev, items: [...prev.items, ...added], next: page.next, total: page.total };
      });

      // Sparse filters can walk several pages with nothing to show — stop
      // auto-loading and let the reader ask for more.
      hollowLoads.current = fresh === 0 ? hollowLoads.current + 1 : 0;
      setStalledKey(hollowLoads.current >= 3 ? queryKey : null);
    } catch {
      /* keep what we have; the sentinel retries on the next scroll */
    } finally {
      setLoadingMore(false);
    }
  }, [activeQuery, current, loadingMore, queryKey]);

  const loadMoreRef = useRef(loadMore);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  }, [loadMore]);

  // Infinite scroll — both view modes use the same sentinel.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || nextOffset === null || stalled) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMoreRef.current();
      },
      { rootMargin: '600px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [nextOffset, stalled]);

  // The hover card is fixed and positioned imperatively so mouse moves do
  // not re-render the list.
  const placeCard = useCallback(() => {
    const card = cardRef.current;
    if (!card) return;

    const width = card.offsetWidth;
    const height = card.offsetHeight;

    let left = cursor.current.x + 16;
    if (left + width > window.innerWidth - 12) left = cursor.current.x - width - 16;
    left = Math.max(12, Math.min(left, window.innerWidth - width - 12));

    let top = cursor.current.y + 18;
    if (top + height > window.innerHeight - 12) top = cursor.current.y - height - 18;
    top = Math.max(12, Math.min(top, window.innerHeight - height - 12));

    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }, []);

  useLayoutEffect(() => {
    if (hovered) placeCard();
  }, [hovered, placeCard]);

  // Hide the card when anything scrolls.
  useEffect(() => {
    const hide = () => setHovered(null);
    document.addEventListener('scroll', hide, true);
    return () => document.removeEventListener('scroll', hide, true);
  }, []);

  const hoverProps = (card: AnimeCard) => ({
    onMouseEnter: (event: React.MouseEvent) => {
      cursor.current = { x: event.clientX, y: event.clientY };
      setHovered(card);

      window.clearTimeout(prefetchTimer.current);
      prefetchTimer.current = window.setTimeout(() => {
        void getAnimeDetail(card.ref).catch(() => undefined);
      }, 250);
    },
    onMouseMove: (event: React.MouseEvent) => {
      cursor.current = { x: event.clientX, y: event.clientY };
      placeCard();
    },
    onMouseLeave: () => {
      window.clearTimeout(prefetchTimer.current);
      setHovered(null);
    },
  });

  const viewButton = (mode: 'list' | 'cards') =>
    `flex h-7 w-7 items-center justify-center rounded border transition duration-200 ${
      viewMode === mode
        ? 'border-twist-red bg-twist-red/10 text-twist-red'
        : 'border-transparent bg-twist-800 text-twist-lightgray hover:border-twist-gray hover:text-gray-200'
    }`;

  return (
    <Shell>
      <div className="content-column mx-auto w-full px-4 py-2">
        <form onSubmit={(e) => e.preventDefault()}>
          {settings.homeSearch && (
            <div className="relative mt-8">
              <input
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="SEARCH"
                aria-label="Search anime"
                className="rounded w-full focus:outline-none p-3 pr-11 text-white placeholder-twist-redlight text-sm bg-twist-red"
                value={searchTerm}
              />
              <button
                type="button"
                onClick={() => setAdvancedOpen((isOpen) => !isOpen)}
                aria-label="Advanced filters"
                aria-expanded={advancedOpen}
                className={`absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded transition duration-200 hover:bg-white/15 ${
                  advancedOpen ? 'bg-white/20 text-white' : 'text-white/75'
                }`}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="h-4 w-4"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" d="M4 7h9M17 7h3M4 17h3M11 17h9" />
                  <circle cx="15" cy="7" r="2" />
                  <circle cx="9" cy="17" r="2" />
                </svg>
                {activeCount > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-white px-1 font-body text-[9px] font-bold text-twist-red">
                    {activeCount}
                  </span>
                )}
              </button>
            </div>
          )}
        </form>

        {/* Resume shelf: hidden while a search/filter is active so results are
            not pushed down by a list that does not match the query. */}
        {!debouncedTerm && activeCount === 0 && <ContinueWatching />}

        {advancedOpen && (
          <div className="mt-2 rounded-lg border border-twist-800 bg-twist-800/40 p-3">
            <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
              <FilterSelect
                label="Genre"
                value={filters.genre}
                options={genreSelectOptions}
                onChange={setFilter('genre')}
                anyLabel="Any"
              />
              <FilterSelect
                label="Year"
                value={filters.year}
                options={years}
                onChange={setFilter('year')}
                anyLabel="Any"
              />
              <FilterSelect
                label="Season"
                value={filters.season}
                options={SEASON_OPTIONS}
                onChange={setFilter('season')}
                anyLabel="Any"
              />
              <FilterSelect
                label="Format"
                value={filters.format}
                options={FORMAT_OPTIONS}
                onChange={setFilter('format')}
                anyLabel="Any"
              />
              <FilterSelect
                label="Status"
                value={filters.status}
                options={STATUS_OPTIONS}
                onChange={setFilter('status')}
                anyLabel="Any"
              />
              <FilterSelect
                label="Origin"
                value={filters.origin}
                options={ORIGIN_OPTIONS}
                onChange={setFilter('origin')}
                anyLabel="Any"
              />
              <FilterSelect
                label="Audio"
                value={filters.audio}
                options={AUDIO_OPTIONS}
                onChange={setFilter('audio')}
                anyLabel="Any"
              />
              <FilterInput
                label="Tag"
                value={filters.tag}
                listId="twist-tags"
                placeholder="isekai, time travel…"
                onChange={setFilter('tag')}
              />
              <FilterInput
                label="Studio"
                value={filters.studio}
                placeholder="e.g. Kyoto Animation"
                onChange={setFilter('studio')}
              />
              <FilterInput
                label="Character"
                value={filters.character}
                placeholder="e.g. Hitori Gotou"
                onChange={setFilter('character')}
              />
              <FilterInput
                label="Staff"
                value={filters.staff}
                placeholder="e.g. Naoko Yamada"
                onChange={setFilter('staff')}
              />
              <FilterSelect
                label="Sort"
                value={filters.sort}
                options={SORT_OPTIONS}
                onChange={setFilter('sort')}
              />
            </div>

            {tagChoices.length > 0 && (
              <datalist id="twist-tags">
                {tagChoices.map((tag) => (
                  <option key={tag.value} value={tag.value} />
                ))}
              </datalist>
            )}

            <div className="mt-3 flex items-center justify-between border-t border-twist-800 pt-3">
              <span className="font-body text-[11px] tabular-nums text-twist-lightgray">
                {loading
                  ? 'Loading…'
                  : total !== null
                    ? `${items.length} of ${total.toLocaleString()} titles`
                    : `${items.length} titles`}
              </span>
              <button
                type="button"
                onClick={() => {
                  setFilters(EMPTY_BROWSE);
                  setSearchTerm('');
                }}
                className="focus:outline-none cursor-default rounded bg-twist-800 h-7 px-2.5 border border-transparent transition duration-200 hover:border-twist-gray"
              >
                <span className="font-body text-[11px] text-gray-300">Clear filters</span>
              </button>
            </div>
          </div>
        )}

        <div className="mt-3 flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={() => updateSettings({ viewMode: 'list' })}
            aria-label="List view"
            aria-pressed={viewMode === 'list'}
            className={viewButton('list')}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-3.5 w-3.5"
              aria-hidden="true"
            >
              <path strokeLinecap="round" d="M9 6h11M9 12h11M9 18h11" />
              <circle cx="5" cy="6" r="1" fill="currentColor" stroke="none" />
              <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
              <circle cx="5" cy="18" r="1" fill="currentColor" stroke="none" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => updateSettings({ viewMode: 'cards' })}
            aria-label="Cards view"
            aria-pressed={viewMode === 'cards'}
            className={viewButton('cards')}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-3.5 w-3.5"
              aria-hidden="true"
            >
              <rect x="4" y="4" width="7" height="7" rx="1" />
              <rect x="13" y="4" width="7" height="7" rx="1" />
              <rect x="4" y="13" width="7" height="7" rx="1" />
              <rect x="13" y="13" width="7" height="7" rx="1" />
            </svg>
          </button>
        </div>

        {error ? (
          <div className="mt-2 flex flex-col items-center gap-3 rounded-lg border border-twist-800 bg-twist-800/40 py-8">
            <span className="font-body text-sm text-twist-white">{error}</span>
            <button
              type="button"
              onClick={() => setRetryToken((token) => token + 1)}
              className="rounded bg-twist-red px-3 h-8 font-body text-xs text-gray-100 transition duration-200 hover:bg-twist-reddark"
            >
              Try again
            </button>
          </div>
        ) : loading ? (
          viewMode === 'cards' ? (
            <div className="mt-2 grid gap-3" style={{ gridTemplateColumns: `repeat(${settings.homeColumns}, minmax(0, 1fr))` }}>
              {Array.from({ length: 6 }, (_, index) => (
                <SkeletonCard key={index} />
              ))}
            </div>
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              {Array.from({ length: 8 }, (_, index) => (
                <div key={index} className="h-9 w-full animate-pulse rounded bg-twist-800/60" />
              ))}
            </div>
          )
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center mt-2 py-8">
            <span className="font-body text-twist-white">
              No results for{' '}
              <span className="text-twist-red">{searchTerm || 'these filters'}</span>
            </span>
          </div>
        ) : viewMode === 'cards' ? (
          <div className="mt-2 grid gap-3" style={{ gridTemplateColumns: `repeat(${settings.homeColumns}, minmax(0, 1fr))` }}>
            {items.map((card) => (
              <Link
                key={card.ref}
                href={`/${card.ref}/info`}
                {...hoverProps(card)}
                className="group overflow-hidden rounded-lg border border-twist-800 bg-twist-800/40 transition duration-200 hover:border-twist-gray"
              >
                <Poster card={card} className="aspect-[3/4] w-full" />
                <div className="p-2.5">
                  <span className="block truncate font-body text-sm text-gray-300 transition-colors duration-200 group-hover:text-gray-100">
                    {pick(card)}
                  </span>
                  <span className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="truncate font-body text-[10px] text-twist-lightgray">
                      {[card.format, card.year, episodesLabel(card)]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
  
                  </span>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="mt-2 flex flex-col w-full">
            {items.map((card) => (
              <Link
                href={`/${card.ref}/info`}
                key={card.ref}
                {...hoverProps(card)}
                className="group flex items-center justify-between gap-3 border-b border-twist-800 px-3 py-3 transition-colors duration-200 hover:bg-twist-800/50"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <Poster card={card} className="aspect-[3/4] w-9 shrink-0 rounded border border-twist-800" />
                  <span className="min-w-0">
                    <span className="block truncate font-body text-gray-300 transition-colors duration-200 group-hover:text-gray-100">
                      {pick(card)}
                    </span>
                    <span className="mt-0.5 block truncate font-body text-[10px] text-twist-lightgray">
                      {[card.format, card.year, episodesLabel(card)]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                </span>

                <span className="flex shrink-0 items-center gap-1.5">
                  {card.score !== undefined && (
                    <span className="font-body text-[10px] text-twist-redlight">★ {card.score}</span>
                  )}

                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 text-twist-red opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </span>
              </Link>
            ))}
          </div>
        )}

        {/* Infinite scroll: the sentinel loads the next page before it hits. */}
        {nextOffset !== null && !error && !loading && !stalled && (
          <div ref={sentinelRef} className="h-12 w-full" aria-hidden="true" />
        )}
        {stalled && nextOffset !== null && (
          <button
            type="button"
            onClick={() => {
              hollowLoads.current = 0;
              setStalledKey(null);
              void loadMore();
            }}
            className="focus:outline-none mt-3 h-9 w-full rounded border border-transparent bg-twist-800 font-body text-xs text-gray-300 transition duration-200 hover:border-twist-gray"
          >
            Load more
          </button>
        )}
        {loadingMore && (
          <span className="mt-1 block text-center font-body text-[11px] text-twist-lightgray">
            Loading more…
          </span>
        )}

      </div>

      {/* Hover preview card, anchored to the cursor. */}
      {hovered && (
        <div
          ref={cardRef}
          className="pointer-events-none fixed z-40 w-64 overflow-hidden rounded-lg border border-twist-700 bg-twist-900 shadow-2xl"
        >
          <div className="p-3">
            <div className="flex gap-3">
              <Poster
                card={hovered}
                className="aspect-[3/4] w-16 shrink-0 rounded border border-twist-800"
              />

              <div className="min-w-0 flex-1">
                <span className="flex items-start justify-between gap-2">
                  <span className="font-body text-sm leading-tight text-gray-100">
                    {pick(hovered)}
                  </span>
                  {hovered.score !== undefined && (
                    <span className="shrink-0 font-body text-xs text-twist-redlight">
                      ★ {hovered.score}
                    </span>
                  )}
                </span>

                <span className="mt-1 block font-body text-[11px] text-twist-lightgray">
                  {[hovered.format, hovered.year].filter(Boolean).join(' · ')}
                </span>
                <span className="mt-0.5 block font-body text-[11px] text-twist-lightgray">
                  {[hovered.episodes ? `${hovered.episodes} eps` : null, hovered.status]
                    .filter(Boolean)
                    .join(' · ')}
                </span>


              </div>
            </div>

            {hovered.synopsis && (
              <p className="mt-2 line-clamp-3 font-body text-xs leading-relaxed text-twist-lightgray">
                {hovered.synopsis}
              </p>
            )}

            {hovered.genres.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {hovered.genres.slice(0, 5).map((genre) => (
                  <span
                    key={genre}
                    className="rounded bg-twist-800 px-1.5 py-0.5 font-body text-[9px] font-bold text-twist-lightgray"
                  >
                    {genre}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Shell>
  );
};
