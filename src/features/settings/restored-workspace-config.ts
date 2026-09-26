import type { AppConfig } from '../../types';

type SettingsSaveCoordinatorOptions<T> = {
  initial: T;
  normalize: (value: T) => T;
  applyDraft: (value: T) => void;
  save: (value: T, baseline: T) => boolean | Promise<boolean>;
  onFailure: (value: T, error: Error) => void;
};
type TransactionSaveOptions = { incorporatesPending?: boolean };

export const patchSettingsDraft = <T extends object>(current: T, patch: (current: T) => Partial<T>): T => ({ ...current, ...patch(current) });

export const createSettingsSaveCoordinator = <T,>({ initial, normalize, applyDraft, save, onFailure }: SettingsSaveCoordinatorOptions<T>) => {
  let tail = Promise.resolve();
  let draft = normalize(initial);
  let persisted = draft;
  let latestRevision = 0;
  let visibleRevision = 0;
  let persistedVersion = 0;
  let lastFailedVersion = 0;
  let incorporatedThroughRevision = 0;
  const apply = (value: T) => {
    const baseline = draft;
    const version = ++latestRevision;
    const normalized = normalize(value);
    draft = normalized;
    applyDraft(normalized);
    visibleRevision = version;
    return { normalized, version, baseline };
  };
  const rollbackFailed = async (value: T, version: number, reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    lastFailedVersion = version;
    onFailure(value, error);
    if (version === visibleRevision) {
      draft = persisted;
      applyDraft(persisted);
      visibleRevision = persistedVersion;
      try { await save(persisted, persisted); } catch { /* Re-applying still restores an optimistic parent draft. */ }
    }
    return false;
  };
  const saveApplied = async ({ normalized, version, baseline }: ReturnType<typeof apply>, incorporatesThrough = 0) => {
    if (version < persistedVersion) return true;
    try {
      if (!await save(normalized, baseline)) throw new Error('设置没有保存成功');
      persisted = normalized;
      persistedVersion = version;
      incorporatedThroughRevision = Math.max(incorporatedThroughRevision, incorporatesThrough);
      if (visibleRevision < version) { draft = normalized; applyDraft(normalized); visibleRevision = version; }
      if (lastFailedVersion <= version) lastFailedVersion = 0;
      return true;
    } catch (reason) { return rollbackFailed(normalized, version, reason); }
  };
  const saveMutation = async ({ mutation, version, baseline }: { mutation: (current: T) => T; version: number; baseline: T }) => {
    if (version <= incorporatedThroughRevision && persistedVersion > version) return true;
    const baselineRevision = persistedVersion;
    const rebased = normalize(mutation(persisted));
    const commitRevision = version > baselineRevision ? version : ++latestRevision;
    try {
      if (!await save(rebased, baseline)) throw new Error('设置没有保存成功');
      persisted = rebased;
      persistedVersion = commitRevision;
      if (visibleRevision <= Math.max(version, baselineRevision)) {
        draft = rebased;
        applyDraft(rebased);
        visibleRevision = commitRevision;
      }
      if (lastFailedVersion <= commitRevision) lastFailedVersion = 0;
      return true;
    } catch (reason) { return rollbackFailed(rebased, version, reason); }
  };
  const queue = <R,>(operation: () => Promise<R>) => { const result = tail.then(operation, operation); tail = result.then(() => undefined, () => undefined); return result; };
  const enqueue = (value: T) => { const applied = apply(value); return queue(() => saveApplied(applied)); };
  const enqueueMutation = (mutation: (current: T) => T) => {
    if (typeof mutation !== 'function') throw new TypeError('Settings mutation must be a function');
    const applied = apply(mutation(draft));
    return queue(() => saveMutation({ mutation, version: applied.version, baseline: applied.baseline }));
  };
  const adoptPersisted = (value: T) => {
    const incorporatesThrough = latestRevision;
    const applied = apply(value);
    persisted = applied.normalized;
    persistedVersion = applied.version;
    incorporatedThroughRevision = Math.max(incorporatedThroughRevision, incorporatesThrough);
    lastFailedVersion = 0;
    return applied.version;
  };
  const transaction = <R,>(worker: (saveInTransaction: (value: T, options?: TransactionSaveOptions) => Promise<boolean>, adoptInTransaction: (value: T) => number) => Promise<R>) =>
    queue(() => worker((value, options) => {
      const incorporatesThrough = options?.incorporatesPending === true ? latestRevision : 0;
      return saveApplied(apply(value), incorporatesThrough);
    }, adoptPersisted));
  const drain = async (version = visibleRevision) => {
    const pending = tail;
    await pending;
    if (persistedVersion > version) return { status: 'superseded' as const, version, latestVersion: visibleRevision };
    if (lastFailedVersion === version) return { status: 'save-failed' as const, version, latestVersion: visibleRevision };
    if (visibleRevision !== version) return { status: 'changed' as const, version, latestVersion: visibleRevision };
    if (persistedVersion < version) return { status: 'save-failed' as const, version, latestVersion: visibleRevision };
    return { status: 'saved' as const, version, latestVersion: visibleRevision };
  };
  return {
    enqueue,
    enqueueMutation,
    transaction,
    currentVersion: () => visibleRevision,
    getAcknowledgement: () => ({ latestRevision, currentRevision: visibleRevision, persistedRevision: persistedVersion, lastFailedRevision: lastFailedVersion }),
    drain,
    adoptPersisted,
    mergePersisted: (merge: (value: T) => T) => { persisted = normalize(merge(persisted)); draft = normalize(merge(draft)); },
  };
};

export const waitForPersistedSettings = <T,>(coordinator: ReturnType<typeof createSettingsSaveCoordinator<T>>) =>
  coordinator.drain(coordinator.currentVersion());

const canonicalWorkspacePath = (value: string) => {
  const trimmed = String(value || '').trim();
  return trimmed.length > 3 ? trimmed.replace(/[\\/]+$/, '') : trimmed;
};

export const restoredWorkspaceConfig = (savedConfig: AppConfig, workspacePath: string, currentConfig?: AppConfig): AppConfig => ({
  ...savedConfig,
  telemetry: currentConfig?.telemetry || savedConfig.telemetry,
  backup: currentConfig?.backup || savedConfig.backup,
  workspacePath: canonicalWorkspacePath(workspacePath),
  workspacePaths: [canonicalWorkspacePath(workspacePath)].filter(Boolean),
});
