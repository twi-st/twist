import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MediaPlayer,
  MediaProvider,
  Captions,
  Spinner,
  PlayButton,
  MuteButton,
  FullscreenButton,
  Time,
  TimeSlider,
  VolumeSlider,
  isHLSProvider,
  useMediaPlayer,
  useMediaRemote,
  useMediaState,
  useVideoQualityOptions,
} from "@vidstack/react";
import {
  ReplayIcon,
  PlayIcon,
  PauseIcon,
  MuteIcon,
  VolumeLowIcon,
  VolumeHighIcon,
  FullscreenIcon,
  FullscreenExitIcon,
} from "@vidstack/react/icons";
import { useStore } from "../lib/store";
import { getSkipTimes, type SkipData } from "../lib/anime";
import { desktop } from "../lib/desktop";
import { useSpeedTest } from "../lib/speedtest";
import type { SubtitleTrack, StreamKind } from "../lib/streams";
import { IntroAnimation } from "./IntroAnimation";
import { Artwork } from "./Artwork";
/** The gear menu styles captions per audio track; the prop tells it which. */ type KindProp =
  { kind: StreamKind };
type Props = {
  /** Worker master playlist url (HLS). */ src: string;
  /** Episode still, or the title's poster when the episode has none. */ poster?: string;
  /** Additional cover candidates tried when the still/poster fails. */ posterSources?: string[];
  subtitles?: SubtitleTrack[];
  slug: string;
  episode: number;
  /** Episode length in seconds — lets AniSkip pick the matching variant. */ episodeLength?: number;
  /** The stream's own markers, used when AniSkip has nothing for the episode. */ fallbackSkip?: {
    op?: { start: number; end: number };
    ed?: { start: number; end: number };
  };
  /** Changes whenever the source changes (episode / audio / retry). */ resumeKey?: string;
  /** Which audio track this source is (subtitle visibility is remembered per track). */ kind?: StreamKind;
  /** Sub-servers offered by the active mirror (empty when it has one). */ servers?: string[];
  /** Currently selected sub-server. */ server?: string;
  onServerChange?: (server: string) => void;
  /** Increments when navigating: the current video pauses before the swap. */ pauseToken?: number;
  /** Navigation for the N / P shortcuts. */ onNext?: () => void;
  onPrev?: () => void;
  title: string;
  onEnded?: () => void;
  startAt?: number;
  /** Play the intro animation after the viewer starts this episode. */
  showIntro?: boolean;
  onIntroDone?: () => void;
  /** Called when playback is first requested, to refresh the stream token. */
  onStart?: () => void;
  /** Label ("1080p") to advertised bits per second, for quality selection. */
  renditions?: Record<string, number>;
  /** Extra subtitle catalogues the viewer can load on demand. */
  subtitleSources?: { id: string; name: string; count: number }[];
  /** Fetches one catalogue for this episode. */
  loadSubtitles?: (source: string) => Promise<SubtitleTrack[]>;
};

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/**
 * Which track starts enabled: the preferred language when the source offers
 * it, otherwise the source's own default, otherwise the first track.
 */
const isPreferredSubtitle = (track: SubtitleTrack, language: string) => {
  if (language && language !== "auto") {
    return track.language.toLowerCase().startsWith(language.toLowerCase());
  }
  return track.isDefault;
};
const TogglePlay = () => {
  const paused = useMediaState("paused");
  const ended = useMediaState("ended");
  return (
    <PlayButton className="vds-button" aria-label={ended ? "Replay" : "Play"}>
      {ended ? <ReplayIcon /> : paused ? <PlayIcon /> : <PauseIcon />}
    </PlayButton>
  );
};
const ToggleVolume = () => {
  const muted = useMediaState("muted");
  const volume = useMediaState("volume");
  return (
    <MuteButton className="vds-button" aria-label="Mute">
      {muted || volume === 0 ? (
        <MuteIcon />
      ) : volume < 0.5 ? (
        <VolumeLowIcon />
      ) : (
        <VolumeHighIcon />
      )}
    </MuteButton>
  );
};
const ToggleFullscreen = () => {
  const active = useMediaState("fullscreen");
  return (
    <FullscreenButton className="vds-button" aria-label="Fullscreen">
      {active ? <FullscreenExitIcon /> : <FullscreenIcon />}
    </FullscreenButton>
  );
};
const GearIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 20 20"
    fill="currentColor"
  >
    <path
      fillRule="evenodd"
      d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.53 1.53 0 01-2.29.95c-1.37-.84-2.94.73-2.1 2.1.54.89.06 2.05-.95 2.3-1.56.37-1.56 2.6 0 2.97a1.53 1.53 0 01.95 2.29c-.84 1.37.73 2.94 2.1 2.1a1.53 1.53 0 012.3.95c.37 1.56 2.6 1.56 2.97 0a1.53 1.53 0 012.29-.95c1.37.84 2.94-.73 2.1-2.1a1.53 1.53 0 01.95-2.3c1.56-.37 1.56-2.6 0-2.97a1.53 1.53 0 01-.95-2.29c.84-1.37-.73-2.94-2.1-2.1a1.53 1.53 0 01-2.3-.95zM10 13a3 3 0 100-6 3 3 0 000 6z"
      clipRule="evenodd"
    />
  </svg>
);
/* * Gear menu: a JW-Player-style tabbed panel — Quality, Speed and Subtitles. * Speed, subtitle and quality renditions all come straight from the manifest, * nothing is invented. Long lists (a dozen audio-derived subtitle tracks) get a * scroll area and a search box so the menu stays compact. */ type SettingsTab =
  "quality" | "speed" | "subtitles" | "server";
const PlayerSettings = ({
  open,
  onToggle,
  onClose,
  kind,
  servers,
  server,
  onServerChange,
  subtitleSources,
  onLoadSubtitles,
  loadingSubtitles,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** Audio track of the current source: subtitle visibility is per track. */ kind: StreamKind;
  /** Sub-servers of the active mirror; a "Server" tab appears when >1. */ servers?: string[];
  server?: string;
  onServerChange?: (server: string) => void;
  /** Extra catalogues the viewer can pull subtitles from on demand. */
  subtitleSources?: { id: string; name: string; count: number }[];
  /** Loads one catalogue; resolves once its tracks are attached. */
  onLoadSubtitles?: (source: string) => Promise<void>;
  loadingSubtitles?: string | null;
}) => {
  const remote = useMediaRemote();
  const playbackRate = useMediaState("playbackRate");
  const textTracks = useMediaState("textTracks");
  const qualities = useVideoQualityOptions({ auto: true, sort: "descending" });
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<SettingsTab | null>(null);
  const [subQuery, setSubQuery] = useState("");
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        menuRef.current?.contains(target) ||
        buttonRef.current?.contains(target)
      )
        return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);
  const tracks = textTracks ?? [];
  const activeTrack = tracks.findIndex((track) => track.mode === "showing");
  const { settings, updateSettings } = useStore(); // Tabs only appear when they have something to show; the active one falls back  // to the first available (derived, so no effect has to fix it up).
  const tabs: { id: SettingsTab; label: string }[] = [];
  if (qualities.length > 1) tabs.push({ id: "quality", label: "Quality" });
  if ((servers ?? []).length > 1) tabs.push({ id: "server", label: "Server" });
  tabs.push({ id: "speed", label: "Speed" });
  tabs.push({ id: "subtitles", label: "Subtitles" });
  const activeTab: SettingsTab =
    tab && tabs.some((entry) => entry.id === tab)
      ? tab
      : (tabs[0]?.id ?? "speed");
  const turnOffSubtitles = () => {
    if (activeTrack >= 0) remote.changeTextTrackMode(activeTrack, "disabled"); // Captions are remembered per audio track: turning them off in a dub does    // not touch the sub preference.
    updateSettings({ subtitlesOn: { ...settings.subtitlesOn, [kind]: false } }); // The renderer can leave the last cue painted after the track is switched    // off; clear what is on screen.
    document
      .querySelectorAll(
        '.vds-captions [data-part="cue-display"], .vds-captions [data-part="cue"]',
      )
      .forEach((node) => node.replaceChildren());
  };
  const chooseSubtitle = (index: number) => {
    remote.changeTextTrackMode(index, "showing");
    updateSettings({ subtitlesOn: { ...settings.subtitlesOn, [kind]: true } });
  };
  const needle = subQuery.trim().toLowerCase();
  const subtitleOptions = tracks
    .map((track, index) => ({
      track,
      index,
      label: track.label || `Track ${index + 1}`,
    }))
    .filter((option) => !needle || option.label.toLowerCase().includes(needle));
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="vds-button"
        onClick={onToggle}
        aria-label="Player settings"
        aria-expanded={open}
      >
        <GearIcon />
      </button>
      {open && (
        <div ref={menuRef} className="vds-settings-menu">
          <div className="vds-settings-tabs" role="tablist">
            {tabs.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={activeTab === entry.id}
                data-active={activeTab === entry.id || undefined}
                onClick={() => setTab(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          {activeTab === "quality" && (
            <div className="vds-settings-panel">
              <div className="vds-settings-list">
                {qualities.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    data-active={option.selected || undefined}
                    title={option.bitrateText ?? undefined}
                    onClick={() => option.select()}
                  >
                    <span>{option.label}</span>
                    {option.bitrateText && (
                      <span className="vds-settings-hint">
                        {option.bitrateText}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
          {activeTab === "speed" && (
            <div className="vds-settings-panel">
              <div className="vds-settings-list">
                {SPEEDS.map((speed) => (
                  <button
                    key={speed}
                    type="button"
                    data-active={playbackRate === speed || undefined}
                    onClick={() => remote.changePlaybackRate(speed)}
                  >
                    <span>{speed}x</span>
                    {speed === 1 && (
                      <span className="vds-settings-hint">Normal</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
          {activeTab === "server" && (
            <div className="vds-settings-panel">
              <div className="vds-settings-list">
                {(servers ?? []).map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    data-active={entry === server || undefined}
                    onClick={() => {
                      if (entry === server) return;
                      onServerChange?.(entry);
                      onClose();
                    }}
                  >
                    <span>Server {entry}</span>
                    {entry === server && (
                      <span className="vds-settings-hint">Current</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
          {activeTab === "subtitles" && (
            <div className="vds-settings-panel">
              <input
                className="vds-settings-search"
                value={subQuery}
                onChange={(event) => setSubQuery(event.target.value)}
                placeholder="Search subtitles…"
                aria-label="Search subtitles"
                spellCheck={false}
              />
              <div className="vds-settings-list">
                <button
                  type="button"
                  data-active={activeTrack === -1 || undefined}
                  onClick={turnOffSubtitles}
                >
                  <span>Off</span>
                </button>
                {tracks.length === 0 ? (
                  <p className="vds-settings-empty">
                    No subtitles for this episode.
                  </p>
                ) : subtitleOptions.length === 0 ? (
                  <p className="vds-settings-empty">
                    No subtitles match “{subQuery.trim()}”.
                  </p>
                ) : (
                  subtitleOptions.map(({ track, index, label }) => (
                    <button
                      key={`${label}-${index}`}
                      type="button"
                      data-active={activeTrack === index || undefined}
                      onClick={() => chooseSubtitle(index)}
                    >
                      <span>{label}</span>
                    </button>
                  ))
                )}

                {/* Extra catalogues: the stream's own tracks stay on top, and
                    these are pulled in only when asked for. */}
                {(subtitleSources ?? []).map((source) => (
                  <button
                    key={source.id}
                    type="button"
                    disabled={loadingSubtitles === source.id}
                    onClick={() => void onLoadSubtitles?.(source.id)}
                    className="vds-settings-source"
                  >
                    <span>
                      {loadingSubtitles === source.id
                        ? `Loading ${source.name}…`
                        : `Load ${source.name}`}
                    </span>
                    <span className="vds-settings-hint">{source.count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
};
/* * Bridges media state into the app store so the signed-in account keeps track * of watched episodes, and honours the auto next / auto skip preferences. */ const ProgressSync =
  ({
    slug,
    episode,
    onEnded,
    startAt,
    resumeKey,
  }: Pick<Props, "slug" | "episode" | "onEnded" | "startAt" | "resumeKey">) => {
    const player = useMediaPlayer();
    const remote = useMediaRemote();
    const { saveProgress, settings } = useStore();
    const duration = useMediaState("duration");
    const currentTime = useMediaState("currentTime");
    const ended = useMediaState("ended");
    const paused = useMediaState("paused");
    const seeked = useRef(false);
    const markedWatched = useRef(false);
    const advanced = useRef(false);
    const endedSaved = useRef(false);
    const readyForNext = useRef(false); // The player survives episode changes (so fullscreen does too): every  // per-source guard has to start over when the source changes.
    useEffect(() => {
      seeked.current = false;
      markedWatched.current = false;
      advanced.current = false;
      endedSaved.current = false; // The next episode is loaded with `ended` still true from the previous    // one; hold auto-next off until the new source actually starts playing,    // otherwise one ending would cascade straight through two episodes.
      readyForNext.current = false;
    }, [resumeKey]); // A source becomes eligible for auto-next once it has played a little.
    useEffect(() => {
      if (ended) return;
      if (paused) return;
      if (!duration || currentTime < 1) return;
      readyForNext.current = true;
    }, [currentTime, duration, ended, paused]); // Resume where the viewer left off, once the media is ready to be seeked.  // `startAt` arrives asynchronously (the store hydrates after the first  // render), so an absent value must not permanently skip the seek � only an  // actual seek or real playback marks it done.
    useEffect(() => {
      if (seeked.current || !player) return;
      if (!duration) return;
      if (currentTime > 1) {
        // Playback already started before the saved position was known.
        seeked.current = true;
        return;
      }
      if (!startAt || startAt <= 0 || !Number.isFinite(startAt)) return;
      remote.seek(Math.min(startAt, Math.max(duration - 1, 0)));
      seeked.current = true;
    }, [currentTime, duration, player, remote, startAt]); // Persist position while playing. This must not depend on `currentTime`:  // a timeout keyed on it is cleared on every tick and never fires, which left  // every episode starting from 00:00.
    const latest = useRef({ currentTime: 0, duration: 0, paused: true });
    latest.current = { currentTime, duration, paused };
    useEffect(() => {
      const save = () => {
        const state = latest.current;
        if (state.paused || state.duration < 1 || state.currentTime < 1) return;
        saveProgress({
          slug,
          episode,
          currentTime: Math.floor(state.currentTime),
          duration: Math.floor(state.duration),
          completed: false,
        });
      };
      const id = window.setInterval(save, 5000); // Also record the position the moment playback stops or the page unloads.
      const flush = () => save();
      window.addEventListener("pagehide", flush);
      return () => {
        window.clearInterval(id);
        window.removeEventListener("pagehide", flush);
        flush();
      };
    }, [episode, saveProgress, slug]); // Save on pause too, so leaving mid-episode keeps the exact spot.
    useEffect(() => {
      if (!paused) return;
      const state = latest.current;
      if (state.duration < 1 || state.currentTime < 1) return;
      saveProgress({
        slug,
        episode,
        currentTime: Math.floor(state.currentTime),
        duration: Math.floor(state.duration),
        completed: false,
      });
    }, [episode, paused, saveProgress, slug]); // Mark the episode as watched once 90% has played through, so history and  // the "Episode Complete" checkbox update without waiting for the credits.
    useEffect(() => {
      if (markedWatched.current) return;
      if (!duration || currentTime < 1) return;
      if (currentTime / duration < 0.9) return;
      markedWatched.current = true;
      saveProgress({
        slug,
        episode,
        currentTime: Math.floor(currentTime),
        duration: Math.floor(duration),
        completed: true,
      });
    }, [currentTime, duration, episode, saveProgress, slug]);
    /*   * The episode is over only when playback has actually reached the end.   * `ended` alone is not enough: it stays true across a seek or a source swap   * and once fired a next-episode jump just for clicking the video.   */ const atEnd =
      !paused &&
      duration > 0 &&
      Number.isFinite(duration) &&
      currentTime >= duration - 0.75;
    useEffect(() => {
      if (!atEnd) {
        advanced.current = false;
        endedSaved.current = false;
        return;
      } // Save once per ended period: the parent re-renders while navigating and    // re-saving on every render would loop.
      if (!endedSaved.current) {
        endedSaved.current = true;
        saveProgress({
          slug,
          episode,
          currentTime: Math.floor(duration),
          duration: Math.floor(duration),
          completed: true,
        });
      }
      if (settings.autoNext && readyForNext.current && !advanced.current) {
        advanced.current = true;
        onEnded?.();
      }
    }, [
      atEnd,
      duration,
      episode,
      onEnded,
      saveProgress,
      settings.autoNext,
      slug,
    ]); // `ended` is only used to keep the guard honest while the media reports it.
    void ended;
    return null;
  };
/** AniSkip's ranges, with the stream's own markers filling any gap. */ const useSkipData =
  (
    slug: string,
    episode: number,
    episodeLength?: number,
    fallback?: Props["fallbackSkip"],
  ): SkipData | null => {
    const [aniskip, setAniskip] = useState<SkipData | null>(null);
    useEffect(() => {
      let active = true;
      getSkipTimes(slug, episode, episodeLength).then((data) => {
        if (active) setAniskip(data);
      });
      return () => {
        active = false;
      };
    }, [slug, episode, episodeLength]);
    return useMemo(() => {
      if (aniskip) {
        return {
          op: aniskip.op ?? fallback?.op,
          ed: aniskip.ed ?? fallback?.ed,
          recap: aniskip.recap,
        };
      }
      if (fallback?.op || fallback?.ed)
        return { op: fallback.op, ed: fallback.ed };
      return null;
    }, [aniskip, fallback]);
  };
/* * Skip buttons backed by AniSkip through isekai. They always show while a * range is on screen, labelled by the kind that actually came back * (op / ed / recap); ranges without a recognised kind are never shown. When * the Auto skip preference is on, the range is jumped over as it starts. */ const SKIP_BUTTONS: {
  key: keyof SkipData;
  label: string;
}[] = [
  { key: "recap", label: "Skip recap" },
  { key: "op", label: "Skip intro" },
  { key: "ed", label: "Skip outro" },
];
const SkipButtons = ({
  skip,
  autoSkip,
  onNextEpisode,
}: {
  skip: SkipData | null;
  autoSkip: boolean;
  /** "Next episode" button shown during the outro. */ onNextEpisode?: () => void;
}) => {
  const remote = useMediaRemote();
  const currentTime = useMediaState("currentTime");
  /** Ranges already jumped over, so seeking back into one does not loop. */ const handled =
    useRef<string[]>([]); // Auto skip: whenever playback enters a range it has not skipped yet, jump  // to its end — including after a manual seek back into the intro.
  useEffect(() => {
    if (!skip) {
      handled.current = [];
      return;
    }
    if (!autoSkip) return;
    for (const { key } of SKIP_BUTTONS) {
      const point = skip[key];
      if (!point) continue;
      const inside =
        currentTime >= point.start && currentTime < point.end - 0.5;
      if (!inside) {
        // Leaving the range re-arms it (seek away and come back later).
        handled.current = handled.current.filter((entry) => entry !== key);
        continue;
      }
      if (handled.current.includes(key)) continue;
      handled.current.push(key);
      remote.seek(point.end);
    }
  }, [currentTime, remote, autoSkip, skip]);
  const visible = SKIP_BUTTONS.filter(({ key }) => {
    const point = skip?.[key];
    return (
      point !== undefined &&
      currentTime >= point.start - 3 &&
      currentTime < point.end
    );
  }); // During the outro the viewer can move on without waiting for the credits.
  const inOutro =
    skip?.ed !== undefined &&
    currentTime >= skip.ed.start &&
    currentTime < skip.ed.end;
  if (visible.length === 0 && !(inOutro && onNextEpisode)) return null;
  return (
    <>
      {visible.map(({ key, label }) => (
        <button
          key={key}
          className="vds-button vds-skip-intro"
          onClick={() => remote.seek(skip![key]!.end)}
          type="button"
        >
          {label}
        </button>
      ))}
      {inOutro && onNextEpisode && (
        <button
          className="vds-button vds-skip-intro"
          onClick={onNextEpisode}
          type="button"
          tabIndex={-1}
        >
          Next episode
        </button>
      )}
    </>
  );
};
/** * The skipped ranges, drawn on the timeline: recap (violet), intro (yellow) * and outro (blue), positioned as a share of the episode's duration. */ const SkipMarkers =
  ({ skip }: { skip: SkipData | null }) => {
    const duration = useMediaState("duration");
    if (!skip || !duration || !Number.isFinite(duration) || duration <= 0)
      return null;
    const marks: {
      key: string;
      range: { start: number; end: number };
      className: string;
    }[] = [];
    if (skip.recap)
      marks.push({
        key: "recap",
        range: skip.recap,
        className: "bg-violet-400/85",
      });
    if (skip.op)
      marks.push({ key: "op", range: skip.op, className: "bg-yellow-400/90" });
    if (skip.ed)
      marks.push({ key: "ed", range: skip.ed, className: "bg-sky-400/85" });
    return (
      <>
        {marks.map(({ key, range, className }) => {
          const left = Math.max(
            0,
            Math.min(100, (range.start / duration) * 100),
          );
          const width = Math.max(
            0.4,
            Math.min(100 - left, ((range.end - range.start) / duration) * 100),
          );
          return (
            <span
              key={key}
              aria-hidden="true"
              className={`pointer-events-none absolute top-1/2 z-[2] h-[5px] -translate-y-1/2 rounded-full ${className}`}
              style={{ left: `${left}%`, width: `${width}%` }}
            />
          );
        })}
      </>
    );
  };
/** * Keyboard shortcuts for the whole page (no iframe in the way): the usual * YouTube/Vidstack set. Ignored while typing or using modifier keys. */ const Shortcuts =
  ({ onNext, onPrev }: { onNext?: () => void; onPrev?: () => void }) => {
    const remote = useMediaRemote();
    const currentTime = useMediaState("currentTime");
    const duration = useMediaState("duration");
    const paused = useMediaState("paused");
    const muted = useMediaState("muted");
    const fullscreen = useMediaState("fullscreen");
    useEffect(() => {
      const onKeyDown = (event: KeyboardEvent) => {
        const target = event.target as HTMLElement | null;
        if (
          target &&
          (target.isContentEditable ||
            /^(input|textarea|select)$/i.test(target.tagName))
        ) {
          return;
        }
        if (event.metaKey || event.ctrlKey || event.altKey) return; // A control clicked with the mouse keeps focus, and Space would then      // re-activate it (e.g. toggling fullscreen instead of pausing). Drop      // that focus so every shortcut acts on the player itself.
        const active = document.activeElement as HTMLElement | null;
        if (active && active !== document.body && active.closest(".player"))
          active.blur();
        const seek = (delta: number) => {
          event.preventDefault();
          remote.seek(Math.max(0, currentTime + delta));
        };
        if (event.key === " " || event.key.toLowerCase() === "k") {
          event.preventDefault();
          if (paused)
            void Promise.resolve(remote.play()).catch(() => undefined);
          else remote.pause();
          return;
        }
        switch (event.key) {
          case "ArrowLeft":
            return seek(-5);
          case "ArrowRight":
            return seek(5);
          case ",":
          case ".": // Frame stepping is a paused-only action, like YouTube.
            if (paused) seek(event.key === "." ? 1 / 24 : -1 / 24);
            return;
          default:
            break;
        }
        if (/^[0-9]$/.test(event.key) && duration > 0) {
          event.preventDefault();
          remote.seek(duration * (Number(event.key) / 10));
          return;
        }
        switch (event.key.toLowerCase()) {
          case "j":
            return seek(-10);
          case "l":
            return seek(10);
          case "f":
            event.preventDefault();
            if (fullscreen) void remote.exitFullscreen();
            else
              void Promise.resolve(remote.enterFullscreen()).catch(
                () => undefined,
              );
            return;
          case "m":
            event.preventDefault();
            if (muted) remote.unmute();
            else remote.mute();
            return;
          case "n":
            if (onNext) {
              event.preventDefault();
              onNext();
            }
            return;
          case "p":
            if (onPrev) {
              event.preventDefault();
              onPrev();
            }
            return;
          default:
            return;
        }
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, [
      currentTime,
      duration,
      fullscreen,
      muted,
      onNext,
      onPrev,
      paused,
      remote,
    ]);
    return null;
  };
/** Pauses the current video the moment a navigation starts. */ const PauseOnNav =
  ({ token }: { token?: number }) => {
    const remote = useMediaRemote();
    useEffect(() => {
      if (!token) return;
      remote.pause();
    }, [remote, token]);
    return null;
  };
/**
 * Starts playback the moment the intro is out of the way, and again whenever
 * the source changes (auto-next, audio switch, server switch) without touching
 * fullscreen. src is part of the trigger: a server switch changes the URL but
 * not the episode key, and without it the player stayed paused on the old
 * stream - the frozen-player symptom.
 */
const IntroStarter =
  ({ active, resumeKey, src }: { active: boolean; resumeKey?: string; src: string }) => {
    const remote = useMediaRemote();
    useEffect(() => {
      if (!active) return;
      void Promise.resolve(remote.play()).catch(() => undefined);
    }, [active, remote, resumeKey, src]);
    return null;
  };
/**
 * Picks a rendition from the measured bandwidth instead of always taking the
 * tallest one. hls.js' own estimator only reacts to buffer stalls, which is too
 * late: by then the viewer already watched a stutter. The speed test runs while
 * playing and stops when paused; this keeps the automatic level within what the
 * link can sustain, so a fast connection still gets the best rendition.
 */
const AdaptiveQuality = ({
  renditions,
  mbps,
  active,
}: {
  renditions: Record<string, number>;
  mbps: number;
  active: boolean;
}) => {
  const remote = useMediaRemote();
  const qualities = useVideoQualityOptions({ auto: true, sort: "descending" });
  const applied = useRef<number>(Number.NaN);

  useEffect(() => {
    if (!active || mbps <= 0) return;
    // Options[0] is "auto"; the rest follow in descending order, and quality
    // index 0 is the tallest rendition.
    const options = qualities.slice(1);
    if (options.length === 0) return;

    // Keep a third of the link free for the rest of the app.
    const budget = mbps * 1e6 * 0.65;
    let pick = -1;
    for (let index = 0; index < options.length; index += 1) {
      const bandwidth = renditions[options[index].label] ?? 0;
      if (bandwidth <= 0 || bandwidth <= budget) {
        pick = index;
        break;
      }
    }
    if (pick < 0) return;
    if (pick === applied.current) return;
    applied.current = pick;
    remote.changeQuality(pick);
  }, [active, mbps, qualities, remote, renditions]);

  return null;
};
export const VideoPlayer = ({
  src,
  poster,
  subtitles,
  slug,
  episode,
  episodeLength,
  fallbackSkip,
  title,
  onEnded,
  startAt,
  showIntro,
  onIntroDone,
  onStart,
  resumeKey,
  pauseToken,
  onNext,
  onPrev,
  kind = "sub",
  posterSources = [],
  servers = [],
  server = "",
  onServerChange,
  renditions = {},
  subtitleSources = [],
  loadSubtitles,
}: Props) => {
  const { settings } = useStore();
  const [menuOpen, setMenuOpen] = useState(false);

  /*
   * Subtitles shown to the player: the stream's own tracks first, then any
   * extra catalogue the viewer loaded. Loading is per source and per episode;
   * a new source (server, track, episode) resets the list so stale tracks from
   * the previous episode never linger.
   */
  const [extraSubtitles, setExtraSubtitles] = useState<SubtitleTrack[]>([]);
  const [loadingSource, setLoadingSource] = useState<string | null>(null);
  useEffect(() => {
    setExtraSubtitles([]);
    setLoadingSource(null);
  }, [resumeKey]);

  const allSubtitles = useMemo(
    () => [...(subtitles ?? []), ...extraSubtitles],
    [subtitles, extraSubtitles]
  );

  const loadSource = useCallback(
    async (source: string) => {
      if (!loadSubtitles) return;
      setLoadingSource(source);
      try {
        const loaded = await loadSubtitles(source);
        setExtraSubtitles((prev) => {
          // Re-loading replaces that catalogue's tracks rather than appending
          // a duplicate set.
          const kept = prev.filter((track) => track.source !== source);
          return [...kept, ...loaded];
        });
      } catch {
        /* the menu simply stays as it was; the viewer can retry */
      } finally {
        setLoadingSource(null);
      }
    },
    [loadSubtitles]
  );
  /** The media only mounts once playback is requested — that is when it buffers. */ const [
    started,
    setStarted,
  ] = useState(settings.autoplay);
  const [intro, setIntro] = useState(false);
  const [playAfterIntro, setPlayAfterIntro] = useState(false);
  /**   * Controls are awake while the viewer is doing something (pointer move, key,   * touch) and go back to sleep after a few idle seconds � in fullscreen as   * well, where the mouse is hidden alongside the bar.   */ const IDLE_MS = 3000;
  const [awake, setAwake] = useState(false);
  const idleTimer = useRef<number | undefined>(undefined);
  const wake = useCallback(() => {
    setAwake(true);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setAwake(false), IDLE_MS);
  }, []);
  const sleep = useCallback(() => {
    window.clearTimeout(idleTimer.current);
    setAwake(false);
  }, []);
  const onPointerEnter = useCallback(() => wake(), [wake]);
  const onPointerMove = useCallback(() => wake(), [wake]);
  const onPointerLeave = useCallback(() => {
    // Outside the player the bar is simply not needed; fullscreen keeps it on    // the idle timer because the pointer stays over the video.
    sleep();
  }, [sleep]); // Any key press also wakes the bar (arrow seeks, space, f, �), and a touch  // on the screen counts as activity too.
  useEffect(() => {
    const onKey = () => wake();
    const onTouch = () => wake();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("touchstart", onTouch, {
      capture: true,
      passive: true,
    });
    window.addEventListener("pointerdown", onTouch, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("touchstart", onTouch, true);
      window.removeEventListener("pointerdown", onTouch, true);
      window.clearTimeout(idleTimer.current);
    };
  }, [wake]);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const skip = useSkipData(slug, episode, episodeLength, fallbackSkip);
  // Bandwidth is only measured while the episode is actually playing: a paused
  // or idle player must not spend data, and a probe would compete with the
  // stream for the very bandwidth it is trying to measure.
  const [playing, setPlaying] = useState(false);
  const speed = useSpeedTest(playing, started && desktop.available());
  const beginPlay = useCallback(() => {
    setStarted(true);
    onStart?.(); // The intro plays before the episode on a deliberate start.
    if (showIntro) setIntro(true);
    else setPlayAfterIntro(true);
  }, [onStart, showIntro]); // Autoplay used to skip the intro entirely, which made it look like the
  // animation had been removed. It now plays once per visit either way; with
  // autoplay on the media still mounts behind it and is ready when it ends.
  useEffect(() => {
    if (!settings.autoplay) return;
    if (showIntro) {
      setStarted(true);
      setIntro(true);
    } else {
      setPlayAfterIntro(true);
    }
  }, [settings.autoplay, showIntro]);
  const finishIntro = useCallback(() => {
    setIntro(false);
    setPlayAfterIntro(true);
    onIntroDone?.();
  }, [onIntroDone]); // Keep the control bar up while the settings menu is open so the panel  // does not fade out when the pointer leaves the player.
  const controlsVisible = settings.controls === "visible" || awake || menuOpen;
  const cue = settings.subtitleStyle;
  const rgb = (hex: string) => {
    const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
    if (!match) return "0, 0, 0";
    return [match[1], match[2], match[3]]
      .map((part) => parseInt(part, 16))
      .join(", ");
  };
  return (
    <div
      className="player"
      data-hovered={awake || undefined}
      data-idle={!awake || undefined}
      data-controls-visible={controlsVisible || undefined}
      data-subtitles={settings.subtitles}
      data-cue-stroke={cue.strokeSize > 0 ? "on" : "0"}
      data-cue-shadow={cue.shadow ? "true" : "false"}
      style={
        {
          "--cue-scale": cue.scale / 100,
          "--cue-color": cue.color,
          "--cue-bg-rgb": rgb(cue.background),
          "--cue-bg-opacity": cue.backgroundOpacity / 100,
          "--cue-opacity": cue.opacity / 100,
          "--cue-stroke": cue.stroke,
        } as React.CSSProperties
      }
      onPointerEnter={onPointerEnter}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onMouseDown={(event) => {
        // Never let a control take focus: keyboard shortcuts stay on the page.
        const control = (event.target as HTMLElement).closest(
          'button, [role="button"]',
        );
        if (control && !control.closest(".vds-settings-menu"))
          event.preventDefault();
      }}
    >
      {started ? (
        <MediaPlayer
          src={{ src, type: "application/x-mpegurl" }}
          title={title}
          aspectRatio="16/9"
          playsInline
          preload="auto"
          autoPlay={false}
          onProviderChange={(provider) => {
            // hls.js is bundled with the app instead of being pulled off a CDN.
            if (isHLSProvider(provider)) {
              provider.library = () => import("hls.js");
            }
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onFocus={() => wake()}
          onBlur={() => sleep()}
        >
          <MediaProvider className="vds-provider">
            {allSubtitles.map((track) => (
              <track
                key={`${track.url}-${track.label}`}
                kind="captions"
                src={track.url}
                label={track.label}
                srcLang={track.language}
                default={
                  isPreferredSubtitle(track, settings.subtitleLanguage) &&
                  settings.subtitlesOn[kind]
                }
              />
            ))}
          </MediaProvider>
          <Captions className="vds-captions" />
          <Spinner.Root className="vds-spinner" size={44}>
            <Spinner.Track /> <Spinner.TrackFill className="vds-spinner-fill" />
          </Spinner.Root>
          <div className="vds-controls" data-no-focus>
            <div className="vds-group">
              <TogglePlay />
              <SkipButtons
                skip={skip}
                autoSkip={settings.autoSkip}
                onNextEpisode={onNext}
              />
            </div>
            <div className="vds-group" data-grow>
              <Time className="vds-time" type="current" />
              <div className="vds-slider-wrap">
                <TimeSlider.Root className="vds-time-slider">
                  <TimeSlider.Preview>
                    <TimeSlider.Value className="vds-preview" />
                  </TimeSlider.Preview>
                  <TimeSlider.Track className="vds-track">
                    <TimeSlider.Progress className="vds-track-progress" />
                    <TimeSlider.TrackFill className="vds-track-fill" />
                  </TimeSlider.Track>
                  <TimeSlider.Thumb className="vds-thumb" />
                </TimeSlider.Root>
                <SkipMarkers skip={skip} />
              </div>
              <Time className="vds-time" type="duration" />
            </div>
            <div className="vds-group">
              <ToggleVolume />
              <VolumeSlider.Root className="vds-volume-slider">
                <VolumeSlider.Track className="vds-track">
                  <VolumeSlider.TrackFill className="vds-track-fill" />
                </VolumeSlider.Track>
                <VolumeSlider.Thumb className="vds-thumb" />
              </VolumeSlider.Root>
              <PlayerSettings
                open={menuOpen}
                onToggle={() => setMenuOpen((isOpen) => !isOpen)}
                onClose={closeMenu}
                kind={kind}
                servers={servers}
                server={server}
                onServerChange={onServerChange}
                subtitleSources={subtitleSources}
                onLoadSubtitles={loadSource}
                loadingSubtitles={loadingSource}
              />
              <ToggleFullscreen />
            </div>
          </div>
          <ProgressSync
            slug={slug}
            episode={episode}
            onEnded={onEnded}
            startAt={startAt}
            resumeKey={resumeKey}
          />
          <IntroStarter active={playAfterIntro} resumeKey={resumeKey} src={src} />
          <AdaptiveQuality
            renditions={renditions}
            mbps={speed.mbps}
            active={playing && speed.idle}
          />
          <PauseOnNav token={pauseToken} />
          <Shortcuts onNext={onNext} onPrev={onPrev} />
        </MediaPlayer> // Before playback: the episode still (or the title poster) and a play        // button. Nothing is fetched until this is pressed.
      ) : (
        <button
          type="button"
          onClick={beginPlay}
          aria-label="Play episode"
          className="vds-poster-gate group relative flex aspect-video w-full items-center justify-center overflow-hidden rounded bg-black"
        >
          {posterSources.length > 0 && (
            <Artwork
              sources={posterSources}
              alt=""
              className="absolute inset-0 h-full w-full opacity-80 transition duration-300 group-hover:opacity-90"
            />
          )}
          <span className="relative flex h-16 w-16 items-center justify-center rounded-full border border-white/20 bg-black/55 text-white backdrop-blur transition duration-200 group-hover:scale-105 group-hover:bg-twist-red">
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              className="ml-1 h-7 w-7"
              aria-hidden="true"
            >
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        </button>
      )}
      {intro && <IntroAnimation onEnded={finishIntro} />}
    </div>
  );
};
