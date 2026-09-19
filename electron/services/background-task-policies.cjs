const { MEDIA_RESCAN_POLICY_VERSION } = require('./background-task-policy-versions.cjs');

const DEFAULT_BACKGROUND_TASK_POLICY = Object.freeze({
  resumePolicy: 'atomic', notificationPolicy: 'error-only', historyPolicy: 'persistent',
  taskCenterPolicy: 'always', interruptedPolicy: 'retain', successHistory: 'retain',
  pausable: false, resumable: false,
});

const BACKGROUND_TASK_POLICIES = Object.freeze({
  'project-file-operation': { resumePolicy: 'checkpoint', notificationPolicy: 'progress-and-result', pausable: true, resumable: true },
  'project-archive': { resumePolicy: 'checkpoint', notificationPolicy: 'progress-toast', resumable: true },
  'project-unarchive': { resumePolicy: 'checkpoint', notificationPolicy: 'progress-toast', resumable: true },
  'workspace-backup': { resumePolicy: 'checkpoint', notificationPolicy: 'progress-toast', resumable: true },
  'workspace-restore': { resumePolicy: 'checkpoint', notificationPolicy: 'progress-toast', resumable: true },
  'project-restore': { resumePolicy: 'checkpoint', notificationPolicy: 'progress-toast', resumable: true },
  'video-trim': { resumePolicy: 'safe-restart', notificationPolicy: 'progress-toast' },
  'version-tracking': { resumePolicy: 'safe-restart', notificationPolicy: 'progress-toast' },
  'version-media-rescan': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only', taskCenterPolicy: 'attention-only', interruptedPolicy: 'migrate', successHistory: 'clearable', foregroundNonBlocking: true, migrateTask: task => (
    task.metadata?.fullScan === true || Number(task.metadata?.mediaRescanPolicyVersion || 0) >= MEDIA_RESCAN_POLICY_VERSION ? task : null
  ) },
  'version-fingerprint-maintenance': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only', interruptedPolicy: 'discard', successHistory: 'auto-clear', foregroundNonBlocking: true },
  'version-stale-detection': { resumePolicy: 'safe-restart', notificationPolicy: 'silent', historyPolicy: 'ephemeral', foregroundNonBlocking: true },
  'thumbnail-generate': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only', taskCenterPolicy: 'attention-only', interruptedPolicy: 'discard', successHistory: 'auto-clear' },
  'thumbnail-cache-recovery': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only', taskCenterPolicy: 'attention-only', interruptedPolicy: 'restart', successHistory: 'auto-clear' },
  'workspace-database-maintenance': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only', taskCenterPolicy: 'attention-only', interruptedPolicy: 'discard', successHistory: 'clearable', foregroundNonBlocking: true },
  'backup-verify': { resumePolicy: 'checkpoint', notificationPolicy: 'error-only', resumable: true },
  'workspace-reconcile': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only', foregroundNonBlocking: true },
  'storage-usage-scan': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only' },
  'deleted-project-cleanup': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only' },
  'backup-cleanup': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only' },
  'cache-cleanup': definition => definition.metadata?.origin === 'daily-auto'
    || !definition.metadata?.origin && Number(definition.metadata?.olderThanDays) === 30
    ? { resumePolicy: 'safe-restart', notificationPolicy: 'error-only', taskCenterPolicy: 'attention-only', interruptedPolicy: 'discard', successHistory: 'auto-clear' }
    : { resumePolicy: 'safe-restart', notificationPolicy: 'result-only', taskCenterPolicy: 'always', interruptedPolicy: 'restart', successHistory: 'retain' },
  'internal-artifact-cleanup': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only' },
  'internal-filesystem-cleanup': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only' },
  'system-filesystem-cleanup': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only' },
  'component-status-refresh': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only' },
  'component-runtime': { resumePolicy: 'safe-restart', notificationPolicy: 'progress-and-result' },
});

const configuredPolicy = definition => {
  const configured = BACKGROUND_TASK_POLICIES[definition?.type];
  return typeof configured === 'function' ? configured(definition) : configured || {};
};

const hasCentralBackgroundTaskPolicy = type => Object.prototype.hasOwnProperty.call(BACKGROUND_TASK_POLICIES, String(type || ''));

const resolveBackgroundTaskPolicy = definition => {
  definition = definition || {};
  const configured = configuredPolicy(definition);
  const registered = hasCentralBackgroundTaskPolicy(definition.type);
  const select = (explicit, central, fallback) => registered ? central || fallback : explicit || central || fallback;
  const notificationPolicy = select(definition.notificationPolicy, configured.notificationPolicy, DEFAULT_BACKGROUND_TASK_POLICY.notificationPolicy);
  return {
    ...DEFAULT_BACKGROUND_TASK_POLICY,
    ...configured,
    resumePolicy: select(definition.resumePolicy, configured.resumePolicy, DEFAULT_BACKGROUND_TASK_POLICY.resumePolicy),
    notificationPolicy,
    historyPolicy: registered
      ? configured.historyPolicy || DEFAULT_BACKGROUND_TASK_POLICY.historyPolicy
      : definition.historyPolicy || (notificationPolicy === 'silent' ? 'ephemeral' : configured.historyPolicy || DEFAULT_BACKGROUND_TASK_POLICY.historyPolicy),
    taskCenterPolicy: select(definition.taskCenterPolicy, configured.taskCenterPolicy, DEFAULT_BACKGROUND_TASK_POLICY.taskCenterPolicy),
    pausable: registered ? configured.pausable ?? false : definition.pausable ?? configured.pausable ?? false,
    resumable: registered ? configured.resumable ?? false : definition.resumable ?? configured.resumable ?? false,
  };
};

module.exports = { BACKGROUND_TASK_POLICIES, DEFAULT_BACKGROUND_TASK_POLICY, hasCentralBackgroundTaskPolicy, resolveBackgroundTaskPolicy };
