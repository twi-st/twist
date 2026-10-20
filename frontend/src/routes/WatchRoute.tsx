import { useNavigate, useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { getAnimeDetail, type AnimeDetail } from '../lib/anime';
import { RouteLoading, RouteNotFound } from '../components/RouteState';
import { AnimePage } from '../views/AnimePage';
import { useStore } from '../lib/store';

export const WatchRoute = () => {
  const { slug, episode: episodeParam } = useParams<{ slug: string; episode: string }>();
  const navigate = useNavigate();
  const ref = slug ? decodeURIComponent(slug) : '';
  const episode = Number(episodeParam);
  const { getProgress, progress } = useStore();

  const [loaded, setLoaded] = useState<{ ref: string; detail: AnimeDetail } | null>(null);
  const [failedRef, setFailedRef] = useState<string | null>(null);

  useEffect(() => {
    if (!ref) return;
    let active = true;

    getAnimeDetail(ref)
      .then((detail) => {
        if (active) setLoaded({ ref, detail });
      })
      .catch(() => {
        if (active) setFailedRef(ref);
      });

    return () => {
      active = false;
    };
  }, [ref]);

  const anime = loaded?.ref === ref ? loaded.detail : null;
  const failed = failedRef === ref;

  useEffect(() => {
    if (anime && anime.routeSlug && anime.routeSlug !== ref && Number.isInteger(episode)) {
      navigate(`/${encodeURIComponent(anime.routeSlug)}/watch/${episode}`, { replace: true });
    }
  }, [anime, ref, episode, navigate]);

  if (failed) {
    return (
      <RouteNotFound
        title="Title not found"
        detail={`Nothing matches “${ref}”. It may have been removed upstream, or the link is wrong.`}
      />
    );
  }

  if (!anime) return <RouteLoading label="Loading episode" />;

  if (!Number.isInteger(episode) || episode < 1) {
    return (
      <RouteNotFound
        title="Episode not found"
        detail={`Episode ${episodeParam} does not exist for ${anime.titles.romaji ?? ref}.`}
      />
    );
  }

  if (anime.episodes !== null && episode > anime.episodes) {
    return (
      <RouteNotFound
        title="Episode not found"
        detail={`${anime.titles.romaji ?? ref} has ${anime.episodes} episode${
          anime.episodes === 1 ? '' : 's'
        }.`}
      />
    );
  }

  // A title link whose route spelling differs from the stored key (Kitsu slug
  // vs `mal-<id>`) must still resume rather than restart at 00:00.
  const saved = getProgress(anime.routeSlug, episode) ?? getProgress(ref, episode);
  const resumeAt = saved && !saved.completed ? saved.currentTime : undefined;

  // Referenced so the route re-renders once the store hydrates its history.
  void progress;

  return <AnimePage anime={anime} slug={anime.routeSlug} episode={episode} resumeAt={resumeAt} />;
};
