const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const COMMON_LABELS = new Map([
  ['.txt', '文本文档'],
  ['.rtf', 'RTF 文档'],
  ['.bmp', 'BMP 图像'],
  ['.psd', 'Adobe Photoshop 图像'],
  ['.doc', 'Microsoft Word 文档'],
  ['.docx', 'Microsoft Word 文档'],
  ['.ppt', 'Microsoft PowerPoint 演示文稿'],
  ['.pptx', 'Microsoft PowerPoint 演示文稿'],
  ['.xls', 'Microsoft Excel 工作表'],
  ['.xlsx', 'Microsoft Excel 工作表'],
  ['.zip', 'ZIP 压缩文件'],
]);
const COMMON_ORDER = ['.txt', '.rtf', '.bmp', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls', '.psd', '.zip'];
const EMPTY_BMP_BASE64 = Buffer.from('424d3a0000000000000036000000280000000100000001000000010018000000000004000000130b0000130b00000000000000000000ffffff00', 'hex').toString('base64');
const CACHE_VERSION = 1;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const BASIC_TYPES = [
  { id: '.txt', extension: '.txt', label: '文本文档', method: 'null', templatePath: '', dataBase64: '' },
  { id: '.rtf', extension: '.rtf', label: 'RTF 文档', method: 'data', templatePath: '', dataBase64: Buffer.from('{\\rtf1\\ansi\\deff0 \\par}', 'utf8').toString('base64') },
  { id: '.bmp', extension: '.bmp', label: 'BMP 图像', method: 'data', templatePath: '', dataBase64: EMPTY_BMP_BASE64 },
];

const DISCOVERY_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$results = [System.Collections.Generic.List[object]]::new()
$seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$registryPaths = [System.Collections.Generic.List[string]]::new()
# Only extension trees can match the accepted ShellNew paths. Avoid walking
# every COM class and application registration in HKEY_CLASSES_ROOT.
$classes = [Microsoft.Win32.Registry]::ClassesRoot
foreach ($extensionName in $classes.GetSubKeyNames()) {
  if ($extensionName -notmatch '^\.[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$') { continue }
  $pending = [System.Collections.Generic.Stack[string]]::new()
  $pending.Push($extensionName)
  while ($pending.Count -gt 0) {
    $keyPath = $pending.Pop()
    $key = $null
    try {
      $key = $classes.OpenSubKey($keyPath)
      if (-not $key) { continue }
      if ($keyPath.EndsWith('\ShellNew', [System.StringComparison]::OrdinalIgnoreCase)) {
        $registryPaths.Add('HKEY_CLASSES_ROOT\' + $keyPath)
      }
      # Preserve reg.exe's depth-first precedence when an extension has
      # several ShellNew providers (for example Windows ZIP and an archiver).
      $children = $key.GetSubKeyNames()
      for ($childIndex = $children.Length - 1; $childIndex -ge 0; $childIndex--) { $pending.Push($keyPath + '\' + $children[$childIndex]) }
    } catch { } finally { if ($key) { $key.Dispose() } }
  }
}
$registryPaths | ForEach-Object {
  $registryPath = ([string]$_).Trim()
  if ($registryPath -notmatch '^HKEY_CLASSES_ROOT\\(\.[A-Za-z0-9][A-Za-z0-9._+-]{0,31})(?:\\.*)?\\ShellNew$') { return }
  $extension = $Matches[1].ToLowerInvariant()
  if ($seen.Contains($extension)) { return }
  $extensionKey = Get-Item -LiteralPath ('Registry::HKEY_CLASSES_ROOT\' + $extension)
  if (-not $extensionKey) { return }
  $progId = [string]$extensionKey.GetValue('')
  $shellNew = Get-Item -LiteralPath ('Registry::' + $registryPath)
  if (-not $shellNew) { return }
  $names = @($shellNew.GetValueNames())
  if ($names -contains 'Command' -or $names -contains 'Handler') { return }
  $method = ''
  $fileName = ''
  $dataBase64 = ''
  if ($names -contains 'NullFile') { $method = 'null' }
  elseif ($names -contains 'FileName') { $method = 'template'; $fileName = [string]$shellNew.GetValue('FileName') }
  elseif ($names -contains 'Data') {
    $value = $shellNew.GetValue('Data')
    if ($value -is [byte[]]) { $method = 'data'; $dataBase64 = [Convert]::ToBase64String($value) }
  }
  # Command and handler-based entries are intentionally not executed by the app.
  if (-not $method) { return }
  $label = ''
  if ($progId) {
    $progIdKey = Get-Item -LiteralPath ('Registry::HKEY_CLASSES_ROOT\' + $progId)
    if ($progIdKey) { $label = [string]$progIdKey.GetValue('') }
  }
  if (-not $label -or $label.StartsWith('@')) { $label = $extension.TrimStart('.').ToUpperInvariant() + ' 文件' }
  $results.Add([pscustomobject]@{ id=$extension; extension=$extension; label=$label; method=$method; fileName=$fileName; dataBase64=$dataBase64 })
  [void]$seen.Add($extension)
}
$results | ConvertTo-Json -Compress -Depth 4
`;

let discoverySequence = 0;
const runPowerShellJson = (script, processSupervisor) => new Promise((resolve, reject) => {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
  const command = path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = processSupervisor ? processSupervisor.launch({
    id: `csharp:shell-new-discovery:${++discoverySequence}`, kind: 'csharp-helper', command, args,
    options: { stdio: ['ignore', 'pipe', 'pipe'] }, ephemeral: true, windowsJob: true,
  }).child : spawn(command, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { stdout = (stdout + data).slice(-4 * 1024 * 1024); });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); });
  const timer = setTimeout(() => {
    if (!child.killed) child.kill();
    reject(new Error('读取 Windows 新建文件类型超时'));
  }, 60000);
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', code => {
    clearTimeout(timer);
    if (code !== 0) { reject(new Error(stderr.trim() || '无法读取 Windows 新建文件类型')); return; }
    try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || '[]')); }
    catch { reject(new Error('Windows 新建文件类型返回格式无效')); }
  });
});

const expandEnvironmentVariables = value => String(value || '').replace(/%([^%]+)%/g, (_match, name) => process.env[name] || process.env[Object.keys(process.env).find(key => key.toLocaleLowerCase() === name.toLocaleLowerCase())] || '');
const safeBaseName = value => String(value || '').trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '') || '文件';
const HARDLINK_FALLBACK_CODES = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL', 'UNKNOWN']);

const digestFile = async filePath => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
};

const publishGeneratedFileNoClobber = async (destination, populate, publishNoClobber) => {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomUUID()}.photoflow-new`);
  let preserveTemporary = false;
  try {
    await populate(temporary);
    try { await fs.promises.link(temporary, destination); }
    catch (error) {
      if (!HARDLINK_FALLBACK_CODES.has(error?.code)) throw error;
      // The temporary lives on the target volume. A native no-replace rename
      // avoids copying and hashing the template again on non-hardlink volumes.
      if (publishNoClobber) {
        try { await publishNoClobber(temporary, destination); return; }
        catch (publicationError) { preserveTemporary = Boolean(publicationError.recoveryRequired || publicationError.outcomeUnknown); throw publicationError; }
      }
      try {
        await fs.promises.copyFile(temporary, destination, fs.constants.COPYFILE_EXCL);
        const sourceMode = (await fs.promises.stat(temporary)).mode;
        await fs.promises.chmod(destination, sourceMode | 0o200);
        const handle = await fs.promises.open(destination, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
        const [sourceStat, targetStat, sourceHash, targetHash] = await Promise.all([fs.promises.stat(temporary), fs.promises.stat(destination), digestFile(temporary), digestFile(destination)]);
        if (sourceStat.size !== targetStat.size || sourceHash !== targetHash) throw Object.assign(new Error('新建文件发布校验失败'), { code: 'PUBLISH_VERIFY_FAILED' });
        await fs.promises.chmod(destination, sourceMode).catch(() => undefined);
      } catch (copyError) {
        if (fs.existsSync(destination)) {
          const recovery = `${destination}.recovery-${crypto.randomUUID()}`;
          try { await fs.promises.rename(destination, recovery); copyError.recoveryPath = recovery; } catch { /* preserve ambiguous destination */ }
        }
        throw copyError;
      }
    }
  } finally {
    if (!preserveTemporary) await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
  }
};

const createShellNewService = ({ app, processSupervisor = null, publishNoClobber = null, discover = () => process.platform === 'win32' ? runPowerShellJson(DISCOVERY_SCRIPT, processSupervisor) : [], onUpdated = () => {}, onError = () => {} } = {}) => {
  let cachedTypes = null;
  let cachedAt = 0;
  let hydration = null;
  let retryAfter = 0;
  let loading = null;
  const publicTypes = () => (cachedTypes || BASIC_TYPES).map(item => ({ id: item.id, extension: item.extension, label: item.label, method: item.method, iconDataUrl: item.iconDataUrl || '' }));
  const cachePath = () => app?.getPath ? path.join(app.getPath('userData'), 'shell-new-types-cache.json') : '';
  const readPersistentCache = async () => {
    const filePath = cachePath();
    if (!filePath) return null;
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return null;
      const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
      if (parsed?.version !== CACHE_VERSION || !Number.isFinite(parsed.savedAt) || !Array.isArray(parsed.types)) return null;
      const types = parsed.types.filter(item => /^\.[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/.test(item?.extension || '') && ['null', 'data', 'template'].includes(item?.method)).slice(0, 80);
      if (!types.length) return null;
      return { savedAt: parsed.savedAt, types };
    } catch {
      return null;
    }
  };
  const writePersistentCache = async types => {
    const filePath = cachePath();
    if (!filePath) return;
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify({ version: CACHE_VERSION, savedAt: Date.now(), types }), 'utf8');
  };

  const list = async ({ refresh = false, background = false } = {}) => {
    hydration ||= readPersistentCache().then(saved => {
      if (saved) { cachedTypes = saved.types; cachedAt = saved.savedAt; }
    });
    await hydration;
    if (!refresh && cachedTypes && Date.now() - cachedAt < CACHE_MAX_AGE_MS) return publicTypes();
    if (loading) return background ? publicTypes() : loading;
    if (background && !refresh && Date.now() < retryAfter) return publicTypes();
    loading = (async () => {
      // Do not turn a transient registry/PowerShell failure into a permanently
      // cached three-item fallback menu. Let the IPC layer report it and retry
      // the next time the user opens the menu.
      let discovered;
      try {
        discovered = await discover();
      } catch (error) {
        retryAfter = Date.now() + 30000;
        onError(error);
        if (!cachedTypes) throw error;
        return publicTypes();
      }
      const normalized = (Array.isArray(discovered) ? discovered : [discovered]).filter(item => /^\.[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/.test(item?.extension || '')).map(item => ({
        id: item.extension.toLocaleLowerCase(),
        extension: item.extension.toLocaleLowerCase(),
        label: COMMON_LABELS.get(item.extension.toLocaleLowerCase()) || safeBaseName(item.label),
        method: item.method,
        templatePath: item.fileName || '',
        dataBase64: item.dataBase64 || '',
      }));
      for (const fallback of BASIC_TYPES) if (!normalized.some(item => item.extension === fallback.extension)) normalized.push({ ...fallback });
      for (let index = normalized.length - 1; index >= 0; index -= 1) if (normalized[index].extension === '.lnk') normalized.splice(index, 1);
      normalized.sort((left, right) => {
        const leftIndex = COMMON_ORDER.indexOf(left.extension);
        const rightIndex = COMMON_ORDER.indexOf(right.extension);
        if (leftIndex >= 0 || rightIndex >= 0) return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex);
        return left.label.localeCompare(right.label, 'zh-CN', { numeric: true, sensitivity: 'base' });
      });
      const nextTypes = normalized.slice(0, 80);
      if (app?.getFileIcon) {
        const iconDirectory = path.join(app.getPath('temp'), 'Photoflow-shell-new-icons');
        await fs.promises.mkdir(iconDirectory, { recursive: true });
        for (const descriptor of nextTypes) {
          const iconSource = path.join(iconDirectory, `type${descriptor.extension}`);
          try {
            await fs.promises.writeFile(iconSource, Buffer.alloc(0));
            const icon = await app.getFileIcon(iconSource, { size: 'normal' });
            descriptor.iconDataUrl = icon.isEmpty() ? '' : icon.toDataURL();
          } catch {
            descriptor.iconDataUrl = '';
          } finally {
            await fs.promises.rm(iconSource, { force: true }).catch(() => undefined);
          }
        }
      }
      // Publish the complete snapshot only after every descriptor and icon is
      // ready, so concurrent menu requests cannot observe a partial result.
      cachedTypes = nextTypes;
      cachedAt = Date.now();
      retryAfter = 0;
      await writePersistentCache(cachedTypes).catch(() => undefined);
      const snapshot = publicTypes();
      onUpdated(snapshot);
      return snapshot;
    })().finally(() => { loading = null; });
    if (!background) return loading;
    void loading.catch(() => undefined);
    return publicTypes();
  };

  const resolveTemplate = requested => {
    const expanded = expandEnvironmentVariables(String(requested || '').replace(/^"|"$/g, ''));
    const candidates = path.isAbsolute(expanded) ? [expanded] : [
      path.join(process.env.WINDIR || 'C:\\Windows', 'ShellNew', expanded),
      path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Templates', expanded),
      path.join(process.env.PROGRAMDATA || '', 'Microsoft', 'Windows', 'Templates', expanded),
    ];
    return candidates.find(candidate => candidate && fs.existsSync(candidate)) || '';
  };

  const create = async (typeId, directory, uniqueDestination) => {
    await list({ background: true });
    let descriptor = (cachedTypes || BASIC_TYPES).find(item => item.id === String(typeId || '').toLocaleLowerCase());
    if (!descriptor) {
      await list();
      descriptor = cachedTypes?.find(item => item.id === String(typeId || '').toLocaleLowerCase());
    }
    if (!descriptor) throw new Error('不支持该新建文件类型');
    const baseName = `新建 ${safeBaseName(descriptor.label)}`;
    const destination = uniqueDestination(directory, `${baseName}${descriptor.extension}`);
    if (descriptor.method === 'null') await fs.promises.writeFile(destination, Buffer.alloc(0), { flag: 'wx' });
    else if (descriptor.method === 'data') await publishGeneratedFileNoClobber(destination, temporary => fs.promises.writeFile(temporary, Buffer.from(descriptor.dataBase64, 'base64'), { flag: 'wx' }), publishNoClobber);
    else if (descriptor.method === 'template') {
      const template = resolveTemplate(descriptor.templatePath);
      if (!template) throw new Error(`找不到“${descriptor.label}”的 Windows 模板文件`);
      await publishGeneratedFileNoClobber(destination, temporary => fs.promises.copyFile(template, temporary, fs.constants.COPYFILE_EXCL), publishNoClobber);
    } else throw new Error('该文件类型需要外部程序创建，当前未开放执行');
    return { name: path.basename(destination), path: destination, extension: descriptor.extension };
  };

  return { list, create, warm: () => list() };
};

module.exports = { createShellNewService };
