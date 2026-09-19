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
  const importKinds: Array<{ kind: ImportMaterialKind; label: string; icon: React.ReactNode }> = [
    { kind: 'original', label: '原始素材', icon: <Aperture size={16}/> },
    { kind: 'progress', label: '进度', icon: <GitBranch size={16}/> },
    { kind: 'broll', label: '花絮', icon: <Video size={16}/> },
    { kind: 'files', label: '其他文件', icon: <Files size={16}/> },
  ];

  return <div className="space-y-4">
  <SourcePathPicker
    paths={selectedPaths}
    onChange={onSelectedPathsChange}
    onChooseFiles={onChooseFiles}
    onChooseFolder={onChooseFolder}
    fileButtonLabel={selectedPaths.length ? `追加${chooseFilesLabel.replace(/^选择/, '')}` : chooseFilesLabel}
    folderButtonLabel={selectedPaths.length ? `追加${chooseFolderLabel.replace(/^选择/, '')}` : chooseFolderLabel}
    title="已选择"
    description="所选文件和文件夹将按列表顺序导入"
    emptyTitle={selectionTitle}
    emptyDescription={selectionDescription}
    disabled={busy}
    itemLabel="个来源"
  />

  {importKind && onImportKindChange && <fieldset>
    <legend className="mb-2 text-xs font-semibold text-slate-600">导入的内容</legend>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {importKinds.map(item => {
        const unavailable = disabledImportKinds.includes(item.kind);
        return <button
          key={item.kind}
          type="button"
          aria-pressed={importKind === item.kind}
          disabled={busy || unavailable}
          title={unavailable ? '当前目录不支持此导入类型' : undefined}
          onClick={() => onImportKindChange(item.kind)}
          className={`flex min-h-10 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${importKind === item.kind ? 'border-blue-500 bg-blue-50 text-blue-700 ring-1 ring-blue-100' : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:bg-blue-50/40'}`}
        >{item.icon}{item.label}</button>;
      })}
    </div>
  </fieldset>}

    <PanelSwitch
      title="导入后删除源文件"
      description={deleteSourceDescription}
      checked={deleteSourceAfterImport}
      disabled={busy}
      onChange={onDeleteSourceAfterImportChange}
    />

  <div className="flex items-center gap-3 border-t border-slate-200 pt-4">
    <span className="mr-auto text-xs text-slate-400">{statusText || (selectedPaths.length ? `已选择 ${selectedPaths.length} 个来源` : '尚未选择来源')}</span>
    <button type="button" onClick={onStart} disabled={busy || startDisabled || !selectedPaths.length} className="dialog-primary inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50">
      {busy && <Loader2 size={15} className="animate-spin"/>}
      {busy ? busyLabel : startLabel}
    </button>
  </div>
</div>;
};
