const { existsSync, mkdirSync, statSync } = require('fs');
const { dirname, join } = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') process.exit(0);

const root = join(__dirname, '..');
const source = join(root, 'electron', 'native', 'ShellThumbnailCache.cs');
const target = join(root, 'electron', 'bin', 'shell-thumbnail.exe');
const compilers = [
  join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
];
const compiler = compilers.find(existsSync);

if (!compiler) throw new Error('找不到 Windows C# 编译器，无法构建 Shell 缩略图缓存辅助程序。');
if (existsSync(target) && statSync(target).mtimeMs >= statSync(source).mtimeMs) process.exit(0);

mkdirSync(dirname(target), { recursive: true });
const result = spawnSync(compiler, [
  '/nologo',
  '/optimize+',
  '/target:exe',
  `/out:${target}`,
  '/reference:System.Drawing.dll',
  source
], { encoding: 'utf8', windowsHide: true });

if (result.status !== 0) {
  throw new Error(`Shell 缩略图缓存辅助程序构建失败：${result.stderr || result.stdout}`);
}
console.log(`已构建 ${target}`);
