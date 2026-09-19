const { COMPONENT_HOST_ERROR_CODES: CODES, hostError } = require('../contracts/component-host-errors.cjs');

const registerRuntimeFolderArtifacts = async ({ result, policy, inputs, scope, context, versionService, fs, path }) => {
  const mappings = result?.folderOutputs || [];
  if (!Array.isArray(mappings) || mappings.length > 120) throw hostError(CODES.INVALID_REQUEST, 'Invalid runtime folder output mappings');
  if (!mappings.length) return { linked: [], skipped: [] };
  const comparable = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const inside = (root, candidate) => { const relative = path.relative(root, candidate); return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
  const canonicalProject = await fs.promises.realpath(scope.projectRoot);
  let progressFolders;
  const plans = [], skipped = [], seen = new Set();
  for (const [index, mapping] of mappings.entries()) {
    if (!mapping || typeof mapping.sourceFolder !== 'string' || typeof mapping.outputFolder !== 'string' || !path.isAbsolute(mapping.sourceFolder) || !path.isAbsolute(mapping.outputFolder)) throw hostError(CODES.INVALID_REQUEST, 'Runtime folder mapping requires absolute worker paths');
    const input = inputs.find(item => item.directory && comparable(item.filePath) === comparable(mapping.sourceFolder));
    if (!input) throw hostError(CODES.PERMISSION_DENIED, 'Runtime folder source was not an authorized input');
    if (!input.relativePath) { skipped.push({ index, reason: 'external-input' }); continue; }
    const sourceFolder = await fs.promises.realpath(mapping.sourceFolder);
    const outputStat = await fs.promises.lstat(mapping.outputFolder);
    const outputFolder = await fs.promises.realpath(mapping.outputFolder);
    if (!outputStat.isDirectory() || outputStat.isSymbolicLink() || !inside(canonicalProject, sourceFolder) || !inside(canonicalProject, outputFolder) || comparable(sourceFolder) === comparable(outputFolder)) throw hostError(CODES.PERMISSION_DENIED, 'Runtime output folder is outside the project or is unsafe');
    if (!progressFolders) {
      const listed = await versionService.listProgress(scope.workspaceRoot, context.projectName, true);
      if (listed.success === false) throw hostError(CODES.INTERNAL, listed.error || 'Unable to read project progress');
      progressFolders = listed.progressFolders || [];
    }
    const parent = progressFolders.find(item => item.folderPath && comparable(item.folderPath) === comparable(sourceFolder)
      && !item.folderMissing && item.mediaKind === policy.mediaKind && (item.nodeRole === 'original' && !item.artifactKind || item.nodeRole === 'progress' && item.parentProgressId && item.relationKind === 'main'));
    if (!parent) { skipped.push({ index, reason: 'source-not-registered' }); continue; }
    const outputKey = comparable(outputFolder);
    if (seen.has(outputKey)) throw hostError(CODES.INVALID_REQUEST, 'Runtime output folder was mapped more than once');
    seen.add(outputKey);
    plans.push({ sourceProgressId: parent.id, outputFolder, relativePath: path.relative(scope.projectRoot, outputFolder).replace(/\\/g, '/') });
  }
  const linked = [];
  for (const plan of plans) {
    const adopted = await versionService.adoptMediaFolder(scope.workspaceRoot, {
      projectName: context.projectName, folderPath: plan.outputFolder,
      mode: policy.mode, mediaKind: policy.mediaKind, sourceProgressId: plan.sourceProgressId,
    });
    if (!adopted?.success || !adopted.progressFolder?.id || !adopted.edge?.id) throw hostError(CODES.INTERNAL, adopted?.error || 'Unable to register generated folder relation');
    linked.push({ sourceProgressId: plan.sourceProgressId, targetProgressId: adopted.progressFolder.id, relativePath: plan.relativePath });
  }
  return { linked, skipped };
};

module.exports = { registerRuntimeFolderArtifacts };
