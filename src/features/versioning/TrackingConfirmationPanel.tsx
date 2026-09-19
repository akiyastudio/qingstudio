import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Loader2, X } from 'lucide-react';
import type { AppConfig, ProgressFolder, ProgressTrackingItem } from '../../types';
import { ProgressPairPreview, type ProgressPairPreviewMode } from './ProgressPairPreview';
import { useHostSurfaceSuspension } from '../../components/LayerProvider';
import {
  adjacentTrackingPreviewItemId,
  applyTrackingItemDecision,
  canCommitTrackingSession,
  firstUnresolvedTrackingItemId,
  firstTrackingPreviewItemId,
  groupTrackingConfirmationItems,
  normalizeTrackingSessionNextCursor,
  resolveTrackingComparisonPaths,
  TRACKING_CONFIRMATION_PAGE_SIZE,
  type TrackingConfirmationViewState,
  unresolvedTrackingStatus,
} from './tracking-confirmation-model';

type TrackingConfirmationPanelProps = {
  active: boolean;
  sessionId: string;
  workspacePath: string;
  progressFolders: ProgressFolder[];
  cacheConfig: AppConfig['mediaCache'];
  onClose: () => void;
  onCommitted: () => void;
  onReleased: () => void;
  onNotice: (message: string, duration?: number) => void;
};

const statusLabel: Record<ProgressTrackingItem['status'], string> = {
  recognized: '已识别', pending_confirmation: '待确认', accepted: '已接受', missing_reference: '引用缺失', rejected: '已拒绝',
};
const categoryLabel = { recognized: '识别匹配', accepted: '已接受', pending: '待确认新素材', missing: '旧版缺失' } as const;
const TRACKING_PAGE_SIZE = TRACKING_CONFIRMATION_PAGE_SIZE;

export const TrackingConfirmationPanel = ({ active, sessionId, workspacePath, progressFolders, cacheConfig, onClose, onCommitted, onReleased, onNotice }: TrackingConfirmationPanelProps) => {
  useHostSurfaceSuspension(active);
  const [view, setView] = useState<TrackingConfirmationViewState>({ sessionId, items: [], minimized: false });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busyItemId, setBusyItemId] = useState('');
  const [committing, setCommitting] = useState(false);
  const [mode, setMode] = useState<ProgressPairPreviewMode>('side-by-side');
  const [swapped, setSwapped] = useState(false);
  const [relocateName, setRelocateName] = useState('');
  const [pageCursor, setPageCursor] = useState(0);
  const loadSequenceRef = useRef(0);
  const actionGenerationRef = useRef(0);
  const actionInFlightRef = useRef(false);

  const loadSession = useCallback(async () => {
    const sequence = ++loadSequenceRef.current;
    setLoading(true);
    setLoadError('');
    try {
      const result = await window.electronAPI.getProgressTrackingSession(workspacePath, { sessionId, cursor: pageCursor, limit: TRACKING_PAGE_SIZE });
      if (!result.success || !result.session) throw new Error(result.error || '无法读取版本匹配会话');
      if (result.session.id !== sessionId) throw new Error('版本匹配会话身份不一致');
      if (loadSequenceRef.current !== sequence) return;
      const items = result.items || [];
      setView({
        sessionId,
        session: result.session,
        items,
        selectedItemId: firstTrackingPreviewItemId(items),
        nextCursor: normalizeTrackingSessionNextCursor(result.nextCursor),
        minimized: false,
      });
    } catch (error) {
      if (loadSequenceRef.current === sequence) {
        const message = error instanceof Error ? error.message : String(error);
        setLoadError(message);
        onNotice(`读取版本匹配失败：${message}`);
      }
    } finally {
      if (loadSequenceRef.current === sequence) setLoading(false);
    }
  }, [sessionId, workspacePath, pageCursor, onNotice]);

  useLayoutEffect(() => {
    actionGenerationRef.current += 1;
    setPageCursor(0);
    setView({ sessionId, items: [], minimized: false });
    setBusyItemId('');
    setCommitting(false);
    setRelocateName('');
    setMode('side-by-side');
    setSwapped(false);
    actionInFlightRef.current = false;
    return () => { actionGenerationRef.current += 1; actionInFlightRef.current = false; };
  }, [sessionId, workspacePath]);
  useEffect(() => { void loadSession(); return () => { loadSequenceRef.current += 1; }; }, [loadSession]);

  const viewMatchesSession = view.sessionId === sessionId;
  const sessionActionsAvailable = viewMatchesSession && view.session?.id === sessionId;
  const selectedItem = sessionActionsAvailable ? view.items.find(item => item.id === view.selectedItemId) : undefined;
  const progressFolder = sessionActionsAvailable ? progressFolders.find(folder => folder.id === view.session?.progressId) : undefined;
  const parentFolder = sessionActionsAvailable ? progressFolders.find(folder => folder.id === view.session?.parentProgressId) : undefined;
  const paths = useMemo(() => resolveTrackingComparisonPaths(selectedItem, parentFolder?.folderPath || '', progressFolder?.folderPath || ''), [selectedItem, parentFolder?.folderPath, progressFolder?.folderPath]);
  const hasReferenceCandidate = Boolean(selectedItem?.referenceName && paths.referencePath && !paths.referenceMissing);
  const missingCurrentItem = selectedItem?.kind === 'missing';
  useEffect(() => { setRelocateName(selectedItem?.referenceName || ''); }, [selectedItem?.id, selectedItem?.referenceName]);

  const decide = async (status: 'accepted' | 'rejected', referenceName?: string) => {
    if (!sessionActionsAvailable || !selectedItem || actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    const itemId = selectedItem.id;
    const previousView = view;
    const generation = actionGenerationRef.current;
    setView(current => applyTrackingItemDecision(current, itemId, status, referenceName));
    setBusyItemId(itemId);
    const result = await window.electronAPI.decideProgressTrackingItem(workspacePath, { sessionId, itemId, status, ...(referenceName ? { referenceName } : {}) })
      .catch(error => ({ success: false, error: error instanceof Error ? error.message : String(error) }));
    if (generation !== actionGenerationRef.current) return;
    actionInFlightRef.current = false;
    setBusyItemId('');
    if (!result.success) { setView(previousView); onNotice(`保存决定失败：${result.error || '未知错误'}`); }
  };

  const commit = () => {
    if (!sessionActionsAvailable || actionInFlightRef.current || loadError || busyItemId || (view.session?.unresolvedCount ?? 1) > 0 || !canCommitTrackingSession(view.items)) return;
    actionInFlightRef.current = true;
    const generation = actionGenerationRef.current;
    setCommitting(true);
    // onClose(); intentionally deferred until the commit succeeds.
    void (async () => { try {
      const result = await window.electronAPI.commitProgressTracking(workspacePath, { sessionId })
        .catch(error => ({ success: false, taskNotificationOwned: false, error: error instanceof Error ? error.message : String(error) }));
      if (generation !== actionGenerationRef.current) return;
      if (!result.success) {
        if (!result.taskNotificationOwned) onNotice(`提交版本跟踪失败：${result.error || '未知错误'}`);
        return;
      }
      const released = await window.electronAPI.releaseProgressTrackingSession(workspacePath, { sessionId })
        .catch(error => ({ success: false, released: false, error: error instanceof Error ? error.message : String(error) }));
      if (generation !== actionGenerationRef.current) return;
      if (!released.success || !released.released) onNotice(`跟踪结果已提交，但会话释放失败：${released.error || '稍后将由维护任务清理'}`);
      onClose();
      onCommitted();
    } finally {
      if (generation === actionGenerationRef.current) {
        actionInFlightRef.current = false;
        setCommitting(false);
      }
    } })();
  };

  const release = async () => {
    if (!sessionActionsAvailable || actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    const generation = actionGenerationRef.current;
    setCommitting(true);
    const result = await window.electronAPI.releaseProgressTrackingSession(workspacePath, { sessionId })
      .catch(error => ({ success: false, released: false, error: error instanceof Error ? error.message : String(error) }));
    if (generation !== actionGenerationRef.current) return;
    actionInFlightRef.current = false;
    setCommitting(false);
    if (!result.success || !result.released) { onNotice(`取消会话失败：${result.error || '会话仍在使用中，请稍后重试'}`); return; }
    onReleased();
  };

  const unresolved = view.session?.unresolvedCount ?? view.items.filter(item => unresolvedTrackingStatus(item.status)).length;
  const total = view.session?.total ?? view.items.length;
  const pageEnd = Math.min(total, pageCursor + view.items.length);
  const groups = groupTrackingConfirmationItems(view.items);
  const commitUnavailable = !sessionActionsAvailable || loading || Boolean(loadError) || Boolean(busyItemId) || unresolved > 0 || !canCommitTrackingSession(view.items) || Boolean(view.session?.status === 'failed' && !view.items.length);
  const revealPending = () => {
    const itemId = firstUnresolvedTrackingItemId(view.items);
    if (!itemId) {
      if (view.nextCursor !== undefined) setPageCursor(view.nextCursor);
      else if (pageCursor > 0) setPageCursor(0);
      return;
    }
    setView(current => ({ ...current, selectedItemId: itemId }));
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-tracking-item-id="${CSS.escape(itemId)}"]`)?.scrollIntoView({ block: 'center' }));
  };
  return <div role="dialog" aria-modal="true" aria-label="确认版本匹配" className="fixed inset-0 z-[350] flex items-center justify-center bg-slate-950/55 p-4">
    <div className="tracking-confirmation-dialog">
      <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4"><div><h3 className="text-lg font-bold text-slate-800">确认版本匹配</h3><p className="mt-1 text-xs text-slate-500">{parentFolder?.displayName || '上一版本'} → {progressFolder?.displayName || '当前版本'} · {total} 项，{unresolved} 项待处理</p></div><button type="button" disabled={committing || Boolean(busyItemId)} onClick={onClose} title="稍后继续" className="rounded p-1.5 text-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"><X size={17}/></button></header>
      {view.session?.error && <p className="border-b border-red-200 bg-red-50 px-5 py-2 text-xs text-red-700">会话上次处理失败：{view.session.error}</p>}
      {loading ? <div className="flex flex-1 items-center justify-center gap-2 text-sm text-slate-500"><Loader2 size={20} className="animate-spin"/>正在加载匹配结果…</div> : loadError ? <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-red-600"><p>读取版本匹配失败：{loadError}</p><button type="button" onClick={() => void loadSession()} className="dialog-secondary">重新加载</button></div> : <div className="tracking-confirmation-layout">
        <aside className="tracking-confirmation-list flex flex-col"><div className="min-h-0 flex-1 overflow-y-auto">{groups.map(group => <section key={group.category}>{group.items.length > 0 && <h4 className="sticky top-0 z-10 flex justify-between border-y border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-bold text-slate-500"><span>{categoryLabel[group.category]}</span><span>{group.items.length}</span></h4>}{group.items.map(item => <button key={item.id} data-tracking-item-id={item.id} type="button" aria-pressed={item.id === view.selectedItemId} onClick={() => setView(current => ({ ...current, selectedItemId: item.id }))} className={`tracking-confirmation-row ${item.id === view.selectedItemId ? 'is-selected' : ''}`}><span className="min-w-0"><b className="block truncate" title={item.sourceName || item.targetName}>{item.sourceName || item.targetName || '未命名媒体'}</b><small className="mt-1 block truncate text-slate-400">{item.referenceName ? `上一版 · ${item.referenceName}` : '未关联上一版本'}</small></span><span className={`tracking-confirmation-status is-${item.status}`}>{statusLabel[item.status]}</span><small className="col-span-2 text-right text-slate-400">{item.confidence || '—'}</small></button>)}</section>)}</div><div className="flex items-center justify-between border-t border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-500"><button type="button" disabled={pageCursor === 0 || Boolean(busyItemId) || committing} onClick={() => setPageCursor(Math.max(0, pageCursor - TRACKING_PAGE_SIZE))} className="dialog-secondary !px-2 !py-1">上一页</button><span>{total ? `${pageCursor + 1}–${pageEnd} / ${total}` : '0 项'}</span><button type="button" disabled={view.nextCursor === undefined || Boolean(busyItemId) || committing} onClick={() => view.nextCursor !== undefined && setPageCursor(view.nextCursor)} className="dialog-secondary !px-2 !py-1">下一页</button></div></aside>
        <main className="tracking-confirmation-main">{selectedItem ? <><div className="mb-2 flex items-center justify-between gap-2 text-xs text-slate-500"><span className="truncate"><b className="text-slate-700">{selectedItem.sourceName || selectedItem.targetName}</b> · {statusLabel[selectedItem.status]} · {selectedItem.confidence || '无置信度'}</span><div className="flex shrink-0 gap-1"><button type="button" onClick={() => setView(current => ({ ...current, selectedItemId: adjacentTrackingPreviewItemId(current.items, current.selectedItemId, -1) }))} className="dialog-secondary !px-2 !py-1" title="上一项"><ArrowLeft size={14}/></button><button type="button" onClick={() => setView(current => ({ ...current, selectedItemId: adjacentTrackingPreviewItemId(current.items, current.selectedItemId, 1) }))} className="dialog-secondary !px-2 !py-1" title="下一项"><ArrowRight size={14}/></button></div></div><ProgressPairPreview referencePath={paths.referencePath} sourcePath={paths.sourcePath} referenceLabel={selectedItem.referenceName ? `上一版本 · ${selectedItem.referenceName}` : '上一版本'} sourceLabel={`当前版本 · ${selectedItem.sourceName || selectedItem.targetName || ''}`} referenceMissing={paths.referenceMissing} mode={mode} swapped={swapped} cacheConfig={cacheConfig} onModeChange={setMode} onSwappedChange={setSwapped}/><div className="tracking-confirmation-decisions">{unresolvedTrackingStatus(selectedItem.status) && !missingCurrentItem && <div className="flex min-w-[240px] flex-1 gap-2"><input value={relocateName} onChange={event => setRelocateName(event.target.value)} placeholder="输入上一版本中的文件名" className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-xs"/><button type="button" disabled={!sessionActionsAvailable || !relocateName.trim() || Boolean(busyItemId)} onClick={() => void decide('accepted', relocateName.trim())} className="dialog-secondary">匹配上一版本</button></div>}{unresolvedTrackingStatus(selectedItem.status) && <><button type="button" disabled={!sessionActionsAvailable || Boolean(busyItemId)} onClick={() => void decide('rejected')} className="dialog-secondary">{missingCurrentItem ? '确认当前版本已缺失' : hasReferenceCandidate ? '不是同一张' : '标记不关联'}</button>{!missingCurrentItem && hasReferenceCandidate && selectedItem.status === 'pending_confirmation' && <button type="button" disabled={!sessionActionsAvailable || Boolean(busyItemId)} onClick={() => void decide('accepted')} className="dialog-primary">确认同一张</button>}</>}</div></> : <div className="flex flex-1 items-center justify-center text-sm text-slate-400">没有需要确认的图片。</div>}</main>
      </div>}
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4"><button type="button" disabled={!sessionActionsAvailable || committing || Boolean(busyItemId)} onClick={() => void release()} className="text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-40">放弃本次确认</button><div className="flex gap-2"><button type="button" disabled={committing || Boolean(busyItemId)} onClick={onClose} className="dialog-secondary">稍后继续</button>{commitUnavailable ? <button type="button" disabled={!sessionActionsAvailable || committing || loading || Boolean(loadError) || unresolved === 0} onClick={revealPending} className="dialog-primary">{loadError ? '无法提交' : '有待确认图片'}</button> : <button type="button" disabled={!sessionActionsAvailable || committing} onClick={() => void commit()} className="dialog-primary inline-flex items-center gap-2">{committing && <Loader2 size={15} className="animate-spin"/>}提交结果</button>}</div></footer>
    </div>
  </div>;
};
