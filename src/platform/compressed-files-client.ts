import type { CompressedFilesRequest } from '../contracts/compressed-files';
import type { ProjectWorkspaceApi } from '../contracts/project-workspace-api';
export const compressedFilesRequest = async <T,>(request: CompressedFilesRequest): Promise<T> => {
  const api: Pick<ProjectWorkspaceApi, 'compressedFiles'> = window.electronAPI;
  const reply = await api.compressedFiles(request);
  if (!reply.success) throw Object.assign(new Error(reply.error || '压缩处理失败'), { code: reply.code });
  return reply.result as T;
};
