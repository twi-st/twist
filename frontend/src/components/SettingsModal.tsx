import { useEffect, useState } from 'react';
import { useStore, type Settings, type Theme } from '../lib/store';
import { useDownloads } from '../lib/downloads';
import {
  desktop,
  type CacheStats,
  type DesktopSettings,
  type KumaSettings,
  type KumaStatus,
  type PlayerInfo,
  type VideoStatus,
} from '../lib/desktop';
import { AVATAR_SEEDS, CARD_PRESETS, avatarSeed, avatarUrl, badgesFor, cardPreset } from '../lib/profile';
import { BadgeRow } from './Badges';

/** Caption languages offered as the preferred default. */
const SUBTITLE_LANGUAGES: { code: string; label: string }[] = [
  { code: 'auto', label: 'Source default' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ru', label: 'Russian' },
  { code: 'ar', label: 'Arabic' },
  { code: 'ja', label: 'Japanese' },
];

/**
 * Kuma (torrent) settings. Everything here is stored locally in
 * %APPDATA%/Twist/kuma.json and is deliberately never synced to the cloud.
 */
const KumaSettingsPanel = ({ available }: { available: boolean }) => {
  const [settings, setSettings] = useState<KumaSettings | null>(null);
  const [status, setStatus] = useState<KumaStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!available) return;
    const [current, next] = await Promise.all([
      desktop.getKumaSettings().catch(() => null),
      desktop.kumaStatus().catch(() => null),
    ]);
    setSettings(current);
    setStatus(next);
  };

  useEffect(() => {
    void load();
  }, [available]);

  const save = async (patch: Partial<KumaSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      await desktop.saveKumaSettings(next);
      setStatus(await desktop.kumaStatus());
    } catch (failure) {
      setError((failure as Error).message || 'could not save');
    }
  };

  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      await desktop.downloadFFmpeg();
      await load();
    } catch (failure) {
      setError((failure as Error).message || 'ffmpeg download failed');
    } finally {
      setBusy(false);
    }
  };

  if (!available || !settings) {
    return (
      <p className="font-body text-sm leading-relaxed text-twist-lightgray">
        Kuma streams torrents through the desktop app, so these options live there only.
      </p>
    );
  }

  const ffmpeg = status?.ffmpeg;

  return (
    <div className="flex flex-col">
      <Toggle
        label="Enable Kuma"
        hint="Torrent streaming, opt-in per device (never synced)"
        checked={settings.enabled}
        onChange={(value) => void save({ enabled: value })}
      />

      <div className="flex items-center justify-between gap-3 py-3">
        <span className="flex flex-col">
          <span className="font-body text-sm text-gray-200">ffmpeg</span>
          <span className="break-all font-body text-xs text-twist-lightgray">
            {ffmpeg?.available ? `${ffmpeg.source}: ${ffmpeg.path}` : 'not found — required for torrent playback'}
          </span>
        </span>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void install()}
            className="rounded bg-twist-800 px-3 py-1.5 font-body text-[11px] text-gray-300 border border-transparent transition duration-200 hover:border-twist-gray disabled:opacity-50"
          >
            {busy ? 'Downloading...' : ffmpeg?.available ? 'Reinstall' : 'Download'}
          </button>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded bg-twist-800 px-3 py-1.5 font-body text-[11px] text-gray-300 border border-transparent transition duration-200 hover:border-twist-gray"
          >
            Re-check
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between py-3">
        <span className="flex flex-col">
          <span className="font-body text-sm text-gray-200">Quality</span>
          <span className="font-body text-xs text-twist-lightgray">
            Releases at or below this quality are preferred
          </span>
        </span>
        <select
          value={settings.quality}
          onChange={(event) => void save({ quality: event.target.value })}
          className="rounded bg-twist-800 p-2 font-body text-sm text-gray-200 border border-transparent focus:border-twist-red focus:outline-none"
        >
          {['best', '2160p', '1440p', '1080p', '720p', '480p'].map((quality) => (
            <option key={quality} value={quality}>
              {quality === 'best' ? 'Best available' : quality}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center justify-between py-3">
        <span className="flex flex-col">
          <span className="font-body text-sm text-gray-200">Max size per episode</span>
          <span className="font-body text-xs text-twist-lightgray">
            Budget for ~24 min; longer episodes scale with length
          </span>
        </span>
        <select
          value={settings.maxEpisodeMB}
          onChange={(event) => void save({ maxEpisodeMB: Number(event.target.value) })}
          className="rounded bg-twist-800 p-2 font-body text-sm text-gray-200 border border-transparent focus:border-twist-red focus:outline-none"
        >
          {[300, 600, 900, 1200, 2000, 3500, 6000].map((size) => (
            <option key={size} value={size}>
              {size >= 1000 ? `${(size / 1000).toFixed(1)} GB` : `${size} MB`}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center justify-between py-3">
        <span className="flex flex-col">
          <span className="font-body text-sm text-gray-200">When nothing fits</span>
          <span className="font-body text-xs text-twist-lightgray">
            Every release exceeds the size budget
          </span>
        </span>
        <select
          value={settings.ifNothingFits}
          onChange={(event) =>
            void save({ ifNothingFits: event.target.value as KumaSettings['ifNothingFits'] })
          }
          className="rounded bg-twist-800 p-2 font-body text-sm text-gray-200 border border-transparent focus:border-twist-red focus:outline-none"
        >
          <option value="closest">Use the smallest release</option>
          <option value="ask">Ask me in the player</option>
        </select>
      </div>

      <div className="flex items-center justify-between py-3">
        <span className="flex flex-col">
          <span className="font-body text-sm text-gray-200">Release picking</span>
          <span className="font-body text-xs text-twist-lightgray">
            Auto-play the best match, or list every release in the player
          </span>
        </span>
        <select
          value={settings.pickMode}
          onChange={(event) => void save({ pickMode: event.target.value as KumaSettings['pickMode'] })}
          className="rounded bg-twist-800 p-2 font-body text-sm text-gray-200 border border-transparent focus:border-twist-red focus:outline-none"
        >
          <option value="auto">Best match automatically</option>
          <option value="choose">Let me choose in the player</option>
        </select>
      </div>

      <div className="flex items-center justify-between py-3">
        <span className="flex flex-col">
          <span className="font-body text-sm text-gray-200">Cache limit</span>
          <span className="font-body text-xs text-twist-lightgray">
            Torrent data and generated segments kept on disk
          </span>
        </span>
        <select
          value={settings.cacheLimitMB}
          onChange={(event) => void save({ cacheLimitMB: Number(event.target.value) })}
          className="rounded bg-twist-800 p-2 font-body text-sm text-gray-200 border border-transparent focus:border-twist-red focus:outline-none"
        >
          {[5120, 10240, 20480, 40960, 81920].map((size) => (
            <option key={size} value={size}>
              {size / 1024} GB
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center justify-between py-3">
        <span className="flex flex-col">
          <span className="font-body text-sm text-gray-200">Segment length</span>
          <span className="font-body text-xs text-twist-lightgray">
            Shorter segments start faster, longer ones seek smoother
          </span>
        </span>
        <select
          value={settings.segmentSeconds}
          onChange={(event) => void save({ segmentSeconds: Number(event.target.value) })}
          className="rounded bg-twist-800 p-2 font-body text-sm text-gray-200 border border-transparent focus:border-twist-red focus:outline-none"
        >
          {[2, 4, 6, 8, 10, 12].map((seconds) => (
            <option key={seconds} value={seconds}>
              {seconds}s
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center justify-between py-3">
        <span className="flex flex-col">
          <span className="font-body text-sm text-gray-200">Torrent port</span>
          <span className="font-body text-xs text-twist-lightgray">
            0 lets the OS choose; a fixed port helps peers reach you
          </span>
        </span>
        <input
          type="number"
          min={0}
          max={65535}
          value={settings.listenPort}
          onChange={(event) => void save({ listenPort: Number(event.target.value) })}
          className="w-24 rounded bg-twist-800 p-2 font-body text-sm text-gray-200 border border-transparent focus:border-twist-red focus:outline-none"
        />
      </div>

      <div className="flex flex-col gap-1 border-t border-twist-800 py-3">
        <span className="break-all font-body text-[11px] text-twist-lightgray">
          Cache: {settings.cacheDir}
        </span>
        <span className="font-body text-[11px] text-twist-lightgray">
          Settings file: kuma.json (local only)
        </span>
        {status?.error && <span className="font-body text-[11px] text-red-400">{status.error}</span>}
        {error && <span className="font-body text-[11px] text-red-400">{error}</span>}
      </div>
    </div>
  );
};

/** Players detected this session; the scan is not repeated per visit. */
let playerCache: PlayerInfo[] | null = null;

/** Fallback list until the desktop side reports what is actually installed. */
const PLAYERS: { value: Settings['player']; label: string }[] = [
  { value: 'builtin', label: 'Twist player' },
  { value: 'system', label: 'System default' },
];

const ACCENTS = [
  { value: '#d4433c', label: 'Red' },
  { value: '#e0574f', label: 'Coral' },
  { value: '#c2410c', label: 'Ember' },
  { value: '#7c3aed', label: 'Violet' },
  { value: '#2563eb', label: 'Blue' },
  { value: '#0d9488', label: 'Teal' },
  { value: '#16a34a', label: 'Green' },
  { value: '#ca8a04', label: 'Gold' },
];

const THEMES: { value: Theme; label: string; swatch: string }[] = [
  { value: 'dark', label: 'Dark', swatch: '#1d1f22' },
  { value: 'dim', label: 'Dim', swatch: '#24252a' },
  { value: 'midnight', label: 'Midnight', swatch: '#14161c' },
];

const TABS = [
  { id: 'playback', label: 'Playback' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'desktop', label: 'Desktop' },
  { id: 'kuma', label: 'Kuma' },
  { id: 'account', label: 'Account' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const Toggle = ({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) => (
  <label className="flex cursor-pointer items-center justify-between py-3">
    <span className="flex flex-col">
      <span className="font-body text-sm text-gray-200">{label}</span>
      <span className="font-body text-xs text-twist-lightgray">{hint}</span>
    </span>
    <input
      type="checkbox"
      className="plus-minus"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  </label>
);

const SLIDER =
  'h-1.5 w-full cursor-pointer appearance-none rounded-full bg-twist-700 accent-[var(--accent)]';

/** One labelled range control for the caption appearance editor. */
const CueSlider = ({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix: string;
  onChange: (value: number) => void;
}) => (
  <label className="flex flex-col gap-1 py-1.5">
    <span className="flex items-center justify-between font-body text-xs text-gray-300">
      <span>{label}</span>
      <span className="tabular-nums text-twist-lightgray">
        {value}
        {suffix}
      </span>
    </span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      className={SLIDER}
    />
  </label>
);

/** YouTube-style caption appearance: scale, colours, background, stroke, shadow. */
const SubtitleStyleEditor = () => {
  const { settings, updateSettings } = useStore();
  const cue = settings.subtitleStyle;
  const setCue = (patch: Partial<Settings['subtitleStyle']>) =>
    updateSettings({ subtitleStyle: { ...cue, ...patch } });

  const rgb = (hex: string) => {
    const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
    return match ? [match[1], match[2], match[3]].map((part) => parseInt(part, 16)).join(', ') : '0, 0, 0';
  };

  return (
    <div className="mt-2 border-t border-twist-800 pt-3">
      <span className="font-body text-sm text-gray-200">Subtitle appearance</span>
      <span className="mb-2 block font-body text-xs text-twist-lightgray">
        Applies to every episode, like YouTube's caption options.
      </span>

      <div
        className="mb-3 flex h-20 items-center justify-center rounded bg-black/80 px-3 text-center"
        aria-hidden="true"
      >
        <span
          className="font-body font-bold"
          style={{
            fontSize: `${0.95 * (cue.scale / 100) * 16}px`,
            color: cue.color,
            opacity: cue.opacity / 100,
            background: `rgba(${rgb(cue.background)}, ${cue.backgroundOpacity / 100})`,
            padding: '0 0.25em',
            borderRadius: 2,
            textShadow:
              cue.strokeSize > 0
                ? `${cue.strokeSize}px ${cue.strokeSize}px 0 ${cue.stroke}${
                    cue.shadow ? ', 0 2px 6px rgba(0,0,0,0.75)' : ''
                  }`
                : cue.shadow
                  ? '0 2px 6px rgba(0,0,0,0.75)'
                  : 'none',
          }}
        >
          Sample subtitle text
        </span>
      </div>

      <CueSlider label="Scale" value={cue.scale} min={50} max={250} suffix="%" onChange={(scale) => setCue({ scale })} />
      <CueSlider
        label="Opacity"
        value={cue.opacity}
        min={10}
        max={100}
        suffix="%"
        onChange={(opacity) => setCue({ opacity })}
      />
      <CueSlider
        label="Background opacity"
        value={cue.backgroundOpacity}
        min={0}
        max={100}
        suffix="%"
        onChange={(backgroundOpacity) => setCue({ backgroundOpacity })}
      />
      <CueSlider
        label="Stroke size"
        value={cue.strokeSize}
        min={0}
        max={6}
        suffix="px"
        onChange={(strokeSize) => setCue({ strokeSize })}
      />

      <div className="mt-2 flex flex-wrap items-center gap-4">
        {(
          [
            ['Text color', 'color'],
            ['Background color', 'background'],
            ['Stroke color', 'stroke'],
          ] as const
        ).map(([label, key]) => (
          <label key={key} className="flex items-center gap-2 font-body text-xs text-gray-300">
            <input
              type="color"
              value={cue[key]}
              onChange={(event) => setCue({ [key]: event.target.value })}
              aria-label={label}
              className="h-7 w-9 cursor-pointer rounded border border-twist-700 bg-twist-900"
            />
            {label}
          </label>
        ))}

        <label className="flex cursor-pointer items-center gap-2 font-body text-xs text-gray-300">
          <input
            type="checkbox"
            checked={cue.shadow}
            onChange={(event) => setCue({ shadow: event.target.checked })}
            className="plus-minus"
          />
          Shadow
        </label>
      </div>
    </div>
  );
};

/**
 * Settings page body. Rendered inside the app frame (TitleBar chrome stays
 * visible) — there is no modal wrapper; the route owns the scrolling.
 */
/**
 * Graphics diagnostics for RTX Video Super Resolution.
 *
 * VSR is decided by the driver, not the page: it only runs when the WebView2 GPU
 * process is on the NVIDIA adapter and the video is below the display's
 * resolution. On a laptop with an Intel/AMD iGPU this app requests the
 * high-performance GPU, and this panel reports what Windows sees so a silent
 * "inactive" can be diagnosed instead of guessed at.
 */
const GraphicsPanel = () => {
  const [status, setStatus] = useState<VideoStatus | null>(null);

  useEffect(() => {
    let active = true;
    desktop
      .videoStatus()
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="flex flex-col gap-1.5 border-t border-twist-800 py-3">
      <span className="font-body text-sm text-gray-200">Graphics &amp; RTX Video</span>
      <span className="break-all font-body text-[11px] text-twist-lightgray">
        {status
          ? status.adapters.length > 0
            ? status.adapters.join(' · ')
            : 'No display adapter reported'
          : 'Checking…'}
      </span>
      <span className="font-body text-[11px] text-twist-lightgray">
        High-performance GPU requested: {status?.highPerformanceGpu ? 'yes' : 'no'}
      </span>
      {status?.superResolution && (
        <span className="font-body text-[11px] leading-relaxed text-twist-lightgray">
          {status.superResolution}
        </span>
      )}
    </div>
  );
};

export const SettingsPage = ({ initialTab = 'playback' }: { initialTab?: TabId }) => {
  const { settings, updateSettings, account, level, xp, signOut, updateAccount, messages, watched } =
    useStore();
  const { available: desktopAvailable, settings: desktopSettings, saveSettings, info } = useDownloads();
  const [tab, setTab] = useState<TabId>(initialTab);
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [draft, setDraft] = useState<DesktopSettings | null>(null);
  const [clearing, setClearing] = useState(false);
  // Players actually installed on this machine, reported by the desktop side.
  // The scan is cached module-wide (and on the Go side) so opening settings
  // repeatedly does not re-probe the disk every time.
  const [detected, setDetected] = useState<PlayerInfo[]>(() => playerCache ?? []);

  useEffect(() => {
    if (!desktopAvailable || playerCache) return;
    let active = true;
    desktop
      .listPlayers()
      .then((players) => {
        playerCache = players;
        if (active) setDetected(players);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [desktopAvailable]);

  const playerOptions = [
    { value: 'builtin', label: 'Twist player' },
    ...detected.map((player) => ({ value: player.id, label: `${player.name} (${player.path})` })),
    { value: 'system', label: 'System default app' },
  ];
  // A saved player that is no longer installed stays visible so the choice is
  // obvious rather than silently switching.
  if (!playerOptions.some((option) => option.value === settings.player)) {
    playerOptions.splice(playerOptions.length - 1, 0, {
      value: settings.player,
      label: `${settings.player} (not found)`,
    });
  }

  useEffect(() => {
    if (!desktopAvailable) return;
    setDraft(desktopSettings);
  }, [desktopAvailable, desktopSettings]);

  // Cache stats are only needed on the Desktop tab, and only once.
  useEffect(() => {
    if (!desktopAvailable || tab !== 'desktop' || stats) return;
    void desktop.cacheStats().then(setStats).catch(() => undefined);
  }, [desktopAvailable, tab, stats]);

  const set = <K extends keyof Settings>(key: K) => (value: Settings[K]) =>
    updateSettings({ [key]: value } as Partial<Settings>);

  const badges = badgesFor({
    level,
    xp,
    messages: account
      ? messages.filter((message) => message.username === account.username).length
      : 0,
    watched,
  });

  return (
    <div className="content-column mx-auto w-full px-4 py-4">
      <div className="rounded-lg border border-twist-800 bg-twist-800/20">
        <div className="border-b border-twist-800 px-5 pt-5">
          <div className="flex items-center justify-between">
            <span className="font-body text-lg text-gray-200">Settings</span>
          </div>

          <div className="mt-4 flex gap-5">
            {TABS.map((item) => (
              <button
                key={item.id}
                onClick={() => setTab(item.id)}
                aria-selected={tab === item.id}
                className={`focus:outline-none -mb-px border-b-2 pb-2.5 font-body text-sm transition duration-200 ${
                  tab === item.id
                    ? 'border-twist-red text-gray-100'
                    : 'border-transparent text-twist-lightgray hover:text-gray-300'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-[260px] p-5">
          {tab === 'playback' && (
            <>
              <Toggle
                label="Autoplay"
                hint="Start playing as soon as an episode loads"
                checked={settings.autoplay}
                onChange={set('autoplay')}
              />
              <Toggle
                label="Auto next"
                hint="Play the next episode when one finishes"
                checked={settings.autoNext}
                onChange={set('autoNext')}
              />
              <Toggle
                label="Auto skip"
                hint="Jump over intros and outros the moment they start"
                checked={settings.autoSkip}
                onChange={set('autoSkip')}
              />

              <div className="mt-2 border-t border-twist-800">
                <div className="flex items-center justify-between py-3">
                  <span className="flex flex-col">
                    <span className="font-body text-sm text-gray-200">Controls</span>
                    <span className="font-body text-xs text-twist-lightgray">
                      Show the control bar only while hovering
                    </span>
                  </span>
                  <select
                    value={settings.controls}
                    onChange={(e) => set('controls')(e.target.value as Settings['controls'])}
                    className="rounded bg-twist-800 p-2 font-body text-sm text-gray-200 focus:outline-none focus:border-twist-red border border-transparent"
                  >
                    <option value="hover">On hover</option>
                    <option value="visible">Always visible</option>
                  </select>
                </div>

                <div className="flex items-center justify-between py-3">
                  <span className="flex flex-col">
                    <span className="font-body text-sm text-gray-200">Subtitle size</span>
                    <span className="font-body text-xs text-twist-lightgray">
                      Scale of burned-in captions
                    </span>
                  </span>
                  <select
                    value={settings.subtitles}
                    onChange={(e) =>
                      set('subtitles')(e.target.value as Settings['subtitles'])
                    }
                    className="rounded bg-twist-800 p-2 font-body text-sm text-gray-200 focus:outline-none focus:border-twist-red border border-transparent"
                  >
                    <option value="small">Small</option>
                    <option value="medium">Medium</option>
                    <option value="large">Large</option>
                  </select>
                </div>

                <div className="flex items-center justify-between py-3">
                  <span className="flex flex-col">
                    <span className="font-body text-sm text-gray-200">Subtitles in sub</span>
                    <span className="font-body text-xs text-twist-lightgray">
                      Remembered separately from the dub track
                    </span>
                  </span>
                  <Toggle
                    label=""
                    hint=""
                    checked={settings.subtitlesOn.sub}
                    onChange={(value) =>
                      updateSettings({ subtitlesOn: { ...settings.subtitlesOn, sub: value } })
                    }
                  />
                </div>

                <div className="flex items-center justify-between py-3">
                  <span className="flex flex-col">
                    <span className="font-body text-sm text-gray-200">Subtitles in dub</span>
                    <span className="font-body text-xs text-twist-lightgray">
                      Remembered separately from the sub track
                    </span>
                  </span>
                  <Toggle
                    label=""
                    hint=""
                    checked={settings.subtitlesOn.dub}
                    onChange={(value) =>
                      updateSettings({ subtitlesOn: { ...settings.subtitlesOn, dub: value } })
                    }
                  />
                </div>

                <div className="flex items-center justify-between py-3">
                  <span className="flex flex-col">
                    <span className="font-body text-sm text-gray-200">Default audio</span>
                    <span className="font-body text-xs text-twist-lightgray">
                      Which track plays when a title has both sub and dub
                    </span>
                  </span>
                  <select
                    value={settings.defaultTrack}
                    onChange={(e) =>
                      set('defaultTrack')(e.target.value as Settings['defaultTrack'])
                    }
                    className="rounded bg-twist-800 p-2 font-body text-sm text-gray-200 focus:outline-none focus:border-twist-red border border-transparent"
                  >
                    <option value="sub">Sub</option>
                    <option value="dub">Dub</option>
                  </select>
                </div>

                <div className="flex items-center justify-between py-3">
                  <span className="flex flex-col">
                    <span className="font-body text-sm text-gray-200">Subtitle language</span>
                    <span className="font-body text-xs text-twist-lightgray">
                      Preferred caption language when a track offers it
                    </span>
                  </span>
                  <select
                    value={settings.subtitleLanguage}
                    onChange={(e) => set('subtitleLanguage')(e.target.value)}
                    className="rounded bg-twist-800 p-2 font-body text-sm text-gray-200 focus:outline-none focus:border-twist-red border border-transparent"
                  >
                    {SUBTITLE_LANGUAGES.map((language) => (
                      <option key={language.code} value={language.code}>
                        {language.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center justify-between py-3">
                  <span className="flex flex-col">
                    <span className="font-body text-sm text-gray-200">Video player</span>
                    <span className="font-body text-xs text-twist-lightgray">
                      Use the built-in player or hand playback to an external app
                    </span>
                  </span>
                  <select
                    value={settings.player}
                    onChange={(e) => {
                      set('player')(e.target.value);
                      // The Go side launches the player, so keep its copy in sync.
                      if (draft) {
                        const next = { ...draft, player: e.target.value as DesktopSettings['player'] };
                        setDraft(next);
                        void saveSettings(next);
                      }
                    }}
                    className="max-w-[55%] rounded bg-twist-800 p-2 font-body text-sm text-gray-200 focus:outline-none focus:border-twist-red border border-transparent"
                  >
                    {playerOptions.map((player) => (
                      <option key={player.value} value={player.value}>
                        {player.label}
                      </option>
                    ))}
                  </select>
                </div>

                {settings.player !== 'builtin' && (
                  <p className="rounded border border-twist-800 bg-twist-800/40 px-3 py-2 font-body text-[11px] leading-relaxed text-twist-lightgray">
                    Episodes open in the external player; downloads open the saved file directly.
                    Playback position is not tracked there, so resume history only advances in the
                    built-in player.
                  </p>
                )}
                <div className="flex items-center justify-between py-3">
                  <span className="flex flex-col">
                    <span className="font-body text-sm text-gray-200">Auto-next delay</span>
                    <span className="font-body text-xs text-twist-lightgray">
                      Seconds to cancel before the next episode starts
                    </span>
                  </span>
                  <select
                    value={settings.autoNextDelay}
                    onChange={(e) => updateSettings({ autoNextDelay: Number(e.target.value) })}
                    className="rounded bg-twist-800 p-2 font-body text-sm text-gray-200 focus:outline-none focus:border-twist-red border border-transparent"
                  >
                    {[0, 5, 8, 10, 15, 20].map((seconds) => (
                      <option key={seconds} value={seconds}>
                        {seconds === 0 ? 'Immediately' : `${seconds}s`}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <SubtitleStyleEditor />
            </>
          )}

          {tab === 'appearance' && (
            <>
              <div className="flex flex-col py-3">
                <span className="font-body text-sm text-gray-200">Primary color</span>
                <span className="font-body text-xs text-twist-lightgray">
                  Used across the site and the player controls
                </span>

                <div className="mt-3 flex flex-wrap gap-2">
                  {ACCENTS.map((accent) => (
                    <button
                      key={accent.value}
                      onClick={() => set('accent')(accent.value)}
                      aria-label={accent.label}
                      title={accent.label}
                      className={`h-8 w-8 rounded-full border-2 transition duration-200 ${
                        settings.accent.toLowerCase() === accent.value
                          ? 'border-gray-100'
                          : 'border-transparent hover:border-twist-gray'
                      }`}
                      style={{ background: accent.value }}
                    />
                  ))}

                  <label
                    className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border-2 border-dashed border-twist-gray"
                    title="Custom color"
                  >
                    <span
                      className="h-5 w-5 rounded-full"
                      style={{ background: settings.accent }}
                    />
                    <input
                      type="color"
                      value={settings.accent}
                      onChange={(e) => set('accent')(e.target.value)}
                      aria-label="Custom primary color"
                      className="absolute h-0 w-0 opacity-0"
                    />
                  </label>
                </div>
              </div>

              <div className="flex flex-col py-3">
                <span className="font-body text-sm text-gray-200">Theme</span>
                <div className="mt-3 flex gap-3">
                  {THEMES.map((theme) => (
                    <button
                      key={theme.value}
                      onClick={() => set('theme')(theme.value)}
                      className={`flex flex-1 flex-col items-center gap-2 rounded border p-3 transition duration-200 ${
                        settings.theme === theme.value
                          ? 'border-twist-red bg-twist-800'
                          : 'border-transparent bg-twist-800/60 hover:border-twist-gray'
                      }`}
                    >
                      <span
                        className="h-6 w-6 rounded-full border border-twist-gray"
                        style={{ background: theme.swatch }}
                      />
                      <span className="font-body text-xs text-gray-300">{theme.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between py-3">
                <span className="flex flex-col">
                  <span className="font-body text-sm text-gray-200">Titles</span>
                  <span className="font-body text-xs text-twist-lightgray">
                    Show English names where a title has one
                  </span>
                </span>
                <select
                  value={settings.titleLanguage}
                  onChange={(e) =>
                    set('titleLanguage')(e.target.value as Settings['titleLanguage'])
                  }
                  className="rounded bg-twist-800 p-2 font-body text-sm text-gray-200 focus:outline-none focus:border-twist-red border border-transparent"
                >
                  <option value="romaji">Romaji (Japanese)</option>
                  <option value="english">English</option>
                </select>
              </div>

              <div className="flex items-center justify-between py-3">
                <span className="flex flex-col">
                  <span className="font-body text-sm text-gray-200">View mode</span>
                  <span className="font-body text-xs text-twist-lightgray">
                    How titles are shown on the home page
                  </span>
                </span>
                <select
                  value={settings.viewMode}
                  onChange={(e) => set('viewMode')(e.target.value as Settings['viewMode'])}
                  className="rounded bg-twist-800 p-2 font-body text-sm text-gray-200 focus:outline-none focus:border-twist-red border border-transparent"
                >
                  <option value="list">List</option>
                  <option value="cards">Cards</option>
                </select>
              </div>

              <div className="mt-2 border-t border-twist-800 pt-3">
                <span className="font-body text-[10px] font-bold uppercase tracking-wide text-twist-red">
                  Home page
                </span>
              </div>

              <Toggle
                label="Show logo"
                hint="The large Twist mark above the search box"
                checked={settings.homeLogo}
                onChange={(value) => set('homeLogo')(value)}
              />

              <Toggle
                label="Show search box"
                hint="The title bar keeps its own search either way"
                checked={settings.homeSearch}
                onChange={(value) => set('homeSearch')(value)}
              />

              <div className="flex items-center justify-between py-3">
                <span className="flex flex-col">
                  <span className="font-body text-sm text-gray-200">Content width</span>
                  <span className="font-body text-xs text-twist-lightgray">
                    Width of every page, not just the home list
                  </span>
                </span>
                <select
                  value={settings.homeWidth}
                  onChange={(e) => set('homeWidth')(Number(e.target.value))}
                  className="rounded bg-twist-800 p-2 font-body text-sm text-gray-200 focus:outline-none focus:border-twist-red border border-transparent"
                >
                  <option value={560}>Narrow</option>
                  <option value={672}>Default</option>
                  <option value={896}>Wide</option>
                  <option value={1152}>Extra wide</option>
                  <option value={1440}>Full</option>
                </select>
              </div>

              <div className="flex items-center justify-between py-3">
                <span className="flex flex-col">
                  <span className="font-body text-sm text-gray-200">Cards per row</span>
                  <span className="font-body text-xs text-twist-lightgray">
                    Applies to the card view
                  </span>
                </span>
                <select
                  value={settings.homeColumns}
                  onChange={(e) => set('homeColumns')(Number(e.target.value))}
                  className="rounded bg-twist-800 p-2 font-body text-sm text-gray-200 focus:outline-none focus:border-twist-red border border-transparent"
                >
                  {[2, 3, 4, 5, 6].map((count) => (
                    <option key={count} value={count}>
                      {count}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}

          {tab === 'kuma' && <KumaSettingsPanel available={desktopAvailable} />}

          {tab === 'desktop' && (
            <div className="flex flex-col">
              {!desktopAvailable || !draft ? (
                <p className="font-body text-sm leading-relaxed text-twist-lightgray">
                  These options are available in the desktop app. Cache and offline downloads
                  are handled by the local Go service; the browser build streams directly.
                </p>
              ) : (
                <>
                  <div className="flex items-center justify-between py-3">
                    <span className="flex flex-col">
                      <span className="font-body text-sm text-gray-200">External player</span>
                      <span className="font-body text-xs text-twist-lightgray">
                        Hand episodes to an installed app instead of the built-in player
                      </span>
                    </span>
                    <select
                      value={draft.player}
                      onChange={(event) => {
                        const next = { ...draft, player: event.target.value as DesktopSettings['player'] };
                        setDraft(next);
                        void saveSettings(next);
                      }}
                      className="rounded bg-twist-800 p-2 font-body text-sm text-gray-200 border border-transparent focus:border-twist-red focus:outline-none"
                    >
                      {playerOptions.map((player) => (
                        <option key={player.value} value={player.value}>
                          {player.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <Toggle
                    label="Stream cache"
                    hint="Keep recently played segments on disk so rewatches load instantly"
                    checked={draft.cacheEnabled}
                    onChange={(value) => {
                      const next = { ...draft, cacheEnabled: value };
                      setDraft(next);
                      void saveSettings(next);
                    }}
                  />

                  <div className="flex items-center justify-between py-3">
                    <span className="flex flex-col">
                      <span className="font-body text-sm text-gray-200">Cache limit</span>
                      <span className="font-body text-xs text-twist-lightgray">
                        Oldest segments are evicted beyond this size
                      </span>
                    </span>
                    <select
                      value={draft.cacheMaxMB}
                      onChange={(event) => {
                        const next = { ...draft, cacheMaxMB: Number(event.target.value) };
                        setDraft(next);
                        void saveSettings(next);
                      }}
                      className="rounded bg-twist-800 p-2 font-body text-sm text-gray-200 border border-transparent focus:border-twist-red focus:outline-none"
                    >
                      {[1024, 2048, 4096, 8192, 16384, 32768].map((size) => (
                        <option key={size} value={size}>
                          {size / 1024} GB
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex items-center justify-between py-3">
                    <span className="flex flex-col">
                      <span className="font-body text-sm text-gray-200">Concurrent downloads</span>
                      <span className="font-body text-xs text-twist-lightgray">
                        Episodes fetched at the same time
                      </span>
                    </span>
                    <select
                      value={draft.maxConcurrentDownloads}
                      onChange={(event) => {
                        const next = { ...draft, maxConcurrentDownloads: Number(event.target.value) };
                        setDraft(next);
                        void saveSettings(next);
                      }}
                      className="rounded bg-twist-800 p-2 font-body text-sm text-gray-200 border border-transparent focus:border-twist-red focus:outline-none"
                    >
                      {[1, 2, 3, 4].map((count) => (
                        <option key={count} value={count}>
                          {count}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-col gap-2 border-t border-twist-800 py-3">
                    <span className="font-body text-sm text-gray-200">Storage</span>
                    <span className="break-all font-body text-[11px] text-twist-lightgray">
                      Cache: {stats ? `${(stats.bytes / (1024 * 1024)).toFixed(0)} MB across ${stats.entries} files` : 'â€¦'}
                      {info?.cacheDir ? ` Â· ${info.cacheDir}` : ''}
                    </span>
                    <span className="break-all font-body text-[11px] text-twist-lightgray">
                      Downloads: {draft.downloadsDir}
                    </span>

                    <div className="mt-1 flex flex-wrap gap-2">
                      <button
                        onClick={() => void desktop.openDownloadsFolder()}
                        className="rounded bg-twist-800 px-3 py-1.5 font-body text-[11px] text-gray-300 border border-transparent hover:border-twist-gray"
                      >
                        Open downloads folder
                      </button>
                      <button
                        onClick={() => void desktop.openCacheFolder()}
                        className="rounded bg-twist-800 px-3 py-1.5 font-body text-[11px] text-gray-300 border border-transparent hover:border-twist-gray"
                      >
                        Open cache folder
                      </button>
                      <button
                        disabled={clearing}
                        onClick={async () => {
                          setClearing(true);
                          await desktop.clearCache().catch(() => undefined);
                          setStats(await desktop.cacheStats().catch(() => null));
                          setClearing(false);
                        }}
                        className="rounded bg-twist-800 px-3 py-1.5 font-body text-[11px] text-twist-lightgray border border-transparent hover:border-twist-gray hover:text-red-400 disabled:opacity-50"
                      >
                        {clearing ? 'Clearingâ€¦' : 'Clear cache'}
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1 border-t border-twist-800 py-3">
                    <span className="font-body text-xs text-twist-lightgray">
                      Twist {info?.version ?? ''} · {info?.platform ?? ''}
                    </span>
                    <span className="break-all font-mono text-[10px] text-twist-lightgray">
                      local relay {info?.proxyUrl ?? ''}
                    </span>
                  </div>

                  <GraphicsPanel />
                </>
              )}
            </div>
          )}

          {tab === 'account' &&
            (account ? (
              <div className="flex flex-col gap-5">
                <div className="overflow-hidden rounded border border-twist-800 bg-twist-800/40">
                  <div
                    className="h-10 w-full"
                    style={{ background: cardPreset(account.card).style }}
                  />
                  <div className="flex items-center gap-3 px-3">
                    <span className="-mt-5 flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-twist-900 bg-twist-800">
                      <img
                        src={avatarUrl(avatarSeed(account.username, account.avatar))}
                        alt={account.username}
                        className="h-full w-full object-cover"
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="flex items-center font-body text-sm text-gray-100">
                        <span className="truncate">{account.username}</span>
                        <span className="ml-2 shrink-0 rounded bg-twist-red px-1.5 py-0.5 text-[10px] font-bold leading-4 text-white">
                          {level}
                        </span>
                      </span>
                      <span className="mt-0.5 block font-body text-xs text-twist-lightgray">
                        Level {level} Â· {xp} XP Â· {watched} episodes
                      </span>
                    </div>
                  </div>
                  <div className="px-3 pb-3 pt-2">
                    <BadgeRow badges={badges} />
                  </div>
                </div>

                <div className="flex flex-col">
                  <span className="font-body text-sm text-gray-200">Avatar</span>
                  <span className="mb-2 font-body text-xs text-twist-lightgray">
                    Anime avatar shown in chat and on your profile.
                  </span>
                  <div className="grid grid-cols-8 gap-1.5">
                    {AVATAR_SEEDS.map((seed) => {
                      const active = avatarSeed(account.username, account.avatar) === seed;
                      return (
                        <button
                          key={seed}
                          onClick={() => updateAccount({ avatar: seed })}
                          aria-label={`Avatar ${seed}`}
                          className={`h-9 w-9 overflow-hidden rounded-full border-2 bg-twist-800 transition duration-150 ${
                            active
                              ? 'border-twist-red'
                              : 'border-transparent hover:border-twist-gray'
                          }`}
                        >
                          <img
                            src={avatarUrl(seed)}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="flex flex-col">
                  <span className="font-body text-sm text-gray-200">Profile card</span>
                  <span className="mb-2 font-body text-xs text-twist-lightgray">
                    Background of the card shown when someone hovers your name.
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {CARD_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        onClick={() => updateAccount({ card: preset.id })}
                        aria-label={preset.label}
                        title={preset.label}
                        className={`h-9 w-14 rounded border-2 transition duration-200 ${
                          (account.card ?? CARD_PRESETS[0].id) === preset.id
                            ? 'border-gray-100'
                            : 'border-transparent hover:border-twist-gray'
                        }`}
                        style={{ background: preset.style }}
                      />
                    ))}
                  </div>
                </div>

                <button
                  onClick={signOut}
                  className="focus:outline-none cursor-default self-start rounded bg-twist-800 px-3 h-9 border border-transparent transition duration-200 hover:border-twist-gray"
                >
                  <span className="font-body text-xs text-gray-300">Log out</span>
                </button>
              </div>
            ) : (
              <p className="font-body text-sm leading-relaxed text-twist-lightgray">
                You are not signed in. Use the chat panel to log in or create an
                account â€” your watched episodes and continue-watching list are tied
                to it.
              </p>
            ))}
        </div>
      </div>
    </div>
  );
};
