const { createPlaybackEnvelopeWriter, validatePlaybackEnvelope } = require('../contracts/media-playback-backend-v1.cjs');

const LEGACY_COMMAND_TO_V1 = Object.freeze({
  open: 'media.open', play: 'playback.play', pause: 'playback.pause', seek: 'playback.seek', 'frame-step':'playback.frame-step', 'frame-back-step':'playback.frame-back-step', volume: 'audio.volume', mute: 'audio.mute', 'audio-select':'audio.track-select', speed: 'playback.speed', stop: 'playback.stop',
  'subtitle-select': 'subtitles.select', 'subtitle-visible': 'subtitles.visible', 'subtitle-delay': 'subtitles.delay', 'subtitle-style': 'subtitles.style', 'subtitle-add': 'subtitles.add',
  screenshot: 'capture.stage', transform: 'video.transform', 'hdr-mode': 'video.hdr-mode', 'tone-mapping': 'video.tone-mapping', 'statistics-level': 'statistics.level', 'display-output': 'display.output',
});
const V1_EVENT_TO_LEGACY = Object.freeze({
  'runtime.ready': 'ready', 'surface.created': 'surface-created', 'state.changed': 'state', 'state.loading': 'loading', 'media.loaded': 'file-loaded', 'media.ended': 'ended',
  'tracks.changed': 'subtitle-tracks', 'audio-tracks.changed':'audio-tracks', 'statistics.changed': 'statistics', 'input.raw': 'input', 'capture.completed': 'screenshot-result', diagnostic: 'diagnostic', fatal: 'fatal', error: 'error', terminated: 'stopped',
});
const LEGACY_EVENT_TO_V1 = Object.freeze(Object.fromEntries(Object.entries(V1_EVENT_TO_LEGACY).map(([key, value]) => [value, key])));

const createMediaPlaybackProcessAdapter = ({ sessionId, writeLine, now = Date.now, legacy = false }) => {
  const writer = createPlaybackEnvelopeWriter({ sessionId, direction: 'command', send: value => writeLine(JSON.stringify(value)), now });
  const eventState = { sessionId, lastSequence: 0, closed: false };
  const send = (event, payload = {}) => writer.emit(event, payload);
  const sendLegacy = (command, payload = {}) => {
    const event = LEGACY_COMMAND_TO_V1[command]; if (!event) throw new Error(`Unsupported playback command: ${command}`);
    if (legacy) { if (writer.closed) throw new Error('Playback protocol session is closed'); writeLine(JSON.stringify({ ...payload, command })); return true; }
    return send(event, payload);
  };
  const receiveLine = line => {
    const raw = JSON.parse(line);
    if (legacy) { const event = LEGACY_EVENT_TO_V1[raw.type]; if (!event) throw new Error(`Unknown legacy playback event: ${raw.type}`); const payload = { ...raw }; delete payload.type; return { type: raw.type, event, payload }; }
    const envelope = validatePlaybackEnvelope(raw, eventState, { direction: 'event', now: now() });
    const event = envelope.event.slice('event.'.length); const type = V1_EVENT_TO_LEGACY[event];
    if (!type) throw new Error(`Unknown playback v1 event: ${event}`);
    return { type, event, payload: envelope.payload };
  };
  const close = () => { eventState.closed = true; writer.close(); };
  return { send, sendLegacy, receiveLine, close, get closed() { return writer.closed; } };
};

module.exports = { LEGACY_COMMAND_TO_V1, LEGACY_EVENT_TO_V1, createMediaPlaybackProcessAdapter };
