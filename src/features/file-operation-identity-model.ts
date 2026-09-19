const normalizeOperationIdentity = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/g, '').toLocaleLowerCase('zh-CN');

export type AsyncOperationIdentity = { scopePath: string; generation?: number };

export const asyncOperationIdentityMatches = (
  requested: AsyncOperationIdentity,
  current: AsyncOperationIdentity,
) => normalizeOperationIdentity(requested.scopePath) === normalizeOperationIdentity(current.scopePath)
  && (requested.generation === undefined && current.generation === undefined || requested.generation === current.generation);

export const mayCommitAsyncOperationResult = (
  requestedScopePath: string,
  currentScopePath: string,
  requestedGeneration?: number,
  currentGeneration?: number,
) => asyncOperationIdentityMatches(
  { scopePath: requestedScopePath, generation: requestedGeneration },
  { scopePath: currentScopePath, generation: currentGeneration },
);
