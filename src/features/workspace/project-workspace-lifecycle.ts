export interface ProjectWorkspaceLifecycleIdentity {
  pageId: string;
  projectId: string;
  projectPath: string;
  projectName: string;
  projectStatus: string;
}

export type ProjectWorkspaceLifecycleAction = {
  kind: 'initialize' | 'refresh' | 'none';
  relativePath: string;
  resetNavigation: boolean;
};

export const PROJECT_BACKGROUND_LOAD_DELAYS_MS = Object.freeze({
  progress: 40,
  watcher: 160,
  clipboard: 320,
  drives: 480,
});

export const PROJECT_WATCH_RECONCILE_COOLDOWN_MS = 30_000;
export const PROJECT_WATCH_FALLBACK_REFRESH_MS = 60_000;

export const shouldReconcileProjectWatch = (
  lastReconciledAt: number,
  now: number,
  force = false,
  cooldownMs = PROJECT_WATCH_RECONCILE_COOLDOWN_MS,
) => force || lastReconciledAt <= 0 || now - lastReconciledAt >= cooldownMs;

export const isForegroundDirectoryRefresh = (
  requestedRelativePath: string,
  currentRelativePath: string,
  requestedProjectPath: string,
  currentProjectPath: string,
) => requestedRelativePath === currentRelativePath && requestedProjectPath === currentProjectPath;

export const resolveProjectWorkspaceLifecycle = (
  previous: ProjectWorkspaceLifecycleIdentity | undefined,
  next: ProjectWorkspaceLifecycleIdentity,
  currentRelativePath: string,
  initialRelativePath: string,
): ProjectWorkspaceLifecycleAction => {
  if (!previous || previous.pageId !== next.pageId || previous.projectId !== next.projectId) {
    return { kind: 'initialize', relativePath: initialRelativePath, resetNavigation: true };
  }
  const metadataChanged = previous.projectPath !== next.projectPath
    || previous.projectName !== next.projectName
    || previous.projectStatus !== next.projectStatus;
  return metadataChanged
    ? { kind: 'refresh', relativePath: currentRelativePath, resetNavigation: false }
    : { kind: 'none', relativePath: currentRelativePath, resetNavigation: false };
};
