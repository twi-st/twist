/**
 * GIF search for the chat's `/gif` command.
 *
 * Calls Openverse (keyless, CORS-open) straight from the browser — no server
 * route — and falls back to the bundled set in `public/gifs` when offline or
 * when a query finds nothing.
 */
export type Gif = {
  id: string;
  title: string;
  /** Full-size image posted to the chat. */
  url: string;
  /** Smaller image shown in the picker grid. */
  preview: string;
  tags?: string[];
};

const OPENVERSE_ENDPOINT = 'https://api.openverse.org/v1/images/';
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; results: Gif[] }>();

export const FALLBACK_GIFS: Gif[] = [
  { id: 'sparkle', title: 'Sparkles', url: '/gifs/sparkle.svg', preview: '/gifs/sparkle.svg', tags: ['sparkle', 'star', 'magic', 'shine'] },
  { id: 'heart', title: 'Heartbeat', url: '/gifs/heart.svg', preview: '/gifs/heart.svg', tags: ['heart', 'love', 'like'] },
  { id: 'party', title: 'Party', url: '/gifs/party.svg', preview: '/gifs/party.svg', tags: ['party', 'celebrate', 'congrats'] },
  { id: 'fire', title: 'On fire', url: '/gifs/fire.svg', preview: '/gifs/fire.svg', tags: ['fire', 'lit', 'hot'] },
  { id: 'dance', title: 'Dance', url: '/gifs/dance.svg', preview: '/gifs/dance.svg', tags: ['dance', 'music', 'groove'] },
  { id: 'cat', title: 'Cat', url: '/gifs/cat.svg', preview: '/gifs/cat.svg', tags: ['cat', 'cute', 'pet'] },
  { id: 'shock', title: 'Shocked', url: '/gifs/shock.svg', preview: '/gifs/shock.svg', tags: ['shocked', 'wow', 'surprise'] },
  { id: 'laugh', title: 'Laughing', url: '/gifs/laugh.svg', preview: '/gifs/laugh.svg', tags: ['lol', 'laugh', 'funny'] },
  { id: 'zzz', title: 'Sleepy', url: '/gifs/zzz.svg', preview: '/gifs/zzz.svg', tags: ['sleep', 'tired', 'late'] },
  { id: 'boom', title: 'Boom', url: '/gifs/boom.svg', preview: '/gifs/boom.svg', tags: ['boom', 'mindblown', 'explode'] },
];

const localMatches = (query: string) => {
  const search = query.trim().toLowerCase();
  if (!search) return FALLBACK_GIFS;
  const words = search.split(/\s+/);
  return FALLBACK_GIFS.filter((gif) =>
    words.some(
      (word) =>
        gif.title.toLowerCase().includes(word) ||
        (gif.tags ?? []).some((tag) => tag.startsWith(word))
    )
  );
};

type OpenverseImage = { id: string; title?: string; url: string };

const fetchOpenverse = async (query: string): Promise<Gif[]> => {
  const cached = cache.get(query);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.results;

  const url = new URL(OPENVERSE_ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('extension', 'gif');
  url.searchParams.set('page_size', '18');

  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`GIF provider failed (${response.status})`);

  const data = (await response.json()) as { results?: OpenverseImage[] };
  const results = (data.results ?? [])
    .filter((image) => Boolean(image.url))
    .map((image) => ({
      id: image.id,
      title: image.title?.trim() || 'GIF',
      url: image.url,
      preview: image.url,
    }));

  cache.set(query, { at: Date.now(), results });
  return results;
};

export async function searchGifs(query: string): Promise<Gif[]> {
  const search = query.trim();

  // No query yet: show the bundled set instantly instead of a round-trip.
  if (!search) return FALLBACK_GIFS;

  try {
    const results = await fetchOpenverse(search);
    return results.length > 0 ? results : localMatches(search);
  } catch {
    return localMatches(search);
  }
}
