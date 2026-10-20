import { Call, Events } from '@wailsio/runtime';

/**
 * Bridge to the desktop (Go) side. Everything degrades gracefully: if the
 * bindings are missing — e.g. the frontend is opened in a plain browser — the
 * helpers report `available === false` and the app keeps using the web paths.
 */

export type PlayerTarget = 'builtin' | 'vlc' | 'mpv' | 'mpc' | 'mpcbe' | 'potplayer' | 'system';

/** One video player discovered on this machine. */
export type PlayerInfo = {
  id: string;
  name: string;
  path: string;
  streams: boolean;
  kind: string;
};

export type DesktopSettings = {
  cacheEnabled: boolean;
  cacheMaxMB: number;
  downloadsDir: string;
  maxConcurrentDownloads: number;
  /** Where playback happens; the Go side launches the external app. */
  player: PlayerTarget;
};

export type DesktopInfo = {
  version: string;
  platform: string;
  proxyUrl: string;
  cacheDir: string;
  downloadsDir: string;
  desktop: boolean;
};

export type CacheStats = {
  enabled: boolean;
  entries: number;
  bytes: number;
  maxMb: number;
};

export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'complete' | 'failed';

export type DownloadItem = {
  id: string;
  malId: number;
  slug: string;
  title: string;
  poster: string;
  /** Episode still from the catalogue, when the episode had one. */
  episodeThumb: string;
  /** File names inside the download directory (served through the relay). */
  localPoster: string;
  localThumb: string;
  year: number;
  totalEpisodes: number;
  episode: number;
  kind: 'sub' | 'dub' | 'hsub';
  quality: string;
  status: DownloadStatus;
  bytes: number;
  /** Total size advertised by the playlist, when known. */
  expectedBytes: number;
  segments: number;
  done: number;
  error: string;
  createdAt: number;
  updatedAt: number;
};

export type DesktopStream = {
  url: string;
  qualities: string[];
  subtitles: { url: string; label: string; language: string; default: boolean; source?: string }[];
  intro?: { start: number; end: number };
  outro?: { start: number; end: number };
  resolvedAt: number;
  kind: string;
  /** Mirror that served the stream ("ahiru", "inu", ...). */
  provider?: string;
  /** Sub-server inside that mirror. */
  server?: string;
  /** Advertised label ("1080p") to bits per second, for quality selection. */
  renditions?: Record<string, number>;
  /** Extra subtitle catalogues that can be loaded on demand. */
  subtitleSources?: { id: string; name: string; count: number }[];
};

/** One subtitle track, from the stream or from an extra catalogue. */
export type SubtitleEntry = {
  url: string;
  label: string;
  language: string;
  default: boolean;
  /** Catalogue it came from; empty for the stream's own subtitles. */
  source?: string;
};

/** One bandwidth measurement; `mbps` is the running median. */
export type SpeedResult = {
  mbps: number;
  bytes: number;
  at: number;
  samples: number;
  probeSize: number;
};

/** One mirror the desktop side can resolve episodes from. */
export type ProviderInfo = {
  id: string;
  name: string;
  /** Selectable sub-servers (empty when the mirror has only one). */
  servers: string[];
};

/** Kuma's torrent settings (local only, never synced). */
export type KumaSettings = {
  enabled: boolean;
  ffmpegPath: string;
  cacheDir: string;
  cacheLimitMB: number;
  segmentSeconds: number;
  listenPort: number;
  /** Size budget for a ~24 min episode; longer episodes scale it. */
  maxEpisodeMB: number;
  /** "closest" or "ask" when every release exceeds the budget. */
  ifNothingFits: 'closest' | 'ask';
  /** "best" or a concrete label like "1080p". */
  quality: string;
  /** "auto" streams the best match; "choose" lists releases in the player. */
  pickMode: 'auto' | 'choose';
};

export type FFmpegStatus = {
  available: boolean;
  path: string;
  version: string;
  managed: boolean;
  source: string;
};

export type KumaStatus = {
  enabled: boolean;
  ffmpeg: FFmpegStatus;
  cacheDir: string;
  error?: string;
};

/** Graphics stack as the app sees it, for the RTX Video diagnostics. */
export type VideoStatus = {
  platform: string;
  adapters: string[];
  highPerformanceGpu: boolean;
  webviewArgs: string[];
  superResolution: string;
};

export type TorrentCandidate = {
  infoHash: string;
  fileIdx: number;
  title: string;
  filename: string;
  quality: string;
  seeders: number;
  size: string;
  sizeBytes: number;
};

const SERVICE = 'twisted/internal/api.Service';

export const isDesktop = () =>
  typeof window !== 'undefined' && Boolean((window as { _wails?: unknown })._wails);

const call = async <T>(method: string, ...args: unknown[]): Promise<T> => {
  if (!isDesktop()) throw new Error('desktop bridge unavailable');
  return (await Call.ByName(`${SERVICE}.${method}`, ...args)) as T;
};

export const desktop = {
  available: isDesktop,

  info: () => call<DesktopInfo>('AppInfo'),

  getSettings: () => call<DesktopSettings>('GetSettings'),
  saveSettings: (settings: DesktopSettings) => call<DesktopSettings>('SaveSettings', settings),

  cacheStats: () => call<CacheStats>('CacheStats'),
  clearCache: () => call<number>('ClearCache'),
  /** Drops cached media for one episode (and stops its Kuma session). */
  clearEpisodeCache: (provider: string, malId: number, episode: number, kind: string) =>
    call<number>('ClearEpisodeCache', provider, malId, episode, kind),

  openDownloadsFolder: () => call<void>('OpenDownloadsFolder'),
  openCacheFolder: () => call<void>('OpenCacheFolder'),
  openExternal: (url: string) => call<void>('OpenExternal', url),
  quit: () => call<void>('Quit'),
  playExternal: (url: string) => call<void>('PlayExternal', url),
  openFile: (path: string) => call<void>('OpenFile', path),
  downloadsPath: (id: string) => call<string>('DownloadsPath', id),
  localPlaylistPath: (id: string) => call<string>('LocalPlaylistPath', id),
  listPlayers: () => call<PlayerInfo[]>('ListPlayers'),

  resolveStream: (malId: number, episode: number, kind: string, provider?: string) =>
    call<DesktopStream>('ResolveStream', malId, episode, kind, provider ?? ''),
  resolveKumaStream: (malId: number, episode: number, kind: string, infoHash: string) =>
    call<DesktopStream>('ResolveKumaStream', malId, episode, kind, infoHash),
  /** Loads one extra subtitle catalogue for the episode. */
  loadSubtitles: (source: string, malId: number, episode: number) =>
    call<SubtitleEntry[]>('LoadSubtitles', source, malId, episode),
  /** Measures the connection; cheap to call repeatedly, no-op while running. */
  measureSpeed: () => call<SpeedResult>('MeasureSpeed'),
  speedEstimate: () => call<SpeedResult>('SpeedEstimate'),
  recommendedQuality: (renditions: Record<string, number>) =>
    call<string>('RecommendedQuality', renditions),
  providers: () => call<ProviderInfo[]>('Providers'),
  getKumaSettings: () => call<KumaSettings>('GetKumaSettings'),
  saveKumaSettings: (next: KumaSettings) => call<KumaSettings>('SaveKumaSettings', next),
  kumaStatus: () => call<KumaStatus>('KumaStatus'),
  videoStatus: () => call<VideoStatus>('VideoStatus'),
  downloadFFmpeg: () => call<FFmpegStatus>('DownloadFFmpeg'),
  kumaCandidates: (malId: number, episode: number, kind: string, minutes = 0) =>
    call<TorrentCandidate[]>('KumaCandidates', malId, episode, kind, minutes),
  selectProvider: (id: string) => call<void>('SelectProvider', id),
  selectServer: (provider: string, server: string) => call<void>('SelectServer', provider, server),

  listDownloads: () => call<DownloadItem[]>('ListDownloads'),
  addDownload: (request: Partial<DownloadItem>) => call<DownloadItem>('AddDownload', request),
  pauseDownload: (id: string) => call<DownloadItem>('PauseDownload', id),
  resumeDownload: (id: string) => call<DownloadItem>('ResumeDownload', id),
  retryDownload: (id: string) => call<DownloadItem>('RetryDownload', id),
  removeDownload: (id: string) => call<void>('RemoveDownload', id),
  playUrl: (id: string) => call<string>('PlayDownload', id),
  downloadMetadata: (id: string) => call<Record<string, unknown>>('DownloadMetadata', id),

  onDownload: (handler: (item: DownloadItem) => void) => {
    if (!isDesktop()) return () => undefined;
    return Events.On('twist:download', (event) => {
      handler(event.data as DownloadItem);
    });
  },
};

/** Resolve a relative download path against the local relay. */
export const absoluteUrl = (base: string, path: string) => {
  if (!path) return path;
  if (/^https?:/i.test(path)) return path;
  return `${base.replace(/\/$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
};
