const path = require('node:path');

const comparable = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const inside = (root, value) => typeof value === 'string' && value && (comparable(value) === comparable(root) || comparable(value).startsWith(`${comparable(root)}${path.sep}`));
const undoTargets = operation => {
  if (operation.kind === 'remove-created') return operation.paths || [];
  if (operation.kind === 'trash') return (operation.items || []).map(item => item.original);
  if (operation.kind === 'import-with-sources') return operation.createdPaths || [];
  if (operation.kind === 'paste-replace') return [...(operation.paths || []), ...(operation.moves || []).map(item => item.destination), ...(operation.items || []).map(item => item.original)];
  if (operation.moves?.length) return operation.moves.map(item => item.destination);
  return [operation.destination || operation.source].filter(Boolean);
};
const undoMatchesScope = (operation, workspaceRoot = '', projectPath = '') => {
  if (!workspaceRoot) return true; // Legacy internal callers without a UI scope.
  if (operation.workspaceRoot && comparable(operation.workspaceRoot) !== comparable(workspaceRoot)) return false;
  if (projectPath && !inside(workspaceRoot, projectPath)) return false;
  const targets = undoTargets(operation);
  return targets.length > 0 && targets.every(target => inside(projectPath || workspaceRoot, target));
};
const takeScopedUndo = (history, workspaceRoot, projectPath) => {
  const index = history.findLastIndex(operation => undoMatchesScope(operation, workspaceRoot, projectPath));
  return index < 0 ? undefined : history.splice(index, 1)[0];
};

module.exports = { undoMatchesScope, takeScopedUndo };
