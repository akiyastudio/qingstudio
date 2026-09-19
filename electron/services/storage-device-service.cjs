const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PROCESS_TIMEOUT_MS = 5000;
const PROCESS_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const PROCESS_TERMINATION_GRACE_MS = 1000;
const errorMessage = error => error instanceof Error ? error.message : String(error);

const normalizeMountPath = (value, platform = process.platform) => {
  const source = String(value || '').trim();
  if (!source) return '';
  if (platform === 'win32') {
    const match = source.replace(/\\/g, '/').match(/^([a-z]):(?:\/.*)?$/i);
    return match ? `${match[1].toUpperCase()}:/` : '';
  }
  return path.resolve(source);
};

const parseWindowsLogicalDisks = output => {
  const text = String(output || '').replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap(row => {
    const mountPath = normalizeMountPath(row?.DeviceID || row?.Name, 'win32');
    if (!mountPath) return [];
    const serial = String(row?.VolumeSerialNumber || '').trim().toUpperCase();
    const driveType = Number(row?.DriveType) || 0;
    return [{
      id: serial ? `win-volume:${serial}` : `win-path:${mountPath.toUpperCase()}`,
      mountPath,
      label: String(row?.VolumeName || row?.VolumeLabel || '').trim(),
      removable: driveType === 2,
      driveType,
      identityStable: Boolean(serial),
      ...(typeof row?.HasSupportedMedia === 'boolean' ? { hasSupportedMedia: row.HasSupportedMedia } : {}),
    }];
  });
};

const parseWindowsVolOutput = (output, mountPath) => {
  const normalizedPath = normalizeMountPath(mountPath, 'win32');
  if (!normalizedPath) return null;
  const parsedSerial = String(output || '').match(/\b([0-9A-F]{4}-[0-9A-F]{4})\b/i)?.[1]?.toUpperCase() || '';
  const serial = parsedSerial === '0000-0000' ? '' : parsedSerial;
  return {
    id: serial ? `win-volume:${serial}` : `win-path:${normalizedPath.toUpperCase()}`,
    mountPath: normalizedPath,
    label: '',
    removable: false,
    driveType: 0,
    identityStable: Boolean(serial),
  };
};

const parseWindowsMountvolOutput = (output, mountPath) => {
  const normalizedPath = normalizeMountPath(mountPath, 'win32');
  if (!normalizedPath) return null;
  const volumeGuid = String(output || '').match(/Volume\{([0-9A-F-]+)\}/i)?.[1]?.toUpperCase() || '';
  return {
    id: volumeGuid ? `win-volume-guid:${volumeGuid}` : `win-path:${normalizedPath.toUpperCase()}`,
    mountPath: normalizedPath,
    identityStable: Boolean(volumeGuid),
  };
};

const collectProcessOutput = (command, args, options = {}) => new Promise((resolve, reject) => {
  const { timeoutMs = PROCESS_TIMEOUT_MS, terminationGraceMs = PROCESS_TERMINATION_GRACE_MS, spawnImpl = spawn, ...spawnOptions } = options;
  const child = spawnImpl(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions });
  let stdout = '';
  let stderr = '';
  let settled = false;
  let terminationFence = null;
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutId);
    clearTimeout(terminationFence);
    callback(value);
  };
  let terminalError = null;
  const timeoutId = setTimeout(() => {
    terminalError = new Error(`${command} timed out after ${timeoutMs}ms`);
    terminationFence = setTimeout(() => finish(reject, terminalError), terminationGraceMs);
    child.kill();
  }, timeoutMs);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const append = (current, chunk) => {
    const next = current + chunk;
    if (Buffer.byteLength(next, 'utf8') > PROCESS_OUTPUT_LIMIT_BYTES) {
      terminalError ||= new Error(`${command} output exceeded ${PROCESS_OUTPUT_LIMIT_BYTES} bytes`);
      child.kill();
      return current;
    }
    return next;
  };
  child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
  child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
  child.once('error', error => finish(reject, terminalError || error));
  child.once('close', code => {
    if (terminalError) return finish(reject, terminalError);
    if (code === 0) finish(resolve, stdout);
    else finish(reject, new Error(stderr.trim() || `${command} exited with code ${code}`));
  });
});

const MEDIA_ROOT_PROBE_TIMEOUT_MS = 1500;
const WINDOWS_ENUMERATION_TIMEOUT_MS = 3000;
const WINDOWS_DEVICE_PROBE_TIMEOUT_MS = 2500;
const hasSupportedMediaRoot = async (mountPath, platform = process.platform) => {
  if (platform !== 'darwin') return false;
  const results = await Promise.all(['DCIM', 'PRIVATE'].map(async folderName => {
    try {
      await collectProcessOutput('/bin/test', ['-d', path.join(mountPath, folderName)], { timeoutMs: MEDIA_ROOT_PROBE_TIMEOUT_MS });
      return true;
    } catch { return false; }
  }));
  return results.some(Boolean);
};

const finalizeStorageDevice = async (device, platform = process.platform) => {
  const hasSupportedMedia = device.removable === true && (typeof device.hasSupportedMedia === 'boolean'
    ? device.hasSupportedMedia
    : await hasSupportedMediaRoot(device.mountPath, platform));
  return {
    ...device,
    hasSupportedMedia,
    eligibleForSdImport: device.removable === true && hasSupportedMedia,
  };
};

const WINDOWS_ENUMERATION_COMMAND = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
$items = foreach ($drive in [System.IO.DriveInfo]::GetDrives()) {
  $driveType = [int]$drive.DriveType
  if ($driveType -ne 2) { continue }
  [PSCustomObject]@{ Name = $drive.Name; DriveType = $driveType }
}
@($items) | ConvertTo-Json -Compress`;

const windowsDeviceProbeCommand = mountPath => `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
$drive = [System.IO.DriveInfo]::new('${normalizeMountPath(mountPath, 'win32')}')
$driveType = [int]$drive.DriveType
$label = ''
$hasSupportedMedia = $false
try {
  if ($drive.IsReady) {
    $label = $drive.VolumeLabel
    $hasSupportedMedia = (Test-Path -LiteralPath (Join-Path $drive.Name 'DCIM') -PathType Container) -or (Test-Path -LiteralPath (Join-Path $drive.Name 'PRIVATE') -PathType Container)
  }
} catch {}
[PSCustomObject]@{ Name = $drive.Name; DriveType = $driveType; VolumeLabel = $label; HasSupportedMedia = $hasSupportedMedia } | ConvertTo-Json -Compress`;

const probeWindowsStorageDevice = async (device, collect = collectProcessOutput) => {
  const drive = device.mountPath.slice(0, 2);
  const [metadataResult, serialResult, guidResult] = await Promise.allSettled([
    collect('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsDeviceProbeCommand(device.mountPath)], { timeoutMs: WINDOWS_DEVICE_PROBE_TIMEOUT_MS }),
    collect('cmd.exe', ['/d', '/s', '/c', 'vol', drive], { timeoutMs: WINDOWS_DEVICE_PROBE_TIMEOUT_MS }),
    collect('cmd.exe', ['/d', '/s', '/c', 'mountvol', drive, '/L'], { timeoutMs: WINDOWS_DEVICE_PROBE_TIMEOUT_MS }),
  ]);
  if (metadataResult.status === 'rejected') {
    return { recognized: false, mountPath: device.mountPath, error: `${device.mountPath}: ${errorMessage(metadataResult.reason)}` };
  }
  let metadata;
  try { metadata = parseWindowsLogicalDisks(metadataResult.value)[0]; }
  catch (error) { return { recognized: false, mountPath: device.mountPath, error: `${device.mountPath}: ${errorMessage(error)}` }; }
  if (!metadata) return { recognized: false, mountPath: device.mountPath, error: `${device.mountPath}: 设备探测没有返回有效结果` };
  const serialIdentity = serialResult.status === 'fulfilled' ? parseWindowsVolOutput(serialResult.value, device.mountPath) : null;
  const guidIdentity = guidResult.status === 'fulfilled' ? parseWindowsMountvolOutput(guidResult.value, device.mountPath) : null;
  const canonicalIdentity = serialIdentity?.identityStable ? serialIdentity
    : (guidIdentity?.identityStable ? guidIdentity : parseWindowsVolOutput('', device.mountPath));
  const aliases = guidIdentity?.identityStable && guidIdentity.id !== canonicalIdentity.id ? [guidIdentity.id] : [];
  const finalized = await finalizeStorageDevice({ ...device, ...metadata, id: canonicalIdentity.id, identityStable: canonicalIdentity.identityStable, aliases }, 'win32');
  const warnings = [
    ...(serialResult.status === 'rejected' ? [`${device.mountPath} 卷序列号：${errorMessage(serialResult.reason)}`] : []),
    ...(guidResult.status === 'rejected' ? [`${device.mountPath} 旧 GUID：${errorMessage(guidResult.reason)}`] : []),
  ];
  return { recognized: true, device: finalized, warnings };
};

const summarizeWindowsStorageDeviceResults = results => {
  const devices = results.flatMap(result => result.device ? [result.device] : []);
  const deviceErrors = results.flatMap(result => [
    ...(result.error ? [{ mountPath: result.mountPath || '', error: result.error }] : []),
    ...((result.warnings || []).map(error => ({ mountPath: result.device?.mountPath || result.mountPath || '', error }))),
  ]);
  const recognizedCount = results.filter(result => result.recognized === true).length;
  const stableIds = new Map();
  for (const device of devices) {
    if (!device.identityStable) continue;
    for (const identity of [...new Set([device.id, ...(Array.isArray(device.aliases) ? device.aliases : [])].filter(Boolean))]) {
      const previous = stableIds.get(identity);
      if (previous && previous !== device) {
        device.identityStable = false;
        device.eligibleForSdImport = false;
        previous.identityStable = false;
        previous.eligibleForSdImport = false;
        deviceErrors.push({ mountPath: device.mountPath, error: `检测到重复设备标识 ${identity}` });
      } else stableIds.set(identity, device);
    }
  }
  if (deviceErrors.length && recognizedCount === 0) {
    return { devices, complete: false, deviceErrors, error: `无法识别 Windows 存储设备：${deviceErrors.map(item => item.error).join('；')}` };
  }
  return { devices, complete: true, ...(deviceErrors.length ? { deviceErrors, warning: `有 ${deviceErrors.length} 个设备探测步骤失败，其他存储卡仍可使用` } : {}) };
};

const listWindowsStorageDevices = async ({ collect = collectProcessOutput } = {}) => {
  let devices;
  try {
    const output = await collect('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_ENUMERATION_COMMAND], { timeoutMs: WINDOWS_ENUMERATION_TIMEOUT_MS });
    devices = parseWindowsLogicalDisks(output);
  } catch (error) {
    return { devices: [], complete: false, error: `无法判断 Windows 存储设备类型：${errorMessage(error)}` };
  }
  const results = await Promise.all(devices.filter(device => device.removable === true).map(device => probeWindowsStorageDevice(device, collect)));
  return summarizeWindowsStorageDeviceResults(results);
};

const readPlistValue = (output, key, valueTag) => {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(output || '').match(new RegExp(`<key>\\s*${escapedKey}\\s*</key>\\s*<${valueTag}>([\\s\\S]*?)</${valueTag}>`, 'i'))?.[1]?.trim() || '';
};

const readPlistBoolean = (output, key) => {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const value = String(output || '').match(new RegExp(`<key>\\s*${escapedKey}\\s*</key>\\s*<(true|false)\\s*/>`, 'i'))?.[1];
  return value === undefined ? undefined : value.toLowerCase() === 'true';
};

const parseDiskutilInfoPlist = (output, mountPath) => {
  const volumeUuid = readPlistValue(output, 'VolumeUUID', 'string');
  const mediaUuid = readPlistValue(output, 'MediaUUID', 'string');
  const diskUuid = readPlistValue(output, 'DiskUUID', 'string');
  const stableId = volumeUuid || mediaUuid || diskUuid;
  const removableMedia = readPlistBoolean(output, 'RemovableMedia');
  const legacyRemovable = readPlistBoolean(output, 'Removable');
  return {
    id: stableId ? `darwin-volume:${stableId.toUpperCase()}` : `darwin-path:${mountPath}`,
    identityStable: Boolean(stableId),
    removable: removableMedia === undefined ? legacyRemovable === true : removableMedia,
  };
};

const summarizeDarwinStorageDeviceResults = results => {
  const devices = results.flatMap(result => result.device ? [result.device] : []);
  const errors = results.flatMap(result => result.error ? [result.error] : []);
  const recognizedCount = results.filter(result => result.recognized === true).length;
  if (errors.length && recognizedCount === 0) {
    return { devices, complete: false, error: `无法识别 macOS 存储设备：${errors.join('；')}` };
  }
  return { devices, complete: true, ...(errors.length ? {
    deviceErrors: errors.map(error => ({ mountPath: String(error).split(':')[0], error })),
    warning: `有 ${errors.length} 个设备探测步骤失败，其他存储卡仍可使用`,
  } : {}) };
};

const listDarwinStorageDevices = async () => {
  const entries = await fs.promises.readdir('/Volumes', { withFileTypes: true });
  const candidates = entries.filter(entry => entry.isDirectory() || entry.isSymbolicLink());
  const results = await Promise.all(candidates.map(async entry => {
    const mountPath = path.join('/Volumes', entry.name);
    try {
      const output = await collectProcessOutput('/usr/sbin/diskutil', ['info', '-plist', mountPath]);
      const identity = parseDiskutilInfoPlist(output, mountPath);
      if (!identity.removable) return { recognized: true };
      const device = await finalizeStorageDevice({
        id: identity.id,
        mountPath,
        label: entry.name,
        removable: identity.removable,
        driveType: identity.removable ? 2 : 3,
        identityStable: identity.identityStable,
      }, 'darwin');
      return { recognized: true, device };
    } catch (error) {
      return { recognized: false, error: `${mountPath}: ${errorMessage(error)}` };
    }
  }));
  return summarizeDarwinStorageDeviceResults(results);
};

const listStorageDevices = async (platform = process.platform) => {
  if (platform === 'win32') return listWindowsStorageDevices();
  if (platform === 'darwin') return listDarwinStorageDevices();
  return { devices: [], complete: false, error: `当前平台不支持 SD 设备枚举：${platform}` };
};

module.exports = {
  collectProcessOutput,
  listStorageDevices,
  listWindowsStorageDevices,
  normalizeMountPath,
  parseDiskutilInfoPlist,
  parseWindowsLogicalDisks,
  parseWindowsMountvolOutput,
  parseWindowsVolOutput,
  probeWindowsStorageDevice,
  summarizeDarwinStorageDeviceResults,
  summarizeWindowsStorageDeviceResults,
};
