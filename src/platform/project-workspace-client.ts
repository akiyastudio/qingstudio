import type { ProjectWorkspaceApi } from '../contracts/project-workspace-api';

// The renderer sees the full preload bridge, while the workspace feature is
// intentionally compiled against only its declared domain contract.
export const projectWorkspaceClient: ProjectWorkspaceApi = window.electronAPI;
