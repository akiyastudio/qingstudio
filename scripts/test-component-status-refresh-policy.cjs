const assert = require('assert/strict');
const { decideComponentStatusRefresh, nextComponentProbeTimestamps } = require('../electron/services/component-status-refresh-policy.cjs');

const HOUR = 60 * 60 * 1000;
const now = 100 * HOUR;
const base = {
  now,
  integrityReusable: true,
  lastDetailedAt: now - HOUR,
  lastDetailedAttemptAt: now - HOUR,
  runtimeProbeTtlMs: 24 * HOUR,
  failureRetryDelayMs: 30 * 60 * 1000,
};

assert.equal(decideComponentStatusRefresh(base).shouldProbeRuntime, false, 'fresh unchanged metadata must reuse runtime status');
assert.equal(decideComponentStatusRefresh({ ...base, lastDetailedAt: now - 25 * HOUR, lastDetailedAttemptAt: now - 25 * HOUR }).shouldProbeRuntime, true, 'expired runtime status must be probed');
assert.equal(decideComponentStatusRefresh({ ...base, integrityReusable: false }).shouldProbeRuntime, true, 'changed component files must force a runtime probe');
assert.equal(decideComponentStatusRefresh({ ...base, dirty: true }).shouldProbeRuntime, true, 'component mutations must force a runtime probe');

const failed = nextComponentProbeTimestamps({ attempted: true, succeeded: false, now, lastDetailedAt: now - 25 * HOUR, lastDetailedAttemptAt: now - 25 * HOUR });
assert.equal(failed.lastDetailedAt, now - 25 * HOUR, 'a failed probe must preserve the last successful time');
assert.equal(failed.lastDetailedAttemptAt, now, 'a failed probe must record its attempt time');
const deferred = decideComponentStatusRefresh({ ...base, lastDetailedAt: failed.lastDetailedAt, lastDetailedAttemptAt: failed.lastDetailedAttemptAt });
assert.equal(deferred.shouldProbeRuntime, false, 'automatic retries must back off after a failed probe');
assert.equal(deferred.retryDeferred, true);
assert.equal(decideComponentStatusRefresh({ ...base, force: true, lastDetailedAt: failed.lastDetailedAt, lastDetailedAttemptAt: failed.lastDetailedAttemptAt }).shouldProbeRuntime, true, 'manual refresh must bypass failure backoff');

const succeeded = nextComponentProbeTimestamps({ attempted: true, succeeded: true, now, lastDetailedAt: 1, lastDetailedAttemptAt: 2 });
assert.deepEqual(succeeded, { lastDetailedAt: now, lastDetailedAttemptAt: now }, 'a successful probe must advance success and attempt times together');
const reused = nextComponentProbeTimestamps({ attempted: false, succeeded: false, now, lastDetailedAt: 10, lastDetailedAttemptAt: 20 });
assert.deepEqual(reused, { lastDetailedAt: 10, lastDetailedAttemptAt: 20 }, 'cache reuse must preserve detailed timestamps');

process.stdout.write('Component status refresh policy tests passed.\n');
