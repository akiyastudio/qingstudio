import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, SyntheticEvent } from 'react';
import { Play } from 'lucide-react';

let activeHoverVideo: HTMLVideoElement | null = null;

const hoverTargetTime = (duration: number, ratio: number) => {
  const endBuffer = Math.max(0.05, Math.min(0.5, duration * 0.01));
  return Math.min(Math.max(0, duration - endBuffer), ratio * duration);
};

type VideoHoverThumbnailProps = {
  src: string;
  poster?: string;
  name: string;
  large: boolean;
  initialRatio: number;
  onError: () => void;
};

const VideoHoverThumbnail = ({ src, poster, name, large, initialRatio, onError }: VideoHoverThumbnailProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onErrorRef = useRef(onError);
  const ratioRef = useRef(initialRatio);
  const seekFrameRef = useRef<number>();
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  onErrorRef.current = onError;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let active = true;
    ratioRef.current = initialRatio;
    setDuration(0);
    setTime(0);
    setPlaying(false);
    const beginPlayback = () => {
      if (!active) return;
      if (activeHoverVideo && activeHoverVideo !== video) activeHoverVideo.pause();
      activeHoverVideo = video;
      video.play().catch(() => { if (active) onErrorRef.current(); });
    };
    const seekBeforePlayback = () => {
      if (!active || !Number.isFinite(video.duration) || video.duration <= 0) return;
      const target = hoverTargetTime(video.duration, ratioRef.current);
      setDuration(video.duration);
      setTime(target);
      if (Math.abs(video.currentTime - target) <= 0.04) { beginPlayback(); return; }
      video.addEventListener('seeked', beginPlayback, { once: true });
      video.currentTime = target;
    };
    const preparePlayback = () => {
      if (!active) return;
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        video.addEventListener('loadeddata', seekBeforePlayback, { once: true });
        return;
      }
      seekBeforePlayback();
    };
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) preparePlayback();
    else video.addEventListener('loadedmetadata', preparePlayback, { once: true });
    return () => {
      active = false;
      video.removeEventListener('loadedmetadata', preparePlayback);
      video.removeEventListener('loadeddata', seekBeforePlayback);
      video.removeEventListener('seeked', beginPlayback);
      video.pause();
      if (activeHoverVideo === video) activeHoverVideo = null;
      if (seekFrameRef.current !== undefined) window.cancelAnimationFrame(seekFrameRef.current);
    };
  }, [initialRatio, src]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const update = () => {
      const video = videoRef.current;
      if (video) setTime(video.currentTime);
      frame = window.requestAnimationFrame(update);
    };
    frame = window.requestAnimationFrame(update);
    return () => window.cancelAnimationFrame(frame);
  }, [playing]);

  const seekToRatio = (ratio: number) => {
    const video = videoRef.current;
    ratioRef.current = ratio;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    if (seekFrameRef.current !== undefined) window.cancelAnimationFrame(seekFrameRef.current);
    seekFrameRef.current = window.requestAnimationFrame(() => {
      seekFrameRef.current = undefined;
      const target = hoverTargetTime(video.duration, ratio);
      video.currentTime = target;
      setTime(target);
    });
  };
  const updatePointerRatio = (clientX: number) => {
    const rect = videoRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    if (Math.abs(ratio - ratioRef.current) >= 0.002) seekToRatio(ratio);
  };
  const seekVideo = (event: ChangeEvent<HTMLInputElement>) => {
    event.stopPropagation();
    const video = videoRef.current;
    if (!video) return;
    const nextTime = Number(event.currentTarget.value);
    video.currentTime = nextTime;
    if (video.duration > 0) ratioRef.current = nextTime / video.duration;
    setTime(nextTime);
  };
  const restartPlayback = (event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    const target = hoverTargetTime(video.duration, ratioRef.current);
    video.currentTime = target;
    setTime(target);
    video.play().catch(() => onErrorRef.current());
  };
  const progress = duration > 0 ? Math.min(100, Math.max(0, time / duration * 100)) : 0;

  return <span onMouseMove={event => { if (!(event.target as HTMLElement).closest('input[type="range"]')) updatePointerRatio(event.clientX); }} className="absolute inset-0 z-[1] flex items-center justify-center overflow-hidden bg-black/5">
    <video ref={videoRef} key={src} src={src} muted playsInline preload="auto" poster={poster} draggable={false} className="h-full w-full object-contain" onLoadedMetadata={event => setDuration(event.currentTarget.duration)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={restartPlayback} onError={() => onErrorRef.current()}/>
    {!playing && <Play size={large ? 25 : 15} fill="currentColor" className="pointer-events-none absolute text-white drop-shadow-[0_1px_4px_rgba(0,0,0,.8)]"/>}
    {duration > 0 && <span className="absolute inset-x-0 bottom-0 z-10 flex items-center gap-1.5 bg-gradient-to-t from-black/85 to-black/20 px-2 pb-1.5 pt-3" onMouseMove={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
      <input type="range" min="0" max={duration} step="0.05" value={Math.min(time, duration)} onChange={seekVideo} aria-label={`调整 ${name} 的播放进度`} className="video-hover-seek min-w-0 flex-1" style={{ '--seek-progress': `${progress}%` } as React.CSSProperties}/>
    </span>}
  </span>;
};

export { VideoHoverThumbnail };
