export const PROJECT_RATING_CACHE_LIMIT = 20000;

type RatingEntry = { path: string; updatedAt: number; rating?: number };
type RatingResult = { path: string; success: boolean; rating: number };

// Small independent batches let fast files appear while a slow file is still
// being inspected. Publish at most ten snapshots per second for large folders.
export const loadProjectFilterRatings = async ({
  entries, readBatch, getCachedRating, cacheRating, onProgress, isCurrent,
}: {
  entries: readonly RatingEntry[];
  readBatch: (entries: RatingEntry[]) => Promise<{ results: RatingResult[] }>;
  getCachedRating: (entry: RatingEntry) => number | undefined;
  cacheRating: (entry: RatingEntry, rating: number) => void;
  onProgress: (ratings: Record<string, number>, checked: number) => void;
  isCurrent: () => boolean;
}) => {
  const ratings: Record<string, number> = {};
  const pending: RatingEntry[] = [];
  let checked = 0;
  for (const entry of entries) {
    const cached = entry.rating ?? getCachedRating(entry);
    if (cached === undefined) pending.push(entry);
    else { ratings[entry.path] = cached; checked += 1; }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = () => {
    timer = undefined;
    if (!isCurrent()) return;
    // Ratings already published can also be edited while later batches load.
    for (const entry of entries) {
      if (entry.rating !== undefined || !(entry.path in ratings)) continue;
      const current = getCachedRating(entry);
      if (current !== undefined) ratings[entry.path] = current;
    }
    onProgress({ ...ratings }, checked);
  };
  publish();
  let cursor = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(2, Math.ceil(pending.length / 8)) }, async () => {
      while (isCurrent() && cursor < pending.length) {
        const batch = pending.slice(cursor, cursor += 8);
        let results: RatingResult[];
        try { results = (await readBatch(batch)).results || []; }
        catch { results = []; } // Failed reads remain retryable, never cached as zero.
        if (!isCurrent()) return;
        const byPath = new Map(results.map(item => [item.path, item]));
        for (const entry of batch) {
          const item = byPath.get(entry.path);
          if (!item?.success) continue;
          // A rating written by the user while a read was pending wins.
          const rating = getCachedRating(entry) ?? item.rating;
          cacheRating(entry, rating);
          ratings[entry.path] = rating;
        }
        checked += batch.length;
        if (timer === undefined) timer = setTimeout(publish, 100);
      }
    }));
  } finally {
    clearTimeout(timer);
    publish();
  }
};
