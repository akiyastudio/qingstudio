import { useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

export type CropRectangle = { x: number; y: number; width: number; height: number };
type CropHandle = 'move' | 'nw' | 'ne' | 'sw' | 'se';
type CropArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

const normalizeCropRectangle = (value: CropRectangle, imageSize: { width: number; height: number }, minimumSize = 1): CropRectangle => {
  const imageWidth = Math.max(0, imageSize.width);
  const imageHeight = Math.max(0, imageSize.height);
  const minimumWidth = Math.min(imageWidth, Math.max(0, minimumSize));
  const minimumHeight = Math.min(imageHeight, Math.max(0, minimumSize));
  const width = Math.max(minimumWidth, Math.min(imageWidth, value.width));
  const height = Math.max(minimumHeight, Math.min(imageHeight, value.height));
  const x = Math.max(0, Math.min(imageWidth - width, value.x));
  const y = Math.max(0, Math.min(imageHeight - height, value.y));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
};

const isCropArrowKey = (key: string): key is CropArrowKey => key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown';

const adjustCropRectangleFromKeyboard = ({ crop, imageSize, minimumSize, handle, key, accelerated = false }: {
  crop: CropRectangle;
  imageSize: { width: number; height: number };
  minimumSize: number;
  handle: CropHandle;
  key: CropArrowKey;
  accelerated?: boolean;
}): CropRectangle => {
  const imageWidth = Math.max(0, imageSize.width);
  const imageHeight = Math.max(0, imageSize.height);
  const current = normalizeCropRectangle(crop, { width: imageWidth, height: imageHeight }, minimumSize);
  const acceleratedStep = Math.max(10, Math.round(Math.min(imageWidth, imageHeight) * .01));
  const step = accelerated ? acceleratedStep : 1;
  const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
  const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
  if (handle === 'move') return normalizeCropRectangle({ ...current, x: current.x + dx, y: current.y + dy }, { width: imageWidth, height: imageHeight }, minimumSize);

  const minimumWidth = Math.min(imageWidth, Math.max(0, minimumSize));
  const minimumHeight = Math.min(imageHeight, Math.max(0, minimumSize));
  let left = current.x;
  let top = current.y;
  let right = current.x + current.width;
  let bottom = current.y + current.height;
  if (dx && handle.includes('w')) left = Math.max(0, Math.min(right - minimumWidth, left + dx));
  if (dx && handle.includes('e')) right = Math.min(imageWidth, Math.max(left + minimumWidth, right + dx));
  if (dy && handle.includes('n')) top = Math.max(0, Math.min(bottom - minimumHeight, top + dy));
  if (dy && handle.includes('s')) bottom = Math.min(imageHeight, Math.max(top + minimumHeight, bottom + dy));
  return normalizeCropRectangle({ x: left, y: top, width: right - left, height: bottom - top }, { width: imageWidth, height: imageHeight }, minimumSize);
};

const InteractiveCropEditor = ({ previewUrl, imageSize, crop, onChange, large = false, embedded = false, snapGuides = { x: [], y: [] }, snapEnabled = false }: { previewUrl: string; imageSize: { width: number; height: number }; crop: CropRectangle; onChange: (crop: CropRectangle) => void; large?: boolean; embedded?: boolean; snapGuides?: { x: number[]; y: number[] }; snapEnabled?: boolean }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ pointerId: number; handle: CropHandle; x: number; y: number; crop: CropRectangle } | null>(null);
  const cropDescriptionId = useId();
  const minimumSize = Math.max(40, Math.round(Math.min(imageSize.width, imageSize.height) * .025));
  const handleSize = Math.max(40, Math.min(imageSize.width, imageSize.height) / 28);
  const snapDistance = Math.max(8, Math.round(Math.min(imageSize.width, imageSize.height) * .018));
  const [activeGuides, setActiveGuides] = useState<{ x?: number; y?: number }>({});
  const [focusedHandle, setFocusedHandle] = useState<CropHandle | null>(null);
  const nearestGuide = (value: number, guides: number[]) => {
    let best: { value: number; distance: number } | undefined;
    for (const guide of guides) {
      const distance = Math.abs(value - guide);
      if (distance <= snapDistance && (!best || distance < best.distance)) best = { value: guide, distance };
    }
    return best;
  };
  const imagePoint = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return { x: 0, y: 0 };
    const point = svg.createSVGPoint(); point.x = clientX; point.y = clientY;
    const transformed = point.matrixTransform(matrix.inverse());
    return { x: transformed.x, y: transformed.y };
  };
  const beginDrag = (event: ReactPointerEvent<SVGElement>, handle: CropHandle) => {
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.focus();
    const point = imagePoint(event.clientX, event.clientY);
    svgRef.current?.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, handle, x: point.x, y: point.y, crop: { ...crop } };
  };
  const moveDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = imagePoint(event.clientX, event.clientY);
    const dx = point.x - drag.x; const dy = point.y - drag.y;
    if (drag.handle === 'move') {
      let x = Math.max(0, Math.min(imageSize.width - drag.crop.width, drag.crop.x + dx));
      let y = Math.max(0, Math.min(imageSize.height - drag.crop.height, drag.crop.y + dy));
      const leftSnap = snapEnabled ? nearestGuide(x, snapGuides.x) : undefined;
      const rightSnap = snapEnabled ? nearestGuide(x + drag.crop.width, snapGuides.x) : undefined;
      const xSnap = !leftSnap ? rightSnap && { value: rightSnap.value - drag.crop.width, guide: rightSnap.value, distance: rightSnap.distance } : !rightSnap || leftSnap.distance <= rightSnap.distance ? { value: leftSnap.value, guide: leftSnap.value, distance: leftSnap.distance } : { value: rightSnap.value - drag.crop.width, guide: rightSnap.value, distance: rightSnap.distance };
      const topSnap = snapEnabled ? nearestGuide(y, snapGuides.y) : undefined;
      const bottomSnap = snapEnabled ? nearestGuide(y + drag.crop.height, snapGuides.y) : undefined;
      const ySnap = !topSnap ? bottomSnap && { value: bottomSnap.value - drag.crop.height, guide: bottomSnap.value, distance: bottomSnap.distance } : !bottomSnap || topSnap.distance <= bottomSnap.distance ? { value: topSnap.value, guide: topSnap.value, distance: topSnap.distance } : { value: bottomSnap.value - drag.crop.height, guide: bottomSnap.value, distance: bottomSnap.distance };
      if (xSnap) x = Math.max(0, Math.min(imageSize.width - drag.crop.width, xSnap.value));
      if (ySnap) y = Math.max(0, Math.min(imageSize.height - drag.crop.height, ySnap.value));
      setActiveGuides({ x: xSnap?.guide, y: ySnap?.guide });
      onChange(normalizeCropRectangle({ ...drag.crop, x, y }, imageSize, minimumSize));
      return;
    }
    let left = drag.crop.x; let top = drag.crop.y; let right = drag.crop.x + drag.crop.width; let bottom = drag.crop.y + drag.crop.height;
    if (drag.handle.includes('w')) left = Math.max(0, Math.min(right - minimumSize, drag.crop.x + dx));
    if (drag.handle.includes('e')) right = Math.min(imageSize.width, Math.max(left + minimumSize, drag.crop.x + drag.crop.width + dx));
    if (drag.handle.includes('n')) top = Math.max(0, Math.min(bottom - minimumSize, drag.crop.y + dy));
    if (drag.handle.includes('s')) bottom = Math.min(imageSize.height, Math.max(top + minimumSize, drag.crop.y + drag.crop.height + dy));
    const horizontalEdge = drag.handle.includes('w') ? left : right;
    const verticalEdge = drag.handle.includes('n') ? top : bottom;
    const xSnap = snapEnabled ? nearestGuide(horizontalEdge, snapGuides.x) : undefined;
    const ySnap = snapEnabled ? nearestGuide(verticalEdge, snapGuides.y) : undefined;
    if (xSnap) { if (drag.handle.includes('w')) left = Math.min(right - minimumSize, xSnap.value); else right = Math.max(left + minimumSize, xSnap.value); }
    if (ySnap) { if (drag.handle.includes('n')) top = Math.min(bottom - minimumSize, ySnap.value); else bottom = Math.max(top + minimumSize, ySnap.value); }
    setActiveGuides({ x: xSnap?.value, y: ySnap?.value });
    onChange(normalizeCropRectangle({ x: left, y: top, width: right - left, height: bottom - top }, imageSize, minimumSize));
  };
  const endDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setActiveGuides({});
  };
  const handleKeyboardAdjustment = (event: ReactKeyboardEvent<SVGElement>, handle: CropHandle) => {
    if (!isCropArrowKey(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    setActiveGuides({});
    onChange(adjustCropRectangleFromKeyboard({ crop, imageSize, minimumSize, handle, key: event.key, accelerated: event.shiftKey }));
  };
  const normalizedCrop = normalizeCropRectangle(crop, imageSize, minimumSize);
  const cropDescription = `当前裁剪矩形：左 ${normalizedCrop.x} 像素，上 ${normalizedCrop.y} 像素，宽 ${normalizedCrop.width} 像素，高 ${normalizedCrop.height} 像素。使用方向键细调 1 像素，按住 Shift 使用加速步长。`;
  const handleLabels: Record<CropHandle, string> = { move: '移动裁剪区域', nw: '调整裁剪区域左上角', ne: '调整裁剪区域右上角', sw: '调整裁剪区域左下角', se: '调整裁剪区域右下角' };
  const keyboardShortcuts = 'ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown';
  const corners: Array<{ handle: Exclude<CropHandle, 'move'>; x: number; y: number; cursor: string }> = [
    { handle: 'nw', x: crop.x, y: crop.y, cursor: 'nwse-resize' }, { handle: 'ne', x: crop.x + crop.width, y: crop.y, cursor: 'nesw-resize' },
    { handle: 'sw', x: crop.x, y: crop.y + crop.height, cursor: 'nesw-resize' }, { handle: 'se', x: crop.x + crop.width, y: crop.y + crop.height, cursor: 'nwse-resize' },
  ];
  return <div className={`flex justify-center overflow-hidden bg-slate-950 ${embedded ? 'h-full w-full' : `mt-4 rounded-xl ${large ? 'h-[68vh] max-h-[760px] min-h-[420px]' : 'max-h-80'}`}`}><svg ref={svgRef} aria-label="交互式裁剪编辑器" className={`${embedded || large ? 'h-full' : 'max-h-80'} w-full select-none touch-none`} viewBox={`0 0 ${imageSize.width} ${imageSize.height}`} preserveAspectRatio="xMidYMid meet" onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}>
    <desc id={cropDescriptionId}>{cropDescription}</desc>
    <image href={previewUrl} width={imageSize.width} height={imageSize.height} pointerEvents="none"/>
    {activeGuides.x !== undefined && <line x1={activeGuides.x} y1="0" x2={activeGuides.x} y2={imageSize.height} stroke="#22d3ee" strokeWidth={Math.max(2, imageSize.width / 1000)} strokeDasharray={`${Math.max(8, imageSize.width / 120)} ${Math.max(6, imageSize.width / 180)}`} pointerEvents="none"/>}
    {activeGuides.y !== undefined && <line x1="0" y1={activeGuides.y} x2={imageSize.width} y2={activeGuides.y} stroke="#22d3ee" strokeWidth={Math.max(2, imageSize.width / 1000)} strokeDasharray={`${Math.max(8, imageSize.width / 120)} ${Math.max(6, imageSize.width / 180)}`} pointerEvents="none"/>}
    <path d={`M0 0H${imageSize.width}V${imageSize.height}H0Z M${crop.x} ${crop.y}V${crop.y + crop.height}H${crop.x + crop.width}V${crop.y}Z`} fill="rgba(2,6,23,.55)" fillRule="evenodd" pointerEvents="none"/>
    <rect x={crop.x} y={crop.y} width={crop.width} height={crop.height} role="button" tabIndex={0} aria-label={handleLabels.move} aria-describedby={cropDescriptionId} aria-keyshortcuts={keyboardShortcuts} fill={focusedHandle === 'move' ? 'rgba(34,211,238,.18)' : 'rgba(37,99,235,.1)'} stroke={focusedHandle === 'move' ? '#22d3ee' : '#60a5fa'} strokeWidth={Math.max(focusedHandle === 'move' ? 5 : 3, imageSize.width / (focusedHandle === 'move' ? 600 : 800))} className="outline-none" style={{ cursor: 'move' }} onFocus={() => setFocusedHandle('move')} onBlur={() => setFocusedHandle(null)} onKeyDown={event => handleKeyboardAdjustment(event, 'move')} onPointerDown={event => beginDrag(event, 'move')}/>
    {corners.map(corner => <rect key={corner.handle} x={corner.x - handleSize / 2} y={corner.y - handleSize / 2} width={handleSize} height={handleSize} rx={handleSize * .16} role="button" tabIndex={0} aria-label={handleLabels[corner.handle]} aria-describedby={cropDescriptionId} aria-keyshortcuts={keyboardShortcuts} fill={focusedHandle === corner.handle ? '#cffafe' : '#fff'} stroke={focusedHandle === corner.handle ? '#22d3ee' : '#2563eb'} strokeWidth={Math.max(focusedHandle === corner.handle ? 5 : 3, imageSize.width / (focusedHandle === corner.handle ? 650 : 900))} className="outline-none" style={{ cursor: corner.cursor }} onFocus={() => setFocusedHandle(corner.handle)} onBlur={() => setFocusedHandle(null)} onKeyDown={event => handleKeyboardAdjustment(event, corner.handle)} onPointerDown={event => beginDrag(event, corner.handle)}/>)}
  </svg></div>;
};

export { InteractiveCropEditor };
