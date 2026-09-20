import { LocalizedText } from "../i18n/LocalizedText";
import { localizedMessage } from "../i18n/messages";
import { getLocale } from "../i18n/runtime";
import { projectStatusLabel } from '../i18n/project-labels';
import { useLocale } from "../i18n/react";
import { t } from "../i18n/runtime";
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, Folder, FolderInput, FolderOpen, FolderPlus, HardDrive, Loader2, Plus, Search, X } from 'lucide-react';
import { normalizeProjectCategoryOrder, normalizeWorkspacePaths } from '../types';
import type { BackupStatus, ProjectDate, ProjectStatus, WorkspaceProject, WorkspaceStatusGroup } from '../types';
import { useAppDialog } from './AppDialogProvider';
import { useEscapeLayer } from './LayerProvider';
import { RECYCLE_BIN_FAILURE_DIALOG, isRecycleBinFailure } from '../utils/recycleBinFailure';
import { useTaskCenter } from '../features/background-tasks/TaskCenter';
import { getWorkspaceCatalog, readWorkspaceCatalogSnapshot, workspaceCatalogEventMatches } from '../platform/workspace-catalog-client';
import { useUserFacingToast } from '../features/app/useUserFacingToast';

type Action = 'import' | 'broll' | 'match';
type ExistingProjectDraft = {
  sourcePath: string;
  inspectionToken: string;
  name: string;
  fileCount: number;
  folderCount: number;
  totalBytes: number;
  truncated: boolean;
};
type ExistingProjectImportResult = {
  project: WorkspaceProject;
  sourceRetained: boolean;
};
const formatBytes = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
};
const cleanupCheckedWorkspaces = new Set<string>();
const localDateKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
const initialProjectDate = () => {
  const now = new Date();
  return { year: String(now.getFullYear()).slice(-2), month: String(now.getMonth() + 1), day: String(now.getDate()) };
};
const parseProjectDateText = (value: string) => {
  const matched = value.trim().match(/^(\d{2}|\d{4})\s*[-/.年]\s*(\d{1,2})(?:\s*[-/.月]\s*(\d{1,2})\s*日?)?$/);
  if (!matched) return null;
  const year = Number(matched[1]) < 100 ? Number(matched[1]) + 2000 : Number(matched[1]);
  const month = Number(matched[2]);
  const day = matched[3] ? Number(matched[3]) : undefined;
  if (year < 2000 || year > 2099 || month < 1 || month > 12) return null;
  if (day !== undefined) {
    const checked = new Date(year, month - 1, day);
    if (day < 1 || checked.getFullYear() !== year || checked.getMonth() !== month - 1 || checked.getDate() !== day) return null;
  }
  return { year: String(year).slice(-2), month: String(month), day: day === undefined ? '' : String(day) };
};
const formatProjectDateText = (value?: ProjectDate) => value
  ? `${String(value.year).slice(-2)}-${value.month}${value.precision === 'day' && value.day ? `-${value.day}` : ''}`
  : '';
const projectEditorValue = (project: WorkspaceProject) => {
  if (project.projectDate) {
    const dateText = formatProjectDateText(project.projectDate);
    return {
      year: String(project.projectDate.year).slice(-2),
      month: String(project.projectDate.month),
      day: project.projectDate.precision === 'day' && project.projectDate.day ? String(project.projectDate.day) : '',
      quickDate: dateText,
      name: project.name.startsWith(`${dateText} `) ? project.name.slice(dateText.length + 1) : project.name === dateText ? '' : project.name,
    };
  }

  const currentFormat = project.name.match(/^((?:\d{2}|\d{4})[-/.]\d{1,2}(?:[-/.]\d{1,2})?)(?:\s+(.+))?$/);
  const parsedCurrent = currentFormat ? parseProjectDateText(currentFormat[1]) : null;
  if (parsedCurrent) return { ...parsedCurrent, quickDate: currentFormat![1], name: currentFormat![2] || '' };

  // Older projects used M-D or M-D-name. Supply the current year when opening
  // the editor; for example, "9-12-2" becomes date YY-9-12 plus name "2".
  const legacyMonthDay = project.name.match(/^(\d{1,2})[-/.](\d{1,2})(?:[-\s]+(.+))?$/);
  if (legacyMonthDay) {
    const now = new Date();
    const month = Number(legacyMonthDay[1]);
    const day = Number(legacyMonthDay[2]);
    const checked = new Date(now.getFullYear(), month - 1, day);
    if (checked.getFullYear() === now.getFullYear() && checked.getMonth() === month - 1 && checked.getDate() === day) {
      const year = String(now.getFullYear()).slice(-2);
      return { year, month: String(month), day: String(day), quickDate: `${year}-${month}-${day}`, name: legacyMonthDay[3] || '' };
    }
  }

  return { year: '', month: '', day: '', quickDate: '', name: project.name };
};

export const ProjectNavigator = ({ workspacePath, workspacePaths, backupEnabled, backupStatus, autoCleanupDeletedProjectData, createPlanningFolder, customProjectCategories, projectCategoryOrder, selectedProject, onSelectProject, onProjectDeleted, onWorkspacesResolved, onOpenBackup }: {
  workspacePath: string;
  workspacePaths: string[];
  backupEnabled: boolean;
  backupStatus: BackupStatus;
  autoCleanupDeletedProjectData: boolean;
  createPlanningFolder: boolean;
  customProjectCategories: string[];
  projectCategoryOrder: string[];
  selectedProject: WorkspaceProject | null;
  onSelectProject: (project: WorkspaceProject, replacePath?: string) => void;
  onProjectAction: (action: Action, project: WorkspaceProject) => void;
  onProjectDeleted: (project: WorkspaceProject) => void;
  onWorkspacesResolved: (workspacePaths: string[]) => void;
  onOpenBackup: (project?: WorkspaceProject) => void;
}) => {
  useLocale();
  const appDialog = useAppDialog();
  const { backgroundTasks } = useTaskCenter();
  const [groups, setGroups] = useState<WorkspaceStatusGroup[]>([]);
  const configuredWorkspacePaths = useMemo(() => normalizeWorkspacePaths(workspacePath, workspacePaths), [workspacePath, workspacePaths]);
  const configuredWorkspacePathsRef = useRef(configuredWorkspacePaths);
  configuredWorkspacePathsRef.current = configuredWorkspacePaths;
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const refreshQueuedRef = useRef(false);
  const refreshQueuedFreshRef = useRef(false);
  const refreshQueuedCachedOnlyRef = useRef(true);
  const refreshGenerationRef = useRef(0);
  const inspectionGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const statuses = useMemo<ProjectStatus[]>(() => {
    const ordered = ['未分类', ...normalizeProjectCategoryOrder(projectCategoryOrder, customProjectCategories), ...groups.map(group => group.status)];
    const seen = new Set<string>();
    return ordered.filter(status => { const key = status.toLocaleLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  }, [customProjectCategories, groups, projectCategoryOrder]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ 未分类: true, 策划中: true, 待拍摄: true, 后期中: true, 已归档: true });
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('photoflow:sidebar-expanded');
      if (saved) setExpanded(current => ({ ...current, ...JSON.parse(saved) }));
    } catch {
      try { window.localStorage.removeItem('photoflow:sidebar-expanded'); } catch { /* unavailable storage */ }
    }
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem('photoflow:sidebar-expanded', JSON.stringify(expanded)); } catch { /* unavailable storage */ }
  }, [expanded]);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState<{ project: WorkspaceProject; x: number; y: number } | null>(null);
  const [draggedProject, setDraggedProject] = useState<WorkspaceProject | null>(null);
  const [pendingProjectAction, setPendingProjectAction] = useState<{ path: string; kind: 'move' | 'delete'; project: WorkspaceProject; targetStatus?: ProjectStatus } | null>(null);
  const pendingProjectActionRef = useRef(pendingProjectAction);
  pendingProjectActionRef.current = pendingProjectAction;
  const [dragTargetStatus, setDragTargetStatus] = useState<ProjectStatus | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [projectSearchQuery, setProjectSearchQuery] = useState('');
  const [showExistingProjectImport, setShowExistingProjectImport] = useState(false);
  const [existingProjectDragActive, setExistingProjectDragActive] = useState(false);
  const [choosingExistingProject, setChoosingExistingProject] = useState(false);
  const [existingProjectDraft, setExistingProjectDraft] = useState<ExistingProjectDraft | null>(null);
  const [existingProjectName, setExistingProjectName] = useState('');
  const [existingProjectMode, setExistingProjectMode] = useState<'copy' | 'move' | 'reference'>('copy');
  const [existingProjectError, setExistingProjectError] = useState('');
  const [isImportingExistingProject, setIsImportingExistingProject] = useState(false);
  const [isCancellingExistingProject, setIsCancellingExistingProject] = useState(false);
  const [existingProjectImportOperationId, setExistingProjectImportOperationId] = useState('');
  const [existingProjectResult, setExistingProjectResult] = useState<ExistingProjectImportResult | null>(null);
  const existingProjectImportTask = useMemo(() => existingProjectImportOperationId
    ? backgroundTasks.find(task => task.id === existingProjectImportOperationId
      && task.type === 'project-file-operation'
      && task.metadata?.operation === 'import-project'
      && (task.state === 'queued' || task.state === 'running'))
    : undefined, [backgroundTasks, existingProjectImportOperationId]);
  const initialDate = initialProjectDate();
  const [editor, setEditor] = useState({ year: initialDate.year, month: initialDate.month, day: initialDate.day, quickDate: `${initialDate.year}-${initialDate.month}-${initialDate.day}`, name: '' });
  const { year, month, day, quickDate, name } = editor;
  const setYear = (value: string) => setEditor(current => ({ ...current, year: value }));
  const setMonth = (value: string) => setEditor(current => ({ ...current, month: value }));
  const setDay = (value: string) => setEditor(current => ({ ...current, day: value }));
  const setName = (value: string) => setEditor(current => ({ ...current, name: value }));
  const [renameProject, setRenameProject] = useState<WorkspaceProject | null>(null);
  const [newProjectError, setNewProjectError] = useState('');
  const toast = useUserFacingToast();
  const [isCreating, setIsCreating] = useState(false);
  const resetProjectDate = () => {
    const value = initialProjectDate();
    setEditor(current => ({ ...current, year: value.year, month: value.month, day: value.day, quickDate: `${value.year}-${value.month}-${value.day}` }));
  };
  const openNewProject = () => {
    setShowCreateMenu(false);
    resetProjectDate();
    setName('');
    setNewProjectError('');
    setShowNew(true);
  };
  const chooseExistingProject = async () => {
    const generation = ++inspectionGenerationRef.current;
    setChoosingExistingProject(true);
    setExistingProjectError('');
    setExistingProjectResult(null);
    try {
      const result = await window.electronAPI.chooseExistingProject();
      if (generation !== inspectionGenerationRef.current) return;
      if (result.cancelled) return;
      if (!result.success || !result.sourcePath || !result.name) {
        toast.show(result.error || '无法读取已有项目', { tone: 'error', dedupeKey: 'project-import-inspection' });
        return;
      }
      const draft: ExistingProjectDraft = {
        sourcePath: result.sourcePath,
        inspectionToken: result.inspectionToken || '',
        name: result.name,
        fileCount: result.fileCount || 0,
        folderCount: result.folderCount || 0,
        totalBytes: result.totalBytes || 0,
        truncated: Boolean(result.truncated),
      };
      setExistingProjectDraft(draft);
      setExistingProjectName(draft.name);
      setExistingProjectMode('copy');
    } finally {
      if (generation === inspectionGenerationRef.current) setChoosingExistingProject(false);
    }
  };
  const openExistingProjectImport = () => {
    inspectionGenerationRef.current += 1;
    setShowCreateMenu(false);
    setExistingProjectDraft(null);
    setExistingProjectResult(null);
    setExistingProjectError('');
    setShowExistingProjectImport(true);
  };
  const inspectDroppedExistingProject = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setExistingProjectDragActive(false);
    const file = Array.from(event.dataTransfer.files)[0];
    if (!file) return;
    let sourcePath = '';
    try { sourcePath = window.electronAPI.getPathForFile(file); } catch { /* handled below */ }
    if (!sourcePath) { setExistingProjectError('无法读取拖入文件夹的系统路径'); return; }
    const generation = ++inspectionGenerationRef.current;
    setChoosingExistingProject(true);
    setExistingProjectError('');
    try {
      const result = await window.electronAPI.inspectExistingProject(sourcePath);
      if (generation !== inspectionGenerationRef.current) return;
      if (!result.success || !result.sourcePath || !result.name) { setExistingProjectError(result.error || '无法读取项目文件夹'); return; }
      const draft: ExistingProjectDraft = { sourcePath: result.sourcePath, inspectionToken: result.inspectionToken || '', name: result.name, fileCount: result.fileCount || 0, folderCount: result.folderCount || 0, totalBytes: result.totalBytes || 0, truncated: Boolean(result.truncated) };
      setExistingProjectDraft(draft);
      setExistingProjectName(draft.name);
      setExistingProjectMode('copy');
    } finally { if (generation === inspectionGenerationRef.current) setChoosingExistingProject(false); }
  };
  const cancelExistingProjectImport = async () => {
    if (!existingProjectImportTask?.cancellable || isCancellingExistingProject) return;
    setIsCancellingExistingProject(true);
    setExistingProjectError('');
    const result = await window.electronAPI.cancelBackgroundTask(existingProjectImportTask.id);
    if (!result.success) {
      setIsCancellingExistingProject(false);
      setExistingProjectError('无法取消导入，请重试。');
    }
  };
  const closeExistingProjectImport = () => {
    if (isImportingExistingProject) {
      void cancelExistingProjectImport();
      return;
    }
    inspectionGenerationRef.current += 1;
    if (existingProjectResult) onSelectProject({ ...existingProjectResult.project, workspacePath: existingProjectResult.project.workspacePath || workspacePath });
    setExistingProjectDraft(null);
    setExistingProjectResult(null);
    setExistingProjectError('');
    setExistingProjectImportOperationId('');
    setShowExistingProjectImport(false);
  };
  const importExistingProject = async (mode: 'copy' | 'move' | 'reference') => {
    if (!existingProjectDraft || !existingProjectName.trim() || isImportingExistingProject) return;
    setExistingProjectError('');
    setExistingProjectMode(mode);
    setIsImportingExistingProject(true);
    setIsCancellingExistingProject(false);
    const operationId = crypto.randomUUID();
    setExistingProjectImportOperationId(operationId);
    try {
      const importOptions = {
        name: existingProjectName.trim(),
        operationId,
        inspectionToken: existingProjectDraft.inspectionToken,
        workspacePaths: configuredWorkspacePaths,
      };
      const result = await window.electronAPI.importExistingProject(workspacePath, existingProjectDraft.sourcePath, { ...importOptions, mode });
      if (result.cancelled) {
        setExistingProjectDraft(null);
        return;
      }
      if (!result.success || !result.project) {
        setExistingProjectError(result.error || '导入已有项目失败');
        return;
      }
      setExpanded(current => ({ ...current, 策划中: true }));
      await refresh();
      setExistingProjectResult({ project: result.project, sourceRetained: Boolean(result.sourceRetained) });
    } catch (importError) {
      setExistingProjectError(importError instanceof Error ? importError.message : '导入已有项目失败');
    } finally {
      setIsImportingExistingProject(false);
      setIsCancellingExistingProject(false);
      setExistingProjectImportOperationId('');
    }
  };
  const openRenameProject = (project: WorkspaceProject) => {
    setEditor(projectEditorValue(project));
    setNewProjectError('');
    setRenameProject(project);
  };
  const closeProjectEditor = () => {
    setShowNew(false);
    setRenameProject(null);
    setNewProjectError('');
  };
  const applyQuickDate = (value: string) => {
    const parsed = parseProjectDateText(value);
    setEditor(current => parsed
      ? { ...current, quickDate: value, year: parsed.year, month: parsed.month, day: parsed.day }
      : { ...current, quickDate: value });
  };
  const projectDate = (): ProjectDate | null => {
    if (!year.trim() && !month.trim() && !day.trim()) return null;
    if (!year.trim() || !month.trim()) throw new Error('项目日期至少需要填写年份和月份');
    const normalizedYear = Number(year) < 100 ? Number(year) + 2000 : Number(year);
    return { year: normalizedYear, month: Number(month), ...(day.trim() ? { day: Number(day) } : {}), precision: day.trim() ? 'day' : 'month' };
  };
  const formattedDate = year.trim() && month.trim() ? `${String(year).trim().slice(-2)}-${Number(month)}${day.trim() ? `-${Number(day)}` : ''}` : '';
  const nextProjectDisplayName = [formattedDate, name.trim()].filter(Boolean).join(' ');

  const refreshOnce = async (fresh = false, cachedOnly = false) => {
    const requestedWorkspacePaths = configuredWorkspacePathsRef.current;
    const requestKey = requestedWorkspacePaths.join('\0').toLocaleLowerCase();
    const generation = ++refreshGenerationRef.current;
    if (!requestedWorkspacePaths.length) {
      setGroups([]);
      setError('');
      return;
    }
    let results: Array<{ requestedPath: string; result: Awaited<ReturnType<typeof window.electronAPI.getWorkspaceProjects>> }>;
    try {
      results = await Promise.all(requestedWorkspacePaths.map(async requestedPath => ({
        requestedPath,
        result: cachedOnly ? readWorkspaceCatalogSnapshot(requestedPath) || await getWorkspaceCatalog(requestedPath) : await getWorkspaceCatalog(requestedPath, { fresh }),
      })));
    } catch (refreshError) {
      if (mountedRef.current && generation === refreshGenerationRef.current) {
        setError(refreshError instanceof Error ? refreshError.message : '无法刷新项目目录');
      }
      return;
    }
    if (!mountedRef.current || generation !== refreshGenerationRef.current
        || requestKey !== configuredWorkspacePathsRef.current.join('\0').toLocaleLowerCase()) return;
    const merged = new Map<ProjectStatus, WorkspaceProject[]>();
    for (const { requestedPath, result } of results) {
      if (!result.success) continue;
      const resolvedRoot = result.root || requestedPath;
      for (const group of result.statuses) {
        const projects = merged.get(group.status) || [];
        projects.push(...group.projects.map(project => ({ ...project, workspacePath: resolvedRoot })));
        merged.set(group.status, projects);
      }
    }
    setGroups([...merged].map(([status, projects]) => ({ status, projects })));
    const resolvedWorkspacePaths = normalizeWorkspacePaths(results[0]?.result.root || requestedWorkspacePaths[0], results.map(({ requestedPath, result }) => result.success && result.root ? result.root : requestedPath));
    if (resolvedWorkspacePaths.join('\0').toLocaleLowerCase() !== requestKey) onWorkspacesResolved(resolvedWorkspacePaths);
    const failures = results.filter(({ result }) => !result.success);
    setError(failures.length ? `${failures.length} 个工作目录暂时无法读取，其余项目仍可使用` : '');
  };

  const refresh = async (fresh = false, cachedOnly = false) => {
    if (refreshInFlightRef.current) {
      if (!refreshQueuedRef.current) {
        refreshQueuedFreshRef.current = fresh;
        refreshQueuedCachedOnlyRef.current = cachedOnly;
      } else {
        refreshQueuedFreshRef.current ||= fresh;
        refreshQueuedCachedOnlyRef.current &&= cachedOnly;
      }
      refreshQueuedRef.current = true;
      return refreshInFlightRef.current;
    }
    const operation = (async () => {
      let nextFresh = fresh;
      let nextCachedOnly = cachedOnly;
      do {
        refreshQueuedRef.current = false;
        refreshQueuedFreshRef.current = false;
        refreshQueuedCachedOnlyRef.current = true;
        await refreshOnce(nextFresh, nextCachedOnly);
        nextFresh = refreshQueuedFreshRef.current;
        nextCachedOnly = refreshQueuedCachedOnlyRef.current;
      } while (refreshQueuedRef.current && mountedRef.current);
    })().finally(() => {
      refreshInFlightRef.current = null;
    });
    refreshInFlightRef.current = operation;
    return operation;
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshQueuedRef.current = false;
      refreshQueuedFreshRef.current = false;
      refreshQueuedCachedOnlyRef.current = true;
      refreshGenerationRef.current += 1;
      inspectionGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => { void refresh(); }, [configuredWorkspacePaths]);
  useEffect(() => {
    if (!autoCleanupDeletedProjectData || !configuredWorkspacePaths.length) return;
    let disposed = false;
    const timer = window.setTimeout(() => {
      for (const currentWorkspacePath of configuredWorkspacePaths) {
        const key = currentWorkspacePath.toLocaleLowerCase();
        if (cleanupCheckedWorkspaces.has(key)) continue;
        cleanupCheckedWorkspaces.add(key);
        const storageKey = `photoflow:maintenance:deleted-project-cleanup:${key}`;
        const today = localDateKey();
        try { if (window.localStorage.getItem(storageKey) === today) continue; } catch { /* unavailable storage */ }
        void window.electronAPI.cleanupDeletedWorkspaceProjects(currentWorkspacePath).then(result => {
          if (!result.success) { cleanupCheckedWorkspaces.delete(key); return; }
          try { window.localStorage.setItem(storageKey, today); } catch { /* unavailable storage */ }
          if (!disposed && result.cleanedCount > 0) void refresh(true);
        }).catch(() => { cleanupCheckedWorkspaces.delete(key); });
      }
    }, 15000);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [configuredWorkspacePaths, autoCleanupDeletedProjectData]);
  useEffect(() => {
    const close = () => { setMenu(null); setShowCreateMenu(false); };
    let refreshTimer = 0;
    const changed = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void refresh(true), 250);
    };
    const snapshotChanged = (event: Event) => {
      if (!configuredWorkspacePaths.some(currentPath => workspaceCatalogEventMatches(event, currentPath))) return;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void refresh(false, true), 0);
    };
    const unsubscribe = window.electronAPI.onWorkspaceProjectsChanged(changed);
    window.addEventListener('click', close);
    window.addEventListener('photoflow-menu-open', close);
    window.addEventListener('workspace-projects-changed', changed);
    window.addEventListener('workspace-catalog-snapshot-changed', snapshotChanged);
    return () => { window.clearTimeout(refreshTimer); unsubscribe(); window.removeEventListener('click', close); window.removeEventListener('photoflow-menu-open', close); window.removeEventListener('workspace-projects-changed', changed); window.removeEventListener('workspace-catalog-snapshot-changed', snapshotChanged); };
  }, [configuredWorkspacePaths]);
  useEffect(() => {
    const hasOfflineArchive = groups.some(group => group.projects.some(project => project.archived && project.availability === 'missing'));
    if (!hasOfflineArchive) return;
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(timer);
  }, [groups, configuredWorkspacePaths]);
  useEffect(() => {
    if (configuredWorkspacePaths.length < 2) return;
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(timer);
  }, [configuredWorkspacePaths]);

  const workspaceFor = (project?: WorkspaceProject | null) => project?.workspacePath || workspacePath;

  const createProject = async () => {
    setNewProjectError('');
    setIsCreating(true);
    try {
      const result = await window.electronAPI.createWorkspaceProject(workspacePath, projectDate(), name, { createPlanningFolder, workspacePaths: configuredWorkspacePaths });
      if (!result.success || !result.project) {
        setNewProjectError(result.error || '新建项目失败');
        return;
      }
      const createdName = result.project.name;
      setShowNew(false);
      resetProjectDate();
      setName('');
      setExpanded(current => ({ ...current, 策划中: true }));
      onSelectProject({ ...result.project, workspacePath: result.project.workspacePath || workspacePath });
      refresh();
      toast.show(`项目“${createdName}”已创建成功`, { tone: 'success', dedupeKey: 'project-created' });
    } catch (createError) {
      setNewProjectError(createError instanceof Error ? createError.message : '新建项目失败');
    } finally {
      setIsCreating(false);
    }
  };
  const rename = async () => {
    if (!renameProject) return;
    setNewProjectError('');
    setIsCreating(true);
    try {
      const projectWorkspacePath = workspaceFor(renameProject);
      const result = await window.electronAPI.renameWorkspaceProject(projectWorkspacePath, renameProject.status, renameProject.name, projectDate(), name);
      if (!result.success || !result.project) {
        setNewProjectError(result.error || '重命名失败');
        return;
      }
      onSelectProject({ ...result.project, workspacePath: projectWorkspacePath }, renameProject.path);
      closeProjectEditor();
      refresh();
    } catch (renameError) {
      setNewProjectError(renameError instanceof Error ? renameError.message : '重命名失败');
    } finally {
      setIsCreating(false);
    }
  };
  const move = async (project: WorkspaceProject, status: ProjectStatus) => {
    if (status === project.status) return;
    if (pendingProjectActionRef.current) { setError('另一个项目操作正在处理中'); return; }
    const projectWorkspacePath = workspaceFor(project);
    if (project.archived && status !== '已归档') {
      await moveBack(project, status);
      return;
    }
    if (status === '已归档' && !project.archived) {
      const archive = await window.electronAPI.getArchiveStatus();
      if (archive.enabled) {
        const choice = await appDialog.choice({
          title: localizedMessage("ui.how.would.you.like.to.archive.860ddd"),
          message: archive.state === 'connected' ? '可只更改状态，也可验证后移至归档盘。归档不等于备份。' : '归档盘离线，目前只能更改状态。',
          choices: [
            ...(archive.state === 'connected' ? [{ value: 'move', label: localizedMessage("ui.move.to.archive.drive.756e55") }] : []),
            { value: 'status', label: localizedMessage("ui.change.status.only.219d8f") },
          ],
          defaultValue: archive.state === 'connected' ? 'move' : 'status',
        });
        if (!choice) return;
        if (choice === 'move') {
          const result = await window.electronAPI.archiveWorkspaceProject(projectWorkspacePath, project.name);
          if (!result.success) toast.show(result.error || '无法开始归档', { tone: 'error', dedupeKey: `project-archive:${project.id}` });
          return;
        }
      }
    }
    const pendingAction = { path: project.path, kind: 'move' as const, project, targetStatus: status };
    pendingProjectActionRef.current = pendingAction;
    setPendingProjectAction(pendingAction);
    try {
      const result = await window.electronAPI.moveWorkspaceProject(projectWorkspacePath, project.status, project.name, status);
      if (!result.success) { pendingProjectActionRef.current = null; setPendingProjectAction(null); setError(result.error || '更改状态失败'); }
      else if (result.project) onSelectProject({ ...result.project, workspacePath: projectWorkspacePath }, project.path);
      setExpanded(current => ({ ...current, [status]: true }));
      await refresh();
    } catch (moveError) {
      pendingProjectActionRef.current = null;
      setPendingProjectAction(null);
      setError(moveError instanceof Error ? moveError.message : '更改状态失败');
      await refresh();
    } finally {
      pendingProjectActionRef.current = null;
      setPendingProjectAction(null);
    }
  };
  const dragProjectOverStatus = (event: React.DragEvent, status: ProjectStatus) => {
    if (!draggedProject || draggedProject.status === status) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    if (dragTargetStatus !== status) setDragTargetStatus(status);
  };
  const leaveProjectStatus = (event: React.DragEvent<HTMLElement>, status: ProjectStatus) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    if (dragTargetStatus === status) setDragTargetStatus(null);
  };
  const dropProjectOnStatus = (event: React.DragEvent, status: ProjectStatus) => {
    if (!draggedProject || draggedProject.status === status) return;
    event.preventDefault();
    event.stopPropagation();
    const project = draggedProject;
    setDraggedProject(null);
    setDragTargetStatus(null);
    void move(project, status);
  };
  const moveBack = async (project: WorkspaceProject, statusAfter: Exclude<ProjectStatus, '已归档'> = '后期中') => {
    if (!await appDialog.confirm({ title: localizedMessage("ui.move.value0.back.to.the.workspace.58d271", { value0: project.name }), message: localizedMessage("ui.move.the.project.from.the.archive.791f7e", { value0: projectStatusLabel(statusAfter) }), confirmLabel: localizedMessage("ui.move.back.to.workspace.drive.d6cc91") })) return;
    const result = await window.electronAPI.moveArchivedProjectBack(workspaceFor(project), project.name, statusAfter);
    if (!result.success) toast.show(result.error || '无法移回项目', { tone: 'error', dedupeKey: `project-unarchive:${project.id}` });
  };
  const trash = async (project: WorkspaceProject) => {
    if (pendingProjectActionRef.current) { setError('另一个项目操作正在处理中'); return; }
    if (!await appDialog.confirm({
      title: localizedMessage("ui.delete.this.project.8bbed1"),
      message: localizedMessage("message.70be90ecc5dc", { value0: project.name }),
      confirmLabel: localizedMessage("ui.delete.project.f6dc6a"),
      tone: 'danger',
    })) return;
    const pendingAction = { path: project.path, kind: 'delete' as const, project };
    pendingProjectActionRef.current = pendingAction;
    setPendingProjectAction(pendingAction);
    try {
      const result = await window.electronAPI.trashWorkspaceProject(workspaceFor(project), project.status, project.name);
      if (!result.success) {
        pendingProjectActionRef.current = null;
        setPendingProjectAction(null);
        if (isRecycleBinFailure(result.error, result.errorCode)) await appDialog.alert(RECYCLE_BIN_FAILURE_DIALOG);
        else setError(result.error || '删除项目失败');
      } else if (result.permanent) {
        toast.show(`项目“${project.name}”已按 Windows 确认永久删除`, { tone: 'success', dedupeKey: `project-deleted:${project.id}` });
      }
      if (result.success) onProjectDeleted(project);
      await refresh();
    } catch (trashError) {
      pendingProjectActionRef.current = null;
      setPendingProjectAction(null);
      setError(trashError instanceof Error ? trashError.message : '删除项目失败');
      await refresh();
    } finally {
      pendingProjectActionRef.current = null;
      setPendingProjectAction(null);
    }
  };
  const openProject = async (project: WorkspaceProject) => {
    if (project.availability === 'missing') {
      setError('项目文件夹不可用，记录已保留；恢复后会自动重新连接。');
      return;
    }
    const result = await window.electronAPI.openWorkspaceProject(workspaceFor(project), project.status, project.name);
    if (!result.success) setError(result.error || '无法打开文件夹');
  };
  const presentedGroups = useMemo(() => {
    if (!pendingProjectAction) return groups;
    const withoutPendingProject = groups.map(group => ({ ...group, projects: group.projects.filter(project => project.path !== pendingProjectAction.path) }));
    if (pendingProjectAction.kind === 'delete' || !pendingProjectAction.targetStatus) return withoutPendingProject;
    return withoutPendingProject.map(group => group.status === pendingProjectAction.targetStatus
      ? { ...group, projects: [...group.projects, { ...pendingProjectAction.project, status: pendingProjectAction.targetStatus! }] }
      : group);
  }, [groups, pendingProjectAction]);
  const normalizedProjectSearchQuery = projectSearchQuery.trim().toLocaleLowerCase();
  const projectMatchesSearch = (project: WorkspaceProject) => !normalizedProjectSearchQuery
    || project.name.toLocaleLowerCase().includes(normalizedProjectSearchQuery);
  const visibleStatuses = statuses.filter(status => {
    const projects = presentedGroups.find(group => group.status === status)?.projects || [];
    if (normalizedProjectSearchQuery) return projects.some(projectMatchesSearch);
    return status !== '未分类' || projects.length > 0;
  });
  return <>
    <div className="relative px-3 pt-2" onClick={event => event.stopPropagation()}>
      <div className="flex w-full items-center gap-1.5">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{t("ui.search.by.project.name.ed9e53")}</span>
          <Search aria-hidden="true" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"/>
          <input type="search" value={projectSearchQuery} onChange={event => setProjectSearchQuery(event.target.value)} onFocus={() => setShowCreateMenu(false)} placeholder={t("ui.search.projects.dfb59e")} aria-label={t("ui.search.by.project.name.ed9e53")} autoComplete="off" className="h-8 w-full rounded-md border border-slate-200 bg-slate-50 pl-8 pr-2.5 text-xs text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-500/15"/>
        </label>
        <button type="button" disabled={choosingExistingProject} aria-haspopup="menu" aria-expanded={showCreateMenu} aria-label={t("ui.add.project.8964f5")} title={t("ui.add.project.8964f5")} onClick={() => setShowCreateMenu(current => !current)} className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-transparent transition disabled:opacity-60 ${showCreateMenu ? 'text-blue-600' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'}`}>{choosingExistingProject ? <Loader2 size={15} className="animate-spin"/> : <Plus size={17}/>}</button>
      </div>
      {showCreateMenu && <div role="menu" className="project-create-menu absolute right-3 top-full z-[250] mt-1 w-40 rounded-lg border border-slate-200 bg-white p-1 shadow-xl"><button role="menuitem" type="button" onClick={openNewProject} className="project-menu-item"><FolderPlus size={15}/>{t("ui.new.project.0e1a70")}</button><button role="menuitem" type="button" onClick={openExistingProjectImport} className="project-menu-item"><FolderInput size={15}/>{t("ui.import.project.579cd7")}</button></div>}
    </div>
    <nav className="project-navigator-scroll flex-1 overflow-y-auto p-4 pt-2">
      {visibleStatuses.map(status => {
        const projects = (presentedGroups.find(group => group.status === status)?.projects || []).filter(projectMatchesSearch).slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
        const isOpen = normalizedProjectSearchQuery ? true : expanded[status];
        return <section key={status} onDragEnter={event => dragProjectOverStatus(event, status)} onDragOver={event => dragProjectOverStatus(event, status)} onDragLeave={event => leaveProjectStatus(event, status)} onDrop={event => dropProjectOnStatus(event, status)} className={`border-t py-2 first:border-t-0 transition ${dragTargetStatus === status ? 'rounded-lg border-blue-400 bg-blue-50 ring-2 ring-inset ring-blue-400' : 'border-slate-200'}`}>
          <button type="button" aria-expanded={isOpen} onClick={() => { if (!normalizedProjectSearchQuery) setExpanded(current => ({ ...current, [status]: !current[status] })); }} className={`flex w-full items-center gap-1.5 rounded-md px-2 py-2 text-left text-xs font-bold tracking-wide text-slate-500 ${normalizedProjectSearchQuery ? 'cursor-default' : 'hover:bg-slate-100 hover:text-slate-800'}`}>{isOpen ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}<span>{projectStatusLabel(status)}</span><span className="ml-auto font-mono text-[10px] text-slate-400">{projects.length}</span></button>
          {isOpen && <div className="mt-1 space-y-1">{projects.map(project => { const unavailable = project.availability === 'missing'; return <div key={project.path} onContextMenu={event => { event.preventDefault(); window.dispatchEvent(new Event('photoflow-menu-open')); setMenu({ project, x: event.clientX, y: event.clientY }); }} className={`project-row group flex items-center gap-1 rounded-lg text-sm transition ${draggedProject?.path === project.path ? 'opacity-50' : ''} ${unavailable ? 'bg-amber-50 text-amber-700' : selectedProject?.path === project.path ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}><button draggable={!unavailable} onDragStart={event => { setDraggedProject(project); event.dataTransfer.effectAllowed = 'copyMove'; event.dataTransfer.setData('application/x-photoflow-folder-tab', JSON.stringify({ kind: 'project', project })); event.dataTransfer.setData('application/x-photoflow-project', project.path); event.dataTransfer.setData('text/plain', project.name); window.dispatchEvent(new Event('photoflow:folder-tab-drag-start')); }} onDragEnd={() => { setDraggedProject(null); setDragTargetStatus(null); window.dispatchEvent(new Event('photoflow:folder-tab-drag-end')); }} title={unavailable ? `${project.name}（${project.archived ? t("ui.archive.drive.disconnected.996a7c") : t("ui.folder.unavailable.data.has.been.kept.71b365")}）` : t("ui.value0.drag.to.another.category.to.493fa3", { value0: project.name })} disabled={unavailable} onClick={() => onSelectProject(project)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left disabled:cursor-not-allowed"><Folder size={15} className="shrink-0"/><span className="min-w-0 flex-1 truncate">{project.name}</span>{project.archived && !unavailable && <HardDrive size={13} className="shrink-0 opacity-60"/>}{unavailable && <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">{project.archived ? t("ui.archive.drive.offline.ffb9f3") : t("ui.offline.be1b4f")}</span>}</button><button type="button" aria-label={t("ui.open.project.folder.01e11d")} title={unavailable ? t("ui.project.folder.unavailable.f1b416") : t("ui.open.project.folder.01e11d")} disabled={unavailable} onClick={() => openProject(project)} className="project-open-button mr-1 rounded p-1.5 disabled:cursor-not-allowed disabled:opacity-40"><FolderOpen size={15}/></button></div>; })}{!projects.length && <p className="px-7 py-1 text-xs text-slate-400">{t("ui.no.projects.455044")}</p>}</div>}
        </section>;
      })}
      {normalizedProjectSearchQuery && !visibleStatuses.length && <p className="px-2 py-8 text-center text-xs text-slate-400">{t("ui.no.matching.projects.0529b9")}</p>}
      {error && <p className="mt-2 px-2 text-xs text-red-500"><LocalizedText value={error}/></p>}
    </nav>
    {menu && (backupEnabled || menu.project.availability !== 'missing' || menu.project.archived) && (() => { const hasProjectBackup = backupStatus.snapshots.some(snapshot => snapshot.projectItems?.some(project => project.name === menu.project.name)); return <div className="fixed z-[300] w-52 rounded-lg border border-slate-200 bg-white p-1 shadow-xl" style={{ left: Math.min(menu.x, window.innerWidth - 221), top: Math.min(menu.y, window.innerHeight - 350) }} onClick={event => event.stopPropagation()}>{menu.project.availability !== 'missing' && <><button className="project-menu-item" onClick={() => { openRenameProject(menu.project); setMenu(null); }}>{t("ui.rename.0d0cba")}</button>{menu.project.archived && <button className="project-menu-item" onClick={() => { const project = menu.project; setMenu(null); void moveBack(project); }}>{t("ui.move.back.to.workspace.drive.d6cc91")}</button>}{backupEnabled && <div className="my-1 border-t border-slate-100"/>}</>}{backupEnabled && <><button className="project-menu-item" onClick={() => { const project = menu.project; setMenu(null); onOpenBackup(project); }}>{t("ui.view.project.backups.5e8689")}</button>{menu.project.availability === 'missing' && <button disabled={!hasProjectBackup} title={hasProjectBackup ? t("ui.choose.a.project.snapshot.to.restore.8eafc2") : t("ui.no.project.snapshots.available.to.restore.c2fc3f")} className="project-menu-item disabled:cursor-not-allowed disabled:text-slate-300" onClick={() => { if (!hasProjectBackup) return; const project = menu.project; setMenu(null); onOpenBackup(project); }}>{t("ui.restore.this.project.from.backup.51c989")}</button>}</>}{!backupEnabled && menu.project.archived && menu.project.availability === 'missing' && <button className="project-menu-item" onClick={() => { setMenu(null); onOpenBackup(); }}>{t("ui.view.archive.settings.ef1faa")}</button>}{menu.project.availability !== 'missing' && <><div className="my-1 border-t border-slate-100"/><p className="px-2 py-1 text-[11px] font-bold text-slate-400">{t("ui.change.status.1362de")}</p>{statuses.filter(status => status !== '未分类').map(status => { const isCurrentStatus = status === menu.project.status; return <button key={status} aria-current={isCurrentStatus ? 'true' : undefined} className={`project-menu-item ${isCurrentStatus ? 'bg-blue-50 font-bold text-blue-700' : ''}`} onClick={() => { move(menu.project, status); setMenu(null); }}>{projectStatusLabel(status)}{isCurrentStatus ? t("ui.current.58d8cd") : ''}</button>; })}<div className="my-1 border-t border-slate-100"/>{menu.project.archived ? <p className="px-2 py-1 text-[11px] leading-4 text-amber-600">{t("ui.move.back.to.the.workspace.drive.e6d2fd")}</p> : <button className="project-menu-item text-red-500 hover:bg-red-50" onClick={() => { trash(menu.project); setMenu(null); }}>{t("ui.delete.project.f6dc6a")}</button>}</>}</div>; })()}
    {(showNew || renameProject) && <ProjectDialog title={renameProject ? t("ui.rename.project.84ba75") : t("ui.new.project.0e1a70")} onClose={closeProjectEditor}>
      <form autoComplete="off" onSubmit={event => { event.preventDefault(); if (!isCreating && nextProjectDisplayName) void (renameProject ? rename() : createProject()); }}>
        <p className="text-xs text-slate-500">{t("ui.enter.a.full.date.for.automatic.ca2652")}</p>
        <label className="form-label">{t("ui.quick.date.entry.0ca3ad")}</label>
        <input value={quickDate} onInput={event => applyQuickDate(event.currentTarget.value)} autoComplete="off" placeholder={t("ui.for.example.26.7.17.or.bd5102")} className="form-input"/>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <label className="text-xs font-medium text-slate-500">{t("ui.year.62ef90")}<input type="number" min="0" max="2099" value={year} onInput={event => setYear(event.currentTarget.value)} autoComplete="off" placeholder="26" inputMode="numeric" className="form-input mt-1"/></label>
          <label className="text-xs font-medium text-slate-500">{t("ui.month.162517")}<input type="number" min="1" max="12" value={month} onInput={event => setMonth(event.currentTarget.value)} autoComplete="off" placeholder="7" inputMode="numeric" className="form-input mt-1"/></label>
          <label className="text-xs font-medium text-slate-500">{t("ui.day.optional.b694be")}<input type="number" min="1" max="31" value={day} onInput={event => setDay(event.currentTarget.value)} autoComplete="off" placeholder="17" inputMode="numeric" className="form-input mt-1"/></label>
        </div>
        <label className="form-label">{t("ui.project.name.optional.36b5d9")}</label>
        <input value={name} onInput={event => setName(event.currentTarget.value)} autoComplete="off" placeholder={t("ui.for.example.spring.portraits.15a910")} className="form-input"/>
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">{renameProject ? t("ui.new.name.28925c") : t("ui.will.create.5cb828")}：<strong className="text-slate-700">{nextProjectDisplayName || t("ui.enter.a.date.or.name.0c178c")}</strong></p>
        {newProjectError && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600"><LocalizedText value={newProjectError}/></div>}
        <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={closeProjectEditor} disabled={isCreating} className="dialog-secondary">{t("common.cancel")}</button><button type="submit" disabled={isCreating || !nextProjectDisplayName} className="dialog-primary">{isCreating ? renameProject ? t("ui.renaming.b49f6a") : t("ui.creating.56b63d") : renameProject ? t("ui.confirm.rename.cb0cfc") : t("ui.create.cde2cd")}</button></div>
      </form>
    </ProjectDialog>}
    {showExistingProjectImport && <ProjectImportDialog title={t("ui.import.project.579cd7")} busy={isImportingExistingProject} onClose={closeExistingProjectImport}>
      {existingProjectResult && existingProjectDraft ? <div className="space-y-4">
        <section className={`rounded-xl border px-4 py-4 ${existingProjectResult.sourceRetained ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'}`}>
          <div className="flex items-start gap-3"><span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${existingProjectResult.sourceRetained ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}><FolderInput size={18}/></span><div><h4 className="text-sm font-bold text-slate-800">{t("ui.project.import.complete.c8f080")}</h4><p className="mt-1 text-xs leading-5 text-slate-600">{t("message.0e57f1e3727b", { value0: existingProjectResult.sourceRetained ? t("ui.some.source.content.could.not.be.7fba72") : t("ui.folders.are.managed.as.ordinary.files.7fae64") })}</p></div></div>
          <div className="mt-4 grid grid-cols-2 gap-2">{[[t("ui.file.39932f"), existingProjectDraft.fileCount.toLocaleString(getLocale())], [t("ui.folder.7c7802"), existingProjectDraft.folderCount.toLocaleString(getLocale())]].map(([label, value]) => <div key={label} className="rounded-lg border border-white/80 bg-white/75 px-3 py-2"><span className="block text-[10px] text-slate-400">{label}</span><b className="mt-1 block text-sm text-slate-700">{value}</b></div>)}</div>
        </section>
        <div className="flex justify-end"><button type="button" onClick={closeExistingProjectImport} className="dialog-primary">{t("ui.close.and.open.project.37d543")}</button></div>
      </div> : !existingProjectDraft ? <div className="space-y-4"><div onDragOver={event => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setExistingProjectDragActive(true); }} onDragLeave={() => setExistingProjectDragActive(false)} onDrop={event => void inspectDroppedExistingProject(event)} className={`grid min-h-64 place-items-center rounded-xl border border-dashed p-8 text-center transition ${existingProjectDragActive ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-500/20' : 'border-slate-300 bg-slate-50'}`}><div><span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-blue-100 text-blue-600"><FolderInput size={22}/></span><p className="mt-4 text-sm font-bold text-slate-800">{t("ui.drop.a.project.or.media.folder.409caf")}</p><p className="mt-1 text-xs text-slate-500">{t("ui.or.use.the.button.below.to.38146c")}</p><button type="button" disabled={choosingExistingProject} onClick={() => void chooseExistingProject()} className="dialog-primary mt-4 inline-flex items-center gap-2">{choosingExistingProject && <Loader2 size={15} className="animate-spin"/>}{t("ui.choose.folder.0d6fad")}</button></div></div>{existingProjectError && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600"><LocalizedText value={existingProjectError}/></div>}</div> : <form className="space-y-4" onSubmit={event => { event.preventDefault(); void importExistingProject(existingProjectMode); }}>
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white"><header className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3"><span className="flex h-8 w-10 shrink-0 items-center justify-center rounded-md bg-blue-50 text-[10px] font-bold text-blue-700">DIR</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-800">{existingProjectDraft.name}</p><p title={existingProjectDraft.sourcePath} className="mt-0.5 truncate text-xs text-slate-500">{t("message.1dfc95a8a500", { value0: existingProjectDraft.sourcePath, value1: existingProjectDraft.fileCount.toLocaleString(getLocale()), value2: existingProjectDraft.folderCount.toLocaleString(getLocale()) })}</p></div><span className="shrink-0 text-xs font-bold text-slate-500">{formatBytes(existingProjectDraft.totalBytes)}</span></header></section>
        <label className="text-xs font-bold text-slate-600">{t("ui.project.name.867698")}<input autoFocus value={existingProjectName} disabled={isImportingExistingProject} onInput={event => setExistingProjectName(event.currentTarget.value)} className="form-input mt-1" placeholder={t("ui.project.name.867698")}/></label>
        <fieldset disabled={isImportingExistingProject}>
          <legend className="mb-2 text-xs font-bold text-slate-600">{t("ui.import.mode.53a42c")}</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {([
              ['copy', t("ui.copy.63d90d"), t("ui.copy.to.the.workspace.and.keep.90026c")],
              ['move', t("ui.move.fc6bb4"), t("ui.remove.the.originals.after.copying.and.63edac")],
              ['reference', t("ui.reference.original.location.266332"), t("ui.files.stay.in.place.edits.and.f658c3")],
            ] as const).map(([mode, label, description]) => <label key={mode} className={`cursor-pointer rounded-xl border p-3 ${existingProjectMode === mode ? 'border-blue-500 bg-blue-50' : 'border-slate-200 bg-white'}`}>
              <span className="flex items-center gap-2 text-sm font-semibold"><input type="radio" name="project-import-mode" value={mode} checked={existingProjectMode === mode} onChange={() => setExistingProjectMode(mode)}/>{label}</span>
              <span className="mt-2 block text-xs leading-5 text-slate-500">{description}</span>
            </label>)}
          </div>
        </fieldset>
        <p className="text-xs leading-5 text-slate-500">{t("ui.keep.the.folder.structure.and.manage.040de3")}</p>
        {isImportingExistingProject && <section className="rounded-xl border border-slate-200 bg-slate-50 p-3" aria-live="polite">
          <p className="text-xs text-slate-600">{existingProjectImportTask?.message || (existingProjectMode === 'reference' ? t("ui.adding.project.3a577b") : t("ui.importing.project.a57e42"))}</p>
          {existingProjectMode !== 'reference' && <progress className="mt-2 w-full" max={100} value={existingProjectImportTask?.progress || 0}/>}
        </section>}
        {existingProjectError && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600"><LocalizedText value={existingProjectError}/></div>}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4"><span className="text-xs text-slate-500">{t("ui.will.be.added.to.planning.1c5c3f")}</span><div className="flex flex-wrap gap-2"><button type="button" disabled={isImportingExistingProject || choosingExistingProject} onClick={() => void chooseExistingProject()} className="dialog-secondary">{choosingExistingProject ? t("ui.loading.86b6d0") : t("ui.choose.again.9b904c")}</button>{isImportingExistingProject ? <button type="button" onClick={() => void cancelExistingProjectImport()} disabled={!existingProjectImportTask?.cancellable || isCancellingExistingProject} className="dialog-secondary">{isCancellingExistingProject ? t("ui.cancelling.e8e08b") : t("ui.cancel.import.26bff7")}</button> : <button type="submit" disabled={!existingProjectName.trim()} className="dialog-primary">{t("ui.import.project.579cd7")}</button>}</div></div>
      </form>}
    </ProjectImportDialog>}
  </>;
};

const ProjectDialog = ({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) => {
  useLocale();
  useEscapeLayer(true, onClose, true, true);
  return createPortal(<div className="fixed inset-x-0 bottom-0 top-10 z-[500] overflow-y-auto bg-slate-950/40 p-4"><div className="flex min-h-full items-center justify-center"><div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl"><div className="mb-3 flex items-center justify-between"><h3 className="font-bold text-slate-800">{title}</h3><button onClick={onClose} aria-label={t("common.close")} className="rounded p-1 text-slate-500 hover:bg-slate-100"><X size={18}/></button></div>{children}</div></div></div>, document.body);
};

const ProjectImportDialog = ({ title, busy, onClose, children }: { title: string; busy: boolean; onClose: () => void; children: React.ReactNode }) => {
  useLocale();
  useEscapeLayer(true, onClose, true, true);
  return createPortal(<div className="tool-panel-backdrop fixed inset-x-0 bottom-0 top-10 z-[500] flex items-center justify-center p-4" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><section role="dialog" aria-modal="true" aria-label={title} className="tool-panel-window flex max-h-[90vh] w-full max-w-[960px] flex-col overflow-hidden border bg-white"><header className="tool-panel-header flex shrink-0 items-center gap-3 border-b border-slate-200 px-5"><span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-blue-50 text-blue-600"><FolderInput size={18}/></span><div className="min-w-0 flex-1"><h3 className="truncate text-[15px] font-bold text-slate-800">{title}</h3><p className="mt-0.5 truncate text-[10px] text-slate-400">{t("ui.copy.or.move.an.existing.project.221de9")}</p></div><button type="button" onClick={onClose} aria-label={busy ? t("ui.cancel.import.26bff7") : t("common.close")} title={busy ? t("ui.cancel.this.import.d827cd") : t("common.close")} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100"><X size={18}/></button></header><div className="tool-panel-body min-h-0 flex-1 overflow-y-auto p-[22px]">{children}</div></section></div>, document.body);
};
