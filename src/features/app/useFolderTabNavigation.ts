import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { WorkspaceProject } from '../../types';
import { normalizeWorkspaceRelativePath, pruneFolderNavigationRequests, type BrowserPageInstance, type FolderNavigationRequests } from './workspace-tab-model';

type InspirationPageDraft = Omit<BrowserPageInstance, 'id'>;

export const useFolderTabNavigation = ({
  rootPath,
  pages,
  activePageId,
  createPage,
  requestInspirationPath,
  activateInspiration,
  openProjectInNewTab,
}: {
  rootPath: string;
  pages: BrowserPageInstance[];
  activePageId: string | null;
  createPage: (page: InspirationPageDraft) => string;
  requestInspirationPath: (rootPath: string, relativePath: string) => void;
  activateInspiration: () => void;
  openProjectInNewTab: (project: WorkspaceProject) => void;
}) => {
  const [navigationRequests, setNavigationRequests] = useState<FolderNavigationRequests>({});
  const navigationRequestIdRef = useRef(0);
  const [sourceDragActive, setSourceDragActive] = useState(false);
  useEffect(() => {
    const start = () => setSourceDragActive(true);
    const end = () => setSourceDragActive(false);
    window.addEventListener('photoflow:folder-tab-drag-start', start);
    window.addEventListener('photoflow:folder-tab-drag-end', end);
    return () => {
      window.removeEventListener('photoflow:folder-tab-drag-start', start);
      window.removeEventListener('photoflow:folder-tab-drag-end', end);
    };
  }, []);

  useEffect(() => {
    setNavigationRequests(current => pruneFolderNavigationRequests(current, pages, rootPath));
  }, [pages, rootPath]);

  const openInNewTab = (relativePath: string) => {
    const normalizedPath = normalizeWorkspaceRelativePath(relativePath);
    createPage({ kind: 'inspiration', projectId: `inspiration:${rootPath}`, project: null, inspirationRootPath: rootPath, currentRelativePath: normalizedPath, initialRelativePath: normalizedPath, operation: null });
    activateInspiration();
  };
  const navigateCurrent = (relativePath: string) => {
    const normalizedPath = normalizeWorkspaceRelativePath(relativePath);
    const activePage = pages.find(page => page.id === activePageId && page.kind === 'inspiration');
    if (activePage) {
      const id = ++navigationRequestIdRef.current;
      setNavigationRequests(current => ({ ...current, [activePage.id]: { path: normalizedPath, id } }));
    } else requestInspirationPath(rootPath, normalizedPath);
    activateInspiration();
  };
  const dropProps = {
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
      if (!Array.from(event.dataTransfer.types).includes('application/x-photoflow-folder-tab')) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDrop: (event: React.DragEvent<HTMLDivElement>) => {
      const serialized = event.dataTransfer.getData('application/x-photoflow-folder-tab');
      if (!serialized) return;
      event.preventDefault();
      event.stopPropagation();
      setSourceDragActive(false);
      try {
        const payload = JSON.parse(serialized) as { kind?: string; project?: WorkspaceProject; rootPath?: string; relativePath?: string };
        if (payload.kind === 'inspiration' && payload.rootPath === rootPath && typeof payload.relativePath === 'string') openInNewTab(payload.relativePath);
        else if (payload.kind === 'project' && payload.project && typeof payload.project.id === 'string' && typeof payload.project.path === 'string') openProjectInNewTab(payload.project);
      } catch { /* ignore unrelated or malformed drag payloads */ }
    },
  };
  return { navigationRequests, openInNewTab, navigateCurrent, sourceDragActive, dropProps };
};
