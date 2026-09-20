import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PreviewDecoder, PreviewPageContext } from '../../contracts/component-preview';

export function ComponentFileThumbnail({ relativePath, updatedAt, decoder, context, size, fallback }: { relativePath: string; updatedAt: number; decoder: PreviewDecoder; context: PreviewPageContext; size: number; fallback: ReactNode }) {
  const element = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const identity = JSON.stringify([relativePath, updatedAt, decoder.componentId, decoder.id, decoder.version, context, size]);
  const [image, setImage] = useState<{ identity: string; url: string }>();
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: '120px' });
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let active = true, timer = 0, attempts = 0;
    const requestId = crypto.randomUUID();
    const load = async () => {
      const value = await window.electronAPI.getComponentThumbnail({ requestId, componentId: decoder.componentId, decoderId: decoder.id, relativePath, maxEdge: Math.max(64, Math.min(640, Math.round(size))), context }).catch(() => null);
      if (!active) return;
      if (value && !value.success && value.errorCode === 'COMPONENT_HOST_CONFLICT' && attempts++ < 120) { timer = window.setTimeout(() => void load(), 500 + Math.random() * 250); return; }
      if (value?.success && value.kind !== 'video') setImage({ identity, url: value.dataUrl });
    };
    void load();
    return () => { active = false; clearTimeout(timer); void window.electronAPI.cancelComponentPreview(requestId).catch(() => undefined); };
  }, [identity, visible]);
  return <span ref={element} className="relative flex h-full w-full min-h-0 min-w-0 items-center justify-center" data-component-thumbnail="true">{image?.identity === identity ? <img src={image.url} alt="" draggable={false} onError={() => setImage(undefined)} className="h-full w-full object-contain"/> : fallback}</span>;
}
