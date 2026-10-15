import type { ProjectStatus } from '../types';
export interface CompressionContext { workspacePath: string; projectId: string; projectName: string; projectStatus: ProjectStatus; sourcePageId: string; contentKind: 'project' | 'inspiration' }
export interface ArchiveMember { relativePath: string; directory: boolean; size: number; inputPath?: string }
export interface ArchiveSession { sessionId: string; archiveName: string; entries: ArchiveMember[]; totalBytes: number }
export interface ArchiveResource { mediaUrl?: string; extension?: string; text?: string; opened?: boolean }
export interface CompressionJob { operationId: string; state: 'running' | 'publishing' | 'completed' | 'failed' | 'cancelled' | 'publication-failed'; progress: number; message: string; outputs: { relativePath: string }[]; errorCode?: string }
export interface CompressedFilesRequest {
  action: 'open' | 'close' | 'member' | 'run' | 'current' | 'cancel' | 'publish' | 'preferences';
  context?: CompressionContext;
  sessionId?: string;
  relativePath?: string;
  password?: string;
  openExternal?: boolean;
  payload?: { relativePaths?: string[]; mode?: 'compress' | 'extract'; operationId?: string; name?: string; format?: 'zip' | '7z'; level?: number; splitMiB?: number; encryptNames?: boolean; password?: string; maxGiB?: number; comment?: string };
}
export interface CompressedFilesReply { success: boolean; result?: unknown; error?: string; code?: string }
export const isCompressedFile = (name: string) => /\.(zip|7z|rar|001|tar|gz|bz2|xz|tgz|tbz2|txz)$/i.test(name);
/** ZIP member paths may omit directory records; synthesize just the current level. */
export const archiveDirectoryEntries = (entries: ArchiveMember[], directory: string) => {
  const prefix = directory ? `${directory}/` : '', result = new Map<string, ArchiveMember>();
  for (const entry of entries) {
    if (!entry.relativePath.startsWith(prefix)) continue;
    const remainder = entry.relativePath.slice(prefix.length), first = remainder.split('/')[0];
    if (!first) continue;
    const relativePath = prefix + first;
    const child = remainder.includes('/') ? { relativePath, directory: true, size: 0 } : entry;
    result.set(relativePath, child);
  }
  return [...result.values()].sort((a, b) => Number(b.directory) - Number(a.directory) || a.relativePath.localeCompare(b.relativePath, 'zh-CN', { numeric: true }));
};
