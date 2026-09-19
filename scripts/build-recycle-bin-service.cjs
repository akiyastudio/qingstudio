const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') process.exit(0);

const root = path.join(__dirname, '..');
const source = path.join(root, 'electron', 'native', 'RecycleBinService.cs');
const manifest = path.join(root, 'electron', 'native', 'RecycleBinService.manifest');
const target = path.join(root, 'electron', 'bin', 'recycle-bin-service.exe');
const staleValidationTarget = path.join(root, 'electron', 'bin', 'recycle-bin-validation-test.exe');
const validationOutputIndex = process.argv.indexOf('--validation-output');
const validationTarget = validationOutputIndex >= 0 ? path.resolve(process.argv[validationOutputIndex + 1] || '') : '';
const frameworkRoots = [
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319'),
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319'),
];
const frameworkRoot = frameworkRoots.find(candidate => fs.existsSync(path.join(candidate, 'csc.exe')));
if (!frameworkRoot) throw new Error('找不到 Windows C# 编译器，无法构建回收站辅助程序。');
fs.mkdirSync(path.dirname(target), { recursive: true });
const compile = (output, extra = []) => {
  const result = spawnSync(path.join(frameworkRoot, 'csc.exe'), [
    '/nologo', '/optimize+', '/target:exe', `/out:${output}`,
    `/win32manifest:${manifest}`,
    `/reference:${path.join(frameworkRoot, 'System.Web.Extensions.dll')}`,
    ...extra,
    source,
  ], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`回收站辅助程序构建失败：${result.stderr || result.stdout}`);
};
if (validationTarget) {
  fs.mkdirSync(path.dirname(validationTarget), { recursive: true });
  compile(validationTarget, ['/define:RECYCLE_VALIDATION_TESTS']);
  console.log(`已构建测试专用 ${validationTarget}`);
} else {
  fs.rmSync(staleValidationTarget, { force: true });
  compile(target);
  console.log(`已构建 ${target}`);
}
