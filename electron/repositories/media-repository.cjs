const { MAX_CHANGED_PATHS } = require('../contracts/media-sync-limits.cjs');
const crypto = require('crypto');

const MEDIA_SYNC_BATCH_SIZE = 64;

// These actions publish a staged copy of the core/media/versioning SQLite files
// back over the live databases. Killing the worker halfway through leaves a
// media-operation journal whose replay is charged to the next request that opens
// the database, so a timeout shorter than the publication itself turns one slow
// scan into an endless replay loop. Budget the publication cost, not one query:
// a fixed floor covers staging and publishing the database set, plus a per-file
// allowance for the metadata probe each item performs on the network volume.
// These actions used to copy the whole database set per call, so their budget had
// to cover that publication. The incremental index now writes in place, so the
// only real cost is reading the changed files themselves; a per-file allowance
// plus a floor leaves room for a slow network volume without inviting a 30 minute
// stall. The staged actions keep their larger budget because they still publish.
const MEDIA_SYNC_PATH_FLOOR_MS = 2 * 60 * 1000;
const MEDIA_SYNC_PATH_PER_FILE_MS = 500;
const MEDIA_SYNC_PATH_TIMEOUT_MS = 10 * 60 * 1000;
const mediaPathTimeoutMs = itemCount => Math.min(
  MEDIA_SYNC_PATH_TIMEOUT_MS,
  MEDIA_SYNC_PATH_FLOOR_MS + Math.max(0, Number(itemCount) || 0) * MEDIA_SYNC_PATH_PER_FILE_MS,
);
const MEDIA_PUBLICATION_FLOOR_MS = 6 * 60 * 1000;
const MEDIA_PUBLICATION_PER_FILE_MS = 2 * 1000;
const MEDIA_PUBLICATION_TIMEOUT_MS = 30 * 60 * 1000;
const mediaPublicationTimeoutMs = itemCount => Math.min(
  MEDIA_PUBLICATION_TIMEOUT_MS,
  MEDIA_PUBLICATION_FLOOR_MS + Math.max(0, Number(itemCount) || 0) * MEDIA_PUBLICATION_PER_FILE_MS,
);

const cancelledError = () => Object.assign(new Error('媒体索引已让路给前台文件操作'), { code: 'TASK_CANCELLED' });
const throwIfCancelled = signal => { if (signal?.aborted) throw cancelledError(); };

const createMediaRepository = client => {
  const prepareMediaSync = (root, projectName, externalRoots = [], options = {}, callOptions = {}) => client.call(root, 'media_sync_prepare', { projectName, externalRoots, ...options }, 30 * 60 * 1000, callOptions);
  const applyMediaSyncBatch = (root, payload, callOptions = {}) => client.call(root, 'media_sync_apply_batch', payload, mediaPublicationTimeoutMs(payload?.files?.length), callOptions);
  const finalizeMediaSync = (root, payload, callOptions = {}) => client.call(root, 'media_sync_finalize', payload, MEDIA_PUBLICATION_FLOOR_MS, callOptions);
  // The incremental index writes in place: `prepareChangedPaths` walks the changed
  // paths, and apply/finalize each commit one SQLite transaction. None of them
  // copies the database set any more, so they take the path budget. The staged
  // full-scan actions keep the publication budget.
  const prepareChangedPaths = (root, payload, callOptions = {}) => client.call(root, 'media_sync_paths_prepare', payload, mediaPathTimeoutMs(payload?.changes?.length), callOptions);
  const applyChangedPathsBatch = (root, payload, callOptions = {}) => client.call(root, 'media_sync_paths_apply_batch', payload, mediaPathTimeoutMs(payload?.files?.length), callOptions);
  const finalizeChangedPaths = (root, payload, callOptions = {}) => client.call(root, 'media_sync_paths_finalize', payload, MEDIA_SYNC_PATH_FLOOR_MS, callOptions);
  const abortMediaSync = (root, projectName, snapshotId) => client.call(root, 'media_sync_abort', { projectName, snapshotId }, MEDIA_PUBLICATION_FLOOR_MS);
  const syncProject = async (root, projectName, externalRoots = [], options = {}) => {
    const signal = options?.signal;
    const callOptions = { signal, priority: options.background === true ? -10 : 0, preemptible: options.background === true };
    const snapshotId = crypto.randomUUID();
    try {
    throwIfCancelled(signal);
    let prepared = await prepareMediaSync(root, projectName, externalRoots, {
      paged: true, snapshotId, pageToken: '0', pageSize: MEDIA_SYNC_BATCH_SIZE,
    }, callOptions);
    throwIfCancelled(signal);
    if (prepared.projectUnavailable) return prepared;
    let count = 0;
    if (prepared.paged === true) {
      while (true) {
        const batchIndex = Number(prepared.pageOffset || 0) / MEDIA_SYNC_BATCH_SIZE;
        if (!Number.isSafeInteger(batchIndex) || !Array.isArray(prepared.files) || prepared.files.length > MEDIA_SYNC_BATCH_SIZE) {
          throw new Error('media_sync_page_invalid: 数据库返回了无效分页');
        }
        if (prepared.files.length) {
          throwIfCancelled(signal);
          const applied = await applyChangedPathsBatch(root, {
            projectName, snapshotId: prepared.snapshotId, batchIndex, files: prepared.files,
          }, callOptions);
          count += Number(applied.count) || 0;
          await new Promise(resolve => setImmediate(resolve));
        }
        if (!prepared.nextPageToken) break;
        throwIfCancelled(signal);
        prepared = await prepareMediaSync(root, projectName, externalRoots, {
          paged: true, snapshotId: prepared.snapshotId, pageToken: prepared.nextPageToken,
          pageSize: MEDIA_SYNC_BATCH_SIZE,
        }, callOptions);
      }
      throwIfCancelled(signal);
      const finalized = await finalizeChangedPaths(root, { projectName, snapshotId: prepared.snapshotId }, callOptions);
      return { ...finalized, count };
    }
    // Older workers ignore the pagination request and return the legacy full
    // manifest. Preserve that wire contract during rolling upgrades.
    for (let offset = 0, batchIndex = 0; offset < prepared.files.length; offset += MEDIA_SYNC_BATCH_SIZE, batchIndex += 1) {
      throwIfCancelled(signal);
      const applied = await applyMediaSyncBatch(root, {
        projectName,
        snapshotId: prepared.snapshotId,
        batchIndex,
        authorizedRoots: prepared.authorizedRoots,
        files: prepared.files.slice(offset, offset + MEDIA_SYNC_BATCH_SIZE),
      }, callOptions);
      count += Number(applied.count) || 0;
      // The physical writer lease was released when the action returned. Yield
      // before rejoining the coordinator so queued interactive writes can run.
      await new Promise(resolve => setImmediate(resolve));
    }
    throwIfCancelled(signal);
    const finalized = await finalizeMediaSync(root, {
      projectName,
      snapshotId: prepared.snapshotId,
      authorizedRoots: prepared.authorizedRoots,
      files: prepared.files,
      baselineVersions: prepared.baselineVersions,
    }, callOptions);
    return { ...finalized, count };
    } catch (error) {
      if (!signal?.aborted && error?.code !== 'DATABASE_PREEMPTED') throw error;
      await abortMediaSync(root, projectName, snapshotId).catch(() => undefined);
      if (error?.code === 'DATABASE_PREEMPTED') throw error;
      throw cancelledError();
    }
  };
  const syncChangedPaths = async (root, projectName, changes, externalRoots = [], options = {}) => {
    if (!Array.isArray(changes) || changes.length > MAX_CHANGED_PATHS) throw new Error(`media_sync_paths_limit: 增量路径最多 ${MAX_CHANGED_PATHS} 条`);
    const normalizedChanges = changes.map(change => {
      const input = typeof change === 'string' ? { path: change, eventType: 'rename', kind: 'missing' } : change;
      if (!input || typeof input !== 'object' || typeof input.path !== 'string' || !input.path.trim()) throw new Error('media_sync_paths_invalid: 增量路径不能为空');
      if (input.eventType !== undefined && !['rename', 'change'].includes(input.eventType)) throw new Error('media_sync_paths_invalid: 增量事件类型无效');
      if (input.kind !== undefined && !['file', 'directory', 'missing'].includes(input.kind)) throw new Error('media_sync_paths_invalid: 增量路径类型无效');
      return { ...input, path: input.path };
    });
    const signal = options?.signal;
    const callOptions = { signal, priority: options.background === true ? -10 : 0, preemptible: options.background === true };
    const requestedSnapshotId = options.snapshotId || crypto.randomUUID();
    try {
    throwIfCancelled(signal);
    const prepared = await prepareChangedPaths(root, {
      projectName, changes: normalizedChanges, externalRoots,
      snapshotId: requestedSnapshotId,
    }, callOptions);
    throwIfCancelled(signal);
    let count = 0;
    for (let offset = 0, batchIndex = 0; offset < prepared.files.length; offset += MEDIA_SYNC_BATCH_SIZE, batchIndex += 1) {
      throwIfCancelled(signal);
      const applied = await applyChangedPathsBatch(root, {
        projectName, snapshotId: prepared.snapshotId, batchIndex,
        files: prepared.files.slice(offset, offset + MEDIA_SYNC_BATCH_SIZE),
      }, callOptions);
      count += Number(applied.count) || 0;
      await new Promise(resolve => setImmediate(resolve));
    }
    throwIfCancelled(signal);
    const finalized = await finalizeChangedPaths(root, {
      projectName, snapshotId: prepared.snapshotId,
    }, callOptions);
    return { ...finalized, count };
    } catch (error) {
      if (!signal?.aborted && error?.code !== 'DATABASE_PREEMPTED') throw error;
      await abortMediaSync(root, projectName, requestedSnapshotId).catch(() => undefined);
      if (error?.code === 'DATABASE_PREEMPTED') throw error;
      throw cancelledError();
    }
  };

  const prepareProgressStale = (root, payload, callOptions = {}) => client.call(root, 'progress_stale_prepare', payload, 30 * 60 * 1000, callOptions);
  const applyProgressStale = (root, payload, callOptions = {}) => client.call(root, 'progress_stale_apply', payload, undefined, callOptions);
  const detectProgressStale = async (root, payload, options = {}) => {
    const callOptions = { signal: options.signal, priority: options.background === true ? -10 : 0, preemptible: options.background === true };
    for (let revisionAttempt = 0; revisionAttempt < 5; revisionAttempt += 1) {
      const prepared = await prepareProgressStale(root, payload, callOptions);
      if (!prepared.candidates.length) return prepared;
      const applied = await applyProgressStale(root, {
        projectName: payload.projectName,
        snapshotId: prepared.snapshotId,
        revision: prepared.revision,
        candidates: prepared.candidates,
        scannedProgressIds: prepared.scannedProgressIds,
        propagatedProgressIds: prepared.propagatedProgressIds,
      }, callOptions);
      if (!applied.revisionExpired) return applied;
      await new Promise(resolve => setImmediate(resolve));
    }
    const error = new Error('progress_stale_revision_busy: 版本状态持续变化，请稍后重试');
    error.code = 'PROGRESS_STALE_REVISION_BUSY';
    throw error;
  };

  return ({
  syncProject,
  syncChangedPaths,
  prepareMediaSync,
  applyMediaSyncBatch,
  finalizeMediaSync,
  prepareChangedPaths,
  applyChangedPathsBatch,
  finalizeChangedPaths,
  abortMediaSync,
  setThumbnail: (root, payload) => client.call(root, 'media_set_thumbnail', payload),
  getMedia: (root, payload) => client.call(root, 'media_get', payload),
  snapshotProjectVersions: (root, payload) => client.call(root, 'media_versions_snapshot', payload),
  getPhoto: (root, photoId) => client.call(root, 'media_get_photo', { photoId }),
  createVersion: (root, payload) => client.call(root, 'media_create_version', payload),
  updateVersion: (root, payload) => client.call(root, 'media_update_version', payload),
  componentUpdateVersion: (root, payload) => client.call(root, 'media_component_update_version', payload),
  componentDeleteVersion: (root, payload) => client.call(root, 'media_component_delete_version', payload),
  refreshMetadataFingerprint: (root, payload) => client.call(root, 'media_refresh_metadata_fingerprint', payload),
  listFinalVersions: (root, projectName) => client.call(root, 'final_version_list', { projectName }),
  relocateVersion: (root, payload) => client.call(root, 'media_relocate_version', payload),
  deleteVersion: (root, versionId) => client.call(root, 'media_delete_version', { versionId }),
  getVersionDeleteScope: (root, versionId) => client.call(root, 'media_version_delete_scope', { versionId }),
  deleteProjectMissingVersion: (root, versionId) => client.call(root, 'media_delete_project_missing_version', { versionId }),
  recordCompare: (root, payload) => client.call(root, 'media_record_compare', payload),
  listProgress: (root, projectName, includeMissing = false) => client.call(root, 'progress_list', { projectName, includeMissing }),
  snapshotProgress: (root, projectName, includeMissing = false) => client.call(root, 'progress_snapshot', { projectName, includeMissing }, undefined, { priority: 10 }),
  snapshotProgressLocations: (root, projectName, includeMissing = false) => client.call(root, 'progress_locations_snapshot', { projectName, includeMissing }),
  registerProgress: (root, payload) => client.call(root, 'progress_register', payload),
  registerProgressWithGraph: (root, payload) => client.call(root, 'progress_register_with_graph', payload),
  adoptMediaFolder: (root, payload) => client.call(root, 'progress_adopt_media', payload),
  updateProgressTree: (root, payload) => client.call(root, 'progress_update_tree', payload),
  beginProgressTreeUpdate: (root, payload) => client.call(root, 'progress_update_tree_begin', payload),
  finishProgressTreeUpdate: (root, payload) => client.call(root, 'progress_update_tree_finish', payload),
  renameProgressFolder: (root, payload) => client.call(root, 'progress_folder_rename', payload),
  updateProgressRelation: (root, payload) => client.call(root, 'progress_relation_update', payload),
  repairLegacySelectionRelation: (root, payload) => client.call(root, 'progress_legacy_selection_repair', payload),
  commitImportGraph: (root, payload) => client.call(root, 'media_workflow_import_commit', payload),
  createVersionGraphEdge: (root, payload) => client.call(root, 'version_graph_edge_create', payload),
  deleteVersionGraphEdge: (root, payload) => client.call(root, 'version_graph_edge_delete', payload),
  replaceVersionGraphEdgeSource: (root, payload) => client.call(root, 'version_graph_edge_replace_source', payload),
  getVersionTreeLayout: (root, payload) => client.call(root, 'version_tree_layout_get', payload, undefined, { priority: 10 }),
  saveVersionTreeLayout: (root, payload) => client.call(root, 'version_tree_layout_save', payload),
  unregisterProgress: (root, payload) => client.call(root, 'progress_unregister', payload),
  componentManageProgress: (root, payload) => client.call(root, 'progress_component_manage', payload),
  deleteMissingProgress: (root, payload) => client.call(root, 'progress_delete_missing', payload),
  registerBatchBaseline: (root, payload) => client.call(root, 'batch_register_baseline', payload),
  commitBatchCompare: (root, payload) => client.call(root, 'batch_commit_compare', payload),
  listBatchOperations: (root, batchId) => client.call(root, 'batch_operation_list', { batchId }),
  retryBatchOperations: (root, batchId) => client.call(root, 'batch_retry_operations', { batchId }),
  detectProgressStale,
  hasProgressToCheck: async (root, projectName) => {
    const result = await prepareProgressStale(root, { projectName, eligibilityOnly: true }, { priority: -10, preemptible: true });
    if (result?.success !== true || typeof result.eligible !== 'boolean') throw new Error('Invalid version tracking eligibility response');
    return result.eligible;
  },
  prepareProgressStale,
  applyProgressStale,
  createTrackingSession: (root, payload) => client.call(root, 'tracking_session_create', payload),
  prepareTracking: (root, payload) => client.call(root, 'tracking_prepare', payload, 30 * 60 * 1000),
  storeTrackingPreview: (root, payload) => client.call(root, 'tracking_store_preview', payload, 60 * 1000),
  getTrackingSession: (root, payload) => client.call(root, 'tracking_session_get', payload),
  releaseTrackingSession: (root, sessionId) => client.call(root, 'tracking_session_release', { sessionId }),
  decideTrackingItem: (root, payload) => client.call(root, 'tracking_session_decide', payload),
  getTrackingCommitPlan: (root, sessionId) => client.call(root, 'tracking_commit_plan', { sessionId }),
  getTrackingCommitResources: (root, sessionId) => client.call(root, 'tracking_commit_resources', { sessionId }),
  applyTrackingCopies: (root, sessionId) => client.call(root, 'tracking_apply_copies', { sessionId }, 30 * 60 * 1000),
  // Legacy in-flight sessions may not have a prepared snapshot and must fall
  // back to fingerprinting both folders. Keep that compatibility path bounded
  // as a long disk operation instead of killing the database worker at 60s.
  completeTrackingCommit: (root, payload) => client.call(root, 'tracking_commit_complete', payload, 30 * 60 * 1000),
  failTrackingCommit: (root, payload) => client.call(root, 'tracking_commit_failed', payload),
  getMainBranchMedia: (root, payload) => client.call(root, 'progress_main_branch_media', payload),
  stop: () => client.stop(),
  });
};

module.exports = {
  createMediaRepository, MEDIA_SYNC_BATCH_SIZE,
  MEDIA_PUBLICATION_FLOOR_MS, MEDIA_PUBLICATION_PER_FILE_MS, MEDIA_PUBLICATION_TIMEOUT_MS, mediaPublicationTimeoutMs,
};
