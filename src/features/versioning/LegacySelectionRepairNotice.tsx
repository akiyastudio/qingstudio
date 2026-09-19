import { useMemo, useState } from 'react';
import type { LegacySelectionRelationRepair, ProgressFolder } from '../../types';

type LegacySelectionRepairNoticeProps = {
  repairs: LegacySelectionRelationRepair[];
  folders: ProgressFolder[];
  busyProgressIds?: string[];
  onRepair: (progressId: string, sourceProgressId: string) => void;
  onKeepIndependent: (progressId: string) => void;
};

export const LegacySelectionRepairNotice = ({ repairs, folders, busyProgressIds = [], onRepair, onKeepIndependent }: LegacySelectionRepairNoticeProps) => {
  const [selectedSources, setSelectedSources] = useState<Record<string, string>>({});
  const folderById = useMemo(() => new Map(folders.map(folder => [folder.id, folder])), [folders]);
  const busyIds = useMemo(() => new Set(busyProgressIds), [busyProgressIds]);
  if (!repairs.length) return null;
  return <section role="alert" className="m-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950">
    <h3 className="flex items-center gap-2 text-sm font-bold">选片来源待确认</h3>
    <p className="mt-1 text-xs text-amber-800">请选择真实的原始素材来源；如果该项目确实没有来源，可保留为独立节点。两种操作都不会移动、合并或删除物理文件夹。</p>
    <div className="mt-3 space-y-2">{repairs.map(repair => {
      const legacy = folderById.get(repair.progressId);
      const sourceCandidates = folders.filter(folder => folder.nodeRole === 'original' && !folder.folderMissing && folder.mediaKind === legacy?.mediaKind);
      const suggestedSourceIds = [...new Set(repair.candidateIds.flatMap(id => {
        const candidate = folderById.get(id);
        return candidate?.nodeRole === 'selection' && candidate.parentProgressId ? [candidate.parentProgressId] : [];
      }))].filter(id => sourceCandidates.some(folder => folder.id === id));
      const legalSourceIds = new Set(sourceCandidates.map(folder => folder.id));
      const selectedSourceId = selectedSources[repair.progressId];
      const suggestedSourceId = suggestedSourceIds.length === 1 ? suggestedSourceIds[0] : '';
      const sourceProgressId = selectedSourceId && legalSourceIds.has(selectedSourceId) ? selectedSourceId : suggestedSourceId;
      const busy = busyIds.has(repair.progressId);
      const reason = repair.reason === 'selection_already_exists'
        ? `已经存在现代选片节点，同时还发现旧“${repair.legacyName}”；不能静默覆盖或删除。`
        : repair.reason === 'source_ambiguous'
          ? `存在多个可能的“${repair.expectedSourceName}”来源，无法自动判断。`
          : `缺少预期的“${repair.expectedSourceName}”原始素材来源。`;
      return <div key={repair.progressId} data-legacy-selection-repair={repair.reason} className="rounded-lg border border-amber-200 bg-white/80 p-3">
        <p className="text-sm font-medium">{reason}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="text-xs text-amber-900">真实来源
            <select aria-label={`选择 ${repair.legacyName} 的真实来源`} value={sourceProgressId} disabled={busy} onChange={event => setSelectedSources(current => ({ ...current, [repair.progressId]: event.target.value }))} className="ml-2 rounded border border-amber-300 bg-white px-2 py-1 text-xs disabled:opacity-50">
              <option value="">请选择原始素材节点</option>
              {sourceCandidates.map(folder => <option key={folder.id} value={folder.id}>{folder.displayName}</option>)}
            </select>
          </label>
          <button type="button" disabled={!sourceProgressId || busy} onClick={() => onRepair(repair.progressId, sourceProgressId)} className="rounded bg-amber-700 px-3 py-1 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">{busy ? '修复中…' : '确认修复关系'}</button>
          <button type="button" disabled={busy} onClick={() => onKeepIndependent(repair.progressId)} title="保留为独立节点，不再提示。" className="rounded border border-amber-300 bg-white px-3 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40">保留为独立节点</button>
          {!sourceCandidates.length && <span className="text-xs text-red-700">当前项目没有同媒体类型的有效原始素材节点。</span>}
        </div>
      </div>;
    })}</div>
  </section>;
};
