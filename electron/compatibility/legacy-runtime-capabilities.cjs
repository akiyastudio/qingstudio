// Delete after the last supported pre-capability component packages are outside
// the upgrade window. These declarations preserve discovery only; implementations
// and execution remain owned by the component packages.
const LEGACY_RUNTIME_CAPABILITIES = Object.freeze({
  'video-tools': Object.freeze(['media.video.processing', 'media.video.processing.cli']),
  'video-playback-mpv': Object.freeze(['media.video.playback.advanced', 'media.video.timeline-frames']),
});
const LEGACY_RUNTIME_COMMAND_CAPABILITIES = Object.freeze({
  'video-tools': Object.freeze({
    'media.video.processing.cli': Object.freeze({ argsPrefix: Object.freeze([]) }),
  }),
  'video-playback-mpv': Object.freeze({
    'media.video.timeline-frames': Object.freeze({ argsPrefix: Object.freeze(['--timeline-request']) }),
  }),
});

const legacyRuntimeCapabilities = componentId => LEGACY_RUNTIME_CAPABILITIES[String(componentId || '')] || [];
const legacyRuntimeCommandCapability = (componentId, capability) => LEGACY_RUNTIME_COMMAND_CAPABILITIES[String(componentId || '')]?.[String(capability || '')] || null;

module.exports = { legacyRuntimeCapabilities, legacyRuntimeCommandCapability };
