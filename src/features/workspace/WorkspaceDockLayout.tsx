import { WORKSPACE_PANEL_LABELS } from "../../i18n/built-in-labels";
import { useLocale } from "../../i18n/react";
import { t } from "../../i18n/runtime";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { useEscapeLayer } from '../../components/LayerProvider';
import { ColumnResizeHandle } from '../app/AppShellLayout';
import { movePanelBefore, panelDropBefore, PANEL_LAYOUT_CHANGED_EVENT, type WorkspacePanelId } from './workspace-panel-model';

type DockDrag = { source: WorkspacePanelId; line: number; valid: boolean };
export const WorkspaceDockLayout = ({ containerRef, order, visible, onReorder, onResize, children, labels: customLabels = {} }: {
  labels?: Partial<Record<WorkspacePanelId, string>>;
  containerRef: RefObject<HTMLDivElement>;
  order: readonly WorkspacePanelId[];
  visible: readonly WorkspacePanelId[];
  onReorder: (order: WorkspacePanelId[]) => void;
  onResize: (left: WorkspacePanelId, right: WorkspacePanelId, delta: number) => void;
  children: ReactNode;
}) => {
  useLocale();
  const labels = { ...WORKSPACE_PANEL_LABELS, ...customLabels };
  const [drag, setDrag] = useState<DockDrag | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const cleanupRef = useRef<() => void>(() => undefined);
  const orderKey = order.join(':');
  const visibleKey = visible.join(':');
  useEscapeLayer(Boolean(drag), () => cleanupRef.current(), true, Boolean(drag));
  useEffect(() => () => cleanupRef.current(), [orderKey, visibleKey]);
  useLayoutEffect(() => {
    // A move can change position without changing size, so ResizeObserver alone
    // cannot update the native video surface or the file status badge.
    window.dispatchEvent(new Event(PANEL_LAYOUT_CHANGED_EVENT));
  }, [orderKey, visibleKey]);

  const onPointerDownCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const target = event.target as HTMLElement;
    const handle = target.closest<HTMLElement>('[data-panel-drag-handle]');
    const source = handle?.dataset.panelDragHandle as WorkspacePanelId | undefined;
    const interactive = target.closest('button, a, input, select, textarea, [contenteditable="true"], [role="separator"]');
    if (!source || !visible.includes(source) || interactive) return;
    const container = containerRef.current;
    if (!container || !handle || !container.contains(handle)) return;
    event.preventDefault();
    event.stopPropagation();
    cleanupRef.current();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let started = false;
    let before: WorkspacePanelId | null = source;
    let valid = false;
    const cursor = document.body.style.cursor;
    const userSelect = document.body.style.userSelect;
    const update = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      if (!started && Math.hypot(move.clientX - startX, move.clientY - startY) < 5) return;
      started = true;
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
      const bounds = container.getBoundingClientRect();
      valid = move.clientX >= bounds.left && move.clientX <= bounds.right && move.clientY >= bounds.top && move.clientY <= bounds.bottom;
      const rects = visible.map(id => {
        const rect = container.querySelector<HTMLElement>(`[data-workspace-panel="${id}"]`)?.getBoundingClientRect();
        return { id, left: rect?.left ?? bounds.left, right: rect?.right ?? bounds.left };
      });
      before = panelDropBefore(rects, source, move.clientX);
      const line = before ? rects.find(rect => rect.id === before)!.left : rects.at(-1)?.right ?? bounds.right;
      setDrag({ source, valid, line: Math.max(2, Math.min(bounds.width - 2, line - bounds.left)) });
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', update);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cleanup);
      container.removeEventListener('lostpointercapture', cancel);
      cleanupRef.current = () => undefined;
      if (container.hasPointerCapture(pointerId)) container.releasePointerCapture(pointerId);
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
      setDrag(null);
    };
    const finish = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      update(up);
      const commit = started && valid;
      cleanup();
      if (commit) {
        onReorder(movePanelBefore(order, source, before));
        setAnnouncement(`${labels[source]}面板位置已调整`);
      }
    };
    const cancel = (cancelled: PointerEvent) => { if (cancelled.pointerId === pointerId) cleanup(); };
    container.setPointerCapture(pointerId);
    window.addEventListener('pointermove', update);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cleanup);
    container.addEventListener('lostpointercapture', cancel);
    cleanupRef.current = cleanup;
  };

  return <div ref={containerRef} className="workspace-dock-layout relative flex min-h-0 min-w-0 flex-1 overflow-hidden" onPointerDownCapture={onPointerDownCapture} onKeyDownCapture={event => {
    const target = event.target as HTMLElement;
    const source = target.dataset.panelDragHandle as WorkspacePanelId | undefined;
    if (!source || !event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const index = visible.indexOf(source);
    const next = index + (event.key === 'ArrowLeft' ? -1 : 1);
    if (next < 0 || next >= visible.length) return;
    onReorder(movePanelBefore(order, source, event.key === 'ArrowLeft' ? visible[next] : visible[next + 1] ?? null));
    setAnnouncement(`${labels[source]}面板位置已调整`);
  }}>
    {children}
    {visible.slice(1).map((right, index) => <div key={right} className="workspace-panel-boundary" style={{ order: order.indexOf(right) * 2 - 1 }}><ColumnResizeHandle label={t("ui.resize.value0.and.value1.66d7ae", { value0: labels[visible[index]], value1: labels[right] })} onDrag={delta => onResize(visible[index], right, delta)}/></div>)}
    {!visible.length && <div className="m-auto p-6 text-center text-sm text-slate-400">{t("ui.panel.hidden.show.it.again.using.6bcc58")}</div>}
    {drag && <div className="workspace-panel-drag-overlay" aria-hidden="true"><span className="workspace-panel-drag-label">{t("message.72b4d5f20eea", { value0: labels[drag.source] })}</span>{drag.valid && <span className="workspace-panel-drop-line" style={{ left: drag.line }}/>}</div>}
    <span role="status" aria-live="polite" className="sr-only">{announcement}</span>
  </div>;
};
