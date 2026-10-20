import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  desktop,
  isDesktop,
  type DesktopInfo,
  type DesktopSettings,
  type DownloadItem,
} from './desktop';

type DownloadsContext = {
  available: boolean;
  items: DownloadItem[];
  loading: boolean;
  info: DesktopInfo | null;
  settings: DesktopSettings | null;
  refresh: () => Promise<void>;
  add: (item: {
    malId: number;
    slug: string;
    title: string;
    poster: string;
    episodeThumb?: string;
    year?: number;
    totalEpisodes?: number;
    episode: number;
    kind: string;
    quality?: string;
  }) => Promise<DownloadItem | null>;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  saveSettings: (next: DesktopSettings) => Promise<void>;
  localUrl: (item: DownloadItem) => string;
  /** Artwork served from the download folder, falling back to the remote URL. */
  posterUrl: (item: DownloadItem) => string;
  thumbUrl: (item: DownloadItem) => string;
  metadata: (id: string) => Promise<Record<string, unknown> | null>;
};

const DownloadsCtx = createContext<DownloadsContext | null>(null);

export const DownloadsProvider = ({ children }: { children: ReactNode }) => {
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (!isDesktop()) {
      setLoading(false);
      return;
    }
    try {
      const [list, appInfo, current] = await Promise.all([
        desktop.listDownloads(),
        desktop.info(),
        desktop.getSettings(),
      ]);
      if (!mounted.current) return;
      setItems(list ?? []);
      setInfo(appInfo);
      setSettings(current);
    } catch {
      /* the bridge may not be ready yet */
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();

    const off = desktop.onDownload((item) => {
      setItems((prev) => {
        const next = prev.filter((entry) => entry.id !== item.id);
        return [item, ...next];
      });
    });

    return () => {
      mounted.current = false;
      off();
    };
  }, [refresh]);

  const add: DownloadsContext['add'] = useCallback(async (request) => {
    if (!isDesktop()) return null;
    try {
      const item = await desktop.addDownload({
        ...request,
        kind: request.kind as DownloadItem['kind'],
        quality: request.quality ?? 'auto',
      });
      setItems((prev) => [item, ...prev.filter((entry) => entry.id !== item.id)]);
      return item;
    } catch {
      return null;
    }
  }, []);

  const pause = useCallback(async (id: string) => {
    if (!isDesktop()) return;
    // Optimistic: the button flips to "Resume" immediately; the Go side
    // publishes the authoritative state right after.
    setItems((prev) =>
      prev.map((entry) => (entry.id === id ? { ...entry, status: 'paused' } : entry))
    );
    const saved = await desktop.pauseDownload(id).catch(() => null);
    if (saved) setItems((prev) => prev.map((entry) => (entry.id === id ? saved : entry)));
  }, []);

  const resume = useCallback(async (id: string) => {
    if (!isDesktop()) return;
    setItems((prev) =>
      prev.map((entry) => (entry.id === id ? { ...entry, status: 'queued' } : entry))
    );
    const saved = await desktop.resumeDownload(id).catch(() => null);
    if (saved) setItems((prev) => prev.map((entry) => (entry.id === id ? saved : entry)));
  }, []);

  const retry = useCallback(async (id: string) => {
    if (!isDesktop()) return;
    setItems((prev) =>
      prev.map((entry) => (entry.id === id ? { ...entry, status: 'queued', error: '' } : entry))
    );
    const saved = await desktop.retryDownload(id).catch(() => null);
    if (saved) setItems((prev) => prev.map((entry) => (entry.id === id ? saved : entry)));
  }, []);

  const remove = useCallback(async (id: string) => {
    if (!isDesktop()) return;
    await desktop.removeDownload(id).catch(() => undefined);
    setItems((prev) => prev.filter((entry) => entry.id !== id));
  }, []);

  const saveSettings = useCallback(async (next: DesktopSettings) => {
    if (!isDesktop()) return;
    const saved = await desktop.saveSettings(next);
    setSettings(saved);
  }, []);

  const localUrl = useCallback(
    (item: DownloadItem) => {
      const base = info?.proxyUrl ?? '';
      return `${base}/downloads/${item.id}/playlist.m3u8`;
    },
    [info]
  );

  const assetUrl = useCallback(
    (item: DownloadItem, file: string, remote: string) => {
      const base = info?.proxyUrl ?? '';
      return file && base ? `${base}/downloads/${item.id}/${file}` : remote;
    },
    [info]
  );

  const posterUrl = useCallback(
    (item: DownloadItem) => assetUrl(item, item.localPoster, item.poster),
    [assetUrl]
  );

  const thumbUrl = useCallback(
    (item: DownloadItem) => assetUrl(item, item.localThumb, item.episodeThumb || item.poster),
    [assetUrl]
  );

  const metadata = useCallback(async (id: string) => {
    if (!isDesktop()) return null;
    try {
      return await desktop.downloadMetadata(id);
    } catch {
      return null;
    }
  }, []);

  const value = useMemo<DownloadsContext>(
    () => ({
      available: isDesktop(),
      items,
      loading,
      info,
      settings,
      refresh,
      add,
      pause,
      resume,
      retry,
      remove,
      saveSettings,
      localUrl,
      posterUrl,
      thumbUrl,
      metadata,
    }),
    [
      items,
      loading,
      info,
      settings,
      refresh,
      add,
      pause,
      resume,
      retry,
      remove,
      saveSettings,
      localUrl,
      posterUrl,
      thumbUrl,
      metadata,
    ]
  );

  return <DownloadsCtx.Provider value={value}>{children}</DownloadsCtx.Provider>;
};

export const useDownloads = () => {
  const context = useContext(DownloadsCtx);
  if (!context) throw new Error('useDownloads must be used inside DownloadsProvider');
  return context;
};
