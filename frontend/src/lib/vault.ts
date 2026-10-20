/**
 * Vaults: private per-user data on Irys (watch progress + settings).
 *
 * Payloads are AES-GCM encrypted with the seed-derived key and located via
 * the capability tag, uploaded with the unlinkable upload key. Uploads that
 * fail (offline) are queued in localStorage and flushed on the next
 * successful sync — writes are tiny append-only deltas, folded last-wins.
 */
import { encryptJson, decryptJson, type Encrypted, type Wallet } from './wallet';
import { buildEnvelope, validateEnvelope, APP, PROTOCOL_VERSION, SITE_ID } from './protocol';
import { fetchDoc, floorToHour, queryNodes, uploadDoc } from './irys';
import type { Progress, Settings } from './store';

const QUEUE_KEY = 'twist:vault-queue';
const QUEUE_MAX = 50;

type QueuedUpload = { kind: 'settings' | 'progress'; payload: string; at: number };

const readQueue = (): QueuedUpload[] => {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedUpload[]) : [];
  } catch {
    return [];
  }
};

const writeQueue = (queue: QueuedUpload[]) => {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-QUEUE_MAX)));
  } catch {
    /* storage unavailable */
  }
};

const vaultTags = (type: string, ts: number, wallet: Wallet) => [
  { name: 'App', value: APP },
  { name: 'Site', value: SITE_ID },
  { name: 'Type', value: type },
  { name: 'V', value: String(PROTOCOL_VERSION) },
  { name: 'TS', value: String(ts) },
  { name: 'Owner', value: wallet.ownerTag },
];

/** Queues a vault upload for later (used when Irys is unreachable). */
export const queueVaultUpload = (kind: 'settings' | 'progress', payload: unknown) => {
  const queue = readQueue();
  queue.push({ kind, payload: JSON.stringify(payload), at: Date.now() });
  writeQueue(queue);
};

export const publishVaultSettings = async (wallet: Wallet, settings: Settings) => {
  const enc = await encryptJson(wallet.encryptionKey, 'twist:v1:vault.settings', settings);
  const { envelope } = buildEnvelope(wallet.identityPrivateKey, 'vault.settings', { enc });
  await uploadDoc(wallet.uploadPrivateKey, JSON.stringify(envelope), vaultTags('vault.settings', envelope.ts, wallet));
};

export const publishVaultProgress = async (wallet: Wallet, entries: Progress[]) => {
  const enc = await encryptJson(wallet.encryptionKey, 'twist:v1:vault.progress', entries);
  const { envelope } = buildEnvelope(wallet.identityPrivateKey, 'vault.progress', { enc });
  await uploadDoc(wallet.uploadPrivateKey, JSON.stringify(envelope), vaultTags('vault.progress', envelope.ts, wallet));
};

/** Retries queued vault uploads; keeps the ones that still fail. */
export const flushVaultQueue = async (wallet: Wallet) => {
  const queue = readQueue();
  if (queue.length === 0) return;

  const remaining: QueuedUpload[] = [];
  for (const item of queue) {
    try {
      const value = JSON.parse(item.payload);
      await (item.kind === 'settings'
        ? publishVaultSettings(wallet, value)
        : publishVaultProgress(wallet, value));
    } catch {
      remaining.push(item);
    }
  }

  writeQueue(remaining);
};

const fetchVaultEnc = async (wallet: Wallet, type: string, limit: number) => {
  // Owner-scoped queries stay cheap over a wide window; the upload address
  // is derived from the seed, so only this user can locate their vault.
  const { nodes } = await queryNodes(
    [
      { name: 'Site', values: [SITE_ID] },
      { name: 'Type', values: [type] },
    ],
    {
      from: floorToHour(Date.now() - 365 * 24 * 60 * 60 * 1000),
      owners: [wallet.uploadAddress],
      limit,
      order: 'DESC',
    }
  );

  const envelopes: { enc: Encrypted; ts: number }[] = [];
  await Promise.all(
    nodes.map(async (node) => {
      try {
        const envelope = validateEnvelope<{ enc: Encrypted }>(
          JSON.parse(await fetchDoc(node.id)),
          type
        );
        if (envelope?.payload?.enc) envelopes.push({ enc: envelope.payload.enc, ts: envelope.ts });
      } catch {
        /* skip unreadable doc */
      }
    })
  );

  return envelopes.sort((a, b) => b.ts - a.ts);
};

export const fetchVaultSettings = async (wallet: Wallet): Promise<Settings | null> => {
  const docs = await fetchVaultEnc(wallet, 'vault.settings', 5);
  for (const doc of docs) {
    try {
      return await decryptJson<Settings>(
        wallet.encryptionKey,
        'twist:v1:vault.settings',
        doc.enc
      );
    } catch {
      /* wrong key / corrupt — try the next newest */
    }
  }
  return null;
};

export const fetchVaultProgress = async (wallet: Wallet): Promise<Progress[]> => {
  const docs = await fetchVaultEnc(wallet, 'vault.progress', 100);
  const folded = new Map<string, Progress>();

  for (const doc of docs) {
    try {
      const entries = await decryptJson<Progress[]>(
        wallet.encryptionKey,
        'twist:v1:vault.progress',
        doc.enc
      );
      for (const entry of entries) {
        const key = `${entry.slug}:${entry.episode}`;
        const existing = folded.get(key);
        if (!existing || entry.updatedAt > existing.updatedAt) folded.set(key, entry);
      }
    } catch {
      /* skip */
    }
  }

  return [...folded.values()];
};
