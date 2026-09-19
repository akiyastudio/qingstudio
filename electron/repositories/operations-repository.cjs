const createOperationsRepository = (client, getLegacyDatabasePath) => {
  const call = (root, action, payload = {}) => client.call(root, action, {
    ...payload,
    legacyDatabase: getLegacyDatabasePath(root),
  });

  return {
    load: root => call(root, 'init'),
    addUndoRecord: (root, payload) => call(root, 'undo_record_add', payload),
    retireUndoRecordClaim: (root, id) => call(root, 'undo_record_retire_claim', { id }),
    claimUndoRecordExecution: (root, id, claimToken) => call(root, 'undo_record_claim_execute', { id, claimToken }),
    latestUndoRecord: root => call(root, 'undo_record_latest'),
    listUndoRecords: (root, kinds = ['trash', 'project-cleanup']) => call(root, 'undo_record_list', { kinds }),
    removeUndoRecord: (root, id) => call(root, 'undo_record_remove', { id }),
    removeUndoRecords: (root, ids) => call(root, 'undo_record_remove_many', { ids }),
    markUndoRecordUnavailable: (root, id) => call(root, 'undo_record_mark_unavailable', { id }),
    stop: () => client.stop(),
  };
};

module.exports = { createOperationsRepository };
