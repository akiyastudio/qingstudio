import type { ProgressTrackingItem, ProgressTrackingSession } from '../../types';

export type TrackingConfirmationCategory = 'recognized' | 'accepted' | 'pending' | 'missing';
export const TRACKING_CONFIRMATION_PAGE_SIZE = 200;

export const trackingConfirmationCategory = (item: ProgressTrackingItem): TrackingConfirmationCategory => {
  if (item.status === 'accepted' || item.status === 'rejected') return 'accepted';
  if (item.status === 'pending_confirmation') return 'pending';
  if (item.status === 'missing_reference') return 'missing';
  return 'recognized';
};

export const groupTrackingConfirmationItems = (items: readonly ProgressTrackingItem[]) => (['recognized', 'accepted', 'pending', 'missing'] as const)
  .map(category => ({ category, items: items.filter(item => trackingConfirmationCategory(item) === category) }));

export type TrackingConfirmationViewState = {
  sessionId: string;
  session?: ProgressTrackingSession;
  items: ProgressTrackingItem[];
  selectedItemId?: string;
  nextCursor?: number;
  minimized: boolean;
};

export const normalizeTrackingSessionNextCursor = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;

export const unresolvedTrackingStatus = (status: ProgressTrackingItem['status']) =>
  status === 'pending_confirmation' || status === 'missing_reference';

export const firstTrackingPreviewItemId = (items: readonly ProgressTrackingItem[]) =>
  items.find(item => item.status === 'pending_confirmation')?.id
  || items.find(item => item.status === 'missing_reference')?.id
  || items[0]?.id;

export const firstUnresolvedTrackingItemId = (items: readonly ProgressTrackingItem[]) =>
  items.find(item => unresolvedTrackingStatus(item.status))?.id;

export const adjacentTrackingPreviewItemId = (items: readonly ProgressTrackingItem[], selectedId: string | undefined, direction: -1 | 1) => {
  if (!items.length) return undefined;
  const current = items.findIndex(item => item.id === selectedId);
  return items[(current < 0 ? 0 : current + direction + items.length) % items.length]?.id;
};

export const nextPendingTrackingItemId = (items: readonly ProgressTrackingItem[], selectedId?: string) => {
  const start = Math.max(0, items.findIndex(item => item.id === selectedId));
  for (let offset = 1; offset <= items.length; offset += 1) {
    const item = items[(start + offset) % items.length];
    if (item && unresolvedTrackingStatus(item.status)) return item.id;
  }
  return undefined;
};

export const mergeTrackingSessionPage = (
  state: TrackingConfirmationViewState,
  page: { session?: ProgressTrackingSession; items: ProgressTrackingItem[]; nextCursor?: number | null },
) => {
  if (page.session && page.session.id !== state.sessionId) return state;
  const byId = new Map(state.items.map(item => [item.id, item]));
  page.items.forEach(item => byId.set(item.id, item));
  const items = [...byId.values()];
  const nextCursor = normalizeTrackingSessionNextCursor(page.nextCursor);
  return {
    ...state,
    session: page.session || state.session,
    items,
    nextCursor,
    selectedItemId: state.selectedItemId && byId.has(state.selectedItemId)
      ? state.selectedItemId
      : nextCursor === undefined ? firstTrackingPreviewItemId(items) : undefined,
  };
};

export const applyTrackingItemDecision = (
  state: TrackingConfirmationViewState,
  itemId: string,
  status: 'accepted' | 'rejected',
  referenceName?: string,
) => {
  const previousItem = state.items.find(item => item.id === itemId);
  const items = state.items.map(item => item.id === itemId
    ? { ...item, status, ...(referenceName === undefined ? {} : { referenceName }) }
    : item);
  return {
    ...state,
    items,
    selectedItemId: nextPendingTrackingItemId(items, itemId) || itemId,
    session: state.session ? {
      ...state.session,
      unresolvedCount: Math.max(0, state.session.unresolvedCount - (previousItem && unresolvedTrackingStatus(previousItem.status) ? 1 : 0)),
    } : state.session,
  };
};

export const canCommitTrackingSession = (items: readonly ProgressTrackingItem[]) =>
  !items.some(item => unresolvedTrackingStatus(item.status));

export const validTrackingBasename = (name: string | undefined): name is string => Boolean(name
  && name !== '.'
  && name !== '..'
  && !/^[a-zA-Z]:/.test(name)
  && !/[\\/]/.test(name)
  && ![...name].some(character => {
    const codePoint = character.codePointAt(0) || 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  }));

const joinTrackingPath = (folderPath: string, name?: string) => folderPath && validTrackingBasename(name)
  ? `${folderPath.replace(/[\\/]+$/, '')}${folderPath.includes('\\') ? '\\' : '/'}${name}`
  : '';

export const resolveTrackingComparisonPaths = (
  item: ProgressTrackingItem | undefined,
  parentFolderPath: string,
  progressFolderPath: string,
) => {
  const referencePath = joinTrackingPath(parentFolderPath, item?.referenceName);
  return {
    referencePath,
    sourcePath: joinTrackingPath(progressFolderPath, item?.sourceName),
    referenceMissing: Boolean(item && (item.status === 'missing_reference' || !referencePath)),
  };
};

export const setTrackingPanelMinimized = (state: TrackingConfirmationViewState, minimized: boolean) => ({ ...state, minimized });

/**
 * Turn a stored session failure into something a user can act on.
 *
 * The session row records whatever the database worker reported. When a worker is
 * killed mid-operation that string is a bare OS error (`[Errno 9] Bad file
 * descriptor`), which says nothing about the version commit the user asked for.
 * A worker kill is recoverable by retrying, so say that; anything else is shown
 * as recorded, and the message key keeps the raw detail available in the log.
 */
export type TrackingSessionNotice = {
  key: 'message.e3ff2dea171b' | 'message.0dabe30cef58';
  value0: string;
  raw: boolean;
};

export const trackingSessionFailureNotice = (error: string | undefined | null): TrackingSessionNotice | undefined => {
  const detail = (error || '').trim();
  if (!detail) return undefined;
  const workerLost = /\[Errno\s*9\]/i.test(detail)
    || /bad file descriptor/i.test(detail)
    || /database service exited/i.test(detail)
    || /文件句柄无效/.test(detail);
  if (workerLost) return { key: 'message.0dabe30cef58', value0: detail, raw: true };
  return { key: 'message.e3ff2dea171b', value0: detail, raw: false };
};

export const createPreviewRequestGate = () => {
  let sequence = 0;
  return {
    begin: () => ++sequence,
    isCurrent: (request: number) => request === sequence,
    invalidate: () => { sequence += 1; },
  };
};
