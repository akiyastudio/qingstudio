import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Aperture,
  ArrowRight,
  CheckCircle2,
  Crop,
  FileImage,
  FileInput,
  FileText,
  FolderInput,
  FolderPlus,
  Gauge,
  GitBranch,
  Image as ImageIcon,
  MemoryStick,
  Minimize2,
  Scissors as Cut,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import { useEscapeLayer } from '../../components/LayerProvider';
import { PanelTaskScope, useTaskCenter } from '../background-tasks/TaskCenter';
import { isActivePresentedBackgroundTaskForPanel, panelTaskSessionKey } from '../background-tasks/panel-task-session-model';

const TOOL_MODAL_DETAILS: Record<string, { description: string; icon: React.ReactNode }> = {
  import: { description: '分析 SD 卡素材并导入当前项目。', icon: <MemoryStick size={18}/> },
  'negative-import': { description: '从文件或文件夹导入并登记原始素材。', icon: <Aperture size={18}/> },
  broll: { description: '批量导入图片与视频花絮。', icon: <FolderInput size={18}/> },
  'file-import': { description: '从当前文件夹或右键菜单进入，目标目录已确定。', icon: <FileInput size={18}/> },
  match: { description: '按完整文件名预检，确认后再复制。', icon: <FileText size={18}/> },
  research: { description: '识别视频转场并挑选清晰画面。', icon: <Video size={18}/> },
  'video-transcode': { description: '转换视频封装、编码、画质与音频。', icon: <Gauge size={18}/> },
  'video-split': { description: '批量将视频无损切成约 3.95 GB 的连续分段。', icon: <Cut size={18}/> },
  converter: { description: '批量将常见图片格式转换为 JPG。', icon: <ImageIcon size={18}/> },
  'screenshot-main-image': { description: '先分析候选范围，确认后再生成主图。', icon: <Crop size={18}/> },
  'office-extract': { description: '提取 Word、PowerPoint 或 Excel 中的图片。', icon: <FileImage size={18}/> },
  trash: { description: '将整个项目及其内容移入系统回收站。', icon: <Trash2 size={18}/> },
  'version-create': { description: '创建可跟踪的图片或视频版本节点。', icon: <FolderPlus size={18}/> },
  'version-create-next': { description: '从当前版本创建下一版本或可跟踪分支。', icon: <ArrowRight size={18}/> },
  'version-import': { description: '将已有项目文件夹登记为可跟踪版本。', icon: <FolderInput size={18}/> },
  'version-modify': { description: '修改版本信息与跟踪策略。', icon: <GitBranch size={18}/> },
  'folder-mark': { description: '将文件夹标记为原始素材、进度或花絮。', icon: <GitBranch size={18}/> },
};

export const ToolModal = ({ title, ownerPageId, panelKind, open, busy = false, useBackgroundTaskBusyFallback = true, onClose, children }: { title: string; ownerPageId: string; panelKind: string; open: boolean; busy?: boolean; useBackgroundTaskBusyFallback?: boolean; onClose: () => void; children: React.ReactNode }) => {
  const { backgroundTasks, panelTasks, reportPanelTask, dismissPanelTask } = useTaskCenter();
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const taskKey = panelTaskSessionKey(ownerPageId, panelKind);
  const task = panelTasks[taskKey];
  const manualBusyRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const backgroundTaskActive = backgroundTasks.some(candidate => isActivePresentedBackgroundTaskForPanel(candidate, ownerPageId, panelKind));
  const effectiveBusy = busy || task?.state === 'running' || useBackgroundTaskBusyFallback && backgroundTaskActive;
  useEscapeLayer(open, onClose, true, true);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const selector = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';
    const focusables = () => Array.from(dialog?.querySelectorAll<HTMLElement>(selector) || []).filter(node => !node.hidden);
    focusables()[0]?.focus();
    const trapKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); onCloseRef.current(); return; }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) { event.preventDefault(); dialog?.focus(); return; }
      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? currentIndex <= 0 ? items.length - 1 : currentIndex - 1
        : currentIndex < 0 || currentIndex === items.length - 1 ? 0 : currentIndex + 1;
      event.preventDefault();
      items[nextIndex].focus();
    };
    window.addEventListener('keydown', trapKeyboard, true);
    return () => { window.removeEventListener('keydown', trapKeyboard, true); previouslyFocused?.focus(); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const interceptOutsidePointer = (event: PointerEvent) => {
      const backdrop = backdropRef.current;
      const dialog = dialogRef.current;
      if (!backdrop || !dialog) return;
      const bounds = backdrop.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
      const path = event.composedPath();
      if (path.includes(dialog)) return;
      const target = event.target instanceof Element ? event.target : null;
      const higherDialog = target?.closest('[role="dialog"]');
      if (higherDialog && higherDialog !== dialog) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!effectiveBusy) onCloseRef.current();
    };
    window.addEventListener('pointerdown', interceptOutsidePointer, true);
    return () => window.removeEventListener('pointerdown', interceptOutsidePointer, true);
  }, [effectiveBusy, open]);

  const reportBusyAsPanelTask = !panelKind.startsWith('version-');
  useEffect(() => {
    if (busy && reportBusyAsPanelTask) {
      manualBusyRef.current = true;
      if (task?.state !== 'running') reportPanelTask({ key: taskKey, ownerPageId, panelKind, title }, { state: 'running', progress: task?.progress || 0, message: task?.message || '任务正在运行…', logs: task?.logs || [] });
    } else if (manualBusyRef.current) {
      manualBusyRef.current = false;
      dismissPanelTask(taskKey);
    }
  }, [busy, dismissPanelTask, ownerPageId, panelKind, reportBusyAsPanelTask, reportPanelTask, task, taskKey, title]);

  const detail = TOOL_MODAL_DETAILS[panelKind];
  return createPortal(<div ref={backdropRef} aria-hidden={!open} className={open ? 'tool-panel-backdrop fixed inset-x-0 bottom-0 top-10 z-[360] flex cursor-default items-center justify-center p-4' : 'hidden'}><PanelTaskScope ownerPageId={ownerPageId} panelKind={panelKind} title={title}><section ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} className="tool-panel-window flex max-h-[90vh] w-full max-w-[960px] flex-col overflow-hidden border bg-white"><header className="tool-panel-header flex shrink-0 items-center gap-3 border-b border-slate-200 px-5"><span className="tool-panel-title-icon flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-blue-50 text-blue-600">{detail?.icon}</span><div className="min-w-0 flex-1"><h3 className="truncate text-[15px] font-bold text-slate-800">{title}</h3>{detail?.description && <p className="mt-0.5 truncate text-[10px] text-slate-400">{detail.description}</p>}</div><button type="button" onClick={onClose} aria-label={effectiveBusy ? '收起到后台' : '关闭'} title={effectiveBusy ? '收起到后台，任务会继续运行' : '关闭'} className={`rounded-md text-slate-500 hover:bg-slate-100 ${effectiveBusy ? 'inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-bold' : 'p-1.5'}`}>{effectiveBusy ? <><Minimize2 size={15}/>收起到后台</> : <X size={18}/>}</button></header><div className="tool-panel-body min-h-0 flex-1 overflow-y-auto p-[22px]">{children}</div></section></PanelTaskScope></div>, document.body);
};

export const ImportCompletionNotice = ({ message, onClose }: { message: string; onClose: () => void }) => (
  <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-emerald-200 bg-emerald-50/70 px-6 py-10 text-center">
    <CheckCircle2 size={42} className="text-emerald-600"/>
    <p className="mt-4 text-lg font-bold text-slate-800">导入完成</p>
    <p className="mt-2 text-sm text-slate-600">{message}</p>
    <button type="button" onClick={onClose} className="dialog-primary mt-6">关闭</button>
  </div>
);
