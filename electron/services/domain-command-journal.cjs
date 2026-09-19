const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const clone = value => JSON.parse(JSON.stringify(value));

const createDomainCommandJournal = ({ filePath, writeLog = () => undefined, now = () => Date.now(), maxAttempts = 5, backoffMs = [100, 500, 2000, 10000, 30000] }) => {
  const absolute = path.resolve(filePath);
  const handlers = new Map();
  let records = [];
  let draining = false;
  let stopped = false;
  let timer = null;
  let persistenceError = null;

  const persist = () => {
    if (persistenceError) throw persistenceError;
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const temporary = `${absolute}.tmp-${process.pid}-${crypto.randomUUID()}`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, records }, null, 2), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, absolute);
  };

  const load = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
      records = Array.isArray(parsed.records) ? parsed.records : [];
      for (const record of records) if (record.status === 'processing') record.status = 'pending';
      persist();
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        const quarantine = `${absolute}.corrupt-${now()}`;
        try {
          fs.renameSync(absolute, quarantine);
          writeLog('error', 'Corrupt domain command journal quarantined', { error: error.message || String(error), quarantine });
        } catch (quarantineError) {
          // Refuse to silently overwrite an unreadable journal. Enqueue will
          // surface the filesystem error until an operator can recover it.
          writeLog('error', 'Unable to quarantine corrupt domain command journal', {
            error: error.message || String(error), quarantineError: quarantineError.message || String(quarantineError),
          });
          persistenceError = new Error(`domain command journal is unreadable and could not be quarantined: ${quarantineError.message || String(quarantineError)}`);
        }
      }
      records = [];
    }
  };

  const schedule = delay => {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = null; void drain(); }, Math.max(0, delay));
    timer.unref?.();
  };

  const drain = async () => {
    if (stopped || draining) return;
    draining = true;
    try {
      while (!stopped) {
        const timestamp = now();
        const record = records.find(item => item.status === 'pending' && Number(item.nextAttemptAt || 0) <= timestamp && handlers.has(`${item.target}:${item.type}`));
        if (!record) break;
        const handler = handlers.get(`${record.target}:${record.type}`);
        record.status = 'processing';
        record.updatedAt = timestamp;
        persist();
        try {
          const result = await handler(clone(record));
          record.status = 'completed';
          record.result = result == null ? null : clone(result);
          record.error = '';
          record.updatedAt = now();
          writeLog('info', 'Domain command completed', { commandId: record.commandId, target: record.target, type: record.type, attempts: record.attempts });
        } catch (error) {
          record.attempts += 1;
          record.error = error.message || String(error);
          record.updatedAt = now();
          if (record.attempts >= maxAttempts) {
            record.status = 'dead';
            writeLog('error', 'Domain command moved to dead letter', { commandId: record.commandId, target: record.target, type: record.type, attempts: record.attempts, error: record.error });
          } else {
            record.status = 'pending';
            record.nextAttemptAt = now() + (backoffMs[Math.min(record.attempts - 1, backoffMs.length - 1)] ?? 30000);
            writeLog('warn', 'Domain command retry scheduled', { commandId: record.commandId, target: record.target, type: record.type, attempts: record.attempts, error: record.error });
          }
        }
        // Retain a bounded idempotency history.
        const completed = records.filter(item => item.status === 'completed').sort((left, right) => right.updatedAt - left.updatedAt);
        if (completed.length > 500) {
          const stale = new Set(completed.slice(500).map(item => item.commandId));
          records = records.filter(item => !stale.has(item.commandId));
        }
        persist();
      }
    } finally {
      draining = false;
      const next = records
        .filter(item => item.status === 'pending' && handlers.has(`${item.target}:${item.type}`))
        .sort((left, right) => left.nextAttemptAt - right.nextAttemptAt)[0];
      if (next) schedule(Math.max(0, next.nextAttemptAt - now()));
    }
  };

  const register = (target, type, handler) => {
    const key = `${target}:${type}`;
    if (handlers.has(key)) throw new Error(`domain command handler already registered: ${key}`);
    handlers.set(key, handler);
    schedule(0);
    return () => handlers.delete(key);
  };

  const enqueue = ({ commandId = crypto.randomUUID(), correlationId = crypto.randomUUID(), target, type, workspaceRoot, payload }) => {
    const existing = records.find(item => item.commandId === commandId);
    if (existing) return clone(existing);
    const timestamp = now();
    const record = {
      schemaVersion: 1, commandId, correlationId, target, type,
      workspaceRoot: path.resolve(workspaceRoot), payload: clone(payload || {}),
      status: 'pending', attempts: 0, nextAttemptAt: timestamp,
      createdAt: timestamp, updatedAt: timestamp, error: '',
    };
    records.push(record);
    persist();
    schedule(0);
    return clone(record);
  };

  const retryDead = commandId => {
    const record = records.find(item => item.commandId === commandId && item.status === 'dead');
    if (!record) return false;
    record.status = 'pending';
    record.attempts = 0;
    record.nextAttemptAt = now();
    record.error = '';
    persist();
    schedule(0);
    return true;
  };

  const status = () => clone(records);
  const stop = () => { stopped = true; if (timer) clearTimeout(timer); timer = null; };

  load();
  return { drain, enqueue, register, retryDead, status, stop };
};

module.exports = { createDomainCommandJournal };
