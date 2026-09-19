import type { BackgroundTask } from '../../types';

const FAILURE_TOAST_MS = 10_000;
const RESULT_TOAST_MS = 6_000;
const TERMINAL_TASK_STATES = new Set<BackgroundTask['state']>(['completed', 'failed', 'cancelled', 'interrupted']);

export const isBackgroundTaskDismissible = (task: Pick<BackgroundTask, 'state' | 'retryPending'>) =>
  TERMINAL_TASK_STATES.has(task.state) && !task.retryPending;

const twoDigits = (value: number) => String(value).padStart(2, '0');

export const formatBackgroundTaskStartedAt = (value: number, now = Date.now()) => {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const startedAt = new Date(timestamp);
  if (Number.isNaN(startedAt.getTime())) return '';

  const reference = new Date(now);
  const time = `${twoDigits(startedAt.getHours())}:${twoDigits(startedAt.getMinutes())}`;
  const sameYear = !Number.isNaN(reference.getTime()) && startedAt.getFullYear() === reference.getFullYear();
  if (sameYear && startedAt.getMonth() === reference.getMonth() && startedAt.getDate() === reference.getDate()) return time;

  const date = `${twoDigits(startedAt.getMonth() + 1)}/${twoDigits(startedAt.getDate())}`;
  return sameYear ? `${date} ${time}` : `${startedAt.getFullYear()}/${date} ${time}`;
};

type TaskCenterPublishedTask = {
  startedAt?: number;
  createdAt?: number;
  updatedAt?: number;
};

export const taskCenterPublishedAt = (task: TaskCenterPublishedTask) => {
  for (const candidate of [task.startedAt, task.createdAt, task.updatedAt]) {
    const timestamp = Number(candidate);
    if (Number.isFinite(timestamp) && timestamp > 0) return timestamp;
  }
  return 0;
};

export const compareTaskCenterPublishedAt = (left: TaskCenterPublishedTask, right: TaskCenterPublishedTask) =>
  taskCenterPublishedAt(right) - taskCenterPublishedAt(left);

export const normalizeBackgroundTaskSnapshots = (tasks: BackgroundTask[], limit = 200) => {
  const retained = tasks.filter(task => !TERMINAL_TASK_STATES.has(task.state));
  const history = tasks
    .filter(task => task.historyPolicy !== 'ephemeral' && TERMINAL_TASK_STATES.has(task.state))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  return [...retained, ...history.slice(0, Math.max(0, limit - retained.length))];
};

export const mergeBackgroundTaskSnapshots = (current: BackgroundTask[], incoming: BackgroundTask[], limit = 200) => {
  const merged: BackgroundTask[] = [];
  const seen = new Set<string>();
  for (const task of [...incoming, ...current]) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    merged.push(task);
  }
  return normalizeBackgroundTaskSnapshots(merged, limit);
};

export const collapseRetryPredecessors = (tasks: BackgroundTask[]) => {
  const retrySources = new Set(tasks.filter(task => task.retryOfTaskId).map(task => String(task.retryOfTaskId)));
  return tasks.filter(task => !retrySources.has(task.id));
};

export const isBackgroundTaskCenterVisible = (task: BackgroundTask) => {
  if (task.taskCenterPolicy === 'hidden') return false;
  if (task.taskCenterPolicy === 'attention-only') return task.state === 'failed';
  return task.state === 'queued' || task.state === 'running' || task.state === 'pausing'
    || task.state === 'resuming' || task.state === 'paused' || task.state === 'interrupted' || task.state === 'failed'
    || (task.type === 'version-tracking' && (task.state === 'completed' || task.state === 'cancelled'));
};

const showsProgressToast = (task: BackgroundTask) => task.notificationPolicy === 'progress-toast'
  || task.notificationPolicy === 'progress-and-result'
  || (!task.notificationPolicy && (task.type === 'project-file-operation' || task.type === 'version-tracking'));

const showsSuccessToast = (task: BackgroundTask) => task.notificationPolicy === 'result-only'
  || task.notificationPolicy === 'progress-and-result';

export const taskToastExpiresAt = (task: BackgroundTask, firstVisibleAt?: number) => task.state === 'failed'
  ? (firstVisibleAt ?? task.updatedAt) + FAILURE_TOAST_MS
  : task.state === 'completed' && showsSuccessToast(task)
    ? (firstVisibleAt ?? task.updatedAt) + RESULT_TOAST_MS
    : 0;

export const taskToastInstanceKey = (task: Pick<BackgroundTask, 'id' | 'createdAt'> & { instanceId?: unknown }) => {
  const generation = typeof task.instanceId === 'string' && task.instanceId ? task.instanceId : String(task.createdAt);
  return `${task.id.length}:${task.id}:${generation.length}:${generation}`;
};

export const taskToastLiveRole = (state: BackgroundTask['state']): 'alert' | 'status' | undefined => state === 'failed' ? 'alert' : state === 'completed' ? 'status' : undefined;

export const isActiveProjectFileTask = (task: BackgroundTask, now = Date.now(), firstVisibleAt?: number, pendingResult = true, awaitingVisibility = false) => {
  const active = task.state === 'queued' || task.state === 'running' || task.state === 'pausing' || task.state === 'paused' || task.state === 'resuming';
  if (active) return showsProgressToast(task);
  const anchor = firstVisibleAt ?? (awaitingVisibility ? undefined : task.updatedAt);
  if (task.state === 'failed') return task.notificationPolicy !== 'silent' && pendingResult && (anchor === undefined || now < anchor + FAILURE_TOAST_MS);
  return task.state === 'completed' && showsSuccessToast(task) && pendingResult && (anchor === undefined || now < anchor + RESULT_TOAST_MS);
};

export const compareProjectFileTasks = (left: BackgroundTask, right: BackgroundTask) => {
  const priority = (task: BackgroundTask) => task.state === 'failed' ? 0
    : task.state === 'running' || task.state === 'resuming' ? 1
    : task.state === 'paused' || task.state === 'pausing' ? 2
      : task.state === 'queued' ? 3 : 4;
  if (priority(left) !== priority(right)) return priority(left) - priority(right);
  return left.createdAt - right.createdAt;
};

export const selectProjectFileTaskToasts = (tasks: BackgroundTask[], minimizedTaskIds: ReadonlySet<string>, limit = 4, now = Date.now(), queuedDelayMs = 700, firstVisibleAt: ReadonlyMap<string, number> = new Map(), pendingResultKeys?: ReadonlySet<string>) => {
  const eligible = collapseRetryPredecessors(tasks).filter(task => {
    const instanceKey = taskToastInstanceKey(task);
    const pendingResult = pendingResultKeys ? pendingResultKeys.has(instanceKey) : true;
    return isActiveProjectFileTask(task, now, firstVisibleAt.get(instanceKey), pendingResult, Boolean(pendingResultKeys))
      && !minimizedTaskIds.has(instanceKey) && !minimizedTaskIds.has(task.id)
      && (task.state !== 'queued' || now - task.createdAt >= queuedDelayMs);
  }).sort(compareProjectFileTasks);
  return { visible: eligible.slice(0, limit), overflowCount: Math.max(0, eligible.length - limit) };
};

export const setTaskToastMinimized = (current: Set<string>, id: string, minimized: boolean): Set<string> => {
  if (minimized === current.has(id)) return current;
  const next = new Set(current);
  if (minimized) next.add(id);
  else next.delete(id);
  return next;
};

export const pruneFinishedTaskToastIds = (current: Set<string>, tasks: BackgroundTask[]): Set<string> => {
  const activeIds = new Set(tasks.map(taskToastInstanceKey));
  const next = new Set([...current].filter(id => activeIds.has(id)));
  return next.size === current.size ? current : next;
};

export const isPointerInsideTaskIndicator = (
  trigger: Pick<HTMLElement, 'contains'> | null,
  panel: Pick<HTMLElement, 'contains'> | null,
  target: Node,
) => Boolean(trigger?.contains(target) || panel?.contains(target));
