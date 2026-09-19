const { existsSync, readdirSync, rmSync } = require('fs');
const { spawnSync } = require('child_process');
const { join } = require('path');

const root = join(__dirname, '..');
const venvPython = process.platform === 'win32'
  ? join(root, '.venv', 'Scripts', 'python.exe')
  : join(root, '.venv', 'bin', 'python');
if (!existsSync(venvPython)) throw new Error('Python virtual environment is missing. Run: npm run setup:python');
const python = venvPython;
const sharedWorkerName = 'PhotoFlowImportWorker';
const pythonDistRoot = join(root, 'artifacts', 'python');
const pythonBuildRoot = join(root, 'artifacts', 'python-build');
const releaseRoot = join(root, 'artifacts', 'installers');
const compatibilityRoot = join(root, 'python', 'compatibility');
const compatibilityHiddenImports = readdirSync(compatibilityRoot, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.py') && entry.name !== '__init__.py')
  .map(entry => join(entry.parentPath, entry.name).slice(join(root, 'python').length + 1, -3).replace(/[\\/]/g, '.'))
  .flatMap(moduleName => ['--hidden-import', moduleName]);

// These workers now share the tools runtime. Remove stale standalone outputs
// so local release inspection cannot mistake them for packaged resources.
for (const retiredOutput of ['thumbnail-image-worker', 'workspace-db-worker', 'tools', 'tools.exe', sharedWorkerName, 'thumbnail-image-worker.exe', 'workspace-db-worker.exe', 'ffmpeg.zip', 'ffmpeg-runtime-manifest.json']) {
  rmSync(join(pythonDistRoot, retiredOutput), { recursive: true, force: true });
}
rmSync(join(releaseRoot, 'components', 'raw-decoder-libraw'), { recursive: true, force: true });
if (existsSync(releaseRoot)) {
  for (const entry of readdirSync(releaseRoot, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith('PhotoFlow-raw-decoder-libraw-') && entry.name.endsWith('.zip')) {
      rmSync(join(releaseRoot, entry.name), { force: true });
    }
  }
}

const result = spawnSync(python, [
  '-m', 'PyInstaller', '--onedir', '--clean', '--noconfirm',
  '--specpath', join(pythonBuildRoot, 'specs'),
  '--workpath', join(pythonBuildRoot, sharedWorkerName),
  '--distpath', pythonDistRoot,
  '--name', sharedWorkerName, '--exclude-module', 'imageio_ffmpeg',
  '--collect-binaries', 'rawpy', '--exclude-module', 'scipy', '--exclude-module', 'cv2',
  '--exclude-module', 'torch', '--exclude-module', 'torchvision',
  '--exclude-module', 'torchaudio', '--exclude-module', 'triton',
  '--exclude-module', 'PIL._imagingmath',
  '--exclude-module', 'PIL._imagingtk',
  '--hidden-import', 'catch', '--hidden-import', 'classify',
  '--hidden-import', 'png_to_jpg', '--hidden-import', 'raw_decoder', '--hidden-import', 'rawpy',
  '--hidden-import', 'rename',
  '--hidden-import', 'thumbnail_db', '--hidden-import', 'thumbnail_image',
  '--hidden-import', 'workspace_db', '--hidden-import', 'operations_db', '--hidden-import', 'backup_db',
  ...compatibilityHiddenImports,
  'tools.py',
], { cwd: join(root, 'python'), stdio: 'inherit' });

if (result.error) throw result.error;
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);

const inspirationTools = spawnSync(python, [
  '-m', 'PyInstaller', '--onedir', '--clean', '--noconfirm',
  '--specpath', join(pythonBuildRoot, 'specs'),
  '--workpath', join(pythonBuildRoot, 'inspiration-tools'),
  '--distpath', pythonDistRoot,
  '--name', 'inspiration-tools', '--exclude-module', 'imageio_ffmpeg',
  '--exclude-module', 'scipy', '--exclude-module', 'matplotlib',
  '--exclude-module', 'torch', '--exclude-module', 'torchvision',
  '--exclude-module', 'torchaudio', '--exclude-module', 'triton',
  '--exclude-module', 'tkinter', '--exclude-module', 'PIL.ImageTk',
  '--exclude-module', 'PIL.ImageQt', '--exclude-module', 'PIL._avif',
  '--exclude-module', 'PIL._imagingmath', '--exclude-module', 'PIL._imagingtk',
  '--exclude-module', 'PIL._webp',
  '--hidden-import', 'research', '--hidden-import', 'office_media_extract',
  '--hidden-import', 'screenshot_main_image',
  'inspiration_tools.py',
], { cwd: join(root, 'python'), stdio: 'inherit' });

if (inspirationTools.error) throw inspirationTools.error;
process.exit(inspirationTools.status ?? 1);
