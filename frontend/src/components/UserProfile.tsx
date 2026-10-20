import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getCardBySlug, type SlugCard } from '../lib/anime';
import { useStore, type Progress } from '../lib/store';
import { isRootAddress } from '../lib/moderation';
import { avatarSeed, avatarUrl, badgesFor, cardPreset } from '../lib/profile';
import { shortAddress } from '../lib/wallet';
import { lookupProfile, type PublicProfileData } from '../lib/chain';
import { Shell } from './Shell';
import { BadgeRow } from './Badges';

const nextLevelXp = (level: number) => level * level * 25;
const levelFloorXp = (level: number) => (level - 1) * (level - 1) * 25;

const prettySlug = (slug: string) => slug.replace(/-/g, ' ');

/** Real titles and genres for stored slugs, resolved in the background. */
const useSlugCards = (slugs: string[]) => {
  const key = slugs.join(',');
  const [cards, setCards] = useState<Map<string, SlugCard>>(new Map());

  useEffect(() => {
    const list = key ? key.split(',') : [];
    if (list.length === 0) return;

    let active = true;
    void Promise.all(list.map(async (slug) => [slug, await getCardBySlug(slug)] as const)).then(
      (entries) => {
        if (!active) return;
        setCards((prev) => {
          const next = new Map(prev);
          for (const [slug, card] of entries) if (card) next.set(slug, card);
          return next;
        });
      }
    );

    return () => {
      active = false;
    };
  }, [key]);

  return cards;
};

const CARD = 'rounded-lg border border-twist-800 bg-twist-800/40';
const GHOST =
  'focus:outline-none cursor-default rounded bg-twist-800 h-9 px-3 border border-transparent transition duration-200 hover:border-twist-gray';

const section = (title: string, body: React.ReactNode) => (
  <div className="mt-6 border-t border-twist-800 pt-4">
    <span className="font-body text-xs font-bold uppercase tracking-wide text-twist-red">
      {title}
    </span>
    {body}
  </div>
);

const Empty = ({ message }: { message: string }) => (
  <div className="mt-3 rounded-lg border border-dashed border-twist-700 p-4 text-center">
    <p className="font-body text-xs text-twist-lightgray">{message}</p>
    <Link
      href="/"
      className="mt-2 inline-block font-body text-xs text-twist-red transition duration-200 hover:text-twist-redlight"
    >
      Browse anime
    </Link>
  </div>
);

/** Wallet address with a copy button — this is the account's real identity. */
const AddressRow = ({ address }: { address: string }) => {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      title="Copy address"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(address)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
      className="mt-1 flex max-w-full items-center gap-2 rounded bg-twist-900/60 px-2 py-1 transition duration-200 hover:bg-twist-900"
    >
      <span className="truncate font-body text-[10px] tabular-nums text-twist-lightgray">
        {address}
      </span>
      <span className="shrink-0 font-body text-[10px] font-bold text-twist-red">
        {copied ? 'Copied' : 'Copy'}
      </span>
    </button>
  );
};

/* --------------------------------------------------------------------------
 * Own profile
 *
 * The signed-in profile used to be one long scroll (level, stats, badges,
 * genres, activity, continue watching, history). It is now a header plus tabs,
 * so each kind of information is one click away instead of buried below the
 * fold. "Continue watching" leads because it is what people come back for.
 * ----------------------------------------------------------------------- */

const PROFILE_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'watching', label: 'Watching' },
  { id: 'history', label: 'History' },
  { id: 'activity', label: 'Activity' },
] as const;

type ProfileTabId = (typeof PROFILE_TABS)[number]['id'];

const ProfileStats = ({
  completed,
  started,
  xp,
}: {
  completed: number;
  started: number;
  xp: number;
}) => (
  <div className="mt-3 grid grid-cols-3 gap-3">
    {[
      { label: 'Episodes', value: completed },
      { label: 'Anime', value: started },
      { label: 'Total XP', value: xp },
    ].map((stat) => (
      <div key={stat.label} className={`${CARD} p-3 text-center`}>
        <span className="block font-body text-lg tabular-nums text-gray-100">{stat.value}</span>
        <span className="mt-0.5 block font-body text-[10px] uppercase tracking-wide text-twist-lightgray">
          {stat.label}
        </span>
      </div>
    ))}
  </div>
);

/**
 * Continue watching as poster cards: the still, how far in, and a direct link
 * to the episode. The old rows worked but read as a list of links rather than
 * a shelf of what you were watching.
 */
const ContinueWatching = ({
  entries,
  titleFor,
  cardFor,
}: {
  entries: { slug: string; episode: number; currentTime: number; duration: number }[];
  titleFor: (slug: string) => string;
  cardFor: Map<string, SlugCard>;
}) => {
  if (entries.length === 0) {
    return <Empty message="Nothing in progress yet. Start an episode and it shows up here." />;
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {entries.slice(0, 12).map((entry) => {
        const percent = Math.min(
          100,
          Math.round((entry.currentTime / Math.max(entry.duration, 1)) * 100)
        );
        const poster = cardFor.get(entry.slug)?.poster;
        return (
          <Link
            key={`${entry.slug}-${entry.episode}`}
            href={`/${entry.slug}/watch/${entry.episode}`}
            className={`${CARD} group relative overflow-hidden transition duration-200 hover:border-twist-gray`}
          >
            <div className="relative aspect-video w-full overflow-hidden bg-twist-800">
              {poster ? (
                <img
                  src={poster}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover opacity-80 transition duration-200 group-hover:opacity-100"
                />
              ) : null}
              <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1.5 py-0.5 font-body text-[10px] tabular-nums text-white">
                Ep {entry.episode}
              </span>
              <span className="absolute inset-x-0 bottom-0 h-0.5 bg-white/20">
                <span
                  className="block h-full bg-twist-red"
                  style={{ width: `${percent}%` }}
                />
              </span>
            </div>
            <div className="p-2">
              <span className="block truncate font-body text-xs text-gray-300 transition-colors duration-200 group-hover:text-gray-100">
                {titleFor(entry.slug)}
              </span>
              <span className="mt-0.5 block font-body text-[10px] tabular-nums text-twist-lightgray">
                {percent}% watched
              </span>
            </div>
          </Link>
        );
      })}
    </div>
  );
};

/**
 * Watch history, grouped by title with every episode listed under it.
 *
 * Episodes used to be summarised as "12 ep" with no way to touch an individual
 * one. Each row now carries its own state (watched / 42% in) and a delete
 * button, so a wrong or unwanted episode can be removed without clearing the
 * whole history.
 */
const WatchHistory = ({
  entries,
  titleFor,
  onRemove,
}: {
  entries: Progress[];
  titleFor: (slug: string) => string;
  onRemove: (slug: string, episode: number) => void;
}) => {
  const [open, setOpen] = useState<Record<string, boolean>>({});

  if (entries.length === 0) {
    return <Empty message="Nothing watched yet." />;
  }

  // Newest title first, and newest episode first inside each title.
  const groups = new Map<string, Progress[]>();
  for (const entry of entries) {
    const list = groups.get(entry.slug) ?? [];
    list.push(entry);
    groups.set(entry.slug, list);
  }
  const ordered = [...groups.entries()]
    .map(([slug, list]) => [slug, [...list].sort((a, b) => b.episode - a.episode)] as const)
    .sort((a, b) => Math.max(...b[1].map((e) => e.updatedAt)) - Math.max(...a[1].map((e) => e.updatedAt)));

  return (
    <div className="flex flex-col gap-2">
      {ordered.map(([slug, list]) => {
        const watchedCount = list.filter((entry) => entry.completed).length;
        const expanded = open[slug] ?? list.length <= 3;
        const shown = expanded ? list : list.slice(0, 3);
        return (
          <div key={slug} className={`${CARD} overflow-hidden`}>
            <div className="flex items-center justify-between gap-3 p-3">
              <Link
                href={`/${slug}/info`}
                className="min-w-0 flex-1 truncate font-body text-sm text-gray-300 transition-colors duration-200 hover:text-gray-100"
              >
                {titleFor(slug)}
              </Link>
              <span className="shrink-0 rounded bg-twist-800 px-2 py-0.5 font-body text-xs text-twist-lightgray">
                {watchedCount} / {list.length} ep
              </span>
              {list.length > 3 && (
                <button
                  type="button"
                  onClick={() => setOpen((prev) => ({ ...prev, [slug]: !expanded }))}
                  className="shrink-0 font-body text-[10px] text-twist-red transition duration-200 hover:text-twist-redlight"
                >
                  {expanded ? 'Less' : `All ${list.length}`}
                </button>
              )}
            </div>

            <div className="border-t border-twist-800/60">
              {shown.map((entry) => {
                const percent = Math.min(
                  100,
                  Math.round((entry.currentTime / Math.max(entry.duration, 1)) * 100)
                );
                return (
                  <div
                    key={entry.episode}
                    className="flex items-center gap-2 border-b border-twist-800/40 px-3 py-1.5 last:border-b-0"
                  >
                    <Link
                      href={`/${slug}/watch/${entry.episode}`}
                      className="min-w-0 flex-1 truncate font-body text-xs text-gray-300 transition-colors duration-200 hover:text-gray-100"
                    >
                      Episode {entry.episode}
                    </Link>
                    <span
                      className={`shrink-0 font-body text-[10px] tabular-nums ${
                        entry.completed ? 'text-twist-red' : 'text-twist-lightgray'
                      }`}
                    >
                      {entry.completed ? 'Watched' : percent > 0 ? `${percent}%` : 'Opened'}
                    </span>
                    <button
                      type="button"
                      onClick={() => onRemove(slug, entry.episode)}
                      aria-label={`Remove episode ${entry.episode} from history`}
                      title="Remove from history"
                      className="shrink-0 rounded p-0.5 text-twist-lightgray transition duration-200 hover:text-twist-red"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        className="h-3 w-3"
                        aria-hidden="true"
                      >
                        <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
};

const ProfileTabs = ({
  stats,
  levelCard,
  continueWatching,
  history,
  badges,
  genres,
  activity,
  footer,
}: {
  stats: React.ReactNode;
  levelCard: React.ReactNode;
  continueWatching: React.ReactNode;
  history: React.ReactNode;
  badges: React.ReactNode;
  genres: React.ReactNode;
  activity: React.ReactNode;
  footer: React.ReactNode;
}) => {
  const [tab, setTab] = useState<ProfileTabId>('overview');

  return (
    <>
      <div className="mt-3 flex gap-1 rounded-lg border border-twist-800 bg-twist-800/40 p-1">
        {PROFILE_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            onClick={() => setTab(entry.id)}
            className={`flex-1 rounded px-2 py-1.5 font-body text-xs transition duration-200 ${
              tab === entry.id
                ? 'bg-twist-red/15 text-gray-100'
                : 'text-twist-lightgray hover:bg-white/5 hover:text-gray-200'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          {levelCard}
          {stats}
          {section('Badges', badges)}
          {section('Top genres', genres)}
        </>
      )}

      {tab === 'watching' && (
        <div className="mt-4">
          <span className="font-body text-xs font-bold uppercase tracking-wide text-twist-red">
            Continue watching
          </span>
          <div className="mt-3">{continueWatching}</div>
        </div>
      )}

      {tab === 'history' && <div className="mt-4">{history}</div>}

      {tab === 'activity' && (
        <div className="mt-4">{section('Recent messages', activity)}</div>
      )}

      {footer}
    </>
  );
};

/** Public view shown when visiting someone else's profile. */const PublicProfile = ({ username }: { username: string }) => {
  const {
    messages,
    users,
    isAdmin,
    bannedAddresses,
    bannedBy,
    bannedReason,
    moderateBan,
    moderateUnban,
  } = useStore();

  const lower = username.toLowerCase();
  const [chainProfile, setChainProfile] = useState<PublicProfileData | null | 'loading'>(
    'loading'
  );

  // Resolve the name straight from the chain so fresh browsers work too.
  useEffect(() => {
    let active = true;
    lookupProfile(username)
      .then((result) => {
        if (active) setChainProfile(result);
      })
      .catch(() => {
        if (active) setChainProfile(null);
      });
    return () => {
      active = false;
    };
  }, [username]);

  const resolved = chainProfile !== 'loading' ? chainProfile : null;
  const fromUsers = Object.values(users).find(
    (user) => user.username && user.username.toLowerCase() === lower
  );
  const fromMessages = messages.find(
    (message) => message.username.toLowerCase() === lower && message.address
  );
  const address = (
    resolved?.address ??
    fromUsers?.address ??
    fromMessages?.address
  )?.toLowerCase();
  const cached = address ? users[address] : undefined;

  const displayName = resolved?.username || cached?.username || username;
  const level = resolved?.level ?? cached?.level;
  const avatarName = resolved?.avatar ?? cached?.avatar;
  const cardId = resolved?.card ?? cached?.card;
  const watchedCount = resolved?.watched ?? cached?.watched;
  const xpValue = resolved?.xp ?? cached?.xp;
  const banned = address ? bannedAddresses.includes(address) : false;

  if (!address) {
    if (chainProfile === 'loading') {
      return (
        <Shell>
          <div className="content-column mx-auto w-full px-4 py-6" />
        </Shell>
      );
    }

    return (
      <Shell>
        <div className="content-column mx-auto w-full px-4 py-6">
          <div className={`${CARD} mt-6 p-6 text-center`}>
            <h1 className="font-body text-lg text-gray-100">Profile not found</h1>
            <p className="mx-auto mt-2 max-w-sm font-body text-xs leading-relaxed text-twist-lightgray">
              Nobody with the name “{username}” exists here yet.
            </p>
            <Link href="/" className={`${GHOST} mt-5 inline-flex items-center`}>
              <span className="font-body text-xs text-gray-300">Browse anime</span>
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  const userMessages = messages.filter((message) =>
    address
      ? message.address?.toLowerCase() === address
      : message.username.toLowerCase() === lower
  );
  const recent = [...userMessages].reverse().slice(0, 5);

  const badges = badgesFor({
    level: level ?? 1,
    xp: xpValue ?? 0,
    messages: userMessages.length,
    watched: watchedCount ?? 0,
  });

  return (
    <Shell>
      <div className="content-column mx-auto w-full px-4 py-6">
        <div className={`${CARD} mt-2 overflow-hidden`}>
          <div
            className="h-16 w-full"
            style={{ background: cardPreset(cardId).style }}
          />
          <div className="flex items-center gap-4 px-4 pb-4">
            <span className="-mt-7 flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-twist-900 bg-twist-800">
              <img
                src={avatarUrl(avatarSeed(displayName, avatarName))}
                alt={displayName}
                className="h-full w-full object-cover"
              />
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h1 className="truncate font-body text-xl text-gray-100">{displayName}</h1>
                {level !== undefined && (
                  <span className="shrink-0 rounded bg-twist-red px-1.5 py-0.5 font-body text-[10px] font-bold leading-4 text-white">
                    {level}
                  </span>
                )}
                {banned && (
                  <span className="shrink-0 rounded bg-twist-red px-1.5 py-0.5 font-body text-[10px] font-bold uppercase leading-4 text-white">
                    Banned
                  </span>
                )}
              </div>

              {address ? (
                <AddressRow address={address} />
              ) : (
                <span className="mt-1 block font-body text-xs text-twist-lightgray">
                  Public profile
                </span>
              )}
            </div>

            {isAdmin && address && !isRootAddress(address) && (
              <button
                onClick={() =>
                  banned ? moderateUnban(address) : moderateBan(address)
                }
                className={`${GHOST} shrink-0`}
              >
                <span className="font-body text-xs text-gray-300">
                  {banned ? 'Unban' : 'Ban user'}
                </span>
              </button>
            )}
          </div>
        </div>

        {banned && address && (
          <p className="mt-2 font-body text-[11px] text-twist-redlight">
            Banned by{' '}
            {(bannedBy[address] ?? []).map((admin) => shortAddress(admin)).join(', ')}
            {bannedReason[address] ? ` · “${bannedReason[address]}”` : ''}
          </p>
        )}

        <div className="mt-3 grid grid-cols-3 gap-3">
          {[
            { label: 'Messages', value: userMessages.length },
            { label: 'Level', value: level ?? '—' },
            { label: 'Watched', value: watchedCount ?? '—' },
          ].map((stat) => (
            <div key={stat.label} className={`${CARD} p-3 text-center`}>
              <span className="block font-body text-lg tabular-nums text-gray-100">
                {stat.value}
              </span>
              <span className="mt-0.5 block font-body text-[10px] uppercase tracking-wide text-twist-lightgray">
                {stat.label}
              </span>
            </div>
          ))}
        </div>

        {section('Badges', <BadgeRow badges={badges} />)}

        {section(
          'Recent messages',
          recent.length === 0 ? (
            <Empty message="Nothing said yet." />
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {recent.map((message) => (
                <p
                  key={message.id}
                  className="wrap-break-word rounded border border-twist-800 bg-twist-800/40 px-3 py-2 font-body text-xs text-gray-300"
                >
                  {message.gif ? 'GIF' : message.body}
                </p>
              ))}
            </div>
          )
        )}

      </div>
    </Shell>
  );
};

export const UserProfile = ({ username }: { username?: string }) => {
  const {
    account,
    signOut,
    level,
    xp,
    progress,
    resetProgress,
    removeProgress,
    ready,
    messages,
    comments,
    watched,
    openAuth,
    isAdmin,
    reports,
    moderateDelete,
    moderateBan,
    settings,
  } = useStore();

  const viewing = username?.trim();
  const isOwn =
    !viewing || (account !== null && account.username.toLowerCase() === viewing.toLowerCase());

  // Visiting your own profile while signed out prompts the auth modal.
  useEffect(() => {
    if (ready && !account && isOwn) openAuth();
  }, [ready, account, isOwn, openAuth]);

  // Real titles/genres for the watch history, resolved in the background.
  // (Every hook stays above the early returns.)
  const historyCards = useSlugCards(
    [...new Set(progress.map((entry) => entry.slug))].slice(0, 30)
  );
  const titleFor = (slug: string) => {
    const card = historyCards.get(slug);
    if (!card) return prettySlug(slug);
    return settings.titleLanguage === 'english' ? card.english || card.title : card.title;
  };

  if (!ready) {
    return (
      <Shell>
        <div className="content-column mx-auto w-full px-4 py-6" />
      </Shell>
    );
  }

  if (!isOwn && viewing) {
    return <PublicProfile username={viewing} />;
  }

  if (!account) {
    return (
      <Shell>
        <div className="content-column mx-auto w-full px-4 py-6">
          <div className={`${CARD} mt-6 p-6 text-center`}>
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-twist-800 text-twist-lightgray">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                className="h-5 w-5"
                aria-hidden="true"
              >
                <path d="M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-4.42 0-8 2.24-8 5v1h16v-1c0-2.76-3.58-5-8-5z" />
              </svg>
            </span>
            <h1 className="mt-4 font-body text-lg text-gray-100">
              You are not signed in
            </h1>
            <p className="mx-auto mt-2 max-w-sm font-body text-xs leading-relaxed text-twist-lightgray">
              Sign in to keep your watch history, level up and chat with everyone.
            </p>
            <div className="mt-5 flex items-center justify-center gap-2">
              <button
                onClick={openAuth}
                className="focus:outline-none cursor-default flex h-9 items-center rounded bg-twist-red px-4 border border-transparent transition duration-300 hover:bg-twist-reddark"
              >
                <span className="font-body text-xs text-gray-100">Sign in</span>
              </button>
              <Link href="/" className={`${GHOST} inline-flex items-center`}>
                <span className="font-body text-xs text-gray-300">Browse anime</span>
              </Link>
            </div>
          </div>
        </div>
      </Shell>
    );
  }

  const completed = progress.filter((entry) => entry.completed);
  const inProgress = progress
    .filter((entry) => !entry.completed)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const watchedSlugs = [...new Set(completed.map((entry) => entry.slug))];
  const started = new Set(progress.map((entry) => entry.slug)).size;

  const floorXp = levelFloorXp(level);
  const targetXp = nextLevelXp(level);
  const span = Math.max(targetXp - floorXp, 1);
  const intoLevel = Math.max(xp - floorXp, 0);
  const ratio = Math.min(1, Math.max(0, intoLevel / span));
  const remaining = Math.max(targetXp - xp, 0);

  const myMessages = messages.filter(
    (message) => message.address?.toLowerCase() === account.address?.toLowerCase()
  );
  const recentMessages = [...myMessages].reverse().slice(0, 5);

  const badges = badgesFor({
    level,
    xp,
    messages: myMessages.length,
    watched,
  });

  const genreCounts = new Map<string, number>();
  for (const slug of watchedSlugs) {
    for (const genre of historyCards.get(slug)?.genres ?? []) {
      genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1);
    }
  }
  const topGenres = [...genreCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxGenreCount = topGenres[0]?.[1] ?? 1;

  const resolveTarget = (target: string, targetType: string) => {
    if (targetType === 'message') {
      const message = messages.find((m) => m.id === target);
      return message ? `${message.username}: ${message.body.slice(0, 60)}` : null;
    }
    if (targetType === 'comment') {
      const comment = comments.find((c) => c.id === target);
      return comment ? `${comment.username}: ${comment.body.slice(0, 60)}` : null;
    }
    return null;
  };

  const targetAuthor = (target: string, targetType: string) => {
    if (targetType === 'message') return messages.find((m) => m.id === target)?.address;
    if (targetType === 'comment') return comments.find((c) => c.id === target)?.address;
    return undefined;
  };

  return (
    <Shell>
      <div className="content-column mx-auto w-full px-4 py-6">
        <div className={`${CARD} mt-2 overflow-hidden`}>
          <div
            className="h-16 w-full"
            style={{ background: cardPreset(account.card).style }}
          />
          <div className="flex items-center gap-4 px-4 pb-3">
            <span className="-mt-7 flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-twist-900 bg-twist-800">
              <img
                src={avatarUrl(avatarSeed(account.username, account.avatar))}
                alt={account.username}
                className="h-full w-full object-cover"
              />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h1 className="truncate font-body text-xl text-gray-100">
                  {account.username}
                </h1>
                <span className="shrink-0 rounded bg-twist-red px-1.5 py-0.5 font-body text-[10px] font-bold leading-4 text-white">
                  {level}
                </span>
                {isAdmin && (
                  <span className="shrink-0 rounded bg-twist-800 px-1.5 py-0.5 font-body text-[10px] font-bold uppercase leading-4 text-twist-lightgray">
                    Admin
                  </span>
                )}
              </div>
              <span className="mt-1 block font-body text-xs text-twist-lightgray">
                Member since{' '}
                {new Date(account.createdAt).toLocaleDateString(undefined, {
                  month: 'long',
                  year: 'numeric',
                })}
              </span>
            </div>
            <button onClick={signOut} className={`${GHOST} shrink-0`}>
              <span className="font-body text-xs text-gray-300">Log out</span>
            </button>
          </div>

          {account.address && (
            <div className="px-4 pb-4">
              <AddressRow address={account.address} />
            </div>
          )}
        </div>

        {isAdmin && (
          <div className={`${CARD} mt-3 p-4`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-body text-xs font-bold uppercase tracking-wide text-twist-red">
                Moderation
              </span>
              <span className="flex items-center gap-2">
                <span className="font-body text-[10px] text-twist-lightgray">
                  {isRootAddress(account?.address) ? 'Root admin' : 'Admin'} · {reports.length}{' '}
                  reports
                </span>
                <Link href="/admin" className={`${GHOST} h-6 px-2`}>
                  <span className="font-body text-[10px] text-gray-300">Open panel</span>
                </Link>
              </span>
            </div>

            {reports.length === 0 ? (
              <p className="mt-2 font-body text-xs text-twist-lightgray">
                No open reports.
              </p>
            ) : (
              <div className="mt-2 flex flex-col gap-2">
                {reports.map((report) => {
                  const preview = resolveTarget(
                    report.payload.target,
                    report.payload.targetType
                  );
                  const author = targetAuthor(
                    report.payload.target,
                    report.payload.targetType
                  );
                  return (
                    <div
                      key={report.id}
                      className="rounded border border-twist-800 bg-twist-900/40 p-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-body text-[11px] text-gray-300">
                          {report.payload.targetType} ·{' '}
                          {shortAddress(report.payload.target)}
                        </span>
                        <span className="shrink-0 font-body text-[10px] text-twist-lightgray">
                          by {shortAddress(report.author)}
                        </span>
                      </div>
                      {preview && (
                        <p className="mt-1 truncate font-body text-[11px] text-twist-lightgray">
                          {preview}
                        </p>
                      )}
                      <div className="mt-1.5 flex items-center gap-2">
                        <button
                          onClick={() => moderateDelete(report.payload.target)}
                          className="focus:outline-none cursor-default rounded bg-twist-800 px-2 h-6 border border-transparent transition duration-200 hover:border-twist-gray"
                        >
                          <span className="font-body text-[10px] text-gray-300">
                            Delete
                          </span>
                        </button>
                        {author && !isRootAddress(author) && (
                          <button
                            onClick={() => moderateBan(author)}
                            className="focus:outline-none cursor-default rounded bg-twist-800 px-2 h-6 border border-transparent transition duration-200 hover:border-twist-gray"
                          >
                            <span className="font-body text-[10px] text-gray-300">
                              Ban {shortAddress(author)}
                            </span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <ProfileTabs
          stats={<ProfileStats completed={completed.length} started={started} xp={xp} />}
          levelCard={
            <div className={`${CARD} mt-3 p-4`}>
              <div className="flex items-center justify-between">
                <span className="font-body text-xs font-bold uppercase tracking-wide text-twist-red">
                  Level {level}
                </span>
                <span className="font-body text-xs tabular-nums text-twist-lightgray">
                  {intoLevel} / {span} XP
                </span>
              </div>
              <div
                className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-twist-gray/50"
                role="progressbar"
                aria-label="Level progress"
                aria-valuemin={0}
                aria-valuemax={span}
                aria-valuenow={intoLevel}
              >
                <div className="h-full rounded-full bg-twist-red" style={{ width: `${ratio * 100}%` }} />
              </div>
              <span className="mt-2 block font-body text-xs text-twist-lightgray">
                {remaining} XP to level {level + 1}
              </span>
            </div>
          }
          continueWatching={
            <ContinueWatching entries={inProgress} titleFor={titleFor} cardFor={historyCards} />
          }
          history={
            <WatchHistory
              entries={progress}
              titleFor={titleFor}
              onRemove={(slug, episode) => removeProgress(slug, episode)}
            />
          }
          badges={<BadgeRow badges={badges} />}
          genres={
            topGenres.length === 0 ? (
              <Empty message="Watch a few episodes to build your taste profile." />
            ) : (
              <div className="flex flex-col gap-2.5">
                {topGenres.map(([genre, count]) => (
                  <div key={genre}>
                    <div className="flex items-center justify-between">
                      <span className="font-body text-sm text-gray-300">{genre}</span>
                      <span className="font-body text-xs tabular-nums text-twist-lightgray">
                        {count} {count === 1 ? 'title' : 'titles'}
                      </span>
                    </div>
                    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-twist-gray/50">
                      <div className="h-full rounded-full bg-twist-red" style={{ width: `${(count / maxGenreCount) * 100}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            )
          }
          activity={
            recentMessages.length === 0 ? (
              <Empty message="No messages yet." />
            ) : (
              <div className="flex flex-col gap-2">
                {recentMessages.map((message) => (
                  <p
                    key={message.id}
                    className="wrap-break-word rounded border border-twist-800 bg-twist-800/40 px-3 py-2 font-body text-xs text-gray-300"
                  >
                    {message.gif ? 'GIF' : message.body}
                  </p>
                ))}
              </div>
            )
          }
          footer={
            <button onClick={resetProgress} className={`${GHOST} mt-4`}>
              <span className="font-body text-xs text-gray-300">Clear history</span>
            </button>
          }
        />
      </div>
    </Shell>
  );
};
