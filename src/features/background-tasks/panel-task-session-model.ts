export type PanelTaskRestoreDetail = {
  ownerPageId?: string;
  panelKind?: string;
};

export const panelTaskSessionKey = (ownerPageId: string, panelKind: string) => `${ownerPageId}:${panelKind}`;

export const componentPanelTaskKind = (componentId: string, contributionId: string) => `component:${componentId}:${contributionId}`;

export const panelTaskRestoreDetail = (ownerPageId: string, panelKind: string): PanelTaskRestoreDetail => ({
  ownerPageId,
  panelKind,
});

export const isPanelTaskRestoreForPage = (ownerPageId: string, detail?: PanelTaskRestoreDetail) => detail?.ownerPageId === ownerPageId;

const ACTIVE_PRESENTED_BACKGROUND_TASK_STATES = new Set(['queued', 'running', 'pausing', 'paused', 'resuming']);

export const isActivePresentedBackgroundTaskForPanel = (
  task: { state?: string; metadata?: Record<string, unknown> },
  ownerPageId: string,
  panelKind: string,
) => ACTIVE_PRESENTED_BACKGROUND_TASK_STATES.has(task.state || '')
  && String(task.metadata?.presentationOwnerPageId || '') === ownerPageId
  && String(task.metadata?.presentationPanelKind || '') === panelKind;

export const nextPanelTaskStartedAt = (
  previous: { state?: string; startedAt?: number } | undefined,
  nextState: string,
  now = Date.now(),
) => {
  const retained = Number(previous?.startedAt);
  const retainedStartedAt = Number.isFinite(retained) && retained > 0 ? retained : 0;
  if (nextState !== 'running') return retainedStartedAt;
  return previous?.state === 'running' && retainedStartedAt ? retainedStartedAt : now;
};

export const removePanelTasksByOwnerPageId = <T extends { ownerPageId: string }>(tasks: Record<string, T>, ownerPageId: string) => {
  let changed = false;
  const remaining = Object.fromEntries(Object.entries(tasks).filter(([, task]) => {
    const keep = task.ownerPageId !== ownerPageId;
    if (!keep) changed = true;
    return keep;
  })) as Record<string, T>;
  return changed ? remaining : tasks;
};
