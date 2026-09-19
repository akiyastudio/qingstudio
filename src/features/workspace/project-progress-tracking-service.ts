import type { ProgressFolder, WorkspaceProject } from '../../types';
import { projectWorkspaceClient } from '../../platform/project-workspace-client';

export const setProjectProgressTrackingState = async ({
  workspacePath,
  project,
  progressFolder,
  relativePath,
  trackingState,
}: {
  workspacePath: string;
  project: Pick<WorkspaceProject, 'name' | 'status'>;
  progressFolder: ProgressFolder;
  relativePath: string;
  trackingState: ProgressFolder['trackingState'];
}) => {
  const mediaKind = progressFolder.mediaKind === 'image' || progressFolder.mediaKind === 'video' ? progressFolder.mediaKind : null;
  if (!mediaKind) throw new Error('混合媒体节点不能启用版本跟踪');
  const updated = await projectWorkspaceClient.registerProgressFolder(workspacePath, project.status, project.name, {
    relativePath,
    mediaKind,
    versionKey: progressFolder.versionKey,
    parentProgressId: progressFolder.parentProgressId || undefined,
    displayName: progressFolder.displayName,
    trackingEnabled: trackingState === 'ready',
    trackingState,
    progressId: progressFolder.id,
  });
  if (!updated.success || !updated.progressFolder) throw new Error(updated.error || '无法更新版本跟踪状态');
  return updated.progressFolder;
};
