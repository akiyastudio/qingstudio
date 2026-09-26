const VERSION_MUTATIONS = new Set(['createVersion', 'updateVersion', 'componentUpdateVersion', 'componentDeleteVersion', 'relocateVersion', 'deleteVersion', 'deleteProjectMissingVersion', 'registerProgress', 'registerProgressWithGraph', 'adoptMediaFolder', 'updateProgressTree', 'finishProgressTreeUpdate', 'renameProgressFolder', 'updateProgressRelation', 'repairLegacySelectionRelation', 'commitImportGraph', 'createVersionGraphEdge', 'deleteVersionGraphEdge', 'replaceVersionGraphEdgeSource', 'saveVersionTreeLayout', 'unregisterProgress', 'componentManageProgress', 'deleteMissingProgress', 'registerBatchBaseline', 'commitBatchCompare', 'retryBatchOperations', 'completeTrackingCommit']);
const createVersionService = ({ repository, onChanged = () => undefined }) => {
  const service = {
  syncProject: (root, projectName, externalRoots = [], options = {}) => repository.syncProject(root, projectName, externalRoots, options),
  syncChangedPaths: (root, projectName, changes, externalRoots = [], options = {}) => repository.syncChangedPaths(root, projectName, changes, externalRoots, options),
  setThumbnail: (root, payload) => repository.setThumbnail(root, payload),
  getMedia: (root, payload) => repository.getMedia(root, payload),
  snapshotProjectVersions: (root, payload) => repository.snapshotProjectVersions(root, payload),
  getPhoto: (root, photoId) => repository.getPhoto(root, photoId),
  createVersion: (root, payload) => repository.createVersion(root, payload),
  updateVersion: (root, payload) => repository.updateVersion(root, payload),
  componentUpdateVersion: (root, payload) => repository.componentUpdateVersion(root, payload),
  componentDeleteVersion: (root, payload) => repository.componentDeleteVersion(root, payload),
  refreshMetadataFingerprint: (root, payload) => repository.refreshMetadataFingerprint(root, payload),
  listFinalVersions: (root, projectName) => repository.listFinalVersions(root, projectName),
  relocateVersion: (root, payload) => repository.relocateVersion(root, payload),
  deleteVersion: (root, versionId) => repository.deleteVersion(root, versionId),
  getVersionDeleteScope: (root, versionId) => repository.getVersionDeleteScope(root, versionId),
  deleteProjectMissingVersion: (root, versionId) => repository.deleteProjectMissingVersion(root, versionId),
  recordCompare: (root, payload) => repository.recordCompare(root, payload),
  listProgress: (root, projectName, includeMissing = false) => repository.listProgress(root, projectName, includeMissing),
  snapshotProgress: (root, projectName, includeMissing = false) => repository.snapshotProgress(root, projectName, includeMissing),
  snapshotProgressLocations: (root, projectName, includeMissing = false) => repository.snapshotProgressLocations(root, projectName, includeMissing),
  registerProgress: (root, payload) => repository.registerProgress(root, payload),
  registerProgressWithGraph: (root, payload) => repository.registerProgressWithGraph(root, payload),
  adoptMediaFolder: (root, payload) => repository.adoptMediaFolder(root, payload),
  updateProgressTree: (root, payload) => repository.updateProgressTree(root, payload),
  beginProgressTreeUpdate: (root, payload) => repository.beginProgressTreeUpdate(root, payload),
  finishProgressTreeUpdate: (root, payload) => repository.finishProgressTreeUpdate(root, payload),
  renameProgressFolder: (root, payload) => repository.renameProgressFolder(root, payload),
  updateProgressRelation: (root, payload) => repository.updateProgressRelation(root, payload),
  repairLegacySelectionRelation: (root, payload) => repository.repairLegacySelectionRelation(root, payload),
  commitImportGraph: (root, payload) => repository.commitImportGraph(root, payload),
  createVersionGraphEdge: (root, payload) => repository.createVersionGraphEdge(root, payload),
  deleteVersionGraphEdge: (root, payload) => repository.deleteVersionGraphEdge(root, payload),
  replaceVersionGraphEdgeSource: (root, payload) => repository.replaceVersionGraphEdgeSource(root, payload),
  getVersionTreeLayout: (root, payload) => repository.getVersionTreeLayout(root, payload),
  saveVersionTreeLayout: (root, payload) => repository.saveVersionTreeLayout(root, payload),
  unregisterProgress: (root, payload) => repository.unregisterProgress(root, payload),
  componentManageProgress: (root, payload) => repository.componentManageProgress(root, payload),
  deleteMissingProgress: (root, payload) => repository.deleteMissingProgress(root, payload),
  registerBatchBaseline: (root, payload) => repository.registerBatchBaseline(root, payload),
  commitBatchCompare: (root, payload) => repository.commitBatchCompare(root, payload),
  listBatchOperations: (root, batchId) => repository.listBatchOperations(root, batchId),
  retryBatchOperations: (root, batchId) => repository.retryBatchOperations(root, batchId),
  detectProgressStale: (root, payload, options = {}) => repository.detectProgressStale(root, payload, options),
  hasProgressToCheck: (root, projectName) => repository.hasProgressToCheck(root, projectName),
  createTrackingSession: (root, payload) => repository.createTrackingSession(root, payload),
  prepareTracking: (root, payload) => repository.prepareTracking(root, payload),
  storeTrackingPreview: (root, payload) => repository.storeTrackingPreview(root, payload),
  getTrackingSession: (root, payload) => repository.getTrackingSession(root, payload),
  releaseTrackingSession: (root, sessionId) => repository.releaseTrackingSession(root, sessionId),
  decideTrackingItem: (root, payload) => repository.decideTrackingItem(root, payload),
  getTrackingCommitPlan: (root, sessionId) => repository.getTrackingCommitPlan(root, sessionId),
  getTrackingCommitResources: (root, sessionId) => repository.getTrackingCommitResources(root, sessionId),
  applyTrackingCopies: (root, sessionId) => repository.applyTrackingCopies(root, sessionId),
  completeTrackingCommit: (root, payload) => repository.completeTrackingCommit(root, payload),
  failTrackingCommit: (root, payload) => repository.failTrackingCommit(root, payload),
  getMainBranchMedia: (root, payload) => repository.getMainBranchMedia(root, payload),
  };
  for (const name of VERSION_MUTATIONS) {
    const mutate = service[name];
    service[name] = async (root, payload, ...args) => {
      const result = await mutate(root, payload, ...args);
      if (result?.success === true) {
        try { onChanged({ root, projectName: payload?.projectName, projectId: result.photo?.projectId || result.projectId, photoId: result.photo?.id || payload?.photoId }); } catch { /* A committed mutation must not fail because an observer closed. */ }
      }
      return result;
    };
  }
  return service;
};

module.exports = { createVersionService };
