import { useEffect, useState } from 'react';
import type { PreviewDecoder, PreviewDecodeResult, PreviewPageContext } from '../../contracts/component-preview';

export const usePreviewDecoders = () => {
  const [decoders, setDecoders] = useState<PreviewDecoder[]>([]);
  useEffect(() => {
    let active = true;
    const refresh = () => { void window.electronAPI.getPreviewDecoders().then(value => { if (active) setDecoders(value); }).catch(() => { if (active) setDecoders([]); }); };
    refresh(); const stop = window.electronAPI.onComponentsStatusChanged(refresh);
    return () => { active = false; stop(); };
  }, []);
  return decoders;
};
export const decoderForFile = (decoders: PreviewDecoder[], name: string) => decoders.find(item => item.extensions.some(extension => extension !== '*' && name.toLowerCase().endsWith(extension))) || decoders.find(item => item.extensions.includes('*'));

export const ComponentDecodedPreview = ({ context, relativePath, decoder, onOpen }: { context: PreviewPageContext; relativePath: string; decoder: PreviewDecoder; onOpen: () => void }) => {
  const [page, setPage] = useState(0); const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<PreviewDecodeResult | null>(null); const [loading, setLoading] = useState(true);
  const contextKey = JSON.stringify(context);
  useEffect(() => {
    let active = true; let timer = 0; let attempts = 0;
    setLoading(true); setResult(null);
    const run = async () => {
      const value = await window.electronAPI.decodeComponentPreview({ componentId: decoder.componentId, decoderId: decoder.id, context, relativePath, pageIndex: page, maxEdge: 2048 }).catch(() => ({ success: false as const, error: '预览解码失败', errorCode: 'COMPONENT_HOST_INTERNAL' }));
      if (!active) return;
      if (!value.success && value.errorCode === 'COMPONENT_HOST_CONFLICT' && attempts++ < 120) { timer = window.setTimeout(() => void run(), 500); return; }
      setResult(value); setLoading(false);
    };
    void run(); return () => { active = false; window.clearTimeout(timer); };
  }, [contextKey, relativePath, decoder.componentId, decoder.id, page, retry]);
  return <div className="absolute inset-0 flex min-h-0 flex-col bg-slate-100" aria-label="文件预览">
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-2">
      {loading ? <p role="status" className="text-sm text-slate-500">正在生成预览…</p> : result?.success ? <img src={result.dataUrl} alt={`${relativePath}，第 ${page + 1} 页`} className="max-h-full max-w-full object-contain"/> : <div role="alert" className="p-4 text-sm text-slate-600"><p>{result?.error || '无法预览此文件'}</p><button onClick={() => setRetry(value => value + 1)} className="mt-3 rounded border px-3 py-1">重试</button><button onClick={onOpen} className="ml-2 rounded border px-3 py-1">外部打开</button></div>}
    </div>
    {result?.success && result.pageCount > 1 && <nav aria-label="预览翻页" className="flex shrink-0 items-center justify-center gap-3 border-t bg-white p-2 text-sm"><button disabled={page === 0} onClick={() => setPage(value => value - 1)}>上一页</button><span>{page + 1} / {result.pageCount}</span><button disabled={page + 1 >= result.pageCount} onClick={() => setPage(value => value + 1)}>下一页</button></nav>}
  </div>;
};
