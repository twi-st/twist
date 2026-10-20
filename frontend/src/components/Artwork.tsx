import { useEffect, useMemo, useState } from 'react';

/**
 * Artwork with provider fallbacks.
 *
 * Catalogues disagree about which image CDN answers for a title, so every
 * caller passes the candidates it knows (AniList, Kitsu, the episode still…).
 * Each one is tried in order; when they all fail the app draws its own mark
 * instead of leaving a broken image or an empty box.
 */

/**
 * Placeholder for missing artwork: the wordmark on the raised surface.
 */
const PLACEHOLDER = (
  <span className="absolute inset-0 flex items-center justify-center overflow-hidden">
    <svg viewBox="0 0 16 10" aria-hidden="true" className="relative h-auto w-1/2 opacity-30">
      <polygon points="0,10 5,0 10,10 9,10 5,2 1,10" fill="currentColor" />
      <polygon points="11,10 6,0 16,0 15.5,1 7.5,1 11.5,9" fill="var(--accent, #d4433c)" />
    </svg>
  </span>
);

/** Rewrites a provider URL onto a mirror that is usually reachable. */
const variants = (url: string): string[] => {
  const out = [url];
  if (!/^https?:/i.test(url)) return out;
  // Kitsu moved its CDN from media.kitsu.io to media.kitsu.app; the old host
  // now 404s every poster, including URLs cached in older profiles.
  const kitsuHost = /^https?:\/\/media\.kitsu\.(?:io|app)\/(.+)$/i.exec(url);
  if (kitsuHost) {
    out.unshift(`https://media.kitsu.app/${kitsuHost[1]}`);
  }
  // Kitsu's media host is frequently rate-limited; the same art is mirrored by
  // the AniList image proxy for the matching path.
  const kitsu = /^https?:\/\/media\.kitsu\.(?:io|app)\/(.+)$/i.exec(url);
  if (kitsu) out.push(`https://img.anili.st/media/${kitsu[1]}`);
  return [...new Set(out)];
};

export const Artwork = ({
  sources,
  alt = '',
  className = '',
  fit = 'cover',
  children,
}: {
  /** Candidate image URLs, best first. Empty strings are ignored. */
  sources: Array<string | null | undefined>;
  alt?: string;
  className?: string;
  fit?: 'cover' | 'contain';
  /** Overlay content (badges, play buttons) drawn above the image. */
  children?: React.ReactNode;
}) => {
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const source of sources) {
      if (!source) continue;
      for (const url of variants(source)) {
        if (seen.has(url)) continue;
        seen.add(url);
        out.push(url);
      }
    }
    return out;
  }, [sources]);

  const [index, setIndex] = useState(0);
  // A new candidate list restarts the walk from the best source.
  useEffect(() => {
    setIndex(0);
  }, [candidates]);

  const src = candidates[index];
  const exhausted = index >= candidates.length;
  // Callers often position the artwork themselves (absolute inset-0 behind a
  // spinner or a play button). Tailwind emits `.relative` after `.absolute`, so
  // hardcoding `relative` here would silently win and push siblings aside.
  const positioned = /\b(absolute|fixed|sticky|relative)\b/.test(className);

  return (
    <span
      className={`block overflow-hidden bg-twist-800 text-twist-lightgray ${
        positioned ? '' : 'relative'
      } ${className}`}
    >
      {!exhausted && (
        <img
          key={src}
          src={src}
          alt={alt}
          loading="lazy"
          draggable={false}
          onError={() => setIndex((value) => value + 1)}
          className={`absolute inset-0 h-full w-full ${fit === 'contain' ? 'object-contain' : 'object-cover'}`}
        />
      )}
      {exhausted && (
        <span className="absolute inset-0 flex items-center justify-center" aria-label={alt || 'No image'}>
          {PLACEHOLDER}
        </span>
      )}
      {children}
    </span>
  );
};
