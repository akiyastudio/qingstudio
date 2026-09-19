const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { developmentRoots } = require('../electron/component-development.cjs');

const projectRoot = path.resolve(__dirname, '..');
const packages = [];
for (const root of developmentRoots({ projectRoot })) {
  const candidates = [root, ...fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink?.()).map(entry => path.join(root, entry.name))];
  for (const directory of candidates) {
    const packagePath = path.join(directory, 'package.json');
    const stat = fs.lstatSync(packagePath, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const script = manifest.photoflowComponent?.development?.prepare;
    if (!script) continue;
    if (typeof script !== 'string' || !/^[a-z0-9:._-]{1,80}$/i.test(script) || !manifest.scripts?.[script]) throw new Error(`Invalid development prepare declaration: ${packagePath}`);
    packages.push({ directory, name: manifest.name || path.basename(directory), script });
  }
}
const runComponent = async component => {
  const startedAt = Date.now();
  console.log(`[dev-startup] Preparing ${component.name}...`);
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('npm_execpath is unavailable; run development preparation through npm');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, 'run', component.script], { cwd: component.directory, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Development component prepare failed: ${component.name}`)));
  });
  console.log(`[dev-startup] ${component.name}: ${Date.now() - startedAt} ms`);
};
// Separate component environments can prepare concurrently. Wait for every
// in-flight process even on failure, and never start Electron after a failed batch.
const prepareComponents = async (components, run = runComponent) => {
  for (let index = 0; index < components.length; index += 2) {
    const results = await Promise.allSettled(components.slice(index, index + 2).map(component => Promise.resolve().then(() => run(component))));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
};
if (require.main === module) {
  const startedAt = Date.now();
  prepareComponents(packages).then(() => console.log(`Prepared ${packages.length} discovered development component(s) in ${Date.now() - startedAt} ms.`))
    .catch(error => { console.error(error.message || String(error)); process.exitCode = 1; });
}
module.exports = { prepareComponents };
