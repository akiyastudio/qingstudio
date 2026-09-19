import { useEffect, useRef, useState } from 'react';
import { Check, PanelsTopLeft, Pin, RotateCcw } from 'lucide-react';
import { useEscapeLayer } from '../../components/LayerProvider';
import { useWorkspacePanels } from '../../platform/workspace-panel-registry';

const PanelVisibilityToggle = ({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (visible: boolean) => void; disabled?: boolean }) => (
  <button type="button" role="checkbox" aria-checked={checked} aria-label={`显示${label}`} disabled={disabled} onClick={() => onChange(!checked)} className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1.5 text-left text-xs text-slate-700 disabled:opacity-50"><span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300'}`}>{checked && <Check size={12}/>}</span>{label}</button>
);

export const WorkspacePanelMenu = ({ pageId, backgroundOpen, onBackgroundOpenChange }: {
  pageId: string | null;
  backgroundOpen: boolean;
  onBackgroundOpenChange: (visible: boolean) => void;
}) => {
  const controller = useWorkspacePanels(pageId);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); triggerRef.current?.focus(); };
  useEscapeLayer(open, close, true, true);
  useEffect(() => setOpen(false), [pageId]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const closeForOtherMenu = () => setOpen(false);
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('photoflow-menu-open', closeForOtherMenu);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('photoflow-menu-open', closeForOtherMenu);
    };
  }, [open]);
  return <div ref={rootRef} className="app-titlebar-control workspace-panel-menu-root relative flex shrink-0 items-center">
    <button ref={triggerRef} type="button" title="面板" aria-label="面板" aria-haspopup="dialog" aria-expanded={open} onClick={() => { window.dispatchEvent(new Event('photoflow-menu-open')); setOpen(!open); }} className={`flex h-8 w-8 items-center justify-center rounded-md hover:bg-slate-100 ${open ? 'bg-blue-50 text-blue-600' : 'text-slate-500'}`}><PanelsTopLeft size={16}/></button>
    {open && <div role="dialog" aria-label="面板设置" className="workspace-panel-menu absolute right-0 top-full z-[90] mt-1 w-80 max-w-[calc(100vw-1rem)] rounded-xl border border-slate-200 bg-white p-2 shadow-xl" onBlur={event => { if (event.relatedTarget && !rootRef.current?.contains(event.relatedTarget as Node)) setOpen(false); }}>
      <div className="px-2 pb-2 pt-1"><h2 className="text-sm font-semibold text-slate-700">面板</h2><p className="mt-1 text-xs text-slate-400">拖动标题栏空白处调整位置；固定后保持打开。</p></div>
      {controller ? <>
        {controller.panels.map(panel => <div key={panel.id} className="flex items-center gap-1 rounded-lg px-1 py-1 hover:bg-slate-50">
          <PanelVisibilityToggle label={panel.label} checked={panel.visible} onChange={visible => controller.setVisible(panel.id, visible)}/>
          <button type="button" aria-label={`${panel.pinned ? '取消固定' : '固定'}${panel.label}`} aria-pressed={panel.pinned} title={panel.pinned ? '取消固定' : '固定后保持打开'} onClick={() => controller.setPinned(panel.id, !panel.pinned)} className={`workspace-panel-menu-action ${panel.pinned ? 'bg-blue-50 text-blue-600' : 'text-slate-400'}`}><Pin size={14}/></button>
        </div>)}
        <button type="button" onClick={controller.reset} className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs text-slate-500 hover:bg-slate-100"><RotateCcw size={14}/>恢复默认布局</button>
      </> : <p className="px-2 py-3 text-xs text-slate-400">打开项目或灵感库后，可管理工作区面板。</p>}
      <div className="mt-1 border-t border-slate-100 pt-1"><div className="flex items-center gap-1 rounded-lg px-1 py-1 hover:bg-slate-50"><PanelVisibilityToggle label="后台任务" checked={backgroundOpen} onChange={onBackgroundOpenChange}/></div></div>
    </div>}
  </div>;
};
