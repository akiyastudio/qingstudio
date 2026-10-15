const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { registerComponentProjectCapabilities, stableUuid } = require('../electron/services/component-project-capabilities.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-rollback-scope-'));
for (const name of ['project-a', 'project-b']) fs.mkdirSync(path.join(root, name));
const handlers = new Map();
const descriptor = { componentId: 'scope-test' };
const context = { workspacePath: root, projectId: 'project-a', projectName: 'project-a' };
const receipts = path.join(root, 'data/components/scope-test/receipts/commits');
registerComponentProjectCapabilities({
  broker: { register: (name, handler) => handlers.set(name, handler) },
  ensureWorkspace: () => root,
  getWorkspaceDataRoot: () => path.join(root, 'data'),
  getBoundProject: (_workspace, name) => ({ id: name, name }),
  getProjectPath: (_workspace, _status, name) => path.join(root, name),
  path, fs, crypto, IMAGE_EXTENSIONS: new Set(['.png']),
});
const output = (payload, scope = context) => handlers.get('project.output')(payload, scope, descriptor);
const stageFile = async scope => {
  const stage = await output({ action: 'stage' }, scope);
  await output({ action: 'write', stageId: stage.stageId, name: 'sample.png', outputRelativePath: 'sample.png', base64: Buffer.from('sample').toString('base64') }, scope);
  return stage;
};

(async () => {
  const other = { ...context, projectId: 'project-b', projectName: 'project-b' };
  const foreignStage = await stageFile(other);
  const foreignCommit = await output({ action: 'commit', stageId: foreignStage.stageId, idempotencyKey: 'foreign-project' }, other);
  const foreignPath = path.join(receipts, `${foreignCommit.commitId}.json`);
  const foreignBytes = fs.readFileSync(foreignPath);
  const stage = await stageFile(context);
  const metadata = JSON.parse(fs.readFileSync(path.join(path.dirname(stage.privatePath), 'stage.json'), 'utf8'));
  const file = metadata.files[0];
  const commitId = stableUuid(crypto, 'local-prepared');
  const receiptPath = path.join(receipts, `${commitId}.json`);
  const receipt = {
    schemaVersion: 1, kind: 'component-output-commit', state: 'prepared', commitId,
    idempotencyKey: 'local-prepared', componentId: descriptor.componentId,
    projectId: context.projectId, scopeDigest: metadata.scopeDigest,
    stageId: stage.stageId, createdAt: Date.now(),
    outputs: [{ artifactId: file.artifactId, relativePath: file.outputRelativePath, size: 6, sha256: crypto.createHash('sha256').update('sample').digest('hex'), published: false }],
  };
  const otherScopePath = path.join(receipts, `${stableUuid(crypto, 'other-workspace')}.json`);
  fs.writeFileSync(otherScopePath, JSON.stringify({ ...receipt, commitId: path.basename(otherScopePath, '.json'), scopeDigest: '0'.repeat(64) }));
  const otherScopeBytes = fs.readFileSync(otherScopePath);
  fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, outputs: [{ ...receipt.outputs[0], artifactId: 'invalid' }] }));
  await assert.rejects(output({ action: 'rollback', stageId: stage.stageId }), error => error.code === 'COMPONENT_HOST_PERMISSION_DENIED');
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  assert.equal((await output({ action: 'rollback', stageId: stage.stageId })).rolledBack, true);
  assert(!fs.existsSync(receiptPath));
  assert.deepEqual(fs.readFileSync(foreignPath), foreignBytes);
  assert.deepEqual(fs.readFileSync(otherScopePath), otherScopeBytes);
  assert.equal(fs.readFileSync(path.join(root, 'project-b/sample.png'), 'utf8'), 'sample');
  const realRename = fs.promises.rename;
  fs.promises.rename = async (source, destination) => {
    if (String(source).startsWith(path.join(root, 'project-b')) && String(destination).startsWith(path.join(root, 'data'))) {
      throw Object.assign(new Error('simulated cross-volume rename'), { code: 'EXDEV' });
    }
    return realRename(source, destination);
  };
  try {
    const payload = { action: 'delete', previousCommitId: foreignCommit.commitId, previousArtifactId: foreignCommit.outputs[0].artifactId, expectedDigest: foreignCommit.outputs[0].sha256, idempotencyKey: 'cross-volume-delete' };
    const target = path.join(root, 'project-b/sample.png');
    fs.writeFileSync(target, 'changed');
    await assert.rejects(output(payload, other), error => error.code === 'COMPONENT_HOST_CONFLICT');
    assert.equal(fs.readFileSync(target, 'utf8'), 'changed');
    fs.writeFileSync(target, 'sample');
    assert.equal((await output(payload, other)).deleted, true, 'deletion succeeds without moving to the app data volume');
    assert.equal((await output(payload, other)).deleted, true, 'deletion receipt makes retries idempotent');
    assert(!fs.existsSync(target));
    assert.deepEqual(fs.readdirSync(path.dirname(target)), []);
  } finally { fs.promises.rename = realRename; }
  console.log('PASS: scoped rollback and cross-volume controlled deletion');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
