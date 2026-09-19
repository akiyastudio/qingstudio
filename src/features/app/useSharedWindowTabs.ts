import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { WorkspaceWindowContext, WorkspaceWindowSeed, NativeWorkspaceTab } from '../../contracts/workspace-windows';
import { setLocalWorkspaceTabOpener } from '../../platform/workspace-window-client';
import { capturePageTransferState, installPageTransferState, releasePageTransferState, rollbackPageTransfer } from '../../platform/page-transfer-state';
import { flushApplicationBeforeQuit } from './application-quit-client';
import { preloadPageKind } from './lazyPage';

export type SharedWindowTab = {
  id: string; label: string; kind: WorkspaceWindowSeed['kind']; iconUrl?: string; active: boolean; pinned?: boolean; pageId?: string;
  seed: () => WorkspaceWindowSeed | Promise<WorkspaceWindowSeed>;
  activate: () => unknown; close: () => unknown; release: () => unknown;
  prepare?: () => unknown;
};
export const useSharedWindowTabs = ({ context, entries, open, onError, sidebarCollapsed, runningPageIds }: {
  context: WorkspaceWindowContext | null; entries: SharedWindowTab[];
  open: (seed: WorkspaceWindowSeed, reuse: boolean) => string | Promise<string>;
  onError: (message: string) => void; sidebarCollapsed: boolean; runningPageIds: Set<string>;
}) => {
  const [order, setOrder] = useState<string[]>([]);
  const [transferring, setTransferring] = useState('');
  const hadTabs = useRef(false);
  const current = useRef({ entries, open, onError, sidebarCollapsed, runningPageIds });
  current.current = { entries, open, onError, sidebarCollapsed, runningPageIds };
  const sorted = [...entries].sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
    || (order.includes(left.id) ? order.indexOf(left.id) : order.length + entries.indexOf(left)) - (order.includes(right.id) ? order.indexOf(right.id) : order.length + entries.indexOf(right)));
  const tabs: NativeWorkspaceTab[] = sorted.map(tab => ({ id: tab.id, label: tab.label, kind: tab.kind, iconUrl: tab.iconUrl, active: tab.active, pinned: Boolean(tab.pinned), ready: true }));
  const signature = JSON.stringify(tabs);
  const find = (id?: string) => {
    const entry = current.current.entries.find(entry => entry.id === id);
    if (!entry) throw new Error('标签页已关闭');
    return entry;
  };
  const closeEntry = async (entry: SharedWindowTab) => {
    if (entry.pageId && current.current.runningPageIds.has(entry.pageId)) throw new Error('此标签页正在完成操作，请等待完成后再关闭');
    if (context?.sharedTabs && !context.root && current.current.entries.length === 1) { window.electronAPI.closeWindow(); return; }
    await entry.close();
    setTimeout(() => releasePageTransferState(entry.pageId || entry.id), 0);
  };
  const reorder = (id: string, index: number) => {
    setOrder(previous => {
      const visible = current.current.entries.map(entry => entry.id);
      const next = [...previous.filter(item => visible.includes(item)), ...visible.filter(item => !previous.includes(item))].filter(item => item !== id);
      next.splice(Math.max(0, Math.min(index, next.length)), 0, id); return next;
    });
  };
  useLayoutEffect(() => {
    if (!context?.sharedTabs) return;
    setLocalWorkspaceTabOpener((seed, reuse) => current.current.open(seed, reuse));
    const api = window.electronAPI.workspaceWindows!;
    const unsubscribe = api.onTabRequest(request => {
      void (async () => {
        if (request.action === 'open' || request.action === 'import') {
          if (!request.seed) throw new Error('缺少标签页内容');
          if (request.action === 'import' && ['settings', 'search-all'].includes(request.seed.kind) && current.current.entries.some(entry => entry.id === request.seed!.kind)) throw new Error('目标窗口已有此页面，请先关闭其中一个');
          await preloadPageKind(request.seed.kind);
          installPageTransferState(request.seed.transfer?.state);
          let opening: string | Promise<string> = '';
          flushSync(() => { opening = current.current.open(request.seed!, request.action === 'open'); });
          const id = await opening;
          // Commit the imported tab before acknowledging; release happens only
          // after the destination has a usable React tree.
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          return id;
        }
        const entry = find(request.id);
        if (request.action === 'activate') return entry.activate();
        if (request.action === 'close') return closeEntry(entry);
        if (request.action === 'reorder') return reorder(entry.id, request.index || 0);
        if (request.action === 'export') {
          if (entry.pinned) throw new Error('主页不能移出主窗口');
          if (entry.pageId && current.current.runningPageIds.has(entry.pageId)) throw new Error('此标签页正在完成操作，请等待完成后再移动');
          flushSync(() => setTransferring(entry.id));
          await flushApplicationBeforeQuit();
          const seed = await entry.seed();
          const state = capturePageTransferState([entry.pageId || entry.id]);
          await entry.prepare?.();
          return { ...seed, transfer: { ...seed.transfer, state, sidebarCollapsed: current.current.sidebarCollapsed } };
        }
        if (request.action === 'release') {
          flushSync(() => { void entry.release(); setTransferring(''); });
          releasePageTransferState(entry.pageId || entry.id);
          return true;
        }
        rollbackPageTransfer([entry.pageId || entry.id]);
        setTransferring(''); entry.activate(); return true;
      })().then(result => api.respondTabRequest(request.token, result)).catch(error => {
        setTransferring('');
        void api.respondTabRequest(request.token, undefined, String(error.message || error));
      });
    });
    return () => { setLocalWorkspaceTabOpener(null); unsubscribe(); };
  }, [context?.sharedTabs]);
  useLayoutEffect(() => {
    if (!context?.sharedTabs) return;
    void window.electronAPI.workspaceWindows!.publishTabs(JSON.parse(signature)).catch(error => current.current.onError(String(error.message || error)));
    if (current.current.entries.length) hadTabs.current = true;
    else if (hadTabs.current && !context.root && !transferring) window.electronAPI.closeWindow();
  }, [signature, context?.sharedTabs, context?.root, transferring]);
  const actions = {
    activate: async (id: string) => { if (!transferring) await find(id).activate(); },
    close: async (id: string) => { if (!transferring) await closeEntry(find(id)); },
    reorder: async (id: string, index: number) => { if (!transferring) reorder(id, index); },
  };
  return { context: context?.sharedTabs ? { ...context, tabs } : context, actions, transferring };
};
