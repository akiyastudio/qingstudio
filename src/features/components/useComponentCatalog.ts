import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentSettingsPageContribution, ComponentStatus } from '../../types';
import { COMPONENT_CACHE_VERSION, readCachedComponentStatuses } from './component-cache';
import { componentHostCatalogKey } from './useComponentPages';

type UseComponentCatalogOptions = {
  onError: (message: string) => void;
  onSettingsPagesChanged: (pages: ComponentSettingsPageContribution[]) => void;
};

const cacheComponents = (components: ComponentStatus[]) => {
  try { window.localStorage.setItem('photoflow:components-cache', JSON.stringify({schemaVersion:COMPONENT_CACHE_VERSION,components:components.slice(0,512)})); }
  catch { /* Cache quota or privacy mode must not turn a successful refresh into a failure. */ }
};

export const useComponentCatalog = ({ onError, onSettingsPagesChanged }: UseComponentCatalogOptions) => {
  const [components, setComponents] = useState<ComponentStatus[]>(readCachedComponentStatuses);
  const [componentInstallPath, setComponentInstallPath] = useState('');
  const [componentsLoading, setComponentsLoading] = useState(true);
  const [componentSettingsPages, setComponentSettingsPages] = useState<ComponentSettingsPageContribution[]>([]);
  const refreshGeneration = useRef(0);
  const catalogKey = componentHostCatalogKey(components);

  const refreshComponents = useCallback(async (force = false) => {
    const generation = ++refreshGeneration.current;
    setComponentsLoading(true);
    try {
      const result = await window.electronAPI.getComponents(force);
      if (generation !== refreshGeneration.current) return;
      if (!result.success) throw new Error(result.error || '无法读取组件状态');
      const nextComponents = result.components || [];
      setComponents(nextComponents);
      cacheComponents(nextComponents);
      setComponentInstallPath(result.installPath || '');
    } catch (error) {
      if (generation !== refreshGeneration.current) return;
      onError(`读取组件状态失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (generation === refreshGeneration.current) setComponentsLoading(false);
    }
  }, [onError]);

  const handleComponentsChanged = useCallback(async () => {
    await refreshComponents(true);
    window.dispatchEvent(new Event('photoflow-components-changed'));
  }, [refreshComponents]);

  useEffect(() => {
    let active = true;
    void window.electronAPI.getComponentSettingsPages().then(result => {
      if (!active) return;
      const pages = result.success ? result.pages || [] : [];
      setComponentSettingsPages(pages);
      onSettingsPagesChanged(pages);
    }).catch(() => {
      if (!active) return;
      setComponentSettingsPages([]);
      onSettingsPagesChanged([]);
    });
    return () => { active = false; };
  }, [catalogKey, onSettingsPagesChanged]);

  useEffect(() => { void refreshComponents(); }, [refreshComponents]);

  useEffect(() => window.electronAPI.onComponentsStatusChanged(result => {
    if (!result.success) return;
    refreshGeneration.current += 1;
    const nextComponents = result.components || [];
    setComponents(nextComponents);
    cacheComponents(nextComponents);
    setComponentInstallPath(result.installPath || '');
    setComponentsLoading(false);
  }), []);

  return { components, componentInstallPath, componentsLoading, componentSettingsPages, refreshComponents, handleComponentsChanged };
};
