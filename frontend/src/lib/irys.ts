/**
 * Irys client: upload signed documents, query them by tag via GraphQL and
 * fetch their bytes from the gateway.
 *
 * The public GraphQL indexer is shared and only fast when queries are cheap:
 * narrow timestamp windows answer in milliseconds, wide ones time out after
 * ~9 s and bursts get throttled. Every query therefore funnels through the
 * scheduler below:
 *   - queries start at most one every `MIN_GAP_MS`;
 *   - at most `BUDGET_MAX` queries per `BUDGET_WINDOW_MS`, then it waits;
 *   - identical in-flight queries share one request and successful results
 *     are cached for `CACHE_TTL_MS` (callers bucket their windows so repeated
 *     checks produce identical queries);
 *   - timeouts, network errors and 5xx/429 retry with backoff.
 * Callers keep windows narrow (see `names.ts` for the chunked backfill walk).
 *
 * The Irys browser SDK expects an EIP-1193-style provider. Our brain wallets
 * hold raw private keys, so we hand it a shim whose `getSigner()` returns an
 * ethers v5 wallet — the Irys EIP-712 domain ("Bundlr" v1) carries no chain
 * id, so no RPC endpoint is involved.
 */
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type { EnvelopeTag } from './protocol';
import { MAX_DOC_BYTES } from './protocol';

const GRAPHQL_ENDPOINT = 'https://uploader.irys.xyz/graphql';
const GATEWAY_ENDPOINT = 'https://gateway.irys.xyz';

/* ------------------------------ rate limiting ---------------------------- */

/** Minimum spacing between two query starts. */
const MIN_GAP_MS = 350;
/** Sliding-window budget: at most this many queries per `BUDGET_WINDOW_MS`. */
const BUDGET_MAX = 20;
const BUDGET_WINDOW_MS = 60_000;
/** Identical successful queries are reused for this long. */
const CACHE_TTL_MS = 30_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [900, 2400];
/** Parallel gateway document fetches. */
const MAX_FETCHES = 4;

export type TagFilter = { name: string; values: string[] };

type IrysQueryResult = {
  errors?: { message?: string }[];
  data?: {
    transactions?: {
      edges?: {
        cursor: string;
        node: { id: string; timestamp: number; tags: { name: string; value: string }[] };
      }[];
    };
  };
};

export type ChainNode = {
  id: string;
  timestamp: number;
  tags: Record<string, string>;
};

/** Truncates a timestamp to the hour — gives repeated window queries one
 * cacheable shape instead of a new one every millisecond. */
export const floorToHour = (ms: number) => Math.floor(ms / 3_600_000) * 3_600_000;

/** Rounds a timestamp up to the hour; used for window upper bounds so the
 * bound never cuts off fresh documents. */
export const ceilToHour = (ms: number) => Math.ceil(ms / 3_600_000) * 3_600_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let lastStartAt = 0;
const starts: number[] = [];
let scheduler: Promise<void> = Promise.resolve();

/** Serialised gate: resolves when this query is allowed to start. */
const schedule = (): Promise<void> => {
  const run = scheduler.then(async () => {
    for (;;) {
      const now = Date.now();
      while (starts.length > 0 && now - starts[0] > BUDGET_WINDOW_MS) starts.shift();

      const gapWait = lastStartAt + MIN_GAP_MS - now;
      const budgetWait =
        starts.length >= BUDGET_MAX ? starts[0] + BUDGET_WINDOW_MS - now : 0;
      const waitMs = Math.max(gapWait, budgetWait);
      if (waitMs <= 0) break;
      await sleep(waitMs + Math.random() * 150);
    }
    lastStartAt = Date.now();
    starts.push(lastStartAt);
  });
  scheduler = run.catch(() => undefined);
  return run;
};

/* ------------------------------- graphql --------------------------------- */

type QueryOutcome = { json: IrysQueryResult } | { error: string; retryable: boolean };

const request = async (query: string): Promise<QueryOutcome> => {
  try {
    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!response.ok) {
      return {
        error: `Query failed (${response.status})`,
        retryable: response.status === 429 || response.status >= 500,
      };
    }
    const json = (await response.json()) as IrysQueryResult;
    if (json.errors?.length) {
      const message = json.errors[0]?.message ?? 'Query failed';
      return { error: message, retryable: /timed?\s*out|timeout/i.test(message) };
    }
    return { json };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'network error',
      retryable: true,
    };
  }
};

const inflight = new Map<string, Promise<IrysQueryResult>>();
const cache = new Map<string, { at: number; json: IrysQueryResult }>();

/** One GraphQL call, deduplicated, cached and retried with backoff. */
const graphql = async (query: string): Promise<IrysQueryResult> => {
  const cached = cache.get(query);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.json;

  const running = inflight.get(query);
  if (running) return running;

  const task = (async () => {
    let lastError = 'Query failed';

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1] + Math.random() * 400);
      await schedule();

      const outcome = await request(query);
      if ('json' in outcome) {
        cache.set(query, { at: Date.now(), json: outcome.json });
        return outcome.json;
      }

      lastError = outcome.error;
      if (!outcome.retryable) break;
    }

    throw new Error(lastError);
  })();

  inflight.set(query, task);
  try {
    return await task;
  } finally {
    inflight.delete(query);
  }
};

/* -------------------------------- queries -------------------------------- */

/** Tag query against the Irys GraphQL indexer. A timestamp window is
 * REQUIRED — unbounded tag scans time out on the indexer. */
export const queryNodes = async (
  filters: TagFilter[],
  opts: {
    from: number;
    owners?: string[];
    limit?: number;
    after?: string;
    order?: 'ASC' | 'DESC';
  }
): Promise<{ nodes: ChainNode[]; cursor?: string }> => {
  const tagQuery = filters
    .map(
      (filter) =>
        `{ name: ${JSON.stringify(filter.name)}, values: ${JSON.stringify(filter.values)} }`
    )
    .join(', ');
  const limit = opts.limit ?? 40;
  const order = opts.order ?? 'DESC';
  const from = Math.max(0, Math.floor(opts.from));
  // Bucketed so identical logical queries stay deduplicable and cacheable.
  const to = ceilToHour(Date.now() + 10 * 60 * 1000);
  const after = opts.after ? `, after: ${JSON.stringify(opts.after)}` : '';
  const owners =
    opts.owners && opts.owners.length > 0
      ? `, owners: ${JSON.stringify(opts.owners)}`
      : '';

  const query = `query { transactions(tags: [${tagQuery}]${owners}, limit: ${limit}, order: ${order}, timestamp: { from: ${from}, to: ${to} }${after}) { edges { cursor node { id timestamp tags { name value } } } } }`;

  const json = await graphql(query);
  const edges = json.data?.transactions?.edges ?? [];
  return {
    nodes: edges.map((edge) => ({
      id: edge.node.id,
      timestamp: edge.node.timestamp,
      tags: Object.fromEntries((edge.node.tags ?? []).map((tag) => [tag.name, tag.value])),
    })),
    cursor: edges.at(-1)?.cursor,
  };
};

/* -------------------------------- uploads -------------------------------- */

type Uploader = { upload: (data: string, opts: { tags: EnvelopeTag[] }) => Promise<{ id: string }> };

let uploaderPromise: Promise<Uploader> | null = null;
let uploaderKey = '';

const getUploader = (privateKey: Uint8Array) => {
  const key = bytesToHex(privateKey);
  if (!uploaderPromise || uploaderKey !== key) {
    uploaderKey = key;
    uploaderPromise = (async () => {
      const [{ WebUploader }, { default: WebEthereum }, { Wallet }] = await Promise.all([
        import('@irys/web-upload'),
        import('@irys/web-upload-ethereum'),
        import('@ethersproject/wallet'),
      ]);

      const signer = new Wallet(`0x${key}`);
      const provider = { getSigner: () => signer };

      // The builder is thenable and resolves to the Irys instance.
      const instance = await WebUploader(WebEthereum).withProvider(provider).mainnet();
      return instance as unknown as Uploader;
    })();
  }
  return uploaderPromise;
};

/** Uploads a document body; returns the Irys transaction id. */
export const uploadDoc = async (
  privateKey: Uint8Array,
  body: string,
  tags: EnvelopeTag[]
): Promise<string> => {
  if (utf8ToBytes(body).length > MAX_DOC_BYTES) {
    throw new Error('Document exceeds the 96 KiB upload limit.');
  }

  const uploader = await getUploader(privateKey);
  const receipt = await uploader.upload(body, { tags });
  return receipt.id;
};

/* -------------------------------- gateway -------------------------------- */

let fetchSlots = MAX_FETCHES;
/** Waiter queues: interactive reads (chat/comments) jump ahead of bulk reads. */
const priorityWaiters: (() => void)[] = [];
const fetchWaiters: (() => void)[] = [];

const acquireFetchSlot = async (priority = false) => {
  if (fetchSlots > 0) {
    fetchSlots -= 1;
    return;
  }
  await new Promise<void>((resolve) => (priority ? priorityWaiters : fetchWaiters).push(resolve));
};

const releaseFetchSlot = () => {
  // Interactive waiters are served first, so a background profile/name scan
  // (up to a hundred docs) can never starve the chat behind it.
  const next = priorityWaiters.shift() ?? fetchWaiters.shift();
  if (next) next();
  else fetchSlots += 1;
};

/** Fetches a document's raw bytes from the gateway (never trusted blindly).
 * Pass `priority` for reads a human is waiting on (chat, comments, moderation). */
export const fetchDoc = async (id: string, priority = false): Promise<string> => {
  await acquireFetchSlot(priority);
  try {
    const response = await fetch(`${GATEWAY_ENDPOINT}/${id}`);
    if (!response.ok) throw new Error(`Gateway fetch failed (${response.status})`);
    return await response.text();
  } finally {
    releaseFetchSlot();
  }
};
