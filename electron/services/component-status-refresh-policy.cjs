const decideComponentStatusRefresh = ({
  now = Date.now(),
  force = false,
  dirty = false,
  integrityReusable = false,
  lastDetailedAt = 0,
  lastDetailedAttemptAt = 0,
  runtimeProbeTtlMs = 24 * 60 * 60 * 1000,
  failureRetryDelayMs = 30 * 60 * 1000,
} = {}) => {
  const detailedProbeDue = now - Number(lastDetailedAt || 0) >= runtimeProbeTtlMs;
  const previousAttemptFailed = Number(lastDetailedAttemptAt || 0) > Number(lastDetailedAt || 0);
  const retryDeferred = previousAttemptFailed
    && now - Number(lastDetailedAttemptAt || 0) < failureRetryDelayMs;
  const shouldProbeRuntime = Boolean(force || dirty || !integrityReusable || (detailedProbeDue && !retryDeferred));
  return { detailedProbeDue, retryDeferred, shouldProbeRuntime };
};

const nextComponentProbeTimestamps = ({
  attempted = false,
  succeeded = false,
  now = Date.now(),
  lastDetailedAt = 0,
  lastDetailedAttemptAt = 0,
} = {}) => ({
  lastDetailedAt: attempted && succeeded ? now : Number(lastDetailedAt || 0),
  lastDetailedAttemptAt: attempted ? now : Number(lastDetailedAttemptAt || 0),
});

module.exports = { decideComponentStatusRefresh, nextComponentProbeTimestamps };
