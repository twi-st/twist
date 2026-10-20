import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Shell } from '../components/Shell';
import { Artwork } from '../components/Artwork';
import { VideoPlayer } from '../components/VideoPlayer';
import { PlayerToggles } from '../components/PlayerToggles';
import { Comments } from '../components/Comments';
import { EpisodeGrid, NextEpisodeCard } from '../components/EpisodeGrid';
import { useStore } from '../lib/store';
import { useDownloads } from '../lib/downloads';
import { desktop, type KumaStatus, type ProviderInfo, type TorrentCandidate } from '../lib/desktop';
import {
  detailPosters,
  getEpisodePage,
  titleOf,
  type AnimeDetail,
  type EpisodeEntry,
} from '../lib/anime';
import {
  StreamUnavailableError,
  StreamTimeoutError,
  forgetStream,
  freshStream,
  warmTracks,
  type EpisodeStream,
  type StreamKind,
} from '../lib/streams';

/*
 * One server only for now: it resolves megaplay sources through the Go side.
 * The UI calls it "neko"; the provider's own name is an implementation detail.
 * Sub and dub are separate rows, each listing the servers that have that
 * audio track.
 */
const SERVER_NAME = 'neko';

/**
 * Consent controls for Kuma: explains the torrent trade-off, reports whether
 * ffmpeg is present, and offers the in-app download when it is not.
 */
const KumaConsent = ({
  onCancel,
  onEnable,
}: {
  onCancel: () => void;
  onEnable: () => Promise<void>;
}) => {
  const [status, setStatus] = useState<KumaStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    desktop.kumaStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      await desktop.downloadFFmpeg();
      setStatus(await desktop.kumaStatus());
    } catch (failure) {
      setError((failure as Error).message || 'ffmpeg download failed');
    } finally {
      setBusy(false);
    }
  };

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      const current = (await desktop.getKumaSettings()) ?? {
        enabled: false,
        ffmpegPath: '',
        cacheDir: '',
        cacheLimitMB: 20480,
        segmentSeconds: 6,
        listenPort: 0,
      };
      await desktop.saveKumaSettings({ ...current, enabled: true });
      await onEnable();
    } catch (failure) {
      setError((failure as Error).message || 'could not enable Kuma');
    } finally {
      setBusy(false);
    }
  };

  const ffmpeg = status?.ffmpeg;

  return (
    <div className="mt-4 flex flex-col gap-3">
      <div className="rounded border border-twist-800 bg-twist-800/40 px-3 py-2 font-body text-[11px] text-twist-lightgray">
        {ffmpeg?.available
          ? `ffmpeg found: ${ffmpeg.path}`
          : 'ffmpeg was not found on this machine — it is required to transcode the torrent.'}
      </div>
      {error && <p className="font-body text-[11px] text-red-400">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded bg-twist-800 px-3 h-8 font-body text-xs text-gray-300 border border-transparent transition duration-200 hover:border-twist-gray"
        >
          Not now
        </button>
        {!ffmpeg?.available && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void install()}
            className="rounded bg-twist-800 px-3 h-8 font-body text-xs text-gray-300 border border-transparent transition duration-200 hover:border-twist-gray disabled:opacity-50"
          >
            {busy ? 'Working...' : 'Download ffmpeg'}
          </button>
        )}
        <button
          type="button"
          disabled={busy || !ffmpeg?.available}
          onClick={() => void enable()}
          className="rounded bg-twist-red px-3 h-8 font-body text-xs text-gray-100 transition duration-200 hover:bg-twist-reddark disabled:opacity-50"
        >
          Enable Kuma
        </button>
      </div>
    </div>
  );
};

const FlagGlyph = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    aria-hidden="true"
    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-twist-red"
  >
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 3v18M6 4h11l-1.5 3.5L17 11H6" />
  </svg>
);

/**
 * Download split-button: the main face saves at the best quality, the chevron
 * opens the renditions the source advertised so the size can be chosen.
 */
const DownloadButton = ({
  available,
  qualities,
  busy,
  done,
  label,
  onPick,
}: {
  available: boolean;
  qualities: string[];
  busy: boolean;
  done: boolean;
  label: string;
  onPick: (quality: string) => void | Promise<void>;
}) => {
  const [open, setOpen] = useState(false);
  const choices = ['auto', ...qualities];
  const disabled = !available || busy || done;

  return (
    <div className="relative flex">
      <button
        type="button"
        disabled={disabled}
        onClick={() => void onPick('auto')}
        className="flex h-9 items-center gap-2 rounded-l bg-twist-800 px-3 border border-transparent transition duration-200 hover:border-twist-gray disabled:cursor-not-allowed disabled:opacity-50"
        title={available ? 'Save this episode for offline viewing' : 'Downloads need the desktop app'}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 text-twist-lightgray" aria-hidden="true">
          <path d="M12 3a1 1 0 011 1v9.59l3.3-3.3a1 1 0 111.4 1.42l-5 5a1 1 0 01-1.4 0l-5-5a1 1 0 111.4-1.42l3.3 3.3V4a1 1 0 011-1zM5 19a1 1 0 011-1h12a1 1 0 110 2H6a1 1 0 01-1-1z" />
        </svg>
        <span className="font-body text-xs text-gray-300">
          {!available
            ? 'Desktop only'
            : done
              ? 'Downloading...'
              : busy
                ? 'Starting...'
                : `Download ${label.toUpperCase()}`}
        </span>
      </button>

      <button
        type="button"
        disabled={disabled}
        aria-label="Choose quality"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex h-9 w-7 items-center justify-center rounded-r border-l border-twist-900 bg-twist-800 transition duration-200 hover:bg-twist-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5 text-twist-lightgray">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-40 mt-1 w-32 overflow-hidden rounded border border-twist-700 bg-twist-900 shadow-xl">
            {choices.map((quality) => (
              <button
                key={quality}
                type="button"
                onClick={() => {
                  setOpen(false);
                  void onPick(quality);
                }}
                className="block w-full px-3 py-1.5 text-left font-body text-xs text-gray-300 transition duration-200 hover:bg-twist-800 hover:text-gray-100"
              >
                {quality === 'auto' ? 'Best available' : quality}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

export const AnimePage = ({
  anime,
  slug,
  episode: episodeParam,
  resumeAt,
}: {
  anime: AnimeDetail;
  slug: string;
  episode: number;
  /** Exact position to resume from (from the route, which knows every key). */
  resumeAt?: number;
}) => {
  const { getProgress, toggleCompleted, settings, updateSettings, progress: history } = useStore();
  const downloads = useDownloads();
  const [downloadState, setDownloadState] = useState<'idle' | 'working' | 'done'>('idle');

  /*
   * Episode changes are handled in place (`pushState` + state) instead of a
   * route change: the player element survives, so fullscreen survives
   * auto-next and the next episode just starts. A real navigation (link,
   * reload) still shows up as a changed param and wins.
   */
  const [localEpisode, setLocalEpisode] = useState<{ base: number; value: number } | null>(null);
  const episode =
    localEpisode && localEpisode.base === episodeParam ? localEpisode.value : episodeParam;
  /** Last episode this page navigated to, so a duplicate call is a no-op. */
  const goToRef = useRef<number | null>(null);

  const total = anime.episodes;
  const title = titleOf(anime.titles, settings.titleLanguage) || slug;
  const malId = typeof anime.ids.mal === 'number' ? anime.ids.mal : null;
  // Episode stills are the right backdrop; fall back to the title poster.
  const fallbackPoster = anime.images.posters[0]?.url;
  const coverCandidates = detailPosters(anime);
  // External player selected in settings: the built-in one is skipped entirely.
  const external = settings.player !== 'builtin';

  // A saved copy of this very episode works even with the stream unavailable.
  const saved = downloads.items.find(
    (entry) =>
      entry.status === 'complete' &&
      entry.episode === episode &&
      (entry.slug === slug || (malId !== null && entry.malId === malId))
  );

  // One intro per visit, however often the source is switched.
  const [introDone, setIntroDone] = useState(false);
  // Default audio follows the preference until the viewer switches manually.
  const [kind, setKind] = useState<StreamKind>(settings.defaultTrack);
  const kindTouched = useRef(false);
  const [dubAvailable, setDubAvailable] = useState(false);
  // Mirrors offered by the desktop side ("ahiru", "inu", ...). The viewer
  // picks one here; its sub-servers are switched inside the player.
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState<string | null>(null);
  const [server, setServer] = useState<string>('1');
  /** Kuma is opt-in and local: show the consent dialog before first use. */
  const [kumaPrompt, setKumaPrompt] = useState(false);
  /** Releases shown when Kuma is set to "let me choose". */
  const [kumaReleases, setKumaReleases] = useState<TorrentCandidate[] | null>(null);
  const [kumaPick, setKumaPick] = useState<string | null>(null);
  const [stream, setStream] = useState<EpisodeStream | null>(null);
  /** Key of the source the current `stream` belongs to. */
  const [streamKey, setStreamKey] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  /** Which maintenance action is running (refresh / cache clear), for the icons. */
  const [maintenance, setMaintenance] = useState<'refresh' | 'cache' | null>(null);
  /** Bumped on every episode switch so the player pauses the old video. */
  const [pauseToken, setPauseToken] = useState(0);
  // Tied to the episode so a stale position never leaks into the next one.
  const [resume, setResume] = useState<{ key: string; at: number } | null>(null);

  const [currentEntry, setCurrentEntry] = useState<EpisodeEntry | null>(null);

  // Discover the mirrors once; the first one is the default.
  useEffect(() => {
    if (!desktop.available()) return;
    let active = true;
    desktop
      .providers()
      .then((list) => {
        if (!active) return;
        setProviders(list);
        setProvider((current) => current ?? list[0]?.id ?? null);
        // Match the player's first mirror on the Go side so downloads use it.
        if (list[0]) void desktop.selectProvider(list[0].id).catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const activeProvider = providers.find((entry) => entry.id === provider) ?? null;

  const pickProvider = async (id: string) => {
    if (id === 'kuma') {
      const settings = await desktop.getKumaSettings().catch(() => null);
      if (!settings?.enabled) {
        setKumaPrompt(true);
        return;
      }
    }
    // Leaving Kuma discards its release choice so the next visit starts fresh.
    if (id !== 'kuma') {
      setKumaReleases(null);
      setKumaPick(null);
    }
    setProvider(id);
    const entry = providers.find((candidate) => candidate.id === id);
    setServer(entry?.servers[0] ?? '1');
    void desktop.selectProvider(id).catch(() => undefined);
  };

  // Keep the Go side (used by downloads) on the same mirror/sub-server the
  // viewer picked in the player.
  useEffect(() => {
    if (!desktop.available() || !provider) return;
    void desktop.selectProvider(provider).catch(() => undefined);
    void desktop.selectServer(provider, server).catch(() => undefined);
  }, [provider, server]);

  // Just the episode being watched: its still and title (one request).
  useEffect(() => {
    let active = true;

    getEpisodePage(slug, Math.max(0, Math.floor((episode - 1) / 20) * 20), 1)
      .then((page) => {
        if (active) setCurrentEntry(page.items.find((entry) => entry.number === episode) ?? null);
      })
      .catch(() => {
        if (active) setCurrentEntry(null);
      });

    return () => {
      active = false;
    };
  }, [slug, episode]);

  const current = currentEntry;
  const poster = current?.thumbnail ?? fallbackPoster;
  const resumeKey = `${slug}:${episode}:${kind}:${reloadToken}`;

  // Episodes that are marked complete (accented in the chip grid).
  const completedEpisodes = useMemo(
    () =>
      new Set(
        history
          .filter((entry) => entry.slug === slug && entry.completed)
          .map((entry) => entry.episode)
      ),
    [history, slug]
  );

  /*
   * Resolve the stream (and re-resolve when the episode or audio track
   * changes). The previous episode is stopped immediately: until the new
   * source resolves the player area shows the new episode's still instead of
   * quietly continuing the old one.
   */
  const wantedKey = `${slug}:${episode}:${kind}:${provider ?? 'auto'}:${server}:${kumaPick ?? ''}:${reloadToken}`;
  useEffect(() => {
    if (malId === null) return;
    let active = true;
    setPauseToken((token) => token + 1);

    // Kuma has two modes: list the releases first (the viewer picks one), or
    // stream the best match straight away. Both go through the torrent engine;
    // neither may fall back to a mirror.
    const kuma = provider === 'kuma';
    if (kuma) setStreamError(null);

    // Sub and dub are independent requests, so they start together: the audio
    // buttons are known as soon as the first one lands, instead of waiting for
    // the requested track to finish and then asking about the other. Both are
    // cached by the stream layer, so the "dub" answer here is the same promise
    // playback would have used.
    if (!kuma) {
      const tracks = warmTracks(malId, episode, kind, provider ?? undefined);
      tracks.dub.then((available) => {
        if (!active) return;
        setDubAvailable(available);
        if (!available && kindTouched.current === false && kind === 'dub') setKind('sub');
      });
    }

    const resolve = (async () => {
      if (kuma && !kumaPick) {
        const current = await desktop.getKumaSettings().catch(() => null);
        if (current?.pickMode === 'choose') {
          const list = await desktop.kumaCandidates(
            malId,
            episode,
            kind,
            anime.durationSec ? anime.durationSec / 60 : 0
          );
          if (active) setKumaReleases(list);
          return null;
        }
      }
      if (!kuma) return freshStream(malId, episode, kind, provider ?? undefined);
      const stream = await desktop.resolveKumaStream(malId, episode, kind, kumaPick ?? '');
      return {
        kind: stream.kind === 'dub' ? ('dub' as const) : ('sub' as const),
        provider: stream.provider,
        server: stream.server,
        url: stream.url,
        qualities: stream.qualities ?? [],
        intro: stream.intro,
        outro: stream.outro,
        subtitles: (stream.subtitles ?? []).map((track) => ({
          url: track.url,
          label: track.label || 'English',
          language: track.language || 'en',
          isDefault: Boolean(track.default),
        })),
        resolvedAt: stream.resolvedAt || Date.now(),
      };
    })();

    resolve
      .then((value) => {
        if (!active || value === null) return;
        setStream(value);
        setStreamKey(wantedKey);
        setStreamError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setStream(null);
        setStreamKey(null);
        setStreamError(
          kuma
            ? (error as Error).message || 'Kuma could not start this episode.'
            : error instanceof StreamTimeoutError
              ? 'The sources did not answer in time - this episode is not missing, just slow right now. Try again.'
              : error instanceof StreamUnavailableError
                ? `This episode is not available in ${kind === 'dub' ? 'dub' : 'sub'}.`
                : 'Could not load this episode - try again.'
        );
      });

    return () => {
      active = false;
    };
  }, [malId, episode, kind, provider, server, kumaPick, reloadToken, wantedKey]);

  /** The resolved stream, only while it belongs to what is on screen. */
  const readyStream = streamKey === wantedKey ? stream : null;

  /** Why the external player could not be started, if it could not. */
  const [externalError, setExternalError] = useState<string | null>(null);

  // Choosing an external player means "play it there", so the episode is handed
  // over as soon as it resolves — no extra click. Each distinct stream opens
  // once; the button below covers re-opening it.
  const openedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!external || !readyStream) return;
    const key = `${readyStream.url}#${kind}`;
    if (openedRef.current === key) return;
    openedRef.current = key;
    setExternalError(null);
    void desktop
      .playExternal(readyStream.url)
      .catch((error: Error) =>
        setExternalError(error.message || 'Could not open the external player - check it is installed.')
      );
  }, [external, readyStream, kind]);

  const progress = getProgress(slug, episode);

  const goTo = useCallback(
    (next: number) => {
      if (next < 1) return;
      if (total !== null && next > total) return;
      // Never move twice for the same source: a stale ended event or a
      // double-invoked handler must not skip an episode.
      if (goToRef.current === next) return;
      goToRef.current = next;
      // Stop the current episode first; the next one starts when it is ready.
      setPauseToken((token) => token + 1);
      setNextEpisodeAt(null);
      window.history.pushState(null, '', `/${slug}/watch/${next}`);
      setLocalEpisode({ base: episodeParam, value: next });
    },
    [episodeParam, slug, total]
  );

  /*
   * Ctrl+S + digit selects sub server N, Ctrl+D + digit selects dub server N.
   *
   * The chord is armed for a couple of seconds instead of requiring Ctrl to
   * still be held on the digit: holding Ctrl through a two-key chord is
   * unreliable once the webview or the OS grabs the first combination, and a
   * missed digit looked like the shortcut simply did not work.
   */
  const chordRef = useRef<{ track: 'sub' | 'dub'; at: number } | null>(null);
  const switchKindRef = useRef<(next: StreamKind) => void>(() => undefined);
  useEffect(() => {
    const serversFor = (track: StreamKind) => {
      if (!activeProvider) return [] as string[];
      return activeProvider.servers;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;

      const key = event.key.toLowerCase();
      const chord = chordRef.current;

      if (event.ctrlKey && (key === 's' || key === 'd')) {
        event.preventDefault();
        chordRef.current = { track: key === 's' ? 'sub' : 'dub', at: Date.now() };
        return;
      }

      // A digit right after the chord selects a server. Ctrl may already have
      // been released, so only the armed chord is checked.
      if (chord && Date.now() - chord.at < 2500) {
        const index = Number(event.key) - 1;
        const list = serversFor(chord.track);
        if (!Number.isInteger(index) || index < 0 || index >= list.length) {
          if (/^[0-9]$/.test(event.key)) chordRef.current = null;
          return;
        }
        event.preventDefault();
        chordRef.current = null;
        const next = list[index];
        if (chord.track === 'sub' && kind !== 'sub') switchKindRef.current('sub');
        if (chord.track === 'dub' && kind !== 'dub') switchKindRef.current('dub');
        setServer(next);
        void desktop.selectServer(activeProvider?.id ?? '', next).catch(() => undefined);
        return;
      }

      if (!event.ctrlKey) chordRef.current = null;
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeProvider, kind]);

  // Number keys pick a Kuma release while the chooser is open.
  useEffect(() => {
    if (kumaReleases === null || kumaPick) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
      if (event.key === 'Escape') {
        setKumaReleases(null);
        return;
      }
      const index = Number(event.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < Math.min(9, kumaReleases.length)) {
        event.preventDefault();
        setKumaPick(kumaReleases[index].infoHash);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [kumaReleases, kumaPick]);

  // Back / forward buttons move episodes too.
  useEffect(() => {
    const onPop = () => {
      const match = /\/watch\/(\d+)/.exec(window.location.pathname);
      if (match) setLocalEpisode({ base: episodeParam, value: Number(match[1]) });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [episodeParam]);

  /*
   * Auto-next countdown. The episode is already over when this starts: the
   * player only reports an ending once playback reached the end, so the wait
   * happens after the episode (cancelable) rather than delaying the transition
   * before it. "Next episode" during the outro skips straight away.
   */
  const [nextEpisodeAt, setNextEpisodeAt] = useState<number | null>(null);
  const [nextCountdown, setNextCountdown] = useState(settings.autoNextDelay);
  const cancelNext = useCallback(() => {
    setNextEpisodeAt(null);
    setNextCountdown(settings.autoNextDelay);
  }, [settings.autoNextDelay]);

  const handleEnded = useCallback(() => {
    if (!settings.autoNext) return;
    if (nextEpisodeAt === null) setNextEpisodeAt(Date.now());
  }, [nextEpisodeAt, settings.autoNext]);
  const handleNext = useCallback(() => goTo(episode + 1), [episode, goTo]);
  const handlePrev = useCallback(() => goTo(episode - 1), [episode, goTo]);

  // The countdown restarts whenever a new pending transition begins.
  const goToRef2 = useRef(goTo);
  goToRef2.current = goTo;

  useEffect(() => {
    if (nextEpisodeAt === null) return;
    setNextCountdown(settings.autoNextDelay);
    const started = Date.now();
    const timer = window.setInterval(() => {
      const left = settings.autoNextDelay - Math.floor((Date.now() - started) / 1000);
      setNextCountdown(Math.max(0, left));
      if (left <= 0) {
        window.clearInterval(timer);
        setNextEpisodeAt(null);
        goToRef2.current(episode + 1);
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [nextEpisodeAt, settings.autoNextDelay, episode]);

  /*
   * Switching audio tracks keeps the player mounted (so fullscreen survives)
   * and resumes from the last saved position.
   */
  const switchKind = (next: StreamKind) => {
    if (next === kind) return;
    kindTouched.current = true;
    setResume({ key: resumeKey, at: progress?.currentTime ?? 0 });
    setKind(next);
  };
  // The keyboard chord is registered once per provider, so it reaches the
  // current switcher through a ref instead of capturing a stale closure.
  switchKindRef.current = switchKind;

  const startAt =
    resume?.key === resumeKey
      ? resume.at
      : progress?.completed
        ? 0
        : (resumeAt ?? progress?.currentTime);

  const canPrev = episode > 1;
  const canNext = total === null || episode < total;

  return (
    <Shell>
      <div className="content-column mx-auto w-full px-4 py-2">
        {/* Home > Title > Episode */}
        <nav className="mb-3 mt-2 flex flex-wrap items-center gap-2 font-body text-sm">
          <Link href="/" className="text-twist-lightgray transition duration-200 hover:text-gray-200">
            Home
          </Link>
          <span className="text-twist-lightgray">â€º</span>
          <Link
            href={`/${slug}/info`}
            className="min-w-0 truncate text-gray-200 transition duration-200 hover:text-white"
          >
            {title}
          </Link>
          <span className="text-twist-lightgray">â€º</span>
          <span className="font-bold text-twist-red">
            Episode {episode}
            {current?.title ? ` Â· ${current.title}` : ''}
          </span>
        </nav>

        {malId === null ? (
          <div className="flex aspect-video w-full items-center justify-center rounded bg-twist-800 p-6 text-center">
            <span className="font-body text-sm text-twist-lightgray">
              No stream source is linked to this title yet.
            </span>
          </div>
        ) : streamError ? (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded bg-twist-800 p-6 text-center">
            <span className="font-body text-sm text-twist-white">{streamError}</span>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {saved && (
                <Link
                  href={`/offline/${saved.id}`}
                  className="rounded bg-twist-red px-3 h-8 font-body text-xs text-gray-100 transition duration-200 hover:bg-twist-reddark inline-flex items-center"
                >
                  Play downloaded copy
                </Link>
              )}
              <button
                type="button"
                onClick={() => {
                  setStreamError(null);
                  setReloadToken((token) => token + 1);
                }}
                className="rounded bg-twist-800 px-3 h-8 font-body text-xs text-gray-300 transition duration-200 hover:border-twist-gray border border-transparent"
              >
                Try again
              </button>
            </div>
          </div>
        ) : external ? (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded bg-twist-800 p-6 text-center">
            <span className="font-body text-sm text-twist-white">
              {externalError
                ? 'Could not open the external player'
                : `Playing in ${settings.player === 'system' ? 'your default player' : settings.player.toUpperCase()}`}
            </span>
            <span className="font-body text-xs text-twist-lightgray">
              {externalError ?? `Episode ${episode} · ${kind.toUpperCase()}`}
            </span>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (!readyStream) return;
                  void desktop
                    .playExternal(readyStream.url)
                    .then(() => setExternalError(null))
                    .catch((error: Error) =>
                      setExternalError(error.message || 'Could not open the external player - check it is installed.')
                    );
                }}
                className="rounded bg-twist-red px-3 h-8 font-body text-xs text-gray-100 transition duration-200 hover:bg-twist-reddark"
              >
                Open again
              </button>
              {saved && (
                <Link
                  href={`/offline/${saved.id}`}
                  className="rounded bg-twist-800 px-3 h-8 font-body text-xs text-gray-300 border border-transparent transition duration-200 hover:border-twist-gray inline-flex items-center"
                >
                  Play downloaded copy
                </Link>
              )}
              <button
                type="button"
                onClick={() => updateSettings({ player: 'builtin' })}
                className="rounded bg-twist-800 px-3 h-8 font-body text-xs text-gray-300 border border-transparent transition duration-200 hover:border-twist-gray"
              >
                Use built-in player
              </button>
            </div>
          </div>
        ) : provider === 'kuma' && kumaReleases !== null && !kumaPick ? (
          <div className="flex aspect-video w-full flex-col overflow-hidden rounded bg-twist-800">
            <div className="flex items-center justify-between border-b border-twist-800 px-3 py-2">
              <span className="font-body text-xs font-bold uppercase tracking-wide text-twist-red">
                Kuma releases
              </span>
              <span className="font-body text-[10px] text-twist-lightgray">
                Press 1–9 to pick · Esc cancels
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {kumaReleases.length === 0 ? (
                <p className="p-4 font-body text-xs text-twist-lightgray">
                  No torrents matched the quality and size limits. Raise them in Settings ? Kuma.
                </p>
              ) : (
                kumaReleases.slice(0, 9).map((release, index) => (
                  <button
                    key={release.infoHash + release.fileIdx}
                    type="button"
                    onClick={() => setKumaPick(release.infoHash)}
                    className="flex w-full items-center gap-3 border-b border-twist-800/60 px-3 py-2 text-left transition duration-200 hover:bg-twist-700/40"
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-twist-900 font-body text-[11px] text-twist-lightgray">
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-body text-xs text-gray-100">
                        {release.title || release.filename}
                      </span>
                      <span className="block truncate font-body text-[10px] text-twist-lightgray">
                        {[
                          release.quality,
                          release.size,
                          release.seeders ? `${release.seeders} seeders` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : !readyStream ? (
          // Switching episode/track: show the new episode's still while it loads.
          <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded bg-twist-800">
            <Artwork
              sources={[poster, ...coverCandidates]}
              alt=""
              className="absolute inset-0 h-full w-full opacity-40"
            />
            <span className="relative flex items-center gap-2 font-body text-xs text-twist-lightgray">
              <span className="block h-3.5 w-3.5 animate-spin rounded-full border-2 border-twist-gray/40 border-t-twist-lightgray" />
              Getting episode {episode} ready...
            </span>
          </div>
        ) : (
          <VideoPlayer
            key={slug}
            src={readyStream.url}
            poster={poster}
            posterSources={[poster, ...coverCandidates].filter(Boolean) as string[]}
            subtitles={readyStream.subtitles}
            renditions={readyStream.renditions}
            slug={slug}
            episode={episode}
            episodeLength={anime.durationSec ?? undefined}
            fallbackSkip={{ op: readyStream.intro, ed: readyStream.outro }}
            title={`${title} Episode ${episode}`}
            startAt={startAt}
            onEnded={handleEnded}
            onNext={handleNext}
            onPrev={handlePrev}
            resumeKey={resumeKey}
            pauseToken={pauseToken}
            kind={kind}
            servers={activeProvider?.servers ?? []}
            server={server}
            onServerChange={(next) => {
              setServer(next);
              void desktop
                .selectServer(activeProvider?.id ?? '', next)
                .catch(() => undefined);
            }}
            showIntro={!introDone}
            onIntroDone={() => setIntroDone(true)}
            subtitleSources={readyStream.subtitleSources}
            loadSubtitles={(source) => {
              if (malId === null) return Promise.resolve([]);
              return desktop.loadSubtitles(source, malId, episode).then((tracks) =>
                tracks.map((track) => ({
                  url: track.url,
                  label: track.label || 'English',
                  language: track.language || 'en',
                  isDefault: false,
                  source: track.source ?? source,
                }))
              );
            }}
            onStart={() => {
              // The CDN token is short-lived: refresh the link as playback begins.
              if (malId === null) return;
              void freshStream(malId, episode, kind, provider ?? undefined)
                .then((next) => {
                  setStream(next);
                  setStreamKey(wantedKey);
                })
                .catch(() => undefined);
            }}
          />
        )}

        {nextEpisodeAt !== null && (
          <div className="mt-2 flex flex-wrap items-center gap-3 rounded border border-twist-800 bg-twist-800/60 px-3 py-2">
            <span className="font-body text-xs text-gray-200">
              {canNext ? `Next episode in ${nextCountdown}s` : 'This was the last episode'}
            </span>
            {canNext && (
              <button
                type="button"
                onClick={() => {
                  cancelNext();
                  goTo(episode + 1);
                }}
                className="rounded bg-twist-red px-2.5 py-1 font-body text-[11px] text-gray-100 transition duration-200 hover:bg-twist-reddark"
              >
                Play now
              </button>
            )}
            <button
              type="button"
              onClick={cancelNext}
              className="rounded bg-twist-800 px-2.5 py-1 font-body text-[11px] text-gray-300 border border-transparent transition duration-200 hover:border-twist-gray"
            >
              Cancel
            </button>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <DownloadButton
            available={downloads.available}
            qualities={readyStream?.qualities ?? []}
            busy={downloadState === 'working'}
            done={downloadState === 'done'}
            label={kind}
            onPick={async (quality) => {
              if (malId === null) return;
              setDownloadState('working');
              const item = await downloads.add({
                malId,
                slug,
                title,
                poster: fallbackPoster ?? '',
                episodeThumb: poster ?? '',
                year: anime.season?.year ?? undefined,
                totalEpisodes: anime.episodes ?? undefined,
                episode,
                kind,
                quality,
              });
              setDownloadState(item ? 'done' : 'idle');
            }}
          />
          <span className="font-body text-[11px] text-twist-lightgray">
            Saved episodes play offline from the Downloads page.
          </span>
        </div>

        <div className="mt-3 flex items-start gap-2.5 rounded border-l-2 border-twist-red bg-twist-800/60 px-3 py-2.5">
          <FlagGlyph />
          <span className="font-body text-xs leading-relaxed text-gray-300">
            If the episode is not working, please report it and we will fix it as soon as possible.
          </span>
        </div>

        <PlayerToggles
          busy={maintenance !== null}
          onRefresh={() => {
            // Drop the memoised stream so the resolver runs again (a stale
            // token or a dead mirror is what usually needs this).
            if (malId === null) return;
            setStreamError(null);
            setMaintenance('refresh');
            forgetStream(malId, episode, kind, provider ?? undefined);
            setReloadToken((token) => token + 1);
            window.setTimeout(() => setMaintenance(null), 1200);
          }}
          onClearCache={async () => {
            if (malId === null) return;
            setMaintenance('cache');
            try {
              await desktop.clearEpisodeCache(provider ?? '', malId, episode, kind);
            } catch {
              /* nothing to report: the next play re-fetches anyway */
            }
            forgetStream(malId, episode, kind, provider ?? undefined);
            setReloadToken((token) => token + 1);
            setMaintenance(null);
          }}
        />

        {kumaPrompt && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Enable Kuma"
            className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4"
          >
            <div className="w-full max-w-md rounded-lg border border-twist-700 bg-twist-900 p-5 shadow-2xl">
              <h2 className="font-body text-lg text-gray-100">Kuma uses torrents</h2>
              <p className="mt-2 font-body text-xs leading-relaxed text-twist-lightgray">
                Kuma finds releases on Torrentio and streams them through a local torrent client.
                Your IP address is visible to other peers in the swarm, and playback needs
                <strong className="text-gray-200"> ffmpeg</strong> installed. This setting stays on
                this device and is never uploaded to your profile.
              </p>
              <KumaConsent
                onCancel={() => setKumaPrompt(false)}
                onEnable={async () => {
                  setKumaPrompt(false);
                  await pickProvider('kuma');
                }}
              />
            </div>
          </div>
        )}

        <div className="mt-3 flex flex-col gap-4 rounded-lg border border-twist-800 bg-twist-800/40 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0 flex-1">
            <p className="font-body text-[10px] uppercase tracking-wide text-twist-lightgray">
              You are watching
            </p>
            <p className="mt-0.5 font-body text-base font-bold text-gray-100">
              Episode {episode}
              {current?.title ? ` Â· ${current.title}` : ''}
            </p>
          </div>

          <div className="flex shrink-0 flex-col gap-2">
            {(['sub', 'dub'] as const)
              .filter((track) => track === 'sub' || dubAvailable)
              .map((track) => (
                <div key={track} className="flex items-center gap-2">
                  <span className="w-9 shrink-0 font-body text-xs font-bold text-twist-lightgray">
                    {track.toUpperCase()}:
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {providers.length === 0 ? (
                      <button
                        type="button"
                        onClick={() => switchKind(track)}
                        aria-pressed={kind === track}
                        className={`h-8 rounded border px-3 transition duration-200 ${
                          kind === track
                            ? 'border-transparent bg-twist-red'
                            : 'border-transparent bg-twist-800 hover:border-twist-gray'
                        }`}
                      >
                        <span
                          className={`font-body text-xs font-bold ${
                            kind === track ? 'text-gray-100' : 'text-twist-lightgray'
                          }`}
                        >
                          {SERVER_NAME}
                        </span>
                      </button>
                    ) : (
                      providers.map((entry) => (
                        <button
                          key={`${track}-${entry.id}`}
                          type="button"
                          onClick={() => {
                            if (kind !== track) switchKind(track);
                            if (provider !== entry.id) void pickProvider(entry.id);
                          }}
                          aria-pressed={kind === track && provider === entry.id}
                          className={`h-8 rounded border px-3 transition duration-200 ${
                            kind === track && provider === entry.id
                              ? 'border-transparent bg-twist-red'
                              : 'border-transparent bg-twist-800 hover:border-twist-gray'
                          }`}
                        >
                          <span
                            className={`font-body text-xs font-bold ${
                              kind === track && provider === entry.id
                                ? 'text-gray-100'
                                : 'text-twist-lightgray'
                            }`}
                          >
                            {entry.name.toLowerCase()}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              ))}
          </div>
        </div>

        <div className="mt-3 mb-2 flex flex-col border-y border-twist-800 pb-4 pt-3">
          <Link
            href={`/${slug}/info`}
            className="font-body text-2xl text-twist-white hover:text-gray-100"
          >
            {title}
          </Link>
          <span className="text-twist-white text-xs">
            Episode {episode}
            {total !== null ? ` of ${total}` : ''}
            {anime.season
              ? ` Â· ${anime.season.season.charAt(0)}${anime.season.season.slice(1).toLowerCase()} ${anime.season.year ?? ''}`
              : ''}
          </span>
        </div>

        <div className="mb-2 flex flex-col border-b border-twist-800 pb-4">
          <label className="flex cursor-pointer items-center">
            <input
              type="checkbox"
              className="plus-minus"
              checked={progress?.completed ?? false}
              onChange={() => toggleCompleted(slug, episode)}
            />
            <span className="ml-2 text-twist-white hover:text-white text-sm">Episode Complete</span>
          </label>

          <NextEpisodeCard
            nextEpisode={
              anime.nextEpisode
                ? { number: anime.nextEpisode.number, airsAt: anime.nextEpisode.airsAt }
                : null
            }
          />

          <EpisodeGrid
            slug={slug}
            total={total}
            nextEpisode={anime.nextEpisode?.number}
            completed={completedEpisodes}
            current={episode}
            focus={episode}
            onSelect={goTo}
          />
        </div>

        <Comments slug={slug} episode={episode} />
      </div>
    </Shell>
  );
};
