import { useEffect, useRef, useState } from 'react';
import type { StartupSdAutoImportRequest } from './startup-sd-auto-import-model';

const STARTUP_SD_IMPORT_WINDOW_MS = 60_000;

export const useStartupSdAutoImport = ({
  enabledAtLaunch,
  enabledNow,
  ready,
  onStart,
}: {
  enabledAtLaunch: boolean;
  enabledNow: boolean;
  ready: boolean;
  onStart: () => void;
}) => {
  const issuedRef = useRef(false);
  const [request, setRequest] = useState<StartupSdAutoImportRequest | null>(null);

  useEffect(() => {
    if (!ready || issuedRef.current) return;
    issuedRef.current = true;
    if (!enabledAtLaunch) return;
    const createdAt = Date.now();
    onStart();
    setRequest({ id: 1, createdAt, expiresAt: createdAt + STARTUP_SD_IMPORT_WINDOW_MS, state: 'pending' });
  }, [enabledAtLaunch, onStart, ready]);

  useEffect(() => {
    if (!request || request.state !== 'pending') return;
    if (!enabledNow) {
      setRequest(current => current?.state === 'pending' ? { ...current, state: 'cancelled' } : current);
      return;
    }
    const remainingMs = request.expiresAt - Date.now();
    if (remainingMs <= 0) {
      setRequest(current => current?.state === 'pending' ? { ...current, state: 'expired' } : current);
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setRequest(current => current?.state === 'pending' ? { ...current, state: 'expired' } : current);
    }, remainingMs);
    return () => window.clearTimeout(timeoutId);
  }, [enabledNow, request]);

  return request;
};
