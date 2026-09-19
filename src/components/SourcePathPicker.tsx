import { useEffect, useId, useMemo, useState } from 'react';
import { ChevronDown, File, FileInput, FolderInput, Plus, Trash2, X } from 'lucide-react';
import { mergeSourcePaths, parseSourcePathText, removeSourcePath, sourcePathIdentity } from './source-path-picker-model';

const sourcePathDetails = (sourcePath: string, kind?: 'file' | 'folder') => {
  const normalized = sourcePath.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  const name = parts.pop() || sourcePath;
  const extensionMatch = name.match(/\.([^.]+)$/);
  return {
    name,
    badge: kind === 'folder' ? '目录' : extensionMatch ? extensionMatch[1].slice(0, 5).toLocaleUpperCase() : '文件',
    parent: parts.slice(-2).join(' / '),
  };
};

type SourcePathPickerProps = {
  paths: readonly string[];
  onChange: (paths: string[]) => void;
  onChooseFiles?: () => void | Promise<void>;
  onChooseFolder?: () => void | Promise<void>;
  fileButtonLabel?: string;
  folderButtonLabel?: string;
  title?: string;
  description?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  itemLabel?: string;
  pastePlaceholder?: string;
  disabled?: boolean;
  loading?: boolean;
  maxPaths?: number;
  pathKinds?: Readonly<Record<string, 'file' | 'folder'>>;
  pathAnnotations?: Readonly<Record<string, string>>;
  folderPreviewExtensions?: readonly string[];
};

type FolderPreview = {
  count: number;
  files: string[];
  truncated: boolean;
  loading?: boolean;
  error?: string;
};

export const SourcePathPicker = ({
  paths,
  onChange,
  onChooseFiles,
  onChooseFolder,
  fileButtonLabel = '追加文件',
  folderButtonLabel = '追加文件夹',
  title = '已选择',
  description = '文件和文件夹将按列表顺序处理',
  emptyTitle = '拖入文件或文件夹',
  emptyDescription = '也可以使用上方按钮或批量粘贴路径',
  itemLabel = '项',
  pastePlaceholder = '每行一个绝对路径；也支持带引号的 Windows“复制为路径”内容',
  disabled = false,
  loading = false,
  maxPaths = 4096,
  pathKinds = {},
  pathAnnotations = {},
  folderPreviewExtensions = [],
}: SourcePathPickerProps) => {
  const normalizedPaths = useMemo(() => mergeSourcePaths(paths), [paths]);
  const [dragActive, setDragActive] = useState(false);
  const [pasteDraft, setPasteDraft] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const [folderPreviews, setFolderPreviews] = useState<Record<string, FolderPreview>>({});
  const [selectionError, setSelectionError] = useState('');
  const pastePanelId = useId();
  const previewExtensionsKey = [...folderPreviewExtensions].map(value => value.replace(/^\./, '').toLocaleLowerCase()).sort().join(',');
  const folderPaths = useMemo(() => normalizedPaths.filter(sourcePath => pathKinds[sourcePathIdentity(sourcePath)] === 'folder'), [normalizedPaths, pathKinds]);
  const folderPathsKey = folderPaths.map(sourcePathIdentity).join('\n');
  const expandedFoldersKey = [...expandedFolders].sort().join('\n');
  const allFoldersExpanded = folderPaths.length > 0 && folderPaths.every(sourcePath => expandedFolders.has(sourcePathIdentity(sourcePath)));

  useEffect(() => {
    if (!disabled) return;
    setDragActive(false);
  }, [disabled]);

  useEffect(() => {
    const activeIdentities = new Set(folderPaths.map(sourcePathIdentity));
    setExpandedFolders(current => new Set([...current].filter(identity => activeIdentities.has(identity))));
    setFolderPreviews(current => Object.fromEntries(Object.entries(current).filter(([identity]) => activeIdentities.has(identity))));
    const previewPaths = folderPaths.filter(sourcePath => expandedFolders.has(sourcePathIdentity(sourcePath)));
    if (!previewPaths.length) return;
    let active = true;
    setFolderPreviews(current => ({ ...current, ...Object.fromEntries(previewPaths.map(sourcePath => {
      const identity = sourcePathIdentity(sourcePath);
      return [identity, { ...(current[identity] || { count: 0, files: [], truncated: false }), loading: true, error: undefined }];
    })) }));
    void (async () => {
      for (let offset = 0; offset < previewPaths.length && active; offset += 8) {
        const batch = previewPaths.slice(offset, offset + 8);
        try {
          const result = await window.electronAPI.inspectSourcePaths(batch, { includeFolderFiles: true, extensions: previewExtensionsKey ? previewExtensionsKey.split(',') : [] });
          if (!active) return;
          const returned = Object.fromEntries(result.sources.flatMap(source => source.kind === 'folder' && source.preview ? [[sourcePathIdentity(source.path), { ...source.preview, loading: false } satisfies FolderPreview]] : []));
          setFolderPreviews(current => ({ ...current, ...Object.fromEntries(batch.map(sourcePath => {
            const identity = sourcePathIdentity(sourcePath);
            return [identity, returned[identity] || { ...(current[identity] || { count: 0, files: [], truncated: false }), loading: false, error: result.error || '无法读取文件夹' }];
          })) }));
        } catch (error) {
          if (!active) return;
          const message = error instanceof Error ? error.message : String(error);
          setFolderPreviews(current => ({ ...current, ...Object.fromEntries(batch.map(sourcePath => {
            const identity = sourcePathIdentity(sourcePath);
            return [identity, { ...(current[identity] || { count: 0, files: [], truncated: false }), loading: false, error: message }];
          })) }));
        }
      }
    })();
    return () => { active = false; };
  }, [expandedFoldersKey, folderPathsKey, previewExtensionsKey]);

  const choose = async (chooser: (() => void | Promise<void>) | undefined) => {
    if (!chooser) return;
    setSelectionError('');
    try { await chooser(); }
    catch (error) { setSelectionError(error instanceof Error ? error.message : String(error || '选择来源失败')); }
  };

  const append = (nextPaths: readonly string[]) => onChange(mergeSourcePaths(normalizedPaths, nextPaths).slice(0, maxPaths));
  const applyPastedPaths = (text = pasteDraft) => {
    const parsed = parseSourcePathText(text);
    if (!parsed.length) return;
    append(parsed);
    setPasteDraft('');
  };
  const acceptDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (disabled || loading || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  };
  const drop = (event: React.DragEvent<HTMLDivElement>) => {
    if (disabled || loading) return;
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    append(Array.from(event.dataTransfer.files).map(file => {
      try { return window.electronAPI.getPathForFile(file); }
      catch { return ''; }
    }));
  };

  return <section className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase text-slate-500">{loading ? '正在读取来源…' : `${title} ${normalizedPaths.length} ${itemLabel}`}</p>
        <p className="mt-1 text-xs text-slate-500">{loading ? '正在建立可处理文件列表' : description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {folderPaths.length > 0 && <button type="button" disabled={loading} onClick={() => setExpandedFolders(allFoldersExpanded ? new Set() : new Set(folderPaths.map(sourcePathIdentity)))} className="dialog-secondary px-3 py-1.5 text-xs disabled:opacity-50">{allFoldersExpanded ? '全部收起' : '展开全部'}</button>}
        {onChooseFolder && <button type="button" disabled={disabled || loading} onClick={() => void choose(onChooseFolder)} className="dialog-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs disabled:opacity-50"><FolderInput size={14}/>{folderButtonLabel}</button>}
        {onChooseFiles && <button type="button" disabled={disabled || loading} onClick={() => void choose(onChooseFiles)} className="dialog-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs disabled:opacity-50"><Plus size={14}/>{fileButtonLabel}</button>}
        <button type="button" disabled={disabled || loading || !normalizedPaths.length} onClick={() => onChange([])} className="dialog-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-600 disabled:opacity-50"><Trash2 size={14}/>清空</button>
      </div>
    </div>

    <div
      onDragEnter={acceptDrop}
      onDragOver={acceptDrop}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }}
      onDrop={drop}
      className={`max-h-64 overflow-y-auto rounded-xl border p-2 transition ${dragActive ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-500/20' : normalizedPaths.length ? 'border-slate-200 bg-slate-50' : 'border-dashed border-slate-300 bg-slate-50/70'}`}
    >
      {!normalizedPaths.length ? <button type="button" disabled={disabled || loading || !onChooseFiles} onClick={() => void choose(onChooseFiles)} className="flex min-h-28 w-full flex-col items-center justify-center gap-2 rounded-lg px-4 text-sm text-slate-500 hover:bg-white disabled:opacity-50"><FolderInput size={24} className="text-slate-400"/><span className="font-semibold">{loading ? '正在读取…' : emptyTitle}</span><span className="text-xs text-slate-400">{dragActive ? '松开即可追加' : emptyDescription}</span></button> : <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        {normalizedPaths.map(sourcePath => {
          const identity = sourcePathIdentity(sourcePath);
          const details = sourcePathDetails(sourcePath, pathKinds[identity]);
          const annotation = pathAnnotations[identity];
          const folder = pathKinds[identity] === 'folder';
          const preview = folderPreviews[identity];
          const expanded = expandedFolders.has(identity);
          return <div key={identity} className="border-b border-slate-100 last:border-0">
            <div className="flex items-center gap-3 px-3 py-2.5">
              <span className="flex h-8 w-10 shrink-0 items-center justify-center rounded-md bg-blue-50 text-[10px] font-bold text-blue-700">{details.badge}</span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-slate-700" title={sourcePath}>{details.name}</span><span className="mt-0.5 block truncate text-[10px] text-slate-400" title={sourcePath}>{annotation || details.parent || sourcePath}</span></span>
              {folder && <span className="shrink-0 text-xs text-slate-500">{preview?.loading ? '正在读取…' : preview?.error ? '读取失败' : preview ? `${preview.count} 个文件${preview.truncated ? '+' : ''}` : '展开后读取'}</span>}
              {folder && <button type="button" aria-expanded={expanded} onClick={() => setExpandedFolders(current => { const next = new Set(current); if (next.has(identity)) next.delete(identity); else next.add(identity); return next; })} aria-label={`${expanded ? '收起' : '展开'} ${details.name}`} title={expanded ? '收起' : '展开'} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><ChevronDown size={14} className={`transition-transform ${expanded ? 'rotate-180' : '-rotate-90'}`}/></button>}
              <button type="button" disabled={disabled || loading} onClick={() => onChange(removeSourcePath(normalizedPaths, sourcePath))} aria-label={`移除 ${details.name}`} title="移除" className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"><X size={14}/></button>
            </div>
            {folder && expanded && <div className="border-t border-slate-100 bg-slate-50/70 px-3 py-1.5">
              {preview?.loading ? <p className="px-2 py-2 text-xs text-slate-400">正在读取文件夹中的媒体文件…</p> : preview?.error ? <p className="px-2 py-2 text-xs text-red-500">{preview.error}</p> : preview?.files.length ? preview.files.map(relativePath => <div key={relativePath} className="flex items-center gap-2 border-b border-slate-100 px-2 py-1.5 last:border-0"><File size={13} className="shrink-0 text-slate-400"/><span className="min-w-0 flex-1 truncate text-xs text-slate-600" title={relativePath}>{relativePath}</span></div>) : <p className="px-2 py-2 text-xs text-slate-400">没有找到匹配的媒体文件</p>}
              {preview?.truncated && <p className="px-2 py-1.5 text-[10px] text-amber-600">文件较多，列表仅显示前 {preview.files.length} 个。</p>}
            </div>}
          </div>;
        })}
      </div>}
    </div>
    {selectionError && <p role="alert" className="text-xs text-red-600">选择来源失败：{selectionError}</p>}

    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <button type="button" aria-expanded={pasteOpen} aria-controls={pastePanelId} onClick={() => setPasteOpen(open => !open)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-bold text-slate-600 hover:bg-slate-50">
        <ChevronDown size={13} className={`shrink-0 transition-transform ${pasteOpen ? 'rotate-180' : '-rotate-90'}`}/>
        <span>批量粘贴路径</span>
      </button>
      {pasteOpen && <div id={pastePanelId} className="border-t border-slate-200 px-3 pb-3">
        <textarea
          value={pasteDraft}
          disabled={disabled || loading}
          onChange={event => setPasteDraft(event.target.value)}
          onPaste={event => {
            const text = event.clipboardData.getData('text/plain');
            if (!text) return;
            event.preventDefault();
            applyPastedPaths(text);
          }}
          placeholder={pastePlaceholder}
          className="mt-3 h-24 w-full resize-y rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 font-mono text-xs text-slate-900 outline-none transition focus:border-blue-500 disabled:opacity-60"
        />
        <div className="mt-2 flex items-center justify-between gap-3"><span className="text-[10px] text-slate-400">粘贴后会立即追加；手动输入可点击右侧按钮。</span><button type="button" disabled={disabled || loading || !parseSourcePathText(pasteDraft).length} onClick={() => applyPastedPaths()} className="dialog-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs disabled:opacity-40"><FileInput size={13}/>添加这些路径</button></div>
      </div>}
    </section>
  </section>;
};
