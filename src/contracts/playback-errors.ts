export const PLAYBACK_ERROR_CODES = ['BACKEND_UNAVAILABLE','UNSUPPORTED_CONTAINER','UNSUPPORTED_CODEC','DECODE_INITIALIZATION_FAILED','HARDWARE_DECODING_FAILED','RENDER_INITIALIZATION_FAILED','SURFACE_LOST','GPU_DEVICE_LOST','CORRUPT_MEDIA','MEDIA_IO_FAILED','PERMISSION_DENIED','STARTUP_TIMEOUT','CANCELLED','BACKEND_CRASHED'] as const;
export type PlaybackErrorCode = typeof PLAYBACK_ERROR_CODES[number];
export type PlaybackFallbackSuggestion = 'chromium'|'component'|'system-player'|'none';
export type PlaybackAttempt = { backendId:string; phase:'probe'|'start'|'runtime'|'release'; startedAt:number; endedAt:number; errorCode?:PlaybackErrorCode; message?:string; automatic:boolean };
export type PlaybackResult<T> = { success:true; value:T; attempts:PlaybackAttempt[] } | { success:false; error:{ code:PlaybackErrorCode; message:string; recoverable:boolean; suggestedFallback:PlaybackFallbackSuggestion }; attempts:PlaybackAttempt[] };

const LEGACY: Record<string, PlaybackErrorCode> = { START_TIMEOUT:'STARTUP_TIMEOUT',MEDIA_UNSUPPORTED:'UNSUPPORTED_CODEC',DECODE_FAILED:'DECODE_INITIALIZATION_FAILED',INPUT_REVOKED:'PERMISSION_DENIED',CAPTURE_FAILED:'MEDIA_IO_FAILED',RESOURCE_RELEASE_FAILED:'BACKEND_CRASHED',ALL_BACKENDS_FAILED:'BACKEND_UNAVAILABLE' };
const ERROR_CODE_SET: ReadonlySet<string> = new Set(PLAYBACK_ERROR_CODES);
const FALLBACK_SET: ReadonlySet<string> = new Set(['chromium','component','system-player','none']);
const stableCode = (value: unknown): PlaybackErrorCode | undefined => {
  const raw = String(value || '').trim().toUpperCase();
  const mapped = LEGACY[raw] || raw;
  return ERROR_CODE_SET.has(mapped) ? mapped as PlaybackErrorCode : undefined;
};
const stableMessage = (value: unknown) => {
  const candidate = value instanceof Error ? value.message : typeof value === 'string' ? value : value && typeof value === 'object' ? (value as { message?: unknown }).message : undefined;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : '视频播放失败';
};
const fallbackForCode = (code: PlaybackErrorCode): PlaybackFallbackSuggestion => code === 'CANCELLED' ? 'none' : code === 'CORRUPT_MEDIA' || code === 'PERMISSION_DENIED' ? 'system-player' : 'component';
const stableFallback = (value: unknown, code: PlaybackErrorCode) => {
  const fallback = String(value || '').trim().toLowerCase();
  return FALLBACK_SET.has(fallback) ? fallback as PlaybackFallbackSuggestion : fallbackForCode(code);
};

export class PlaybackFailure extends Error {
  readonly code: PlaybackErrorCode;
  readonly recoverable: boolean;
  readonly suggestedFallback: PlaybackFallbackSuggestion;
  readonly attempts: PlaybackAttempt[];
  constructor(code: PlaybackErrorCode|string, message: string, recoverable?: boolean, attempts: PlaybackAttempt[] = [], suggestedFallback?: PlaybackFallbackSuggestion) {
    const normalizedMessage = stableMessage(message);
    super(normalizedMessage);
    this.name = 'PlaybackFailure';
    this.code = stableCode(code) || classifyPlaybackError(normalizedMessage).code;
    this.recoverable = recoverable ?? !['CANCELLED','CORRUPT_MEDIA','PERMISSION_DENIED'].includes(this.code);
    this.attempts = attempts;
    this.suggestedFallback = stableFallback(suggestedFallback, this.code);
  }
}

export const classifyPlaybackError = (value: unknown, fallback: PlaybackErrorCode = 'DECODE_INITIALIZATION_FAILED'): PlaybackFailure => {
  if (value instanceof PlaybackFailure) return value;
  const raw = value && typeof value === 'object' ? value as { code?:unknown; message?:unknown } : {};
  const message = stableMessage(value);
  const text = message.toLowerCase();
  let code = stableCode(raw.code);
  if (!code) code = /cancel|取消|替换|关闭/.test(text)?'CANCELLED':/timeout|timed out|超时/.test(text)?'STARTUP_TIMEOUT':/permission|access denied|eacces|eperm|拒绝访问|授权/.test(text)?'PERMISSION_DENIED':/hardware decode|hwdec|硬件解码/.test(text)?'HARDWARE_DECODING_FAILED':/render initialization|render init|渲染初始化/.test(text)?'RENDER_INITIALIZATION_FAILED':/gpu|device lost|d3d/.test(text)?'GPU_DEVICE_LOST':/surface|hwnd|表面/.test(text)?'SURFACE_LOST':/container|容器/.test(text)?'UNSUPPORTED_CONTAINER':/codec|编码/.test(text)?'UNSUPPORTED_CODEC':/corrupt|损坏/.test(text)?'CORRUPT_MEDIA':/(?:^|\W)(?:eio|i\/o|io error|read error|write error)(?:\W|$)|读取|文件读写/.test(text)?'MEDIA_IO_FAILED':/missing|enoent|未安装|不可用/.test(text)?'BACKEND_UNAVAILABLE':stableCode(fallback)||'DECODE_INITIALIZATION_FAILED';
  const recoverable = !['CANCELLED','CORRUPT_MEDIA','PERMISSION_DENIED'].includes(code);
  return new PlaybackFailure(code, message, recoverable, [], fallbackForCode(code));
};
