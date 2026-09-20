import { useLocale } from "../../i18n/react";
import { t } from "../../i18n/runtime";
import { useRef } from 'react';
import { Aperture, GitBranch, Loader2, Video } from 'lucide-react';
import type { ProgressFolder } from '../../types';
import { VersionProgressPanel } from './VersionProgressPanel';
import { selectableVersionParents, type VersionPanelState, type VersionPanelTaskProgress } from './versioning-v2-model';
import { cleanFolderMarkCommon, createFolderMarkDraft, switchFolderMarkPurpose, type FolderMarkCommon, type FolderMarkDraft, type FolderMarkMediaKind, type FolderMarkPurpose } from './folder-mark-model';

export type FolderMarkPanelProps = {
  draft: FolderMarkDraft;
  folders: ProgressFolder[];
  state?: VersionPanelState;
  taskProgress?: VersionPanelTaskProgress;
  message?: string;
  error?: string;
  namePresets?: string[];
  onChange: (draft: FolderMarkDraft) => void;
  onSubmit: (draft: FolderMarkDraft) => void;
  onClose: () => void;
};

const FolderSummary = ({ draft }: { draft: FolderMarkCommon }) => { useLocale(); return (<section className="rounded-xl border border-slate-200 bg-white p-4">
  <p className="text-xs font-semibold text-slate-500">{t("ui.current.folder.9112e7")}</p>
  <p className="mt-1 truncate text-sm font-bold text-slate-800" title={draft.folderName}>{draft.folderName}</p>
  <p className="mt-1 truncate text-xs text-slate-400" title={draft.relativePath}>{draft.relativePath || t("ui.project.root.3db07c")}</p>
</section>); };

const MediaKindControl = ({ value, disabled, onChange }: {
  value: FolderMarkMediaKind;
  disabled?: boolean;
  onChange: (mediaKind: FolderMarkMediaKind) => void;
}) => { useLocale(); return (<fieldset disabled={disabled}>
  <legend className="text-xs font-semibold text-slate-600">{t("ui.media.type.296225")}</legend>
  <div className="mt-2 grid grid-cols-2 gap-2">
    {([['image', t("ui.image.d24c10")], ['video', t("ui.video.c20f76")]] as const).map(([mediaKind, label]) => <button
      key={mediaKind}
      type="button"
      aria-pressed={value === mediaKind}
      onClick={() => onChange(mediaKind)}
      className={`h-10 rounded-lg border text-sm font-semibold transition disabled:opacity-50 ${value === mediaKind ? 'border-blue-500 bg-blue-50 text-blue-700 ring-1 ring-blue-200' : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'}`}
    >{label}</button>)}
  </div>
</fieldset>); };

const SimplePanelFooter = ({ busy, submitLabel, onSubmit, onClose }: {
  busy: boolean;
  submitLabel: string;
  onSubmit: () => void;
  onClose: () => void;
}) => { useLocale(); return (<div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 pt-4">
  <button type="button" disabled={busy} onClick={onClose} className="dialog-secondary">{t("common.cancel")}</button>
  <button type="button" disabled={busy} onClick={onSubmit} className="dialog-primary inline-flex items-center gap-2">
    {busy && <Loader2 size={15} className="animate-spin"/>}
    {submitLabel}
  </button>
</div>); };

export const FolderMarkPanel = ({ draft, folders, state = 'ready', taskProgress, message, error, namePresets, onChange, onSubmit, onClose }: FolderMarkPanelProps) => {
  useLocale();
  const busy = state === 'processing';
  const lastMediaKindRef = useRef<FolderMarkMediaKind>(draft.purpose === 'original'
    ? draft.mediaKind
    : draft.purpose === 'progress' ? draft.progress.mediaKind : 'image');
  if (draft.purpose === 'original') lastMediaKindRef.current = draft.mediaKind;
  else if (draft.purpose === 'progress') lastMediaKindRef.current = draft.progress.mediaKind;
  const purposes: Array<{ purpose: FolderMarkPurpose; label: string; icon: React.ReactNode }> = [
    { purpose: 'original', label: t("ui.original.media.2a53f2"), icon: <Aperture size={16}/> },
    { purpose: 'progress', label: t("ui.progress.f81ff5"), icon: <GitBranch size={16}/> },
    { purpose: 'broll', label: t("ui.behind.the.scenes.6bcb07"), icon: <Video size={16}/> },
  ];
  const changePurpose = (purpose: FolderMarkPurpose) => {
    if (purpose === draft.purpose) return;
    onChange(switchFolderMarkPurpose(draft, purpose, folders, lastMediaKindRef.current));
  };

  if (draft.purpose !== 'progress' && state !== 'ready') {
    const title = state === 'processing' ? '正在更新文件夹标记' : state === 'result' ? '文件夹标记已更新' : '文件夹标记失败';
    const tone = state === 'failure' ? 'border-red-200 bg-red-50 text-red-800' : state === 'result' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-blue-200 bg-blue-50 text-blue-800';
    return <div className="space-y-4"><FolderSummary draft={draft}/><section role={state === 'failure' ? 'alert' : 'status'} className={`rounded-xl border px-4 py-3 ${tone}`}><b className="text-sm">{title}</b><p className="mt-1 text-xs leading-5 opacity-80">{error || message || (busy ? taskProgress?.currentName || t("ui.processing.please.wait.ba3e42") : t("ui.the.operation.is.complete.9e9f75"))}</p>{busy && typeof taskProgress?.percentage === 'number' && <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/60"><div className="h-full rounded-full bg-blue-500" style={{ width: `${Math.max(0, Math.min(100, taskProgress.percentage))}%` }}/></div>}</section><div className="flex justify-end"><button type="button" disabled={busy} onClick={onClose} className="dialog-primary">{t("common.close")}</button></div></div>;
  }

  const originalPanel = draft.purpose === 'original' ? <div className="space-y-4">
    <FolderSummary draft={draft}/>
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <MediaKindControl
        value={draft.mediaKind}
        disabled={busy}
        onChange={mediaKind => onChange(createFolderMarkDraft(cleanFolderMarkCommon(draft), 'original', folders, mediaKind))}
      />
      <p className="mt-3 text-xs leading-5 text-slate-500">{t("ui.register.as.a.project.media.source.f1fdf9")}</p>
    </section>
    <SimplePanelFooter busy={busy} submitLabel={t("legacy.b3f355afdd9f")} onSubmit={() => onSubmit(draft)} onClose={onClose}/>
  </div> : null;

  const brollPanel = draft.purpose === 'broll' ? <div className="space-y-4">
    <FolderSummary draft={draft}/>
    <section className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-emerald-800">
      <b className="text-sm">{t("ui.mixed.images.and.videos.9a1024")}</b>
      <p className="mt-1 text-xs leading-5 opacity-80">{t("ui.use.this.folder.for.behind.the.9ae4a1")}</p>
    </section>
    <SimplePanelFooter busy={busy} submitLabel={t("legacy.cdf54dd7bb63")} onSubmit={() => onSubmit(draft)} onClose={onClose}/>
  </div> : null;

  let progressPanel: React.ReactNode = null;
  if (draft.purpose === 'progress') {
    const mediaKind = draft.progress.mediaKind === 'video' ? 'video' : 'image';
    const validParents = selectableVersionParents(folders, { mediaKind, relationKind: 'main' });
    if (!validParents.length) {
      progressPanel = <div className="space-y-4">
        <FolderSummary draft={draft}/>
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <MediaKindControl
            value={mediaKind}
            disabled={busy}
            onChange={nextMediaKind => onChange(createFolderMarkDraft(cleanFolderMarkCommon(draft), 'progress', folders, nextMediaKind))}
          />
        </section>
        <section className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800">
          <b className="text-sm">{t("ui.mark.original.media.first.f55977")}</b>
          <p className="mt-1 text-xs leading-5 opacity-80">{t("ui.no.source.is.available.for.this.f425b8")}</p>
        </section>
        <div className="flex justify-end border-t border-slate-200 pt-4"><button type="button" disabled={busy} onClick={onClose} className="dialog-secondary">{t("common.cancel")}</button></div>
      </div>;
    } else {
      progressPanel = <VersionProgressPanel
        draft={draft.progress}
        folders={folders}
        state={state}
        progress={taskProgress}
        message={message}
        error={error}
        namePresets={namePresets}
        onChange={nextProgress => {
          const nextMediaKind = nextProgress.mediaKind === 'video' ? 'video' : 'image';
          const nextParentValid = selectableVersionParents(folders, { mediaKind: nextMediaKind, relationKind: 'main' })
            .some(folder => folder.id === nextProgress.parentProgressId);
          if (!nextParentValid) {
            onChange(createFolderMarkDraft(cleanFolderMarkCommon(draft), 'progress', folders, nextMediaKind));
            return;
          }
          onChange({ ...cleanFolderMarkCommon(draft), purpose: 'progress', progress: nextProgress });
        }}
        onSubmit={() => onSubmit(draft)}
        onClose={onClose}
      />;
    }
  }

  return <div className="space-y-4">
    <fieldset disabled={busy}>
      <legend className="mb-2 text-xs font-semibold text-slate-600">{t("ui.mark.as.1f6c2d")}</legend>
      <div className="grid grid-cols-3 gap-2">
        {purposes.map(item => <button
          key={item.purpose}
          type="button"
          aria-pressed={draft.purpose === item.purpose}
          onClick={() => changePurpose(item.purpose)}
          className={`flex min-h-10 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${draft.purpose === item.purpose ? 'border-blue-500 bg-blue-50 text-blue-700 ring-1 ring-blue-100' : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:bg-blue-50/40'}`}
        >{item.icon}{item.label}</button>)}
      </div>
    </fieldset>
    {originalPanel}
    {progressPanel}
    {brollPanel}
  </div>;
};
