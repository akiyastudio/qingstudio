import { selectionTypeLabel, selectionFormatLabel, shutterSpeedLabel } from '../../i18n/metadata-values';
import { renderText } from '../../i18n/messages';
import { LocalizedText } from "../../i18n/LocalizedText";
import { getLocale } from "../../i18n/runtime";
import { metadataFieldLabel, metadataGroupLabel } from "../../i18n/built-in-labels";
import { useLocale } from "../../i18n/react";
import { t } from "../../i18n/runtime";
import React, { useEffect, useMemo, useState } from 'react';
import { Activity, Aperture, Calendar, Camera, CheckSquare, ChevronDown, ChevronUp, Copy, ExternalLink, FileText, Folder, Gauge, MemoryStick, Ruler, ScanSearch, Timer, Video, Volume2 } from 'lucide-react';
import type { MediaMetadataField, ProjectFileEntry } from '../../types';

import { WorkspacePanelHeader } from './WorkspacePanelHeader';
import { metadataGroupDependencyKey, reconcileExpandedMetadataGroups } from '../metadata/metadata-pane-model';
import { isFolderLikeEntry } from './file-entry-sort-model';
import { summarizeMultiSelection, type SelectionEntryDetails } from './multi-selection-metadata-model';
import { formatShutterSpeed, pickCaptureDate, pickMetadataValue } from './project-workspace-media-metadata';

const IMPORTANT_METADATA_ICONS: Record<string, typeof Camera> = {
  相机: Camera, 镜头: ScanSearch, 拍摄时间: Calendar, 尺寸: Ruler, 光圈: Aperture, 快门: Timer, ISO: Gauge, 焦距: ScanSearch,
  编码: Video, 帧率: Activity, 时长: Timer, 码率: Gauge, 音频: Volume2,
};

const MetadataRow = ({ label, sourceLabel, value }: { label: string; sourceLabel?: string; value: React.ReactNode }) => <div className="grid grid-cols-[minmax(76px,38%)_minmax(0,1fr)] gap-3 border-b border-slate-100 py-2 last:border-b-0"><dt title={sourceLabel} className="break-words text-[11px] font-medium text-slate-400">{renderText(label)}</dt><dd className="select-text break-words text-xs leading-5 text-slate-700">{value}</dd></div>;

const formatSelectionTimeRange = (earliest?: number, latest?: number) => {
  if (!earliest || !latest) return undefined;
  const first = new Date(earliest).toLocaleString(getLocale());
  const last = new Date(latest).toLocaleString(getLocale());
  return earliest === latest ? first : t('metadata.dateRange', { first, last });
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
  useLocale();
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
    ['光圈', firstValue('FNumber', 'Aperture')], ['快门', shutterSpeedLabel(formatShutterSpeed(firstValue('ExposureTime', 'ShutterSpeed')))], ['ISO', firstValue('ISO')], ['焦距', firstValue('FocalLength')],
  ]).filter((item): item is string[] => Boolean(item[1] && item[1] !== '—'));
  const applicationFields: MediaMetadataField[] = entry ? [
    { group: 'Application', name: '文件名', value: entry.name }, { group: 'Application', name: '媒体类型', value: renderText(mediaType) },
    ...((entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video') && dimensions ? [{ group: 'Application', name: '像素尺寸', value: dimensions }] : []),
    ...(entry.extension ? [{ group: 'Application', name: '文件格式', value: firstValue('FileType') || entry.extension.replace(/^\./, '').toLocaleUpperCase() }] : []),
    { group: 'Application', name: '大小', value: entryDetails ? formatFileSize(entryDetails.size) : entry.size >= 0 ? formatFileSize(entry.size) : t("legacy.e1fa1bf0cd78") },
    ...(entryDetails ? [{ group: 'Application', name: '创建时间', value: new Date(entryDetails.createdAt).toLocaleString(getLocale()) }, { group: 'Application', name: '修改时间', value: new Date(entryDetails.updatedAt).toLocaleString(getLocale()) }] : []),
    ...(isFolderLikeEntry(entry) && entryDetails ? [{ group: 'Application', name: '包含', value: t('metadata.contents', { files: entryDetails.fileCount, folders: entryDetails.folderCount }) }] : []),
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
      ? selectionSummary.totalSize > 0 ? t('metadata.calculatingSize', { size: formatFileSize(selectionSummary.totalSize) }) : '正在计算…'
      : selectionSummary.totalSize > 0 ? t('metadata.atLeast', { size: formatFileSize(selectionSummary.totalSize) }) : t("legacy.4c9a573981bc");
  const selectionContainedLabel = selectionSummary.selectedFolderCount
    ? selectionEntryDetailsLoading && !selectionSummary.sizeComplete
      ? t("legacy.d208fe74c193")
      : t(selectionSummary.sizeComplete ? 'metadata.contents' : 'metadata.incompleteContents', { files: selectionSummary.containedFileCount, folders: selectionSummary.selectedFolderCount + selectionSummary.containedFolderCount })
    : t('metadata.fileCount', { count: selectionSummary.selectedFileCount });
  const selectionCreatedRange = formatSelectionTimeRange(selectionSummary.earliestCreatedAt, selectionSummary.latestCreatedAt);
  const selectionUpdatedRange = formatSelectionTimeRange(selectionSummary.earliestUpdatedAt, selectionSummary.latestUpdatedAt);

  return <aside data-workspace-panel="metadata" style={{ width, order: panelOrder }} className="flex min-h-0 shrink-0 flex-col bg-white">
    <WorkspacePanelHeader id="metadata" label={t("ui.details.1932da")} subtitle={multiSelection ? t("ui.selected.items.value0.c878b1", { value0: selectionSummary.selectedCount }) : entry?.name || t("ui.file.information.800e19")} pinned={pinned} onTogglePinned={onTogglePinned} onClose={onClose}/>
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      {multiSelection ? <>
        <section className="grid grid-cols-2 gap-1.5 py-2">{([
          [t("ui.selected.items.af5e52"), String(selectionSummary.selectedCount), CheckSquare], [t("ui.total.size.348241"), selectionSizeLabel, MemoryStick],
          [t("ui.file.39932f"), String(selectionSummary.selectedFileCount), FileText], [t("ui.folder.7c7802"), String(selectionSummary.selectedFolderCount), Folder],
        ] as const).map(([label, value, Icon]) => <div key={label} className="min-w-0 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2"><p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400"><Icon size={12}/>{renderText(label)}</p><p title={value} className="mt-1 truncate text-xs font-semibold text-slate-700">{value}</p></div>)}</section>
        <div className="border-b border-slate-200 py-2 text-[11px] text-slate-400">{t("ui.selection.summary.390ca1")}</div>
        <section className="border-b border-slate-200"><div className="flex w-full items-center gap-2 py-2.5 text-left"><CheckSquare size={13} className="text-slate-400"/><span className="text-xs font-bold text-slate-700">{t("ui.selected.contents.e68b94")}</span><span className="ml-auto text-[10px] text-slate-400">{[selectionCreatedRange, selectionUpdatedRange].filter(Boolean).length + 6}</span></div><dl className="pb-2">
          <MetadataRow label={t("ui.selected.45c21a")} value={t('metadata.selectedItems', { count: selectionSummary.selectedCount })}/><MetadataRow label={t("ui.contains.107319")} value={selectionContainedLabel}/><MetadataRow label={t("ui.type.ba4001")} value={selectionTypeLabel(selectionSummary)}/><MetadataRow label={t("ui.file.format.806835")} value={selectionFormatLabel(selectionSummary)}/><MetadataRow label={t("ui.total.size.348241")} value={selectionSizeLabel}/><MetadataRow label={t("ui.location.524859")} value={selectionSummary.commonParentPath || t("ui.project.root.3db07c")}/>{selectionCreatedRange && <MetadataRow label={t("ui.created.07ec86")} value={selectionCreatedRange}/>} {selectionUpdatedRange && <MetadataRow label={t("ui.modified.257bbc")} value={selectionUpdatedRange}/>}</dl></section>
        <div className="flex flex-col gap-2 py-4"><button type="button" onClick={onCopyPath} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"><Copy size={14}/>{t("message.e8d8ae9d62db", { count: selectionSummary.selectedCount })}</button></div>
      </> : !entry ? <div className="py-12 text-center"><FileText size={34} strokeWidth={1.4} className="mx-auto text-slate-300"/><p className="mt-3 text-sm text-slate-400">{t("ui.select.files.or.folders.to.view.334e54")}</p></div> : <>
        {importantItems.length > 0 && <section className="grid grid-cols-2 gap-1.5 py-2">{importantItems.map(([label, value]) => { const Icon = IMPORTANT_METADATA_ICONS[label] || FileText; return <div key={label} className="min-w-0 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2"><p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400"><Icon size={12}/>{label}</p><p title={value} className="mt-1 truncate text-xs font-semibold text-slate-700">{value}</p></div>; })}</section>}
        <div className="flex items-center justify-between border-b border-slate-200 py-2"><span className="text-[11px] text-slate-400">{metadataLoading ? t("ui.loading.details.1b86f5") : t("ui.fields.value0.8a672c", { value0: metadataFields.length + applicationFields.length })}</span>{groupNames.length > 1 && <button type="button" onClick={() => setExpandedGroups(allExpanded ? new Set() : new Set(groupNames))} className="text-[11px] font-bold text-blue-500 hover:text-blue-400">{allExpanded ? t("ui.collapse.all.79f3c0") : t("ui.expand.all.19673b")}</button>}</div>
        {metadataError && <p className="my-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-xs text-red-600"><LocalizedText value={metadataError}/></p>}
        {groupNames.map(group => { const fields = groupedMetadata.get(group) || []; const expanded = expandedGroups.has(group); return <section key={group} className="border-b border-slate-200"><button type="button" onClick={() => toggleGroup(group)} className="flex w-full items-center gap-2 py-2.5 text-left"><span className="text-slate-400">{expanded ? <ChevronUp size={13}/> : <ChevronDown size={13}/>}</span><span className="text-xs font-bold text-slate-700">{metadataGroupLabel(group)}</span><span className="ml-auto text-[10px] text-slate-400">{fields.length}</span></button>{expanded && <dl className="pb-2">{fields.map((field, index) => <MetadataRow key={`${group}:${field.name}:${index}`} label={metadataFieldLabel(field.name)} sourceLabel={field.name} value={field.value}/>)}</dl>}</section>; })}
        <div className="flex flex-col gap-2 py-4"><button type="button" onClick={onOpen} className="inline-flex items-center justify-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-500"><ExternalLink size={14}/>{t("ui.open.externally.5a006a")}</button><button type="button" onClick={onCopyPath} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"><Copy size={14}/>{t("ui.copy.file.path.63c2ec")}</button></div>
      </>}
    </div>
  </aside>;
};
