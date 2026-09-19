import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ExternalLink, Loader2, RotateCcw } from 'lucide-react';
import type { ComponentSettingsFormField, ComponentSettingsPageContribution, ComponentSettingsValue } from '../../types';
import { ComponentSettingsPageSurface } from './ComponentSettingsPageSurface';

type DeclarativePage = Extract<ComponentSettingsPageContribution, { renderMode: 'declarative' }> | Extract<ComponentSettingsPageContribution, { renderMode: 'hybrid' }>;
type DraftValue = ComponentSettingsValue | string;
type Values = Record<string, DraftValue>;

const FieldControl = ({ field, value, saving, onDraft, onCommit }: { field: ComponentSettingsFormField; value: DraftValue; saving: boolean; onDraft: (value: DraftValue) => void; onCommit: (value: DraftValue) => void }) => {
  const inputId = `component-setting-${field.id}`;
  if (field.type === 'toggle') return <div className="flex justify-end"><input id={inputId} type="checkbox" checked={Boolean(value)} disabled={saving} onChange={event => onCommit(event.target.checked)} className="h-4 w-4 accent-blue-600"/></div>;
  if (field.type === 'select') return <div className="pf-control-cluster ml-auto max-w-sm"><select id={inputId} value={String(value)} disabled={saving} onChange={event => onCommit(event.target.value)} className="pf-select min-w-0 flex-1">{field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{saving && <Loader2 size={15} className="shrink-0 animate-spin text-blue-600"/>}</div>;
  if (field.type === 'text') return <div className="pf-control-cluster ml-auto max-w-sm"><input id={inputId} value={String(value)} maxLength={field.maxLength} placeholder={field.placeholder} disabled={saving} onChange={event => onDraft(event.target.value)} onBlur={event => onCommit(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} className="pf-input min-w-0 flex-1 px-3"/>{saving && <Loader2 size={15} className="shrink-0 animate-spin text-blue-600"/>}</div>;
  const numericValue = typeof value === 'number' || typeof value === 'string' ? value : field.default;
  if (field.type === 'number') return <div className="pf-control-cluster ml-auto max-w-sm"><input id={inputId} type="number" value={numericValue} min={field.min} max={field.max} step={field.step} disabled={saving} onChange={event => onDraft(event.target.value)} onBlur={event => onCommit(event.target.value)} className="pf-input min-w-0 flex-1 px-3"/>{field.suffix && <span className="shrink-0 text-xs font-medium text-slate-500">{field.suffix}</span>}{saving && <Loader2 size={15} className="shrink-0 animate-spin text-blue-600"/>}</div>;
  return <div className="pf-control-cluster ml-auto max-w-sm"><input id={inputId} type="range" value={numericValue} min={field.min} max={field.max} step={field.step} disabled={saving} onChange={event => onDraft(Number(event.target.value))} onPointerUp={event => onCommit(Number(event.currentTarget.value))} onKeyUp={event => onCommit(Number(event.currentTarget.value))} className="min-w-0 flex-1 accent-blue-600"/><output htmlFor={inputId} className="min-w-16 text-right text-sm font-bold tabular-nums text-slate-700">{numericValue}{field.suffix || ''}</output>{saving && <Loader2 size={15} className="shrink-0 animate-spin text-blue-600"/>}</div>;
};

export const ComponentDeclarativeSettingsSurface = ({ page }: { page: DeclarativePage }) => {
  const [values, setValues] = useState<Values>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [customReady, setCustomReady] = useState(false);
  const [customLoadError, setCustomLoadError] = useState('');
  const [customAttempt, setCustomAttempt] = useState(0);
  const committedRef = useRef<Values>({});
  const pendingRef = useRef<Values>({});
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const savingCounts = useRef(new Map<string,number>());
  const loadGeneration = useRef(0);
  const pageGeneration = useRef(0);
  const pageKey = `${page.componentId}\u001f${page.componentVersion}\u001f${page.pageId}`;
  const activePageKey = useRef(pageKey); activePageKey.current=pageKey;

  const load = useCallback(async () => {
    const currentPageGeneration = pageGeneration.current;
    const generation = ++loadGeneration.current;
    setLoading(true); setLoadError(''); setSaveError('');
    try {
      const result = await window.electronAPI.readComponentSettingsForm({ componentId: page.componentId, pageId: page.pageId });
      if (generation !== loadGeneration.current || currentPageGeneration !== pageGeneration.current) return;
      if (!result.success || !result.values) { setLoadError(result.error || '无法读取组件设置'); return; }
      committedRef.current = result.values; pendingRef.current = {}; setValues(result.values);
    } catch (error) { if (generation === loadGeneration.current && currentPageGeneration === pageGeneration.current) setLoadError(error instanceof Error ? error.message : String(error)); }
    finally { if (generation === loadGeneration.current && currentPageGeneration === pageGeneration.current) setLoading(false); }
  }, [page.componentId, page.pageId, pageKey]);

  useEffect(() => { pageGeneration.current += 1; loadGeneration.current += 1; committedRef.current={}; pendingRef.current={}; queueRef.current=Promise.resolve(); savingCounts.current.clear(); setValues({}); setLoading(true); setLoadError(''); setSaveError(''); setSavingIds(new Set()); setCustomReady(false); setCustomLoadError(''); setCustomAttempt(0); void load(); return () => { loadGeneration.current += 1; pageGeneration.current += 1; }; }, [load, pageKey]);
  const handleCustomReady = useCallback(() => { if(activePageKey.current!==pageKey)return; setCustomLoadError(''); setCustomReady(true); }, [pageKey]);
  const handleCustomError = useCallback((message: string) => { if(activePageKey.current!==pageKey)return; setCustomReady(false); setCustomLoadError(message); }, [pageKey]);
  const retryHybridLoad = () => {
    if (loadError) void load();
    if (customLoadError) { setCustomLoadError(''); setCustomReady(false); setCustomAttempt(current => current + 1); }
  };
  const draft = (id: string, value: DraftValue) => { pendingRef.current = { ...pendingRef.current, [id]: value }; setValues(current => ({ ...current, [id]: value })); };
  const commit = (id: string, draftValue: DraftValue) => {
    const field=page.form.groups.flatMap(group=>group.fields).find(candidate=>candidate.id===id);
    let value: ComponentSettingsValue=draftValue as ComponentSettingsValue;
    if(field?.type==='number'){const text=String(draftValue).trim();const parsed=text===''?Number.NaN:typeof draftValue==='number'?draftValue:Number(text);const stepOffset=(parsed-field.min)/field.step;const validStep=Number.isInteger(stepOffset)||Math.abs(stepOffset-Math.round(stepOffset))<1e-9;if(!Number.isFinite(parsed)||parsed<field.min||parsed>field.max||!validStep){const next={...pendingRef.current};delete next[id];pendingRef.current=next;setValues({...committedRef.current,...next});setSaveError(`${field.label}不是有效数值`);return;}value=parsed;}
    const generation=pageGeneration.current; const targetComponentId=page.componentId; const targetPageId=page.pageId;
    if (Object.is(committedRef.current[id], value) && !Object.hasOwn(pendingRef.current, id)) return;
    draft(id, value); setSaveError(''); savingCounts.current.set(id,(savingCounts.current.get(id)||0)+1); setSavingIds(current => new Set(current).add(id));
    let attempted: DraftValue=value;
    const run = async () => {
      const desired = pendingRef.current[id];
      attempted=desired;
      if(generation!==pageGeneration.current)return;
      const result = await window.electronAPI.updateComponentSettingsForm({ componentId: targetComponentId, pageId: targetPageId, patch: { [id]: desired as ComponentSettingsValue } });
      if(generation!==pageGeneration.current)return;
      if (!result.success || !result.values) throw new Error(result.error || '保存组件设置失败');
      committedRef.current = result.values;
      if (Object.is(pendingRef.current[id], desired)) { const next = { ...pendingRef.current }; delete next[id]; pendingRef.current = next; }
      setValues({ ...result.values, ...pendingRef.current });
    };
    const queued = queueRef.current.catch(() => undefined).then(run).catch(error => { if(generation!==pageGeneration.current)return;
      const next = { ...pendingRef.current }; if(Object.is(next[id],attempted))delete next[id]; pendingRef.current = next;
      setValues({ ...committedRef.current, ...next }); setSaveError(error instanceof Error ? error.message : String(error));
    }).finally(() => {if(generation===pageGeneration.current){const count=Math.max(0,(savingCounts.current.get(id)||1)-1);if(count)savingCounts.current.set(id,count);else savingCounts.current.delete(id);setSavingIds(current => { const next = new Set(current); if(!count)next.delete(id); return next; });}});
    queueRef.current = queued;
  };

  const form = <div className="pf-settings-container"><header className="pf-settings-header"><h1 className="pf-settings-title">{page.pageTitle}</h1></header>{saveError && <div role="alert" data-tone="danger" className="pf-callout">{saveError}</div>}{Boolean(page.form.help?.length) && <section className="pf-settings-group" aria-label="使用说明"><h2 className="pf-settings-group-title">使用说明</h2><div className="pf-settings-card">{page.form.help?.map((item, index) => <div key={index} className="pf-settings-row"><div className="pf-settings-copy" style={{ gridColumn: '1 / -1' }}><h3 className="pf-settings-row-title">{item.title}</h3><p className="pf-settings-description whitespace-pre-line">{item.description}</p></div></div>)}</div></section>}{page.form.groups.map(group => <section key={group.id} className="pf-settings-group"><h2 className="pf-settings-group-title">{group.title}</h2>{group.description && <p className="pf-settings-group-description">{group.description}</p>}<div className="pf-settings-card">{group.fields.map(field => <div key={field.id} className="pf-settings-row"><div className="pf-settings-copy"><label htmlFor={`component-setting-${field.id}`} className="pf-settings-row-title">{field.label}</label>{field.description && <p className="pf-settings-description">{field.description}</p>}</div><div className="pf-settings-control"><FieldControl field={field} value={values[field.id] ?? field.default} saving={savingIds.has(field.id)} onDraft={value => draft(field.id, value)} onCommit={value => commit(field.id, value)}/></div></div>)}</div></section>)}{Boolean(page.form.notices?.length) && <section className="pf-settings-group"><h2 className="pf-settings-group-title">第三方软件与运行库</h2><div className="pf-settings-card">{page.form.notices?.map((notice, index) => <div key={index} className="pf-settings-row"><div className="pf-settings-copy"><h3 className="pf-settings-row-title">{notice.title}</h3><p className="pf-settings-description">{notice.description}</p></div><div className="pf-settings-control"><div className="pf-control-cluster"><span className="text-xs font-bold text-slate-500">{notice.license}</span><button type="button" className="pf-button inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap" onClick={() => void window.electronAPI.openExternal(notice.sourceUrl)}>来源<ExternalLink size={13} className="shrink-0"/></button><button type="button" className="pf-button inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap" onClick={() => void window.electronAPI.openExternal(notice.licenseUrl)}>许可<ExternalLink size={13} className="shrink-0"/></button></div></div></div>)}</div></section>}</div>;
  if (page.renderMode === 'hybrid') {
    const pageReady = !loading && !loadError && customReady && !customLoadError;
    const failure = loadError || customLoadError;
    return <div className="pf-settings-page relative h-full overflow-hidden">
      <div aria-hidden={!pageReady} className={`h-full overflow-y-auto ${pageReady ? '' : 'invisible'}`}>
        {form}
        <section aria-label={page.customPageTitle} className="mx-auto w-full max-w-6xl overflow-hidden" style={{ height: 'clamp(460px, 65vh, 760px)' }}>
          <ComponentSettingsPageSurface key={customAttempt} page={page} visible={pageReady} onReady={handleCustomReady} onError={handleCustomError}/>
        </section>
      </div>
      {!pageReady && <div className="absolute inset-0 flex items-center justify-center p-6">
        {failure ? <section className="pf-card w-full max-w-xl p-6 text-center"><AlertTriangle size={24} className="mx-auto text-red-600"/><h2 className="mt-3 text-sm font-bold">组件设置读取失败</h2><p className="pf-settings-description mt-2">{failure}</p><button type="button" onClick={retryHybridLoad} className="pf-button mt-4 inline-flex items-center gap-2"><RotateCcw size={14}/>重试</button></section> : <div className="flex items-center gap-2 text-sm font-bold"><Loader2 size={18} className="animate-spin text-blue-600"/>正在打开{page.pageTitle}…</div>}
      </div>}
    </div>;
  }
  if (loading) return <div className="pf-settings-page flex h-full items-center justify-center gap-2 text-sm font-bold"><Loader2 size={18} className="animate-spin text-blue-600"/>正在读取{page.pageTitle}…</div>;
  if (loadError) return <div className="pf-settings-page flex h-full items-center justify-center p-6"><section className="pf-card w-full max-w-xl p-6 text-center"><AlertTriangle size={24} className="mx-auto text-red-600"/><h2 className="mt-3 text-sm font-bold">组件设置读取失败</h2><p className="pf-settings-description mt-2">{loadError}</p><button type="button" onClick={() => void load()} className="pf-button mt-4 inline-flex items-center gap-2"><RotateCcw size={14}/>重试</button></section></div>;
  return <div className="pf-settings-page h-full">{form}</div>;
};
