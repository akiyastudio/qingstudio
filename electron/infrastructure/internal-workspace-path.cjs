const isInternalWorkspacePathSegment = value => {
  const normalized = String(value || '').toLowerCase();
  return normalized.includes('.photoflow-part')
    || normalized === '.photoflow-workspace-id'
    || normalized === '_photoflow_safety_temp'
    || normalized.startsWith('.') && normalized.includes('.photoflow-');
};

const isInternalWorkspacePath = value => String(value || '')
  .split(/[\\/]/)
  .some(isInternalWorkspacePathSegment);

module.exports = { isInternalWorkspacePath, isInternalWorkspacePathSegment };
