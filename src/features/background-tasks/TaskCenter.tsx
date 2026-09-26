/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { workspaceWindowContext, type WindowPanelSnapshot } from '../../platform/workspace-window-client';
import type { BackgroundTask, LogEntry } from '../../types';
import { nextPanelTaskStartedAt, panelTaskSessionKey, removePanelTaskSession, removePanelTasksByOwnerPageId } from './panel-task-session-model';
import { pruneFinishedTaskToastIds, setTaskToastMinimized, taskToastInstanceKey } from './task-toast-model';
import { initialBackgroundTaskStreamState, receiveBackgroundTaskDelta, receiveBackgroundTaskSnapshot, type BackgroundTaskStreamState } from './background-task-stream-model';

export type PanelTaskState = 'idle' | 'running' | 'completed' | 'failed';

export interface PanelTaskSnapshot {
  nativeTabId?: string;
  originKey?: string;
  key: string;
  ownerPageId: string;
  panelKind: string;
  title: string;
  state: PanelTaskState;
  progress: number;
  message: string;
  logs: LogEntry[];
  startedAt: number;
  updatedAt: number;
}

type PanelTaskReport = Omit<PanelTaskSnapshot, 'key' | 'ownerPageId' | 'panelKind' | 'title' | 'startedAt' | 'updatedAt'>;

interface TaskCenterValue {
  backgroundTasks: BackgroundTask[];
  backgroundTaskSyncing: boolean;
  backgroundTaskDegraded: boolean;
  panelTasks: Record<string, PanelTaskSnapshot>;
  reportPanelTask: (identity: Pick<PanelTaskSnapshot, 'key' | 'ownerPageId' | 'panelKind' | 'title'>, report: PanelTaskReport) => void;
  dismissPanelTask: (key: string) => void;
  withdrawPanelTask: (key: string) => void;
  dismissPanelTasksByOwnerPageId: (pageId: string) => void;
  dismissBackgroundTask: (id: string) => Promise<unknown>;
  retryBackgroundTask: (id: string) => Promise<unknown>;
  minimizeTaskToast: (id: string) => void;
  restoreTaskToast: (id: string) => void;
  isTaskToastMinimized: (id: string) => boolean;
}

const TaskCenterContext = createContext<TaskCenterValue | null>(null);
type PanelTaskIdentity = Pick<PanelTaskSnapshot, 'key' | 'ownerPageId' | 'panelKind' | 'title'>;
type PanelTaskContextValue = {
  identity: PanelTaskIdentity;
  report: (report: PanelTaskReport) => void;
};
const PanelTaskReporterContext = createContext<PanelTaskContextValue | null>(null);

const sameLogs = (left: LogEntry[], right: LogEntry[]) => {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  const leftLast = left[left.length - 1];
  const rightLast = right[right.length - 1];
  return leftLast?.timestamp === rightLast?.timestamp && leftLast?.message === rightLast?.message && leftLast?.type === rightLast?.type;
};

type BackgroundTaskStreamAction =
  | { type: 'delta'; delta: Parameters<typeof receiveBackgroundTaskDelta>[1] }
  | { type: 'snapshot'; snapshot: Parameters<typeof receiveBackgroundTaskSnapshot>[1] }
  | { type: 'snapshot-retry' };

const backgroundTaskStreamReducer = (state: BackgroundTaskStreamState, action: BackgroundTaskStreamAction) => {
  if (action.type === 'delta') return receiveBackgroundTaskDelta(state, action.delta);
  if (action.type === 'snapshot') return receiveBackgroundTaskSnapshot(state, action.snapshot);
  return { ...state, hydrated: false, syncing: true, degraded: true, retryAttempt: state.retryAttempt + 1, snapshotRequest: state.snapshotRequest + 1 };
};

export const TaskCenterProvider = ({ children }: { children: React.ReactNode }) => {
  const [backgroundTaskStream, dispatchBackgroundTaskStream] = useReducer(backgroundTaskStreamReducer, undefined, initialBackgroundTaskStreamState);
  const backgroundTasks = backgroundTaskStream.tasks;
  const [localPanelTasks, setPanelTasks] = useState<Record<string, PanelTaskSnapshot>>({});
  const [remotePanels, setRemotePanels] = useState<WindowPanelSnapshot>({ revision: -1, tasks: [] });
  const nativeTabId = workspaceWindowContext()?.id;
  const panelTasks = useMemo(() => ({ ...Object.fromEntries(remotePanels.tasks.filter(task => task.nativeTabId !== nativeTabId).map(task => [task.key, task])), ...localPanelTasks }), [localPanelTasks, remotePanels, nativeTabId]);
  const latestPanels = useRef(localPanelTasks);
  latestPanels.current = localPanelTasks;
  const remotePanelsRef = useRef(remotePanels.tasks);
  remotePanelsRef.current = remotePanels.tasks;
  const panelPublishTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    const api = window.electronAPI.workspaceWindows;
    if (!api || panelPublishTimer.current) return;
    panelPublishTimer.current = setTimeout(() => {
      panelPublishTimer.current = undefined;
      void api.updatePanels(Object.values(latestPanels.current).map(task => ({ ...task, logs: task.logs.slice(-100) }))).catch(error => window.electronAPI.reportRendererError('同步任务面板失败', String(error)));
    }, 100);
  }, [localPanelTasks]);
  useEffect(() => {
    const api = window.electronAPI.workspaceWindows;
    if (!api) return;
    const receive = (snapshot: WindowPanelSnapshot) => setRemotePanels(current => snapshot.revision >= current.revision ? snapshot : current);
    const unsubscribe = api.onPanels(receive);
    void api.panels().then(receive).catch(() => undefined);
    const restore = api.onRestorePanel(detail => window.dispatchEvent(new CustomEvent('photoflow:restore-panel-task', { detail })));
    const dismiss = api.onDismissPanel(key => setPanelTasks(current => { if (!current[key] || current[key].state === 'running') return current; const next = { ...current }; delete next[key]; return next; }));
    return () => { unsubscribe(); restore(); dismiss(); clearTimeout(panelPublishTimer.current); panelPublishTimer.current = undefined; };
  }, []);
  const [minimizedToastTaskIds, setMinimizedToastTaskIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const unsubscribe = window.electronAPI.onBackgroundTaskChanged(delta => {
      dispatchBackgroundTaskStream({ type: 'delta', delta });
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    void window.electronAPI.getBackgroundTasks().then(result => {
      if (!active) return;
      if (result.success) dispatchBackgroundTaskStream({ type: 'snapshot', snapshot: result });
      else retryTimer = setTimeout(() => dispatchBackgroundTaskStream({ type: 'snapshot-retry' }), Math.min(30_000, 1000 * 2 ** backgroundTaskStream.retryAttempt));
    }).catch(() => {
      if (active) retryTimer = setTimeout(() => dispatchBackgroundTaskStream({ type: 'snapshot-retry' }), Math.min(30_000, 1000 * 2 ** backgroundTaskStream.retryAttempt));
    });
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [backgroundTaskStream.snapshotRequest]);

  useEffect(() => {
    setMinimizedToastTaskIds(current => pruneFinishedTaskToastIds(current, backgroundTasks));
  }, [backgroundTasks]);

  const reportPanelTask = useCallback((identity: Pick<PanelTaskSnapshot, 'key' | 'ownerPageId' | 'panelKind' | 'title'>, report: PanelTaskReport) => {
    setPanelTasks(current => {
      const previous = current[identity.key];
      const progress = previous?.state === 'running' && report.state === 'running' ? Math.max(previous.progress, report.progress) : report.progress;
      const updatedAt = Date.now();
      const startedAt = nextPanelTaskStartedAt(previous, report.state, updatedAt);
      if (previous && previous.state === report.state && previous.progress === progress && previous.message === report.message && previous.startedAt === startedAt && sameLogs(previous.logs, report.logs)) return current;
      return {
        ...current,
        [identity.key]: { ...identity, ...report, progress, startedAt, updatedAt },
      };
    });
  }, []);

  const dismissPanelTask = useCallback((key: string) => {
    const remote = remotePanelsRef.current.find(task => task.key === key && task.nativeTabId !== workspaceWindowContext()?.id);
    if (remote?.nativeTabId && window.electronAPI.workspaceWindows) { void window.electronAPI.workspaceWindows.dismissPanel(remote.nativeTabId, remote.originKey || key); return; }
    setPanelTasks(current => {
      if (!current[key] || current[key].state === 'running') return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const dismissPanelTasksByOwnerPageId = useCallback((pageId: string) => {
    setPanelTasks(current => removePanelTasksByOwnerPageId(current, pageId));
  }, []);

  // Only the panel that owns a session withdraws it here, which is what lets an
  // operation end its own busy mirror after its modal has already unmounted.
  const withdrawPanelTask = useCallback((key: string) => {
    setPanelTasks(current => removePanelTaskSession(current, key));
  }, []);

  const dismissBackgroundTask = useCallback(async (id: string) => {
    return window.electronAPI.dismissBackgroundTask(id);
  }, []);

  const retryBackgroundTask = useCallback(async (id: string) => {
    return window.electronAPI.retryBackgroundTask(id);
  }, []);

  const minimizeTaskToast = useCallback((id: string) => {
    const task = backgroundTasks.find(candidate => candidate.id === id);
    if (task) setMinimizedToastTaskIds(current => setTaskToastMinimized(current, taskToastInstanceKey(task), true));
  }, [backgroundTasks]);
  const restoreTaskToast = useCallback((id: string) => {
    const task = backgroundTasks.find(candidate => candidate.id === id);
    if (task) setMinimizedToastTaskIds(current => setTaskToastMinimized(current, taskToastInstanceKey(task), false));
  }, [backgroundTasks]);
  const isTaskToastMinimized = useCallback((id: string) => {
    const task = backgroundTasks.find(candidate => candidate.id === id);
    return Boolean(task && minimizedToastTaskIds.has(taskToastInstanceKey(task)));
  }, [backgroundTasks, minimizedToastTaskIds]);

  const value = useMemo<TaskCenterValue>(() => ({ backgroundTasks, backgroundTaskSyncing: backgroundTaskStream.syncing, backgroundTaskDegraded: backgroundTaskStream.degraded, panelTasks, reportPanelTask, dismissPanelTask, withdrawPanelTask, dismissPanelTasksByOwnerPageId, dismissBackgroundTask, retryBackgroundTask, minimizeTaskToast, restoreTaskToast, isTaskToastMinimized }), [backgroundTaskStream.degraded, backgroundTaskStream.syncing, backgroundTasks, dismissBackgroundTask, dismissPanelTask, dismissPanelTasksByOwnerPageId, isTaskToastMinimized, minimizeTaskToast, panelTasks, reportPanelTask, restoreTaskToast, retryBackgroundTask, withdrawPanelTask]);
  return <TaskCenterContext.Provider value={value}>{children}</TaskCenterContext.Provider>;
};

export const useTaskCenter = () => {
  const value = useContext(TaskCenterContext);
  if (!value) throw new Error('useTaskCenter must be used inside TaskCenterProvider');
  return value;
};

export const PanelTaskScope = ({ ownerPageId, panelKind, title, children }: { ownerPageId: string; panelKind: string; title: string; children: React.ReactNode }) => {
  const { reportPanelTask } = useTaskCenter();
  const key = panelTaskSessionKey(ownerPageId, panelKind);
  const identity = useMemo<PanelTaskIdentity>(() => ({ key, ownerPageId, panelKind, title }), [key, ownerPageId, panelKind, title]);
  const report = useCallback((value: PanelTaskReport) => reportPanelTask(identity, value), [identity, reportPanelTask]);
  const value = useMemo<PanelTaskContextValue>(() => ({ identity, report }), [identity, report]);
  return <PanelTaskReporterContext.Provider value={value}>{children}</PanelTaskReporterContext.Provider>;
};

export const usePanelTaskReporter = () => useContext(PanelTaskReporterContext)?.report || null;
export const usePanelTaskIdentity = () => useContext(PanelTaskReporterContext)?.identity || null;
