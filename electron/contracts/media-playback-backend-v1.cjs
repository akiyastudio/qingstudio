const PROTOCOL = 'media-playback-backend-v1';
const MAX_FRAME_BYTES = 256 * 1024;
const SESSION_ID = /^[a-zA-Z0-9_-]{8,96}$/;
const EVENT_NAME = /^(?:command|event)\.[a-z][a-z0-9.-]{0,95}$/;
const FORBIDDEN_BINARY_FIELDS = new Set(['bytes', 'data', 'frame', 'image', 'pixels', 'videoFrame', 'audioFrame']);

const byteLength = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const assertNoBinaryPayload = (value, depth = 0) => {
  if (depth > 12) throw new Error('Playback protocol payload nesting exceeds limit');
  if (!value || typeof value !== 'object') return;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) throw new Error('Playback protocol forbids binary media frames');
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_BINARY_FIELDS.has(key)) throw new Error(`Playback protocol forbids binary field: ${key}`);
    assertNoBinaryPayload(item, depth + 1);
  }
};

const validateWriterInput = (direction, event, payload, sequence, timestamp, sessionId) => {
  const qualifiedEvent = `${direction}.${event}`;
  if (!EVENT_NAME.test(qualifiedEvent) || !payload || typeof payload !== 'object' || Array.isArray(payload) || Object.prototype.hasOwnProperty.call(payload, 'type')) throw new Error('Invalid playback protocol writer event or payload');
  assertNoBinaryPayload(payload);
  const envelope = { protocol: PROTOCOL, protocolVersion: 1, sessionId, sequence, timestamp, event: qualifiedEvent, payload };
  if (byteLength(envelope) > MAX_FRAME_BYTES) throw new Error('Playback protocol frame exceeds 256 KiB');
  return envelope;
};

const validatePlaybackEnvelope = (value, state, { direction, now = Date.now() } = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid playback protocol envelope');
  const unknown = Object.keys(value).filter(field => !['protocol', 'protocolVersion', 'sessionId', 'sequence', 'timestamp', 'event', 'payload'].includes(field));
  if (unknown.length || value.protocol !== PROTOCOL || value.protocolVersion !== 1 || !SESSION_ID.test(String(value.sessionId || '')) || !EVENT_NAME.test(String(value.event || ''))) throw new Error('Invalid playback protocol envelope');
  if (value.sessionId !== state.sessionId || state.closed || !value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload) || Object.prototype.hasOwnProperty.call(value.payload, 'type')) throw new Error('Playback protocol session is closed, mismatched, or has invalid payload');
  const sequence = Number(value.sequence); const timestamp = Number(value.timestamp);
  if (!Number.isSafeInteger(sequence) || sequence <= state.lastSequence || !Number.isFinite(timestamp) || Math.abs(now - timestamp) > 5 * 60 * 1000) throw new Error('Invalid playback protocol ordering');
  if (direction && !String(value.event).startsWith(`${direction}.`)) throw new Error('Invalid playback protocol direction');
  assertNoBinaryPayload(value.payload);
  if (byteLength(value) > MAX_FRAME_BYTES) throw new Error('Playback protocol frame exceeds 256 KiB');
  state.lastSequence = sequence;
  return value;
};

const createPlaybackEnvelopeWriter = ({ sessionId, direction, send, now = Date.now, maxHighFrequencyHz = 10 }) => {
  if (!SESSION_ID.test(sessionId) || !['command', 'event'].includes(direction) || !Number.isFinite(maxHighFrequencyHz) || maxHighFrequencyHz <= 0) throw new Error('Invalid playback protocol writer');
  let sequence = 0; let closed = false; let lastHighFrequencyAt = 0; const pending = new Map();
  const emit = (event, payload = {}, options = {}) => {
    if (closed) throw new Error('Playback protocol session is closed');
    const timestamp = now();
    const envelope = validateWriterInput(direction, event, payload, sequence + 1, timestamp, sessionId);
    if (options.highFrequency && !options.force && timestamp - lastHighFrequencyAt < 1000 / maxHighFrequencyHz) {
      pending.set(event, payload);
      return false;
    }
    lastHighFrequencyAt = options.highFrequency ? timestamp : lastHighFrequencyAt;
    envelope.sequence = ++sequence;
    send(envelope);
    return true;
  };
  const flush = () => {
    const values = [...pending.entries()]; pending.clear();
    for (const [event, payload] of values) emit(event, payload, { highFrequency: true, force: true });
  };
  const close = () => { closed = true; pending.clear(); };
  return { emit, flush, close, get closed() { return closed; }, get sequence() { return sequence; } };
};

module.exports = { MAX_FRAME_BYTES, PROTOCOL, createPlaybackEnvelopeWriter, validatePlaybackEnvelope };
