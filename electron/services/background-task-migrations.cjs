const { resolveBackgroundTaskPolicy } = require('./background-task-policies.cjs');
const {
  BACKGROUND_TASK_PERSISTENCE_VERSION,
  BACKGROUND_TASK_STATES,
  BACKGROUND_TASK_ACTIVE_STATES,
  BACKGROUND_TASK_POLICY_VALUES,
  projectBackgroundTaskCapabilities,
} = require('./background-task-policy-versions.cjs');

const ACTIVE_STATES = new Set(BACKGROUND_TASK_ACTIVE_STATES);
const STATES = new Set(BACKGROUND_TASK_STATES);
const TASK_CENTER_POLICIES = new Set(BACKGROUND_TASK_POLICY_VALUES.taskCenterPolicy);
const RESUME_POLICIES = new Set(BACKGROUND_TASK_POLICY_VALUES.resumePolicy);
const NOTIFICATION_POLICIES = new Set(BACKGROUND_TASK_POLICY_VALUES.notificationPolicy);
const HISTORY_POLICIES = new Set(BACKGROUND_TASK_POLICY_VALUES.historyPolicy);

const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
const validText = (value, maximum = 256) => typeof value === 'string' && value.length > 0
  && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
const optionalId = value => validText(value) ? value : null;
const finiteTimestamp = value => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
const text = (value, fallback = '', maximum = 2000) => typeof value === 'string' ? value.slice(0, maximum) : fallback;

const normalizeTask = value => {
  if (!isRecord(value) || !validText(value.id) || !validText(value.type, 128) || !STATES.has(value.state)) return null;
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const explicit = {
    ...value,
    metadata,
    ...(TASK_CENTER_POLICIES.has(value.taskCenterPolicy) ? {} : { taskCenterPolicy: undefined }),
    ...(RESUME_POLICIES.has(value.resumePolicy) ? {} : { resumePolicy: undefined }),
    ...(NOTIFICATION_POLICIES.has(value.notificationPolicy) ? {} : { notificationPolicy: undefined }),
    ...(HISTORY_POLICIES.has(value.historyPolicy) ? {} : { historyPolicy: undefined }),
  };
  let policy = resolveBackgroundTaskPolicy(explicit);
  if (value.state === 'failed' && value.error === 'Process supervisor is stopping' && policy.taskCenterPolicy === 'attention-only') {
    value = { ...value, state: 'cancelled', error: '', message: '因退出停止', retryable: false, retryPending: false };
  }
  if (ACTIVE_STATES.has(value.state)) {
    if (policy.interruptedPolicy === 'discard') return null;
    if (policy.interruptedPolicy === 'migrate') {
      const migrated = typeof policy.migrateTask === 'function' ? policy.migrateTask({ ...value, metadata }) : null;
      if (!migrated) return null;
      policy = resolveBackgroundTaskPolicy({ ...explicit, ...migrated, metadata: isRecord(migrated.metadata) ? migrated.metadata : metadata });
    } else if (!['retain', 'restart'].includes(policy.interruptedPolicy)) return null;
  }
  const resumable = Boolean(policy.resumable);
  return {
    id: value.id, type: value.type, title: text(value.title, value.type, 512),
    state: ACTIVE_STATES.has(value.state) ? 'interrupted' : value.state,
    progress: Math.max(0, Math.min(100, Number(value.progress) || 0)),
    message: text(value.message), error: text(value.error),
    cancellable: false, retryable: false, resumable, resumeAvailable: false, restartAvailable: false,
    capabilities: projectBackgroundTaskCapabilities(policy, { cancellable: false, resumable, retryable: false }),
    resumePolicy: policy.resumePolicy,
    notificationPolicy: policy.notificationPolicy,
    historyPolicy: policy.historyPolicy,
    taskCenterPolicy: policy.taskCenterPolicy,
    retryOfTaskId: optionalId(value.retryOfTaskId), replacedByTaskId: optionalId(value.replacedByTaskId),
    retryAttempt: Math.max(0, Math.floor(Number(value.retryAttempt) || 0)), retryPending: Boolean(value.retryPending),
    checkpointVersion: Math.max(1, Math.floor(Number(value.checkpointVersion) || 1)), checkpoint: value.checkpoint,
    metadata,
    createdAt: finiteTimestamp(value.createdAt), updatedAt: finiteTimestamp(value.updatedAt),
    startedAt: finiteTimestamp(value.startedAt), finishedAt: finiteTimestamp(value.finishedAt),
  };
};

const migrateBackgroundTaskPayload = payload => {
  const source = isRecord(payload) ? payload : {};
  const tasks = (Array.isArray(source.tasks) ? source.tasks : []).map(normalizeTask).filter(Boolean);
  return { version: BACKGROUND_TASK_PERSISTENCE_VERSION, tasks };
};

module.exports = { migrateBackgroundTaskPayload, normalizeTask };
