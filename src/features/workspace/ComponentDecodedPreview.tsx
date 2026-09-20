import { useLocale } from "../../i18n/react";
import { t } from "../../i18n/runtime";
import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import type { PreviewDecoder, PreviewDecodeResult, PreviewPageContext } from '../../contracts/component-preview';
import { VideoPlayer } from '../../components/AdvancedVideoPlayer';
import { useComponentPreview } from './useComponentPreview';
import { Play } from 'lucide-react';
import { livePhotoFinished } from './live-photo-playback';

type PlayerOptions = Pick<ComponentProps<typeof VideoPlayer>, 'keyboardSettings' | 'onNavigate' | 'onContextMenuAt' | 'onPointerActivity' | 'controlsVisible' | 'controlsOverlay' | 'topRightOverlayHole' | 'onEscape' | 'onToggleFullscreen' | 'onMetadata'>;
const DynamicPreview = ({ previewId, mimeType, context, relativePath, onError, playerOptions, poster, presentation }: { previewId: string; mimeType: string; context: PreviewPageContext; relativePath: string; onError: (message: string) => void; playerOptions?: PlayerOptions; poster?: string; presentation?: 'live-photo' }) => {
  const live = presentation === 'live-photo' && Boolean(poster);
  const [playing, setPlaying] = useState(true);
  const [liveSeek, setLiveSeek] = useState<{ id: number; time: number; play: boolean }>();
  const liveCommandId = useRef(0);
  const [ready, setReady] = useState(false);
  const [pictureSize, setPictureSize] = useState<{ width: number; height: number }>();
  const sawMotion = useRef(false);
  const [motionError, setMotionError] = useState('');
  const preview = useComponentPreview(context, relativePath, true);
  useEffect(() => {
    if (!live || !preview.seek) return;
    sawMotion.current = false; setPlaying(true);
    setLiveSeek({ id: ++liveCommandId.current, time: preview.seek.time, play: true });
  }, [live, preview.seek]);
  const api = useMemo((): Window['electronAPI'] => ({
    ...window.electronAPI,
    getVideoPlaybackSource: () => window.electronAPI.componentPreviewPlayback({ previewId, action: 'source' }),
    getVideoPlaybackBackends: async (_path, browserProbe) => { const value = await window.electronAPI.componentPreviewPlayback({ previewId, action: 'backends', browserProbe }); return { ...value, backends: value.backends || [] }; },
    startVideoPlayer: (_path, settings, playerId, requestId, backendId) => window.electronAPI.componentPreviewPlayback({ previewId, action: 'start', settings, playerId, requestId, backendId }),
    // The derived movie is a private preview, not a project output destination.
    captureVideoPlayerFrame: async () => ({ success: false, error: '此预览不支持保存截图。' }),
    publishVideoPlayerFrame: async () => ({ success: false, error: '此预览不支持保存截图。' }),
  }), [previewId]);
  useEffect(() => {
    const timer = window.setInterval(() => { void window.electronAPI.componentPreviewPlayback({ previewId, action: 'keepalive' }).then(value => { if (!value.success) onError(value.error || '预览已关闭。'); }).catch(() => onError('预览连接已关闭。')); }, 30000);
    const stop = window.electronAPI.onComponentPreviewReleased(value => { if (value.previewId === previewId) onError('预览已关闭，请重试。'); });
    return () => { window.clearInterval(timer); stop(); };
  }, [previewId, onError]);
  return <div className={`absolute inset-0 ${live ? 'bg-slate-50' : 'bg-black'}`} data-live-photo={live ? 'true' : undefined}>
    <div className="absolute inset-0">
    {live && <img src={poster} alt={relativePath} draggable={false} onLoad={event => { const { naturalWidth: width, naturalHeight: height } = event.currentTarget; if (width && height) setPictureSize({ width, height }); }} className="absolute inset-0 h-full w-full object-contain"/>}
    {(!live || !motionError) && <VideoPlayer {...playerOptions} filePath={`${previewId}${mimeType === 'video/mp4' ? '.mp4' : '.mov'}`} electronApi={api} poster={poster} pictureSize={pictureSize} surfaceVisible={!live || Boolean(pictureSize) && ready && playing} controlsVisible={live ? false : playerOptions?.controlsVisible} appearance={live ? 'photo' : 'video'} onError={message => { if (live) { setPlaying(false); setReady(false); setMotionError(message); } else onError(message); }} onMetadata={playerOptions?.onMetadata || (() => undefined)} onSessionReady={session => { if (live) { session.control({ action: 'mute', value: true }); session.control({ action: 'seek', value: 0 }); session.control({ action: playing ? 'play' : 'pause' }); setReady(true); } }} onPlaybackState={value => { preview.onPlaybackState(value); if (live) { if (!value.paused && value.time > 0) sawMotion.current = true; if (livePhotoFinished(value, sawMotion.current)) setPlaying(false); } }} editorSeekRequest={live ? liveSeek : preview.seek}/>}
    </div>
    {live && <button type="button" data-live-photo-replay="true" aria-label={playing ? '重新播放实况照片' : '播放实况照片'} title="播放实况照片" onClick={() => { sawMotion.current = false; setMotionError(''); setLiveSeek({ id: ++liveCommandId.current, time: 0, play: true }); setPlaying(true); }} className="absolute left-3 top-1 z-30 inline-flex h-8 w-20 items-center justify-start gap-1.5 rounded bg-transparent px-2 text-xs font-semibold text-slate-600 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"><Play size={13} fill="currentColor"/><span>LIVE</span></button>}
    {live && motionError && <p role="status" className="absolute inset-x-4 bottom-4 z-20 rounded bg-black/60 p-2 text-center text-xs text-white">{motionError}</p>}
  </div>;
};

export const ComponentDecodedPreview = ({ context, relativePath, decoder, onOpen, playerOptions }: { context: PreviewPageContext; relativePath: string; decoder: PreviewDecoder; onOpen: () => void; playerOptions?: PlayerOptions }) => {
  useLocale();
  const [page, setPage] = useState(0); const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<PreviewDecodeResult | null>(null); const [loading, setLoading] = useState(true);
  const contextKey = JSON.stringify(context);
  useEffect(() => {
    let active = true; let timer = 0; let attempts = 0; let previewId = '';
    const requestId = crypto.randomUUID();
    setLoading(true); setResult(null);
    const run = async () => {
      const value = await window.electronAPI.decodeComponentPreview({ requestId, componentId: decoder.componentId, decoderId: decoder.id, context, relativePath, pageIndex: page, maxEdge: 2048 }).catch(() => ({ success: false as const, error: '预览解码失败', errorCode: 'COMPONENT_HOST_INTERNAL' }));
      if (value.success && value.kind === 'video') previewId = value.previewId;
      if (!active) { if (previewId) void window.electronAPI.componentPreviewPlayback({ previewId, action: 'release' }).catch(() => undefined); return; }
      if (!value.success && value.errorCode === 'COMPONENT_HOST_CONFLICT' && attempts++ < 120) { timer = window.setTimeout(() => void run(), 500); return; }
      setResult(value); setLoading(false);
    };
    void run(); return () => { active = false; window.clearTimeout(timer); void window.electronAPI.cancelComponentPreview(requestId).catch(() => undefined); if (previewId) void window.electronAPI.componentPreviewPlayback({ previewId, action: 'release' }).catch(() => undefined); };
  }, [contextKey, relativePath, decoder.componentId, decoder.id, page, retry]);
  return <div className="absolute inset-0 flex min-h-0 flex-col bg-slate-100" aria-label={t("ui.file.preview.f3c5fe")}>
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-2">
      {loading ? <p role="status" className="text-sm text-slate-500">{t("ui.generating.preview.a8eecc")}</p> : result?.success ? result.kind === 'video' ? <DynamicPreview previewId={result.previewId} poster={result.poster} presentation={result.presentation} mimeType={result.mimeType} playerOptions={playerOptions} context={context} relativePath={relativePath} onError={error => { void window.electronAPI.componentPreviewPlayback({ previewId: result.previewId, action: 'release' }).catch(() => undefined); setResult({ success: false, error, errorCode: 'COMPONENT_HOST_INTERNAL' }); }}/> : <img src={result.dataUrl} alt={t("ui.value0.page.value1.c67ab0", { value0: relativePath, value1: page + 1 })} className="max-h-full max-w-full object-contain"/> : <div role="alert" className="p-4 text-sm text-slate-600"><p>{result?.error || t("ui.cannot.preview.this.file.959e07")}</p><button onClick={() => setRetry(value => value + 1)} className="mt-3 rounded border px-3 py-1">{t("ui.retry.b8784c")}</button><button onClick={onOpen} className="ml-2 rounded border px-3 py-1">{t("ui.open.externally.5a006a")}</button></div>}
    </div>
    {result?.success && result.pageCount > 1 && <nav aria-label={t("ui.preview.navigation.c5ee96")} className="flex shrink-0 items-center justify-center gap-3 border-t bg-white p-2 text-sm"><button disabled={page === 0} onClick={() => setPage(value => value - 1)}>{t("ui.previous.page.c9b9ae")}</button><span>{page + 1} / {result.pageCount}</span><button disabled={page + 1 >= result.pageCount} onClick={() => setPage(value => value + 1)}>{t("ui.next.page.8a8542")}</button></nav>}
  </div>;
};
