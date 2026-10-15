const assert = require('node:assert/strict');
const path = require('node:path');
const { createProcessSupervisor } = require('../electron/services/process-supervisor.cjs');
const { createFileClipboardService } = require('../electron/services/file-clipboard-service.cjs');

const run = async () => {
  if (process.platform !== 'win32') { console.log('Clipboard Windows Job lifecycle test skipped on this platform.'); return; }
  const projectRoot = process.env.PHOTOFLOW_CLIPBOARD_TEST_ROOT || path.resolve(__dirname, '..');
  for (const delayMs of [0, 25, 100, 250, 500]) {
    const supervisor = createProcessSupervisor();
    const launch = supervisor.launch.bind(supervisor);
    let launched;
    const started = new Promise(resolve => { launched = resolve; });
    let child;
    supervisor.launch = specification => {
      assert.equal(specification.windowsJob, true, 'reused clipboard helpers require authoritative process-tree accounting');
      const managed = launch(specification); child = managed.child; launched(); return managed;
    };
    const service = createFileClipboardService({ app: { isPackaged: false }, projectRoot, processSupervisor: supervisor });
    const reading = service.read().catch(error => error);
    await started;
    await new Promise(resolve => setTimeout(resolve, delayMs));
    await supervisor.stopAll('clipboard-quit-race-test');
    await reading;
    assert.equal(child.__photoFlowTreeExitConfirmed, true, `tree confirmation at ${delayMs}ms`);
    assert.equal(child.__photoFlowCloseObserved, true, `helper close at ${delayMs}ms`);
    assert.equal(supervisor.list().length, 0);
  }
  console.log('Clipboard read/quit races passed at 5 timings with Windows Job tree and helper closure confirmed.');
};

run().catch(error => { console.error(error); process.exitCode = 1; });
