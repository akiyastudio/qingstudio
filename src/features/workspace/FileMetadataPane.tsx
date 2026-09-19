import React, { useEffect, useMemo, useState } from 'react';
import { Activity, Aperture, Calendar, Camera, CheckSquare, ChevronDown, ChevronUp, Copy, ExternalLink, FileText, Folder, Gauge, MemoryStick, Ruler, ScanSearch, Timer, Video, Volume2 } from 'lucide-react';
import type { MediaMetadataField, ProjectFileEntry } from '../../types';
import { metadataFieldLabel, metadataGroupLabel } from '../metadata/metadata-labels';
import { WorkspacePanelHeader } from './WorkspacePanelHeader';
import { metadataGroupDependencyKey, reconcileExpandedMetadataGroups } from '../metadata/metadata-pane-model';
import { isFolderLikeEntry } from './file-entry-sort-model';
import { summarizeMultiSelection, type SelectionEntryDetails } from './multi-selection-metadata-model';
import { formatShutterSpeed, pickCaptureDate, pickMetadataValue } from './project-workspace-media-metadata';

const IMPORTANT_METADATA_ICONS: Record<string, typeof Camera> = {
  相机: Camera, 镜头: ScanSearch, 拍摄时间: Calendar, 尺寸: Ruler, 光圈: Aperture, 快门: Timer, ISO: Gauge, 焦距: ScanSearch,
  编码: Video, 帧率: Activity, 时长: Timer, 码率: Gauge, 音频: Volume2,
};

const MetadataRow = ({ label, sourceLabel, value }: { label: string; sourceLabel?: string; value: React.ReactNode }) => <div className="grid grid-cols-[minmax(76px,38%)_minmax(0,1fr)] gap-3 border-b border-slate-100 py-2 last:border-b-0"><dt title={sourceLabel} className="break-words text-[11px] font-medium text-slate-400">{label}</dt><dd className="select-text break-words text-xs leading-5 text-slate-700">{value}</dd></div>;

const formatSelectionTimeRange = (earliest?: number, latest?: number) => {
  if (!earliest || !latest) return undefined;
  const first = new Date(earliest).toLocaleString();
  const last = new Date(latest).toLocaleString();
  return earliest === latest ? first : `${first} 至 ${last}`;
};

const formatMediaDuration = (seconds?: number) => {
  if (!seconds || !Number.isFinite(seconds)) return '—';
  const wholeSeconds = Math.round(seconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainingSeconds = wholeSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
    : `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
};

export const FileMetadataPane = ({ panelOrder, entry, selectedEntries, selectionEntryDetails, selectionEntryDetailsLoading, entryDetails, metadataFields, metadataLoading, metadataError, technicalMetadata, formatFileSize, width, pinned, onTogglePinned, onOpen, onCopyPath, onClose }: {
  entry?: ProjectFileEntry;
  selectedEntries: readonly ProjectFileEntry[];
  selectionEntryDetails: Readonly<Record<string, SelectionEntryDetails | undefined>>;
  selectionEntryDetailsLoading: boolean;
  entryDetails: { size: number; createdAt: number; updatedAt: number; fileCount: number; folderCount: number } | null;
  metadataFields: readonly MediaMetadataField[];
  metadataLoading: boolean;
  metadataError: string;
  technicalMetadata: { width?: number; height?: number; duration?: number; unavailable?: boolean };
  formatFileSize: (size: number) => string;
  width: number;
  pinned: boolean;
  panelOrder?: number;
  onTogglePinned: () => void;
  onOpen: () => void;
  onCopyPath: () => void;
  onClose: () => void;
}) => {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const metadataGroupKey = metadataGroupDependencyKey(metadataFields);
  const multiSelection = selectedEntries.length > 1;
  const selectionSummary = useMemo(() => summarizeMultiSelection(selectedEntries, selectionEntryDetails), [selectedEntries, selectionEntryDetails]);

  useEffect(() => {
    setExpandedGroups(current => reconcileExpandedMetadataGroups(current, entry?.path, metadataGroupKey));
  }, [entry?.path, metadataGroupKey]);

  const mediaType = entry && isFolderLikeEntry(entry) ? '文件夹' : entry?.kind === 'image' ? '图片' : entry?.kind === 'raw' ? 'RAW 图片' : entry?.kind === 'video' ? '视频' : '文件';
  const firstValue = (...names: string[]) => pickMetadataValue(metadataFields, ...names);
  const exactWidth = firstValue('ImageWidth', 'SourceImageWidth', 'ExifImageWidth', 'PixelWidth');
  const exactHeight = firstValue('ImageHeight', 'SourceImageHeight', 'ExifImageHeight', 'PixelHeight');
  const compositeDimensionMatch = firstValue('ImageSize')?.match(/(\d+)\s*[x×]\s*(\d+)/i);
  const dimensions = exactWidth && exactHeight
    ? `${exactWidth} × ${exactHeight}`
    : compositeDimensionMatch
      ? `${compositeDimensionMatch[1]} × ${compositeDimensionMatch[2]}`
      : technicalMetadata.width && technicalMetadata.height
        ? `${technicalMetadata.width} × ${technicalMetadata.height}`
        : undefined;
  const cameraMake = firstValue('Make');
  const cameraModel = firstValue('Model');
  const camera = cameraMake && cameraModel && cameraModel.toLocaleLowerCase().startsWith(cameraMake.toLocaleLowerCase()) ? cameraModel : [cameraMake, cameraModel].filter(Boolean).join(' ');
  const importantItems = (entry?.kind === 'video' ? [
    ['编码', firstValue('CompressorName', 'VideoCodec', 'Encoder')], ['尺寸', dimensions], ['帧率', firstValue('VideoFrameRate', 'CaptureFrameRate')],
    ['时长', firstValue('Duration') || formatMediaDuration(technicalMetadata.duration)], ['码率', firstValue('AvgBitrate', 'VideoAvgBitrate', 'Bitrate')], ['音频', firstValue('AudioFormat', 'AudioCodec')],
  ] : [
    ['相机', camera], ['镜头', firstValue('LensModel', 'Lens')], ['拍摄时间', pickCaptureDate(metadataFields, 'DateTimeOriginal', 'CreateDate', 'MediaCreateDate', 'TrackCreateDate')], ['尺寸', dimensions],
    ['光圈', firstValue('FNumber', 'Aperture')], ['快门', formatShutterSpeed(firstValue('ExposureTime', 'ShutterSpeed'))], ['ISO', firstValue('ISO')], ['焦距', firstValue('FocalLength')],
  ]).filter((item): item is string[] => Boolean(item[1] && item[1] !== '—'));
  const applicationFields: MediaMetadataField[] = entry ? [
    { group: 'Application', name: '文件名', value: entry.name }, { group: 'Application', name: '媒体类型', value: mediaType },
    ...((entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video') && dimensions ? [{ group: 'Application', name: '像素尺寸', value: dimensions }] : []),
    ...(entry.extension ? [{ group: 'Application', name: '文件格式', value: firstValue('FileType') || entry.extension.replace(/^\./, '').toLocaleUpperCase() }] : []),
    { group: 'Application', name: '大小', value: entryDetails ? formatFileSize(entryDetails.size) : entry.size >= 0 ? formatFileSize(entry.size) : '正在计算…' },
    ...(entryDetails ? [{ group: 'Application', name: '创建时间', value: new Date(entryDetails.createdAt).toLocaleString() }, { group: 'Application', name: '修改时间', value: new Date(entryDetails.updatedAt).toLocaleString() }] : []),
    ...(isFolderLikeEntry(entry) && entryDetails ? [{ group: 'Application', name: '包含', value: `${entryDetails.fileCount} 个文件，${entryDetails.folderCount} 个文件夹` }] : []),
    { group: 'Application', name: '项目内路径', value: entry.relativePath }, { group: 'Application', name: '完整路径', value: entry.path },
  ] : [];
  const groupedMetadata = [...applicationFields, ...metadataFields].reduce((groups, field) => {
    const existing = groups.get(field.group) || [];
    existing.push(field);
    groups.set(field.group, existing);
    return groups;
  }, new Map<string, MediaMetadataField[]>());
  const groupNames = Array.from(groupedMetadata.keys());
  const allExpanded = groupNames.length > 0 && groupNames.every(group => expandedGroups.has(group));
  const toggleGroup = (group: string) => setExpandedGroups(current => {
    const next = new Set(current);
    if (next.has(group)) next.delete(group); else next.add(group);
    return next;
  });
  const selectionSizeLabel = selectionSummary.sizeComplete
    ? formatFileSize(selectionSummary.totalSize)
    : selectionEntryDetailsLoading
      ? selectionSummary.totalSize > 0 ? `至少 ${formatFileSize(selectionSummary.totalSize)}（计算中）` : '正在计算…'
      : selectionSummary.totalSize > 0 ? `至少 ${formatFileSize(selectionSummary.totalSize)}` : '无法完整计算';
  const selectionContainedLabel = selectionSummary.selectedFolderCount
    ? selectionEntryDetailsLoading && !selectionSummary.sizeComplete
      ? '正在统计文件夹内容…'
      : `${selectionSummary.sizeComplete ? '' : '至少 '}${selectionSummary.containedFileCount} 个文件，${selectionSummary.selectedFolderCount + selectionSummary.containedFolderCount} 个文件夹`
    : `${selectionSummary.selectedFileCount} 个文件`;
  const selectionCreatedRange = formatSelectionTimeRange(selectionSummary.earliestCreatedAt, selectionSummary.latestCreatedAt);
  const selectionUpdatedRange = formatSelectionTimeRange(selectionSummary.earliestUpdatedAt, selectionSummary.latestUpdatedAt);

  return <aside data-workspace-panel="metadata" style={{ width, order: panelOrder }} className="flex min-h-0 shrink-0 flex-col bg-white">
    <WorkspacePanelHeader id="metadata" label="详细信息" subtitle={multiSelection ? `已选择 ${selectionSummary.selectedCount} 个项目` : entry?.name || '文件信息'} pinned={pinned} onTogglePinned={onTogglePinned} onClose={onClose}/>
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      {multiSelection ? <>
        <section className="grid grid-cols-2 gap-1.5 py-2">{([
          ['已选项目', String(selectionSummary.selectedCount), CheckSquare], ['合计大小', selectionSizeLabel, MemoryStick],
          ['文件', String(selectionSummary.selectedFileCount), FileText], ['文件夹', String(selectionSummary.selectedFolderCount), Folder],
        ] as const).map(([label, value, Icon]) => <div key={label} className="min-w-0 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2"><p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400"><Icon size={12}/>{label}</p><p title={value} className="mt-1 truncate text-xs font-semibold text-slate-700">{value}</p></div>)}</section>
        <div className="border-b border-slate-200 py-2 text-[11px] text-slate-400">多选汇总信息</div>
        <section className="border-b border-slate-200"><div className="flex w-full items-center gap-2 py-2.5 text-left"><CheckSquare size={13} className="text-slate-400"/><span className="text-xs font-bold text-slate-700">所选内容</span><span className="ml-auto text-[10px] text-slate-400">{[selectionCreatedRange, selectionUpdatedRange].filter(Boolean).length + 6}</span></div><dl className="pb-2">
          <MetadataRow label="选中" value={`${selectionSummary.selectedCount} 个项目`}/><MetadataRow label="包含" value={selectionContainedLabel}/><MetadataRow label="类型" value={selectionSummary.typeSummary || '—'}/><MetadataRow label="文件格式" value={selectionSummary.formatSummary}/><MetadataRow label="合计大小" value={selectionSizeLabel}/><MetadataRow label="所在位置" value={selectionSummary.commonParentPath || '项目根目录'}/>{selectionCreatedRange && <MetadataRow label="创建时间" value={selectionCreatedRange}/>} {selectionUpdatedRange && <MetadataRow label="修改时间" value={selectionUpdatedRange}/>}</dl></section>
        <div className="flex flex-col gap-2 py-4"><button type="button" onClick={onCopyPath} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"><Copy size={14}/>复制 {selectionSummary.selectedCount} 个项目地址</button></div>
      </> : !entry ? <div className="py-12 text-center"><FileText size={34} strokeWidth={1.4} className="mx-auto text-slate-300"/><p className="mt-3 text-sm text-slate-400">选择文件或文件夹后显示详细信息</p></div> : <>
        {importantItems.length > 0 && <section className="grid grid-cols-2 gap-1.5 py-2">{importantItems.map(([label, value]) => { const Icon = IMPORTANT_METADATA_ICONS[label] || FileText; return <div key={label} className="min-w-0 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2"><p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400"><Icon size={12}/>{label}</p><p title={value} className="mt-1 truncate text-xs font-semibold text-slate-700">{value}</p></div>; })}</section>}
        <div className="flex items-center justify-between border-b border-slate-200 py-2"><span className="text-[11px] text-slate-400">{metadataLoading ? '正在读取详细信息…' : `${metadataFields.length + applicationFields.length} 个字段`}</span>{groupNames.length > 1 && <button type="button" onClick={() => setExpandedGroups(allExpanded ? new Set() : new Set(groupNames))} className="text-[11px] font-bold text-blue-500 hover:text-blue-400">{allExpanded ? '全部折叠' : '全部展开'}</button>}</div>
        {metadataError && <p className="my-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-xs text-red-600">{metadataError}</p>}
        {groupNames.map(group => { const fields = groupedMetadata.get(group) || []; const expanded = expandedGroups.has(group); return <section key={group} className="border-b border-slate-200"><button type="button" onClick={() => toggleGroup(group)} className="flex w-full items-center gap-2 py-2.5 text-left"><span className="text-slate-400">{expanded ? <ChevronUp size={13}/> : <ChevronDown size={13}/>}</span><span className="text-xs font-bold text-slate-700">{metadataGroupLabel(group)}</span><span className="ml-auto text-[10px] text-slate-400">{fields.length}</span></button>{expanded && <dl className="pb-2">{fields.map((field, index) => <MetadataRow key={`${group}:${field.name}:${index}`} label={metadataFieldLabel(field.name)} sourceLabel={field.name} value={field.value}/>)}</dl>}</section>; })}
        <div className="flex flex-col gap-2 py-4"><button type="button" onClick={onOpen} className="inline-flex items-center justify-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-500"><ExternalLink size={14}/>外部打开</button><button type="button" onClick={onCopyPath} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"><Copy size={14}/>复制文件地址</button></div>
      </>}
    </div>
  </aside>;
};
