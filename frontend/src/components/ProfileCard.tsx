import Link from 'next/link';
import { useStore } from '../lib/store';
import { avatarSeed, avatarUrl, badgesFor, cardPreset, earnedBadges } from '../lib/profile';

/** Floating profile card shown while hovering a username in chat. */
export const ProfileCard = ({
  address,
  username,
  onNavigate,
}: {
  address: string;
  username: string;
  onNavigate?: () => void;
}) => {
  const { account, users, level, xp, watched, messages, bannedAddresses, bannedReason } =
    useStore();

  const key = address.toLowerCase();
  const own = account?.address?.toLowerCase() === key;
  const info = users[key];

  const displayName = own ? account.username : info?.username || username;
  const displayLevel = own ? level : info?.level;
  const displayXp = own ? xp : info?.xp;
  const displayWatched = own ? watched : info?.watched ?? 0;

  const preset = cardPreset(own ? account?.card : info?.card);
  const avatar = avatarSeed(displayName, own ? account?.avatar : info?.avatar);
  const banned = bannedAddresses.includes(key);
  const count = messages.filter((message) => message.address?.toLowerCase() === key).length;

  const badges =
    displayLevel !== undefined
      ? earnedBadges(
          badgesFor({
            level: displayLevel,
            xp: displayXp ?? 0,
            messages: count,
            watched: displayWatched,
          })
        )
      : [];

  return (
    <div className="w-56 overflow-hidden rounded-xl border border-twist-700 bg-twist-900 shadow-2xl">
      <div className="h-14 w-full" style={{ background: preset.style }} />

      <div className="px-4 pb-3">
        <span className="-mt-6 flex h-12 w-12 items-center justify-center overflow-hidden rounded-full border-2 border-twist-900 bg-twist-800">
          <img
            src={avatarUrl(avatar)}
            alt={displayName}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        </span>

        <span className="mt-2 flex items-center gap-1.5 font-body text-sm text-gray-100">
          <span className="truncate">{displayName}</span>
          {displayLevel !== undefined && (
            <span className="flex h-4 shrink-0 items-center rounded bg-twist-red px-1 text-[10px] font-bold text-white">
              {displayLevel}
            </span>
          )}
          {own && (
            <span className="shrink-0 rounded bg-twist-800 px-1 text-[9px] font-bold uppercase tracking-wide text-twist-lightgray">
              You
            </span>
          )}
          {banned && (
            <span className="shrink-0 rounded bg-twist-red px-1 text-[9px] font-bold uppercase tracking-wide text-white">
              Banned
            </span>
          )}
        </span>

        <span className="mt-1 block font-body text-[11px] text-twist-lightgray">
          {count} message{count === 1 ? '' : 's'}
          {displayXp !== undefined ? ` · ${displayXp} XP` : ''}
        </span>

        {banned && bannedReason[key] && (
          <span className="mt-0.5 block font-body text-[10px] text-twist-redlight">
            {bannedReason[key]}
          </span>
        )}

        {badges.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {badges.map((badge) => (
              <span
                key={badge.id}
                title={badge.label}
                className={`flex h-6 w-6 items-center justify-center rounded-full border border-white/10 bg-gradient-to-br text-[11px] ${badge.gradient}`}
              >
                <span aria-hidden="true">{badge.icon}</span>
              </span>
            ))}
          </div>
        )}

        <Link
          href={own ? '/profile' : `/profile/${encodeURIComponent(displayName)}`}
          onClick={onNavigate}
          className="group mt-2.5 flex h-8 items-center justify-between rounded bg-twist-800 px-2.5 border border-transparent transition duration-200 hover:border-twist-gray"
        >
          <span className="font-body text-xs text-gray-300 transition-colors duration-200 group-hover:text-gray-100">
            View profile
          </span>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
            className="h-3 w-3 text-twist-lightgray transition duration-200 group-hover:translate-x-0.5 group-hover:text-gray-100"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </Link>
      </div>
    </div>
  );
};
