import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'react-router-dom';
import { useDownloads } from '../lib/downloads';
import type { DownloadItem } from '../lib/desktop';
import { getAnimeDetail, type AnimeDetail } from '../lib/anime';
import { Shell } from '../components/Shell';
import { Artwork } from '../components/Artwork';
import { RouteLoading, RouteNotFound } from '../components/RouteState';
import { groupDownloads, groupKey, type DownloadGroup } from './DownloadsPage';

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

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <p className="mb-1 font-body text-xs text-twist-white">
    <span className="font-bold">{label}: </span>
    {children}
  </p>
);

/** Info page for a title the user has downloaded episodes of. */
export const DownloadsInfo = ({ group }: { group: DownloadGroup }) => {
  const { pause, resume, retry, remove, posterUrl, thumbUrl, info } = useDownloads();
  const [detail, setDetail] = useState<AnimeDetail | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);

  // Catalogue details are optional: offline this simply stays empty and the
  // page is built from what the download itself stored.
  useEffect(() => {
    if (!group.slug) return;
    let active = true;
    getAnimeDetail(group.slug)
      .then((value) => active && setDetail(value))
      .catch(() => active && setDetailFailed(true));
    return () => {
      active = false;
    };
  }, [group.slug]);

  const year = detail?.season?.year ?? group.year;
  const total = detail?.episodes ?? group.totalEpisodes ?? group.items.length;
  const poster = detail?.images.posters[0]?.url ?? group.poster;
  const banner = detail?.images.banners[0]?.url;
  const title = detail?.titles.romaji ?? group.title;
  const episodeStill = (item: DownloadItem) => thumbUrl(item);

  return (
    <Shell>
      <div className="content-column mx-auto w-full px-4 py-6">
        <nav className="mb-3 flex flex-wrap items-center gap-2 font-body text-sm">
          <Link href="/downloads" className="text-twist-lightgray transition duration-200 hover:text-gray-200">
            Downloads
          </Link>
          <span className="text-twist-lightgray">›</span>
          <span className="min-w-0 truncate text-gray-200">{title}</span>
        </nav>

        {banner && (
          <div className="relative mb-4 h-28 w-full overflow-hidden rounded-lg border border-twist-800 sm:h-36">
            <img src={banner} alt="" className="h-full w-full object-cover opacity-70" />
            <div className="absolute inset-0 bg-gradient-to-t from-twist-900 to-transparent" />
          </div>
        )}

        <div className="flex flex-col gap-6 sm:flex-row">
          <div className="mx-auto w-40 shrink-0 sm:mx-0">
            <Artwork
              sources={[posterUrl(group.items[0]), poster]}
              alt={title}
              className="aspect-[3/4] w-full rounded"
            />
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="font-body text-2xl leading-tight text-gray-100">{title}</h1>
            {detail?.titles.english && detail.titles.english !== title && (
              <span className="mt-1 font-body text-xs text-twist-lightgray">{detail.titles.english}</span>
            )}

            <div className="mt-4 flex items-center gap-3 border-b border-twist-800">
              <span className="inline-block border-b-2 border-twist-red pb-2 font-body text-sm text-gray-200">
                Summary
              </span>
              {detail?.score?.value !== undefined && (
                <span className="pb-2 font-body text-sm text-twist-redlight">★ {detail.score.value}</span>
              )}
            </div>

            <p className="mt-4 whitespace-pre-line font-body text-sm leading-relaxed text-gray-300">
              {detail?.synopsis?.trim() ||
                (detailFailed
                  ? 'Details are unavailable offline — the downloaded episodes below still play.'
                  : 'No synopsis has been published for this title yet.')}
            </p>

            <div className="mt-6 border-t border-twist-800 pt-4">
              <Row label="Episodes offline">
                {group.ready} of {group.items.length} saved
                {total ? ` · ${total} total` : ''}
              </Row>
              <Row label="On disk">{formatBytes(group.bytes)}</Row>
              {year && <Row label="Year">{year}</Row>}
              {detail?.status && <Row label="Status">{detail.status}</Row>}
              {detail?.studios && detail.studios.length > 0 && (
                <Row label="Studio">{detail.studios.join(', ')}</Row>
              )}
              {detail?.genres && detail.genres.length > 0 && (
                <Row label="Genres">{detail.genres.slice(0, 6).join(', ')}</Row>
              )}
              {info?.downloadsDir && (
                <Row label="Folder">
                  <span className="break-all text-twist-lightgray">{info.downloadsDir}</span>
                </Row>
              )}
            </div>

            {group.slug && (
              <Link
                href={`/${encodeURIComponent(group.slug)}/info`}
                className="mt-6 flex w-48 items-center justify-center rounded border border-transparent bg-twist-800 h-10 font-body text-gray-200 transition duration-200 hover:border-twist-gray"
              >
                Open in catalogue
              </Link>
            )}
          </div>
        </div>

        <div className="mt-8 border-t border-twist-800 pt-5">
          <span className="font-body text-xs font-bold uppercase tracking-wide text-twist-red">
            Downloaded episodes
          </span>

          <div className="mt-3 flex flex-col">
            {group.items.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-3 border-b border-twist-800 px-1 py-2.5 last:border-b-0"
              >
                <Artwork
                  sources={[episodeStill(item), group.poster]}
                  alt={`Episode ${item.episode}`}
                  className="aspect-video w-24 shrink-0 rounded border border-twist-800"
                >
                  {item.status === 'complete' && (
                    <Link
                      href={`/offline/${item.id}`}
                      aria-label={`Play episode ${item.episode}`}
                      className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition duration-200 hover:opacity-100"
                    >
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-twist-red text-white">
                        <svg viewBox="0 0 24 24" className="ml-0.5 h-4 w-4" fill="currentColor">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </span>
                    </Link>
                  )}
                </Artwork>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-body text-sm text-gray-200">
                      Episode {item.episode}
                      <span className="text-twist-lightgray"> · {item.kind.toUpperCase()}</span>
                    </span>
                    <span
                      className={`shrink-0 font-body text-[9px] uppercase tracking-wide ${STATUS_COLOR[item.status]}`}
                    >
                      {STATUS_LABEL[item.status]}
                    </span>
                  </div>

                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="font-body text-[11px] text-twist-lightgray">
                      {formatBytes(item.bytes)}
                      {item.status !== 'complete' && item.expectedBytes > item.bytes
                        ? ` of ${formatBytes(item.expectedBytes)}`
                        : ''}
                      {item.quality && item.quality !== 'auto' ? ` · ${item.quality}` : ''}
                    </span>
                    <span className="flex items-center gap-1">
                      {(item.status === 'downloading' || item.status === 'queued') && (
                        <button
                          onClick={() => void pause(item.id)}
                          className="rounded bg-twist-800 px-1.5 py-0.5 font-body text-[9px] text-gray-300 border border-transparent hover:border-twist-gray"
                        >
                          Pause
                        </button>
                      )}
                      {item.status === 'paused' && (
                        <button
                          onClick={() => void resume(item.id)}
                          className="rounded bg-twist-800 px-1.5 py-0.5 font-body text-[9px] text-gray-300 border border-transparent hover:border-twist-gray"
                        >
                          Resume
                        </button>
                      )}
                      {item.status === 'failed' && (
                        <button
                          onClick={() => void retry(item.id)}
                          className="rounded bg-twist-800 px-1.5 py-0.5 font-body text-[9px] text-gray-300 border border-transparent hover:border-twist-gray"
                        >
                          Retry
                        </button>
                      )}
                      <button
                        onClick={() => void remove(item.id)}
                        className="rounded bg-twist-800 px-1.5 py-0.5 font-body text-[9px] text-twist-lightgray border border-transparent hover:border-twist-gray hover:text-red-400"
                      >
                        Delete
                      </button>
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Shell>
  );
};

/** `/downloads/:key` — key is the slug, or `mal-<id>` when the slug is unknown. */
export const DownloadsInfoRoute = () => {
  const { slug = '' } = useParams<{ slug: string }>();
  const key = decodeURIComponent(slug);
  const { items, loading, available, refresh } = useDownloads();

  useEffect(() => {
    if (available) void refresh();
  }, [available, refresh]);

  const group = useMemo(
    () => groupDownloads(items).find((entry) => entry.key === key || groupKey(entry.items[0]) === key),
    [items, key]
  );

  if (!group) {
    if (loading) return <RouteLoading label="Loading downloads" />;
    return (
      <RouteNotFound
        title="Not downloaded"
        detail="There is no saved copy of this title on this device."
      />
    );
  }

  return <DownloadsInfo group={group} />;
};
