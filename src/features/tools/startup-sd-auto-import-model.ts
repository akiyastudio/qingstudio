export type StartupSdAutoImportRequestState = 'pending' | 'expired' | 'cancelled';

export interface StartupSdAutoImportRequest {
  id: number;
  createdAt: number;
  expiresAt: number;
  state: StartupSdAutoImportRequestState;
}

export type StartupSdAutoImportDecision = 'ignore' | 'wait' | 'wait-for-device' | 'expired' | 'start';

export const decideStartupSdAutoImport = ({
  active,
  directSource,
  request,
  handledRequest,
  ready,
  busy,
  selectionCount,
  now,
}: {
  active: boolean;
  directSource: boolean;
  request: StartupSdAutoImportRequest | null;
  handledRequest: number;
  ready: boolean;
  busy: boolean;
  selectionCount: number;
  now: number;
}): StartupSdAutoImportDecision => {
  if (!active || directSource || !request || handledRequest === request.id || request.state === 'cancelled') return 'ignore';
  if (request.state === 'expired' || now >= request.expiresAt) return 'expired';
  if (!ready || busy) return 'wait';
  if (selectionCount === 0) return 'wait-for-device';
  return 'start';
};

export const shouldDeleteSourceForImportBatch = (
  deleteSourceRequested: boolean,
  mode: 'manual' | 'startup',
) => deleteSourceRequested && mode === 'manual';

export const handledStartupRequestAfterBatchStart = (
  request: StartupSdAutoImportRequest | null,
  handledRequest: number,
  mode: 'manual' | 'startup',
) => mode === 'manual' && request?.state === 'pending' ? request.id : handledRequest;
