export const MAX_PERSISTENT_NOTICES = 4;
export const MAX_TRANSIENT_NOTICES = 5;
export const MAX_TOTAL_NOTICES = 8;

export interface TopToastNotice {
  id: number;
  message: string;
  persistent: boolean;
  count: number;
  tone?: 'info' | 'success' | 'warning' | 'error';
  dedupeKey?: string;
  sourceComponentId?: string;
}

export const enqueueTopToastNoticeWithEvictions = (current: TopToastNotice[], incoming: TopToastNotice) => {
  const repeatedPersistent = incoming.persistent && !incoming.dedupeKey
    ? current.find(notice => notice.persistent
      && !notice.dedupeKey
      && notice.message === incoming.message
      && notice.sourceComponentId === incoming.sourceComponentId)
    : undefined;
  let next = repeatedPersistent
    ? [...current.filter(notice => notice.id !== repeatedPersistent.id), { ...repeatedPersistent, count: repeatedPersistent.count + 1 }]
    : [...current, incoming];
  if (incoming.persistent) {
    let overflow = next.filter(notice => notice.persistent).length - MAX_PERSISTENT_NOTICES;
    next = next.filter(notice => {
      if (!notice.persistent || overflow <= 0) return true;
      overflow -= 1;
      return false;
    });
  }
  const beforeBounds = next;
  const kept = [...next];
  while (kept.filter(notice => !notice.persistent).length > MAX_TRANSIENT_NOTICES || kept.length > MAX_TOTAL_NOTICES) {
    let index = kept.findIndex(notice => !notice.persistent && notice.tone !== 'error');
    if (index < 0) index = kept.findIndex(notice => !notice.persistent);
    if (index < 0) index = 0;
    kept.splice(index, 1);
  }
  const keptIds = new Set(kept.map(notice => notice.id));
  return { notices: kept, evictedIds: beforeBounds.filter(notice => !keptIds.has(notice.id)).map(notice => notice.id) };
};

export const enqueueTopToastNotice = (current: TopToastNotice[], incoming: TopToastNotice) => enqueueTopToastNoticeWithEvictions(current, incoming).notices;

export const removeTopToastNotice = (current: TopToastNotice[], id: number) => current.filter(notice => notice.id !== id);
export const upsertTopToastNotice = (current: TopToastNotice[], incoming: TopToastNotice) => {
  const existing = incoming.dedupeKey
    ? current.find(notice => notice.dedupeKey === incoming.dedupeKey)
    : current.find(notice => notice.id === incoming.id);
  if (!existing) return enqueueTopToastNoticeWithEvictions(current, incoming);
  const replacement = { ...incoming, id: existing.id, count: existing.count };
  return { notices: current.map(notice => notice.id === existing.id ? replacement : notice), evictedIds: incoming.id === existing.id ? [] : [incoming.id] };
};
export const purgeComponentTopToastNotices = (current: TopToastNotice[], componentId: string) => current.filter(notice => notice.sourceComponentId !== componentId);
export const clearTopToastNoticeTimers = (timers: Map<number, number>, ids: Iterable<number>, clearTimer: (timer: number) => void) => {
  for (const id of ids) { const timer = timers.get(id); if (timer !== undefined) clearTimer(timer); timers.delete(id); }
};
