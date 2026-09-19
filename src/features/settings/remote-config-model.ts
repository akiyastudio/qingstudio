const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Refresh untouched fields while keeping local edits that are still pending. */
export const reconcileRemoteConfig = <T,>(local: T, previous: T, remote: T): T => {
  if (equal(local, previous)) return remote;
  if (!record(local) || !record(previous) || !record(remote)) return local;
  const result: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    result[key] = reconcileRemoteConfig(local[key], previous[key], remote[key]);
  }
  return result as T;
};
