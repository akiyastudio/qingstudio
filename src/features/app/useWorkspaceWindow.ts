import { useEffect, useRef, useState } from 'react';
import { useAppDialog } from '../../components/AppDialogProvider';
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
        // Closing the page during that work could lose a continuation or a draft.
        if (running.length && !quit) {
          const id = workspaceWindowContext()?.id;
          if (id) await api.activate(id);
          await current.current.dialog.alert({ title: '标签页中还有任务', message: '请等待任务完成，或先在任务面板中取消，再关闭标签页。', detail: running.map(task => task.title).join('\n') });
          await api.respondClose(token, false);
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
