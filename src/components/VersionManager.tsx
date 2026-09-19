import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useScopedPageState, useRestoreScopedPageState, usePageTransferParticipant } from '../platform/page-transfer-state';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  ExternalLink,
  FolderSearch,
  GitBranch,
  Image as ImageIcon,
  Loader2,
  MoreHorizontal,
  Maximize2,
  Minimize2,
  Trash2,
  X,
} from 'lucide-react';
import type { AppConfig, MediaMetadataField, MediaVersion, MediaVersionBundle, ProjectFileEntry, TrackedPhoto, WorkspaceProject } from '../types';
import { useAppDialog } from './AppDialogProvider';
import { useEscapeLayer } from './LayerProvider';
import { RECYCLE_BIN_FAILURE_DIALOG } from '../utils/recycleBinFailure';
import { VideoPlayer } from './AdvancedVideoPlayer';
import { metadataFieldLabel, metadataGroupLabel } from '../features/metadata/metadata-labels';
import { MAIN_BRANCH_PHOTO_PAGE_SIZE, mainBranchPhotoSummaries, mainBranchVersionsForPhoto, paginateMainBranchPhotos, versioningMediaKind, type MainBranchPhotoSummary } from '../features/versioning/public';
import { ImageComparisonView, type ImageComparisonMode } from './ImageComparisonView';

type VersionManagerProps = {
  active?: boolean;
  entry: ProjectFileEntry;
  workspacePath: string;
  project: WorkspaceProject;
  cacheConfig: AppConfig['mediaCache'];
  videoPlaybackSettings: AppConfig['videoPlayback'];
  onClose: () => void;
  onNotice: (message: string) => void;
  onVersionStateChanged?: () => void;
  progressVersionKey?: string;
  progressId?: string;
  initialCompareIds?: string[];
  initialCompareMode?: 'side-by-side' | 'split' | 'overlay' | 'blink' | 'difference';
};

const ResizeHandle = ({ orientation, label, value, min, max, onDrag, onReset }: {
  orientation: 'vertical' | 'horizontal';
  label: string;
  value: number;
  min: number;
  max: number;
  onDrag: (delta: number) => void;
  onReset: () => void;
}) => {
  const cleanupDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupDragRef.current?.(), []);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    cleanupDragRef.current?.();
    let previousPosition = orientation === 'vertical' ? event.clientX : event.clientY;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    const move = (moveEvent: PointerEvent) => {
      const position = orientation === 'vertical' ? moveEvent.clientX : moveEvent.clientY;
      onDrag(position - previousPosition);
      previousPosition = position;
    };
    const finish = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      cleanupDragRef.current = null;
    };
    cleanupDragRef.current = finish;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const negativeKey = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    const positiveKey = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    if (event.key !== negativeKey && event.key !== positiveKey) return;
    event.preventDefault();
    onDrag(event.key === negativeKey ? -20 : 20);
  };
  return <div
    role="separator"
    aria-label={label}
    aria-orientation={orientation}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={Math.round(value)}
    tabIndex={0}
    title={orientation === 'vertical' ? '左右拖动调整宽度，双击恢复默认' : '上下拖动调整高度，双击恢复默认'}
    onDoubleClick={onReset}
    onPointerDown={onPointerDown}
    onKeyDown={onKeyDown}
    className={orientation === 'vertical' ? 'column-resize-handle' : 'row-resize-handle'}
  />;
};

const formatSize = (size: number) => size < 1024 * 1024
  ? `${Math.max(1, Math.round(size / 1024))} KB`
  : size < 1024 * 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)} MB`
    : `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
const visibleVersionName = (version: Pick<MediaVersion, 'versionName'>) => version.versionName.replace(/^R\d+\s*·\s*/i, '');
const visibleVersionNote = (note: string) => note.replace(/返修批次 R\d+/gi, '进度版本');
const visibleVersionLabel = (version: Pick<MediaVersion, 'versionNumber' | 'displayVersionKey'>) => `V${version.displayVersionKey || version.versionNumber}`;
const normalizeVisibleVersionBundle = (bundle: MediaVersionBundle, entryPath = '', progressVersionKey = ''): MediaVersionBundle => ({
  ...bundle,
  versions: bundle.versions.map(version => ({
    ...version,
    displayVersionKey: progressVersionKey && version.filePath.replace(/\\/g, '/').toLocaleLowerCase() === entryPath.replace(/\\/g, '/').toLocaleLowerCase()
      ? progressVersionKey
      : version.displayVersionKey,
    versionName: visibleVersionName(version),
    note: visibleVersionNote(version.note),
  })),
});

const mediaKind = versioningMediaKind;

type VersionResourceData = {
  url?: string;
  orientationMatrix?: number[];
  orientationSwapsAxes?: boolean;
};
const versionResourceCache = new Map<string, VersionResourceData>();
const versionResourceRequests = new Map<string, Promise<VersionResourceData>>();
type VersionResourceQuality = 'thumbnail' | 'full';
const versionResourceCacheKey = (version: MediaVersion, quality: VersionResourceQuality) => `${version.filePath.replace(/\\/g, '/').toLocaleLowerCase()}|${version.fileModifiedAt || 0}|${version.fileSize}|${quality}`;
const loadVersionResource = (version: MediaVersion, cacheConfig: AppConfig['mediaCache'], quality: VersionResourceQuality) => {
  const key = versionResourceCacheKey(version, quality);
  const cached = versionResourceCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = versionResourceRequests.get(key);
  if (pending) return pending;
  const kind = mediaKind(version.filePath);
  const request = (quality === 'thumbnail'
    ? window.electronAPI.getMediaThumbnail(version.filePath, kind, cacheConfig, 1600, 0, -1)
    : kind === 'raw'
      ? window.electronAPI.getMediaOriginal(version.filePath, kind, cacheConfig).then(result => ({
        success: result.success,
        previewUrl: result.mediaUrl,
        orientation: result.orientation,
        error: result.error,
      }))
      : window.electronAPI.getMediaThumbnail(version.filePath, kind, cacheConfig, 1600, 0, -1)
  ).then(async result => {
    if (!result.success) return {};
    let url = result.previewUrl;
    let orientationMatrix = 'orientation' in result ? result.orientation?.matrix : undefined;
    let orientationSwapsAxes = 'orientation' in result ? result.orientation?.swapsAxes : undefined;
    if (kind === 'image' && quality === 'full') {
      const original = await window.electronAPI.getMediaOriginal(version.filePath, kind, cacheConfig);
      if (original.success && original.mediaUrl) {
        url = original.mediaUrl;
        orientationMatrix = original.orientation?.matrix;
        orientationSwapsAxes = original.orientation?.swapsAxes;
      }
    }
    const resource = { url, orientationMatrix, orientationSwapsAxes };
    if (versionResourceCache.size >= 80) versionResourceCache.delete(versionResourceCache.keys().next().value as string);
    versionResourceCache.set(key, resource);
    return resource;
  }).catch(() => ({})).finally(() => versionResourceRequests.delete(key));
  versionResourceRequests.set(key, request);
  return request;
};

const OrientedVersionImage = ({ src, alt, orientationMatrix, contentStyle }: {
  src: string;
  alt: string;
  orientationMatrix?: number[];
  contentStyle?: React.CSSProperties;
}) => {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const matrix = orientationMatrix?.length === 4 ? orientationMatrix : [1, 0, 0, 1];
  const matrixKey = matrix.join(',');

  useEffect(() => {
    setNaturalSize({ width: 0, height: 0 });
  }, [src, matrixKey]);
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const measure = () => setSurfaceSize({ width: surface.clientWidth, height: surface.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  const orientedSize = {
    width: Math.abs(matrix[0]) * naturalSize.width + Math.abs(matrix[2]) * naturalSize.height,
    height: Math.abs(matrix[1]) * naturalSize.width + Math.abs(matrix[3]) * naturalSize.height,
  };
  const fittedScale = orientedSize.width && orientedSize.height
    ? Math.min(surfaceSize.width / orientedSize.width, surfaceSize.height / orientedSize.height)
    : 0;
  const fittedElementSize = {
    width: naturalSize.width * fittedScale,
    height: naturalSize.height * fittedScale,
  };
  const fittedOrientedSize = {
    width: orientedSize.width * fittedScale,
    height: orientedSize.height * fittedScale,
  };

  return <div ref={surfaceRef} className="absolute inset-0" style={contentStyle}>
    <div
      className="pointer-events-none absolute left-1/2 top-1/2"
      style={{
        width: fittedOrientedSize.width || '100%',
        height: fittedOrientedSize.height || '100%',
        transform: 'translate(-50%, -50%)',
      }}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        onLoad={event => setNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        className="pointer-events-none absolute left-1/2 top-1/2 select-none object-contain"
        style={{
          width: fittedElementSize.width || '100%',
          height: fittedElementSize.height || '100%',
          maxWidth: fittedElementSize.width ? 'none' : '100%',
          maxHeight: fittedElementSize.height ? 'none' : '100%',
          transform: `translate(-50%, -50%) matrix(${matrixKey}, 0, 0)`,
          transformOrigin: 'center',
        }}
      />
    </div>
  </div>;
};

const VersionResource = ({ version, cacheConfig, videoPlaybackSettings, className = '', contentStyle, videoPlayback = true, quality }: { version: MediaVersion; cacheConfig: AppConfig['mediaCache']; videoPlaybackSettings?: AppConfig['videoPlayback']; className?: string; contentStyle?: React.CSSProperties; videoPlayback?: boolean; quality?: VersionResourceQuality }) => {
  const resourceQuality = quality || (videoPlayback ? 'full' : 'thumbnail');
  const resourceKey = versionResourceCacheKey(version, resourceQuality);
  const [resource, setResource] = useState<VersionResourceData>(() => versionResourceCache.get(resourceKey) || {});
  const [loading, setLoading] = useState(false);
  const [videoPlaybackFailed, setVideoPlaybackFailed] = useState(false);
  const [videoPlayerError, setVideoPlayerError] = useState('');
  const kind = mediaKind(version.filePath);
  useEffect(() => {
    let active = true;
    const cached = versionResourceCache.get(resourceKey);
    setResource(cached || {});
    if (version.fileMissing) return () => { active = false; };
    if (cached) {
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    loadVersionResource(version, cacheConfig, resourceQuality).then(result => { if (active) setResource(result); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [resourceKey, version.fileMissing, cacheConfig.directory, cacheConfig.maxSizeGB, resourceQuality]);
  useEffect(() => { setVideoPlaybackFailed(false); setVideoPlayerError(''); }, [resourceKey]);

  if (version.fileMissing) return <div className={`flex items-center justify-center bg-slate-100 text-slate-400 ${className}`}><AlertTriangle size={26}/></div>;
  if (kind === 'video' && videoPlayback && !videoPlaybackFailed) return <div style={contentStyle} className={`relative overflow-hidden bg-black ${className}`}><VideoPlayer filePath={version.filePath} poster={resource.url} keyboardSettings={videoPlaybackSettings} onError={message => {
    setVideoPlaybackFailed(true);
    setVideoPlayerError(message);
    window.electronAPI.reportRendererError('Video player failed in version manager', `${version.filePath}: ${message}`);
  }} onMetadata={() => undefined}/></div>;
  if (kind === 'video' && videoPlayback && videoPlaybackFailed) return <div role="alert" style={contentStyle} className={`flex flex-col items-center justify-center bg-slate-950 p-4 text-center text-white ${className}`}><AlertTriangle size={26} className="text-red-400"/><p className="mt-2 text-sm font-bold">视频播放器无法启动</p><p className="mt-1 max-w-sm text-xs text-slate-300">{videoPlayerError || 'Chromium 与高级解码组件均无法播放此视频；请安装或修复高级解码组件，或使用系统播放器。'}</p></div>;
  return <div className={`relative flex items-center justify-center overflow-hidden bg-slate-100 ${className}`}>
    {resource.url ? <OrientedVersionImage src={resource.url} alt={version.versionName} orientationMatrix={resource.orientationMatrix} contentStyle={contentStyle}/> : <ImageIcon size={28} className="text-slate-400"/>}
    {loading && <span className="absolute rounded-full bg-slate-900/70 p-2 text-white"><Loader2 size={16} className="animate-spin"/></span>}
  </div>;
};

const CompareView = ({ active, left, right, cacheConfig, videoPlaybackSettings, workspacePath, photoId, onClose, initialMode = 'side-by-side' }: {
  active: boolean;
  left: MediaVersion;
  right: MediaVersion;
  cacheConfig: AppConfig['mediaCache'];
  videoPlaybackSettings: AppConfig['videoPlayback'];
  workspacePath: string;
  photoId: string;
  onClose: () => void;
  initialMode?: 'side-by-side' | 'split' | 'overlay' | 'blink' | 'difference';
}) => {
  const [mode, setMode] = useScopedPageState<ImageComparisonMode>("version:mode", initialMode);
  const videoComparison = mediaKind(left.filePath) === 'video' || mediaKind(right.filePath) === 'video';
  useEffect(() => {
    if (videoComparison && mode !== 'side-by-side') setMode('side-by-side');
  }, [mode, videoComparison]);
  useEffect(() => {
    void window.electronAPI.recordMediaVersionCompare(workspacePath, { photoId, leftVersionId: left.id, rightVersionId: right.id, compareMode: videoComparison ? 'side-by-side' : mode })
      .catch(() => undefined);
  }, [mode, videoComparison, left.id, right.id, photoId, workspacePath]);
  return <ImageComparisonView
    left={{ label: `${visibleVersionLabel(left)} ${visibleVersionName(left)}`, interactive: active && mediaKind(left.filePath) === 'video', content: <VersionResource version={left} cacheConfig={cacheConfig} videoPlaybackSettings={videoPlaybackSettings} videoPlayback={active} className="absolute inset-0 h-full w-full"/> }}
    right={{ label: `${visibleVersionLabel(right)} ${visibleVersionName(right)}`, interactive: active && mediaKind(right.filePath) === 'video', content: <VersionResource version={right} cacheConfig={cacheConfig} videoPlaybackSettings={videoPlaybackSettings} videoPlayback={active} className="absolute inset-0 h-full w-full"/> }}
    mode={mode}
    onModeChange={setMode}
    comparisonKey={`${left.id}|${right.id}`}
    className="h-full min-h-[520px]"
    leading={<><h3 className="font-bold">版本对比</h3><p className="truncate text-xs text-slate-400">{visibleVersionLabel(left)} {visibleVersionName(left)} ↔ {visibleVersionLabel(right)} {visibleVersionName(right)}</p></>}
    trailing={<button type="button" onClick={onClose} className="rounded p-2 hover:bg-white/10"><X size={18}/></button>}
    unavailable={videoComparison}
  />;
};

const SingleVersionView = ({ active, version, cacheConfig, videoPlaybackSettings, busy, onClose, onNotice, onSaveNote, onMakeCurrent, onRelocate, onDelete }: {
  active: boolean;
  version: MediaVersion;
  cacheConfig: AppConfig['mediaCache'];
  videoPlaybackSettings: AppConfig['videoPlayback'];
  busy: boolean;
  onClose: () => void;
  onNotice: (message: string) => void;
  onSaveNote: (note: string) => Promise<void>;
  onMakeCurrent: () => void;
  onRelocate: () => void;
  onDelete: () => void;
}) => {
  const [metadataFields, setMetadataFields] = useState<MediaMetadataField[]>([]);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [metadataError, setMetadataError] = useState('');
  const [openMetadataGroups, setOpenMetadataGroups] = useScopedPageState<Set<string>>('version-'+version.id+':openMetadataGroups', () => new Set());
  const [fullscreen, setFullscreen] = useState(false);
  const [zoom, setZoom] = useScopedPageState('version-'+version.id+':zoom', 1);
  const [pan, setPan] = useScopedPageState('version-'+version.id+':pan', { x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useScopedPageState('version-'+version.id+':noteDraft', version.note);
  const [metadataWidth, setMetadataWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem('photoflow:version-metadata-width'));
    return Number.isFinite(stored) && stored >= 260 && stored <= 560 ? stored : 340;
  });
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const fileName = version.filePath.replace(/\\/g, '/').split('/').pop() || version.versionName;

  useEffect(() => {
    let active = true;
    setMetadataFields([]);
    setMetadataError('');
    setZoom(1);
    setPan({ x: 0, y: 0 });
    if (version.fileMissing) {
      setMetadataLoading(false);
      return () => { active = false; };
    }
    setMetadataLoading(true);
    window.electronAPI.getMediaMetadata(version.filePath).then(result => {
      if (!active) return;
      if (!result.success) setMetadataError(result.error || '无法读取完整详细信息');
      else setMetadataFields(result.fields);
    }).catch(error => {
      if (active) setMetadataError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (active) setMetadataLoading(false); });
    return () => { active = false; };
  }, [version.id, version.filePath, version.fileModifiedAt, version.fileMissing]);
  useEffect(() => window.localStorage.setItem('photoflow:version-metadata-width', String(Math.round(metadataWidth))), [metadataWidth]);
  useEffect(() => setNoteDraft(version.note), [version.id, version.note]);
  useEffect(() => {
    if (zoom === 1) setPan(current => current.x || current.y ? { x: 0, y: 0 } : current);
  }, [zoom]);
  const clampMetadataWidth = useCallback((width: number) => {
    const available = layoutRef.current?.getBoundingClientRect().width || window.innerWidth;
    return Math.max(260, Math.min(560, Math.max(260, available - 320), width));
  }, []);
  useEffect(() => {
    const layout = layoutRef.current;
    if (!layout || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setMetadataWidth(width => clampMetadataWidth(width)));
    observer.observe(layout);
    return () => observer.disconnect();
  }, [clampMetadataWidth]);
  useEscapeLayer(fullscreen, () => setFullscreen(false));
  useEscapeLayer(actionsOpen, () => setActionsOpen(false));
  useEffect(() => {
    if (!actionsOpen) return;
    const closeActions = (event: PointerEvent) => {
      if (!actionsRef.current?.contains(event.target as Node)) setActionsOpen(false);
    };
    document.addEventListener('pointerdown', closeActions);
    return () => document.removeEventListener('pointerdown', closeActions);
  }, [actionsOpen]);

  const groupedMetadata = useMemo(() => metadataFields.reduce((groups, field) => {
    const fields = groups.get(field.group) || [];
    fields.push(field);
    groups.set(field.group, fields);
    return groups;
  }, new Map<string, MediaMetadataField[]>()), [metadataFields]);
  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  const preview = <section className={`flex min-h-0 min-w-0 flex-1 flex-col bg-slate-50 ${fullscreen ? 'fixed inset-x-0 bottom-0 top-10 z-[370] w-screen' : ''}`}>
    <header className="flex min-h-14 shrink-0 items-center justify-between border-b border-slate-200 px-3 py-2">
      <div className="min-w-0"><p className="text-xs font-bold uppercase tracking-wider text-slate-400">预览</p><p className="truncate text-sm font-semibold text-slate-700">{fileName}</p></div>
      <div className="flex items-center gap-1">
        {!fullscreen && <button type="button" onClick={() => setFullscreen(true)} title="全屏查看预览图" aria-label="全屏查看预览图" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><Maximize2 size={16}/></button>}
        <button type="button" disabled={version.fileMissing} onClick={async () => { const result = await window.electronAPI.openMediaVersion(version.filePath).catch(error => ({ success: false, error: error instanceof Error ? error.message : String(error) })); if (!result.success) onNotice(`打开版本失败：${result.error || '未知错误'}`); }} title="使用系统默认应用打开" aria-label="使用系统默认应用打开" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40"><ExternalLink size={16}/></button>
        {fullscreen ? <button type="button" onClick={() => setFullscreen(false)} title="缩小预览（Esc）" aria-label="缩小预览" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><Minimize2 size={16}/></button> : <button type="button" disabled={busy} onClick={onClose} title="关闭版本管理" aria-label="关闭版本管理" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-40"><X size={16}/></button>}
      </div>
    </header>
    <div
      className={`relative min-h-0 flex-1 overflow-hidden bg-slate-50 ${zoom > 1 ? dragging ? 'cursor-grabbing' : 'cursor-grab' : ''}`}
      onWheel={event => { if (mediaKind(version.filePath) === 'video') return; event.preventDefault(); setZoom(value => Math.max(1, Math.min(8, value * (event.deltaY < 0 ? 1.15 : 1 / 1.15)))); }}
      onDoubleClick={resetView}
      onPointerDown={event => { if (zoom <= 1 || event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y }; setDragging(true); }}
      onPointerMove={event => { const drag = dragRef.current; if (drag?.pointerId === event.pointerId) setPan({ x: drag.panX + event.clientX - drag.startX, y: drag.panY + event.clientY - drag.startY }); }}
      onPointerUp={event => { if (dragRef.current?.pointerId === event.pointerId) { dragRef.current = null; setDragging(false); } }}
      onPointerCancel={() => { dragRef.current = null; setDragging(false); }}
    >
      <VersionResource version={version} cacheConfig={cacheConfig} videoPlaybackSettings={videoPlaybackSettings} videoPlayback={active} contentStyle={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'center', transition: dragging ? 'none' : 'transform 100ms ease-out' }} className="h-full w-full"/>
      {mediaKind(version.filePath) !== 'video' && !version.fileMissing && <button type="button" onClick={resetView} title="恢复适合窗口" className="absolute bottom-4 right-4 rounded-md bg-slate-900/75 px-2 py-1 font-mono text-[11px] text-slate-200 shadow-lg">{Math.round(zoom * 100)}%</button>}
    </div>
  </section>;

  return <div ref={layoutRef} className="flex h-full min-h-0 min-w-0 flex-1">
    {fullscreen ? createPortal(preview, document.body) : preview}
    <ResizeHandle orientation="vertical" label="调整预览区和详细信息区宽度" value={metadataWidth} min={260} max={560} onReset={() => setMetadataWidth(340)} onDrag={delta => setMetadataWidth(width => clampMetadataWidth(width - delta))}/>
    <aside style={{ width: metadataWidth }} className="pointer-events-auto flex min-h-0 shrink-0 select-auto flex-col bg-white">
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-slate-200 px-4"><div className="min-w-0"><p className="text-xs font-bold uppercase tracking-wider text-slate-400">详细信息</p><p className="truncate text-sm font-semibold text-slate-700">{visibleVersionName(version)}</p></div><div ref={actionsRef} className="relative"><button type="button" onClick={() => setActionsOpen(open => !open)} aria-label="版本操作" title="版本操作" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><MoreHorizontal size={18}/></button>{actionsOpen && <div className="absolute right-0 top-full z-30 mt-1 w-48 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-xl">{!version.isCurrent && <button type="button" disabled={busy || version.fileMissing} onClick={() => { setActionsOpen(false); onMakeCurrent(); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40"><CheckCircle2 size={14}/>设为当前工作版本</button>}{version.fileMissing && <button type="button" disabled={busy} onClick={() => { setActionsOpen(false); onRelocate(); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40"><FolderSearch size={14}/>重新定位文件</button>}<button type="button" onClick={async () => { setActionsOpen(false); try { await navigator.clipboard.writeText(version.filePath); onNotice('成功复制文字'); } catch { onNotice('复制文件地址失败'); } }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"><Copy size={14}/>复制文件地址</button>{version.versionNumber > 0 && !version.fileMissing && <><div className="my-1 border-t border-slate-200"/><button type="button" disabled={busy} onClick={() => { setActionsOpen(false); onDelete(); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-40"><Trash2 size={14}/>删除版本记录</button></>}</div>}</div></header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <section className="border-b border-slate-200 pb-2"><h4 className="py-2 text-xs font-bold text-slate-700">版本信息</h4><dl>
          <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-3 border-b border-slate-100 py-2"><dt className="text-[11px] text-slate-400">版本</dt><dd className="break-words text-xs text-slate-700">{visibleVersionLabel(version)} · {visibleVersionName(version)}</dd></div>
          <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-3 border-b border-slate-100 py-2"><dt className="text-[11px] text-slate-400">标记</dt><dd className="text-xs text-slate-700">{version.isCurrent ? '当前版本' : '—'}</dd></div>
          <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-3 border-b border-slate-100 py-2"><dt className="text-[11px] text-slate-400">文件大小</dt><dd className="text-xs text-slate-700">{formatSize(version.fileSize)}</dd></div>
          <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-3 border-b border-slate-100 py-2"><dt className="text-[11px] text-slate-400">状态</dt><dd className={`text-xs ${version.fileMissing ? 'font-bold text-red-500' : version.contentChanged ? 'font-bold text-amber-600' : 'text-slate-700'}`}>{version.fileMissing ? '文件丢失' : version.contentChanged ? '文件曾被外部修改' : '正常'}</dd></div>
          <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-3 border-b border-slate-100 py-2"><dt className="text-[11px] text-slate-400">创建时间</dt><dd className="text-xs text-slate-700">{new Date(version.createdAt).toLocaleString()}</dd></div>
          <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-3 py-2"><dt className="pt-2 text-[11px] text-slate-400"><label htmlFor={`version-note-${version.id}`}>版本说明</label></dt><dd><textarea id={`version-note-${version.id}`} rows={4} value={noteDraft} disabled={busy} onChange={event => setNoteDraft(event.target.value)} placeholder="记录本次进度的修改内容" className="w-full resize-y rounded-md border border-slate-200 bg-white px-2.5 py-2 text-xs leading-5 text-slate-700 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:opacity-60"/><div className="mt-2 flex items-center justify-end gap-2">{noteDraft !== version.note && <button type="button" disabled={busy} onClick={() => setNoteDraft(version.note)} className="rounded px-2 py-1 text-[11px] font-bold text-slate-500 hover:bg-slate-100 disabled:opacity-40">撤销</button>}<button type="button" disabled={busy || noteDraft === version.note} onClick={() => void onSaveNote(noteDraft)} className="rounded bg-blue-600 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40">保存说明</button></div></dd></div>
        </dl></section>
        <div className="flex items-center justify-between border-b border-slate-200 py-2"><span className="text-[11px] text-slate-400">{metadataLoading ? '正在读取媒体元数据…' : `${metadataFields.length} 个媒体字段`}</span></div>
        {metadataError && <p className="my-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-xs text-red-600">{metadataError}</p>}
        {Array.from(groupedMetadata.entries()).map(([group, fields], groupIndex) => { const open = openMetadataGroups.has(group); const regionId = `version-metadata-group-${groupIndex}`; return <section key={group} className="border-b border-slate-200"><button type="button" aria-expanded={open} aria-controls={regionId} onClick={() => setOpenMetadataGroups(current => { const next = new Set(current); if (next.has(group)) next.delete(group); else next.add(group); return next; })} className="flex w-full cursor-pointer items-center py-2.5 text-left text-xs font-bold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400">{open ? <ChevronDown size={13} className="mr-1 shrink-0"/> : <ChevronRight size={13} className="mr-1 shrink-0"/>}{metadataGroupLabel(group)}<span className="ml-2 text-[10px] font-normal text-slate-400">{fields.length}</span></button>{open && <dl id={regionId} className="pb-2">{fields.map((field, index) => <div key={`${field.name}:${index}`} className="grid grid-cols-[82px_minmax(0,1fr)] gap-3 border-b border-slate-100 py-2 last:border-0"><dt title={field.name} className="break-words text-[11px] text-slate-400">{metadataFieldLabel(field.name)}</dt><dd className="select-text break-words text-xs leading-5 text-slate-700">{field.value}</dd></div>)}</dl>}</section>; })}
      </div>
    </aside>
  </div>;
};

export const VersionManager = ({ active = true, entry, workspacePath, project, cacheConfig, videoPlaybackSettings, onClose, onNotice, onVersionStateChanged, progressVersionKey = '', progressId = '', initialCompareIds = [], initialCompareMode = 'side-by-side' }: VersionManagerProps) => {
  const appDialog = useAppDialog();
  const initialCompareKey = initialCompareIds.join('|');
  const [bundle, setBundle] = useState<MediaVersionBundle>({ success: true, versions: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  useRestoreScopedPageState(!loading);
  usePageTransferParticipant('version-operation', { read: () => null, prepare: () => { if (busy) throw new Error('版本正在保存，请完成后再移动标签页'); } });
  const [selectedId, setSelectedId] = useScopedPageState("version:selectedId", '');
  const [compareIds, setCompareIds] = useScopedPageState<string[]>("version:compareIds", []);
  const [branchPhotos, setBranchPhotos] = useState<MainBranchPhotoSummary[]>([]);
  const [branchPhotoPage, setBranchPhotoPage] = useScopedPageState("version:branchPhotoPage", 0);
  const [branchPhotoLoading, setBranchPhotoLoading] = useState(false);
  const [activePhotoId, setActivePhotoId] = useScopedPageState("version:activePhotoId", '');
  const branchPhotoRequestRef = useRef(0);
  const loadRequestRef = useRef(0);
  const pageGenerationRef = useRef(0);
  const busyRef = useRef(false);
  const mutationSequenceRef = useRef(0);
  const busyOwnerRef = useRef<number | null>(null);
  const pageIdentityKey = `${workspacePath}\0${project.status}\0${project.name}\0${entry.path}\0${entry.updatedAt}\0${progressId}\0${progressVersionKey}\0${initialCompareKey}`;
  const pageIdentityRef = useRef(pageIdentityKey);
  if (pageIdentityRef.current !== pageIdentityKey) {
    pageIdentityRef.current = pageIdentityKey;
    pageGenerationRef.current += 1;
    loadRequestRef.current += 1;
    branchPhotoRequestRef.current += 1;
    mutationSequenceRef.current += 1;
    busyOwnerRef.current = null;
    busyRef.current = false;
  }
  const pageGenerationIsCurrent = (generation: number) => generation === pageGenerationRef.current;
  const resetMutationBusy = () => {
    mutationSequenceRef.current += 1;
    busyOwnerRef.current = null;
    busyRef.current = false;
    setBusy(false);
  };
  const settleMutationBusy = (pageGeneration: number, owner: number) => {
    if (busyOwnerRef.current !== owner) return;
    busyOwnerRef.current = null;
    busyRef.current = false;
    if (pageGenerationIsCurrent(pageGeneration)) setBusy(false);
  };
  const runMutation = async <T,>(pageGeneration: number, operation: () => Promise<T>) => {
    const owner = ++mutationSequenceRef.current;
    busyOwnerRef.current = owner;
    busyRef.current = true;
    setBusy(true);
    try {
      return await operation();
    } finally {
      settleMutationBusy(pageGeneration, owner);
    }
  };
  const publishCommittedMutation = () => onVersionStateChanged?.();
  const publishCommittedMutationNotice = (message: string) => onNotice(message);
  const initialCompareAppliedRef = useRef('');
  const [treeWidth, setTreeWidth] = useScopedPageState("version:treeWidth", () => {
    const stored = Number(window.localStorage.getItem('photoflow:version-manager-tree-width-v2'));
    return Number.isFinite(stored) && stored >= 260 && stored <= 760 ? stored : 360;
  });
  const [branchPhotoHeight, setBranchPhotoHeight] = useScopedPageState("version:branchPhotoHeight", () => {
    const stored = Number(window.localStorage.getItem('photoflow:version-manager-branch-photo-height'));
    return Number.isFinite(stored) && stored >= 140 && stored <= 720 ? stored : 276;
  });
  const layoutRef = useRef<HTMLDivElement>(null);
  const treePaneRef = useRef<HTMLElement>(null);

  useEffect(() => {
    window.localStorage.setItem('photoflow:version-manager-tree-width-v2', String(Math.round(treeWidth)));
  }, [treeWidth]);
  useEffect(() => {
    window.localStorage.setItem('photoflow:version-manager-branch-photo-height', String(Math.round(branchPhotoHeight)));
  }, [branchPhotoHeight]);
  const clampTreeWidth = useCallback((width: number) => {
    const available = layoutRef.current?.getBoundingClientRect().width || window.innerWidth;
    return Math.max(260, Math.min(760, Math.max(260, available - 580), width));
  }, []);
  const clampBranchPhotoHeight = useCallback((height: number) => {
    const available = treePaneRef.current?.getBoundingClientRect().height || window.innerHeight;
    return Math.max(140, Math.min(720, Math.max(140, available - 250), height));
  }, []);
  useEffect(() => {
    const layout = layoutRef.current;
    const treePane = treePaneRef.current;
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setTreeWidth(width => clampTreeWidth(width));
      setBranchPhotoHeight(height => clampBranchPhotoHeight(height));
    });
    if (layout) observer.observe(layout);
    if (treePane) observer.observe(treePane);
    return () => observer.disconnect();
  }, [clampBranchPhotoHeight, clampTreeWidth]);

  const trackedPhotoForBranch = (photoId: string, summary: MainBranchPhotoSummary | undefined, versions: MediaVersion[], fallback?: TrackedPhoto): TrackedPhoto => {
    if (fallback?.id === photoId) return { ...fallback, currentVersionId: versions.find(version => version.isCurrent)?.id || versions.at(-1)?.id || fallback.currentVersionId };
    const current = versions.find(version => version.isCurrent) || versions.at(-1);
    const first = versions[0];
    return {
      id: photoId,
      projectId: project.id,
      mediaType: mediaKind(current?.filePath || first?.filePath || '') === 'video' ? 'video' : 'image',
      originalName: summary?.originalName || photoId,
      displayName: summary?.originalName || photoId,
      currentVersionId: current?.id || '',
      originalFilePath: first?.filePath || current?.filePath || '',
      createdAt: first?.createdAt || Date.now(),
      updatedAt: current?.updatedAt || first?.updatedAt || Date.now(),
    };
  };

  const applyBranchPhoto = (photoId: string, versions: MediaVersion[], fallback?: TrackedPhoto, summaries = branchPhotos) => {
    const photo = trackedPhotoForBranch(photoId, summaries.find(item => item.photoId === photoId), versions, fallback);
    setBundle({ success: true, photo, versions });
    setActivePhotoId(photoId);
    setSelectedId(currentId => versions.some(version => version.id === currentId) ? currentId : versions.find(version => version.isCurrent)?.id || versions.at(-1)?.id || '');
    setCompareIds(ids => ids.filter(id => versions.some(version => version.id === id && !version.fileMissing)).slice(0, 2));
  };

  const loadBranchPhoto = async (photoId: string, fallback?: TrackedPhoto, summaries = branchPhotos, pageGeneration = pageGenerationRef.current) => {
    if (!progressId || !photoId || !pageGenerationIsCurrent(pageGeneration)) return false;
    const requestId = ++branchPhotoRequestRef.current;
    setCompareIds([]);
    setBranchPhotoLoading(true);
    const result = await window.electronAPI.getProgressMainBranchMedia(workspacePath, { progressId, photoId })
      .catch(error => ({ success: false as const, entries: [], error: error instanceof Error ? error.message : String(error) }));
    if (requestId !== branchPhotoRequestRef.current || !pageGenerationIsCurrent(pageGeneration)) return false;
    setBranchPhotoLoading(false);
    if (!result.success) { onNotice(`读取主分支版本失败：${result.error || '未知错误'}`); return false; }
    const versions = mainBranchVersionsForPhoto(result.entries, photoId);
    if (!versions.length) { onNotice('该图片在当前主分支中没有版本记录'); return false; }
    applyBranchPhoto(photoId, versions, fallback, summaries);
    return true;
  };
  const selectBranchPhoto = async (photoId: string) => {
    if (busyRef.current) return false;
    const pageGeneration = ++pageGenerationRef.current;
    loadRequestRef.current += 1;
    resetMutationBusy();
    return loadBranchPhoto(photoId, undefined, branchPhotos, pageGeneration);
  };

  const load = async (pageGeneration = pageGenerationRef.current) => {
    if (!pageGenerationIsCurrent(pageGeneration)) return;
    const requestId = ++loadRequestRef.current;
    branchPhotoRequestRef.current += 1;
    setBranchPhotoLoading(false);
    setLoading(true);
    const result = await window.electronAPI.getMediaVersions(workspacePath, project.status, project.name, entry.relativePath)
      .catch(error => ({ success: false as const, versions: [], error: error instanceof Error ? error.message : String(error) }));
    if (requestId !== loadRequestRef.current || !pageGenerationIsCurrent(pageGeneration)) return;
    if (!result.success) {
      setLoading(false);
      setBundle({ ...result, versions: [] });
      setBranchPhotos([]);
      setActivePhotoId('');
      setSelectedId('');
      setCompareIds([]);
      onNotice(`读取版本失败：${result.error || '未知错误'}`);
      return;
    }
    let visibleVersions = normalizeVisibleVersionBundle(result, entry.path, progressVersionKey).versions;
    let summaries: MainBranchPhotoSummary[] = [];
    if (progressId && result.photo?.id) {
      const [photoBranch, fullBranch] = await Promise.all([
        window.electronAPI.getProgressMainBranchMedia(workspacePath, { progressId, photoId: result.photo.id })
          .catch(error => ({ success: false as const, entries: [], error: error instanceof Error ? error.message : String(error) })),
        window.electronAPI.getProgressMainBranchMedia(workspacePath, { progressId })
          .catch(error => ({ success: false as const, entries: [], error: error instanceof Error ? error.message : String(error) })),
      ]);
      if (requestId !== loadRequestRef.current || !pageGenerationIsCurrent(pageGeneration)) return;
      if (fullBranch.success) {
        summaries = mainBranchPhotoSummaries(fullBranch.entries);
        setBranchPhotos(summaries);
        setBranchPhotoPage(Math.max(0, Math.floor(Math.max(0, summaries.findIndex(item => item.photoId === result.photo!.id)) / MAIN_BRANCH_PHOTO_PAGE_SIZE)));
      } else {
        setBranchPhotos([]);
      }
      if (photoBranch.success) {
        const branchVersions = mainBranchVersionsForPhoto(photoBranch.entries, result.photo.id);
        if (branchVersions.length) visibleVersions = branchVersions;
      } else {
        onNotice(`读取主分支版本失败：${photoBranch.error || '未知错误'}`);
      }
    } else {
      setBranchPhotos([]);
    }
    if (requestId !== loadRequestRef.current || !pageGenerationIsCurrent(pageGeneration)) return;
    setLoading(false);
    if (result.photo) applyBranchPhoto(result.photo.id, visibleVersions, result.photo, summaries);
    else setBundle({ ...result, versions: visibleVersions });
    const current = visibleVersions.find(version => version.isCurrent) || visibleVersions[visibleVersions.length - 1];
    setSelectedId(value => visibleVersions.some(version => version.id === value) ? value : current?.id || '');
    const compareKey = `${result.photo?.id || entry.path}|${initialCompareKey}`;
    if (initialCompareKey && initialCompareAppliedRef.current !== compareKey) {
      const availableIds = [...new Set(initialCompareIds)].filter(id => visibleVersions.some(version => version.id === id && !version.fileMissing)).slice(0, 2);
      if (availableIds.length === 2) setCompareIds(availableIds);
      initialCompareAppliedRef.current = compareKey;
    }
  };
  useEffect(() => {
    const pageGeneration = ++pageGenerationRef.current;
    if (!initialCompareKey) initialCompareAppliedRef.current = '';
    resetMutationBusy();
    void load(pageGeneration);
    return () => {
      pageGenerationRef.current += 1;
      loadRequestRef.current += 1;
      branchPhotoRequestRef.current += 1;
    };
  }, [entry.path, entry.updatedAt, workspacePath, project.status, project.name, initialCompareKey, progressId, progressVersionKey]);

  const branchPhotoPagination = useMemo(() => paginateMainBranchPhotos(branchPhotos, branchPhotoPage), [branchPhotos, branchPhotoPage]);

  const selected = bundle.versions.find(version => version.id === selectedId);
  const compareVersions = compareIds.map(id => bundle.versions.find(version => version.id === id)).filter((version): version is MediaVersion => Boolean(version));
  const missingVersionCount = bundle.versions.filter(version => version.fileMissing).length;
  useEffect(() => {
    const switchSelectedVersion = (event: KeyboardEvent) => {
      if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || compareVersions.length === 2) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      const currentIndex = bundle.versions.findIndex(version => version.id === selectedId);
      if (currentIndex < 0) return;
      const nextIndex = Math.max(0, Math.min(bundle.versions.length - 1, currentIndex + (event.key === 'ArrowRight' ? 1 : -1)));
      if (nextIndex === currentIndex) return;
      event.preventDefault();
      event.stopPropagation();
      setSelectedId(bundle.versions[nextIndex].id);
    };
    window.addEventListener('keydown', switchSelectedVersion);
    return () => window.removeEventListener('keydown', switchSelectedVersion);
  }, [bundle.versions, selectedId, compareVersions.length]);
  const depths = useMemo(() => {
    const byId = new Map(bundle.versions.map(version => [version.id, version]));
    return new Map(bundle.versions.map(version => {
      let depth = 0;
      let parent = version.parentVersionId ? byId.get(version.parentVersionId) : undefined;
      const visited = new Set<string>();
      while (parent && !visited.has(parent.id)) { visited.add(parent.id); depth += 1; parent = parent.parentVersionId ? byId.get(parent.parentVersionId) : undefined; }
      return [version.id, depth];
    }));
  }, [bundle.versions]);

  const updateVersion = async (request: { versionId: string; versionName?: string; note?: string; makeCurrent?: boolean }, notice: string) => {
    if (busyRef.current) return;
    const pageGeneration = pageGenerationRef.current;
    if (!pageGenerationIsCurrent(pageGeneration)) return;
    const result = await runMutation(pageGeneration, () => window.electronAPI.updateMediaVersion(workspacePath, request)
      .catch(error => ({ success: false as const, versions: [], error: error instanceof Error ? error.message : String(error) })));
    const current = pageGenerationIsCurrent(pageGeneration);
    if (!result.success) {
      if (!current) return;
      onNotice(`更新版本失败：${result.error || '未知错误'}`);
      return;
    }
    publishCommittedMutation();
    publishCommittedMutationNotice(notice);
    if (!current) return;
    const branchLoaded = result.photo ? await loadBranchPhoto(result.photo.id, result.photo, branchPhotos, pageGeneration) : false;
    if (!pageGenerationIsCurrent(pageGeneration)) return;
    if (!result.photo || !branchLoaded) setBundle(normalizeVisibleVersionBundle(result, entry.path, progressVersionKey));
  };
  const deleteVersion = async (version: MediaVersion) => {
    if (!bundle.photo) return;
    const pageGeneration = pageGenerationRef.current;
    const photoId = bundle.photo.id;
    const scope = await window.electronAPI.getMediaVersionDeleteScope(workspacePath, version.id)
      .catch(error => ({ success: false as const, error: error instanceof Error ? error.message : String(error) }));
    if (!pageGenerationIsCurrent(pageGeneration)) return;
    if (!scope.success) { onNotice(`读取删除范围失败：${scope.error || '未知错误'}`); return; }
    const selectedReparentText = scope.success && scope.selectedChildCount
      ? `\n\n该版本有 ${scope.selectedChildCount} 条直接子版本；删除后会自动改接到它的上一级版本，编号不会变化。`
      : '';
    const confirmed = await appDialog.confirm({
      title: `确定删除 ${visibleVersionLabel(version)} 吗？`,
      message: `将删除“${visibleVersionName(version)}”的版本记录。${selectedReparentText}`,
      confirmLabel: '删除版本',
      tone: 'danger',
    });
    if (!pageGenerationIsCurrent(pageGeneration) || !confirmed) return;
    if (version.fileMissing) {
      if (scope.success && scope.allMissing && scope.versionCount > 1) {
        const bulkReparentText = scope.childCount ? `\n其中 ${scope.childCount} 条直接子版本会自动改接到上一级版本。` : '';
        const deleteAll = await appDialog.confirm({
          title: `删除所有图片的 V${scope.versionNumber}？`,
          message: `当前项目中 V${scope.versionNumber} 的 ${scope.versionCount} 条版本记录已全部丢失。${bulkReparentText}\n\n选择“只删当前图片”将只删除当前这一张图片的 V${scope.versionNumber}。`,
          confirmLabel: '删除所有图片',
          cancelLabel: '只删当前图片',
          tone: 'danger',
        });
        if (!pageGenerationIsCurrent(pageGeneration)) return;
        if (deleteAll) {
          if (busyRef.current) return;
          const bulkResult = await runMutation(pageGeneration, () => window.electronAPI.deleteProjectMissingMediaVersion(workspacePath, version.id)
            .catch(error => ({ success: false as const, deletedCount: 0, reparentedCount: 0, versionNumber: version.versionNumber, error: error instanceof Error ? error.message : String(error) })));
          const current = pageGenerationIsCurrent(pageGeneration);
          if (!bulkResult.success) {
            if (!current) return;
            onNotice(`批量删除失效版本失败：${bulkResult.error || '未知错误'}`);
            return;
          }
          publishCommittedMutation();
          publishCommittedMutationNotice(`已删除当前项目 ${bulkResult.deletedCount} 张图片的 V${bulkResult.versionNumber} 失效版本${bulkResult.reparentedCount ? `，并改接 ${bulkResult.reparentedCount} 条后续版本` : ''}；其他版本编号保持不变`);
          if (!current) return;
          setCompareIds([]);
          await load(pageGeneration);
          if (!pageGenerationIsCurrent(pageGeneration)) return;
          return;
        }
      }
    }
    const trashFile = version.fileMissing ? false : await appDialog.confirm({
      title: '是否同时删除磁盘文件？',
      message: '对应磁盘文件将移入系统回收站。选择“仅删除记录”会保留磁盘文件。',
      confirmLabel: '文件移入回收站',
      cancelLabel: '仅删除记录',
      tone: 'danger',
    });
    if (!pageGenerationIsCurrent(pageGeneration)) return;
    if (busyRef.current) return;
    const result = await runMutation(pageGeneration, () => window.electronAPI.deleteMediaVersion(workspacePath, { photoId, versionId: version.id, trashFile })
      .catch(error => ({ success: false as const, versions: [], error: error instanceof Error ? error.message : String(error) })));
    const current = pageGenerationIsCurrent(pageGeneration);
    if (!result.success) {
      if (!current) return;
      onNotice(`删除版本失败：${result.error || '未知错误'}`);
      return;
    }
    publishCommittedMutation();
    if (result.warning) await appDialog.alert(RECYCLE_BIN_FAILURE_DIALOG);
    else publishCommittedMutationNotice(trashFile ? '版本已删除，文件已移入回收站；其他版本编号保持不变' : '版本记录已删除；其他版本编号保持不变');
    if (!pageGenerationIsCurrent(pageGeneration)) return;
    const branchLoaded = result.photo ? await loadBranchPhoto(result.photo.id, result.photo, branchPhotos, pageGeneration) : false;
    if (!pageGenerationIsCurrent(pageGeneration)) return;
    if (!result.photo || !branchLoaded) setBundle(normalizeVisibleVersionBundle(result, entry.path, progressVersionKey));
    setSelectedId(result.versions.find(item => item.isCurrent)?.id || result.versions[0]?.id || '');
    setCompareIds(ids => ids.filter(id => id !== version.id));
  };
  const relocateVersion = async (version: MediaVersion) => {
    if (!bundle.photo || busyRef.current) return;
    const pageGeneration = pageGenerationRef.current;
    const photoId = bundle.photo.id;
    let result = await runMutation(pageGeneration, () => window.electronAPI.relocateMediaVersion(workspacePath, project.status, project.name, {
      photoId,
      versionId: version.id,
    }).catch(error => ({ success: false as const, versions: [], requiresDecision: undefined, cancelled: false, error: error instanceof Error ? error.message : String(error) })));
    let current = pageGenerationIsCurrent(pageGeneration);
    if (!current && !result.success) return;
    if (result.requiresDecision?.kind === 'version-fingerprint-mismatch') {
      const decision = result.requiresDecision;
      const action = await appDialog.choice({
        title: '文件内容不一致',
        message: decision.message,
        detail: decision.detail,
        choices: [{ value: 'relocate', label: '仍然重新定位' }],
        cancelDefault: true,
      });
      if (!pageGenerationIsCurrent(pageGeneration)) return;
      if (action !== 'relocate') return;
      if (busyRef.current) return;
      result = await runMutation(pageGeneration, () => window.electronAPI.relocateMediaVersion(workspacePath, project.status, project.name, {
        photoId,
        versionId: version.id,
        filePath: decision.filePath,
        force: true,
      }).catch(error => ({ success: false as const, versions: [], requiresDecision: undefined, cancelled: false, error: error instanceof Error ? error.message : String(error) })));
      current = pageGenerationIsCurrent(pageGeneration);
      if (!current && !result.success) return;
    }
    if (result.cancelled) return;
    if (!result.success) { onNotice(`重新定位失败：${result.error || '未知错误'}`); return; }
    publishCommittedMutation();
    publishCommittedMutationNotice(result.versions.find(item => item.id === version.id)?.contentChanged ? '已重新定位，但文件内容与原记录不同。' : '版本文件已重新定位');
    if (!current) return;
    const branchLoaded = result.photo ? await loadBranchPhoto(result.photo.id, result.photo, branchPhotos, pageGeneration) : false;
    if (!pageGenerationIsCurrent(pageGeneration)) return;
    if (!result.photo || !branchLoaded) setBundle(normalizeVisibleVersionBundle(result, entry.path, progressVersionKey));
  };
  const toggleCompare = (id: string) => setCompareIds(current => current.includes(id) ? current.filter(value => value !== id) : [...(current.length >= 2 ? current.slice(1) : current), id]);
  const previewVersion = (id: string) => {
    setCompareIds([]);
    setSelectedId(id);
  };

  return <div className="version-manager-surface fixed inset-x-0 bottom-0 top-10 z-[300] flex flex-col bg-slate-50">
    {loading ? <div className="flex flex-1 items-center justify-center gap-3 text-slate-500"><Loader2 size={20} className="animate-spin"/>正在扫描文件身份并建立版本记录…</div> : <div ref={layoutRef} className="relative flex min-h-0 flex-1">
      <aside ref={treePaneRef} style={{ width: treeWidth }} className="flex min-h-0 shrink-0 flex-col overflow-hidden bg-white">
        <header className="z-10 shrink-0 border-b border-slate-200 bg-white px-4 py-3"><div className="flex items-start gap-2"><GitBranch size={18} className="mt-0.5 shrink-0 text-blue-600"/><div className="min-w-0 flex-1"><h2 className="truncate text-sm font-bold text-slate-800">版本对比 · {bundle.photo?.displayName || entry.name}</h2><p className="mt-1 truncate text-[11px] text-slate-500" title={bundle.photo?.id}>Photo ID：<span className="font-mono">{bundle.photo?.id || '正在建立追踪…'}</span></p></div><button disabled={busy} onClick={onClose} title="关闭版本对比" aria-label="关闭版本对比" className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"><X size={17}/></button></div></header>
        {missingVersionCount > 0 && <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[11px] font-medium leading-5 text-amber-800"><AlertTriangle size={14} className="mt-0.5 shrink-0"/><span>{missingVersionCount} 个版本文件不可用，请重新定位或删除记录。</span></div>}
        {branchPhotos.length > 1 && <><section style={{ height: branchPhotoHeight }} className="flex min-h-0 shrink-0 flex-col bg-slate-50/70 p-3"><div className="mb-2 flex shrink-0 items-center justify-between"><span className="text-xs font-bold text-slate-600">主分支图片</span><span className="text-[10px] text-slate-400">{branchPhotoPagination.total} 张</span></div><div className="min-h-0 flex-1 space-y-1 overflow-y-auto">{branchPhotoPagination.items.map(photo => <button key={photo.photoId} type="button" disabled={busy} aria-pressed={activePhotoId === photo.photoId} onClick={() => void selectBranchPhoto(photo.photoId)} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs disabled:cursor-not-allowed disabled:opacity-40 ${activePhotoId === photo.photoId ? 'bg-blue-100 font-bold text-blue-700' : 'text-slate-600 hover:bg-white'}`}><span className={`h-2 w-2 shrink-0 rounded-full ${photo.missing ? 'bg-red-400' : 'bg-emerald-400'}`}/><span className="min-w-0 flex-1 truncate" title={photo.originalName}>{photo.originalName}</span><span className="shrink-0 text-[10px] text-slate-400">{photo.versionCount} 版</span></button>)}</div>{branchPhotoPagination.pageCount > 1 && <div className="mt-2 flex shrink-0 items-center justify-between"><button type="button" disabled={busy || branchPhotoPagination.currentPage === 0 || branchPhotoLoading} onClick={() => setBranchPhotoPage(page => Math.max(0, page - 1))} className="rounded border border-slate-200 bg-white px-2 py-1 text-[10px] font-bold text-slate-600 disabled:opacity-40">上一页</button><span className="text-[10px] text-slate-400">{branchPhotoPagination.currentPage + 1} / {branchPhotoPagination.pageCount}</span><button type="button" disabled={busy || branchPhotoPagination.currentPage + 1 >= branchPhotoPagination.pageCount || branchPhotoLoading} onClick={() => setBranchPhotoPage(page => page + 1)} className="rounded border border-slate-200 bg-white px-2 py-1 text-[10px] font-bold text-slate-600 disabled:opacity-40">下一页</button></div>}</section><ResizeHandle orientation="horizontal" label="调整主分支图片列表高度" value={branchPhotoHeight} min={140} max={720} onReset={() => setBranchPhotoHeight(276)} onDrag={delta => setBranchPhotoHeight(height => clampBranchPhotoHeight(height + delta))}/></>}
        <div className="min-h-0 flex-1 overflow-y-auto p-3"><div className="mb-2 flex items-center justify-between px-2"><span className="text-xs font-bold uppercase tracking-wider text-slate-400">版本树</span><span className="text-xs text-slate-400">{bundle.versions.length} 个版本</span></div>
        <div className="space-y-2">{bundle.versions.map(version => <div key={version.id} className={`relative w-full rounded-xl border p-3 text-left transition ${selectedId === version.id ? 'border-blue-400 bg-blue-50 shadow-sm' : 'border-slate-200 bg-white hover:bg-slate-50'}`} style={{ paddingLeft: 12 + Math.min(depths.get(version.id) || 0, 6) * 14 }}><button type="button" aria-label={`预览 ${visibleVersionLabel(version)} ${visibleVersionName(version)}`} onClick={() => previewVersion(version.id)} className="absolute inset-0 z-0 cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"/>
          {(depths.get(version.id) || 0) > 0 && <span className="absolute bottom-1/2 top-0 w-px bg-slate-200" style={{ left: 8 + Math.min(depths.get(version.id) || 0, 6) * 14 }}/>} {/* Visual indentation is capped without truncating logical depth. */}
          <div className="pointer-events-none relative z-10 flex items-start gap-3"><VersionResource version={version} cacheConfig={cacheConfig} videoPlayback={false} className="h-16 w-20 shrink-0 rounded-md"/><div className="min-w-0 flex-1"><div className="flex items-center gap-1.5"><span className="font-mono text-xs font-bold text-blue-600">{visibleVersionLabel(version)}</span><span className="truncate text-sm font-bold text-slate-800">{visibleVersionName(version)}</span>{version.isCurrent && <span title="当前版本" className="rounded-full bg-blue-600 p-0.5 text-white"><Check size={10}/></span>}</div><p className="mt-1 flex items-center gap-1 text-[11px] text-slate-400"><Clock3 size={11}/>{new Date(version.createdAt).toLocaleString()}</p>{version.note && <p title={version.note} className="mt-1 line-clamp-2 break-words text-[11px] leading-4 text-slate-500">{version.note}</p>}{version.fileMissing && <div className="mt-1 flex flex-wrap items-center gap-2"><span className="text-[11px] font-bold text-red-500">文件丢失</span>{version.versionNumber > 0 && <button type="button" disabled={busy} onClick={event => { event.stopPropagation(); void deleteVersion(version); }} className="pointer-events-auto inline-flex items-center gap-1 rounded border border-red-200 bg-white px-2 py-0.5 text-[10px] font-bold text-red-600 hover:bg-red-50 disabled:opacity-40"><Trash2 size={11}/>删除版本</button>}</div>}{version.contentChanged && <p className="mt-1 text-[11px] font-bold text-amber-600">文件曾被外部修改</p>}</div><input disabled={version.fileMissing} title={version.fileMissing ? '请先重新定位文件' : '选择进行对比'} aria-label={`选择 ${visibleVersionLabel(version)} 进行对比`} type="checkbox" checked={compareIds.includes(version.id)} onClick={event => event.stopPropagation()} onChange={() => toggleCompare(version.id)} className="pointer-events-auto mt-1 accent-blue-600 disabled:opacity-40"/></div>
        </div>)}</div></div>
      </aside>
      <ResizeHandle orientation="vertical" label="调整版本树宽度" value={treeWidth} min={260} max={760} onReset={() => setTreeWidth(360)} onDrag={delta => setTreeWidth(width => clampTreeWidth(width + delta))}/>
      <main className="flex min-w-0 flex-1 overflow-hidden">{compareVersions.length === 2 ? null : selected ? <SingleVersionView active={active} version={selected} cacheConfig={cacheConfig} videoPlaybackSettings={videoPlaybackSettings} busy={busy} onClose={onClose} onNotice={onNotice} onSaveNote={note => updateVersion({ versionId: selected.id, note }, '版本说明已更新')} onMakeCurrent={() => void updateVersion({ versionId: selected.id, makeCurrent: true }, '已切换当前版本')} onRelocate={() => void relocateVersion(selected)} onDelete={() => void deleteVersion(selected)}/> : <div className="flex h-full flex-1 items-center justify-center text-slate-400">请选择一个版本</div>}</main>
      {bundle.photo && compareVersions.length === 2 && <div className="absolute inset-y-0 right-0 z-20 bg-slate-950" style={{ left: treeWidth + 1 }}><CompareView active={active} left={compareVersions[0]} right={compareVersions[1]} cacheConfig={cacheConfig} videoPlaybackSettings={videoPlaybackSettings} workspacePath={workspacePath} photoId={bundle.photo.id} initialMode={initialCompareMode} onClose={() => setCompareIds([])}/></div>}
    </div>}
  </div>;
};
