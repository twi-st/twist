/**
 * Real anime data, fetched in the browser.
 *
 * Everything goes through `@ainzoal/isekai` — there is no backend and no
 * proxy: the package talks to the providers directly.
 *  - browsing/searching runs on **Kitsu** (the default source) with real
 *    server-side filters, sorting and pagination;
 *  - the filters Kitsu cannot express (tag, character, staff, studio, origin)
 *    run on **AniList**, normalized into the same card shape;
 *  - detail pages merge every provider isekai knows for one title;
 *  - skip times come from **AniSkip** (keyless).
 *
 * Results are cached in memory per tab; isekai keeps its own HTTP cache too.
 */
import { Isekai, type Anime, type EpisodeList, type SkipTimes } from '@ainzoal/isekai';

export type { Anime };

let client: Isekai | null = null;

const api = (): Isekai => {
  // `defaultSource` is honoured by the runtime but missing from the shipped
  // types (Kitsu is the package default anyway).
  //
  // Only Kitsu and AniList are in the plan: both answer fast and are CORS-open,
  // and one unreachable provider (Jikan stalls on some networks) used to hold
  // the whole merge until its timeout — which made a cold info page crawl.
  client ??= new Isekai({
    defaultSource: 'kitsu',
    providers: ['kitsu', 'anilist'],
    timeoutMs: 7000,
    retries: 1,
  } as never);
  return client;
};

/* The hand-written package types miss a couple of runtime options. */
type EpisodeRef = string | Record<string, number>;
type EpisodeOptions = { providers?: string[]; offset?: number; maxPages?: number };
type SkipOptions = { number?: number; episodeLength?: number; skipProviders?: string[] };

const episodesOf = (ref: EpisodeRef, options: EpisodeOptions): Promise<EpisodeList> =>
  (api() as unknown as {
    episodes: (ref: EpisodeRef, options: EpisodeOptions) => Promise<EpisodeList>;
  }).episodes(ref, options);

const skipTimesOf = (ref: EpisodeRef, options: SkipOptions): Promise<SkipTimes | null> =>
  api().skipTimes(ref as Parameters<Isekai['skipTimes']>[0], options as Parameters<Isekai['skipTimes']>[1]);

/* ------------------------------ card model ------------------------------- */

export type AnimeCard = {
  /** Route reference: a Kitsu slug, a packed isekai id or `mal:`-style id. */
  ref: string;
  slug: string | null;
  title: string;
  english?: string;
  poster?: string;
  /** Extra cover candidates from other providers (AniList + Kitsu). */
  posters?: string[];
  synopsis?: string;
  genres: string[];
  year?: number;
  score?: number;
  episodes?: number | null;
  /** Episodes that have actually aired — an airing title shows `aired/total`. */
  airedEpisodes?: number | null;
  /** MyAnimeList id, when known: used to batch-fetch aired counts from AniList. */
  malId?: number;
  format?: string;
  status?: string;
  sub: boolean;
  dub: boolean;
  source: 'kitsu' | 'anilist';
};

export type BrowseQuery = {
  query: string;
  genre: string;
  year: string;
  tag: string;
  character: string;
  staff: string;
  studio: string;
  season: string;
  format: string;
  status: string;
  origin: string;
  audio: string;
  sort: string;
};

export const EMPTY_BROWSE: BrowseQuery = {
  query: '',
  genre: '',
  year: '',
  tag: '',
  character: '',
  staff: '',
  studio: '',
  season: '',
  format: '',
  status: '',
  origin: '',
  audio: '',
  sort: 'newest',
};

export type BrowsePage = {
  items: AnimeCard[];
  /** Offset for the next page, or null when the list is exhausted. */
  next: number | null;
  total: number | null;
  /** Which provider answered (AniList covers tag/character/staff/studio/origin). */
  source: 'kitsu' | 'anilist';
};

export const SORT_OPTIONS = [
  { value: 'popularity', label: 'Popular' },
  { value: 'rating', label: 'Rating' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'episodes', label: 'Most episodes' },
  { value: 'title-asc', label: 'Title A–Z' },
  { value: 'title-desc', label: 'Title Z–A' },
];

export const SEASON_OPTIONS = [
  { value: 'winter', label: 'Winter' },
  { value: 'spring', label: 'Spring' },
  { value: 'summer', label: 'Summer' },
  { value: 'fall', label: 'Fall' },
];

export const FORMAT_OPTIONS = [
  { value: 'TV', label: 'TV' },
  { value: 'Movie', label: 'Movie' },
  { value: 'OVA', label: 'OVA' },
  { value: 'ONA', label: 'ONA' },
  { value: 'Special', label: 'Special' },
  { value: 'Music', label: 'Music' },
];

export const STATUS_OPTIONS = [
  { value: 'airing', label: 'Airing' },
  { value: 'finished', label: 'Finished' },
  { value: 'upcoming', label: 'Upcoming' },
];

export const ORIGIN_OPTIONS = [
  { value: 'manga', label: 'Manga' },
  { value: 'light-novel', label: 'Light Novel' },
  { value: 'original', label: 'Original' },
  { value: 'game', label: 'Game' },
  { value: 'visual-novel', label: 'Visual Novel' },
  { value: 'novel', label: 'Novel' },
  { value: 'web-novel', label: 'Web Novel' },
  { value: 'web-manga', label: 'Web Manga' },
  { value: 'doujinshi', label: 'Doujinshi' },
  { value: 'live-action', label: 'Live Action' },
];

export const AUDIO_OPTIONS = [
  { value: 'sub', label: 'Sub' },
  { value: 'dub', label: 'Dub' },
];

/** Years offered in the filter — newest first, back to the first anime. */
export const yearOptions = () => {
  const current = new Date().getFullYear() + 1;
  const years: { value: string; label: string }[] = [];
  for (let year = current; year >= 1940; year -= 1) {
    years.push({ value: String(year), label: String(year) });
  }
  return years;
};

/* --------------------------------- cache --------------------------------- */

const cache = new Map<string, { at: number; value: unknown }>();

const cached = async <T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
};

/* ------------------------------ normalization ----------------------------- */

type KitsuResource = {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string; type: string }[] }>;
};

type KitsuList = { data?: KitsuResource[]; included?: KitsuResource[]; meta?: { count?: number } };

const yearOf = (date?: unknown) => {
  if (typeof date !== 'string' || !/^\d{4}/.test(date)) return undefined;
  const year = Number(date.slice(0, 4));
  // Kitsu keeps a few placeholder dates (year 0); don't show them as real.
  return year >= 1800 ? year : undefined;
};

const scoreOf = (averageRating: unknown) => {
  const value = Number(averageRating);
  return Number.isFinite(value) && value > 0 ? Math.round((value / 10) * 10) / 10 : undefined;
};

const KITSU_FORMAT_LABEL: Record<string, string> = {
  TV: 'TV',
  movie: 'Movie',
  OVA: 'OVA',
  ONA: 'ONA',
  special: 'Special',
  music: 'Music',
};

const KITSU_STATUS_LABEL: Record<string, string> = {
  current: 'Airing',
  finished: 'Finished',
  tba: 'Upcoming',
  upcoming: 'Upcoming',
  unreleased: 'Upcoming',
};

/** Nothing that has not aired yet shows up unless the user asks for it. */
const isReleased = (card: AnimeCard) =>
  card.status !== 'Upcoming' &&
  (card.year === undefined || card.year <= new Date().getFullYear());

const cardFromKitsu = (entry: KitsuResource, included: KitsuResource[]): AnimeCard | null => {
  const a = entry.attributes ?? {};
  const titles = (a.titles ?? {}) as Record<string, string>;
  const title = String(a.canonicalTitle ?? titles.en_jp ?? '');
  if (!title) return null;

  const byId = new Map(included.map((item) => [item.id, item]));
  const related = (name: string) =>
    (entry.relationships?.[name]?.data ?? [])
      .map((ref) => byId.get(ref.id))
      .filter((item): item is KitsuResource => Boolean(item));

  const genres = related('categories')
    .map((item) => String(item.attributes?.title ?? ''))
    .filter(Boolean);
  const links = related('streamingLinks');
  // Kitsu lists audio/subtitle languages per service: `dubs: ["ja"]` is just
  // the original audio, so a real dub means a non-Japanese track.
  const languages = (link: KitsuResource, field: 'subs' | 'dubs') =>
    ((link.attributes?.[field] as string[] | undefined) ?? []).map((value) =>
      String(value).toLowerCase()
    );
  const sub = links.some((link) => languages(link, 'subs').some((lang) => lang !== 'ja'));
  const dub = links.some((link) => languages(link, 'dubs').some((lang) => lang !== 'ja'));

  const poster = a.posterImage as Record<string, string> | undefined;

  // The MAL mapping lets the browser batch an AniList call for aired counts.
  const malId = (() => {
    const mappingIds = (entry.relationships?.mappings?.data ?? []).map((ref) => ref.id);
    for (const item of included) {
      if (item.type !== 'mappings' || !mappingIds.includes(item.id)) continue;
      if (String(item.attributes?.externalSite ?? '') !== 'myanimelist/anime') continue;
      const value = Number(item.attributes?.externalId);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return undefined;
  })();

  return {
    ref: String(a.slug ?? entry.id),
    slug: a.slug ? String(a.slug) : null,
    title,
    english: titles.en,
    poster: poster?.medium ?? poster?.large ?? poster?.original,
    posters: [poster?.large, poster?.original, poster?.medium].filter(
      (value): value is string => Boolean(value)
    ),
    synopsis: a.synopsis ? String(a.synopsis) : undefined,
    genres,
    year: yearOf(a.startDate),
    score: scoreOf(a.averageRating),
    episodes: a.episodeCount != null ? Number(a.episodeCount) : null,
    malId,
    format: KITSU_FORMAT_LABEL[String(a.subtype)] ?? (a.subtype ? String(a.subtype) : undefined),
    status: KITSU_STATUS_LABEL[String(a.status)] ?? undefined,
    sub,
    dub,
    source: 'kitsu',
  };
};

/* --------------------------------- Kitsu --------------------------------- */

const KITSU_SUBTYPE: Record<string, string> = {
  TV: 'TV',
  Movie: 'movie',
  OVA: 'OVA',
  ONA: 'ONA',
  Special: 'special',
  Music: 'music',
};

const KITSU_STATUS: Record<string, string> = {
  airing: 'current',
  finished: 'finished',
  // Every not-yet-aired bucket Kitsu uses.
  upcoming: 'upcoming,unreleased,tba',
};

const KITSU_SORT: Record<string, string | undefined> = {
  popularity: '-userCount',
  relevance: undefined,
  rating: '-averageRating',
  newest: '-startDate',
  oldest: 'startDate',
  episodes: '-episodeCount',
  'title-asc': 'canonicalTitle',
  'title-desc': '-canonicalTitle',
};

const browseKitsu = async (query: BrowseQuery, offset: number, limit: number): Promise<BrowsePage> => {
  const pageSize = Math.min(limit, 20); // Kitsu caps page[limit]/size at 20
  const params: Record<string, unknown> = {
    'page[size]': pageSize,
    include: 'categories,streamingLinks,mappings',
  };

  if (query.query.trim()) params['filter[text]'] = query.query.trim();
  if (query.genre) params['filter[categories]'] = query.genre;
  if (query.year) params['filter[seasonYear]'] = query.year;
  if (query.season) params['filter[season]'] = query.season;
  if (query.format) params['filter[subtype]'] = KITSU_SUBTYPE[query.format] ?? query.format;
  if (query.status) params['filter[status]'] = KITSU_STATUS[query.status] ?? query.status;
  // Announced/future titles would otherwise headline "Newest" and "Popular".
  else params['filter[status]'] = 'current,finished';

  const sort = KITSU_SORT[query.sort];
  // Without a text query there is nothing to rank by relevance.
  params.sort = sort ?? (query.query.trim() ? undefined : '-userCount');

  const matchesAudio = (card: AnimeCard) =>
    query.audio === 'dub' ? card.dub : query.audio === 'sub' ? card.sub : true;

  const matchesStatus = (card: AnimeCard) => query.status !== '' || isReleased(card);

  // Streaming flags are not filterable upstream, so an audio filter walks a
  // few pages and keeps what matches (each walk stays one page otherwise).
  const pages = query.audio ? 3 : 1;
  const items: AnimeCard[] = [];
  // Kitsu mis-pages `page[offset]` once a status filter is present, while
  // `page[number]` advances correctly — so the offset is converted here.
  let pageNumber = Math.floor(offset / pageSize) + 1;
  let cursor = offset;
  let total: number | null = null;
  let exhausted = false;

  for (let page = 0; page < pages; page += 1) {
    const json = (await api().raw.kitsu('anime', {
      ...params,
      'page[number]': pageNumber,
    })) as KitsuList;
    if (json.meta?.count != null) total = json.meta.count;

    const cards = (json.data ?? [])
      .map((entry) => cardFromKitsu(entry, json.included ?? []))
      .filter((card): card is AnimeCard => card !== null);

    items.push(...cards.filter(matchesAudio).filter(matchesStatus));
    cursor += pageSize;
    pageNumber += 1;

    if (cards.length < pageSize) {
      exhausted = true;
      break;
    }
  }

  // Airing titles: one batched AniList call fills in how many episodes have
  // actually aired, so a card can read `2/24` instead of just `24`.
  const airing = items.filter((card) => card.status === 'Airing' && card.malId != null);
  if (airing.length > 0) {
    try {
      const counts = await airedCounts(airing.map((card) => card.malId as number));
      for (const card of items) {
        if (card.malId == null) continue;
        const aired = counts.get(card.malId);
        if (aired != null) card.airedEpisodes = aired;
      }
    } catch {
      /* aired counts are a nicety — skip them when AniList is unreachable */
    }
  }

  const next = !exhausted && (total === null || cursor < total) ? cursor : null;
  return { items, next, total, source: 'kitsu' };
};

/* -------------------------------- AniList -------------------------------- */

const ANILIST_MEDIA = `id idMal title { romaji english native } coverImage { extraLarge large } averageScore seasonYear format status episodes nextAiringEpisode { episode } genres description(asHtml: false)`;

/** Airing counts for a batch of MAL ids (one AniList request per browse page). */
const airedCounts = async (malIds: number[]): Promise<Map<number, number>> => {
  const out = new Map<number, number>();
  const ids = [...new Set(malIds)].filter((id) => Number.isFinite(id) && id > 0).slice(0, 50);
  if (ids.length === 0) return out;
  const data = (await api().raw.anilist(
    `query ($ids: [Int]) { Page(page: 1, perPage: 50) { media(type: ANIME, idMal_in: $ids) { idMal nextAiringEpisode { episode } } } }`,
    { ids }
  )) as { Page: { media: Array<{ idMal: number | null; nextAiringEpisode: { episode: number } | null }> } };
  for (const media of data.Page?.media ?? []) {
    if (media.idMal == null || media.nextAiringEpisode?.episode == null) continue;
    // `nextAiringEpisode.episode` is the next one to air, so aired = that - 1.
    out.set(media.idMal, Math.max(0, media.nextAiringEpisode.episode - 1));
  }
  return out;
};

const ANILIST_SORT: Record<string, string> = {
  popularity: 'POPULARITY_DESC',
  relevance: 'SEARCH_MATCH',
  rating: 'SCORE_DESC',
  newest: 'START_DATE_DESC',
  oldest: 'START_DATE',
  episodes: 'EPISODES_DESC',
  'title-asc': 'TITLE_ROMAJI',
  'title-desc': 'TITLE_ROMAJI_DESC',
};

const ANILIST_FORMAT: Record<string, string> = {
  TV: 'TV',
  Movie: 'MOVIE',
  OVA: 'OVA',
  ONA: 'ONA',
  Special: 'SPECIAL',
  Music: 'MUSIC',
};

const ANILIST_STATUS: Record<string, string> = {
  airing: 'RELEASING',
  finished: 'FINISHED',
  upcoming: 'NOT_YET_RELEASED',
};

const ANILIST_SOURCE: Record<string, string> = {
  manga: 'MANGA',
  'light-novel': 'LIGHT_NOVEL',
  original: 'ORIGINAL',
  game: 'VIDEO_GAME',
  'visual-novel': 'VISUAL_NOVEL',
  novel: 'NOVEL',
  'web-novel': 'WEB_NOVEL',
  'web-manga': 'COMIC',
  doujinshi: 'DOUJINSHI',
  'live-action': 'LIVE_ACTION',
};

type AniListMedia = {
  id: number;
  idMal: number | null;
  title: { romaji?: string; english?: string; native?: string } | null;
  coverImage: { extraLarge?: string; large?: string } | null;
  averageScore: number | null;
  seasonYear: number | null;
  format: string | null;
  status: string | null;
  episodes: number | null;
  nextAiringEpisode: { episode: number } | null;
  genres: string[];
  description: string | null;
};

type AniListPage = { pageInfo: { total: number; hasNextPage: boolean }; media: AniListMedia[] };

const stripHtml = (html?: string | null) =>
  html ? html.replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&#039;/g, "'").trim() : undefined;

const ANILIST_FORMAT_LABEL: Record<string, string> = {
  TV: 'TV',
  TV_SHORT: 'TV',
  MOVIE: 'Movie',
  OVA: 'OVA',
  ONA: 'ONA',
  SPECIAL: 'Special',
  MUSIC: 'Music',
};

const ANILIST_STATUS_LABEL: Record<string, string> = {
  RELEASING: 'Airing',
  FINISHED: 'Finished',
  NOT_YET_RELEASED: 'Upcoming',
  CANCELLED: 'Cancelled',
  HIATUS: 'Hiatus',
};

const cardFromAniList = (media: AniListMedia): AnimeCard => {
  const ids = api().ids;
  let ref = String(media.id);
  try {
    if (media.idMal != null || media.id != null) {
      ref = ids.toIsekai({ mal: media.idMal ?? undefined, anilist: media.id });
    }
  } catch {
    ref = media.idMal != null ? `mal:${media.idMal}` : `anilist:${media.id}`;
  }

  return {
    ref,
    slug: null,
    title: media.title?.romaji ?? media.title?.english ?? `#${media.id}`,
    english: media.title?.english ?? undefined,
    poster: media.coverImage?.extraLarge ?? media.coverImage?.large ?? undefined,
    posters: [media.coverImage?.extraLarge, media.coverImage?.large].filter(
      (value): value is string => Boolean(value)
    ),
    synopsis: stripHtml(media.description),
    genres: media.genres ?? [],
    year: media.seasonYear ?? undefined,
    score: media.averageScore != null ? Math.round((media.averageScore / 10) * 10) / 10 : undefined,
    episodes: media.episodes ?? null,
    airedEpisodes:
      media.nextAiringEpisode?.episode != null ? Math.max(0, media.nextAiringEpisode.episode - 1) : null,
    malId: media.idMal ?? undefined,
    format: media.format ? ANILIST_FORMAT_LABEL[media.format] : undefined,
    status: media.status ? ANILIST_STATUS_LABEL[media.status] : undefined,
    // Streaming flags live on Kitsu links; unknown here, not invented.
    sub: false,
    dub: false,
    source: 'anilist',
  };
};

/** Resolves a person/studio name to its AniList id (cached). */
const anilistEntityId = async (kind: 'character' | 'staff' | 'studio', name: string) => {
  const key = `anilist:${kind}:${name.trim().toLowerCase()}`;
  return cached(key, 30 * 60_000, async () => {
    const field = kind === 'studio' ? 'studios' : kind === 'staff' ? 'staff' : 'characters';
    const data = (await api().raw.anilist(
      `query ($search: String) { Page(perPage: 1) { ${field}(search: $search, sort: [FAVOURITES_DESC]) { id name${kind === 'studio' ? '' : ' { full }'} } } }`,
      { search: name.trim() }
    )) as { Page: Record<string, Array<{ id: number }>> };
    return data.Page[field]?.[0]?.id ?? null;
  });
};

/** Tags come from AniList; a typed tag is matched against the real list so
 * "time loop" finds "Time Loop" instead of silently returning nothing. */
/** Tags come from AniList; typed tags are matched against the real list so
 * "time loop" finds "Time Loop". Commas stack tags (AniList ANDs them). */
const resolveTagNames = async (input: string): Promise<string[]> => {
  const parts = input
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const resolved = await Promise.all(parts.map((part) => resolveTagName(part)));
  return [...new Set(resolved)];
};

const resolveTagName = async (input: string): Promise<string> => {
  const needle = input.trim().toLowerCase();
  const tags = await tagOptions().catch(() => [] as OptionGroup[]);
  if (!needle || tags.length === 0) return input.trim();

  const exact = tags.find((tag) => tag.value.toLowerCase() === needle);
  if (exact) return exact.value;

  const starts = tags.filter((tag) => tag.value.toLowerCase().startsWith(needle));
  if (starts.length === 1) return starts[0].value;

  const contains = tags.filter((tag) => tag.value.toLowerCase().includes(needle));
  if (contains.length === 1) return contains[0].value;

  return input.trim();
};

const browseAniList = async (
  query: BrowseQuery,
  offset: number,
  limit: number
): Promise<BrowsePage> => {
  const perPage = 25;
  const page = Math.floor(offset / perPage) + 1;
  void limit;

  // Announced/future titles stay out unless the user asked for them.
  const keep = (card: AnimeCard) => query.status !== '' || isReleased(card);

  // A person or studio filter resolves to their works, not to media search.
  if (query.character || query.staff || query.studio) {
    const kind: 'character' | 'staff' | 'studio' = query.character
      ? 'character'
      : query.staff
        ? 'staff'
        : 'studio';
    const name = (query.character || query.staff || query.studio).trim();
    const id = await anilistEntityId(kind, name);
    if (id == null) return { items: [], next: null, total: 0, source: 'anilist' };

    if (kind === 'staff') {
      const data = (await api().raw.anilist(
        `query ($id: Int, $page: Int, $perPage: Int) { Staff(id: $id) { staffMedia(page: $page, perPage: $perPage, sort: [POPULARITY_DESC], type: ANIME) { pageInfo { total hasNextPage } edges { node { ${ANILIST_MEDIA} } } } } }`,
        { id, page, perPage }
      )) as { Staff: { staffMedia: { pageInfo: AniListPage['pageInfo']; edges: { node: AniListMedia }[] } } };
      const connection = data.Staff.staffMedia;
      return {
        items: connection.edges.map((edge) => cardFromAniList(edge.node)).filter(keep),
        next: connection.pageInfo.hasNextPage ? offset + perPage : null,
        total: connection.pageInfo.total,
        source: 'anilist',
      };
    }

    if (kind === 'studio') {
      // Studio.media takes no `type` argument (isMain does the work).
      const data = (await api().raw.anilist(
        `query ($id: Int, $page: Int, $perPage: Int) { Studio(id: $id) { media(page: $page, perPage: $perPage, sort: [POPULARITY_DESC], isMain: true) { pageInfo { total hasNextPage } nodes { ${ANILIST_MEDIA} } } } }`,
        { id, page, perPage }
      )) as { Studio: { media: { pageInfo: AniListPage['pageInfo']; nodes: AniListMedia[] } } };
      const connection = data.Studio.media;
      return {
        items: connection.nodes.map(cardFromAniList).filter(keep),
        next: connection.pageInfo.hasNextPage ? offset + perPage : null,
        total: connection.pageInfo.total,
        source: 'anilist',
      };
    }

    const data = (await api().raw.anilist(
      `query ($id: Int, $page: Int, $perPage: Int) { Character(id: $id) { media(page: $page, perPage: $perPage, sort: [POPULARITY_DESC], type: ANIME) { pageInfo { total hasNextPage } edges { node { ${ANILIST_MEDIA} } } } } }`,
      { id, page, perPage }
    )) as { Character: { media: { pageInfo: AniListPage['pageInfo']; edges: { node: AniListMedia }[] } } };
    const connection = data.Character.media;
    return {
      items: connection.edges.map((edge) => cardFromAniList(edge.node)).filter(keep),
      next: connection.pageInfo.hasNextPage ? offset + perPage : null,
      total: connection.pageInfo.total,
      source: 'anilist',
    };
  }

  const vars: Record<string, unknown> = {
    page,
    perPage,
    search: query.query.trim() || undefined,
    tag_in: query.tag.trim() ? await resolveTagNames(query.tag) : undefined,
    seasonYear: query.year ? Number(query.year) : undefined,
    season: query.season ? query.season.toUpperCase() : undefined,
    format: query.format ? ANILIST_FORMAT[query.format] : undefined,
    status: query.status ? ANILIST_STATUS[query.status] : undefined,
    status_in: query.status ? undefined : ['RELEASING', 'FINISHED'],
    source: query.origin ? ANILIST_SOURCE[query.origin] : undefined,
    sort: [ANILIST_SORT[query.sort] ?? 'POPULARITY_DESC'],
  };

  const data = (await api().raw.anilist(
    `query ($page: Int, $perPage: Int, $search: String, $tag_in: [String], $seasonYear: Int, $season: MediaSeason, $format: MediaFormat, $status: MediaStatus, $status_in: [MediaStatus], $source: MediaSource, $sort: [MediaSort]) {
      Page(page: $page, perPage: $perPage) { pageInfo { total hasNextPage }
        media(type: ANIME, isAdult: false, search: $search, tag_in: $tag_in, seasonYear: $seasonYear, season: $season, format: $format, status: $status, status_in: $status_in, source: $source, sort: $sort) { ${ANILIST_MEDIA} } } }`,
    vars
  )) as { Page: AniListPage };

  const items = data.Page.media.map(cardFromAniList).filter(keep);
  return {
    items,
    next: data.Page.pageInfo.hasNextPage ? offset + perPage : null,
    total: data.Page.pageInfo.total,
    source: 'anilist',
  };
};

/* --------------------------------- browse -------------------------------- */

/** Filters Kitsu cannot express are routed to AniList. */
const needsAniList = (query: BrowseQuery) =>
  Boolean(query.tag.trim() || query.character.trim() || query.staff.trim() || query.studio.trim() || query.origin);

export const browseAnime = async (
  query: BrowseQuery,
  offset = 0,
  limit = 24
): Promise<BrowsePage> =>
  cached(`browse:${offset}:${limit}:${JSON.stringify(query)}`, 5 * 60_000, () =>
    needsAniList(query) ? browseAniList(query, offset, limit) : browseKitsu(query, offset, limit)
  );

/* ------------------------------- filter data ------------------------------ */

export type OptionGroup = { value: string; label: string };

/** Kitsu's categories, most used first — the genre filter's real options. */
export const genreOptions = async (): Promise<OptionGroup[]> =>
  cached('genres', 24 * 60 * 60_000, async () => {
    const json = (await api().raw.kitsu('categories', {
      'page[limit]': 60,
      sort: '-totalMediaCount',
    })) as { data?: KitsuResource[] };
    return (json.data ?? [])
      .map((entry) => ({
        value: String(entry.attributes?.slug ?? ''),
        label: String(entry.attributes?.title ?? ''),
      }))
      .filter((option) => option.value);
  });

/** AniList's tag list — the tag filter's real options. */
export const tagOptions = async (): Promise<OptionGroup[]> =>
  cached('tags', 24 * 60 * 60_000, async () => {
    const data = (await api().raw.anilist(
      'query { MediaTagCollection { name category } }'
    )) as { MediaTagCollection: { name: string; category: string }[] };
    return (data.MediaTagCollection ?? [])
      .filter((tag) => tag.category !== 'Technical')
      .map((tag) => ({ value: tag.name, label: tag.name }));
  });

/* --------------------------------- detail -------------------------------- */

export type AnimeDetail = Anime & {
  /** Canonical route slug: Kitsu's native slug, or a slugified romaji title. */
  routeSlug: string;
};

/** Every cover URL the merged record knows, best first (AniList, then Kitsu). */
export const detailPosters = (anime: AnimeDetail): string[] => {
  const out: string[] = [];
  const push = (url?: string | null) => {
    if (url && !out.includes(url)) out.push(url);
  };
  for (const image of anime.images?.posters ?? []) {
    push(image.url);
    push(image.thumbUrl);
  }
  for (const image of anime.images?.thumbnails ?? []) {
    push(image.url);
  }
  // The other providers' own cover namespaces, when the merged record carries
  // their ids (kitsu media host is rate-limited more often than AniList's).
  const kitsuId = (anime.ids as Record<string, unknown> | undefined)?.kitsu;
  if (typeof kitsuId === 'number' && kitsuId > 0) {
    push(`https://media.kitsu.app/anime/poster_images/${kitsuId}/large.jpg`);
  }
  const anilistId = (anime.ids as Record<string, unknown> | undefined)?.anilist;
  if (typeof anilistId === 'number' && anilistId > 0) {
    push(`https://img.anili.st/media/${anilistId}`);
  }
  return out;
};

const canonicalSlug = (anime: Anime) => {
  if (anime.slug) return anime.slug;
  const base = anime.titles.romaji ?? anime.titles.english ?? '';
  return api().ids.slugify(base) || String(anime.ids.isekai ?? 'anime');
};

const detailFrom = (anime: Anime): AnimeDetail => ({ ...anime, routeSlug: canonicalSlug(anime) });

/** Provider merges can carry junk slots (isekai then throws on them); keep the
 * three id namespaces we trust and only when they are sane numbers. */
const pickIds = (ids: Record<string, unknown>) => {
  const out: Record<string, number> = {};
  for (const key of ['mal', 'anilist', 'kitsu'] as const) {
    const value = ids[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[key] = value;
  }
  return out;
};

/**
 * `findById` accepts anything, but a *name*-based ref (a slug that is not
 * Kitsu's native one, e.g. `attack-on-titan`) goes through isekai's identify
 * path, which can throw on junk ids a provider merged in. Fall back to an
 * explicit identify + a sanitised id lookup so title-style URLs still work.
 */
const fetchAnime = async (ref: string) => {
  const client = api();
  try {
    return await client.findById(ref);
  } catch (error) {
    let guess: Awaited<ReturnType<typeof client.identify>> | null = null;
    try {
      guess = await client.identify(ref);
    } catch {
      guess = null;
    }
    if (!guess?.best?.ids) throw error;
    const ids = pickIds(guess.best.ids as Record<string, unknown>);
    if (Object.keys(ids).length === 0) throw error;

    // The merge can also choke on junk a *mapping* provider contributed, so
    // narrow the plan to the metadata sources this app actually renders.
    for (const providers of [
      ['kitsu', 'anilist'],
      ['kitsu'],
    ] as string[][]) {
      try {
        return await client.findById(ids as Parameters<typeof client.findById>[0], { providers });
      } catch {
        /* try the next (smaller) plan */
      }
    }
    throw error;
  }
};

/**
 * Merged metadata for a route reference (slug, packed id or `mal:21`).
 * Cached per tab *and* in the browser for 72 hours, so refreshing a page the
 * visitor already opened never re-queries the providers.
 */
const DETAIL_TTL_MS = 72 * 60 * 60 * 1000;
const DETAIL_STORE_KEY = 'twist:anime:detail:v1';
const DETAIL_STORE_MAX = 40;

const readStoredDetail = (ref: string): AnimeDetail | null => {
  try {
    const raw = localStorage.getItem(DETAIL_STORE_KEY);
    if (!raw) return null;
    const store = JSON.parse(raw) as Record<string, { at: number; detail: AnimeDetail }>;
    const entry = store[ref];
    if (!entry || Date.now() - entry.at > DETAIL_TTL_MS) return null;
    return entry.detail;
  } catch {
    return null;
  }
};

const writeStoredDetail = (ref: string, detail: AnimeDetail) => {
  try {
    const raw = localStorage.getItem(DETAIL_STORE_KEY);
    const store = raw
      ? (JSON.parse(raw) as Record<string, { at: number; detail: AnimeDetail }>)
      : {};
    store[ref] = { at: Date.now(), detail };

    // Drop anything expired, then keep the newest entries only.
    const entries = Object.entries(store)
      .filter(([, entry]) => Date.now() - entry.at <= DETAIL_TTL_MS)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, DETAIL_STORE_MAX);
    localStorage.setItem(DETAIL_STORE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* storage unavailable or full */
  }
};

const detailInflight = new Map<string, Promise<AnimeDetail>>();

export const getAnimeDetail = (ref: string): Promise<AnimeDetail> => {
  const key = `detail:${ref}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < DETAIL_TTL_MS) return Promise.resolve(hit.value as AnimeDetail);

  const stored = readStoredDetail(ref);
  if (stored) {
    cache.set(key, { at: Date.now(), value: stored });
    return Promise.resolve(stored);
  }

  // One lookup per title, even when the hover prefetch and the page ask at the
  // same moment.
  const running = detailInflight.get(ref);
  if (running) return running;

  const promise = fetchAnime(ref)
    .then((anime) => {
      const detail = detailFrom(anime);
      cache.set(key, { at: Date.now(), value: detail });
      writeStoredDetail(ref, detail);
      return detail;
    })
    .finally(() => detailInflight.delete(ref));

  detailInflight.set(ref, promise);
  return promise;
};

/**
 * The id namespaces isekai can safely key a lookup on.
 *
 * Provider merges routinely carry junk slots — Kitsu hands back a `tvdb: NaN`
 * for Death Note — and isekai validates *every* slot whenever it parses an ids
 * object, so feeding it a raw ref (or a merged `ids`) makes `episodes()` and
 * `skipTimes()` throw `Invalid tvdb id: null`. Resolve through the cached
 * detail lookup and keep only sane mal/anilist/kitsu ids.
 */
const cleanIds = async (ref: string): Promise<Record<string, number>> => {
  try {
    const ids = pickIds((await getAnimeDetail(ref)).ids as Record<string, unknown>);
    if (Object.keys(ids).length) return ids;
  } catch {
    /* detail lookup failed — fall through to an explicit identify */
  }
  try {
    const guess = await api().identify(ref);
    return pickIds((guess?.best?.ids ?? {}) as Record<string, unknown>);
  } catch {
    return {};
  }
};

export type SlugCard = {
  slug: string;
  title: string;
  english?: string;
  genres: string[];
  poster?: string;
  year?: number;
};

/** The title line to show, following the visitor's title-language setting. */
export const titleOf = (
  titles: { romaji?: string | null; english?: string | null } | null | undefined,
  language: 'romaji' | 'english'
) => {
  if (!titles) return '';
  const romaji = titles.romaji?.trim() ?? '';
  const english = titles.english?.trim() ?? '';
  return language === 'english' ? english || romaji : romaji || english;
};

/** Lightweight card for a stored slug (watch history) — one Kitsu request. */
export const getCardBySlug = async (slug: string): Promise<SlugCard | null> =>
  cached(`card:${slug}`, 60 * 60_000, async () => {
    const json = (await api().raw.kitsu('anime', {
      'filter[slug]': slug,
      'page[limit]': 1,
      include: 'categories',
    })) as KitsuList;
    const entry = json.data?.[0];
    if (!entry) return null;
    const card = cardFromKitsu(entry, json.included ?? []);
    if (!card || !card.slug) return null;
    return {
      slug: card.slug,
      title: card.title,
      english: card.english,
      genres: card.genres,
      poster: card.poster,
      year: card.year,
    };
  });

/* -------------------------------- episodes -------------------------------- */

export type EpisodeEntry = {
  number: number;
  title?: string;
  airedAt?: string;
  durationSec?: number;
  thumbnail?: string;
};

export type EpisodePage = {
  items: EpisodeEntry[];
  total: number | null;
  hasMore: boolean;
};

const KITSU_EPISODE_PAGE = 20;

export const getEpisodePage = async (
  ref: string,
  offset = 0,
  maxPages = 1
): Promise<EpisodePage> =>
  cached(`episodes:${ref}:${offset}:${maxPages}`, 10 * 60_000, async () => {
    // A raw slug ref carries the junk ids that make isekai throw, so key the
    // request on the title's clean ids instead (see `cleanIds`).
    const ids = await cleanIds(ref);
    const target: EpisodeRef =
      ids.kitsu != null
        ? { kitsu: ids.kitsu }
        : ids.anilist != null
          ? { anilist: ids.anilist }
          : ids.mal != null
            ? { mal: ids.mal }
            : ref;
    const list = await episodesOf(target, { providers: ['kitsu'], offset, maxPages });
    const items = list
      .map((episode) => ({
        number: Number(episode.number),
        title: episode.title ?? undefined,
        airedAt: episode.airedAt ?? undefined,
        durationSec: episode.durationSec ?? undefined,
        thumbnail: episode.images?.[0]?.thumbUrl ?? episode.images?.[0]?.url,
      }))
      .filter((episode) => Number.isFinite(episode.number));

    const summary = list.consolidated?.providers?.kitsu;
    const total = summary?.total ?? null;
    const known = offset + KITSU_EPISODE_PAGE * maxPages;
    const hasMore = list.consolidated?.truncated ?? (total !== null ? known < total : items.length >= KITSU_EPISODE_PAGE);
    return { items, total, hasMore };
  });

/* ------------------------------ skip times -------------------------------- */

export type SkipPoint = { start: number; end: number };

export type SkipData = { op?: SkipPoint; ed?: SkipPoint; recap?: SkipPoint };

const range = (value?: { start: number; end: number | null }) =>
  value && value.end != null && value.end > value.start
    ? { start: value.start, end: value.end }
    : undefined;

/** AniSkip skip times for one episode (keyless, real ranges). */
export const getSkipTimes = async (
  ref: string,
  episode: number,
  episodeLength?: number
): Promise<SkipData | null> =>
  cached(`skip:${ref}:${episode}:${Math.round(episodeLength ?? 0)}`, 30 * 60_000, async () => {
    // AniSkip keys on the MAL id and a raw slug ref throws on junk ids (see
    // `cleanIds`). No clean ids at all means there is nothing to look up.
    const ids = await cleanIds(ref);
    const target: EpisodeRef = ids.mal != null ? { mal: ids.mal } : ids;
    if (typeof target !== 'string' && Object.keys(target).length === 0) return null;

    const ask = async (length?: number) => {
      const times = await skipTimesOf(target, {
        number: episode,
        episodeLength: length && length > 0 ? length : undefined,
        // AniSkip only — keyless, real ranges (no Anime Skip client id here).
        skipProviders: ['aniskip'],
      });
      if (!times) return null;
      return { op: range(times.op), ed: range(times.ed), recap: range(times.recap) };
    };

    try {
      // The length hint selects a release variant; if it matches nothing,
      // AniSkip answers empty and the same query without it usually lands.
      const withLength = await ask(episodeLength);
      if (withLength) return withLength;
      return await ask(undefined);
    } catch {
      return null;
    }
  });

/* ------------------------------- related ---------------------------------- */

export type RelatedEntry = { title: string; ref: string; format?: string | null };
export type RelatedGroup = { key: string; entries: RelatedEntry[] };

/** Relation buckets worth showing, in display order (AniList's names). */
const RELATED_ORDER = ['prequel', 'sequel', 'parent', 'spinOff', 'alternative', 'sideStory', 'summary'] as const;
const RELATED_CAP: Record<string, number> = { sideStory: 6, summary: 3, alternative: 4, parent: 4 };
const RELATED_DEFAULT_CAP = 8;

/**
 * Prequels / sequels / spin-offs and the rest of the franchise, grouped and
 * ready to link. One AniList request, keyed by the title's clean ids.
 */
export const getRelated = async (ref: string): Promise<RelatedGroup[]> =>
  cached(`related:${ref}`, 6 * 60 * 60_000, async () => {
    const ids = await cleanIds(ref);
    if (Object.keys(ids).length === 0) return [];

    let raw: Record<string, unknown[]>;
    try {
      raw = (await api().relations(ids as never)) as unknown as Record<string, unknown[]>;
    } catch {
      return [];
    }

    const groups: RelatedGroup[] = [];
    for (const key of RELATED_ORDER) {
      const list = raw[key];
      if (!Array.isArray(list)) continue;

      const entries: RelatedEntry[] = [];
      for (const item of list as Array<{ ids?: Record<string, unknown>; title?: string | null; format?: string | null }>) {
        const relIds = pickIds(item.ids ?? {});
        // The route resolves `mal:`/`anilist:` refs and canonicalises to the slug.
        const target =
          relIds.mal != null ? `mal:${relIds.mal}` : relIds.anilist != null ? `anilist:${relIds.anilist}` : null;
        if (!target) continue;
        entries.push({
          title: (item.title ?? '').trim() || 'Untitled',
          ref: target,
          format: item.format ?? null,
        });
        if (entries.length >= (RELATED_CAP[key] ?? RELATED_DEFAULT_CAP)) break;
      }
      if (entries.length) groups.push({ key, entries });
    }
    return groups;
  });
