import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Minimize2, X } from 'lucide-react';
import { ComponentIcon } from '../../components/ComponentIcon';
import { useEscapeLayer } from '../../components/LayerProvider';
import type { ComponentContribution } from '../../types';
import { useTaskCenter } from '../background-tasks/TaskCenter';
import { isActivePresentedBackgroundTaskForPanel } from '../background-tasks/panel-task-session-model';

export const ComponentToolPanelSurface = ({ contribution, instanceId, initialContentHeight = 0, ownerPageId, panelKind, open, onClose, onMinimize }: {
  contribution: ComponentContribution;
  instanceId: string;
  initialContentHeight?: number;
  ownerPageId: string;
  panelKind: string;
  open: boolean;
  onClose: () => void;
  onMinimize: () => void;
}) => {
  const { backgroundTasks } = useTaskCenter();
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(() => Math.max(0, Number(initialContentHeight) || 0));
  const currentInstanceRef=useRef(instanceId);const openRef=useRef(open);currentInstanceRef.current=instanceId;openRef.current=open;
  const backgroundTaskActive = backgroundTasks.some(task => isActivePresentedBackgroundTaskForPanel(task, ownerPageId, panelKind));
  const requestClose = backgroundTaskActive ? onMinimize : onClose;

  // A component panel is itself a native host surface, so it must remain
  // visible while the renderer-owned modal chrome is open.
  useEscapeLayer(open, requestClose, true, false);

  useEffect(() => {
    setContentHeight(Math.max(0, Number(initialContentHeight) || 0));
    return window.electronAPI.onComponentPanelContentSizeChanged(value => {
      if (value.instanceId === instanceId && Number.isFinite(value.height) && value.height > 0) setContentHeight(Math.ceil(value.height));
    });
  }, [initialContentHeight, instanceId]);

  useEffect(() => window.electronAPI.onComponentPanelCloseRequested(requestedInstanceId => {
    if (requestedInstanceId === instanceId) requestClose();
  }), [instanceId, requestClose]);

  useEffect(() => {
    if (!open) return;
    const interceptOutsidePointer = (event: PointerEvent) => {
      const backdrop = backdropRef.current;
      const dialog = dialogRef.current;
      if (!backdrop || !dialog) return;
      const bounds = backdrop.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
      if (event.composedPath().includes(dialog)) return;
      const target = event.target instanceof Element ? event.target : null;
      const higherDialog = target?.closest('[role="dialog"]');
      if (higherDialog && higherDialog !== dialog) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      requestClose();
    };
    window.addEventListener('pointerdown', interceptOutsidePointer, true);
    return () => window.removeEventListener('pointerdown', interceptOutsidePointer, true);
  }, [open, requestClose]);

  useEffect(() => {
    if (!instanceId) return;
    if(!open){let cancelled=false;void (async()=>{await window.electronAPI.setComponentPageBounds(instanceId,{x:0,y:0,width:0,height:0}).catch(()=>undefined);if(!cancelled&&currentInstanceRef.current===instanceId&&!openRef.current)await window.electronAPI.activateComponentPage({instanceId,deactivateIfActive:true}).catch(()=>undefined);})();return()=>{cancelled=true;};}
    const surface = surfaceRef.current;
    if (!surface) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const bounds = surface.getBoundingClientRect();
      void window.electronAPI.setComponentPageBounds(instanceId, {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      }).catch(() => undefined);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(surface);
    window.addEventListener('resize', schedule);
    void window.electronAPI.activateComponentPage({instanceId}).catch(() => undefined);
    schedule();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      if (frame) window.cancelAnimationFrame(frame);
      void window.electronAPI.setComponentPageBounds(instanceId, { x: 0, y: 0, width: 0, height: 0 }).catch(() => undefined);
    };
  }, [instanceId, open]);

  if (!open) return null;
  return createPortal(
    <div ref={backdropRef} className="tool-panel-backdrop fixed inset-x-0 bottom-0 top-10 z-[360] flex cursor-default items-center justify-center p-4">
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-label={contribution.title} style={{ height: contentHeight > 0 ? `min(${contentHeight + 60}px, 90vh)` : 'min(360px, 90vh)', maxHeight: '90vh' }} className="tool-panel-window flex w-full max-w-[960px] flex-col overflow-hidden border bg-white">
        <header className="tool-panel-header flex shrink-0 items-center gap-3 border-b border-slate-200 px-5">
          <span className="tool-panel-title-icon flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-blue-50 text-blue-600"><ComponentIcon src={contribution.iconUrl} size={18}/></span>
          <div className="min-w-0 flex-1"><h3 className="truncate text-[15px] font-bold text-slate-800">{contribution.title}</h3>{contribution.description && <p className="mt-0.5 truncate text-[10px] text-slate-400">{contribution.description}</p>}</div>
          <button type="button" onClick={requestClose} aria-label={backgroundTaskActive ? '收起到后台' : '关闭插件面板'} title={backgroundTaskActive ? '收起到后台，任务会继续运行' : '关闭'} className={`rounded-md text-slate-500 hover:bg-slate-100 ${backgroundTaskActive ? 'inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-bold' : 'p-1.5'}`}>{backgroundTaskActive ? <><Minimize2 size={15}/>收起到后台</> : <X size={18}/>}</button>
        </header>
        <div className="tool-panel-body relative min-h-0 flex-1 overflow-hidden"><div ref={surfaceRef} data-component-view-host aria-label={`${contribution.title} 插件内容`} className="absolute inset-0"/></div>
      </section>
    </div>,
    document.body,
  );
};
