const CODES = new Set(['BACKEND_UNAVAILABLE', 'UNSUPPORTED_CONTAINER', 'UNSUPPORTED_CODEC', 'DECODE_INITIALIZATION_FAILED', 'HARDWARE_DECODING_FAILED', 'RENDER_INITIALIZATION_FAILED', 'SURFACE_LOST', 'GPU_DEVICE_LOST', 'CORRUPT_MEDIA', 'MEDIA_IO_FAILED', 'PERMISSION_DENIED', 'STARTUP_TIMEOUT', 'CANCELLED', 'BACKEND_CRASHED']);
const LEGACY = Object.freeze({ START_TIMEOUT: 'STARTUP_TIMEOUT', MEDIA_UNSUPPORTED: 'UNSUPPORTED_CODEC', DECODE_FAILED: 'DECODE_INITIALIZATION_FAILED', INPUT_REVOKED: 'PERMISSION_DENIED', CAPTURE_FAILED: 'MEDIA_IO_FAILED', RESOURCE_RELEASE_FAILED: 'BACKEND_CRASHED', ALL_BACKENDS_FAILED: 'BACKEND_UNAVAILABLE' });

const normalizeCode = value => {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return LEGACY[code] || code;
};

const playbackError = (value, fallback = 'DECODE_INITIALIZATION_FAILED') => {
  const rawMessage = value && typeof value === 'object' && typeof value.message === 'string' ? value.message : typeof value === 'string' ? value : '';
  const message = rawMessage.trim() || '视频播放失败';
  const text = message.toLowerCase();
  let code = normalizeCode(value?.code);
  const candidateFallback = normalizeCode(fallback);
  const normalizedFallback = CODES.has(candidateFallback) ? candidateFallback : 'DECODE_INITIALIZATION_FAILED';
  if (!CODES.has(code)) {
    code = /cancel|取消|替换|关闭/.test(text) ? 'CANCELLED'
      : /timeout|timed out|超时/.test(text) ? 'STARTUP_TIMEOUT'
        : /permission|access denied|eacces|eperm|拒绝访问|授权/.test(text) ? 'PERMISSION_DENIED'
          : /hardware decode|hwdec|硬件解码/.test(text) ? 'HARDWARE_DECODING_FAILED'
            : /render initialization|render init|渲染初始化/.test(text) ? 'RENDER_INITIALIZATION_FAILED'
              : /gpu|device lost|d3d/.test(text) ? 'GPU_DEVICE_LOST'
                : /surface|hwnd|表面/.test(text) ? 'SURFACE_LOST'
                  : /container|容器/.test(text) ? 'UNSUPPORTED_CONTAINER'
                    : /codec|编码/.test(text) ? 'UNSUPPORTED_CODEC'
                      : /corrupt|损坏/.test(text) ? 'CORRUPT_MEDIA'
                        : /(?:^|\W)(?:eio|i\/o|io error|read error|write error)(?:\W|$)|读取|文件读写/.test(text) ? 'MEDIA_IO_FAILED'
                          : /missing|enoent|未安装|不可用/.test(text) ? 'BACKEND_UNAVAILABLE'
                            : normalizedFallback;
  }
  const recoverable = !['CANCELLED', 'CORRUPT_MEDIA', 'PERMISSION_DENIED'].includes(code);
  const suggestedFallback = code === 'CANCELLED' ? 'none' : code === 'CORRUPT_MEDIA' || code === 'PERMISSION_DENIED' ? 'system-player' : 'component';
  return { code, message, recoverable, suggestedFallback };
};

module.exports = { PLAYBACK_ERROR_CODES: CODES, playbackError };
