import Link from 'next/link';
import { useStore } from '../lib/store';

/**
 * Page header: just the mark and the collapsed-banner affordance. Window
 * chrome (history, search, profile, downloads, chat, settings) is in the
 * TitleBar.
 */
export const Header = () => {
  const { dismissed, restore, settings } = useStore();
  // The home page can hide its mark; the title bar keeps the Twist logo.
  if (!settings.homeLogo) return null;

  // Banners collapse rather than vanish; this arrow reopens them. It stays
  // mounted so it can animate in and out instead of popping.
  const BANNERS = ['donate'] as const;
  const anyCollapsed = BANNERS.some((key) => dismissed[key]);

  return (
    <div className="relative py-5">
      <div className="relative w-16 h-16 m-auto mt-4">
        <Link href="/" aria-label="Twist home">
          <svg viewBox="0 0 16 10">
            <polygon points="0,10 5,0 10,10 9,10 5,2 1,10" fill="#cdcece" />
            <polygon
              points="11,10 6,0 16,0 15.5,1 7.5,1 11.5,9"
              fill="var(--accent, #d4433c)"
            />
          </svg>
        </Link>

        <button
          type="button"
          onClick={() => BANNERS.forEach((key) => restore(key))}
          inert={!anyCollapsed}
          aria-label="Show banners"
          title="Show banners"
          className={`focus:outline-none cursor-default absolute left-full top-1/2 ml-2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full bg-twist-800 border border-transparent text-twist-lightgray transition duration-300 ease-out ${
            anyCollapsed
              ? 'translate-x-0 scale-100 opacity-100 hover:border-twist-gray hover:text-gray-100'
              : 'pointer-events-none -translate-x-1.5 scale-75 opacity-0'
          }`}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={`h-3.5 w-3.5 transition-transform duration-300 ease-out ${
              anyCollapsed ? 'rotate-0' : 'rotate-180'
            }`}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>
    </div>
  );
};
