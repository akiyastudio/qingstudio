const readline = require('readline');
let sequence = 0; const pending = new Map();
const send = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'capability-response') { const request = pending.get(frame.id); pending.delete(frame.id); return frame.ok ? request?.resolve(frame.result) : request?.reject(Object.assign(new Error(frame.error), { code: frame.errorCode })); }
  if (frame.type !== 'request' || frame.method !== 'sample.project-files.v1') return;
  const id = `read-${++sequence}`; pending.set(id, { resolve: result => send({ type: 'response', id: frame.id, ok: true, result }), reject: error => send({ type: 'response', id: frame.id, ok: false, error: error.message, errorCode: error.code }) });
  send({ type: 'capability', id, parentId: frame.id, method: 'project.files.page', payload: { pageSize: 50, cursor: frame.payload?.cursor ?? null } });
});
send({ type: 'ready', protocolVersion: 1 });
