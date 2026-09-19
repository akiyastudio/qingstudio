import React from 'react';
import { StartupWindowFrame } from './AppChrome';

export class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: '' };

  static getDerivedStateFromError(error: Error) {
    return { error: error.message || '界面渲染失败' };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    window.electronAPI?.reportRendererError?.('React 界面渲染失败', `${error.stack || error.message}\n${info.componentStack}`);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <StartupWindowFrame><div className="flex h-screen w-full items-center justify-center bg-slate-50 p-6 text-slate-900"><div className="w-full max-w-lg rounded-2xl border border-red-200 bg-white p-6 shadow-xl"><h1 className="text-lg font-bold text-red-600">界面遇到错误</h1><p className="mt-2 break-words text-sm text-slate-600">{this.state.error}</p><p className="mt-2 text-xs text-slate-500">错误已记录。可重新载入界面，后台文件任务会继续运行。</p><button type="button" onClick={() => window.location.reload()} className="mt-5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-500">重新载入</button></div></div></StartupWindowFrame>;
  }
}
