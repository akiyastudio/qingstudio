const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
if (process.platform !== 'win32') {
  const source = path.join(root, 'electron', 'native', 'FilePublicationServicePosix.c');
  const target = path.join(root, 'electron', 'bin', 'file-publication-service');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const compiler = process.env.CC || 'cc';
  const result = spawnSync(compiler, ['-O2', '-std=c11', '-o', target, source], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`POSIX 文件发布辅助程序构建失败：${result.stderr || result.stdout}`);
  fs.chmodSync(target, 0o755); console.log(`已构建 ${target}`); process.exit(0);
}
const source = path.join(root, 'electron', 'native', 'FilePublicationService.cs');
const manifest = path.join(root, 'electron', 'native', 'FilePublicationService.manifest');
const target = path.join(root, 'electron', 'bin', 'file-publication-service.exe');
const frameworkRoots = [path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319'), path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319')];
const frameworkRoot = frameworkRoots.find(candidate => fs.existsSync(path.join(candidate, 'csc.exe')));
if (!frameworkRoot) throw new Error('找不到 Windows C# 编译器，无法构建文件发布辅助程序。');
fs.mkdirSync(path.dirname(target), { recursive: true });
const result = spawnSync(path.join(frameworkRoot, 'csc.exe'), ['/nologo', '/optimize+', '/target:exe', `/out:${target}`, `/win32manifest:${manifest}`, `/reference:${path.join(frameworkRoot, 'System.Web.Extensions.dll')}`, source], { encoding: 'utf8', windowsHide: true });
if (result.status !== 0) throw new Error(`文件发布辅助程序构建失败：${result.stderr || result.stdout}`);
console.log(`已构建 ${target}`);
