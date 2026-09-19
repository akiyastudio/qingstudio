import type { ReactNode } from 'react';
import { Pin, X } from 'lucide-react';
import type { WorkspacePanelId } from '../../contracts/workspace-panels';

export const WorkspacePanelDragSpace = ({ id, label }: { id: WorkspacePanelId; label: string }) => <div data-panel-drag-handle={id} tabIndex={0} aria-label={`移动${label}面板`} className="workspace-panel-drag-space"/>;
export const WorkspacePanelButtons = ({ label, pinned, onTogglePinned, onClose }: { label: string; pinned: boolean; onTogglePinned: () => void; onClose: () => void }) => <><button type="button" onClick={onTogglePinned} title={pinned ? `取消固定${label}面板` : `固定${label}面板`} aria-label={pinned ? `取消固定${label}面板` : `固定${label}面板`} aria-pressed={pinned} className={`rounded-md p-2 transition hover:bg-blue-50 hover:text-blue-600 ${pinned ? 'bg-blue-50 text-blue-600' : 'text-slate-500'}`}><Pin size={16} fill={pinned ? 'currentColor' : 'none'}/></button><button type="button" onClick={onClose} title={`关闭${label}`} aria-label={`关闭${label}`} className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><X size={16}/></button></>;
export const WorkspacePanelHeader = ({ id, label, title, subtitle, pinned, onTogglePinned, onClose, children, showButtons = true }: { id: WorkspacePanelId; label: string; title?: string; subtitle?: string; pinned: boolean; onTogglePinned: () => void; onClose: () => void; children?: ReactNode; showButtons?: boolean }) => <header className="flex min-h-14 shrink-0 items-center justify-between border-b border-slate-200 px-3 py-2">
  <div className="min-w-0 cursor-text select-text"><p className="text-xs font-bold uppercase tracking-wider text-slate-400">{title || label}</p><p className="truncate text-sm font-semibold text-slate-700">{subtitle ?? label}</p></div>
  <WorkspacePanelDragSpace id={id} label={label}/>
  <div className="flex items-center gap-1">{children}{showButtons && <WorkspacePanelButtons label={label} pinned={pinned} onTogglePinned={onTogglePinned} onClose={onClose}/>}</div>
</header>;
