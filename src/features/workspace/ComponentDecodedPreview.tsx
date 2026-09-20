import { useLocale } from "../../i18n/react";
import { t } from "../../i18n/runtime";
import { useEffect, useState } from 'react';
import type { PreviewDecoder, PreviewDecodeResult, PreviewPageContext } from '../../contracts/component-preview';

export const ComponentDecodedPreview = ({ context, relativePath, decoder, onOpen }: { context: PreviewPageContext; relativePath: string; decoder: PreviewDecoder; onOpen: () => void }) => {
  useLocale();
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
  return <div className="absolute inset-0 flex min-h-0 flex-col bg-slate-100" aria-label={t("ui.file.preview.f3c5fe")}>
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-2">
      {loading ? <p role="status" className="text-sm text-slate-500">{t("ui.generating.preview.a8eecc")}</p> : result?.success ? <img src={result.dataUrl} alt={t("ui.value0.page.value1.c67ab0", { value0: relativePath, value1: page + 1 })} className="max-h-full max-w-full object-contain"/> : <div role="alert" className="p-4 text-sm text-slate-600"><p>{result?.error || t("ui.cannot.preview.this.file.959e07")}</p><button onClick={() => setRetry(value => value + 1)} className="mt-3 rounded border px-3 py-1">{t("ui.retry.b8784c")}</button><button onClick={onOpen} className="ml-2 rounded border px-3 py-1">{t("ui.open.externally.5a006a")}</button></div>}
    </div>
    {result?.success && result.pageCount > 1 && <nav aria-label={t("ui.preview.navigation.c5ee96")} className="flex shrink-0 items-center justify-center gap-3 border-t bg-white p-2 text-sm"><button disabled={page === 0} onClick={() => setPage(value => value - 1)}>{t("ui.previous.page.c9b9ae")}</button><span>{page + 1} / {result.pageCount}</span><button disabled={page + 1 >= result.pageCount} onClick={() => setPage(value => value + 1)}>{t("ui.next.page.8a8542")}</button></nav>}
  </div>;
};
