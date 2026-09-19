import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAppDialog } from '../../components/AppDialogProvider';
import { useEscapeLayer } from '../../components/LayerProvider';
import type { ApplicationQuitState } from '../../types';
import { flushApplicationBeforeQuit } from './application-quit-client';

export const ApplicationQuitController = () => {
  const dialog = useAppDialog();
  const [state, setState] = useState<ApplicationQuitState>({ phase: 'idle' });
  const [showSaving, setShowSaving] = useState(false);
  const handled = useRef('');
  const surface = useRef<HTMLElement>(null);
  useEffect(() => {
    const receive = (next: ApplicationQuitState) => setState(current => (next.revision || 0) < (current.revision || 0) ? current : next);
    const unsubscribe = window.electronAPI.onApplicationQuitState(receive);
    void window.electronAPI.getApplicationQuitState().then(receive);
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (state.phase !== 'saving') { setShowSaving(false); return; }
    const timer = setTimeout(() => setShowSaving(true), 250);
    return () => clearTimeout(timer);
  }, [state.phase]);
  useEffect(() => {
    if (state.phase !== 'confirming' || !state.requestId || handled.current === state.requestId) return;
    handled.current = state.requestId;
    const requestId = state.requestId;
    void (async () => {
      const tasks = state.tasks || [];
      const labels: Record<string, string> = { queued: '等待中', running: '进行中', paused: '已暂停', pausing: '暂停中', resuming: '恢复中' };
      const detail = tasks.slice(0, 5).map(task => `• ${task.title || '未命名任务'}（${labels[task.state] || '未完成'}）`).join('\n')
        + (tasks.length > 5 ? `\n另有 ${tasks.length - 5} 个任务` : '');
      const confirmed = !tasks.length || await dialog.confirm({
        title: '确认退出', message: '还有任务未完成，确定要退出吗？',
        detail: `退出后，以下任务将停止：\n${detail}`,
        confirmLabel: '仍然退出', cancelLabel: '暂不退出', tone: 'danger', priority: true,
      });
      if (!confirmed) {
        await window.electronAPI.respondToApplicationQuit(requestId, false);
        return;
      }
      setState(current => ({ ...current, phase: 'saving' }));
      try {
        if (!window.electronAPI.workspaceWindows) void flushApplicationBeforeQuit().catch(error => console.error('退出前保存设置失败，将继续退出', error));
      } catch (error) {
        console.error('退出前保存设置失败，将继续退出', error);
      }
      await window.electronAPI.respondToApplicationQuit(requestId, true);
    })().catch(error => console.error('退出确认流程失败', error));
  }, [dialog, state]);
  const visible = showSaving;
  useEscapeLayer(visible, () => undefined, true, true);
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => (surface.current?.querySelector<HTMLButtonElement>('button') || surface.current)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [visible, state.phase]);
  if (!visible) return null;
  return <div className="fixed inset-0 z-[3100] flex items-center justify-center bg-slate-950/40 p-4">
    <section ref={surface} tabIndex={-1} onKeyDown={event => { if (event.key === 'Tab') { event.preventDefault(); (surface.current?.querySelector<HTMLButtonElement>('button') || surface.current)?.focus(); } }} role="dialog" aria-modal="true" aria-labelledby="application-quit-title" className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
      <div className="flex items-center gap-3">
        <Loader2 className="animate-spin text-blue-500" size={20}/>
        <h3 id="application-quit-title" className="font-bold text-slate-800">正在保存并结束任务</h3>
      </div>
      <p className="mt-3 text-sm leading-6 text-slate-500">请稍候，完成必要的保存后会自动关闭。</p>
    </section>
  </div>;
};
