import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AlertTriangle, ChevronRight, ExternalLink, Gift, HardDrive, Loader2, ShieldCheck } from 'lucide-react';
import { useEscapeLayer } from '../../components/LayerProvider';
import type { AppUpdateInfo, BackupStatus } from '../../types';

export const WindowControls = () => {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    void window.electronAPI.isWindowMaximized().then(setMaximized);
    return window.electronAPI.onWindowMaximizedChange(setMaximized);
  }, []);
  return <div className="app-titlebar-control flex h-10 w-[138px] shrink-0 items-stretch">
    <button type="button" onClick={() => window.electronAPI.minimizeWindow()} aria-label="最小化" title="最小化" className="window-control-button"><span className="window-glyph window-glyph-minimize"/></button>
    <button type="button" onClick={async () => setMaximized(await window.electronAPI.toggleMaximizeWindow())} aria-label={maximized ? '还原' : '最大化'} title={maximized ? '还原' : '最大化'} className="window-control-button">{maximized ? <span className="window-glyph window-glyph-restore"/> : <span className="window-glyph window-glyph-maximize"/>}</button>
    <button type="button" onClick={() => window.electronAPI.closeWindow()} aria-label="关闭" title="关闭" className="window-control-button window-control-close"><span className="window-glyph window-glyph-close"/></button>
  </div>;
};

export const StartupWindowFrame = ({ children }: { children: ReactNode }) => <div className="h-screen w-full overflow-auto">
  <header className="startup-window-titlebar fixed inset-x-0 top-0 z-[2000] flex h-10 items-stretch"><div title="拖动窗口" className="app-window-drag-region min-w-0 flex-1"/><WindowControls/></header>
  {children}
</div>;

export const BackupHomeCard = ({ status, onOpen, onRun }: { status: BackupStatus; onOpen: () => void; onRun: () => void }) => {
  const running = status.state === 'running';
  const protectedState = status.state === 'protected';
  const offline = status.state === 'offline';
  const title = running ? '正在备份'
    : protectedState ? '备份已保护'
      : offline ? '备份盘未连接'
        : status.state === 'never-backed-up' ? '尚未创建备份'
          : status.state === 'error' ? '备份需要处理' : '设置备份';
  const detail = running ? status.task?.message || '正在准备备份'
    : protectedState && status.latestAt ? `上次成功：${new Date(status.latestAt).toLocaleString()}`
      : offline ? status.targetPath || '连接备份盘后会自动恢复状态'
        : status.error || '保护项目文件、版本关系和软件设置';
  const Icon = running ? Loader2 : protectedState ? ShieldCheck : offline || status.state === 'error' ? AlertTriangle : HardDrive;
  const tone = protectedState ? 'bg-emerald-50 text-emerald-600' : offline || status.state === 'error' ? 'bg-amber-50 text-amber-600' : 'bg-blue-50 text-blue-600';
  return <div className="group flex min-w-0 items-center gap-4 rounded-xl border border-slate-200 bg-white px-5 py-5 transition hover:border-blue-400 hover:bg-blue-50 hover:shadow-sm">
    <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-4 text-left">
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${tone}`}><Icon size={22} className={running ? 'animate-spin' : undefined}/></span>
      <span className="min-w-0 flex-1"><span className="block text-base font-bold text-slate-800">{title}</span><span title={detail} className="mt-1 block truncate text-xs text-slate-500">{detail}</span></span>
    </button>
    {status.enabled && !running && <button type="button" onClick={onRun} className="shrink-0 rounded-lg border border-blue-200 bg-white px-3 py-2 text-xs font-bold text-blue-600 hover:bg-blue-50">立即备份</button>}
    {!status.enabled && <ChevronRight size={19} className="shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-blue-500"/>}
  </div>;
};

export const UpdateModal = ({ version, notes, url, mandatory, onClose }: AppUpdateInfo & { onClose: () => void }) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEscapeLayer(true, onClose, !mandatory, true);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>('[data-default-focus="true"]')?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      window.requestAnimationFrame(() => previousFocus?.isConnected && previousFocus.focus());
    };
  }, []);
  const trapFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])];
    if (!controls.length) { event.preventDefault(); dialogRef.current?.focus(); return; }
    const first = controls[0]; const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-50/80 backdrop-blur-sm p-4 animate-in fade-in duration-300">
    <div ref={dialogRef} tabIndex={-1} onKeyDown={trapFocus} role="dialog" aria-modal="true" aria-label={`${mandatory ? '必须更新至' : '发现新版本'} ${version}`} className="bg-white border border-blue-500/30 w-full max-w-md rounded-2xl shadow-2xl flex flex-col relative overflow-hidden">
      <div className="absolute top-0 right-0 p-16 bg-blue-500/20 blur-3xl rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none"/>
      <div className="p-6 pb-0 z-10"><div className="w-12 h-12 bg-blue-500/20 rounded-xl flex items-center justify-center text-blue-600 mb-4 border border-blue-500/20"><Gift size={24}/></div><h3 className="text-xl font-bold text-slate-800 mb-2">{mandatory ? '需要更新至' : '发现新版本'} {version}</h3><p className="text-slate-500 text-sm">{mandatory ? '此版本为必须更新版本，完成更新后才能继续使用照片流。' : '一个新的更新已准备就绪。下载安装包以体验最新功能。'}</p></div>
      <div className="p-6 z-10"><div className="bg-slate-50/50 rounded-lg p-4 border border-slate-200 max-h-40 overflow-y-auto"><p className="text-xs font-bold text-slate-500 uppercase mb-2">更新日志</p><p className="text-sm text-slate-800 whitespace-pre-wrap">{notes}</p></div></div>
      <div className="p-6 pt-2 flex gap-3 z-10">{!mandatory && <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition font-medium text-sm">以后再说</button>}<button type="button" data-default-focus="true" onClick={() => window.electronAPI?.openExternal?.(url)} className="flex-1 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-900/20 transition font-bold text-sm flex items-center justify-center gap-2">去下载 <ExternalLink size={14}/></button></div>
    </div>
  </div>;
};
