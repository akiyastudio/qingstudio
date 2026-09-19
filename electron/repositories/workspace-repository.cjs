const createWorkspaceRepository = (client, operationsRepository = null) => {
  const pendingUndoPurges = new Map();
  const pathKey = value => process.platform === 'win32' ? String(value).toLocaleLowerCase() : String(value);
  const removeUndoRecordsRetryably = async (root, key, ids) => {
    if (!operationsRepository || !ids.length) return { undoCleanupPending: false };
    const pendingKey = `${pathKey(root)}\0${key}`;
    const allIds = [...new Set([...(pendingUndoPurges.get(pendingKey) || []), ...ids])];
    try {
      await operationsRepository.removeUndoRecords(root, allIds);
      pendingUndoPurges.delete(pendingKey);
      return { undoCleanupPending: false };
    } catch {
      pendingUndoPurges.set(pendingKey, allIds);
      return { undoCleanupPending: true, pendingUndoIds: allIds };
    }
  };
  return ({
  load: async root => {
    const catalog = await client.call(root, 'init');
    return catalog;
  },
  syncCatalog: (root, options = {}) => client.call(root, 'catalog_sync', {}, 30 * 60 * 1000, options),
  runMaintenance: (root, options = {}) => client.call(root, 'maintenance_run', {}, 30 * 60 * 1000, options),
  addProject: (root, payload) => client.call(root, 'add', payload),
  renameProject: (root, payload) => client.call(root, 'rename', payload, undefined, { priority: 10 }),
  setProjectStatus: (root, payload) => client.call(root, 'status', payload),
  archiveProject: (root, payload) => client.call(root, 'archive_project', payload),
  unarchiveProject: (root, payload) => client.call(root, 'unarchive_project', payload),
  softDeleteProject: (root, payload) => client.call(root, 'delete', payload),
  restoreProject: (root, payload) => client.call(root, 'restore_project', payload),
  listDeletedProjects: async root => client.call(root, 'deleted_projects_list', operationsRepository
    ? { undoRecords: (await operationsRepository.listUndoRecords(root)).records }
    : {}),
  getDeletedProjectCleanupPlan: async (root, projectId) => client.call(root, 'deleted_project_cleanup_plan', {
    projectId,
    ...(operationsRepository ? { undoRecords: (await operationsRepository.listUndoRecords(root)).records } : {}),
  }),
  purgeDeletedProject: async (root, projectId) => {
    const undoRecords = operationsRepository ? (await operationsRepository.listUndoRecords(root)).records : undefined;
    if (operationsRepository) {
      const plan = await client.call(root, 'deleted_project_cleanup_plan', { projectId, undoRecords });
      if (plan.removedUndoIds?.length) await operationsRepository.removeUndoRecords(root, plan.removedUndoIds);
    }
    return client.call(root, 'purge_deleted_project', { projectId, ...(undoRecords ? { undoRecords } : {}) });
  },
  purgeMissingProject: async (root, name) => {
    const result = await client.call(root, 'purge_missing_project', {
      name,
      ...(operationsRepository ? { undoRecords: (await operationsRepository.listUndoRecords(root)).records } : {}),
    });
    const compensation = await removeUndoRecordsRetryably(root, `missing:${name}`, result.removedUndoIds || []);
    return { ...result, ...compensation };
  },
  listMissingProjects: (root, missingBefore) => client.call(root, 'missing_projects_list', { missingBefore }),
  addUndoRecord: (root, payload) => operationsRepository
    ? operationsRepository.addUndoRecord(root, payload)
    : client.call(root, 'undo_record_add', payload),
  retireUndoRecordClaim: (root, id) => operationsRepository
    ? operationsRepository.retireUndoRecordClaim(root, id)
    : client.call(root, 'undo_record_retire_claim', { id }),
  claimUndoRecordExecution: (root, id, claimToken) => operationsRepository
    ? operationsRepository.claimUndoRecordExecution(root, id, claimToken)
    : client.call(root, 'undo_record_claim_execute', { id, claimToken }),
  shadowRetireUndoRecord: (root, id) => client.call(root, 'undo_record_shadow_retire', { id }),
  latestUndoRecord: root => operationsRepository
    ? operationsRepository.latestUndoRecord(root)
    : client.call(root, 'undo_record_latest', {}),
  listUndoRecords: (root, kinds = ['trash', 'project-cleanup']) => operationsRepository
    ? operationsRepository.listUndoRecords(root, kinds)
    : client.call(root, 'undo_record_list', { kinds }),
  removeUndoRecords: (root, ids) => operationsRepository
    ? operationsRepository.removeUndoRecords(root, ids)
    : client.call(root, 'undo_record_remove_many', { ids }),
  removeUndoRecord: (root, id) => operationsRepository
    ? operationsRepository.removeUndoRecord(root, id)
    : client.call(root, 'undo_record_remove', { id }),
  markUndoRecordUnavailable: (root, id) => operationsRepository
    ? operationsRepository.markUndoRecordUnavailable(root, id)
    : client.call(root, 'undo_record_mark_unavailable', { id }),
  stop: () => client.stop(),
  });
};

module.exports = { createWorkspaceRepository };
