import React, { useEffect, useRef, useState } from 'react';

export type ImageComparisonMode = 'side-by-side' | 'split' | 'overlay' | 'blink' | 'difference';

type ComparisonItem = {
  label: string;
  content: React.ReactNode;
  interactive?: boolean;
};

type ImageComparisonViewProps = {
  left: ComparisonItem;
  right: ComparisonItem;
  mode: ImageComparisonMode;
  onModeChange: (mode: ImageComparisonMode) => void;
  swapped?: boolean;
  onSwappedChange?: (swapped: boolean) => void;
  comparisonKey?: string;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  className?: string;
  stageClassName?: string;
  unavailable?: boolean;
};

const MODES: Array<[ImageComparisonMode, string]> = [
  ['side-by-side', '并排'],
  ['split', '滑动分割'],
  ['overlay', '透明叠加'],
  ['blink', '闪烁'],
  ['difference', '差异'],
];

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

export const ImageComparisonView = ({ left, right, mode, onModeChange, swapped = false, onSwappedChange, comparisonKey, leading, trailing, className = '', stageClassName = '', unavailable = false }: ImageComparisonViewProps) => {
  const [internalSwapped, setInternalSwapped] = useState(false);
  const [split, setSplit] = useState(50);
  const [opacity, setOpacity] = useState(50);
  const [blinkRight, setBlinkRight] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const panDragRef = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null);
  const splitDragRef = useRef<number | null>(null);
  const effectiveSwapped = onSwappedChange ? swapped : internalSwapped;
  const ordered = effectiveSwapped ? [right, left] : [left, right];

  const resetView = () => {
    setSplit(50);
    setOpacity(50);
    setZoom(1);
    setRotation(0);
    setPan({ x: 0, y: 0 });
    if (onSwappedChange) onSwappedChange(false);
    else setInternalSwapped(false);
  };

  useEffect(() => {
    resetView();
  }, [comparisonKey]);

  useEffect(() => {
    if (zoom === 1) setPan(current => current.x || current.y ? { x: 0, y: 0 } : current);
  }, [zoom]);

  useEffect(() => {
    setBlinkRight(false);
    if (mode !== 'blink' || unavailable) return;
    const timer = window.setInterval(() => setBlinkRight(current => !current), 700);
    return () => window.clearInterval(timer);
  }, [mode, unavailable, comparisonKey]);

  const updateSplit = (clientX: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    setSplit(clamp((clientX - rect.left) / rect.width * 100, 0, 100));
  };
  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`;
  const renderContent = (item: ComparisonItem) => <div className={`${item.interactive ? 'pointer-events-auto' : 'pointer-events-none'} absolute inset-0`} style={{ transform: unavailable ? 'none' : transform, transformOrigin: 'center', transition: panDragRef.current ? 'none' : 'transform 100ms ease-out' }}>{item.content}</div>;
  const renderLabel = (item: ComparisonItem, side: 'A' | 'B') => <span className="pointer-events-none absolute left-3 top-3 z-20 max-w-[calc(100%-1.5rem)] truncate rounded bg-black/70 px-2 py-1 text-xs text-white">{side} · {item.label}</span>;

  return <section className={`flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-950 text-white ${className}`}>
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2">
      {leading && <div className="mr-2 min-w-0">{leading}</div>}
      <div className="flex flex-wrap items-center gap-1">
        {MODES.map(([value, label]) => <button key={value} type="button" disabled={unavailable} onClick={() => onModeChange(value)} className={`rounded-md px-3 py-1.5 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-35 ${mode === value ? 'bg-blue-600 text-white' : 'bg-white/10 text-slate-300 hover:bg-white/15'}`}>{label}</button>)}
        <button type="button" disabled={unavailable} onClick={() => onSwappedChange ? onSwappedChange(!swapped) : setInternalSwapped(current => !current)} className="rounded-md bg-white/10 px-3 py-1.5 text-xs font-bold text-slate-300 hover:bg-white/15 disabled:opacity-35">交换 A/B</button>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <button type="button" disabled={unavailable} onClick={() => setRotation(current => (current + 90) % 360)} className="rounded-md bg-white/10 px-2.5 py-1.5 text-xs font-bold hover:bg-white/15 disabled:opacity-35">旋转 {rotation}°</button>
        <button type="button" disabled={unavailable} onClick={resetView} className="rounded-md bg-white/10 px-2.5 py-1.5 text-xs font-bold hover:bg-white/15 disabled:opacity-35">重置</button>
        <span className="text-xs text-slate-400">缩放</span>
        <input disabled={unavailable} aria-label="图片缩放" type="range" min="1" max="5" step="0.1" value={zoom} onChange={event => setZoom(Number(event.currentTarget.value))}/>
        <span className="w-10 text-right font-mono text-[11px] text-slate-400">{Math.round(zoom * 100)}%</span>
        {trailing}
      </div>
    </header>
    {mode === 'overlay' && !unavailable && <div className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-2 text-xs text-slate-300"><span>B 图透明度</span><input className="w-64" aria-label="B 图透明度" type="range" min="0" max="100" value={opacity} onChange={event => setOpacity(Number(event.currentTarget.value))}/><span className="font-mono">{opacity}%</span></div>}
    <div
      ref={stageRef}
      onWheel={event => { if (unavailable) return; event.preventDefault(); setZoom(current => clamp(Number((current * (event.deltaY < 0 ? 1.15 : 1 / 1.15)).toFixed(2)), 1, 5)); }}
      onDoubleClick={() => { if (!unavailable) resetView(); }}
      onPointerDown={event => { if (unavailable || event.button !== 0 || zoom <= 1) return; event.currentTarget.setPointerCapture(event.pointerId); panDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y }; }}
      onPointerMove={event => { const drag = panDragRef.current; if (drag?.pointerId === event.pointerId) setPan({ x: drag.panX + event.clientX - drag.startX, y: drag.panY + event.clientY - drag.startY }); }}
      onPointerUp={event => { if (panDragRef.current?.pointerId === event.pointerId) panDragRef.current = null; }}
      onPointerCancel={() => { panDragRef.current = null; splitDragRef.current = null; }}
      className={`relative min-h-[300px] flex-1 overflow-hidden bg-black ${zoom > 1 ? 'cursor-grab active:cursor-grabbing' : ''} ${stageClassName}`}
    >
      {mode === 'side-by-side' ? <div className="grid h-full grid-cols-2 gap-px bg-white/15">
        {ordered.map((item, index) => <div key={`${item.label}-${index}`} className="relative min-w-0 overflow-hidden bg-black">{renderContent(item)}{renderLabel(item, index ? 'B' : 'A')}</div>)}
      </div> : <>
        <div className="absolute inset-0 overflow-hidden bg-black">{renderContent(ordered[0])}{renderLabel(ordered[0], 'A')}</div>
        {mode === 'split' && !unavailable && <div className="absolute inset-0 overflow-hidden" style={{ clipPath: `inset(0 0 0 ${split}%)` }}>{renderContent(ordered[1])}{renderLabel(ordered[1], 'B')}</div>}
        {mode === 'overlay' && !unavailable && <><div className="absolute inset-0 overflow-hidden" style={{ opacity: opacity / 100 }}>{renderContent(ordered[1])}</div>{renderLabel(ordered[1], 'B')}</>}
        {mode === 'blink' && !unavailable && <div className="absolute inset-0 overflow-hidden transition-none" style={{ visibility: blinkRight ? 'visible' : 'hidden' }}>{renderContent(ordered[1])}{renderLabel(ordered[1], 'B')}</div>}
        {mode === 'difference' && !unavailable && <><div className="absolute inset-0 overflow-hidden mix-blend-difference">{renderContent(ordered[1])}</div>{renderLabel(ordered[1], 'B')}</>}
        {mode === 'split' && !unavailable && <button
          type="button"
          role="slider"
          aria-label="拖动图片分割线"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(split)}
          title="拖动分割线对比两张图片"
          onPointerDown={event => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); splitDragRef.current = event.pointerId; updateSplit(event.clientX); }}
          onPointerMove={event => { if (splitDragRef.current === event.pointerId) updateSplit(event.clientX); }}
          onPointerUp={event => { if (splitDragRef.current === event.pointerId) splitDragRef.current = null; }}
          onPointerCancel={() => { splitDragRef.current = null; }}
          onKeyDown={event => { if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return; event.preventDefault(); setSplit(current => clamp(current + (event.key === 'ArrowLeft' ? -2 : 2), 0, 100)); }}
          className="absolute bottom-0 top-0 z-30 w-7 -translate-x-1/2 cursor-col-resize touch-none bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          style={{ left: `${split}%` }}
        ><span className="absolute bottom-0 left-1/2 top-0 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_5px_rgba(0,0,0,.9)]"/><span className="absolute left-1/2 top-1/2 flex h-9 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-blue-600 shadow-lg"><span className="text-[10px] font-black tracking-[-2px] text-white">‹›</span></span></button>}
        {mode === 'blink' && !unavailable && <span className="pointer-events-none absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-full border border-white/20 bg-black/75 px-3 py-1 text-xs font-bold text-white shadow-lg"><span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${blinkRight ? 'bg-blue-400' : 'bg-amber-400'}`}/>{blinkRight ? `B · ${ordered[1].label}` : `A · ${ordered[0].label}`}</span>}
      </>}
    </div>
  </section>;
};
