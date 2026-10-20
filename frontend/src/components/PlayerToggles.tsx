/**
 * The row under the player: auto play / auto next / auto skip as icon buttons
 * with hover tooltips ("Disable Auto Next"), per-episode refresh and cache
 * clearing, plus a keyboard-shortcuts panel.
 */
import { useState } from 'react';
import { useStore } from '../lib/store';

const ICON = 'h-4 w-4';

const AutoPlayIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={ICON} aria-hidden="true">
    <path d="M8 5v14l11-7z" />
  </svg>
);

const AutoNextIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={ICON} aria-hidden="true">
    <path d="M6 18l8.5-6L6 6v12zM16 6h2v12h-2z" />
  </svg>
);

const AutoSkipIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    className={ICON}
    aria-hidden="true"
  >
    <circle cx="6" cy="7" r="2.4" />
    <circle cx="6" cy="17" r="2.4" />
    <path d="M8 8.6 20 17M8 15.4 20 7" />
  </svg>
);

const KeyboardIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    className={ICON}
    aria-hidden="true"
  >
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 14h12" />
  </svg>
);

const RefreshIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={ICON}
    aria-hidden="true"
  >
    <path d="M20 11a8 8 0 10-2.3 6.3" />
    <path d="M20 5v6h-6" />
  </svg>
);

const CacheIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={ICON}
    aria-hidden="true"
  >
    <ellipse cx="12" cy="6" rx="7" ry="3" />
    <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
    <path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
  </svg>
);

/** Icon button with the black bubble tooltip from the reference bar. */
const TipButton = ({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    aria-label={label}
    className={`group/tip relative flex h-9 w-9 items-center justify-center rounded-lg border transition duration-200 ${
      active
        ? 'border-transparent bg-twist-red/15 text-twist-red'
        : 'border-transparent bg-twist-800 text-twist-lightgray hover:border-twist-gray hover:text-gray-200'
    }`}
  >
    {children}
    <span className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-black px-3 py-1.5 font-body text-xs text-white opacity-0 shadow-xl transition duration-150 group-hover/tip:opacity-100">
      {label}
      <span className="absolute left-1/2 top-full -translate-x-1/2 border-[5px] border-transparent border-t-black" />
    </span>
  </button>
);

const SHORTCUTS: [string, string][] = [
  ['Space / K', 'Play / Pause'],
  ['â† / â†’', 'Seek 5s'],
  ['J / L', 'Seek 10s'],
  [', / .', 'Step one frame'],
  ['0â€“9', 'Jump to 0â€“90%'],
  ['F', 'Fullscreen'],
  ['M', 'Mute'],
  ['N / P', 'Next / Previous episode'],
  ['Ctrl+S + 1…', 'Sub server 1… (hold Ctrl+S, tap digit)'],
  ['Ctrl+D + 1…', 'Dub server 1…'],
  ['1–9', 'Pick a Kuma release when the list is open'],
];

export const PlayerToggles = ({
  onRefresh,
  onClearCache,
  busy,
}: {
  /** Reloads the current episode from its source. */
  onRefresh?: () => void;
  /** Drops the cached media for this episode. */
  onClearCache?: () => void;
  /** A refresh/clear is in flight. */
  busy?: boolean;
}) => {
  const { settings, updateSettings } = useStore();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  return (
    <div className="relative mt-3 flex flex-wrap items-center justify-end gap-2 border-b border-twist-800 pb-3">
      <TipButton
        label={`${settings.autoplay ? 'Disable' : 'Enable'} Auto Play`}
        active={settings.autoplay}
        onClick={() => updateSettings({ autoplay: !settings.autoplay })}
      >
        <AutoPlayIcon />
      </TipButton>
      <TipButton
        label={`${settings.autoNext ? 'Disable' : 'Enable'} Auto Next`}
        active={settings.autoNext}
        onClick={() => updateSettings({ autoNext: !settings.autoNext })}
      >
        <AutoNextIcon />
      </TipButton>
      <TipButton
        label={`${settings.autoSkip ? 'Disable' : 'Enable'} Auto Skip`}
        active={settings.autoSkip}
        onClick={() => updateSettings({ autoSkip: !settings.autoSkip })}
      >
        <AutoSkipIcon />
      </TipButton>

      {/* Episode maintenance: re-resolve the stream, or forget its cached media
          so the next play fetches fresh segments. */}
      <span className="mx-0.5 h-5 w-px bg-twist-800" aria-hidden="true" />
      <TipButton label={busy ? 'Working…' : 'Refresh this episode'} onClick={() => onRefresh?.()}>
        <RefreshIcon />
      </TipButton>
      <TipButton label="Clear this episode's cache" onClick={() => onClearCache?.()}>
        <CacheIcon />
      </TipButton>

      <TipButton
        label="Keyboard shortcuts"
        active={shortcutsOpen}
        onClick={() => setShortcutsOpen((open) => !open)}
      >
        <KeyboardIcon />
      </TipButton>

      {shortcutsOpen && (
        <>
          <button
            type="button"
            aria-label="Close shortcuts"
            onClick={() => setShortcutsOpen(false)}
            className="fixed inset-0 z-20 cursor-default bg-transparent"
          />
          <div className="absolute bottom-full right-0 z-30 mb-3 w-72 rounded-lg border border-twist-700 bg-twist-900 p-4 shadow-2xl">
            <span className="font-body text-[11px] font-bold uppercase tracking-wide text-twist-lightgray">
              Keyboard shortcuts
            </span>
            <div className="mt-3 flex flex-col gap-2">
              {SHORTCUTS.map(([keys, action]) => (
                <div key={keys} className="flex items-center justify-between gap-3">
                  <span className="rounded bg-twist-800 px-2 py-0.5 font-body text-[11px] text-gray-200">
                    {keys}
                  </span>
                  <span className="font-body text-xs text-twist-lightgray">{action}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 font-body text-[10px] leading-relaxed text-twist-lightgray">
              Shortcuts work anywhere on the page, except while typing.
            </p>
          </div>
        </>
      )}
    </div>
  );
};
