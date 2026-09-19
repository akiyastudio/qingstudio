import { useEffect, useRef, useState } from 'react';
import type { ComponentSettingsPageContribution } from '../../types';

type CustomSettingsPage = Extract<ComponentSettingsPageContribution, { renderMode: 'custom' }> | Extract<ComponentSettingsPageContribution, { renderMode: 'hybrid' }>;
type ComponentSettingsPageSurfaceProps = {
  page: CustomSettingsPage;
  onError: (message: string) => void;
  onReady?: () => void;
  visible?: boolean;
};

const hiddenBounds = { x: 0, y: 0, width: 0, height: 0 };

export const ComponentSettingsPageSurface = ({ page, onError, onReady, visible = true }: ComponentSettingsPageSurfaceProps) => {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const onErrorRef = useRef(onError);
  const onReadyRef = useRef(onReady);
  const [instanceId, setInstanceId] = useState('');
  const openGeneration = useRef(0);

  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);

  useEffect(() => {
    let disposed = false; const generation=++openGeneration.current; setInstanceId('');
    const leaseId = `settings-${globalThis.crypto.randomUUID()}`;
    void window.electronAPI.openComponentSettingsPage({ componentId: page.componentId, pageId: page.pageId, leaseId }).then(result => {
      if (!result.success || !result.page) throw new Error(result.error || '打开组件设置页失败');
      if (result.page.leaseId !== leaseId) { void window.electronAPI.releaseComponentSettingsPage({ componentId: page.componentId, pageId: page.pageId, leaseId }).catch(() => undefined); throw new Error('组件设置页 lease 不匹配'); }
      if (disposed || generation!==openGeneration.current) { void window.electronAPI.releaseComponentSettingsPage({ componentId: page.componentId, pageId: page.pageId, leaseId }).catch(() => undefined); return; }
      setInstanceId(result.page.instanceId); onReadyRef.current?.();
    }).catch(error => { if (!disposed && generation===openGeneration.current) onErrorRef.current(error instanceof Error ? error.message : String(error)); });
    return () => {
      disposed = true; openGeneration.current+=1;
      void window.electronAPI.releaseComponentSettingsPage({ componentId: page.componentId, pageId: page.pageId, leaseId }).catch(() => undefined);
    };
  }, [page.componentId, page.componentVersion, page.pageId]);

  useEffect(() => {
    if (!instanceId) return;
    if (!visible) {
      void window.electronAPI.setComponentPageBounds(instanceId, hiddenBounds).catch(() => undefined);
      return;
    }
    const surface = surfaceRef.current;
    if (!surface) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const bounds = surface.getBoundingClientRect();
      void window.electronAPI.setComponentPageBounds(instanceId, { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }).catch(() => undefined);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(surface);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    void window.electronAPI.activateComponentPage({instanceId}).catch(() => undefined);
    schedule();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      if (frame) window.cancelAnimationFrame(frame);
      void window.electronAPI.setComponentPageBounds(instanceId, hiddenBounds).catch(() => undefined);
    };
  }, [instanceId, visible]);

  return <div ref={surfaceRef} aria-label={`${page.pageTitle} 组件设置页`} className="pf-canvas h-full w-full"/>;
};
