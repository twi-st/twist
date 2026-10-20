/**
 * Episode streams.
 *
 * On the desktop build the Go side does the resolving (megaplay + the local
 * relay), so playback URLs are plain loopback URLs with no CORS/token worries.
 * In a plain browser the original sekai + fetch-worker path is used, and the
 * desktop build falls back to it when Go reports a track missing — otherwise
 * dev (browser path) and production (Go path) disagreed about dubs.
 */
import createSekai from 'sekai/browser';

import { desktop, type DesktopStream } from './desktop';

/** The CORS relay the web build uses (strict fetch worker, no app logic). */
export const STREAM_WORKER = 'https://cors.chatbook.ink';

export type StreamKind = 'sub' | 'dub';

export type SubtitleTrack = {
  url: string;
  label: string;
  language: string;
  isDefault: boolean;
  /** Catalogue it came from; empty for the stream''s own subtitles. */
  source?: string;
};

export type EpisodeStream = {
  kind: StreamKind;
  /** Mirror that served the stream, when known ("ahiru", "inu", ...). */
  provider?: string;
  /** Sub-server inside that mirror. */
  server?: string;
  /** Master playlist for hls.js (CORS enabled, playlist rewritten). */
  url: string;
  /** Rendition labels the source advertises, highest first ("auto" implicit). */
  qualities: string[];
  /** Label ("1080p") to advertised bits per second, when the master says so. */
  renditions?: Record<string, number>;
  subtitles: SubtitleTrack[];
  /** Extra subtitle catalogues that can be loaded on demand. */
  subtitleSources?: { id: string; name: string; count: number }[];
  /** The stream's own intro/outro markers â€” the skip fallback when AniSkip is silent. */
  intro?: SkipRange;
  outro?: SkipRange;
  resolvedAt: number;
};

export type SkipRange = { start: number; end: number };

/** The stream simply does not exist for this episode (or audio track). */
export class StreamUnavailableError extends Error {
  constructor(kind: StreamKind, message = 'This episode is not available.') {
    super(message);
    this.name = 'StreamUnavailableError';
  }
}

/**
 * The sources did not answer in time. Distinct from "unavailable" on purpose:
 * a slow mirror is retryable, and telling the viewer the episode is missing
 * when it played a minute ago is what made a working episode look broken.
 */
export class StreamTimeoutError extends Error {
  constructor(kind: StreamKind, message = 'Stream sources timed out. Try again in a moment.') {
    super(message);
    this.name = 'StreamTimeoutError';
  }
}

const sekai = createSekai({ worker: STREAM_WORKER });

const streams = new Map<string, Promise<EpisodeStream>>();
const dubChecks = new Map<string, Promise<boolean>>();

const keyOf = (malId: number, episode: number, kind: StreamKind) => `${malId}:${episode}:${kind}`;

const missing = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  ((error as { status?: number }).status === 404 ||
    /not found|unavailable|invalid route/i.test(String((error as Error).message ?? '')));

/** The slice of a sekai source this app uses. */
type SekaiSource = {
  playback: { url: string };
  qualities: unknown[];
  intro?: { start?: number; end?: number } | null;
  outro?: { start?: number; end?: number } | null;
  subtitles: Array<{
    label?: string;
    language?: string;
    default?: boolean;
    playback: { url: string };
  }>;
};

const range = (value?: { start?: number; end?: number } | null): SkipRange | undefined =>
  value && typeof value.start === 'number' && typeof value.end === 'number' && value.end > value.start
    ? { start: value.start, end: value.end }
    : undefined;

const fromDesktop = (stream: DesktopStream): EpisodeStream => ({
  kind: stream.kind === 'dub' ? 'dub' : 'sub',
  provider: stream.provider,
  server: stream.server,
  url: stream.url,
  qualities: (stream.qualities ?? []).filter((label) => label && label !== 'auto'),
  renditions: stream.renditions,
  intro: range(stream.intro),
  outro: range(stream.outro),
  subtitleSources: stream.subtitleSources,
  subtitles: (stream.subtitles ?? []).map((track) => ({
    url: track.url,
    label: track.label || 'English',
    language: track.language || 'en',
    isDefault: Boolean(track.default),
    source: track.source,
  })),
  resolvedAt: stream.resolvedAt || Date.now(),
});

/** The browser/worker path, used by `vite dev` and as a fallback. */
const resolveViaSekai = async (
  malId: number,
  episode: number,
  kind: StreamKind
): Promise<EpisodeStream> => {
  try {
    const source = (await sekai.megaplay.resolve({
      malId,
      episode,
      type: kind,
    })) as SekaiSource;

    return {
      kind,
      url: source.playback.url,
      qualities: (source.qualities as Array<{ label?: string }>)
        .map((entry) => entry?.label)
        .filter((label): label is string => Boolean(label)),
      intro: range(source.intro),
      outro: range(source.outro),
      subtitles: (source.subtitles ?? []).map((track) => ({
        url: track.playback.url,
        label: track.label || 'English',
        language: track.language || 'en',
        isDefault: Boolean(track.default),
      })),
      resolvedAt: Date.now(),
    };
  } catch (error) {
    if (missing(error)) throw new StreamUnavailableError(kind);
    throw error;
  }
};

const resolve = async (
  malId: number,
  episode: number,
  kind: StreamKind,
  provider?: string
): Promise<EpisodeStream> => {
  if (desktop.available()) {
    try {
      return fromDesktop(await desktop.resolveStream(malId, episode, kind, provider));
    } catch (error) {
      const message = String((error as Error).message ?? '');

      // A timeout is not "this episode does not exist": the mirrors were slow.
      // Report it as retryable instead of showing "not available", and try the
      // browser resolver once, since it reaches the provider a different way.
      if (/timed out|timeout|deadline/i.test(message)) {
        try {
          return await resolveViaSekai(malId, episode, kind);
        } catch {
          throw new StreamTimeoutError(kind);
        }
      }

      // "Not found" from Go means the providers do not carry this track. The
      // browser path (what `vite dev` uses) sometimes still finds it — try it
      // before giving up, so dev and production agree. The chain reports both
      // "no provider had this episode" and "stream sources timed out"; only
      // the former means the track is really absent.
      if (/not available|not found|no provider had this episode|404/i.test(message)) {
        try {
          return await resolveViaSekai(malId, episode, kind);
        } catch {
          throw new StreamUnavailableError(kind);
        }
      }
      throw error;
    }
  }

  return resolveViaSekai(malId, episode, kind);
};

/** Episode stream for one audio track. Successful lookups are shared. */
export const resolveEpisodeStream = (
  malId: number,
  episode: number,
  kind: StreamKind,
  provider?: string
): Promise<EpisodeStream> => {
  // The provider is part of the key so switching servers re-resolves instead
  // of handing back the previous mirror's stream.
  const key = `${keyOf(malId, episode, kind)}:${provider ?? 'auto'}`;
  const cached = streams.get(key);
  if (cached) return cached;

  const promise = resolve(malId, episode, kind, provider).catch((error) => {
    // Failures are not cached â€” a flaky network should be retryable.
    streams.delete(key);
    throw error;
  });

  streams.set(key, promise);
  return promise;
};

/**
 * Drops a memoised stream so the next resolve really asks the provider again.
 * Used by the player's refresh / clear-cache buttons, where the cached answer
 * (or a stale CDN token) is exactly the thing being fixed.
 */
export const forgetStream = (
  malId: number,
  episode: number,
  kind: StreamKind,
  provider?: string
) => {
  streams.delete(`${keyOf(malId, episode, kind)}:${provider ?? 'auto'}`);
};

/** Whether the episode also has a dub, by actually asking for one. */export const hasDub = (malId: number, episode: number): Promise<boolean> => {
  const key = keyOf(malId, episode, 'dub');
  const cached = dubChecks.get(key);
  if (cached) return cached;

  const promise = resolveEpisodeStream(malId, episode, 'dub')
    .then(() => true)
    .catch(() => false);

  dubChecks.set(key, promise);
  return promise;
};

/**
 * Starts the sub and the dub at the same time.
 *
 * The player used to resolve the requested track and only then ask whether a
 * dub existed, which meant two full provider round-trips before the audio
 * buttons could be shown. Both tracks are independent requests, so they are
 * issued together and each result is cached exactly as a normal resolve would
 * be: whichever the viewer picks is already in flight (or done).
 *
 * `preferred` is the track the page intends to play; its promise is returned
 * separately so a dub failure can never break sub playback.
 */
export const warmTracks = (
  malId: number,
  episode: number,
  preferred: StreamKind,
  provider?: string
): { preferred: Promise<EpisodeStream>; dub: Promise<boolean> } => {
  const sub = resolveEpisodeStream(malId, episode, 'sub', provider);
  const dub = resolveEpisodeStream(malId, episode, 'dub', provider);

  // Neither promise may surface as unhandled: the caller only awaits the one
  // it needs, and the other settles in the background.
  sub.catch(() => undefined);
  dub.catch(() => undefined);

  return {
    preferred: preferred === 'dub' ? dub : sub,
    dub: dub.then(() => true).catch(() => false),
  };
};

/**
 * CDN tokens are short-lived. On desktop the Go resolver re-signs and rewrites
 * the playlist on every request, so a stale entry only matters for the web
 * build; both refresh on the same schedule.
 */
export const freshStream = async (
  malId: number,
  episode: number,
  kind: StreamKind,
  provider?: string,
  maxAgeMs = 60_000
): Promise<EpisodeStream> => {
  const key = `${keyOf(malId, episode, kind)}:${provider ?? 'auto'}`;
  const cached = streams.get(key);
  if (cached) {
    const stream = await cached.catch(() => null);
    if (stream && Date.now() - stream.resolvedAt < maxAgeMs) return stream;
  }
  streams.delete(key);
  return resolveEpisodeStream(malId, episode, kind, provider);
};
