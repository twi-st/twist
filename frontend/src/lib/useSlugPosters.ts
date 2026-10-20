import { useEffect, useState } from 'react';
import { getCardBySlug } from '../lib/anime';

/**
 * Posters for a set of slugs, resolved in the background and cached by the data
 * layer. The list renders immediately with titles and fills the art in when it
 * arrives, so a cold start does not wait on the catalogue.
 */
export const useSlugPosters = (slugs: string[]) => {
  const key = slugs.join(',');
  const [posters, setPosters] = useState<Record<string, string>>({});

  useEffect(() => {
    const list = key ? key.split(',') : [];
    if (list.length === 0) return;

    let active = true;
    void Promise.all(
      list.map(async (slug) => [slug, (await getCardBySlug(slug))?.poster] as const)
    ).then((entries) => {
      if (!active) return;
      setPosters((prev) => {
        const next = { ...prev };
        for (const [slug, poster] of entries) {
          if (poster) next[slug] = poster;
        }
        return next;
      });
    });

    return () => {
      active = false;
    };
  }, [key]);

  return posters;
};
