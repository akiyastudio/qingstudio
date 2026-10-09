const isInternalWorkspacePathSegment = value => {
  const normalized = String(value || '').toLowerCase();
  return normalized.includes('.photoflow-part')
    // Encoder Studio writes here until validation and atomic publication finish.
    || /^\.studio-[0-9a-f]{32}(?:\.[^.]*)?$/.test(normalized)
    || normalized === '.photoflow-workspace-id'
    || normalized === '_photoflow_safety_temp'
    || normalized.startsWith('.') && normalized.includes('.photoflow-');
};

const isInternalWorkspacePath = value => String(value || '')
  .split(/[\\/]/)
  .some(isInternalWorkspacePathSegment);

module.exports = { isInternalWorkspacePath, isInternalWorkspacePathSegment };
