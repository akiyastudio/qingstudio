import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MediaRatingBadge } from '../../components/MediaRatingBadge';
import type { AppConfig, ProjectFileEntry } from '../../types';
import { mediaRatingCacheKey } from './file-entry-interaction-model';

export function RatedMediaThumbnail({ entry, mode, large, loadRating, children }: {
  entry: ProjectFileEntry;
  mode: AppConfig['favoriteDisplayMode'];
  large: boolean;
  loadRating: (entry: ProjectFileEntry) => Promise<number | undefined>;
  children: ReactNode;
}) {
  const container = useRef<HTMLSpanElement>(null);
  const identity = mediaRatingCacheKey(entry.path, entry.updatedAt);
  const [loaded, setLoaded] = useState<{ identity: string; rating: number }>();
  const canReadRating = !entry.viaShortcut && (entry.kind === 'image' || entry.kind === 'raw');
  useEffect(() => {
    if (!canReadRating || typeof entry.rating === 'number' || !container.current) return;
    let active = true;
    const observer = new IntersectionObserver(([item]) => {
      if (!item.isIntersecting) return;
      observer.disconnect();
      void loadRating(entry).then(rating => {
        if (active && rating !== undefined) setLoaded({ identity, rating });
      }).catch(() => undefined);
    }, { rootMargin: '120px' });
    observer.observe(container.current);
    return () => { active = false; observer.disconnect(); };
  }, [identity, entry.rating, canReadRating, loadRating]);
  const rating = entry.rating ?? (loaded?.identity === identity ? loaded.rating : 0);
  return <span ref={container} className="relative flex h-full w-full min-h-0 min-w-0 items-center justify-center">
    {children}
    <MediaRatingBadge rating={rating} mode={mode} large={large}/>
  </span>;
}
