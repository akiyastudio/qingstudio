import { useEffect, useRef, useState } from 'react';
import { FileImage, Loader2, Play } from 'lucide-react';
import type { AppConfig, ProjectFileEntry } from '../types';
import { projectWorkspaceClient } from '../platform/project-workspace-client';
import { VideoHoverThumbnail } from './VideoHoverThumbnail';
import {
  deleteMediaThumbnailPreview,
  findCachedMediaThumbnailPreview,
  forgetMediaThumbnailPreviews,
  getMediaThumbnailPreview,
  mediaThumbnailPreviewKey,
  rememberMediaThumbnailPreview,
  requestThumbnail,
  useThumbnailUpdates,
} from '../features/workspace/useProjectThumbnail';

const HOVER_VIDEO_PLAY_DELAY_MS = 300;

export const MediaThumbnail = ({ entry, cacheConfig, requestedSize, queueOrder, large = false }: { entry: ProjectFileEntry; cacheConfig: AppConfig['mediaCache']; requestedSize: number; queueOrder: number; large?: boolean }) => {
  const previewCacheKey = mediaThumbnailPreviewKey(entry.path, entry.updatedAt, requestedSize);
  const cachedPreview = getMediaThumbnailPreview(previewCacheKey)
    ? { url: getMediaThumbnailPreview(previewCacheKey), size: requestedSize }
    : findCachedMediaThumbnailPreview(entry.path, entry.updatedAt);
  const [preview, setPreview] = useState<{ url?: string; size: number }>({ url: cachedPreview?.url || entry.previewUrl, size: cachedPreview?.size || (entry.previewUrl ? 320 : 0) });
  const [loading, setLoading] = useState(false);
  const [sourceRevision, setSourceRevision] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string>();
  const [videoActivated, setVideoActivated] = useState(false);
  const [videoUnavailable, setVideoUnavailable] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const container = useRef<HTMLSpanElement>(null);
  const hoverRatioRef = useRef(0);
  const previewSourceRef = useRef({ path: entry.path, updatedAt: entry.updatedAt });
  const thumbnailRequestRef = useRef<{ key: string; promoted: boolean; promise: ReturnType<typeof projectWorkspaceClient.getMediaThumbnail> }>();
  const failedPreviewLoadCountRef = useRef(0);
  useEffect(() => {
    failedPreviewLoadCountRef.current = 0;
    const previousSource = previewSourceRef.current;
    const sourceChanged = previousSource.path !== entry.path || previousSource.updatedAt !== entry.updatedAt;
    previewSourceRef.current = { path: entry.path, updatedAt: entry.updatedAt };
    const exactUrl = getMediaThumbnailPreview(previewCacheKey);
    const cached = exactUrl ? { url: exactUrl, size: requestedSize } : findCachedMediaThumbnailPreview(entry.path, entry.updatedAt);
    setPreview(current => {
      if (sourceChanged) return {
        // Keep the last painted preview during an external edit of this file.
        // Size zero still requests its replacement; never carry it to another path.
        url: cached?.url || entry.previewUrl || (previousSource.path === entry.path ? current.url : undefined),
        size: cached?.size || (entry.previewUrl ? 320 : 0),
      };
      if (cached?.url && cached.size > current.size) return cached;
      if (current.url) return current;
      return { url: entry.previewUrl, size: entry.previewUrl ? 320 : 0 };
    });
    setLoading(false);
    setVideoUrl(undefined);
    setVideoActivated(false);
    setVideoUnavailable(false);
    setHovering(false);
    setPlaybackFailed(false);
    hoverRatioRef.current = 0;
    thumbnailRequestRef.current = undefined;
  }, [entry.path, entry.updatedAt, entry.previewUrl, previewCacheKey, requestedSize]);
  useThumbnailUpdates(entry.path, requestedSize, (state, url) => {
    if (state === 'READY') {
      if (url) { rememberMediaThumbnailPreview(previewCacheKey, url); setPreview({ url, size: requestedSize }); }
      setLoading(false);
    } else if (state === 'STALE') {
      forgetMediaThumbnailPreviews(entry.path);
      thumbnailRequestRef.current = undefined;
      setPreview(current => ({ url: current.url, size: 0 }));
      setVideoUrl(undefined);
      setVideoActivated(false);
      setHovering(false);
      setLoading(true);
      setSourceRevision(version => version + 1);
    } else if (state === 'FAILED' || state === 'MISSING') {
      setLoading(false);
    }
  });
  const requestTileThumbnail = (priority: 0 | 1) => {
    const key = `${entry.path}|${entry.updatedAt}|${requestedSize}`;
    const current = thumbnailRequestRef.current;
    if (current?.key === key) {
      return current.promise.then(result => {
        if (priority === 0 && !current.promoted && (result.state === 'QUEUED' || result.state === 'GENERATING')) {
          current.promoted = true;
          return projectWorkspaceClient.getMediaThumbnail(entry.path, entry.kind as 'image' | 'raw' | 'video', cacheConfig, requestedSize, 0, queueOrder);
        }
        return result;
      });
    }
    const promise = projectWorkspaceClient.getMediaThumbnail(entry.path, entry.kind as 'image' | 'raw' | 'video', cacheConfig, requestedSize, priority, queueOrder)
      .catch(error => { if (thumbnailRequestRef.current?.key === key) thumbnailRequestRef.current = undefined; throw error; });
    thumbnailRequestRef.current = { key, promoted: priority === 0, promise };
    return promise;
  };
  const captureVideoResource = (result: Awaited<ReturnType<typeof projectWorkspaceClient.getMediaThumbnail>>) => {
    if (entry.kind !== 'video') return;
    if (result.mediaUrl) setVideoUrl(result.mediaUrl);
    if (result.importedVideoWithoutPreview) setVideoUnavailable(true);
  };
  useEffect(() => {
    if (preview.size >= requestedSize || !container.current) return;
    let active = true;
    const observer = new IntersectionObserver(([item]) => {
      if (!item.isIntersecting) return;
      observer.disconnect();
      setLoading(true);
      requestThumbnail(() => requestTileThumbnail(1))
        .then(result => {
          if (!active) return;
          if (result.previewUrl) { rememberMediaThumbnailPreview(previewCacheKey, result.previewUrl); setPreview({ url: result.previewUrl, size: requestedSize }); }
          captureVideoResource(result);
          if (result.state !== 'QUEUED' && result.state !== 'GENERATING') setLoading(false);
        })
        .catch(() => { if (active) setLoading(false); });
    }, { rootMargin: '240px' });
    observer.observe(container.current);
    return () => { active = false; observer.disconnect(); };
  }, [entry.path, entry.kind, entry.updatedAt, preview.size, cacheConfig, requestedSize, queueOrder, previewCacheKey, sourceRevision]);
  useEffect(() => {
    if (!container.current) return;
    let active = true;
    const observer = new IntersectionObserver(([item]) => {
      if (!item.isIntersecting) return;
      observer.disconnect();
      void requestTileThumbnail(0).then(result => {
        if (!active) return;
        captureVideoResource(result);
        if (result.previewUrl) {
          rememberMediaThumbnailPreview(previewCacheKey, result.previewUrl);
          setPreview({ url: result.previewUrl, size: requestedSize });
        }
        if (result.previewUrl || result.state !== 'QUEUED' && result.state !== 'GENERATING') setLoading(false);
      }).catch(() => { if (active) setLoading(false); });
    });
    observer.observe(container.current);
    return () => { active = false; observer.disconnect(); };
  }, [entry.kind, entry.path, entry.updatedAt, cacheConfig, requestedSize, queueOrder, previewCacheKey, sourceRevision]);
  useEffect(() => {
    if (!hovering || entry.kind !== 'video' || videoUnavailable) return;
    let active = true;
    const timer = window.setTimeout(() => {
      if (!active) return;
      setVideoActivated(true);
      if (!videoUrl) setLoading(true);
      requestTileThumbnail(0).then(result => {
        if (!active) return;
        captureVideoResource(result);
        if (!result.mediaUrl) setVideoUnavailable(true);
      }).catch(() => undefined).finally(() => { if (active) setLoading(false); });
    }, HOVER_VIDEO_PLAY_DELAY_MS);
    return () => { active = false; window.clearTimeout(timer); };
  }, [entry.kind, hovering, videoUnavailable, videoUrl]);
  const setPointerRatio = (clientX: number) => {
    const rect = container.current?.getBoundingClientRect();
    if (!rect?.width) return;
    hoverRatioRef.current = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };
  const handleMouseLeave = () => {
    setHovering(false);
    hoverRatioRef.current = 0;
    setVideoActivated(false);
  };
  const showVideo = entry.kind === 'video' && videoActivated && videoUrl && !playbackFailed;
  const handlePreviewLoadError = () => {
    deleteMediaThumbnailPreview(previewCacheKey);
    thumbnailRequestRef.current = undefined;
    if (failedPreviewLoadCountRef.current >= 1) {
      setPreview({ url: undefined, size: requestedSize });
      setLoading(false);
      return;
    }
    failedPreviewLoadCountRef.current += 1;
    setPreview({ url: undefined, size: 0 });
    setLoading(true);
  };
  return <span
    ref={container}
    onMouseEnter={event => { setPointerRatio(event.clientX); setHovering(true); }}
    onMouseMove={event => { if (hovering && entry.kind === 'video') setPointerRatio(event.clientX); }}
    onMouseLeave={handleMouseLeave}
    className="relative flex h-full w-full items-center justify-center overflow-hidden bg-black/5"
  >
    {preview.url ? <img src={preview.url} alt="" draggable={false} className="h-full w-full object-contain" onLoad={() => { failedPreviewLoadCountRef.current = 0; setLoading(false); }} onError={handlePreviewLoadError}/> : <FileImage size={large ? 42 : 23} className="text-slate-400"/>}
    {loading && <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-900/25"><Loader2 size={large ? 24 : 16} className="animate-spin text-white drop-shadow"/><span className="sr-only">正在加载预览</span></span>}
    {entry.kind === 'video' && !showVideo && <Play size={large ? 25 : 15} fill="currentColor" className="pointer-events-none absolute text-white drop-shadow-[0_1px_4px_rgba(0,0,0,.8)]"/>}
    {showVideo && (
      <VideoHoverThumbnail src={videoUrl} poster={preview.url} name={entry.name} large={large} initialRatio={hoverRatioRef.current} onError={() => { setPlaybackFailed(true); setVideoActivated(false); }}/>
    )}
  </span>;
};
