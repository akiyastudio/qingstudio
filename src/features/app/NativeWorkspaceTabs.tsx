import { workspaceTabLabel } from '../../i18n/tab-labels';
import { useLocale } from "../../i18n/react";
import { t } from "../../i18n/runtime";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ExternalLink, Folder, GitBranch, Home, Lightbulb, Loader2, PanelTop, Search, Settings, X } from 'lucide-react';
import type { WorkspaceWindowContext, WorkspaceWindowsAPI } from '../../platform/workspace-window-client';
import { ComponentIcon } from '../../components/ComponentIcon';

export const NativeWorkspaceTabs = ({ context, onError, actions }: { context: WorkspaceWindowContext; onError: (message: string) => void; actions?: Pick<WorkspaceWindowsAPI, 'activate' | 'close' | 'reorder'> }) => {
  useLocale();
  const [dragged, setDragged] = useState('');
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const cleanup = useRef<() => void>();
  const suppressClick = useRef(false);
  const api = { ...window.electronAPI.workspaceWindows!, ...actions };
  const run = (operation: Promise<unknown>) => { void operation.catch(error => onError(String(error.message || error))); };
  useEffect(() => () => cleanup.current?.(), []);
  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('blur', dismiss);
    window.addEventListener('keydown', dismiss);
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('blur', dismiss); window.removeEventListener('keydown', dismiss); };
  }, [menu]);
  const startDrag = (event: ReactPointerEvent<HTMLElement>, id: string, pinned: boolean) => {
    if (pinned || event.button !== 0 || (event.target as HTMLElement).closest('[data-tab-drag-ignore]')) return;
    cleanup.current?.();
    const element = event.currentTarget, pointerId = event.pointerId, x = event.clientX, y = event.clientY;
    let started = false;
    let targetIndex = context.tabs.findIndex(tab => tab.id === id);
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', escape);
      window.removeEventListener('blur', cancel);
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      setDragged(''); cleanup.current = undefined;
      if (started) { suppressClick.current = true; setTimeout(() => { suppressClick.current = false; }, 100); }
    };
    const cancel = () => finish();
    const escape = (key: KeyboardEvent) => { if (key.key === 'Escape') finish(); };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      if (!started && Math.hypot(pointer.clientX - x, pointer.clientY - y) < 8) return;
      if (!started) { started = true; element.setPointerCapture(pointerId); setDragged(id); }
      pointer.preventDefault();
      const container = element.parentElement;
      if (!container) return;
      const bounds = container.getBoundingClientRect();
      if (pointer.clientY < bounds.top - 10 || pointer.clientY > bounds.bottom + 10) return;
      if (pointer.clientX < bounds.left + 36) container.scrollLeft -= 18;
      if (pointer.clientX > bounds.right - 36) container.scrollLeft += 18;
      const tabs = [...container.querySelectorAll<HTMLElement>('[data-native-tab]')].filter(tab => tab.dataset.nativeTab !== id);
      const candidate = tabs.findIndex(tab => pointer.clientX < tab.getBoundingClientRect().left + tab.getBoundingClientRect().width / 2);
      const next = Math.max(context.tabs.some(tab => tab.pinned) ? 1 : 0, candidate < 0 ? tabs.length : candidate);
      if (next !== targetIndex) { targetIndex = next; run(api.reorder(id, next)); }
    };
    const up = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      const wasStarted = started;
      finish();
      if (wasStarted) run(api.drop(id));
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', escape);
    window.addEventListener('blur', cancel);
    cleanup.current = finish;
  };
  const icons = { home: Home, project: Folder, inspiration: Lightbulb, component: PanelTop, version: GitBranch, settings: Settings, 'search-all': Search };
  return <>
    {context.tabs.map(tab => {
      const label = workspaceTabLabel(tab);
      const Icon = tab.ready ? icons[tab.kind] : Loader2;
      return <div key={tab.id} data-native-tab={tab.id} data-titlebar-tab-id={tab.id} data-active-tab={tab.active} data-dragging={dragged === tab.id || undefined}
        onPointerDown={event => { if (tab.ready) startDrag(event, tab.id, tab.pinned); }}
        onContextMenu={event => { if (!tab.pinned && tab.ready) { event.preventDefault(); setMenu({ id: tab.id, x: event.clientX, y: event.clientY }); } }}
        title={!tab.ready ? t("ui.opening.value0.462dee", { value0: label }) : tab.pinned ? label : t("ui.value0.drag.out.to.a.new.5bc457", { value0: label })}
        className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[112px] max-w-[230px] shrink-0 select-none items-center rounded-t-lg border text-xs font-medium transition ${tab.active ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
        <button type="button" aria-busy={!tab.ready} onClick={() => { if (!suppressClick.current) run(api.activate(tab.id)); }} className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-3 text-left">{tab.ready && tab.kind === 'component' ? <ComponentIcon src={tab.iconUrl} size={14}/> : <Icon size={14} className={tab.ready ? 'shrink-0' : 'shrink-0 animate-spin'}/>}<span className="truncate">{label}</span></button>
        {!tab.pinned && <button type="button" data-tab-drag-ignore aria-label={t("ui.close.value0.9a7809", { value0: label })} onClick={() => run(api.close(tab.id))} className="mr-1 rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-800"><X size={13}/></button>}
      </div>;
    })}
    {menu && <div role="menu" onPointerDown={event => event.stopPropagation()} className="app-titlebar-control fixed z-[4000] min-w-44 rounded-lg border border-slate-200 bg-white p-1 shadow-xl" style={{ left: Math.min(menu.x, window.innerWidth - 190), top: menu.y }}>
      <button role="menuitem" className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm hover:bg-slate-100" onClick={() => { run(api.detach(menu.id)); setMenu(null); }}><ExternalLink size={14}/>{t("ui.move.to.new.window.4f2697")}</button>
      <button role="menuitem" className="w-full rounded px-3 py-2 text-left text-sm hover:bg-slate-100" onClick={() => { run(api.merge()); setMenu(null); }}>{t("ui.merge.all.windows.b5c74f")}</button>
    </div>}
  </>;
};
