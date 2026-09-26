const path = require('path');

// Keep this allowlist limited to audited query-only operations. Stale detection
// uses a read-only snapshot and validates its revision before the later apply
// step; progress and layout snapshots are plain persisted-state queries. They
// can safely overlap foreground/background writers through SQLite WAL.
const CONFIRMED_READ_ACTIONS = new Set(['media_version_delete_scope', 'progress_snapshot', 'progress_stale_prepare', 'version_tree_layout_get']);

const IDEMPOTENT_ACTIONS = new Set([
  'progress_snapshot', 'progress_locations_snapshot', 'tracking_session_get', 'tracking_commit_resources', 'version_tree_layout_get',
  'media_sync_prepare', 'media_sync_paths_prepare', 'media_sync_abort', 'progress_stale_prepare',
  'maintenance_run', 'media_sync_apply_batch', 'media_sync_finalize',
  'media_sync_paths_apply_batch', 'media_sync_paths_finalize', 'progress_stale_apply',
  'media_get', 'media_create_version', 'media_update_version', 'media_component_update_version',
  'media_component_delete_version', 'media_refresh_metadata_fingerprint', 'media_set_thumbnail',
  'media_relocate_version', 'media_delete_version', 'media_delete_project_missing_version',
  'media_record_compare',
]);
// These actions publish a staged SQLite snapshot back over the live core/media/
// versioning files. Windows cannot open or replace that staging set safely while
// another worker still has any participating database open for reading.
//
// This list mirrors `ELECTRON_EXCLUSIVE_ACTIONS` in
// `python/workspace_durability.py`, which is the source of truth for the
// durability classification. Two kinds of action are on it:
//
//   * staged publications - Python stages a copy of the core/media/versioning
//     databases, and Windows cannot open or replace that set while another
//     worker still holds any of those files open for reading;
//   * long in-place writers - a whole-folder walk, a version import, a thumbnail
//     stamp. They no longer stage, but their `BEGIN IMMEDIATE` still has to run
//     without an interleaved reader, and the work is long enough that overlapping
//     readers would starve it.
//
// Metadata writes that only touch a row or two (`media_record_compare`,
// `media_delete_version`, ...) were deliberately dropped from this list: for them
// the SQLite write transaction is the durable unit, so the exclusive lease bought
// nothing but serialization.
// `scripts/test-workspace-sqlite-coordinator.cjs` asserts the two lists match.
const DURABLE_PUBLICATION_ACTIONS = new Set([
  'media_sync_apply_batch', 'media_sync_finalize',
  'media_sync_paths_prepare', 'media_sync_paths_apply_batch', 'media_sync_paths_finalize',
  'media_create_version', 'media_update_version', 'media_set_thumbnail',
  'batch_register_baseline', 'batch_commit_compare', 'batch_retry_operations',
  'tracking_apply_copies',
]);
const VERSIONING_ONLY_ACTIONS = new Set(['batch_list', 'progress_snapshot', 'progress_locations_snapshot', 'version_graph_edge_list', 'version_tree_layout_get', 'version_tree_layout_save']);

const domainDatabasePath = (database, domain) => {
  const absolute = path.resolve(database);
  const workspaceKey = path.parse(absolute).name;
  return path.join(path.dirname(absolute), workspaceKey, 'databases', `${domain}.sqlite3`);
};

class WorkspaceDatabaseOperationPolicy {
  // Resuming an interrupted durable media operation publishes staged copies back
  // over the live core/media/versioning files from inside `connect()`. That work
  // is charged to whichever request happens to open the database next, including
  // a request this policy would otherwise classify as a plain read. Charging it
  // to an exclusive lease keeps the cost visible to the coordinator: competing
  // readers queue behind a declared budget, and preemptible background scans can
  // be cancelled, instead of being blocked by work nothing can see or defer.
  constructor({ isRecoveryPending = () => false } = {}) {
    this.isRecoveryPending = typeof isRecoveryPending === 'function' ? isRecoveryPending : () => false;
  }

  classify({ database, action, payload = {}, scriptName = 'workspace_db.py' }) {
    const recoversPendingPublication = scriptName === 'workspace_db.py' && this.isRecoveryPending(database) === true;
    const mode = action === 'maintenance_run' || DURABLE_PUBLICATION_ACTIONS.has(action) || recoversPendingPublication
      ? 'exclusive' : CONFIRMED_READ_ACTIONS.has(action) && payload?._coordinatorWriteFallback !== true ? 'read' : 'write';
    const databases = [{ path: database, mode }];

    if (scriptName === 'operations_db.py') {
      if (payload.legacyDatabase) databases.push({ path: payload.legacyDatabase, mode: 'write' });
    } else if (scriptName === 'workspace_db.py') {
      const needsRetiredProjectCleanup = action === 'add';
      const needsDomains = action === 'maintenance_run' || VERSIONING_ONLY_ACTIONS.has(action)
        || /^(media_|progress_|batch_|tracking_|version_)/.test(action)
        || ['deleted_projects_list', 'deleted_project_cleanup_plan', 'purge_deleted_project', 'purge_missing_project'].includes(action)
        || needsRetiredProjectCleanup;
      if (needsDomains) databases.push({ path: domainDatabasePath(database, 'versioning'), mode });
      if (needsDomains && !VERSIONING_ONLY_ACTIONS.has(action)) databases.push({ path: domainDatabasePath(database, 'media'), mode });
    }

    return { databases, idempotent: IDEMPOTENT_ACTIONS.has(action), mode };
  }
}

module.exports = { WorkspaceDatabaseOperationPolicy, CONFIRMED_READ_ACTIONS, DURABLE_PUBLICATION_ACTIONS, IDEMPOTENT_ACTIONS, domainDatabasePath };
