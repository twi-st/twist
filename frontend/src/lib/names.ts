/**
 * Username claims, answered locally first.
 *
 * The indexer cannot answer "is this username taken?" over the whole history
 * in one query — a year-wide window times out — so this module walks the
 * profile history in 14-day chunks (newest first) and records every claimed
 * name in a small localStorage ledger. Interactive checks then hit the
 * ledger and only touch the network for claims made since the last walk;
 * sign-up finishes the walk before minting so a name claimed in the past
 * cannot be taken twice.
 *
 * A claim keeps the earliest timestamp seen (first-come wins) and, once
 * known, the address that published it (used to open a profile from a name
 * without a name scan).
 */
import { floorToHour, queryNodes, fetchDoc } from './irys';
import { SITE_ID, validateEnvelope } from './protocol';

export type NameClaim = { ts: number; address?: string };

const LEDGER_KEY = 'twist:name-claims:v1';
/** Chunk size for the backfill walk — wide windows are what times the
 * indexer out, so pages stay small. */
const CHUNK_MS = 14 * 24 * 60 * 60 * 1000;
/** Nothing on Twist predates this; it bounds the walk. */
const FLOOR_MS = Date.UTC(2026, 8, 15);
const PAGE_LIMIT = 100;
/** How often a completed ledger re-checks the newest chunk. */
const REFRESH_MS = 10 * 60 * 1000;

type Ledger = {
  names: Record<string, NameClaim>;
  /** End of the chunk currently being walked (walk goes backwards in time). */
  to: number;
  /** Cursor for paging within the current chunk. */
  after?: string;
  complete: boolean;
  /** When the newest chunk was last checked. */
  at: number;
};

let ledger: Ledger | null = null;
let activeWalk: Promise<boolean> | null = null;

const fresh = (): Ledger => ({ names: {}, to: Date.now(), complete: false, at: 0 });

const load = (): Ledger => {
  if (ledger) return ledger;
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Ledger;
      if (parsed && typeof parsed === 'object' && parsed.names) {
        ledger = { ...fresh(), ...parsed };
        return ledger;
      }
    }
  } catch {
    /* storage unavailable — keep an in-memory ledger */
  }
  ledger = fresh();
  return ledger;
};

const save = () => {
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(load()));
  } catch {
    /* storage unavailable */
  }
};

const record = (name: string, ts: number, address?: string) => {
  const state = load();
  const existing = state.names[name];

  if (!existing) {
    state.names[name] = { ts, address };
    return true;
  }
  if (ts < existing.ts) {
    existing.ts = ts;
    if (address) existing.address = address;
    return true;
  }
  if (!existing.address && address) {
    existing.address = address;
    return true;
  }
  return false;
};

/** The known claim for a name, if any. */
export const claimOf = (name: string): NameClaim | undefined =>
  load().names[name.trim().toLowerCase()];

export const hasClaim = (name: string): boolean => Boolean(claimOf(name));

/** Records a claim (called with every profile document the app sees). */
export const noteClaim = (name: string, ts: number, address?: string) => {
  if (!name || !Number.isFinite(ts)) return;
  if (record(name.trim().toLowerCase(), ts, address?.toLowerCase())) save();
};

/** Author of a profile document — the walk only sees tags, so it needs one
 * gateway read to learn the address that published a name. */
const authorOf = async (id: string): Promise<string | undefined> => {
  try {
    const envelope = validateEnvelope<{ username?: string }>(
      JSON.parse(await fetchDoc(id)),
      'profile'
    );
    return envelope?.author.toLowerCase();
  } catch {
    return undefined;
  }
};

/** False while older profile history still needs to be walked. */
export const isLedgerComplete = (): boolean => load().complete;

/**
 * Walks one page of profile history (newest chunk first, then older ones)
 * and, once complete, refreshes the newest chunk every `REFRESH_MS` so
 * claims made since the last walk still land in the ledger. Returns true
 * when there may be more pages to walk.
 */
export const syncNameClaims = async (force = false): Promise<boolean> => {
  if (activeWalk) return activeWalk;

  activeWalk = (async () => {
    try {
      const state = load();
      const refreshing =
        state.complete && (force || Date.now() - state.at > REFRESH_MS);
      if (state.complete && !refreshing) return false;

      const from = refreshing
        ? Date.now() - CHUNK_MS
        : Math.max(FLOOR_MS, state.to - CHUNK_MS);

      const { nodes, cursor } = await queryNodes(
        [
          { name: 'Site', values: [SITE_ID] },
          { name: 'Type', values: ['profile'] },
        ],
        {
          from: floorToHour(from),
          limit: PAGE_LIMIT,
          order: 'DESC',
          after: refreshing ? undefined : state.after,
        }
      );

      // The walk sees documents, not authors: fetch the ones whose address is
      // still unknown so a name can be turned into a profile later.
      const claimed = nodes
        .map((node) => ({
          name: node.tags.Username?.trim().toLowerCase(),
          id: node.id,
          ts: node.timestamp,
        }))
        .filter((entry): entry is { name: string; id: string; ts: number } =>
          Boolean(entry.name)
        );

      const authors = await Promise.all(
        claimed.map(async (entry) => {
          if (state.names[entry.name]?.address) return undefined;
          return authorOf(entry.id);
        })
      );

      for (let i = 0; i < claimed.length; i += 1) {
        record(claimed[i].name, claimed[i].ts, authors[i]);
      }

      state.at = Date.now();

      if (refreshing) {
        // One page is enough to catch claims made since the last walk.
      } else if (nodes.length >= PAGE_LIMIT && cursor) {
        state.after = cursor; // more pages in this chunk
      } else if (from <= FLOOR_MS) {
        state.complete = true; // reached the beginning of time
      } else {
        state.to = from; // older chunk next
        state.after = undefined;
      }

      save();
      return !state.complete;
    } finally {
      activeWalk = null;
    }
  })();

  return activeWalk;
};

/**
 * Walks until the ledger covers the full history (bounded). Returns true
 * when the ledger is complete — a `false` means the indexer could not be
 * reached, so callers should treat availability as unverified. `force`
 * refreshes the newest chunk first (used before minting an account).
 */
export const ensureNameClaims = async (maxPages = 8, force = false): Promise<boolean> => {
  for (let page = 0; page < maxPages; page += 1) {
    try {
      if (!(await syncNameClaims(force))) return true;
    } catch {
      return isLedgerComplete();
    }
    force = false; // only the first pass is forced
  }
  return isLedgerComplete();
};
