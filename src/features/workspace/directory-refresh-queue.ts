type RefreshBatch<T> = {
  includeProjectContents: boolean;
  run: (includeProjectContents: boolean) => Promise<T>;
  promise: Promise<T>;
  resolve: (result: T) => void;
  reject: (error: unknown) => void;
};

// A slow directory read must be allowed to commit even when watcher events
// keep arriving. Merge those events into one subsequent read instead of
// superseding the active read on every event.
export const createDirectoryRefreshQueue = <T>() => {
  const running = new Map<string, { pending?: RefreshBatch<T> }>();
  const execute = async (key: string, state: { pending?: RefreshBatch<T> }, batch: RefreshBatch<T>) => {
    try {
      batch.resolve(await batch.run(batch.includeProjectContents));
    } catch (error) {
      batch.reject(error);
    } finally {
      const next = state.pending;
      state.pending = undefined;
      if (next) void execute(key, state, next);
      else running.delete(key);
    }
  };
  return (key: string, includeProjectContents: boolean, run: RefreshBatch<T>['run']): Promise<T> => {
    const existing = running.get(key);
    if (existing?.pending) {
      existing.pending.includeProjectContents ||= includeProjectContents;
      existing.pending.run = run;
      return existing.pending.promise;
    }
    let resolve!: RefreshBatch<T>['resolve'];
    let reject!: RefreshBatch<T>['reject'];
    const promise = new Promise<T>((accepted, failed) => { resolve = accepted; reject = failed; });
    const batch = { includeProjectContents, run, promise, resolve, reject };
    if (existing) existing.pending = batch;
    else {
      const state = {};
      running.set(key, state);
      void execute(key, state, batch);
    }
    return promise;
  };
};
