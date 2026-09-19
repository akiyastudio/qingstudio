const { parseMediaPlaybackBackendContributions } = require('../contracts/media-playback-backend-contract.cjs');

const supportRank = Object.freeze({ probably: 3, maybe: 2, unknown: 1, unsupported: 0 });
const normalizeBrowserProbe = value => ['probably', 'maybe', 'unsupported'].includes(value) ? value : 'unknown';
const CHROMIUM_FEATURES = Object.freeze({
  transforms: Object.freeze({ aspectModes: Object.freeze(['source','contain','cover','16:9','4:3','1:1']), rotation:true, flip:true, crop:true }),
  hdr: Object.freeze({ passthrough:false, toneMapping:false, algorithms:Object.freeze([]), targetPeakControl:false }),
  statistics: Object.freeze({ basic:true, decode:false, hdr:false, timing:true, cache:false, gpu:false, maxUpdateHz:4 }),
  subtitles: Object.freeze({ embedded:false, external:false, ass:false, styles:false }),
  hardwareDecoding: Object.freeze({ supported:true, selectable:false, softwareFallback:true }),
  capture: Object.freeze({ sourceFrame:true, displayedFrame:true }),
});

const createVideoPlaybackBroker = ({ pluginService, path }) => {
  const contributions = () => (pluginService.listInstalled ? pluginService.listInstalled() : pluginService.list()).flatMap(component => {
    if (!component?.installed || component.enabled === false || !component.compatible) return [];
    let declared = [];
    try { declared = parseMediaPlaybackBackendContributions(component.manifest); } catch { return []; }
    return declared.map(contribution => ({ component, contribution, backendId: `${component.id}:${contribution.backendId}` }));
  });

  const listDescriptors = async (filePath, browserProbe) => {
    const extension = path.extname(String(filePath || '')).toLowerCase();
    const chromiumSupport = normalizeBrowserProbe(browserProbe);
    const descriptors = [{
      backendId: 'core.chromium', protocolVersion: 1, transport: 'chromium',
      displayName: 'Chromium', backendVersion: process.versions.chrome || '0.0.0', priority: 100,
      probe: { support: chromiumSupport, basis: 'html-media-can-play-type', containers: [], codecs: { video: [], audio: [] }, extensions: [extension].filter(Boolean) },
      features: CHROMIUM_FEATURES,
    }];
    for (const item of contributions()) {
      // A declared extension proves only that the backend accepts the
      // container family; it says nothing about the file's actual codec.
      const support = item.contribution.probe.extensions.includes(extension) ? 'maybe' : 'unknown';
      descriptors.push({
        backendId: item.backendId,
        protocolVersion: item.contribution.protocolVersion,
        transport: item.contribution.transport,
        displayName: item.contribution.displayName,
        backendVersion: item.contribution.backendVersion,
        priority: item.contribution.priority,
        probe: { support, basis: 'manifest-extension-hint', ...item.contribution.probe },
        features: item.contribution.features,
      });
    }
    return descriptors.filter(item => item.probe.support !== 'unsupported')
      .sort((left, right) => {
        // An available contributed decoder is the installed playback upgrade.
        // Chromium remains the automatic fallback when that backend rejects or fails.
        if (left.transport !== right.transport) return left.transport === 'chromium' ? 1 : -1;
        return supportRank[right.probe.support] - supportRank[left.probe.support]
          || right.priority - left.priority
          || left.backendId.localeCompare(right.backendId);
      });
  };

  const resolveRunConfigAsync = async (backendId, args = []) => {
    const match = contributions().find(item => item.backendId === backendId);
    if (!match) {
      const error = new Error('视频播放后端不可用或已经变更');
      error.code = 'PLAYBACK_BACKEND_MISSING';
      throw error;
    }
    const runConfig = await pluginService.resolveRunConfigAsync(match.component.id, args);
    return { ...runConfig, componentId: match.component.id, descriptor: match.contribution };
  };

  const defaultBackendId = () => contributions().sort((left, right) => right.contribution.priority - left.contribution.priority || left.backendId.localeCompare(right.backendId))[0]?.backendId || '';
  const ownerForBackend = backendId => { const match = contributions().find(item => item.backendId === backendId); return match ? { componentId: match.component.id, descriptor: match.contribution } : null; };

  return { listDescriptors, resolveRunConfigAsync, defaultBackendId, ownerForBackend };
};

module.exports = { createVideoPlaybackBroker };
