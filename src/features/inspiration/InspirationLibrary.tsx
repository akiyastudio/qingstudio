import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Edit, Folder, FolderInput, FolderPlus, Lightbulb, Loader2, Trash2 } from 'lucide-react';
import { useAppDialog } from '../../components/AppDialogProvider';
import { useEscapeLayer } from '../../components/LayerProvider';
import { SidebarSettingsButton } from '../../components/SidebarSettingsButton';
import { FileBrowserWorkspace } from '../workspace/ProjectWorkspace';
import { renamedEntryDestinationPath } from '../workspace/file-entry-interaction-model';
import { pageOwnsFileOperationNotification } from '../workspace/file-operation-notification-model';
import { INSPIRATION_FILE_BROWSER_CONTEXT } from '../file-browser/browser-context';
import type { AppConfig, ComponentContribution, ComponentHostAction, ComponentPageOpenScope, ComponentStatus, WorkspaceProject } from '../../types';
import { useUserFacingToast } from '../app/useUserFacingToast';
import { mayCommitAsyncOperationResult } from '../file-operation-identity-model';
import { componentCapabilityIsAvailable } from '../components/component-availability-model';

export const INSPIRATION_PROJECT_NAME = '.__photoflow_inspiration__';
const inspirationCollapsedPathsStorageKey = (rootPath: string) => {
  const normalizedRoot = rootPath.trim().replace(/\\/g, '/').replace(/\/+$/g, '').toLocaleLowerCase();
  return normalizedRoot ? `photoflow:inspiration-collapsed-paths:${encodeURIComponent(normalizedRoot)}` : '';
};
const readInspirationCollapsedPaths = (rootPath: string) => {
  const storageKey = inspirationCollapsedPathsStorageKey(rootPath);
  if (!storageKey) return new Set<string>();
  try {
    const stored = JSON.parse(window.localStorage.getItem(storageKey) || '[]');
    return new Set<string>(Array.isArray(stored) ? stored.filter(value => typeof value === 'string').slice(0, 20000) : []);
  } catch {
    return new Set<string>();
  }
};
const writeInspirationCollapsedPaths = (rootPath: string, paths: Set<string>) => {
  const storageKey = inspirationCollapsedPathsStorageKey(rootPath);
  if (!storageKey) return;
  try { window.localStorage.setItem(storageKey, JSON.stringify([...paths])); } catch { /* storage unavailable */ }
};
const inspirationNavigatorScrollStorageKey = (rootPath: string) => {
  const normalizedRoot = rootPath.trim().replace(/\\/g, '/').replace(/\/+$/g, '').toLocaleLowerCase();
  return normalizedRoot ? `photoflow:inspiration-scroll:${encodeURIComponent(normalizedRoot)}` : '';
};
const readInspirationNavigatorScroll = (rootPath: string) => {
  const storageKey = inspirationNavigatorScrollStorageKey(rootPath);
  if (!storageKey) return 0;
  try {
    const scrollTop = Number(window.sessionStorage.getItem(storageKey));
    return Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0;
  } catch {
    return 0;
  }
};
const writeInspirationNavigatorScroll = (rootPath: string, scrollTop: number) => {
  const storageKey = inspirationNavigatorScrollStorageKey(rootPath);
  if (!storageKey) return;
  try { window.sessionStorage.setItem(storageKey, String(scrollTop)); } catch { /* storage unavailable */ }
};

export const InspirationLibraryNavigator = ({
  active,
  rootPath,
  targetWorkspacePath,
  currentRelativePath,
  onNavigate,
  onOpenInNewTab,
  onOpenSettings,
}: {
  active: boolean;
  rootPath: string;
  targetWorkspacePath: string;
  currentRelativePath: string;
  onNavigate: (relativePath: string) => void;
  onOpenInNewTab: (relativePath: string) => void;
  onOpenSettings: () => void;
}) => {
  const toast = useUserFacingToast();
  const onNotice = useCallback((message: string, duration?: number) => { toast.show(message, duration); }, [toast]);
  type InspirationFolder = { name: string; relativePath: string; parentRelativePath: string; depth: number };
  const appDialog = useAppDialog();
  const [folders, setFolders] = useState<InspirationFolder[]>([]);
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => readInspirationCollapsedPaths(rootPath));
  const [loading, setLoading] = useState(false);
  const [treeError, setTreeError] = useState('');
  const [folderMenu, setFolderMenu] = useState<{ folder: InspirationFolder; x: number; y: number } | null>(null);
  const [renamingPath, setRenamingPath] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [busyPath, setBusyPath] = useState('');
  const [pendingFolderMutation, setPendingFolderMutation] = useState<{
    kind: 'rename' | 'create' | 'delete'; sourcePath?: string; target?: InspirationFolder;
  } | null>(null);
  const [targetProjectsAvailable, setTargetProjectsAvailable] = useState(false);
  const [targetProject, setTargetProject] = useState<WorkspaceProject | null>(null);
  const folderLoadInFlightRef = useRef(false);
  const folderLoadGenerationRef = useRef(0);
  const folderLoadQueuedRef = useRef(false);
  const folderTreeDirtyRef = useRef(true);
  const lastFolderLoadAtRef = useRef(0);
  const wasNavigatorActiveRef = useRef(active);
  const [folderLoadRevision, setFolderLoadRevision] = useState(0);
  const renameSubmittingRef = useRef(false);
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const selectedFolderRef = useRef<HTMLDivElement>(null);
  const revealedSelectedFolderKeyRef = useRef<string | null>(null);
  const pendingTreeScrollTopRef = useRef<number | null>(null);
  const navigationContextRef = useRef({ rootPath, currentRelativePath });
  navigationContextRef.current = { rootPath, currentRelativePath };
  const rootIdentityRef = useRef({ scopePath: rootPath, generation: 0 });
  if (!mayCommitAsyncOperationResult(rootPath, rootIdentityRef.current.scopePath)) {
    rootIdentityRef.current = { scopePath: rootPath, generation: rootIdentityRef.current.generation + 1 };
  }
  const rootGeneration = rootIdentityRef.current.generation;
  const rootRequestIsCurrent = useCallback((requestedRootPath: string, requestedGeneration: number) => mayCommitAsyncOperationResult(
    requestedRootPath, rootIdentityRef.current.scopePath, requestedGeneration, rootIdentityRef.current.generation,
  ), []);
  useEscapeLayer(Boolean(folderMenu), () => setFolderMenu(null));
  useEscapeLayer(Boolean(renamingPath), () => { if (!renameSubmittingRef.current) setRenamingPath(''); });
  useEffect(() => {
    const closeMenu = () => setFolderMenu(null);
    window.addEventListener('photoflow-menu-open', closeMenu);
    return () => window.removeEventListener('photoflow-menu-open', closeMenu);
  }, []);
  useEffect(() => {
    let disposed = false;
    const loadTargetProject = async () => {
      setTargetProjectsAvailable(false);
      setTargetProject(null);
      if (!targetWorkspacePath.trim()) {
        return;
      }
      try {
        const result = await window.electronAPI.getWorkspaceProjects(targetWorkspacePath);
        if (disposed || !result.success) return;
        const projects = result.statuses.flatMap(group => group.projects).filter(project => project.availability !== 'missing');
        let preferredPath = '';
        try { preferredPath = window.localStorage.getItem('photoflow:inspiration-target-project') || ''; } catch { /* storage unavailable */ }
        setTargetProjectsAvailable(projects.length > 0);
        setTargetProject(projects.find(project => project.path === preferredPath) || null);
      } catch (error) {
        if (!disposed) onNotice(`读取目标项目失败：${error instanceof Error ? error.message : String(error || '未知错误')}`, 6000);
      }
    };
    void loadTargetProject();
    const changed = () => void loadTargetProject();
    window.addEventListener('workspace-projects-changed', changed);
    window.addEventListener('photoflow:inspiration-target-project-changed', changed);
    return () => {
      disposed = true;
      window.removeEventListener('workspace-projects-changed', changed);
      window.removeEventListener('photoflow:inspiration-target-project-changed', changed);
    };
  }, [targetWorkspacePath]);
  const loadFolders = useCallback(async () => {
    const loadGeneration = ++folderLoadGenerationRef.current;
    const requestedRootPath = rootPath;
    const requestedGeneration = rootGeneration;
    if (!rootPath.trim()) {
      setFolders([]);
      setTreeError('');
      return;
    }
    if (folderLoadInFlightRef.current) { folderLoadQueuedRef.current = true; return; }
    folderLoadInFlightRef.current = true;
    pendingTreeScrollTopRef.current = treeScrollRef.current?.scrollTop ?? null;
    setLoading(true);
    try {
      const result = await window.electronAPI.listWorkspaceFolders(rootPath, '未分类', INSPIRATION_PROJECT_NAME);
      if (!rootRequestIsCurrent(requestedRootPath, requestedGeneration) || folderLoadGenerationRef.current !== loadGeneration) return;
      if (result.success) {
        setFolders(current => current.length === result.folders.length
          && current.every((folder, index) => folder.relativePath === result.folders[index]?.relativePath
            && folder.name === result.folders[index]?.name
            && folder.parentRelativePath === result.folders[index]?.parentRelativePath
            && folder.depth === result.folders[index]?.depth)
          ? current : result.folders);
        const treeWarnings = [
          result.truncated ? '目录超过 20000 个，仅显示前 20000 个。' : '',
          result.skippedCount ? `有 ${result.skippedCount} 个目录或链接无法读取。` : '',
        ].filter(Boolean);
        setTreeError(treeWarnings.join(' '));
        folderTreeDirtyRef.current = false;
        lastFolderLoadAtRef.current = Date.now();
      } else {
        setFolders([]);
        setTreeError(result.error || '无法读取目录');
      }
    } catch (error) {
      if (rootRequestIsCurrent(requestedRootPath, requestedGeneration) && folderLoadGenerationRef.current === loadGeneration) {
        setFolders([]);
        setTreeError(error instanceof Error ? error.message : String(error || '无法读取目录'));
      }
    } finally {
      folderLoadInFlightRef.current = false;
      if (rootRequestIsCurrent(requestedRootPath, requestedGeneration) && folderLoadGenerationRef.current === loadGeneration) setLoading(false);
      if (folderLoadQueuedRef.current) {
        folderLoadQueuedRef.current = false;
        setFolderLoadRevision(current => current + 1);
      }
    }
  }, [rootGeneration, rootPath, rootRequestIsCurrent]);
  useEffect(() => { void loadFolders(); }, [folderLoadRevision, loadFolders]);
  useEffect(() => {
    if (active && !wasNavigatorActiveRef.current
      && (folderTreeDirtyRef.current || Date.now() - lastFolderLoadAtRef.current >= 30_000)) void loadFolders();
    wasNavigatorActiveRef.current = active;
  }, [active, loadFolders]);
  useLayoutEffect(() => {
    renameSubmittingRef.current = false;
    setBusyPath('');
    setPendingFolderMutation(null);
    setRenamingPath('');
    setRenameValue('');
    setFolderMenu(null);
    setFolders([]);
    pendingTreeScrollTopRef.current = null;
    setCollapsedPaths(readInspirationCollapsedPaths(rootPath));
  }, [rootPath]);
  useEffect(() => {
    let timer: number | undefined;
    const unsubscribe = window.electronAPI.onWorkspaceFilesChanged(change => {
      if (change.root && change.root.replace(/\\/g, '/').toLocaleLowerCase() !== rootPath.replace(/\\/g, '/').toLocaleLowerCase()) return;
      if (change.eventType === 'change') return;
      folderTreeDirtyRef.current = true;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void loadFolders(), 350);
    });
    const refreshOnFocus = () => {
      if (active && (folderTreeDirtyRef.current || Date.now() - lastFolderLoadAtRef.current >= 30_000)) void loadFolders();
    };
    window.addEventListener('focus', refreshOnFocus);
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
      window.removeEventListener('focus', refreshOnFocus);
    };
  }, [active, loadFolders, rootPath]);
  const presentedFolders = useMemo(() => {
    if (!pendingFolderMutation) return folders;
    if (pendingFolderMutation.kind === 'delete') return folders.filter(folder => folder.relativePath !== pendingFolderMutation.sourcePath && !folder.relativePath.startsWith(`${pendingFolderMutation.sourcePath}/`));
    if (pendingFolderMutation.kind === 'create') return folders;
    if (pendingFolderMutation.kind === 'rename' && pendingFolderMutation.target && pendingFolderMutation.sourcePath) {
      const source = pendingFolderMutation.sourcePath;
      const target = pendingFolderMutation.target;
      return folders.map(folder => folder.relativePath === source || folder.relativePath.startsWith(`${source}/`) ? {
        ...folder,
        name: folder.relativePath === source ? target.name : folder.name,
        relativePath: `${target.relativePath}${folder.relativePath.slice(source.length)}`,
        parentRelativePath: folder.parentRelativePath === source || folder.parentRelativePath.startsWith(`${source}/`)
          ? `${target.relativePath}${folder.parentRelativePath.slice(source.length)}` : folder.parentRelativePath,
      } : folder);
    }
    return folders;
  }, [folders, pendingFolderMutation]);
  const folderByPath = useMemo(() => new Map(presentedFolders.map(folder => [folder.relativePath, folder])), [presentedFolders]);
  const parentPaths = useMemo(() => new Set(presentedFolders.map(folder => folder.parentRelativePath)), [presentedFolders]);
  const collapsibleFolderPaths = useMemo(() => [...parentPaths].filter(Boolean), [parentPaths]);
  const visibleFolders = useMemo(() => presentedFolders.filter(folder => {
    if (collapsedPaths.has('')) return false;
    let parentPath = folder.parentRelativePath;
    while (parentPath) {
      if (collapsedPaths.has(parentPath)) return false;
      parentPath = folderByPath.get(parentPath)?.parentRelativePath || '';
    }
    return true;
  }), [collapsedPaths, folderByPath, presentedFolders]);
  const selectedFolderRevealKey = `${rootPath}\u0000${currentRelativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}`;
  useLayoutEffect(() => {
    const container = treeScrollRef.current;
    if (!container) return;
    const pendingScrollTop = pendingTreeScrollTopRef.current;
    pendingTreeScrollTopRef.current = null;
    if (pendingScrollTop !== null) {
      container.scrollTop = pendingScrollTop;
      return;
    }
    const savedScrollTop = readInspirationNavigatorScroll(rootPath);
    if (savedScrollTop > 0) container.scrollTop = savedScrollTop;
  }, [folders, rootPath]);
  useLayoutEffect(() => {
    if (revealedSelectedFolderKeyRef.current === selectedFolderRevealKey) return;
    const container = treeScrollRef.current;
    const selectedFolder = selectedFolderRef.current;
    if (!container || !selectedFolder) return;
    const containerBounds = container.getBoundingClientRect();
    const selectedBounds = selectedFolder.getBoundingClientRect();
    if (selectedBounds.top < containerBounds.top || selectedBounds.bottom > containerBounds.bottom) {
      selectedFolder.scrollIntoView({ block: 'nearest' });
    }
    revealedSelectedFolderKeyRef.current = selectedFolderRevealKey;
  }, [selectedFolderRevealKey, visibleFolders]);
  useEffect(() => {
    const normalizedPath = currentRelativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!normalizedPath) return;
    const segments = normalizedPath.split('/');
    const pathsToExpand = ['', ...segments.slice(0, -1).map((_segment, index) => segments.slice(0, index + 1).join('/'))];
    setCollapsedPaths(current => {
      if (!pathsToExpand.some(path => current.has(path))) return current;
      const next = new Set(current);
      pathsToExpand.forEach(path => next.delete(path));
      writeInspirationCollapsedPaths(rootPath, next);
      return next;
    });
  }, [currentRelativePath, rootPath]);
  const toggleCollapsed = (relativePath: string) => setCollapsedPaths(current => {
    const next = new Set(current);
    if (next.has(relativePath)) next.delete(relativePath);
    else next.add(relativePath);
    writeInspirationCollapsedPaths(rootPath, next);
    return next;
  });
  const allFoldersCollapsed = collapsedPaths.has('') || (collapsibleFolderPaths.length > 0 && collapsibleFolderPaths.every(path => collapsedPaths.has(path)));
  const toggleAllFolders = () => setCollapsedPaths(() => {
    const next = allFoldersCollapsed ? new Set<string>() : new Set(collapsibleFolderPaths);
    writeInspirationCollapsedPaths(rootPath, next);
    return next;
  });
  const startRename = (folder: InspirationFolder) => {
    if (busyPath) { onNotice('另一个文件夹操作正在处理中'); return; }
    setFolderMenu(null);
    setRenamingPath(folder.relativePath);
    setRenameValue(folder.name);
  };
  const commitRename = async (folder: InspirationFolder) => {
    const requestedRootPath = rootPath;
    const requestedGeneration = rootGeneration;
    const nextName = renameValue.trim();
    if (renameSubmittingRef.current) return;
    if (!nextName || nextName === folder.name) { setRenamingPath(''); return; }
    renameSubmittingRef.current = true;
    setBusyPath(folder.relativePath);
    const targetRelativePath = [folder.parentRelativePath, nextName].filter(Boolean).join('/');
    setPendingFolderMutation({ kind: 'rename', sourcePath: folder.relativePath, target: { ...folder, name: nextName, relativePath: targetRelativePath } });
    setRenamingPath('');
    const requestedCurrentPath = currentRelativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    try {
      const result = await window.electronAPI.projectFileOperation(rootPath, '未分类', INSPIRATION_PROJECT_NAME, 'rename', [folder.relativePath], '', nextName);
      if (!rootRequestIsCurrent(requestedRootPath, requestedGeneration)) return;
      if (!result.success) { onNotice(`重命名文件夹失败：${result.error || '未知错误'}`, 6000); return; }
      const nextRelativePath = renamedEntryDestinationPath(folder.relativePath, nextName, result.movedItems);
      const navigationTarget = requestedCurrentPath === folder.relativePath || requestedCurrentPath.startsWith(`${folder.relativePath}/`)
        ? `${nextRelativePath}${requestedCurrentPath.slice(folder.relativePath.length)}`
        : '';
      setCollapsedPaths(current => {
        const next = new Set<string>();
        for (const collapsedPath of current) {
          next.add(collapsedPath === folder.relativePath || collapsedPath.startsWith(`${folder.relativePath}/`)
            ? `${nextRelativePath}${collapsedPath.slice(folder.relativePath.length)}`
            : collapsedPath);
        }
        writeInspirationCollapsedPaths(rootPath, next);
        return next;
      });
      setRenamingPath('');
      await loadFolders();
      if (!rootRequestIsCurrent(requestedRootPath, requestedGeneration)) return;
      const latestNavigation = navigationContextRef.current;
      if (latestNavigation.rootPath === requestedRootPath
        && navigationTarget
        && latestNavigation.currentRelativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') === requestedCurrentPath) onNavigate(navigationTarget);
    } catch (error) {
      if (!rootRequestIsCurrent(requestedRootPath, requestedGeneration)) return;
      await loadFolders();
      if (!rootRequestIsCurrent(requestedRootPath, requestedGeneration)) return;
      onNotice(`重命名文件夹失败：${error instanceof Error ? error.message : String(error || '未知错误')}`, 6000);
    } finally {
      if (rootRequestIsCurrent(requestedRootPath, requestedGeneration)) {
        renameSubmittingRef.current = false;
        setBusyPath('');
        setPendingFolderMutation(null);
      }
    }
  };
  const createChildFolder = async (folder: InspirationFolder) => {
    if (busyPath) { onNotice('另一个文件夹操作正在处理中'); return; }
    setFolderMenu(null);
    const requestedRootPath = rootPath;
    const requestedGeneration = rootGeneration;
    const requestedCurrentPath = currentRelativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const answer = await appDialog.prompt({ title: '新建文件夹', message: `在“${folder.name}”中输入新文件夹名称。`, defaultValue: '新建文件夹', confirmLabel: '新建' });
    const folderName = answer?.trim();
    if (!folderName) return;
    if (!rootRequestIsCurrent(requestedRootPath, requestedGeneration)) return;
    setBusyPath(folder.relativePath);
    setPendingFolderMutation({ kind: 'create' });
    try {
      const result = await window.electronAPI.createProjectFolder(rootPath, '未分类', INSPIRATION_PROJECT_NAME, folderName, folder.relativePath, true);
      if (!rootRequestIsCurrent(requestedRootPath, requestedGeneration)) return;
      if (!result.success) { onNotice(`新建文件夹失败：${result.error || '未知错误'}`, 6000); return; }
      const createdRelativePath = (result.folder?.relativePath || `${folder.relativePath}/${result.folder?.name || folderName}`).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      setCollapsedPaths(current => {
        if (!current.has(folder.relativePath)) return current;
        const next = new Set(current);
        next.delete(folder.relativePath);
        writeInspirationCollapsedPaths(rootPath, next);
        return next;
      });
      await loadFolders();
      if (!rootRequestIsCurrent(requestedRootPath, requestedGeneration)) return;
      const latestNavigation = navigationContextRef.current;
      if (latestNavigation.rootPath === requestedRootPath
        && latestNavigation.currentRelativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') === requestedCurrentPath) onNavigate(createdRelativePath);
      onNotice(`已在“${folder.name}”中新建文件夹“${result.folder?.name || folderName}”`);
    } catch (error) {
      if (!rootRequestIsCurrent(requestedRootPath, requestedGeneration)) return;
      await loadFolders();
      if (!rootRequestIsCurrent(requestedRootPath, requestedGeneration)) return;
      onNotice(`新建文件夹失败：${error instanceof Error ? error.message : String(error || '未知错误')}`, 6000);
    } finally {
      if (rootRequestIsCurrent(requestedRootPath, requestedGeneration)) {
        setBusyPath('');
        setPendingFolderMutation(null);
      }
    }
  };
  const deleteFolder = async (folder: InspirationFolder) => {
    if (busyPath) { onNotice('另一个文件夹操作正在处理中'); return; }
    const requestedRootPath = rootPath;
    const requestedGeneration = rootGeneration;
    const requestedCurrentPath = currentRelativePath.replace(/\\/g, '/');
    setFolderMenu(null);
    const confirmed = await appDialog.confirm({ title: `删除“${folder.name}”吗？`, message: '文件夹及其中内容将移入系统回收站。', confirmLabel: '删除文件夹', tone: 'danger' });
    if (!rootRequestIsCurrent(requestedRootPath, requestedGeneration) || !confirmed) return;
    setBusyPath(folder.relativePath);
    setPendingFolderMutation({ kind: 'delete', sourcePath: folder.relativePath });
    try {
      const result = await window.electronAPI.projectFileOperation(rootPath, '未分类', INSPIRATION_PROJECT_NAME, 'trash', [folder.relativePath]);
      if (!rootRequestIsCurrent(requestedRootPath, requestedGeneration)) return;
      const pageOwnsNotice = pageOwnsFileOperationNotification(result);
      if (!result.success) { if (result.count) { await loadFolders(); if (!rootRequestIsCurrent(requestedRootPath, requestedGeneration)) return; } if (pageOwnsNotice) onNotice(`删除文件夹失败：${result.error || '未知错误'}`, 6000); return; }
      if (requestedCurrentPath === folder.relativePath || requestedCurrentPath.startsWith(`${folder.relativePath}/`)) onNavigate(folder.parentRelativePath);
      setCollapsedPaths(current => {
        const next = new Set([...current].filter(collapsedPath => collapsedPath !== folder.relativePath && !collapsedPath.startsWith(`${folder.relativePath}/`)));
        writeInspirationCollapsedPaths(rootPath, next);
        return next;
      });
      await loadFolders();
      if (!rootRequestIsCurrent(requestedRootPath, requestedGeneration)) return;
      if (pageOwnsNotice) onNotice(result.warning || `已将文件夹“${folder.name}”移入回收站`, result.warning ? 8000 : undefined);
    } catch (error) {
      if (!rootRequestIsCurrent(requestedRootPath, requestedGeneration)) return;
      await loadFolders();
      if (!rootRequestIsCurrent(requestedRootPath, requestedGeneration)) return;
      onNotice(`删除文件夹失败：${error instanceof Error ? error.message : String(error || '未知错误')}`, 6000);
    } finally {
      if (rootRequestIsCurrent(requestedRootPath, requestedGeneration)) {
        setBusyPath('');
        setPendingFolderMutation(null);
      }
    }
  };
  const addFolderToProject = (folder: InspirationFolder, chooseProject = false) => {
    setFolderMenu(null);
    window.dispatchEvent(new CustomEvent('photoflow:inspiration-add-folder-to-project', { detail: { relativePath: folder.relativePath, chooseProject } }));
  };
  const treeRow = (label: string, relativePath: string, depth: number, hasChildren: boolean) => {
    const selected = currentRelativePath.replace(/\\/g, '/') === relativePath;
    const collapsed = collapsedPaths.has(relativePath);
    const folder = relativePath ? folderByPath.get(relativePath) : undefined;
    const renaming = renamingPath === relativePath;
    return <div ref={selected ? selectedFolderRef : undefined} key={relativePath || '__root__'} onContextMenu={event => { if (!folder) return; event.preventDefault(); window.dispatchEvent(new Event('photoflow-menu-open')); setFolderMenu({ folder, x: event.clientX, y: event.clientY }); }} className={`group flex min-w-0 items-center rounded-lg ${selected ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-50'}`} style={{ paddingLeft: 5 + depth * 14 }}>
      <button type="button" disabled={!hasChildren} onClick={() => toggleCollapsed(relativePath)} aria-label={`${collapsed ? '展开' : '收起'} ${label}`} className="flex h-8 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-200 disabled:invisible">{collapsed ? <ChevronRight size={14}/> : <ChevronDown size={14}/>}</button>
      {renaming && folder ? <form className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2" onSubmit={event => { event.preventDefault(); void commitRename(folder); }}><Folder size={16} className="shrink-0 text-blue-500"/><input autoFocus value={renameValue} onChange={event => setRenameValue(event.target.value)} onFocus={event => event.currentTarget.select()} onBlur={() => void commitRename(folder)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setRenamingPath(''); } }} disabled={busyPath === relativePath} aria-label={`重命名 ${label}`} className="min-w-0 flex-1 rounded border border-blue-400 bg-white px-1.5 py-0.5 text-sm text-slate-800 outline-none ring-2 ring-blue-100"/></form> : <button type="button" draggable={!busyPath} onDragStart={event => {
        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData('application/x-photoflow-folder-tab', JSON.stringify({ kind: 'inspiration', rootPath, relativePath }));
        event.dataTransfer.setData('text/plain', label);
        window.dispatchEvent(new Event('photoflow:folder-tab-drag-start'));
      }} onDragEnd={() => window.dispatchEvent(new Event('photoflow:folder-tab-drag-end'))} onClick={() => onNavigate(relativePath)} title={label} className={`flex min-w-0 flex-1 items-center gap-2 py-2 pr-2 text-left text-sm ${selected ? 'font-bold' : ''}`}><Folder size={16} className="shrink-0 text-blue-500"/><span className="truncate">{label}</span></button>}
    </div>;
  };
  return <nav aria-label="灵感库导航" className="flex min-h-0 flex-1 flex-col bg-white">
    {folderMenu && createPortal(<div className="fixed inset-0 z-[420]" onPointerDown={() => setFolderMenu(null)} onContextMenu={event => { event.preventDefault(); setFolderMenu(null); }}><div role="menu" aria-label={`${folderMenu.folder.name} 文件夹菜单`} onPointerDown={event => event.stopPropagation()} className="project-context-menu fixed w-60 rounded-lg border border-slate-200 bg-white p-1.5 shadow-2xl" style={{ left: Math.min(folderMenu.x, Math.max(8, window.innerWidth - 248)), top: Math.min(folderMenu.y, Math.max(8, window.innerHeight - 250)) }}><button type="button" className="project-menu-item" onClick={() => { const path = folderMenu.folder.relativePath; setFolderMenu(null); onOpenInNewTab(path); }}><FolderPlus size={14}/>在新标签页打开</button><div className="my-1 border-t border-slate-100"/><button type="button" className="project-menu-item" onClick={() => void createChildFolder(folderMenu.folder)}><FolderPlus size={14}/>新建文件夹</button><div className="my-1 border-t border-slate-100"/><button type="button" className="project-menu-item" onClick={() => startRename(folderMenu.folder)}><Edit size={14}/>重命名</button><button type="button" disabled={!targetProjectsAvailable} className="project-menu-item" onClick={() => addFolderToProject(folderMenu.folder)}><FolderInput size={14}/>添加到项目{targetProject ? `“${targetProject.name}”` : '…'}</button>{targetProject && <button type="button" className="project-menu-item" onClick={() => addFolderToProject(folderMenu.folder, true)}><ChevronDown size={14}/>选择其他项目…</button>}<div className="my-1 border-t border-slate-100"/><button type="button" className="project-menu-item project-menu-danger" onClick={() => void deleteFolder(folderMenu.folder)}><Trash2 size={14}/>删除文件夹</button></div></div>, document.body)}
    <div className="flex items-center gap-2 px-4 pb-3 pt-3 text-sm font-bold text-slate-800"><Lightbulb size={18} className="text-amber-500"/><span className="min-w-0 flex-1 truncate">灵感库</span><button type="button" disabled={!collapsibleFolderPaths.length} onClick={toggleAllFolders} aria-label={allFoldersCollapsed ? '展开全部文件夹' : '折叠全部文件夹'} title={allFoldersCollapsed ? '展开全部文件夹' : '折叠全部文件夹'} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:cursor-default disabled:opacity-30">{allFoldersCollapsed ? <ChevronsUpDown size={16}/> : <ChevronsDownUp size={16}/>}</button></div>
    <div ref={treeScrollRef} onScroll={event => writeInspirationNavigatorScroll(rootPath, event.currentTarget.scrollTop)} className="inspiration-navigator-scroll min-h-0 flex-1 space-y-1 overflow-y-auto px-3">
      {rootPath ? <div className="space-y-0.5">{treeRow('灵感库文件夹', '', 0, folders.length > 0)}{loading && !folders.length ? <p className="flex items-center gap-2 px-3 py-3 text-xs text-slate-400"><Loader2 size={14} className="animate-spin"/>正在读取目录…</p> : visibleFolders.map(folder => treeRow(folder.name, folder.relativePath, folder.depth + 1, parentPaths.has(folder.relativePath))) }{treeError && <p className="px-3 py-2 text-xs leading-5 text-amber-600">{treeError}</p>}</div> : <p className="px-3 py-4 text-xs leading-5 text-slate-400">首次进入灵感库时请选择文件夹。</p>}
    </div>
    <SidebarSettingsButton onClick={onOpenSettings}/>
  </nav>;
};

export const InspirationLibraryPage = ({
  pageId,
  active,
  initialRelativePath,
  config,
  components,
  componentHostActions,
  componentContributions,
  onOpenComponentPage,
  onUpdateConfig,
  onDirectoryChange,
  navigationRequest,
  onOpenDirectoryPage,
}: {
  pageId: string;
  active: boolean;
  initialRelativePath: string;
  config: AppConfig;
  components: ComponentStatus[];
  componentHostActions: ComponentHostAction[];
  componentContributions: ComponentContribution[];
  onOpenComponentPage: (action: ComponentHostAction, project: WorkspaceProject, workspacePath: string, scope: ComponentPageOpenScope) => void;
  onUpdateConfig: (config: AppConfig) => void | boolean | Promise<void | boolean>;
  onDirectoryChange: (pageId: string, relativePath: string) => void;
  navigationRequest?: { path: string; id: number };
  onOpenDirectoryPage: (relativePath: string) => void;
}) => {
  const toast = useUserFacingToast();
  const onNotice = useCallback((message: string, duration?: number) => { toast.show(message, duration); }, [toast]);
  const rootPath = config.inspirationLibrary.rootPath.trim();
  const [choosingRoot, setChoosingRoot] = useState(false);
  const attemptedInitialChoiceRef = useRef(false);
  const chooseRoot = useCallback(async () => {
    if (choosingRoot) return;
    setChoosingRoot(true);
    try {
      const result = await window.electronAPI.chooseWorkspaceDirectory(rootPath);
      if (result.cancelled || !result.path) return;
      const nextConfig = { ...config, inspirationLibrary: { ...config.inspirationLibrary, rootPath: result.path } };
      const saved = await onUpdateConfig(nextConfig);
      if (saved === false) onNotice('保存灵感库文件夹失败，请重试。', 6000);
      else onDirectoryChange(pageId, '');
    } catch (error) {
      onNotice(`选择灵感库文件夹失败：${error instanceof Error ? error.message : String(error || '未知错误')}`, 6000);
    } finally {
      setChoosingRoot(false);
    }
  }, [choosingRoot, config, onDirectoryChange, onNotice, onUpdateConfig, pageId, rootPath]);
  useEffect(() => {
    if (!active || rootPath || attemptedInitialChoiceRef.current) return;
    attemptedInitialChoiceRef.current = true;
    void chooseRoot();
  }, [active, chooseRoot, rootPath]);
  const handleDirectoryChange = useCallback((relativePath: string) => {
    onDirectoryChange(pageId, relativePath);
  }, [onDirectoryChange, pageId]);

  if (!rootPath) {
    return <div className="flex h-full items-center justify-center p-8 text-center"><div><Folder size={42} className="mx-auto text-slate-300"/><h2 className="mt-4 text-xl font-bold text-slate-800">设置灵感库文件夹</h2><p className="mt-2 text-sm text-slate-500">首次使用灵感库，需要先选择用于收集和整理素材的文件夹。</p><button type="button" onClick={() => void chooseRoot()} disabled={choosingRoot} className="dialog-primary mt-5 disabled:opacity-50">{choosingRoot ? '正在选择…' : '选择灵感库文件夹'}</button></div></div>;
  }
  const project: WorkspaceProject = {
    id: `inspiration:${rootPath}`,
    name: INSPIRATION_PROJECT_NAME,
    path: rootPath,
    status: '未分类',
    updatedAt: Date.now(),
  };
  const installedComponentIds = new Set(components.filter(component => component.installed && component.enabled !== false).map(component => component.id));
  const videoToolsAvailable = componentCapabilityIsAvailable(components, 'media.video.processing');
  const advancedVideoPlaybackAvailable = componentCapabilityIsAvailable(components, 'media.video.playback.advanced');
  return <FileBrowserWorkspace
    pageId={pageId}
    active={active}
    activeView="project"
    browserContext={INSPIRATION_FILE_BROWSER_CONTEXT}
    initialRelativePath={initialRelativePath}
    navigationRequest={navigationRequest}
    onDirectoryChange={handleDirectoryChange}
    onOpenDirectoryPage={onOpenDirectoryPage}
    project={project}
    workspacePath={rootPath}
    componentWorkspacePath={config.workspacePath}
    inspirationTargetWorkspacePath={config.workspacePath}
    installedComponentIds={installedComponentIds}
    videoToolsAvailable={videoToolsAvailable}
    advancedVideoPlaybackAvailable={advancedVideoPlaybackAvailable}
    componentHostActions={componentHostActions}
    componentContributions={componentContributions}
    onOpenComponentPage={(action, scope) => onOpenComponentPage(action, project, config.workspacePath, { ...scope, contentKind: 'inspiration' })}
    videoPlaybackSettings={config.videoPlayback}
    initialPanel={null}
    importConfig={config.smartImport}
    importDefaults={config.importDefaults}
    brollConfig={config.brollImport}
    videoTools={config.videoTools}
    matchConfig={config.smartMatch}
    researchConfig={config.research}
    mediaCacheConfig={config.mediaCache}
    defaultFolderSort={config.defaultFolderSort}
    itemOpenMode={config.itemOpenMode}
    folderAlphabetFilterEnabled={config.folderAlphabetFilterEnabled}
    onImportConfigChange={smartImport => onUpdateConfig({ ...config, smartImport })}
    onMatchConfigChange={smartMatch => onUpdateConfig({ ...config, smartMatch })}
    onResearchConfigChange={research => onUpdateConfig({ ...config, research })}
    onNotice={onNotice}
  />;
};
