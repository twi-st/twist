/**
 * Donation totals, checked in the visitor's browser.
 *
 * Both wallets are queried directly — Solana JSON-RPC (native + the USDC/USDT
 * token accounts, derived locally) and TronGrid (TRX + TRC20 USDT) — and the
 * balances are turned into dollars with CoinGecko prices. One snapshot is
 * cached in localStorage for 24 hours, so the providers see at most one check
 * per visitor per day; a stale snapshot is reused when the network is down.
 */
import { useEffect, useState } from 'react';
import { sha256 } from '@noble/hashes/sha256';
import { ed25519 } from '@noble/curves/ed25519';
import { utf8ToBytes } from '@noble/hashes/utils';

export const DONATION_GOAL_USD = 500;

export type WalletKind = 'solana' | 'tron';

export type DonationWallet = {
  kind: WalletKind;
  network: string;
  address: string;
  accepts: string;
};

export const DONATION_WALLETS: DonationWallet[] = [
  {
    kind: 'solana',
    network: 'Solana',
    address: '657NmXwjozSAK11HeAT7xicTAP1VDEtt3cu3rVNXBqr6',
    accepts: 'SOL · USDC · USDT',
  },
  {
    kind: 'tron',
    network: 'TRON',
    address: 'TYgdov3URSbzcQDHusjbX6F9HmX964xjPX',
    accepts: 'TRX · USDT',
  },
];

export type AssetBalance = { symbol: string; amount: number; usd: number };

export type WalletSnapshot = {
  kind: WalletKind;
  address: string;
  usd: number;
  assets: AssetBalance[];
  /** Present when this wallet could not be read this time. */
  error?: string;
};

export type DonationSnapshot = {
  raisedUsd: number;
  wallets: WalletSnapshot[];
  checkedAt: number;
  /** Last known coin prices, reused when a later price fetch fails. */
  prices: { sol: number; trx: number };
  /** True when an older snapshot is shown because a refresh failed. */
  stale: boolean;
};

const CACHE_KEY = 'twist:donation:v1';
const CACHE_MS = 24 * 60 * 60 * 1000;

const SOLANA_RPC = ['https://solana-rpc.publicnode.com', 'https://rpc.solanatracker.io/public'];
const TRONGRID = 'https://api.trongrid.io';
const PRICES =
  'https://api.coingecko.com/api/v3/simple/price?ids=solana,tron&vs_currencies=usd';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const PDA_MARKER = utf8ToBytes('ProgramDerivedAddress');
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const LAMPORTS = 1_000_000_000;
const STABLE_DECIMALS = 1_000_000;
const SUN = 1_000_000;

/* --------------------------- base58 + PDA (ATA) --------------------------- */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ZERO = BigInt(0);
const BASE58 = BigInt(58);
const BYTE = BigInt(256);

const base58Decode = (value: string): Uint8Array => {
  let num = ZERO;
  for (const char of value) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid base58');
    num = num * BASE58 + BigInt(index);
  }
  const bytes: number[] = [];
  while (num > ZERO) {
    bytes.unshift(Number(num % BYTE));
    num /= BYTE;
  }
  for (let i = 0; i < value.length && value[i] === '1'; i += 1) bytes.unshift(0);
  return new Uint8Array(bytes);
};

const base58Encode = (bytes: Uint8Array): string => {
  let num = ZERO;
  for (const byte of bytes) num = num * BYTE + BigInt(byte);
  let out = '';
  while (num > ZERO) {
    out = ALPHABET[Number(num % BASE58)] + out;
    num /= BASE58;
  }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i += 1) out = `1${out}`;
  return out;
};

const isOnCurve = (bytes: Uint8Array) => {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
};

const TOKEN_PROGRAM_BYTES = base58Decode(TOKEN_PROGRAM);
const ATA_PROGRAM_BYTES = base58Decode(ATA_PROGRAM);

/**
 * Associated token account for (owner, mint) — the same derivation the SPL
 * token program uses: highest bump whose `sha256(seeds ‖ bump ‖ program ‖
 * "ProgramDerivedAddress")` is not a valid curve point.
 */
const associatedTokenAddress = (owner: string, mint: string) => {
  const seeds = [base58Decode(owner), TOKEN_PROGRAM_BYTES, base58Decode(mint)];
  const seedBytes = seeds.reduce((sum, seed) => sum + seed.length, 0);

  for (let bump = 255; bump >= 0; bump -= 1) {
    const data = new Uint8Array(seedBytes + 1 + ATA_PROGRAM_BYTES.length + PDA_MARKER.length);
    let offset = 0;
    for (const seed of seeds) {
      data.set(seed, offset);
      offset += seed.length;
    }
    data[offset] = bump;
    data.set(ATA_PROGRAM_BYTES, offset + 1);
    data.set(PDA_MARKER, offset + 1 + ATA_PROGRAM_BYTES.length);

    const hash = sha256(data);
    if (!isOnCurve(hash)) return base58Encode(hash);
  }
  throw new Error('No valid bump');
};

/* ------------------------------- providers -------------------------------- */

const rpc = async (method: string, params: unknown[]) => {
  let lastError: Error | null = null;

  for (const endpoint of SOLANA_RPC) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const body = (await response.json()) as {
        result?: { value?: { data?: [string, string] } | number | null };
        error?: { message?: string };
      };
      if (body.error) throw new Error(body.error.message ?? 'RPC error');
      return body.result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('RPC failed');
    }
  }

  throw lastError ?? new Error('RPC failed');
};

const tokenAmount = (data?: [string, string]) => {
  if (!data?.[0]) return 0;
  const binary = atob(data[0]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

  const decimals = bytes[44];
  let raw = ZERO;
  for (let i = 7; i >= 0; i -= 1) raw = (raw << BigInt(8)) | BigInt(bytes[64 + i]);
  return Number(raw) / 10 ** decimals;
};

const solanaWallet = async (address: string): Promise<Omit<WalletSnapshot, 'kind' | 'address'>> => {
  try {
    const [balance, usdc, usdt] = await Promise.all([
      rpc('getBalance', [address]) as Promise<number>,
      rpc('getAccountInfo', [associatedTokenAddress(address, USDC_MINT), { encoding: 'base64' }]),
      rpc('getAccountInfo', [associatedTokenAddress(address, USDT_MINT), { encoding: 'base64' }]),
    ]);

    const sol = (typeof balance === 'number' ? balance : 0) / LAMPORTS;
    const usdcAmount = tokenAmount((usdc as { value?: [string, string] | null })?.value ?? undefined);
    const usdtAmount = tokenAmount((usdt as { value?: [string, string] | null })?.value ?? undefined);

    return {
      usd: 0, // filled in once prices are known
      assets: [
        { symbol: 'SOL', amount: sol, usd: 0 },
        { symbol: 'USDC', amount: usdcAmount, usd: usdcAmount },
        { symbol: 'USDT', amount: usdtAmount, usd: usdtAmount },
      ],
    };
  } catch (error) {
    return {
      usd: 0,
      assets: [],
      error: error instanceof Error ? error.message : 'Could not read the wallet',
    };
  }
};

const tronWallet = async (address: string): Promise<Omit<WalletSnapshot, 'kind' | 'address'>> => {
  try {
    const response = await fetch(`${TRONGRID}/v1/accounts/${address}`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`TronGrid ${response.status}`);

    const body = (await response.json()) as {
      data?: Array<{ balance?: number; trc20?: Array<Record<string, string>> }>;
    };
    // An account with no activity simply has no entry yet.
    const account = body.data?.[0];
    const trx = (account?.balance ?? 0) / SUN;
    const usdtEntry = (account?.trc20 ?? []).find((entry) => USDT_TRC20 in entry);
    const usdt = usdtEntry ? Number(usdtEntry[USDT_TRC20]) / STABLE_DECIMALS : 0;

    return {
      usd: 0,
      assets: [
        { symbol: 'TRX', amount: trx, usd: 0 },
        { symbol: 'USDT', amount: usdt, usd: usdt },
      ],
    };
  } catch (error) {
    return {
      usd: 0,
      assets: [],
      error: error instanceof Error ? error.message : 'Could not read the wallet',
    };
  }
};

const prices = async (fallback: { sol: number; trx: number }): Promise<{ sol: number; trx: number }> => {
  try {
    const response = await fetch(PRICES, { headers: { Accept: 'application/json' } });
    const body = (await response.json()) as { solana?: { usd?: number }; tron?: { usd?: number } };
    return {
      sol: body.solana?.usd || fallback.sol,
      trx: body.tron?.usd || fallback.trx,
    };
  } catch {
    // Keep the previous prices rather than silently under-counting.
    return fallback;
  }
};

/* -------------------------------- snapshot -------------------------------- */

const readCache = (): DonationSnapshot | null => {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DonationSnapshot;
    return parsed && typeof parsed.checkedAt === 'number' ? parsed : null;
  } catch {
    return null;
  }
};

const writeCache = (snapshot: DonationSnapshot) => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    /* storage unavailable */
  }
};

const round = (value: number) => Math.round(value * 100) / 100;

const buildSnapshot = async (fallbackPrices: { sol: number; trx: number }): Promise<DonationSnapshot> => {
  // Balances and prices are fetched together, then combined.
  const [price, results] = await Promise.all([
    prices(fallbackPrices),
    Promise.all(
      DONATION_WALLETS.map((wallet) =>
        wallet.kind === 'solana' ? solanaWallet(wallet.address) : tronWallet(wallet.address)
      )
    ),
  ]);

  const wallets: WalletSnapshot[] = results.map((result, index) => {
    const wallet = DONATION_WALLETS[index];
    const assets: AssetBalance[] = result.assets.map((asset) => ({
      ...asset,
      usd:
        asset.symbol === 'SOL'
          ? asset.amount * price.sol
          : asset.symbol === 'TRX'
            ? asset.amount * price.trx
            : asset.usd,
    }));

    return {
      kind: wallet.kind,
      address: wallet.address,
      usd: round(assets.reduce((sum, asset) => sum + asset.usd, 0)),
      assets,
      error: result.error,
    };
  });

  return {
    raisedUsd: round(wallets.reduce((sum, wallet) => sum + wallet.usd, 0)),
    wallets,
    checkedAt: Date.now(),
    prices: price,
    stale: false,
  };
};

let inflight: Promise<DonationSnapshot> | null = null;
let memory: DonationSnapshot | null = null;

/** Cached for 24 h; falls back to the last good snapshot when offline. */
export const loadDonation = async (options?: { force?: boolean }): Promise<DonationSnapshot> => {
  const cached = memory ?? readCache();
  if (cached) memory = cached;

  const fresh = cached && Date.now() - cached.checkedAt < CACHE_MS;
  if (fresh && !options?.force) return { ...cached, stale: false };

  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const snapshot = await buildSnapshot(cached?.prices ?? { sol: 0, trx: 0 });
      if (snapshot.wallets.every((wallet) => wallet.error)) throw new Error('All wallets failed');

      memory = snapshot;
      writeCache(snapshot);
      return snapshot;
    } catch {
      if (cached) return { ...cached, stale: true };
      throw new Error('Donation balances are unavailable right now');
    } finally {
      inflight = null;
    }
  })();

  return inflight;
};

/**
 * Shared snapshot for the banner and the modal: the first mount checks (or
 * reads the cache) and everyone else reuses the same promise.
 */
export const useDonation = () => {
  const [snapshot, setSnapshot] = useState<DonationSnapshot | null>(memory);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;

    loadDonation()
      .then((value) => {
        if (active) setSnapshot(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });

    return () => {
      active = false;
    };
  }, []);

  const refresh = async () => {
    try {
      const value = await loadDonation({ force: true });
      setSnapshot(value);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };

  return { snapshot, failed, refresh };
};
