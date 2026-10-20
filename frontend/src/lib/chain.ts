/**
 * Chain bridge: publishes and syncs the app's documents (chat messages,
 * comments, account records) through Irys, using the protocol envelope.
 *
 * Every fetched document is verified (`validateEnvelope`) before it is
 * handed to the store — forged or malformed documents are dropped.
 */
import type {
  AdminAction,
  BanAction,
  DeleteAction,
  ModerationDocs,
  ReportAction,
  UnbanAction,
} from './moderation';
import { fetchDoc, floorToHour, queryNodes, type ChainNode } from './irys';
import { claimOf, ensureNameClaims, isLedgerComplete, noteClaim, syncNameClaims } from './names';
import { buildEnvelope, validateEnvelope, APP, PROTOCOL_VERSION, SITE_ID, type Envelope, type EnvelopeTag } from './protocol';
import { encryptJson, type Wallet } from './wallet';

const DAY_MS = 24 * 60 * 60 * 1000;

export type RemoteMessage = {
  id: string;
  author: string;
  username: string;
  body: string;
  gif?: string;
  replyTo?: { username: string; body: string };
  at: number;
};

export type RemoteComment = {
  id: string;
  slug: string;
  episode: number;
  parentId?: string;
  replyToId?: string;
  username: string;
  body: string;
  at: number;
  address: string;
};

const baseTags = (type: string, ts: number, extra: EnvelopeTag[] = []): EnvelopeTag[] => [
  { name: 'App', value: APP },
  { name: 'Site', value: SITE_ID },
  { name: 'Type', value: type },
  { name: 'V', value: String(PROTOCOL_VERSION) },
  { name: 'TS', value: String(ts) },
  ...extra,
];

/** Runs `fn` over `items` with bounded concurrency (keeps the gateway queue short). */
const mapLimit = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> => {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length || 1));
  const workers = Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
};

/* ------------------------------- publishing ------------------------------ */

export const publishChatMessage = async (
  wallet: Wallet,
  body: string,
  options?: { gif?: string; replyTo?: { username: string; body: string } }
): Promise<string> => {
  const payload = {
    username: wallet.username,
    body,
    gif: options?.gif,
    replyTo: options?.replyTo,
  };
  const { envelope } = buildEnvelope(wallet.identityPrivateKey, 'chat.message', payload);
  // Return the upload's own id so the optimistic local copy carries the same id
  // the indexer will serve — otherwise tombstones/deletes never match it.
  return uploadSigned(wallet.identityPrivateKey, envelope, baseTags('chat.message', envelope.ts, [
    { name: 'Channel', value: 'general' },
  ]));
};

export const publishComment = async (
  wallet: Wallet,
  comment: {
    slug: string;
    episode: number;
    parentId?: string;
    replyToId?: string;
    body: string;
  }
): Promise<string> => {
  const payload = { username: wallet.username, ...comment };
  const { envelope } = buildEnvelope(wallet.identityPrivateKey, 'comment.message', payload);
  return uploadSigned(wallet.identityPrivateKey, envelope, baseTags('comment.message', envelope.ts, [
    { name: 'Slug', value: comment.slug },
    { name: 'Episode', value: String(comment.episode) },
  ]));
};

/** Private account genesis (capability-tagged, unlinkable upload key). */
export const publishGenesis = async (wallet: Wallet): Promise<void> => {
  const enc = await encryptJson(wallet.encryptionKey, 'twist:v1:account.genesis', {
    username: wallet.username,
  });
  const genesis = buildEnvelope(wallet.identityPrivateKey, 'account.genesis', { enc });
  await uploadSigned(wallet.uploadPrivateKey, genesis.envelope, baseTags('account.genesis', genesis.envelope.ts, [
    { name: 'Owner', value: wallet.ownerTag },
  ]));
};

/** Account genesis + public profile + stats. Best-effort; callers catch. */
export const publishAccount = async (
  wallet: Wallet,
  profile: { avatar?: string; card?: string; settings?: ProfileSettings },
  stats: { level: number; xp: number; watched: number }
): Promise<void> => {
  await publishGenesis(wallet);
  await publishProfile(wallet, profile);
  await publishStats(wallet, stats);
};

/**
 * The public slice of a user's preferences, published with the profile so a
 * fresh device (or a lost vault) still gets their look and playback setup.
 * Clients validate every field before applying anything.
 */
export type ProfileSettings = {
  theme?: string;
  accent?: string;
  viewMode?: string;
  titleLanguage?: string;
  autoplay?: boolean;
  autoNext?: boolean;
  autoSkip?: boolean;
  controls?: string;
  subtitles?: string;
  subtitleStyle?: Record<string, unknown>;
  subtitlesOn?: Record<string, boolean>;
  autoNextDelay?: number;
  player?: string;
  subtitleLanguage?: string;
  defaultTrack?: string;
  /** Home page layout, synced with the rest of the appearance settings. */
  homeLogo?: boolean;
  homeSearch?: boolean;
  homeWidth?: number;
  homeColumns?: number;
};

export const publishProfile = async (
  wallet: Wallet,
  profile: { avatar?: string; card?: string; settings?: ProfileSettings }
): Promise<void> => {
  const payload = {
    username: wallet.username,
    avatar: profile.avatar,
    card: profile.card,
    settings: profile.settings,
    updatedAt: Date.now(),
  };
  const { envelope } = buildEnvelope(wallet.identityPrivateKey, 'profile', payload);
  await uploadSigned(wallet.identityPrivateKey, envelope, baseTags('profile', envelope.ts, [
    { name: 'Username', value: wallet.username },
  ]));
};

export const publishStats = async (
  wallet: Wallet,
  stats: { level: number; xp: number; watched: number }
): Promise<void> => {
  const { envelope } = buildEnvelope(wallet.identityPrivateKey, 'stats', stats);
  await uploadSigned(wallet.identityPrivateKey, envelope, baseTags('stats', envelope.ts));
};

const uploadSigned = async (
  uploadKey: Uint8Array,
  envelope: unknown,
  tags: EnvelopeTag[]
): Promise<string> => {
  const { uploadDoc } = await import('./irys');
  return uploadDoc(uploadKey, JSON.stringify(envelope), tags);
};

/** True when a profile already claims this username. Answered from the local
 * ledger — scanning the `Username` tag is unreliable on the indexer, so the
 * chunked walk in `names.ts` keeps the ledger current instead. */
export const isUsernameClaimed = async (username: string): Promise<boolean> => {
  if (!isLedgerComplete()) void syncNameClaims().catch(() => false);
  return claimOf(username) !== undefined;
};

/* --------------------------------- syncing ------------------------------- */

type ChatPayload = {
  username?: string;
  body?: string;
  gif?: string;
  replyTo?: { username: string; body: string };
};

const readVerified = async <T>(
  id: string,
  type: string,
  priority = false
): Promise<{ envelope: ReturnType<typeof validateEnvelope<T>>; payload: T } | null> => {
  try {
    const envelope = validateEnvelope<T>(JSON.parse(await fetchDoc(id, priority)), type);
    if (!envelope) return null;
    return { envelope, payload: envelope.payload };
  } catch {
    return null;
  }
};

export const syncChat = async (
  knownIds: Set<string>,
  since: number
): Promise<RemoteMessage[]> => {
  const { nodes } = await queryNodes(
    [
      { name: 'Site', values: [SITE_ID] },
      { name: 'Type', values: ['chat.message'] },
    ],
    { from: since, limit: 50, order: 'DESC' }
  );

  const fresh = nodes.filter((node) => !knownIds.has(node.id)).slice(0, 20);

  const messages: RemoteMessage[] = [];
  await Promise.all(
    fresh.map(async (node) => {
      const doc = await readVerified<ChatPayload>(node.id, 'chat.message', true);
      if (!doc) return;

      const payload = doc.payload ?? {};
      if (!payload.body && !payload.gif) return;

      messages.push({
        id: node.id,
        author: doc.envelope!.author,
        username: payload.username?.trim() || '',
        body: payload.body ?? '',
        gif: payload.gif,
        replyTo: payload.replyTo,
        at: doc.envelope!.ts,
      });
    })
  );

  return messages.sort((a, b) => a.at - b.at);
};

export const syncComments = async (
  slug: string,
  episode: number,
  knownIds: Set<string>
): Promise<RemoteComment[]> => {
  const { nodes } = await queryNodes(
    [
      { name: 'Site', values: [SITE_ID] },
      { name: 'Type', values: ['comment.message'] },
      { name: 'Slug', values: [slug] },
      { name: 'Episode', values: [String(episode)] },
    ],
    { from: Date.now() - 365 * 24 * 60 * 60 * 1000, limit: 60, order: 'DESC' }
  );

  const fresh = nodes.filter((node) => !knownIds.has(node.id)).slice(0, 40);

  const comments: RemoteComment[] = [];
  await Promise.all(
    fresh.map(async (node) => {
      const doc = await readVerified<{
        username?: string;
        slug?: string;
        episode?: number;
        parentId?: string;
        replyToId?: string;
        body?: string;
      }>(node.id, 'comment.message', true);
      if (!doc || !doc.payload.body) return;

      comments.push({
        id: node.id,
        slug,
        episode,
        parentId: doc.payload.parentId,
        replyToId: doc.payload.replyToId,
        username: doc.payload.username?.trim() || '',
        body: doc.payload.body,
        at: doc.envelope!.ts,
        address: doc.envelope!.author,
      });
    })
  );

  return comments.sort((a, b) => a.at - b.at);
};

/* ------------------------------ profiles -------------------------------- */

export type RemoteUser = {
  address: string;
  /** Absent when the user has not published a profile document yet. */
  username?: string;
  /** Timestamp of the profile document (oldest claim wins a username). */
  profileTs?: number;
  avatar?: string;
  card?: string;
  /** Public appearance/playback preferences carried by the profile. */
  settings?: ProfileSettings;
  level?: number;
  xp?: number;
  watched?: number;
  updatedAt: number;
};

/** Fetches real profile + stats documents for every known author. */
export const syncProfiles = async (since: number): Promise<RemoteUser[]> => {
  const { nodes } = await queryNodes(
    [
      { name: 'Site', values: [SITE_ID] },
      { name: 'Type', values: ['profile', 'stats'] },
    ],
    { from: since, limit: 100, order: 'DESC' }
  );

  type Entry = {
    address: string;
    ts: number;
    profile?: { username?: string; avatar?: string; card?: string; settings?: ProfileSettings };
    profileTs?: number;
    stats?: { level?: number; xp?: number; watched?: number };
  };

  const entries = new Map<string, Entry>();

  await mapLimit(nodes, 6, async (node) => {
      const type = node.tags.Type;
      if (type === 'profile') {
        const doc = await readVerified<{
          username?: string;
          avatar?: string;
          card?: string;
          settings?: ProfileSettings;
        }>(node.id, 'profile');
        if (!doc) return;
        const address = doc.envelope!.author.toLowerCase();
        const entry = entries.get(address) ?? { address, ts: 0 };
        if (doc.envelope!.ts >= (entry.profileTs ?? 0)) {
          entry.profile = doc.payload;
          entry.profileTs = doc.envelope!.ts;
        }
        entry.ts = Math.max(entry.ts, doc.envelope!.ts);
        entries.set(address, entry);
      } else if (type === 'stats') {
        const doc = await readVerified<{ level?: number; xp?: number; watched?: number }>(
          node.id,
          'stats'
        );
        if (!doc) return;
        const address = doc.envelope!.author.toLowerCase();
        const entry = entries.get(address) ?? { address, ts: 0 };
        if (doc.envelope!.ts >= entry.ts) entry.stats = doc.payload;
        entry.ts = Math.max(entry.ts, doc.envelope!.ts);
        entries.set(address, entry);
      }
  });

  const users = [...entries.values()].map((entry) => ({
    address: entry.address,
    username: entry.profile?.username?.trim() || undefined,
    profileTs: entry.profileTs,
    avatar: entry.profile?.avatar,
    card: entry.profile?.card,
    settings: entry.profile?.settings,
    level: entry.stats?.level,
    xp: entry.stats?.xp,
    watched: entry.stats?.watched,
    updatedAt: entry.ts,
  }));

  // Every profile document teaches the local ledger a claim.
  for (const user of users) {
    if (user.username) noteClaim(user.username, user.profileTs ?? user.updatedAt, user.address);
  }

  return users;
};

/** Direct lookup of a user's published profile + stats for the profile page. */
export type PublicProfileData = {
  address: string;
  username?: string;
  avatar?: string;
  card?: string;
  level?: number;
  xp?: number;
  watched?: number;
};

type ProfilePayload = { username?: string; avatar?: string; card?: string };
type StatsPayload = { level?: number; xp?: number; watched?: number };
type ProfileDoc = { envelope: Envelope<ProfilePayload> | null; payload: ProfilePayload };

const readNewestProfile = async (nodes: ChainNode[]): Promise<ProfileDoc | null> => {
  const docs = (
    await Promise.all(
      nodes.map((node) => readVerified<ProfilePayload>(node.id, 'profile'))
    )
  ).filter((doc): doc is ProfileDoc => doc !== null);

  docs.sort((a, b) => (b.envelope?.ts ?? 0) - (a.envelope?.ts ?? 0));
  return docs[0] ?? null;
};

/** Owner-scoped profile fetch — cheap even over a wide window. */
const readProfileByAuthor = async (address: string, from: number) => {
  const { nodes } = await queryNodes(
    [
      { name: 'Site', values: [SITE_ID] },
      { name: 'Type', values: ['profile'] },
    ],
    { from, owners: [address], limit: 5, order: 'DESC' }
  );
  return readNewestProfile(nodes);
};

const readStats = async (address: string, from: number): Promise<StatsPayload | undefined> => {
  try {
    const { nodes } = await queryNodes(
      [
        { name: 'Site', values: [SITE_ID] },
        { name: 'Type', values: ['stats'] },
      ],
      { from, owners: [address], limit: 5, order: 'DESC' }
    );

    const docs = (
      await Promise.all(nodes.map((node) => readVerified<StatsPayload>(node.id, 'stats')))
    ).filter((doc): doc is NonNullable<typeof doc> => doc !== null);
    docs.sort((a, b) => (b.envelope?.ts ?? 0) - (a.envelope?.ts ?? 0));
    return docs[0]?.payload;
  } catch {
    return undefined;
  }
};

export const lookupProfile = async (username: string): Promise<PublicProfileData | null> => {
  const name = username.trim().toLowerCase();
  const yearAgo = floorToHour(Date.now() - 365 * DAY_MS);

  // Names are only ever learned from profile documents (the walk), never
  // from a `Username`-tag scan — that query shape is unreliable.
  let address = claimOf(name)?.address;
  if (!address) {
    await ensureNameClaims(8, true).catch(() => false);
    address = claimOf(name)?.address;
  }
  if (!address) return null;

  let newest: ProfileDoc | null = null;
  try {
    newest = await readProfileByAuthor(address, yearAgo);
  } catch {
    return null;
  }

  if (!newest?.envelope) return null;
  const stats = await readStats(address, yearAgo);

  return {
    address,
    username: newest.payload.username?.trim() || undefined,
    avatar: newest.payload.avatar,
    card: newest.payload.card,
    level: stats?.level,
    xp: stats?.xp,
    watched: stats?.watched,
  };
};

/* ------------------------------ moderation ------------------------------- */

export const publishRegistry = async (
  wallet: Wallet,
  action: 'add' | 'remove',
  subject: string,
  genesis = false
): Promise<void> => {
  const payload: AdminAction = { action, subject: subject.toLowerCase(), genesis };
  const { envelope } = buildEnvelope(wallet.identityPrivateKey, 'admin.registry', payload);
  await uploadSigned(wallet.identityPrivateKey, envelope, baseTags('admin.registry', envelope.ts, [
    { name: 'Admin', value: wallet.address },
    { name: 'Subject', value: subject.toLowerCase() },
  ]));
};

export const publishBan = async (
  wallet: Wallet,
  subject: string,
  reason?: string
): Promise<void> => {
  const payload: BanAction = { subject: subject.toLowerCase(), reason };
  const { envelope } = buildEnvelope(wallet.identityPrivateKey, 'mod.ban', payload);
  await uploadSigned(wallet.identityPrivateKey, envelope, baseTags('mod.ban', envelope.ts, [
    { name: 'Admin', value: wallet.address },
    { name: 'Target', value: subject.toLowerCase() },
  ]));
};

export const publishUnban = async (wallet: Wallet, subject: string): Promise<void> => {
  const payload: UnbanAction = { subject: subject.toLowerCase() };
  const { envelope } = buildEnvelope(wallet.identityPrivateKey, 'mod.unban', payload);
  await uploadSigned(wallet.identityPrivateKey, envelope, baseTags('mod.unban', envelope.ts, [
    { name: 'Admin', value: wallet.address },
    { name: 'Target', value: subject.toLowerCase() },
  ]));
};

export const publishDelete = async (
  wallet: Wallet,
  target: string,
  reason?: string
): Promise<void> => {
  const payload: DeleteAction = { target, reason };
  const { envelope } = buildEnvelope(wallet.identityPrivateKey, 'mod.delete', payload);
  await uploadSigned(wallet.identityPrivateKey, envelope, baseTags('mod.delete', envelope.ts, [
    { name: 'Target', value: target },
  ]));
};

export const publishReport = async (
  wallet: Wallet,
  report: { target: string; targetType: 'message' | 'comment' | 'address'; reason?: string }
): Promise<void> => {
  const payload: ReportAction = report;
  const { envelope } = buildEnvelope(wallet.identityPrivateKey, 'report', payload);
  await uploadSigned(wallet.identityPrivateKey, envelope, baseTags('report', envelope.ts, [
    { name: 'Target', value: report.target },
  ]));
};

const MOD_TYPES = ['admin.registry', 'mod.ban', 'mod.unban', 'mod.delete', 'report'] as const;

type VerifiedMod<T> = { id: string; author: string; ts: number; payload: T };

const readMod = async <T>(id: string, type: string): Promise<VerifiedMod<T> | null> => {
  try {
    const envelope = validateEnvelope<T>(JSON.parse(await fetchDoc(id, true)), type);
    if (!envelope?.payload) return null;
    return { id, author: envelope.author, ts: envelope.ts, payload: envelope.payload };
  } catch {
    return null;
  }
};

const hasSubjectOrTarget = <T>(payload: T) => {
  const value = payload as Record<string, unknown> | null;
  if (!value) return false;
  return typeof value.subject === 'string' || typeof value.target === 'string';
};

/** Fetches and cryptographically verifies every moderation document. */
export const syncModeration = async (since: number): Promise<ModerationDocs> => {
  const { nodes } = await queryNodes([{ name: 'Type', values: [...MOD_TYPES] }], {
    from: since,
    limit: 100,
    order: 'DESC',
  });

  const docs: ModerationDocs = {
    registry: [],
    bans: [],
    unbans: [],
    deletes: [],
    reports: [],
  };

  await Promise.all(
    nodes.map(async (node) => {
      const type = node.tags.Type;

      try {
        switch (type) {
          case 'admin.registry': {
            const doc = await readMod<AdminAction>(node.id, type);
            if (doc && hasSubjectOrTarget(doc.payload)) docs.registry.push(doc);
            return;
          }
          case 'mod.ban': {
            const doc = await readMod<BanAction>(node.id, type);
            if (doc && hasSubjectOrTarget(doc.payload)) docs.bans.push(doc);
            return;
          }
          case 'mod.unban': {
            const doc = await readMod<UnbanAction>(node.id, type);
            if (doc && hasSubjectOrTarget(doc.payload)) docs.unbans.push(doc);
            return;
          }
          case 'mod.delete': {
            const doc = await readMod<DeleteAction>(node.id, type);
            if (doc && hasSubjectOrTarget(doc.payload)) docs.deletes.push(doc);
            return;
          }
          case 'report': {
            const doc = await readMod<ReportAction>(node.id, type);
            if (doc && hasSubjectOrTarget(doc.payload)) docs.reports.push(doc);
            return;
          }
          default:
            return;
        }
      } catch {
        /* skip unreadable doc */
      }
    })
  );

  return docs;
};
