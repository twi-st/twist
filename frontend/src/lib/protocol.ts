/**
 * Twist document protocol: one signed envelope for everything stored on Irys.
 *
 * Envelope bytes are canonical (sorted keys, no whitespace) so the signature
 * covers the exact serialization; the document id is the sha256 of the
 * envelope without its signature. Every receiving client validates before
 * rendering (see `validateEnvelope`).
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { addressFromPublicKey, publicKeyOf, signBytes, verifyBytes } from './wallet';

export const APP = 'twist';
export const PROTOCOL_VERSION = 1;

/**
 * Stable site identifier (a fixed hash), written as a `Site` tag on every
 * document and used as the primary query filter so an app only ever sees its
 * own feed. Change it to reset the feed.
 */
export const SITE_ID = '9c1f7a3e5b2d6408';

/** Reject anything larger than this before upload (Irys free-tier size). */
export const MAX_DOC_BYTES = 96 * 1024;
/** Documents are signed and content-addressed; history stays valid, so the
 * past window only needs to cover the chain's lifetime. The future window
 * absorbs clock skew (and nothing else — a future timestamp buys nothing). */
const TS_PAST_MS = 400 * 24 * 60 * 60 * 1000;
const TS_FUTURE_MS = 10 * 60 * 1000;

export type EnvelopeTag = { name: string; value: string };

export type Envelope<T = unknown> = {
  v: number;
  app: string;
  type: string;
  author: string;
  pub: string;
  ts: number;
  nonce: string;
  payload: T;
  sig?: string;
};

/** Deterministic JSON: sorted keys, no extra whitespace (JCS-style). */
export const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(',')}}`;
};

const randomNonce = () => bytesToHex(crypto.getRandomValues(new Uint8Array(8)));

const signedBytes = (envelope: Envelope) =>
  utf8ToBytes(canonicalize({ ...envelope, sig: undefined }));

export const docIdOf = (envelope: Envelope) =>
  bytesToHex(sha256(signedBytes(envelope)));

/** Creates and signs an envelope ready for upload. */
export const buildEnvelope = <T>(
  privateKey: Uint8Array,
  type: string,
  payload: T
): { envelope: Envelope<T>; docId: string } => {
  const pub = publicKeyOf(privateKey);
  const unsigned: Envelope<T> = {
    v: PROTOCOL_VERSION,
    app: APP,
    type,
    author: addressFromPublicKey(pub),
    pub,
    ts: Date.now(),
    nonce: randomNonce(),
    payload,
  };

  const envelope: Envelope<T> = {
    ...unsigned,
    sig: signBytes(privateKey, signedBytes(unsigned)),
  };

  return { envelope, docId: docIdOf(envelope) };
};

/** Full validation: shape, window, author/pubkey match, signature. */
export const validateEnvelope = <T>(
  raw: unknown,
  expectedType?: string
): Envelope<T> | null => {
  if (!raw || typeof raw !== 'object') return null;
  const envelope = raw as Envelope<T>;

  if (envelope.v !== PROTOCOL_VERSION || envelope.app !== APP) return null;
  if (typeof envelope.type !== 'string') return null;
  if (expectedType && envelope.type !== expectedType) return null;
  if (typeof envelope.author !== 'string' || typeof envelope.pub !== 'string') return null;
  if (typeof envelope.ts !== 'number' || !Number.isFinite(envelope.ts)) return null;
  if (typeof envelope.nonce !== 'string' || typeof envelope.sig !== 'string') return null;

  const now = Date.now();
  if (envelope.ts > now + TS_FUTURE_MS || envelope.ts < now - TS_PAST_MS) return null;

  try {
    if (
      addressFromPublicKey(envelope.pub).toLowerCase() !== envelope.author.toLowerCase()
    ) {
      return null;
    }
  } catch {
    return null;
  }

  if (!verifyBytes(envelope.pub, envelope.sig, signedBytes(envelope))) return null;

  return envelope;
};
