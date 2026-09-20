import { useLocale } from "../../i18n/react";
import { t } from "../../i18n/runtime";
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
  useLocale();
  const [selectedSources, setSelectedSources] = useState<Record<string, string>>({});
  const folderById = useMemo(() => new Map(folders.map(folder => [folder.id, folder])), [folders]);
  const busyIds = useMemo(() => new Set(busyProgressIds), [busyProgressIds]);
  if (!repairs.length) return null;
  return <section role="alert" className="m-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950">
    <h3 className="flex items-center gap-2 text-sm font-bold">{t("ui.selection.source.needs.confirmation.61882d")}</h3>
    <p className="mt-1 text-xs text-amber-800">{t("ui.choose.the.actual.original.media.source.933f1a")}</p>
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
          <label className="text-xs text-amber-900">{t("ui.actual.source.060dca")}<select aria-label={t("ui.choose.the.actual.source.for.value0.5d1b63", { value0: repair.legacyName })} value={sourceProgressId} disabled={busy} onChange={event => setSelectedSources(current => ({ ...current, [repair.progressId]: event.target.value }))} className="ml-2 rounded border border-amber-300 bg-white px-2 py-1 text-xs disabled:opacity-50">
              <option value="">{t("ui.choose.an.original.media.node.5d0585")}</option>
              {sourceCandidates.map(folder => <option key={folder.id} value={folder.id}>{folder.displayName}</option>)}
            </select>
          </label>
          <button type="button" disabled={!sourceProgressId || busy} onClick={() => onRepair(repair.progressId, sourceProgressId)} className="rounded bg-amber-700 px-3 py-1 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">{busy ? t("ui.repairing.152e3d") : t("ui.confirm.relationship.repair.719587")}</button>
          <button type="button" disabled={busy} onClick={() => onKeepIndependent(repair.progressId)} title={t("ui.keep.as.an.independent.node.and.779385")} className="rounded border border-amber-300 bg-white px-3 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40">{t("ui.keep.as.independent.node.596ceb")}</button>
          {!sourceCandidates.length && <span className="text-xs text-red-700">{t("ui.this.project.has.no.valid.original.c8473d")}</span>}
        </div>
      </div>;
    })}</div>
  </section>;
};
