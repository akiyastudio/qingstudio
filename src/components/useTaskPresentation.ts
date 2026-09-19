import { usePanelTaskIdentity } from '../features/background-tasks/TaskCenter';
import type { BackgroundTask } from '../types';

export const normalizeTaskProgress = (value: unknown) => {
  const progress = Number(value);
  return Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0;
};

export const formatTaskBytes = (value: unknown) => {
  const bytes = Number(value);
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  return safe >= 1024 ** 3 ? `${(safe / 1024 ** 3).toFixed(1)} GB`
    : safe >= 1024 ** 2 ? `${(safe / 1024 ** 2).toFixed(1)} MB`
      : safe >= 1024 ? `${Math.round(safe / 1024)} KB` : `${Math.round(safe)} B`;
};

export const taskStateLabel = (task: Pick<BackgroundTask, 'state' | 'progress'>) => {
  if (task.state === 'failed') return '失败';
  if (task.state === 'completed') return '已完成';
  if (task.state === 'cancelled') return '已取消';
  if (task.state === 'interrupted') return '已中断';
  if (task.state === 'paused') return '已暂停';
  if (task.state === 'pausing') return '暂停中';
  if (task.state === 'queued') return '等待中';
  if (task.state === 'resuming') return '继续中';
  return `${Math.round(normalizeTaskProgress(task.progress))}%`;
};

export const taskActionCapabilities = (task: BackgroundTask) => ({
  canPause: (task.state === 'running' || task.state === 'resuming') && task.capabilities.pausable,
  canContinue: task.state === 'paused' && task.capabilities.pausable,
  canCancel: ['queued', 'running', 'pausing', 'paused', 'resuming'].includes(task.state) && task.cancellable,
});

/** Gives task producers the optional panel destination without exposing task-center internals. */
export const useTaskPresentation = usePanelTaskIdentity;
