import { Loader2 } from 'lucide-react';
import type { ProgressFolder } from '../../types';
import { ImportSourceControls, type ImportMaterialKind } from '../../components/ImportSourceControls';
import { defaultMainParentId, isUserVersionKey, nextVersionKeys, normalizeTrackingPolicy, planProgressRootMove, selectableVersionParents, versionKeyMatchesParentKind, versionKeyWithFinalIndex, versionKindForParent, type VersionPanelState, type VersionPanelTaskProgress, type VersionRelationKind } from './versioning-v2-model';

export type VersionProgressDraft = {
  mode: 'create' | 'create-next' | 'import' | 'modify';
  sourceRelativePath: string;
  displayName: string;
  mediaKind: 'image' | 'video';
  relationKind: VersionRelationKind;
  parentProgressId: string;
  trackingEnabled: boolean;
  renameFromParent: boolean;
  copyMissingFromParent: boolean;
  workflowInputProgressIds: string[];
  sourcePaths?: string[];
  deleteSourceAfterImport?: boolean;

  existingProgressId?: string;
  versionKey?: string;
  versionKind?: 'main' | 'branch';
  contextLocked?: boolean;
  targetFolderLocked?: boolean;
};

type VersionProgressPanelProps = {
  draft: VersionProgressDraft;
  folders: ProgressFolder[];
  state?: VersionPanelState;
  progress?: VersionPanelTaskProgress;
  message?: string;
  error?: string;
  namePresets?: string[];
  onChange: (draft: VersionProgressDraft) => void;
  onChooseFiles?: () => void;
  onChooseFolder?: () => void;
  importStep?: 'source' | 'settings';
  onImportStepChange?: (step: 'source' | 'settings') => void;
  onImportKindChange?: (kind: ImportMaterialKind, sourcePaths: string[]) => void;
  onSubmit: () => void;
  onClose: () => void;
};

const stateLabel: Partial<Record<VersionPanelState, string>> = {
  move_confirm: '需要确认移动', processing: '正在处理', waiting_confirmation: '等待确认', result: '操作完成', failure: '处理失败',
};
const fieldClass = 'mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-500';
const folderPrefix = (mediaKind: VersionProgressDraft['mediaKind']) => mediaKind === 'video' ? '视频后期' : '图片后期';
const lastPathPart = (value: string) => value.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() || '项目根目录';
const generatedFolderName = (draft: VersionProgressDraft) => `${folderPrefix(draft.mediaKind)}_${draft.versionKey?.trim() || '—'}${draft.displayName.trim() ? `_${draft.displayName.trim()}` : ''}`;

const Callout = ({ tone = 'info', title, children }: { tone?: 'info' | 'success' | 'warning' | 'danger'; title: string; children: React.ReactNode }) => {
  const toneClass = tone === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : tone === 'warning' ? 'border-amber-200 bg-amber-50 text-amber-800' : tone === 'danger' ? 'border-red-200 bg-red-50 text-red-800' : 'border-blue-200 bg-blue-50 text-blue-800';
  return <div className={`rounded-xl border px-4 py-3 ${toneClass}`}><b className="text-sm">{title}</b><div className="mt-1 text-xs leading-5 opacity-80">{children}</div></div>;
};
const Card = ({ title, meta, children }: { title?: string; meta?: string; children: React.ReactNode }) => <section className="rounded-xl border border-slate-200 bg-white p-4">{(title || meta) && <div className="mb-3 flex items-center justify-between gap-3"><b className="text-sm text-slate-800">{title}</b>{meta && <span className="text-[11px] text-slate-400">{meta}</span>}</div>}{children}</section>;

export const VersionProgressPanel = ({ draft, folders, state = 'ready', progress, message, error, namePresets = [], onChange, onChooseFiles, onChooseFolder, importStep = 'source', onImportStepChange, onImportKindChange, onSubmit, onClose }: VersionProgressPanelProps) => {
  const restrictedNode = draft.relationKind === 'auxiliary';
  const policy = normalizeTrackingPolicy(draft.relationKind, draft);
  const parents = selectableVersionParents(folders, { ...draft, relationKind: 'main' });
  const parent = parents.find(folder => folder.id === draft.parentProgressId);
  const movePlan = planProgressRootMove(draft.sourceRelativePath);
  const requiresMove = draft.mode !== 'create' && draft.mode !== 'modify' && movePlan.requiresMove;
  const busy = state === 'processing';
  const update = (patch: Partial<VersionProgressDraft>) => onChange({ ...draft, ...patch });
  const updatePolicy = (patch: Partial<Pick<VersionProgressDraft, 'trackingEnabled' | 'renameFromParent' | 'copyMissingFromParent'>>) => update(normalizeTrackingPolicy(draft.relationKind, { ...policy, ...patch }));
  const targetName = lastPathPart(draft.sourceRelativePath);
  const versionLabel = `V${draft.versionKey || '—'}`;
  const suggestions = nextVersionKeys(folders, draft.mediaKind, parent, draft.existingProgressId);
  const versionKind = draft.versionKind || versionKindForParent(draft.versionKey, parent);
  const suggestedVersionKey = versionKind === 'branch' ? suggestions.branch : suggestions.main;
  const suggestedParts = suggestedVersionKey.split('_');
  const versionPrefix = suggestedParts.length > 1 ? `${suggestedParts.slice(0, -1).join('_')}_` : '';
  const normalizedVersionKey = (draft.versionKey || '').trim();
  const versionIndex = normalizedVersionKey.split('_').at(-1) || '';
  const versionIndexValid = /^[1-9]\d*$/.test(versionIndex);
  const versionFormatValid = versionIndexValid && isUserVersionKey(normalizedVersionKey);
  const versionStructureValid = versionFormatValid && versionKeyMatchesParentKind(normalizedVersionKey, parent, versionKind);
  const versionConflict = versionFormatValid && draft.mode !== 'import' && folders.some(folder => folder.id !== draft.existingProgressId
    && !folder.folderMissing && folder.nodeRole === 'progress' && folder.mediaKind === draft.mediaKind && folder.versionKey === normalizedVersionKey);
  const versionError = !versionFormatValid
    ? '请输入大于 0 的版本序号。'
    : !versionStructureValid
      ? versionKind === 'branch' ? '子分支版本号必须以父版本号开头，例如 V1_2 → V1_2_1。' : '延续版本必须与父版本处于同一分支层级。'
      : versionConflict ? `版本 V${normalizedVersionKey} 已存在。` : '';
  const setCustomVersionIndex = (value: string) => {
    update({ versionKey: versionKeyWithFinalIndex(suggestedVersionKey, value) });
  };
  const setVersionKind = (nextKind: 'main' | 'branch') => {
    const suggestedKey = nextKind === 'branch' ? suggestions.branch : suggestions.main;
    if (nextKind === versionKind && isUserVersionKey(draft.versionKey || '')
      && (draft.mode === 'modify' || draft.versionKey === suggestedKey)) return;
    if (nextKind === 'branch' && !parent) return;
    update({
      versionKind: nextKind,
      versionKey: suggestedKey,
    });
  };
  const setParent = (parentProgressId: string) => {
    const nextParent = folders.find(folder => folder.id === parentProgressId);
    const nextSuggestions = nextVersionKeys(folders, draft.mediaKind, nextParent, draft.existingProgressId);
    update({
      parentProgressId,
      versionKey: versionKind === 'branch' ? nextSuggestions.branch : nextSuggestions.main,
    });
  };
  const setMediaKind = (mediaKind: VersionProgressDraft['mediaKind']) => {
    if (mediaKind === draft.mediaKind) return;
    const nextParents = selectableVersionParents(folders, { ...draft, mediaKind, relationKind: 'main' });
    const semanticParentId = defaultMainParentId(folders, [], mediaKind);
    const nextParent = nextParents.find(folder => folder.id === semanticParentId);
    const nextSuggestions = nextVersionKeys(folders, mediaKind, nextParent, draft.existingProgressId);
    update({
      mediaKind,
      parentProgressId: nextParent?.id || '',
      versionKind: nextParent ? versionKind : 'main',
      versionKey: nextParent ? versionKind === 'branch' ? nextSuggestions.branch : nextSuggestions.main : '',
    });
  };
  const noAvailableParents = parents.length === 0;
  const parentSelectionRequired = !parent;
  const resolvedVersionKey = versionStructureValid ? normalizedVersionKey : '';
  const resolvedVersionLabel = `V${resolvedVersionKey || '—'}`;
  const parentVersionLabel = parent?.nodeRole === 'original' ? '原始素材' : parent ? `V${parent.versionKey}` : '';
  const parentLabel = parent ? `${parent.nodeRole === 'original' ? '原始素材' : `V${parent.versionKey}`} · ${parent.displayName}` : '请选择父版本';
  const outputFolderName = draft.targetFolderLocked ? targetName : generatedFolderName({ ...draft, versionKey: resolvedVersionKey });
  const locationLabel = draft.targetFolderLocked
    ? `使用现有文件夹“${targetName}”`
    : draft.mode === 'modify' || draft.mode === 'create-next' && draft.sourceRelativePath
      ? '当前文件夹所在位置'
      : '项目根目录';
  const modeAction = draft.mode === 'import' ? '导入并创建' : draft.mode === 'modify' ? '保存修改' : '创建';
  const versionKindControl = parent ? <fieldset>
    <legend className="text-xs font-semibold text-slate-600">创建方式</legend>
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      <button type="button" aria-pressed={versionKind === 'main'} onClick={() => setVersionKind('main')} className={`rounded-xl border px-3 py-3 text-left transition ${versionKind === 'main' ? 'border-blue-500 bg-blue-50 text-blue-800 ring-1 ring-blue-200' : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:bg-blue-50/40'}`}>
        <b className="block text-sm">{parent.nodeRole === 'original' ? '创建主版本' : '继续当前分支'}</b><span className="mt-1 block text-xs font-semibold tabular-nums">{parentVersionLabel} → V{suggestions.main}</span>
      </button>
      <button type="button" aria-pressed={versionKind === 'branch'} onClick={() => setVersionKind('branch')} className={`rounded-xl border px-3 py-3 text-left transition ${versionKind === 'branch' ? 'border-violet-500 bg-violet-50 text-violet-800 ring-1 ring-violet-200' : 'border-slate-200 bg-white text-slate-600 hover:border-violet-300 hover:bg-violet-50/40'}`}>
        <b className="block text-sm">创建子分支</b><span className="mt-1 block text-xs font-semibold tabular-nums">{parentVersionLabel} → V{suggestions.branch}</span>
      </button>
    </div>
  </fieldset> : <Callout tone="warning" title={noAvailableParents ? '请先标记原始素材' : '请选择父版本'}>{noAvailableParents
    ? '当前媒体类型没有可用来源。请先将一个文件夹标记为原始素材，再创建版本进度。'
    : '选择同媒体类型的原始素材或已有进度后，才能生成延续版本或子分支。'}</Callout>;

  if (state !== 'ready') {
    const totalCount = progress?.totalCount && progress.totalCount > 0 ? progress.totalCount : 0;
    const processedCount = Math.max(0, progress?.processedCount || 0);
    const hasExplicitPercentage = typeof progress?.percentage === 'number' && Number.isFinite(progress.percentage);
    const determinate = hasExplicitPercentage || totalCount > 0;
    const progressValue = Math.min(100, Math.max(0, hasExplicitPercentage
      ? progress.percentage!
      : totalCount ? Math.round(processedCount / totalCount * 100) : 0));
    const progressStatus = totalCount
      ? `${processedCount} / ${totalCount}`
      : progress?.waiting ? '等待后台资源' : '处理中';
    return <div className="space-y-4"><Callout tone={state === 'failure' ? 'danger' : state === 'result' ? 'success' : 'info'} title={stateLabel[state] || state}>{error || message || (busy ? '版本任务正在后台执行；收起面板不会中断任务。' : '版本节点及其自动关系已更新。')}</Callout>{busy && <Card><div className="flex items-center justify-between text-xs font-semibold text-slate-600"><span className="truncate">{progress?.currentName || '正在启动版本任务…'}</span><span className="ml-3 tabular-nums text-blue-600">{determinate ? `${Math.round(progressValue)}%` : progress?.waiting ? '等待中' : '处理中'}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-blue-100">{determinate ? <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${progressValue > 0 ? Math.max(2, progressValue) : 0}%` }}/> : <div className="h-full w-1/3 animate-pulse rounded-full bg-blue-500"/>}</div><p className="mt-2 text-xs text-slate-500">{progressStatus}</p></Card>}<div className="flex justify-end"><button type="button" disabled={busy} onClick={onClose} className="dialog-primary">关闭</button></div></div>;
  }

  if (draft.mode === 'import' && importStep === 'source') {
    return <div className="space-y-4">
      <Callout title="先选择需要导入的来源">选择文件或文件夹并确认导入方式后，再进入进度版本设置。</Callout>
      <ImportSourceControls
        selectionTitle="选择或拖入进度文件/文件夹"
        selectionDescription="可直接拖入多个文件或文件夹"
        selectedPaths={draft.sourcePaths || []}
        onSelectedPathsChange={paths => update({ sourcePaths: paths })}
        onChooseFiles={onChooseFiles || (() => undefined)}
        onChooseFolder={onChooseFolder}
        importKind="progress"
        onImportKindChange={kind => onImportKindChange?.(kind, draft.sourcePaths || [])}
        deleteSourceAfterImport={draft.deleteSourceAfterImport === true}
        onDeleteSourceAfterImportChange={value => update({ deleteSourceAfterImport: value })}
        deleteSourceDescription="复制并验证成功后删除源文件；关闭则保留"


        startLabel="下一步：设置进度"
        onStart={() => onImportStepChange?.('settings')}
      />
    </div>;
  }

  return <div className="space-y-4">
    {draft.mode === 'import' && <Card title="导入来源" meta={`${draft.sourcePaths?.length || 0} 个`}><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs leading-5 text-slate-500">已确认来源；{draft.deleteSourceAfterImport ? '导入验证成功后将删除源文件。' : '将复制到项目内并保留源文件。'}</p><button type="button" onClick={() => onImportStepChange?.('source')} className="dialog-secondary">返回重新选择</button></div></Card>}
    {requiresMove && <Callout tone="warning" title="所选文件夹将移动到项目根目录">登记前会预检并移动到“{movePlan.targetRelativePath}”。快捷方式或外部目录不能移动或覆盖。</Callout>}
    {draft.mode === 'modify' && <Callout title={`修改 ${versionLabel}`}>保存时会同步更新版本关系和文件夹名称。</Callout>}
    {restrictedNode && <Callout tone="warning" title="辅助节点不参与版本跟踪">选片、预览和协作节点不参与版本跟踪传播。</Callout>}
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
    <Card title={draft.mode === 'modify' ? '版本关系' : '创建版本'}>
      <div className="space-y-4">
        <div>
          <p className="text-xs font-semibold text-slate-600">父版本</p>
          {draft.contextLocked ? <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3"><b className="block text-sm text-slate-800">{parentLabel}</b><span className="mt-1 block text-xs text-slate-400">从版本树发起，媒体类型和父版本已锁定</span></div> : <select aria-label="父版本" className={fieldClass} value={draft.parentProgressId} onChange={event => setParent(event.target.value)}><option value="" disabled>{noAvailableParents ? '没有可用父版本' : '请选择父版本'}</option>{parents.map(folder => <option key={folder.id} value={folder.id}>{folder.nodeRole === 'original' ? `原始素材 · ${folder.displayName}` : `V${folder.versionKey} · ${folder.displayName}`}</option>)}</select>}
        </div>
        {!draft.contextLocked && draft.mode !== 'modify' && <fieldset><legend className="text-xs font-semibold text-slate-600">媒体类型</legend><div className="mt-2 grid grid-cols-2 gap-2"><button type="button" aria-pressed={draft.mediaKind === 'image'} onClick={() => setMediaKind('image')} className={`h-10 rounded-lg border text-sm font-semibold ${draft.mediaKind === 'image' ? 'border-blue-500 bg-blue-50 text-blue-700 ring-1 ring-blue-200' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>图片</button><button type="button" aria-pressed={draft.mediaKind === 'video'} onClick={() => setMediaKind('video')} className={`h-10 rounded-lg border text-sm font-semibold ${draft.mediaKind === 'video' ? 'border-blue-500 bg-blue-50 text-blue-700 ring-1 ring-blue-200' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>视频</button></div></fieldset>}
        {versionKindControl}
        <label className="block text-xs font-semibold text-slate-600">版本序号
          <span className={`mt-1 flex h-10 overflow-hidden rounded-lg border bg-white transition focus-within:ring-2 ${versionError ? 'border-red-400 focus-within:border-red-500 focus-within:ring-red-100' : 'border-slate-300 focus-within:border-blue-500 focus-within:ring-blue-100'}`}><span className="flex items-center border-r border-slate-200 bg-slate-50 px-3 text-sm font-bold tabular-nums text-slate-500">V{versionPrefix}</span><input aria-label="版本序号" className="min-w-0 flex-1 px-3 text-sm font-semibold tabular-nums text-slate-800 outline-none" value={versionIndex} inputMode="numeric" pattern="[0-9]*" placeholder={suggestedParts.at(-1) || '1'} onChange={event => setCustomVersionIndex(event.target.value)}/></span>
          {versionError ? <span className="mt-1.5 block text-xs font-normal text-red-500">{versionError}</span> : <span className="mt-1.5 block text-xs font-normal text-slate-400">只需填写最后一段数字；系统会自动补全为 V{normalizedVersionKey}。</span>}
        </label>
        <label className="block text-xs font-semibold text-slate-600">文件夹名称<input aria-label="文件夹名称" className={fieldClass} value={draft.displayName} placeholder="例如 精修" onChange={event => update({ displayName: event.target.value, targetFolderLocked: false })}/>{namePresets.length > 0 && <span className="mt-2 flex flex-wrap gap-2">{namePresets.map(name => <button key={name} type="button" onClick={() => update({ displayName: name, targetFolderLocked: false })} className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700 transition hover:border-blue-400 hover:bg-blue-100">{name}</button>)}</span>}</label>
        <div className="rounded-xl border border-blue-200 bg-blue-50/70 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold text-blue-600">{draft.mode === 'modify' ? '修改后' : draft.targetFolderLocked ? '当前文件夹' : '将创建'}</p><p className="mt-1 text-base font-bold text-slate-900">{resolvedVersionLabel} · {outputFolderName}</p></div><span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-blue-700 shadow-sm">{versionKind === 'branch' ? '子分支' : parent?.nodeRole === 'original' ? '主版本' : parent ? '继续当前分支' : '等待父版本'}</span></div>
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2"><div><dt className="text-slate-400">父版本</dt><dd className="mt-0.5 font-semibold text-slate-700">{parentLabel}</dd></div><div><dt className="text-slate-400">位置</dt><dd className="mt-0.5 font-semibold text-slate-700">{locationLabel}</dd></div></dl>
        </div>
      </div>
    </Card>
    <Card title="版本跟踪">
      <label className={`flex gap-3 ${restrictedNode ? 'opacity-50' : ''}`}><input type="checkbox" className="mt-0.5" checked={policy.trackingEnabled} disabled={restrictedNode} onChange={event => updatePolicy({ trackingEnabled: event.target.checked })}/><span><b className="block text-sm text-slate-700">启用版本跟踪</b><small className="mt-0.5 block text-xs leading-5 text-slate-400">检测当前文件夹的媒体变化，并在需要时确认图片对应关系。</small></span></label>
      <div className={`mt-3 border-t border-slate-100 pt-3 ${!policy.trackingEnabled || restrictedNode ? 'opacity-50' : ''}`}><div>{([['renameFromParent', '沿用上一版本文件名', '开启后会重新检查已有匹配；确认关联后使用父版本媒体文件名。'], ['copyMissingFromParent', '补齐缺失媒体', '父版本新增媒体后，此版本会变成“待刷新”。']] as const).map(([key, title, help], index) => <label key={key} className={`flex gap-3 py-3 first:pt-0 last:pb-0 ${index ? 'border-t border-slate-100' : ''}`}><input type="checkbox" className="mt-0.5" checked={policy[key]} disabled={!policy.trackingEnabled || restrictedNode} onChange={event => updatePolicy({ [key]: event.target.checked })}/><span><b className="block text-sm text-slate-700">{title}</b><small className="mt-0.5 block text-xs leading-5 text-slate-400">{help}</small></span></label>)}</div></div>
    </Card>
    </div>
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 pt-4"><span className="mr-auto max-w-xl text-xs leading-5 text-slate-400">版本前缀由父版本和创建方式生成，只需调整最后一段数字；名称更改时会同步更新文件夹名。</span><button type="button" disabled={busy} onClick={onClose} className="dialog-secondary">取消</button><button type="button" disabled={busy || Boolean(versionError) || !resolvedVersionKey || parentSelectionRequired || (draft.mode === 'import' && !draft.sourcePaths?.length)} onClick={onSubmit} className="dialog-primary inline-flex items-center gap-2">{busy && <Loader2 size={15} className="animate-spin"/>}{requiresMove ? '继续并检查移动' : `${modeAction} ${resolvedVersionLabel}`}</button></div>
  </div>;
};
