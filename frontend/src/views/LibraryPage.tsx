import Link from 'next/link';
import { useStore } from '../lib/store';
import { useSlugPosters } from '../lib/useSlugPosters';
import { Shell } from '../components/Shell';
import { Artwork } from '../components/Artwork';

/**
 * The watch-later library: titles saved from an info page. It is local to the
 * device (like the watch history) and deliberately small — the catalogue owns
 * the real metadata, this list only remembers what to put on the shelf.
 *
 * The cards match the home grid exactly (same breakpoints, same aspect ratio,
 * same padding) so the two shelves read as one app.
 */
export const LibraryPage = () => {
  const { library, removeFromLibrary, settings, progress } = useStore();
  // Saved posters are a snapshot; the catalogue's current art wins when it
  // resolves, which keeps a renamed/re-catalogued title looking right.
  const posters = useSlugPosters(library.map((entry) => entry.slug));

  return (
    <Shell>
      <div className="content-column mx-auto w-full px-4 py-6">
        <div className="mt-2 flex items-end justify-between">
          <div>
            <h1 className="font-body text-xl text-gray-100">Library</h1>
            <p className="mt-0.5 font-body text-xs text-twist-lightgray">
              Titles you saved to watch later
            </p>
          </div>
          <span className="font-body text-[11px] tabular-nums text-twist-lightgray">
            {library.length} {library.length === 1 ? 'title' : 'titles'}
          </span>
        </div>

        {library.length === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed border-twist-700 p-8 text-center">
            <p className="font-body text-sm text-twist-lightgray">
              Nothing saved yet. Open a title and press Save.
            </p>
            <Link
              href="/"
              className="mt-3 inline-block rounded bg-twist-red px-3 h-8 font-body text-xs leading-8 text-gray-100 transition duration-200 hover:bg-twist-reddark"
            >
              Browse anime
            </Link>
          </div>
        ) : (
          <div
            className="mt-4 grid gap-3"
            style={{ gridTemplateColumns: `repeat(${settings.homeColumns}, minmax(0, 1fr))` }}
          >
            {library.map((entry) => {
              const next = progress
                .filter((item) => item.slug === entry.slug)
                .sort((a, b) => b.updatedAt - a.updatedAt)[0];
              return (
                <div
                  key={entry.slug}
                  className="group overflow-hidden rounded-lg border border-twist-800 bg-twist-800/40 transition duration-200 hover:border-twist-gray"
                >
                  <Link href={`/${entry.slug}/info`} className="block">
                    <Artwork
                      sources={[posters[entry.slug], entry.poster]}
                      alt={entry.title}
                      className="aspect-[3/4] w-full"
                    />
                  </Link>
                  <div className="p-2.5">
                    <Link
                      href={`/${entry.slug}/info`}
                      className="block truncate font-body text-sm text-gray-300 transition-colors duration-200 group-hover:text-gray-100"
                    >
                      {entry.title}
                    </Link>
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <Link
                        href={
                          next
                            ? `/${entry.slug}/watch/${next.episode}`
                            : `/${entry.slug}/watch/1`
                        }
                        className="truncate font-body text-[10px] text-twist-red transition duration-200 hover:text-twist-redlight"
                      >
                        {next ? `Continue ep ${next.episode}` : 'Start watching'}
                      </Link>
                      <button
                        type="button"
                        onClick={() => removeFromLibrary(entry.slug)}
                        aria-label={`Remove ${entry.title} from library`}
                        title="Remove"
                        className="shrink-0 rounded p-0.5 text-twist-lightgray transition duration-200 hover:text-twist-red"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          className="h-3 w-3"
                          aria-hidden="true"
                        >
                          <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Shell>
  );
};
