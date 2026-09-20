import { useLocale } from "../i18n/react";
import { t } from "../i18n/runtime";
import { Aperture, Files, GitBranch, Loader2, Video } from 'lucide-react';
import { PanelSwitch } from './PanelSwitch';
import { SourcePathPicker } from './SourcePathPicker';

export type ImportMaterialKind = 'original' | 'progress' | 'broll' | 'files';

type ImportSourceControlsProps = {
  selectionTitle: string;
  selectionDescription: string;
  selectedPaths: readonly string[];
  onSelectedPathsChange: (paths: string[]) => void;
  onChooseFiles: () => void;
  onChooseFolder?: () => void;
  chooseFilesLabel?: string;
  chooseFolderLabel?: string;
  deleteSourceAfterImport: boolean;
  onDeleteSourceAfterImportChange: (value: boolean) => void;
  deleteSourceDescription: string;
  importKind?: ImportMaterialKind;
  onImportKindChange?: (kind: ImportMaterialKind) => void;
  disabledImportKinds?: readonly ImportMaterialKind[];
  statusText?: string;
  startLabel?: string;
  busyLabel?: string;
  busy?: boolean;
  startDisabled?: boolean;
  onStart: () => void;
};

export const ImportSourceControls = ({
  selectionTitle,
  selectionDescription,
  selectedPaths,
  onSelectedPathsChange,
  onChooseFiles,
  onChooseFolder,
  chooseFilesLabel = '选择文件',
  chooseFolderLabel = '选择文件夹',
  deleteSourceAfterImport,
  onDeleteSourceAfterImportChange,
  deleteSourceDescription,
  importKind,
  onImportKindChange,
  disabledImportKinds = [],
  statusText,
  startLabel = '开始导入',
  busyLabel = '正在导入…',
  busy = false,
  startDisabled = false,
  onStart,
}: ImportSourceControlsProps) => {
  useLocale();
  const importKinds: Array<{ kind: ImportMaterialKind; label: string; icon: React.ReactNode }> = [
    { kind: 'original', label: t("ui.original.media.2a53f2"), icon: <Aperture size={16}/> },
    { kind: 'progress', label: t("ui.progress.f81ff5"), icon: <GitBranch size={16}/> },
    { kind: 'broll', label: t("ui.behind.the.scenes.6bcb07"), icon: <Video size={16}/> },
    { kind: 'files', label: t("ui.other.files.6ef019"), icon: <Files size={16}/> },
  ];

  return <div className="space-y-4">
  <SourcePathPicker
    paths={selectedPaths}
    onChange={onSelectedPathsChange}
    onChooseFiles={onChooseFiles}
    onChooseFolder={onChooseFolder}
    fileButtonLabel={selectedPaths.length ? t("ui.add.value0.3eec14", { value0: chooseFilesLabel.replace(/^选择/, '') }) : chooseFilesLabel}
    folderButtonLabel={selectedPaths.length ? t("ui.add.value0.3eec14", { value0: chooseFolderLabel.replace(/^选择/, '') }) : chooseFolderLabel}
    title={t("ui.selected.3f4ebc")}
    description={t("ui.selected.files.and.folders.will.be.ec790f")}
    emptyTitle={selectionTitle}
    emptyDescription={selectionDescription}
    disabled={busy}
    itemLabel={t("legacy.68450f43fd47")}
  />

  {importKind && onImportKindChange && <fieldset>
    <legend className="mb-2 text-xs font-semibold text-slate-600">{t("ui.import.contents.c95c54")}</legend>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {importKinds.map(item => {
        const unavailable = disabledImportKinds.includes(item.kind);
        return <button
          key={item.kind}
          type="button"
          aria-pressed={importKind === item.kind}
          disabled={busy || unavailable}
          title={unavailable ? t("ui.this.import.type.is.not.supported.089fec") : undefined}
          onClick={() => onImportKindChange(item.kind)}
          className={`flex min-h-10 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${importKind === item.kind ? 'border-blue-500 bg-blue-50 text-blue-700 ring-1 ring-blue-100' : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:bg-blue-50/40'}`}
        >{item.icon}{item.label}</button>;
      })}
    </div>
  </fieldset>}

    <PanelSwitch
      title={t("ui.delete.source.files.after.import.7a39fa")}
      description={deleteSourceDescription}
      checked={deleteSourceAfterImport}
      disabled={busy}
      onChange={onDeleteSourceAfterImportChange}
    />

  <div className="flex items-center gap-3 border-t border-slate-200 pt-4">
    <span className="mr-auto text-xs text-slate-400">{statusText || (selectedPaths.length ? t("ui.selected.sources.value0.3a9d8a", { value0: selectedPaths.length }) : t("ui.no.source.selected.1e22f4"))}</span>
    <button type="button" onClick={onStart} disabled={busy || startDisabled || !selectedPaths.length} className="dialog-primary inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50">
      {busy && <Loader2 size={15} className="animate-spin"/>}
      {busy ? busyLabel : startLabel}
    </button>
  </div>
</div>;
};
