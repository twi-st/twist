/**
 * Moderation fold logic (pure — no network).
 *
 * - Admins are reconstructed by replaying signed `admin.registry` documents
 *   as a chain of trust. The root admin is the pinned `GENESIS_ADMIN` address
 *   (provisioned out-of-band); there is no in-app way to claim it, and it is
 *   exempt from bans.
 * - Each admin keeps their own ban list (`mod.ban` / `mod.unban`); clients
 *   apply the UNION of all lists.
 * - Deletions are tombstones (`mod.delete`) hiding a document id; Irys is
 *   append-only, so nothing is ever removed from storage.
 * - Rate limits are validated by every client, not by a gatekeeper.
 */
export type ModDoc<T> = { id: string; author: string; ts: number; payload: T };

export type AdminAction = { action: 'add' | 'remove'; subject: string; genesis?: boolean };
export type BanAction = { subject: string; reason?: string };
export type UnbanAction = { subject: string };
export type DeleteAction = { target: string; reason?: string };
export type ReportAction = {
  target: string;
  targetType: 'message' | 'comment' | 'address';
  reason?: string;
};

export type ModerationDocs = {
  registry: ModDoc<AdminAction>[];
  bans: ModDoc<BanAction>[];
  unbans: ModDoc<UnbanAction>[];
  deletes: ModDoc<DeleteAction>[];
  reports: ModDoc<ReportAction>[];
};

export type ModerationState = {
  admins: string[];
  genesis?: { address: string; docId: string };
  banned: string[];
  bannedBy: Record<string, string[]>;
  bannedReason: Record<string, string>;
  tombstones: string[];
  reports: ModDoc<ReportAction>[];
};

/**
 * Root admin address. Pinned here on purpose: only this address can register
 * the genesis admin document, and it can never be banned or claimed from the
 * app UI.
 */
export const GENESIS_ADMIN = '0x255373d051d40a4053f36afda61834d4b4aa7b21';

/** The pinned root address (lowercase). The root can never be banned. */
export const ROOT_ADDRESS = (GENESIS_ADMIN || '').toLowerCase();

/** True when `address` is the moderation root. */
export const isRootAddress = (address?: string | null) =>
  Boolean(address && ROOT_ADDRESS && address.toLowerCase() === ROOT_ADDRESS);

const lower = (value: string) => value.toLowerCase();

export const foldModeration = (docs: ModerationDocs): ModerationState => {
  /* ------------------------------- registry ------------------------------ */
  const registry = [...docs.registry].sort(
    (a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1)
  );

  const admins = new Set<string>();
  let genesis: ModerationState['genesis'];

  for (const doc of registry) {
    const author = lower(doc.author);
    const subject = lower(doc.payload.subject);

    if (doc.payload.genesis) {
      if (genesis) continue;
      if (author !== subject) continue;
      if (GENESIS_ADMIN && lower(GENESIS_ADMIN) !== author) continue;
      genesis = { address: author, docId: doc.id };
      admins.add(author);
      continue;
    }

    if (!admins.has(author)) continue;
    if (doc.payload.action === 'add') {
      admins.add(subject);
    } else if (doc.payload.action === 'remove' && admins.size > 1) {
      admins.delete(subject);
    }
  }

  /* -------------------------------- bans --------------------------------- */
  // The root admin is unbannable: a ban targeting it is ignored by every client.
  const root = (genesis?.address ?? ROOT_ADDRESS).toLowerCase();
  const bansBy = new Map<string, Map<string, string>>();
  for (const doc of docs.bans) {
    const admin = lower(doc.author);
    if (!admins.has(admin)) continue;
    const subject = lower(doc.payload.subject);
    if (root && subject === root) continue;
    if (!bansBy.has(admin)) bansBy.set(admin, new Map());
    bansBy.get(admin)!.set(subject, doc.payload.reason ?? '');
  }
  for (const doc of docs.unbans) {
    const admin = lower(doc.author);
    if (!admins.has(admin)) continue;
    bansBy.get(admin)?.delete(lower(doc.payload.subject));
  }

  const bannedBy: Record<string, string[]> = {};
  const bannedReason: Record<string, string> = {};
  for (const [admin, subjects] of bansBy) {
    for (const [subject, reason] of subjects) {
      (bannedBy[subject] ??= []).push(admin);
      if (reason && !bannedReason[subject]) bannedReason[subject] = reason;
    }
  }

  /* ------------------------------ tombstones ----------------------------- */
  const tombstones = [...new Set(docs.deletes.map((doc) => doc.payload.target))];

  /* -------------------------------- reports ------------------------------ */
  const reports = [...docs.reports].sort((a, b) => b.ts - a.ts).slice(0, 100);

  return {
    admins: [...admins],
    genesis,
    banned: Object.keys(bannedBy),
    bannedBy,
    bannedReason,
    tombstones,
    reports,
  };
};

/* ------------------------------ rate limits (client-enforced) ------------- */

const RATE = { gapMs: 5_000, burstWindowMs: 30_000, burstMax: 5, hourWindowMs: 3_600_000, hourMax: 60 };

/**
 * Applies the per-author rate limits used by every client: at most one
 * message per 5 s, 5 per 30 s and 60 per hour. Messages without an author
 * address (local seeds) are exempt.
 */
export const applyRateLimits = <T extends { id: string; at: number; address?: string }>(
  messages: T[]
): T[] => {
  const sorted = [...messages].sort(
    (a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)
  );
  const history = new Map<string, number[]>();
  const kept: T[] = [];

  for (const message of sorted) {
    if (!message.address) {
      kept.push(message);
      continue;
    }

    const author = message.address.toLowerCase();
    const times = history.get(author) ?? [];
    const last = times.at(-1) ?? -Infinity;
    const inBurst = times.filter((t) => message.at - t < RATE.burstWindowMs).length;
    const inHour = times.filter((t) => message.at - t < RATE.hourWindowMs).length;

    if (
      message.at - last < RATE.gapMs ||
      inBurst >= RATE.burstMax ||
      inHour >= RATE.hourMax
    ) {
      continue;
    }

    times.push(message.at);
    history.set(author, times);
    kept.push(message);
  }

  return kept;
};
