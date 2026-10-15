const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createArchiveService } = require('../electron/services/compressed-files/operations.cjs');
const { enginePath, archiveFolderName } = require('../electron/services/compressed-files/engine.cjs');
const { publicContext } = require('../electron/services/component-service-manager.cjs');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-archive-service-'));
  const project = path.join(root, 'project'), storage = path.join(root, 'private');
  fs.mkdirSync(path.join(project, '照片', '空目录'), { recursive: true }); fs.mkdirSync(storage);
  fs.writeFileSync(path.join(project, '照片', 'a.jpg'), 'synthetic-image');
  fs.writeFileSync(path.join(project, '照片', 'note.txt'), 'hello');
  const tokens = new Map(), stages = new Map(), receipts = new Map(), tasks = new Map(), calls = [];
  let failCommit = false, slowCopy = false, settings = {};
  const enumerate = () => {
    const entries = [], pending = [''];
    for (let index = 0; index < pending.length; index++) for (const item of fs.readdirSync(path.join(project, pending[index]), { withFileTypes: true })) {
      const relativePath = [pending[index], item.name].filter(Boolean).join('/');
      entries.push({ relativePath, name: item.name, kind: item.isDirectory() ? 'directory' : 'file' });
      if (item.isDirectory()) pending.push(relativePath);
    }
    return entries;
  };
  const host = async (_parentId, method, payload) => {
    calls.push(method);
    if (method === 'component.storage') return { dataPath: storage };
    if (method === 'component.settings') {
      if (payload.action === 'merge') settings = { ...settings, ...payload.settings };
      return { settings: { ...settings }, revision: 1 };
    }
    if (method === 'tasks') {
      if (payload.action === 'start') tasks.set(payload.operationId, { state: 'running' });
      const task = tasks.get(payload.operationId);
      if (task && ['cancel', 'complete', 'fail'].includes(payload.action)) task.state = payload.action === 'cancel' ? 'cancelled' : payload.action === 'complete' ? 'completed' : 'failed';
      return { task, cancelled: task?.state === 'cancelled' };
    }
    if (method === 'project.files.page' || method === 'project.media.page') {
      const items = enumerate().filter(item => method === 'project.media.page' ? /\.jpg$/.test(item.relativePath) : !/\.jpg$/.test(item.relativePath));
      return { items, page: { hasMore: false, truncated: false } };
    }
    if (method === 'project.files.inputToken') {
      if (slowCopy) await new Promise(resolve => setTimeout(resolve, 100));
      const input = crypto.randomUUID(), target = path.join(project, payload.relativePath);
      tokens.set(input, target);
      return { input: { token: input }, byteLength: fs.statSync(target).size };
    }
    if (method === 'project.input.tokens') return { privatePath: tokens.get(payload.token) };
    if (method === 'project.output') {
      if (payload.action === 'stage') {
        const stageId = crypto.randomUUID(), privatePath = path.join(storage, stageId); fs.mkdirSync(privatePath);
        stages.set(stageId, { privatePath, outputs: [] }); return { stageId, privatePath };
      }
      if (payload.action === 'rollback') return { rolledBack: true };
      const stage = stages.get(payload.stageId);
      if (payload.action === 'write') { stage.outputs.push(payload); return { artifactId: crypto.randomUUID() }; }
      if (payload.action === 'validate') return { valid: true };
      if (payload.action === 'commit') {
        assert.equal(payload.onConflict, 'rename', 'collisions always preserve existing files by renaming');
        if (receipts.has(payload.idempotencyKey)) return receipts.get(payload.idempotencyKey);
        if (failCommit) { failCommit = false; throw new Error('synthetic publication failure'); }
        const outputs = stage.outputs.map(item => {
          let relativePath = item.outputRelativePath, target = path.join(project, relativePath), suffix = 1;
          while (fs.existsSync(target)) { relativePath = item.outputRelativePath + ` (${suffix++})`; target = path.join(project, relativePath); }
          fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(stage.privatePath, item.sourceName), target);
          return { relativePath, artifactId: crypto.randomUUID() };
        });
        const result = { commitId: crypto.randomUUID(), outputs }; receipts.set(payload.idempotencyKey, result); return result;
      }
    }
    if (method === 'project.files.mutate') {
      if (payload.phase === 'preflight') return { planToken: payload.targetRelativePath };
      fs.mkdirSync(path.join(project, payload.planToken), { recursive: true }); return { committed: true };
    }
    throw new Error(`Unexpected host capability: ${method}`);
  };
  const context = { componentId: 'archive-tools', componentVersion: '1', surface: 'component.sidePanel', projectId: 'fixture', projectName: 'Fixture', projectStatus: 'active', contentKind: 'project' };
  const frame = (method, payload, contributionId = 'add') => ({
    id: crypto.randomUUID(), method,
    payload: { ...(method === 'compression.run.v1' ? { mode: contributionId === 'add' ? 'compress' : 'extract' } : {}), ...payload },
    context: publicContext({ ...context, contributionId }),
  });
  try {
    let service = createArchiveService(host, { executable: enginePath() });
    assert.equal(frame('compression.run.v1', {}).context.contributionId, undefined, 'the real Host service context intentionally omits the UI entry ID');
    for (const mode of [undefined, null, 'add', 'unknown']) await assert.rejects(service.handle(frame('compression.run.v1', { relativePaths: ['照片/a.jpg'], mode })), /请选择压缩或解压操作/);
    assert.equal(calls.length, 0, 'invalid operation types are rejected before reading or writing files');
    assert.equal((await service.handle(frame('compression.preferences.v1', {}))).format, 'zip', 'a fresh plugin defaults to ZIP');
    await service.handle(frame('compression.preferences.v1', { format: '7z' }));
    const reopened = createArchiveService(host, { executable: enginePath() });
    assert.equal((await reopened.handle(frame('compression.preferences.v1', {}))).format, '7z', 'format is restored across service instances');
    await assert.rejects(service.handle(frame('compression.preferences.v1', { format: 'rar' })), /不支持的压缩格式/);
    let job = await service.handle(frame('compression.run.v1', { relativePaths: ['照片'], mode: 'compress', name: '照片', format: '7z', password: 'secret-test-only' }));
    assert.equal(job.state, 'completed'); assert.equal(job.outputs.length, 1);
    assert(fs.existsSync(path.join(project, '照片.7z')));
    assert(calls.includes('project.media.page'), 'selected folders collect both media and ordinary files');
    fs.mkdirSync(path.join(project, '批量照片'));
    const batch = Array.from({ length: 20 }, (_, index) => `批量照片/照片-${index}.jpg`);
    for (const name of batch) fs.writeFileSync(path.join(project, name), `synthetic-photo-${name}`);
    for (const format of ['zip', '7z']) {
      const packed = await service.handle(frame('compression.run.v1', { relativePaths: batch, format, comment: format === 'zip' ? '项目照片说明' : '', onConflict: 'error' }));
      assert.equal(packed.state, 'completed', `20 ordinary photos must be compressed as ${format} without a contributionId in the service context`);
      assert.equal(packed.outputs[0].relativePath, `批量照片/批量照片.${format}`, 'archive names default to the containing folder');
    }
    const rootFile = 'root.txt'; fs.writeFileSync(path.join(project, rootFile), 'fixture');
    const rootArchive = await service.handle(frame('compression.run.v1', { relativePaths: [rootFile] }));
    assert.equal(rootArchive.outputs[0].relativePath, 'Fixture.zip', 'project-root files use the project folder name and ZIP by default');
    await assert.rejects(service.handle(frame('compression.run.v1', { relativePaths: batch, format: '7z', comment: 'not-supported' })), /不支持压缩包注释/);
    for (const [archive, expected] of [['素材.zip', '素材'], ['素材.7z.001', '素材'], ['素材.tar.gz', '素材'], ['素材.part01.rar', '素材']]) assert.equal(archiveFolderName(archive), expected);
    const beforeRead = enumerate().length;
    const listing = await service.handle(frame('compression.inspect.v1', { relativePath: '批量照片/批量照片.zip' }, 'browse'));
    assert.equal(listing.entries.length, 20);
    assert.equal(listing.totalBytes, batch.reduce((sum, name) => sum + fs.statSync(path.join(project, name)).size, 0));
    assert.equal(enumerate().length, beforeRead, 'opening archives never extracts or writes project files');
    await assert.rejects(service.handle(frame('compression.inspect.v1', { relativePath: '照片.7z' }, 'browse')), error => error.code === 'ARCHIVE_PASSWORD_REQUIRED');
    const protectedListing = await service.handle(frame('compression.inspect.v1', { relativePath: '照片.7z', password: 'secret-test-only' }, 'browse'));
    assert(protectedListing.entries.some(item => item.relativePath === '照片/a.jpg'));
    assert(!fs.readdirSync(path.join(storage, 'archive-operations')).some(name => name.startsWith('inspect-')), 'inspection inputs are cleaned on success and password failures');
    const original = fs.readFileSync(path.join(project, '照片', 'a.jpg'));
    job = await service.handle(frame('compression.run.v1', { relativePaths: ['照片.7z'], password: 'secret-test-only' }, 'extract-here'));
    assert.equal(job.state, 'completed'); assert.equal(job.outputs.length, 2);
    assert(job.outputs.every(item => item.relativePath.startsWith('照片 (2)/')), 'a dedicated archive-named folder is automatically renamed if it already exists');
    assert(fs.existsSync(path.join(project, '照片 (2)', '照片', '空目录')), 'empty directories stay inside the new output folder');
    const unpacked = await service.handle(frame('compression.run.v1', { relativePaths: ['批量照片/批量照片.zip'], directoryMode: 'here' }, 'extract-panel'));
    assert.equal(unpacked.state, 'completed');
    assert(unpacked.outputs.every(item => item.relativePath.startsWith('批量照片/批量照片/')), 'all extraction entry points enforce the archive-named folder even for legacy payloads');
    assert.deepEqual(fs.readFileSync(path.join(project, '照片', 'a.jpg')), original, 'extracting never overwrites the original');
    job = await service.handle(frame('compression.run.v1', { relativePaths: ['照片.7z'], password: 'wrong' }, 'extract-panel'));
    assert.equal(job.state, 'failed'); assert.equal(job.errorCode, 'ARCHIVE_PASSWORD_REQUIRED');
    failCommit = true;
    job = await service.handle(frame('compression.run.v1', { relativePaths: ['照片/note.txt'], mode: 'compress', format: 'zip', name: '恢复测试' }));
    assert.equal(job.state, 'publication-failed');
    const pendingId = job.operationId;
    service = createArchiveService(host, { executable: enginePath() });
    job = await service.handle(frame('compression.current.v1', { operationId: pendingId }));
    assert.equal(job.state, 'publication-failed', 'pending stages survive service restart');
    job = await service.handle(frame('compression.publish.v1', { operationId: pendingId }));
    assert.equal(job.state, 'completed');
    assert(fs.existsSync(path.join(project, '照片', '恢复测试.zip')));
    for (const file of fs.readdirSync(path.join(storage, 'archive-operations')).filter(name => name.endsWith('.json'))) assert(!fs.readFileSync(path.join(storage, 'archive-operations', file), 'utf8').includes('secret-test-only'), 'operation records must not persist passwords');
    slowCopy = true;
    const pending = service.handle(frame('compression.run.v1', { relativePaths: ['照片/note.txt'], mode: 'compress', format: 'zip', name: '取消测试' }));
    let active;
    for (let attempt = 0; attempt < 100 && !active; attempt++) { active = [...service.jobs.values()].find(item => item.state === 'running'); if (!active) await new Promise(resolve => setTimeout(resolve, 10)); }
    assert(active);
    await service.handle(frame('compression.cancel.v1', { operationId: active.id }));
    assert.equal((await pending).state, 'cancelled');
    assert(!fs.existsSync(path.join(project, '照片', '取消测试.zip')));
    const { createCompressedFilesService } = require('../electron/services/compressed-files/native-service.cjs');
    const access = require('../electron/services/media-access-service.cjs').createMediaAccessService({ getWorkspaceRoots: () => [] });
    const grants = new Map(); let openedPath;
    const native = createCompressedFilesService({ broker: { invoke: (_descriptor, method, payload) => host('native', method, payload) }, resolveContext: async value => value, mediaAccessService: { ...access, grantPath: target => { const id = access.grantPath(target); grants.set(id, target); return id; }, revokeToken: async token => { grants.delete(token); await access.revokeToken(token); } }, shell: { openPath: async target => { openedPath = target; return ''; } }, executable: enginePath() });
    const session = await native.request(1, { action: 'open', context, relativePath: '批量照片/批量照片.zip' });
    assert.equal(session.entries.length, 20);
    assert(session.entries.every(entry => entry.inputPath.startsWith('media-token:')));
    const lazyInput = session.entries[0].inputPath;
    const [lazyPath, samePath] = await Promise.all([access.authorizeInput(lazyInput), access.authorizeInput(lazyInput)]);
    assert.equal(lazyPath, samePath, 'concurrent thumbnail/original requests materialize one member');
    assert.deepEqual(access.inputAliasesForPath(lazyPath), [lazyInput], 'thumbnail notifications retain the virtual input identity');
    await assert.rejects(native.request(2, { action: 'member', sessionId: session.sessionId, relativePath: '照片-0.jpg' }), /已关闭/);
    await assert.rejects(native.request(1, { action: 'member', sessionId: session.sessionId, relativePath: '../outside' }));
    const member = await native.request(1, { action: 'member', sessionId: session.sessionId, relativePath: '照片-0.jpg' });
    assert(member.mediaUrl.startsWith('photoflow-media://file/'));
    assert.equal(fs.readFileSync([...grants.values()][0], 'utf8'), 'synthetic-photo-批量照片/照片-0.jpg');
    await native.request(1, { action: 'member', sessionId: session.sessionId, relativePath: '照片-0.jpg', openExternal: true });
    assert(openedPath && fs.existsSync(openedPath));
    const temporary = openedPath;
    await native.request(1, { action: 'close', sessionId: session.sessionId });
    assert.equal(grants.size, 0); assert(!fs.existsSync(temporary), 'closing the archive revokes access and cleans materialized members');
    await assert.rejects(access.authorizeInput(lazyInput), /已失效/);
    assert.deepEqual(access.inputAliasesForPath(lazyPath), [], 'closed archive aliases cannot receive thumbnail notifications');
    const encrypted = await native.request(1, { action: 'open', context, relativePath: '照片.7z', password: 'secret-test-only' });
    const text = await native.request(1, { action: 'member', sessionId: encrypted.sessionId, relativePath: '照片/note.txt' });
    assert.equal(text.text, 'hello');
    await native.destroy();
    console.log('Archive service scoped input, media/folder compression, safe publication, password failure, cancellation and restart recovery tests passed.');
  } finally { if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('photoflow-archive-service-')) fs.rmSync(root, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
