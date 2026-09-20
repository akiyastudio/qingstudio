import { LocalizedText } from "../../i18n/LocalizedText";
import { useLocale } from "../../i18n/react";
import { t } from "../../i18n/runtime";
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
  import: { get description() { return t("ui.analyze.sd.card.media.and.import.fab2c4"); }, icon: <MemoryStick size={18}/> },
  'negative-import': { get description() { return t("ui.import.files.or.folders.and.register.4d2f65"); }, icon: <Aperture size={18}/> },
  broll: { get description() { return t("ui.batch.import.behind.the.scenes.images.3fc252"); }, icon: <FolderInput size={18}/> },
  'file-import': { get description() { return t("ui.opened.from.the.current.folder.or.688211"); }, icon: <FileInput size={18}/> },
  match: { get description() { return t("ui.check.full.file.names.before.copying.84181d"); }, icon: <FileText size={18}/> },
  research: { get description() { return t("ui.detect.scene.transitions.and.choose.clear.bd6c70"); }, icon: <Video size={18}/> },
  'video-transcode': { get description() { return t("ui.convert.video.containers.codecs.quality.and.b8761f"); }, icon: <Gauge size={18}/> },
  'video-split': { get description() { return t("ui.split.videos.losslessly.into.consecutive.segments.25565c"); }, icon: <Cut size={18}/> },
  converter: { get description() { return t("ui.batch.convert.common.image.formats.to.eea4ce"); }, icon: <ImageIcon size={18}/> },
  'screenshot-main-image': { get description() { return t("ui.analyze.candidate.areas.then.generate.main.0cd512"); }, icon: <Crop size={18}/> },
  'office-extract': { get description() { return t("ui.extract.images.from.word.powerpoint.or.8d7dbf"); }, icon: <FileImage size={18}/> },
  trash: { get description() { return t("ui.move.the.entire.project.and.its.fa0f74"); }, icon: <Trash2 size={18}/> },
  'version-create': { get description() { return t("ui.create.tracked.image.or.video.version.5104df"); }, icon: <FolderPlus size={18}/> },
  'version-create-next': { get description() { return t("ui.create.the.next.version.or.a.3235e7"); }, icon: <ArrowRight size={18}/> },
  'version-import': { get description() { return t("ui.register.an.existing.project.folder.as.31b3b8"); }, icon: <FolderInput size={18}/> },
  'version-modify': { get description() { return t("ui.edit.version.information.and.tracking.policy.351728"); }, icon: <GitBranch size={18}/> },
  'folder-mark': { get description() { return t("ui.mark.a.folder.as.original.media.77fdfa"); }, icon: <GitBranch size={18}/> },
};

export const ToolModal = ({ title, ownerPageId, panelKind, open, busy = false, useBackgroundTaskBusyFallback = true, onClose, children }: { title: string; ownerPageId: string; panelKind: string; open: boolean; busy?: boolean; useBackgroundTaskBusyFallback?: boolean; onClose: () => void; children: React.ReactNode }) => {
  useLocale();
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
  return createPortal(<div ref={backdropRef} aria-hidden={!open} className={open ? 'tool-panel-backdrop fixed inset-x-0 bottom-0 top-10 z-[360] flex cursor-default items-center justify-center p-4' : 'hidden'}><PanelTaskScope ownerPageId={ownerPageId} panelKind={panelKind} title={title}><section ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} className="tool-panel-window flex max-h-[90vh] w-full max-w-[960px] flex-col overflow-hidden border bg-white"><header className="tool-panel-header flex shrink-0 items-center gap-3 border-b border-slate-200 px-5"><span className="tool-panel-title-icon flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-blue-50 text-blue-600">{detail?.icon}</span><div className="min-w-0 flex-1"><h3 className="truncate text-[15px] font-bold text-slate-800">{title}</h3>{detail?.description && <p className="mt-0.5 truncate text-[10px] text-slate-400">{detail.description}</p>}</div><button type="button" onClick={onClose} aria-label={effectiveBusy ? t("ui.minimize.to.background.a466fe") : t("common.close")} title={effectiveBusy ? t("ui.minimize.to.background.the.task.keeps.8f7ffd") : t("common.close")} className={`rounded-md text-slate-500 hover:bg-slate-100 ${effectiveBusy ? 'inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-bold' : 'p-1.5'}`}>{effectiveBusy ? <><Minimize2 size={15}/>{t("ui.minimize.to.background.a466fe")}</> : <X size={18}/>}</button></header><div className="tool-panel-body min-h-0 flex-1 overflow-y-auto p-[22px]">{children}</div></section></PanelTaskScope></div>, document.body);
};

export const ImportCompletionNotice = ({ message, onClose }: { message: string; onClose: () => void }) => { useLocale(); return ((
  <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-emerald-200 bg-emerald-50/70 px-6 py-10 text-center">
    <CheckCircle2 size={42} className="text-emerald-600"/>
    <p className="mt-4 text-lg font-bold text-slate-800">{t("ui.import.complete.d613fe")}</p>
    <p className="mt-2 text-sm text-slate-600"><LocalizedText value={message}/></p>
    <button type="button" onClick={onClose} className="dialog-primary mt-6">{t("common.close")}</button>
  </div>
)); };
