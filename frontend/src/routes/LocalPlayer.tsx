import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useNavigate, useParams } from 'react-router-dom';
import { Shell } from '../components/Shell';
import { Artwork } from '../components/Artwork';
import { VideoPlayer } from '../components/VideoPlayer';
import { PlayerToggles } from '../components/PlayerToggles';
import { useDownloads } from '../lib/downloads';
import { desktop } from '../lib/desktop';
import { useStore } from '../lib/store';

type Track = { file: string; label: string; language: string; default?: boolean };

type Metadata = {
  tracks?: Track[];
  intro?: { start: number; end: number };
  outro?: { start: number; end: number };
};

/**
 * A downloaded episode, on the same watch page as a streamed one: same player,
 * same skip data, same resume history. Only the media source differs (the
 * local playlist served by the loopback relay).
 */
export const LocalPlayer = () => {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { items, localUrl, metadata, info, thumbUrl, posterUrl } = useDownloads();
  const { getProgress, settings } = useStore();
  const [data, setData] = useState<Metadata | null>(null);
  const [error, setError] = useState<string | null>(null);

  const item = items.find((entry) => entry.id === id) ?? null;
  const base = info?.proxyUrl ?? '';

  // Other downloaded episodes of the same title, for next/previous.
  const siblings = useMemo(() => {
    if (!item) return [];
    return items
      .filter(
        (entry) =>
          entry.status === 'complete' &&
          entry.episode !== item.episode &&
          (entry.slug === item.slug || (item.malId > 0 && entry.malId === item.malId))
      )
      .sort((a, b) => a.episode - b.episode);
  }, [items, item]);

  const next = item ? siblings.find((entry) => entry.episode > item.episode) : undefined;
  const prev = item ? [...siblings].reverse().find((entry) => entry.episode < item.episode) : undefined;

  const progress = item ? getProgress(item.slug, item.episode) : undefined;
  const startAt = progress?.completed ? 0 : progress?.currentTime;

  useEffect(() => {
    metadata(id).then((value) => setData((value as Metadata) ?? null));
  }, [id, metadata]);

  /** Hands the saved playlist file to the external player, when configured. */
  const openExternalCopy = async () => {
    try {
      const playlist = await desktop.localPlaylistPath(id);
      await desktop.openFile(playlist);
    } catch {
      setError('Could not open the external player — check it is installed.');
    }
  };

  if (!item) {
    return (
      <Shell>
        <div className="content-column mx-auto w-full px-4 py-6">
          <p className="font-body text-sm text-twist-lightgray">
            This episode is not in your downloads.
          </p>
          <Link
            href="/downloads"
            className="mt-4 inline-flex h-9 items-center rounded bg-twist-800 px-3 font-body text-xs text-gray-300 border border-transparent hover:border-twist-gray"
          >
            Open downloads
          </Link>
        </div>
      </Shell>
    );
  }

  const poster = thumbUrl(item) || posterUrl(item);
  const subtitles = (data?.tracks ?? []).map((track) => ({
    url: `${base}/downloads/${item.id}/${track.file}`,
    label: track.label || 'Subtitles',
    language: track.language || 'en',
    isDefault: Boolean(track.default),
  }));

  return (
    <Shell>
      <div className="content-column mx-auto w-full px-4 py-2">
        <nav className="mb-3 mt-2 flex flex-wrap items-center gap-2 font-body text-sm">
          <Link href="/downloads" className="text-twist-lightgray transition duration-200 hover:text-gray-200">
            Downloads
          </Link>
          <span className="text-twist-lightgray">›</span>
          {item.slug ? (
            <Link
              href={`/downloads/${encodeURIComponent(item.slug)}`}
              className="min-w-0 truncate text-gray-200 transition duration-200 hover:text-white"
            >
              {item.title}
            </Link>
          ) : (
            <span className="min-w-0 truncate text-gray-200">{item.title}</span>
          )}
          <span className="text-twist-lightgray">›</span>
          <span className="font-bold text-twist-red">
            Episode {item.episode}
            <span className="ml-2 rounded bg-twist-800 px-1.5 py-0.5 font-body text-[9px] uppercase tracking-wide text-twist-lightgray">
              Offline · {item.kind.toUpperCase()}
            </span>
          </span>
        </nav>

        {error ? (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded bg-twist-800 p-6 text-center">
            <span className="font-body text-sm text-twist-white">{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="rounded bg-twist-800 px-3 h-8 font-body text-xs text-gray-300 transition duration-200 hover:border-twist-gray border border-transparent"
            >
              Dismiss
            </button>
          </div>
        ) : item.status !== 'complete' ? (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded bg-twist-800 p-6 text-center">
            <Artwork sources={[poster]} alt="" className="absolute inset-0 opacity-20" />
            <span className="relative font-body text-sm text-twist-lightgray">
              This episode is still {item.status}. Finish the download to watch it offline.
            </span>
          </div>
        ) : settings.player !== 'builtin' ? (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded bg-twist-800 p-6 text-center">
            <span className="font-body text-sm text-twist-white">
              Playing in {settings.player === 'system' ? 'your default player' : settings.player.toUpperCase()}
            </span>
            <span className="font-body text-xs text-twist-lightgray">
              Episode {item.episode} · saved on this device
            </span>
            <button
              type="button"
              onClick={() => void openExternalCopy()}
              className="rounded bg-twist-red px-3 h-8 font-body text-xs text-gray-100 transition duration-200 hover:bg-twist-reddark"
            >
              Open again
            </button>
          </div>
        ) : (
          <VideoPlayer
            key={item.id}
            src={localUrl(item)}
            poster={poster}
            posterSources={[poster, posterUrl(item)]}
            subtitles={subtitles}
            slug={item.slug || `mal-${item.malId}`}
            episode={item.episode}
            episodeLength={undefined}
            fallbackSkip={{ op: data?.intro, ed: data?.outro }}
            title={`${item.title} Episode ${item.episode}`}
            startAt={startAt}
            onEnded={() => next && navigate(`/offline/${next.id}`)}
            onNext={next ? () => navigate(`/offline/${next.id}`) : undefined}
            onPrev={prev ? () => navigate(`/offline/${prev.id}`) : undefined}
            resumeKey={`offline:${item.id}`}
            kind={item.kind === 'dub' ? 'dub' : 'sub'}
            showIntro={false}
          />
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {settings.player !== 'builtin' && (
            <button
              type="button"
              onClick={() => void openExternalCopy()}
              className="flex h-9 items-center rounded bg-twist-800 px-3 font-body text-xs text-gray-300 border border-transparent transition duration-200 hover:border-twist-gray"
            >
              Play in {settings.player === 'system' ? 'default app' : settings.player.toUpperCase()}
            </button>
          )}
          <button
            type="button"
            onClick={() => void desktop.openDownloadsFolder()}
            className="flex h-9 items-center rounded bg-twist-800 px-3 font-body text-xs text-gray-300 border border-transparent transition duration-200 hover:border-twist-gray"
          >
            Open folder
          </button>
          <span className="font-body text-[11px] text-twist-lightgray">
            Playing from disk · {item.kind.toUpperCase()}
            {item.quality && item.quality !== 'auto' ? ` · ${item.quality}` : ''}
          </span>
        </div>

        <PlayerToggles />

        <div className="mt-3 mb-2 flex flex-col border-y border-twist-800 pb-4 pt-3">
          <span className="font-body text-2xl text-twist-white">{item.title}</span>
          <span className="text-twist-white text-xs">
            Episode {item.episode}
            {item.totalEpisodes ? ` of ${item.totalEpisodes}` : ''}
          </span>
        </div>

        {siblings.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {siblings.map((entry) => (
              <Link
                key={entry.id}
                href={`/offline/${entry.id}`}
                className={`flex h-9 min-w-9 items-center justify-center rounded border px-2 font-body text-xs transition duration-200 ${
                  entry.episode === item.episode
                    ? 'border-twist-gray bg-twist-800 text-twist-white'
                    : 'border-transparent bg-twist-800 text-twist-lightgray hover:border-twist-gray'
                }`}
              >
                {entry.episode}
              </Link>
            ))}
          </div>
        )}
      </div>
    </Shell>
  );
};
