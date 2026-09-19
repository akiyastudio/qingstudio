import type { VideoAudioTrack, VideoPlaybackBackendDescriptor, VideoPlaybackSettings, VideoPlayerState, VideoSubtitleTrack } from '../../types';
import { chromiumVideoStyle, DEFAULT_VIDEO_TRANSFORM, drawTransformedVideoFrame, normalizeVideoTransform, transformedFrameSize } from '../../contracts/video-playback.ts';
import type { VideoHdrMode, VideoStatisticsLevel, VideoToneMapping, VideoTransform } from '../../contracts/video-playback.ts';
import { classifyPlaybackError, PlaybackFailure } from '../../contracts/playback-errors.ts';
import type { PlaybackAttempt, PlaybackErrorCode } from '../../contracts/playback-errors.ts';

export type PlaybackBackendId = string;
export type PlaybackControl = {
  action: 'play' | 'pause' | 'seek' | 'frame-step' | 'frame-back-step' | 'volume' | 'mute' | 'speed' | 'stop' | 'subtitle-select' | 'subtitle-visible' | 'subtitle-delay' | 'subtitle-style' | 'audio-select' | 'transform' | 'hdr-mode' | 'tone-mapping' | 'statistics-level';
  value?: number | boolean | string;
  fontSize?: VideoPlaybackSettings['subtitleSize'];
  style?: VideoPlaybackSettings['subtitleStyle'];
  transform?: VideoTransform;
  hdrMode?: VideoHdrMode;
  toneMapping?: VideoToneMapping;
  targetPeakNits?: number;
  statisticsLevel?: VideoStatisticsLevel;
};

export type PlaybackBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  viewportDip?: { x: number; y: number; width: number; height: number };
  overlayHole?: { x: number; y: number; width: number; height: number; radius?: number };
  controlsOverlayHole?: { x: number; y: number; width: number; height: number };
  cornerOverlayHole?: { x: number; y: number; width: number; height: number };
};

export interface PlaybackSession {
  readonly id: string;
  readonly backendId: PlaybackBackendId;
  readonly availableBackends?: VideoPlaybackBackendDescriptor[];
  readonly attempts?: PlaybackAttempt[];
  control(request: PlaybackControl): void;
  setBounds(bounds: PlaybackBounds): void;
  capture(mode?: 'sourceFrame'|'displayedFrame'): Promise<{ success: boolean; path?: string; error?: string }>;
  chooseSubtitle(): Promise<{ success: boolean; cancelled?: boolean; path?: string; error?: string; requiresFeature?: string }>;
  switchBackend?(backendId: string): Promise<{ success: boolean; error?: string }>;
  close(): Promise<void>;
}

export interface VideoPlaybackBackend {
  readonly descriptor: VideoPlaybackBackendDescriptor;
  start(context: PlaybackBackendContext): Promise<PlaybackSession>;
}

export type PlaybackSessionSnapshot = {
  time: number;
  paused: boolean;
  volume: number;
  muted: boolean;
  speed: number;
  subtitle: { mode: 'default' | 'off' | 'track'; stableId?: string; visible: boolean; delay: number };
  subtitleStyle: { fontSize: VideoPlaybackSettings['subtitleSize']; style: VideoPlaybackSettings['subtitleStyle'] };
  transform: VideoTransform;
  hdrMode: VideoHdrMode;
  toneMapping: VideoToneMapping;
  targetPeakNits: number;
  statisticsLevel: VideoStatisticsLevel;
  audio: { stableId?: string; language?: string };
};

type ElectronApi = Window['electronAPI'];

export type PlaybackBackendContext = {
  filePath: string;
  settings: VideoPlaybackSettings;
  playerId: string;
  requestId: string;
  video: HTMLVideoElement;
  electronApi: ElectronApi;
  onState: (state: VideoPlayerState) => void;
  onRuntimeFailure: (error: string, code?: PlaybackErrorCode) => void;
  signal?: AbortSignal;
};

const stateEnvelope = (context: Omit<PlaybackBackendContext, 'onRuntimeFailure'>, type: VideoPlayerState['type'], state: Partial<VideoPlayerState> = {}): VideoPlayerState => ({
  sessionId: context.requestId,
  playerId: context.playerId,
  requestId: context.requestId,
  type,
  ...state,
});

const chromiumPlaybackFailure = (video: HTMLVideoElement): PlaybackFailure => {
  const mediaError = video.error;
  const detail = String(mediaError?.message || '').trim();
  const state = `readyState=${video.readyState}，networkState=${video.networkState}`;
  if (mediaError?.code === 1) return new PlaybackFailure('CANCELLED', detail || `Chromium 媒体读取已中止（${state}）`, false, [], 'none');
  if (mediaError?.code === 2) return new PlaybackFailure('MEDIA_IO_FAILED', detail || `Chromium 读取视频数据失败（MEDIA_ERR_NETWORK，${state}）`);
  if (mediaError?.code === 3) return new PlaybackFailure('DECODE_INITIALIZATION_FAILED', detail || `Chromium 解码视频数据失败（MEDIA_ERR_DECODE，${state}）`);
  if (mediaError?.code === 4) return new PlaybackFailure('UNSUPPORTED_CODEC', detail || `Chromium 不支持该媒体源（MEDIA_ERR_SRC_NOT_SUPPORTED，${state}）`);
  return classifyPlaybackError(detail || `Chromium 视频播放失败（未提供 MediaError，${state}）`, 'DECODE_INITIALIZATION_FAILED');
};

const benignPlayRejection = (error: unknown) => error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError');
const chromiumVideoOwners = new WeakMap<HTMLVideoElement, string>();
const cancelledFailure = (message = '视频播放操作已取消') => new PlaybackFailure('CANCELLED', message, false, [], 'none');
const waitForChromiumFrame = (video: HTMLVideoElement, timeoutMs = 300, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  let settled = false;
  let frameId: number | undefined;
  const cleanup = () => {
    globalThis.clearTimeout(timer);
    if (frameId !== undefined && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(frameId);
    signal?.removeEventListener('abort', cancel);
  };
  const finish = () => { if (!settled) { settled = true; cleanup(); resolve(); } };
  const cancel = () => { if (!settled) { settled = true; cleanup(); reject(cancelledFailure('Chromium 等待视频帧已取消')); } };
  const timer = globalThis.setTimeout(finish, timeoutMs);
  if (signal?.aborted) { cancel(); return; }
  signal?.addEventListener('abort', cancel, { once: true });
  if (typeof video.requestVideoFrameCallback === 'function') frameId = video.requestVideoFrameCallback(() => finish());
  else globalThis.requestAnimationFrame(() => finish());
});

const withPlaybackTimeout = <T,>(promise: Promise<T>, timeoutMs: number, failure: () => PlaybackFailure, signal?: AbortSignal) => new Promise<T>((resolve, reject) => {
  let settled = false;
  const cancel = () => finish(() => reject(cancelledFailure()));
  const finish = (complete: () => void) => { if (!settled) { settled = true; globalThis.clearTimeout(timer); signal?.removeEventListener('abort', cancel); complete(); } };
  const timer = globalThis.setTimeout(() => finish(() => reject(failure())), timeoutMs);
  if (signal?.aborted) { cancel(); return; }
  signal?.addEventListener('abort', cancel, { once: true });
  promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
});

const waitForChromiumReady = (video: HTMLVideoElement, timeoutMs = 8000, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  let timer = 0;
  const ready = () => { cleanup(); resolve(); };
  const failed = () => { cleanup(); reject(chromiumPlaybackFailure(video)); };
  const cleanup = () => {
    globalThis.clearTimeout(timer);
    video.removeEventListener('loadedmetadata', ready);
    video.removeEventListener('error', failed);
    signal?.removeEventListener('abort', cancelled);
  };
  const cancelled = () => { cleanup(); reject(cancelledFailure('Chromium 打开媒体已取消')); };
  if (signal?.aborted) { cancelled(); return; }
  signal?.addEventListener('abort', cancelled, { once: true });
  video.addEventListener('loadedmetadata', ready, { once: true });
  video.addEventListener('error', failed, { once: true });
  timer = globalThis.setTimeout(() => { cleanup(); reject(new PlaybackFailure('STARTUP_TIMEOUT', `Chromium 等待视频元数据超时（readyState=${video.readyState}，networkState=${video.networkState}）`)); }, timeoutMs);
  video.load();
});

export class ChromiumPlaybackBackend implements VideoPlaybackBackend {
  readonly descriptor: VideoPlaybackBackendDescriptor;
  constructor(descriptor: VideoPlaybackBackendDescriptor) { this.descriptor = descriptor; }

  async start(context: PlaybackBackendContext): Promise<PlaybackSession> {
    const { video } = context;
    const lifecycleController = new AbortController();
    const abortLifecycle = () => lifecycleController.abort();
    context.signal?.addEventListener('abort', abortLifecycle, { once: true });
    if (context.signal?.aborted) lifecycleController.abort();
    const ownerId = `${context.playerId}:${context.requestId}`;
    chromiumVideoOwners.set(video, ownerId);
    const ownsVideo = () => chromiumVideoOwners.get(video) === ownerId;
    const requireOwnership = () => { if (closed || lifecycleController.signal.aborted || !ownsVideo()) throw new PlaybackFailure('CANCELLED', 'Chromium 播放请求已被新的会话替换', false, [], 'none'); };
    let closed = false;
    let loaded = false;
    let runtimeFailureReported = false;
    let transform = DEFAULT_VIDEO_TRANSFORM;
    let statisticsLevel: VideoStatisticsLevel = 'off';
    let statisticsTimer = 0;
    let estimatedFps = 0; let lastFrameMediaTime = -1;
    let subtitleDelay = 0;
    const browserSubtitles = new Map<string, { element: HTMLTrackElement; stableId: string; name: string; originalTimes: WeakMap<TextTrackCue, { start: number; end: number }> }>();
    const emitSubtitles = () => {
      const tracks = [...browserSubtitles.entries()].map(([id, item]) => ({ id, stableId: item.stableId, source: 'external' as const, title: item.name, format: 'vtt', selected: item.element.track.mode !== 'disabled' }));
      const selected = tracks.find(item => item.selected);
      context.onState(stateEnvelope(context, 'subtitle-tracks', { subtitleTracks: tracks, subtitleTrackId: selected?.id || null, subtitleVisible: selected ? browserSubtitles.get(selected.id)?.element.track.mode === 'showing' : false, subtitleDelay }));
    };
    const applyBrowserSubtitleDelay = () => {
      for (const item of browserSubtitles.values()) for (const cue of Array.from(item.element.track.cues || [])) {
        const original = item.originalTimes.get(cue) || { start: cue.startTime, end: cue.endTime }; item.originalTimes.set(cue, original);
        cue.startTime = Math.max(0, original.start + subtitleDelay); cue.endTime = Math.max(cue.startTime, original.end + subtitleDelay);
      }
    };
    video.poster = '';
    video.preload = 'auto';
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    const chromiumViewport = () => ({ width: video.clientWidth || video.parentElement?.clientWidth || video.videoWidth, height: video.clientHeight || video.parentElement?.clientHeight || video.videoHeight });
    const applyChromiumTransform = () => { const viewport = chromiumViewport(); Object.assign(video.style, chromiumVideoStyle(transform, viewport.width, viewport.height, video.videoWidth || viewport.width, video.videoHeight || viewport.height)); };
    const transformResizeObserver = typeof globalThis.ResizeObserver === 'function' ? new globalThis.ResizeObserver(() => applyChromiumTransform()) : null;
    transformResizeObserver?.observe(video.parentElement || video);
    applyChromiumTransform();

    const emitState = () => {
      if (!ownsVideo()) return;
      const time = Number(video.currentTime) || 0;
      context.onState(stateEnvelope(context, 'state', {
        time,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        paused: video.paused,
        buffering: video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
        muted: video.muted,
        volume: Math.round(video.volume * 100),
        speed: video.playbackRate,
        width: video.videoWidth,
        height: video.videoHeight,
      }));
    };
    const onWaiting = () => { if (ownsVideo()) context.onState(stateEnvelope(context, 'loading', { buffering: true })); };
    const onPlaying = () => { if (ownsVideo()) { loaded = true; emitState(); } };
    const onEnded = () => { if (ownsVideo()) context.onState(stateEnvelope(context, 'ended', { paused: true, time: Number(video.duration) || Number(video.currentTime) || 0 })); };
    const onError = () => {
      if (closed || !ownsVideo() || !loaded || runtimeFailureReported) return;
      runtimeFailureReported = true;
      const failure = chromiumPlaybackFailure(video);
      context.onRuntimeFailure(failure.message, failure.code);
    };
    const emitStatistics = () => {
      if (statisticsLevel === 'off' || closed) return;
      const quality = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null;
      context.onState(stateEnvelope(context, 'statistics', { statistics: {
        level: statisticsLevel === 'detailed' ? 'detailed' : 'basic',
        container: context.filePath.split('.').pop()?.toLowerCase(),
        droppedFrames: quality?.droppedVideoFrames,
        sourceFps: estimatedFps || undefined,
        displayFps: estimatedFps || undefined,
        hardwareDecoding: undefined,
        renderer: 'Chromium HTMLVideoElement',
        toneMapping: 'browser-managed',
      } }));
    };
    const sampleFrameRate = (_now: number, metadata: VideoFrameCallbackMetadata) => { if (closed) return; if (lastFrameMediaTime >= 0 && metadata.mediaTime > lastFrameMediaTime) { const current = 1 / (metadata.mediaTime - lastFrameMediaTime); if (current >= 1 && current <= 240) estimatedFps = estimatedFps ? estimatedFps * 0.8 + current * 0.2 : current; } lastFrameMediaTime = metadata.mediaTime; video.requestVideoFrameCallback?.(sampleFrameRate); };
    const updateStatisticsTimer = () => {
      globalThis.clearInterval(statisticsTimer);
      statisticsTimer = statisticsLevel === 'off' ? 0 : globalThis.setInterval(emitStatistics, statisticsLevel === 'detailed' ? 250 : 1000);
    };
    const events: Array<[keyof HTMLMediaElementEventMap, EventListener]> = [
      ['timeupdate', emitState as EventListener], ['durationchange', emitState as EventListener],
      ['volumechange', emitState as EventListener], ['ratechange', emitState as EventListener],
      ['play', emitState as EventListener], ['pause', emitState as EventListener],
      ['waiting', onWaiting as EventListener], ['playing', onPlaying as EventListener],
      ['ended', onEnded as EventListener], ['error', onError as EventListener],
    ];
    events.forEach(([name, listener]) => video.addEventListener(name, listener));

    try {
      let startupFailure: PlaybackFailure | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          requireOwnership();
          const source = await withPlaybackTimeout(context.electronApi.getVideoPlaybackSource(context.filePath), 5000, () => new PlaybackFailure('STARTUP_TIMEOUT', 'Chromium 媒体源授权超时'), lifecycleController.signal);
          requireOwnership();
          if (!source.success || !source.mediaUrl) throw new PlaybackFailure('MEDIA_IO_FAILED', source.error || '无法授权 Chromium 读取视频');
          video.src = source.mediaUrl;
          await waitForChromiumReady(video, 8000, lifecycleController.signal);
          requireOwnership();
          startupFailure = null;
          break;
        } catch (error) {
          startupFailure = classifyPlaybackError(error, 'DECODE_INITIALIZATION_FAILED');
          if (!ownsVideo()) throw startupFailure;
          const retryable = ['STARTUP_TIMEOUT', 'MEDIA_IO_FAILED'].includes(startupFailure.code);
          if (attempt > 0 || !retryable) throw startupFailure;
          video.pause();
          video.removeAttribute('src');
          video.load();
        }
      }
      if (startupFailure) throw startupFailure;
      loaded = true;
      applyChromiumTransform();
      context.onState(stateEnvelope(context, 'file-loaded', {
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        width: video.videoWidth,
        height: video.videoHeight,
        buffering: false,
      }));
      try {
        await video.play();
      } catch (error) {
        // A host autoplay policy is not a decoder failure. Keep the Chromium
        // session ready so the existing play control can satisfy user gesture.
        if (!benignPlayRejection(error)) throw error;
        emitState();
      }
      video.requestVideoFrameCallback?.(sampleFrameRate);
    } catch (error) {
      events.forEach(([name, listener]) => video.removeEventListener(name, listener));
      transformResizeObserver?.disconnect();
      context.signal?.removeEventListener('abort', abortLifecycle);
      lifecycleController.abort();
      if (ownsVideo()) {
        chromiumVideoOwners.delete(video);
        video.removeAttribute('src');
        video.load();
      }
      throw error;
    }

    return {
      id: context.requestId,
      backendId: this.descriptor.backendId,
      control: request => {
        if (closed) return;
        if (request.action === 'play') void video.play().catch(error => {
          if (benignPlayRejection(error)) emitState();
          else {
            const failure = classifyPlaybackError(error, 'DECODE_INITIALIZATION_FAILED');
            context.onRuntimeFailure(`Chromium 播放请求失败：${failure.message}`, failure.code);
          }
        });
        else if (request.action === 'pause') video.pause();
        else if (request.action === 'seek') video.currentTime = Math.max(0, Number(request.value) || 0);
        else if (request.action === 'frame-step' || request.action === 'frame-back-step') { if (estimatedFps > 0) { video.pause(); video.currentTime = Math.max(0, video.currentTime + (request.action === 'frame-step' ? 1 : -1) / estimatedFps); } else context.onState(stateEnvelope(context, 'diagnostic', { diagnostic: { code: 'FRAME_STEP_UNAVAILABLE', severity: 'warning', phase: 'frame-step', message: 'Chromium 尚未获得可靠源帧率，未执行近似逐帧', recoverable: true } })); }
        else if (request.action === 'volume') video.volume = Math.max(0, Math.min(1, (Number(request.value) || 0) / 100));
        else if (request.action === 'mute') video.muted = Boolean(request.value);
        else if (request.action === 'speed') video.playbackRate = Math.max(0.25, Math.min(4, Number(request.value) || 1));
        else if (request.action === 'transform') { transform = normalizeVideoTransform(request.transform); applyChromiumTransform(); }
        else if (request.action === 'statistics-level') { statisticsLevel = request.statisticsLevel || 'off'; updateStatisticsTimer(); emitStatistics(); }
        else if (request.action === 'subtitle-select') { for (const [id, item] of browserSubtitles) item.element.track.mode = id === String(request.value || '') ? 'showing' : 'disabled'; emitSubtitles(); }
        else if (request.action === 'subtitle-visible') { const selected = [...browserSubtitles.values()].find(item => item.element.track.mode !== 'disabled'); if (selected) selected.element.track.mode = request.value ? 'showing' : 'hidden'; emitSubtitles(); }
        else if (request.action === 'subtitle-delay') { subtitleDelay = Math.max(-30, Math.min(30, Number(request.value) || 0)); applyBrowserSubtitleDelay(); emitSubtitles(); }
        else if (request.action === 'stop') { video.pause(); video.currentTime = 0; }
      },
      setBounds: () => undefined,
      capture: async mode => {
        if (closed || !ownsVideo()) return { success: false, error: '当前 Chromium 播放会话已结束' };
        if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return { success: false, error: '当前视频帧尚未就绪' };
        try {
          await waitForChromiumFrame(video, 300, lifecycleController.signal);
          requireOwnership();
          const canvas = document.createElement('canvas');
          const captureTransform = mode === 'sourceFrame' ? DEFAULT_VIDEO_TRANSFORM : transform;
          const viewport = mode === 'sourceFrame' ? { width: 0, height: 0 } : chromiumViewport();
          const size = transformedFrameSize(video.videoWidth, video.videoHeight, captureTransform, viewport.width, viewport.height);
          canvas.width = size.width; canvas.height = size.height;
          const drawing = canvas.getContext('2d');
          if (!drawing) return { success: false, error: '无法创建视频截图画布' };
          requireOwnership();
          drawTransformedVideoFrame(drawing, video, captureTransform, viewport.width, viewport.height);
          requireOwnership();
          const blob = await new Promise<Blob | null>(resolve => {
            const timer = globalThis.setTimeout(() => resolve(null), 5000);
            canvas.toBlob(value => { globalThis.clearTimeout(timer); resolve(value); }, 'image/png');
          });
          requireOwnership();
          if (!blob) return { success: false, error: 'Chromium 生成截图超时或失败' };
          const bytes = new Uint8Array(await blob.arrayBuffer());
          requireOwnership();
          const result = await context.electronApi.publishVideoPlayerFrame(context.filePath, bytes);
          requireOwnership();
          return result;
        } catch (error) {
          return { success: false, error: `Chromium 截图失败：${error instanceof Error ? error.message : String(error)}` };
        }
      },
      chooseSubtitle: async () => ({ success: false, error: 'Chromium 模式未启用字幕功能', requiresFeature: 'subtitles' }),
      close: async () => {
        if (closed) return;
        closed = true;
        context.signal?.removeEventListener('abort', abortLifecycle);
        lifecycleController.abort();
        globalThis.clearInterval(statisticsTimer);
        transformResizeObserver?.disconnect();
        events.forEach(([name, listener]) => video.removeEventListener(name, listener));
        for (const item of browserSubtitles.values()) item.element.remove(); browserSubtitles.clear();
        if (ownsVideo()) {
          chromiumVideoOwners.delete(video);
          video.pause();
          video.removeAttribute('src');
          video.load();
        }
      },
    };
  }
}

export class BrokeredPlaybackBackend implements VideoPlaybackBackend {
  readonly descriptor: VideoPlaybackBackendDescriptor;
  constructor(descriptor: VideoPlaybackBackendDescriptor) { this.descriptor = descriptor; }

  async start(context: PlaybackBackendContext): Promise<PlaybackSession> {
    let sessionId = '';
    let closed = false;
    let ready = false;
    let expectedStop = false;
    let loadError: Error | null = null;
    let resolveLoaded!: () => void;
    const loaded = new Promise<void>(resolve => { resolveLoaded = resolve; });
    const unsubscribe = context.electronApi.onVideoPlayerState(update => {
      if (update.playerId !== context.playerId || update.requestId !== context.requestId) return;
      if (sessionId && update.sessionId !== sessionId) return;
      if (update.type === 'stopped' && expectedStop) {
        context.onState(stateEnvelope(context, 'state', { paused: true, time: 0, buffering: false }));
        return;
      }
      if (update.type === 'fatal' || update.type === 'error' || update.type === 'stopped') {
        const error = update.error || '高级视频解码组件意外退出';
        if (ready && !closed) context.onRuntimeFailure(error, update.errorCode || 'BACKEND_CRASHED');
        else { loadError = new PlaybackFailure(update.errorCode || 'DECODE_INITIALIZATION_FAILED', error); resolveLoaded(); }
        return;
      }
      if (update.type === 'file-loaded') resolveLoaded();
      context.onState(update);
    });
    let result;
    const startRequest = context.electronApi.startVideoPlayer(context.filePath, context.settings, context.playerId, context.requestId, this.descriptor.backendId);
    try {
      result = await withPlaybackTimeout(startRequest, 8000, () => new PlaybackFailure('STARTUP_TIMEOUT', '高级视频播放后端启动超时'), context.signal);
    } catch (error) {
      unsubscribe();
      void startRequest.then(late => { if (late.success && late.sessionId) return context.electronApi.stopVideoPlayer(late.sessionId); }, () => undefined);
      throw error;
    }
    if (!result.success || !result.sessionId) {
      unsubscribe();
      throw new PlaybackFailure(result.errorCode || 'BACKEND_UNAVAILABLE', result.error || '高级视频解码组件无法启动', result.recoverable !== false, [], result.suggestedFallback || 'component');
    }
    sessionId = result.sessionId;
    try {
      await withPlaybackTimeout(loaded, 8000, () => new PlaybackFailure('STARTUP_TIMEOUT', '高级视频播放后端打开媒体超时'), context.signal);
      if (loadError) throw loadError;
    } catch (error) {
      unsubscribe();
      await context.electronApi.stopVideoPlayer(sessionId);
      throw error;
    } finally { /* timeout and cancellation cleanup is owned by withPlaybackTimeout */ }
    ready = true;
    return {
      id: sessionId,
      backendId: this.descriptor.backendId,
      control: request => { if (request.action === 'stop') expectedStop = true; else if (request.action === 'play') expectedStop = false; context.electronApi.controlVideoPlayer(sessionId, request); },
      setBounds: bounds => context.electronApi.setVideoPlayerBounds(sessionId, bounds),
      capture: mode => context.electronApi.captureVideoPlayerFrame(sessionId, mode || 'displayedFrame'),
      chooseSubtitle: () => context.electronApi.chooseVideoSubtitle(sessionId),
      close: async () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        context.electronApi.setVideoPlayerBounds(sessionId, { x: 0, y: 0, width: 0, height: 0, visible: false });
        await context.electronApi.stopVideoPlayer(sessionId);
      },
    };
  }
}

const MIME_HINTS: Record<string, string> = {
  '.avi': 'video/x-msvideo', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg',
  '.mts': 'video/mp2t', '.m2ts': 'video/mp2t', '.ogv': 'video/ogg',
  '.ogg': 'video/ogg', '.webm': 'video/webm',
};

export const chromiumContainerProbe = (video: HTMLVideoElement, filePath: string): 'probably' | 'maybe' | 'unknown' => {
  const cleanPath = filePath.split(/[?#]/, 1)[0];
  const dot = cleanPath.lastIndexOf('.');
  const mime = MIME_HINTS[dot >= 0 ? cleanPath.slice(dot).toLowerCase() : ''];
  if (!mime) return 'unknown';
  const result = video.canPlayType(mime);
  return result === 'probably' || result === 'maybe' ? result : 'unknown';
};

export const discoverPlaybackBackends = async (context: Pick<PlaybackBackendContext, 'filePath' | 'video' | 'electronApi'> & { signal?: AbortSignal }): Promise<VideoPlaybackBackend[]> => {
  if (context.signal?.aborted) throw cancelledFailure('播放后端发现已取消');
  const result = await context.electronApi.getVideoPlaybackBackends(context.filePath, chromiumContainerProbe(context.video, context.filePath));
  if (context.signal?.aborted) throw cancelledFailure('播放后端发现已取消');
  if (!result.success) throw new Error(result.error || '无法发现视频播放后端');
  return result.backends.map(descriptor => descriptor.transport === 'chromium'
    ? new ChromiumPlaybackBackend(descriptor)
    : new BrokeredPlaybackBackend(descriptor));
};

const languageMatches = (trackLanguage: string | undefined, preferredLanguage: string) => {
  const track = String(trackLanguage || '').trim().replaceAll('_', '-').toLowerCase();
  const preferred = String(preferredLanguage || '').trim().replaceAll('_', '-').toLowerCase();
  return Boolean(track && preferred && (track === preferred || track.startsWith(`${preferred}-`) || preferred.startsWith(`${track}-`)));
};

const initialSnapshot = (settings: VideoPlaybackSettings): PlaybackSessionSnapshot => ({
  time: 0, paused: false, volume: 100, muted: false, speed: 1,
  subtitle: { mode: 'default', visible: settings.subtitlesEnabled === true, delay: 0 },
  subtitleStyle: { fontSize: settings.subtitleSize, style: settings.subtitleStyle },
  transform: { ...DEFAULT_VIDEO_TRANSFORM }, hdrMode: settings.hdrMode || 'auto', toneMapping: settings.toneMapping || 'auto', targetPeakNits: Math.max(100, Math.min(4000, settings.targetPeakNits || 400)), statisticsLevel: 'off', audio: {},
});
const selectedStableId = (state: VideoPlayerState) => {
  const tracks = state.subtitleTracks || [];
  return (tracks.find(track => track.id === String(state.subtitleTrackId ?? '')) || tracks.find(track => track.selected))?.stableId;
};
const AUTOMATIC_BACKEND_STABILITY_MS = 5000;

export const startPlaybackSession = async ({ backends, context }: {
  backends: VideoPlaybackBackend[];
  context: Omit<PlaybackBackendContext, 'onRuntimeFailure'>;
}): Promise<PlaybackSession> => {
  const automaticallyAttempted = new Set<PlaybackBackendId>();
  const successfulBackends = new Set<PlaybackBackendId>();
  const attempts: PlaybackAttempt[] = [];
  let current: PlaybackSession | null = null;
  let currentTracks: VideoSubtitleTrack[] = [];
  let currentAudioTracks: VideoAudioTrack[] = [];
  let currentSubtitleState: VideoPlayerState | null = null;
  let currentAudioState: VideoPlayerState | null = null;
  let closed = false;
  let switching = false;
  let fallbackPromise: Promise<void> | null = null;
  let manualSwitchPromise: Promise<{ success: boolean; error?: string }> | null = null;
  let suppressBackendState = false;
  let lastError = '';
  let lastBounds: PlaybackBounds | null = null;
  const snapshot = initialSnapshot(context.settings);
  let operationGeneration = 0;
  let operationController = new AbortController();
  let automaticChainResetTimer = 0;
  let pendingRuntimeFailure: { generation: number; backendId: PlaybackBackendId; error: string; code?: PlaybackErrorCode } | null = null;
  let startingBackend: { generation: number; backendId: PlaybackBackendId } | null = null;
  let drainPendingRuntimeFailure = () => undefined;
  const abortOperation = () => operationController.abort();
  context.signal?.addEventListener('abort', abortOperation, { once: true });
  const clearAutomaticChainReset = () => { globalThis.clearTimeout(automaticChainResetTimer); automaticChainResetTimer = 0; };
  const scheduleAutomaticChainReset = (generation: number, backendId: PlaybackBackendId) => {
    clearAutomaticChainReset();
    automaticChainResetTimer = globalThis.setTimeout(() => {
      automaticChainResetTimer = 0;
      if (!operationIsCurrent(generation) || switching || pendingRuntimeFailure || current?.backendId !== backendId) return;
      automaticallyAttempted.clear();
      automaticallyAttempted.add(backendId);
    }, AUTOMATIC_BACKEND_STABILITY_MS);
  };

  const beginOperation = () => {
    clearAutomaticChainReset();
    pendingRuntimeFailure = null;
    startingBackend = null;
    operationController.abort();
    operationController = new AbortController();
    operationGeneration += 1;
    return operationGeneration;
  };
  const operationIsCurrent = (generation: number) => !closed && !context.signal?.aborted && generation === operationGeneration && !operationController.signal.aborted;
  const requireCurrentOperation = (generation: number) => { if (!operationIsCurrent(generation)) throw cancelledFailure('播放后端操作已被新的会话操作替换'); };

  const updateSnapshotFromState = (state: VideoPlayerState) => {
    if (Number.isFinite(state.time)) snapshot.time = Math.max(0, Number(state.time));
    if (typeof state.paused === 'boolean') snapshot.paused = state.paused;
    if (Number.isFinite(state.volume)) snapshot.volume = Math.max(0, Math.min(100, Number(state.volume)));
    if (typeof state.muted === 'boolean') snapshot.muted = state.muted;
    if (Number.isFinite(state.speed)) snapshot.speed = Math.max(0.25, Math.min(4, Number(state.speed)));
    // Before the initial backend is bound, a selected flag is only a decoder
    // fact. It must not replace the application's default subtitle policy.
    const stableId = current ? selectedStableId(state) : undefined;
    if (Number.isFinite(state.subtitleDelay)) snapshot.subtitle.delay = Math.max(-30, Math.min(30, Number(state.subtitleDelay)));
    if (typeof state.subtitleVisible === 'boolean' && (snapshot.subtitle.mode !== 'default' || stableId)) snapshot.subtitle.visible = state.subtitleVisible;
    if (stableId) snapshot.subtitle = { ...snapshot.subtitle, mode: 'track', stableId };
    const audioTracks = state.audioTracks || [];
    const selectedAudio = audioTracks.find(track => track.id === String(state.audioTrackId ?? '')) || audioTracks.find(track => track.selected);
    if (selectedAudio) snapshot.audio = { stableId: selectedAudio.stableId, language: selectedAudio.language };
  };

  const applySubtitleSnapshot = (session: PlaybackSession, tracks: VideoSubtitleTrack[], value = snapshot) => {
    session.control({ action: 'subtitle-delay', value: value.subtitle.delay });
    let track: VideoSubtitleTrack | undefined;
    if (value.subtitle.mode === 'track') track = tracks.find(item => item.stableId === value.subtitle.stableId);
    else if (value.subtitle.mode === 'default' && context.settings.subtitlesEnabled) {
      for (const language of context.settings.subtitlePreferredLanguages || []) {
        track = tracks.find(item => languageMatches(item.language, language));
        if (track) break;
      }
      track ||= tracks[0];
    }
    if (!track || value.subtitle.mode === 'off') {
      session.control({ action: 'subtitle-select', value: '' });
      return;
    }
    value.subtitle = { ...value.subtitle, mode: 'track', stableId: track.stableId };
    session.control({ action: 'subtitle-select', value: track.id });
    session.control({ action: 'subtitle-visible', value: value.subtitle.visible });
  };

  const handleBackendState = (state: VideoPlayerState, generation: number) => {
    if (!operationIsCurrent(generation)) return;
    if (!suppressBackendState) updateSnapshotFromState(state);
    if (state.type === 'subtitle-tracks') {
      currentTracks = state.subtitleTracks || [];
      currentSubtitleState = state;
      if (current) applySubtitleSnapshot(current, currentTracks);
    }
    if (state.type === 'audio-tracks') { currentAudioTracks = state.audioTracks || []; currentAudioState = state; }
    if (!suppressBackendState) context.onState(state);
  };

  const restoreSnapshot = (session: PlaybackSession, value: PlaybackSessionSnapshot) => {
    session.control({ action: 'pause' });
    session.control({ action: 'volume', value: value.volume });
    session.control({ action: 'mute', value: value.muted });
    session.control({ action: 'speed', value: value.speed });
    session.control({ action: 'seek', value: value.time });
    session.control({ action: 'subtitle-style', fontSize: value.subtitleStyle.fontSize, style: value.subtitleStyle.style });
    session.control({ action: 'transform', transform: value.transform });
    session.control({ action: 'hdr-mode', hdrMode: value.hdrMode });
    session.control({ action: 'tone-mapping', toneMapping: value.toneMapping, targetPeakNits: value.targetPeakNits });
    session.control({ action: 'statistics-level', statisticsLevel: value.statisticsLevel });
    applySubtitleSnapshot(session, currentTracks, value);
    const audioTrack = currentAudioTracks.find(item => item.stableId === value.audio.stableId) || currentAudioTracks.find(item => value.audio.language && item.language === value.audio.language);
    if (audioTrack) session.control({ action: 'audio-select', value: audioTrack.id });
    if (!value.paused) session.control({ action: 'play' });
  };

  const startBackend = async (backend: VideoPlaybackBackend, automatic: boolean, generation: number): Promise<PlaybackSession> => {
    requireCurrentOperation(generation);
    startingBackend = { generation, backendId: backend.descriptor.backendId };
    if (automatic) automaticallyAttempted.add(backend.descriptor.backendId);
    const attempt: PlaybackAttempt = { backendId: backend.descriptor.backendId, phase: 'start', startedAt: Date.now(), endedAt: 0, automatic };
    attempts.push(attempt);
    currentTracks = [];
    currentAudioTracks = [];
    currentAudioState = null;
    currentSubtitleState = null;
    try {
      const started = await backend.start({
        ...context,
        signal: operationController.signal,
        onState: state => handleBackendState(state, generation),
        onRuntimeFailure: (error, code) => {
          if (!operationIsCurrent(generation)) return;
          pendingRuntimeFailure = { generation, backendId: backend.descriptor.backendId, error, code };
          queueMicrotask(() => drainPendingRuntimeFailure());
        },
      });
      attempt.endedAt = Date.now();
      if (!operationIsCurrent(generation)) {
        await started.close().catch(() => undefined);
        throw cancelledFailure('播放后端启动已被取消');
      }
      successfulBackends.add(backend.descriptor.backendId);
      return started;
    } catch (error) {
      if (startingBackend?.generation === generation && startingBackend.backendId === backend.descriptor.backendId) startingBackend = null;
      if (pendingRuntimeFailure?.generation === generation && pendingRuntimeFailure.backendId === backend.descriptor.backendId) pendingRuntimeFailure = null;
      const failure = classifyPlaybackError(error, 'BACKEND_UNAVAILABLE'); attempt.endedAt = Date.now(); attempt.errorCode = failure.code; attempt.message = failure.message;
      lastError = failure.message;
      throw failure;
    }
  };

  const startNextAutomatic = async (generation: number): Promise<PlaybackSession> => {
    for (const backend of backends) {
      requireCurrentOperation(generation);
      if (automaticallyAttempted.has(backend.descriptor.backendId)) continue;
      try {
        return await startBackend(backend, true, generation);
      } catch (error) {
        const failure = classifyPlaybackError(error, 'BACKEND_UNAVAILABLE');
        if (failure.code === 'CANCELLED' || !failure.recoverable) throw failure;
      }
    }
    throw new PlaybackFailure('BACKEND_UNAVAILABLE', lastError || 'Chromium 与高级视频解码组件均无法播放此视频', false, attempts.map(item => ({ ...item })), 'system-player');
  };

  const publishRestoredState = () => {
    if (currentSubtitleState) {
      const restoredTrack = currentTracks.find(item => item.stableId === snapshot.subtitle.stableId);
      context.onState({ ...currentSubtitleState, subtitleTrackId: restoredTrack?.id ?? null, subtitleVisible: snapshot.subtitle.visible, subtitleDelay: snapshot.subtitle.delay });
    }
    if (currentAudioState) {
      const restoredAudio = currentAudioTracks.find(item => item.stableId === snapshot.audio.stableId) || currentAudioTracks.find(item => snapshot.audio.language && item.language === snapshot.audio.language);
      context.onState({ ...currentAudioState, audioTrackId: restoredAudio?.id ?? null });
    }
    context.onState(stateEnvelope(context, 'state', {
      time: snapshot.time, paused: snapshot.paused, volume: snapshot.volume, muted: snapshot.muted, speed: snapshot.speed,
      subtitleDelay: snapshot.subtitle.delay, subtitleVisible: snapshot.subtitle.visible, buffering: false,
    }));
  };

  const bindStartedSession = (started: PlaybackSession, generation: number) => {
    current = started;
    if (startingBackend?.generation === generation && startingBackend.backendId === started.backendId) startingBackend = null;
  };
  const installStartedSession = (started: PlaybackSession, generation: number) => {
    bindStartedSession(started, generation);
    if (lastBounds) started.setBounds(lastBounds);
    restoreSnapshot(started, snapshot);
    publishRestoredState();
  };
  const resetAutomaticFailureChain = (backendId: PlaybackBackendId) => {
    automaticallyAttempted.clear();
    automaticallyAttempted.add(backendId);
  };

  const switchAfterFailure = async (error: string, errorCode: PlaybackErrorCode = 'BACKEND_CRASHED') => {
    clearAutomaticChainReset();
    const runtimeFailure = classifyPlaybackError({ code: errorCode, message: error }, 'BACKEND_CRASHED');
    if (closed || switching || runtimeFailure.code === 'CANCELLED') return;
    if (!runtimeFailure.recoverable) {
      if (current) attempts.push({ backendId: current.backendId, phase: 'runtime', startedAt: Date.now(), endedAt: Date.now(), errorCode: runtimeFailure.code, message: runtimeFailure.message, automatic: true });
      const failed = current;
      current = null;
      void failed?.close().catch(() => undefined);
      context.onState(stateEnvelope(context, 'fatal', { errorCode: runtimeFailure.code, suggestedFallback: runtimeFailure.suggestedFallback, attempts: attempts.map(item => ({ ...item })), error: runtimeFailure.message }));
      return;
    }
    switching = true;
    suppressBackendState = true;
    const generation = beginOperation();
    if (current) {
      automaticallyAttempted.add(current.backendId);
      attempts.push({ backendId: current.backendId, phase: 'runtime', startedAt: Date.now(), endedAt: Date.now(), errorCode, message: error, automatic: true });
    }
    lastError = error;
    const failed = current;
    current = null;
    await failed?.close().catch(() => undefined);
    if (!closed) context.onState(stateEnvelope(context, 'loading', { buffering: true, subtitleTracks: [], subtitleTrackId: null, subtitleVisible: false }));
    try {
      const next = await startNextAutomatic(generation);
      requireCurrentOperation(generation);
      installStartedSession(next, generation);
      scheduleAutomaticChainReset(generation, next.backendId);
    } catch (terminalError) {
      const failure = classifyPlaybackError(terminalError, 'BACKEND_UNAVAILABLE');
      if (!closed && failure.code !== 'CANCELLED') context.onState(stateEnvelope(context, 'fatal', { errorCode: failure.recoverable ? 'BACKEND_UNAVAILABLE' : failure.code, suggestedFallback: failure.suggestedFallback === 'none' ? 'system-player' : failure.suggestedFallback, attempts: attempts.map(item => ({ ...item })), error: `视频无法播放：${failure.message}。请安装或修复高级解码组件，或使用系统播放器。` }));
    } finally {
      suppressBackendState = false;
      switching = false;
      queueMicrotask(() => drainPendingRuntimeFailure());
    }
  };
  const beginAutomaticSwitch = (error: string, errorCode: PlaybackErrorCode = 'BACKEND_CRASHED') => {
    if (errorCode === 'CANCELLED') return Promise.resolve();
    if (!fallbackPromise) fallbackPromise = switchAfterFailure(error, errorCode).finally(() => { fallbackPromise = null; queueMicrotask(() => drainPendingRuntimeFailure()); });
    return fallbackPromise;
  };
  drainPendingRuntimeFailure = () => {
    const pending = pendingRuntimeFailure;
    if (!pending || closed || switching || fallbackPromise) return;
    if (!operationIsCurrent(pending.generation)) { pendingRuntimeFailure = null; return; }
    if (startingBackend?.generation === pending.generation && startingBackend.backendId === pending.backendId) return;
    if (current?.backendId !== pending.backendId) { pendingRuntimeFailure = null; return; }
    pendingRuntimeFailure = null;
    void beginAutomaticSwitch(pending.error, pending.code).catch(() => undefined);
  };

  const initialGeneration = beginOperation();
  const initialSession = await startNextAutomatic(initialGeneration);
  bindStartedSession(initialSession, initialGeneration);
  // Native stdout may deliver file-loaded and subtitle-tracks before start()
  // resolves. Apply only the application-owned subtitle policy here; full
  // state restoration is reserved for an actual backend switch.
  if (currentTracks.length) applySubtitleSnapshot(initialSession, currentTracks);
  initialSession.control({ action: 'transform', transform: snapshot.transform });
  initialSession.control({ action: 'hdr-mode', hdrMode: snapshot.hdrMode });
  initialSession.control({ action: 'tone-mapping', toneMapping: snapshot.toneMapping, targetPeakNits: snapshot.targetPeakNits });
  scheduleAutomaticChainReset(initialGeneration, initialSession.backendId);
  queueMicrotask(() => drainPendingRuntimeFailure());

  const performManualSwitch = async (target: VideoPlaybackBackend): Promise<{ success: boolean; error?: string }> => {
    if (closed) return { success: false, error: '视频播放会话已经关闭' };
    const previousBackendId = current?.backendId || '';
    const previousBackend = backends.find(item => item.descriptor.backendId === previousBackendId);
    switching = true;
    suppressBackendState = true;
    const generation = beginOperation();
    const previous = current;
    current = null;
    await previous?.close().catch(() => undefined);
    try {
      const started = await startBackend(target, false, generation);
      requireCurrentOperation(generation);
      installStartedSession(started, generation);
      resetAutomaticFailureChain(started.backendId);
      return { success: true };
    } catch (error) {
      const failure = classifyPlaybackError(error, 'BACKEND_UNAVAILABLE');
      lastError = failure.message;
      let rollbackFailure: PlaybackFailure | null = null;
      if (failure.code !== 'CANCELLED' && operationIsCurrent(generation) && previousBackend && successfulBackends.has(previousBackendId)) {
        try {
          const recovered = await startBackend(previousBackend, false, generation);
          requireCurrentOperation(generation);
          installStartedSession(recovered, generation);
          resetAutomaticFailureChain(recovered.backendId);
        } catch (recoveryError) {
          rollbackFailure = classifyPlaybackError(recoveryError, 'BACKEND_UNAVAILABLE');
          lastError = rollbackFailure.message;
        }
      }
      if (!closed && failure.code !== 'CANCELLED' && !current) {
        const compositeError = rollbackFailure
          ? `切换至 ${target.descriptor.displayName || target.descriptor.backendId} 失败：${failure.message}；恢复 ${previousBackend?.descriptor.displayName || previousBackendId || '原播放后端'} 失败：${rollbackFailure.message}`
          : `切换至 ${target.descriptor.displayName || target.descriptor.backendId} 失败：${failure.message}；没有可恢复的播放后端`;
        lastError = compositeError;
        context.onState(stateEnvelope(context, 'fatal', { errorCode: 'BACKEND_UNAVAILABLE', suggestedFallback: 'system-player', attempts: attempts.map(item => ({ ...item })), error: compositeError }));
        return { success: false, error: compositeError };
      }
      return { success: false, error: failure.message || '无法切换播放后端' };
    } finally {
      suppressBackendState = false;
      switching = false;
      queueMicrotask(() => drainPendingRuntimeFailure());
    }
  };

  return {
    get id() { return current?.id || context.requestId; },
    get backendId() { return current?.backendId || 'unavailable'; },
    get attempts() { return attempts.map(item => ({ ...item })); },
    control: request => {
      if (request.action === 'play') snapshot.paused = false;
      else if (request.action === 'pause') snapshot.paused = true;
      else if (request.action === 'stop') { snapshot.paused = true; snapshot.time = 0; }
      else if (request.action === 'seek') snapshot.time = Math.max(0, Number(request.value) || 0);
      else if (request.action === 'volume') snapshot.volume = Math.max(0, Math.min(100, Number(request.value) || 0));
      else if (request.action === 'mute') snapshot.muted = Boolean(request.value);
      else if (request.action === 'speed') snapshot.speed = Math.max(0.25, Math.min(4, Number(request.value) || 1));
      else if (request.action === 'subtitle-delay') snapshot.subtitle.delay = Math.max(-30, Math.min(30, Number(request.value) || 0));
      else if (request.action === 'subtitle-visible') snapshot.subtitle.visible = Boolean(request.value);
      else if (request.action === 'subtitle-select') {
        const track = currentTracks.find(item => item.id === String(request.value || ''));
        snapshot.subtitle = track ? { ...snapshot.subtitle, mode: 'track', stableId: track.stableId } : { ...snapshot.subtitle, mode: 'off', stableId: undefined, visible: false };
      } else if (request.action === 'subtitle-style') snapshot.subtitleStyle = { fontSize: request.fontSize ?? snapshot.subtitleStyle.fontSize, style: request.style ?? snapshot.subtitleStyle.style };
      else if (request.action === 'audio-select') { const track = currentAudioTracks.find(item => item.id === String(request.value || '')); if (track) snapshot.audio = { stableId: track.stableId, language: track.language }; }
      else if (request.action === 'transform') snapshot.transform = normalizeVideoTransform(request.transform);
      else if (request.action === 'hdr-mode') snapshot.hdrMode = request.hdrMode || 'auto';
      else if (request.action === 'tone-mapping') { snapshot.toneMapping = request.toneMapping || 'auto'; snapshot.targetPeakNits = Math.max(100, Math.min(4000, request.targetPeakNits || 400)); }
      else if (request.action === 'statistics-level') snapshot.statisticsLevel = request.statisticsLevel || 'off';
      current?.control(request);
      if (request.action === 'stop') context.onState(stateEnvelope(context, 'state', { paused: true, time: 0, buffering: false }));
    },
    setBounds: bounds => {
      lastBounds = bounds;
      current?.setBounds(bounds);
    },
    capture: async mode => {
      const session = current;
      const generation = operationGeneration;
      if (!session) return { success: false, error: '视频播放会话不存在' };
      const result = await session.capture(mode);
      return current === session && operationGeneration === generation && !closed ? result : { success: false, error: '截图所属播放会话已结束' };
    },
    chooseSubtitle: async () => {
      const session = current;
      const generation = operationGeneration;
      if (!session) return { success: false, error: '视频播放会话不存在' };
      const result = await session.chooseSubtitle();
      return current === session && operationGeneration === generation && !closed ? result : { success: false, cancelled: true, error: '字幕选择所属播放会话已结束' };
    },
    availableBackends: backends.map(item => item.descriptor),
    switchBackend: async backendId => {
      if (closed) return { success: false, error: '视频播放会话已经关闭' };
      if (current?.backendId === backendId) return { success: true };
      const target = backends.find(item => item.descriptor.backendId === backendId);
      if (!target) return { success: false, error: '播放后端不存在' };
      if (fallbackPromise) await fallbackPromise;
      if (closed) return { success: false, error: '视频播放会话已经关闭' };
      if (manualSwitchPromise || switching) return { success: false, error: '播放后端正在切换' };
      manualSwitchPromise = performManualSwitch(target);
      try { return await manualSwitchPromise; }
      finally { manualSwitchPromise = null; }
    },
    close: async () => {
      closed = true;
      context.signal?.removeEventListener('abort', abortOperation);
      operationController.abort();
      operationGeneration += 1;
      clearAutomaticChainReset();
      pendingRuntimeFailure = null;
      startingBackend = null;
      const active = current;
      current = null;
      let closeError: unknown;
      try { await active?.close(); } catch (error) { closeError = error; }
      finally {
        try { await fallbackPromise; } catch (error) { closeError ||= error; }
        finally { try { await manualSwitchPromise; } catch (error) { closeError ||= error; } }
      }
      if (closeError) throw closeError;
    },
  };
};
