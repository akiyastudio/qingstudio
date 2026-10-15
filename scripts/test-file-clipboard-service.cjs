const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { performance } = require('node:perf_hooks');
const { PassThrough, Writable } = require('stream');
const { createProcessSupervisor } = require('../electron/services/process-supervisor.cjs');
const { createFileClipboardService, runJson } = require('../electron/services/file-clipboard-service.cjs');

const root = path.resolve(__dirname, '..');
const nativeSource = fs.readFileSync(path.join(root, 'electron', 'native', 'FileClipboardService.cs'), 'utf8');
const serviceSource = fs.readFileSync(path.join(root, 'electron', 'services', 'file-clipboard-service.cjs'), 'utf8');
const buildSource = fs.readFileSync(path.join(root, 'scripts', 'build-file-clipboard-service.cjs'), 'utf8');

assert(nativeSource.includes('[STAThread]'), 'native clipboard commands must run in an STA apartment');
assert(nativeSource.includes('SetClipboardData(CF_HDROP, dropMemory)') && nativeSource.includes('SetClipboardData(effectFormat, effectMemory)') && nativeSource.includes('Preferred DropEffect'), 'native writes must publish concrete CF_HDROP and Preferred DropEffect buffers');
assert(nativeSource.includes('operation == "cut" ? 2 : 1'), 'copy and cut drop effects must be DWORD values 1 and 2');
assert(nativeSource.includes('GetClipboardSequenceNumber') && nativeSource.includes('case "clear-if-current"'), 'native reads and conditional clearing must use Windows clipboard sequence numbers');
assert(nativeSource.includes('ReadDataObject(Clipboard.GetDataObject())') && nativeSource.includes('DataFormats.FileDrop, false') && nativeSource.includes('DropEffectFormat, false'), 'FileDrop and Preferred DropEffect must come from one IDataObject snapshot');
assert(nativeSource.includes('var before = GetClipboardSequenceNumber()') && nativeSource.includes('if (before == after)'), 'read must reject cross-sequence clipboard snapshots');
assert(nativeSource.includes('OpenClipboard(IntPtr.Zero)') && nativeSource.includes('if (matches && !EmptyClipboard())') && nativeSource.indexOf('OpenClipboard(IntPtr.Zero)') < nativeSource.indexOf('if (matches && !EmptyClipboard())'), 'conditional clear must validate and empty while one clipboard lock is held');
const clearSource = nativeSource.slice(nativeSource.indexOf('private static object ClearIfCurrent'));
assert(clearSource.includes('ReadOpenClipboard()') && clearSource.includes('GetClipboardData(CF_HDROP)') && clearSource.includes('DragQueryFile') && clearSource.includes('GlobalLock') && !clearSource.includes('Clipboard.GetDataObject'), 'ClearIfCurrent must parse CF_HDROP and drop effect through Win32 while its OpenClipboard lock is held');
assert(!nativeSource.includes('wait-left-release') && !nativeSource.includes('GetAsyncKeyState') && !nativeSource.includes('GetCursorPos'), 'clipboard helper must not participate in native drag release arbitration');
assert(nativeSource.includes('Write(ReadRequest())') && nativeSource.includes('写入后回读验证失败'), 'native writes must immediately verify the persisted clipboard payload');
assert(nativeSource.includes('RetryCount') && nativeSource.includes('Thread.Sleep'), 'clipboard busy handling must use bounded short retries');
assert(serviceSource.includes("path.join(process.resourcesPath, 'file-clipboard-service.exe')") && serviceSource.includes("path.join(projectRoot, 'electron', 'bin', 'file-clipboard-service.exe')"), 'the wrapper must resolve packaged and development executables separately');
assert(serviceSource.includes('FILE_CLIPBOARD_SERVICE_MISSING') && !serviceSource.includes('powershell.exe'), 'missing native service errors must be explicit and must not fall back to PowerShell');
assert(!serviceSource.includes('waitForLeftMouseRelease'), 'the Electron clipboard wrapper must not expose drag release waiting');
assert(buildSource.includes('System.Windows.Forms.dll') && buildSource.includes('FileClipboardService.cs'), 'the build must compile the Windows Forms clipboard helper');

const run = async () => {
if (process.platform === 'win32') {
  let launches = 0;
  const commands = [];
  let snapshot = { success: true, sources: [], operation: 'copy', sequence: 0 };
  let mode = 'success';
  const service = createFileClipboardService({ app: { isPackaged: false }, projectRoot: root, timeoutMs: 100,
    processSupervisor: { launch(specification) {
      launches++;
      assert.deepStrictEqual(specification.args, ['serve']);
      assert.strictEqual(specification.windowsJob, true);
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.exitCode = null; child.signalCode = null; child.__photoFlowJobManaged = true;
      child.terminateJob = async () => {
        child.__photoFlowTreeExitConfirmed = true; child.__photoFlowCloseObserved = true;
        child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0);
      };
      child.stdin = new Writable({ write(chunk, _encoding, callback) {
        const request = JSON.parse(chunk.toString()); commands.push(request.command); callback();
        queueMicrotask(() => {
          if (mode === 'timeout') return;
          if (mode === 'disconnect') { child.emit('close', 1); return; }
          let result;
          if (request.command === 'write') {
            if (mode === 'reject') result = { success: false, code: 'FILE_CLIPBOARD_FAILED', error: 'write rejected' };
            else result = snapshot = { success: true, sources: request.sources, operation: request.operation, sequence: snapshot.sequence + 1 };
          } else if (request.command === 'clear-if-current') {
            const cleared = request.sequence === snapshot.sequence && snapshot.operation === 'cut';
            if (cleared) snapshot = { ...snapshot, sources: [], operation: 'copy', sequence: snapshot.sequence + 1 };
            result = { ...snapshot, cleared };
          } else result = snapshot;
          child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
        });
      } });
      queueMicrotask(() => child.stdout.write('{"ready":true,"protocol":"photoflow-clipboard-v1"}\n'));
      return { child };
    } },
  });
  try {
    await service.warm();
    assert.strictEqual(commands.length, 0, 'warmup must not inspect or mutate the system clipboard');
    const copy = service.write(['first.txt'], 'copy');
    const cut = service.write(['second.txt'], 'cut');
    const reading = service.read();
    await Promise.all([copy, cut]);
    const latest = await reading;
    assert.deepStrictEqual(commands, ['write', 'write', 'read'], 'immediate paste/read waits for all queued clipboard writes');
    assert.strictEqual(latest.operation, 'cut');
    assert.deepStrictEqual(latest.sources, ['second.txt']);
    assert.strictEqual(launches, 1, 'prewarmed copy/cut/read operations reuse one helper');
    assert.strictEqual((await service.clearIfCurrent({ ...latest, sequence: latest.sequence - 1 })).cleared, false);
    assert.strictEqual((await service.clearIfCurrent(latest)).cleared, true);
    mode = 'reject';
    await assert.rejects(service.write(['missing.txt'], 'copy'), error => error.code === 'FILE_CLIPBOARD_FAILED' && !error.outcomeUnknown);
    mode = 'success'; await service.read();
    assert.strictEqual(launches, 1, 'an ordinary command failure keeps the helper reusable');
    for (const failure of ['timeout', 'disconnect']) {
      mode = failure; const before = commands.length;
      await assert.rejects(service.write(['uncertain.txt'], 'cut'), error => error.outcomeUnknown === true && error.code === (failure === 'timeout' ? 'FILE_CLIPBOARD_TIMEOUT' : 'FILE_CLIPBOARD_DISCONNECTED'));
      assert.strictEqual(commands.length, before + 1, 'uncertain writes must never be replayed');
      mode = 'success'; await service.read();
    }
    assert.strictEqual(launches, 3, 'later requests restart only after failed helpers are terminated');
  } finally { await service.stop(); }
  await assert.rejects(service.read(), /停止/);
}
{
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null; let killed = false;
  child.kill = () => { killed = true; setImmediate(() => { child.exitCode = 1; child.emit('exit', 1, null); child.emit('close', 1, null); }); return true; };
  await assert.rejects(runJson('helper', [], '', 5, { launch: () => ({ child }) }), error => error.code === 'FILE_CLIPBOARD_TIMEOUT' && error.outcomeUnknown === true);
  assert.strictEqual(killed, true, 'clipboard timeout must terminate and wait for helper exit before returning');
}
if (process.platform === 'win32') {
  const nativeProjectRoot = process.env.PHOTOFLOW_CLIPBOARD_TEST_ROOT || root;
  const builtExecutable = path.join(nativeProjectRoot, 'electron', 'bin', 'file-clipboard-service.exe');
  const runNative = (args, options = {}) => spawnSync(builtExecutable, args, { encoding: 'utf8', windowsHide: true, timeout: 12000, ...options });
  if (fs.existsSync(builtExecutable)) {
    const readResult = runNative(['read']);
    assert.strictEqual(readResult.status, 0, readResult.stderr);
    const snapshot = JSON.parse(readResult.stdout.trim());
    assert(Array.isArray(snapshot.sources) && Number.isInteger(snapshot.sequence), 'native read must return sources and the Windows sequence number');
    const clearResult = runNative(['clear-if-current'], { input: JSON.stringify({ sequence: snapshot.sequence + 1, sources: snapshot.sources }) });
    assert.strictEqual(clearResult.status, 0, clearResult.stderr);
    assert.strictEqual(JSON.parse(clearResult.stdout.trim()).cleared, false, 'a stale sequence must never clear the clipboard');
    const nativeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-clipboard-native-')); const nativeFile = path.join(nativeRoot, 'cut.txt');
    const supervisor = createProcessSupervisor();
    const launch = supervisor.launch.bind(supervisor); let nativeLaunches = 0;
    supervisor.launch = specification => { nativeLaunches++; return launch(specification); };
    const service = createFileClipboardService({ app: { isPackaged: false }, projectRoot: nativeProjectRoot, processSupervisor: supervisor });
    try {
      fs.writeFileSync(nativeFile, 'cut');
      const coldTimes = []; const warmTimes = [];
      for (let index = 0; index < 8; index++) {
        const start = performance.now();
        const written = runNative(['write'], { input: JSON.stringify({ sources: [nativeFile], operation: index % 2 ? 'cut' : 'copy' }) });
        coldTimes.push(performance.now() - start);
        assert.strictEqual(written.status, 0, written.stderr);
      }
      await service.warm();
      for (let index = 0; index < 8; index++) {
        const start = performance.now();
        const written = await service.write([nativeFile], index % 2 ? 'cut' : 'copy').catch(error => {
          error.message = `persistent write sample ${index}: ${error.message}`;
          throw error;
        });
        warmTimes.push(performance.now() - start);
        assert.deepStrictEqual(written.sources, [nativeFile]);
        assert.strictEqual(written.operation, index % 2 ? 'cut' : 'copy');
        // A same-process read can pass even when the idle owner blocks OLE RPC.
        // Probe each copy/cut from another process while the owner remains alive.
        const externalRead = runNative(['read'], { timeout: 3000 });
        assert.strictEqual(externalRead.status, 0, `idle clipboard owner must answer external reads: ${externalRead.error || externalRead.stderr}`);
        assert.deepStrictEqual(JSON.parse(externalRead.stdout.trim()), written);
      }
      await assert.rejects(service.write([path.join(nativeRoot, 'missing.txt')], 'copy'), /不存在/);
      const cut = await service.read();
      const externalRead = runNative(['read']);
      assert.strictEqual(externalRead.status, 0, externalRead.stderr);
      assert.deepStrictEqual(JSON.parse(externalRead.stdout.trim()), cut, 'persisted data must be readable from another process');
      assert.strictEqual((await service.clearIfCurrent({ ...cut, sequence: cut.sequence - 1 })).cleared, false);
      const externalCopy = runNative(['write'], { input: JSON.stringify({ sources: [nativeFile], operation: 'copy' }) });
      assert.strictEqual(externalCopy.status, 0, externalCopy.stderr);
      assert.strictEqual((await service.clearIfCurrent(cut)).cleared, false, 'an external clipboard replacement must survive stale cut cleanup');
      const nextCut = await service.write([nativeFile], 'cut');
      assert.strictEqual((await service.clearIfCurrent(nextCut)).cleared, true, 'an exact cut snapshot is atomically cleared');
      assert.strictEqual(nativeLaunches, 1, 'all native operations, including recovery from invalid sources, reuse one supervised helper');
      const unicodeFile = path.join(nativeRoot, '中文 照片 📷.txt');
      const nativeFolder = path.join(nativeRoot, '文件夹');
      fs.writeFileSync(unicodeFile, 'unicode file');
      fs.mkdirSync(nativeFolder);
      fs.writeFileSync(path.join(nativeFolder, 'nested.txt'), 'nested file');
      const persistedCopy = await service.write([nativeFile, unicodeFile, nativeFolder], 'copy');
      const mixedRead = runNative(['read'], { timeout: 3000 });
      assert.strictEqual(mixedRead.status, 0, mixedRead.error || mixedRead.stderr);
      assert.deepStrictEqual(JSON.parse(mixedRead.stdout.trim()), persistedCopy, 'multiple Unicode file and folder paths round-trip through CF_HDROP');
      const eofResult = runNative(['serve'], { input: JSON.stringify({ id: 'eof-read', command: 'read' }) + '\n', timeout: 3000 });
      assert.strictEqual(eofResult.status, 0, eofResult.error || eofResult.stderr);
      const eofResponses = eofResult.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
      assert.strictEqual(eofResponses.length, 2, 'serve exits after completing queued input on EOF');
      assert.strictEqual(eofResponses[0].ready, true);
      assert.deepStrictEqual(eofResponses[1], { id: 'eof-read', result: persistedCopy });
      await service.stop();
      const afterStop = runNative(['read'], { timeout: 3000 });
      assert.strictEqual(afterStop.status, 0, afterStop.error || afterStop.stderr);
      assert.deepStrictEqual(JSON.parse(afterStop.stdout.trim()), persistedCopy, 'copied files remain available after the helper exits');
      const medianMs = values => Math.round([...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] * 10) / 10;
      console.log(`Native clipboard write (8 samples): one-shot median ${medianMs(coldTimes)} ms, prewarmed median ${medianMs(warmTimes)} ms, first prewarmed write ${Math.round(warmTimes[0] * 10) / 10} ms.`);
    } finally {
      await service.stop(); await supervisor.stopAll('clipboard-test-cleanup');
      fs.rmSync(nativeRoot, { recursive: true, force: true });
    }
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-file-clipboard-missing-'));
  try {
    const service = createFileClipboardService({ app: { isPackaged: false }, projectRoot: sandbox });
    assert(service.executable().endsWith(path.join('electron', 'bin', 'file-clipboard-service.exe')));
    await assert.rejects(service.read(), error => error.code === 'FILE_CLIPBOARD_SERVICE_MISSING');
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
}
console.log('file clipboard service tests passed');
};
run().catch(error => { console.error(error); process.exit(1); });
