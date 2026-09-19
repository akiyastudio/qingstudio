const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
assert.equal(require('../package.json').license, 'Apache-2.0');
assert.equal(require('../electron/cloud-config.cjs').apiBaseUrl, '');
assert.equal(fs.existsSync(path.join(root, 'extensions')), false);
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'python/birthdays.json'), 'utf8')), {});
const { createPrivacyService } = require('../electron/privacy-service.cjs');
const service = createPrivacyService({ app: { isPackaged: false }, path, shell: { openPath: async () => '' }, projectRoot: root });
assert.equal(service.hasCoreConsent(), true);
assert.equal(service.hasFaceRecognitionConsent(), false);
assert.equal(service.getState().experienceProgramGranted, false);
(async () => {
  await assert.rejects(service.saveConsent({ faceRecognitionGranted: true }));
  assert.equal((await service.openLegalDocument('privacy')).success, false);
  assert.equal((await service.openLegalDocument('open-source')).success, true);
  // Every static local CommonJS dependency must resolve without private code.
  for (const directory of ['electron', 'scripts', 'component-sdk']) {
    for (const file of fs.readdirSync(path.join(root, directory), { recursive: true }).filter(f => f.endsWith('.cjs'))) {
      const absolute = path.join(root, directory, file);
      for (const match of fs.readFileSync(absolute, 'utf8').matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
        assert.doesNotThrow(() => require.resolve(path.resolve(path.dirname(absolute), match[1])), `${directory}/${file}: ${match[1]}`);
      }
    }
  }
  console.log('Public source boundaries and disabled commercial services verified.');
})().catch(error => { console.error(error); process.exitCode = 1; });
