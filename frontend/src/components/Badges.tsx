import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProfileBadge } from '../lib/profile';

/*
 * Badge showcase. Tiles are icon-only: hovering shows the name, clicking
 * opens a detail modal with the requirement and proud progress.
 */
export const BadgeRow = ({ badges }: { badges: ProfileBadge[] }) => {
  const [selected, setSelected] = useState<ProfileBadge | null>(null);

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {badges.map((badge) => (
          <button
            key={badge.id}
            type="button"
            onClick={() => setSelected(badge)}
            title={badge.label}
            aria-label={`${badge.label} badge`}
            className={`flex h-9 w-9 items-center justify-center rounded-full border bg-gradient-to-br text-base transition duration-200 hover:scale-105 ${
              badge.gradient
            } ${
              badge.earned
                ? 'border-white/15 shadow-lg hover:border-white/40'
                : 'border-white/5 opacity-45 grayscale'
            }`}
          >
            <span aria-hidden="true">{badge.icon}</span>
          </button>
        ))}
      </div>

      {selected && <BadgeModal badge={selected} onClose={() => setSelected(null)} />}
    </>
  );
};

const BadgeModal = ({ badge, onClose }: { badge: ProfileBadge; onClose: () => void }) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${badge.label} badge`}
      onClick={onClose}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-xs overflow-hidden rounded-xl border border-twist-700 bg-twist-900 shadow-2xl"
      >
        <div className={`h-20 w-full bg-gradient-to-br ${badge.gradient}`} />

        <div className="px-5 pb-5">
          <span className="-mt-8 flex h-16 w-16 items-center justify-center rounded-full border-4 border-twist-900 bg-twist-800 text-2xl shadow-xl">
            <span aria-hidden="true">{badge.icon}</span>
          </span>

          <div className="mt-3 flex items-center gap-2">
            <span className="font-body text-base text-gray-100">{badge.label}</span>
            <span
              className={`rounded px-1.5 py-0.5 font-body text-[10px] font-bold uppercase tracking-wide ${
                badge.earned
                  ? 'bg-twist-red/15 text-twist-red'
                  : 'bg-twist-800 text-twist-lightgray'
              }`}
            >
              {badge.earned ? 'Earned' : 'Locked'}
            </span>
          </div>

          <p className="mt-1 font-body text-xs leading-relaxed text-twist-lightgray">
            {badge.description}
          </p>

          <div className="mt-4 flex items-center justify-between">
            <span className="font-body text-[11px] text-twist-lightgray">
              {badge.requirement}
            </span>
            <span className="font-body text-[11px] tabular-nums text-twist-lightgray">
              {badge.progressText}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-twist-gray/50">
            <div
              className="h-full rounded-full bg-twist-red"
              style={{ width: `${badge.progress * 100}%` }}
            />
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
