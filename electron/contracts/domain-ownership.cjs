const DOMAIN_IDS = Object.freeze([
  'shell',
  'workspace',
  'file-operations',
  'import',
  'media',
  'versioning',
  'backup-archive',
  'inspiration-tools',
  'telemetry',
]);

const DOMAIN_OWNERSHIP = Object.freeze({
  shell: Object.freeze({
    owns: Object.freeze(['window-lifecycle', 'navigation', 'component-lifecycle', 'application-config']),
    storage: Object.freeze(['config.json', 'component-status-cache.json']),
  }),
  workspace: Object.freeze({
    owns: Object.freeze(['workspace-identity', 'project-catalog', 'project-status', 'virtual-paths']),
    storage: Object.freeze(['workspace.sqlite3:projects']),
  }),
  'file-operations': Object.freeze({
    owns: Object.freeze(['project-content-mutations', 'operation-journal', 'undo-journal']),
    storage: Object.freeze(['operations.sqlite3']),
  }),
  import: Object.freeze({
    owns: Object.freeze(['import-plan', 'import-staging', 'import-checkpoints']),
    storage: Object.freeze(['import-session-manifests', 'import-staging-directories']),
  }),
  media: Object.freeze({
    owns: Object.freeze(['media-index', 'metadata', 'ratings', 'thumbnails', 'preview-cache']),
    storage: Object.freeze(['media.sqlite3', 'thumbnail-index.sqlite3', 'media-cache']),
  }),
  versioning: Object.freeze({
    owns: Object.freeze(['version-graph', 'progress-relations', 'tracking-sessions']),
    storage: Object.freeze(['versioning.sqlite3']),
  }),
  'backup-archive': Object.freeze({
    owns: Object.freeze(['backup-snapshots', 'backup-retention', 'archive-placement', 'restore-plans']),
    storage: Object.freeze(['backup-store', 'archive-target']),
  }),
  'inspiration-tools': Object.freeze({
    owns: Object.freeze(['inspiration-index', 'tool-job-state']),
    storage: Object.freeze(['inspiration-library-metadata', 'tool-temporary-output']),
  }),
  telemetry: Object.freeze({
    owns: Object.freeze(['consent-filtered-events', 'crash-reports', 'feedback-queue']),
    storage: Object.freeze(['telemetry-state.json', 'telemetry-queue.json']),
  }),
});

const PROJECT_CONTENT_MUTATION_OWNER = 'file-operations';
const PROJECT_CONTENT_COMMANDS = Object.freeze([
  'copy',
  'move',
  'rename',
  'trash',
  'restore',
  'create-directory',
  'create-file',
  'commit-import',
  'commit-version',
]);

const LEGACY_PROJECT_CONTENT_WRITERS = Object.freeze([
  'electron/modules/broll-import.cjs',
  'electron/modules/files-ipc.cjs',
  'electron/modules/version-tracking-ipc.cjs',
  'electron/modules/versions-ipc.cjs',
  'electron/modules/workspace-ipc.cjs',
  'electron/modules/workspace/import-ipc.cjs',
  'electron/services/archive-service.cjs',
  'electron/services/selection-service.cjs',
  'electron/services/video-trim-commit-service.cjs',
  'python/classify.py',
]);

const domainOwnsCapability = (domain, capability) =>
  DOMAIN_OWNERSHIP[domain]?.owns.includes(capability) === true;

const assertKnownDomain = domain => {
  if (!DOMAIN_IDS.includes(domain)) throw new Error(`Unknown domain: ${String(domain)}`);
  return domain;
};

const assertProjectContentMutationOwner = domain => {
  assertKnownDomain(domain);
  if (domain !== PROJECT_CONTENT_MUTATION_OWNER) {
    throw new Error(`Project content mutations are owned by ${PROJECT_CONTENT_MUTATION_OWNER}, not ${domain}`);
  }
  return domain;
};

module.exports = {
  DOMAIN_IDS,
  DOMAIN_OWNERSHIP,
  LEGACY_PROJECT_CONTENT_WRITERS,
  PROJECT_CONTENT_COMMANDS,
  PROJECT_CONTENT_MUTATION_OWNER,
  assertKnownDomain,
  assertProjectContentMutationOwner,
  domainOwnsCapability,
};
