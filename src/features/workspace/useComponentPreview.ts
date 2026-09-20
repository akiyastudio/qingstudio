import { useEffect, useRef, useState } from 'react';
import type { PreviewPageContext, PreviewVideo } from '../../contracts/component-preview';
let sequence = Date.now() * 1000;
export const useComponentPreview = (context: PreviewPageContext | undefined, relativePath: string | undefined, enabled: boolean) => {
  const [seek, setSeek] = useState<{ id: number; time: number }>();
  const current = useRef<{ sessionId: string; video: PreviewVideo; publish: () => void } | null>(null);
  const contextKey = JSON.stringify(context);
  useEffect(() => {
    if (!context) return;
    const video: PreviewVideo = { sessionId: crypto.randomUUID(), relativePath: relativePath || '', time: 0, duration: 0, paused: true, canSeek: false };
    let alive = true;
    const publish = () => { if (alive) void window.electronAPI.publishComponentPreview({ context, update: { sequence: ++sequence, video: enabled && relativePath ? { ...video } : null } }).catch(() => undefined); };
    const value = { sessionId: video.sessionId, video, publish }; current.current = value;
    setSeek(undefined); publish();
    const interval = enabled ? window.setInterval(publish, 250) : 0;
    const stop = window.electronAPI.onComponentPreviewSeek(command => {
      if (command.sourcePageId !== context.sourcePageId) return;
      const accepted = alive && enabled && command.sessionId === video.sessionId && video.canSeek && command.time >= 0 && command.time <= video.duration;
      if (accepted) setSeek({ id: ++sequence, time: command.time });
      window.electronAPI.acknowledgeComponentPreviewSeek({ requestId: command.requestId, accepted });
    });
    return () => { alive = false; stop(); window.clearInterval(interval); if (current.current === value) current.current = null; void window.electronAPI.publishComponentPreview({ context, update: { sequence: ++sequence, video: null, closed: true } }).catch(() => undefined); };
  }, [contextKey, relativePath, enabled]);
  return { seek, onPlaybackState: (value: { time: number; duration: number; paused: boolean }) => { if (current.current) Object.assign(current.current.video, { time: value.time, duration: value.duration, paused: value.paused, canSeek: value.duration > 0 }); } };
};
