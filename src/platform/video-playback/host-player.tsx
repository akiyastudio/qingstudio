import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { VideoPlayer } from '../../components/AdvancedVideoPlayer';
import { LayerProvider } from '../../components/LayerProvider';
import type { PlaybackControl, PlaybackSession } from './playback-session';

export const apiVersion = 1;
export type Options = {
  apiVersion: 1;
  filePath: string;
  electronApi: Window['electronAPI'];
  timeline?: HTMLElement;
  surfaceOverlay?: HTMLElement;
  toolbar?: HTMLElement;
  playbackEnabled?: boolean;
  controlsVisible?: boolean;
  externalTimeline?: boolean;
  editorState?: { time: number; duration: number; paused: boolean; ready: boolean };
  onControlRequest?: (control: PlaybackControl) => boolean;
  onReady?: (value: { backendId: string }) => void;
  onMetadata?: (value: { width?: number; height?: number; duration?: number }) => void;
  onState: (value: { time: number; duration: number; paused: boolean; frameRate?: number }) => void;
  onError: (message: string) => void;
  onNavigate?: (direction: -1 | 1) => void;
};

// The Host supplies this bundle. Every mount keeps its own capability facade;
// never install a plugin facade on window.electronAPI.
export function mount(element: HTMLElement, options: Options) {
  if (options.apiVersion !== apiVersion) throw new Error('播放器接口版本不兼容，请更新主程序和插件');
  element.classList.add('photoflow-player');
  const root = createRoot(element);
  let revision = 0, closed = false;
  let session: PlaybackSession | null = null;
  let command: { id: number; control: PlaybackControl } | undefined;
  let seekRequest: { id: number; time: number; play: boolean } | undefined;
  let latest = { time: 0, duration: 0, paused: true };
  const pending = new Set<{ resolve: (time: number) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const pendingFrames = new Set<() => void>();
  const onState = (value: typeof latest) => {
    latest = value; options.onState(value);
    if (value.paused) for (const waiter of pending) { clearTimeout(waiter.timer); waiter.resolve(value.time); pending.delete(waiter); }
  };
  const fullscreen = () => {
    if (session && session.backendId !== 'core.chromium') { session.control({ action: 'fullscreen' }); return; }
    if (document.fullscreenElement) void document.exitFullscreen().catch(error => options.onError(error.message));
    else void element.requestFullscreen().catch(error => options.onError(error.message));
  };
  const attach = (node: HTMLElement | null, child?: HTMLElement) => { if (node && child && child.parentElement !== node) node.append(child); };
  const render = () => root.render(<LayerProvider electronApi={options.electronApi}><VideoPlayer
    electronApi={options.electronApi} filePath={options.filePath} playbackEnabled={options.playbackEnabled} controlsVisible={options.controlsVisible}
    editorState={options.editorState} onControlRequest={options.onControlRequest}
    onSessionReady={value => { session = value; options.onReady?.({ backendId: value.backendId }); }}
    onError={options.onError} onMetadata={value => options.onMetadata?.(value)}
    onPlaybackState={onState} onNavigate={options.onNavigate}
    onToggleFullscreen={fullscreen} onEscape={() => { if (document.fullscreenElement) void document.exitFullscreen(); if (session?.backendId !== 'core.chromium') session?.control({ action: 'fullscreen', value: false }); }}
    editorControlRequest={command} editorSeekRequest={seekRequest}
    externalTimeline={options.externalTimeline ?? Boolean(options.timeline)} editingTransport frameControlsVisible={!options.timeline}
    progressRail={options.timeline ? <div className="shared-player-progress" ref={node => attach(node, options.timeline)}/> : undefined}
    toolbarExtras={options.toolbar ? <div ref={node => attach(node, options.toolbar)}/> : undefined}
  /></LayerProvider>);
  const attachOverlay = () => attach(element.querySelector('[data-video-player] > [role=button]'), options.surfaceOverlay);
  const refreshBounds = () => window.dispatchEvent(new Event('resize'));
  document.addEventListener('fullscreenchange', refreshBounds);
  flushSync(render); attachOverlay();
  return {
    update(patch: Partial<Omit<Options, 'apiVersion' | 'electronApi'>>) {
      if (closed) return;
      if (patch.playbackEnabled === false || patch.filePath !== undefined && patch.filePath !== options.filePath) {
        for (const cancel of pendingFrames) cancel();
        session = null;
      }
      options = { ...options, ...patch }; flushSync(render); attachOverlay();
    },
    get backendId() { return session?.backendId; },
    refreshBounds,
    frameAt(time: number): Promise<string | null> {
      if (closed) return Promise.reject(new Error('视频已关闭'));
      if (!Number.isFinite(time) || time < 0) return Promise.reject(new Error('取帧时间无效'));
      const video = element.querySelector('video');
      if (session?.backendId !== 'core.chromium' || !video) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer); video.removeEventListener('seeked', ready); video.removeEventListener('loadeddata', ready); pendingFrames.delete(cancel);
          if (error) { reject(error); return; }
          try {
            const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
            const context = canvas.getContext('2d');
            if (!context || !canvas.width || !canvas.height) { resolve(null); return; }
            context.drawImage(video, 0, 0); resolve(canvas.toDataURL('image/png'));
          } catch { resolve(null); }
        };
        const ready = () => {
          if (!video.seeking && video.readyState >= 2) finish(Math.abs(video.currentTime - time) > 0.01 ? new Error('无法跳转到指定帧') : undefined);
        };
        const cancel = () => finish(new Error('视频已关闭'));
        const timer = setTimeout(() => finish(new Error('读取当前帧超时')), 5000);
        pendingFrames.add(cancel); video.addEventListener('seeked', ready); video.addEventListener('loadeddata', ready);
        session?.control({ action: 'pause' }); session?.control({ action: 'seek', value: time }); ready();
      });
    },
    control(control: PlaybackControl) { if (!closed) { command = { id: ++revision, control }; flushSync(render); } },
    playFrom(time: number) { if (!closed) { seekRequest = { id: ++revision, time, play: true }; flushSync(render); } },
    async pauseAtFrame() {
      if (closed) throw new Error('视频已关闭');
      const video = element.querySelector('video');
      if (video && video.readyState > 0) { this.control({ action: 'pause' }); return video.currentTime; }
      if (latest.paused) return latest.time;
      return new Promise<number>((resolve, reject) => {
        const waiter = { resolve, reject, timer: setTimeout(() => { pending.delete(waiter); reject(new Error('未能确认当前帧，请暂停视频后重试')); }, 2500) };
        pending.add(waiter); this.control({ action: 'pause' });
      });
    },
    fullscreen,
    close() {
      if (closed) return;
      closed = true; document.removeEventListener('fullscreenchange', refreshBounds);
      for (const cancel of pendingFrames) cancel();
      if (document.fullscreenElement && element.contains(document.fullscreenElement)) void document.exitFullscreen().catch(() => {});
      for (const waiter of pending) { clearTimeout(waiter.timer); waiter.reject(new Error('视频已切换')); }
      pending.clear(); options.timeline?.remove(); options.toolbar?.remove(); options.surfaceOverlay?.remove(); root.unmount(); session = null;
    },
  };
}
