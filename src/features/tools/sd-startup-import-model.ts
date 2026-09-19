import type { AppConfig, ConfiguredSdDevice, StorageDevice } from '../../types';

type SmartImportConfig = AppConfig['smartImport'];

export interface ResolvedSdDevice {
  configuredPath: string;
  mountPath: string;
  deviceId: string;
  type: 'work' | 'broll';
  splitVideosOnImport: boolean;
  transcodeVideosOnImport: boolean;
}

export interface SdImportVideoActions {
  splitVideosOnImport: boolean;
  transcodeVideosOnImport: boolean;
}

type SdImportVideoActionDefaults = Partial<Record<'work' | 'broll', SdImportVideoActions>>;

const pathKey = (value: string) => value.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
const identityKey = (value: string) => String(value || '').trim().toLocaleLowerCase();
const isLegacyWindowsGuid = (value: string) => identityKey(value).startsWith('win-volume-guid:');
const uniquePaths = (paths: string[]) => paths.filter((path, index) => paths.findIndex(candidate => pathKey(candidate) === pathKey(path)) === index);
const legacySelectedPaths = (config: SmartImportConfig) => [...new Set(config.sdPaths?.length ? config.sdPaths : config.sdPath ? [config.sdPath] : [])];
const videoActionsAtPath = (actions: Record<string, SdImportVideoActions> | undefined, path: string) => Object.entries(actions || {}).find(([candidate]) => pathKey(candidate) === pathKey(path))?.[1];
const valueAtPath = <T>(values: Record<string, T> | undefined, path: string) => Object.entries(values || {}).find(([candidate]) => pathKey(candidate) === pathKey(path))?.[1];

export const normalizeSavedSdDriveVideoActions = (
  value: Record<string, SdImportVideoActions> | undefined,
  paths: string[],
  types: Record<string, 'work' | 'broll'> | undefined,
  defaults: SdImportVideoActionDefaults = {},
) => Object.fromEntries(uniquePaths(paths).map(path => {
  const type = valueAtPath(types, path) === 'broll' ? 'broll' : 'work';
  const saved = videoActionsAtPath(value, path);
  return [path, {
    splitVideosOnImport: typeof saved?.splitVideosOnImport === 'boolean' ? saved.splitVideosOnImport : defaults[type]?.splitVideosOnImport === true,
    transcodeVideosOnImport: typeof saved?.transcodeVideosOnImport === 'boolean' ? saved.transcodeVideosOnImport : defaults[type]?.transcodeVideosOnImport === true,
  }];
}));

export const isTrustedSdImportDevice = (device: StorageDevice) => device.identityStable === true
  && device.eligibleForSdImport === true;

export const storageDeviceMatchesId = (device: StorageDevice, deviceId: string) => {
  const expected = identityKey(deviceId);
  return Boolean(expected) && [device.id, ...(device.aliases || [])].some(candidate => identityKey(candidate) === expected);
};

export const normalizeConfiguredSdDeviceRecords = (records: ConfiguredSdDevice[] | undefined, defaults: SdImportVideoActionDefaults = {}): ConfiguredSdDevice[] => {
  if (!Array.isArray(records)) return [];
  const byId = new Map<string, ConfiguredSdDevice>();
  for (const record of records) {
    const deviceId = String(record?.deviceId || '').trim();
    const lastMountPath = String(record?.lastMountPath || '').trim();
    if (!deviceId || !lastMountPath) continue;
    const type = record.type === 'broll' ? 'broll' : 'work';
    const key = identityKey(deviceId);
    const previous = byId.get(key);
    const next: ConfiguredSdDevice = {
      deviceId,
      lastMountPath,
      type,
      splitVideosOnImport: typeof record.splitVideosOnImport === 'boolean' ? record.splitVideosOnImport : defaults[type]?.splitVideosOnImport === true,
      transcodeVideosOnImport: typeof record.transcodeVideosOnImport === 'boolean' ? record.transcodeVideosOnImport : defaults[type]?.transcodeVideosOnImport === true,
      confirmedAt: Math.max(0, Number(record.confirmedAt) || 0),
      enabled: record.enabled !== false,
    };
    byId.set(key, previous && previous.confirmedAt > next.confirmedAt ? previous : { ...previous, ...next });
  }
  return [...byId.values()];
};

export const migrateLegacySdDeviceRecords = (config: Pick<SmartImportConfig, 'sdPath' | 'sdPaths' | 'sdDriveTypes' | 'sdDeviceIds'>): ConfiguredSdDevice[] => {
  const ids = config.sdDeviceIds || {};
  return legacySelectedPaths(config as SmartImportConfig).flatMap(lastMountPath => {
    const deviceId = String(valueAtPath(ids, lastMountPath) || '').trim();
    if (!deviceId) return [];
    return [{
      deviceId,
      lastMountPath,
      type: valueAtPath(config.sdDriveTypes, lastMountPath) === 'broll' ? 'broll' as const : 'work' as const,
      splitVideosOnImport: false,
      transcodeVideosOnImport: false,
      confirmedAt: 0,
      enabled: true,
    }];
  });
};

export const normalizeSavedSdDeviceRecords = (
  records: ConfiguredSdDevice[] | undefined,
  paths: string[],
  ids: Record<string, string> | undefined,
  types: Record<string, 'work' | 'broll'> | undefined,
  defaults: SdImportVideoActionDefaults = {},
) => {
  const normalized = normalizeConfiguredSdDeviceRecords(records, defaults);
  const byId = new Map<string, ConfiguredSdDevice>(normalized.map(record => [identityKey(record.deviceId), record]));
  for (const lastMountPath of paths) {
    const deviceId = String(valueAtPath(ids, lastMountPath) || '').trim();
    if (!deviceId) continue;
    const type = valueAtPath(types, lastMountPath) === 'broll' ? 'broll' : 'work';
    const key = identityKey(deviceId);
    if (byId.has(key)) continue;
    byId.set(key, {
      deviceId,
      lastMountPath,
      type,
      splitVideosOnImport: defaults[type]?.splitVideosOnImport === true,
      transcodeVideosOnImport: defaults[type]?.transcodeVideosOnImport === true,
      confirmedAt: 0,
      enabled: true,
    });
  }
  return [...byId.values()];
};

const legacyUnboundPaths = (config: SmartImportConfig, records: ConfiguredSdDevice[]) => {
  const recordIds = new Set(records.map(record => identityKey(record.deviceId)));
  const recordPaths = new Set(records.map(record => pathKey(record.lastMountPath)));
  return legacySelectedPaths(config).filter(path => {
    if (recordPaths.has(pathKey(path))) return false;
    const legacyId = valueAtPath(config.sdDeviceIds, path);
    return !legacyId || !recordIds.has(identityKey(legacyId));
  });
};

export const syncLegacySdMirrors = (config: SmartImportConfig, records: ConfiguredSdDevice[]): SmartImportConfig => {
  const normalizedRecords = normalizeConfiguredSdDeviceRecords(records);
  const unboundPaths = legacyUnboundPaths(config, normalizedRecords);
  const enabledRecords = normalizedRecords.filter(record => record.enabled);
  const sdPaths = uniquePaths([...enabledRecords.map(record => record.lastMountPath), ...unboundPaths]);
  const sdDriveTypes: Record<string, 'work' | 'broll'> = {};
  const sdDriveVideoActions: Record<string, SdImportVideoActions> = {};
  const sdDeviceIds: Record<string, string> = {};
  for (const path of unboundPaths) {
    sdDriveTypes[path] = valueAtPath(config.sdDriveTypes, path) || 'work';
    sdDriveVideoActions[path] = videoActionsAtPath(config.sdDriveVideoActions, path) || { splitVideosOnImport: false, transcodeVideosOnImport: false };
    const legacyId = valueAtPath(config.sdDeviceIds, path);
    if (legacyId) sdDeviceIds[path] = legacyId;
  }
  for (const record of enabledRecords) {
    sdDriveTypes[record.lastMountPath] = record.type;
    sdDriveVideoActions[record.lastMountPath] = {
      splitVideosOnImport: record.splitVideosOnImport,
      transcodeVideosOnImport: record.transcodeVideosOnImport,
    };
    sdDeviceIds[record.lastMountPath] = record.deviceId;
  }
  return {
    ...config,
    sdPath: sdPaths[0] || '',
    sdPaths,
    sdDriveTypes,
    sdDriveVideoActions,
    sdDeviceIds,
    sdDevices: normalizedRecords,
  };
};

export const configuredSdSelectionPaths = (config: SmartImportConfig, devices: StorageDevice[]) => {
  const records = normalizeConfiguredSdDeviceRecords(config.sdDevices);
  const recordPaths = records.filter(record => record.enabled).map(record => (
    devices.find(device => storageDeviceMatchesId(device, record.deviceId))?.mountPath || record.lastMountPath
  ));
  return uniquePaths([...recordPaths, ...legacyUnboundPaths(config, records)]);
};

export const configuredSdDriveTypes = (config: SmartImportConfig, devices: StorageDevice[]) => {
  const result = { ...(config.sdDriveTypes || {}) };
  for (const record of normalizeConfiguredSdDeviceRecords(config.sdDevices)) {
    const mountPath = devices.find(device => storageDeviceMatchesId(device, record.deviceId))?.mountPath || record.lastMountPath;
    result[mountPath] = record.type;
  }
  return result;
};

export const configuredSdDriveVideoActions = (config: SmartImportConfig, devices: StorageDevice[]) => {
  const result: Record<string, SdImportVideoActions> = { ...(config.sdDriveVideoActions || {}) };
  for (const record of normalizeConfiguredSdDeviceRecords(config.sdDevices)) {
    const mountPath = devices.find(device => storageDeviceMatchesId(device, record.deviceId))?.mountPath || record.lastMountPath;
    result[mountPath] = {
      splitVideosOnImport: record.splitVideosOnImport,
      transcodeVideosOnImport: record.transcodeVideosOnImport,
    };
  }
  return result;
};

export const upsertConfiguredSdDevice = (
  config: SmartImportConfig,
  device: StorageDevice,
  type: 'work' | 'broll',
  confirmedAt: number,
  videoActions: SdImportVideoActions = { splitVideosOnImport: false, transcodeVideosOnImport: false },
) => {
  const pathVideoActions = videoActionsAtPath(config.sdDriveVideoActions, device.mountPath) || videoActions;
  const records = normalizeConfiguredSdDeviceRecords(config.sdDevices).map(record => {
    if (storageDeviceMatchesId(device, record.deviceId)) return { ...record, deviceId: device.id, lastMountPath: device.mountPath, type, confirmedAt, enabled: true };
    if (record.confirmedAt <= 0 && pathKey(record.lastMountPath) === pathKey(device.mountPath)) return { ...record, deviceId: device.id, lastMountPath: device.mountPath, type, confirmedAt, enabled: true };
    if (record.enabled && pathKey(record.lastMountPath) === pathKey(device.mountPath)) return { ...record, enabled: false };
    return record;
  });
  if (!records.some(record => record.deviceId === device.id)) {
    records.push({ deviceId: device.id, lastMountPath: device.mountPath, type, ...pathVideoActions, confirmedAt, enabled: true });
  }
  return syncLegacySdMirrors(config, records);
};

export const removeConfiguredSdDevice = (config: SmartImportConfig, deviceId: string) => {
  const removedPathKeys = new Set(Object.entries(config.sdDeviceIds || {}).filter(([, id]) => identityKey(id) === identityKey(deviceId)).map(([path]) => pathKey(path)));
  const sdPaths = legacySelectedPaths(config).filter(path => !removedPathKeys.has(pathKey(path)));
  const sdDriveTypes = Object.fromEntries(Object.entries(config.sdDriveTypes || {}).filter(([path]) => !removedPathKeys.has(pathKey(path))));
  const sdDriveVideoActions = Object.fromEntries(Object.entries(config.sdDriveVideoActions || {}).filter(([path]) => !removedPathKeys.has(pathKey(path))));
  const sdDeviceIds = Object.fromEntries(Object.entries(config.sdDeviceIds || {}).filter(([path, id]) => !removedPathKeys.has(pathKey(path)) && identityKey(id) !== identityKey(deviceId)));
  const baseConfig = { ...config, sdPath: sdPaths[0] || '', sdPaths, sdDriveTypes, sdDriveVideoActions, sdDeviceIds };
  return syncLegacySdMirrors(baseConfig, normalizeConfiguredSdDeviceRecords(config.sdDevices).filter(record => identityKey(record.deviceId) !== identityKey(deviceId)));
};

export const resolveConfiguredSdDevices = (
  config: SmartImportConfig,
  devices: StorageDevice[],
): ResolvedSdDevice[] => {
  const physicalDevices = new Set<string>();
  return normalizeConfiguredSdDeviceRecords(config.sdDevices).flatMap(record => {
  if (!record.enabled || record.confirmedAt <= 0) return [];
  const device = devices.find(candidate => storageDeviceMatchesId(candidate, record.deviceId) && isTrustedSdImportDevice(candidate));
  if (!device) return [];
  const physicalIdentity = identityKey(device.id) || pathKey(device.mountPath);
  if (physicalDevices.has(physicalIdentity)) return [];
  physicalDevices.add(physicalIdentity);
  return [{
    configuredPath: record.lastMountPath,
    mountPath: device.mountPath,
    deviceId: device.id,
    type: record.type,
    splitVideosOnImport: record.splitVideosOnImport,
    transcodeVideosOnImport: record.transcodeVideosOnImport,
  }];
  });
};

export const reconcileConfiguredSdDevices = (
  config: SmartImportConfig,
  devices: StorageDevice[],
): SmartImportConfig => {
  const records = normalizeConfiguredSdDeviceRecords(config.sdDevices);
  if (!records.length) return config;
  const staleMirrorPaths = new Set<string>();
  const nextRecords = records.map(record => {
    const match = devices.find(device => storageDeviceMatchesId(device, record.deviceId) && isTrustedSdImportDevice(device));
    if (match && (identityKey(match.id) !== identityKey(record.deviceId) || pathKey(match.mountPath) !== pathKey(record.lastMountPath))) {
      staleMirrorPaths.add(pathKey(record.lastMountPath));
      return { ...record, deviceId: match.id, lastMountPath: match.mountPath };
    }
    const samePathCanonical = isLegacyWindowsGuid(record.deviceId)
      ? devices.find(device => isTrustedSdImportDevice(device) && pathKey(device.mountPath) === pathKey(record.lastMountPath))
      : undefined;
    return samePathCanonical && record.confirmedAt > 0 ? { ...record, confirmedAt: 0 } : record;
  });
  const nextConfigBase = staleMirrorPaths.size ? {
    ...config,
    sdPath: legacySelectedPaths(config).find(path => !staleMirrorPaths.has(pathKey(path))) || '',
    sdPaths: legacySelectedPaths(config).filter(path => !staleMirrorPaths.has(pathKey(path))),
    sdDriveTypes: Object.fromEntries(Object.entries(config.sdDriveTypes || {}).filter(([path]) => !staleMirrorPaths.has(pathKey(path)))),
    sdDriveVideoActions: Object.fromEntries(Object.entries(config.sdDriveVideoActions || {}).filter(([path]) => !staleMirrorPaths.has(pathKey(path)))),
    sdDeviceIds: Object.fromEntries(Object.entries(config.sdDeviceIds || {}).filter(([path]) => !staleMirrorPaths.has(pathKey(path)))),
  } : config;
  const nextConfig = syncLegacySdMirrors(nextConfigBase, nextRecords);
  return JSON.stringify(nextConfig) === JSON.stringify(config) ? config : nextConfig;
};
