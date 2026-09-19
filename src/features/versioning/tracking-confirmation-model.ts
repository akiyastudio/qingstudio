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

export const createPreviewRequestGate = () => {
  let sequence = 0;
  return {
    begin: () => ++sequence,
    isCurrent: (request: number) => request === sequence,
    invalidate: () => { sequence += 1; },
  };
};
