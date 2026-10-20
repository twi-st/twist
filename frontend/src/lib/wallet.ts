/**
 * Brain-wallet identity.
 *
 * username + password → Argon2id seed → HKDF subkeys:
 *   identity  secp256k1 key, ETH-style address  — signs every document
 *   upload    secp256k1 key                     — signs private uploads (unlinkable)
 *   enc       AES-256-GCM key                   — encrypts vault payloads
 *   tag       HMAC key                          — capability tag for private docs
 *
 * Keys are held in memory only. `identity.ts` wraps the seed with a
 * non-extractable WebCrypto key so sessions survive reloads without ever
 * storing the password or the private keys.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

export type Wallet = {
  username: string;
  address: string;
  /** Address of the upload key — owns private (vault) uploads; unlinkable
   * from the identity address but derivable only from the seed. */
  uploadAddress: string;
  ownerTag: string;
  seed: Uint8Array;
  identityPrivateKey: Uint8Array;
  uploadPrivateKey: Uint8Array;
  encryptionKey: Uint8Array;
};

const ARGON2 = {
  parallelism: 1,
  iterations: 3,
  memorySize: 65536, // 64 MiB
  hashLength: 32,
} as const;

const HKDF_SALT = utf8ToBytes('twist:v1');

export const normalizeUsername = (username: string) => username.trim().toLowerCase();

export const usernameProblem = (username: string): string | null => {
  if (!/^[a-z0-9_]{2,24}$/.test(normalizeUsername(username))) {
    return 'Usernames are 2–24 characters: letters, numbers and underscores.';
  }
  return null;
};

/** Password policy: 8+ chars, upper + lower, number, special character. */
export const passwordProblem = (password: string): string | null => {
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(password)) return 'Password needs at least one uppercase letter.';
  if (!/[a-z]/.test(password)) return 'Password needs at least one lowercase letter.';
  if (!/\d/.test(password)) return 'Password needs at least one number.';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Password needs at least one special character.';
  return null;
};

/** Full derivation (slow — Argon2id). Used on sign-up and manual sign-in. */
export const deriveWallet = async (username: string, password: string): Promise<Wallet> => {
  const normalized = normalizeUsername(username);
  // hash-wasm is ~200 kB and only needed the moment credentials are derived.
  // Loading it on demand keeps it out of the startup bundle: the landing page
  // never touches it, and sign-in already waits on Argon2 itself.
  const { argon2id } = await import('hash-wasm');
  const seed = (await argon2id({
    password,
    salt: `twist:v1:${normalized}`,
    ...ARGON2,
    outputType: 'binary',
  })) as Uint8Array;

  return walletFromSeed(seed, normalized);
};

const addressOf = (privateKey: Uint8Array) =>
  `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(privateKey, false).slice(1)).slice(-20))}`;

/** Rebuilds the key set from the seed (fast — used when restoring a session). */
export const walletFromSeed = (seed: Uint8Array, username: string): Wallet => {
  const identityPrivateKey = hkdf(sha256, seed, HKDF_SALT, utf8ToBytes('identity'), 32);
  const uploadPrivateKey = hkdf(sha256, seed, HKDF_SALT, utf8ToBytes('upload'), 32);
  const encryptionKey = hkdf(sha256, seed, HKDF_SALT, utf8ToBytes('enc'), 32);
  const tagKey = hkdf(sha256, seed, HKDF_SALT, utf8ToBytes('tag'), 32);

  const address = addressOf(identityPrivateKey);
  const uploadAddress = addressOf(uploadPrivateKey);
  const ownerTag = bytesToHex(hmac(sha256, tagKey, utf8ToBytes('twist:v1:owner')));

  return {
    username,
    address,
    uploadAddress,
    ownerTag,
    seed,
    identityPrivateKey,
    uploadPrivateKey,
    encryptionKey,
  };
};

export const publicKeyOf = (privateKey: Uint8Array) =>
  bytesToHex(secp256k1.getPublicKey(privateKey, false));

export const addressFromPublicKey = (publicKeyHex: string) =>
  `0x${bytesToHex(keccak_256(hexToBytes(publicKeyHex).slice(1)).slice(-20))}`;

export const shortAddress = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;

/** Fresh ArrayBuffer-backed copy — WebCrypto's types reject ArrayBufferLike views. */
const toBytes = (value: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(value);

export const signBytes = (privateKey: Uint8Array, bytes: Uint8Array) => {
  const digest = sha256(bytes);
  return secp256k1.sign(digest, privateKey).toCompactHex();
};

export const verifyBytes = (
  publicKeyHex: string,
  signatureHex: string,
  bytes: Uint8Array
) => {
  try {
    const digest = sha256(bytes);
    return secp256k1.verify(hexToBytes(signatureHex), digest, hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
};

export type Encrypted = { iv: string; ct: string };

export const encryptJson = async (
  key: Uint8Array,
  aad: string,
  value: unknown
): Promise<Encrypted> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey('raw', toBytes(key), 'AES-GCM', false, [
    'encrypt',
  ]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: toBytes(utf8ToBytes(aad)) },
    cryptoKey,
    toBytes(utf8ToBytes(JSON.stringify(value)))
  );
  return { iv: bytesToHex(iv), ct: bytesToHex(new Uint8Array(ciphertext)) };
};

export const decryptJson = async <T>(
  key: Uint8Array,
  aad: string,
  payload: Encrypted
): Promise<T> => {
  const cryptoKey = await crypto.subtle.importKey('raw', toBytes(key), 'AES-GCM', false, [
    'decrypt',
  ]);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toBytes(hexToBytes(payload.iv)),
      additionalData: toBytes(utf8ToBytes(aad)),
    },
    cryptoKey,
    toBytes(hexToBytes(payload.ct))
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
};
