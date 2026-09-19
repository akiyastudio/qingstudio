const readline = require('readline');
const pending = new Map(); let sequence = 0;
const send = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'capability-response') { const request = pending.get(frame.id); pending.delete(frame.id); return frame.ok ? request?.resolve(frame.result) : request?.reject(Object.assign(new Error(frame.error), { code: frame.errorCode })); }
  if (frame.type !== 'request' || frame.method !== 'project-write.rate.v1') return;
  const id = `write-${++sequence}`; pending.set(id, { resolve: result => send({ type: 'response', id: frame.id, ok: true, result }), reject: error => send({ type: 'response', id: frame.id, ok: false, error: error.message, errorCode: error.code || 'COMPONENT_SERVICE_FAILED' }) });
  send({ type: 'capability', id, parentId: frame.id, method: 'project.media.ratings.write', payload: { idempotencyKey: String(frame.payload?.idempotencyKey || ''), items: frame.payload?.items } });
});
send({ type: 'ready', protocolVersion: 1 });
