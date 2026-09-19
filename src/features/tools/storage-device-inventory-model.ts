import type { StorageDevice, StorageDeviceInventoryResult } from '../../types';
import type { StartupSdAutoImportRequest } from './startup-sd-auto-import-model';

export interface StorageDeviceInventorySnapshot {
  devices: StorageDevice[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  lastSuccessAt: number | null;
  error: string | null;
  warning: string | null;
  deviceErrors: Array<{ mountPath: string; error: string }>;
}

type Schedule = (callback: () => void, delayMs: number) => unknown;
type CancelSchedule = (handle: unknown) => void;

export const isFreshStorageDeviceInventory = (
  snapshot: StorageDeviceInventorySnapshot,
  now: number,
  maxAgeMs = 10_000,
) => snapshot.status === 'ready'
  && snapshot.error === null
  && snapshot.lastSuccessAt !== null
  && now - snapshot.lastSuccessAt <= maxAgeMs;

export const shouldPollStorageDeviceInventory = ({
  section,
  active,
  busy,
  panelOpen,
  startupRequest,
}: {
  section: 'all' | 'import' | 'birthday';
  active: boolean;
  busy: boolean;
  panelOpen: boolean;
  startupRequest: StartupSdAutoImportRequest | null;
}) => section !== 'birthday'
  && (busy || (active && (panelOpen || startupRequest?.state === 'pending')));

export const createStorageDeviceInventoryController = ({
  load,
  schedule,
  cancelSchedule,
  now = () => Date.now(),
  pollIntervalMs = 3000,
}: {
  load: () => Promise<StorageDeviceInventoryResult>;
  schedule: Schedule;
  cancelSchedule: CancelSchedule;
  now?: () => number;
  pollIntervalMs?: number;
}) => {
  let snapshot: StorageDeviceInventorySnapshot = { devices: [], status: 'idle', lastSuccessAt: null, error: null, warning: null, deviceErrors: [] };
  let scheduledHandle: unknown;
  let running = false;
  let generation = 0;
  const listeners = new Set<(value: StorageDeviceInventorySnapshot) => void>();

  const emit = (next: StorageDeviceInventorySnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
  };

  const poll = async (currentGeneration: number) => {
    if (running || currentGeneration !== generation || listeners.size === 0) return;
    running = true;
    try {
      const result = await load();
      if (currentGeneration !== generation || listeners.size === 0) return;
      if (result.complete) emit({ devices: result.devices, status: 'ready', lastSuccessAt: now(), error: null, warning: result.warning || null, deviceErrors: result.deviceErrors || [] });
      else emit({ devices: result.devices, status: 'error', lastSuccessAt: snapshot.lastSuccessAt, error: result.error || '存储设备枚举不完整', warning: result.warning || null, deviceErrors: result.deviceErrors || [] });
    } catch (error) {
      if (currentGeneration !== generation || listeners.size === 0) return;
      emit({ ...snapshot, status: 'error', error: error instanceof Error ? error.message : String(error), warning: null });
    } finally {
      running = false;
      if (listeners.size > 0) {
        const nextGeneration = generation;
        const delayMs = currentGeneration === nextGeneration ? pollIntervalMs : 0;
        scheduledHandle = schedule(() => { void poll(nextGeneration); }, delayMs);
      }
    }
  };

  const start = () => {
    generation += 1;
    emit({ ...snapshot, status: 'loading', error: null, warning: null, deviceErrors: [] });
    void poll(generation);
  };

  const stop = () => {
    generation += 1;
    if (scheduledHandle !== undefined) cancelSchedule(scheduledHandle);
    scheduledHandle = undefined;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: (value: StorageDeviceInventorySnapshot) => void) {
      listeners.add(listener);
      listener(snapshot);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
  };
};
