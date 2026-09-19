import type { ThumbnailState } from '../../types';

export type FolderCoverMediaState = {
  sourceKey: string;
  displayedUrl?: string;
  candidateUrl?: string;
  consecutiveLoadFailures: number;
};

export type FolderCoverMediaAction =
  | { type: 'SOURCE_UPDATED'; sourceKey: string; previewUrl?: string; preserveDisplayed: boolean }
  | { type: 'THUMBNAIL_UPDATED'; state: ThumbnailState; previewUrl?: string }
  | { type: 'CANDIDATE_LOADED'; url: string }
  | { type: 'CANDIDATE_FAILED'; url: string }
  | { type: 'DISPLAYED_FAILED'; url: string };

export const FOLDER_COVER_MAX_CONSECUTIVE_LOAD_FAILURES = 2;

export const folderCoverMediaSourceKey = (
  entry: { path: string; size: number; updatedAt: number },
  requestedSize: number,
) => `${entry.path.replace(/\\/g, '/').toLocaleLowerCase('zh-CN')}|${entry.size}|${entry.updatedAt}|${requestedSize}`;

export const folderCoverRequestKey = (sourceKey: string, pendingRename: boolean, retryVersion: number) => (
  `${sourceKey}|pending:${pendingRename ? 1 : 0}|retry:${retryVersion}`
);

const offerCandidate = (state: FolderCoverMediaState, url?: string): FolderCoverMediaState => {
  if (!url || url === state.displayedUrl || url === state.candidateUrl) return state;
  // Media access grants use a fresh token for every request. Budgeting by URL
  // would therefore turn one broken cache file into an unbounded retry loop.
  if (state.consecutiveLoadFailures >= FOLDER_COVER_MAX_CONSECUTIVE_LOAD_FAILURES) return state;
  return { ...state, candidateUrl: url };
};

export const createFolderCoverMediaState = (sourceKey: string, previewUrl?: string): FolderCoverMediaState => ({
  sourceKey,
  candidateUrl: previewUrl,
  consecutiveLoadFailures: 0,
});

/** Keeps a successfully rendered cover until a replacement URL has itself loaded. */
export const reduceFolderCoverMediaState = (
  state: FolderCoverMediaState,
  action: FolderCoverMediaAction,
): FolderCoverMediaState => {
  switch (action.type) {
    case 'SOURCE_UPDATED': {
      if (state.sourceKey === action.sourceKey) return offerCandidate(state, action.previewUrl);
      const next = {
        sourceKey: action.sourceKey,
        displayedUrl: action.preserveDisplayed ? state.displayedUrl : undefined,
        candidateUrl: undefined,
        consecutiveLoadFailures: 0,
      };
      return offerCandidate(next, action.previewUrl);
    }
    case 'THUMBNAIL_UPDATED':
      // STALE denotes a new source/cache generation, so it receives a fresh
      // bounded load budget while the last successfully painted image stays.
      if (action.state === 'STALE') return { ...state, candidateUrl: undefined, consecutiveLoadFailures: 0 };
      return action.state === 'READY' ? offerCandidate(state, action.previewUrl) : state;
    case 'CANDIDATE_LOADED':
      if (state.candidateUrl !== action.url) return state;
      return {
        ...state,
        displayedUrl: action.url,
        candidateUrl: undefined,
        consecutiveLoadFailures: 0,
      };
    case 'CANDIDATE_FAILED':
      if (state.candidateUrl !== action.url) return state;
      return { ...state, candidateUrl: undefined, consecutiveLoadFailures: state.consecutiveLoadFailures + 1 };
    case 'DISPLAYED_FAILED':
      if (state.displayedUrl !== action.url) return state;
      return { ...state, displayedUrl: undefined, consecutiveLoadFailures: state.consecutiveLoadFailures + 1 };
  }
};
