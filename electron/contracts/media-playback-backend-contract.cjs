const PLAYBACK_BACKEND_CONTRIBUTION_TYPE = 'media.playbackBackend';
const PLAYBACK_BACKEND_PROTOCOL_VERSION = 1;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const EXTENSION = /^\.[a-z0-9]{1,12}$/;
const MEDIA_TOKEN = /^[a-z0-9][a-z0-9.+_-]{0,63}$/i;
const ASPECT_MODES = new Set(['source', 'contain', 'cover', '16:9', '4:3', '1:1']);
const TONE_MAPPING_ALGORITHMS = new Set(['auto', 'bt2390', 'reinhard', 'mobius', 'hable']);

const exactObject = (value, allowed, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid media playback backend ${label}`);
  const unknown = Object.keys(value).filter(field => !allowed.includes(field));
  if (unknown.length) throw new Error(`Unknown media playback backend ${label} field: ${unknown[0]}`);
  return value;
};
const normalizedInteger = value => {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : NaN;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return NaN;
  const result = Number(value.trim());
  return Number.isSafeInteger(result) ? result : NaN;
};
const boundedUniqueStrings = (value, { label, pattern = MEDIA_TOKEN, allowed = null, min = 1, max = 64 }) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`Invalid media playback backend ${label}`);
  if (value.some(item => typeof item !== 'string')) throw new Error(`Invalid media playback backend ${label}`);
  const result = value.map(item => item.toLowerCase());
  if (new Set(result).size !== result.length || result.some(item => allowed ? !allowed.has(item) : !pattern.test(item))) throw new Error(`Invalid media playback backend ${label}`);
  return Object.freeze(result);
};

const parseFeatures = value => {
  const raw = exactObject(value, ['transforms', 'hdr', 'statistics', 'subtitles', 'hardwareDecoding', 'capture'], 'features');
  const transforms = exactObject(raw.transforms, ['aspectModes', 'rotation', 'flip', 'crop'], 'transform features');
  const hdr = exactObject(raw.hdr, ['passthrough', 'toneMapping', 'algorithms', 'targetPeakControl'], 'HDR features');
  const statistics = exactObject(raw.statistics, ['basic', 'decode', 'hdr', 'timing', 'cache', 'gpu', 'maxUpdateHz'], 'statistics features');
  const subtitles = exactObject(raw.subtitles, ['embedded', 'external', 'ass', 'styles'], 'subtitle features');
  const hardwareDecoding = exactObject(raw.hardwareDecoding, ['supported', 'selectable', 'softwareFallback'], 'hardware decoding features');
  const capture = exactObject(raw.capture, ['sourceFrame', 'displayedFrame'], 'capture features');
  const maxUpdateHz = Number(statistics.maxUpdateHz);
  if (!Number.isFinite(maxUpdateHz) || maxUpdateHz < 0.2 || maxUpdateHz > 4) throw new Error('Invalid media playback backend statistics maxUpdateHz');
  const flags = [transforms.rotation, transforms.flip, transforms.crop, hdr.passthrough, hdr.toneMapping, hdr.targetPeakControl, statistics.basic, statistics.decode, statistics.hdr, statistics.timing, statistics.cache, statistics.gpu, subtitles.embedded, subtitles.external, subtitles.ass, subtitles.styles, hardwareDecoding.supported, hardwareDecoding.selectable, hardwareDecoding.softwareFallback, capture.sourceFrame, capture.displayedFrame];
  if (flags.some(flag => typeof flag !== 'boolean')) throw new Error('Invalid media playback backend feature flag');
  if (hardwareDecoding.selectable && !hardwareDecoding.supported || hardwareDecoding.softwareFallback && !hardwareDecoding.supported || subtitles.ass && !subtitles.external || subtitles.styles && !subtitles.embedded && !subtitles.external || hdr.targetPeakControl && !hdr.toneMapping) throw new Error('Exaggerated media playback backend feature relationship');
  return Object.freeze({
    transforms: Object.freeze({ aspectModes: boundedUniqueStrings(transforms.aspectModes, { label: 'aspect modes', allowed: ASPECT_MODES }), rotation: transforms.rotation, flip: transforms.flip, crop: transforms.crop }),
    hdr: Object.freeze({ passthrough: hdr.passthrough, toneMapping: hdr.toneMapping, algorithms: boundedUniqueStrings(hdr.algorithms, { label: 'tone mapping algorithms', allowed: TONE_MAPPING_ALGORITHMS }), targetPeakControl: hdr.targetPeakControl }),
    statistics: Object.freeze({ basic: statistics.basic, decode: statistics.decode, hdr: statistics.hdr, timing: statistics.timing, cache: statistics.cache, gpu: statistics.gpu, maxUpdateHz }),
    subtitles: Object.freeze({ embedded: subtitles.embedded, external: subtitles.external, ass: subtitles.ass, styles: subtitles.styles }),
    hardwareDecoding: Object.freeze({ supported: hardwareDecoding.supported, selectable: hardwareDecoding.selectable, softwareFallback: hardwareDecoding.softwareFallback }),
    capture: Object.freeze({ sourceFrame: capture.sourceFrame, displayedFrame: capture.displayedFrame }),
  });
};

const parseMediaPlaybackBackendContributions = manifest => {
  const values = Array.isArray(manifest?.runtimeContributions) ? manifest.runtimeContributions : [];
  const seen = new Set();
  return values.filter(value => value?.type === PLAYBACK_BACKEND_CONTRIBUTION_TYPE).map(value => {
    exactObject(value, ['type', 'protocolVersion', 'backendId', 'displayName', 'backendVersion', 'transport', 'priority', 'probe', 'features'], 'contribution');
    const protocolVersion = normalizedInteger(value.protocolVersion);
    if (protocolVersion !== PLAYBACK_BACKEND_PROTOCOL_VERSION) throw new Error(`Unsupported media playback backend protocol: ${value.protocolVersion}`);
    const backendId = typeof value.backendId === 'string' ? value.backendId : '';
    if (!IDENTIFIER.test(backendId) || seen.has(backendId)) throw new Error('Invalid or duplicate media playback backendId');
    seen.add(backendId);
    const displayName = typeof value.displayName === 'string' ? value.displayName.trim() : ''; if (!displayName || displayName.length > 120) throw new Error('Invalid media playback backend displayName');
    const backendVersion = typeof value.backendVersion === 'string' ? value.backendVersion : ''; if (!SEMVER.test(backendVersion)) throw new Error('Invalid media playback backend backendVersion');
    if (value.transport !== 'media-playback-backend-v1') throw new Error(`Unsupported media playback backend transport: ${value.transport}`);
    const priority = normalizedInteger(value.priority);
    if (!Number.isInteger(priority) || priority < -1000 || priority > 1000) throw new Error('Invalid media playback backend priority');
    const probe = exactObject(value.probe, ['containers', 'codecs', 'extensions'], 'probe');
    const codecs = exactObject(probe.codecs, ['video', 'audio'], 'codec probe');
    return Object.freeze({
      type: PLAYBACK_BACKEND_CONTRIBUTION_TYPE,
      protocolVersion,
      backendId,
      displayName,
      backendVersion,
      transport: value.transport,
      priority,
      probe: Object.freeze({
        containers: boundedUniqueStrings(probe.containers, { label: 'containers' }),
        codecs: Object.freeze({
          video: boundedUniqueStrings(codecs.video, { label: 'video codecs', min: 0 }),
          audio: boundedUniqueStrings(codecs.audio, { label: 'audio codecs', min: 0 }),
        }),
        extensions: boundedUniqueStrings(probe.extensions, { label: 'extensions', pattern: EXTENSION }),
      }),
      features: parseFeatures(value.features),
    });
  });
};

module.exports = { PLAYBACK_BACKEND_CONTRIBUTION_TYPE, PLAYBACK_BACKEND_PROTOCOL_VERSION, parseMediaPlaybackBackendContributions };
