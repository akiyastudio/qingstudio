import React, { useEffect, useRef } from 'react';

export const ColumnResizeHandle = ({ onDrag, label, value, minimum, maximum, onReset }: { onDrag: (deltaX: number) => void; label: string; value?: number; minimum?: number; maximum?: number; onReset?: () => void }) => {
  const cleanupRef = useRef<() => void>();
  useEffect(() => () => cleanupRef.current?.(), []);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    cleanupRef.current?.();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
    let previousX = event.clientX;
    let cleaned = false;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const deltaX = moveEvent.clientX - previousX;
      previousX = moveEvent.clientX;
      onDrag(deltaX);
    };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', cleanup);
      handle.removeEventListener('lostpointercapture', lostCapture);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      if (cleanupRef.current === cleanup) cleanupRef.current = undefined;
    };
    const finish = (finishEvent: PointerEvent) => {
      if (finishEvent.pointerId !== pointerId) return;
      cleanup();
    };
    const lostCapture = (captureEvent: PointerEvent) => {
      if (captureEvent.pointerId !== pointerId) return;
      cleanup();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', cleanup);
    handle.addEventListener('lostpointercapture', lostCapture);
    cleanupRef.current = cleanup;
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    onDrag(event.key === 'ArrowLeft' ? -16 : 16);
  };
  return <div role="separator" aria-orientation="vertical" aria-label={label} aria-valuenow={value === undefined ? undefined : Math.round(value)} aria-valuemin={minimum} aria-valuemax={maximum} tabIndex={0} onPointerDown={onPointerDown} onDoubleClick={onReset} onKeyDown={onKeyDown} className="column-resize-handle"/>;
};
