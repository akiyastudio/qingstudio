export function livePhotoFinished(value: { time: number; duration: number; paused: boolean; frameRate?: number }, sawMotion: boolean) {
  if (!sawMotion || !value.paused || !Number.isFinite(value.duration) || value.duration <= 0 || !Number.isFinite(value.time)) return false;
  // Native players with keep-open stop at the last frame's timestamp, not at
  // duration. A fixed 40 ms window misses 24/15 fps movies and VFR Live Photos.
  const fps = value.frameRate && Number.isFinite(value.frameRate) && value.frameRate > 0 ? value.frameRate : 24;
  const tolerance = Math.min(value.duration / 4, Math.max(.1, Math.min(.25, 2 / fps)));
  return value.time >= value.duration - tolerance;
}
