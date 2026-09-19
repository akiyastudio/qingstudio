import { useEffect, useRef } from 'react';
import {
  recordRendererError,
  rendererErrorNoticeSummary,
  type RendererErrorOccurrence,
} from './renderer-error-notice-model';

type Notice = (message: string, durationOrTone?: number | 'info' | 'success' | 'warning' | 'error') => void;

interface PythonErrorEvent {
  type: 'log' | 'error' | 'progress' | 'status' | 'ask_user' | 'success' | 'warning' | 'preview';
  message: string;
  scriptName?: string;
}

export const useRendererErrorReporting = (showNotice: Notice) => {
  const recentRendererErrorsRef = useRef<RendererErrorOccurrence[]>([]);

  useEffect(() => {
    const report = (message: string, details?: string) => {
      const now = Date.now();
      const decision = recordRendererError(recentRendererErrorsRef.current, message, now);
      recentRendererErrorsRef.current = decision.occurrences;
      if (!decision.report) return;
      showNotice(`发生错误：${rendererErrorNoticeSummary(message)}`);
      window.electronAPI?.reportRendererError?.(message, details);
    };
    const originalConsoleError = console.error;
    console.error = (...values: unknown[]) => {
      originalConsoleError(...values);
      const message = values.map(value => value instanceof Error ? value.message : String(value)).join(' ');
      report(message || '界面操作失败', values.map(value => value instanceof Error ? value.stack : String(value)).join('\n'));
    };
    const handleWindowError = (event: ErrorEvent) => report(event.message || '界面运行异常', event.error?.stack);
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      report(reason instanceof Error ? reason.message : String(reason || '异步操作失败'), reason instanceof Error ? reason.stack : undefined);
    };
    const removePythonListener = window.electronAPI?.onPythonEvent?.((event: PythonErrorEvent) => {
      if (event.type === 'error') report(event.message || `${event.scriptName || '后台任务'}执行失败`);
    });
    const removeMainErrorListener = window.electronAPI?.onAppError?.(message => report(message));
    window.addEventListener('error', handleWindowError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    return () => {
      console.error = originalConsoleError;
      window.removeEventListener('error', handleWindowError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
      removePythonListener?.();
      removeMainErrorListener?.();
    };
  }, [showNotice]);
};
