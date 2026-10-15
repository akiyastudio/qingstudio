import { useLocale } from "../../i18n/react";
import { t } from "../../i18n/runtime";
import { useEffect, useRef, useState } from 'react';
import type { CompressionContext, CompressionJob } from '../../contracts/compressed-files';
import { compressedFilesRequest } from '../../platform/compressed-files-client';
import { TaskProgress } from '../../components/TaskStatus';
import { ToolModal } from './ProjectToolModal';

export const CompressionToolPanel = ({ context, paths, mode, open, autoStart = false, onClose, onComplete }: { context: CompressionContext; paths: string[]; mode: 'compress' | 'extract'; open: boolean; autoStart?: boolean; onClose: () => void; onComplete: () => void }) => {
  useLocale();
  const compress = mode === 'compress';
  const [name, setName] = useState(() => {
    const folders = paths.map(value => value.replace(/\\/g, '/').split('/').slice(0, -1));
    const common = [...(folders[0] || [])];
    for (const folder of folders.slice(1)) while (common.length && common.some((part, index) => part.toLowerCase() !== folder[index]?.toLowerCase())) common.pop();
    return common.at(-1) || context.projectName || '压缩文件';
  });
  const [format, setFormat] = useState<'zip' | '7z'>('zip'), [ready, setReady] = useState(false);
  const [password, setPassword] = useState(''), [needsPassword, setNeedsPassword] = useState(false);
  const [level, setLevel] = useState(5), [split, setSplit] = useState(0), [limit, setLimit] = useState(16), [encrypt, setEncrypt] = useState(true), [comment, setComment] = useState('');
  const [job, setJob] = useState<CompressionJob | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const jobRef = useRef(job), started = useRef(false), saveFormat = useRef(Promise.resolve());
  const completedOperations = useRef(new Set<string>()), onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const running = busy || job?.state === 'running' || job?.state === 'publishing';
  jobRef.current = job;
  const accept = (value: CompressionJob) => {
    setJob(value);
    if (value.errorCode === 'ARCHIVE_PASSWORD_REQUIRED') setNeedsPassword(true);
    if (value.state === 'completed') { setNeedsPassword(false); if (!completedOperations.current.has(value.operationId)) { completedOperations.current.add(value.operationId); onCompleteRef.current(); } }
  };
  const start = async () => {
    if (running || !ready || job?.state === 'publication-failed') return;
    setBusy(true); setError(''); setJob(null);
    const secret = password; setPassword('');
    try {
      await saveFormat.current;
      accept(await compressedFilesRequest<CompressionJob>({ action: 'run', context, payload: { relativePaths: paths, mode, name, format, level, splitMiB: split, encryptNames: encrypt, password: secret, maxGiB: compress ? limit : 16, comment: compress && format === 'zip' ? comment : '' } }));
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    let active = true;
    void (async () => {
      const value = await compressedFilesRequest<{ format: 'zip' | '7z' }>({ action: 'preferences', context });
      if (active) setFormat(value.format);
      const restored = await compressedFilesRequest<CompressionJob | null>({ action: 'current', context });
      if (active && restored && ['running', 'publishing', 'publication-failed'].includes(restored.state)) setJob(restored);
    })().catch(failure => { if (active) setError(String(failure.message)); }).finally(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, [context]);
  useEffect(() => {
    if (ready && autoStart && !started.current) { started.current = true; if (!job || !['running', 'publishing', 'publication-failed'].includes(job.state)) void start(); }
  });
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const current = jobRef.current;
        const value = await compressedFilesRequest<CompressionJob | null>({ action: 'current', context, payload: current ? { operationId: current.operationId } : {} });
        if (active && value && (['running', 'publishing', 'publication-failed'].includes(value.state) || current?.operationId === value.operationId)) accept(value);
      } catch { /* The operation request reports actionable errors. */ }
    };
    const timer = window.setInterval(() => { void poll(); }, 750);
    return () => { active = false; window.clearInterval(timer); };
  }, [busy, context]);
  const changeFormat = (value: 'zip' | '7z') => {
    setFormat(value);
    saveFormat.current = saveFormat.current.then(() => compressedFilesRequest({ action: 'preferences', context, payload: { format: value } })).then(() => undefined).catch(failure => { setError(failure.message); });
  };
  const control = 'pf-form-input w-full';
  const label = 'pf-form-label flex flex-col gap-2 text-xs font-semibold text-slate-600';
  return <ToolModal title={compress ? t("compression.add") : t("compression.extract_title")} ownerPageId={context.sourcePageId} panelKind="component:builtin-compression:tool" open={open} busy={running} onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); void start(); }} className="space-y-4">
      <div className="flex justify-between gap-4 text-xs text-slate-500"><span>{t("compression.selected_count", { value0: paths.length })}</span><span>{compress ? t("compression.compress_destination") : t("compression.extract_destination")}</span></div>
      {compress && <div className="rounded-xl border border-slate-200 bg-slate-50 p-4"><div className="grid gap-4 sm:grid-cols-2">
        <label className={label}>{t("compression.name")}<input className={control} value={name} maxLength={200} disabled={running} onChange={event => setName(event.target.value)}/></label>
        <label className={label}>{t("compression.format")}<select className={control} value={format} disabled={running || !ready} onChange={event => changeFormat(event.target.value as 'zip' | '7z')}><option value="zip">{t("compression.zip")}</option><option value="7z">{t("compression.7z")}</option></select></label>
      </div><details className="mt-4 border-t border-slate-200 pt-3"><summary className="cursor-pointer text-sm font-semibold text-slate-600">{t("compression.advanced")}</summary><div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className={label}>{t("compression.level")}<select className={control} value={level} disabled={running} onChange={event => setLevel(Number(event.target.value))}>{[[0, t("compression.store")], [1, t("compression.fastest")], [3, t("compression.fast")], [5, t("compression.normal")], [7, t("compression.high")], [9, t("compression.maximum")]].map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>
        <label className={label}>{t("compression.volume")}<input className={control} type="number" min={0} max={65536} value={split} disabled={running} onChange={event => setSplit(Number(event.target.value))}/><span className="font-normal text-slate-400">{t("compression.volume_hint")}</span></label>
        <label className={label}>{t("compression.optional_password")}<input className={control} type="password" autoComplete="off" maxLength={256} value={password} disabled={running} onChange={event => setPassword(event.target.value)}/></label>
        <label className={label}>{t("compression.limit")}<input className={control} type="number" min={1} max={64} value={limit} disabled={running} onChange={event => setLimit(Number(event.target.value))}/></label>
        {format === '7z' && <label className="flex items-center gap-2 text-xs text-slate-600 sm:col-span-2"><input type="checkbox" checked={encrypt} disabled={running} onChange={event => setEncrypt(event.target.checked)}/>{t("compression.encrypt_names")}</label>}
        <label className={`${label} sm:col-span-2`}>{t("compression.comment")}<textarea className={control} rows={3} maxLength={16000} value={comment} disabled={running || format === '7z'} onChange={event => setComment(event.target.value)}/><span className="font-normal text-slate-400">{format === '7z' ? t("compression.7z_comment") : t("compression.zip_comment")}</span></label>
      </div></details></div>}
      {!compress && needsPassword && <label className={label}>{t("compression.extract_password")}<input autoFocus className={control} type="password" autoComplete="off" maxLength={256} value={password} disabled={running} onChange={event => setPassword(event.target.value)}/><span className="font-normal text-slate-400">{t("compression.password_hint")}</span></label>}
      <TaskProgress logs={[]} progress={job?.progress || 0} isRunning={running} statusMessage={error || job?.message || (compress ? t("compression.wait_compress") : t("compression.wait_extract"))} reportToTaskCenter={false} action={<div className="flex gap-2">
        <button type="submit" className="dialog-primary" disabled={running || !ready || !paths.length || job?.state === 'publication-failed'}>{compress ? t("compression.start_compress") : t("compression.start_extract")}</button>
        {job?.state === 'running' && <button type="button" className="dialog-secondary" onClick={() => void compressedFilesRequest<CompressionJob>({ action: 'cancel', context, payload: { operationId: job.operationId } }).then(accept).catch(failure => setError(failure.message))}>{t("ui.cancel.task.537d17")}</button>}
        {job?.state === 'publication-failed' && <button type="button" className="dialog-secondary" onClick={() => void compressedFilesRequest<CompressionJob>({ action: 'publish', context, payload: { operationId: job.operationId } }).then(accept).catch(failure => setError(failure.message))}>{t("compression.retry_publish")}</button>}
      </div>}/>
    </form>
  </ToolModal>;
};
