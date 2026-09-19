const createMediaService = ({ accessService, thumbnailService, toMediaUrl }) => ({
  authorizeInput: value => accessService.authorizeInput(value),
  authorizeWorkspaceInput: (workspaceRoot, value) => accessService.authorizeWorkspaceInput(workspaceRoot, value),
  grantRoot: value => accessService.grantRoot(value),
  grantPath: value => accessService.grantPath(value),
  resolveToken: value => accessService.resolveToken(value),
  toUrl: toMediaUrl,
  requestThumbnail: request => thumbnailService.request(request),
  cancelThumbnail: (filePath, requestedSize) => thumbnailService.cancel(filePath, requestedSize),
});

module.exports = { createMediaService };
