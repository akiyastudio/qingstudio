const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') process.exit(0);
const root = path.join(__dirname, '..');
const source = path.join(root, 'electron', 'native', 'FileClipboardService.cs');
const target = path.join(root, 'electron', 'bin', 'file-clipboard-service.exe');
const frameworkRoots = [
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319'),
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319'),
];
const frameworkRoot = frameworkRoots.find(candidate => fs.existsSync(path.join(candidate, 'csc.exe')));
if (!frameworkRoot) throw new Error('找不到 Windows C# 编译器，无法构建文件剪贴板辅助程序。');
if (fs.existsSync(target) && fs.statSync(target).mtimeMs >= fs.statSync(source).mtimeMs) process.exit(0);
fs.mkdirSync(path.dirname(target), { recursive: true });
const result = spawnSync(path.join(frameworkRoot, 'csc.exe'), [
  '/nologo', '/optimize+', '/target:exe', `/out:${target}`,
  `/reference:${path.join(frameworkRoot, 'System.Web.Extensions.dll')}`,
  `/reference:${path.join(frameworkRoot, 'System.Windows.Forms.dll')}`,
  source,
], { encoding: 'utf8', windowsHide: true });
if (result.status !== 0) throw new Error(`文件剪贴板辅助程序构建失败：${result.stderr || result.stdout}`);
console.log(`已构建 ${target}`);
