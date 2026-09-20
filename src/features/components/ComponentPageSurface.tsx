import { useLocale } from "../../i18n/react";
import { t } from "../../i18n/runtime";
import { useEffect, useRef } from 'react';
import type { ComponentPageInstance } from '../../types';

export const ComponentPageSurface = ({ page, active }: { page: ComponentPageInstance; active: boolean }) => {
  useLocale();
  const surfaceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!page.instanceId || !active) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const bounds = surface.getBoundingClientRect();
      void window.electronAPI.setComponentPageBounds(page.instanceId, { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(surface);
    window.addEventListener('resize', schedule);
    void window.electronAPI.activateComponentPage({ instanceId: page.instanceId });
    schedule();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [active, page.instanceId]);
  return <div ref={surfaceRef} aria-label={t("ui.value0.component.page.9249fb", { value0: page.title })} className={active ? 'h-full w-full bg-white' : 'hidden'}/>;
};
