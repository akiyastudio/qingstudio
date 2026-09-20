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
