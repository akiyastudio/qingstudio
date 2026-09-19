import { Settings } from 'lucide-react';

export const SidebarSettingsButton = ({ onClick }: { onClick: () => void }) => (
  <div className="border-t border-slate-200 px-3 py-2">
    <button type="button" onClick={onClick} className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900">
      <Settings size={17} className="text-slate-400"/>
      <span className="text-sm font-medium">设置</span>
    </button>
  </div>
);
