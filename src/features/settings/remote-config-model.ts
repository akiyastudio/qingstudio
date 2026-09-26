const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Keep equal subtrees referentially stable so unrelated form effects do not reset drafts. */
export const retainConfigReferences = <T,>(current: T, next: T): T => {
  if (equal(current, next)) return current;
  if (!record(current) || !record(next) || ![Object.prototype, null].includes(Object.getPrototypeOf(current)) || ![Object.prototype, null].includes(Object.getPrototypeOf(next))) return next;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(next)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    result[key] = retainConfigReferences(current[key], next[key]);
  }
  return result as T;
};

/** Refresh untouched fields while keeping local edits that are still pending. */
export const reconcileRemoteConfig = <T,>(local: T, previous: T, remote: T): T => {
  if (equal(local, previous)) return retainConfigReferences(local, remote);
  if (!record(local) || !record(previous) || !record(remote)) return local;
  const result: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    result[key] = reconcileRemoteConfig(local[key], previous[key], remote[key]);
  }
  return result as T;
};

// Only untouched (or already acknowledged) fields may advance their save base.
// A dirty field keeps the snapshot it was edited against, so a remote edit to
// that same field still conflicts when this draft is saved.
export const rebaseConfigDraft = <T,>(local: T, baseline: T, remote: T): { config: T; baseline: T } => {
  if (equal(local, baseline) || equal(local, remote)) return { config: retainConfigReferences(local, remote), baseline: remote };
  if (!record(local) || !record(baseline) || !record(remote)) return { config: local, baseline };
  const config: Record<string, unknown> = {}, nextBaseline: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(local), ...Object.keys(baseline), ...Object.keys(remote)])) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    const next = rebaseConfigDraft(local[key], baseline[key], remote[key]);
    if (next.config !== undefined) config[key] = next.config;
    if (next.baseline !== undefined) nextBaseline[key] = next.baseline;
  }
  return { config: retainConfigReferences(local, config as T), baseline: nextBaseline as T };
};
