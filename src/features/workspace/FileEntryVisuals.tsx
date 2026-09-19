import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowUpRight, File, FileImage, Folder, FolderInput } from 'lucide-react';
import type { AppConfig, ProjectFileEntry } from '../../types';
import { projectWorkspaceClient } from '../../platform/project-workspace-client';
import { folderCoverEntryAfterLoad } from './directory-preview-cache-model';
import { FOLDER_COVER_MAX_CONSECUTIVE_LOAD_FAILURES, createFolderCoverMediaState, folderCoverMediaSourceKey, folderCoverRequestKey, reduceFolderCoverMediaState, type FolderCoverMediaState } from './folder-cover-media-model';
import { forgetMediaThumbnailPreviews, getMediaThumbnailPreview, mediaThumbnailPreviewKey, rememberMediaThumbnailPreview, useThumbnailUpdates } from './useProjectThumbnail';

type DirectoryPreviewLoadResult = { entries: ProjectFileEntry[]; authoritative: boolean };

const FOLDER_COVER_THUMBNAIL_RETRY_DELAYS_MS = [1500, 4000] as const;

const FolderCoverMedia = ({ entry, cacheConfig, requestedSize, queueOrder, pendingRename }: {
  entry: ProjectFileEntry;
  cacheConfig: AppConfig['mediaCache'];
  requestedSize: number;
  queueOrder: number;
  pendingRename: boolean;
}) => {
  const sourceKey = folderCoverMediaSourceKey(entry, requestedSize);
  const previewCacheKey = mediaThumbnailPreviewKey(entry.path, entry.updatedAt, requestedSize);
  const [mediaState, setMediaState] = useState<FolderCoverMediaState>(() => {
    const cachedUrl = getMediaThumbnailPreview(previewCacheKey);
    // Returning to a directory remounts its covers. Paint the previous URL
    // immediately while the normal request below revalidates the disk cache.
    return { ...createFolderCoverMediaState(sourceKey, cachedUrl ? undefined : entry.previewUrl), displayedUrl: cachedUrl };
  });
  const mediaStateRef = useRef(mediaState);
  mediaStateRef.current = mediaState;
  const [retryVersion, setRetryVersion] = useState(0);
  const updateRetryCountRef = useRef(0);
  const updateRetryTimerRef = useRef<number>();
  const requestKey = folderCoverRequestKey(sourceKey, pendingRename, retryVersion);
  const clearScheduledRetry = useCallback(() => {
    if (updateRetryTimerRef.current !== undefined) window.clearTimeout(updateRetryTimerRef.current);
    updateRetryTimerRef.current = undefined;
  }, []);
  const scheduleRetry = useCallback(() => {
    if (mediaStateRef.current.consecutiveLoadFailures >= FOLDER_COVER_MAX_CONSECUTIVE_LOAD_FAILURES
      || updateRetryCountRef.current >= FOLDER_COVER_THUMBNAIL_RETRY_DELAYS_MS.length
      || updateRetryTimerRef.current !== undefined) return;
    const attempt = updateRetryCountRef.current;
    updateRetryCountRef.current += 1;
    const retryDelay = pendingRename ? 250 * (attempt + 1) : FOLDER_COVER_THUMBNAIL_RETRY_DELAYS_MS[attempt];
    updateRetryTimerRef.current = window.setTimeout(() => {
      updateRetryTimerRef.current = undefined;
      setRetryVersion(version => version + 1);
    }, retryDelay);
  }, [pendingRename]);
  useThumbnailUpdates(entry.path, requestedSize, (state, nextUrl) => {
    setMediaState(current => reduceFolderCoverMediaState(current, { type: 'THUMBNAIL_UPDATED', state, previewUrl: nextUrl }));
    if (state === 'READY' && nextUrl) {
      clearScheduledRetry();
      updateRetryCountRef.current = 0;
      return;
    }
    if (state === 'STALE') {
      forgetMediaThumbnailPreviews(entry.path);
      clearScheduledRetry();
      updateRetryCountRef.current = 0;
      setRetryVersion(version => version + 1);
      return;
    }
    if (state === 'NOT_READY' || state === 'QUEUED' || state === 'GENERATING' || state === 'FAILED') scheduleRetry();
  });
  useEffect(() => {
    updateRetryCountRef.current = 0;
    clearScheduledRetry();
    setMediaState(current => reduceFolderCoverMediaState(current, {
      type: 'SOURCE_UPDATED', sourceKey, preserveDisplayed: pendingRename,
    }));
  }, [clearScheduledRetry, sourceKey, pendingRename]);
  useEffect(() => {
    setMediaState(current => reduceFolderCoverMediaState(current, {
      type: 'SOURCE_UPDATED', sourceKey, previewUrl: entry.previewUrl, preserveDisplayed: pendingRename,
    }));
  }, [sourceKey, entry.previewUrl, pendingRename]);
  useEffect(() => () => clearScheduledRetry(), [clearScheduledRetry]);
  useEffect(() => {
    let active = true;
    projectWorkspaceClient.getMediaThumbnail(entry.path, entry.kind as 'image' | 'raw' | 'video', cacheConfig, requestedSize, 1, queueOrder)
      .then(result => {
        if (!active) return;
        if (result.previewUrl) {
          clearScheduledRetry();
          updateRetryCountRef.current = 0;
          setMediaState(current => reduceFolderCoverMediaState(current, { type: 'THUMBNAIL_UPDATED', state: 'READY', previewUrl: result.previewUrl }));
          return;
        }
        if (!result.success || result.state === 'NOT_READY' || result.state === 'QUEUED' || result.state === 'GENERATING' || result.state === 'FAILED') scheduleRetry();
      })
      .catch(() => { if (active) scheduleRetry(); });
    return () => { active = false; };
  }, [entry.path, entry.kind, cacheConfig.directory, cacheConfig.maxSizeGB, requestedSize, queueOrder, requestKey, clearScheduledRetry, scheduleRetry]);
  return <>
    {mediaState.displayedUrl
      ? <img key={mediaState.displayedUrl} src={mediaState.displayedUrl} alt="" draggable={false} className="h-full w-full object-cover" onError={() => {
        const failedUrl = mediaState.displayedUrl!;
        const nextFailureCount = mediaState.consecutiveLoadFailures + 1;
        forgetMediaThumbnailPreviews(entry.path);
        setMediaState(current => reduceFolderCoverMediaState(current, { type: 'DISPLAYED_FAILED', url: failedUrl }));
        if (nextFailureCount < FOLDER_COVER_MAX_CONSECUTIVE_LOAD_FAILURES) scheduleRetry();
      }}/>
      : <FileImage size={requestedSize > 160 ? 28 : 14} className="text-slate-400"/>}
    {mediaState.candidateUrl && (
      <img key={mediaState.candidateUrl} src={mediaState.candidateUrl} alt="" draggable={false} className="pointer-events-none absolute inset-0 h-full w-full opacity-0" onLoad={() => {
      clearScheduledRetry();
      updateRetryCountRef.current = 0;
      rememberMediaThumbnailPreview(previewCacheKey, mediaState.candidateUrl!);
      setMediaState(current => reduceFolderCoverMediaState(current, { type: 'CANDIDATE_LOADED', url: mediaState.candidateUrl! }));
    }} onError={() => {
      const failedUrl = mediaState.candidateUrl!;
      const nextFailureCount = mediaState.consecutiveLoadFailures + 1;
      forgetMediaThumbnailPreviews(entry.path);
      setMediaState(current => reduceFolderCoverMediaState(current, { type: 'CANDIDATE_FAILED', url: failedUrl }));
      if (nextFailureCount < FOLDER_COVER_MAX_CONSECUTIVE_LOAD_FAILURES) scheduleRetry();
    }}/>
    )}
  </>;
};

export const FolderCover = ({ entry, cacheConfig, requestedSize, queueOrder, large, loadEntries }: {
  entry: ProjectFileEntry;
  cacheConfig: AppConfig['mediaCache'];
  requestedSize: number;
  queueOrder: number;
  large: boolean;
  loadEntries: (entry: ProjectFileEntry) => Promise<DirectoryPreviewLoadResult>;
}) => {
  const container = useRef<HTMLSpanElement>(null);
  const [coverEntry, setCoverEntry] = useState<ProjectFileEntry>();
  const pendingRename = Boolean((entry as ProjectFileEntry & { pendingSourceRelativePath?: string }).pendingSourceRelativePath);
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    let active = true;
    const observer = new IntersectionObserver(([item]) => {
      if (!item.isIntersecting) return;
      observer.disconnect();
      void loadEntries(entry).then(result => {
        if (!active) return;
        setCoverEntry(previous => folderCoverEntryAfterLoad(previous, result.entries, pendingRename || !result.authoritative));
      });
    }, { rootMargin: '180px' });
    observer.observe(node);
    return () => { active = false; observer.disconnect(); };
  }, [entry.path, entry.updatedAt, pendingRename, loadEntries]);

  const isMedia = coverEntry && (coverEntry.kind === 'image' || coverEntry.kind === 'raw' || coverEntry.kind === 'video');
  const iconSize = large ? '100%' : 27;
  // Enlarge only the artwork so folder covers cannot push grid labels below file labels.
  return <span ref={container} aria-hidden style={large ? undefined : { width: 27, height: 27 }} className={`relative isolate block shrink-0 text-blue-500 ${large ? 'h-full w-full scale-[1.14]' : ''}`}>
    <Folder size={iconSize} strokeWidth={1.5} fill="currentColor" className="absolute inset-0"/>
    {coverEntry && <span className="absolute bottom-[20%] left-[11%] right-[11%] top-[31%] z-10 flex items-center justify-center overflow-hidden rounded-[5%] bg-slate-100">
      {isMedia
        ? <FolderCoverMedia entry={coverEntry} cacheConfig={cacheConfig} requestedSize={requestedSize} queueOrder={queueOrder} pendingRename={pendingRename}/>
        : <SystemFileIcon filePath={coverEntry.path} size={large ? 40 : 11}/>}
    </span>}
    {coverEntry && <>
      <span
        className="pointer-events-none absolute bottom-[17%] left-[8.3%] right-[8.3%] z-20 h-[18%] bg-blue-500 shadow-[0_-1px_0_rgba(255,255,255,0.32)]"
        style={{ clipPath: 'polygon(0 18%, 39% 18%, 46% 0, 100% 0, 100% 100%, 0 100%)' }}
      />
      <Folder size={iconSize} strokeWidth={1.5} fill="none" className="pointer-events-none absolute inset-0 z-30"/>
    </>}
  </span>;
};

export const ShortcutEntryIcon = ({ entry, cacheConfig, requestedSize, queueOrder, large, loadEntries }: {
  entry: ProjectFileEntry;
  cacheConfig: AppConfig['mediaCache'];
  requestedSize: number;
  queueOrder: number;
  large: boolean;
  loadEntries: (entry: ProjectFileEntry) => Promise<DirectoryPreviewLoadResult>;
}) => {
  const container = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (entry.shortcutTargetKind || entry.shortcutBroken) return;
    const node = container.current;
    if (!node) return;
    const observer = new IntersectionObserver(([item]) => {
      if (!item.isIntersecting) return;
      observer.disconnect();
      void loadEntries(entry);
    }, { rootMargin: '180px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [entry.path, entry.updatedAt, entry.shortcutTargetKind, entry.shortcutBroken, loadEntries]);

  if (entry.shortcutBroken) return <span ref={container} className={`shortcut-folder-cover is-broken ${large ? 'h-full w-full' : ''}`} aria-label="失效的文件夹快捷方式">
    <Folder size={large ? 64 : 30} strokeWidth={1.5} fill="currentColor"/>
    <span className="shortcut-cover-badge is-warning"><AlertTriangle size={large ? 15 : 10}/></span>
  </span>;
  if (entry.shortcutTargetKind === 'folder') return <>
    <FolderCover entry={entry} cacheConfig={cacheConfig} requestedSize={requestedSize} queueOrder={queueOrder} large={large} loadEntries={loadEntries}/>
    <span aria-label="快捷方式" className="shortcut-cover-badge"><ArrowUpRight size={large ? 16 : 10}/></span>
  </>;
  return <span ref={container} className="relative inline-flex"><FolderInput size={large ? 48 : 28} strokeWidth={1.4} className="text-blue-500"/></span>;
};

const systemFileIconCache = new Map<string, Promise<string | undefined>>();
export const SystemFileIcon = ({ filePath, size }: { filePath: string; size: number }) => {
  const [dataUrl, setDataUrl] = useState<string>();
  useEffect(() => {
    const fileName = filePath.split(/[\\/]/).pop() || filePath;
    const extension = fileName.includes('.') ? `.${fileName.split('.').pop()?.toLowerCase()}` : fileName.toLowerCase();
    let request = systemFileIconCache.get(extension);
    if (!request) {
      request = projectWorkspaceClient.getFileIcon(filePath)
        .then(result => result.success ? result.dataUrl : undefined)
        .catch(error => { systemFileIconCache.delete(extension); throw error; });
      if (systemFileIconCache.size >= 128) systemFileIconCache.delete(systemFileIconCache.keys().next().value as string);
      systemFileIconCache.set(extension, request);
    }
    let active = true;
    request.then(icon => { if (active) setDataUrl(icon); }).catch(() => undefined);
    return () => { active = false; };
  }, [filePath]);
  return dataUrl ? <img src={dataUrl} alt="" draggable={false} style={{ width: size, height: size }} className="object-contain"/> : <File size={size} className="text-slate-400"/>;
};
