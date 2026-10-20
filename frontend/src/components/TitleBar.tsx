import { useEffect, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { useLocation, useNavigate } from 'react-router-dom';
import { desktop, isDesktop } from '../lib/desktop';
import { formatSpeed, useConnectionSpeed } from '../lib/connection';
import { setSpeedTestPaused } from '../lib/speedtest';
import { browseUrl, countActiveFilters, readBrowseParams } from '../lib/browse';
import {
  AUDIO_OPTIONS,
  EMPTY_BROWSE,
  FORMAT_OPTIONS,
  ORIGIN_OPTIONS,
  SEASON_OPTIONS,
  SORT_OPTIONS,
  STATUS_OPTIONS,
  genreOptions,
  tagOptions,
  yearOptions,
  type BrowseQuery,
  type OptionGroup,
} from '../lib/anime';
import { useStore } from '../lib/store';

type Region = 'caption' | 'minimize' | 'maximize' | 'close';

/**
 * Custom window chrome. The drag regions use Wails' CSS convention
 * (`--wails-draggable: drag`), and the buttons use the frameless-window
 * runtime calls. In a browser the bar simply renders as a static header.
 */
const region = (kind: Region) =>
  isDesktop() ? ({ '--wails-non-client-region': kind } as CSSProperties) : undefined;

/** Deepest history index reached, kept outside React so it survives remounts. */
let furthestIndex = 0;

const useHistoryNav = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);

  useEffect(() => {
    const update = () => {
      const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
      if (idx > furthestIndex) furthestIndex = idx;
      setCanBack(idx > 0);
      setCanForward(idx < furthestIndex);
    };
    update();
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, [location.key]);

  return {
    canBack,
    canForward,
    back: () => canBack && navigate(-1),
    forward: () => canForward && navigate(1),
  };
};

const ChromeButton = ({
  label,
  onClick,
  path,
  active,
}: {
  label: string;
  onClick: () => void;
  path: string;
  active?: boolean;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={!active}
    aria-label={label}
    title={label}
    className="flex h-6 w-7 items-center justify-center rounded text-twist-lightgray transition duration-200 hover:bg-white/10 hover:text-gray-100 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  </button>
);

/**
 * A themed dropdown for the title-bar filters. Native <select> popups are
 * OS-styled and look pasted-on, so this renders its own panel with the app's
 * palette and closes on outside click / Escape.
 */
const FilterMenu = ({
  label,
  value,
  options,
  anyLabel,
  onChange,
}: {
  label: string;
  value: string;
  options: OptionGroup[];
  anyLabel: string;
  onChange: (value: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const active = value !== '';

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const current =
    value === ''
      ? anyLabel
      : (options.find((option) => option.value === value)?.label ?? value.replace(/-/g, ' '));

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((isOpen) => !isOpen)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex h-7 max-w-[9.5rem] items-center gap-1.5 rounded border px-2 font-body text-[11px] transition duration-200 ${
          active
            ? 'border-twist-red/70 bg-twist-red/10 text-gray-100'
            : 'border-twist-700/60 bg-twist-800 text-twist-lightgray hover:border-twist-gray hover:text-gray-200'
        }`}
      >
        <span className="truncate">
          {active && <span className="text-twist-lightgray">{label}: </span>}
          {current}
        </span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`h-2.5 w-2.5 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full z-[95] mt-1 max-h-72 w-52 overflow-y-auto rounded-lg border border-twist-700 bg-twist-950/98 p-1 shadow-2xl backdrop-blur"
        >
          {[{ value: '', label: anyLabel }, ...options].map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value || 'any'}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left font-body text-[11px] transition duration-150 ${
                  selected
                    ? 'bg-twist-red/15 text-gray-100'
                    : 'text-twist-lightgray hover:bg-white/5 hover:text-gray-200'
                }`}
              >
                <span className="truncate capitalize">{option.label}</span>
                {selected && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3 w-3 shrink-0 text-twist-red" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

/** Selected filters as removable tags, below the bar. */
const FilterChips = ({
  query,
  labels,
  onRemove,
  onClear,
}: {
  query: BrowseQuery;
  labels: Record<string, string>;
  onRemove: (key: keyof BrowseQuery) => void;
  onClear: () => void;
}) => {
  const entries = Object.entries(query).filter(
    ([key, value]) => key !== 'sort' && key !== 'query' && Boolean(value)
  );
  if (entries.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center justify-center gap-1.5 border-b border-twist-800/70 bg-twist-950/60 px-3 py-1.5">
      {entries.map(([key, value]) => (
        <button
          key={key}
          type="button"
          onClick={() => onRemove(key as keyof BrowseQuery)}
          title={`Remove ${labels[key] ?? key}`}
          className="group flex items-center gap-1 rounded-full border border-twist-700/70 bg-twist-800/70 px-2 py-0.5 font-body text-[10px] text-gray-300 transition duration-200 hover:border-twist-red/60 hover:text-gray-100"
        >
          <span className="text-twist-lightgray">{labels[key] ?? key}</span>
          <span className="max-w-[8rem] truncate capitalize">{value.replace(/-/g, ' ')}</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-2.5 w-2.5 text-twist-lightgray group-hover:text-twist-red" aria-hidden="true">
            <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      ))}
      <button
        type="button"
        onClick={onClear}
        className="ml-1 font-body text-[10px] text-twist-lightgray underline decoration-twist-700 underline-offset-2 transition duration-200 hover:text-twist-red"
      >
        Clear
      </button>
    </div>
  );
};

const FILTER_LABELS: Record<string, string> = {
  genre: 'Genre',
  year: 'Year',
  season: 'Season',
  format: 'Format',
  status: 'Status',
  origin: 'Origin',
  audio: 'Audio',
  tag: 'Tag',
  studio: 'Studio',
  character: 'Character',
  staff: 'Staff',
};

export const TitleBar = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { canBack, canForward, back, forward } = useHistoryNav();
  const [maximised, setMaximised] = useState(false);
  const [desktopReady, setDesktopReady] = useState(false);
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const { chatOpen, setChatOpen } = useStore();
  const connection = useConnectionSpeed(desktopReady);

  // Browse filters live in the URL, so the bar always reflects the list that
  // is actually on screen (including one opened from a shared link).
  const [filters, setFilters] = useState<BrowseQuery>(() =>
    readBrowseParams(new URLSearchParams(location.search))
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [genres, setGenres] = useState<OptionGroup[]>([]);
  const [tags, setTags] = useState<OptionGroup[]>([]);

  // Follow the URL: home navigation (back/forward, a link, or the home page's
  // own filter panel) updates the bar instead of leaving stale values.
  useEffect(() => {
    if (location.pathname !== '/') return;
    const next = readBrowseParams(new URLSearchParams(location.search));
    setFilters(next);
    setSearch(next.query);
  }, [location.pathname, location.search]);

  // Going back to the home page (by history or the logo) clears the box, so it
  // never keeps showing a term that is no longer what the list is filtered by.
  useEffect(() => {
    if (location.pathname === '/') {
      setSearch((current) =>
        current === readBrowseParams(new URLSearchParams(location.search)).query ? current : ''
      );
    }
  }, [location.pathname]);

  useEffect(() => {
    setDesktopReady(isDesktop());
  }, []);

  // Genre and tag options are needed the moment the filter row is opened.
  useEffect(() => {
    if (!filtersOpen || genres.length > 0) return;
    let active = true;
    genreOptions()
      .then((options) => {
        if (active) setGenres(options);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [filtersOpen, genres.length]);

  useEffect(() => {
    if (!filtersOpen || tags.length > 0) return;
    let active = true;
    tagOptions()
      .then((options) => {
        if (active) setTags(options);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [filtersOpen, tags.length]);

  const windowApi = async () => {
    if (!desktopReady) return null;
    const runtime = await import('@wailsio/runtime');
    return runtime.Window;
  };

  const minimise = async () => (await windowApi())?.Minimise();
  const toggle = async () => {
    const api = await windowApi();
    if (!api) return;
    await api.ToggleMaximise();
    setMaximised(await api.IsMaximised().catch(() => false));
  };
  // Closing the webview alone can leave the process (and its tray/relay)
  // alive; ask the Go side to shut the whole app down, with the window close
  // as a fallback for the browser build.
  const close = async () => {
    if (desktopReady) {
      try {
        await desktop.quit();
        return;
      } catch {
        /* fall through to the window call */
      }
    }
    await (await windowApi())?.Close();
  };

  // Searching is navigation, not a message to whoever happens to be mounted:
  // the query goes into the URL so it works from any page, survives a reload,
  // and the home list reads it back (no duplicate state to drift).
  const submitSearch = (next?: BrowseQuery) => {
    const query = next ?? { ...filters, query: search };
    navigate(browseUrl(query));
  };

  const setFilter = (key: keyof BrowseQuery, value: string) => {
    const next = { ...filters, [key]: value };
    setFilters(next);
    // Applying a filter always lands on the list it filters.
    submitSearch(next);
  };

  return (
    <>
      <header
        className="relative z-[80] grid h-9 shrink-0 select-none grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-twist-800 bg-twist-950/95 pl-2 pr-0"
        style={{ '--wails-draggable': 'drag' } as CSSProperties}
      >
        {/* Left cluster. A 1fr / auto / 1fr grid keeps the search dead-centre
            no matter how many icons the right side grows. */}
        <div className="flex min-w-0 items-center gap-1">
          <Link
            href="/"
            aria-label="Twist home"
            title="Twist home"
            className="flex shrink-0 items-center gap-2 rounded px-1 py-1 transition duration-200 hover:bg-white/5"
            style={{ '--wails-draggable': 'no-drag' } as CSSProperties}
          >
            <svg viewBox="0 0 16 10" className="h-3 w-5" aria-hidden="true">
              <polygon points="0,10 5,0 10,10 9,10 5,2 1,10" fill="#cdcece" />
              <polygon points="11,10 6,0 16,0 15.5,1 7.5,1 11.5,9" fill="var(--accent, #d4433c)" />
            </svg>
            <span className="font-body text-[11px] tracking-widest text-twist-lightgray">TWIST</span>
          </Link>
          <ChromeButton label="Back" active={canBack} onClick={back} path="M15 19l-7-7 7-7" />
          <ChromeButton label="Forward" active={canForward} onClick={forward} path="M9 5l7 7-7 7" />
        </div>

        {/* Search + connection reading. Only the controls opt out of dragging;
            the surrounding space stays draggable. */}
        <div className="flex min-w-0 items-center justify-center gap-2">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submitSearch();
              inputRef.current?.blur();
            }}
            className="relative w-full max-w-sm"
            style={{ '--wails-draggable': 'no-drag' } as CSSProperties}
          >
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
              ref={inputRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setSearch('');
                  inputRef.current?.blur();
                }
              }}
              placeholder="Search anime…"
              aria-label="Search anime"
              spellCheck={false}
              className="h-6 w-full rounded bg-twist-800 pl-7 pr-14 font-body text-[11px] text-gray-200 placeholder-twist-lightgray border border-twist-700/60 transition duration-200 focus:border-twist-red focus:outline-none"
            />
            {/* Filter toggle sits inside the box so the bar keeps its height. */}
            <button
              type="button"
              onClick={() => setFiltersOpen((open) => !open)}
              aria-label="Filters"
              aria-expanded={filtersOpen}
              title="Filters"
              className={`absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded transition duration-200 ${
                filtersOpen || countActiveFilters(filters) > 0
                  ? 'bg-twist-red/20 text-twist-red'
                  : 'text-twist-lightgray hover:bg-white/10 hover:text-gray-200'
              }`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3" aria-hidden="true">
                <path strokeLinecap="round" d="M4 7h9M17 7h3M4 17h3M11 17h9" />
                <circle cx="15" cy="7" r="2" />
                <circle cx="9" cy="17" r="2" />
              </svg>
              {countActiveFilters(filters) > 0 && (
                <span className="absolute -right-1 -top-1 flex h-3 min-w-3 items-center justify-center rounded-full bg-twist-red px-0.5 font-body text-[8px] font-bold leading-none text-white">
                  {countActiveFilters(filters)}
                </span>
              )}
            </button>
          </form>

          {/* Live connection reading. Clicking it pauses (or resumes) the
              background speed test; the icon reflects which. */}
          <button
            type="button"
            onClick={() => setSpeedTestPaused(!connection.paused)}
            aria-pressed={connection.paused}
            title={
              connection.paused
                ? 'Speed test paused — click to resume'
                : 'Connection speed used for quality. Click to pause the test'
            }
            className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-body text-[10px] tabular-nums transition duration-200 ${
              connection.paused
                ? 'text-twist-red hover:bg-white/5'
                : 'text-twist-lightgray hover:bg-white/5 hover:text-gray-200'
            }`}
          >
            {connection.paused ? (
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3" aria-hidden="true">
                <rect x="6" y="5" width="4" height="14" rx="1" />
                <rect x="14" y="5" width="4" height="14" rx="1" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3" aria-hidden="true">
                <path strokeLinecap="round" d="M4 16a8 8 0 0116 0" />
                <path strokeLinecap="round" d="M7.5 18.5a4.5 4.5 0 019 0" />
                <circle cx="12" cy="21" r="0.6" fill="currentColor" />
              </svg>
            )}
            <span className={connection.paused ? '' : connection.measured ? 'text-gray-300' : 'opacity-60'}>
              {formatSpeed(connection.mbps)}
            </span>
          </button>
        </div>

        <div
          className="flex min-w-0 items-center justify-end gap-0.5"
          style={{ '--wails-draggable': 'no-drag' } as CSSProperties}
        >
          <Link
            href="/profile"
            aria-label="Profile"
            title="Profile"
            className="flex h-7 w-7 items-center justify-center rounded text-twist-lightgray transition duration-200 hover:bg-white/10 hover:text-gray-100"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
              <path d="M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-4.42 0-8 2.24-8 5v1h16v-1c0-2.76-3.58-5-8-5z" />
            </svg>
          </Link>

          <Link
            href="/library"
            aria-label="Library"
            title="Library"
            className="flex h-7 w-7 items-center justify-center rounded text-twist-lightgray transition duration-200 hover:bg-white/10 hover:text-gray-100"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
              <path d="M6 4h12a1 1 0 011 1v16l-7-4-7 4V5a1 1 0 011-1z" />
            </svg>
          </Link>

          <Link
            href="/downloads"
            aria-label="Downloads"
            title="Downloads"
            className="flex h-7 w-7 items-center justify-center rounded text-twist-lightgray transition duration-200 hover:bg-white/10 hover:text-gray-100"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
              <path d="M12 3a1 1 0 011 1v9.59l3.3-3.3a1 1 0 111.4 1.42l-5 5a1 1 0 01-1.4 0l-5-5a1 1 0 111.4-1.42l3.3 3.3V4a1 1 0 011-1zM5 19a1 1 0 011-1h12a1 1 0 110 2H6a1 1 0 01-1-1z" />
            </svg>
          </Link>

          <button
            type="button"
            onClick={() => setChatOpen(!chatOpen)}
            aria-label={chatOpen ? 'Hide chat' : 'Show chat'}
            title={chatOpen ? 'Hide chat' : 'Show chat'}
            aria-pressed={chatOpen}
            className={`flex h-7 w-7 items-center justify-center rounded transition duration-200 hover:bg-white/10 hover:text-gray-100 ${
              chatOpen ? 'bg-white/10 text-gray-100' : 'text-twist-lightgray'
            }`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 12a8 8 0 01-8 8H7l-4 3v-6.5A8 8 0 0113 4a8 8 0 018 8z"
              />
            </svg>
          </button>

          <Link
            href="/settings"
            aria-label="Settings"
            title="Settings"
            className="flex h-7 w-7 items-center justify-center rounded text-twist-lightgray transition duration-200 hover:bg-white/10 hover:text-gray-100"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path
                fillRule="evenodd"
                d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.53 1.53 0 01-2.29.95c-1.37-.84-2.94.73-2.1 2.1.54.89.06 2.05-.95 2.3-1.56.37-1.56 2.6 0 2.97a1.53 1.53 0 01.95 2.29c-.84 1.37.73 2.94 2.1 2.1a1.53 1.53 0 012.3.95c.37 1.56 2.6 1.56 2.97 0a1.53 1.53 0 012.29-.95c1.37.84 2.94-.73 2.1-2.1a1.53 1.53 0 01.95-2.3c1.56-.37 1.56-2.6 0-2.97a1.53 1.53 0 01-.95-2.29c.84-1.37-.73-2.94-2.1-2.1a1.53 1.53 0 01-2.3-.95zM10 13a3 3 0 100-6 3 3 0 000 6z"
                clipRule="evenodd"
              />
            </svg>
          </Link>

          <span className="mx-1 h-4 w-px bg-twist-700" aria-hidden="true" />

          <button
            type="button"
            onClick={minimise}
            aria-label="Minimise"
            style={region('minimize')}
            className="flex h-9 w-10 items-center justify-center text-twist-lightgray transition hover:bg-white/10 hover:text-gray-100 disabled:opacity-40"
            disabled={!desktopReady}
          >
            <svg viewBox="0 0 10 10" className="h-2.5 w-2.5"><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
          </button>
          <button
            type="button"
            onClick={toggle}
            aria-label={maximised ? 'Restore' : 'Maximise'}
            style={region('maximize')}
            className="flex h-9 w-10 items-center justify-center text-twist-lightgray transition hover:bg-white/10 hover:text-gray-100 disabled:opacity-40"
            disabled={!desktopReady}
          >
            <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="0.5" y="0.5" width="9" height="9" />
            </svg>
          </button>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            style={region('close')}
            className="flex h-9 w-10 items-center justify-center text-twist-lightgray transition hover:bg-[#c0392b] hover:text-white disabled:opacity-40"
            disabled={!desktopReady}
          >
            <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" stroke="currentColor" strokeWidth="1">
              <path d="M0 0l10 10M10 0L0 10" />
            </svg>
          </button>
        </div>
      </header>

      {filtersOpen && (
        <div
          className="relative z-[85] flex flex-wrap items-center justify-center gap-1.5 border-b border-twist-800 bg-twist-950/95 px-3 py-1.5"
          style={{ '--wails-draggable': 'no-drag' } as CSSProperties}
        >
          <FilterMenu
            label="Genre"
            value={filters.genre}
            options={genres}
            anyLabel="Any genre"
            onChange={(value) => setFilter('genre', value)}
          />
          <FilterMenu
            label="Tag"
            value={filters.tag}
            options={tags}
            anyLabel="Any tag"
            onChange={(value) => setFilter('tag', value)}
          />
          <FilterMenu
            label="Year"
            value={filters.year}
            options={yearOptions()}
            anyLabel="Any year"
            onChange={(value) => setFilter('year', value)}
          />
          <FilterMenu
            label="Season"
            value={filters.season}
            options={SEASON_OPTIONS}
            anyLabel="Any season"
            onChange={(value) => setFilter('season', value)}
          />
          <FilterMenu
            label="Format"
            value={filters.format}
            options={FORMAT_OPTIONS}
            anyLabel="Any format"
            onChange={(value) => setFilter('format', value)}
          />
          <FilterMenu
            label="Status"
            value={filters.status}
            options={STATUS_OPTIONS}
            anyLabel="Any status"
            onChange={(value) => setFilter('status', value)}
          />
          <FilterMenu
            label="Origin"
            value={filters.origin}
            options={ORIGIN_OPTIONS}
            anyLabel="Any origin"
            onChange={(value) => setFilter('origin', value)}
          />
          <FilterMenu
            label="Audio"
            value={filters.audio}
            options={AUDIO_OPTIONS}
            anyLabel="Any audio"
            onChange={(value) => setFilter('audio', value)}
          />
          <FilterMenu
            label="Sort"
            value={filters.sort}
            options={SORT_OPTIONS}
            anyLabel="Newest"
            onChange={(value) => setFilter('sort', value)}
          />
        </div>
      )}

      <FilterChips
        query={filters}
        labels={FILTER_LABELS}
        onRemove={(key) => setFilter(key, key === 'sort' ? EMPTY_BROWSE.sort : '')}
        onClear={() => {
          setFilters(EMPTY_BROWSE);
          setSearch('');
          submitSearch({ ...EMPTY_BROWSE, query: '' });
        }}
      />
    </>
  );
};
