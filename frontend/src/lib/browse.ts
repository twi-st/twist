import { EMPTY_BROWSE, type BrowseQuery } from './anime';

/**
 * The browse query lives in the address bar, so the home list, the title-bar
 * search and any link elsewhere all describe the same view. These helpers are
 * the single place that knows the parameter names.
 */

export const BROWSE_PATH = '/';

/** Reads a browse query out of a URLSearchParams (or the current location). */
export const readBrowseParams = (params: URLSearchParams): BrowseQuery => ({
  ...EMPTY_BROWSE,
  query: params.get('q') ?? '',
  genre: params.get('genre') ?? '',
  tag: params.get('tags') ?? '',
  year: params.get('year') ?? '',
  season: params.get('season') ?? '',
  format: params.get('format') ?? '',
  status: params.get('status') ?? '',
  studio: params.get('studio') ?? '',
  character: params.get('character') ?? '',
  staff: params.get('staff') ?? '',
  origin: params.get('origin') ?? '',
  audio: params.get('audio') ?? '',
  sort: params.get('sort') ?? EMPTY_BROWSE.sort,
});

/** Serialises a browse query; empty values are omitted, as is the default sort. */
export const writeBrowseParams = (query: BrowseQuery): URLSearchParams => {
  const params = new URLSearchParams();
  const set = (key: string, value: string) => {
    if (value) params.set(key, value);
  };
  set('q', query.query.trim());
  set('genre', query.genre);
  set('tags', query.tag);
  set('year', query.year);
  set('season', query.season);
  set('format', query.format);
  set('status', query.status);
  set('studio', query.studio);
  set('character', query.character);
  set('staff', query.staff);
  set('origin', query.origin);
  set('audio', query.audio);
  if (query.sort !== EMPTY_BROWSE.sort) params.set('sort', query.sort);
  return params;
};

/** Full URL for a browse query (used by `navigate`). */
export const browseUrl = (query: BrowseQuery) => {
  const params = writeBrowseParams(query).toString();
  return `${BROWSE_PATH}${params ? `?${params}` : ''}`;
};

/** Number of filters in effect, for the badge on the filter button. */
export const countActiveFilters = (query: BrowseQuery) =>
  Object.entries(query).filter(
    ([key, value]) => key !== 'sort' && key !== 'query' && Boolean(value)
  ).length;
