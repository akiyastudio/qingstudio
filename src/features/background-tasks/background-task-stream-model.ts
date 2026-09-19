import type { BackgroundTask, BackgroundTaskDelta } from '../../types';
import { mergeBackgroundTaskSnapshots, normalizeBackgroundTaskSnapshots } from './task-toast-model';

export interface BackgroundTaskStreamState {
  hydrated: boolean;
  syncing: boolean;
  degraded: boolean;
  revision: number;
  tasks: BackgroundTask[];
  bufferedDeltas: BackgroundTaskDelta[];
  snapshotRequest: number;
  retryAttempt: number;
}

const MAX_BUFFERED_DELTAS = 256;

export const initialBackgroundTaskStreamState = (): BackgroundTaskStreamState => ({
  hydrated: false,
  syncing: true,
  degraded: false,
  revision: 0,
  tasks: [],
  bufferedDeltas: [],
  snapshotRequest: 1,
  retryAttempt: 0,
});

const applyDelta = (tasks: BackgroundTask[], delta: BackgroundTaskDelta) => {
  const removed = new Set(delta.removeIds);
  return mergeBackgroundTaskSnapshots(tasks.filter(task => !removed.has(task.id)), delta.upserts);
};

const uniqueSortedDeltas = (deltas: BackgroundTaskDelta[]) => [...new Map(
  deltas.map(delta => [delta.revision, delta]),
).values()].sort((left, right) => left.revision - right.revision).slice(-MAX_BUFFERED_DELTAS);

export const receiveBackgroundTaskDelta = (
  state: BackgroundTaskStreamState,
  delta: BackgroundTaskDelta,
): BackgroundTaskStreamState => {
  if (delta.revision <= state.revision) return state;
  if (!state.hydrated) return {
    ...state,
    syncing: true,
    bufferedDeltas: uniqueSortedDeltas([...state.bufferedDeltas, delta]),
  };
  if (delta.revision !== state.revision + 1) return {
    ...state,
    hydrated: false,
    syncing: true,
    degraded: true,
    bufferedDeltas: uniqueSortedDeltas([delta]),
    snapshotRequest: state.snapshotRequest + 1,
  };
  return {
    ...state,
    revision: delta.revision,
    tasks: applyDelta(state.tasks, delta),
  };
};

export const receiveBackgroundTaskSnapshot = (
  state: BackgroundTaskStreamState,
  snapshot: { revision: number; tasks: BackgroundTask[] },
): BackgroundTaskStreamState => {
  let revision = snapshot.revision;
  let tasks = normalizeBackgroundTaskSnapshots(snapshot.tasks);
  const buffered = uniqueSortedDeltas(state.bufferedDeltas).filter(delta => delta.revision > revision);
  for (let index = 0; index < buffered.length; index += 1) {
    const delta = buffered[index];
    if (delta.revision !== revision + 1) return {
      hydrated: false,
      syncing: true,
      degraded: true,
      revision,
      tasks,
      bufferedDeltas: buffered.slice(index),
      snapshotRequest: state.snapshotRequest + 1,
      retryAttempt: state.retryAttempt + 1,
    };
    tasks = applyDelta(tasks, delta);
    revision = delta.revision;
  }
  return {
    hydrated: true,
    syncing: false,
    degraded: false,
    revision,
    tasks,
    bufferedDeltas: [],
    snapshotRequest: state.snapshotRequest,
    retryAttempt: 0,
  };
};
