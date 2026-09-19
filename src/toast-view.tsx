import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { FileTransferToastItem } from './features/background-tasks/FileTransferToast';
import { taskToastInstanceKey } from './features/background-tasks/task-toast-model';
import type { ToastViewAction, ToastViewSnapshot } from './features/app/toast-view-contract';
import { topToastTonePresentation } from './features/app/top-toast-tone-model';
import { TOAST_STACK_REFLOW_MS, useToastStackReflow } from './components/toast-stack-reflow';
import './index.css';

const EMPTY_SNAPSHOT: ToastViewSnapshot = { revision: 0, dark: false, top: 40, width: 0, height: 0, notices: [], tasks: [], overflowCount: 0 };
const sendAction = (action: ToastViewAction['action'], id: string | number) => window.toastViewAPI.sendAction({ action, id: String(id) });

export const ToastView = () => {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const stackRef = useRef<HTMLDivElement>(null);
  const reflowKey = JSON.stringify({
    notices: snapshot.notices.map(notice => [notice.id, notice.message, notice.count]),
    tasks: snapshot.tasks.map(task => [task.id, task.state]),
    overflow: snapshot.overflowCount > 0,
  });
  useToastStackReflow(stackRef, reflowKey);

  useEffect(() => window.toastViewAPI.onSnapshot(setSnapshot), []);
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', snapshot.dark);
    const stack = stackRef.current;
    if (!stack) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const report = () => window.toastViewAPI.reportLayout({ revision: snapshot.revision, height: Math.max(0, Math.ceil(stack.scrollHeight)), reflowMs: reducedMotion ? 0 : TOAST_STACK_REFLOW_MS });
    const observer = new ResizeObserver(report);
    observer.observe(stack);
    report();
    return () => observer.disconnect();
  }, [snapshot.dark, snapshot.revision]);

  return <div ref={stackRef} className="top-toast-stack top-toast-stack--view" data-global-overlay-layer="toast" aria-label="通知">
    {snapshot.notices.map(notice => {
      const presentation = topToastTonePresentation(notice.tone || 'info');
      const ToneIcon = presentation.icon === 'check' ? CheckCircle2 : presentation.icon === 'warning' ? AlertTriangle : presentation.icon === 'error' ? XCircle : Info;
      return <div key={notice.id} data-top-toast-id={`notice:${notice.id}`} data-toast-tone={presentation.tone} role={presentation.role} aria-live={presentation.ariaLive} className="app-notice-toast animate-in fade-in slide-in-from-top-2">
        <ToneIcon size={16} aria-hidden="true" className="app-notice-toast__tone-icon shrink-0"/><span className="app-notice-toast__message">{notice.message}{notice.count > 1 && <span className="app-notice-toast__count">×{notice.count}</span>}</span><button type="button" onClick={() => sendAction('notice-dismiss', notice.id)} aria-label="关闭提示" title="关闭提示" className="app-notice-toast__dismiss"><X size={15}/></button>
      </div>;
    })}
    {snapshot.tasks.map(task => <FileTransferToastItem key={taskToastInstanceKey(task)} task={task} onMinimize={id => sendAction('task-minimize', id)} onDismiss={id => sendAction('task-dismiss', id)} onPause={id => sendAction('task-pause', id)} onContinue={id => sendAction('task-continue', id)} onCancel={value => sendAction('task-cancel', value.id)}/>) }
    {snapshot.overflowCount > 0 && <div data-top-toast-id="task-overflow" className="file-transfer-toast-overflow">还有 {snapshot.overflowCount} 个任务</div>}
  </div>;
};

ReactDOM.createRoot(document.getElementById('toast-view-root')!).render(<React.StrictMode><ToastView/></React.StrictMode>);
