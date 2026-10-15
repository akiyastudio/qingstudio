import { useEffect, useState } from 'react';
import type { CatalogPlugin } from '../../contracts/plugin-catalog';

export const useCloudPluginCatalog = (active: boolean) => {
  const [plugins, setPlugins] = useState<CatalogPlugin[]>([]);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const refresh = () => {
      void window.electronAPI.getPluginCatalog().then(result => {
        if (alive) setPlugins(result.success ? result.plugins : []);
      }).catch(() => { if (alive) setPlugins([]); });
    };
    refresh();
    const interval = window.setInterval(refresh, 60_000);
    const stop = window.electronAPI.onComponentsStatusChanged(refresh);
    return () => { alive = false; window.clearInterval(interval); stop(); };
  }, [active]);
  return plugins;
};
