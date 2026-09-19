import type { WorkspaceProject } from '../../types';

export type BrowserPageKind = 'project' | 'inspiration';
export type BrowserPageOperation = 'import' | 'broll' | 'match' | null;

export interface BrowserPageInstance {
  /** Unique identity for this page instance, not for its project. */
  id: string;
  kind: BrowserPageKind;
  /** Stable database project identity shared by every page of one project. */
  projectId: string;
  project: WorkspaceProject | null;
  /** Root captured by an inspiration page so root changes cannot leave stale pages mounted. */
  inspirationRootPath?: string;
  currentRelativePath: string;
  initialRelativePath: string;
  operation: BrowserPageOperation;
}

export interface WorkspaceTabsState {
  pages: BrowserPageInstance[];
  activePageId: string | null;
}

export type FolderNavigationRequests = Record<string, { path: string; id: number }>;

export const browserPageActivation = (page?: BrowserPageInstance) => {
  if (page?.kind === 'inspiration') return { activeTab: 'inspiration' as const, selectedProject: null, projectDestination: null };
  if (page?.project) return { activeTab: 'project' as const, selectedProject: page.project, projectDestination: page.project.path };
  return { activeTab: 'home' as const, selectedProject: null, projectDestination: null };
};

export const EMPTY_WORKSPACE_TABS: WorkspaceTabsState = { pages: [], activePageId: null };

export const createBrowserPage = (state: WorkspaceTabsState, page: BrowserPageInstance): WorkspaceTabsState => {
  if (state.pages.some(candidate => candidate.id === page.id)) throw new Error(`Duplicate browser page id: ${page.id}`);
  return { pages: [...state.pages, page], activePageId: page.id };
};

export const activateBrowserPage = (state: WorkspaceTabsState, pageId: string): WorkspaceTabsState => state.activePageId === pageId
  ? state
  : state.pages.some(page => page.id === pageId)
    ? { ...state, activePageId: pageId }
    : state;

export const updateBrowserPagePath = (state: WorkspaceTabsState, pageId: string, currentRelativePath: string): WorkspaceTabsState => {
  const page = state.pages.find(candidate => candidate.id === pageId);
  if (!page || page.currentRelativePath === currentRelativePath) return state;
  return {
    ...state,
    pages: state.pages.map(candidate => candidate.id === pageId ? { ...candidate, currentRelativePath } : candidate),
  };
};

export const closeBrowserPage = (state: WorkspaceTabsState, pageId: string): WorkspaceTabsState => {
  const closingIndex = state.pages.findIndex(page => page.id === pageId);
  if (closingIndex < 0) return state;
  const pages = state.pages.filter(page => page.id !== pageId);
  if (state.activePageId !== pageId) return { ...state, pages };
  const nextActive = pages[Math.min(closingIndex, pages.length - 1)];
  return { pages, activePageId: nextActive?.id || null };
};

const projectsMatch = (left: WorkspaceProject | null, right: WorkspaceProject) => {
  if (!left) return false;
  const keysMatch = Object.keys(right).every(key => key === 'projectDate'
    || left[key as keyof WorkspaceProject] === right[key as keyof WorkspaceProject])
    && Object.keys(left).every(key => key === 'projectDate'
      || left[key as keyof WorkspaceProject] === right[key as keyof WorkspaceProject]);
  const datesMatch = left.projectDate === right.projectDate
    || Boolean(left.projectDate && right.projectDate
      && left.projectDate.year === right.projectDate.year
      && left.projectDate.month === right.projectDate.month
      && left.projectDate.day === right.projectDate.day
      && left.projectDate.precision === right.projectDate.precision);
  return keysMatch && datesMatch;
};

export const updateProjectPages = (state: WorkspaceTabsState, project: WorkspaceProject): WorkspaceTabsState => {
  if (!state.pages.some(page => page.projectId === project.id && !projectsMatch(page.project, project))) return state;
  return {
    ...state,
    pages: state.pages.map(page => page.projectId === project.id && !projectsMatch(page.project, project) ? { ...page, project } : page),
  };
};

export const closeProjectPages = (state: WorkspaceTabsState, projectId: string): WorkspaceTabsState => {
  if (!state.pages.some(page => page.projectId === projectId)) return state;
  const pages = state.pages.filter(page => page.projectId !== projectId);
  return { pages, activePageId: pages.some(page => page.id === state.activePageId) ? state.activePageId : pages[0]?.id || null };
};

export const selectProjectFromSidebar = (state: WorkspaceTabsState, project: WorkspaceProject, newPageId: string): WorkspaceTabsState => {
  const rootPage = state.pages.find(page => page.kind === 'project' && page.projectId === project.id && page.currentRelativePath === '');
  if (rootPage) return activateBrowserPage(updateProjectPages(state, project), rootPage.id);
  return createBrowserPage(updateProjectPages(state, project), {
    id: newPageId,
    kind: 'project',
    projectId: project.id,
    project,
    currentRelativePath: '',
    initialRelativePath: '',
    operation: null,
  });
};

export const normalizeWorkspaceRelativePath = (value: string) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

export const pruneFolderNavigationRequests = (
  requests: FolderNavigationRequests,
  pages: BrowserPageInstance[],
  rootPath: string,
) => {
  const currentPageIds = new Set(pages
    .filter(page => page.kind === 'inspiration' && page.inspirationRootPath === rootPath)
    .map(page => page.id));
  const entries = Object.entries(requests).filter(([pageId]) => currentPageIds.has(pageId));
  if (entries.length === Object.keys(requests).length) return requests;
  return Object.fromEntries(entries);
};

export const selectInspirationPath = (state: WorkspaceTabsState, rootPath: string, relativePath: string, newPageId: string): WorkspaceTabsState => {
  const normalizedPath = normalizeWorkspaceRelativePath(relativePath);
  const activePage = state.pages.find(page => page.id === state.activePageId);
  if (activePage?.kind === 'inspiration' && activePage.inspirationRootPath === rootPath && activePage.currentRelativePath === normalizedPath) return state;
  const existing = state.pages.find(page => page.kind === 'inspiration' && page.inspirationRootPath === rootPath && page.currentRelativePath === normalizedPath);
  if (existing) return activateBrowserPage(state, existing.id);
  return createBrowserPage(state, {
    id: newPageId,
    kind: 'inspiration',
    projectId: `inspiration:${rootPath}`,
    project: null,
    inspirationRootPath: rootPath,
    currentRelativePath: normalizedPath,
    initialRelativePath: normalizedPath,
    operation: null,
  });
};

export const ensureInspirationRootPage = (state: WorkspaceTabsState, rootPath: string, newPageId: string): WorkspaceTabsState => {
  if (state.pages.some(page => page.kind === 'inspiration' && page.inspirationRootPath === rootPath && page.initialRelativePath === '')) return state;
  const activePageId = state.activePageId;
  const withRoot = selectInspirationPath(state, rootPath, '', newPageId);
  return activePageId ? { ...withRoot, activePageId } : withRoot;
};

export const replaceInspirationRootPages = (state: WorkspaceTabsState, rootPath: string, keepRootPage: boolean, newPageId: string): WorkspaceTabsState => {
  const inspirationWasActive = state.pages.some(page => page.id === state.activePageId && page.kind === 'inspiration');
  const pages = state.pages.filter(page => page.kind !== 'inspiration');
  const base = { pages, activePageId: pages.some(page => page.id === state.activePageId) ? state.activePageId : pages[0]?.id || null };
  if (!keepRootPage) return base;
  const withRoot = selectInspirationPath(base, rootPath, '', newPageId);
  return inspirationWasActive || !base.activePageId ? withRoot : { ...withRoot, activePageId: base.activePageId };
};
