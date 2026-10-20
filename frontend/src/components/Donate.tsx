import { useState } from 'react';
import { useCollapsible } from '../lib/useCollapsible';
import { DONATION_GOAL_USD, useDonation } from '../lib/donate';
import { DonateModal } from './DonateModal';

/*
 * The goal lives on-chain: both wallets are checked in the visitor's browser
 * (cached for 24 hours) and this banner shows that snapshot. The banner
 * collapses rather than disappearing — the arrow next to the logo opens it.
 */
export const Donate = () => {
  const { ready, collapsed, collapse } = useCollapsible('donate');
  const { snapshot, failed } = useDonation();
  const [open, setOpen] = useState(false);

  if (!ready) return null;

  const raised = snapshot?.raisedUsd ?? 0;
  const percent = Math.min(100, Math.round((raised / DONATION_GOAL_USD) * 1000) / 10);
  const reached = snapshot !== null && raised >= DONATION_GOAL_USD;

  return (
    <>
      <div
        className="collapsible"
        data-collapsed={collapsed || undefined}
        // The state is inline so the collapse can never depend on a cached CSS
        // build; `.collapsible` only provides `display: grid` + the transition.
        style={{
          gridTemplateRows: collapsed ? '0fr' : '1fr',
          opacity: collapsed ? 0 : 1,
        }}
      >
        <div
          inert={collapsed}
          aria-hidden={collapsed || undefined}
          // Clipping also inline: keeps the collapse self-contained.
          style={{ minHeight: 0, overflow: 'hidden' }}
        >
          <div className="border-b border-twist-800 bg-twist-900">
            <div className="relative mx-auto flex w-full max-w-2xl flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 pr-12">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-full bg-twist-red/15 text-twist-red sm:flex">
                  <svg
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    className="h-4 w-4"
                    aria-hidden="true"
                  >
                    <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                  </svg>
                </span>

                <div className="min-w-0 flex-1">
                  <p className="font-body text-xs text-twist-lightgray">
                    {reached
                      ? 'Goal reached — thank you! Extra support still helps with next month.'
                      : 'Please donate to keep the site up & running, ad-free, and subscription free. We need your help!'}
                  </p>
                  <div
                    className="mt-2 h-1 w-full overflow-hidden rounded-full bg-twist-gray/50"
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
                </div>
              </div>

              <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:shrink-0">
                <span className="font-body text-xs tabular-nums text-twist-lightgray">
                  {snapshot
                    ? `$${raised.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })} / $${DONATION_GOAL_USD.toFixed(2)}`
                    : failed
                      ? 'Balances unavailable'
                      : 'Checking balances…'}
                </span>
                <button
                  type="button"
                  onClick={() => setOpen(true)}
                  className="focus:outline-none cursor-default flex h-8 items-center justify-center rounded bg-twist-red px-3 border border-transparent transition duration-500 ease-in-out hover:bg-twist-reddark"
                >
                  <span className="font-body text-xs text-gray-100">
                    Sure, I&apos;ll donate
                  </span>
                </button>
              </div>

              <button
                type="button"
                onClick={collapse}
                aria-label="Collapse donation banner"
                className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-twist-lightgray transition duration-200 hover:bg-twist-800 hover:text-gray-100"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="h-3.5 w-3.5"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      <DonateModal open={open} onClose={() => setOpen(false)} />
    </>
  );
};
