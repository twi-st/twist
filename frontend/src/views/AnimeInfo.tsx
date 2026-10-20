import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Shell } from '../components/Shell';
import { Artwork } from '../components/Artwork';
import { EpisodeGrid, NextEpisodeCard } from '../components/EpisodeGrid';
import { useStore } from '../lib/store';
import { detailPosters, getRelated, titleOf, type AnimeDetail, type RelatedGroup } from '../lib/anime';

const CARD =
  'rounded-lg border border-twist-800 bg-twist-800/40';

const STATUS_LABEL: Record<string, string> = {
  FINISHED: 'Finished',
  RELEASING: 'Airing',
  NOT_YET_RELEASED: 'Upcoming',
  CANCELLED: 'Cancelled',
  HIATUS: 'Hiatus',
};

const FORMAT_LABEL: Record<string, string> = {
  TV: 'TV',
  TV_SHORT: 'TV Short',
  MOVIE: 'Movie',
  OVA: 'OVA',
  ONA: 'ONA',
  SPECIAL: 'Special',
  MUSIC: 'Music',
};

const SOURCE_LABEL: Record<string, string> = {
  MANGA: 'Manga',
  LIGHT_NOVEL: 'Light Novel',
  NOVEL: 'Novel',
  WEB_NOVEL: 'Web Novel',
  ORIGINAL: 'Original',
  VIDEO_GAME: 'Game',
  VISUAL_NOVEL: 'Visual Novel',
  COMIC: 'Web Manga',
  DOUJINSHI: 'Doujinshi',
  LIVE_ACTION: 'Live Action',
  PICTURE_BOOK: 'Picture Book',
  MULTIMEDIA_PROJECT: 'Multimedia Project',
  OTHER: 'Other',
};

const RELATED_LABEL: Record<string, string> = {
  prequel: 'Prequel',
  sequel: 'Sequel',
  parent: 'Parent story',
  spinOff: 'Spin-off',
  alternative: 'Alternative',
  sideStory: 'Side story',
  summary: 'Recap',
};

const titleCase = (value: string) =>
  value
    .toLowerCase()
    .replace(/(^|\s|-)\w/g, (char) => char.toUpperCase());

const seasonLabel = (season: AnimeDetail['season']) =>
  season ? `${titleCase(season.season)}${season.year ? ` ${season.year}` : ''}` : undefined;

const dateLabel = (value?: string | null) => {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <p className="mb-1 font-body text-xs text-twist-white">
    <span className="font-bold">{label}: </span>
    {children}
  </p>
);

export const AnimeInfo = ({ anime }: { anime: AnimeDetail }) => {
  const { progress } = useStore();

  const episodeTotal = anime.episodes;

  const watched = useMemo(() => {
    const done = new Set(
      progress.filter((entry) => entry.slug === anime.routeSlug && entry.completed).map((entry) => entry.episode)
    );
    return done;
  }, [progress, anime.routeSlug]);

  // "Continue episode N" — the most recently touched episode.
  const resume = useMemo(() => {
    const entries = progress.filter((entry) => entry.slug === anime.routeSlug);
    if (entries.length === 0) return null;
    return entries.reduce((latest, entry) => (entry.updatedAt > latest.updatedAt ? entry : latest));
  }, [progress, anime.routeSlug]);

  const watchHref = `/${anime.routeSlug}/watch/${resume && !resume.completed ? resume.episode : 1}`;

  const poster = anime.images.posters[0]?.url;
  const banner = anime.images.banners[0]?.url;
  const score = anime.score?.value;
  const { settings } = useStore();
  const { inLibrary, toggleLibrary } = useStore();
  const saved = inLibrary(anime.routeSlug);
  const title = titleOf(anime.titles, settings.titleLanguage) || anime.routeSlug;
  // AniList supplies the genre list; Kitsu's categories (tags) fill in when
  // that provider is unavailable.
  const genreChips = anime.genres.length > 0 ? anime.genres : anime.tags.slice(0, 8);

  // Sequels / prequels and the rest of the franchise, resolved after paint.
  const [related, setRelated] = useState<{ slug: string; groups: RelatedGroup[] }>({
    slug: '',
    groups: [],
  });
  useEffect(() => {
    let active = true;
    getRelated(anime.routeSlug)
      .then((groups) => {
        if (active) setRelated({ slug: anime.routeSlug, groups });
      })
      .catch(() => {
        if (active) setRelated({ slug: anime.routeSlug, groups: [] });
      });
    return () => {
      active = false;
    };
  }, [anime.routeSlug]);
  const relatedGroups = related.slug === anime.routeSlug ? related.groups : [];

  return (
    <Shell>
      <div className="content-column mx-auto w-full px-4 py-6">
        {banner && (
          <div className="relative mb-4 h-28 w-full overflow-hidden rounded-lg border border-twist-800 sm:h-36">
            <img src={banner} alt="" className="h-full w-full object-cover opacity-70" />
            <div className="absolute inset-0 bg-gradient-to-t from-twist-900 to-transparent" />
          </div>
        )}

        <div className="flex flex-col gap-6 sm:flex-row">
          <div className="mx-auto w-40 shrink-0 sm:mx-0">
            <Artwork
              sources={[poster, ...detailPosters(anime)]}
              alt={anime.titles.romaji ?? 'Cover'}
              className="aspect-[3/4] w-full rounded"
            />
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="font-body text-2xl leading-tight text-gray-100">{title}</h1>
            {anime.titles.english && anime.titles.english !== title && (
              <span className="mt-1 font-body text-xs text-twist-lightgray">
                {anime.titles.english}
              </span>
            )}
            {settings.titleLanguage === 'english' && anime.titles.romaji && anime.titles.romaji !== title && (
              <span className="mt-1 font-body text-xs text-twist-lightgray">
                {anime.titles.romaji}
              </span>
            )}

            <div className="mt-4 flex items-center gap-3 border-b border-twist-800">
              <span className="inline-block border-b-2 border-twist-red pb-2 font-body text-sm text-gray-200">
                Summary
              </span>
              {score !== undefined && (
                <span className="pb-2 font-body text-sm text-twist-redlight">★ {score}</span>
              )}
            </div>

            <p className="mt-4 whitespace-pre-line font-body text-sm leading-relaxed text-gray-300">
              {anime.synopsis?.trim() || 'No synopsis has been published for this title yet.'}
            </p>

            <div className="mt-6 border-t border-twist-800 pt-4">
              {anime.titles.synonyms?.slice(0, 3).map((synonym) => (
                <Row key={synonym} label="Synonyms">
                  {synonym}
                </Row>
              ))}
              {anime.titles.native && <Row label="Japanese">{anime.titles.native}</Row>}
              <Row label="Type">
                {anime.type ? (FORMAT_LABEL[anime.type] ?? titleCase(anime.type)) : 'Unknown'}
              </Row>
              <Row label="Episodes">{anime.episodes ?? 'Unknown'}</Row>
              <Row label="Status">
                {anime.status ? (STATUS_LABEL[anime.status] ?? titleCase(anime.status)) : 'Unknown'}
              </Row>
              {anime.durationSec ? (
                <Row label="Duration">{Math.round(anime.durationSec / 60)} minutes</Row>
              ) : null}
              <Row label="Aired">
                {[dateLabel(anime.aired?.from), dateLabel(anime.aired?.to)].filter(Boolean).join(' to ') ||
                  'Unknown'}
              </Row>
              {seasonLabel(anime.season) && <Row label="Season">{seasonLabel(anime.season)}</Row>}
              {anime.studios.length > 0 && <Row label="Studio">{anime.studios.join(', ')}</Row>}
              {anime.producers.length > 0 && <Row label="Producers">{anime.producers.join(', ')}</Row>}
              {anime.sourceMaterial?.type && (
                <Row label="Source">
                  {SOURCE_LABEL[anime.sourceMaterial.type] ?? titleCase(anime.sourceMaterial.type)}
                </Row>
              )}
              {anime.contentRating && <Row label="Rated">{anime.contentRating}</Row>}
              {watched.size > 0 && (
                <Row label="Watched">
                  <span className="text-twist-red">
                    {watched.size}
                    {anime.episodes ? ` of ${anime.episodes}` : ''}
                  </span>
                </Row>
              )}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {genreChips.map((genre) => (
                <Link
                  key={genre}
                  href={`/?genre=${encodeURIComponent(
                    genre.toLowerCase().replace(/[^a-z0-9]+/g, '-')
                  )}`}
                  className="rounded bg-twist-800 px-2 py-1 font-body text-xs text-twist-red transition duration-200 hover:bg-twist-700"
                >
                  {genre}
                </Link>
              ))}
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-2">
              <Link
                href={watchHref}
                className="focus:outline-none cursor-default flex w-48 items-center justify-center rounded bg-twist-red h-10 border border-transparent transition duration-500 ease-in-out hover:bg-twist-reddark"
              >
                <span className="font-body text-gray-100">
                  {resume && !resume.completed ? `Continue episode ${resume.episode}` : 'Watch now'}
                </span>
              </Link>

              {/* Save for later: the library lists these newest first. */}
              <button
                type="button"
                aria-pressed={saved}
                onClick={() =>
                  toggleLibrary({
                    slug: anime.routeSlug,
                    title,
                    poster: poster ?? '',
                  })
                }
                title={saved ? 'Remove from library' : 'Save to library'}
                className={`flex h-10 items-center gap-2 rounded border px-3 transition duration-200 ${
                  saved
                    ? 'border-twist-red/70 bg-twist-red/10 text-twist-red'
                    : 'border-transparent bg-twist-800 text-twist-lightgray hover:border-twist-gray hover:text-gray-200'
                }`}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill={saved ? 'currentColor' : 'none'}
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-4 w-4"
                  aria-hidden="true"
                >
                  <path d="M6 4h12a1 1 0 011 1v16l-7-4-7 4V5a1 1 0 011-1z" />
                </svg>
                <span className="font-body text-xs">{saved ? 'In library' : 'Save'}</span>
              </button>
            </div>
          </div>
        </div>

        {anime.links.streaming.length > 0 && (
          <div className={`mt-6 ${CARD} p-4`}>
            <span className="font-body text-xs font-bold uppercase tracking-wide text-twist-red">
              Streaming
            </span>
            <div className="mt-2 flex flex-wrap gap-2">
              {anime.links.streaming.slice(0, 6).map((link) => (
                <a
                  key={`${link.service}-${link.url}`}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="flex items-center gap-1.5 rounded bg-twist-800 px-2 py-1 font-body text-xs text-gray-300 transition duration-200 hover:bg-twist-700"
                >
                  {titleCase(link.service)}
                </a>
              ))}
            </div>
          </div>
        )}

        {relatedGroups.length > 0 && (
          <div className={`mt-6 ${CARD} p-4`}>
            <span className="font-body text-xs font-bold uppercase tracking-wide text-twist-red">
              Related
            </span>
            <div className="mt-3 flex flex-col gap-3">
              {relatedGroups.map((group) => (
                <div key={group.key} className="flex flex-col gap-1.5">
                  <span className="font-body text-[10px] font-bold uppercase tracking-wide text-twist-lightgray">
                    {RELATED_LABEL[group.key] ?? titleCase(group.key)}
                  </span>
                  <span className="flex flex-wrap gap-2">
                    {group.entries.map((entry) => (
                      <Link
                        key={entry.ref}
                        href={`/${entry.ref}/info`}
                        title={entry.title}
                        className="flex max-w-full items-center gap-1.5 rounded bg-twist-800 px-2 py-1 font-body text-xs text-gray-300 transition duration-200 hover:bg-twist-700 hover:text-gray-100"
                      >
                        <span className="truncate">{entry.title}</span>
                        {entry.format && (
                          <span className="shrink-0 text-[10px] text-twist-lightgray">
                            {FORMAT_LABEL[entry.format] ?? titleCase(entry.format)}
                          </span>
                        )}
                      </Link>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-8 border-t border-twist-800 pt-5">
          <span className="font-body text-xs font-bold uppercase tracking-wide text-twist-red">
            Episodes{episodeTotal ? ` (${episodeTotal})` : ''}
          </span>

          <NextEpisodeCard
            nextEpisode={
              anime.nextEpisode
                ? { number: anime.nextEpisode.number, airsAt: anime.nextEpisode.airsAt }
                : null
            }
          />

          <EpisodeGrid
            slug={anime.routeSlug}
            total={episodeTotal}
            nextEpisode={anime.nextEpisode?.number}
            completed={watched}
            focus={resume?.episode}
          />
        </div>

      </div>
    </Shell>
  );
};
