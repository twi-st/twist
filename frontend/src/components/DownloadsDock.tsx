import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useDownloads } from '../lib/downloads';
import type { DownloadItem } from '../lib/desktop';
import { Artwork } from './Artwork';

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

const percentOf = (item: DownloadItem) => {
  if (item.status === 'complete') return 100;
  if (item.expectedBytes > 0) {
    return Math.min(100, Math.round((item.bytes / item.expectedBytes) * 100));
  }
  return item.segments > 0 ? Math.min(100, Math.round((item.done / item.segments) * 100)) : 0;
};

/** "48.2 MB of 312 MB · 2.1 MB/s" style sizing for the tray. */
const sizeLabel = (item: DownloadItem) => {
  const done = formatBytes(item.bytes);
  if (item.status === 'complete') return `${done} · done`;
  if (item.expectedBytes > item.bytes) {
    const left = formatBytes(item.expectedBytes - item.bytes);
    return `${done} of ${formatBytes(item.expectedBytes)} · ${left} left`;
  }
  return `${done} · ${item.status}`;
};

const isActive = (item: DownloadItem) =>
  item.status === 'downloading' || item.status === 'queued' || item.status === 'paused';

/**
 * Floating progress tray for downloads in flight. Collapsed it is a small
 * badge; expanded it lists each episode with what is done, what is left and
 * the progress bar.
 */
export const DownloadsDock = () => {
  const { available, items, pause, resume, posterUrl, thumbUrl } = useDownloads();
  const [open, setOpen] = useState(false);
  const [announced, setAnnounced] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);

  const active = useMemo(() => items.filter(isActive), [items]);
  // Only downloads that finished while the app was open are announced; ones
  // already on disk from a previous session stay quiet.
  const finished = useMemo(
    () =>
      items.filter(
        (item) =>
          item.status === 'complete' &&
          announced.includes(item.id) &&
          !dismissed.includes(item.id)
      ),
    [items, announced, dismissed]
  );

  // Track transitions into "complete" rather than the list itself, so opening
  // the app with a full downloads folder does not raise the tray.
  const previous = useRef<Map<string, DownloadItem['status']>>(new Map());
  useEffect(() => {
    const next = new Map<string, DownloadItem['status']>();
    const justFinished: string[] = [];
    for (const item of items) {
      next.set(item.id, item.status);
      const before = previous.current.get(item.id);
      if (item.status === 'complete' && before && before !== 'complete') {
        justFinished.push(item.id);
      }
    }
    previous.current = next;
    if (justFinished.length > 0) {
      setAnnounced((prev) => [...new Set([...prev, ...justFinished])]);
    }
  }, [items]);

  if (!available || (active.length === 0 && finished.length === 0)) return null;

  const shown = [...active, ...finished].slice(0, 6);
  const label = active.length > 0 ? `${active.length} downloading` : `${finished.length} ready`;

  return (
    <div className="pointer-events-none fixed bottom-3 right-3 z-[70] flex flex-col items-end gap-2">
      {open && (
        <div className="pointer-events-auto w-80 overflow-hidden rounded-lg border border-twist-700 bg-twist-900/95 shadow-2xl backdrop-blur">
          <div className="flex items-center justify-between border-b border-twist-800 px-3 py-2">
            <span className="font-body text-xs text-gray-200">Downloads</span>
            <Link
              href="/downloads"
              className="font-body text-[10px] text-twist-red hover:text-twist-redlight"
            >
              Open page
            </Link>
          </div>

          <ul className="max-h-72 overflow-y-auto">
            {shown.map((item) => {
              const percent = percentOf(item);
              return (
                <li key={item.id} className="flex gap-2.5 border-b border-twist-800/60 px-3 py-2 last:border-b-0">
                  <Artwork
                    sources={[thumbUrl(item), posterUrl(item)]}
                    alt=""
                    className="h-11 w-8 shrink-0 rounded"
                  />

                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-body text-[11px] text-gray-100">
                        {item.title}
                      </span>
                      <span className="shrink-0 font-body text-[10px] text-twist-lightgray">
                        EP {item.episode}
                      </span>
                    </div>

                    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-twist-800">
                      <div
                        className={`h-full rounded-full transition-[width] duration-300 ${
                          item.status === 'complete' ? 'bg-emerald-400' : 'bg-twist-red'
                        }`}
                        style={{
                          width: `${item.status === 'complete' ? 100 : Math.max(percent, item.status === 'queued' ? 2 : 4)}%`,
                        }}
                      />
                    </div>

                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span className="truncate font-body text-[10px] text-twist-lightgray">
                        {sizeLabel(item)}
                      </span>

                      <span className="flex shrink-0 items-center gap-1.5">
                        <span className="font-body text-[10px] tabular-nums text-gray-300">
                          {item.status === 'complete' ? '100%' : `${percent}%`}
                        </span>
                        {item.status === 'downloading' && (
                          <button
                            onClick={() => void pause(item.id)}
                            className="rounded bg-twist-800 px-1.5 py-0.5 font-body text-[9px] text-gray-300 hover:border-twist-gray border border-transparent"
                          >
                            Pause
                          </button>
                        )}
                        {item.status === 'paused' && (
                          <button
                            onClick={() => void resume(item.id)}
                            className="rounded bg-twist-800 px-1.5 py-0.5 font-body text-[9px] text-gray-300 hover:border-twist-gray border border-transparent"
                          >
                            Resume
                          </button>
                        )}
                        {item.status === 'complete' && (
                          <button
                            onClick={() => setDismissed((prev) => [...prev, item.id])}
                            className="rounded bg-twist-800 px-1.5 py-0.5 font-body text-[9px] text-twist-lightgray hover:border-twist-gray border border-transparent"
                          >
                            Dismiss
                          </button>
                        )}
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={label}
        title={label}
        className="pointer-events-auto relative flex h-11 items-center gap-2 rounded-full border border-twist-700 bg-twist-900/95 px-3.5 text-twist-lightgray shadow-xl transition duration-200 hover:border-twist-gray hover:text-gray-100"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
          <path d="M12 3a1 1 0 011 1v9.59l3.3-3.3a1 1 0 111.4 1.42l-5 5a1 1 0 01-1.4 0l-5-5a1 1 0 111.4-1.42l3.3 3.3V4a1 1 0 011-1zM5 19a1 1 0 011-1h12a1 1 0 110 2H6a1 1 0 01-1-1z" />
        </svg>
        <span className="font-body text-[11px] tabular-nums">{label}</span>
        {active.length > 0 && (
          <span className="absolute -left-1 -top-1 h-2.5 w-2.5 animate-pulse rounded-full bg-twist-red" />
        )}
      </button>
    </div>
  );
};
