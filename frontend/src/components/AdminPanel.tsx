import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useStore } from '../lib/store';
import { isRootAddress, ROOT_ADDRESS } from '../lib/moderation';
import { avatarSeed, avatarUrl } from '../lib/profile';
import { shortAddress } from '../lib/wallet';
import { Shell } from './Shell';

const CARD = 'rounded-lg border border-twist-800 bg-twist-800/40';
const GHOST =
  'focus:outline-none cursor-default rounded border border-transparent bg-twist-800 transition duration-200 hover:border-twist-gray disabled:cursor-not-allowed disabled:opacity-40';
const DANGER =
  'focus:outline-none cursor-default rounded border border-transparent bg-twist-red/15 transition duration-200 hover:border-twist-red disabled:cursor-not-allowed disabled:opacity-40';

const timeAgo = (ts: number) => {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

/** Caption under the title: which address roots the moderation tree. */
const chainNoticeRole = (root?: string) => (root ? `root ${shortAddress(root)}` : 'no root admin yet');

const Stat = ({ label, value, accent }: { label: string; value: number; accent?: boolean }) => (
  <div className={`${CARD} flex flex-col items-center p-3`}>
    <span
      className={`block font-body text-lg tabular-nums ${accent ? 'text-twist-red' : 'text-gray-100'}`}
    >
      {value}
    </span>
    <span className="mt-0.5 block font-body text-[10px] uppercase tracking-wide text-twist-lightgray">
      {label}
    </span>
  </div>
);

const Section = ({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) => (
  <div className={`${CARD} mt-4 p-4`}>
    <div className="flex items-baseline justify-between gap-2">
      <span className="font-body text-xs font-bold uppercase tracking-wide text-twist-red">
        {title}
      </span>
      {hint && <span className="font-body text-[10px] text-twist-lightgray">{hint}</span>}
    </div>
    {children}
  </div>
);

const AddressChip = ({ address }: { address: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={address}
      onClick={() => {
        void navigator.clipboard?.writeText(address).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          },
          () => undefined
        );
      }}
      className="focus:outline-none cursor-default font-body text-[11px] tabular-nums text-twist-lightgray transition duration-200 hover:text-gray-200"
    >
      {copied ? 'Copied' : shortAddress(address)}
    </button>
  );
};

/** Admin-only moderation dashboard. Renders nothing but a gate for everyone else. */
export const AdminPanel = () => {
  const {
    ready,
    account,
    openAuth,
    moderationReady,
    isAdmin,
    genesis,
    admins,
    bannedAddresses,
    bannedBy,
    bannedReason,
    reports,
    users,
    messages,
    comments,
    moderateDelete,
    moderateBan,
    moderateUnban,
    moderateAdmin,
  } = useStore();

  const [newAdmin, setNewAdmin] = useState('');
  const [query, setQuery] = useState('');

  const banned = useMemo(() => new Set(bannedAddresses.map((a) => a.toLowerCase())), [bannedAddresses]);

  // Report targets: the visible message/comment, so the admin can judge it.
  const resolveTarget = (target: string, targetType: string) => {
    if (targetType === 'message') {
      const message = messages.find((m) => m.id === target);
      return message ? `${message.username || shortAddress(message.address ?? '')}: ${message.gif ? 'GIF' : message.body.slice(0, 90)}` : null;
    }
    if (targetType === 'comment') {
      const comment = comments.find((c) => c.id === target);
      return comment ? `${comment.username || shortAddress(comment.address ?? '')}: ${comment.body.slice(0, 90)}` : null;
    }
    return null;
  };

  const targetAuthor = (target: string, targetType: string) => {
    if (targetType === 'address') return target;
    if (targetType === 'message') return messages.find((m) => m.id === target)?.address;
    if (targetType === 'comment') return comments.find((c) => c.id === target)?.address;
    return undefined;
  };

  const directory = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return Object.values(users)
      .filter((user) => {
        if (!needle) return true;
        return (
          (user.username ?? '').toLowerCase().includes(needle) ||
          user.address.toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => (a.username ?? '').localeCompare(b.username ?? '') || a.address.localeCompare(b.address));
  }, [users, query]);

  // The pinned root is known up front; the chain registry only fills in the rest.
  const rootAddress = (genesis?.address ?? ROOT_ADDRESS).toLowerCase();
  const adminList = admins.includes(rootAddress) ? admins : [rootAddress, ...admins];

  /* ------------------------------- gates -------------------------------- */

  if (!ready) {
    return (
      <Shell>
        <div className="mx-auto w-full max-w-3xl px-4 py-6">
          <div className={`${CARD} mt-2 h-24 animate-pulse`} />
        </div>
      </Shell>
    );
  }

  if (!account) {
    return (
      <Shell>
        <div className="mx-auto w-full max-w-3xl px-4 py-6">
          <div className={`${CARD} mt-6 p-6 text-center`}>
            <h1 className="font-body text-lg text-gray-100">Admins only</h1>
            <p className="mx-auto mt-2 max-w-sm font-body text-xs leading-relaxed text-twist-lightgray">
              Sign in with an admin account to open the moderation panel.
            </p>
            <button onClick={openAuth} className={`${GHOST} mt-5 h-9 px-3`}>
              <span className="font-body text-xs text-gray-300">Sign in</span>
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  // Signed in but the admin fold has not landed yet: we do not know the role.
  if (!isAdmin && !moderationReady) {
    return (
      <Shell>
        <div className="mx-auto w-full max-w-3xl px-4 py-6">
          <div className={`${CARD} mt-2 h-24 animate-pulse`} />
        </div>
      </Shell>
    );
  }

  if (!isAdmin) {
    return (
      <Shell>
        <div className="mx-auto w-full max-w-3xl px-4 py-6">
          <div className={`${CARD} mt-6 p-6 text-center`}>
            <h1 className="font-body text-lg text-gray-100">Admins only</h1>
            <p className="mx-auto mt-2 max-w-sm font-body text-xs leading-relaxed text-twist-lightgray">
              This account is not an admin. Ask an existing admin to add you.
            </p>
            <Link
              href="/"
              className={`${GHOST} mt-5 inline-flex h-9 items-center px-3`}
            >
              <span className="font-body text-xs text-gray-300">Browse anime</span>
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  /* ------------------------------ dashboard ------------------------------ */

  return (
    <Shell>
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h1 className="font-body text-xl text-gray-100">Admin</h1>
            <span className="rounded bg-twist-red px-1.5 py-0.5 font-body text-[10px] font-bold uppercase leading-4 text-white">
              {rootAddress === account.address?.toLowerCase() ? 'Root' : 'Admin'}
            </span>
          </div>
          <span className="font-body text-[10px] text-twist-lightgray">
            {chainNoticeRole(rootAddress)} · signed in as {account.username}
          </span>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Reports" value={reports.length} accent={reports.length > 0} />
          <Stat label="Banned" value={bannedAddresses.length} accent={bannedAddresses.length > 0} />
          <Stat label="Admins" value={adminList.length} />
          <Stat label="Users" value={Object.keys(users).length} />
        </div>

        {/* ------------------------------ reports ----------------------------- */}
        <Section title="Reports" hint={reports.length ? `${reports.length} open` : 'queue clear'}>
          {reports.length === 0 ? (
            <p className="mt-2 font-body text-xs text-twist-lightgray">No open reports.</p>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {reports.map((report) => {
                const preview = resolveTarget(report.payload.target, report.payload.targetType);
                const author = targetAuthor(report.payload.target, report.payload.targetType);
                const authorBanned = author ? banned.has(author.toLowerCase()) : false;
                return (
                  <div key={report.id} className="rounded border border-twist-800 bg-twist-900/40 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="rounded bg-twist-800 px-1.5 py-0.5 font-body text-[9px] font-bold uppercase tracking-wide text-twist-lightgray">
                          {report.payload.targetType}
                        </span>
                        <span className="truncate font-body text-[11px] text-gray-300">
                          {preview ?? shortAddress(report.payload.target)}
                        </span>
                      </span>
                      <span className="shrink-0 font-body text-[10px] text-twist-lightgray">
                        {timeAgo(report.ts)}
                      </span>
                    </div>

                    {report.payload.reason && (
                      <p className="mt-1.5 font-body text-[11px] italic text-twist-lightgray">
                        “{report.payload.reason}”
                      </p>
                    )}
                    <p className="mt-1 font-body text-[10px] text-twist-lightgray">
                      reported by <AddressChip address={report.author} />
                    </p>

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => moderateDelete(report.payload.target)}
                        className={`${DANGER} h-7 px-2.5`}
                      >
                        <span className="font-body text-[11px] text-gray-200">Delete content</span>
                      </button>
                      {author && !isRootAddress(author) && (
                        <button
                          onClick={() => moderateBan(author, report.payload.reason)}
                          disabled={authorBanned}
                          className={`${GHOST} h-7 px-2.5`}
                        >
                          <span className="font-body text-[11px] text-gray-300">
                            {authorBanned ? 'Banned' : `Ban ${shortAddress(author)}`}
                          </span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        {/* ------------------------------- banned ----------------------------- */}
        <Section title="Banned" hint={bannedAddresses.length ? `${bannedAddresses.length} accounts` : undefined}>
          {bannedAddresses.length === 0 ? (
            <p className="mt-2 font-body text-xs text-twist-lightgray">Nobody is banned.</p>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {[...bannedAddresses]
                .sort()
                .map((address) => {
                  const adminsWhoBanned = bannedBy[address] ?? [];
                  const automatic = adminsWhoBanned.length === 0;
                  return (
                    <div
                      key={address}
                      className="flex flex-wrap items-center justify-between gap-2 rounded border border-twist-800 bg-twist-900/40 px-3 py-2"
                    >
                      <span className="flex min-w-0 flex-col">
                        <AddressChip address={address} />
                        <span className="font-body text-[10px] text-twist-lightgray">
                          {bannedReason[address] ? `“${bannedReason[address]}”` : 'no reason given'}
                          {!automatic && ` · by ${adminsWhoBanned.map(shortAddress).join(', ')}`}
                          {automatic && ' · duplicate username (automatic)'}
                        </span>
                      </span>
                      <button
                        onClick={() => moderateUnban(address)}
                        disabled={automatic}
                        title={automatic ? 'Automatic bans cannot be lifted' : 'Unban'}
                        className={`${GHOST} h-7 px-2.5`}
                      >
                        <span className="font-body text-[11px] text-gray-300">Unban</span>
                      </button>
                    </div>
                  );
                })}
            </div>
          )}
        </Section>

        {/* ------------------------------- admins ----------------------------- */}
        <Section title="Admins" hint={`${adminList.length} with moderation keys`}>
          <div className="mt-3 flex flex-col gap-2">
            {adminList.map((address) => {
              const isRoot = rootAddress === address.toLowerCase();
              const isSelf = account.address?.toLowerCase() === address.toLowerCase();
              return (
                <div
                  key={address}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-twist-800 bg-twist-900/40 px-3 py-2"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <AddressChip address={address} />
                    {isRoot && (
                      <span className="rounded bg-twist-red/20 px-1.5 py-0.5 font-body text-[9px] font-bold uppercase tracking-wide text-twist-red">
                        Root
                      </span>
                    )}
                    {isSelf && !isRoot && (
                      <span className="font-body text-[10px] text-twist-lightgray">you</span>
                    )}
                  </span>
                  <button
                    onClick={() => moderateAdmin('remove', address)}
                    disabled={isRoot || (isSelf && adminList.length <= 1)}
                    title={isRoot ? 'The root admin cannot be removed' : 'Remove admin'}
                    className={`${GHOST} h-7 px-2.5`}
                  >
                    <span className="font-body text-[11px] text-gray-300">Remove</span>
                  </button>
                </div>
              );
            })}
          </div>

          <form
            className="mt-3 flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const address = newAdmin.trim().toLowerCase();
              if (!/^0x[a-f0-9]{40}$/.test(address)) return;
              moderateAdmin('add', address);
              setNewAdmin('');
            }}
          >
            <input
              value={newAdmin}
              onChange={(event) => setNewAdmin(event.target.value)}
              placeholder="0x… wallet address"
              spellCheck={false}
              className="min-w-0 flex-1 rounded border border-twist-700 bg-twist-900 px-2 py-1.5 font-body text-xs text-gray-200 placeholder-twist-lightgray transition duration-200 focus:border-twist-red focus:outline-none"
            />
            <button
              type="submit"
              disabled={!/^0x[a-f0-9]{40}$/.test(newAdmin.trim().toLowerCase())}
              className={`${GHOST} h-8 px-3`}
            >
              <span className="font-body text-xs text-gray-300">Add admin</span>
            </button>
          </form>
        </Section>

        {/* -------------------------------- users ----------------------------- */}
        <Section title="Users" hint={`${directory.length} shown`}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search username or address…"
            className="mt-3 w-full rounded border border-twist-700 bg-twist-900 px-2 py-1.5 font-body text-xs text-gray-200 placeholder-twist-lightgray transition duration-200 focus:border-twist-red focus:outline-none"
          />

          {directory.length === 0 ? (
            <p className="mt-3 font-body text-xs text-twist-lightgray">No matching accounts.</p>
          ) : (
            <div className="mt-3 flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
              {directory.map((user) => {
                const name = user.username?.trim() || `User ${shortAddress(user.address)}`;
                const isBanned = banned.has(user.address.toLowerCase());
                return (
                  <div
                    key={user.address}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border border-twist-800 bg-twist-900/40 px-3 py-2"
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className="h-7 w-7 shrink-0 overflow-hidden rounded-full bg-twist-800">
                        <img
                          src={avatarUrl(avatarSeed(user.username || user.address, user.avatar))}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="flex items-center gap-1.5">
                          {user.username ? (
                            <Link
                              href={`/profile/${encodeURIComponent(user.username)}`}
                              className="truncate font-body text-xs text-gray-300 transition duration-200 hover:text-gray-100"
                            >
                              {name}
                            </Link>
                          ) : (
                            <span className="truncate font-body text-xs text-gray-300">{name}</span>
                          )}
                          {user.level != null && (
                            <span className="shrink-0 rounded bg-twist-800 px-1 py-0.5 font-body text-[9px] tabular-nums text-twist-lightgray">
                              Lv {user.level}
                            </span>
                          )}
                          {isBanned && (
                            <span className="shrink-0 rounded bg-twist-red/20 px-1 py-0.5 font-body text-[9px] font-bold uppercase tracking-wide text-twist-red">
                              Banned
                            </span>
                          )}
                        </span>
                        <AddressChip address={user.address} />
                      </span>
                    </span>
                    {isBanned ? (
                      <button
                        onClick={() => moderateUnban(user.address)}
                        className={`${GHOST} h-7 px-2.5`}
                      >
                        <span className="font-body text-[11px] text-gray-300">Unban</span>
                      </button>
                    ) : isRootAddress(user.address) ? (
                      <span className="font-body text-[10px] text-twist-lightgray">Root</span>
                    ) : (
                      <button
                        onClick={() => moderateBan(user.address)}
                        className={`${GHOST} h-7 px-2.5`}
                      >
                        <span className="font-body text-[11px] text-gray-300">Ban</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Section>

      </div>
    </Shell>
  );
};
