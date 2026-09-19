import React, { useState, useEffect, useMemo } from 'react';
import { FolderInput, ScanSearch, HardDrive, Play, Pause, Save, Trash2, AlertCircle, Edit, X, Plus, User, Loader2, RotateCcw, Download, Scissors, Video, ChevronDown, ChevronUp, Crop, CheckCircle2 } from 'lucide-react';
import { TaskProgress } from '../../components/TaskStatus';
import { useTaskPresentation } from '../../components/useTaskPresentation';
import type { AppConfig, LogEntry, MediaWorkflowImportManifest, ProjectStatus, SelectionPreflightResult, StorageDevice, VideoTranscodeSettings, WorkspaceProject } from '../../types';
import { useAppDialog } from '../../components/AppDialogProvider';
import { useEscapeLayer } from '../../components/LayerProvider';
import { RECYCLE_BIN_FAILURE_DIALOG, isRecycleBinFailure } from '../../utils/recycleBinFailure';
import { InteractiveCropEditor, type CropRectangle } from '../../components/InteractiveCropEditor';
import { ImportSourceControls, type ImportMaterialKind } from '../../components/ImportSourceControls';
import { SourcePathPicker } from '../../components/SourcePathPicker';
import { mergeSourcePaths, sourcePathIdentity } from '../../components/source-path-picker-model';
import { PanelSwitch } from '../../components/PanelSwitch';
import { appendImportSuccess, createImportProtocolState, describeImportCompletion, importEventIsPartial, pendingImportGraphKey, reduceImportProtocolEvent, resolveImportOutcome, shouldForgetImportSession, type ImportCompletion } from './import-completion-model';
import { createFilenameSelectionTaskOwnership, filenameSelectionOutputName, resolveFilenameSelectionSource } from './filename-selection-model';
import { configuredSdDriveTypes, configuredSdDriveVideoActions, configuredSdSelectionPaths, isTrustedSdImportDevice, normalizeConfiguredSdDeviceRecords, reconcileConfiguredSdDevices, resolveConfiguredSdDevices, storageDeviceMatchesId, syncLegacySdMirrors, upsertConfiguredSdDevice } from './sd-startup-import-model';
import { decideStartupSdAutoImport, handledStartupRequestAfterBatchStart, shouldDeleteSourceForImportBatch, type StartupSdAutoImportRequest } from './startup-sd-auto-import-model';
import { isFreshStorageDeviceInventory, shouldPollStorageDeviceInventory } from './storage-device-inventory-model';
import { useStorageDeviceInventory } from './use-storage-device-inventory';
import { getWorkspaceCatalog, readWorkspaceCatalogSnapshot, workspaceCatalogEventMatches } from '../../platform/workspace-catalog-client';
import { BUILTIN_VIDEO_TRANSCODE_PRESETS, formatMediaBytes, normalizeVideoTranscodeSettings, readCustomVideoTranscodePresets, videoTranscodeBlockingErrors, videoTranscodeWarnings, writeCustomVideoTranscodePresets, type VideoTranscodeCapabilities, type VideoTranscodeMediaInfo, type VideoTranscodePreset } from './video-transcode-model';

export type { ImportCompletion } from './import-completion-model';

type RendererMediaWorkflowImportManifest = MediaWorkflowImportManifest & { manifestId?: string };

const VIDEO_SOURCE_PREVIEW_EXTENSIONS = ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'crm', 'mts', 'm2ts', 'ts'];
const IMAGE_SOURCE_PREVIEW_EXTENSIONS = ['png', 'webp', 'heic', 'heif', 'avif', 'tif', 'tiff', 'bmp', 'gif'];

interface PythonEvent {
  type: 'log' | 'error' | 'progress' | 'status' | 'ask_user' | 'success' | 'partial' | 'warning' | 'preview' | 'cancelled' | 'complete';
  message: string;
  data?: any;
  progress?: number;
  scriptName?: string;
  requestId?: string;
  outputs?: string[];
  folderOutputs?: VideoTranscodeFolderOutput[];
  mediaInfo?: VideoTranscodeMediaInfo[];
  capabilities?: VideoTranscodeCapabilities;
  estimatedOutputBytes?: number;
  report?: VideoTranscodeMediaInfo[];
  failedCount?: number;
}

export type VideoTranscodeFolderOutput = { sourceFolder: string; outputFolder: string };
type PythonTaskCompletion = { requestId: string; event: PythonEvent };

type ImportTransferStats = {
  bytesCopied: number;
  totalBytes: number;
  bytesPerSecond: number;
  filesCopied?: number;
  totalFiles?: number;
};

const formatTransferBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** unitIndex;
  return `${value.toFixed(value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
};
const importCountBucket = (count: number) => count <= 20
  ? '1-20'
  : count <= 100
    ? '21-100'
    : count <= 500
      ? '101-500'
      : count <= 2000
        ? '501-2000'
        : '2001+';

const usePythonTask = (scriptName: string, initialStatus: string) => {
  const panelTaskIdentity = useTaskPresentation();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isPaused, setIsPausedState] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState(initialStatus);
  const [preview, setPreview] = useState<Record<string, any> | null>(null);
  const [completion, setCompletion] = useState<PythonTaskCompletion | null>(null);
  const requestIdRef = React.useRef('');
  const taskHadErrorRef = React.useRef(false);
  const taskHadSuccessRef = React.useRef(false);
  const taskHadPartialRef = React.useRef(false);
  const taskCancelledRef = React.useRef(false);
  const taskAwaitingPreviewRef = React.useRef(false);
  const successEventRef = React.useRef<PythonEvent | null>(null);
  const pendingLogsRef = React.useRef<LogEntry[]>([]);
  const logFlushTimerRef = React.useRef<number | null>(null);
  const appendLog = React.useCallback((message: string, type: LogEntry['type']) => {
    pendingLogsRef.current.push({ timestamp: new Date().toLocaleTimeString(), message, type });
    if (logFlushTimerRef.current !== null) return;
    logFlushTimerRef.current = window.setTimeout(() => {
      const pending = pendingLogsRef.current.splice(0);
      logFlushTimerRef.current = null;
      if (pending.length) setLogs(previous => [...previous, ...pending].slice(-200));
    }, 100);
  }, []);

  useEffect(() => () => {
    if (logFlushTimerRef.current !== null) window.clearTimeout(logFlushTimerRef.current);
    pendingLogsRef.current = [];
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onPythonEvent) return;
    return window.electronAPI.onPythonEvent((event: PythonEvent) => {
      if (event.scriptName !== scriptName) return;
      if (!requestIdRef.current || event.requestId !== requestIdRef.current) return;
      if (event.type === 'log' || event.type === 'error' || event.type === 'warning' || event.type === 'success' || event.type === 'partial') {
        const partialTerminal = (event.type === 'success' || event.type === 'partial') && importEventIsPartial(event);
        const type: LogEntry['type'] = event.type === 'log' ? 'info' : partialTerminal || event.type === 'partial' ? 'warning' : event.type;
        appendLog(event.message, type);
        if (event.type === 'success' && !partialTerminal) {
          taskHadSuccessRef.current = true;
          successEventRef.current = event;
          setProgress(100);
          setStatusMsg('正在结束任务…');
        } else if (partialTerminal) {
          taskHadPartialRef.current = true;
          successEventRef.current = event;
          setStatusMsg('部分处理完成，正在结束任务…');
        } else if (event.type === 'error') {
          taskHadErrorRef.current = true;
          setStatusMsg('出现错误，正在结束任务…');
        }
      } else if (event.type === 'progress') {
        if (event.progress !== undefined) setProgress(event.progress);
        if (event.message) setStatusMsg(event.message);
        if (event.data?.fileStarted && event.message) appendLog(event.message, 'info');
      } else if (event.type === 'status') {
        if (event.message) setStatusMsg(event.message);
      } else if (event.type === 'preview') {
        taskAwaitingPreviewRef.current = true;
        setPreview(event.data || {});
        setIsRunning(false);
        setStatusMsg('等待确认');
      } else if (event.type === 'cancelled') {
        taskCancelledRef.current = true;
        appendLog(event.message || '任务已取消。', 'warning');
        setIsRunning(false);
        setIsCancelling(false);
        setIsPausedState(false);
        setProgress(0);
        setStatusMsg('已取消并回滚');
        requestIdRef.current = '';
      } else if (event.type === 'complete') {
        if (taskCancelledRef.current || taskAwaitingPreviewRef.current) return;
        const exitCode = event.data?.exitCode;
        const failed = exitCode !== 0 || (taskHadErrorRef.current && !taskHadSuccessRef.current && !taskHadPartialRef.current);
        setIsRunning(false);
        setIsCancelling(false);
        setIsPausedState(false);
        if (failed) {
          setStatusMsg('发生错误');
        } else if (taskHadPartialRef.current) {
          setProgress(100);
          setStatusMsg('部分处理完成');
          setCompletion({ requestId: event.requestId || requestIdRef.current, event: successEventRef.current || event });
        } else {
          setProgress(100);
          setStatusMsg('处理完成');
          setCompletion({ requestId: event.requestId || requestIdRef.current, event: successEventRef.current || event });
        }
        requestIdRef.current = '';
      }
    });
  }, [appendLog, scriptName]);

  const start = (args: string[], startingStatus: string) => {
    if (isRunning) return false;
    if (logFlushTimerRef.current !== null) window.clearTimeout(logFlushTimerRef.current);
    logFlushTimerRef.current = null;
    pendingLogsRef.current = [];
    setLogs([]);
    taskHadErrorRef.current = false;
    taskHadSuccessRef.current = false;
    taskHadPartialRef.current = false;
    taskCancelledRef.current = false;
    taskAwaitingPreviewRef.current = false;
    successEventRef.current = null;
    setCompletion(null);
    setPreview(null);
    setProgress(0);
    setIsRunning(true);
    setIsCancelling(false);
    setIsPausedState(false);
    setStatusMsg(startingStatus);
    const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    requestIdRef.current = requestId;
    window.electronAPI.runScript(scriptName, args, requestId, panelTaskIdentity ? {
      ownerPageId: panelTaskIdentity.ownerPageId,
      panelKind: panelTaskIdentity.panelKind,
      title: panelTaskIdentity.title,
    } : undefined);
    return true;
  };

  const cancel = async () => {
    if (!isRunning || !requestIdRef.current || isCancelling) return false;
    setIsCancelling(true);
    setStatusMsg('正在取消并回滚……');
    try {
      const result = await window.electronAPI.cancelPythonTask(requestIdRef.current);
      if (result.success) return true;
      setIsCancelling(false);
      appendLog(result.error || '无法取消任务。', 'error');
    } catch (error) {
      setIsCancelling(false);
      appendLog(error instanceof Error ? error.message : String(error || '无法取消任务。'), 'error');
    }
    return false;
  };

  const setPaused = async (paused: boolean) => {
    if (!isRunning || !requestIdRef.current || isCancelling) return false;
    try {
      const result = await window.electronAPI.controlPythonTask(requestIdRef.current, paused ? 'pause' : 'resume');
      if (result.success) {
        setIsPausedState(paused);
        setStatusMsg(paused ? '队列已暂停' : '正在恢复编码…');
      } else appendLog(result.error || '无法更改暂停状态。', 'error');
      return result.success;
    } catch (error) {
      appendLog(error instanceof Error ? error.message : String(error || '无法更改暂停状态。'), 'error');
      return false;
    }
  };

  return { logs, isRunning, isCancelling, isPaused, progress, statusMsg, preview, completion, clearPreview: () => setPreview(null), start, cancel, setPaused };
};

const ImportCard = ({ config, drives = [], storageDevices = [], destinationPath, brollDestinationPath, workspacePath, workspaceProjects, active = true, directSource = false, startupAutoImportRequest = null, startupAutoImportReady = false, startupAutoImportError = null, startupAutoImportSelections = [], importKind, onImportKindChange, deleteSourceAfterImport = true, generateJpgFromRaw = false, splitVideosOnImport = false, transcodeVideosOnImport = false, splitBrollVideosOnImport = false, transcodeBrollVideosOnImport = false, transcodeSettings, videoToolsAvailable = true, onChooseSourceFiles, onChooseSourceFolder, onDropSourcePaths, onBusyChange, onImportConfigChange, onImportComplete, completedActionLabel = '继续导入', onCompletedAction }: { config?: AppConfig['smartImport'], drives?: string[], storageDevices?: StorageDevice[], destinationPath?: string | null, brollDestinationPath?: string | null, workspacePath?: string | null, workspaceProjects?: WorkspaceProject[], active?: boolean, directSource?: boolean, startupAutoImportRequest?: StartupSdAutoImportRequest | null, startupAutoImportReady?: boolean, startupAutoImportError?: string | null, startupAutoImportSelections?: Array<{ path: string; type: 'work' | 'broll' }>, importKind?: ImportMaterialKind, onImportKindChange?: (kind: ImportMaterialKind, sourcePaths: string[]) => void, deleteSourceAfterImport?: boolean, generateJpgFromRaw?: boolean, splitVideosOnImport?: boolean, transcodeVideosOnImport?: boolean, splitBrollVideosOnImport?: boolean, transcodeBrollVideosOnImport?: boolean, transcodeSettings?: VideoTranscodeSettings, videoToolsAvailable?: boolean, onChooseSourceFiles?: () => void, onChooseSourceFolder?: () => void, onDropSourcePaths?: (paths: string[]) => void, onBusyChange?: (busy: boolean) => void, onImportConfigChange?: (config: AppConfig['smartImport']) => void, onImportComplete?: (result: ImportCompletion) => void | Promise<void>, completedActionLabel?: string, onCompletedAction?: () => void }) => {
  const [status, setStatus] = useState<'idle' | 'checking' | 'ready_to_import' | 'importing' | 'decision' | 'processing' | 'completed'>('idle');
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState("等待连接...");
  const [decisionData, setDecisionData] = useState<any>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [transferStats, setTransferStats] = useState<ImportTransferStats | null>(null);
  const [completedProjectNames, setCompletedProjectNames] = useState<string[]>([]);
  const [completedOutcome, setCompletedOutcome] = useState<ImportCompletion['outcome']>('success');
  const [completedDetail, setCompletedDetail] = useState('');
  const [isCancellingImport, setIsCancellingImport] = useState(false);
  const [shouldDeleteSourceAfterImport, setShouldDeleteSourceAfterImport] = useState(deleteSourceAfterImport);
  const [drivePickerOpen, setDrivePickerOpen] = useState(false);
  const selectedDrives = config ? (directSource ? (config.sdPaths?.length ? config.sdPaths : config.sdPath ? [config.sdPath] : []) : configuredSdSelectionPaths(config, storageDevices)) : [];
  const driveTypes = config ? configuredSdDriveTypes(config, storageDevices) : {};
  const driveVideoActions = config ? configuredSdDriveVideoActions(config, storageDevices) : {};
  const defaultVideoActionsForType = (type: 'work' | 'broll') => ({
    splitVideosOnImport: type === 'broll' ? splitBrollVideosOnImport : splitVideosOnImport,
    transcodeVideosOnImport: type === 'broll' ? transcodeBrollVideosOnImport : transcodeVideosOnImport,
  });
  const videoActionsForDrive = (sdPath: string, type: 'work' | 'broll') => {
    if (!videoToolsAvailable) return { splitVideosOnImport: false, transcodeVideosOnImport: false };
    return directSource ? defaultVideoActionsForType(type) : driveVideoActions[sdPath] || defaultVideoActionsForType(type);
  };
  // 【关键修改】使用 Ref 来做“防抖”锁，防止 SD 卡接触不良导致多次触发 startImport
  const isBusyRef = React.useRef(false);
  const handledStartupAutoImportRef = React.useRef(0);
  const importQueueRef = React.useRef<Array<{ path: string; type: 'work' | 'broll' }>>([]);
  const currentDriveRef = React.useRef('');
  const currentDriveTypeRef = React.useRef<'work' | 'broll'>('work');
  const importRequestIdRef = React.useRef('');
  const currentStageRef = React.useRef('');
  const cancelRequestedRef = React.useRef(false);
  const stagingCompleteRef = React.useRef(false);
  const importedProjectNamesRef = React.useRef<string[]>([]);
  const importedWorkProjectNamesRef = React.useRef<string[]>([]);
  const importedBrollProjectNamesRef = React.useRef<string[]>([]);
  const importedPathsByProjectRef = React.useRef<Record<string, string[]>>({});
  const importedCountRef = React.useRef(0);
  const failedImportCountRef = React.useRef(0);
  const completedDriveCountRef = React.useRef(0);
  const failedDrivesRef = React.useRef<string[]>([]);
  const skippedDrivesRef = React.useRef<string[]>([]);
  const drivesRef = React.useRef(drives);
  const driveImportSessionsRef = React.useRef(new Map<string, string>());
  const currentImportSessionKeyRef = React.useRef('');
  const retryDrivePathsRef = React.useRef<string[]>([]);
  const importBatchModeRef = React.useRef<'manual' | 'startup'>('manual');
  const drivePickerRef = React.useRef<HTMLDivElement>(null);
  const currentImportSessionRef = React.useRef('');
  const importProtocolStateRef = React.useRef(createImportProtocolState());
  const continueAfterDriveFailureRef = React.useRef<(drive: string, message: string, requestId?: string) => void>(() => undefined);
  const continueRoutedImportRef = React.useRef<(routes: Record<string, string>, routingDecision?: any) => void | Promise<void>>(() => undefined);
  const startImportRef = React.useRef<(sdPath?: string, type?: 'work' | 'broll') => void>(() => undefined);
  const startBatchRef = React.useRef<(requested?: Array<{ path: string; type: 'work' | 'broll' }>, mode?: 'manual' | 'startup') => boolean>(() => false);
  const onImportCompleteRef = React.useRef(onImportComplete);
  const onBusyChangeRef = React.useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;
  const pendingImportGraphsStorageKey = 'photoflow:pending-import-graphs:v1';
  const commitImportGraphs = React.useCallback(async (manifests: RendererMediaWorkflowImportManifest[]) => {
    if (!manifests.length) return;
    if (!workspacePath) throw new Error('缺少工作区路径，无法保存媒体关系');
    const readPending = () => {
      try { return JSON.parse(window.localStorage.getItem(pendingImportGraphsStorageKey) || '{}') as Record<string, { workspacePath: string; manifest: RendererMediaWorkflowImportManifest }>; }
      catch { return {}; }
    };
    const pending = readPending();
    for (const manifest of manifests) {
      const key = pendingImportGraphKey(workspacePath, manifest);
      pending[key] = { workspacePath, manifest };
    }
    window.localStorage.setItem(pendingImportGraphsStorageKey, JSON.stringify(pending));
    for (const manifest of manifests) {
      const result = await window.electronAPI.commitMediaWorkflowImport(workspacePath, manifest);
      if (!result.success) throw new Error(result.error || '媒体关系保存失败');
      const key = pendingImportGraphKey(workspacePath, manifest);
      delete pending[key];
      window.localStorage.setItem(pendingImportGraphsStorageKey, JSON.stringify(pending));
    }
  }, [workspacePath]);
  useEffect(() => { onImportCompleteRef.current = onImportComplete; }, [onImportComplete]);
  useEffect(() => {
    if (!active || !workspacePath) return;
    void window.electronAPI.recoverMediaWorkflowImports(workspacePath).then(result => {
      if (result.failures.length) setStatusMsg('媒体已导入，关系待恢复；将自动继续重试。');
      let pending: Record<string, { workspacePath: string; manifest: RendererMediaWorkflowImportManifest }> = {};
      try { pending = JSON.parse(window.localStorage.getItem(pendingImportGraphsStorageKey) || '{}'); } catch { return; }
      const manifests = Object.values(pending).filter(item => item.workspacePath === workspacePath).map(item => item.manifest);
      if (manifests.length) void commitImportGraphs(manifests).catch(() => undefined);
    }).catch(() => undefined);
  }, [active, commitImportGraphs, workspacePath]);
  useEffect(() => { drivesRef.current = drives; }, [drives]);
  useEffect(() => {
    if (active && status === 'idle') setShouldDeleteSourceAfterImport(deleteSourceAfterImport);
  }, [active, deleteSourceAfterImport, status]);
  useEffect(() => {
    if (!drivePickerOpen) return;
    const closeDrivePicker = (event: PointerEvent) => {
      if (!drivePickerRef.current?.contains(event.target as Node)) setDrivePickerOpen(false);
    };
    document.addEventListener('pointerdown', closeDrivePicker);
    return () => document.removeEventListener('pointerdown', closeDrivePicker);
  }, [drivePickerOpen]);
  useEffect(() => {
    if (status !== 'idle') setDrivePickerOpen(false);
  }, [status]);
  const importSessionStorageKey = 'photoflow:sd-import-sessions:v1';
  const readPersistedImportSessions = () => {
    try {
      const raw = JSON.parse(window.localStorage.getItem(importSessionStorageKey) || '{}') as Record<string, string | { session?: string; stagingComplete?: boolean }>;
      return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, typeof value === 'string' ? { session: value, stagingComplete: false } : { session: String(value?.session || ''), stagingComplete: value?.stagingComplete === true }])) as Record<string, { session: string; stagingComplete: boolean }>;
    }
    catch { return {}; }
  };
  const persistImportSession = (key: string, session: string, stagingComplete?: boolean) => {
    const sessions = readPersistedImportSessions();
    if (session) sessions[key] = { session, stagingComplete: stagingComplete ?? sessions[key]?.stagingComplete ?? false };
    else delete sessions[key];
    window.localStorage.setItem(importSessionStorageKey, JSON.stringify(sessions));
  };
  const clearImportTerminalState = () => {
    importQueueRef.current = [];
    importRequestIdRef.current = '';
    currentStageRef.current = '';
    currentDriveRef.current = '';
    currentImportSessionRef.current = '';
    currentImportSessionKeyRef.current = '';
    stagingCompleteRef.current = false;
    cancelRequestedRef.current = false;
    isBusyRef.current = false;
    importProtocolStateRef.current = createImportProtocolState();
    setDecisionData(null);
    setIsCancellingImport(false);
  };
  const forgetCurrentImportSession = (terminal: 'success' | 'discard-success' | 'session-invalid') => {
    if (!shouldForgetImportSession(terminal) || !currentImportSessionKeyRef.current) return;
    driveImportSessionsRef.current.delete(currentImportSessionKeyRef.current);
    persistImportSession(currentImportSessionKeyRef.current, '');
  };
  const importDestinationForType = (type: 'work' | 'broll') => workspaceProjects !== undefined ? destinationPath : type === 'broll' ? brollDestinationPath : destinationPath;
  const importSessionKeyFor = (sdPath: string, type: 'work' | 'broll') => {
    const resolvedDestinationPath = importDestinationForType(type);
    return resolvedDestinationPath ? `${resolvedDestinationPath}\u0000${sdPath}\u0000${type}` : '';
  };
  const hasPersistedImportSession = (sdPath: string, type: 'work' | 'broll') => {
    const key = importSessionKeyFor(sdPath, type);
    return Boolean(key && readPersistedImportSessions()[key]?.stagingComplete);
  };
  const importCompletion = (): ImportCompletion => ({
    projectNames: [...importedProjectNamesRef.current],
    workProjectNames: [...importedWorkProjectNamesRef.current],
    brollProjectNames: [...importedBrollProjectNamesRef.current],
    importedPathsByProject: { ...importedPathsByProjectRef.current },
    importedCount: importedCountRef.current,
    skipped: importedCountRef.current === 0 && skippedDrivesRef.current.length > 0,
    failedCount: failedImportCountRef.current + failedDrivesRef.current.length,
    relationPending: false,
    outcome: resolveImportOutcome({ importedCount: importedCountRef.current, skipped: importedCountRef.current === 0 && skippedDrivesRef.current.length > 0, failedCount: failedImportCountRef.current + failedDrivesRef.current.length, relationPending: false }),
  });
  continueAfterDriveFailureRef.current = (failedDrive, message, requestId = '') => {
    if (failedDrive && !failedDrivesRef.current.includes(failedDrive)) failedDrivesRef.current.push(failedDrive);
    currentDriveRef.current = '';
    currentStageRef.current = '';
    currentImportSessionRef.current = '';
    currentImportSessionKeyRef.current = '';
    importRequestIdRef.current = '';
    stagingCompleteRef.current = false;
    cancelRequestedRef.current = false;
    setDecisionData(null);
    setTransferStats(null);
    setIsCancellingImport(false);

    let nextDrive = importQueueRef.current.shift();
    while (nextDrive && !drivesRef.current.includes(nextDrive.path) && !hasPersistedImportSession(nextDrive.path, nextDrive.type)) {
      if (!failedDrivesRef.current.includes(nextDrive.path)) failedDrivesRef.current.push(nextDrive.path);
      nextDrive = importQueueRef.current.shift();
    }

    const continueBatch = () => {
      if (nextDrive) {
        // Release only the in-memory start guard; the visible status remains
        // busy while the next connected card is queued.
        isBusyRef.current = false;
        setStatus('processing');
        setProgress(0);
        setStatusMsg(`${message}；继续导入 ${nextDrive.path}`);
        window.setTimeout(() => startImportRef.current(nextDrive!.path, nextDrive!.type), 300);
        return;
      }
      isBusyRef.current = false;
      const failedLabel = failedDrivesRef.current.join('、');
      retryDrivePathsRef.current = [...failedDrivesRef.current];
      if (completedDriveCountRef.current > 0) {
        const completion = importCompletion();
        const completedProjectNames = completion.projectNames;
        setStatus('completed');
        setProgress(100);
        setCompletedProjectNames(completedProjectNames);
        setCompletedOutcome(completion.outcome);
        setCompletedDetail(describeImportCompletion(completion));
        setStatusMsg(`批量导入已结束：${completedDriveCountRef.current} 张卡完成，${failedLabel} 未完成，可重新插卡后续传`);
        void onImportCompleteRef.current?.(completion);
      } else {
        setStatus('idle');
        setProgress(0);
        setStatusMsg(`${message}；已完成的暂存文件会保留，重新插卡后可续传`);
      }
    };

    if (requestId) {
      void window.electronAPI.cancelPythonTask(requestId).finally(continueBatch);
    } else {
      continueBatch();
    }
  };
  const resetCompletedImport = React.useCallback(() => {
    setStatus('idle');
    setProgress(0);
    setStatusMsg('等待连接...');
    setDecisionData(null);
    setTransferStats(null);
    setCompletedProjectNames([]);
    setCompletedOutcome('success');
    setCompletedDetail('');
    setLogs([]);
    setIsCancellingImport(false);
  }, []);
  useEffect(() => {
    if (!active && status === 'completed') resetCompletedImport();
  }, [active, resetCompletedImport, status]);
  useEffect(() => {
    if (!active || isBusyRef.current) return;
    setShouldDeleteSourceAfterImport(deleteSourceAfterImport);
  }, [active, deleteSourceAfterImport, directSource]);
  useEffect(() => {
    const busy = status === 'ready_to_import' || status === 'importing' || status === 'decision' || status === 'processing';
    onBusyChangeRef.current?.(busy);
  }, [status]);
  useEffect(() => () => onBusyChangeRef.current?.(false), []);
  useEffect(() => {
    if (directSource || !isBusyRef.current || stagingCompleteRef.current) return;
    const currentDrive = currentDriveRef.current;
    if (!currentDrive || drives.includes(currentDrive)) return;

    const disconnectTimer = window.setTimeout(() => {
      if (!isBusyRef.current || stagingCompleteRef.current || drives.includes(currentDrive) || currentDriveRef.current !== currentDrive) return;
      const activeRequestId = status === 'decision' ? '' : importRequestIdRef.current;
      continueAfterDriveFailureRef.current(currentDrive, `设备 ${currentDrive} 已断开`, activeRequestId);
    }, 1200);

    return () => window.clearTimeout(disconnectTimer);
  }, [decisionData?.stagingComplete, directSource, drives, status]);
  const toggleDrive = (sdPath: string) => {
    if (!config || !onImportConfigChange) return;
    retryDrivePathsRef.current = [];
    const removing = selectedDrives.includes(sdPath);
    const device = storageDevices.find(candidate => candidate.mountPath === sdPath);
    if (device && isTrustedSdImportDevice(device)) {
      const records = normalizeConfiguredSdDeviceRecords(config.sdDevices);
      const matchingRecord = records.find(record => storageDeviceMatchesId(device, record.deviceId));
      if (removing && matchingRecord?.enabled && matchingRecord.confirmedAt > 0) {
        onImportConfigChange(syncLegacySdMirrors(config, records.map(record => storageDeviceMatchesId(device, record.deviceId) ? { ...record, deviceId: device.id, enabled: false } : record)));
      } else {
        const type = driveTypes[sdPath] || 'work';
        onImportConfigChange(upsertConfiguredSdDevice(config, device, type, Date.now(), defaultVideoActionsForType(type)));
      }
      return;
    }
    const sdDeviceIds = { ...(config.sdDeviceIds || {}) };
    const sdPaths = removing ? selectedDrives.filter(path => path !== sdPath) : [...selectedDrives, sdPath];
    if (removing) delete sdDeviceIds[sdPath];
    onImportConfigChange({ ...config, sdPath: sdPaths[0] || '', sdPaths, sdDriveTypes: { ...driveTypes, [sdPath]: driveTypes[sdPath] || 'work' }, sdDeviceIds });
  };
  const setDriveType = (sdPath: string, type: 'work' | 'broll') => {
    if (!config || !onImportConfigChange) return;
    const device = storageDevices.find(candidate => candidate.mountPath === sdPath);
    const records = normalizeConfiguredSdDeviceRecords(config.sdDevices);
    const nextRecords = records.map(record => (
      (device ? storageDeviceMatchesId(device, record.deviceId) : record.lastMountPath === sdPath) ? { ...record, ...(device ? { deviceId: device.id } : {}), type } : record
    ));
    onImportConfigChange(syncLegacySdMirrors({ ...config, sdDriveTypes: { ...driveTypes, [sdPath]: type } }, nextRecords));
  };

  const runCmd = (stage: string, args: string[] = []) => {
    const requestId = crypto.randomUUID();
    importProtocolStateRef.current = createImportProtocolState();
    importRequestIdRef.current = requestId;
    currentStageRef.current = stage;
    const sessionArgs = ['plan', 'import', 'broll'].includes(stage) ? ['--import_session', currentImportSessionRef.current] : [];
    const dateFilterArgs = !directSource && ['plan', 'import', 'broll'].includes(stage) && config?.dateFilter && config.dateFilter !== 'all'
      ? ['--date_filter', config.dateFilter]
      : [];
    const deleteSource = shouldDeleteSourceForImportBatch(shouldDeleteSourceAfterImport, importBatchModeRef.current);
    if(window.electronAPI) window.electronAPI.runScript('classify.py', ['--stage', stage, ...args, ...sessionArgs, ...dateFilterArgs, ...(directSource ? ['--direct_source', '--source_paths', JSON.stringify(selectedDrives)] : []), ...(deleteSource ? ['--delete_source'] : []), ...(generateJpgFromRaw ? ['--generate_jpg_from_raw'] : [])], requestId);
  };

  const cancelImport = async () => {
    if (isCancellingImport || !isBusyRef.current) return;
    setIsCancellingImport(true);
    if (status === 'decision') {
      const usesProjectRouting = workspaceProjects !== undefined;
      const resolvedDestinationPath = usesProjectRouting ? destinationPath : currentDriveTypeRef.current === 'broll' ? brollDestinationPath : destinationPath;
      const discardSession = currentImportSessionRef.current;
      if (!resolvedDestinationPath || !discardSession) {
        setIsCancellingImport(false);
        setStatusMsg('Missing import destination or staging session; the session was preserved.');
        return;
      }
      if (resolvedDestinationPath && discardSession) {
        const discardRequestId = crypto.randomUUID();
        let discarded = false;
        try {
          discarded = await new Promise<boolean>(resolve => {
            let unsubscribe = () => {};
            const timeout = window.setTimeout(() => { unsubscribe(); resolve(false); }, 30_000);
            unsubscribe = window.electronAPI.onPythonEvent((event: PythonEvent) => {
              if (event.scriptName !== 'classify.py' || event.requestId !== discardRequestId) return;
              if (event.type !== 'complete' && event.type !== 'cancelled') return;
              window.clearTimeout(timeout);
              unsubscribe();
              resolve(event.type === 'complete' && event.data?.exitCode === 0);
            });
            window.electronAPI.runScript('classify.py', ['--stage', 'discard', '--dest_path', resolvedDestinationPath, '--import_session', discardSession], discardRequestId);
          });
        } catch { discarded = false; }
        if (!discarded) {
          setIsCancellingImport(false);
          setStatusMsg('清理导入暂存失败，可重试取消');
          return;
        }
      }
      importQueueRef.current = [];
      forgetCurrentImportSession('discard-success');
      cancelRequestedRef.current = true;
      currentDriveRef.current = '';
      currentImportSessionRef.current = '';
      currentImportSessionKeyRef.current = '';
      isBusyRef.current = false;
      setStatus('idle');
      setStatusMsg('导入已取消');
      setIsCancellingImport(false);
      return;
    }
    try {
      const result = await window.electronAPI.cancelPythonTask(importRequestIdRef.current);
      if (result.success) {
        importQueueRef.current = [];
        return;
      }
      setIsCancellingImport(false);
      setStatusMsg(result.error || 'Unable to cancel the current import task.');
    } catch (error) {
      setIsCancellingImport(false);
      setStatusMsg(error instanceof Error ? error.message : String(error || 'Unable to cancel the current import task.'));
    }
  };

  useEffect(() => {
    if (!window.electronAPI?.onPythonEvent) return;

    const cleanup = window.electronAPI.onPythonEvent(async (event: PythonEvent) => {
      if (!active && !isBusyRef.current) return;
      if (event.scriptName !== 'classify.py') return;
      if (!event.requestId || event.requestId !== importRequestIdRef.current) return;
      if (cancelRequestedRef.current && event.type !== 'cancelled') return;
      const protocolState = reduceImportProtocolEvent(importProtocolStateRef.current, event);
      importProtocolStateRef.current = protocolState;
      // 1. 记录日志
      if (event.message) {
        setLogs(prev => {
           // 简单的去重逻辑，防止同样的日志刷屏
           const last = prev[prev.length - 1];
           if (last && last.message === event.message && event.type === 'progress') return prev;

           return [...prev, {
            timestamp: new Date().toLocaleTimeString(),
            message: event.message,
            type: event.type as any
           }].slice(-200);
        });
      }

      // 2. 处理事件
      switch (event.type) {
        case 'status':
          // 只有当状态是 idle 或 checking 时，才允许响应连接信号
          if (event.data?.connected) {
            // 【关键判断】如果当前正在忙（正在导入或处理），直接忽略这次信号
            if (isBusyRef.current) return;

            setStatus('ready_to_import');
            setStatusMsg("检测到设备: " + event.data.path);

            // 延迟一点启动，给 UI 一个反应时间
            setTimeout(() => {
                if (!isBusyRef.current) {
                    startBatchRef.current();
                }
            }, 500);
          } else {
             // 只有在非运行状态下才重置为 idle，防止导入过程中拔卡导致界面重置
             if (!isBusyRef.current) {
                setStatus('idle');
                setStatusMsg("未检测到 SD 卡");
             }
          }
          break;

        case 'progress':
          if (event.data?.stagingComplete) {
            stagingCompleteRef.current = true;
            if (currentImportSessionKeyRef.current && currentImportSessionRef.current) persistImportSession(currentImportSessionKeyRef.current, currentImportSessionRef.current, true);
          }
          setProgress(event.progress || 0);
          // Python 那边现在发过来的是 "正在导入: IMG_001.JPG"，这里直接显示
          setStatusMsg(event.message);
          if (event.data && Number.isFinite(Number(event.data.totalBytes))) {
            setTransferStats({
              bytesCopied: Number(event.data.bytesCopied) || 0,
              totalBytes: Number(event.data.totalBytes) || 0,
              bytesPerSecond: Number(event.data.bytesPerSecond) || 0,
              filesCopied: Number.isFinite(Number(event.data.filesCopied)) ? Number(event.data.filesCopied) : undefined,
              totalFiles: Number.isFinite(Number(event.data.totalFiles)) ? Number(event.data.totalFiles) : undefined,
            });
          }
          break;

        case 'ask_user':
          if (event.data?.kind === 'project_routing') {
            if (event.data.stagingComplete) {
              stagingCompleteRef.current = true;
              if (currentImportSessionKeyRef.current && currentImportSessionRef.current) persistImportSession(currentImportSessionKeyRef.current, currentImportSessionRef.current, true);
            }
            const automaticRoutes = event.data.automaticRoutes || {};
            const routingDecision = { ...event.data, routes: automaticRoutes };
            if (!event.data.requiresChoice) {
              setDecisionData(routingDecision);
              void continueRoutedImportRef.current(automaticRoutes, routingDecision);
            } else {
              setStatus('decision');
              setDecisionData(routingDecision);
              setStatusMsg(event.message);
            }
          } else if (event.data?.need_split) {
            setStatus('decision');
            setDecisionData(event.data);
            setStatusMsg(event.message);
          }
          break;

        case 'success':
        case 'partial':
          {
            const importManifests = Array.isArray(event.data?.importManifests) ? event.data.importManifests as RendererMediaWorkflowImportManifest[] : [];
            if (importManifests.length) {
              try {
                setStatusMsg('正在保存媒体工作流关系…');
                await commitImportGraphs(importManifests);
              } catch (error) {
                const relationPendingCompletion = appendImportSuccess(importCompletion(), {
                  projectNames: event.data?.projectNames,
                  importedPathsByProject: event.data?.importedPathsByProject,
                  importedCount: event.data?.importedCount,
                  skipped: event.data?.skipped === true,
                  failedCount: event.data?.failedCount,
                  partialFailure: event.type === 'partial' || event.data?.partialFailure === true,
                  relationPending: true,
                  sourceType: currentDriveTypeRef.current,
                });
                isBusyRef.current = false;
                importRequestIdRef.current = '';
                currentStageRef.current = '';
                setStatus('completed');
                setCompletedProjectNames(relationPendingCompletion.projectNames);
                setCompletedOutcome(relationPendingCompletion.outcome);
                setCompletedDetail(describeImportCompletion(relationPendingCompletion));
                setStatusMsg(`文件已导入（关系待提交），媒体关系保存失败；将保留导入会话并重试：${error instanceof Error ? error.message : String(error)}`);
                setIsCancellingImport(false);
                void onImportCompleteRef.current?.(relationPendingCompletion);
                return;
              }
            }
            const skipped = event.data?.skipped === true;
            const importedCount = Number(event.data?.importedCount);
            if (Number.isFinite(importedCount) && importedCount > 0) {
              window.electronAPI.trackTelemetry('photos_imported', {
                count_bucket: importCountBucket(importedCount),
                source: currentDriveTypeRef.current === 'broll' ? 'sd_broll' : 'sd_work',
                media_kind: 'mixed',
              });
            }
            const completion = appendImportSuccess(importCompletion(), {
              projectNames: event.data?.projectNames,
              importedPathsByProject: event.data?.importedPathsByProject,
              importedCount: event.data?.importedCount,
              skipped,
              failedCount: event.data?.failedCount,
              partialFailure: event.type === 'partial' || event.data?.partialFailure === true,
              sourceType: currentDriveTypeRef.current,
            });
            importedProjectNamesRef.current = completion.projectNames;
            importedWorkProjectNamesRef.current = completion.workProjectNames;
            importedBrollProjectNamesRef.current = completion.brollProjectNames;
            importedPathsByProjectRef.current = completion.importedPathsByProject;
            importedCountRef.current = completion.importedCount;
            failedImportCountRef.current = completion.failedCount;
            const completedDrive = currentDriveRef.current;
            if (completedDrive && currentImportSessionKeyRef.current) {
              forgetCurrentImportSession('success');
            }
            if (skipped) {
              if (completedDrive && !skippedDrivesRef.current.includes(completedDrive)) skippedDrivesRef.current.push(completedDrive);
            } else {
              completedDriveCountRef.current += 1;
            }
            let nextDrive = importQueueRef.current.shift();
            while (nextDrive && !drivesRef.current.includes(nextDrive.path) && !hasPersistedImportSession(nextDrive.path, nextDrive.type)) {
              if (!failedDrivesRef.current.includes(nextDrive.path)) failedDrivesRef.current.push(nextDrive.path);
              nextDrive = importQueueRef.current.shift();
            }
            if (nextDrive) {
              setStatusMsg(skipped
                ? `${currentDriveRef.current} 没有符合条件的媒体，已跳过；接下来导入 ${nextDrive.path}`
                : `${currentDriveRef.current} 导入完成，接下来导入 ${nextDrive.path}`);
              setTimeout(() => startImportRef.current(nextDrive.path, nextDrive.type), 500);
            } else {
              const completion = importCompletion();
              const completedProjectNames = completion.projectNames;
              isBusyRef.current = false; // 【解锁】
              currentDriveRef.current = '';
              currentStageRef.current = '';
              importRequestIdRef.current = '';
              currentImportSessionKeyRef.current = '';
              stagingCompleteRef.current = false;
              importedProjectNamesRef.current = [];
              importedWorkProjectNamesRef.current = [];
              importedBrollProjectNamesRef.current = [];
              importedPathsByProjectRef.current = {};
              importedCountRef.current = 0;
              failedImportCountRef.current = 0;
              setStatus('completed');
              setProgress(100);
              setStatusMsg(failedDrivesRef.current.length
                ? `批量导入已结束：${completedDriveCountRef.current} 张卡完成，${failedDrivesRef.current.join('、')} 未完成，可重新插卡后续传`
                : skippedDrivesRef.current.length
                  ? `${completedDriveCountRef.current ? `${completedDriveCountRef.current} 张卡导入完成；` : ''}${skippedDrivesRef.current.join('、')} 没有符合条件的媒体，已跳过`
                  : completion.outcome === 'partial'
                    ? describeImportCompletion(completion)
                    : '导入完成');
              retryDrivePathsRef.current = failedDrivesRef.current.length ? [...failedDrivesRef.current] : [];
              setDecisionData(null);
              setCompletedProjectNames(completedProjectNames);
              setCompletedOutcome(completion.outcome);
              setCompletedDetail(describeImportCompletion(completion));
              setIsCancellingImport(false);
              void onImportCompleteRef.current?.(completion);
            }
          }
          break;

        case 'warning':
          break;

        case 'error':
          if (event.message.includes('旧暂存不会用于当前卡') || event.message.includes('检测到源文件已变化')) {
            forgetCurrentImportSession('session-invalid');
            currentImportSessionRef.current = '';
            currentImportSessionKeyRef.current = '';
          } else if (!directSource && currentDriveRef.current && (!drivesRef.current.includes(currentDriveRef.current) || event.message.includes('源设备可能已断开'))) {
            continueAfterDriveFailureRef.current(currentDriveRef.current, `设备 ${currentDriveRef.current} 读取失败`);
            break;
          }
          // 严重错误
          setStatusMsg("Error: " + event.message);
          setStatus('idle');
          importQueueRef.current = [];
          currentDriveRef.current = '';
          importRequestIdRef.current = '';
          currentStageRef.current = '';
          currentImportSessionRef.current = '';
          currentImportSessionKeyRef.current = '';
          stagingCompleteRef.current = false;
          isBusyRef.current = false; // 【解锁】
          cancelRequestedRef.current = false;
          setDecisionData(null);
          setTransferStats(null);
          setIsCancellingImport(false);
          break;

        case 'cancelled':
          setStatusMsg('导入已取消');
          setStatus('idle');
          importQueueRef.current = [];
          currentDriveRef.current = '';
          importRequestIdRef.current = '';
          currentStageRef.current = '';
          currentImportSessionRef.current = '';
          currentImportSessionKeyRef.current = '';
          stagingCompleteRef.current = false;
          isBusyRef.current = false;
          setDecisionData(null);
          setTransferStats(null);
          setIsCancellingImport(false);
          cancelRequestedRef.current = false;
          break;

        case 'complete':
          if (protocolState.terminal !== 'failed') break;
          setStatusMsg(`Error: ${protocolState.failureMessage}`);
          setStatus('idle');
          importQueueRef.current = [];
          currentDriveRef.current = '';
          importRequestIdRef.current = '';
          currentStageRef.current = '';
          currentImportSessionRef.current = '';
          currentImportSessionKeyRef.current = '';
          stagingCompleteRef.current = false;
          isBusyRef.current = false;
          setDecisionData(null);
          setTransferStats(null);
          setIsCancellingImport(false);
          break;
      }
    });

    return cleanup;
  }, [active, commitImportGraphs]);

  const runActualImport = async (routes: Record<string, string> = {}, routingDecision?: any) => {
    const type = currentDriveTypeRef.current;
    const usesProjectRouting = workspaceProjects !== undefined;
    const resolvedDestinationPath = usesProjectRouting ? destinationPath : type === 'broll' ? brollDestinationPath : destinationPath;
    if (!resolvedDestinationPath) {
      setStatus('idle');
      setStatusMsg('无法确定导入目录。');
      clearImportTerminalState();
      return;
    }
    let resolvedRoutes = routes;
    if (usesProjectRouting && Object.keys(routes).length) {
      try {
        const result = await window.electronAPI.getWorkspaceProjects(resolvedDestinationPath);
        if (!result.success) throw new Error(result.error || '无法刷新项目列表');
        const currentProjects = result.statuses.flatMap(group => group.projects).filter(project => project.availability !== 'missing');
        resolvedRoutes = Object.fromEntries(Object.entries(routes).map(([groupId, projectIdentity]) => {
          const legacyProject = (workspaceProjects || []).find(project => project.path === projectIdentity);
          const legacyPathName = /[\\/]/.test(projectIdentity) ? projectIdentity.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.toLocaleLowerCase('zh-CN') : '';
          const currentProject = currentProjects.find(project => project.id === projectIdentity
            || project.path === projectIdentity
            || legacyProject?.id === project.id
            || Boolean(legacyPathName && project.name.toLocaleLowerCase('zh-CN') === legacyPathName));
          if (!currentProject) throw new Error(`分组 ${groupId} 的目标项目已移动或删除`);
          return [groupId, currentProject.path];
        }));
      } catch (error) {
        setStatus('decision');
        setDecisionData((current: any) => ({ ...(current || routingDecision || { kind: 'project_routing', groups: [] }), routes: {} }));
        setStatusMsg(`${error instanceof Error ? error.message : String(error)}，请重新选择目标项目。`);
        return;
      }
    }
    setStatus('processing');
    setProgress(0);
    setDecisionData(null);
    const args = ['--sd_path', currentDriveRef.current || selectedDrives[0] || config?.sdPath || '', '--dest_path', resolvedDestinationPath];
    if (Object.keys(resolvedRoutes).length) args.push('--project_routes', JSON.stringify(resolvedRoutes));
    if (!usesProjectRouting) args.push('--direct_project');
    const videoActions = videoActionsForDrive(currentDriveRef.current || selectedDrives[0] || '', type);
    if (videoActions.splitVideosOnImport) args.push('--split_import_videos');
    if (videoActions.transcodeVideosOnImport && transcodeSettings) args.push('--transcode_import_videos', '--transcode_settings', JSON.stringify(transcodeSettings));
    runCmd(type === 'broll' ? 'broll' : 'import', args);
  };
  continueRoutedImportRef.current = runActualImport;

  const startImport = (sdPath = selectedDrives[0], type: 'work' | 'broll' = driveTypes[sdPath] || 'work') => {
    const usesProjectRouting = workspaceProjects !== undefined;
    const resolvedDestinationPath = usesProjectRouting ? destinationPath : type === 'broll' ? brollDestinationPath : destinationPath;
    if (!resolvedDestinationPath) {
      if (type === 'broll') {
        setStatusMsg('请先选择花絮要导入的目标项目。');
        return;
      }
      setStatusMsg('无法确定导入项目，请先设置工作目录。');
      return;
    }
    if (isBusyRef.current && !currentDriveRef.current) {
        console.log("Import already running, skipped.");
        return;
    }

    isBusyRef.current = true; // 【上锁】
    const sessionKey = importSessionKeyFor(sdPath, type);
    const persistedSession = readPersistedImportSessions()[sessionKey];
    const resumableSession = driveImportSessionsRef.current.get(sessionKey) || persistedSession?.session || crypto.randomUUID();
    driveImportSessionsRef.current.set(sessionKey, resumableSession);
    persistImportSession(sessionKey, resumableSession);
    currentImportSessionKeyRef.current = sessionKey;
    currentImportSessionRef.current = resumableSession;
    currentDriveRef.current = sdPath;
    currentDriveTypeRef.current = type;
    stagingCompleteRef.current = persistedSession?.stagingComplete === true && !drivesRef.current.includes(sdPath);
    setStatus(usesProjectRouting ? 'processing' : 'importing');
    setProgress(0);
    setTransferStats(null);
    setLogs([]); // 清空日志准备开始
    setStatusMsg(type === 'broll' ? `正在把 ${sdPath} 导入“花絮”` : `正在整理 ${sdPath} 的原始素材`);

    if (usesProjectRouting) {
      setStatusMsg('正在导入素材…');
      runCmd('plan', ['--sd_path', sdPath, '--dest_path', resolvedDestinationPath, '--import_type', type, '--projects_json', JSON.stringify(workspaceProjects)]);
    } else {
      void runActualImport();
    }
  };
  startImportRef.current = startImport;

  const startBatchImport = (requestedSelections?: Array<{ path: string; type: 'work' | 'broll' }>, mode: 'manual' | 'startup' = 'manual') => {
    if (isBusyRef.current) return false;
    const requested = requestedSelections?.length
      ? requestedSelections
      : (retryDrivePathsRef.current.length
        ? selectedDrives.filter(drive => retryDrivePathsRef.current.includes(drive))
        : selectedDrives).map(path => ({ path, type: driveTypes[path] || 'work' as const }));
    const connected = requested.filter(item => drives.includes(item.path) || hasPersistedImportSession(item.path, item.type));
    if (!connected.length) {
      setStatusMsg(retryDrivePathsRef.current.length ? `等待 ${retryDrivePathsRef.current.join('、')} 重新接入后续传` : '所选 SD 卡均未连接');
      return false;
    }
    handledStartupAutoImportRef.current = handledStartupRequestAfterBatchStart(
      startupAutoImportRequest,
      handledStartupAutoImportRef.current,
      mode,
    );
    retryDrivePathsRef.current = [];
    const queue = directSource
      ? [{ path: connected[0].path, type: 'work' as const }]
      : connected;
    importQueueRef.current = queue.slice(1);
    importedProjectNamesRef.current = [];
    importedWorkProjectNamesRef.current = [];
    importedBrollProjectNamesRef.current = [];
    importedPathsByProjectRef.current = {};
    importedCountRef.current = 0;
    failedImportCountRef.current = 0;
    completedDriveCountRef.current = 0;
    failedDrivesRef.current = [];
    skippedDrivesRef.current = [];
    cancelRequestedRef.current = false;
    stagingCompleteRef.current = false;
    importBatchModeRef.current = mode;
    setIsCancellingImport(false);
    currentDriveRef.current = '';
    startImport(queue[0].path, queue[0].type);
    return true;
  };
  startBatchRef.current = startBatchImport;

  useEffect(() => {
    const decision = decideStartupSdAutoImport({
      active,
      directSource,
      request: startupAutoImportRequest,
      handledRequest: handledStartupAutoImportRef.current,
      ready: startupAutoImportReady,
      busy: isBusyRef.current,
      selectionCount: startupAutoImportSelections.length,
      now: Date.now(),
    });
    if (decision === 'wait') {
      if (startupAutoImportError) setStatusMsg(`启动自动导入正在重试：${startupAutoImportError}`);
      return;
    }
    if (decision === 'wait-for-device') {
      if (!selectedDrives.length) {
        setStatusMsg('启动自动导入尚未配置 SD 卡；请先从盘符列表选择设备');
        return;
      }
      const needsEnrollment = selectedDrives.some(path => {
        const connectedDevice = storageDevices.find(device => device.mountPath === path);
        const record = connectedDevice && normalizeConfiguredSdDeviceRecords(config?.sdDevices).find(item => storageDeviceMatchesId(connectedDevice, item.deviceId));
        return Boolean(connectedDevice && isTrustedSdImportDevice(connectedDevice) && (!record || record.confirmedAt <= 0 || !record.enabled));
      });
      setStatusMsg(needsEnrollment ? '已有 SD 卡配置需要重新确认设备身份；请打开盘符列表并点击对应卡片' : '正在等待已启用的 SD 卡接入…');
      return;
    }
    if (decision === 'expired') {
      handledStartupAutoImportRef.current = startupAutoImportRequest?.id || 0;
      setStatusMsg('启动自动导入等待已结束；之后插入的 SD 卡需要手动导入');
      return;
    }
    if (decision !== 'start') return;
    if (startBatchRef.current(startupAutoImportSelections, 'startup')) {
      handledStartupAutoImportRef.current = startupAutoImportRequest?.id || 0;
      setStatusMsg('启动自动导入已开始；本次将保留 SD 卡源文件');
    }
  }, [active, config?.sdDevices, directSource, selectedDrives, startupAutoImportError, startupAutoImportReady, startupAutoImportRequest, startupAutoImportSelections, storageDevices]);

  const handleDecision = (split: boolean) => {
    setStatus('processing');
    setProgress(0);
    const args = [];
    if (config) {
      const resolvedDestinationPath = currentDriveTypeRef.current === 'broll' ? brollDestinationPath : destinationPath;
      if (!resolvedDestinationPath) {
        setStatus('idle');
        setStatusMsg(currentDriveTypeRef.current === 'broll' ? '请先选择花絮要导入的目标项目。' : '无法确定导入目录。');
        clearImportTerminalState();
        return;
      }
      args.push('--sd_path', currentDriveRef.current || selectedDrives[0] || config.sdPath);
      args.push('--dest_path', resolvedDestinationPath);
      const videoActions = videoActionsForDrive(currentDriveRef.current || selectedDrives[0] || '', currentDriveTypeRef.current);
      if (videoActions.splitVideosOnImport) args.push('--split_import_videos');
      if (videoActions.transcodeVideosOnImport && transcodeSettings) args.push('--transcode_import_videos', '--transcode_settings', JSON.stringify(transcodeSettings));
      // 添加用户决定的参数
      args.push('--should_split', split ? 'true' : 'false');
    }

    // 重新启动导入流程（因为临时文件已经存在，所以会很快）
    runCmd(currentDriveTypeRef.current === 'broll' ? 'broll' : 'import', args);
  };

  const confirmProjectRoutes = () => {
    const groups = Array.isArray(decisionData?.groups) ? decisionData.groups : [];
    const routes = decisionData?.routes || {};
    if (groups.some((group: any) => !routes[group.id])) {
      setStatusMsg('请为每个拍摄时间段选择项目。');
      return;
    }
    void runActualImport(routes);
  };

  // --- 渲染逻辑 (UI 部分) ---

  if (status === 'idle' || status === 'checking') {
    // 实时判断当前配置的盘符是否插在电脑上
    const connectedDrives = selectedDrives.filter(drive => drives.includes(drive));
    const resumableDrives = selectedDrives.filter(drive => !drives.includes(drive) && hasPersistedImportSession(drive, driveTypes[drive] || 'work'));
    const isConnected = connectedDrives.length > 0;
    const canStartImport = isConnected || resumableDrives.length > 0;

    // 动态判断显示的副标题
    let displayMsg = statusMsg;
    if (status === 'idle') {
      if (statusMsg.startsWith('Error:') || statusMsg.includes('已断开') || statusMsg.startsWith('启动自动导入') || statusMsg.startsWith('正在等待已启用') || statusMsg.startsWith('已有 SD 卡配置')) {
        displayMsg = statusMsg;
      } else if (directSource) {
        displayMsg = selectedDrives.length
          ? `已选择 ${selectedDrives.length} 个来源，点击右侧按钮开始导入`
          : '请选择要导入的原始素材文件或文件夹';
      } else if (!selectedDrives.length) {
        displayMsg = "请选择 SD 卡盘符";
      } else if (isConnected) {
        displayMsg = `已连接 ${connectedDrives.length}/${selectedDrives.length} 张卡，点击右侧按钮批量导入`;
      } else if (resumableDrives.length) {
        displayMsg = `已找到 ${resumableDrives.length} 个本地暂存，可在 SD 卡断开时继续分类`;
      } else {
        displayMsg = `等待 ${selectedDrives.join('、')} 接入...`;
      }
    } else if (status === 'checking') {
      displayMsg = `正在准备读取 ${selectedDrives[0] || ''}...`;
    }

    // 动态图标颜色 (扫描中是蓝色，已连接是绿色，未连接是灰色)
    const iconColorClass = status === 'checking'
        ? 'bg-blue-50 text-blue-600'
        : isConnected
            ? 'bg-emerald-50 text-emerald-600'
            : 'bg-slate-100 text-slate-500';

    if (directSource && status === 'idle') return <ImportSourceControls
      selectionTitle="选择一个或多个原始素材文件，或选择素材文件夹"
      selectionDescription="可直接拖入文件或文件夹，也可使用下方选择入口"
      selectedPaths={selectedDrives}
      onSelectedPathsChange={paths => onDropSourcePaths?.(paths)}
      onChooseFiles={() => onChooseSourceFiles?.()}
      onChooseFolder={onChooseSourceFolder ? () => onChooseSourceFolder() : undefined}
      importKind={importKind}
      onImportKindChange={kind => onImportKindChange?.(kind, selectedDrives)}


      deleteSourceAfterImport={shouldDeleteSourceAfterImport}
      onDeleteSourceAfterImportChange={setShouldDeleteSourceAfterImport}
      deleteSourceDescription="全部文件复制并验证成功后删除源文件；关闭则保留。"
      startDisabled={!canStartImport}
      onStart={startBatchImport}
    />;

    return (
      <div className="w-full space-y-3">
      <div className="w-full bg-white/50 border border-slate-200 rounded-xl p-4 flex items-center justify-between animate-in fade-in transition-all">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg transition-colors ${iconColorClass}`}>
            {status === 'checking' ? <Loader2 className="animate-spin" size={18} /> : <HardDrive size={18} />}
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-bold text-slate-800">{directSource ? '导入原始素材' : '从 SD 卡导入媒体'}</span>
            <span className="text-xs text-slate-500">{displayMsg}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!directSource && <div ref={drivePickerRef} className="relative" onClick={event => event.stopPropagation()}>
            <button type="button" aria-haspopup="menu" aria-expanded={drivePickerOpen} onClick={() => setDrivePickerOpen(open => !open)} className="flex h-9 min-w-36 items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:border-blue-400"><span className="max-w-40 truncate">{selectedDrives.length ? `已选 ${selectedDrives.length} 个盘符` : '选择盘符'}</span><ChevronDown size={15} className={`transition-transform ${drivePickerOpen ? 'rotate-180' : ''}`}/></button>
            {drivePickerOpen && <div role="menu" className="absolute right-0 top-full z-50 mt-1 max-h-64 min-w-72 overflow-y-auto rounded-lg border border-slate-200 bg-white p-2 shadow-xl">
              {[...new Set([...selectedDrives, ...drives])].map(drive => <div key={drive} className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-slate-50"><label className="flex min-w-0 cursor-pointer items-center gap-2"><input type="checkbox" checked={selectedDrives.includes(drive)} onChange={() => toggleDrive(drive)}/><span className="font-mono">{drive}</span></label><select aria-label={`${drive} 导入类型`} value={driveTypes[drive] || 'work'} onChange={event => setDriveType(drive, event.target.value as 'work' | 'broll')} className="ml-auto rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600" disabled={!selectedDrives.includes(drive)}><option value="work">原始素材</option><option value="broll">花絮</option></select><span className={`text-xs ${drives.includes(drive) ? 'text-emerald-600' : 'text-slate-400'}`}>{drives.includes(drive) ? '已连接' : '未连接'}</span></div>)}
              {!drives.length && !selectedDrives.length && <p className="px-2 py-1 text-xs text-slate-500">未检测到可用盘符</p>}
            </div>}
          </div>}
          {canStartImport && status === 'idle' ? (
            <button onClick={() => startBatchImport()} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-bold flex items-center gap-2 shadow-md shadow-blue-500/20 transition-all animate-in zoom-in-95"><Download size={16} />{directSource ? '开始导入' : connectedDrives.length > 1 ? '批量导入' : '开始导入'}</button>
          ) : (
            <button disabled className={`p-2 rounded-lg transition ${status === 'checking' ? 'text-blue-500' : 'text-slate-300 bg-slate-50 cursor-not-allowed'}`}><RotateCcw size={18} className={status === 'checking' ? 'animate-spin' : ''} /></button>
          )}
        </div>
      </div>
      {status === 'idle' && <>
        <PanelSwitch title="导入后删除源文件" description={`全部文件复制并验证成功后删除${directSource ? '所选原始素材' : 'SD 卡媒体'}；关闭则保留。`} checked={shouldDeleteSourceAfterImport} onChange={setShouldDeleteSourceAfterImport}/>
      </>}
      </div>
    );
  }

  return (
    <div className="w-full space-y-4">
      {/* 主卡片 */}
      <div className="bg-white/50 border border-slate-200 rounded-xl p-6 flex flex-col relative overflow-hidden min-h-[250px] animate-in slide-in-from-top-2">
        {/* 顶部标题栏 */}
        <div className="flex justify-between items-center mb-6 z-10">
          <h3 className="text-lg font-semibold text-blue-200 flex items-center gap-2">
            <FolderInput size={20} />
            {directSource ? '导入原始素材' : '从 SD 卡导入媒体'}
          </h3>
          <span className="text-xs px-2 py-1 rounded border font-mono bg-blue-500/20 text-blue-300 border-blue-500/30">
            {status.toUpperCase().replace('_', ' ')}
          </span>
        </div>

        {/* 背景装饰 */}
        <div className="absolute top-0 left-0 p-24 bg-blue-500/5 blur-3xl rounded-full pointer-events-none"></div>

        {/* 内容区域 */}
        <div className="flex-1 flex flex-col justify-center items-center text-center space-y-4 z-10 w-full">

          {/* State: Ready */}
          {status === 'completed' && (
            <div className="flex w-full max-w-xl flex-col items-center">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                <CheckCircle2 size={34} />
              </div>
              <p className="text-lg font-bold text-slate-800">{{ success: '导入完成', partial: '部分导入完成', skipped: '本次导入已跳过', 'relation-pending': '文件已导入，关系待提交' }[completedOutcome]}</p>
              <p className="mt-1 text-sm text-slate-500">
                {completedOutcome === 'relation-pending'
                  ? completedDetail
                  : completedOutcome === 'partial'
                    ? completedDetail
                    : completedOutcome === 'skipped'
                      ? completedDetail
                      : completedProjectNames.length
                  ? `素材已导入到 ${completedProjectNames.length} 个项目。`
                  : directSource ? '所选原始素材已成功导入。' : '所选 SD 卡素材已成功导入。'}
              </p>
              {transferStats && <p className="mt-2 text-xs font-medium tabular-nums text-slate-500">
                共导入 {formatTransferBytes(transferStats.totalBytes || transferStats.bytesCopied)}
                {transferStats.totalFiles ? ` · ${transferStats.totalFiles} 个文件` : ''}
              </p>}
              <button type="button" onClick={() => { resetCompletedImport(); onCompletedAction?.(); }} className="dialog-primary mt-5">{completedActionLabel}</button>
            </div>
          )}

          {/* State: Ready */}
          {status === 'ready_to_import' && (
            <div className="flex flex-col items-center w-full">
              <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mb-4 text-blue-600">
                <Loader2 className="animate-spin" size={32} />
              </div>
              <p className="text-slate-800 font-bold text-lg mb-1">准备导入...</p>
              <p className="text-slate-500 text-sm mb-6">{statusMsg}</p>
            </div>
          )}

          {/* State: Progress (Importing or Processing) */}
          {(status === 'importing' || status === 'processing') && (
            <div className="w-full max-w-xl">
              <TaskProgress logs={logs} progress={progress} isRunning idleMessage={statusMsg} reportToTaskCenter={false} />
              {transferStats && <p className="mt-2 text-center text-xs font-medium tabular-nums text-slate-500">
                已导入 {formatTransferBytes(transferStats.bytesCopied)} / {formatTransferBytes(transferStats.totalBytes)}
                {transferStats.bytesPerSecond > 0 ? ` · ${formatTransferBytes(transferStats.bytesPerSecond)}/s` : ''}
                {transferStats.totalFiles ? ` · ${transferStats.filesCopied || 0}/${transferStats.totalFiles} 个文件` : ''}
              </p>}
              <button type="button" onClick={() => void cancelImport()} disabled={isCancellingImport} className="dialog-secondary mt-4 inline-flex items-center gap-2 disabled:opacity-50">{isCancellingImport && <Loader2 size={15} className="animate-spin"/>}{isCancellingImport ? '正在取消…' : '取消导入'}</button>
            </div>
          )}

          {/* State: Decision */}
          {status === 'decision' && decisionData && (
            <div className="w-full bg-slate-50/80 p-5 rounded-xl border border-yellow-500/20 text-left animate-in zoom-in-95">
              <h4 className="text-slate-800 font-bold mb-2 flex items-center gap-2">
                <AlertCircle className="text-yellow-400" size={20} />
                需确认操作
              </h4>
              {decisionData.kind === 'project_routing' ? <>
                <p className="mb-4 text-sm text-slate-500">请为各拍摄时段选择目标项目；可选择同一项目。</p>
                {decisionData.stagingComplete && currentDriveRef.current && !drives.includes(currentDriveRef.current) && <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">设备已断开，仍可继续分类；本次不会删除卡内源文件。</p>}
                <div className="mb-5 max-h-72 space-y-3 overflow-y-auto pr-1">{decisionData.groups.map((group: any) => {
                  const suggestedIds = new Set<string>(group.suggestedProjectIds || []);
                  const suggestedPaths = new Set<string>(group.suggestedProjectPaths || []);
                  const isSuggested = (project: WorkspaceProject) => suggestedIds.has(project.id) || suggestedPaths.has(project.path);
                  const orderedProjects = [...(workspaceProjects || [])].sort((left, right) => Number(isSuggested(right)) - Number(isSuggested(left)));
                  const selectedIdentity = decisionData.routes?.[group.id] || '';
                  const selectedProjectId = orderedProjects.find(project => project.id === selectedIdentity || project.path === selectedIdentity)?.id || selectedIdentity;
                  return <label key={group.id} className="block rounded-lg border border-slate-200 bg-white p-3"><span className="block text-sm font-bold text-slate-700">{group.date} · {group.startTime}–{group.endTime} · {group.count} 个文件</span><select value={selectedProjectId} onChange={event => setDecisionData((current: any) => ({ ...current, routes: { ...(current?.routes || {}), [group.id]: event.target.value } }))} className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"><option value="">请选择目标项目…</option>{orderedProjects.map(project => <option key={project.id} value={project.id}>{isSuggested(project) ? '建议 · ' : ''}{project.name} · {project.status}</option>)}</select></label>;
                })}</div>
                <button onClick={confirmProjectRoutes} className="w-full rounded-lg bg-blue-600 py-2 text-sm font-bold text-white hover:bg-blue-500">确认归属并开始导入</button>
              </> : <><p className="text-slate-500 text-sm mb-6">
                检测到多个拍摄时段，是否分别保存？
              </p>
              <div className="flex gap-3">
                <button
                    onClick={() => handleDecision(true)}
                    className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-slate-800 py-2 rounded-lg text-sm transition-colors"
                >
                    分别保存
                </button>
                <button
                    onClick={() => handleDecision(false)}
                    className="flex-1 bg-slate-700 hover:bg-slate-600 text-slate-900 py-2 rounded-lg text-sm transition-colors"
                >
                    合并保存
                </button>
              </div></>}
              <button type="button" onClick={() => void cancelImport()} className="mt-3 w-full rounded-lg border border-slate-200 bg-white py-2 text-sm font-bold text-slate-600 hover:bg-slate-100">取消本次导入</button>
            </div>
          )}

        </div>
      </div>

    </div>
  );
};

const BirthdayManagerModal = ({ onClose, onDataChanged }: { onClose: () => void, onDataChanged: () => void }) => {
  const appDialog = useAppDialog();
  useEscapeLayer(true, onClose);
  const [birthdays, setBirthdays] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [newMonth, setNewMonth] = useState('');
  const [newDay, setNewDay] = useState('');
  const [formError, setFormError] = useState('');

  useEffect(() => {
    const load = async () => {
      if (window.electronAPI) {
        const data = await window.electronAPI.getBirthdays();
        setBirthdays(data || {});
        setLoading(false);
      }
    };
    load();
  }, []);

  const sortedBirthdays = Object.entries(birthdays).sort(([, dateA], [, dateB]) => {
    const parse = (d: string) => {
       const match = d.trim().match(/^(\d{1,2})(?:\.|月\.?)(\d{1,2})日?$/);
       return { m: Number(match?.[1] || 0), d: Number(match?.[2] || 0) };
    };
    const a = parse(dateA);
    const b = parse(dateB);
    if (a.m !== b.m) return a.m - b.m;
    return a.d - b.d;
  });

  const handleSave = async () => {
    const name = newName.trim();
    const month = Number(newMonth);
    const day = Number(newDay);
    if (!name) { setFormError('请输入姓名。'); return; }
    if (!Number.isInteger(month) || month < 1 || month > 12) { setFormError('月份必须是 1–12 的整数。'); return; }
    if (!Number.isInteger(day) || day < 1 || day > 31) { setFormError('日期必须是 1–31 的整数。'); return; }
    const probe = new Date(2000, month - 1, day);
    if (probe.getMonth() !== month - 1 || probe.getDate() !== day) { setFormError('该月份中不存在这个日期。'); return; }
    const dateStr = `${month}.${day}`;
    const newData = { ...birthdays, [name]: dateStr };

    if (window.electronAPI) {
      const result = await window.electronAPI.saveBirthdays(newData);
      if (!result.success) { setFormError(`保存失败：${result.error || '未知错误'}`); return; }
      setBirthdays(newData);
      setNewName('');
      setNewMonth('');
      setNewDay('');
      setFormError('');
      onDataChanged();
    }
  };

  const handleDelete = async (name: string) => {
    if (!await appDialog.confirm({
      title: `确定删除“${name}”吗？`,
      message: '该生日记录将被删除。',
      confirmLabel: '删除记录',
      tone: 'danger',
    })) return;
    const newData = { ...birthdays };
    delete newData[name];
    if (window.electronAPI) {
      await window.electronAPI.saveBirthdays(newData);
      setBirthdays(newData);
      onDataChanged();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-50/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="absolute inset-0" onClick={onClose}></div>
      <div role="dialog" aria-modal="true" aria-label="生日列表" className="bg-white border border-slate-200 w-full max-w-2xl rounded-2xl shadow-2xl flex flex-col max-h-[80vh] relative z-10">
        <div className="p-6 border-b border-slate-200 flex justify-between items-center bg-slate-200 rounded-t-2xl">
          <div><h3 className="text-xl font-bold text-slate-800">生日列表</h3></div>
          <button onClick={onClose} className="p-2 hover:bg-slate-700 rounded-full text-slate-500 hover:text-slate-800 transition cursor-pointer"><X size={24} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-2">
          {loading ? <div className="text-center text-slate-500">Loading...</div> :
           sortedBirthdays.map(([name, date]) => (
            <div key={name} className="flex items-center justify-between bg-slate-50 p-3 rounded-lg border border-slate-200 group">
               <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-indigo-500/10 flex items-center justify-center text-indigo-400"><User size={14} /></div>
                  <div><div className="font-medium text-slate-900">{name}</div><div className="text-xs text-slate-500">{date}</div></div>
               </div>
               <button onClick={() => handleDelete(name)} className="opacity-0 group-hover:opacity-100 p-2 text-slate-500 hover:text-red-400 transition"><Trash2 size={16} /></button>
            </div>
          ))}
        </div>
        <div className="p-6 border-t border-slate-200 bg-white rounded-b-2xl">
           <div className="flex gap-3">
              <input placeholder="Name" value={newName} onChange={e => setNewName(e.target.value)} className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-4 py-2 text-slate-800" />
              <input aria-label="月份" placeholder="月" type="number" min="1" max="12" step="1" value={newMonth} onChange={e => { setNewMonth(e.target.value); setFormError(''); }} className="w-20 bg-slate-50 border border-slate-200 rounded-lg px-2 py-2 text-center text-slate-800" />
              <input aria-label="日期" placeholder="日" type="number" min="1" max="31" step="1" value={newDay} onChange={e => { setNewDay(e.target.value); setFormError(''); }} className="w-20 bg-slate-50 border border-slate-200 rounded-lg px-2 py-2 text-center text-slate-800" />
              <button onClick={handleSave} className="bg-blue-500 text-white px-4 py-2 rounded-lg flex items-center gap-2"><Plus size={16} /> 添加</button>
           </div>
           {formError && <p role="alert" className="mt-2 text-sm text-red-600">{formError}</p>}
        </div>
      </div>
    </div>
  );
};

type HomePanelDragProps = Pick<React.ComponentProps<'button'>, 'draggable' | 'onDragStart' | 'onDragEnd' | 'onDragOver' | 'onDrop'>;

const parseBirthday = (dateStr: string) => {
  const match = dateStr.trim().match(/^(\d{1,2})(?:\.|月\.?)(\d{1,2})日?$/);
  return { month: Number(match?.[1] || 0), day: Number(match?.[2] || 0) };
};

const upcomingBirthdaysFrom = (data: Record<string, string>, today = new Date()) => {
  const todayZero = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const currentMonth = today.getMonth() + 1;
  const nextMonth = (currentMonth % 12) + 1;
  const results: {name: string, date: string, sortKey: number}[] = [];
  for (const [name, dateStr] of Object.entries(data)) {
    const { month, day } = parseBirthday(dateStr);
    const probe = new Date(2000, month - 1, day);
    if (month < 1 || month > 12 || day < 1 || day > 31 || probe.getMonth() !== month - 1 || probe.getDate() !== day) continue;
    if (month !== currentMonth && month !== nextMonth) continue;
    let targetYear = today.getFullYear();
    if (currentMonth === 12 && month === 1) targetYear += 1;
    const birthdayDate = new Date(targetYear, month - 1, day);
    if (birthdayDate < todayZero) continue;
    results.push({ name, date: `${month}月${day}日`, sortKey: birthdayDate.getTime() });
  }
  return results.sort((left, right) => left.sortKey - right.sortKey);
};

const DashboardView = ({
  workspacePath,
  section = 'all',
  active = true,
  startupAutoImportRequest = null,
  config,
  importDefaults,
  brollConfig,
  videoTools,
  videoToolsAvailable = true,
  projectDestination,
  projectName,
  onImportConfigChange,
  onImportComplete,
  initialBirthdays,
  dragProps
}: {
  workspacePath: string;
  section?: 'all' | 'import' | 'birthday';
  active?: boolean;
  startupAutoImportRequest?: StartupSdAutoImportRequest | null;
  config: AppConfig['smartImport'];
  importDefaults: AppConfig['importDefaults'];
  brollConfig: AppConfig['brollImport'];
  videoTools: AppConfig['videoTools'];
  videoToolsAvailable?: boolean;
  projectDestination?: string | null;
  projectName?: string;
  onImportConfigChange: (config: AppConfig['smartImport']) => void;
  onImportComplete?: (result: ImportCompletion) => void | Promise<void>;
  initialBirthdays?: Record<string, string>;
  dragProps?: HomePanelDragProps;
}) => {
  // 生日逻辑保持不变
  const [upcomingBirthdays, setUpcomingBirthdays] = useState<{name: string, date: string, sortKey: number}[]>(() => upcomingBirthdaysFrom(initialBirthdays || {}));
  const [loading, setLoading] = useState(!initialBirthdays);
  const [showManager, setShowManager] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [workspaceProjects, setWorkspaceProjects] = useState<WorkspaceProject[]>([]);
  const [workspaceProjectsLoaded, setWorkspaceProjectsLoaded] = useState(Boolean(projectDestination));
  const [workspaceProjectsError, setWorkspaceProjectsError] = useState<string | null>(null);
  const [importPanelOpen, setImportPanelOpen] = useState(true);
  const storageInventory = useStorageDeviceInventory(shouldPollStorageDeviceInventory({
    section,
    active,
    busy: importBusy,
    panelOpen: importPanelOpen,
    startupRequest: startupAutoImportRequest,
  }));
  const storageInventoryFresh = isFreshStorageDeviceInventory(storageInventory, Date.now());
  const lastKnownStorageDevices = useMemo(() => storageInventory.devices.filter(device => device.eligibleForSdImport), [storageInventory.devices]);
  const storageDevices = useMemo(() => storageInventoryFresh ? lastKnownStorageDevices : [], [lastKnownStorageDevices, storageInventoryFresh]);
  const drives = useMemo(() => storageDevices.map(device => device.mountPath), [storageDevices]);
  const startupAutoImportSelections = useMemo(() => resolveConfiguredSdDevices(config, storageDevices).map(device => ({ path: device.mountPath, type: device.type })), [config, storageDevices]);

  useEffect(() => {
    if (storageInventory.status !== 'ready') return;
    const reconciled = reconcileConfiguredSdDevices(config, storageDevices);
    if (reconciled !== config) onImportConfigChange(reconciled);
  }, [config, onImportConfigChange, storageDevices, storageInventory.status]);

  useEffect(() => {
    if (section === 'birthday' || (!active && !importBusy)) return;
    if (projectDestination || !workspacePath) {
      setWorkspaceProjectsLoaded(Boolean(projectDestination));
      setWorkspaceProjectsError(workspacePath ? null : '未设置工作区目录');
      return;
    }
    let mounted = true;
    let projectLoadRunning = false;
    let retryTimer: number | undefined;
    const scheduleRetry = () => {
      if (!mounted || retryTimer !== undefined) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        void loadProjects();
      }, 2500);
    };
    async function loadProjects(fresh = false, cachedOnly = false) {
      if (projectLoadRunning) return;
      projectLoadRunning = true;
      try {
        const result = cachedOnly ? readWorkspaceCatalogSnapshot(workspacePath) || await getWorkspaceCatalog(workspacePath) : await getWorkspaceCatalog(workspacePath, { fresh });
        if (!mounted) return;
        if (!result.success) throw new Error(result.error || '无法读取工作区项目');
        if (retryTimer !== undefined) window.clearTimeout(retryTimer);
        retryTimer = undefined;
        const projects = result.statuses.flatMap(group => group.projects);
        setWorkspaceProjects(projects);
        setWorkspaceProjectsLoaded(true);
        setWorkspaceProjectsError(null);
      } catch (error) {
        if (!mounted) return;
        setWorkspaceProjectsLoaded(false);
        setWorkspaceProjectsError(error instanceof Error ? error.message : String(error));
        scheduleRetry();
      } finally {
        projectLoadRunning = false;
      }
    }
    void loadProjects();
    const refreshProjects = () => { void loadProjects(true); };
    const snapshotChanged = (event: Event) => { if (workspaceCatalogEventMatches(event, workspacePath)) void loadProjects(false, true); };
    const unsubscribe = window.electronAPI.onWorkspaceProjectsChanged(refreshProjects);
    window.addEventListener('workspace-catalog-snapshot-changed', snapshotChanged);
    return () => {
      mounted = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      unsubscribe();
      window.removeEventListener('workspace-catalog-snapshot-changed', snapshotChanged);
    };
  }, [active, importBusy, projectDestination, section, workspacePath]);

  const fetchBirthdays = async () => {
    if (!window.electronAPI) return;
    try {
      setLoading(true);
      const data = await window.electronAPI.getBirthdays();
      setUpcomingBirthdays(upcomingBirthdaysFrom(data));
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (section === 'import') return;
    if (initialBirthdays) {
      setUpcomingBirthdays(upcomingBirthdaysFrom(initialBirthdays));
      setLoading(false);
      return;
    }
    void fetchBirthdays();
  }, [initialBirthdays, section]);

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {projectDestination && <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700">当前项目：<strong>{projectName || projectDestination}</strong>{projectDestination.endsWith("花絮") ? " · 导入花絮" : " · 从 SD 卡导入"}</div>}
      {showManager && (
        <BirthdayManagerModal
          onClose={() => setShowManager(false)}
          onDataChanged={fetchBirthdays}
        />
      )}

      {section !== 'birthday' && <HomePanel title="从 SD 卡导入" initiallyOpen onOpenChange={setImportPanelOpen} {...dragProps}>
        <div className="flex flex-col gap-6">
          {storageInventory.warning && <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">{storageInventory.warning}{storageInventory.deviceErrors.length ? `；故障位置：${storageInventory.deviceErrors.map(item => item.mountPath || '未知设备').join('、')}` : ''}</div>}
          {!storageInventoryFresh && lastKnownStorageDevices.length > 0 && <div role="status" className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">设备清单正在刷新或读取失败；仅展示上次检测到的 {lastKnownStorageDevices.length} 个设备，暂不能开始手动导入。</div>}
          <ImportCard config={config} drives={drives} storageDevices={storageDevices} workspacePath={workspacePath} destinationPath={projectDestination ?? workspacePath} brollDestinationPath={projectDestination} workspaceProjects={projectDestination ? undefined : workspaceProjects} active={active} startupAutoImportRequest={startupAutoImportRequest} startupAutoImportReady={storageInventoryFresh && (Boolean(projectDestination) || workspaceProjectsLoaded)} startupAutoImportError={storageInventory.error || workspaceProjectsError} startupAutoImportSelections={startupAutoImportSelections} deleteSourceAfterImport={importDefaults.deleteSourceAfterImport} generateJpgFromRaw={importDefaults.generateJpgFromRaw} splitVideosOnImport={importDefaults.splitVideosOnImport} transcodeVideosOnImport={importDefaults.transcodeVideosOnImport} splitBrollVideosOnImport={brollConfig.splitVideosOnImport} transcodeBrollVideosOnImport={brollConfig.transcodeVideosOnImport} transcodeSettings={videoTools.transcode} videoToolsAvailable={videoToolsAvailable} onBusyChange={setImportBusy} onImportConfigChange={onImportConfigChange} onImportComplete={projectDestination ? undefined : result => { void onImportComplete?.(result); }} completedActionLabel="刷新卡片" />
        </div>
      </HomePanel>}
      {section !== 'import' && <HomePanel title="角色生日" initiallyOpen tone="birthday" {...dragProps}>
        <div className="space-y-3">
          <div className="flex justify-between items-start">
              <h3 className="text-sm font-semibold text-slate-600 flex items-center gap-1.5">
                <span className="text-base">🎂</span> 角色生日
              </h3>
          </div>

          <div className="">
              {loading ? (
                <div className="text-indigo-400 text-sm">Loading birthdays...</div>
              ) : upcomingBirthdays.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pr-1">
                  {upcomingBirthdays.map((b, i) => (
                    // 内部小卡片改为白底，hover 时稍微加深
                    <div key={i} className="flex items-center justify-between bg-white/80 p-2.5 rounded-md border border-blue-100 hover:border-blue-200 transition group">
                      <div className="flex items-center gap-3">
                        <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-[10px]">{b.name.charAt(0)}</div>
                        {/* 名字文字加深 */}
                        <span className="text-sm font-medium text-slate-700 pr-2 leading-snug">{b.name}</span>
                      </div>
                      <span className="flex-shrink-0 text-blue-600 font-mono text-[11px] bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100">{b.date}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-40 text-indigo-400/60 text-sm italic">
                  <p>近期没有角色生日。</p>
                </div>
              )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between pt-3 border-t border-blue-100">
              <p className="text-[11px] text-slate-500">只显示接下来两个月的角色生日</p>
              {/* 管理按钮变亮 */}
              <button onClick={() => setShowManager(true)} className="flex items-center gap-1 px-2 py-1 rounded-md bg-white hover:bg-blue-50 text-blue-600 text-[11px] font-bold transition-all border border-blue-100">
                <Edit size={12} /> Manage
              </button>
          </div>
        </div>
      </HomePanel>}
    </div>
  );
};

const HomePanel = ({ title, initiallyOpen = false, tone, children, onOpenChange, ...dragProps }: { title: string; initiallyOpen?: boolean; tone?: 'birthday'; children: React.ReactNode; onOpenChange?: (open: boolean) => void } & HomePanelDragProps) => {
  const [open, setOpen] = useState(initiallyOpen);
  const storageKey = `photoflow:home-panel:${title}`;
  useEffect(() => {
    const saved = window.localStorage.getItem(storageKey);
    if (saved !== null) setOpen(saved === 'true');
  }, [storageKey]);
  useEffect(() => {
    window.localStorage.setItem(storageKey, String(open));
  }, [open, storageKey]);
  useEffect(() => onOpenChange?.(open), [onOpenChange, open]);
  const isBirthday = tone === 'birthday';
  return <section className={`rounded-xl ${open ? 'overflow-visible' : 'overflow-hidden'} ${isBirthday ? 'birthday-panel' : 'border border-slate-200 bg-white'}`}>
    <button {...dragProps} onClick={() => setOpen(value => !value)} aria-expanded={open} className={`flex w-full items-center justify-between px-5 py-4 text-left ${open ? 'rounded-t-[11px]' : ''} ${dragProps.draggable ? 'cursor-grab active:cursor-grabbing' : ''} ${isBirthday ? 'birthday-panel-header' : ''}`}>
      <span className={`text-base font-bold ${isBirthday ? 'birthday-panel-title' : 'text-slate-800'}`}>{title}</span>
      <span className={isBirthday ? 'birthday-panel-icon' : 'text-slate-400'}>{open ? <ChevronUp size={18}/> : <ChevronDown size={18}/>}</span>
    </button>
    <div hidden={!open} className={`rounded-b-[11px] border-t p-5 ${open ? 'animate-in slide-in-from-top-1 duration-200' : ''} ${isBirthday ? 'birthday-panel-body' : 'border-slate-100'}`}>
      {children}
    </div>
  </section>;
};

const ConverterView = ({ embedded = false, initialTargetPath = "", initialTargetPaths, sourcesLoading = false }: { embedded?: boolean; initialTargetPath?: string; initialTargetPaths?: string[]; sourcesLoading?: boolean }) => {
  const [targetPaths, setTargetPaths] = useState<string[]>(() => initialTargetPaths?.filter(Boolean) || (initialTargetPath ? [initialTargetPath] : []));
  const { pathKinds, resolvingKinds } = useSourcePathKinds(targetPaths);
  const [quality, setQuality] = useState(100);
  const [deleteOriginal, setDeleteOriginal] = useState(true);
  const { logs, isRunning, progress, start } = usePythonTask('png_to_jpg.py', '进度');

  useEffect(() => {
    setTargetPaths(initialTargetPaths?.filter(Boolean) || (initialTargetPath ? [initialTargetPath] : []));
  }, [initialTargetPath, initialTargetPaths]);

  const chooseFiles = async () => {
    if (isRunning || sourcesLoading) return;
    const result = await window.electronAPI.chooseProjectImportFiles();
    if (!result.cancelled) setTargetPaths(current => mergeSourcePaths(current, result.paths));
  };
  const chooseFolder = async () => {
    if (isRunning || sourcesLoading) return;
    const result = await window.electronAPI.chooseWorkspaceDirectory('');
    if (!result.cancelled && result.path) setTargetPaths(current => mergeSourcePaths(current, [result.path!]));
  };

  const startConversion = () => {
    if (!targetPaths.length) return;
    start(['--quality', quality.toString(), ...(deleteOriginal ? [] : ['--keep-original']), ...targetPaths], '正在转换…');
  };

  return (
    <div className="w-full space-y-6">
      {!embedded && <h2 className="text-2xl font-bold text-slate-800">图片转 JPG</h2>}
      <div className={embedded ? 'space-y-6' : 'bg-white border border-slate-200 rounded-xl p-6 space-y-6'}>

        <SourcePathPicker paths={targetPaths} pathKinds={pathKinds} folderPreviewExtensions={IMAGE_SOURCE_PREVIEW_EXTENSIONS} onChange={setTargetPaths} onChooseFiles={chooseFiles} onChooseFolder={chooseFolder} fileButtonLabel="追加图片" folderButtonLabel="追加文件夹" loading={sourcesLoading || resolvingKinds} disabled={isRunning} title="已选择" itemLabel="个来源" description="支持 PNG、WebP、HEIC/HEIF、AVIF、TIFF、BMP 和 GIF；动态图片取第一帧，文件夹会递归处理" emptyTitle="拖入图片或文件夹"/>
        <p className="flex items-center gap-1 text-xs text-slate-600"><AlertCircle size={12}/>{deleteOriginal ? '转换并验证成功后，原始图片会移入回收站' : '转换后保留原始图片'}</p>

        <div className="flex items-center justify-between gap-4 rounded-lg bg-slate-50 p-3 border border-slate-200">
          <label className="text-sm font-medium text-slate-700">JPG 画质</label>
          <select value={quality} onChange={event => setQuality(Number(event.target.value))} className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:border-blue-500">
            <option value={100}>最高（100）</option>
            <option value={95}>高（95）</option>
            <option value={85}>标准（85）</option>
            <option value={75}>节省空间（75）</option>
          </select>
        </div>
        <PanelSwitch title="转换成功后删除原始图片" description="JPG 生成并验证成功后，将原图片移入回收站；已有同名 JPG 不会被覆盖。" checked={deleteOriginal} disabled={isRunning} onChange={setDeleteOriginal}/>
        {/* Progress & Actions */}
        <TaskProgress
          logs={logs}
          progress={progress}
          isRunning={isRunning}
          reportToTaskCenter={false}
          idleMessage={isRunning ? '正在转换…' : '进度'}
          action={<button
                onClick={startConversion}
                disabled={!targetPaths.length || isRunning || sourcesLoading || resolvingKinds}
                className={`px-8 py-2 rounded-lg font-bold transition flex items-center gap-2 ${
                  isRunning || !targetPaths.length || sourcesLoading || resolvingKinds
                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200 shadow-none'
                    : 'bg-blue-600 text-white hover:bg-blue-500 shadow-lg shadow-blue-500/20'
                }`}
             >
                {isRunning || sourcesLoading || resolvingKinds ? <Loader2 className="animate-spin" size={18} /> : <Play size={18} fill="currentColor" />}
                {isRunning ? '转换中...' : sourcesLoading || resolvingKinds ? '正在读取' : '开始转换'}
             </button>}
        />
      </div>

    </div>
  );
};

type ScreenshotMainImageSummary = Awaited<ReturnType<typeof window.electronAPI.extractScreenshotMainImages>> & {
  recycledOriginalCount?: number;
  permanentOriginalCount?: number;
  recycleError?: string;
};

type ScreenshotCropReviewItem = {
  relativePath: string;
  input: string;
  inputName: string;
  crop: CropRectangle;
  snapGuides: { x: number[]; y: number[] };
  originalSize: { width: number; height: number };
  confidence: number;
  reason?: string;
  needsReview: boolean;
  confirmed: boolean;
  included: boolean;
};

const ScreenshotCropPreview = ({ item, cacheConfig, queueOrder, onEdit }: { item: ScreenshotCropReviewItem; cacheConfig: AppConfig['mediaCache']; queueOrder: number; onEdit: (previewUrl: string) => void }) => {
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewError, setPreviewError] = useState('');
  useEffect(() => {
    let active = true;
    let fallbackTimer: number | undefined;
    setPreviewUrl(''); setPreviewError('');
    const loadOriginal = () => window.electronAPI.getMediaOriginal(item.input, 'image', cacheConfig).then(result => {
      if (!active) return;
      if (result.mediaUrl) { setPreviewUrl(result.mediaUrl); setPreviewError(''); }
      else setPreviewError(result.error || '预览加载失败');
    }).catch(error => { if (active) setPreviewError(error instanceof Error ? error.message : String(error)); });
    const stopUpdates = window.electronAPI.onThumbnailStateChanged(update => {
      if (update.filePath.toLocaleLowerCase() !== item.input.toLocaleLowerCase()) return;
      if (update.state === 'READY') {
        const url = update.previewUrls?.large || update.previewUrls?.medium || update.previewUrls?.small;
        if (url && active) { setPreviewUrl(url); setPreviewError(''); }
      } else if (update.state === 'FAILED' || update.state === 'MISSING') {
        void loadOriginal();
      }
    });
    window.electronAPI.getMediaThumbnail(item.input, 'image', cacheConfig, 900, item.needsReview ? 0 : 1, queueOrder).then(result => {
      if (!active) return;
      if (result.previewUrl) { setPreviewUrl(result.previewUrl); return; }
      if (result.state === 'QUEUED' || result.state === 'GENERATING') fallbackTimer = window.setTimeout(() => { void loadOriginal(); }, 8000);
      else void loadOriginal();
    }).catch(() => { void loadOriginal(); });
    return () => { active = false; stopUpdates(); if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer); };
  }, [cacheConfig, item.input, item.needsReview, queueOrder]);
  return <div className="relative flex h-44 items-center justify-center overflow-hidden rounded-lg bg-slate-950">
    {previewUrl ? <svg className="h-full w-full" viewBox={`0 0 ${item.originalSize.width} ${item.originalSize.height}`} preserveAspectRatio="xMidYMid meet"><image href={previewUrl} width={item.originalSize.width} height={item.originalSize.height}/><path d={`M0 0H${item.originalSize.width}V${item.originalSize.height}H0Z M${item.crop.x} ${item.crop.y}V${item.crop.y + item.crop.height}H${item.crop.x + item.crop.width}V${item.crop.y}Z`} fill="rgba(2,6,23,.58)" fillRule="evenodd"/><rect x={item.crop.x} y={item.crop.y} width={item.crop.width} height={item.crop.height} fill="none" stroke={item.confirmed ? '#34d399' : '#f59e0b'} strokeWidth={Math.max(4, item.originalSize.width / 260)}/></svg> : <p className="px-4 text-center text-xs text-slate-400">{previewError || '正在加载预览…'}</p>}
    <button type="button" disabled={!previewUrl || !item.included} onClick={() => onEdit(previewUrl)} className="absolute bottom-2 right-2 rounded-md bg-slate-950/80 px-2.5 py-1.5 text-xs font-bold text-white shadow disabled:opacity-40">调整范围</button>
  </div>;
};

const ScreenshotMainImageView = ({
  embedded = false,
  cropMode = false,
  workspacePath,
  projectStatus,
  projectName,
  initialRelativePaths,
  cacheConfig,
  onFilesChanged,
}: {
  embedded?: boolean;
  cropMode?: boolean;
  workspacePath: string;
  projectStatus: ProjectStatus;
  projectName: string;
  initialRelativePaths: string[];
  cacheConfig: AppConfig['mediaCache'];
  onFilesChanged?: () => void | Promise<void>;
}) => {
  const appDialog = useAppDialog();
  const initialRelativePathKey = JSON.stringify(initialRelativePaths.filter(Boolean));
  const [targetPaths, setTargetPaths] = useState(() => initialRelativePaths.filter(Boolean));
  const [isRunning, setIsRunning] = useState(false);
  const [preserveOriginal, setPreserveOriginal] = useState(cropMode);
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('进度');
  const [summary, setSummary] = useState<ScreenshotMainImageSummary | null>(null);
  const [reviewItems, setReviewItems] = useState<ScreenshotCropReviewItem[]>([]);
  const [analysisErrors, setAnalysisErrors] = useState<Array<{ inputName: string; error?: string }>>([]);
  const [cropEditor, setCropEditor] = useState<{ index: number; previewUrl: string; crop: CropRectangle; snapEnabled: boolean } | null>(null);
  const requestIdRef = React.useRef('');
  const preserveOriginalRef = React.useRef(false);
  const issueResults = useMemo(() => (summary?.results || []).filter(result => !result.cropped), [summary]);
  const firstTargetName = targetPaths[0]?.split(/[\\/]/).pop() || '';
  const pendingReviewCount = reviewItems.filter(item => item.included && !item.confirmed).length;
  const includedReviewItems = reviewItems.filter(item => item.included);
  const progressLogs = useMemo<LogEntry[]>(() => summary ? [{
    timestamp: new Date().toLocaleTimeString(),
    message: summary.recycleError
      ? `主图已生成，但原图未能移入回收站：${summary.recycleError}`
      : summary.success
        ? `处理完成：已生成 ${summary.croppedCount || 0} 张主图${summary.skippedCount ? `，跳过 ${summary.skippedCount} 张` : ''}${summary.failedCount ? `，失败 ${summary.failedCount} 张` : ''}${summary.recycledOriginalCount !== undefined ? `；${summary.recycledOriginalCount} 张原图已移入回收站` : ''}`
        : summary.error || '提取失败',
    type: summary.recycleError || !summary.success ? 'error' : 'success',
  }] : reviewItems.length ? [{ timestamp: new Date().toLocaleTimeString(), message: statusMessage, type: pendingReviewCount ? 'warning' : 'success' }] : [], [pendingReviewCount, reviewItems.length, statusMessage, summary]);

  useEffect(() => {
    requestIdRef.current = '';
    setIsRunning(false);
    setTargetPaths(JSON.parse(initialRelativePathKey) as string[]);
    setSummary(null);
    setReviewItems([]);
    setAnalysisErrors([]);
    setCropEditor(null);
    setProgress(0);
    setStatusMessage('进度');
    setPreserveOriginal(cropMode);
  }, [initialRelativePathKey, cropMode]);

  useEffect(() => window.electronAPI.onScreenshotMainImageProgress(value => {
    if (!requestIdRef.current || value.requestId !== requestIdRef.current) return;
    const extractionProgress = Math.max(0, Math.min(100, Number(value.progress) || 0));
    setProgress(preserveOriginalRef.current ? extractionProgress : extractionProgress * .9);
    if (value.message) setStatusMessage(value.message);
  }), []);

  const startAnalysis = async () => {
    if (!targetPaths.length || isRunning) return;
    const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    requestIdRef.current = requestId;
    preserveOriginalRef.current = true;
    setIsRunning(true);
    setSummary(null);
    setProgress(0);
    setReviewItems([]);
    setAnalysisErrors([]);
    setStatusMessage(cropMode ? '正在识别图片边缘…' : '正在分析截图主图…');
    try {
      const analysis = await window.electronAPI.extractScreenshotMainImages(workspacePath, projectStatus, projectName, targetPaths, { requestId, analyzeOnly: true });
      if (requestIdRef.current !== requestId) return;
      const nextItems = analysis.results.flatMap((result, index) => result.success && result.crop && result.originalSize ? [{
        relativePath: targetPaths[index], input: result.input, inputName: result.inputName, crop: result.crop, snapGuides: result.snapGuides || { x: [0, result.originalSize.width], y: [0, result.originalSize.height] },
        originalSize: result.originalSize, confidence: Number(result.confidence || 0), reason: result.reason,
        needsReview: Boolean(result.needsReview), confirmed: !result.needsReview, included: true,
      }] : []);
      setReviewItems(nextItems);
      setAnalysisErrors(analysis.results.filter(result => !result.success).map(result => ({ inputName: result.inputName, error: result.error })));
      setProgress(100);
      setStatusMessage(nextItems.some(item => !item.confirmed) ? '请确认需要检查的裁剪范围' : '范围分析完成，可以生成主图');
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      const message = error instanceof Error ? error.message : String(error);
      setSummary({ success: false, results: [], error: message });
      setStatusMessage(message);
    } finally {
      if (requestIdRef.current === requestId) {
        requestIdRef.current = '';
        setIsRunning(false);
      }
    }
  };

  const confirmExtraction = async () => {
    if (!includedReviewItems.length || pendingReviewCount || isRunning) return;
    const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    requestIdRef.current = requestId;
    preserveOriginalRef.current = preserveOriginal;
    setIsRunning(true);
    setSummary(null);
    setProgress(0);
    setStatusMessage('正在按确认范围生成主图…');
    const confirmedPaths = includedReviewItems.map(item => item.relativePath);
    try {
      const extraction = await window.electronAPI.extractScreenshotMainImages(workspacePath, projectStatus, projectName, confirmedPaths, { requestId, crops: includedReviewItems.map(item => item.crop), ...(cropMode ? { outputSuffix: '裁剪' as const } : {}) });
      if (requestIdRef.current !== requestId) return;
      let nextSummary: ScreenshotMainImageSummary = extraction;
      const croppedRelativePaths = confirmedPaths.filter((_relativePath, index) => extraction.results[index]?.success && extraction.results[index]?.cropped);
      if (!preserveOriginal && croppedRelativePaths.length) {
        setProgress(90);
        setStatusMessage(`正在将 ${croppedRelativePaths.length} 张原图移入回收站…`);
        try {
          const recycled = await window.electronAPI.projectFileOperation(workspacePath, projectStatus, projectName, 'trash', croppedRelativePaths);
          if (requestIdRef.current !== requestId) return;
          if (recycled.success) {
            nextSummary = { ...extraction, recycledOriginalCount: recycled.count || 0, permanentOriginalCount: recycled.permanentCount || 0 };
          } else {
            const recycleError = recycled.error || '原图未能移入回收站';
            nextSummary = { ...extraction, success: false, recycleError, error: recycleError };
            if (isRecycleBinFailure(recycled.error, recycled.errorCode)) await appDialog.alert(RECYCLE_BIN_FAILURE_DIALOG);
          }
        } catch (error) {
          const recycleError = error instanceof Error ? error.message : String(error || '原图未能移入回收站');
          nextSummary = { ...extraction, success: false, recycleError, error: recycleError };
        }
      }
      let refreshError = '';
      if (croppedRelativePaths.length) {
        try { await onFilesChanged?.(); }
        catch (error) { refreshError = error instanceof Error ? error.message : String(error || '刷新文件失败'); }
      }
      if (requestIdRef.current !== requestId) return;
      if (refreshError) nextSummary = { ...nextSummary, success: false, error: `处理结果已保留，但刷新文件失败：${refreshError}` };
      setSummary(nextSummary);
      setReviewItems([]);
      setProgress(nextSummary.recycleError ? 90 : 100);
      setStatusMessage(nextSummary.recycleError ? '主图已生成，但回收原图失败' : nextSummary.success ? '处理完成' : nextSummary.error || '提取失败');
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      const message = error instanceof Error ? error.message : String(error);
      setSummary({ success: false, results: [], error: message });
      setStatusMessage(message);
    } finally {
      if (requestIdRef.current === requestId) {
        requestIdRef.current = '';
        setIsRunning(false);
      }
    }
  };

  const updateReviewItem = (index: number, changes: Partial<ScreenshotCropReviewItem>) => setReviewItems(items => items.map((item, itemIndex) => {
    if (itemIndex !== index) return item;
    const restored = item.included === false && changes.included === true;
    return { ...item, ...changes, ...(restored ? { confirmed: item.confirmed } : {}) };
  }));
  const saveEditedCrop = () => {
    if (!cropEditor) return;
    const item = reviewItems[cropEditor.index];
    if (!item) return;
    const x = Math.max(0, Math.min(item.originalSize.width - 20, Math.round(cropEditor.crop.x)));
    const y = Math.max(0, Math.min(item.originalSize.height - 20, Math.round(cropEditor.crop.y)));
    const width = Math.max(20, Math.min(item.originalSize.width - x, Math.round(cropEditor.crop.width)));
    const height = Math.max(20, Math.min(item.originalSize.height - y, Math.round(cropEditor.crop.height)));
    updateReviewItem(cropEditor.index, { crop: { x, y, width, height }, confirmed: true });
    setCropEditor(null);
  };

  return <div className="w-full space-y-6">
    {!embedded && <h2 className="text-2xl font-bold text-slate-800">{cropMode ? '裁剪图片' : '提取截图主图'}</h2>}
    <div className={embedded ? 'space-y-5' : 'space-y-5 rounded-xl border border-slate-200 bg-white p-6'}>
      <div className="space-y-2">
        <p className="text-sm leading-6 text-slate-600">{cropMode ? '自动识别边缘，确认范围后以原始像素保存；保留原文件。' : '自动识别主图范围；不确定的结果需要手动确认。'}</p>
        <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-blue-600 shadow-sm"><Crop size={18}/></span>
          <div className="min-w-0">
            <p className="text-sm font-bold text-slate-800">已选择 {targetPaths.length} 张{cropMode ? '图片' : '截图'}</p>
            <p className="mt-0.5 truncate text-xs text-slate-500" title={targetPaths.length === 1 ? firstTargetName : undefined}>{targetPaths.length === 1 ? firstTargetName : '将按同一版式批量识别主图区域'}</p>
          </div>
        </div>
        <p className="flex items-center gap-1 text-xs text-slate-500"><AlertCircle size={12}/>{cropMode ? '裁剪结果保存在原图旁，原文件不会被覆盖。' : '主图保存在原图旁；黄色需确认，绿色可直接生成。'}</p>
        {!cropMode && <PanelSwitch title="保留原图" description="默认关闭；关闭时仅把成功裁剪的原图移入系统回收站，跳过或失败的图片保持不变。" checked={preserveOriginal} disabled={isRunning} onChange={setPreserveOriginal}/>}
      </div>

      {!!reviewItems.length && <section className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-bold text-slate-800">检查裁剪范围</h3><p className="mt-0.5 text-xs text-slate-500">{pendingReviewCount ? `还有 ${pendingReviewCount} 张需要确认` : `已确认 ${includedReviewItems.length} 张，可以生成主图`}</p></div><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${pendingReviewCount ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>{pendingReviewCount ? '待检查' : '已就绪'}</span></div><div className="grid gap-3 md:grid-cols-2">{reviewItems.map((item, index) => <article key={item.relativePath} className={`rounded-xl border p-3 ${!item.included ? 'border-slate-200 bg-slate-50 opacity-65' : item.confirmed ? 'border-emerald-200 bg-emerald-50/40' : 'border-amber-300 bg-amber-50/60'}`}><div className="mb-2 flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate text-xs font-bold text-slate-800" title={item.inputName}>{item.inputName}</p><p className="mt-0.5 text-[11px] text-slate-500">置信度 {Math.round(item.confidence * 100)}% · {item.crop.width} × {item.crop.height}</p></div><span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${item.confirmed ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{item.confirmed ? '已确认' : '需检查'}</span></div><ScreenshotCropPreview item={item} cacheConfig={cacheConfig} queueOrder={index} onEdit={previewUrl => setCropEditor({ index, previewUrl, crop: { ...item.crop }, snapEnabled: true })}/>{item.reason && <p className="mt-2 text-[11px] leading-4 text-amber-700">{item.reason}</p>}<div className="mt-3 flex justify-between gap-2"><button type="button" onClick={() => updateReviewItem(index, { included: !item.included, confirmed: item.included ? item.confirmed : true })} className="dialog-secondary px-3 py-1.5 text-xs">{item.included ? '不处理这张' : '恢复处理'}</button>{item.included && !item.confirmed && <button type="button" onClick={() => updateReviewItem(index, { confirmed: true })} className="rounded-md bg-amber-500 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-400">范围正确</button>}</div></article>)}</div></section>}

      {!!analysisErrors.length && <details className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"><summary className="cursor-pointer font-semibold">{analysisErrors.length} 张图片无法读取</summary><div className="mt-2 space-y-1">{analysisErrors.map((item, index) => <p key={`${item.inputName}-${index}`}>{item.inputName}：{item.error || '分析失败'}</p>)}</div></details>}

      <TaskProgress
        logs={progressLogs}
        progress={progress}
        isRunning={isRunning}
        idleMessage={statusMessage}
        action={<button type="button" onClick={() => void (reviewItems.length ? confirmExtraction() : startAnalysis())} disabled={!targetPaths.length || isRunning || Boolean(reviewItems.length && (!includedReviewItems.length || pendingReviewCount))} className={`flex items-center gap-2 rounded-lg px-8 py-2.5 font-bold transition ${!targetPaths.length || isRunning || Boolean(reviewItems.length && (!includedReviewItems.length || pendingReviewCount)) ? 'cursor-not-allowed border border-slate-200 bg-slate-100 text-slate-400 shadow-none' : 'bg-blue-600 text-white shadow-lg shadow-blue-500/20 hover:bg-blue-500'}`}>
          {isRunning ? <Loader2 size={18} className="animate-spin"/> : <Crop size={18}/>}
          {isRunning ? '正在处理…' : reviewItems.length ? pendingReviewCount ? `先确认 ${pendingReviewCount} 张` : `生成 ${includedReviewItems.length} 张主图` : summary ? '重新分析' : `分析范围${targetPaths.length > 1 ? `（${targetPaths.length} 张）` : ''}`}
        </button>}
      />
      {!!issueResults.length && <details className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"><summary className="cursor-pointer font-semibold">查看 {issueResults.length} 个异常项目</summary><div className="mt-2 max-h-36 space-y-1.5 overflow-y-auto">{issueResults.map((result, index) => <p key={`${result.input}-${index}`} className="break-words"><span className="font-semibold">{result.inputName}</span>：{result.skipped ? result.reason || '已跳过' : result.error || '处理失败'}</p>)}</div></details>}
    </div>
    {cropEditor && (() => {
      const item = reviewItems[cropEditor.index];
      if (!item) return null;
      return <div role="dialog" aria-modal="true" className="fixed inset-0 z-[470] flex items-center justify-center bg-slate-950/75 p-3"><div className="flex max-h-[96vh] w-full max-w-6xl flex-col overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl">
        <div className="flex items-start gap-3"><div><h3 className="font-bold text-slate-900">调整主图范围</h3><p className="mt-1 text-xs text-slate-500">拖动框体移动，拖动四角调整大小；靠近检测边缘时会自动吸附。</p></div><PanelSwitch title="磁吸边缘" checked={cropEditor.snapEnabled} onChange={snapEnabled => setCropEditor(current => current ? { ...current, snapEnabled } : current)} className="ml-auto !rounded-lg !px-3 !py-2"/><button type="button" onClick={() => setCropEditor(null)} className="rounded-md p-2 text-slate-500 hover:bg-slate-100"><X size={18}/></button></div>
        <InteractiveCropEditor large snapEnabled={cropEditor.snapEnabled} snapGuides={item.snapGuides} previewUrl={cropEditor.previewUrl} imageSize={item.originalSize} crop={cropEditor.crop} onChange={crop => setCropEditor(current => current ? { ...current, crop } : current)}/>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">{(['x', 'y', 'width', 'height'] as const).map(key => <label key={key} className="text-xs font-bold text-slate-600">{{ x: '左边 X', y: '顶部 Y', width: '宽度', height: '高度' }[key]}<input type="number" min={key === 'x' || key === 'y' ? 0 : 20} value={cropEditor.crop[key]} onChange={event => setCropEditor(current => current ? { ...current, crop: { ...current.crop, [key]: Math.max(key === 'x' || key === 'y' ? 0 : 20, Math.round(Number(event.target.value) || 0)) } } : current)} className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2"/></label>)}</div>
        <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setCropEditor(null)} className="dialog-secondary">取消</button><button type="button" onClick={saveEditedCrop} className="dialog-primary">确认范围</button></div>
      </div></div>;
    })()}
  </div>;
};

const ResearchView = ({
  embedded = false,
  config,
  onUpdateConfig,
  initialTargetPath = '',
  initialTargetPaths = [],
  sourcesLoading = false,
  hasTxtFiles = false,
}: {
  embedded?: boolean;
  config: AppConfig['research'];
  onUpdateConfig: (newConfig: AppConfig['research']) => void;
  initialTargetPath?: string;
  initialTargetPaths?: string[];
  sourcesLoading?: boolean;
  hasTxtFiles?: boolean;
}) => {
  const { logs, isRunning, progress, statusMsg, start } = usePythonTask('research.py', '准备就绪');
  const initialTargetKey = (initialTargetPaths.length ? initialTargetPaths : initialTargetPath ? [initialTargetPath] : []).join('\n');
  const [targetPaths, setTargetPaths] = useState<string[]>(() => initialTargetKey.split('\n').filter(Boolean));
  const [organizeData, setOrganizeData] = useState(true);
  const [deduplicateImages, setDeduplicateImages] = useState(true);
  const { pathKinds, resolvingKinds } = useSourcePathKinds(targetPaths);
  const currentTargetKey = mergeSourcePaths(targetPaths).join('\n');
  const currentFolderPaths = targetPaths.filter(path => pathKinds[sourcePathIdentity(path)] === 'folder');
  const canOrganizeData = currentTargetKey === mergeSourcePaths(initialTargetKey.split('\n')).join('\n') && currentFolderPaths.length === 1 && hasTxtFiles;

  useEffect(() => {
    setTargetPaths([...new Set(initialTargetKey.split('\n').filter(Boolean))]);
    setOrganizeData(true);
  }, [initialTargetKey]);

  const appendTargets = (paths: string[]) => {
    setTargetPaths(current => [...new Set([...current, ...paths.map(value => value.trim()).filter(Boolean)])].slice(0, 120));
  };
  const chooseFiles = async () => {
    if (isRunning || sourcesLoading) return;
    const result = await window.electronAPI.chooseVideoFiles();
    if (!result.cancelled) appendTargets(result.paths);
  };
  const chooseFolder = async () => {
    if (isRunning || sourcesLoading) return;
    const result = await window.electronAPI.chooseVideoFolder();
    if (!result.cancelled && result.path) appendTargets([result.path]);
  };
  const runAnalysis = () => {
    const args = [
      ...targetPaths.flatMap(path => ['--path', path]),
      '--sensitivity', config.sensitivity,
      '--min_duration', config.minDuration.toString()
    ];
    if (canOrganizeData && organizeData) args.push('--organize-data');
    if (!deduplicateImages) args.push('--no-deduplicate');
    start(args, '正在初始化引擎...');
  };

  return (
    <div className="w-full space-y-6">
      {!embedded && <h2 className="text-2xl font-bold text-slate-800">提取分镜帧</h2>}
      <div className={embedded ? 'space-y-6' : 'bg-white border border-slate-200 rounded-xl p-6 space-y-6'}>
        <div className="space-y-2">
          <p className="mt-2 text-gray-600">识别视频转场，并从每个分镜导出清晰画面。</p>
        </div>
        <SourcePathPicker paths={targetPaths} pathKinds={pathKinds} folderPreviewExtensions={VIDEO_SOURCE_PREVIEW_EXTENSIONS} onChange={setTargetPaths} onChooseFiles={chooseFiles} onChooseFolder={chooseFolder} fileButtonLabel="追加视频" folderButtonLabel="追加文件夹" loading={sourcesLoading || resolvingKinds} disabled={isRunning} title="已选择" itemLabel="个来源" description="文件夹会作为一个来源显示，并在执行时扫描子目录" emptyTitle="拖入视频或文件夹"/>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="form-label">检测灵敏度</label>
            <select value={config.sensitivity} onChange={event => onUpdateConfig({ ...config, sensitivity: event.target.value as AppConfig['research']['sensitivity'] })} className="form-input"><option value="low">低</option><option value="standard">标准</option><option value="high">高</option></select>
            <p className="mt-1 text-xs leading-5 text-slate-500">{{ low: '只保留明显硬切，截图最少。', standard: '兼顾硬切、渐变与误判率。', high: '识别更多轻微转场，截图更多。' }[config.sensitivity]}</p>
          </div>
          <div>
            <label className="form-label">最小片段时长（秒）</label>
            <input type="number" min="0.05" max="5" step="0.05" value={config.minDuration} onChange={event => onUpdateConfig({ ...config, minDuration: Math.min(5, Math.max(0.05, Number(event.target.value) || 0.05)) })} className="form-input"/>
            <p className="mt-1 text-xs leading-5 text-slate-500">数值越大，短暂画面会被过滤，最终导出的截图越少。</p>
          </div>
        </div>
        <PanelSwitch title="自动筛除重复图片" description="截帧完成后，将本次生成的完全重复图片移入回收站，每组保留一张。" checked={deduplicateImages} disabled={isRunning} onChange={setDeduplicateImages}/>
        {canOrganizeData && <PanelSwitch title="整理 data 文件" description="处理完成后，将所选文件夹根目录中的 TXT 文件移入 data 文件夹。" checked={organizeData} onChange={setOrganizeData}/>}

        <TaskProgress
          logs={logs}
          progress={progress}
          isRunning={isRunning}
          reportToTaskCenter={false}
          idleMessage={statusMsg}
          action={<button
               onClick={runAnalysis}
               disabled={isRunning || sourcesLoading || resolvingKinds || !targetPaths.length}
               className={`px-6 py-2.5 rounded-lg font-bold transition flex items-center gap-2 ${
                 isRunning || sourcesLoading || resolvingKinds || !targetPaths.length
                  ? 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed shadow-none'
                  : 'bg-blue-600 text-white hover:bg-blue-500 shadow-md shadow-blue-500/20'
               }`}
             >
                {isRunning || sourcesLoading || resolvingKinds ? <Loader2 className="animate-spin" size={18}/> : <Play size={18} fill="currentColor" />}
                {isRunning ? '处理中' : sourcesLoading || resolvingKinds ? '正在读取' : '开始处理'}
             </button>}
        />
      </div>
    </div>
  );
};

const MatchView = ({
  embedded = false,
  config,
  projectPath,
  onUpdateConfig,
}: {
  embedded?: boolean;
  config: AppConfig['smartMatch'];
  projectPath?: string;
  onUpdateConfig: (newMatchConfig: AppConfig['smartMatch']) => void;
  folderOptions?: Array<{ name: string; path: string }>;
}) => {
  const [keywords, setKeywords] = useState('');
  const [sourceFolders, setSourceFolders] = useState<Array<{ name: string; relativePath: string }>>([]);
  const [sourceFoldersNextCursor, setSourceFoldersNextCursor] = useState<string | null>(null);
  const [sourceFoldersTruncated, setSourceFoldersTruncated] = useState(false);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState('请确认图片、视频来源并输入文件名');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const operationIdRef = React.useRef('');
  const folderListingOperationIdRef = React.useRef('');
  const activeProjectPathRef = React.useRef(projectPath);
  const sourceFolderGenerationRef = React.useRef(0);
  const selectionTaskOwnershipRef = React.useRef<ReturnType<typeof createFilenameSelectionTaskOwnership>>();
  if (!selectionTaskOwnershipRef.current) selectionTaskOwnershipRef.current = createFilenameSelectionTaskOwnership();
  activeProjectPathRef.current = projectPath;
  const executionProgressRef = React.useRef({ label: '', start: 40, end: 90 });
  const appDialog = useAppDialog();
  const selectedImageRelativePath = resolveFilenameSelectionSource(sourceFolders, config.imageSourceFolderName, 'raw');
  const selectedVideoRelativePath = resolveFilenameSelectionSource(sourceFolders, config.videoSourceFolderName, 'mov');
  const selectedSources = [
    selectedImageRelativePath ? { mediaKind: 'image' as const, label: '图片', relativePath: selectedImageRelativePath } : null,
    selectedVideoRelativePath ? { mediaKind: 'video' as const, label: '视频', relativePath: selectedVideoRelativePath } : null,
  ].filter((source): source is { mediaKind: 'image' | 'video'; label: string; relativePath: string } => Boolean(source));

  useEffect(() => {
    const ownedStaleOperationId = selectionTaskOwnershipRef.current!.invalidate();
    const staleOperationId = operationIdRef.current || ownedStaleOperationId;
    operationIdRef.current = '';
    setIsRunning(false);
    setIsConfirming(false);
    setIsCancelling(false);
    setProgress(0);
    if (staleOperationId) void window.electronAPI.cancelSelectionOperation(staleOperationId).catch(() => undefined);
    const generation = ++sourceFolderGenerationRef.current;
    let active = true;
    if (!projectPath) {
      setSourceFolders([]);
      setSourceFoldersNextCursor(null);
      return () => { active = false; };
    }
    const operationId = crypto.randomUUID();
    folderListingOperationIdRef.current = operationId;
    setLoadingFolders(true);
    void window.electronAPI.getSelectionSourceFolders(projectPath, { pageSize: 500, operationId }).then(result => {
      if (!active || sourceFolderGenerationRef.current !== generation) return;
      setSourceFolders(result.success ? result.folders : []);
      setSourceFoldersNextCursor(result.nextCursor || null);
      setSourceFoldersTruncated(result.truncated);
      if (!result.success) setStatusMsg(result.error || '无法读取项目文件夹');
    }).catch(error => {
      if (!active || sourceFolderGenerationRef.current !== generation) return;
      setSourceFolders([]);
      setSourceFoldersNextCursor(null);
      setStatusMsg(error instanceof Error ? error.message : String(error || '无法读取项目文件夹'));
    }).finally(() => { if (active) setLoadingFolders(false); });
    return () => { active = false; if (folderListingOperationIdRef.current === operationId) void window.electronAPI.cancelSelectionOperation(operationId); };
  }, [projectPath]);

  useEffect(() => window.electronAPI.onSelectionOperationProgress(progressEvent => {
    if (progressEvent.operationId !== operationIdRef.current && progressEvent.operationId !== folderListingOperationIdRef.current) return;
    if (progressEvent.phase === 'scanning_source') {
      setStatusMsg(`正在扫描来源：${Number(progressEvent.directoriesScanned || 0)} 个目录，${Number(progressEvent.filesScanned || 0)} 个文件`);
      setProgress(current => Math.max(current, 10));
    }
    if (progressEvent.phase === 'copying') {
      const { label, start, end } = executionProgressRef.current;
      const transferProgress = Math.min(100, Math.max(0, Number(progressEvent.progress) || 0));
      const fileIndex = Number(progressEvent.fileIndex || 0);
      const totalFiles = Number(progressEvent.totalFiles || 0);
      setStatusMsg(`正在复制${label ? `${label}：` : '：'}${progressEvent.fileName || '文件'}${totalFiles ? `（${fileIndex}/${totalFiles}）` : ''}`);
      setProgress(start + (end - start) * transferProgress / 100);
    }
  }), []);

  const loadMoreSourceFolders = async () => {
    if (!projectPath || !sourceFoldersNextCursor || loadingFolders) return;
    const requestedProjectPath = projectPath;
    const requestedCursor = sourceFoldersNextCursor;
    const requestedGeneration = sourceFolderGenerationRef.current;
    setLoadingFolders(true);
    try {
      const result = await window.electronAPI.getSelectionSourceFolders(requestedProjectPath, { cursor: requestedCursor, pageSize: 500 });
      if (activeProjectPathRef.current !== requestedProjectPath || sourceFolderGenerationRef.current !== requestedGeneration) return;
      if (!result.success) { setStatusMsg(result.error || '无法继续读取项目文件夹'); return; }
      setSourceFolders(current => [...current, ...result.folders]);
      setSourceFoldersNextCursor(result.nextCursor || null);
      setSourceFoldersTruncated(result.truncated);
    } catch (error) {
      if (activeProjectPathRef.current === requestedProjectPath && sourceFolderGenerationRef.current === requestedGeneration) setStatusMsg(error instanceof Error ? error.message : String(error || '无法继续读取项目文件夹'));
    } finally { if (activeProjectPathRef.current === requestedProjectPath && sourceFolderGenerationRef.current === requestedGeneration) setLoadingFolders(false); }
  };

  const appendLog = (message: string, type: LogEntry['type'] = 'info') => {
    setLogs(current => [...current, { timestamp: new Date().toLocaleTimeString(), message, type }].slice(-200));
  };
  const cancel = async () => {
    if (!operationIdRef.current || isCancelling) return;
    setIsCancelling(true);
    selectionTaskOwnershipRef.current!.setPhase(selectionTaskOwnershipRef.current!.getSnapshot().generation, 'cancelling');
    setStatusMsg('正在取消并回滚本次复制…');
    try {
      const result = await window.electronAPI.cancelSelectionOperation(operationIdRef.current);
      if (!result.success) {
        setIsCancelling(false);
        setStatusMsg('无法取消当前选片任务，请重试。');
      }
    } catch (error) {
      setIsCancelling(false);
      setStatusMsg(error instanceof Error ? error.message : String(error || '无法取消当前选片任务，请重试。'));
    }
  };
  const runTask = async () => {
    if (!projectPath || !selectedSources.length || !keywords.trim() || isRunning || isConfirming) return;
    const taskGeneration = selectionTaskOwnershipRef.current!.begin();
    setIsRunning(true);
    setProgress(0);
    setStatusMsg('正在预检来源与目标…');
    setLogs([]);
    try {
      const tokens = keywords.trim().split(/\s+/);
      const previews: Array<{ source: typeof selectedSources[number]; preview: SelectionPreflightResult }> = [];
      for (const [index, source] of selectedSources.entries()) {
        const preflightOperationId = crypto.randomUUID();
        operationIdRef.current = preflightOperationId;
        selectionTaskOwnershipRef.current!.setOperation(taskGeneration, preflightOperationId);
        setStatusMsg(`正在预检${source.label}来源…`);
        const preview = await window.electronAPI.preflightFilenameSelection(projectPath, {
          sourceFolderRelativePath: source.relativePath,
          mediaKind: source.mediaKind,
          keywords: tokens,
          operationId: preflightOperationId,
        });
        if (!selectionTaskOwnershipRef.current!.isCurrent(taskGeneration)) return;
        if (preview.cancelled) { setStatusMsg('已取消来源扫描'); setProgress(0); return; }
        if (!preview.success || !preview.signature) throw new Error(preview.error || `${source.label}选片预检失败`);
        previews.push({ source, preview });
        setProgress(10 + Math.round((index + 1) / selectedSources.length * 20));
        appendLog(`${source.label}来源：${preview.sourceFolderRelativePath}`, 'info');
        if (Number(preview.matchedCount || 0) > 0) appendLog(`${source.label}目标：${preview.targetFolderRelativePath}`, 'info');
        else appendLog(`${source.label}来源未匹配到选片，不会创建输出文件夹`, 'info');
      }
      operationIdRef.current = '';
      setProgress(30);
      const matchedPreviews = previews.filter(({ preview }) => Number(preview.matchedCount || 0) > 0);
      if (!matchedPreviews.length) {
        setStatusMsg('未找到与输入文件名匹配的图片或视频');
        setProgress(0);
        return;
      }
      setIsConfirming(true);
      selectionTaskOwnershipRef.current!.setPhase(taskGeneration, 'confirm');
      const filesToCopy = matchedPreviews.reduce((sum, { preview }) => sum + Number(preview.filesToCopy || 0), 0);
      const totalBytes = matchedPreviews.reduce((sum, { preview }) => sum + Number(preview.totalBytes || 0), 0);
      const imageCount = matchedPreviews.reduce((sum, { preview }) => sum + Number(preview.imageCount || 0), 0);
      const videoCount = matchedPreviews.reduce((sum, { preview }) => sum + Number(preview.videoCount || 0), 0);
      const existingCount = matchedPreviews.reduce((sum, { preview }) => sum + Number(preview.existingCount || 0), 0);
      const conflictCount = matchedPreviews.reduce((sum, { preview }) => sum + Number(preview.conflictCount || 0), 0);
      const missingKeywords = tokens.filter(keyword => previews.every(({ preview }) => preview.missingKeywords?.includes(keyword)));
      const details = [
        `图片 ${imageCount} 个，视频 ${videoCount} 个`,
        existingCount ? `目标中已存在 ${existingCount} 个，将保留原文件` : '',
        conflictCount ? `发现 ${conflictCount} 个来源同名冲突，必须处理后才能执行` : '',
        missingKeywords.length ? `未找到 ${missingKeywords.length} 个编号：${missingKeywords.slice(0, 10).join('、')}${missingKeywords.length > 10 ? '…' : ''}` : '',
      ].filter(Boolean).join('；');
      if (conflictCount > 0) {
        const message = `发现 ${conflictCount} 个来源同名冲突，必须处理后重新预检`;
        setStatusMsg(message);
        appendLog(message, 'error');
        return;
      }
      const confirmed = await appDialog.confirm({
        title: '确认从文件名选片',
        message: `将复制 ${filesToCopy} 个文件，共 ${formatTransferBytes(totalBytes)}。`,
        detail: details,
        confirmLabel: '开始复制',
        cancelLabel: '取消',
      });
      if (!selectionTaskOwnershipRef.current!.isCurrent(taskGeneration)) return;
      setIsConfirming(false);
      if (!confirmed) {
        setStatusMsg('已取消，未写入文件');
        setProgress(0);
        return;
      }
      if (matchedPreviews.some(({ preview }) => Number(preview.conflictCount || 0) > 0)) throw new Error('存在输出名称或同名目标冲突，请处理后重新预检');
      let copiedCount = 0;
      for (const [index, { source, preview }] of matchedPreviews.entries()) {
        const operationId = crypto.randomUUID();
        operationIdRef.current = operationId;
        selectionTaskOwnershipRef.current!.setPhase(taskGeneration, 'copy');
        selectionTaskOwnershipRef.current!.setOperation(taskGeneration, operationId);
        const executionStart = 40 + index / matchedPreviews.length * 50;
        const executionEnd = 40 + (index + 1) / matchedPreviews.length * 50;
        executionProgressRef.current = { label: source.label, start: executionStart, end: executionEnd };
        setProgress(executionStart);
        setStatusMsg(`正在复制${source.label}选片文件…`);
        const result = await window.electronAPI.executeFilenameSelection(projectPath, {
          sourceFolderRelativePath: source.relativePath,
          mediaKind: source.mediaKind,
          keywords: tokens,
          expectedSignature: preview.signature!,
          operationId,
        });
        if (!selectionTaskOwnershipRef.current!.isCurrent(taskGeneration)) return;
        if (!result.success) {
          if (result.cancelled) {
            appendLog(`${source.label}任务已取消，当前来源的新增内容已回滚`, 'warning');
            setStatusMsg(copiedCount ? `已取消；此前已复制 ${copiedCount} 个文件` : '已取消并回滚');
            setProgress(0);
            return;
          }
          throw new Error(result.error || `${source.label}选片复制失败`);
        }
        copiedCount += Number(result.copiedCount || 0);
        appendLog(`${source.label}选片完成，已登记节点：${result.selectionProgressId || ''}`, 'success');
      }
      setProgress(100);
      setStatusMsg(`选片完成，复制 ${copiedCount} 个文件`);
    } catch (error) {
      if (!selectionTaskOwnershipRef.current!.isCurrent(taskGeneration)) return;
      const message = error instanceof Error ? error.message : String(error);
      setStatusMsg(message);
      appendLog(message, 'error');
    } finally {
      if (selectionTaskOwnershipRef.current!.finish(taskGeneration)) {
        operationIdRef.current = '';
        setIsRunning(false);
        setIsConfirming(false);
        setIsCancelling(false);
      }
    }
  };

  return <div className="w-full space-y-6">
    {!embedded && <h2 className="text-2xl font-bold text-slate-800">选片</h2>}
    <div className={embedded ? 'space-y-6' : 'space-y-6 rounded-xl border border-slate-200 bg-white p-6'}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-sm text-slate-600">图片来源文件夹
          <select value={selectedImageRelativePath} onChange={event => onUpdateConfig({ ...config, sourceFolderRelativePath: undefined, imageSourceFolderName: event.target.value })} disabled={isRunning || loadingFolders} className="form-input mt-1">
            <option value="">无</option>
            {sourceFolders.map(folder => <option key={folder.relativePath} value={folder.relativePath}>{folder.relativePath}</option>)}
          </select>
          <span className="mt-1 block text-xs font-bold text-slate-500">选中的图片会存放到“{filenameSelectionOutputName(selectedImageRelativePath) || '图片选片'}”文件夹</span>
        </label>
        <label className="text-sm text-slate-600">视频来源文件夹
          <select value={selectedVideoRelativePath} onChange={event => onUpdateConfig({ ...config, sourceFolderRelativePath: undefined, videoSourceFolderName: event.target.value })} disabled={isRunning || loadingFolders} className="form-input mt-1">
            <option value="">无</option>
            {sourceFolders.map(folder => <option key={folder.relativePath} value={folder.relativePath}>{folder.relativePath}</option>)}
          </select>
          <span className="mt-1 block text-xs font-bold text-slate-500">选中的视频会存放到“{filenameSelectionOutputName(selectedVideoRelativePath) || '视频选片'}”文件夹</span>
        </label>
      </div>
      {sourceFoldersNextCursor && <button type="button" onClick={() => void loadMoreSourceFolders()} disabled={loadingFolders} className="text-xs font-bold text-blue-600 hover:text-blue-500 disabled:opacity-50">加载更多文件夹</button>}
      {sourceFoldersTruncated && !sourceFoldersNextCursor && <span className="block text-xs text-amber-700">目录数量或深度已达安全上限，请缩小项目范围。</span>}
      <div className="space-y-2"><label className="text-xs font-semibold uppercase text-slate-500">文件名</label><textarea value={keywords} onChange={event => setKeywords(event.target.value)} placeholder="输入文件名或末尾编号，以空格分隔" className="h-24 min-h-24 w-full resize-y rounded-lg border border-slate-200 bg-slate-50 p-4 font-mono text-sm text-slate-900 focus:border-blue-500 focus:outline-none"/></div>
      <TaskProgress logs={logs} progress={progress} isRunning={isRunning} idleMessage={statusMsg} statusMessage={statusMsg} action={<button onClick={isRunning ? () => void cancel() : () => void runTask()} disabled={isCancelling || isConfirming || (!isRunning && (!projectPath || !selectedSources.length || !keywords.trim()))} className={`flex items-center gap-2 rounded-lg px-8 py-2.5 font-bold transition ${isRunning ? 'bg-red-600 text-white hover:bg-red-500' : isConfirming || !selectedSources.length || !keywords.trim() ? 'cursor-not-allowed border border-slate-200 bg-slate-100 text-slate-400' : 'bg-blue-600 text-white hover:bg-blue-500'}`}>{isRunning ? (isCancelling ? <Loader2 className="animate-spin" size={18}/> : <X size={18}/>) : <ScanSearch size={18}/>} {isRunning ? (isCancelling ? '正在回滚…' : '取消任务') : isConfirming ? '等待确认' : '开始选片'}</button>}/>
    </div>
  </div>;
};

type VideoTranscodeViewProps = {
  embedded?: boolean;
  initialTargetPaths?: string[];
  initialSourceFolders?: string[];
  sourcesLoading?: boolean;
  initialSettings?: VideoTranscodeSettings;
  onSettingsChange?: (settings: VideoTranscodeSettings) => void;
  settingsOnly?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onFolderTranscodeComplete?: (folderOutputs: VideoTranscodeFolderOutput[]) => void | Promise<void>;
};

const AUTO_TRANSCODE_INSPECTION_DELAY_MS = 400;

const TranscodeOutputChoice = ({ selected, disabled, title, description, onSelect }: {
  selected: boolean;
  disabled: boolean;
  title: string;
  description: string;
  onSelect: () => void;
}) => <button
  type="button"
  role="radio"
  aria-checked={selected}
  disabled={disabled}
  onClick={onSelect}
  className={`flex w-full items-start gap-2 rounded-lg border p-3 text-left text-sm transition ${selected ? 'border-blue-400 bg-blue-50' : 'border-slate-200'} ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:border-blue-300 hover:bg-blue-50/40'}`}
>
  <span aria-hidden className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-blue-500' : 'border-slate-400'}`}>{selected && <span className="h-2 w-2 rounded-full bg-blue-500"/>}</span>
  <span><b className="block text-slate-800">{title}</b><span className="mt-1 block text-xs leading-5 text-slate-500">{description}</span></span>
</button>;

const useSourcePathKinds = (paths: readonly string[], knownFolders: readonly string[] = []) => {
  const pathsKey = paths.join('\n');
  const foldersKey = knownFolders.join('\n');
  const [pathKinds, setPathKinds] = useState<Record<string, 'file' | 'folder'>>(() => Object.fromEntries(
    knownFolders.map(folder => [sourcePathIdentity(folder), 'folder' as const]),
  ));
  const [resolvingKinds, setResolvingKinds] = useState(false);
  useEffect(() => {
    let active = true;
    const currentPaths = mergeSourcePaths(pathsKey.split('\n'));
    const folderKeys = new Set(mergeSourcePaths(foldersKey.split('\n')).map(sourcePathIdentity));
    const seeded = Object.fromEntries(currentPaths.flatMap(path => {
      const identity = sourcePathIdentity(path);
      if (folderKeys.has(identity)) return [[identity, 'folder' as const]];
      return pathKinds[identity] ? [[identity, pathKinds[identity]]] : [];
    }));
    setPathKinds(seeded);
    const unresolved = currentPaths.filter(path => !seeded[sourcePathIdentity(path)]);
    if (!unresolved.length) {
      setResolvingKinds(false);
      return () => { active = false; };
    }
    setResolvingKinds(true);
    void window.electronAPI.inspectSourcePaths(unresolved).then(result => {
      if (!active) return;
      setPathKinds(current => ({ ...current, ...Object.fromEntries(result.sources.map(source => [sourcePathIdentity(source.path), source.kind])) }));
      setResolvingKinds(false);
    }).catch(() => {
      if (active) setResolvingKinds(false);
    });
    return () => { active = false; };
  // pathKinds is intentionally read as a cache but not a dependency: path or
  // known-folder changes are the only events that require a new filesystem check.
  }, [foldersKey, pathsKey]);
  return { pathKinds, resolvingKinds };
};

const VideoTranscodeView = ({ embedded = false, initialTargetPaths = [], initialSourceFolders = [], sourcesLoading = false, initialSettings, onSettingsChange, settingsOnly = false, onBusyChange, onFolderTranscodeComplete }: VideoTranscodeViewProps) => {
  const initialTargetKey = initialTargetPaths.join('\n');
  const initialSourceFolderKey = initialSourceFolders.join('\n');
  const [sourcePaths, setSourcePaths] = useState(() => mergeSourcePaths(initialTargetPaths));
  const [settings, setSettings] = useState(() => normalizeVideoTranscodeSettings(initialSettings));
  const [outputMode, setOutputMode] = useState<'new' | 'delete-original'>('new');
  const [customPresets, setCustomPresets] = useState<VideoTranscodePreset[]>(() => readCustomVideoTranscodePresets(window.localStorage));
  const [presetId, setPresetId] = useState('');
  const [presetName, setPresetName] = useState('');
  const [mediaInfo, setMediaInfo] = useState<VideoTranscodeMediaInfo[]>([]);
  const [capabilities, setCapabilities] = useState<VideoTranscodeCapabilities | null>(null);
  const onSettingsChangeRef = React.useRef(onSettingsChange);
  const task = usePythonTask('ffmpeg_transcode.py', '等待选择视频');
  const inspection = usePythonTask('ffmpeg_transcode.py', '尚未分析媒体');
  const transcodeBusy = task.isRunning;
  const handledCompletionRef = React.useRef('');
  const handledInspectionRef = React.useRef('');
  const activeInspectionKeyRef = React.useRef('');
  const lastRequestedInspectionKeyRef = React.useRef('');
  const startInspectionRef = React.useRef(inspection.start);
  startInspectionRef.current = inspection.start;
  const paths = sourcePaths;
  const { pathKinds, resolvingKinds } = useSourcePathKinds(paths, initialSourceFolderKey.split('\n').filter(Boolean));
  const activeSourceFolders = useMemo(() => paths.filter(path => pathKinds[sourcePathIdentity(path)] === 'folder'), [pathKinds, paths]);
  const taskArguments = useMemo(() => [
    ...paths, '--container', settings.container, '--video-mode', settings.videoMode,
    '--quality', settings.quality, '--resolution', settings.resolution,
    '--frame-rate', settings.frameRate, '--audio-mode', settings.audioMode,
    '--subtitle-mode', settings.subtitleMode, '--color-mode', settings.colorMode,
    '--bit-depth', settings.bitDepth, '--frame-rate-mode', settings.frameRateMode,
    '--rotation', settings.rotation, '--aspect-mode', settings.aspectMode,
    '--audio-track', settings.audioTrack, '--audio-bitrate-kbps', String(settings.audioBitrateKbps),
    '--encoder-preset', settings.encoderPreset, '--retry-count', String(settings.retryCount),
    ...(settings.videoBitrateMbps ? ['--video-bitrate-mbps', String(settings.videoBitrateMbps)] : []),
    ...activeSourceFolders.flatMap(folder => ['--source-folder', folder]),
  ], [activeSourceFolders, paths, settings]);
  const inspectionKey = JSON.stringify(taskArguments);
  const presets = [...BUILTIN_VIDEO_TRANSCODE_PRESETS, ...customPresets];
  const blockingErrors = videoTranscodeBlockingErrors(settings, capabilities, mediaInfo);
  const warnings = videoTranscodeWarnings(settings, capabilities, mediaInfo).filter(message => !blockingErrors.includes(message));
  const estimatedOutputBytes = mediaInfo.reduce((sum, item) => sum + Number(item.estimatedOutputBytes || 0), 0);
  const setSetting = <K extends keyof VideoTranscodeSettings>(key: K, value: VideoTranscodeSettings[K]) => {
    setPresetId('');
    setSettings(current => ({ ...current, [key]: value }));
  };

  useEffect(() => setSourcePaths(mergeSourcePaths(initialTargetKey.split('\n'))), [initialTargetKey]);
  useEffect(() => {
    if (!initialSettings) return;
    const normalized = normalizeVideoTranscodeSettings(initialSettings);
    setSettings(current => JSON.stringify(current) === JSON.stringify(normalized) ? current : normalized);
  }, [initialSettings]);
  useEffect(() => { onSettingsChangeRef.current = onSettingsChange; }, [onSettingsChange]);
  useEffect(() => { onSettingsChangeRef.current?.(settings); }, [settings]);
  useEffect(() => { onBusyChange?.(transcodeBusy); }, [onBusyChange, transcodeBusy]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  useEffect(() => { setMediaInfo([]); }, [inspectionKey]);
  useEffect(() => {
    if (settings.videoMode === 'copy') setSettings(current => ({ ...current, resolution: 'original', frameRate: 'original', frameRateMode: 'preserve', colorMode: 'auto', bitDepth: 'auto', rotation: 'auto', aspectMode: 'preserve', videoBitrateMbps: null, subtitleMode: current.subtitleMode === 'burn' ? 'copy' : current.subtitleMode }));
    else if (settings.videoMode === 'prores') setSettings(current => ({ ...current, container: 'mov', bitDepth: '10', videoBitrateMbps: null }));
    else if (settings.videoMode === 'av1' && settings.container === 'mov') setSettings(current => ({ ...current, container: 'mp4' }));
  }, [settings.videoMode]);
  useEffect(() => {
    if (!task.completion || handledCompletionRef.current === task.completion.requestId) return;
    handledCompletionRef.current = task.completion.requestId;
    const folderOutputs = Array.isArray(task.completion.event.folderOutputs) ? task.completion.event.folderOutputs : [];
    if (folderOutputs.length) void onFolderTranscodeComplete?.(folderOutputs);
  }, [task.completion, onFolderTranscodeComplete]);
  useEffect(() => {
    if (!inspection.completion || handledInspectionRef.current === inspection.completion.requestId) return;
    handledInspectionRef.current = inspection.completion.requestId;
    if (!settingsOnly && activeInspectionKeyRef.current !== inspectionKey) return;
    setMediaInfo(Array.isArray(inspection.completion.event.mediaInfo) ? inspection.completion.event.mediaInfo : []);
    if (inspection.completion.event.capabilities) setCapabilities(inspection.completion.event.capabilities);
  }, [inspection.completion, inspectionKey, settingsOnly]);
  useEffect(() => {
    if (settingsOnly || !paths.length || sourcesLoading || resolvingKinds || task.isRunning || inspection.isRunning) return;
    if (lastRequestedInspectionKeyRef.current === inspectionKey) return;
    const timer = window.setTimeout(() => {
      lastRequestedInspectionKeyRef.current = inspectionKey;
      activeInspectionKeyRef.current = inspectionKey;
      startInspectionRef.current([...taskArguments, '--inspect-only'], '正在自动更新预计输出…');
    }, AUTO_TRANSCODE_INSPECTION_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [inspection.isRunning, inspectionKey, paths.length, resolvingKinds, settingsOnly, sourcesLoading, task.isRunning, taskArguments]);

  const chooseVideos = async () => { const result = await window.electronAPI.chooseVideoFiles(); if (!result.cancelled) setSourcePaths(current => mergeSourcePaths(current, result.paths)); };
  const chooseVideoFolder = async () => { const result = await window.electronAPI.chooseVideoFolder(); if (!result.cancelled && result.path) setSourcePaths(current => mergeSourcePaths(current, [result.path!])); };
  const startTranscode = () => {
    if (!paths.length || task.isRunning || inspection.isRunning || sourcesLoading || resolvingKinds) return;
    onBusyChange?.(true);
    task.start([...taskArguments, '--output-mode', outputMode], '正在准备视频转码队列…');
  };
  const applyPreset = (id: string) => { setPresetId(id); const selected = presets.find(value => value.id === id); if (selected) setSettings(selected.settings); };
  const savePreset = () => {
    const name = presetName.trim();
    if (!name) return;
    const next = [...customPresets, { id: globalThis.crypto?.randomUUID?.() || `preset-${Date.now()}`, name: name.slice(0, 40), settings }].slice(-30);
    setCustomPresets(next); writeCustomVideoTranscodePresets(window.localStorage, next); setPresetName('');
  };
  const deletePreset = () => {
    if (!presetId || BUILTIN_VIDEO_TRANSCODE_PRESETS.some(value => value.id === presetId)) return;
    const next = customPresets.filter(value => value.id !== presetId);
    setCustomPresets(next); writeCustomVideoTranscodePresets(window.localStorage, next); setPresetId('');
  };
  const disabled = task.isRunning;
  const videoDisabled = disabled || settings.videoMode === 'copy';
  const inspectionReady = Boolean(inspection.completion) && activeInspectionKeyRef.current === inspectionKey;
  const canStartTranscode = paths.length > 0 && inspectionReady && !task.isRunning && !inspection.isRunning && !sourcesLoading && !resolvingKinds && blockingErrors.length === 0;
  const automaticEstimateStatus = !paths.length
    ? '添加视频后自动估算预计输出'
    : inspection.isRunning || lastRequestedInspectionKeyRef.current !== inspectionKey
      ? '正在自动更新预计输出…'
      : inspection.statusMsg;

  return <div className={embedded ? 'w-full space-y-6' : 'mx-auto w-full max-w-6xl space-y-6'}>
    {!embedded && <div><h2 className="flex items-center gap-2 text-2xl font-bold text-slate-800"><Video size={25}/>Media Encoder Lite</h2><p className="mt-1 text-sm text-slate-500">H.264、HEVC 8/10-bit、AV1 硬件、ProRes、HDR、音轨与字幕批量处理。</p></div>}
    <div className={embedded ? 'space-y-6' : 'space-y-6 rounded-xl border border-slate-200 bg-white p-6'}>
      {!settingsOnly && <SourcePathPicker paths={paths} pathKinds={pathKinds} pathAnnotations={Object.fromEntries(activeSourceFolders.map(folder => [sourcePathIdentity(folder), '递归加入编码队列']))} folderPreviewExtensions={VIDEO_SOURCE_PREVIEW_EXTENSIONS} onChange={setSourcePaths} onChooseFiles={chooseVideos} onChooseFolder={chooseVideoFolder} fileButtonLabel="追加视频" folderButtonLabel="追加文件夹" loading={sourcesLoading || resolvingKinds} disabled={disabled} title="编码队列来源" itemLabel="个来源" description="文件夹会递归扫描，输出保留原子目录结构" emptyTitle="拖入视频或文件夹"/>}
      <section className="rounded-lg border border-slate-200 bg-slate-50 p-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto]">
          <label className="text-xs font-bold text-slate-600">编码预设<select value={presetId} disabled={disabled} onChange={event => applyPreset(event.target.value)} className="form-input mt-1"><option value="">自定义设置</option>{presets.map(value => <option key={value.id} value={value.id}>{value.builtIn ? '内置 · ' : ''}{value.name}</option>)}</select></label>
          <label className="text-xs font-bold text-slate-600">保存为用户预设<input value={presetName} disabled={disabled} maxLength={40} onChange={event => setPresetName(event.target.value)} placeholder="输入预设名称" className="form-input mt-1"/></label>
          <button type="button" disabled={disabled || !presetName.trim()} onClick={savePreset} className="mt-5 inline-flex items-center justify-center gap-1 rounded-md bg-blue-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-40"><Save size={14}/>保存</button>
          <button type="button" disabled={disabled || !presetId || BUILTIN_VIDEO_TRANSCODE_PRESETS.some(value => value.id === presetId)} onClick={deletePreset} className="mt-5 inline-flex items-center justify-center gap-1 rounded-md border border-slate-300 px-3 py-2 text-xs font-bold text-slate-600 disabled:opacity-40"><Trash2 size={14}/>删除</button>
        </div>
      </section>
      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <h3 className="mb-4 text-sm font-bold text-slate-800">输出与编码</h3>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-xs font-bold text-slate-600">输出封装<select value={settings.container} disabled={disabled || settings.videoMode === 'prores'} onChange={event => setSetting('container', event.target.value as VideoTranscodeSettings['container'])} className="form-input mt-1"><option value="mp4">MP4</option><option value="mov">MOV</option><option value="mkv">MKV</option></select></label>
            <label className="text-xs font-bold text-slate-600">视频编码<select value={settings.videoMode} disabled={disabled} onChange={event => setSetting('videoMode', event.target.value as VideoTranscodeSettings['videoMode'])} className="form-input mt-1"><option value="h264">H.264</option><option value="h265">HEVC / H.265</option><option value="av1">AV1 · 硬件</option><option value="prores">Apple ProRes</option><option value="copy">复制视频流</option></select></label>
            <label className="text-xs font-bold text-slate-600">{settings.videoMode === 'prores' ? 'ProRes 规格' : '画质'}<select value={settings.quality} disabled={videoDisabled || settings.videoBitrateMbps !== null} onChange={event => setSetting('quality', event.target.value as VideoTranscodeSettings['quality'])} className="form-input mt-1 disabled:opacity-50">{settings.videoMode === 'prores' ? <><option value="high">422 HQ</option><option value="balanced">422</option><option value="small">422 LT</option></> : <><option value="high">高质量</option><option value="balanced">平衡</option><option value="small">更小文件</option></>}</select></label>
            <label className="text-xs font-bold text-slate-600">编码速度<select value={settings.encoderPreset} disabled={videoDisabled} onChange={event => setSetting('encoderPreset', event.target.value as VideoTranscodeSettings['encoderPreset'])} className="form-input mt-1 disabled:opacity-50"><option value="fast">快速</option><option value="balanced">平衡</option><option value="quality">质量优先</option></select></label>
            <label className="text-xs font-bold text-slate-600">目标视频码率<input type="number" min="0.1" max="800" step="0.1" value={settings.videoBitrateMbps ?? ''} disabled={videoDisabled || settings.videoMode === 'prores'} onChange={event => setSetting('videoBitrateMbps', event.target.value ? Number(event.target.value) : null)} placeholder="自动（Mbps）" className="form-input mt-1 disabled:opacity-50"/></label>
          </div>
        </section>
        <section className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <h3 className="mb-4 text-sm font-bold text-slate-800">画面与色彩</h3>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-xs font-bold text-slate-600">分辨率<select value={settings.resolution} disabled={videoDisabled} onChange={event => setSetting('resolution', event.target.value as VideoTranscodeSettings['resolution'])} className="form-input mt-1 disabled:opacity-50"><option value="original">保持原分辨率</option><option value="2160p">最大 4K</option><option value="1080p">最大 1080p</option><option value="720p">最大 720p</option></select></label>
            <label className="text-xs font-bold text-slate-600">输出色彩<select value={settings.colorMode} disabled={videoDisabled} onChange={event => { setPresetId(''); setSettings(current => ({ ...current, colorMode: event.target.value as VideoTranscodeSettings['colorMode'], ...(['hdr10', 'hlg'].includes(event.target.value) ? { bitDepth: '10' as const } : {}) })); }} className="form-input mt-1 disabled:opacity-50"><option value="auto">跟随来源</option><option value="sdr">Rec.709 SDR</option><option value="hdr10">HDR10 · PQ/BT.2020</option><option value="hlg">HLG · BT.2020</option></select></label>
            <label className="text-xs font-bold text-slate-600">位深<select value={settings.bitDepth} disabled={videoDisabled || ['hdr10', 'hlg'].includes(settings.colorMode) || settings.videoMode === 'prores'} onChange={event => setSetting('bitDepth', event.target.value as VideoTranscodeSettings['bitDepth'])} className="form-input mt-1 disabled:opacity-50"><option value="auto">跟随来源</option><option value="8">8-bit</option><option value="10">10-bit</option></select></label>
            <label className="text-xs font-bold text-slate-600">旋转<select value={settings.rotation} disabled={videoDisabled} onChange={event => setSetting('rotation', event.target.value as VideoTranscodeSettings['rotation'])} className="form-input mt-1 disabled:opacity-50"><option value="auto">自动应用来源方向</option><option value="0">不旋转</option><option value="90">顺时针 90°</option><option value="180">180°</option><option value="270">逆时针 90°</option></select></label>
            <label className="text-xs font-bold text-slate-600">像素宽高比<select value={settings.aspectMode} disabled={videoDisabled} onChange={event => setSetting('aspectMode', event.target.value as VideoTranscodeSettings['aspectMode'])} className="form-input mt-1 disabled:opacity-50"><option value="preserve">保留 SAR/DAR</option><option value="square-pixels">转为方形像素</option></select></label>
          </div>
        </section>
        <section className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <h3 className="mb-4 text-sm font-bold text-slate-800">帧率</h3>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-xs font-bold text-slate-600">帧率模式<select value={settings.frameRateMode} disabled={videoDisabled} onChange={event => { setPresetId(''); setSettings(current => ({ ...current, frameRateMode: event.target.value as VideoTranscodeSettings['frameRateMode'], ...(event.target.value === 'cfr' ? {} : { frameRate: 'original' as const }) })); }} className="form-input mt-1 disabled:opacity-50"><option value="preserve">保持时间戳</option><option value="cfr">CFR 固定帧率</option><option value="vfr">VFR 可变帧率</option></select></label>
            {settings.frameRateMode === 'cfr' && <label className="text-xs font-bold text-slate-600">目标帧率<select value={settings.frameRate} disabled={videoDisabled} onChange={event => setSetting('frameRate', event.target.value as VideoTranscodeSettings['frameRate'])} className="form-input mt-1 disabled:opacity-50"><option value="original">来源帧率</option>{['24', '25', '30', '50', '60'].map(value => <option key={value} value={value}>{value} fps</option>)}</select></label>}
          </div>
        </section>
        <section className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <h3 className="mb-4 text-sm font-bold text-slate-800">音频与字幕</h3>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-xs font-bold text-slate-600">音轨<select value={settings.audioTrack} disabled={disabled || settings.audioMode === 'remove'} onChange={event => setSetting('audioTrack', event.target.value as VideoTranscodeSettings['audioTrack'])} className="form-input mt-1"><option value="all">全部音轨</option><option value="first">仅第一音轨</option></select></label>
            <label className="text-xs font-bold text-slate-600">音频处理<select value={settings.audioMode} disabled={disabled} onChange={event => setSetting('audioMode', event.target.value as VideoTranscodeSettings['audioMode'])} className="form-input mt-1"><option value="copy">复制编码</option><option value="aac">AAC</option><option value="remove">移除音频</option></select></label>
            {settings.audioMode === 'aac' && <label className="text-xs font-bold text-slate-600">AAC 码率<select value={settings.audioBitrateKbps} disabled={disabled} onChange={event => setSetting('audioBitrateKbps', Number(event.target.value) as VideoTranscodeSettings['audioBitrateKbps'])} className="form-input mt-1 disabled:opacity-50">{[96, 128, 160, 192, 256, 320].map(value => <option key={value} value={value}>{value} kbps</option>)}</select></label>}
            <label className="text-xs font-bold text-slate-600">字幕<select value={settings.subtitleMode} disabled={disabled} onChange={event => setSetting('subtitleMode', event.target.value as VideoTranscodeSettings['subtitleMode'])} className="form-input mt-1"><option value="copy">复制字幕轨</option><option value="burn">烧录第一字幕轨</option><option value="remove">移除字幕</option></select></label>
          </div>
        </section>
      </div>
      {settingsOnly && <div className="flex items-center gap-3"><button type="button" disabled={inspection.isRunning || task.isRunning} onClick={() => inspection.start(['--inspect-only'], '正在检测媒体运行库与硬件编码能力…')} className="rounded-md border border-blue-300 px-4 py-2 text-sm font-bold text-blue-700 disabled:opacity-40">{inspection.isRunning ? '正在检测…' : '检测编码器与滤镜能力'}</button><span className="text-xs text-slate-500">{capabilities ? `可用硬件：${capabilities.usableHardwareEncoders?.join('、') || '无'}；滤镜：${capabilities.filters.join('、') || '基础集'}` : inspection.statusMsg}</span></div>}
      {!settingsOnly && paths.length > 0 && !inspection.isRunning && lastRequestedInspectionKeyRef.current === inspectionKey && !inspectionReady && <div className="flex items-center justify-between gap-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800"><span>媒体探测未成功，必须重新探测后才能开始编码。</span><button type="button" onClick={() => { lastRequestedInspectionKeyRef.current = ''; activeInspectionKeyRef.current = inspectionKey; startInspectionRef.current([...taskArguments, '--inspect-only'], '正在重新探测媒体…'); }} className="shrink-0 rounded border border-amber-300 bg-white px-2.5 py-1 font-bold">重试探测</button></div>}
      {blockingErrors.map(message => <div key={message} className="flex gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs leading-5 text-red-800"><AlertCircle size={15} className="mt-0.5 shrink-0"/>{message}</div>)}
      {warnings.map(message => <div key={message} className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800"><AlertCircle size={15} className="mt-0.5 shrink-0"/>{message}</div>)}
      {mediaInfo.filter(item => item.dynamicHdr).map(item => <div key={`dynamic-hdr:${item.path}`} className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800"><AlertCircle size={15} className="mt-0.5 shrink-0"/>{item.name} 含 {item.dynamicHdr} 动态元数据；跟随来源模式会阻止有损转码，请复制视频流或明确指定 SDR/HDR10/HLG 输出。</div>)}
      {!settingsOnly && <>
        <div className="flex flex-wrap items-center gap-3"><span className="text-sm text-slate-600">{mediaInfo.length > 0 && !inspection.isRunning && lastRequestedInspectionKeyRef.current === inspectionKey ? `${mediaInfo.length} 个视频 · 预计输出 ${formatMediaBytes(estimatedOutputBytes)}` : automaticEstimateStatus}</span></div>
        {mediaInfo.length > 0 && <div className="max-h-56 overflow-auto rounded-lg border border-slate-200"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-slate-100 text-slate-600"><tr><th className="p-2">文件</th><th className="p-2">画面</th><th className="p-2">色彩</th><th className="p-2">轨道</th><th className="p-2">预计输出</th></tr></thead><tbody>{mediaInfo.map(item => <tr key={item.path} className="border-t border-slate-100"><td className="max-w-48 truncate p-2" title={item.path}>{item.name}</td><td className="p-2">{item.codec} · {item.pixelFormat}<br/>{item.width}×{item.height} · {item.frameRate} fps<br/>SAR {item.sar} / DAR {item.dar} / {item.rotation}°</td><td className="p-2">{item.hdrKind} · {item.bitDepth}-bit<br/>{item.primaries}/{item.transfer}/{item.matrix}</td><td className="p-2">音频 {item.audioTracks} · 字幕 {item.subtitleTracks}</td><td className="p-2">{formatMediaBytes(item.estimatedOutputBytes)}</td></tr>)}</tbody></table></div>}
        <div role="radiogroup" aria-label="转码后如何保存" className="grid gap-3 md:grid-cols-2"><TranscodeOutputChoice selected={outputMode === 'new'} disabled={disabled} title="另存为新视频" description={activeSourceFolders.length ? '输出到来源文件夹旁的新“_转码”目录，并保留目录结构。' : '保存在原视频旁，文件名增加“_转码”。'} onSelect={() => setOutputMode('new')}/><TranscodeOutputChoice selected={outputMode === 'delete-original'} disabled={disabled} title="替换原视频" description="转码结果校验通过后替换原视频，原视频将移入回收站；失败时保留原视频。" onSelect={() => setOutputMode('delete-original')}/></div>
        {task.completion?.event.report?.length ? <div className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">技术校验完成：{task.completion.event.report.length} 个输出有效{task.completion.event.failedCount ? `，${task.completion.event.failedCount} 个失败` : ''}。</div> : null}
        <TaskProgress logs={task.logs} progress={task.progress} isRunning={task.isRunning} reportToTaskCenter={false} idleMessage={sourcesLoading || resolvingKinds ? '正在读取来源…' : task.statusMsg} statusMessage={sourcesLoading || resolvingKinds ? '正在读取来源…' : task.statusMsg} action={<div className="flex gap-2">{task.isRunning && !task.isCancelling && <button type="button" onClick={() => void task.setPaused(!task.isPaused)} className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 font-bold text-slate-700">{task.isPaused ? <Play size={17}/> : <Pause size={17}/>}{task.isPaused ? '继续' : '暂停'}</button>}<button type="button" onClick={task.isRunning ? () => void task.cancel() : startTranscode} disabled={task.isCancelling || !task.isRunning && !canStartTranscode} className={`flex items-center gap-2 rounded-lg px-6 py-2.5 font-bold transition ${task.isRunning ? 'bg-red-600 text-white hover:bg-red-500' : canStartTranscode ? 'bg-blue-600 text-white hover:bg-blue-500' : 'cursor-not-allowed border border-slate-200 bg-slate-100 text-slate-400'}`}>{task.isRunning ? task.isCancelling ? <Loader2 size={17} className="animate-spin"/> : <X size={17}/> : <Play size={17} fill="currentColor"/>}{task.isRunning ? task.isCancelling ? '正在取消…' : '取消队列' : '开始编码'}</button></div>}/>
      </>}
    </div>
  </div>;
};

const VideoSplitView = ({ embedded = false, initialTargetPath = '', initialTargetPaths = [], settingsOnly = false }: { embedded?: boolean; initialTargetPath?: string; initialTargetPaths?: string[]; settingsOnly?: boolean }) => {
  const initialTargetKey = (initialTargetPaths.length ? initialTargetPaths : initialTargetPath ? [initialTargetPath] : []).join('\n');
  const [targetPaths, setTargetPaths] = useState<string[]>(() => initialTargetKey.split('\n').filter(Boolean));
  const { pathKinds, resolvingKinds } = useSourcePathKinds(targetPaths);
  const { logs, isRunning, isCancelling, progress, statusMsg, start, cancel } = usePythonTask('cut_video.py', '等待输入...');

  useEffect(() => {
    setTargetPaths([...new Set(initialTargetKey.split('\n').filter(Boolean))]);
  }, [initialTargetKey]);

  const appendTargets = (paths: string[]) => {
    setTargetPaths(current => [...new Set([...current, ...paths.map(value => value.trim()).filter(Boolean)])].slice(0, 120));
  };
  const startSplit = () => {
    if (!targetPaths.length) return;
    start(targetPaths, '正在扫描视频...');
  };
  const chooseVideos = async () => {
    if (isRunning) return;
    const result = await window.electronAPI.chooseVideoFiles();
    if (!result.cancelled) appendTargets(result.paths);
  };
  const chooseFolder = async () => {
    if (isRunning) return;
    const result = await window.electronAPI.chooseVideoFolder();
    if (!result.cancelled && result.path) appendTargets([result.path]);
  };

  return (
    <div className="w-full space-y-4">
      {!embedded && <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <Scissors size={24} /> 视频切割
      </h2>}
      <div className={`space-y-4 ${embedded ? '' : 'rounded-xl border border-slate-200 bg-white p-6'}`}>

        <div className="space-y-2">
          <p className="text-sm text-slate-600">
            原视频保持不变，分段文件写入原视频所在目录。
          </p>
        </div>

        {!settingsOnly && <SourcePathPicker paths={targetPaths} pathKinds={pathKinds} folderPreviewExtensions={VIDEO_SOURCE_PREVIEW_EXTENSIONS} onChange={setTargetPaths} onChooseFiles={chooseVideos} onChooseFolder={chooseFolder} fileButtonLabel="追加视频" folderButtonLabel="追加文件夹" loading={resolvingKinds} disabled={isRunning} title="已选择" itemLabel="个来源" description="文件夹会作为一个来源显示；执行时扫描子目录，分段写入原目录" emptyTitle="拖入视频或文件夹"/>}

        <div className="grid gap-3 md:grid-cols-2"><label className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3"><span className="block text-[10px] font-bold uppercase tracking-wide text-slate-400">分段大小</span><span className="mt-1 block text-sm font-bold text-slate-700">约 3.95 GB（固定）</span></label><label className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3"><span className="block text-[10px] font-bold uppercase tracking-wide text-slate-400">输出名称</span><span className="mt-1 block truncate text-sm font-bold text-slate-700">{targetPaths.length === 1 && pathKinds[sourcePathIdentity(targetPaths[0])] === 'folder' ? '文件夹内每个视频分别生成 _part001' : targetPaths.length === 1 ? <span className="font-mono">{targetPaths[0].split(/[\\/]/).pop()?.replace(/(\.[^.]+)$/u, '_part001$1')}</span> : targetPaths.length > 1 ? `按 ${targetPaths.length} 个来源分别处理` : '视频名_part001.mp4'}</span></label></div>

        {!settingsOnly && <TaskProgress
          logs={logs}
          progress={progress}
          isRunning={isRunning}
          reportToTaskCenter={false}
          idleMessage={statusMsg}
          action={<button
            onClick={isRunning ? () => void cancel() : startSplit}
            disabled={!targetPaths.length || isCancelling || resolvingKinds}
            className={`px-8 py-2.5 rounded-lg font-bold transition flex items-center gap-2 ${
              !targetPaths.length || isCancelling || resolvingKinds
                ? 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed shadow-none'
                : isRunning ? 'bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-500/20' : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20'
            }`}
          >
            {isCancelling ? <Loader2 className="animate-spin" size={18}/> : isRunning ? <X size={18}/> : <Scissors size={18} fill="currentColor"/>}
            {isCancelling ? '正在取消…' : isRunning ? '取消切割' : `开始切割${targetPaths.length > 1 ? `（${targetPaths.length} 项）` : ''}`}
          </button>}
        />}
      </div>

    </div>
  );
};

// --- 组件 ---

export { DashboardView, HomePanel, ImportCard, ConverterView, ScreenshotMainImageView, ResearchView, MatchView, VideoTranscodeView, VideoSplitView };
