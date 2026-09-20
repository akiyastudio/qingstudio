import { LocalizedText } from "../../i18n/LocalizedText";
import { renderText } from '../../i18n/messages';
import { useLocale } from "../../i18n/react";
import { t } from "../../i18n/runtime";
import { useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Activity, Pause, Play, RotateCcw, Trash2, X } from 'lucide-react';
import { ProgressBar } from '../../components/ProgressBar';
import { useEscapeLayer } from '../../components/LayerProvider';
import type { BackgroundTask } from '../../types';
import { useTaskCenter } from './TaskCenter';
import { panelTaskRestoreDetail } from './panel-task-session-model';
import { collapseRetryPredecessors, compareTaskCenterPublishedAt, formatBackgroundTaskStartedAt, isBackgroundTaskCenterVisible, isBackgroundTaskDismissible } from './task-toast-model';
import { formatTaskBytes, taskStateLabel } from '../../components/useTaskPresentation';
const taskSummary = (task: BackgroundTask) => {
  const metadata = task.metadata || {};
  const completed = Number(metadata.filesCopied ?? metadata.processedCount ?? 0);
  const total = Number(metadata.totalFiles ?? metadata.totalCount ?? 0);
  const copiedBytes = Number(metadata.bytesCopied ?? 0);
  const totalBytes = Number(metadata.totalBytes ?? 0);
  const parts: string[] = [];
  if (total > 0) parts.push(`${completed}/${total} 项`);
  if (totalBytes > 0) parts.push(`${formatTaskBytes(copiedBytes)}/${formatTaskBytes(totalBytes)}`);
  return parts.join(' · ');
};

export const BackgroundTaskIndicator = ({ ownerPageIds: localOwnerPageIds, open, onOpenChange, drawerHostRef }: { ownerPageIds: ReadonlySet<string>; open: boolean; onOpenChange: (open: boolean) => void; drawerHostRef: RefObject<HTMLDivElement | null> }) => {
  useLocale();
  const { backgroundTasks: tasks, backgroundTaskSyncing, backgroundTaskDegraded, panelTasks, dismissPanelTask, dismissBackgroundTask, retryBackgroundTask, isTaskToastMinimized, restoreTaskToast } = useTaskCenter();
  const ownerPageIds = useMemo(() => new Set([...localOwnerPageIds, ...Object.values(panelTasks).map(task => task.ownerPageId)]), [localOwnerPageIds, panelTasks]);
  const [actionError, setActionError] = useState('');
  const [actionPending, setActionPending] = useState(false);
  const actionPendingRef = useRef(false);
  const runAction = async (action: () => Promise<unknown>) => {
    if (actionPendingRef.current) return;
    actionPendingRef.current = true;
    setActionPending(true);
    setActionError('');
    try {
      const result = await action() as { success?: boolean; error?: string } | undefined;
      if (result?.success === false) throw new Error(result.error || '操作未成功');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '操作未成功');
    } finally {
      actionPendingRef.current = false;
      setActionPending(false);
    }
  };
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeAndRestoreFocus = () => {
    onOpenChange(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };
  useEscapeLayer(open, closeAndRestoreFocus);

  const presentedTasks = useMemo(() => collapseRetryPredecessors(tasks), [tasks]);
  const visibleTasks = useMemo(() => presentedTasks.filter(task => isBackgroundTaskCenterVisible(task) || (
    task.type === 'python-tool'
    && task.state === 'completed'
    && ownerPageIds.has(String(task.metadata?.presentationOwnerPageId || ''))
  )), [ownerPageIds, presentedTasks]);
  const visiblePanelTasks = useMemo(() => Object.values(panelTasks).filter(task => task.state !== 'idle' && ownerPageIds.has(task.ownerPageId)), [ownerPageIds, panelTasks]);
  const visibleTaskItems = useMemo(() => [
    ...visiblePanelTasks.map(task => ({ kind: 'panel' as const, task })),
    ...visibleTasks.map(task => ({ kind: 'background' as const, task })),
  ].sort((left, right) => compareTaskCenterPublishedAt(left.task, right.task)), [visiblePanelTasks, visibleTasks]);
  const runningCount = visibleTasks.filter(task => task.state === 'queued' || task.state === 'running' || task.state === 'resuming').length + visiblePanelTasks.filter(task => task.state === 'running').length;
  const failedCount = visibleTasks.filter(task => task.state === 'failed').length + visiblePanelTasks.filter(task => task.state === 'failed').length;
  const visibleCount = visibleTasks.length + visiblePanelTasks.length;
  // Include collapsed retry predecessors so clearing their successors cannot
  // make old failures reappear in the drawer.
  const dismissibleTasks = tasks.filter(isBackgroundTaskDismissible);
  const dismissiblePanelTasks = visiblePanelTasks.filter(task => task.state !== 'running');
  const clearInactiveTasks = () => runAction(async () => {
    const results = await Promise.allSettled(dismissibleTasks.map(task => dismissBackgroundTask(task.id)));
    dismissiblePanelTasks.forEach(task => dismissPanelTask(task.key));
    const failed = results.some(result => result.status === 'rejected'
      || (result.value as { success?: boolean } | undefined)?.success === false);
    if (failed) throw new Error('部分任务未能清除，任务状态可能已变化，请重试');
    closeAndRestoreFocus();
  });
  const restorePanelTask = (task: (typeof visiblePanelTasks)[number]) => {
    if (window.electronAPI.workspaceWindows) void window.electronAPI.workspaceWindows.restorePanel(task.ownerPageId, task.panelKind, task.nativeTabId);
    else window.dispatchEvent(new CustomEvent('photoflow:restore-panel-task', { detail: panelTaskRestoreDetail(task.ownerPageId, task.panelKind) }));
    onOpenChange(false);
  };
  const restoreBackgroundTaskPanel = (task: BackgroundTask) => {
    const ownerPageId = String(task.metadata?.presentationOwnerPageId || '');
    const panelKind = String(task.metadata?.presentationPanelKind || '');
    if (!ownerPageId || !panelKind || !ownerPageIds.has(ownerPageId)) return;
    if (window.electronAPI.workspaceWindows) void window.electronAPI.workspaceWindows.restorePanel(ownerPageId, panelKind);
    else window.dispatchEvent(new CustomEvent('photoflow:restore-panel-task', { detail: panelTaskRestoreDetail(ownerPageId, panelKind) }));
    onOpenChange(false);
  };
  const cancelTask = (task: BackgroundTask) => task.type === 'selection-operation'
    ? window.electronAPI.cancelSelectionOperation(String(task.metadata?.operationId || ''))
    : window.electronAPI.cancelBackgroundTask(task.id);
  const resumeTask = (task: BackgroundTask) => window.electronAPI.resumeBackgroundTask(task.id);
  const restartTask = (task: BackgroundTask) => window.electronAPI.restartBackgroundTask(task.id);
  const pauseTask = (task: BackgroundTask) => window.electronAPI.pauseBackgroundTask(task.id);
  const continueTask = (task: BackgroundTask) => window.electronAPI.continueBackgroundTask(task.id);
  const showTaskProgress = (task: BackgroundTask) => {
    restoreTaskToast(task.id);
    onOpenChange(false);
  };
  const openTrackingConfirmation = (task: BackgroundTask) => {
    const sessionId = String(task.metadata?.sessionId || '');
    if (!sessionId) return;
    window.dispatchEvent(new CustomEvent('photoflow:open-tracking-confirmation', {
      detail: { sessionId, progressId: String(task.metadata?.progressId || ''), taskId: task.id },
    }));
    onOpenChange(false);
  };

  return <div className="app-titlebar-control relative flex shrink-0 items-center px-1">
    <button ref={triggerRef} type="button" aria-expanded={open} aria-controls="background-task-drawer" onClick={() => onOpenChange(!open)} title={t("ui.background.tasks.4c46c9")} aria-label={t("ui.background.tasks.4c46c9")} className={`relative flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium ${failedCount ? 'text-red-600 hover:bg-red-50' : 'text-slate-500 hover:bg-slate-100'}`}>
      <Activity size={15}/>{runningCount > 0 && <span>{runningCount}</span>}
      {runningCount > 0 && <span className="absolute right-1 top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500"/>}
    </button>
    {open && drawerHostRef.current && createPortal(<aside id="background-task-drawer" className="flex h-full w-full flex-col bg-white p-2" aria-label={t("ui.background.task.drawer.48b702")}>
      <div className="flex shrink-0 items-center justify-between px-2 py-1.5"><strong className="text-sm text-slate-800">{t("ui.background.tasks.4c46c9")}</strong><div className="flex items-center gap-2"><button type="button" onClick={() => void clearInactiveTasks()} disabled={actionPending || (!dismissibleTasks.length && !dismissiblePanelTasks.length)} title={t("ui.clear.finished.tasks.and.close.panel.ab7969")} aria-label={t("ui.clear.finished.tasks.d0c8eb")} className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 size={14}/></button><button type="button" onClick={closeAndRestoreFocus} aria-label={t("ui.close.background.task.drawer.6f79d6")} className="rounded p-1 text-slate-400 hover:bg-slate-100"><X size={14}/></button></div></div>
      {(backgroundTaskSyncing || backgroundTaskDegraded) && <p className="mx-2 mb-1 rounded bg-amber-50 px-2 py-1 text-[10px] text-amber-700">{backgroundTaskDegraded ? t("ui.connection.interrupted.task.statuses.may.be.7bc3bc") : t("ui.synchronizing.background.tasks.fa0655")}</p>}
      {actionError && <p role="alert" className="mx-2 mb-1 rounded bg-red-50 px-2 py-1 text-[10px] text-red-700"><LocalizedText value={actionError}/></p>}
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {visibleCount === 0 && <p className="px-2 py-6 text-center text-xs text-slate-400">{t("ui.no.active.tasks.b1bca3")}</p>}
        {visibleTaskItems.map(item => {
          if (item.kind === 'panel') {
            const task = item.task;
            const startedAt = formatBackgroundTaskStartedAt(task.startedAt);
            return <div key={`panel:${task.key}`} className="rounded-lg border border-slate-100 p-2.5">
            <button type="button" onClick={() => restorePanelTask(task)} className="block w-full text-left">
              <div className="flex items-start justify-between gap-2"><span className="min-w-0 truncate text-xs font-bold text-slate-700">{renderText(task.title)}</span><span className="flex shrink-0 items-center gap-2 text-[10px]">{startedAt && <span className="tabular-nums text-slate-400">{startedAt}</span>}<span className={task.state === 'failed' ? 'text-red-500' : task.state === 'completed' ? 'text-emerald-600' : 'text-blue-600'}>{task.state === 'failed' ? t("ui.failed.28384d") : task.state === 'completed' ? t("ui.completed.f28461") : `${Math.round(task.progress)}%`}</span></span></div>
              <ProgressBar value={task.progress} minimumVisible={2} trackClassName="mt-2 h-1 overflow-hidden rounded-full bg-slate-100" barClassName={`h-full rounded-full ${task.state === 'failed' ? 'bg-red-500' : task.state === 'completed' ? 'bg-emerald-500' : 'bg-blue-500'}`}/>
              {task.message && <p className="mt-1.5 line-clamp-2 text-[11px] text-slate-500">{renderText(task.message)}</p>}
            </button>
            <div className="mt-2 flex justify-end gap-1"><button type="button" onClick={() => restorePanelTask(task)} className="rounded px-2 py-1 text-[11px] text-blue-600 hover:bg-blue-50">{t("ui.restore.panel.80d384")}</button>{task.state !== 'running' && <button type="button" onClick={() => dismissPanelTask(task.key)} className="rounded px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-100">{t("ui.clear.bce237")}</button>}</div>
          </div>;
          }
          const task = item.task;
          const startedAt = formatBackgroundTaskStartedAt(task.startedAt);
          return <div key={`background:${task.id}`} className="rounded-lg border border-slate-100 p-2.5">
            <div className="flex items-start justify-between gap-2"><span className="min-w-0 truncate text-xs font-bold text-slate-700">{renderText(task.title)}</span><span className="flex shrink-0 items-center gap-2 text-[10px]">{startedAt && <span className="tabular-nums text-slate-400">{startedAt}</span>}<span className={task.state === 'failed' ? 'text-red-500' : task.state === 'interrupted' || task.state === 'paused' || task.state === 'pausing' ? 'text-amber-600' : 'text-slate-400'}>{renderText(taskStateLabel(task))}</span></span></div>
            <ProgressBar value={task.progress} minimumVisible={2} trackClassName="mt-2 h-1 overflow-hidden rounded-full bg-slate-100" barClassName={`h-full rounded-full ${task.state === 'failed' ? 'bg-red-500' : 'bg-blue-500'}`}/>
            {task.message && <p className="mt-1.5 line-clamp-2 text-[11px] text-slate-500">{renderText(task.message)}</p>}
            {taskSummary(task) && <p className="mt-1 text-[10px] tabular-nums text-slate-400">{taskSummary(task)}</p>}
            <div className="mt-2 flex justify-end gap-1">
              {task.state === 'interrupted' && task.resumable && <span className="mr-auto self-center text-[10px] text-amber-600">{t("ui.can.resume.from.checkpoint.0e55be")}</span>}
              {task.state === 'interrupted' && !task.resumable && task.resumePolicy === 'safe-restart' && <span className="mr-auto self-center text-[10px] text-amber-600">{t("ui.safe.to.run.again.4c5430")}</span>}
              {Boolean(task.metadata?.presentationOwnerPageId && task.metadata?.presentationPanelKind && ownerPageIds.has(String(task.metadata.presentationOwnerPageId))) && <button type="button" onClick={() => restoreBackgroundTaskPanel(task)} className="rounded px-2 py-1 text-[11px] text-blue-600 hover:bg-blue-50">{t("ui.restore.panel.80d384")}</button>}
              {task.state === 'interrupted' && task.resumeAvailable && <button type="button" onClick={() => void runAction(() => resumeTask(task))} className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-blue-600 hover:bg-blue-50"><RotateCcw size={11}/>{t("ui.continue.7c9691")}</button>}
              {task.state === 'interrupted' && task.restartAvailable && <button type="button" onClick={() => void runAction(() => restartTask(task))} className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-blue-600 hover:bg-blue-50"><RotateCcw size={11}/>{t("ui.run.again.a55426")}</button>}
              {(task.state === 'running' || task.state === 'resuming') && task.capabilities.pausable && <button type="button" onClick={() => void runAction(() => pauseTask(task))} className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-amber-700 hover:bg-amber-50"><Pause size={11}/>{t("ui.pause.8d12fc")}</button>}
              {task.state === 'paused' && task.capabilities.pausable && <button type="button" onClick={() => void runAction(() => continueTask(task))} className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-blue-600 hover:bg-blue-50"><Play size={11}/>{t("ui.continue.7c9691")}</button>}
              {task.type === 'version-tracking' && (task.state === 'completed' || task.state === 'failed') && <button type="button" onClick={() => openTrackingConfirmation(task)} className="rounded px-2 py-1 text-[11px] text-blue-600 hover:bg-blue-50">{task.state === 'failed' ? t("ui.restore.confirmation.panel.86d12c") : t("ui.open.confirmation.panel.e408a3")}</button>}
              {(task.state === 'queued' || task.state === 'running') && isTaskToastMinimized(task.id) && <button type="button" onClick={() => showTaskProgress(task)} className="rounded px-2 py-1 text-[11px] text-blue-600 hover:bg-blue-50">{t("ui.show.progress.b6c86d")}</button>}
              {task.state === 'failed' && task.retryPending && <span className="mr-auto self-center text-[10px] text-blue-600">{t("ui.retrying.ed1410")}</span>}
              {task.state === 'failed' && !task.retryPending && task.retryable && <button type="button" onClick={() => void runAction(() => retryBackgroundTask(task.id))} className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-blue-600 hover:bg-blue-50"><RotateCcw size={11}/>{t("ui.retry.b8784c")}</button>}
              {isBackgroundTaskDismissible(task) && <button type="button" onClick={() => void runAction(() => dismissBackgroundTask(task.id))} className="rounded px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-100">{t("ui.clear.bce237")}</button>}
              {(task.state === 'queued' || task.state === 'running' || task.state === 'pausing' || task.state === 'paused' || task.state === 'resuming') && task.cancellable && <button type="button" onClick={() => void runAction(() => cancelTask(task))} className="rounded px-2 py-1 text-[11px] text-red-600 hover:bg-red-50">{t("common.cancel")}</button>}
            </div>
          </div>
        })}
      </div>
    </aside>, drawerHostRef.current)}
  </div>;
};
