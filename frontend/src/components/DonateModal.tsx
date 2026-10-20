import { useEffect, useState } from 'react';
import {
  DONATION_GOAL_USD,
  DONATION_WALLETS,
  useDonation,
  type WalletSnapshot,
} from '../lib/donate';

const EXPLORER: Record<string, (address: string) => string> = {
  solana: (address) => `https://solscan.io/account/${address}`,
  tron: (address) => `https://tronscan.org/#/address/${address}`,
};

const timeAgo = (at: number) => {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

const amountLabel = (value: number) => {
  if (value === 0) return '0';
  if (value < 0.0001) return '<0.0001';
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
};

const WalletRow = ({ wallet, checking }: { wallet: WalletSnapshot; checking?: boolean }) => {
  const meta = DONATION_WALLETS.find((entry) => entry.kind === wallet.kind);
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(wallet.address).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="rounded border border-twist-800 bg-twist-800/40 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-baseline gap-2">
          <span className="font-body text-sm font-bold text-gray-100">
            {meta?.network ?? wallet.kind}
          </span>
          <span className="font-body text-[10px] uppercase tracking-wide text-twist-lightgray">
            {meta?.accepts}
          </span>
        </span>
        <a
          href={EXPLORER[wallet.kind]?.(wallet.address)}
          target="_blank"
          rel="noreferrer noopener"
          className="shrink-0 font-body text-[11px] text-twist-lightgray transition duration-200 hover:text-gray-200"
        >
          Explorer ↗
        </a>
      </div>

      <button
        type="button"
        onClick={copy}
        title="Copy address"
        className="focus:outline-none mt-2 flex w-full items-center justify-between gap-2 rounded bg-twist-900 px-2 py-1.5 text-left transition duration-200 hover:bg-twist-800"
      >
        <span className="break-all font-mono text-[11px] leading-relaxed text-gray-300">
          {wallet.address}
        </span>
        <span
          className={`shrink-0 font-body text-[10px] font-bold uppercase ${
            copied ? 'text-emerald-400' : 'text-twist-lightgray'
          }`}
        >
          {copied ? 'Copied' : 'Copy'}
        </span>
      </button>

      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
        {checking ? (
          <span className="font-body text-[11px] text-twist-lightgray">Checking…</span>
        ) : wallet.error ? (
          <span className="font-body text-[11px] text-twist-redlight">
            Could not read this wallet ({wallet.error})
          </span>
        ) : (
          <span className="font-body text-[11px] text-twist-lightgray">
            {wallet.assets
              .filter((asset) => asset.amount > 0)
              .map((asset) => `${amountLabel(asset.amount)} ${asset.symbol}`)
              .join(' · ') || 'Empty'}
          </span>
        )}
        {!checking && !wallet.error && (
          <span className="font-body text-xs tabular-nums text-gray-300">
            ${wallet.usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        )}
      </div>
    </div>
  );
};

export const DonateModal = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const { snapshot, failed, refresh } = useDonation();
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const raised = snapshot?.raisedUsd ?? 0;
  const percent = Math.min(100, Math.round((raised / DONATION_GOAL_USD) * 1000) / 10);
  const reached = raised >= DONATION_GOAL_USD;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Support Twist"
      onClick={onClose}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="main-content max-h-full w-full max-w-md overflow-y-auto rounded-lg border border-twist-700 bg-twist-900 p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col">
            <span className="font-body text-lg text-gray-100">Support Twist</span>
            <span className="mt-1 font-body text-xs leading-relaxed text-twist-lightgray">
              Donations keep the site up, ad-free and subscription free. Send crypto
              straight to a wallet below.
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="focus:outline-none cursor-default flex h-8 w-8 shrink-0 items-center justify-center rounded bg-twist-800 border border-transparent transition duration-200 hover:border-twist-gray"
          >
            <span className="font-body text-gray-300">✕</span>
          </button>
        </div>

        <div className="mt-4">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-body text-sm text-gray-200">
              {snapshot
                ? `$${raised.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })} raised`
                : failed
                  ? 'Balances unavailable right now'
                  : 'Checking balances…'}
            </span>
            <span className="font-body text-xs tabular-nums text-twist-lightgray">
              of ${DONATION_GOAL_USD} · {Math.min(100, percent)}%
            </span>
          </div>

          <div
            className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-twist-gray/50"
            role="progressbar"
            aria-label="Donation progress"
            aria-valuemin={0}
            aria-valuemax={DONATION_GOAL_USD}
            aria-valuenow={raised}
          >
            <div
              className="h-full rounded-full bg-twist-red transition-all duration-500 ease-out"
              style={{ width: `${percent}%` }}
            />
          </div>

          {reached && (
            <p className="mt-2 font-body text-[11px] text-emerald-400">
              Goal reached — thank you! Anything extra covers next month&apos;s bill.
            </p>
          )}
        </div>

        <div className="mt-4 flex flex-col gap-2">
          {(
            snapshot?.wallets ??
            DONATION_WALLETS.map((wallet) => ({
              kind: wallet.kind,
              address: wallet.address,
              usd: 0,
              assets: [],
            }))
          ).map((wallet) => (
            <WalletRow key={wallet.address} wallet={wallet} checking={!snapshot} />
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between gap-2 border-t border-twist-800 pt-3">
          <span className="font-body text-[10px] leading-relaxed text-twist-lightgray">
            {snapshot
              ? `Checked in your browser ${timeAgo(snapshot.checkedAt)}${
                  snapshot.stale ? ' · could not refresh, showing the last check' : ''
                }`
              : 'Checked in your browser — refreshes every 24 hours'}
          </span>
          <button
            type="button"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              void refresh().finally(() => setRefreshing(false));
            }}
            className="focus:outline-none shrink-0 h-7 rounded bg-twist-800 px-2.5 font-body text-[11px] text-gray-300 border border-transparent transition duration-200 hover:border-twist-gray disabled:opacity-50"
          >
            {refreshing ? 'Checking…' : 'Refresh'}
          </button>
        </div>
      </div>
    </div>
  );
};
