import { LocalizedText } from "../../i18n/LocalizedText";
import { useLocale } from "../../i18n/react";
import { t } from "../../i18n/runtime";
import React, { useEffect, useRef, useState } from 'react';
import { usePageTransferParticipant } from '../../platform/page-transfer-state';
import { createPortal } from 'react-dom';
import { CheckCircle2, Crop, ExternalLink, FileImage, Heart, Image as ImageIcon, Loader2, Maximize2, Star, Video, X } from 'lucide-react';
import { VideoPlayer } from '../../components/AdvancedVideoPlayer';
import { InteractiveCropEditor, type CropRectangle } from '../../components/InteractiveCropEditor';
import { useEscapeLayer } from '../../components/LayerProvider';
import type { AppConfig, ProjectFileEntry } from '../../types';
import { projectWorkspaceClient } from '../../platform/project-workspace-client';
import { useTaskCenter } from '../background-tasks/TaskCenter';
import { PhotoshopIcon } from './PhotoshopIcon';
import { findCachedMediaThumbnailPreview, mediaThumbnailPreviewKey, rememberMediaThumbnailPreview, requestThumbnail } from './useProjectThumbnail';
import { clampNumber } from './project-workspace-layout-model';
import { formatMediaDuration } from './media-preview-model';
import { WorkspacePanelHeader } from './WorkspacePanelHeader';
import { useComponentPreview } from './useComponentPreview';
import { ComponentDecodedPreview } from './ComponentDecodedPreview';
import type { PreviewPageContext, PreviewDecoder } from '../../contracts/component-preview';

export type PreviewImageCropAnalysis = {
  success: boolean;
  crop?: CropRectangle;
  snapGuides?: { x: number[]; y: number[] };
  originalSize?: { width: number; height: number };
  error?: string;
};
export type PreviewTechnicalMetadata = { width?: number; height?: number; duration?: number; unavailable?: boolean };
const backgroundTaskPathKey = (value: unknown) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
const isUnsupportedShortcutContent = (entry: ProjectFileEntry) => entry.viaShortcut === true;

type VideoTrimExportProgress = { phase: string; progress: number; message: string };

const VideoTrimTimeline = ({ duration, start, end, currentTime, frames, exportMode, busyMode, exportProgress, progressVisible, onChange, onPreview, onCancel, onSave }: {
  duration: number;
  start: number;
  end: number;
  currentTime: number;
  frames: string[];
  exportMode: AppConfig['videoTools']['trim']['exportMode'];
  busyMode: 'new' | 'replace' | '';
  exportProgress?: VideoTrimExportProgress;
  progressVisible: boolean;
  onChange: (edge: 'start' | 'end', time: number) => void;
  onPreview: (time: number) => void;
  onCancel: () => void;
  onSave: (mode: 'new' | 'replace') => void;
}) => {
  useLocale();
  const railRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; edge: 'start' | 'end' } | null>(null);
  const safeDuration = Math.max(.05, duration);
  const percent = (value: number) => Math.max(0, Math.min(100, value / safeDuration * 100));
  const startPercent = percent(start);
  const endPercent = percent(end);
  const playheadPercent = percent(currentTime);
  const timeAtClientX = (clientX: number) => {
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect?.width) return 0;
    return Math.max(0, Math.min(safeDuration, (clientX - rect.left) / rect.width * safeDuration));
  };
  const beginDrag = (event: React.PointerEvent<HTMLButtonElement>, edge: 'start' | 'end') => {
    if (busyMode) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { pointerId: event.pointerId, edge };
    event.currentTarget.setPointerCapture(event.pointerId);
    const time = timeAtClientX(event.clientX);
    onChange(edge, time);
  };
  const moveDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const time = timeAtClientX(event.clientX);
    onChange(drag.edge, time);
  };
  const endDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
  };
  const selectedDuration = Math.max(0, end - start);

  return <div role="dialog" aria-label={t("ui.trim.video.a4a301")} className="relative z-30 shrink-0 border-t border-white/10 bg-[#070b15] px-3 pb-3 pt-2.5 text-white shadow-[0_-12px_30px_rgba(0,0,0,.35)]" onContextMenu={event => event.stopPropagation()}>
    <div className="mb-2 flex items-center justify-between gap-3 text-[11px]">
      <div className="min-w-0"><span className="font-bold text-white">{t("ui.trim.video.a4a301")}</span><span className="ml-2 text-slate-400">{t("ui.drag.either.edge.to.update.the.e8f72e")}</span></div>
      <div className="shrink-0 tabular-nums text-slate-300"><span className="text-white">{formatMediaDuration(start)}</span><span className="mx-1.5 text-slate-600">—</span><span className="text-white">{formatMediaDuration(end)}</span><span className="ml-2 text-slate-500">{t("message.110e837f7f4d", { value0: formatMediaDuration(selectedDuration) })}</span></div>
    </div>
    <div ref={railRef} onPointerDown={event => { if (busyMode || (event.target as HTMLElement).closest('button')) return; const time = timeAtClientX(event.clientX); onPreview(Math.max(start, Math.min(end, time))); }} className="relative h-16 select-none overflow-hidden rounded-lg border border-white/10 bg-slate-900" style={{ touchAction: 'none' }}>
      <div className="pointer-events-none absolute inset-0 grid grid-cols-8 opacity-60">
        {Array.from({ length: 8 }, (_, index) => <div key={index} className="border-r border-black/25 bg-slate-800 bg-cover bg-center last:border-r-0" style={frames[index] ? { backgroundImage: `url(${JSON.stringify(frames[index]).slice(1, -1)})` } : undefined}/>)}
      </div>
      <div className="pointer-events-none absolute inset-y-0 left-0 bg-black/70" style={{ width: `${startPercent}%` }}/>
      <div className="pointer-events-none absolute inset-y-0 right-0 bg-black/70" style={{ width: `${100 - endPercent}%` }}/>
      <div className="pointer-events-none absolute inset-y-0 rounded border-y-[3px] border-amber-400" style={{ left: `${startPercent}%`, width: `${Math.max(0, endPercent - startPercent)}%` }}/>
      {busyMode && exportProgress && <div role="progressbar" aria-label={exportProgress.message} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(exportProgress.progress)} className="pointer-events-none absolute inset-0 z-40 overflow-hidden bg-slate-600/65 backdrop-blur-[1px]">
        <div className="absolute inset-x-0 top-0 h-1 bg-slate-950/45"><div className="h-full bg-amber-400 transition-[width] duration-200" style={{ width: `${progressVisible ? Math.max(0, Math.min(100, exportProgress.progress)) : 0}%` }}/></div>
        <div className="absolute inset-x-2 top-2 flex min-w-0 items-center justify-between gap-2 text-[10px] font-bold text-white drop-shadow-sm"><span className="shrink-0">{t("ui.trimming.video.5929b6")}</span><span className="min-w-0 truncate text-right text-slate-100">{progressVisible ? `${exportProgress.message} · ${Math.round(exportProgress.progress)}%` : t("ui.preparing.trim.5daf7f")}</span></div>
      </div>}
      {currentTime >= start && currentTime <= end && (
        <div className="pointer-events-none absolute inset-y-1 z-20 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_5px_rgba(0,0,0,.9)]" style={{ left: `${playheadPercent}%` }}/>
      )}
      <button type="button" aria-label={t("ui.adjust.start.time.currently.value0.3174a4", { value0: formatMediaDuration(start) })} disabled={Boolean(busyMode)} onPointerDown={event => beginDrag(event, 'start')} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} className="absolute inset-y-0 z-30 w-5 -translate-x-1/2 cursor-ew-resize rounded-l-md border-y-[3px] border-l-[3px] border-amber-400 bg-amber-400/20 outline-none disabled:cursor-default" style={{ left: `${startPercent}%`, touchAction: 'none' }}><span className="absolute left-1/2 top-1/2 h-5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded bg-amber-100"/></button>
      <button type="button" aria-label={t("ui.adjust.end.time.currently.value0.3468c7", { value0: formatMediaDuration(end) })} disabled={Boolean(busyMode)} onPointerDown={event => beginDrag(event, 'end')} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} className="absolute inset-y-0 z-30 w-5 -translate-x-1/2 cursor-ew-resize rounded-r-md border-y-[3px] border-r-[3px] border-amber-400 bg-amber-400/20 outline-none disabled:cursor-default" style={{ left: `${endPercent}%`, touchAction: 'none' }}><span className="absolute left-1/2 top-1/2 h-5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded bg-amber-100"/></button>
    </div>
    <div className="mt-2.5 flex items-center justify-between gap-2">
      <p className="min-w-0 truncate text-[10px] text-slate-500">{exportMode === 'fast' ? t("ui.fast.export.does.not.re.encode.17a452") : t("ui.precise.export.re.encodes.at.high.4c9e35")}</p>
      <div className="flex shrink-0 items-center gap-2"><button type="button" disabled={exportProgress?.phase === 'cancelling'} onClick={onCancel} className="rounded-md px-2.5 py-1.5 text-xs font-bold text-slate-300 hover:bg-white/10 disabled:opacity-40">{busyMode ? exportProgress?.phase === 'cancelling' ? t("ui.cancelling.e8e08b") : t("ui.cancel.export.7eefaa") : t("common.cancel")}</button><button type="button" disabled={Boolean(busyMode) || selectedDuration < .05} onClick={() => onSave('new')} className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-white/20 disabled:opacity-40">{busyMode === 'new' && <Loader2 size={13} className="animate-spin"/>}{busyMode === 'new' ? t("ui.saving.a.copy.ade8e0") : t("ui.save.as.new.video.3321d9")}</button><button type="button" disabled={Boolean(busyMode) || selectedDuration < .05} onClick={() => onSave('replace')} className="inline-flex items-center gap-1.5 rounded-md bg-amber-500 px-2.5 py-1.5 text-xs font-bold text-slate-950 hover:bg-amber-400 disabled:opacity-40">{busyMode === 'replace' && <Loader2 size={13} className="animate-spin"/>}{busyMode === 'replace' ? t("ui.replacing.8a548b") : t("ui.replace.original.video.fdffcb")}</button></div>
    </div>
  </div>;
};
const FULLSCREEN_CONTROLS_HIDE_DELAY_MS = 1800;
export const MediaPreviewPane = ({ previewContext, decoder: availableDecoder, panelOrder, entry, cacheConfig, width, pinned, keyboardSettings, videoTrimExportMode, videoTrimAvailable, photoshopAvailable, ratingAvailable, rating, ratingMode, ratingLoading, ratingBusy, onChangeRating, onTogglePinned, onTechnicalMetadata, onNavigate, onContextMenu, onContextMenuAt, onAnalyzeImageCrop, onConfirmImageCrop, onTrimVideo, onLoadVideoTimelineFrames, onOpen, onOpenInPhotoshop, onSelectImage, selectionAvailable, selectionBusy, onClose }: {
  entry?: ProjectFileEntry;
  previewContext?: PreviewPageContext;
  decoder?: PreviewDecoder;
  cacheConfig: AppConfig['mediaCache'];
  width: number;
  pinned: boolean;
  panelOrder?: number;
  keyboardSettings: AppConfig['videoPlayback'];
  videoTrimExportMode: AppConfig['videoTools']['trim']['exportMode'];
  videoTrimAvailable: boolean;
  photoshopAvailable: boolean;
  ratingAvailable: boolean;
  rating: number;
  ratingMode: AppConfig['favoriteDisplayMode'];
  ratingLoading: boolean;
  ratingBusy: boolean;
  onChangeRating: (rating: number) => void;
  onTogglePinned: () => void;
  onTechnicalMetadata: (metadata: PreviewTechnicalMetadata) => void;
  onNavigate: (direction: -1 | 1) => void;
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
  onContextMenuAt: (x: number, y: number) => void;
  onAnalyzeImageCrop: (entry: ProjectFileEntry) => Promise<PreviewImageCropAnalysis>;
  onConfirmImageCrop: (entry: ProjectFileEntry, crop: CropRectangle, saveMode: 'replace' | 'new') => Promise<{ success: boolean; error?: string }>;
  onTrimVideo: (start: number, end: number, saveMode: 'new' | 'replace', operationId: string, sourceDuration: number) => Promise<{ success: boolean; started?: boolean; cancelled?: boolean; error?: string }>;
  onLoadVideoTimelineFrames: (times: number[]) => Promise<{ success: boolean; frames?: string[]; error?: string }>;
  onOpen: () => void;
  onOpenInPhotoshop: () => void;
  onSelectImage: () => void;
  selectionAvailable: boolean;
  selectionBusy: boolean;
  onClose: () => void;
}) => {
  useLocale();
  const { backgroundTasks } = useTaskCenter();
  const backgroundTrimTask = entry?.kind === 'video' ? backgroundTasks.find(task => task.type === 'video-trim'
    && (task.state === 'queued' || task.state === 'running')
    && backgroundTaskPathKey(task.metadata?.sourcePath) === backgroundTaskPathKey(entry.path)) : undefined;
  const [resource, setResource] = useState<{ sourcePath?: string; previewUrl?: string; originalUrl?: string; orientationMatrix?: number[]; orientationSwapsAxes?: boolean }>({});
  const [loading, setLoading] = useState(false);
  const [originalLoading, setOriginalLoading] = useState(false);
  const [originalLoadError, setOriginalLoadError] = useState('');
  const [videoPlaybackFailed, setVideoPlaybackFailed] = useState(false);
  const decoder = entry?.kind === 'video' && !videoPlaybackFailed ? undefined : availableDecoder;
  const [videoPlayerError, setVideoPlayerError] = useState('');
  const [imageZoom, setImageZoom] = useState(1);
  const [imagePan, setImagePan] = useState({ x: 0, y: 0 });
  const [imageNaturalSize, setImageNaturalSize] = useState({ width: 0, height: 0 });
  const [imageSurfaceSize, setImageSurfaceSize] = useState({ width: 0, height: 0 });
  const [imageDragging, setImageDragging] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenControlsVisible, setFullscreenControlsVisible] = useState(true);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoPlaybackTime, setVideoPlaybackTime] = useState(0);
  const [videoEditorSeek, setVideoEditorSeek] = useState<{ id: number; time: number; pause?: boolean }>();
  const [videoTrimFrames, setVideoTrimFrames] = useState<string[]>([]);
  const [trimEditor, setTrimEditor] = useState<{ start: number; end: number } | null>(null);
  const [trimBusyMode, setTrimBusyMode] = useState<'new' | 'replace' | ''>('');
  const [trimExportProgress, setTrimExportProgress] = useState<VideoTrimExportProgress>();
  const [trimProgressVisible, setTrimProgressVisible] = useState(false);
  const [imageCropEditor, setImageCropEditor] = useState<{ crop: CropRectangle; snapGuides: { x: number[]; y: number[] }; originalSize: { width: number; height: number } } | null>(null);
  const [imageCropPhase, setImageCropPhase] = useState<'analyzing' | 'editing' | 'saving' | ''>('');
  const [cropSaveMenuOpen, setCropSaveMenuOpen] = useState(false);
  const cropSaveMenuRef = useRef<HTMLDivElement>(null);
  const cropConfirmRef = useRef<HTMLButtonElement>(null);
  const [imageCropError, setImageCropError] = useState('');
  // A restored main-process task must suppress the player on the very first
  // render; waiting for the synchronization effect would briefly reopen and
  // lock the source file on Windows before a replace commit.
  const trimBusy = Boolean(trimBusyMode || backgroundTrimTask);
  const componentPreview = useComponentPreview(previewContext, entry?.relativePath, entry?.kind === 'video' && !decoder && !videoPlaybackFailed && !trimBusy);
  useEffect(() => { if (componentPreview.seek) setVideoEditorSeek({ ...componentPreview.seek, id: Date.now() }); }, [componentPreview.seek]);
  const previewSnapshot = () => ({ path: entry?.path, imageZoom, imagePan, trimEditor, imageCropEditor, imageCropPhase, imageCropError, videoDuration });
  usePageTransferParticipant('previewEditor', {
    read: previewSnapshot,
    prepare: () => { if (trimBusy || imageCropPhase === 'analyzing' || imageCropPhase === 'saving') throw new Error('预览正在处理媒体，请等待完成后再移动标签页'); },
    write: value => {
      const saved = value as ReturnType<typeof previewSnapshot>;
      if (saved.path !== entry?.path) return;
      setImageZoom(saved.imageZoom); setImagePan(saved.imagePan); setTrimEditor(saved.trimEditor);
      setImageCropEditor(saved.imageCropEditor); setImageCropPhase(saved.imageCropPhase); setImageCropError(saved.imageCropError); setVideoDuration(saved.videoDuration);
    },
  });
  const imageSurfaceRef = useRef<HTMLDivElement>(null);
  const imageDragRef = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null);
  const previewResourcePathRef = useRef('');
  const fullscreenControlsTimerRef = useRef(0);
  const imageCropRequestRef = useRef(0);
  const trimOperationIdRef = useRef('');
  const restoredBackgroundTrimIdRef = useRef('');
  const trimProgressTimerRef = useRef(0);
  const editorSeekIdRef = useRef(0);
  const loadVideoTimelineFramesRef = useRef(onLoadVideoTimelineFrames);
  loadVideoTimelineFramesRef.current = onLoadVideoTimelineFrames;

  useEffect(() => {
    const unsubscribe = projectWorkspaceClient.onProjectVideoTrimProgress(progress => {
      if (!trimOperationIdRef.current || progress.operationId !== trimOperationIdRef.current) return;
      setTrimExportProgress(current => current?.phase === 'cancelling' && progress.phase !== 'cancelled' && progress.phase !== 'failed'
        ? current
        : { phase: progress.phase, progress: progress.progress, message: progress.message });
      if (progress.phase === 'complete' || progress.phase === 'cancelled' || progress.phase === 'failed') {
        window.clearTimeout(trimProgressTimerRef.current);
        trimOperationIdRef.current = '';
        setTrimProgressVisible(false);
        setTrimBusyMode('');
        if (progress.phase === 'complete') setTrimEditor(null);
      }
    });
    return () => {
      window.clearTimeout(trimProgressTimerRef.current);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const nextSourcePath = entry?.path || '';
    const sourceChanged = previewResourcePathRef.current !== nextSourcePath;
    previewResourcePathRef.current = nextSourcePath;
    if (sourceChanged) {
      setVideoPlaybackFailed(false);
      setVideoPlayerError('');
      setImageZoom(1);
      setImagePan({ x: 0, y: 0 });
      setImageNaturalSize({ width: 0, height: 0 });
      setImageDragging(false);
      setVideoDuration(0);
      setVideoPlaybackTime(0);
      setVideoEditorSeek(undefined);
      setVideoTrimFrames([]);
      setTrimEditor(null);
      imageCropRequestRef.current += 1;
      setImageCropEditor(null);
      setImageCropPhase('');
      setImageCropError('');
      imageDragRef.current = null;
    }
    const cachedPreviewUrl = entry ? findCachedMediaThumbnailPreview(entry.path, entry.updatedAt)?.url : undefined;
    setResource(current => entry
      ? current.sourcePath === entry.path
        // File details often hydrate just after selection. Keep an already
        // decoded original visible until its refreshed replacement is ready.
        ? { ...current, previewUrl: current.previewUrl || cachedPreviewUrl || entry.previewUrl }
        : { sourcePath: entry.path, previewUrl: cachedPreviewUrl || entry.previewUrl }
      : {});
    onTechnicalMetadata({});
    if (!entry || decoder) { setLoading(false); return () => { active = false; }; }
    const unsubscribe = projectWorkspaceClient.onThumbnailStateChanged(update => {
      if (update.filePath.toLocaleLowerCase() !== entry.path.toLocaleLowerCase()) return;
      if (update.state === 'STALE') {
        setLoading(true);
        return;
      }
      if (update.state === 'FAILED' || update.state === 'MISSING') {
        setLoading(false);
        onTechnicalMetadata({ unavailable: true });
        return;
      }
      if (update.state !== 'READY') return;
      const previewUrl = update.previewUrls?.large || update.previewUrls?.medium || update.previewUrls?.small;
      if (previewUrl) {
        rememberMediaThumbnailPreview(mediaThumbnailPreviewKey(entry.path, entry.updatedAt, 1600), previewUrl);
        setResource(current => current.sourcePath === entry.path ? { ...current, previewUrl } : current);
      }
      setLoading(false);
    });
    setLoading(true);
    requestThumbnail(() => projectWorkspaceClient.getMediaThumbnail(entry.path, entry.kind as 'image' | 'raw' | 'video', cacheConfig, 1600, 0, -1))
      .then(result => {
        if (!active) return;
        if (result.success) {
          if (result.previewUrl) rememberMediaThumbnailPreview(mediaThumbnailPreviewKey(entry.path, entry.updatedAt, 1600), result.previewUrl);
          setResource(current => current.sourcePath === entry.path ? { ...current, previewUrl: result.previewUrl || current.previewUrl || entry.previewUrl } : current);
          setLoading(result.state === 'QUEUED' || result.state === 'GENERATING' || result.state === 'NOT_READY' || result.state === 'STALE');
        } else {
          setLoading(false);
          onTechnicalMetadata({ unavailable: true });
        }
      })
      .catch(() => {
        if (!active) return;
        setLoading(false);
        onTechnicalMetadata({ unavailable: true });
      });
    return () => { active = false; unsubscribe(); void projectWorkspaceClient.cancelMediaThumbnail(entry.path, 1600); };
  }, [entry?.path, entry?.updatedAt, cacheConfig.directory, cacheConfig.maxSizeGB, decoder?.componentId, decoder?.id]);

  useEffect(() => {
    if (backgroundTrimTask) {
      const start = Math.max(0, Number(backgroundTrimTask.metadata?.start) || 0);
      const end = Math.max(start + .05, Number(backgroundTrimTask.metadata?.end) || start + .05);
      const sourceDuration = Math.max(end, Number(backgroundTrimTask.metadata?.sourceDuration) || end);
      const saveMode = backgroundTrimTask.metadata?.saveMode === 'replace' ? 'replace' : 'new';
      restoredBackgroundTrimIdRef.current = backgroundTrimTask.id;
      trimOperationIdRef.current = backgroundTrimTask.id;
      window.clearTimeout(trimProgressTimerRef.current);
      setVideoDuration(sourceDuration);
      setTrimEditor({ start, end });
      setTrimBusyMode(saveMode);
      setTrimProgressVisible(true);
      setTrimExportProgress({
        phase: String(backgroundTrimTask.metadata?.phase || (backgroundTrimTask.state === 'queued' ? 'preparing' : 'encoding')),
        progress: backgroundTrimTask.progress,
        message: backgroundTrimTask.message || (backgroundTrimTask.state === 'queued' ? '等待后台导出…' : '正在后台导出视频…'),
      });
      return;
    }
    const restoredOperationId = restoredBackgroundTrimIdRef.current;
    if (!restoredOperationId || trimOperationIdRef.current !== restoredOperationId) return;
    restoredBackgroundTrimIdRef.current = '';
    trimOperationIdRef.current = '';
    window.clearTimeout(trimProgressTimerRef.current);
    setTrimProgressVisible(false);
    setTrimExportProgress(undefined);
    setTrimBusyMode('');
  }, [backgroundTrimTask?.id, backgroundTrimTask?.state, backgroundTrimTask?.progress, backgroundTrimTask?.message, backgroundTrimTask?.metadata?.phase]);

  useEffect(() => {
    let active = true;
    let originalImage: HTMLImageElement | undefined;
    setOriginalLoading(false);
    setOriginalLoadError('');
    if (!entry || decoder || (entry.kind !== 'image' && entry.kind !== 'raw')) return () => { active = false; };

    // Avoid flashing the toast for images that are already in the OS/browser
    // cache, while keeping it visible for genuinely slow originals.
    const loadingTimer = window.setTimeout(() => {
      if (active) setOriginalLoading(true);
    }, 180);
    projectWorkspaceClient.getMediaOriginal(entry.path, entry.kind, cacheConfig).then(result => {
      if (!active) return;
      if (!result.success || !result.mediaUrl) {
        window.clearTimeout(loadingTimer);
        setOriginalLoading(false);
        setOriginalLoadError(result.error || '原图加载失败，当前显示预览图');
        console.warn('Original image preview failed', result.error || 'unknown error');
        projectWorkspaceClient.trackTelemetry('media_preview_failed', { media_kind: entry.kind, reason: 'missing_or_unavailable' });
        return;
      }
      originalImage = new Image();
      originalImage.onload = () => {
        if (!active) return;
        window.clearTimeout(loadingTimer);
        setImageNaturalSize({ width: originalImage?.naturalWidth || 0, height: originalImage?.naturalHeight || 0 });
        setResource(current => current.sourcePath === entry.path ? {
          ...current,
          originalUrl: result.mediaUrl,
          orientationMatrix: result.orientation?.matrix,
          orientationSwapsAxes: result.orientation?.swapsAxes
        } : current);
        setOriginalLoading(false);
        setOriginalLoadError('');
      };
      originalImage.onerror = () => {
        if (!active) return;
        window.clearTimeout(loadingTimer);
        setOriginalLoading(false);
        setOriginalLoadError('原图解码失败，当前显示预览图');
        console.warn('Original image decode failed');
        projectWorkspaceClient.trackTelemetry('media_preview_failed', { media_kind: entry.kind, reason: 'decode_failed' });
      };
      originalImage.src = result.mediaUrl;
    }).catch(error => {
      window.clearTimeout(loadingTimer);
      if (active) {
        setOriginalLoading(false);
        setOriginalLoadError('原图加载失败，当前显示预览图');
        console.warn('Original image preview request failed', error instanceof Error ? error.message : String(error));
        projectWorkspaceClient.trackTelemetry('media_preview_failed', { media_kind: entry.kind, reason: 'request_failed' });
      }
    });
    return () => {
      active = false;
      window.clearTimeout(loadingTimer);
      if (originalImage) {
        originalImage.onload = null;
        originalImage.onerror = null;
        originalImage.src = '';
      }
    };
  }, [entry?.path, entry?.kind, entry?.updatedAt, cacheConfig.directory, cacheConfig.maxSizeGB, decoder?.componentId, decoder?.id]);

  const displayedImageUrl = resource.originalUrl || resource.previewUrl;
  const imageOrientationMatrix = resource.originalUrl && resource.orientationMatrix?.length === 4 ? resource.orientationMatrix : [1, 0, 0, 1];
  const imageOrientationSwapsAxes = Boolean(resource.originalUrl && resource.orientationSwapsAxes);
  const imageOrientationKey = imageOrientationMatrix.join(',');

  useEffect(() => {
    if (!resource.originalUrl) return;
    // The thumbnail and corrected RAW preview can have different orientations.
    // Discard the old transform and remeasure the pane so the rotated image is
    // fitted from scratch instead of inheriting the landscape layout.
    setImageZoom(1);
    setImagePan({ x: 0, y: 0 });
    setImageDragging(false);
    imageDragRef.current = null;
    const surface = imageSurfaceRef.current;
    if (surface) setImageSurfaceSize({ width: surface.clientWidth, height: surface.clientHeight });
  }, [resource.originalUrl, imageOrientationKey]);

  useEffect(() => {
    const surface = imageSurfaceRef.current;
    if (!surface) return;
    const measure = () => setImageSurfaceSize({ width: surface.clientWidth, height: surface.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [displayedImageUrl, entry?.kind, fullscreen, Boolean(imageCropEditor)]);

  useEffect(() => {
    if (!fullscreen) return;
    setFullscreenControlsVisible(true);
    fullscreenControlsTimerRef.current = window.setTimeout(() => setFullscreenControlsVisible(false), FULLSCREEN_CONTROLS_HIDE_DELAY_MS);
    void projectWorkspaceClient.setWindowFullscreen(true);
    return () => {
      window.clearTimeout(fullscreenControlsTimerRef.current);
      void projectWorkspaceClient.setWindowFullscreen(false);
    };
  }, [fullscreen]);
  const revealFullscreenControls = () => {
    if (!fullscreen) return;
    setFullscreenControlsVisible(true);
    window.clearTimeout(fullscreenControlsTimerRef.current);
    fullscreenControlsTimerRef.current = window.setTimeout(() => setFullscreenControlsVisible(false), FULLSCREEN_CONTROLS_HIDE_DELAY_MS);
  };
  const cancelImageCrop = () => {
    if (imageCropPhase === 'saving') return;
    imageCropRequestRef.current += 1;
    setImageCropEditor(null);
    setImageCropPhase('');
    setImageCropError('');
  };
  useEscapeLayer(fullscreen, () => setFullscreen(false));
  useEscapeLayer(Boolean(trimEditor), () => { if (!trimBusy) setTrimEditor(null); }, !trimBusy);
  useEscapeLayer(Boolean(imageCropPhase), cancelImageCrop, imageCropPhase !== 'saving');
  useEscapeLayer(cropSaveMenuOpen, () => { setCropSaveMenuOpen(false); cropConfirmRef.current?.focus(); });
  useEffect(() => { setCropSaveMenuOpen(false); }, [entry?.path, imageCropPhase]);
  useEffect(() => {
    if (!cropSaveMenuOpen) return;
    cropSaveMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!cropSaveMenuRef.current?.contains(event.target as Node)) setCropSaveMenuOpen(false);
    };
    window.addEventListener('pointerdown', dismiss, true);
    return () => window.removeEventListener('pointerdown', dismiss, true);
  }, [cropSaveMenuOpen]);

  // Fit against the full preview viewport. The previous 12px inset on every
  // side became especially visible after a portrait RAW was rotated.
  const availableImageWidth = Math.max(1, imageSurfaceSize.width);
  const availableImageHeight = Math.max(1, imageSurfaceSize.height);
  const orientedNaturalSize = {
    width: Math.abs(imageOrientationMatrix[0]) * imageNaturalSize.width + Math.abs(imageOrientationMatrix[2]) * imageNaturalSize.height,
    height: Math.abs(imageOrientationMatrix[1]) * imageNaturalSize.width + Math.abs(imageOrientationMatrix[3]) * imageNaturalSize.height
  };
  const fittedImageScale = imageNaturalSize.width && imageNaturalSize.height
    ? Math.min(availableImageWidth / orientedNaturalSize.width, availableImageHeight / orientedNaturalSize.height)
    : 0;
  const fittedImageElementSize = {
    width: imageNaturalSize.width * fittedImageScale,
    height: imageNaturalSize.height * fittedImageScale
  };
  const fittedImageSize = {
    width: orientedNaturalSize.width * fittedImageScale,
    height: orientedNaturalSize.height * fittedImageScale
  };
  const clampImagePan = (pan: { x: number; y: number }, zoom: number) => {
    // Once an axis fills the viewport, disallow movement far enough to reveal
    // extra blank space. A letterboxed axis remains centered.
    const maximumX = Math.max(0, (fittedImageSize.width * zoom - imageSurfaceSize.width) / 2);
    const maximumY = Math.max(0, (fittedImageSize.height * zoom - imageSurfaceSize.height) / 2);
    return {
      x: clampNumber(pan.x, -maximumX, maximumX),
      y: clampNumber(pan.y, -maximumY, maximumY)
    };
  };

  useEffect(() => {
    setImagePan(current => {
      const next = clampImagePan(current, imageZoom);
      return next.x === current.x && next.y === current.y ? current : next;
    });
  }, [imageSurfaceSize.width, imageSurfaceSize.height, fittedImageSize.width, fittedImageSize.height, imageZoom]);

  const zoomImage = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const surface = event.currentTarget;
    const rect = surface.getBoundingClientRect();
    const pointerX = event.clientX - rect.left - rect.width / 2;
    const pointerY = event.clientY - rect.top - rect.height / 2;
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    // There is intentionally no upper zoom limit. The lower bound preserves
    // the existing "fit to pane" behaviour when scrolling out.
    const nextZoom = Math.max(1, imageZoom * factor);
    if (nextZoom === imageZoom) return;
    const currentHalfWidth = fittedImageSize.width * imageZoom / 2;
    const currentHalfHeight = fittedImageSize.height * imageZoom / 2;
    // If the cursor is over letterbox space, anchor to the nearest image edge
    // instead of treating the empty pane as part of the image.
    const anchorX = clampNumber(pointerX, imagePan.x - currentHalfWidth, imagePan.x + currentHalfWidth);
    const anchorY = clampNumber(pointerY, imagePan.y - currentHalfHeight, imagePan.y + currentHalfHeight);
    const ratio = nextZoom / imageZoom;
    const nextPan = clampImagePan({
      x: anchorX - (anchorX - imagePan.x) * ratio,
      y: anchorY - (anchorY - imagePan.y) * ratio
    }, nextZoom);
    setImagePan(nextPan);
    setImageZoom(nextZoom);
  };
  const resetImageZoom = () => {
    setImageZoom(1);
    setImagePan({ x: 0, y: 0 });
    setImageDragging(false);
    imageDragRef.current = null;
  };
  const beginImagePan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || imageZoom <= 1) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    imageDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: imagePan.x,
      panY: imagePan.y
    };
    setImageDragging(true);
  };
  const moveImagePan = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = imageDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    setImagePan(clampImagePan({
      x: drag.panX + event.clientX - drag.startX,
      y: drag.panY + event.clientY - drag.startY
    }, imageZoom));
  };
  const finishImagePan = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = imageDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    imageDragRef.current = null;
    setImageDragging(false);
  };
  const beginImageCrop = async () => {
    if (!entry || entry.kind !== 'image' || isUnsupportedShortcutContent(entry) || imageCropPhase) return;
    const requestId = imageCropRequestRef.current + 1;
    imageCropRequestRef.current = requestId;
    setImageCropError('');
    setImageCropEditor(null);
    setImageCropPhase('analyzing');
    const result = await onAnalyzeImageCrop(entry);
    if (imageCropRequestRef.current !== requestId) return;
    if (!result.success || !result.crop || !result.originalSize) {
      setImageCropPhase('');
      setImageCropError(result.error || '无法识别图片边缘');
      return;
    }
    setImageCropEditor({
      crop: result.crop,
      originalSize: result.originalSize,
      snapGuides: result.snapGuides || { x: [0, result.originalSize.width], y: [0, result.originalSize.height] }
    });
    setImageCropPhase('editing');
  };
  const confirmImageCrop = async (saveMode: 'replace' | 'new') => {
    if (!entry || !imageCropEditor || imageCropPhase !== 'editing') return;
    setCropSaveMenuOpen(false);
    const requestId = imageCropRequestRef.current;
    const { originalSize } = imageCropEditor;
    const x = Math.max(0, Math.min(originalSize.width - 20, Math.round(imageCropEditor.crop.x)));
    const y = Math.max(0, Math.min(originalSize.height - 20, Math.round(imageCropEditor.crop.y)));
    const crop = {
      x,
      y,
      width: Math.max(20, Math.min(originalSize.width - x, Math.round(imageCropEditor.crop.width))),
      height: Math.max(20, Math.min(originalSize.height - y, Math.round(imageCropEditor.crop.height)))
    };
    setImageCropError('');
    setImageCropPhase('saving');
    const result = await onConfirmImageCrop(entry, crop, saveMode);
    if (imageCropRequestRef.current !== requestId) return;
    if (result.success) {
      setImageCropEditor(null);
      setImageCropPhase('');
      return;
    }
    setImageCropPhase('editing');
    setImageCropError(result.error || '裁剪失败');
  };
  const handleVideoPlayerError = (message: string) => {
    setVideoPlaybackFailed(true);
    setVideoPlayerError(message);
    setLoading(false);
    projectWorkspaceClient.trackTelemetry('media_preview_failed', { media_kind: 'video', reason: 'video_player_failed' });
  };
  const previewVideoTrimTime = (requestedTime: number) => {
    const time = Math.max(0, Math.min(videoDuration, requestedTime));
    setVideoPlaybackTime(time);
    editorSeekIdRef.current += 1;
    setVideoEditorSeek({ id: editorSeekIdRef.current, time, pause: true });
  };
  const changeVideoTrimEdge = (edge: 'start' | 'end', requestedTime: number) => {
    if (!trimEditor || trimBusy) return;
    const time = edge === 'start'
      ? Math.max(0, Math.min(trimEditor.end - .05, requestedTime))
      : Math.min(videoDuration, Math.max(trimEditor.start + .05, requestedTime));
    setTrimEditor(current => current ? { ...current, [edge]: time } : current);
    previewVideoTrimTime(time);
  };
  const openVideoTrim = () => {
    if (!videoDuration) return;
    // Playback commonly reaches the end before the user opens the editor. Using
    // that position as the trim start leaves an almost empty selection and makes
    // both export buttons appear broken. Always open with the complete clip
    // selected; the user can then move either edge deliberately.
    setTrimEditor({ start: 0, end: videoDuration });
    previewVideoTrimTime(0);
  };
  const confirmVideoTrim = async (saveMode: 'new' | 'replace') => {
    if (!trimEditor || trimBusy || trimEditor.end - trimEditor.start < .05) return;
    const operationId = crypto.randomUUID();
    trimOperationIdRef.current = operationId;
    setTrimExportProgress({ phase: 'preparing', progress: 0, message: t("ui.preparing.video.e5ca0c") });
    setTrimProgressVisible(false);
    window.clearTimeout(trimProgressTimerRef.current);
    trimProgressTimerRef.current = window.setTimeout(() => {
      if (trimOperationIdRef.current === operationId) setTrimProgressVisible(true);
    }, 500);
    setTrimBusyMode(saveMode);
    let startedInBackground = false;
    try {
      // Unmount the active video backend before replacing the source so Windows
      // does not keep the original file locked while the atomic rename runs.
      await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
      const result = await onTrimVideo(trimEditor.start, trimEditor.end, saveMode, operationId, videoDuration);
      startedInBackground = Boolean(result.success && result.started);
      if (result.success && !startedInBackground) setTrimEditor(null);
    } finally {
      if (!startedInBackground) {
        window.clearTimeout(trimProgressTimerRef.current);
        trimOperationIdRef.current = '';
        setTrimProgressVisible(false);
        setTrimExportProgress(undefined);
        setTrimBusyMode('');
      }
    }
  };
  const cancelVideoTrim = () => {
    if (!trimBusy) {
      setTrimEditor(null);
      return;
    }
    const operationId = trimOperationIdRef.current;
    if (!operationId || trimExportProgress?.phase === 'cancelling') return;
    setTrimProgressVisible(true);
    setTrimExportProgress(current => ({ phase: 'cancelling', progress: current?.progress || 0, message: t("ui.cancelling.export.45536a") }));
    void projectWorkspaceClient.cancelProjectVideoTrim(operationId);
  };
  const useVideoPlayer = Boolean(entry && entry.kind === 'video' && !decoder && !videoPlaybackFailed);
  // Frame extraction opens a second hidden video element. Stop it together
  // with the visible player so Windows can release the source before replace.
  const trimEditing = Boolean(trimEditor) && !trimBusy;

  useEffect(() => {
    let active = true;
    setVideoTrimFrames([]);
    if (!trimEditing || !videoDuration) return () => { active = false; };
    const times = Array.from({ length: 8 }, (_, index) => Math.min(videoDuration - .01, videoDuration * (index + .5) / 8));
    void loadVideoTimelineFramesRef.current(times).then(result => {
      if (active && result.success && result.frames?.length) setVideoTrimFrames(result.frames);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [trimEditing, videoDuration, entry?.path]);

  const videoTrimControls = trimEditor ? <VideoTrimTimeline
    duration={videoDuration}
    start={trimEditor.start}
    end={trimEditor.end}
    currentTime={videoPlaybackTime}
    frames={videoTrimFrames}
    exportMode={videoTrimExportMode}
    busyMode={trimBusyMode}
    exportProgress={trimExportProgress}
    progressVisible={trimProgressVisible}
    onChange={changeVideoTrimEdge}
    onPreview={previewVideoTrimTime}
    onCancel={cancelVideoTrim}
    onSave={mode => void confirmVideoTrim(mode)}
  /> : undefined;

  const previewPane = <section data-workspace-panel={fullscreen ? undefined : "preview"} onContextMenu={onContextMenu} onMouseMove={revealFullscreenControls} style={fullscreen ? undefined : { width, order: panelOrder }} className={`flex min-h-0 shrink-0 flex-col ${fullscreen ? 'media-preview-fullscreen fixed inset-0 z-[500] h-screen w-screen bg-black' : 'bg-slate-50'}`}>
    {!fullscreen && <WorkspacePanelHeader id="preview" label={t("ui.preview.13d61f")} title={imageCropPhase ? t("ui.crop.184506") : trimEditor ? t("ui.trim.6d997b") : t("ui.preview.13d61f")} subtitle={entry?.name || t("ui.no.media.selected.c06514")} pinned={pinned} onTogglePinned={onTogglePinned} onClose={onClose} showButtons={!imageCropPhase && !trimEditor}>
      {imageCropPhase ? <div className="ml-2 flex shrink-0 items-center gap-2">
        <button type="button" disabled={imageCropPhase === 'saving'} onClick={cancelImageCrop} className="rounded-md px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40">{t("common.cancel")}</button>
        <div ref={cropSaveMenuRef} className="relative" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setCropSaveMenuOpen(false); }}>
        <button ref={cropConfirmRef} type="button" disabled={imageCropPhase !== 'editing'} aria-haspopup="menu" aria-expanded={cropSaveMenuOpen} onClick={() => setCropSaveMenuOpen(current => !current)} className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-bold text-white shadow-sm hover:bg-blue-500 disabled:bg-blue-400">
          {(imageCropPhase === 'analyzing' || imageCropPhase === 'saving') && <Loader2 size={13} className="animate-spin"/>}
          {imageCropPhase === 'analyzing' ? t("ui.detecting.edges.555914") : imageCropPhase === 'saving' ? t("ui.cropping.b05718") : t("ui.confirm.crop.7fed57")}
        </button>
        {cropSaveMenuOpen && <div role="menu" aria-label={t("ui.save.cropped.image.097aff")} className="project-context-menu absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-slate-200 bg-white p-1 shadow-xl" onKeyDown={event => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
          items[next]?.focus();
        }}>
          <button type="button" role="menuitem" className="project-menu-item w-full" onClick={() => void confirmImageCrop('replace')}>{t("ui.save.a3030b")}<span className="ml-auto text-xs text-slate-400">{t("ui.replace.original.db326e")}</span></button>
          <button type="button" role="menuitem" className="project-menu-item w-full" onClick={() => void confirmImageCrop('new')}>{t("ui.save.as.1232eb")}<span className="ml-auto text-xs text-slate-400">{t("ui.keep.originals.f89e75")}</span></button>
        </div>}
        </div>
      </div> : trimEditor ? <button type="button" disabled={trimExportProgress?.phase === 'cancelling'} onClick={cancelVideoTrim} className="rounded-md px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40">{trimBusy ? trimExportProgress?.phase === 'cancelling' ? t("ui.cancelling.e8e08b") : t("ui.cancel.export.7eefaa") : t("ui.cancel.trim.36a523")}</button> : <div className="flex items-center gap-1">{entry && <><button type="button" onClick={() => setFullscreen(true)} title={t("ui.view.full.screen.11423a")} aria-label={t("ui.view.full.screen.11423a")} className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><Maximize2 size={16}/></button>{(entry.kind === 'image' || entry.kind === 'raw') && <button type="button" disabled={!selectionAvailable || selectionBusy} onClick={onSelectImage} title={t("ui.add.current.image.to.selection.d03517")} aria-label={t("ui.select.current.image.3b84d8")} className="shrink-0 rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40">{selectionBusy ? <Loader2 size={16} className="animate-spin"/> : <CheckCircle2 size={16}/>}</button>}{ratingAvailable && (ratingMode === 'stars' ? <div className="flex items-center" aria-label={t("ui.image.rating.value0.stars.f218de", { value0: rating })}>{[1, 2, 3, 4, 5].map(star => <button key={star} type="button" disabled={ratingLoading || ratingBusy} onClick={() => onChangeRating(rating === star ? 0 : star)} title={rating === star ? t("ui.clear.value0.star.rating.7d2fdc", { value0: star }) : t("ui.set.rating.to.value0.stars.8ef056", { value0: star })} aria-label={rating === star ? t("ui.clear.value0.star.rating.7d2fdc", { value0: star }) : t("ui.set.rating.to.value0.stars.8ef056", { value0: star })} className={`rounded p-1 transition hover:bg-amber-50 hover:text-amber-500 disabled:opacity-40 ${rating >= star ? 'text-amber-400' : 'text-slate-300'}`}><Star size={15} fill={rating >= star ? 'currentColor' : 'none'}/></button>)}</div> : <button type="button" disabled={ratingLoading || ratingBusy} onClick={() => onChangeRating(rating > 0 ? 0 : 5)} title={rating > 0 ? t("ui.unlike.currently.value0.stars.c1b9cd", { value0: rating }) : ratingLoading ? t("ui.loading.image.rating.05a86a") : t("ui.like.writes.five.stars.0b0a9a")} aria-label={rating > 0 ? t("ui.unlike.0c66f5") : t("ui.mark.as.liked.be59ef")} className={`rounded-md p-2 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-40 ${rating > 0 ? 'text-red-500' : 'text-slate-500'}`}><Heart size={16} fill={rating > 0 ? 'currentColor' : 'none'}/></button>)}{photoshopAvailable && (entry.kind === 'image' || entry.kind === 'raw') && <button type="button" onClick={onOpenInPhotoshop} title={t("ui.open.in.photoshop.391462")} aria-label={t("ui.open.in.photoshop.391462")} className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><PhotoshopIcon size={16}/></button>}{(!decoder && (entry.kind !== 'video' || videoTrimAvailable)) && <button type="button" disabled={entry.kind === 'raw' || isUnsupportedShortcutContent(entry) || entry.kind === 'video' && !videoDuration} onClick={entry.kind === 'video' ? openVideoTrim : () => void beginImageCrop()} title={entry.kind === 'video' ? videoDuration ? t("ui.trim.video.value0.5432b6", { value0: videoTrimExportMode === 'fast' ? t("ui.fast.export.4425aa") : t("ui.precise.export.eec2f3") }) : t("ui.loading.video.duration.6ccf5e") : entry.kind === 'raw' ? t("ui.direct.raw.cropping.is.not.supported.e91723") : t("ui.crop.image.detect.and.snap.to.d2c612")} aria-label={entry.kind === 'video' ? t("ui.trim.video.a4a301") : t("ui.crop.image.cf301e")} className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-35"><Crop size={16}/></button>}</>}</div>}
    </WorkspacePanelHeader>}
    {fullscreen && fullscreenControlsVisible && <button type="button" onClick={() => setFullscreen(false)} title={t("ui.exit.full.screen.esc.218e2c")} aria-label={t("ui.exit.full.screen.0f1505")} className="fixed right-5 top-5 z-[520] rounded-full bg-black/60 p-2.5 text-white shadow-lg backdrop-blur transition hover:bg-black/80"><X size={20}/></button>}
    <div className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden ${fullscreen ? 'bg-black' : 'bg-slate-50'}`}>
      {entry && decoder && previewContext && <ComponentDecodedPreview key={`${entry.relativePath}:${entry.updatedAt}:${decoder.componentId}:${decoder.id}`} context={previewContext} relativePath={entry.relativePath} decoder={decoder} onOpen={onOpen}/>}
      {!entry && <div className="max-w-[220px] text-center"><ImageIcon size={38} strokeWidth={1.4} className="mx-auto text-slate-600"/><p className="mt-3 text-sm font-medium text-slate-300">{t("ui.click.an.image.raw.file.or.526e0d")}</p><p className="mt-1 text-xs leading-5 text-slate-500">{t("ui.image.or.video.previews.appear.here.4da6bc")}</p></div>}
      {entry && entry.kind === 'video' && trimBusy && <div className="absolute inset-0 flex min-h-0 flex-col bg-black"><div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">{resource.previewUrl ? <img src={resource.previewUrl} alt="" draggable={false} className="max-h-full max-w-full object-contain opacity-70"/> : <Video size={52} strokeWidth={1.3} className="text-slate-700"/>}</div>{videoTrimControls}</div>}
      {useVideoPlayer && entry && !trimBusy && <VideoPlayer filePath={entry.path} poster={resource.previewUrl} keyboardSettings={keyboardSettings} bottomControls={trimEditor ? videoTrimControls : undefined} controlsVisible={!fullscreen || fullscreenControlsVisible} controlsOverlay={fullscreen} editorSeekRequest={videoEditorSeek} onPlaybackState={playback => { setVideoPlaybackTime(playback.time); componentPreview.onPlaybackState(playback); }} onError={handleVideoPlayerError} onMetadata={metadata => { setLoading(false); setVideoDuration(Number(metadata.duration) || 0); onTechnicalMetadata(metadata); }} onNavigate={onNavigate} onContextMenuAt={onContextMenuAt} onPointerActivity={revealFullscreenControls} topRightOverlayHole={fullscreen && fullscreenControlsVisible ? 60 : 0} onEscape={() => setFullscreen(false)} onToggleFullscreen={() => setFullscreen(current => !current)}/>}
      {entry && entry.kind === 'video' && videoPlaybackFailed && !trimBusy && <div role="alert" className="flex max-h-full w-full flex-col items-center justify-center gap-4 text-center">{resource.previewUrl ? <img src={resource.previewUrl} alt={entry.name} draggable={false} className="max-h-[70%] max-w-full object-contain opacity-60"/> : <Video size={52} strokeWidth={1.3} className="text-slate-600"/>}<div className="max-w-sm px-6"><p className="text-sm font-bold text-red-600">{t("ui.could.not.start.video.player.171295")}</p><p className="mt-1 text-xs leading-5 text-slate-500">{videoPlayerError || t("ui.neither.chromium.nor.the.advanced.decoder.8407b0")}</p><button type="button" onClick={onOpen} className="mt-3 inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-500"><ExternalLink size={14}/>{t("ui.open.with.system.player.884f58")}</button></div></div>}
      {entry && !decoder && entry.kind === 'image' && displayedImageUrl && imageCropEditor && <div className="absolute inset-0 bg-slate-950">
        <InteractiveCropEditor embedded snapEnabled snapGuides={imageCropEditor.snapGuides} previewUrl={displayedImageUrl} imageSize={imageCropEditor.originalSize} crop={imageCropEditor.crop} onChange={crop => { if (imageCropPhase === 'editing') setImageCropEditor(current => current ? { ...current, crop } : current); }}/>
        <span className="pointer-events-none absolute bottom-4 left-4 rounded-md bg-slate-950/80 px-2.5 py-1.5 text-[11px] font-bold text-cyan-200 shadow-lg">{t("ui.edge.snapping.enabled.934826")}</span>
      </div>}
      {entry && !decoder && entry.kind !== 'video' && displayedImageUrl && !imageCropEditor && (
        <div ref={imageSurfaceRef} onWheel={zoomImage} onDoubleClick={resetImageZoom} onPointerDown={beginImagePan} onPointerMove={moveImagePan} onPointerUp={finishImagePan} onPointerCancel={finishImagePan} style={{ touchAction: 'none' }} className={`absolute inset-0 overflow-hidden ${imageZoom > 1 ? imageDragging ? 'cursor-grabbing' : 'cursor-grab' : ''}`}>
          <div
            style={{
              // Rasterize the image at the requested zoom size. Scaling the
              // fitted wrapper with CSS transform made Chromium enlarge its
              // low-resolution compositor texture, so a full-resolution image
              // still looked like a thumbnail when zoomed in.
              width: fittedImageSize.width ? fittedImageSize.width * imageZoom : '100%',
              height: fittedImageSize.height ? fittedImageSize.height * imageZoom : '100%',
              transform: `translate(-50%, -50%) translate3d(${imagePan.x}px, ${imagePan.y}px, 0)`,
              transformOrigin: 'center',
              willChange: imageDragging ? 'transform' : undefined
            }}
            className="pointer-events-none absolute left-1/2 top-1/2"
          >
            <img
              src={displayedImageUrl}
              alt={entry.name}
              draggable={false}
              style={{
                width: fittedImageElementSize.width ? fittedImageElementSize.width * imageZoom : undefined,
                height: fittedImageElementSize.height ? fittedImageElementSize.height * imageZoom : undefined,
                // Tailwind Preflight applies max-width:100% to every image.
                // A portrait RAW is laid out landscape inside a narrower,
                // already-rotated wrapper, so that global rule would shrink it
                // a second time unless it is explicitly disabled here.
                maxWidth: fittedImageElementSize.width ? 'none' : '100%',
                maxHeight: fittedImageElementSize.height ? 'none' : '100%',
                transform: `translate(-50%, -50%) matrix(${imageOrientationMatrix.join(',')}, 0, 0)`,
                transformOrigin: 'center'
              }}
              className="pointer-events-none absolute left-1/2 top-1/2 select-none object-contain"
              onLoad={event => {
                const sourceSize = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight };
                const naturalSize = imageOrientationSwapsAxes ? { width: sourceSize.height, height: sourceSize.width } : sourceSize;
                setImageNaturalSize(sourceSize);
                onTechnicalMetadata(naturalSize);
              }}
              onError={() => onTechnicalMetadata({ unavailable: true })}
            />
          </div>
        </div>
      )}
      {entry && !decoder && entry.kind !== 'video' && displayedImageUrl && !imageCropPhase && <button type="button" onClick={resetImageZoom} title={t("ui.fit.to.window.521c41")} className="absolute bottom-4 right-4 rounded-md bg-slate-900/75 px-2 py-1 font-mono text-[11px] text-slate-200 shadow-lg">{Math.round(imageZoom * 100)}%</button>}
      {entry && !decoder && entry.kind !== 'video' && !displayedImageUrl && !loading && <div className="text-center"><FileImage size={48} strokeWidth={1.3} className="mx-auto text-slate-600"/><p className="mt-3 text-sm text-slate-400">{t("ui.could.not.generate.a.preview.for.a26498")}</p><button type="button" onClick={onOpen} className="mt-3 inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-500"><ExternalLink size={14}/>{t("ui.open.externally.5a006a")}</button></div>}
      {entry && loading && <span className="absolute right-4 top-4 rounded-full bg-slate-900/80 p-2 text-slate-300"><Loader2 size={17} className="animate-spin"/></span>}
      {imageCropPhase === 'analyzing' && <div role="status" className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/35"><span className="inline-flex items-center gap-2 rounded-lg bg-slate-950/85 px-3 py-2 text-xs font-bold text-white shadow-xl"><Loader2 size={15} className="animate-spin text-cyan-300"/>{t("ui.detecting.edges.555914")}</span></div>}
      {imageCropPhase === 'saving' && <div role="status" className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/35"><span className="inline-flex items-center gap-2 rounded-lg bg-slate-950/85 px-3 py-2 text-xs font-bold text-white shadow-xl"><Loader2 size={15} className="animate-spin text-blue-300"/>{t("ui.generating.cropped.image.ac61fb")}</span></div>}
      {imageCropError && <div role="alert" className="absolute bottom-4 left-1/2 z-30 max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-lg bg-red-950/90 px-3 py-2 text-xs text-red-100 shadow-xl" title={imageCropError}><LocalizedText value={imageCropError}/></div>}
      {originalLoading && <div role="status" className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-lg bg-slate-900/85 px-3 py-2 text-xs font-bold text-white shadow-xl"><Loader2 size={15} className="animate-spin text-blue-300"/><span>{t("ui.loading.original.image.3ed618")}</span></div>}
      {!originalLoading && originalLoadError && displayedImageUrl && <div role="status" className="absolute bottom-4 left-1/2 z-20 max-w-[calc(100%-2rem)] -translate-x-1/2 truncate rounded-lg bg-slate-900/85 px-3 py-2 text-xs text-amber-200 shadow-xl" title={originalLoadError}><LocalizedText value={originalLoadError}/></div>}
    </div>
  </section>;
  return fullscreen ? createPortal(previewPane, document.body) : previewPane;
};
