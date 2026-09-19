// Delete after all pre-component renderer/import call sites use component runtime
// capabilities directly. This table translates legacy script entry names only; it
// does not implement component algorithms or alter their arguments.
const LEGACY_RUNTIME_TOOLS = Object.freeze({
  cut_video: Object.freeze({ capability: 'media.video.processing.cli', componentId: 'video-tools', runtimeAction: 'cut_video', scriptName: 'cut_video.py' }),
  ffmpeg_transcode: Object.freeze({ capability: 'media.video.processing.cli', componentId: 'video-tools', runtimeAction: 'ffmpeg_transcode', scriptName: 'ffmpeg_transcode.py' }),
  video_preview: Object.freeze({ capability: 'media.video.processing.cli', componentId: 'video-tools', runtimeAction: 'video_preview', scriptName: 'video_preview.py' }),
});

const resolveLegacyComponentRuntimeTool = baseName => LEGACY_RUNTIME_TOOLS[String(baseName || '')] || null;
const resolveLegacyRuntimeRunConfig = (pluginService, tool, args = []) => typeof pluginService.resolveRunConfigForCapability === 'function'
  ? pluginService.resolveRunConfigForCapability(tool.capability, [tool.runtimeAction, ...args])
  : pluginService.resolveRunConfig(tool.componentId, [tool.runtimeAction, ...args]);

// Some core workflows use the component worker as a generic bridge and append
// their own worker action later. Resolve only the component entrypoint in that
// case; prepending a legacy tool action would route the bridge request into the
// wrong worker subcommand.
const resolveLegacyRuntimeBridgeConfig = (pluginService, tool) => typeof pluginService.resolveRunConfigForCapability === 'function'
  ? pluginService.resolveRunConfigForCapability(tool.capability, [])
  : pluginService.resolveRunConfig(tool.componentId, []);

module.exports = { LEGACY_RUNTIME_TOOLS, resolveLegacyComponentRuntimeTool, resolveLegacyRuntimeRunConfig, resolveLegacyRuntimeBridgeConfig };
