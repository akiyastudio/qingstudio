const MEDIA_RESCAN_POLICY_VERSION = 2;
const BACKGROUND_TASK_PERSISTENCE_VERSION = 4;
const BACKGROUND_TASK_STATES = Object.freeze(['queued', 'running', 'pausing', 'paused', 'resuming', 'interrupted', 'completed', 'failed', 'cancelled']);
const BACKGROUND_TASK_ACTIVE_STATES = Object.freeze(['queued', 'running', 'pausing', 'paused', 'resuming', 'interrupted']);
const BACKGROUND_TASK_POLICY_VALUES = Object.freeze({
  taskCenterPolicy: Object.freeze(['always', 'attention-only', 'hidden']),
  resumePolicy: Object.freeze(['atomic', 'checkpoint', 'safe-restart']),
  notificationPolicy: Object.freeze(['silent', 'error-only', 'result-only', 'progress-toast', 'progress-and-result']),
  historyPolicy: Object.freeze(['persistent', 'ephemeral']),
});

const projectBackgroundTaskCapabilities = (policy, availability = {}) => Object.freeze({
  cancellable: Boolean(availability.cancellable),
  pausable: Boolean(availability.pausable ?? policy?.pausable),
  resumable: Boolean(availability.resumable ?? policy?.resumable),
  retryable: Boolean(availability.retryable),
});

module.exports = {
  MEDIA_RESCAN_POLICY_VERSION,
  BACKGROUND_TASK_PERSISTENCE_VERSION,
  BACKGROUND_TASK_STATES,
  BACKGROUND_TASK_ACTIVE_STATES,
  BACKGROUND_TASK_POLICY_VALUES,
  projectBackgroundTaskCapabilities,
};
