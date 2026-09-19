import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { projectStatusLabel, type WorkspaceProject } from '../../types';
import { ViewportContextMenu } from './ProjectWorkspaceLayout';

export const ProjectStatusMenu = ({ open, status, statuses, onOpenChange, onSelect }: {
  open: boolean; status: WorkspaceProject['status']; statuses: WorkspaceProject['status'][];
  onOpenChange: (value: boolean) => void; onSelect: (status: WorkspaceProject['status']) => void;
}) => {
  const [position, setPosition] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (!open) return;
    const close = () => onOpenChange(false);
    const onScroll = (event: Event) => { if (!(event.target instanceof Element && event.target.closest('[role="menu"]'))) close(); };
    window.addEventListener('resize', close); window.addEventListener('scroll', onScroll, true);
    return () => { window.removeEventListener('resize', close); window.removeEventListener('scroll', onScroll, true); };
  }, [open, onOpenChange]);
  return <div className="relative" onClick={event => event.stopPropagation()}>
    <button aria-label="修改项目状态" aria-haspopup="menu" aria-expanded={open} onClick={event => {
      const next = !open; const rect = event.currentTarget.getBoundingClientRect();
      window.dispatchEvent(new Event('photoflow-menu-open'));
      setPosition({ x: rect.left, y: rect.bottom + 4 }); onOpenChange(next);
    }} className="flex items-center gap-1 rounded-full border border-blue-100 bg-blue-50 px-2.5 py-1 text-xs font-bold text-blue-600 hover:bg-blue-100">{projectStatusLabel(status)} <ChevronDown size={14}/></button>
    {open && createPortal(<ViewportContextMenu x={position.x} y={position.y} widthClass="w-36">
      {statuses.map(value => <button key={value} role="menuitem" onClick={() => onSelect(value)} className={`project-menu-item ${value === status ? 'bg-blue-50 font-bold text-blue-600' : ''}`}>{projectStatusLabel(value)}{value === status ? '（当前）' : ''}</button>)}
    </ViewportContextMenu>, document.body)}
  </div>;
};
