import { useEffect, useState } from 'react';
import { createStorageDeviceInventoryController, type StorageDeviceInventorySnapshot } from './storage-device-inventory-model';

const inventoryController = createStorageDeviceInventoryController({
  load: async () => {
    if (!window.electronAPI?.getStorageDevices) throw new Error('当前版本不支持读取存储设备');
    return window.electronAPI.getStorageDevices();
  },
  schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
  cancelSchedule: handle => window.clearTimeout(handle as number),
});

export const useStorageDeviceInventory = (enabled: boolean): StorageDeviceInventorySnapshot => {
  const [snapshot, setSnapshot] = useState(inventoryController.getSnapshot());
  useEffect(() => {
    if (!enabled) return;
    return inventoryController.subscribe(setSnapshot);
  }, [enabled]);
  return snapshot;
};
