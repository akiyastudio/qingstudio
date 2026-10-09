import assert from 'node:assert/strict';
import {
  BUILTIN_VIDEO_TRANSCODE_PRESETS, formatMediaBytes, normalizeVideoTranscodeSettings,
  readCustomVideoTranscodePresets, videoTranscodeBlockingErrors, videoTranscodeWarnings, writeCustomVideoTranscodePresets,
} from '../src/features/tools/video-transcode-model.ts';

const legacy = normalizeVideoTranscodeSettings({ videoMode: 'h265', audioMode: 'copy' });
assert.equal(legacy.colorMode, 'auto');
assert.equal(legacy.retryCount, 1);
assert.equal(normalizeVideoTranscodeSettings({ colorMode: 'hdr-to-sdr' }).colorMode, 'sdr');
assert.equal(normalizeVideoTranscodeSettings({ colorMode: 'hdr10', bitDepth: '8' }).bitDepth, '10');
assert.equal(normalizeVideoTranscodeSettings({ videoMode: 'prores', bitDepth: '8', container: 'mp4' }).bitDepth, '10');
assert.equal(normalizeVideoTranscodeSettings({ videoMode: 'prores', container: 'mp4' }).container, 'mov');
assert.equal(normalizeVideoTranscodeSettings({ videoMode: 'av1', container: 'mov' }).container, 'mp4');
assert.equal(normalizeVideoTranscodeSettings({ videoMode: 'copy', subtitleMode: 'burn' }).subtitleMode, 'copy');
assert.equal(normalizeVideoTranscodeSettings({ retryCount: 3 }).retryCount, 3);
assert.equal(BUILTIN_VIDEO_TRANSCODE_PRESETS.length, 6);
const dolby = BUILTIN_VIDEO_TRANSCODE_PRESETS.find(preset => preset.id === 'dolby-vision-phone').settings;
assert.equal(dolby.colorMode, 'dolby-vision');
assert.equal(normalizeVideoTranscodeSettings(dolby).colorMode, 'dolby-vision');
assert.deepEqual(videoTranscodeBlockingErrors(dolby), []);
assert(videoTranscodeBlockingErrors({ ...dolby, resolution: '720p' }).length);
assert(videoTranscodeBlockingErrors(dolby, { dolbyVision: false }).some(error => error.includes('Dolby Vision')));
assert(videoTranscodeBlockingErrors(dolby, null, [{ codec: 'hevc', pixelFormat: 'yuv420p10le', dolbyVision: { profile: 8, compatibilityId: 1 } }]).length);
assert.equal(formatMediaBytes(1024 ** 3), '1.00 GiB');
assert(videoTranscodeWarnings({ ...legacy, videoMode: 'av1' }, { av1Hardware: false, hevc10Bit: false, hdrToneMap: true, subtitleBurn: true, encoders: [], pixelFormats: {}, filters: [] }).some(value => value.includes('AV1')));
assert(videoTranscodeBlockingErrors(
  { ...legacy, videoMode: 'h264', colorMode: 'auto' },
  null,
  [{ hdr: true }],
).some(value => value.includes('无法保留')));

const values = new Map();
const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
writeCustomVideoTranscodePresets(storage, [{ id: 'mine', name: '我的 HDR', settings: legacy }]);
assert.equal(readCustomVideoTranscodePresets(storage)[0].name, '我的 HDR');
console.log('Video transcode model tests passed.');
