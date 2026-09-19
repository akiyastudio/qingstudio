import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { ProjectFileEntry, ProjectFileListFilter, ProjectFilterScope, WorkspaceProject } from '../../types';
import { projectWorkspaceClient } from '../../platform/project-workspace-client';
import { shouldRetainGroupedResultsDuringRefresh } from './project-workspace-layout-model';
import { useRecentFilesAutoLoad } from './useRecentFilesAutoLoad';
import { mergeProjectFileQueryEntries, projectFileQueryRequestIdentity } from './project-file-query-model';

const RECENT_FILES_PAGE_SIZE = 240;
const RECENT_FILES_LOAD_AHEAD_PX = 900;
const RECENT_FILES_SESSION_EXPIRED = 'RECENT_FILES_SESSION_EXPIRED';
const FILE_LIST_PAGE_SIZE = 200;
const FILE_LIST_SESSION_EXPIRED = 'FILE_LIST_SESSION_EXPIRED';
const FILE_LIST_CANCELLED = 'FILE_LIST_CANCELLED';

type QueryProject = Pick<WorkspaceProject, 'name' | 'status'>;

type ProjectFileQueriesOptions = {
  active: boolean;
  workspacePath: string;
  project: QueryProject;
  currentRelativePath: string;
  recursiveFlatOpen: boolean;
  currentFolderRecursiveSearchActive: boolean;
  versionTreeOpen: boolean;
  finalViewOpen: boolean;
  filterScope: ProjectFilterScope;
  searchQuery: string;
  fileFilter: 'all' | 'media' | 'image' | 'video';
  filesColumnRef: RefObject<HTMLDivElement | null>;
  selectionAnchorPathRef: { current: string };
  setSelectedPaths: Dispatch<SetStateAction<string[]>>;
  setFilterScope: Dispatch<SetStateAction<ProjectFilterScope>>;
};

export const useProjectFileQueries = ({
  active,
  workspacePath,
  project,
  currentRelativePath,
  recursiveFlatOpen,
  currentFolderRecursiveSearchActive,
  versionTreeOpen,
  finalViewOpen,
  filterScope,
  searchQuery,
  fileFilter,
  filesColumnRef,
  selectionAnchorPathRef,
  setSelectedPaths,
  setFilterScope,
}: ProjectFileQueriesOptions) => {
  const [searchEntries, setSearchEntries] = useState<ProjectFileEntry[]>([]);
  const searchEntriesRef = useRef<ProjectFileEntry[]>([]);
  searchEntriesRef.current = searchEntries;
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [recentCursor, setRecentCursor] = useState('');
  const recentCursorRef = useRef('');
  const [recentHasMore, setRecentHasMore] = useState(false);
  const [recentLoadingMore, setRecentLoadingMore] = useState(false);
  const [recentLoadError, setRecentLoadError] = useState('');
  const [recentRefreshToken, setRecentRefreshToken] = useState(0);
  const [scopeEntries, setScopeEntries] = useState<ProjectFileEntry[]>([]);
  const scopeEntriesRef = useRef<ProjectFileEntry[]>([]);
  scopeEntriesRef.current = scopeEntries;
  const [scopeCursor, setScopeCursor] = useState('');
  const [scopeHasMore, setScopeHasMore] = useState(false);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [scopeLoadingMore, setScopeLoadingMore] = useState(false);
  const [scopeError, setScopeError] = useState('');
  const [scopeRefreshToken, setScopeRefreshToken] = useState(0);
  const searchSequenceRef = useRef(0);
  const searchRequestIdentityRef = useRef('');
  const recentLoadInFlightRef = useRef(false);
  const scopeCursorRef = useRef('');
  const scopeLoadInFlightRef = useRef(false);
  const scopeRequestSequenceRef = useRef(0);
  const scopeRequestIdentityRef = useRef('');

  useEffect(() => {
    const query = searchQuery.trim();
    const requestIdentity = projectFileQueryRequestIdentity([active ? 'active' : 'inactive', recursiveFlatOpen ? 'all-files' : currentFolderRecursiveSearchActive ? 'folder-search' : 'closed', finalViewOpen ? 'final' : 'files', workspacePath, project.status, project.name, currentRelativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''), query]);
    const retainExistingEntries = shouldRetainGroupedResultsDuringRefresh(searchRequestIdentityRef.current, requestIdentity, searchEntriesRef.current.length);
    searchRequestIdentityRef.current = requestIdentity;
    searchSequenceRef.current += 1;
    const sequence = searchSequenceRef.current;
    const previousCursor = recentCursorRef.current;
    recentCursorRef.current = '';
    if (previousCursor) void projectWorkspaceClient.cancelRecentProjectFiles(previousCursor).catch(() => undefined);
    if (!active || !(recursiveFlatOpen || currentFolderRecursiveSearchActive) || finalViewOpen) {
      setSearchEntries([]); setSearchLoading(false); setSearchError(''); setRecentCursor(''); setRecentHasMore(false); setRecentLoadingMore(false); setRecentLoadError(''); recentLoadInFlightRef.current = false;
      return;
    }
    if (!retainExistingEntries) setSearchEntries([]);
    setSearchLoading(true); setSearchError(''); setRecentCursor(''); setRecentHasMore(false); setRecentLoadingMore(false); setRecentLoadError(''); recentLoadInFlightRef.current = false;
    const timer = window.setTimeout(() => {
      const request = query
        ? projectWorkspaceClient.searchProjectFiles(workspacePath, project.status, project.name, currentRelativePath, query)
        : projectWorkspaceClient.listRecentProjectFiles(workspacePath, project.status, project.name, currentRelativePath, RECENT_FILES_PAGE_SIZE);
      void request.then(result => {
        if (sequence !== searchSequenceRef.current || !active) {
          const stale = result as { success: boolean; cursor?: string };
          if (!query && stale.success && stale.cursor) void projectWorkspaceClient.cancelRecentProjectFiles(stale.cursor).catch(() => undefined);
          return;
        }
        if (result.success) {
          setSearchEntries(result.entries);
          const recent = result as { cursor?: string; hasMore?: boolean };
          const nextCursor = !query ? recent.cursor || '' : '';
          recentCursorRef.current = nextCursor;
          setRecentCursor(nextCursor);
          setRecentHasMore(!query && Boolean(recent.hasMore));
        } else {
          if (!retainExistingEntries) setSearchEntries([]);
          setRecentCursor(''); setRecentHasMore(false); setSearchError(result.error || '搜索失败');
        }
      }).catch(error => {
        if (sequence !== searchSequenceRef.current) return;
        if (!retainExistingEntries) setSearchEntries([]);
        setRecentHasMore(false); setSearchError(error instanceof Error ? error.message : '搜索失败');
      }).finally(() => { if (sequence === searchSequenceRef.current) setSearchLoading(false); });
    }, 220);
    return () => {
      window.clearTimeout(timer);
      if (sequence === searchSequenceRef.current) searchSequenceRef.current += 1;
      const cursor = recentCursorRef.current;
      recentCursorRef.current = '';
      if (cursor) void projectWorkspaceClient.cancelRecentProjectFiles(cursor).catch(() => undefined);
    };
  }, [active, searchQuery, recursiveFlatOpen, currentFolderRecursiveSearchActive, currentRelativePath, finalViewOpen, workspacePath, project.status, project.name, recentRefreshToken]);

  const loadMoreRecentFiles = useCallback(async () => {
    if (!active || !recursiveFlatOpen || searchQuery.trim() || finalViewOpen || !recentHasMore || !recentCursor || recentLoadInFlightRef.current) return;
    recentLoadInFlightRef.current = true; setRecentLoadingMore(true); setRecentLoadError('');
    const sequence = searchSequenceRef.current;
    try {
      let sessionWasRecreated = false;
      let result = await projectWorkspaceClient.listRecentProjectFiles(workspacePath, project.status, project.name, currentRelativePath, RECENT_FILES_PAGE_SIZE, recentCursor);
      if (sequence !== searchSequenceRef.current || !active) { if (result.success && result.cursor) void projectWorkspaceClient.cancelRecentProjectFiles(result.cursor).catch(() => undefined); return; }
      if (!result.success && result.errorCode === RECENT_FILES_SESSION_EXPIRED) {
        sessionWasRecreated = true;
        result = await projectWorkspaceClient.listRecentProjectFiles(workspacePath, project.status, project.name, currentRelativePath, RECENT_FILES_PAGE_SIZE);
        if (sequence !== searchSequenceRef.current || !active) { if (result.success && result.cursor) void projectWorkspaceClient.cancelRecentProjectFiles(result.cursor).catch(() => undefined); return; }
      }
      if (!result.success) { setRecentHasMore(false); setRecentLoadError(result.error || '继续读取所有文件失败'); return; }
      setSearchEntries(current => mergeProjectFileQueryEntries(current, result.entries, sessionWasRecreated));
      recentCursorRef.current = result.cursor || ''; setRecentCursor(result.cursor || ''); setRecentHasMore(Boolean(result.hasMore));
    } catch (error) {
      if (sequence === searchSequenceRef.current) { setRecentHasMore(false); setRecentLoadError(error instanceof Error ? error.message : '继续读取所有文件失败'); }
    } finally {
      if (sequence === searchSequenceRef.current) { recentLoadInFlightRef.current = false; setRecentLoadingMore(false); }
    }
  }, [active, currentRelativePath, finalViewOpen, project.name, project.status, recentCursor, recentHasMore, recursiveFlatOpen, searchQuery, workspacePath]);

  useRecentFilesAutoLoad(active, recursiveFlatOpen && !searchQuery.trim() && !finalViewOpen && recentHasMore, filesColumnRef, loadMoreRecentFiles, `${recentLoadingMore}:${searchEntries.length}`, RECENT_FILES_LOAD_AHEAD_PX);

  const projectRootFilterActive = filterScope === 'project-root' && !recursiveFlatOpen && !versionTreeOpen && !finalViewOpen;
  const scopeFileListFilter = useMemo<ProjectFileListFilter>(() => ({
    query: searchQuery,
    ...(fileFilter === 'video' ? { kinds: ['video'] } : fileFilter === 'image' ? { kinds: ['image', 'raw', 'file'] } : fileFilter === 'media' ? { kinds: ['image', 'raw', 'video', 'file'] } : {}),
  }), [fileFilter, searchQuery]);
  const replaceScopeCursor = useCallback((cursor: string) => { scopeCursorRef.current = cursor; setScopeCursor(cursor); }, []);
  const cancelScopeSession = useCallback(() => { const cursor = scopeCursorRef.current; replaceScopeCursor(''); if (cursor) void projectWorkspaceClient.cancelListProjectFiles(cursor).catch(() => undefined); }, [replaceScopeCursor]);
  const changeFilterScope = useCallback((scope: ProjectFilterScope) => {
    if (scope === filterScope) return;
    scopeRequestSequenceRef.current += 1; cancelScopeSession(); scopeLoadInFlightRef.current = false;
    setScopeEntries([]); setScopeHasMore(false); setScopeLoading(false); setScopeLoadingMore(false); setScopeError('');
    selectionAnchorPathRef.current = ''; setSelectedPaths([]); setFilterScope(scope);
  }, [cancelScopeSession, filterScope, selectionAnchorPathRef, setFilterScope, setSelectedPaths]);

  useEffect(() => {
    const requestIdentity = projectFileQueryRequestIdentity([active ? 'active' : 'inactive', projectRootFilterActive ? 'project-root' : 'closed', workspacePath, project.status, project.name, JSON.stringify(scopeFileListFilter)]);
    const retainExistingEntries = shouldRetainGroupedResultsDuringRefresh(scopeRequestIdentityRef.current, requestIdentity, scopeEntriesRef.current.length);
    scopeRequestIdentityRef.current = requestIdentity;
    scopeRequestSequenceRef.current += 1;
    const sequence = scopeRequestSequenceRef.current;
    cancelScopeSession(); scopeLoadInFlightRef.current = false;
    if (!retainExistingEntries) setScopeEntries([]);
    setScopeHasMore(false); setScopeLoadingMore(false); setScopeError('');
    if (!active || !projectRootFilterActive) { setScopeLoading(false); return; }
    setScopeLoading(true);
    void projectWorkspaceClient.listProjectFiles(workspacePath, project.status, project.name, '', FILE_LIST_PAGE_SIZE, undefined, scopeFileListFilter).then(result => {
      if (sequence !== scopeRequestSequenceRef.current) { if (result.cursor) void projectWorkspaceClient.cancelListProjectFiles(result.cursor).catch(() => undefined); return; }
      if (!result.success) { setScopeError(result.errorCode === FILE_LIST_CANCELLED ? '' : result.error || '读取项目文件失败'); return; }
      setScopeEntries(result.entries); replaceScopeCursor(result.cursor || ''); setScopeHasMore(Boolean(result.hasMore));
    }).catch(error => {
      if (sequence !== scopeRequestSequenceRef.current) return;
      setScopeHasMore(false); setScopeError(error instanceof Error ? error.message : '读取项目文件失败');
    }).finally(() => { if (sequence === scopeRequestSequenceRef.current) setScopeLoading(false); });
    return () => { scopeRequestSequenceRef.current += 1; cancelScopeSession(); };
  }, [active, cancelScopeSession, project.name, project.status, projectRootFilterActive, replaceScopeCursor, scopeFileListFilter, scopeRefreshToken, workspacePath]);

  const loadMoreScopeFiles = useCallback(async () => {
    if (!active || !projectRootFilterActive || !scopeHasMore || !scopeCursor || scopeLoadInFlightRef.current) return;
    scopeLoadInFlightRef.current = true; setScopeLoadingMore(true);
    const sequence = scopeRequestSequenceRef.current;
    try {
      const result = await projectWorkspaceClient.listProjectFiles(workspacePath, project.status, project.name, '', FILE_LIST_PAGE_SIZE, scopeCursor, scopeFileListFilter);
      if (sequence !== scopeRequestSequenceRef.current) { if (result.cursor) void projectWorkspaceClient.cancelListProjectFiles(result.cursor).catch(() => undefined); return; }
      if (!result.success) {
        replaceScopeCursor(''); setScopeHasMore(false);
        if (result.errorCode === FILE_LIST_SESSION_EXPIRED) setScopeRefreshToken(value => value + 1);
        else if (result.errorCode !== FILE_LIST_CANCELLED) setScopeError(result.error || '继续读取项目文件失败');
        return;
      }
      setScopeEntries(current => [...current, ...result.entries]); replaceScopeCursor(result.cursor || ''); setScopeHasMore(Boolean(result.hasMore));
    } catch (error) {
      if (sequence === scopeRequestSequenceRef.current) { replaceScopeCursor(''); setScopeHasMore(false); setScopeError(error instanceof Error ? error.message : '继续读取项目文件失败'); }
    } finally {
      if (sequence === scopeRequestSequenceRef.current) { scopeLoadInFlightRef.current = false; setScopeLoadingMore(false); }
    }
  }, [active, project.name, project.status, projectRootFilterActive, replaceScopeCursor, scopeCursor, scopeFileListFilter, scopeHasMore, workspacePath]);

  useEffect(() => {
    if (!projectRootFilterActive || !scopeHasMore) return;
    const container = filesColumnRef.current;
    if (!container) return;
    let frame = 0;
    const loadNearBottom = () => { window.cancelAnimationFrame(frame); frame = window.requestAnimationFrame(() => { if (container.scrollHeight - container.scrollTop - container.clientHeight <= RECENT_FILES_LOAD_AHEAD_PX) void loadMoreScopeFiles(); }); };
    loadNearBottom(); container.addEventListener('scroll', loadNearBottom, { passive: true });
    return () => { window.cancelAnimationFrame(frame); container.removeEventListener('scroll', loadNearBottom); };
  }, [loadMoreScopeFiles, projectRootFilterActive, scopeEntries.length, scopeHasMore, scopeLoadingMore, filesColumnRef]);

  return {
    searchEntries, searchEntriesRef, setSearchEntries, searchLoading, searchError,
    recentHasMore, recentLoadingMore, recentLoadError, setRecentRefreshToken,
    scopeEntries, setScopeEntries, scopeLoading, scopeLoadingMore, scopeError, scopeHasMore, setScopeRefreshToken,
    projectRootFilterActive, changeFilterScope,
  };
};
