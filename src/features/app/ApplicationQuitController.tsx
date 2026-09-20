import { useLocale } from "../../i18n/react";
import { t } from "../../i18n/runtime";
import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAppDialog } from '../../components/AppDialogProvider';
import { useEscapeLayer } from '../../components/LayerProvider';
import type { ApplicationQuitState } from '../../types';
import { flushApplicationBeforeQuit } from './application-quit-client';

export const ApplicationQuitController = () => {
  useLocale();
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
        title: t("ui.confirm.exit.ab942a"), message: t("ui.there.are.unfinished.tasks.exit.anyway.4f4169"),
        detail: t("ui.these.tasks.will.stop.when.you.0a0ce3", { value0: detail }),
        confirmLabel: t("ui.exit.anyway.147b9a"), cancelLabel: t("ui.stay.c27b13"), tone: 'danger', priority: true,
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
        <h3 id="application-quit-title" className="font-bold text-slate-800">{t("ui.saving.and.finishing.tasks.18478a")}</h3>
      </div>
      <p className="mt-3 text-sm leading-6 text-slate-500">{t("ui.please.wait.the.application.will.close.0038d8")}</p>
    </section>
  </div>;
};
