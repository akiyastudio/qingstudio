import { useCallback, useState } from 'react';
import type { WorkspaceProject } from '../../types';
import {
  EMPTY_WORKSPACE_TABS,
  activateBrowserPage,
  closeBrowserPage,
  closeProjectPages,
  createBrowserPage,
  ensureInspirationRootPage,
  replaceInspirationRootPages,
  selectProjectFromSidebar,
  selectInspirationPath,
  updateBrowserPagePath,
  updateProjectPages,
  type BrowserPageInstance,
  type WorkspaceTabsState,
} from './workspace-tab-model';

const createPageId = () => crypto.randomUUID();

export const useWorkspaceTabs = (initialState: WorkspaceTabsState = EMPTY_WORKSPACE_TABS) => {
  const [state, setState] = useState(initialState);
  const createPage = useCallback((page: Omit<BrowserPageInstance, 'id'> & { id?: string }) => {
    const id = page.id || createPageId();
    setState(current => createBrowserPage(current, { ...page, id }));
    return id;
  }, []);
  const activatePage = useCallback((id: string) => setState(current => activateBrowserPage(current, id)), []);
  const updatePagePath = useCallback((id: string, path: string) => setState(current => updateBrowserPagePath(current, id, path)), []);
  const closePage = useCallback((id: string) => setState(current => closeBrowserPage(current, id)), []);
  const updateProject = useCallback((project: WorkspaceProject) => setState(current => updateProjectPages(current, project)), []);
  const closeProject = useCallback((projectId: string) => setState(current => closeProjectPages(current, projectId)), []);
  const selectSidebarProject = useCallback((project: WorkspaceProject) => {
    const pageId = createPageId();
    setState(current => selectProjectFromSidebar(current, project, pageId));
  }, []);
  const requestInspirationPath = useCallback((rootPath: string, path: string) => {
    const pageId = createPageId();
    setState(current => selectInspirationPath(current, rootPath, path, pageId));
  }, []);
  const ensureInspirationRoot = useCallback((rootPath: string) => {
    const pageId = createPageId();
    setState(current => ensureInspirationRootPage(current, rootPath, pageId));
  }, []);
  const resetInspirationPages = useCallback((rootPath: string, keepRootPage: boolean) => {
    const pageId = createPageId();
    setState(current => replaceInspirationRootPages(current, rootPath, keepRootPage, pageId));
  }, []);
  return { ...state, createPage, activatePage, updatePagePath, closePage, updateProject, closeProject, selectSidebarProject, requestInspirationPath, ensureInspirationRoot, resetInspirationPages };
};
