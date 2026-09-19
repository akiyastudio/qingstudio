/* eslint-disable react-refresh/only-export-components */
import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Clock3, Loader2, Minimize2, Pause, Play, X, XCircle } from 'lucide-react';
import type { BackgroundTask } from '../../types';
import { useTaskCenter } from './TaskCenter';
import { selectProjectFileTaskToasts, taskToastExpiresAt, taskToastInstanceKey, taskToastLiveRole } from './task-toast-model';
import { useToastStackReflow } from '../../components/toast-stack-reflow';
import { formatTaskBytes, normalizeTaskProgress } from '../../components/useTaskPresentation';

export type FileTransferToastPresentation = { visibleTasks: BackgroundTask[]; overflowCount: number };
type FileTransferToastActions = {
  onMinimize: (id: string) => void;
  onDismiss: (id: string) => void;
  onPause: (id: string) => void;
  onContinue: (id: string) => void;
  onCancel: (task: BackgroundTask) => void;
};

export const FileTransferToastItem = ({ task, onMinimize, onDismiss, onPause, onContinue, onCancel }: { task: BackgroundTask } & FileTransferToastActions) => {
  const metadata = task.metadata || {};
  const filesCopied = Number(metadata.filesCopied ?? metadata.processedCount ?? 0);
  const totalFiles = Number(metadata.totalFiles ?? metadata.totalCount ?? 0);
  const operation = String(metadata.operation || '');
  const countUnit = metadata.filesCopied !== undefined || metadata.totalFiles !== undefined || ['copy', 'paste', 'import', 'import-project'].includes(operation) ? '文件' : '项';
  const bytesCopied = Number(metadata.bytesCopied || 0);
  const totalBytes = Number(metadata.totalBytes || 0);
  const progress = normalizeTaskProgress(task.progress);
  const queued = task.state === 'queued';
  const resuming = task.state === 'resuming';
  const paused = task.state === 'paused';
  const pausing = task.state === 'pausing';
  const failed = task.state === 'failed';
  const completed = task.state === 'completed';
  const versionTracking = task.type === 'version-tracking';
  const message = failed ? task.error || task.message || '任务失败' : completed ? task.message || '任务已完成' : queued
    ? task.message || '等待其他文件操作完成'
    : paused ? '已暂停' : pausing ? '正在暂停…' : task.message || (resuming ? '正在继续任务…' : versionTracking ? '正在准备版本比较…' : '正在处理任务…');
  const details = [
    totalFiles > 0 ? `${filesCopied}/${totalFiles} ${countUnit}` : '',
    totalBytes > 0 ? `${formatTaskBytes(bytesCopied)}/${formatTaskBytes(totalBytes)}` : '',
  ].filter(Boolean).join(' · ');
  return <div role={taskToastLiveRole(task.state)} data-top-toast-id={`task:${task.id}`} className={`file-transfer-toast ${failed ? 'border-red-200 bg-red-50' : completed ? 'border-emerald-200 bg-emerald-50' : ''}`}>
    <div className="flex min-w-0 items-center gap-3">
      {failed ? <XCircle size={16} className="shrink-0 text-red-600"/> : completed ? <CheckCircle2 size={16} className="shrink-0 text-emerald-600"/> : queued ? <Clock3 size={16} className="shrink-0 text-blue-600"/> : paused || pausing ? <Pause size={16} className="shrink-0 text-amber-600"/> : <Loader2 size={16} className="shrink-0 animate-spin text-blue-600"/>}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3 text-xs"><span className={`truncate font-bold ${failed ? 'text-red-800' : completed ? 'text-emerald-800' : 'text-blue-800'}`}>{message}</span>{!queued && !failed && !completed && <span className="shrink-0 font-mono font-bold tabular-nums text-blue-700">{Math.round(progress)}%</span>}</div>
        {!queued && !failed && !completed && <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-blue-100"><div className="h-full rounded-full bg-blue-600 transition-[width] duration-150" style={{ width: `${progress > 0 ? Math.max(2, progress) : 0}%` }}/></div>}
        <p className="mt-1 line-clamp-1 text-[11px] tabular-nums text-blue-600">{queued ? task.blockedByTaskIds?.length ? '占用任务结束后自动开始' : versionTracking ? '完成后自动开始版本比较' : '等待所需资源可用后自动开始' : details || (versionTracking ? '比较完成后可确认版本匹配' : task.title)}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {failed || completed
          ? <button type="button" onClick={() => onDismiss(task.id)} aria-label="关闭通知" title="关闭通知" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"><X size={15}/></button>
          : <button type="button" onClick={() => onMinimize(task.id)} aria-label="收起到任务中心" title="收起到任务中心，任务会继续运行" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-blue-200 bg-white/70 text-blue-700 transition hover:border-blue-300 hover:bg-blue-100"><Minimize2 size={15}/></button>}
        {(task.state === 'running' || task.state === 'resuming') && task.capabilities.pausable && <button type="button" onClick={() => onPause(task.id)} aria-label="暂停任务" title="暂停任务" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-amber-700 transition hover:bg-amber-50"><Pause size={15}/></button>}
        {paused && task.capabilities.pausable && <button type="button" onClick={() => onContinue(task.id)} aria-label="继续任务" title="继续任务" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-blue-700 transition hover:bg-blue-50"><Play size={15}/></button>}
        {!failed && !completed && task.cancellable && <button type="button" onClick={() => onCancel(task)} aria-label="取消任务" title="取消任务" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-red-600 transition hover:bg-red-50"><X size={16}/></button>}
      </div>
    </div>
  </div>;
};

export const useFileTransferToastPresentation = () => {
  const { backgroundTasks, backgroundTaskSyncing, dismissBackgroundTask, isTaskToastMinimized, minimizeTaskToast } = useTaskCenter();
  const [clock, setClock] = useState(() => Date.now());
  const firstVisibleAtRef = useRef(new Map<string, number>());
  const initializedRef = useRef(false);
  const seenStateRef = useRef(new Map<string, BackgroundTask['state']>());
  const [pendingResultKeys, setPendingResultKeys] = useState<Set<string>>(() => new Set());
  const minimizedTaskIds = useMemo(() => new Set(backgroundTasks.filter(task => isTaskToastMinimized(task.id)).map(taskToastInstanceKey)), [backgroundTasks, isTaskToastMinimized]);

  useEffect(() => {
    if (!initializedRef.current && backgroundTaskSyncing) return;
    const currentKeys = new Set(backgroundTasks.map(taskToastInstanceKey));
    for (const key of firstVisibleAtRef.current.keys()) if (!currentKeys.has(key)) firstVisibleAtRef.current.delete(key);
    if (!initializedRef.current) {
      initializedRef.current = true;
      seenStateRef.current = new Map(backgroundTasks.map(task => [taskToastInstanceKey(task), task.state]));
      return;
    }
    setPendingResultKeys(current => {
      const next = new Set([...current].filter(key => currentKeys.has(key)));
      for (const task of backgroundTasks) {
        const key = taskToastInstanceKey(task);
        const previousState = seenStateRef.current.get(key);
        const terminal = task.state === 'failed' || task.state === 'completed';
        const previouslyTerminal = previousState === 'failed' || previousState === 'completed';
        if (terminal && !previouslyTerminal) next.add(key);
      }
      return next;
    });
    seenStateRef.current = new Map(backgroundTasks.map(task => [taskToastInstanceKey(task), task.state]));
  }, [backgroundTaskSyncing, backgroundTasks]);

  const { visible: visibleTasks, overflowCount } = useMemo(() => selectProjectFileTaskToasts(backgroundTasks, minimizedTaskIds, 4, clock, 700, firstVisibleAtRef.current, pendingResultKeys), [backgroundTasks, clock, minimizedTaskIds, pendingResultKeys]);

  useEffect(() => {
    const now = Date.now();
    let anchored = false;
    for (const task of visibleTasks) {
      if (task.state !== 'failed' && task.state !== 'completed') continue;
      const key = taskToastInstanceKey(task);
      if (!firstVisibleAtRef.current.has(key)) { firstVisibleAtRef.current.set(key, now); anchored = true; }
    }
    if (anchored) setClock(now);
  }, [visibleTasks]);

  useEffect(() => {
    const currentTime = Date.now();
    const nextDue = backgroundTasks
      .filter(task => !isTaskToastMinimized(task.id))
      .map(task => task.state === 'queued' ? task.createdAt + 700 : taskToastExpiresAt(task, firstVisibleAtRef.current.get(taskToastInstanceKey(task))))
      .filter(due => due > currentTime)
      .sort((left, right) => left - right)[0];
    if (!nextDue) return;
    const timer = window.setTimeout(() => setClock(Date.now()), nextDue - currentTime + 10);
    return () => window.clearTimeout(timer);
  }, [backgroundTasks, clock, isTaskToastMinimized]);

  useEffect(() => { setClock(Date.now()); }, [backgroundTasks]);

  return { visibleTasks, overflowCount, dismissBackgroundTask, minimizeTaskToast };
};

export const FileTransferToast = ({ stackRef, presentation, reflowKey }: { stackRef: React.RefObject<HTMLDivElement | null>; presentation: ReturnType<typeof useFileTransferToastPresentation>; reflowKey: string }) => {
  const { visibleTasks, overflowCount, minimizeTaskToast } = presentation;
  const [pendingAction, setPendingAction] = useState('');
  const pendingActionRef = useRef('');
  const [actionError, setActionError] = useState('');
  const runAction = async (key: string, action: () => Promise<unknown>) => {
    if (pendingActionRef.current) return;
    pendingActionRef.current = key;
    setPendingAction(key); setActionError('');
    try { const result = await action() as { success?: boolean; error?: string } | undefined; if (result?.success === false) throw new Error(result.error || '操作未成功'); }
    catch (error) { setActionError(error instanceof Error ? error.message : '操作未成功'); }
    finally { pendingActionRef.current = ''; setPendingAction(''); }
  };
  useToastStackReflow(stackRef, reflowKey);

  if (!visibleTasks.length) return null;

  return <>
    {pendingAction && <span className="sr-only" role="status">正在执行任务操作</span>}
    {visibleTasks.map(task => <FileTransferToastItem key={taskToastInstanceKey(task)} task={task} onMinimize={minimizeTaskToast} onDismiss={minimizeTaskToast} onPause={id => void runAction(`pause:${id}`, () => window.electronAPI.pauseBackgroundTask(id))} onContinue={id => void runAction(`continue:${id}`, () => window.electronAPI.continueBackgroundTask(id))} onCancel={task => void runAction(`cancel:${task.id}`, () => task.type === 'selection-operation' ? window.electronAPI.cancelSelectionOperation(String(task.metadata?.operationId || '')) : window.electronAPI.cancelBackgroundTask(task.id))}/>) }
    {actionError && <div role="alert" className="file-transfer-toast border-red-200 bg-red-50 text-xs text-red-700">{actionError}</div>}
    {overflowCount > 0 && <div data-top-toast-id="task-overflow" className="file-transfer-toast-overflow">还有 {overflowCount} 个任务</div>}
  </>;
};
