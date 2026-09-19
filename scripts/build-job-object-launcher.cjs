const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') process.exit(0);
const root = path.resolve(__dirname, '..');
const framework = ['Framework64', 'Framework'].map(name => path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', name, 'v4.0.30319')).find(candidate => fs.existsSync(path.join(candidate, 'csc.exe')));
if (!framework) throw new Error('找不到 Windows C# 编译器，无法构建 Job Object launcher。');
const source = path.join(root, 'electron', 'native', 'JobObjectLauncher.cs');
const output = path.join(root, 'electron', 'bin', 'job-object-launcher.exe');
const temporaryOutput = path.join(root, 'electron', 'bin', `job-object-launcher.${process.pid}.tmp.exe`);
const identity = path.join(root, 'electron', 'generated', 'job-object-launcher-identity.json');
const temporaryIdentity = `${identity}.${process.pid}.tmp`;
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.mkdirSync(path.dirname(identity), { recursive: true });
const result = spawnSync(path.join(framework, 'csc.exe'), [
  '/nologo', '/optimize+', '/target:exe', '/platform:x64', `/out:${temporaryOutput}`,
  `/reference:${path.join(framework, 'System.Web.Extensions.dll')}`, source,
], { cwd: root, encoding: 'utf8', windowsHide: true });
if (result.status !== 0) { fs.rmSync(temporaryOutput, { force: true }); throw new Error(result.stderr || result.stdout || 'Job Object launcher 构建失败'); }
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(temporaryOutput)).digest('hex');
fs.writeFileSync(temporaryIdentity, `${JSON.stringify({ schemaVersion: 2, developmentFile: 'job-object-launcher.exe', packagedFile: 'job-object-launcher.exe', sha256 })}\n`);
fs.renameSync(temporaryOutput, output);
fs.renameSync(temporaryIdentity, identity);
console.log(`Built ${output} (${sha256.slice(0, 12)})`);
