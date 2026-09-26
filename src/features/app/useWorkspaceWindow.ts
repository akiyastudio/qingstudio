import { useEffect, useRef, useState } from 'react';
import { useAppDialog } from '../../components/AppDialogProvider';
import { t } from '../../i18n/runtime';
import { useTaskCenter } from '../background-tasks/TaskCenter';
import { flushApplicationBeforeQuit } from './application-quit-client';
import { workspaceWindowContext } from '../../platform/workspace-window-client';

export const useWorkspaceWindow = (onError: (message: string) => void, ready: boolean) => {
  const [context, setContext] = useState(workspaceWindowContext);
  const { panelTasks } = useTaskCenter();
  const dialog = useAppDialog();
  const current = useRef({ panelTasks, dialog, onError });
  current.current = { panelTasks, dialog, onError };
  useEffect(() => {
    // Effects run after React commits the page. HTML load alone is too early
    // to expose a new tab, and hidden views cannot rely on animation frames.
    if (ready) void window.electronAPI.workspaceWindows?.ready().catch(error => current.current.onError(String(error.message || error)));
  }, [ready]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    return () => cancelAnimationFrame(frame);
  }, [context?.windowId]);
  useEffect(() => {
    const api = window.electronAPI.workspaceWindows;
    if (!api) return;
    const receive = (next: NonNullable<typeof context>) => setContext(previous => !previous || next.revision >= previous.revision ? next : previous);
    const unsubscribe = api.onChanged(receive);
    void api.context().then(receive).catch(error => current.current.onError(String(error.message || error)));
    const close = api.onPrepareClose(({ token, quit }) => {
      void (async () => {
        if (quit) {
          // The main process drains queued configuration writes. A frozen page
          // or a long local task must not prevent an already confirmed quit.
          void flushApplicationBeforeQuit().catch(error => console.error('退出前保存设置失败，将继续退出', error));
          await Promise.resolve();
          await api.respondClose(token, true);
          return;
        }
        const running = Object.values(current.current.panelTasks).filter(task => task.state === 'running' && !task.nativeTabId);
        // Page-owned work is retained until its completion callbacks have run.
        // Closing the page during that work loses a continuation or a draft, so
        // the window asks first and lets the user drop it deliberately.
        if (running.length) {
          const id = workspaceWindowContext()?.id;
          // Bringing the tab forward is a convenience. A window whose tab list
          // changed while closing must still receive the confirmation below.
          if (id) await api.activate(id).catch(() => undefined);
          const detail = running.slice(0, 5).map(task => `• ${String(task.title || '').split('').map(char => char < ' ' || char === '\u007f' ? ' ' : char).join('').trim().slice(0, 160)}`)
            .concat(running.length > 5 ? [t("message.2f60df77b36a", { count: running.length - 5 })] : []).join('\n');
          const confirmed = await current.current.dialog.confirm({
            title: t("ui.close.window.e3896a"), message: t("ui.tasks.are.still.unfinished.close.this.7886ac"),
            detail: t("ui.these.tasks.will.be.interrupted.after.59c433", { value0: detail }),
            confirmLabel: t("ui.close.anyway.19bb74"), cancelLabel: t("ui.keep.it.open.a65b4c"), tone: 'danger', priority: true,
          });
          if (!confirmed) { await api.respondClose(token, false); return; }
          // An accepted close must not be blocked by a frozen page or a long
          // local task, exactly like an already confirmed application quit.
          void flushApplicationBeforeQuit().catch(error => console.error('关闭窗口前保存设置失败，将继续关闭', error));
          await Promise.resolve();
          await api.respondClose(token, true);
          return;
        }
        await flushApplicationBeforeQuit();
        await api.respondClose(token, true);
      })().catch(error => { current.current.onError(String(error.message || error)); void api.respondClose(token, false); });
    });
    const error = (event: Event) => current.current.onError(String((event as CustomEvent).detail));
    window.addEventListener('photoflow:window-error', error);
    return () => { unsubscribe(); close(); window.removeEventListener('photoflow:window-error', error); };
  }, []);
  return context;
};
