import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useDownloads } from '../lib/downloads';
import type { DownloadItem } from '../lib/desktop';
import { Shell } from '../components/Shell';
import { Artwork } from '../components/Artwork';

const formatBytes = (value: number) => {
  if (!value) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
};

const STATUS_LABEL: Record<DownloadItem['status'], string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  paused: 'Paused',
  complete: 'Ready',
  failed: 'Failed',
};

const STATUS_COLOR: Record<DownloadItem['status'], string> = {
  queued: 'text-twist-lightgray',
  downloading: 'text-twist-redlight',
  paused: 'text-amber-400',
  complete: 'text-emerald-400',
  failed: 'text-red-400',
};

export type DownloadGroup = {
  /** Route key for `/downloads/:key`. */
  key: string;
  slug: string;
  malId: number;
  title: string;
  poster: string;
  year: number;
  totalEpisodes: number;
  items: DownloadItem[];
  bytes: number;
  ready: number;
};

export const groupKey = (item: DownloadItem) => item.slug || `mal-${item.malId}`;

/** Downloads grouped per title, so a season reads as one shelf entry. */
export const groupDownloads = (items: DownloadItem[]): DownloadGroup[] => {
  const groups = new Map<string, DownloadGroup>();
  for (const item of items) {
    const key = groupKey(item);
    const group = groups.get(key) ?? {
      key,
      slug: item.slug,
      malId: item.malId,
      title: item.title,
      poster: item.poster,
      year: item.year,
      totalEpisodes: item.totalEpisodes,
      items: [],
      bytes: 0,
      ready: 0,
    };
    group.items.push(item);
    group.bytes += item.bytes;
    if (item.status === 'complete') group.ready += 1;
    if (!group.poster && item.poster) group.poster = item.poster;
    if (!group.totalEpisodes && item.totalEpisodes) group.totalEpisodes = item.totalEpisodes;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      items: [...group.items].sort((a, b) => a.episode - b.episode),
    }))
    .sort((a, b) => {
      const latest = (group: DownloadGroup) =>
        Math.max(...group.items.map((item) => item.updatedAt || item.createdAt));
      return latest(b) - latest(a);
    });
};

export const DownloadsPage = ({ offline = false }: { offline?: boolean }) => {
  const { available, items, loading, refresh, posterUrl } = useDownloads();
  const [hovered, setHovered] = useState<DownloadGroup | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const cursor = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (available) void refresh();
  }, [available, refresh]);

  const groups = useMemo(() => groupDownloads(items), [items]);
  const totalBytes = useMemo(() => items.reduce((sum, item) => sum + item.bytes, 0), [items]);

  // The preview is fixed and placed imperatively so mouse moves do not re-render.
  const placeCard = () => {
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
  };

  useEffect(() => {
    if (hovered) placeCard();
    const hide = () => setHovered(null);
    document.addEventListener('scroll', hide, true);
    return () => document.removeEventListener('scroll', hide, true);
  }, [hovered]);

  return (
    <Shell>
      <div className="content-column mx-auto w-full px-4 py-4">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-twist-800 pb-3">
          <div>
            <h1 className="font-body text-xl text-gray-100">Downloads</h1>
            <p className="mt-0.5 font-body text-[11px] text-twist-lightgray">
              {offline
                ? 'You are offline — showing what is saved on this device.'
                : available
                  ? `${groups.length} title${groups.length === 1 ? '' : 's'} · ${items.length} episode${
                      items.length === 1 ? '' : 's'
                    } · ${formatBytes(totalBytes)} on disk`
                  : 'Downloads need the desktop app'}
            </p>
          </div>
        </div>

        {!available && (
          <p className="mt-4 font-body text-sm leading-relaxed text-twist-lightgray">
            Offline downloads are part of the desktop app. In the browser build episodes stream from
            the network as usual.
          </p>
        )}

        {available && loading && (
          <div className="mt-3 flex flex-col gap-2">
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="h-16 w-full animate-pulse rounded bg-twist-800/60" />
            ))}
          </div>
        )}

        {available && !loading && groups.length === 0 && (
          <p className="mt-4 font-body text-sm text-twist-lightgray">
            Nothing here yet. Use the download button under the player to save an episode.
          </p>
        )}

        <div className="mt-2 flex w-full flex-col">
          {groups.map((group) => (
            <Link
              key={group.key}
              href={`/downloads/${encodeURIComponent(group.key)}`}
              onMouseEnter={(event) => {
                cursor.current = { x: event.clientX, y: event.clientY };
                setHovered(group);
              }}
              onMouseMove={(event) => {
                cursor.current = { x: event.clientX, y: event.clientY };
                placeCard();
              }}
              onMouseLeave={() => setHovered(null)}
              className="group flex items-center justify-between gap-3 border-b border-twist-800 px-3 py-3 transition-colors duration-200 hover:bg-twist-800/50"
            >
              <span className="flex min-w-0 items-center gap-3">
                <Artwork
                  sources={[posterUrl(group.items[0]), group.poster]}
                  alt={group.title}
                  className="aspect-[3/4] w-9 shrink-0 rounded border border-twist-800"
                />
                <span className="min-w-0">
                  <span className="block truncate font-body text-gray-300 transition-colors duration-200 group-hover:text-gray-100">
                    {group.title}
                  </span>
                  <span className="mt-0.5 block truncate font-body text-[10px] text-twist-lightgray">
                    {[
                      group.year || undefined,
                      `${group.ready}/${group.totalEpisodes || group.items.length} offline`,
                      formatBytes(group.bytes),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </span>

              <span className="flex shrink-0 items-center gap-2">
                {group.items.some((item) => item.status === 'downloading' || item.status === 'queued') && (
                  <span className="font-body text-[10px] uppercase tracking-wide text-twist-redlight">
                    Downloading
                  </span>
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
      </div>

      {/* Hover preview, anchored to the cursor — mirrors the home page. */}
      {hovered && (
        <div
          ref={cardRef}
          className="pointer-events-none fixed z-40 w-64 overflow-hidden rounded-lg border border-twist-700 bg-twist-900 shadow-2xl"
        >
          <div className="p-3">
            <div className="flex gap-3">
              <Artwork
                sources={[posterUrl(hovered.items[0]), hovered.poster]}
                alt={hovered.title}
                className="aspect-[3/4] w-16 shrink-0 rounded border border-twist-800"
              />

              <div className="min-w-0 flex-1">
                <span className="font-body text-sm leading-tight text-gray-100">{hovered.title}</span>
                <span className="mt-1 block font-body text-[11px] text-twist-lightgray">
                  {[hovered.year, hovered.totalEpisodes ? `${hovered.totalEpisodes} eps` : null]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <span className="mt-0.5 block font-body text-[11px] text-twist-lightgray">
                  {hovered.ready} of {hovered.items.length} downloaded · {formatBytes(hovered.bytes)}
                </span>
              </div>
            </div>

            <div className="mt-2 flex flex-wrap gap-1">
              {hovered.items.slice(0, 8).map((item) => (
                <span
                  key={item.id}
                  title={`Episode ${item.episode} · ${STATUS_LABEL[item.status]}`}
                  className={`rounded px-1.5 py-0.5 font-body text-[9px] font-bold ${
                    item.status === 'complete'
                      ? 'bg-twist-red/15 text-twist-red'
                      : `bg-twist-800 ${STATUS_COLOR[item.status]}`
                  }`}
                >
                  {item.episode}
                </span>
              ))}
              {hovered.items.length > 8 && (
                <span className="rounded bg-twist-800 px-1.5 py-0.5 font-body text-[9px] text-twist-lightgray">
                  +{hovered.items.length - 8}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
};
