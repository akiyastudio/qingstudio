const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const entry = path.resolve(process.argv[2] || 'examples/hello-component/service.cjs');
const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'inherit'] });
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
let ready = false;
const timeout = setTimeout(() => { child.kill(); throw new Error('Component mock timed out'); }, 5000);
lines.on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'ready') {
    assert.equal(frame.protocolVersion, 1); ready = true;
    child.stdin.write(`${JSON.stringify({ type: 'request', id: '1', method: 'sample.media-page.v1', payload: {}, context: { componentId: 'hello-component', componentVersion: '1.0.0',  permissions: ['project.media.read'], projectId: 'project-1', projectName: 'Fixture', projectStatus: 'active' } })}\n`);
  } else if (frame.type === 'capability') {
    assert(ready); assert.equal(frame.method, 'project.media.page');
    child.stdin.write(`${JSON.stringify({ type: 'capability-response', id: frame.id, ok: true, result: {  items: [], page: { hasMore: false, cursor: null, pageSize: 20 } } })}\n`);
  } else if (frame.type === 'response') {
    clearTimeout(timeout); assert(frame.ok);
    assert.deepStrictEqual(frame.result, {  items: [], page: { hasMore: false, cursor: null, pageSize: 20 } });
    console.log('Component service mock passed'); child.kill();
  }
});
