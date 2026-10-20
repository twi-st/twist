import { useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { getAnimeDetail, type AnimeDetail } from '../lib/anime';
import { RouteLoading, RouteNotFound } from '../components/RouteState';
import { AnimeInfo } from '../views/AnimeInfo';
import { useNavigate } from 'react-router-dom';

export const InfoRoute = () => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const ref = slug ? decodeURIComponent(slug) : '';

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
    if (anime && anime.routeSlug && anime.routeSlug !== ref) {
      navigate(`/${encodeURIComponent(anime.routeSlug)}/info`, { replace: true });
    }
  }, [anime, ref, navigate]);

  if (failed) {
    return (
      <RouteNotFound
        title="Title not found"
        detail={`Nothing matches “${ref}”. It may have been removed upstream, or the link is wrong.`}
      />
    );
  }

  if (!anime) return <RouteLoading />;

  return <AnimeInfo anime={anime} />;
};
