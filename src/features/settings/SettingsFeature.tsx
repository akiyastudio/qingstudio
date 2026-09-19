import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Folder, FolderOpen, HardDrive, Palette, Trash2, RotateCcw, Settings, Download, Puzzle, Loader2, ExternalLink, AtSign, GripVertical, FileText, CheckCircle2, Video, Image as ImageIcon, GitBranch, ChevronUp, ChevronDown, ShieldCheck, MessageSquareText, LockKeyhole, Plus, X, FileImage, Pencil, Power } from 'lucide-react';
import { BUILT_IN_PROJECT_STATUSES, PROJECT_TOOLBAR_ACTION_IDS, normalizeProgressNamePresets, normalizeProjectCategoryOrder, normalizeWorkspacePaths } from '../../types';
import type { AppConfig, BackupSpaceStatus, BackupStatus, ComponentSettingsPageContribution, ComponentStatus, ProjectToolbarActionId, StorageUsageOverview, WorkspaceProject } from '../../types';
import { ComponentIcon } from '../../components/ComponentIcon';
import { useAppDialog } from '../../components/AppDialogProvider';
import { THIRD_PARTY_SOFTWARE_LICENSES } from '../../licenses/softwareLicenses';
import { VideoSplitView, VideoTranscodeView } from '../tools/ToolViews';
import { normalizeConfiguredSdDeviceRecords, removeConfiguredSdDevice, syncLegacySdMirrors } from '../tools/sd-startup-import-model';
import { MAX_SUBTITLE_FONT_SIZE, MIN_SUBTITLE_FONT_SIZE, normalizeSubtitleFontSize } from '../app/video-player-settings';
import { componentSettingsSectionKey, type ComponentSettingsSection } from './component-settings-page-model';
import { componentCapabilityIsAvailable, componentCapabilityUnavailableMessage } from '../components/component-availability-model';
import { createSettingsSaveCoordinator, patchSettingsDraft, restoredWorkspaceConfig, waitForPersistedSettings } from './restored-workspace-config';
import { reconcileRemoteConfig } from './remote-config-model';
import { useUserFacingToast } from '../app/useUserFacingToast';
import { defaultVideoShortcutBindings, exportVideoShortcuts, formatVideoShortcutChord, importVideoShortcuts, isModifierOnlyVideoShortcutInput, isReservedVideoShortcut, normalizeVideoShortcutBindings, shortcutChord, shortcutInputFromKeyboardEvent, VIDEO_ACTIONS, videoShortcutConflicts } from '../../contracts/video-shortcuts';
import type { VideoActionId } from '../../contracts/video-shortcuts';
import { normalizeMediaCacheSize } from '../app/app-config';
export type BuiltInSettingsSection = 'general' | 'project' | 'privacy' | 'storage' | 'backup' | 'components' | 'import' | 'video' | 'about' | 'feedback';
export type SettingsSection = BuiltInSettingsSection | ComponentSettingsSection;

const SETTINGS_SECTION_LABELS: Record<BuiltInSettingsSection, string> = {
  general: '界面',
  project: '项目',
  import: '导入',
  backup: '存储',
  storage: '存储',
  components: '插件管理',
  video: '视频',
  about: '关于',
  feedback: '问题和建议',
  privacy: '隐私与数据',
};

export const PrivacyConsentPage = ({ onAccept }: { onAccept: (joinExperienceProgram: boolean) => void | Promise<void> }) => (
  <main className="p-8"><h1>照片流开源版</h1><p>本版本采用 Apache 2.0 许可证，不连接官方统计与更新服务。</p><button type="button" onClick={() => void onAccept(false)}>进入工作空间</button></main>
);

const WorkspaceFolderPicker = ({ value, onChange }: { value: string; onChange: (path: string) => void }) => {
  const choose = async () => {
    const result = await window.electronAPI.chooseWorkspaceDirectory(value);
    if (!result.cancelled && result.path) onChange(result.path);
  };
  return <div className="flex gap-2"><div title={value || '需选择工作文件夹'} className="min-w-0 flex-1 truncate rounded-lg border border-slate-200 bg-white px-3 py-2.5 font-mono text-sm text-slate-700">{value || '需选择工作文件夹'}</div><button type="button" onClick={() => void choose()} className="dialog-secondary inline-flex shrink-0 items-center gap-2"><FolderOpen size={16}/>选择文件夹</button></div>;
};

const WorkspaceFoldersPicker = ({ primary, values, onChange }: { primary: string; values: string[]; onChange: (primary: string, paths: string[]) => void }) => {
  const paths = normalizeWorkspacePaths(primary, values);
  const add = async () => {
    const result = await window.electronAPI.chooseWorkspaceDirectory(primary);
    if (result.cancelled || !result.path) return;
    const next = normalizeWorkspacePaths(primary || result.path, [...paths, result.path]);
    onChange(next[0], next);
  };
  const makePrimary = (workspacePath: string) => {
    const next = normalizeWorkspacePaths(workspacePath, paths.filter(item => item.toLocaleLowerCase() !== workspacePath.toLocaleLowerCase()));
    onChange(next[0], next);
  };
  const remove = (workspacePath: string) => {
    const next = paths.filter(item => item.toLocaleLowerCase() !== workspacePath.toLocaleLowerCase());
    if (!next.length) return;
    onChange(next[0], next);
  };
  return <div className="space-y-2">
    {paths.map(workspacePath => { const isPrimary = workspacePath.toLocaleLowerCase() === primary.toLocaleLowerCase(); return <div key={workspacePath.toLocaleLowerCase()} className="flex min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
      <div className="min-w-0 flex-1"><p title={workspacePath} className="truncate font-mono text-sm text-slate-700">{workspacePath}</p>{isPrimary && <p className="mt-0.5 text-[10px] font-bold text-blue-600">默认写入目录</p>}</div>
      {!isPrimary && <button type="button" onClick={() => makePrimary(workspacePath)} className="dialog-secondary shrink-0 text-xs">设为默认</button>}
      <button type="button" disabled={paths.length === 1} onClick={() => remove(workspacePath)} className="rounded-md p-2 text-slate-400 hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-30" aria-label={`移除工作目录 ${workspacePath}`} title="移除"><X size={15}/></button>
    </div>; })}
    <button type="button" onClick={() => void add()} className="dialog-secondary inline-flex items-center gap-2"><Plus size={15}/>添加工作目录</button>
  </div>;
};

const WorkspaceSetupPage = ({ config, onSave }: { config: AppConfig; onSave: (config: AppConfig) => void | Promise<void> }) => {
  const [workspacePath, setWorkspacePath] = useState(config.workspacePath);
  const [recoveryStatus, setRecoveryStatus] = useState<BackupStatus>();
  const [restoringSnapshot, setRestoringSnapshot] = useState('');
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState('');
  const confirm = async () => {
    const selectedPath = workspacePath.trim();
    if (selectedPath) await onSave({ ...config, workspacePath: selectedPath, workspacePaths: [selectedPath] });
  };
  const inspectBackup = async () => {
    if (recoveryBusy) return;
    setRecoveryBusy(true); setRecoveryError('');
    try {
      const selected = await window.electronAPI.chooseBackupTarget(config.backup.targetPath);
      if (selected.cancelled || !selected.path) return;
      await onSave({ ...config, backup: { ...config.backup, enabled: true, targetType: selected.path.startsWith('\\\\') ? 'nas' : 'local', targetPath: selected.path } });
      setRecoveryStatus(await window.electronAPI.getBackupStatus(''));
    } catch (error) { setRecoveryError(`读取备份失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { setRecoveryBusy(false); }
  };
  const restore = async (snapshotId: string) => {
    setRestoringSnapshot(snapshotId);
    try {
      const result = await window.electronAPI.restoreBackupWorkspace('', snapshotId);
      if (result.success && result.workspacePath && result.savedConfig) {
        setWorkspacePath(result.workspacePath);
        await onSave(restoredWorkspaceConfig(result.savedConfig, result.workspacePath, config));
      }
      else if (!result.cancelled) setRecoveryError(result.error || '工作区恢复失败');
    } catch (error) { setRecoveryError(`工作区恢复失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { setRestoringSnapshot(''); }
  };
  return <main className="fixed inset-x-0 bottom-0 top-10 z-40 flex items-center justify-center overflow-auto bg-slate-50 p-8"><section className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"><div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-blue-600"><FolderOpen size={28}/></div><div className="mt-5 text-center"><h1 className="text-2xl font-bold text-slate-900">选择工作文件夹</h1><p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-500">请选择工作文件夹。选择磁盘根目录时，会在磁盘下创建“照片流”文件夹作为工作目录。</p></div><div className="mt-7"><WorkspaceFolderPicker value={workspacePath} onChange={setWorkspacePath}/></div><div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-5"><div><p className="text-sm font-bold text-slate-700">已有 PhotoFlow 备份？</p><p className="mt-1 text-xs text-slate-500">可以直接从完整快照恢复到新的工作文件夹。</p></div><button type="button" disabled={recoveryBusy} onClick={() => void inspectBackup()} className="dialog-secondary inline-flex items-center gap-2 disabled:opacity-50"><ShieldCheck size={15}/>{recoveryBusy ? '正在读取…' : '从备份恢复'}</button></div>{recoveryError && <p role="alert" className="mt-3 text-sm text-red-600">{recoveryError}</p>}{recoveryStatus && <div className="mt-4 max-h-48 space-y-2 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-3">{recoveryStatus.snapshots.map(snapshot => <div key={snapshot.id} className="flex items-center justify-between gap-3 rounded-lg bg-white px-3 py-2"><div><p className="text-sm font-bold text-slate-700">{new Date(snapshot.createdAt).toLocaleString()}</p><p className="mt-0.5 text-xs text-slate-400">{snapshot.projects} 个项目 · {formatStorageSize(snapshot.bytes)}</p></div><button type="button" disabled={Boolean(restoringSnapshot)} onClick={() => void restore(snapshot.id)} className="dialog-primary shrink-0 text-xs disabled:opacity-45">{restoringSnapshot === snapshot.id ? '恢复中…' : '恢复'}</button></div>)}{!recoveryStatus.snapshots.length && <p className="py-4 text-center text-sm text-slate-500">这个位置没有可用快照</p>}</div>}<div className="mt-7 flex justify-end"><button type="button" onClick={() => void confirm()} disabled={!workspacePath.trim()} className="dialog-primary disabled:cursor-not-allowed disabled:opacity-45">开始使用</button></div></section></main>;
};

const formatComponentSize = (sizeBytes: number) => sizeBytes > 0 ? `${(sizeBytes / 1024 / 1024).toFixed(sizeBytes >= 100 * 1024 * 1024 ? 0 : 1)} MB` : '';
const formatStorageSize = (sizeBytes = 0) => sizeBytes >= 1024 ** 3
  ? `${(sizeBytes / 1024 ** 3).toFixed(sizeBytes >= 10 * 1024 ** 3 ? 1 : 2)} GB`
  : sizeBytes > 0 ? `${(sizeBytes / 1024 ** 2).toFixed(0)} MB` : '0 MB';

const STORAGE_ITEM_LABELS: Record<StorageUsageOverview['volumes'][number]['items'][number]['kind'], string> = {
  workspace: '工作区',
  inspiration: '灵感库',
  archive: '归档',
  backup: '备份',
  cache: '缓存和数据',
  internal: '缓存和数据',
};

const STORAGE_VOLUME_ROLE_LABELS: Record<StorageUsageOverview['volumes'][number]['items'][number]['kind'], string> = {
  workspace: '工作区盘',
  inspiration: '灵感库盘',
  archive: '归档盘',
  backup: '备份盘',
  cache: '缓存盘',
  internal: '缓存盘',
};

const StorageVolumeOverview = ({ sourceSignature }: { sourceSignature: string }) => {
  const [overview, setOverview] = useState<StorageUsageOverview>({ success: true, updatedAt: 0, scanning: true, stale: true, volumes: [] });
  const [refreshing, setRefreshing] = useState(false);
  const sourceSignatureRef = useRef(sourceSignature);
  const overviewRequestRef = useRef(0);
  const load = useCallback(async (force = false) => {
    const request = ++overviewRequestRef.current;
    if (force) setRefreshing(true);
    try {
      const next = await window.electronAPI.getStorageUsageOverview(force);
      if (request === overviewRequestRef.current) setOverview(next);
    } catch (error) {
      if (request === overviewRequestRef.current) setOverview(current => ({ ...current, scanning: false, error: error instanceof Error ? error.message : String(error) }));
    } finally { if (force && request === overviewRequestRef.current) setRefreshing(false); }
  }, []);
  useEffect(() => {
    return window.electronAPI.onBackgroundTaskChanged(delta => {
      for (const task of delta.upserts) {
      const invalidatingTaskTypes = new Set(['project-file-operation', 'project-archive', 'project-unarchive', 'workspace-backup', 'backup-cleanup', 'workspace-restore', 'project-restore', 'cache-cleanup', 'deleted-project-cleanup']);
      if (task.type !== 'storage-usage-scan') {
        if (task.state === 'completed' && invalidatingTaskTypes.has(task.type)) void load(false);
        continue;
      }
      if (task.state === 'completed') void load(false);
      else if (task.state === 'failed' || task.state === 'cancelled') setOverview(current => ({ ...current, scanning: false, error: task.error || '存储占用统计未完成' }));
      else setOverview(current => ({ ...current, scanning: true }));
      }
    });
  }, [load]);
  useEffect(() => {
    const sourceChanged = sourceSignatureRef.current !== sourceSignature;
    sourceSignatureRef.current = sourceSignature;
    const timer = window.setTimeout(() => void load(sourceChanged), sourceChanged ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, sourceSignature]);
  return <><div>{overview.error && <p className="mx-4 my-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">{overview.error}</p>}<div className="divide-y divide-slate-200">{overview.volumes.map(volume => {
      const total = Number(volume.totalBytes || 0);
      const free = Number(volume.freeBytes || 0);
      const photoFlow = Number(volume.photoflowBytes || 0);
      const other = Number(volume.otherBytes || 0);
      const percent = (value: number) => total > 0 ? Math.max(0, Math.min(100, value / total * 100)) : 0;
      const roleLabels = [...new Set(volume.items.map(item => STORAGE_VOLUME_ROLE_LABELS[item.kind]))];
      const itemGroups = volume.items.reduce<Array<{ key: string; label: string; bytes: number; measured: boolean }>>((groups, item) => {
        const key = item.kind === 'cache' || item.kind === 'internal' ? 'cache-and-data' : item.kind;
        const existing = groups.find(group => group.key === key);
        if (existing) {
          existing.bytes += item.bytes;
          existing.measured = existing.measured && item.measured;
        } else groups.push({ key, label: STORAGE_ITEM_LABELS[item.kind], bytes: item.bytes, measured: item.measured });
        return groups;
      }, []);
      return <section key={volume.id} className="px-4 py-5"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-bold text-slate-800"><HardDrive size={16} className="text-blue-600"/><span>{volume.label || volume.root}</span><span className="text-xs font-bold text-blue-600">{roleLabels.join(' · ')}</span>{!volume.online && <span className="text-[10px] text-amber-700">离线</span>}</p><p className="mt-1 truncate font-mono text-[11px] text-slate-400" title={volume.root}>{volume.root}</p></div><div className="text-right"><p className="text-sm font-bold text-slate-700">照片流 {overview.updatedAt ? formatStorageSize(photoFlow) : '统计中…'}</p>{total > 0 && <p className="mt-1 text-xs text-slate-500">总容量 {formatStorageSize(total)} · 占磁盘 {percent(photoFlow).toFixed(1)}% · 剩余 {formatStorageSize(free)}</p>}</div></div>{total > 0 && <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-slate-200" title={`照片流 ${formatStorageSize(photoFlow)}；其他文件 ${formatStorageSize(other)}；剩余 ${formatStorageSize(free)}`}><span className="bg-blue-500" style={{ width: `${percent(photoFlow)}%` }}/><span className="bg-slate-400" style={{ width: `${percent(other)}%` }}/></div>}<div className="mt-3 flex flex-wrap gap-x-8 gap-y-2">{itemGroups.map(item => <div key={item.key} className="flex min-w-[180px] flex-1 items-center justify-between gap-4 text-xs"><span className="font-bold text-slate-600">{item.label}</span><span className="shrink-0 font-bold text-slate-600">{item.measured ? formatStorageSize(item.bytes) : '待统计'}</span></div>)}</div></section>;
    })}</div>
      {!overview.volumes.length && <div className="py-8 text-center text-sm text-slate-500">{overview.scanning ? '正在读取磁盘信息…' : '没有可统计的存储位置'}</div>}
    </div>
    <div className="grid min-w-0 gap-4 px-4 py-3.5 md:grid-cols-[minmax(220px,1fr)_minmax(280px,1.25fr)] md:items-center"><div><h4 className="text-sm font-bold text-slate-800">磁盘与照片流占用</h4><p className="mt-1 text-xs leading-5 text-slate-500"></p>{overview.updatedAt > 0 && <p className="mt-1 text-xs text-slate-400">上次统计：{new Date(overview.updatedAt).toLocaleString()}{overview.stale ? ' · 正在后台更新' : ''}</p>}</div><button type="button" onClick={() => void load(true)} disabled={refreshing || overview.scanning} className="dialog-secondary ml-auto inline-flex items-center gap-2 text-xs disabled:opacity-45"><RotateCcw size={14} className={overview.scanning ? 'animate-spin' : undefined}/>{overview.scanning ? '正在统计' : '重新统计'}</button></div>
  </>;
};

const offerPackageCleanup = async ({ appDialog, kind, componentId, label, packageSizeBytes, repairHint, onNotice }: {
  appDialog: ReturnType<typeof useAppDialog>;
  kind: 'component' | 'advanced';
  componentId?: string;
  label: string;
  packageSizeBytes?: number;
  repairHint?: string;
  onNotice: (message: string, duration?: number) => void;
}) => {
  if (!packageSizeBytes) return;
  const size = formatStorageSize(packageSizeBytes);
  if (!await appDialog.confirm({
    title: '删除已使用的安装包吗？',
    message: `${label}已经安装并通过校验。删除原 ZIP 可以立即释放约 ${size} 空间，已安装的功能不会受影响。`,
    detail: repairHint || '以后如需重新安装，需要再次把对应 ZIP 复制到组件目录。',
    confirmLabel: `删除并释放 ${size}`,
    cancelLabel: '保留安装包',
    tone: 'danger',
  })) return;
  const deleted = await window.electronAPI.deleteComponentPackage(kind, componentId);
  if (!deleted.success) {
    onNotice(`删除安装包失败：${deleted.error || '未知错误'}`, 6000);
    return;
  }
  onNotice(`安装包已删除，释放约 ${formatStorageSize(deleted.deletedBytes || packageSizeBytes)}`);
};

const LogSettings = ({ onNotice }: { onNotice: (message: string, duration?: number) => void }) => {
  const appDialog = useAppDialog();
  const [clearing, setClearing] = useState(false);
  const openFolder = async () => {
    const result = await window.electronAPI.openLogsFolder();
    if (!result.success) onNotice(`打开日志文件夹失败：${result.error || '未知错误'}`, 5000);
  };
  const clear = async () => {
    if (clearing || !await appDialog.confirm({
      title: '确定清空全部应用日志吗？',
      message: '此操作无法撤销，只会删除照片流生成的日志文件。',
      confirmLabel: '清空日志',
      tone: 'danger',
    })) return;
    setClearing(true);
    try {
      const result = await window.electronAPI.clearLogs();
      if (!result.success) {
        onNotice(`清空日志失败：${result.error || '未知错误'}`, 5000);
        return;
      }
      onNotice(result.deletedCount ? `已清空 ${result.deletedCount} 个日志文件` : '没有需要清理的日志文件');
    } finally {
      setClearing(false);
    }
  };
  return <SettingsRow title="应用日志" description="用于排查运行异常，默认仅保留最近 7 天；清空只删除照片流生成的日志文件。"><div className="ml-auto flex w-fit flex-wrap gap-2"><button type="button" onClick={() => void openFolder()} className="dialog-secondary inline-flex items-center gap-2"><FolderOpen size={15}/>打开</button><button type="button" onClick={() => void clear()} disabled={clearing} className="inline-flex items-center gap-2 rounded-md border border-red-200 bg-white px-3 py-2 text-sm font-bold text-red-600 hover:bg-red-50 disabled:opacity-50">{clearing ? <Loader2 size={15} className="animate-spin"/> : <Trash2 size={15}/>} {clearing ? '正在清空…' : '清空日志'}</button></div></SettingsRow>;
};

const ComponentSettings = ({ components, installPath, loading, onRefresh, onComponentsChanged, onComponentDataCleared, onNotice }: { components: ComponentStatus[]; installPath: string; loading: boolean; onRefresh: () => void | Promise<void>; onComponentsChanged: () => void | Promise<void>; onComponentDataCleared: (componentId: string) => void | Promise<void>; onNotice: (message: string, duration?: number) => void }) => {
  const appDialog = useAppDialog();
  const [busyId, setBusyId] = useState('');
  const [busyAction, setBusyAction] = useState<'install' | 'toggle' | 'uninstall' | ''>('');
  const openFolder = async (componentId?: string) => {
    const result = await window.electronAPI.openComponentsFolder(componentId);
    if (!result.success) onNotice(`打开组件文件夹失败：${result.error || '未知错误'}`);
  };
  const install = async (component: ComponentStatus) => {
    if (busyId) return;
    setBusyId(component.id);
    setBusyAction('install');
    try {
      const result = await window.electronAPI.installComponent({ componentId: component.id }, async presentation => (
        await appDialog.choice({ ...presentation, cancelLabel: '取消', cancelDefault: true, choices: [{ value: 'install', label: '继续安装' }] })
      ) === 'install');
      if (result.cancelled) return;
      if (!result.success) { onNotice(`安装“${component.name}”失败：${result.error || '未知错误'}；请重试`, 6000); return; }
      onNotice(`已安装“${component.name}”`);
      await offerPackageCleanup({ appDialog, kind: 'component', componentId: component.id, label: `“${component.name}”组件`, packageSizeBytes: result.packageSizeBytes, onNotice });
      await onComponentsChanged();
    } catch (error) {
      onNotice(`安装“${component.name}”失败：${error instanceof Error ? error.message : String(error || '未知错误')}；请重试`, 6000);
    } finally { setBusyId(''); setBusyAction(''); }
  };
  const uninstall = async (component: ComponentStatus) => {
    if (busyId) return;
    const choice = await appDialog.choice({
      title: `确定卸载“${component.name}”吗？`,
      message: '是否同时清空该组件的用户数据和相关缓存？',
      detail: '保留数据便于以后重新安装后继续使用；清空后，组件设置、私有数据和相关缓存将移入系统回收站。',
      choices: [
        { value: 'keep', label: '保留数据并卸载' },
        { value: 'clear', label: '清空数据并卸载', tone: 'danger' },
      ],
      cancelLabel: '取消',
      defaultValue: 'keep',
    });
    if (!choice) return;
    const clearUserData = choice === 'clear';
    setBusyId(component.id);
    setBusyAction('uninstall');
    try {
      const result = await window.electronAPI.uninstallComponent(component.id, { clearUserData });
      if (result.cancelled) { onNotice('已取消卸载', 2500); return; }
      if (!result.success) { onNotice(`卸载“${component.name}”失败：${result.error || '未知错误'}；请重试`, 6000); return; }
      if (clearUserData) await onComponentDataCleared(component.id);
      const cleanupWarning = result.cleanupWarnings?.filter(Boolean).join('；');
      onNotice(cleanupWarning
        ? `已卸载“${component.name}”，但部分数据未能清理：${cleanupWarning}`
        : clearUserData ? `已卸载“${component.name}”并清空用户数据和相关缓存` : `已卸载“${component.name}”，用户数据已保留`, cleanupWarning ? 7000 : 4000);
      await onComponentsChanged();
    } catch (error) {
      onNotice(`卸载“${component.name}”失败：${error instanceof Error ? error.message : String(error || '未知错误')}；请重试`, 6000);
    } finally { setBusyId(''); setBusyAction(''); }
  };
  const setEnabled = async (component: ComponentStatus, enabled: boolean) => {
    if (busyId) return;
    const setComponentEnabled = window.electronAPI?.setComponentEnabled;
    if (typeof setComponentEnabled !== 'function') {
      onNotice('插件管理接口已更新，请完全退出并重新启动应用后再试', 6000);
      return;
    }
    setBusyId(component.id);
    setBusyAction('toggle');
    try {
      const result = await setComponentEnabled(component.id, enabled);
      if (result.cancelled) { onNotice(enabled ? '已取消启用' : '已取消禁用', 2500); return; }
      if (!result.success) { onNotice(`${enabled ? '启用' : '禁用'}“${component.name}”失败：${result.error || '未知错误'}；请重试`, 6000); return; }
      onNotice(enabled ? `已启用“${component.name}”` : `已禁用“${component.name}”；组件文件和用户数据均已保留`);
      await onComponentsChanged();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || '未知错误');
      const requiresRestart = /No handler registered|components-set-enabled|is not a function/i.test(message);
      onNotice(requiresRestart
        ? '插件管理接口已更新，请完全退出并重新启动应用后再试'
        : `${enabled ? '启用' : '禁用'}“${component.name}”失败：${message}；请重试`, 6000);
    } finally { setBusyId(''); setBusyAction(''); }
  };
  return <SettingsPageGroup title="组件安装与卸载">
    <SettingsRow title="组件根目录" description="将预编译 ZIP 放入此目录后，可在对应组件行中安装。"><div className="flex min-w-0 gap-2"><input readOnly value={installPath || '正在读取组件根目录'} className="form-input min-w-0 flex-1 font-mono text-xs"/><button type="button" onClick={() => void onRefresh()} disabled={loading} className="dialog-secondary inline-flex shrink-0 items-center gap-2"><RotateCcw size={15} className={loading ? 'animate-spin' : ''}/>刷新</button><button type="button" onClick={() => void openFolder()} className="dialog-secondary inline-flex shrink-0 items-center gap-2"><FolderOpen size={15}/>打开</button></div></SettingsRow>
    {components.map(component => {
      const stateText = component.enabled === false ? '已禁用'
        : component.status === 'package-invalid' ? '安装包损坏或清单无效'
        : component.status === 'integrity-invalid' ? '完整性校验失败'
          : component.status === 'update-available' ? `可更新至 ${component.packageVersion}`
            : component.source === 'development' ? (component.compatible ? '开发组件' : '开发组件不可用')
              : !component.installed ? (component.compatible ? '待安装' : '不兼容')
                : component.compatible ? '已安装' : '已安装但不可用';
      const busy = busyId === component.id;
      const canUninstall = component.installed && component.source === 'user';
      const canToggle = component.installed && (component.enabled === false || component.compatible);
      const hasInstallablePackage = Boolean(component.source !== 'development' && component.packagePath && (component.packageCompatible ?? component.compatible) && component.status !== 'package-invalid');
      const details = [component.description, stateText, component.version ? `版本 ${component.version}` : '', component.installed ? formatComponentSize(component.sizeBytes) : '', component.error || component.packageError || ''].filter(Boolean).join(' · ');
      return <SettingsRow key={component.id} title={component.name} description={details}><div className="ml-auto flex w-fit items-center gap-2"><button type="button" onClick={() => void openFolder(component.installed ? component.id : undefined)} className="dialog-secondary inline-flex items-center gap-1.5"><FolderOpen size={13}/>目录</button>{hasInstallablePackage && (!component.installed || component.updateAvailable || !component.compatible) && <button type="button" onClick={() => void install(component)} disabled={Boolean(busyId)} className="dialog-primary inline-flex items-center gap-2 disabled:opacity-45">{busy && busyAction === 'install' && <Loader2 size={14} className="animate-spin"/>}{component.updateAvailable ? '更新' : component.installed ? '重新安装' : '安装'}</button>}{canToggle && <button type="button" onClick={() => void setEnabled(component, component.enabled === false)} disabled={Boolean(busyId)} className={`dialog-secondary inline-flex items-center gap-1.5 disabled:opacity-45 ${component.enabled === false ? '!border-emerald-500' : ''}`}>{busy && busyAction === 'toggle' ? <Loader2 size={13} className="animate-spin"/> : <Power size={13}/>} {component.enabled === false ? '启用' : '禁用'}</button>}{canUninstall ? <button type="button" onClick={() => void uninstall(component)} disabled={Boolean(busyId)} className="dialog-secondary inline-flex items-center gap-2 !border-red-200 !text-red-600 hover:!bg-red-50 disabled:opacity-45">{busy && busyAction === 'uninstall' && <Loader2 size={13} className="animate-spin"/>}卸载</button> : component.source === 'development' ? <span className="text-xs font-bold text-amber-600">开发组件</span> : component.installed ? <span className="text-xs text-slate-400">系统组件</span> : null}</div></SettingsRow>;
    })}
    {!loading && !components.length && <SettingsRow title="组件状态" description="组件目录中没有安装包或已安装组件。"><span className="ml-auto block w-fit text-xs text-slate-400">暂无组件</span></SettingsRow>}
  </SettingsPageGroup>;
};

const SettingsNavigator = ({ activeSection, componentPages, onSelect }: { activeSection: SettingsSection; componentPages: ComponentSettingsPageContribution[]; onSelect: (section: SettingsSection) => void }) => {
  const items: Array<{ id: SettingsSection; label: string; description: string; icon: React.ReactNode }> = [
    { id: 'general', label: '界面', description: '配色、标签与首页', icon: <Palette size={18}/> },
    { id: 'project', label: '项目', description: '新建项目与分类', icon: <FolderOpen size={18}/> },
    { id: 'import', label: '导入', description: '默认行为、SD 卡与花絮', icon: <Download size={18}/> },
    { id: 'video', label: '视频', description: '播放按键与视频工具', icon: <Video size={18}/> },
    { id: 'backup', label: '存储', description: '工作目录、归档与工作区备份', icon: <HardDrive size={18}/> },
    { id: 'components', label: '插件管理', description: '安装与卸载可选插件', icon: <Puzzle size={18}/> },
    ...componentPages.map(page => ({ id: componentSettingsSectionKey(page), label: page.label, description: page.pageTitle, icon: <ComponentIcon src={page.iconUrl} size={18}/> })),
  ];
  const renderItem = (item: typeof items[number]) => <button key={item.id} type="button" aria-current={activeSection === item.id ? 'page' : undefined} onClick={() => onSelect(item.id)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition ${activeSection === item.id ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}><span className={`shrink-0 ${activeSection === item.id ? 'text-blue-600' : 'text-slate-400'}`}>{item.icon}</span><span className="min-w-0 truncate text-sm font-bold">{item.label}</span></button>;
  return <nav aria-label="设置分类" className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-3">
    <div className="flex items-center gap-2 px-3 pb-3 pt-2 text-sm font-bold text-slate-800"><Settings size={17} className="text-blue-600"/>设置</div>
    <div className="space-y-1">{items.map(renderItem)}</div>
    <div className="mt-3 space-y-1 border-t border-slate-200 pt-3">
      {renderItem({ id: 'about', label: '关于', description: '版本、项目与开源许可', icon: <AtSign size={18}/> })}
      {renderItem({ id: 'feedback', label: '问题和建议', description: '向开发者发送反馈', icon: <MessageSquareText size={18}/> })}
      {renderItem({ id: 'privacy', label: '隐私与数据', description: '本地数据与开源版说明', icon: <ShieldCheck size={18}/> })}
    </div>
  </nav>;
};

const PROJECT_TOOLBAR_ITEMS: Record<ProjectToolbarActionId, { label: string; description: string; icon: React.ReactNode }> = {
  'filename-selection': { label: '从文件名选片', description: '按文件名把选中的素材整理到选片文件夹', icon: <FileText size={17}/> },
  'select-media': { label: '选片', description: '把当前选择的图片或视频加入选片结果', icon: <CheckCircle2 size={17}/> },
  'video-tools': { label: '视频工具', description: '截取分镜帧、视频转码和视频切割', icon: <Video size={17}/> },
  'image-tools': { label: '图片工具', description: '图片转 JPG 和提取截图主图', icon: <ImageIcon size={17}/> },
  photoshop: { label: '用 Photoshop 打开', description: '用 Photoshop 打开所选图片、RAW 或 PSD/PSB', icon: <span className="flex h-[17px] w-[17px] items-center justify-center rounded border border-blue-400 text-[9px] font-bold text-blue-600">Ps</span> },
  'office-extract': { label: 'Office 文档', description: '提取文档图片及扩展工具菜单', icon: <FileImage size={17}/> },
  'version-management': { label: '版本管理', description: '管理素材版本或标记文件夹用途', icon: <GitBranch size={17}/> },
};

const ProjectToolbarSettingsEditor = ({ value, onChange }: { value: AppConfig['projectToolbar']; onChange: (value: AppConfig['projectToolbar']) => void }) => {
  const [draggedId, setDraggedId] = useState<ProjectToolbarActionId>();
  const hidden = new Set(value.hidden);
  const reorder = (source: ProjectToolbarActionId, target: ProjectToolbarActionId) => {
    if (source === target) return;
    const next = [...value.order];
    const sourceIndex = next.indexOf(source);
    const targetIndex = next.indexOf(target);
    if (sourceIndex < 0 || targetIndex < 0) return;
    next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, source);
    onChange({ ...value, order: next });
  };
  const move = (id: ProjectToolbarActionId, offset: -1 | 1) => {
    const index = value.order.indexOf(id);
    const target = value.order[index + offset];
    if (target) reorder(id, target);
  };
  const toggle = (id: ProjectToolbarActionId) => onChange({
    ...value,
    hidden: hidden.has(id) ? value.hidden.filter(item => item !== id) : [...value.hidden, id],
  });
  return <div className="settings-group-card mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
    <label className="flex cursor-pointer items-center gap-3 border-b border-slate-200 px-4 py-3.5">
      <span className="min-w-0 flex-1"><span className="block text-sm font-bold text-slate-700">仅显示当前可用的功能图标</span><span className="mt-1 block text-xs leading-5 text-slate-500">开启后只显示可用功能。</span></span>
      <input type="checkbox" checked={value.onlyShowAvailable} onChange={event => onChange({ ...value, onlyShowAvailable: event.target.checked })}/>
    </label>
    {value.order.map((id, index) => {
      const item = PROJECT_TOOLBAR_ITEMS[id];
      const visible = !hidden.has(id);
      return <div key={id} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }} onDrop={event => { event.preventDefault(); if (draggedId) reorder(draggedId, id); setDraggedId(undefined); }} className={`flex items-center gap-3 border-b border-slate-200 px-3 py-3 last:border-b-0 ${draggedId === id ? 'opacity-60' : ''}`}>
        <button type="button" draggable onDragStart={event => { setDraggedId(id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id); }} onDragEnd={() => setDraggedId(undefined)} title="拖动调整顺序" aria-label={`拖动“${item.label}”调整顺序`} className="cursor-grab rounded p-1 text-slate-400 hover:bg-slate-100 active:cursor-grabbing"><GripVertical size={17}/></button>
        <span className={`shrink-0 ${visible ? 'text-blue-600' : 'text-slate-300'}`}>{item.icon}</span>
        <span className={`min-w-0 flex-1 ${visible ? '' : 'opacity-50'}`}><span className="block text-sm font-bold text-slate-700">{item.label}</span><span className="mt-0.5 block text-xs text-slate-400">{item.description}</span></span>
        <div className="flex shrink-0 items-center gap-1"><button type="button" disabled={index === 0} onClick={() => move(id, -1)} title="上移" aria-label={`上移“${item.label}”`} className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-25"><ChevronUp size={15}/></button><button type="button" disabled={index === value.order.length - 1} onClick={() => move(id, 1)} title="下移" aria-label={`下移“${item.label}”`} className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-25"><ChevronDown size={15}/></button></div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs font-medium text-slate-600"><input type="checkbox" checked={visible} onChange={() => toggle(id)}/>显示</label>
      </div>;
    })}
    <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-3 py-2.5"><span className="text-xs text-slate-400">拖动左侧手柄自由排序，更改会立即保存。</span><button type="button" onClick={() => onChange({ order: [...PROJECT_TOOLBAR_ACTION_IDS], hidden: [], onlyShowAvailable: false })} className="text-xs font-bold text-blue-600 hover:text-blue-700">恢复默认</button></div>
  </div>;
};

const SdDriveHistorySettings = ({ value, videoToolsAvailable, videoToolsUnavailableMessage, onChange, onOpenVideoPanel }: { value: AppConfig['smartImport']; videoToolsAvailable: boolean; videoToolsUnavailableMessage: string; onChange: (value: AppConfig['smartImport']) => void; onOpenVideoPanel: (panel: 'split' | 'transcode') => void }) => {
  const appDialog = useAppDialog();
  const records = normalizeConfiguredSdDeviceRecords(value.sdDevices);
  const selectedPaths = [...new Set(value.sdPaths?.length ? value.sdPaths : value.sdPath ? [value.sdPath] : [])];
  const recordIds = new Set(records.map(record => record.deviceId));
  const legacyPaths = [...new Set([...selectedPaths, ...Object.keys(value.sdDriveTypes || {})])].filter(path => !value.sdDeviceIds?.[path] || !recordIds.has(value.sdDeviceIds[path]));
  const entryCount = records.length + legacyPaths.length;
  const setRecordEnabled = (deviceId: string, enabled: boolean) => onChange(syncLegacySdMirrors(value, records.map(record => record.deviceId === deviceId ? { ...record, enabled } : record)));
  const setRecordType = (deviceId: string, type: 'work' | 'broll') => onChange(syncLegacySdMirrors(value, records.map(record => record.deviceId === deviceId ? { ...record, type } : record)));
  const setRecordVideoAction = (deviceId: string, key: 'splitVideosOnImport' | 'transcodeVideosOnImport', enabled: boolean) => onChange(syncLegacySdMirrors(value, records.map(record => record.deviceId === deviceId ? { ...record, [key]: enabled } : record)));
  const removeRecord = (deviceId: string) => onChange(removeConfiguredSdDevice(value, deviceId));
  const setLegacyEnabled = (path: string, enabled: boolean) => {
    const sdPaths = enabled
      ? [...new Set([...selectedPaths, path])]
      : selectedPaths.filter(item => item !== path);
    onChange({
      ...value,
      sdPath: sdPaths[0] || '',
      sdPaths,
      sdDriveTypes: { ...value.sdDriveTypes, [path]: value.sdDriveTypes[path] || 'work' },
      sdDriveVideoActions: { ...value.sdDriveVideoActions, [path]: value.sdDriveVideoActions?.[path] || { splitVideosOnImport: false, transcodeVideosOnImport: false } },
    });
  };
  const setLegacyType = (path: string, type: 'work' | 'broll') => onChange({
    ...value,
    sdDriveTypes: { ...value.sdDriveTypes, [path]: type },
  });
  const setLegacyVideoAction = (path: string, key: 'splitVideosOnImport' | 'transcodeVideosOnImport', enabled: boolean) => {
    const current = value.sdDriveVideoActions?.[path] || { splitVideosOnImport: false, transcodeVideosOnImport: false };
    onChange({
      ...value,
      sdDriveVideoActions: { ...value.sdDriveVideoActions, [path]: { ...current, [key]: enabled } },
    });
  };
  const removeLegacy = (path: string) => {
    const sdPaths = selectedPaths.filter(item => item !== path);
    const sdDriveTypes = { ...value.sdDriveTypes };
    const sdDriveVideoActions = { ...value.sdDriveVideoActions };
    const sdDeviceIds = { ...(value.sdDeviceIds || {}) };
    delete sdDriveTypes[path];
    delete sdDriveVideoActions[path];
    delete sdDeviceIds[path];
    onChange({ ...value, sdPath: sdPaths[0] || '', sdPaths, sdDriveTypes, sdDriveVideoActions, sdDeviceIds });
  };
  const clear = async () => {
    if (!entryCount || !await appDialog.confirm({
      title: '清空全部 SD 卡历史吗？',
      message: '将删除所有已记录的设备路径和导入类型。以后再次连接时仍可重新选择。',
      confirmLabel: '清空历史',
      cancelLabel: '取消',
      tone: 'danger',
    })) return;
    onChange({ ...value, sdPath: '', sdPaths: [], sdDriveTypes: {}, sdDriveVideoActions: {}, sdDeviceIds: {}, sdDevices: [] });
  };
  return <div className="settings-group-card overflow-hidden rounded-xl border border-slate-200 bg-white">
    {!videoToolsAvailable && <div role="status" className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-xs font-bold text-amber-700">{videoToolsUnavailableMessage}；视频切割、转码及参数入口已停用。</div>}
    {entryCount ? <div className="divide-y divide-slate-200">
      {records.map(record => <div key={record.deviceId} className="px-4 py-3.5">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center">
          <div className="min-w-0"><p title={record.lastMountPath} className="truncate font-mono text-sm font-bold text-slate-700">{record.lastMountPath}</p><p className={`mt-1 text-xs ${record.enabled && record.confirmedAt > 0 ? 'text-emerald-600' : 'text-amber-600'}`}>{record.confirmedAt <= 0 ? '需要在导入面板重新确认设备身份' : record.enabled ? '已启用，按设备身份自动匹配' : '仅保留历史，不会自动读取'}</p></div>
          <div className="flex flex-wrap items-center gap-3"><label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-600"><input type="checkbox" checked={record.enabled} onChange={event => setRecordEnabled(record.deviceId, event.target.checked)}/>启用</label><select aria-label={`${record.lastMountPath} 默认导入类型`} value={record.type} onChange={event => setRecordType(record.deviceId, event.target.value as 'work' | 'broll')} className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-xs font-medium text-slate-600"><option value="work">原始素材</option><option value="broll">花絮</option></select></div>
          <button type="button" onClick={() => removeRecord(record.deviceId)} aria-label={`删除 ${record.lastMountPath} 的历史记录`} title="删除历史记录" className="inline-flex w-fit items-center gap-1.5 rounded-md border border-red-200 px-2.5 py-2 text-xs font-bold text-red-600 hover:bg-red-50"><Trash2 size={13}/>删除</button>
        </div>
        <div className="mt-3 grid gap-2 border-t border-slate-100 pt-3 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2.5"><label className={`inline-flex items-center gap-2 text-xs font-medium ${videoToolsAvailable ? 'cursor-pointer text-slate-700' : 'cursor-not-allowed text-slate-400'}`} title={!videoToolsAvailable ? videoToolsUnavailableMessage : undefined}><input type="checkbox" disabled={!videoToolsAvailable} checked={record.splitVideosOnImport} onChange={event => setRecordVideoAction(record.deviceId, 'splitVideosOnImport', event.target.checked)}/>导入时切割视频</label><button type="button" disabled={!videoToolsAvailable} title={!videoToolsAvailable ? videoToolsUnavailableMessage : undefined} className="text-xs font-bold text-blue-600 hover:text-blue-700 disabled:cursor-not-allowed disabled:text-slate-400" onClick={() => onOpenVideoPanel('split')}>切割规则</button></div>
          <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2.5"><label className={`inline-flex items-center gap-2 text-xs font-medium ${videoToolsAvailable ? 'cursor-pointer text-slate-700' : 'cursor-not-allowed text-slate-400'}`} title={!videoToolsAvailable ? videoToolsUnavailableMessage : undefined}><input type="checkbox" disabled={!videoToolsAvailable} checked={record.transcodeVideosOnImport} onChange={event => setRecordVideoAction(record.deviceId, 'transcodeVideosOnImport', event.target.checked)}/>导入时转码视频</label><button type="button" disabled={!videoToolsAvailable} title={!videoToolsAvailable ? videoToolsUnavailableMessage : undefined} className="text-xs font-bold text-blue-600 hover:text-blue-700 disabled:cursor-not-allowed disabled:text-slate-400" onClick={() => onOpenVideoPanel('transcode')}>转码参数</button></div>
        </div>
      </div>)}
      {legacyPaths.map(path => {
      const enabled = selectedPaths.includes(path);
      const videoActions = value.sdDriveVideoActions?.[path] || { splitVideosOnImport: false, transcodeVideosOnImport: false };
      return <div key={path} className="px-4 py-3.5">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center">
          <div className="min-w-0"><p title={path} className="truncate font-mono text-sm font-bold text-slate-700">{path}</p><p className="mt-1 text-xs text-amber-600">旧盘符记录；重新接入并确认身份后会保留下方行为</p></div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-600"><input type="checkbox" checked={enabled} onChange={event => setLegacyEnabled(path, event.target.checked)}/>启用</label>
            <select aria-label={`${path} 默认导入类型`} value={value.sdDriveTypes[path] || 'work'} onChange={event => setLegacyType(path, event.target.value as 'work' | 'broll')} className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-xs font-medium text-slate-600"><option value="work">原始素材</option><option value="broll">花絮</option></select>
          </div>
          <button type="button" onClick={() => removeLegacy(path)} aria-label={`删除 ${path} 的历史记录`} title="删除历史记录" className="inline-flex w-fit items-center gap-1.5 rounded-md border border-red-200 px-2.5 py-2 text-xs font-bold text-red-600 hover:bg-red-50"><Trash2 size={13}/>删除</button>
        </div>
        <div className="mt-3 grid gap-2 border-t border-slate-100 pt-3 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2.5"><label className={`inline-flex items-center gap-2 text-xs font-medium ${videoToolsAvailable ? 'cursor-pointer text-slate-700' : 'cursor-not-allowed text-slate-400'}`} title={!videoToolsAvailable ? videoToolsUnavailableMessage : undefined}><input type="checkbox" disabled={!videoToolsAvailable} checked={videoActions.splitVideosOnImport} onChange={event => setLegacyVideoAction(path, 'splitVideosOnImport', event.target.checked)}/>导入时切割视频</label><button type="button" disabled={!videoToolsAvailable} title={!videoToolsAvailable ? videoToolsUnavailableMessage : undefined} className="text-xs font-bold text-blue-600 hover:text-blue-700 disabled:cursor-not-allowed disabled:text-slate-400" onClick={() => onOpenVideoPanel('split')}>切割规则</button></div>
          <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2.5"><label className={`inline-flex items-center gap-2 text-xs font-medium ${videoToolsAvailable ? 'cursor-pointer text-slate-700' : 'cursor-not-allowed text-slate-400'}`} title={!videoToolsAvailable ? videoToolsUnavailableMessage : undefined}><input type="checkbox" disabled={!videoToolsAvailable} checked={videoActions.transcodeVideosOnImport} onChange={event => setLegacyVideoAction(path, 'transcodeVideosOnImport', event.target.checked)}/>导入时转码视频</label><button type="button" disabled={!videoToolsAvailable} title={!videoToolsAvailable ? videoToolsUnavailableMessage : undefined} className="text-xs font-bold text-blue-600 hover:text-blue-700 disabled:cursor-not-allowed disabled:text-slate-400" onClick={() => onOpenVideoPanel('transcode')}>转码参数</button></div>
        </div>
      </div>;
    })}</div> : <div className="px-4 py-8 text-center"><HardDrive size={26} className="mx-auto text-slate-300"/><p className="mt-3 text-sm font-medium text-slate-500">还没有记录过 SD 卡设备</p><p className="mt-1 text-xs text-slate-400">在导入模块中选择设备后会自动出现在这里。</p></div>}
    {entryCount > 0 && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3"><span className="text-xs text-slate-400">共记录 {entryCount} 个设备，更改会立即保存。</span><button type="button" onClick={() => void clear()} className="text-xs font-bold text-red-600 hover:text-red-700">清空全部历史</button></div>}
  </div>;
};

const SettingsPageGroup = ({ title, children }: { title: string; children: React.ReactNode }) => <section className="space-y-3">
  <h3 className="text-sm font-bold text-slate-800">{title}</h3>
  <div className="settings-group-card divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">{children}</div>
</section>;

const SettingsRow = ({ title, description, children, align = 'center' }: { title: string; description?: React.ReactNode; children: React.ReactNode; align?: 'center' | 'start' }) => <div className={`grid min-w-0 gap-4 px-4 py-3.5 md:grid-cols-[minmax(220px,1fr)_minmax(280px,1.25fr)] ${align === 'start' ? 'md:items-start' : 'md:items-center'}`}>
  <div className="min-w-0"><h4 className="text-sm font-bold text-slate-800">{title}</h4>{description && <div className="mt-1 text-xs leading-5 text-slate-500">{description}</div>}</div>
  <div className="min-w-0 md:justify-self-stretch">{children}</div>
</div>;

const SettingsToggle = ({ checked, onChange, disabled, label }: { checked: boolean; onChange?: (checked: boolean) => void; disabled?: boolean; label: string }) => <label className="ml-auto flex w-fit cursor-pointer items-center gap-2 text-xs font-medium text-slate-500">
  <span className="sr-only">{label}</span><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange?.(event.target.checked)} className="h-4 w-4 accent-blue-600"/>
</label>;

const SettingsPanel = ({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) => {
  const panelRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => { const previous = previousFocusRef.current; window.requestAnimationFrame(() => previous?.isConnected && previous.focus()); };
  }, []);
  const trapFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const controls = [...(panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])];
    if (!controls.length) { event.preventDefault(); return; }
    const first = controls[0]; const last = controls[controls.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return <div className="fixed inset-0 z-[500] flex items-center justify-center bg-slate-950/40 p-6" role="dialog" aria-modal="true" aria-label={title} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
  <section ref={panelRef} tabIndex={-1} onKeyDown={trapFocus} className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
    <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><h3 className="text-base font-bold text-slate-800">{title}</h3><button type="button" onClick={onClose} aria-label="关闭" className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X size={18}/></button></header>
    <div className="min-h-0 overflow-y-auto p-5">{children}</div>
  </section>
</div>;
};

const SettingsPage = ({ activeSection, backupProjectFocus, onClearBackupProjectFocus, config, components, componentInstallPath, componentsLoading, onRefreshComponents, onComponentsChanged, onSave, onConfigRestored, getDefaultSettings }: { activeSection: BuiltInSettingsSection; backupProjectFocus?: WorkspaceProject | null; onClearBackupProjectFocus?: () => void; config: AppConfig; components: ComponentStatus[]; componentInstallPath: string; componentsLoading: boolean; onRefreshComponents: () => void | Promise<void>; onComponentsChanged: () => void | Promise<void>; onSave: (config: AppConfig) => boolean | Promise<boolean>; onConfigRestored: (config: AppConfig) => void; getDefaultSettings: () => AppConfig | Promise<AppConfig> }) => {
  const toast = useUserFacingToast();
  const onNotice = useCallback((message: string, duration?: number) => { toast.show(message, duration); }, [toast]);
  const appDialog = useAppDialog();
  const [draft, setDraft] = useState(config);
  const [backupStatus, setBackupStatus] = useState<BackupStatus>({ success: true, enabled: false, state: 'unconfigured', snapshots: [] });
  const [backupSpace, setBackupSpace] = useState<BackupSpaceStatus>({ success: false });
  const [archiveStatus, setArchiveStatus] = useState<{ success: boolean; enabled: boolean; state: 'unconfigured' | 'connected' | 'offline'; targetPath?: string; totalBytes?: number; freeBytes?: number }>({ success: true, enabled: false, state: 'unconfigured' });
  const [backupAction, setBackupAction] = useState('');
  const backupActionRef = useRef('');
  const backupRequestRef = useRef(0);
  const [backupTargetSetup, setBackupTargetSetup] = useState<AppConfig['backup']['targetType'] | ''>('');
  const [nasPath, setNasPath] = useState(config.backup.targetType === 'nas' ? config.backup.targetPath : '');
  const [nasUsername, setNasUsername] = useState('');
  const [nasPassword, setNasPassword] = useState('');
  const [newProjectCategory, setNewProjectCategory] = useState('');
  const [projectCategoryError, setProjectCategoryError] = useState('');
  const [addingProjectCategory, setAddingProjectCategory] = useState(false);
  const [importVideoPanel, setImportVideoPanel] = useState<'split' | 'transcode' | null>(null);
  const videoToolsAvailable = componentCapabilityIsAvailable(components, 'media.video.processing');
  const videoToolsUnavailableMessage = componentsLoading ? '正在检查视频处理组件' : componentCapabilityUnavailableMessage(components, 'media.video.processing', '视频处理组件');
  useEffect(() => { if (!videoToolsAvailable && importVideoPanel) setImportVideoPanel(null); }, [importVideoPanel, videoToolsAvailable]);
  const [draggedProjectCategory, setDraggedProjectCategory] = useState('');
  const [newProgressNamePreset, setNewProgressNamePreset] = useState('');
  const [progressNamePresetError, setProgressNamePresetError] = useState('');
  const [addingProgressNamePreset, setAddingProgressNamePreset] = useState(false);
  const [draggedProgressNamePreset, setDraggedProgressNamePreset] = useState('');
  const [editingProgressNamePreset, setEditingProgressNamePreset] = useState('');
  const [editingProgressNamePresetValue, setEditingProgressNamePresetValue] = useState('');
  const [restoreProjects, setRestoreProjects] = useState<Record<string, string>>({});
  const [shortcutTransfer, setShortcutTransfer] = useState('');
  const [recordingShortcutAction, setRecordingShortcutAction] = useState<VideoActionId | ''>('');
  const draftRef = useRef(config);
  const previousConfigRef = useRef(config);
  const onSaveRef = useRef(onSave);
  const onNoticeRef = useRef(onNotice);
  onSaveRef.current = onSave;
  onNoticeRef.current = onNotice;
  const saveCoordinatorRef = useRef<ReturnType<typeof createSettingsSaveCoordinator<AppConfig>> | null>(null);
  if (!saveCoordinatorRef.current) saveCoordinatorRef.current = createSettingsSaveCoordinator<AppConfig>({
    initial: config,
    normalize: next => { const workspacePaths = normalizeWorkspacePaths(next.workspacePath, next.workspacePaths); return { ...next, workspacePath: workspacePaths[0] || '', workspacePaths }; },
    applyDraft: next => { draftRef.current = next; setDraft(next); },
    save: next => onSaveRef.current(next),
    onFailure: (_next, error) => onNoticeRef.current(`保存设置失败：${error.message || '未知错误'}`, 6000),
  });
  const backupSnapshotsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = previousConfigRef.current;
    const next = { ...reconcileRemoteConfig(draftRef.current, previous, config), componentSettings: config.componentSettings, componentSettingsRevisions: config.componentSettingsRevisions };
    draftRef.current = next;
    saveCoordinatorRef.current?.mergePersisted(value => ({ ...reconcileRemoteConfig(value, previous, config), componentSettings: config.componentSettings, componentSettingsRevisions: config.componentSettingsRevisions }));
    previousConfigRef.current = config;
    setDraft(next);
  }, [config]);
  useEffect(() => {
    if (!backupProjectFocus) return;
    const frame = window.requestAnimationFrame(() => backupSnapshotsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    return () => window.cancelAnimationFrame(frame);
  }, [backupProjectFocus]);
  const patchSettings = (patch: (current: AppConfig) => Partial<AppConfig>) => {
    void saveCoordinatorRef.current?.enqueueMutation(current => patchSettingsDraft(current, patch)).then(saved => { if (saved) onNoticeRef.current('已更改设置'); });
  };
  const update = <K extends keyof AppConfig,>(key: K, value: AppConfig[K]) => patchSettings(() => ({ [key]: value }));
  const drainSettingsBeforeBackupAction = async (actionLabel: string) => {
    try {
      const coordinator = saveCoordinatorRef.current;
      if (!coordinator) return false;
      const result = await waitForPersistedSettings(coordinator);
      if (result.status === 'save-failed') {
        onNotice(`${actionLabel}未开始：待保存的设置保存失败，请确认设置后重试`, 6000);
        return false;
      }
      if (result.status === 'changed') {
        onNotice(`${actionLabel}未开始：等待保存期间设置又有更改，请重试以使用最新设置`, 6000);
        return false;
      }
      if (result.status === 'superseded') {
        onNotice(`${actionLabel}未开始：目标设置已被更新版本取代，请重试以使用最新设置`, 6000);
        return false;
      }
      return true;
    } catch (error) {
      onNotice(`${actionLabel}未开始：无法完成设置保存：${error instanceof Error ? error.message : String(error)}`, 6000);
      return false;
    }
  };
  const projectCategories = normalizeProjectCategoryOrder(draft.projectCategoryOrder, draft.customProjectCategories);
  const addProjectCategory = () => {
    const name = newProjectCategory.trim().replace(/\s+/g, ' ');
    const reserved = ['未分类', ...BUILT_IN_PROJECT_STATUSES];
    if (!name) { setProjectCategoryError('请输入分类名称'); return; }
    if (name.length > 24) { setProjectCategoryError('分类名称不能超过 24 个字符'); return; }
    if ([...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) { setProjectCategoryError('分类名称包含无效字符'); return; }
    if ([...reserved, ...draft.customProjectCategories].some(item => item.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setProjectCategoryError('已经存在同名分类');
      return;
    }
    if (draft.customProjectCategories.length >= 50) { setProjectCategoryError('最多可以创建 50 个自定义分类'); return; }
    patchSettings(current => {
      const currentOrder = normalizeProjectCategoryOrder(current.projectCategoryOrder, current.customProjectCategories);
      return { customProjectCategories: [...current.customProjectCategories, name], projectCategoryOrder: [...currentOrder, name] };
    });
    setNewProjectCategory('');
    setProjectCategoryError('');
    setAddingProjectCategory(false);
  };
  const removeProjectCategory = async (name: string) => {
    const workspacePaths = normalizeWorkspacePaths(draft.workspacePath, draft.workspacePaths);
    if (workspacePaths.length) {
      const workspaces = await Promise.all(workspacePaths.map(workspacePath => window.electronAPI.getWorkspaceProjects(workspacePath)));
      const failed = workspaces.find(workspace => !workspace.success);
      if (failed) { onNotice(`无法检查分类：${failed.error || '工作区读取失败'}`, 5000); return; }
      const categoryGroups = workspaces.map(workspace => workspace.statuses.find(group => group.status === name)).filter(Boolean);
      const projectCount = categoryGroups.reduce((total, group) => total + (group?.projects.length || 0), 0);
      if (projectCount > 0) { onNotice(`“${name}”中还有 ${projectCount} 个项目，请先移到其他分类`, 5000); return; }
      if (categoryGroups.length) { onNotice(`“${name}”仍被离线项目记录使用，请恢复或清理这些项目后再删除`, 5000); return; }
    }
    if (!await appDialog.confirm({ title: `删除“${name}”分类吗？`, message: '只会删除这个自定义分类，不会删除任何项目文件。', confirmLabel: '删除分类', tone: 'danger' })) return;
    patchSettings(current => ({
      customProjectCategories: current.customProjectCategories.filter(item => item !== name),
      projectCategoryOrder: normalizeProjectCategoryOrder(current.projectCategoryOrder, current.customProjectCategories).filter(item => item !== name),
    }));
  };
  const reorderProjectCategory = (source: string, target: string) => {
    if (!source || source === target) return;
    const next = [...projectCategories];
    const sourceIndex = next.indexOf(source);
    const targetIndex = next.indexOf(target);
    if (sourceIndex < 0 || targetIndex < 0) return;
    next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, source);
    update('projectCategoryOrder', next);
  };
  const moveProjectCategory = (name: string, offset: -1 | 1) => {
    const index = projectCategories.indexOf(name);
    const target = projectCategories[index + offset];
    if (target) reorderProjectCategory(name, target);
  };
  const progressNamePresets = normalizeProgressNamePresets(draft.progressNamePresets);
  const validateProgressNamePreset = (value: string, previousName = '') => {
    const name = value.trim().replace(/\s+/g, ' ');
    if (!name) return { name, error: '请输入预设名称' };
    if (name.length > 24) return { name, error: '预设名称不能超过 24 个字符' };
    if ([...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return { name, error: '预设名称包含无效字符' };
    if (progressNamePresets.some(item => item !== previousName && item.toLocaleLowerCase() === name.toLocaleLowerCase())) return { name, error: '已经存在同名预设' };
    return { name, error: '' };
  };
  const addProgressNamePreset = () => {
    const { name, error } = validateProgressNamePreset(newProgressNamePreset);
    if (error) { setProgressNamePresetError(error); return; }
    if (progressNamePresets.length >= 50) { setProgressNamePresetError('最多可以创建 50 个预设'); return; }
    update('progressNamePresets', [...progressNamePresets, name]);
    setNewProgressNamePreset(''); setProgressNamePresetError(''); setAddingProgressNamePreset(false);
  };
  const removeProgressNamePreset = (name: string) => update('progressNamePresets', progressNamePresets.filter(item => item !== name));
  const saveProgressNamePreset = () => {
    const { name, error } = validateProgressNamePreset(editingProgressNamePresetValue, editingProgressNamePreset);
    if (error) { setProgressNamePresetError(error); return; }
    update('progressNamePresets', progressNamePresets.map(item => item === editingProgressNamePreset ? name : item));
    setEditingProgressNamePreset(''); setEditingProgressNamePresetValue(''); setProgressNamePresetError('');
  };
  const reorderProgressNamePreset = (source: string, target: string) => {
    if (!source || source === target) return;
    const next = [...progressNamePresets];
    const sourceIndex = next.indexOf(source); const targetIndex = next.indexOf(target);
    if (sourceIndex < 0 || targetIndex < 0) return;
    next.splice(sourceIndex, 1); next.splice(targetIndex, 0, source);
    update('progressNamePresets', next);
  };
  const moveProgressNamePreset = (name: string, offset: -1 | 1) => {
    const target = progressNamePresets[progressNamePresets.indexOf(name) + offset];
    if (target) reorderProgressNamePreset(name, target);
  };
  useEffect(() => { backupRequestRef.current += 1; setBackupSpace({ success: false }); }, [draft.workspacePath, draft.backup.targetType, draft.backup.targetPath]);
  const refreshBackup = useCallback(async () => {
    const request = ++backupRequestRef.current;
    const current = draftRef.current;
    if (!current.workspacePath) return;
    if (!current.backup.enabled || !current.backup.targetPath) setBackupSpace({ success: false });
    try {
      const [status, space, archive] = await Promise.all([
        window.electronAPI.getBackupStatus(current.workspacePath),
        current.backup.enabled && current.backup.targetPath ? window.electronAPI.getBackupSpaceStatus(current.workspacePath) : Promise.resolve<BackupSpaceStatus>({ success: false }),
        window.electronAPI.getArchiveStatus(),
      ]);
      if (request !== backupRequestRef.current) return;
      setBackupStatus(status); setBackupSpace(space); setArchiveStatus(archive);
    } catch (error) {
      if (request === backupRequestRef.current) onNoticeRef.current(`读取存储状态失败：${error instanceof Error ? error.message : String(error)}`, 5000);
    }
  }, [draft.workspacePath, draft.backup.enabled, draft.backup.targetPath]);
  useEffect(() => {
    if (activeSection === 'backup') void refreshBackup();
  }, [activeSection, draft.backup, refreshBackup]);
  useEffect(() => window.electronAPI.onBackgroundTaskChanged(delta => {
    if (activeSection === 'backup' && delta.upserts.some(task => ['workspace-backup', 'backup-verify', 'backup-cleanup', 'workspace-restore', 'project-restore', 'project-archive', 'project-unarchive'].includes(task.type))) void refreshBackup();
  }), [activeSection, refreshBackup]);
  useEffect(() => {
    const credentialRef = draft.backup.nas.credentialRef;
    if (!credentialRef) { setNasUsername(''); return; }
    let active = true;
    void window.electronAPI.readNasCredential(credentialRef).then(result => {
      if (active && result.success) setNasUsername(result.credential?.username || '');
    }).catch(() => { if (active) setNasUsername(''); });
    return () => { active = false; };
  }, [draft.backup.nas.credentialRef]);
  useEffect(() => {
    if (draft.backup.targetType === 'nas' && draft.backup.targetPath.startsWith('\\\\')) setNasPath(draft.backup.targetPath);
  }, [draft.backup.targetPath, draft.backup.targetType]);
  const activeBackupTargetType = backupTargetSetup || draft.backup.targetType;
  const backupTargetConfigurable = draft.backup.enabled || Boolean(backupTargetSetup);
  const chooseBackupTarget = async (currentPath = draft.backup.targetType === 'local' ? draft.backup.targetPath : '') => {
    try {
      const selected = await window.electronAPI.chooseBackupTarget(currentPath);
      if (selected.cancelled || !selected.path) return false;
      const targetPath = selected.path;
      setBackupTargetSetup('');
      patchSettings(current => ({ backup: { ...current.backup, enabled: true, targetType: 'local', targetPath } }));
      return true;
    } catch (error) { onNotice(`选择备份位置失败：${error instanceof Error ? error.message : String(error)}`, 5000); return false; }
  };
  const enableBackup = async () => {
    if (draftRef.current.backup.targetPath) {
      patchSettings(current => ({ backup: { ...current.backup, enabled: true } }));
      return;
    }
    const targetType = await appDialog.choice({
      title: '选择备份方式',
      message: '选择工作区备份的存储位置。完成目标配置后才会启用备份。',
      choices: [
        { value: 'local', label: '本地磁盘或外接硬盘' },
        { value: 'nas', label: 'NAS 网络存储' },
      ],
      defaultValue: draftRef.current.backup.targetType || 'local',
    });
    if (targetType === 'local') await chooseBackupTarget('');
    else if (targetType === 'nas') {
      patchSettings(current => ({ backup: { ...current.backup, enabled: false, targetType: 'nas', targetPath: '' } }));
      setBackupTargetSetup('nas');
      setNasPath('');
    }
  };
  const switchBackupTargetType = async (targetType: AppConfig['backup']['targetType']) => {
    if (targetType === activeBackupTargetType) return;
    if (draftRef.current.backup.targetPath && !await appDialog.confirm({
      title: '更换备份方式？',
      message: '当前备份目标将停止使用，但原位置中的备份不会被删除。完成新目标配置后，备份功能会重新开启。',
      confirmLabel: '更换备份方式',
    })) return;
    if (targetType === 'local') {
      await chooseBackupTarget('');
      return;
    }
    patchSettings(current => ({ backup: { ...current.backup, enabled: false, targetType: 'nas' as const, targetPath: '' } }));
    setBackupTargetSetup('nas');
    setNasPath('');
  };
  const saveNas = async () => {
    if (backupActionRef.current) return;
    backupActionRef.current = 'nas-save';
    setBackupAction('nas-save');
    try {
      await saveCoordinatorRef.current?.transaction(async saveConfig => {
        const target = await window.electronAPI.setNasBackupTarget(nasPath);
        if (!target.success || !target.path) { onNotice(target.error || 'NAS 路径无效', 5000); return; }
        let credentialRef = '';
        if (nasUsername.trim() || nasPassword) {
          const credential = await window.electronAPI.saveNasCredential({ remotePath: target.path, username: nasUsername, password: nasPassword });
          if (!credential.success || !credential.credentialRef) { onNotice(credential.error || '无法保存 NAS 凭据', 5000); return; }
          credentialRef = credential.credentialRef;
        } else credentialRef = draftRef.current.backup.nas.credentialRef;
        if (!credentialRef) { onNotice('请填写 NAS 用户名和密码', 5000); return; }
        const latestForTesting = draftRef.current;
        const testingConfig = { ...latestForTesting, backup: { ...latestForTesting.backup, enabled: false, targetType: 'nas' as const, targetPath: target.path, nas: { ...latestForTesting.backup.nas, credentialRef } } };
        if (!await saveConfig(testingConfig)) return;
        const tested = await window.electronAPI.testBackupConnection();
        if (!tested.success || !tested.connection) {
          const latest = draftRef.current;
          await saveConfig({ ...latest, backup: { ...latest.backup, enabled: false, targetType: 'nas', targetPath: '', nas: { ...latest.backup.nas, credentialRef } } }, { incorporatesPending: true });
          setBackupTargetSetup('nas');
          onNotice(tested.error || 'NAS 连接测试失败，备份仍保持关闭', 6000);
          return;
        }
        const latest = draftRef.current;
        const enabledConfig = { ...latest, backup: { ...latest.backup, enabled: true, targetType: 'nas' as const, targetPath: target.path, nas: { ...latest.backup.nas, credentialRef } } };
        if (!await saveConfig(enabledConfig, { incorporatesPending: true })) return;
        setBackupTargetSetup(''); setNasPassword('');
        const speed = tested.connection.speedMBps ? `，写入 ${tested.connection.speedMBps} MB/s` : '';
        onNotice(`NAS 已保存并连接成功${speed}`);
      });
      await refreshBackup();
    } catch (error) {
      onNotice(`保存 NAS 设置失败：${error instanceof Error ? error.message : String(error)}`, 6000);
    } finally { backupActionRef.current = ''; setBackupAction(''); }
  };
  const cleanupBackup = async () => {
    if (backupActionRef.current) return;
    const expired = backupSpace.expiredSnapshotCount || 0;
    const reclaimable = backupSpace.estimatedReclaimableBytes || 0;
    if (!await appDialog.confirm({ title: '清理过期备份？', message: `预计删除 ${expired} 个过期快照，释放约 ${formatStorageSize(reclaimable)}。只会回收不再被任何保留快照使用的数据；不会删除工作区原文件、归档项目或仍保留的快照。`, confirmLabel: '清理过期备份', tone: 'danger' })) return;
    if (!await drainSettingsBeforeBackupAction('备份清理')) return;
    if (backupActionRef.current) return;
    backupActionRef.current = 'cleanup'; setBackupAction('cleanup');
    try {
      const result = await window.electronAPI.cleanupBackup(draftRef.current.workspacePath);
      if (!result.success) onNotice(result.error || '无法开始清理', 6000);
      await refreshBackup();
    } catch (error) { onNotice(`无法开始清理：${error instanceof Error ? error.message : String(error)}`, 6000); }
    finally { backupActionRef.current = ''; setBackupAction(''); }
  };
  const chooseArchiveTarget = async () => {
    try {
      const selected = await window.electronAPI.chooseArchiveTarget(draftRef.current.archive.targetPath);
      if (selected.cancelled || !selected.path) return;
      update('archive', { enabled: true, targetPath: selected.path });
      setArchiveStatus({ success: true, enabled: true, state: 'connected', targetPath: selected.path });
    } catch (error) { onNotice(`选择归档位置失败：${error instanceof Error ? error.message : String(error)}`, 5000); }
  };
  const runBackup = async () => {
    if (backupActionRef.current) return;
    if (!await drainSettingsBeforeBackupAction('立即备份')) return;
    if (backupActionRef.current) return;
    backupActionRef.current = 'run';
    setBackupAction('run');
    try {
      const result = await window.electronAPI.runBackup(draftRef.current.workspacePath, 'manual');
      if (!result.success) onNotice(result.error || '无法开始备份', 5000);
      await refreshBackup();
    } catch (error) { onNotice(`无法开始备份：${error instanceof Error ? error.message : String(error)}`, 5000); }
    finally { backupActionRef.current = ''; setBackupAction(''); }
  };
  const verifyBackup = async (snapshotId: string) => {
    if (backupActionRef.current) return;
    if (!await drainSettingsBeforeBackupAction('备份验证')) return;
    if (backupActionRef.current) return;
    backupActionRef.current = `verify:${snapshotId}`;
    setBackupAction(`verify:${snapshotId}`);
    try {
      const result = await window.electronAPI.verifyBackup(draftRef.current.workspacePath, snapshotId);
      if (!result.success) onNotice(result.error || '无法开始验证', 5000);
    } catch (error) { onNotice(`无法开始验证：${error instanceof Error ? error.message : String(error)}`, 5000); }
    finally { backupActionRef.current = ''; setBackupAction(''); }
  };
  const restoreWorkspace = async (snapshotId: string) => {
    if (backupActionRef.current) return;
    if (!await appDialog.confirm({ title: '恢复整个工作区？', message: '软件会要求选择一个空文件夹，并把这个快照恢复为新的工作区。当前工作区不会被覆盖。', confirmLabel: '选择恢复位置' })) return;
    if (!await drainSettingsBeforeBackupAction('工作区恢复')) return;
    if (backupActionRef.current) return;
    backupActionRef.current = `workspace:${snapshotId}`;
    setBackupAction(`workspace:${snapshotId}`);
    try {
      const coordinator = saveCoordinatorRef.current;
      if (!coordinator) return;
      await coordinator.transaction(async (_saveConfig, adoptConfig) => {
        const result = await window.electronAPI.restoreBackupWorkspace(draftRef.current.workspacePath, snapshotId);
        if (result.cancelled) return;
        if (!result.success || !result.workspacePath || !result.savedConfig) { onNotice(result.error || '工作区恢复失败', 6000); return; }
        const next = restoredWorkspaceConfig(result.savedConfig, result.workspacePath, draftRef.current);
        adoptConfig(next); onConfigRestored(next);
        onNotice('工作区恢复完成，已切换到恢复位置', 6000);
        window.dispatchEvent(new Event('workspace-projects-changed'));
      });
    } catch (error) { onNotice(`工作区恢复失败：${error instanceof Error ? error.message : String(error)}`, 6000); }
    finally { backupActionRef.current = ''; setBackupAction(''); }
  };
  const restoreProject = async (snapshotId: string, requestedProjectId = '') => {
    if (backupActionRef.current) return;
    const snapshot = backupStatus.snapshots.find(item => item.id === snapshotId);
    const projectId = requestedProjectId || restoreProjects[snapshotId] || snapshot?.projectItems?.[0]?.id || '';
    const project = snapshot?.projectItems?.find(item => item.id === projectId);
    if (!project || !await appDialog.confirm({ title: `恢复项目“${project?.name || ''}”？`, message: '项目会恢复到快照中的原状态和原分类；如果原位置已被占用，恢复会安全停止。', confirmLabel: '恢复项目' })) return;
    if (backupActionRef.current) return;
    backupActionRef.current = `project:${snapshotId}`;
    setBackupAction(`project:${snapshotId}`);
    try {
      const result = await window.electronAPI.restoreBackupProject(draftRef.current.workspacePath, snapshotId, projectId);
      onNotice(result.success ? `项目“${project.name}”已恢复` : result.error || '项目恢复失败', result.success ? 5000 : 6000);
      if (result.success) window.dispatchEvent(new Event('workspace-projects-changed'));
    } catch (error) { onNotice(`项目恢复失败：${error instanceof Error ? error.message : String(error)}`, 6000); }
    finally { backupActionRef.current = ''; setBackupAction(''); }
  };
  const videoPlaybackSettings = draft.videoPlayback;
  const inspirationLibrarySettings = draft.inspirationLibrary;
  const updateVideoPlaybackSettings = (next: AppConfig['videoPlayback']) => update('videoPlayback', next);
  const shortcutBindings = normalizeVideoShortcutBindings(videoPlaybackSettings.shortcuts);
  const shortcutConflicts = videoShortcutConflicts(shortcutBindings);
  const captureShortcut = (actionId: VideoActionId, event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (recordingShortcutAction !== actionId) return;
    event.preventDefault(); event.stopPropagation();
    const input = shortcutInputFromKeyboardEvent(event);
    if (isModifierOnlyVideoShortcutInput(input)) return;
    const chord = shortcutChord(input);
    if (!chord) return;
    if (isReservedVideoShortcut(chord)) { onNotice(`“${formatVideoShortcutChord(chord)}”是系统保留快捷键，请按其他组合键`, 4500); return; }
    const next = normalizeVideoShortcutBindings({ ...shortcutBindings, [actionId]: [chord] });
    const conflict = videoShortcutConflicts(next)[0];
    if (conflict) { onNotice(`“${formatVideoShortcutChord(conflict.chord)}”已用于其他操作`, 4500); return; }
    updateVideoPlaybackSettings({ ...videoPlaybackSettings, shortcuts: next });
    setRecordingShortcutAction('');
  };
  const updateInspirationLibraryRoot = (rootPath: string) => patchSettings(current => ({ inspirationLibrary: { ...current.inspirationLibrary, rootPath } }));
  const visibleBackupSnapshots = backupProjectFocus ? backupStatus.snapshots.filter(snapshot => snapshot.projectItems?.some(project => project.name === backupProjectFocus.name)) : backupStatus.snapshots;
  const restoreDefaults = async () => {
    if (!await appDialog.confirm({
      title: '恢复默认设置吗？',
      message: '保留当前工作目录和组件设置，将其他应用设置恢复为默认值。更改会立即生效。',
      confirmLabel: '恢复默认设置',
    })) return;
    const defaults = await getDefaultSettings();
    patchSettings(current => ({ ...defaults, workspacePath: current.workspacePath.trim() || defaults.workspacePath, workspacePaths: normalizeWorkspacePaths(current.workspacePath, current.workspacePaths), componentSettings: current.componentSettings, componentSettingsRevisions: current.componentSettingsRevisions }));
  };
  return <section className="min-h-full w-full bg-slate-50"><div className="mx-auto w-full max-w-6xl space-y-10 px-8 py-10 lg:px-12">
    <h2 className="text-2xl font-bold text-slate-900">{SETTINGS_SECTION_LABELS[activeSection]}</h2>
    {activeSection === 'general' && <>
    <SettingsPageGroup title="外观">
      <SettingsRow title="界面配色" description="选择照片流跟随系统、浅色或深色显示。"><div className="ml-auto flex w-fit rounded-lg border border-slate-200 p-1">{([['system', '适应系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([theme, label]) => <button key={theme} onClick={() => update('theme', theme)} className={`rounded-md px-4 py-2 text-sm font-bold transition ${draft.theme === theme ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-800'}`}>{label}</button>)}</div></SettingsRow>
      <SettingsRow title="启动时打开灵感库" description="启动应用时自动打开灵感库页面。"><SettingsToggle label="启动时打开灵感库" checked={draft.pinInspirationLibrary} onChange={checked => update('pinInspirationLibrary', checked)}/></SettingsRow>
      <SettingsRow title="显示角色生日" description="在首页显示角色生日提醒。"><SettingsToggle label="显示角色生日" checked={draft.birthdayEnabled} onChange={checked => update('birthdayEnabled', checked)}/></SettingsRow>
    </SettingsPageGroup>
    <SettingsPageGroup title="文件浏览">
      <SettingsRow title="开启版本树功能" description="开启后，包含版本数据的项目根目录会默认进入版本树，并显示版本树入口。关闭会隐藏入口并停用导出文件夹提示，不会删除或修改已有版本数据。"><SettingsToggle label="开启版本树功能" checked={draft.versionTreeEnabled} onChange={checked => update('versionTreeEnabled', checked)}/></SettingsRow>
      <SettingsRow title="打开文件与文件夹" description="单击模式直接打开；双击模式单击选择、双击打开。"><select value={draft.itemOpenMode} onChange={event => update('itemOpenMode', event.target.value as AppConfig['itemOpenMode'])} className="form-input ml-auto max-w-sm"><option value="single">单击打开（默认）</option><option value="double">双击打开</option></select></SettingsRow>
      <SettingsRow title="图片评分显示" description="两种界面都直接读写图片自身的 XMP 星级；喜欢模式会把任意星级视为喜欢，点喜欢时写入五星。"><select value={draft.favoriteDisplayMode} onChange={event => update('favoriteDisplayMode', event.target.value as AppConfig['favoriteDisplayMode'])} className="form-input ml-auto max-w-sm"><option value="binary">喜欢 / 不喜欢</option><option value="stars">一星到五星</option></select></SettingsRow>
      <SettingsRow title="文件夹默认排序方式" description=""><select value={draft.defaultFolderSort} onChange={event => update('defaultFolderSort', event.target.value as AppConfig['defaultFolderSort'])} className="form-input ml-auto max-w-sm"><option value="date">修改日期（最新优先）</option><option value="name">文件名（A–Z）</option><option value="size">大小（从大到小）</option></select></SettingsRow>
      <SettingsRow title="文件夹首字母筛选" description="图标模式下，子文件夹超过 30 个时显示 A–Z 索引；汉字按拼音首字母归类。"><SettingsToggle label="显示文件夹首字母筛选" checked={draft.folderAlphabetFilterEnabled} onChange={checked => update('folderAlphabetFilterEnabled', checked)}/></SettingsRow>
    </SettingsPageGroup>
    <section><h3 className="text-sm font-bold text-slate-800">项目工具栏</h3><p className="mt-1 text-xs leading-5 text-slate-500">设置项目工具栏按钮及顺序。</p><ProjectToolbarSettingsEditor value={draft.projectToolbar} onChange={projectToolbar => update('projectToolbar', projectToolbar)}/></section>
    <SettingsPageGroup title="设置">
      <SettingsRow title="恢复默认设置" description="保留当前工作目录和组件设置，将其他应用设置恢复为初始值。"><button type="button" onClick={() => void restoreDefaults()} className="dialog-secondary ml-auto flex w-fit items-center gap-2"><RotateCcw size={15}/>恢复默认设置</button></SettingsRow>
    </SettingsPageGroup>
    </>}
    {activeSection === 'project' && <SettingsPageGroup title="文件夹名称预设">
      <div className="px-4 py-3.5"><h4 className="text-sm font-bold text-slate-800">预设与顺序</h4><p className="mt-1 text-xs leading-5 text-slate-500">创建或修改进度时点击预设即可填入文件夹名称。可拖动、排序、新增或删除。</p></div>
      {progressNamePresets.map((name, index) => editingProgressNamePreset === name ? <form key={name} className="flex items-start gap-2 bg-blue-50 px-4 py-3" onSubmit={event => { event.preventDefault(); saveProgressNamePreset(); }}><Pencil size={17} className="mt-2.5 shrink-0 text-blue-600"/><div className="min-w-0 flex-1"><input autoFocus value={editingProgressNamePresetValue} maxLength={24} onChange={event => { setEditingProgressNamePresetValue(event.target.value); setProgressNamePresetError(''); }} className="form-input"/>{progressNamePresetError && <p className="mt-1.5 text-xs text-red-500">{progressNamePresetError}</p>}</div><button type="submit" className="dialog-primary shrink-0">保存</button><button type="button" onClick={() => { setEditingProgressNamePreset(''); setEditingProgressNamePresetValue(''); setProgressNamePresetError(''); }} title="取消" className="rounded-md p-2.5 text-slate-400 hover:bg-slate-200"><X size={16}/></button></form> : <div key={name} draggable onDragStart={event => { setDraggedProgressNamePreset(name); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', name); }} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }} onDrop={event => { event.preventDefault(); reorderProgressNamePreset(draggedProgressNamePreset || event.dataTransfer.getData('text/plain'), name); setDraggedProgressNamePreset(''); }} onDragEnd={() => setDraggedProgressNamePreset('')} className={`flex min-w-0 items-center gap-3 px-4 py-3 transition ${draggedProgressNamePreset === name ? 'bg-blue-50 opacity-60' : 'bg-white'}`}><span title="拖动排序" className="cursor-grab text-slate-400 active:cursor-grabbing"><GripVertical size={17}/></span><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600"><GitBranch size={16}/></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-800">{name}</p><p className="mt-0.5 text-xs text-slate-400">点击后填充到文件夹名称</p></div><div className="flex shrink-0 items-center gap-1"><button type="button" disabled={index === 0} onClick={() => moveProgressNamePreset(name, -1)} title="上移" className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-25"><ChevronUp size={15}/></button><button type="button" disabled={index === progressNamePresets.length - 1} onClick={() => moveProgressNamePreset(name, 1)} title="下移" className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-25"><ChevronDown size={15}/></button><button type="button" onClick={() => { setEditingProgressNamePreset(name); setEditingProgressNamePresetValue(name); setProgressNamePresetError(''); }} title="修改预设" className="ml-1 rounded-md p-2 text-slate-400 hover:bg-blue-50 hover:text-blue-600"><Pencil size={15}/></button><button type="button" onClick={() => removeProgressNamePreset(name)} title="删除预设" className="rounded-md p-2 text-slate-400 hover:bg-red-50 hover:text-red-500"><Trash2 size={15}/></button></div></div>)}
      {addingProgressNamePreset ? <form className="flex items-start gap-2 bg-slate-50 px-4 py-3" onSubmit={event => { event.preventDefault(); addProgressNamePreset(); }}><Plus size={17} className="mt-2.5 shrink-0 text-blue-600"/><div className="min-w-0 flex-1"><input autoFocus value={newProgressNamePreset} maxLength={24} onChange={event => { setNewProgressNamePreset(event.target.value); setProgressNamePresetError(''); }} placeholder="输入新预设名称" className="form-input"/>{progressNamePresetError && <p className="mt-1.5 text-xs text-red-500">{progressNamePresetError}</p>}</div><button type="submit" className="dialog-primary shrink-0">添加</button><button type="button" onClick={() => { setAddingProgressNamePreset(false); setNewProgressNamePreset(''); setProgressNamePresetError(''); }} title="取消" className="rounded-md p-2.5 text-slate-400 hover:bg-slate-200"><X size={16}/></button></form> : <button type="button" onClick={() => setAddingProgressNamePreset(true)} className="flex w-full items-center gap-3 bg-slate-50 px-4 py-3 text-left text-sm font-bold text-blue-600 hover:bg-blue-50"><span className="flex h-8 w-8 items-center justify-center rounded-lg border border-dashed border-blue-300 bg-white"><Plus size={17}/></span>新增预设</button>}
    </SettingsPageGroup>}
    {activeSection === 'project' && <>
    <SettingsPageGroup title="新建项目">
      <SettingsRow title="新建项目时创建策划文件夹" description="新建项目时创建“策划”文件夹。"><SettingsToggle label="新建项目时创建策划文件夹" checked={draft.createPlanningFolder} onChange={checked => update('createPlanningFolder', checked)}/></SettingsRow>
    </SettingsPageGroup>
    <SettingsPageGroup title="项目状态">
      <SettingsRow title="导入后自动移动项目分类" description="开启后，工作素材成功导入到“待拍摄”项目时，自动将项目移动到“后期中”；关闭后项目保持“待拍摄”。"><SettingsToggle label="导入后自动移动项目分类" checked={draft.smartImport.autoMoveProjectAfterSdImport} onChange={checked => update('smartImport', { ...draft.smartImport, autoMoveProjectAfterSdImport: checked })}/></SettingsRow>
    </SettingsPageGroup>
    <SettingsPageGroup title="项目分类">
      <div className="px-4 py-3.5"><h4 className="text-sm font-bold text-slate-800">分类与顺序</h4><p className="mt-1 text-xs leading-5 text-slate-500">拖动左侧手柄或使用箭头调整顺序。内置分类固定保留；自定义分类为空时可以删除。</p></div>
      {projectCategories.map((name, index) => { const builtIn = (BUILT_IN_PROJECT_STATUSES as readonly string[]).includes(name); return <div key={name} draggable onDragStart={event => { setDraggedProjectCategory(name); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', name); }} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }} onDrop={event => { event.preventDefault(); reorderProjectCategory(draggedProjectCategory || event.dataTransfer.getData('text/plain'), name); setDraggedProjectCategory(''); }} onDragEnd={() => setDraggedProjectCategory('')} className={`flex min-w-0 items-center gap-3 px-4 py-3 transition ${draggedProjectCategory === name ? 'bg-blue-50 opacity-60' : 'bg-white'}`}>
        <span title="拖动排序" className="cursor-grab text-slate-400 active:cursor-grabbing"><GripVertical size={17}/></span>
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${builtIn ? 'bg-blue-50 text-blue-600' : 'bg-violet-50 text-violet-600'}`}><Folder size={16}/></span>
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-800">{name}</p><p className="mt-0.5 text-xs text-slate-400">{builtIn ? '内置分类 · 不可修改或删除' : '自定义分类'}</p></div>
        <div className="flex shrink-0 items-center gap-1"><button type="button" disabled={index === 0} onClick={() => moveProjectCategory(name, -1)} title="上移" aria-label={`上移 ${name}`} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-25"><ChevronUp size={15}/></button><button type="button" disabled={index === projectCategories.length - 1} onClick={() => moveProjectCategory(name, 1)} title="下移" aria-label={`下移 ${name}`} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-25"><ChevronDown size={15}/></button>{builtIn ? <span title="内置分类不可删除" className="ml-1 flex h-8 w-8 items-center justify-center text-slate-300"><LockKeyhole size={14}/></span> : <button type="button" onClick={() => void removeProjectCategory(name)} title="删除分类" aria-label={`删除分类 ${name}`} className="ml-1 rounded-md p-2 text-slate-400 hover:bg-red-50 hover:text-red-500"><Trash2 size={15}/></button>}</div>
      </div>; })}
      {addingProjectCategory ? <form className="flex items-start gap-2 bg-slate-50 px-4 py-3" onSubmit={event => { event.preventDefault(); addProjectCategory(); }}><Plus size={17} className="mt-2.5 shrink-0 text-blue-600"/><div className="min-w-0 flex-1"><input autoFocus value={newProjectCategory} maxLength={24} onChange={event => { setNewProjectCategory(event.target.value); setProjectCategoryError(''); }} placeholder="输入新分类名称" className="form-input"/>{projectCategoryError && <p className="mt-1.5 text-xs text-red-500">{projectCategoryError}</p>}</div><button type="submit" className="dialog-primary shrink-0">添加</button><button type="button" onClick={() => { setAddingProjectCategory(false); setNewProjectCategory(''); setProjectCategoryError(''); }} title="取消" aria-label="取消新增分类" className="rounded-md p-2.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700"><X size={16}/></button></form> : <button type="button" onClick={() => setAddingProjectCategory(true)} className="flex w-full items-center gap-3 bg-slate-50 px-4 py-3 text-left text-sm font-bold text-blue-600 hover:bg-blue-50"><span className="flex h-8 w-8 items-center justify-center rounded-lg border border-dashed border-blue-300 bg-white"><Plus size={17}/></span>新增分类</button>}
    </SettingsPageGroup>
    </>}
    {activeSection === 'privacy' && <PrivacySettings/>}
    {(activeSection === 'backup' || activeSection === 'storage') && <>
      <SettingsPageGroup title="统计">
        <StorageVolumeOverview sourceSignature={[...normalizeWorkspacePaths(draft.workspacePath, draft.workspacePaths), inspirationLibrarySettings.rootPath, draft.archive.targetPath, draft.backup.targetPath, draft.mediaCache.directory].join('\u0000')}/>
      </SettingsPageGroup>
      <SettingsPageGroup title="工作目录">
      <SettingsRow title="项目工作目录" description="可读取多个磁盘。默认目录用于新建和导入项目；已有项目使用其所在磁盘。" align="start"><WorkspaceFoldersPicker primary={draft.workspacePath} values={draft.workspacePaths} onChange={(workspacePath, workspacePaths) => patchSettings(() => ({ workspacePath, workspacePaths }))}/></SettingsRow>
      <SettingsRow title="灵感库目录" description="选择后立即保存，并纳入磁盘占用统计。"><WorkspaceFolderPicker value={inspirationLibrarySettings.rootPath} onChange={rootPath => void updateInspirationLibraryRoot(rootPath)}/></SettingsRow>
      <SettingsRow title="使用独立项目归档盘" description={draft.archive.enabled ? (archiveStatus.state === 'connected' ? '归档盘已连接。' : archiveStatus.state === 'offline' ? '归档盘当前离线。' : '请选择归档盘。') : '将“已归档”项目迁移到其他存储盘。'}><SettingsToggle label="使用独立项目归档盘" checked={draft.archive.enabled} onChange={checked => { if (checked && !draft.archive.targetPath) void chooseArchiveTarget(); else update('archive', { ...draft.archive, enabled: checked }); }}/></SettingsRow>
      <SettingsRow title="项目归档盘位置" description={archiveStatus.freeBytes !== undefined ? `剩余 ${formatStorageSize(archiveStatus.freeBytes)} / ${formatStorageSize(archiveStatus.totalBytes)}` : '选择用于保存已归档项目的位置。'}><fieldset disabled={!draft.archive.enabled} className="flex min-w-0 gap-2 disabled:opacity-50"><input readOnly value={draft.archive.targetPath} placeholder="尚未选择归档盘" className="form-input min-w-0 flex-1"/><button type="button" onClick={() => void chooseArchiveTarget()} className="dialog-secondary shrink-0">选择</button><button type="button" onClick={() => void window.electronAPI.openArchiveTarget()} disabled={!draft.archive.targetPath} className="dialog-secondary shrink-0 disabled:opacity-45">打开</button></fieldset></SettingsRow>
      </SettingsPageGroup>
      <SettingsPageGroup title="备份">
      <SettingsRow title="启用工作区备份" description={!draft.backup.enabled ? '备份已关闭。' : backupStatus.state === 'protected' ? '工作区已保护。' : backupStatus.state === 'running' ? '正在备份。' : backupStatus.error || '备份已启用。'}><SettingsToggle label="启用工作区备份" checked={draft.backup.enabled} onChange={checked => { if (checked) void enableBackup(); else { setBackupTargetSetup(''); patchSettings(current => ({ backup: { ...current.backup, enabled: false } })); } }}/></SettingsRow>
      <SettingsRow title="备份方式" description="选择本地磁盘、外接硬盘或 NAS 网络存储。"><select disabled={!backupTargetConfigurable || Boolean(backupAction)} value={activeBackupTargetType} onChange={event => void switchBackupTargetType(event.target.value as AppConfig['backup']['targetType'])} className="form-input ml-auto max-w-sm disabled:opacity-50"><option value="local">本地磁盘或外接硬盘</option><option value="nas">NAS 网络存储</option></select></SettingsRow>
      {activeBackupTargetType === 'local' && <SettingsRow title="本地备份位置" description="位置离线时暂停备份，重新连接后可以继续。"><fieldset disabled={!backupTargetConfigurable || Boolean(backupAction)} className="flex min-w-0 gap-2 disabled:opacity-50"><input readOnly value={draft.backup.targetType === 'local' ? draft.backup.targetPath : ''} placeholder="尚未选择备份位置" className="form-input min-w-0 flex-1"/><button type="button" onClick={() => void chooseBackupTarget()} className="dialog-secondary shrink-0">选择</button><button type="button" onClick={() => void window.electronAPI.openBackupTarget()} disabled={draft.backup.targetType !== 'local' || !draft.backup.targetPath} className="dialog-secondary shrink-0 disabled:opacity-45">打开</button></fieldset></SettingsRow>}
      {activeBackupTargetType === 'nas' && <>
        <SettingsRow title="NAS 共享路径" description={backupStatus.connection?.connected ? 'NAS 已连接。' : '输入 Windows 可访问的网络共享路径。'}><input value={nasPath} onChange={event => setNasPath(event.target.value)} placeholder="\\studio-nas\backup" className="form-input font-mono"/></SettingsRow>
        <SettingsRow title="NAS 登录凭据" description="密码保存在 Windows 凭据管理器，配置文件不保存明文。"><div className="grid gap-2 sm:grid-cols-2"><input value={nasUsername} onChange={event => setNasUsername(event.target.value)} autoComplete="username" placeholder="用户名" className="form-input"/><input type="password" value={nasPassword} onChange={event => setNasPassword(event.target.value)} autoComplete="new-password" placeholder={draft.backup.nas.credentialRef ? '已保存；留空则不更改' : '密码'} className="form-input"/></div></SettingsRow>
        <SettingsRow title="保存并测试 NAS" description={backupStatus.connection?.checkedAt ? `上次验证：${new Date(backupStatus.connection.checkedAt).toLocaleString()}` : '保存配置并立即验证连接。'}><div className="ml-auto flex w-fit gap-2"><button type="button" onClick={() => void saveNas()} disabled={!nasPath.trim() || Boolean(backupAction)} className="dialog-primary disabled:opacity-45">{backupAction === 'nas-save' ? '正在测试…' : '保存并测试'}</button><button type="button" onClick={() => void window.electronAPI.openBackupTarget()} disabled={Boolean(backupAction) || !draft.backup.enabled || draft.backup.targetType !== 'nas' || !draft.backup.targetPath} className="dialog-secondary disabled:opacity-45">打开</button></div></SettingsRow>
        <SettingsRow title="限制 NAS 带宽" description="在工作时间避免备份占满局域网带宽。"><SettingsToggle label="限制 NAS 带宽" checked={draft.backup.nas.limitEnabled} onChange={checked => patchSettings(current => ({ backup: { ...current.backup, nas: { ...current.backup.nas, limitEnabled: checked } } }))}/></SettingsRow>
        {draft.backup.nas.limitEnabled && <SettingsRow title="NAS 带宽限制时段" description="设置限速值和生效时间。"><div className="grid gap-2 sm:grid-cols-3"><input aria-label="NAS 带宽上限" type="number" min="1" max="1000" value={draft.backup.nas.bandwidthLimitMBps} onChange={event => { const bandwidthLimitMBps = Math.max(1, Number(event.target.value) || 1); patchSettings(current => ({ backup: { ...current.backup, nas: { ...current.backup.nas, bandwidthLimitMBps } } })); }} className="form-input"/><input aria-label="NAS 限速开始时间" type="time" value={draft.backup.nas.limitStart} onChange={event => { const limitStart = event.target.value; patchSettings(current => ({ backup: { ...current.backup, nas: { ...current.backup.nas, limitStart } } })); }} className="form-input"/><input aria-label="NAS 限速结束时间" type="time" value={draft.backup.nas.limitEnd} onChange={event => { const limitEnd = event.target.value; patchSettings(current => ({ backup: { ...current.backup, nas: { ...current.backup.nas, limitEnd } } })); }} className="form-input"/></div></SettingsRow>}
      </>}
      <SettingsRow title="立即备份" description={backupStatus.latestAt ? `上次成功：${new Date(backupStatus.latestAt).toLocaleString()} · ${backupStatus.snapshotCount || 0} 个快照` : '立即为当前工作区创建备份。'}><button type="button" onClick={() => void runBackup()} disabled={!draft.backup.enabled || !draft.backup.targetPath || Boolean(backupAction)} className="dialog-primary ml-auto flex w-fit items-center gap-2 disabled:opacity-45">{backupAction === 'run' ? <Loader2 size={15} className="animate-spin"/> : <ShieldCheck size={15}/>}立即备份</button></SettingsRow>
      <SettingsRow title="历史策略" description="选择保留全部历史快照或只保留最新状态。"><select value={draft.backup.mode} onChange={event => { const mode = event.target.value as AppConfig['backup']['mode']; patchSettings(current => ({ backup: { ...current.backup, mode } })); }} className="form-input ml-auto max-w-sm"><option value="history">保留全部历史快照</option><option value="latest">仅保留最新快照</option></select></SettingsRow>
      {draft.backup.mode === 'history' && <SettingsRow title="历史快照保留" description="快照按日、周、月自动保留。"><p className="text-sm text-slate-500">最近 7 天每日一份 · 最近 4 周每周一份 · 最近 12 个月每月一份</p></SettingsRow>}
      <SettingsRow title="每天自动备份" description="每天首次启动时检查，24 小时内已有成功快照则跳过。"><SettingsToggle label="每天自动备份" checked={draft.backup.automaticDaily} onChange={checked => patchSettings(current => ({ backup: { ...current.backup, automaticDaily: checked } }))}/></SettingsRow>
      <SettingsRow title="导入完成后自动备份" description="导入任务成功后备份当前工作区，并发触发会自动合并。"><SettingsToggle label="导入完成后自动备份" checked={draft.backup.afterImport} onChange={checked => patchSettings(current => ({ backup: { ...current.backup, afterImport: checked } }))}/></SettingsRow>
      <SettingsRow title="清理过期备份" description="删除保留策略之外的旧快照，并回收只有这些快照使用的文件。不会删除工作区原文件、归档项目或仍保留的快照。"><div className="ml-auto w-fit text-right"><p className="text-sm font-bold text-slate-700">{backupSpace.success ? `预计删除 ${backupSpace.expiredSnapshotCount || 0} 个过期快照，释放约 ${formatStorageSize(backupSpace.estimatedReclaimableBytes)}` : '连接备份位置后显示预计结果'}</p>{backupSpace.success && <p className="mt-1 text-xs text-slate-400">实际占用 {formatStorageSize(backupSpace.actualBytes)} · 内容去重已自动启用，已节省 {formatStorageSize(backupSpace.deduplicatedBytes)}</p>}<button type="button" onClick={() => void cleanupBackup()} disabled={!backupSpace.success || Boolean(backupAction)} className="dialog-secondary mt-3 text-xs disabled:opacity-45">清理过期备份</button></div></SettingsRow>
      <div ref={backupSnapshotsRef} className="divide-y divide-slate-200">
        {backupProjectFocus && <SettingsRow title={`项目备份：${backupProjectFocus.name}`} description={`仅显示包含“${backupProjectFocus.name}”的工作区快照。`}><button type="button" onClick={onClearBackupProjectFocus} className="dialog-secondary ml-auto block w-fit text-xs">查看全部快照</button></SettingsRow>}
        <SettingsRow title="备份快照" description={backupProjectFocus ? '选择一个包含该项目的快照进行查看或恢复。' : '验证快照，或恢复整个工作区和完整项目。'} align="start"><div className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200">{visibleBackupSnapshots.map(snapshot => { const focusedProject = backupProjectFocus ? snapshot.projectItems?.find(project => project.name === backupProjectFocus.name) : undefined; return <div key={snapshot.id} className="p-3"><p className="text-sm font-bold text-slate-800">{new Date(snapshot.createdAt).toLocaleString()}</p><p className="mt-1 text-xs text-slate-500">{snapshot.projects} 个项目 · {snapshot.files} 个文件 · {formatStorageSize(snapshot.bytes)}</p><div className="mt-2 flex flex-wrap items-center gap-2"><button type="button" onClick={() => void verifyBackup(snapshot.id)} disabled={Boolean(backupAction)} className="dialog-secondary text-xs disabled:opacity-45">验证</button>{focusedProject ? backupProjectFocus?.availability === 'missing' && <button type="button" onClick={() => void restoreProject(snapshot.id, focusedProject.id)} disabled={Boolean(backupAction)} className="dialog-secondary text-xs disabled:opacity-45">恢复此项目</button> : <><button type="button" onClick={() => void restoreWorkspace(snapshot.id)} disabled={Boolean(backupAction)} className="dialog-secondary text-xs disabled:opacity-45">恢复工作区</button>{Boolean(snapshot.projectItems?.length) && <><select value={restoreProjects[snapshot.id] || snapshot.projectItems?.[0]?.id || ''} onChange={event => setRestoreProjects(current => ({ ...current, [snapshot.id]: event.target.value }))} className="rounded-md border border-slate-300 bg-white px-2 py-2 text-xs">{snapshot.projectItems?.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><button type="button" onClick={() => { const selectedId = restoreProjects[snapshot.id] || snapshot.projectItems?.[0]?.id || ''; setRestoreProjects(current => ({ ...current, [snapshot.id]: selectedId })); void restoreProject(snapshot.id); }} disabled={Boolean(backupAction)} className="dialog-secondary text-xs disabled:opacity-45">恢复项目</button></>}</>}</div></div>; })}{!visibleBackupSnapshots.length && <p className="p-4 text-center text-sm text-slate-500">{backupProjectFocus ? `还没有“${backupProjectFocus.name}”的可用备份快照` : '还没有可用的备份快照'}</p>}</div></SettingsRow>
      </div>
      </SettingsPageGroup>
      <SettingsPageGroup title="缓存">
        <MediaCacheSettings config={draft.mediaCache} onChange={mediaCache => update('mediaCache', mediaCache)}/>
        <InterfaceCacheSettings onNotice={onNotice}/>
        <SettingsRow title="自动清理已删除项目的数据" description="每天首次启动时检查；系统外删除的项目保留 30 天恢复期，无法确认状态时继续保留。"><SettingsToggle label="自动清理已删除项目的数据" checked={draft.autoCleanupDeletedProjectData} onChange={checked => update('autoCleanupDeletedProjectData', checked)}/></SettingsRow>
        <LogSettings onNotice={onNotice}/>
      </SettingsPageGroup>
    </>}
    {activeSection === 'components' && <ComponentSettings components={components} installPath={componentInstallPath} loading={componentsLoading} onRefresh={onRefreshComponents} onComponentsChanged={onComponentsChanged} onComponentDataCleared={componentId => {
      patchSettings(current => {
        const componentSettings = { ...current.componentSettings };
        delete componentSettings[componentId];
        return { componentSettings };
      });
    }} onNotice={onNotice}/>}
    {activeSection === 'video' && <>
    <SettingsPageGroup title="视频浏览">
      <SettingsRow title="左右方向键行为" description="设置视频播放器的左右方向键用于快进快退或切换视频。"><select value={videoPlaybackSettings.arrowKeyAction} onChange={event => updateVideoPlaybackSettings({ ...videoPlaybackSettings, arrowKeyAction: event.target.value as 'seek' | 'navigate' })} className="form-input ml-auto max-w-sm"><option value="seek">快退 / 快进 5 秒（默认）</option><option value="navigate">切换上一个 / 下一个视频</option></select></SettingsRow>
      <SettingsRow title="默认显示字幕" description="关闭时仍会发现和列出字幕，但不会自动显示；可在播放器 CC 菜单中开启。"><SettingsToggle label="默认显示字幕" checked={videoPlaybackSettings.subtitlesEnabled} onChange={checked => updateVideoPlaybackSettings({ ...videoPlaybackSettings, subtitlesEnabled: checked })}/></SettingsRow>
      <SettingsRow title="字幕首选语言" description="按顺序匹配语言代码，用逗号分隔，例如 zh, chi, zho, en。"><input value={videoPlaybackSettings.subtitlePreferredLanguages.join(', ')} onChange={event => updateVideoPlaybackSettings({ ...videoPlaybackSettings, subtitlePreferredLanguages: event.target.value.split(',').map(value => value.trim().toLowerCase()).filter(Boolean).slice(0, 8) })} className="form-input ml-auto max-w-sm"/></SettingsRow>
      <SettingsRow title="字幕字号" description="设置视频播放器字幕的默认字号，可按 1 递增调整。"><div className="ml-auto flex w-full max-w-sm items-center gap-3"><input type="range" min={MIN_SUBTITLE_FONT_SIZE} max={MAX_SUBTITLE_FONT_SIZE} step={1} value={videoPlaybackSettings.subtitleSize} onChange={event => updateVideoPlaybackSettings({ ...videoPlaybackSettings, subtitleSize: normalizeSubtitleFontSize(event.target.value) })} aria-label="字幕字号" className="min-w-0 flex-1 accent-blue-500"/><output aria-live="polite" className="w-10 rounded-md border border-slate-300 bg-white px-2 py-1 text-center text-sm font-bold tabular-nums text-slate-700">{videoPlaybackSettings.subtitleSize}</output></div></SettingsRow>
      <SettingsRow title="字幕样式" description="高对比度样式使用更明显的描边和阴影。"><select value={videoPlaybackSettings.subtitleStyle} onChange={event => updateVideoPlaybackSettings({ ...videoPlaybackSettings, subtitleStyle: event.target.value as AppConfig['videoPlayback']['subtitleStyle'] })} className="form-input ml-auto max-w-sm"><option value="standard">标准</option><option value="high-contrast">高对比度</option></select></SettingsRow>

    </SettingsPageGroup>
    <SettingsPageGroup title="视频快捷键">
      <div className="px-4 py-3.5"><p className="text-xs leading-5 text-slate-500">点击“修改”后，直接按下单键或组合键即可。修改会替换该操作的现有按键；系统保留键和冲突按键不会保存。</p></div>
      {VIDEO_ACTIONS.map(action => {
        const recording = recordingShortcutAction === action.id;
        return <SettingsRow key={action.id} title={action.label}><div className="ml-auto flex w-full max-w-md items-center gap-2"><div aria-label={`${action.label}当前快捷键`} className="flex min-h-10 min-w-0 flex-1 flex-wrap items-center gap-1.5 rounded-md border border-slate-300 bg-slate-50 px-3 py-1.5">{shortcutBindings[action.id].map(chord => <kbd key={chord} className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-bold text-slate-700 shadow-sm">{formatVideoShortcutChord(chord)}</kbd>)}</div><button type="button" aria-label={`修改${action.label}快捷键`} aria-pressed={recording} onClick={() => setRecordingShortcutAction(current => current === action.id ? '' : action.id)} onKeyDown={event => captureShortcut(action.id, event)} onBlur={() => setRecordingShortcutAction(current => current === action.id ? '' : current)} className={`h-10 shrink-0 rounded-md px-3 text-xs font-bold ${recording ? 'bg-blue-600 text-white ring-2 ring-blue-300' : 'dialog-secondary'}`}>{recording ? '请按键…' : '修改'}</button><button type="button" onClick={() => { updateVideoPlaybackSettings({ ...videoPlaybackSettings, shortcuts: { ...shortcutBindings, [action.id]: [...action.defaults] } }); setRecordingShortcutAction(''); }} className="dialog-secondary h-10 shrink-0 px-3 text-xs">重置</button></div></SettingsRow>;
      })}
      {shortcutConflicts.length > 0 && <div className="px-4 py-3.5"><p role="alert" className="rounded-md bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">快捷键冲突：{shortcutConflicts.map(item => `${item.chord}（${item.actions.join(' / ')}）`).join('；')}</p></div>}
      <div className="p-4"><div className="rounded-lg border border-slate-200 bg-slate-50 p-3"><textarea aria-label="视频快捷键导入导出" value={shortcutTransfer} onChange={event => setShortcutTransfer(event.target.value)} placeholder="快捷键 JSON" className="form-input h-28 w-full resize-y font-mono text-xs"/><div className="mt-2 flex flex-wrap gap-2"><button type="button" onClick={() => setShortcutTransfer(exportVideoShortcuts(shortcutBindings))} className="rounded bg-slate-700 px-3 py-1.5 text-xs font-bold text-white">导出配置</button><button type="button" onClick={() => { try { updateVideoPlaybackSettings({ ...videoPlaybackSettings, shortcuts: importVideoShortcuts(shortcutTransfer) }); onNotice('快捷键配置已导入'); } catch (error) { onNotice(error instanceof Error ? error.message : '快捷键配置无效', 5000); } }} className="rounded bg-blue-600 px-3 py-1.5 text-xs font-bold text-white">导入配置</button><button type="button" onClick={() => updateVideoPlaybackSettings({ ...videoPlaybackSettings, shortcuts: defaultVideoShortcutBindings() })} className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold">全部重置</button></div></div></div>
    </SettingsPageGroup>
    <SettingsPageGroup title="视频剪辑">
      <SettingsRow title="裁剪导出方式" description={draft.videoTools.trim.exportMode === 'fast' ? '快速导出不重新编码，不降低画质；边界可能按关键帧产生少量偏差。' : '精确导出会重新编码所选片段，边界精确但耗时更长。'}><select value={draft.videoTools.trim.exportMode} onChange={event => update('videoTools', { ...draft.videoTools, trim: { exportMode: event.target.value as AppConfig['videoTools']['trim']['exportMode'] } })} className="form-input ml-auto max-w-sm"><option value="fast">快速导出（默认）</option><option value="exact">精确导出</option></select></SettingsRow>
    </SettingsPageGroup>
    </>}
    {activeSection === 'import' && <>
    <SettingsPageGroup title="导入行为">
      <SettingsRow title="RAW 缺 JPG 时自动创建" description="RAW 缺少同名 JPG 时自动生成。"><SettingsToggle label="RAW 缺 JPG 时自动创建" checked={draft.importDefaults.generateJpgFromRaw} onChange={checked => update('importDefaults', { ...draft.importDefaults, generateJpgFromRaw: checked })}/></SettingsRow>
      <SettingsRow title="导入后默认删除源文件" description="关闭时保留源文件，每个导入面板仍可单独决定本次行为。"><SettingsToggle label="导入后默认删除源文件" checked={draft.importDefaults.deleteSourceAfterImport} onChange={checked => update('importDefaults', { ...draft.importDefaults, deleteSourceAfterImport: checked })}/></SettingsRow>
    </SettingsPageGroup>
    <SettingsPageGroup title="从 SD 卡导入">
      <SettingsRow title="启动时自动从 SD 卡导入" description="应用完成启动后，检查已确认身份且包含相机媒体目录的可移动 SD 卡；无人值守导入始终保留卡内源文件。"><SettingsToggle label="启动时自动从 SD 卡导入" checked={draft.smartImport.autoStart} onChange={checked => update('smartImport', { ...draft.smartImport, autoStart: checked })}/></SettingsRow>
      <SettingsRow title="导入日期范围" description="限制从真实 SD 卡读取的素材拍摄日期。"><select value={draft.smartImport.dateFilter} onChange={event => update('smartImport', { ...draft.smartImport, dateFilter: event.target.value as AppConfig['smartImport']['dateFilter'] })} className="form-input ml-auto max-w-sm"><option value="all">全部素材</option><option value="today">仅今天拍摄的素材</option><option value="today_yesterday">今天和昨天拍摄的素材</option></select></SettingsRow>
      <SettingsRow title="已记录的 SD 卡设备" description="为每张卡分别设置导入类型和视频处理行为；例如 G 盘可以转码，其他卡可以不处理。" align="start"><SdDriveHistorySettings value={draft.smartImport} videoToolsAvailable={videoToolsAvailable} videoToolsUnavailableMessage={videoToolsUnavailableMessage} onChange={smartImport => update('smartImport', smartImport)} onOpenVideoPanel={setImportVideoPanel}/></SettingsRow>
    </SettingsPageGroup>
    {videoToolsAvailable && importVideoPanel === 'split' && <SettingsPanel title="视频切割设置" onClose={() => setImportVideoPanel(null)}><VideoSplitView embedded settingsOnly/></SettingsPanel>}
    {videoToolsAvailable && importVideoPanel === 'transcode' && <SettingsPanel title="视频转码设置" onClose={() => setImportVideoPanel(null)}><VideoTranscodeView embedded settingsOnly initialSettings={draft.videoTools.transcode} onSettingsChange={transcode => patchSettings(current => ({ videoTools: { ...current.videoTools, transcode } }))}/></SettingsPanel>}
    </>}
    {activeSection === 'about' && <AboutSettings/>}
    {activeSection === 'feedback' && <FeedbackSettings/>}
  </div></section>;
};

const FeedbackSettings = () => <SettingsPageGroup title="问题和建议"><SettingsRow title="GitHub Issues" description="在公开仓库报告问题；请先移除私人路径、照片和其他敏感信息。"><button type="button" className="dialog-secondary" onClick={() => void window.electronAPI.openExternal('https://github.com/akiyastudio/qingstudio/issues')}>打开问题列表</button></SettingsRow></SettingsPageGroup>;

const PrivacySettings = () => <SettingsPageGroup title="开源版与数据"><SettingsRow title="本地数据" description="项目和配置保存在本机；本版本未配置官方统计、崩溃上报或更新服务。" children={null}/><SettingsRow title="开源许可" description="主程序原创代码采用 Apache 2.0；第三方依赖适用各自许可证。" children={null}/><SettingsRow title="插件" description="本仓库不包含插件实现。自行安装的插件可能访问文件和网络，请审查其来源与权限。" children={null}/></SettingsPageGroup>;

const SoftwareLicenseSettings = () => {
  const openExternal = (url: string) => window.electronAPI.openExternal(url);
  return (
    <SettingsPageGroup title="第三方软件与运行库">
      {THIRD_PARTY_SOFTWARE_LICENSES.map(item => <SettingsRow key={`${item.group}-${item.name}`} title={item.name} description={`${item.group} · ${item.version} · ${item.purpose}${item.note ? ` · ${item.note}` : ''}`}><div className="ml-auto flex w-fit items-center gap-2"><span className="text-xs font-bold text-slate-500">{item.license}</span><button type="button" onClick={() => openExternal(item.sourceUrl)} className="dialog-secondary inline-flex items-center gap-1.5 text-xs">来源<ExternalLink size={13}/></button><button type="button" onClick={() => openExternal(item.licenseUrl)} className="dialog-secondary inline-flex items-center gap-1.5 text-xs">许可<ExternalLink size={13}/></button></div></SettingsRow>)}
    </SettingsPageGroup>
  );
};

const AboutSettings = () => <div className="space-y-10"><SettingsPageGroup title="照片流开源版"><SettingsRow title="版本" description={`${__APP_VERSION__} · Apache 2.0`} children={null}/><SettingsRow title="源码与更新" description="从 GitHub 获取源码和项目动态。"><button type="button" className="dialog-secondary" onClick={() => void window.electronAPI.openExternal('https://github.com/akiyastudio/qingstudio')}>打开源码仓库</button></SettingsRow></SettingsPageGroup><SoftwareLicenseSettings/></div>;

const MediaCacheSettings = ({ config, onChange }: { config: AppConfig['mediaCache']; onChange: (config: AppConfig['mediaCache']) => void }) => {
  const toast = useUserFacingToast();
  const [info, setInfo] = useState({ path: '', sizeBytes: 0, fileCount: 0 });
  const [busy, setBusy] = useState(false);
  const [capacityInput, setCapacityInput] = useState(String(config.maxSizeGB));
  const infoRequestRef = useRef(0);
  const refreshInfo = async (nextConfig = config) => {
    const request = ++infoRequestRef.current;
    try {
      const result = await window.electronAPI.getMediaCacheInfo(nextConfig);
      if (request === infoRequestRef.current && result.success) setInfo(result);
    } catch (error) { if (request === infoRequestRef.current) toast.show(`读取缓存信息失败：${error instanceof Error ? error.message : String(error)}`, 5000); }
  };
  useEffect(() => { refreshInfo(); }, [config.directory, config.maxSizeGB]);
  useEffect(() => { setCapacityInput(String(config.maxSizeGB)); }, [config.maxSizeGB]);
  const chooseDirectory = async () => {
    try {
      const result = await window.electronAPI.chooseCacheDirectory();
      if (!result.path) return;
      const next = { ...config, directory: result.path };
      onChange(next); void refreshInfo(next);
    } catch (error) { toast.show(`选择缓存目录失败：${error instanceof Error ? error.message : String(error)}`, 5000); }
  };
  const commitCapacity = () => {
    const maxSizeGB = normalizeMediaCacheSize(capacityInput);
    setCapacityInput(String(maxSizeGB));
    if (maxSizeGB !== config.maxSizeGB) onChange({ ...config, maxSizeGB });
  };
  const clearAll = async () => {
    setBusy(true);
    try {
      const result = await window.electronAPI.clearMediaCache(config);
      if (!result.success) { toast.show(`清空缓存失败：${result.error || '未知错误'}`, 5000); return; }
      await refreshInfo();
    } catch (error) { toast.show(`清空缓存失败：${error instanceof Error ? error.message : String(error)}`, 5000); }
    finally { setBusy(false); }
  };
  const sizeText = info.sizeBytes >= 1024 * 1024 * 1024 ? `${(info.sizeBytes / 1024 / 1024 / 1024).toFixed(2)} GB` : `${Math.round(info.sizeBytes / 1024 / 1024)} MB`;
  return <>
    <SettingsRow title="最大缩略图缓存容量" description="超过上限时自动清理最久未使用的缩略图。"><div className="ml-auto flex max-w-xs items-center gap-2"><input type="number" min={0} step={0.1} inputMode="decimal" value={capacityInput} onChange={event => setCapacityInput(event.target.value)} onBlur={commitCapacity} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} className="form-input"/><span className="text-sm text-slate-500">GB</span></div></SettingsRow>
    <SettingsRow title="缩略图缓存目录" description="图片、RAW 和视频缩略图的保存位置。"><div className="flex min-w-0 gap-2"><input readOnly value={info.path || config.directory || '默认应用缓存目录'} className="form-input min-w-0 flex-1 font-mono text-xs"/><button onClick={chooseDirectory} className="dialog-secondary shrink-0">选择</button></div></SettingsRow>
    <SettingsRow title="自动清理 30 天前的缓存" description="每天首次启动时检查，并移除已确认不存在的源文件索引。"><SettingsToggle label="自动清理 30 天前的缓存" checked={config.autoCleanup30Days} onChange={checked => onChange({ ...config, autoCleanup30Days: checked })}/></SettingsRow>
    <SettingsRow title="当前缩略图缓存" description={`${sizeText} · ${info.fileCount} 个缓存文件`}><button onClick={clearAll} disabled={busy} className="ml-auto flex w-fit items-center gap-1.5 rounded-md border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50 disabled:opacity-50"><Trash2 size={14}/>{busy ? '正在清理…' : '清空缓存'}</button></SettingsRow>
  </>;
};

const InterfaceCacheSettings = ({ onNotice }: { onNotice: (message: string, duration?: number) => void }) => {
  const appDialog = useAppDialog();
  const [busy, setBusy] = useState(false);
  const clear = async () => {
    if (busy || !await appDialog.confirm({
      title: '确定清理界面缓存吗？',
      message: '缓存会自动管理，仅在需要释放空间时清理。',
      confirmLabel: '清理缓存',
      tone: 'danger',
    })) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.clearInterfaceCache();
      if (!result.success) { onNotice(`清理界面缓存失败：${result.error || '未知错误'}`); return; }
      const clearedMB = Math.round((result.clearedBytes || 0) / 1024 / 1024);
      onNotice(`界面缓存已清理${clearedMB ? `，释放约 ${clearedMB} MB` : ''}`);
    } catch (error) {
      onNotice(`清理界面缓存失败：${error instanceof Error ? error.message : String(error)}`, 5000);
    } finally {
      setBusy(false);
    }
  };
  return <SettingsRow title="界面缓存" description="通常无需清理；释放空间或界面异常时可手动清理。"><button type="button" disabled={busy} onClick={() => void clear()} className="dialog-secondary ml-auto flex w-fit items-center gap-2 disabled:opacity-50"><Trash2 size={14}/>{busy ? '正在清理…' : '清理界面缓存'}</button></SettingsRow>;
};

export { WorkspaceSetupPage, SettingsNavigator, SettingsPage };
