/**
 * Session management.
 *
 * Anti-hijack design:
 *  - The password and the private keys are NEVER stored (no localStorage,
 *    no sessionStorage, no cookies).
 *  - The derived seed is encrypted with a NON-EXTRACTABLE AES-GCM key which
 *    lives in IndexedDB. Scripts cannot read that key's raw bytes back out;
 *    they could only abuse it in-page, and clearing "sign out" wipes it.
 *  - The unwrapped keys live in a module-level variable (memory) only.
 *
 * This is what keeps users signed in across episodes, comments and reloads
 * without ever asking for the password again — while a copy of the profile
 * directory still can't leak something reusable from disk.
 */
import { walletFromSeed, type Wallet } from './wallet';
import { queryNodes } from './irys';
import { SITE_ID } from './protocol';

const DB_NAME = 'twist-identity';
const STORE_NAME = 'session';
const WRAP_KEY = 'wrapKey';
const WRAPPED_SEED = 'wrappedSeed';
const META = 'meta';

type SessionMeta = { username: string; address: string; ownerTag: string };

let session: Wallet | null = null;

export const beginSession = (wallet: Wallet) => {
  session = wallet;
};

export const getSession = () => session;

export const hasSession = () => session !== null;

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const idbGet = async <T>(key: string): Promise<T | undefined> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
};

const idbSet = async (key: string, value: unknown): Promise<void> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

const idbDelete = async (key: string): Promise<void> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

/** Wraps the seed under a fresh non-extractable key and stores the session. */
export const persistSession = async (wallet: Wallet): Promise<void> => {
  const wrapKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrapKey,
    new Uint8Array(wallet.seed)
  );

  const meta: SessionMeta = {
    username: wallet.username,
    address: wallet.address,
    ownerTag: wallet.ownerTag,
  };

  await idbSet(WRAP_KEY, wrapKey);
  await idbSet(WRAPPED_SEED, { iv, ct: ciphertext });
  await idbSet(META, meta);
};

/** Restores a persisted session without touching the network. */
export const restoreSession = async (): Promise<Wallet | null> => {
  try {
    const wrapKey = await idbGet<CryptoKey>(WRAP_KEY);
    const wrapped = await idbGet<{ iv: Uint8Array; ct: ArrayBuffer }>(WRAPPED_SEED);
    const meta = await idbGet<SessionMeta>(META);
    if (!wrapKey || !wrapped || !meta) return null;

    const seed = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(wrapped.iv) },
        wrapKey,
        wrapped.ct
      )
    );

    const wallet = walletFromSeed(seed, meta.username);
    if (wallet.address.toLowerCase() !== meta.address.toLowerCase()) return null;

    session = wallet;
    return wallet;
  } catch {
    return null;
  }
};

/** Wipes everything persisted for the session (used on sign-out). */
export const clearSession = async (): Promise<void> => {
  session = null;
  try {
    await Promise.all([idbDelete(WRAP_KEY), idbDelete(WRAPPED_SEED), idbDelete(META)]);
  } catch {
    /* storage unavailable */
  }
};

/**
 * Chain-side credential proof used on a fresh device. Brain wallets ARE
 * credential hashes: any signed document authored by the derived address
 * proves the credentials (a wrong password derives a different address), so
 * accounts work even if their genesis document is missing.
 * Throws on network failure so callers can tell "wrong" from "offline".
 */
export const accountExistsOnChain = async (wallet: Wallet): Promise<boolean> => {
  const { nodes } = await queryNodes(
    [
      { name: 'Site', values: [SITE_ID] },
      { name: 'Type', values: ['profile', 'stats', 'chat.message'] },
    ],
    {
      from: Date.now() - 365 * 24 * 60 * 60 * 1000,
      owners: [wallet.address],
      limit: 1,
      order: 'DESC',
    }
  );
  return nodes.length > 0;
};
