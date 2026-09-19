import type { ComponentStatus } from '../../types';

export const COMPONENT_CACHE_VERSION = 1;
const statuses = new Set(['pending-install', 'installed', 'disabled', 'update-available', 'incompatible', 'invalid', 'integrity-invalid', 'package-invalid']);
const validString = (value: unknown, max: number) => typeof value === 'string' && value.length <= max;
const validStatus = (value: unknown): value is ComponentStatus => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const component=value as Record<string, unknown>;
  if (!validString(component.id,80)||!component.id||!validString(component.name,240)||!validString(component.description,4000)||!validString(component.capability,160)||!validString(component.version,80)||!validString(component.path,4096)||!validString(component.source,80)) return false;
  if(typeof component.installed!=='boolean'||typeof component.compatible!=='boolean'||!Number.isFinite(component.sizeBytes)||Number(component.sizeBytes)<0) return false;
  if(component.enabled!==undefined&&typeof component.enabled!=='boolean'||component.runtimeAvailable!==undefined&&typeof component.runtimeAvailable!=='boolean') return false;
  if(component.status!==undefined&&(!validString(component.status,80)||!statuses.has(String(component.status)))) return false;
  if(component.capabilities!==undefined&&(!Array.isArray(component.capabilities)||component.capabilities.length>128||component.capabilities.some(item=>!validString(item,160)||!/^[a-z][a-z0-9.-]{0,159}$/i.test(String(item)))||new Set(component.capabilities).size!==component.capabilities.length)) return false;
  return !['application','legacy-application','bundled'].includes(String(component.source||''));
};

export const readCachedComponentStatuses = (): ComponentStatus[] => {
  try {
    const cached = JSON.parse(window.localStorage.getItem('photoflow:components-cache') || 'null');
    return cached?.schemaVersion===COMPONENT_CACHE_VERSION&&Array.isArray(cached.components)&&cached.components.length<=512&&cached.components.every(validStatus)
      ? cached.components
      : [];
  } catch {
    return [];
  }
};
