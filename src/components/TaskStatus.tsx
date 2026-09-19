import React, { useCallback, useEffect, useRef } from 'react';
import type { LogEntry } from '../types';
import { ProgressBar } from './ProgressBar';
import { usePanelTaskReporter } from '../features/background-tasks/TaskCenter';
import { normalizeTaskProgress } from './useTaskPresentation';

interface TaskProgressProps {
  logs: LogEntry[];
  progress: number;
  isRunning: boolean;
  idleMessage?: string;
  statusMessage?: string;
  action?: React.ReactNode;
  reportToTaskCenter?: boolean;
}

type TaskCenterProgressReport = {
  state: 'idle' | 'running' | 'completed' | 'failed';
  progress: number;
  message: string;
  logs: LogEntry[];
};

const TASK_CENTER_REPORT_INTERVAL_MS = 250;

/** Shared execution area used by every tool, with an optional task-specific status title. */
export const TaskProgress: React.FC<TaskProgressProps> = ({
  logs,
  progress,
  isRunning,
  idleMessage = '进度',
  statusMessage,
  action,
  reportToTaskCenter = true,
}) => {
  const latest = logs[logs.length - 1];
  const percentage = normalizeTaskProgress(progress);
  const completed = !isRunning && percentage === 100 && latest?.type !== 'error';
  const message = statusMessage || latest?.message || (completed ? '处理完成' : idleMessage);
  const color = latest?.type === 'error' ? 'text-red-500' : latest?.type === 'success' || completed ? 'text-emerald-600' : latest?.type === 'warning' ? 'text-amber-600' : 'text-slate-800';
  const reporter = usePanelTaskReporter();
  const latestType = latest?.type;
  const reporterRef = useRef(reporter);
  const pendingReportRef = useRef<TaskCenterProgressReport | null>(null);
  const reportTimerRef = useRef<number | null>(null);
  const lastReportAtRef = useRef(0);
  const lastReportedStateRef = useRef<TaskCenterProgressReport['state'] | ''>('');
  reporterRef.current = reporter;

  const flushTaskCenterReport = useCallback(() => {
    if (reportTimerRef.current !== null) {
      window.clearTimeout(reportTimerRef.current);
      reportTimerRef.current = null;
    }
    const nextReport = pendingReportRef.current;
    const nextReporter = reporterRef.current;
    pendingReportRef.current = null;
    if (!nextReport || !nextReporter) return;
    lastReportAtRef.current = Date.now();
    lastReportedStateRef.current = nextReport.state;
    nextReporter(nextReport);
  }, []);

  useEffect(() => {
    if (!reporter || !reportToTaskCenter) {
      pendingReportRef.current = null;
      if (reportTimerRef.current !== null) {
        window.clearTimeout(reportTimerRef.current);
        reportTimerRef.current = null;
      }
      return;
    }
    const state: TaskCenterProgressReport['state'] = isRunning ? 'running' : latestType === 'error' ? 'failed' : completed ? 'completed' : 'idle';
    pendingReportRef.current = {
      state,
      progress: percentage,
      message,
      logs,
    };

    const elapsed = Date.now() - lastReportAtRef.current;
    if (state !== lastReportedStateRef.current || elapsed >= TASK_CENTER_REPORT_INTERVAL_MS) {
      flushTaskCenterReport();
      return;
    }
    if (reportTimerRef.current === null) {
      reportTimerRef.current = window.setTimeout(flushTaskCenterReport, TASK_CENTER_REPORT_INTERVAL_MS - elapsed);
    }
  }, [completed, flushTaskCenterReport, isRunning, latestType, logs, message, percentage, reporter, reportToTaskCenter]);

  useEffect(() => () => {
    if (reportTimerRef.current !== null) window.clearTimeout(reportTimerRef.current);
  }, []);

  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50 p-4" aria-live="polite" aria-busy={isRunning}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center justify-between gap-4 text-sm">
            <p className={`min-w-0 truncate font-medium ${color}`} title={message} role="status">{message}</p>
            <span className="shrink-0 font-mono text-blue-600">{percentage.toFixed(Number.isInteger(percentage) ? 0 : 1)}%</span>
          </div>
          <ProgressBar value={percentage} trackClassName="h-2 overflow-hidden rounded-full bg-slate-200" barClassName="h-full rounded-full bg-blue-500 transition-all duration-300"/>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </section>
  );
};
