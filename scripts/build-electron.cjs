const path = require('node:path');
const { parseReleaseVersion } = require('./release-version.cjs');

// electron-builder normalizes package.json with SemVer, which has only three
// numeric fields. Adapt this one package in memory; preserve the public version
// in app.asar, executable resources and installer names, without editing files.
const installVersionAdapter = packageName => {
  const normalizer = require('app-builder-lib/out/util/normalizePackageData');
  const original = normalizer.normalizePackageData;
  normalizer.normalizePackageData = data => {
    if (data.name !== packageName) return original(data);
    const version = data.version;
    const { date, revision } = parseReleaseVersion(version);
    data.version = `${date}-${revision}`;
    try { return original(data); }
    finally { data.version = version; }
  };
  return () => { normalizer.normalizePackageData = original; };
};

const builderConfigFor = version => {
  const { revision } = parseReleaseVersion(version);
  return { buildVersion: version, buildNumber: String(revision) };
};

const run = async () => {
  const root = path.resolve(__dirname, '..');
  const metadata = require('../package.json');
  const restore = installVersionAdapter(metadata.name);
  try {
    await require('electron-builder').build({ projectDir: root, config: builderConfigFor(metadata.version), publish: 'never' });
  } finally { restore(); }
};

if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { installVersionAdapter, builderConfigFor };
