import { projectStatusLabel } from '../../i18n/project-labels';
import { componentCapabilityUnavailableMessage, formatVideoShortcutChord } from "../../i18n/built-in-labels";
import { renderText } from "../../i18n/messages";
import { LocalizedText } from "../../i18n/LocalizedText";
import { localizedMessage } from "../../i18n/messages";
import { getLocale } from "../../i18n/runtime";
import { VIDEO_ACTIONS } from "../../i18n/built-in-labels";
import { useLocale } from "../../i18n/react";
import { t } from "../../i18n/runtime";
import { LanguageSelector } from '../../i18n/LanguageSelector';
import { normalizeLanguage, type LanguagePreference } from '../../i18n/runtime';
import { useTranslation } from '../../i18n/react';
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
import { componentCapabilityIsAvailable } from '../components/component-availability-model';
import { createSettingsSaveCoordinator, patchSettingsDraft, restoredWorkspaceConfig, waitForPersistedSettings } from './restored-workspace-config';
import { reconcileRemoteConfig } from './remote-config-model';
import { useUserFacingToast } from '../app/useUserFacingToast';
import { defaultVideoShortcutBindings, exportVideoShortcuts, importVideoShortcuts, isModifierOnlyVideoShortcutInput, isReservedVideoShortcut, normalizeVideoShortcutBindings, shortcutChord, shortcutInputFromKeyboardEvent, videoShortcutConflicts } from '../../contracts/video-shortcuts';
import type { VideoActionId } from '../../contracts/video-shortcuts';
import { normalizeMediaCacheSize } from '../app/app-config';
export type BuiltInSettingsSection = 'general' | 'project' | 'privacy' | 'storage' | 'backup' | 'components' | 'import' | 'video' | 'about' | 'feedback';
export type SettingsSection = BuiltInSettingsSection | ComponentSettingsSection;

const SETTINGS_SECTION_LABELS: Record<BuiltInSettingsSection, string> = {
  get general() { return t("ui.interface.785d65"); },
  get project() { return t("ui.projects.79f326"); },
  get import() { return t("ui.import.576d81"); },
  get backup() { return t("ui.storage.a3434a"); },
  get storage() { return t("ui.storage.a3434a"); },
  get components() { return t("ui.plugins.35fcbd"); },
  get video() { return t("ui.video.c20f76"); },
  get about() { return t("ui.about.52d25a"); },
  get feedback() { return t("ui.feedback.7a2bf1"); },
  get privacy() { return t("ui.privacy.and.data.d51db0"); },
};

export const PrivacyConsentPage = ({ onAccept }: { onAccept: (joinExperienceProgram: boolean) => void | Promise<void>; config: AppConfig; onSaveLanguage: (language: LanguagePreference) => Promise<boolean> }) => (
  <main className="p-8"><h1>照片流开源版</h1><p>本版本采用 Apache 2.0 许可证，不连接官方统计与更新服务。</p><button type="button" onClick={() => void onAccept(false)}>进入工作空间</button></main>
);

const WorkspaceFolderPicker = ({ value, onChange }: { value: string; onChange: (path: string) => void }) => {
  useLocale();
  const choose = async () => {
    const result = await window.electronAPI.chooseWorkspaceDirectory(value);
    if (!result.cancelled && result.path) onChange(result.path);
  };
  return <div className="flex gap-2"><div title={value || t("ui.choose.a.workspace.folder.366934")} className="min-w-0 flex-1 truncate rounded-lg border border-slate-200 bg-white px-3 py-2.5 font-mono text-sm text-slate-700">{value || t("ui.choose.a.workspace.folder.366934")}</div><button type="button" onClick={() => void choose()} className="dialog-secondary inline-flex shrink-0 items-center gap-2"><FolderOpen size={16}/>{t("ui.choose.folder.0d6fad")}</button></div>;
};

const WorkspaceFoldersPicker = ({ primary, values, onChange }: { primary: string; values: string[]; onChange: (primary: string, paths: string[]) => void }) => {
  useLocale();
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
      <div className="min-w-0 flex-1"><p title={workspacePath} className="truncate font-mono text-sm text-slate-700">{workspacePath}</p>{isPrimary && <p className="mt-0.5 text-[10px] font-bold text-blue-600">{t("ui.default.destination.656811")}</p>}</div>
      {!isPrimary && <button type="button" onClick={() => makePrimary(workspacePath)} className="dialog-secondary shrink-0 text-xs">{t("ui.set.as.default.357211")}</button>}
      <button type="button" disabled={paths.length === 1} onClick={() => remove(workspacePath)} className="rounded-md p-2 text-slate-400 hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-30" aria-label={t("ui.remove.workspace.folder.value0.0ddf7a", { value0: workspacePath })} title={t("ui.remove.6135d4")}><X size={15}/></button>
    </div>; })}
    <button type="button" onClick={() => void add()} className="dialog-secondary inline-flex items-center gap-2"><Plus size={15}/>{t("ui.add.workspace.folder.f80859")}</button>
  </div>;
};

const WorkspaceSetupPage = ({ config, onSave }: { config: AppConfig; onSave: (config: AppConfig) => void | Promise<void> }) => {
  useLocale();
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
  return <main className="fixed inset-x-0 bottom-0 top-10 z-40 flex items-center justify-center overflow-auto bg-slate-50 p-8"><section className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"><div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-blue-600"><FolderOpen size={28}/></div><div className="mt-5 text-center"><h1 className="text-2xl font-bold text-slate-900">{t("ui.choose.workspace.folder.615297")}</h1><p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-500">{t("ui.choose.a.workspace.folder.if.you.a586c7")}</p></div><div className="mt-7"><WorkspaceFolderPicker value={workspacePath} onChange={setWorkspacePath}/></div><div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-5"><div><p className="text-sm font-bold text-slate-700">{t("ui.already.have.a.photoflow.backup.8c0712")}</p><p className="mt-1 text-xs text-slate-500">{t("ui.restore.a.complete.snapshot.into.a.baad96")}</p></div><button type="button" disabled={recoveryBusy} onClick={() => void inspectBackup()} className="dialog-secondary inline-flex items-center gap-2 disabled:opacity-50"><ShieldCheck size={15}/>{recoveryBusy ? t("ui.loading.86b6d0") : t("ui.restore.from.backup.3618af")}</button></div>{recoveryError && <p role="alert" className="mt-3 text-sm text-red-600"><LocalizedText value={recoveryError}/></p>}{recoveryStatus && <div className="mt-4 max-h-48 space-y-2 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-3">{recoveryStatus.snapshots.map(snapshot => <div key={snapshot.id} className="flex items-center justify-between gap-3 rounded-lg bg-white px-3 py-2"><div><p className="text-sm font-bold text-slate-700">{new Date(snapshot.createdAt).toLocaleString(getLocale())}</p><p className="mt-0.5 text-xs text-slate-400">{t("message.c00550f7620b", { value0: snapshot.projects, value1: formatStorageSize(snapshot.bytes) })}</p></div><button type="button" disabled={Boolean(restoringSnapshot)} onClick={() => void restore(snapshot.id)} className="dialog-primary shrink-0 text-xs disabled:opacity-45">{restoringSnapshot === snapshot.id ? t("ui.restoring.b87f56") : t("ui.restore.e0534b")}</button></div>)}{!recoveryStatus.snapshots.length && <p className="py-4 text-center text-sm text-slate-500">{t("ui.no.snapshots.are.available.at.this.6747ce")}</p>}</div>}<div className="mt-7 flex justify-end"><button type="button" onClick={() => void confirm()} disabled={!workspacePath.trim()} className="dialog-primary disabled:cursor-not-allowed disabled:opacity-45">{t("ui.get.started.715ee9")}</button></div></section></main>;
};

const formatComponentSize = (sizeBytes: number) => sizeBytes > 0 ? `${(sizeBytes / 1024 / 1024).toFixed(sizeBytes >= 100 * 1024 * 1024 ? 0 : 1)} MB` : '';
const formatStorageSize = (sizeBytes = 0) => sizeBytes >= 1024 ** 3
  ? `${(sizeBytes / 1024 ** 3).toFixed(sizeBytes >= 10 * 1024 ** 3 ? 1 : 2)} GB`
  : sizeBytes > 0 ? `${(sizeBytes / 1024 ** 2).toFixed(0)} MB` : '0 MB';

const STORAGE_ITEM_LABELS: Record<StorageUsageOverview['volumes'][number]['items'][number]['kind'], string> = {
  get workspace() { return t("ui.workspace.379798"); },
  get inspiration() { return t("ui.inspiration.library.9ac871"); },
  get archive() { return t("ui.archive.5292ab"); },
  get backup() { return t("ui.backup.70e372"); },
  get cache() { return t("ui.cache.and.data.5e664f"); },
  get internal() { return t("ui.cache.and.data.5e664f"); },
};

const STORAGE_VOLUME_ROLE_LABELS: Record<StorageUsageOverview['volumes'][number]['items'][number]['kind'], string> = {
  get workspace() { return t("ui.workspace.drive.f4c689"); },
  get inspiration() { return t("ui.library.drive.d25cb5"); },
  get archive() { return t("ui.archive.drive.cb35c0"); },
  get backup() { return t("ui.backup.drive.466fd5"); },
  get cache() { return t("ui.cache.drive.43af98"); },
  get internal() { return t("ui.cache.drive.43af98"); },
};

const StorageVolumeOverview = ({ sourceSignature }: { sourceSignature: string }) => {
  useLocale();
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
  return <><div>{overview.error && <p className="mx-4 my-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700"><LocalizedText value={overview.error}/></p>}<div className="divide-y divide-slate-200">{overview.volumes.map(volume => {
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
      return <section key={volume.id} className="px-4 py-5"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-bold text-slate-800"><HardDrive size={16} className="text-blue-600"/><span>{volume.label || volume.root}</span><span className="text-xs font-bold text-blue-600">{roleLabels.join(' · ')}</span>{!volume.online && <span className="text-[10px] text-amber-700">{t("ui.offline.be1b4f")}</span>}</p><p className="mt-1 truncate font-mono text-[11px] text-slate-400" title={volume.root}>{volume.root}</p></div><div className="text-right"><p className="text-sm font-bold text-slate-700">{t("message.54b85c7684b5", { value0: overview.updatedAt ? formatStorageSize(photoFlow) : t("ui.calculating.884dbb") })}</p>{total > 0 && <p className="mt-1 text-xs text-slate-500">{t("message.47e1df59f3a1", { value0: formatStorageSize(total), value1: percent(photoFlow).toFixed(1), value2: formatStorageSize(free) })}</p>}</div></div>{total > 0 && <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-slate-200" title={t("ui.photoflow.value0.other.files.value1.free.a9f87a", { value0: formatStorageSize(photoFlow), value1: formatStorageSize(other), value2: formatStorageSize(free) })}><span className="bg-blue-500" style={{ width: `${percent(photoFlow)}%` }}/><span className="bg-slate-400" style={{ width: `${percent(other)}%` }}/></div>}<div className="mt-3 flex flex-wrap gap-x-8 gap-y-2">{itemGroups.map(item => <div key={item.key} className="flex min-w-[180px] flex-1 items-center justify-between gap-4 text-xs"><span className="font-bold text-slate-600">{item.label}</span><span className="shrink-0 font-bold text-slate-600">{item.measured ? formatStorageSize(item.bytes) : t("ui.not.yet.calculated.088e53")}</span></div>)}</div></section>;
    })}</div>
      {!overview.volumes.length && <div className="py-8 text-center text-sm text-slate-500">{overview.scanning ? t("ui.loading.drive.information.8d1030") : t("ui.no.storage.locations.to.scan.444125")}</div>}
    </div>
    <div className="grid min-w-0 gap-4 px-4 py-3.5 md:grid-cols-[minmax(220px,1fr)_minmax(280px,1.25fr)] md:items-center"><div><h4 className="text-sm font-bold text-slate-800">{t("ui.drive.and.photoflow.usage.643eff")}</h4><p className="mt-1 text-xs leading-5 text-slate-500"></p>{overview.updatedAt > 0 && <p className="mt-1 text-xs text-slate-400">{t("message.eef7c240cfe6", { value0: new Date(overview.updatedAt).toLocaleString(getLocale()), value1: overview.stale ? t("ui.updating.in.background.552f44") : '' })}</p>}</div><button type="button" onClick={() => void load(true)} disabled={refreshing || overview.scanning} className="dialog-secondary ml-auto inline-flex items-center gap-2 text-xs disabled:opacity-45"><RotateCcw size={14} className={overview.scanning ? 'animate-spin' : undefined}/>{overview.scanning ? t("ui.scanning.56b785") : t("ui.rescan.9e61f0")}</button></div>
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
    title: localizedMessage("ui.delete.the.used.installer.packages.c3fcd4"),
    message: localizedMessage("ui.value0.is.installed.and.verified.delete.6d23df", { value0: label, value1: size }),
    detail: repairHint || '以后如需重新安装，需要再次把对应 ZIP 复制到组件目录。',
    confirmLabel: localizedMessage("ui.delete.and.free.value0.fa9508", { value0: size }),
    cancelLabel: localizedMessage("ui.keep.packages.33bc72"),
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
  useLocale();
  const appDialog = useAppDialog();
  const [clearing, setClearing] = useState(false);
  const openFolder = async () => {
    const result = await window.electronAPI.openLogsFolder();
    if (!result.success) onNotice(`打开日志文件夹失败：${result.error || '未知错误'}`, 5000);
  };
  const clear = async () => {
    if (clearing || !await appDialog.confirm({
      title: localizedMessage("ui.clear.all.application.logs.46fe92"),
      message: localizedMessage("ui.this.cannot.be.undone.only.log.726939"),
      confirmLabel: localizedMessage("ui.clear.logs.cca50a"),
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
  return <SettingsRow title={t("ui.application.logs.a0e16c")} description={t("ui.logs.help.diagnose.problems.and.are.76ace3")}><div className="ml-auto flex w-fit flex-wrap gap-2"><button type="button" onClick={() => void openFolder()} className="dialog-secondary inline-flex items-center gap-2"><FolderOpen size={15}/>{t("ui.open.c77124")}</button><button type="button" onClick={() => void clear()} disabled={clearing} className="inline-flex items-center gap-2 rounded-md border border-red-200 bg-white px-3 py-2 text-sm font-bold text-red-600 hover:bg-red-50 disabled:opacity-50">{clearing ? <Loader2 size={15} className="animate-spin"/> : <Trash2 size={15}/>} {clearing ? t("ui.clearing.23098b") : t("ui.clear.logs.cca50a")}</button></div></SettingsRow>;
};

const ComponentSettings = ({ components, installPath, loading, onRefresh, onComponentsChanged, onComponentDataCleared, onNotice }: { components: ComponentStatus[]; installPath: string; loading: boolean; onRefresh: () => void | Promise<void>; onComponentsChanged: () => void | Promise<void>; onComponentDataCleared: (componentId: string) => void | Promise<void>; onNotice: (message: string, duration?: number) => void }) => {
  useLocale();
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
        await appDialog.choice({ ...presentation, cancelLabel: localizedMessage("common.cancel"), cancelDefault: true, choices: [{ value: 'install', label: localizedMessage("ui.continue.installation.b80b97") }] })
      ) === 'install');
      if (result.cancelled) return;
      if (!result.success) { onNotice(`安装“${renderText(component.name)}”失败：${result.error || '未知错误'}；请重试`, 6000); return; }
      onNotice(`已安装“${renderText(component.name)}”`);
      await offerPackageCleanup({ appDialog, kind: 'component', componentId: component.id, label: t("ui.value0.component.cba74f", { value0: renderText(component.name) }), packageSizeBytes: result.packageSizeBytes, onNotice });
      await onComponentsChanged();
    } catch (error) {
      onNotice(`安装“${renderText(component.name)}”失败：${error instanceof Error ? error.message : String(error || '未知错误')}；请重试`, 6000);
    } finally { setBusyId(''); setBusyAction(''); }
  };
  const uninstall = async (component: ComponentStatus) => {
    if (busyId) return;
    const choice = await appDialog.choice({
      title: localizedMessage("ui.uninstall.value0.141191", { value0: renderText(component.name) }),
      message: localizedMessage("ui.also.remove.this.component.s.user.3de78a"),
      detail: localizedMessage("ui.keep.data.to.resume.using.it.088c30"),
      choices: [
        { value: 'keep', label: localizedMessage("ui.uninstall.and.keep.data.36a92f") },
        { value: 'clear', label: localizedMessage("ui.uninstall.and.remove.data.aeb68f"), tone: 'danger' },
      ],
      cancelLabel: localizedMessage("common.cancel"),
      defaultValue: 'keep',
    });
    if (!choice) return;
    const clearUserData = choice === 'clear';
    setBusyId(component.id);
    setBusyAction('uninstall');
    try {
      const result = await window.electronAPI.uninstallComponent(component.id, { clearUserData });
      if (result.cancelled) { onNotice('已取消卸载', 2500); return; }
      if (!result.success) { onNotice(`卸载“${renderText(component.name)}”失败：${result.error || '未知错误'}；请重试`, 6000); return; }
      if (clearUserData) await onComponentDataCleared(component.id);
      const cleanupWarning = result.cleanupWarnings?.filter(Boolean).join('；');
      onNotice(cleanupWarning
        ? `已卸载“${renderText(component.name)}”，但部分数据未能清理：${cleanupWarning}`
        : clearUserData ? `已卸载“${renderText(component.name)}”并清空用户数据和相关缓存` : `已卸载“${renderText(component.name)}”，用户数据已保留`, cleanupWarning ? 7000 : 4000);
      await onComponentsChanged();
    } catch (error) {
      onNotice(`卸载“${renderText(component.name)}”失败：${error instanceof Error ? error.message : String(error || '未知错误')}；请重试`, 6000);
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
      if (!result.success) { onNotice(`${enabled ? '启用' : '禁用'}“${renderText(component.name)}”失败：${result.error || '未知错误'}；请重试`, 6000); return; }
      onNotice(enabled ? `已启用“${renderText(component.name)}”` : `已禁用“${renderText(component.name)}”；组件文件和用户数据均已保留`);
      await onComponentsChanged();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || '未知错误');
      const requiresRestart = /No handler registered|components-set-enabled|is not a function/i.test(message);
      onNotice(requiresRestart
        ? '插件管理接口已更新，请完全退出并重新启动应用后再试'
        : `${enabled ? '启用' : '禁用'}“${renderText(component.name)}”失败：${message}；请重试`, 6000);
    } finally { setBusyId(''); setBusyAction(''); }
  };
  return <SettingsPageGroup title={t("ui.install.and.uninstall.components.61a5e3")}>
    <SettingsRow title={t("ui.component.folder.a9fcaf")} description={t("ui.place.prebuilt.zip.packages.in.this.ae155e")}><div className="flex min-w-0 gap-2"><input readOnly value={installPath || '正在读取组件根目录'} className="form-input min-w-0 flex-1 font-mono text-xs"/><button type="button" onClick={() => void onRefresh()} disabled={loading} className="dialog-secondary inline-flex shrink-0 items-center gap-2"><RotateCcw size={15} className={loading ? 'animate-spin' : ''}/>{t("ui.refresh.aee887")}</button><button type="button" onClick={() => void openFolder()} className="dialog-secondary inline-flex shrink-0 items-center gap-2"><FolderOpen size={15}/>{t("ui.open.c77124")}</button></div></SettingsRow>
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
      const details = [renderText(component.description), stateText, component.version ? `版本 ${component.version}` : '', component.installed ? formatComponentSize(component.sizeBytes) : '', component.error || component.packageError || ''].filter(Boolean).join(' · ');
      return <SettingsRow key={component.id} title={renderText(component.name)} description={details}><div className="ml-auto flex w-fit items-center gap-2"><button type="button" onClick={() => void openFolder(component.installed ? component.id : undefined)} className="dialog-secondary inline-flex items-center gap-1.5"><FolderOpen size={13}/>{t("ui.folder.52daa7")}</button>{hasInstallablePackage && (!component.installed || component.updateAvailable || !component.compatible) && <button type="button" onClick={() => void install(component)} disabled={Boolean(busyId)} className="dialog-primary inline-flex items-center gap-2 disabled:opacity-45">{busy && busyAction === 'install' && <Loader2 size={14} className="animate-spin"/>}{component.updateAvailable ? t("ui.update.3055a0") : component.installed ? t("ui.reinstall.453ad4") : t("ui.install.e8f88f")}</button>}{canToggle && <button type="button" onClick={() => void setEnabled(component, component.enabled === false)} disabled={Boolean(busyId)} className={`dialog-secondary inline-flex items-center gap-1.5 disabled:opacity-45 ${component.enabled === false ? '!border-emerald-500' : ''}`}>{busy && busyAction === 'toggle' ? <Loader2 size={13} className="animate-spin"/> : <Power size={13}/>} {component.enabled === false ? t("ui.enable.f4f0ea") : t("ui.disable.7df5c4")}</button>}{canUninstall ? <button type="button" onClick={() => void uninstall(component)} disabled={Boolean(busyId)} className="dialog-secondary inline-flex items-center gap-2 !border-red-200 !text-red-600 hover:!bg-red-50 disabled:opacity-45">{busy && busyAction === 'uninstall' && <Loader2 size={13} className="animate-spin"/>}{t("ui.uninstall.06bc14")}</button> : component.source === 'development' ? <span className="text-xs font-bold text-amber-600">{t("ui.development.component.ad1574")}</span> : component.installed ? <span className="text-xs text-slate-400">{t("ui.system.component.778a76")}</span> : null}</div></SettingsRow>;
    })}
    {!loading && !components.length && <SettingsRow title={t("ui.component.status.f7530c")} description={t("ui.the.component.folder.contains.no.packages.ecab0a")}><span className="ml-auto block w-fit text-xs text-slate-400">{t("ui.no.components.4bd022")}</span></SettingsRow>}
  </SettingsPageGroup>;
};

const SettingsNavigator = ({ activeSection, componentPages, onSelect }: { activeSection: SettingsSection; componentPages: ComponentSettingsPageContribution[]; onSelect: (section: SettingsSection) => void }) => {
  useLocale();
  const items: Array<{ id: SettingsSection; label: string; description: string; icon: React.ReactNode }> = [
    { id: 'general', label: t("ui.interface.785d65"), description: t("ui.colors.tabs.and.home.page.694649"), icon: <Palette size={18}/> },
    { id: 'project', label: t("ui.projects.79f326"), description: t("ui.new.projects.and.categories.a5da89"), icon: <FolderOpen size={18}/> },
    { id: 'import', label: t("ui.import.576d81"), description: t("ui.defaults.sd.cards.and.behind.the.d4f49c"), icon: <Download size={18}/> },
    { id: 'video', label: t("ui.video.c20f76"), description: t("ui.playback.shortcuts.and.video.tools.e8598f"), icon: <Video size={18}/> },
    { id: 'backup', label: t("ui.storage.a3434a"), description: t("ui.workspace.folders.archives.and.backups.4774e7"), icon: <HardDrive size={18}/> },
    { id: 'components', label: t("ui.plugins.35fcbd"), description: t("ui.install.and.uninstall.optional.plugins.99e99d"), icon: <Puzzle size={18}/> },
    ...componentPages.map(page => ({ id: componentSettingsSectionKey(page), label: renderText(page.label), description: renderText(page.pageTitle), icon: <ComponentIcon src={page.iconUrl} size={18}/> })),
  ];
  const renderItem = (item: typeof items[number]) => <button key={item.id} type="button" aria-current={activeSection === item.id ? 'page' : undefined} onClick={() => onSelect(item.id)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition ${activeSection === item.id ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}><span className={`shrink-0 ${activeSection === item.id ? 'text-blue-600' : 'text-slate-400'}`}>{item.icon}</span><span className="min-w-0 truncate text-sm font-bold">{item.label}</span></button>;
  return <nav aria-label={t("ui.settings.categories.dfb699")} className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-3">
    <div className="flex items-center gap-2 px-3 pb-3 pt-2 text-sm font-bold text-slate-800"><Settings size={17} className="text-blue-600"/>{t("ui.settings.df3d58")}</div>
    <div className="space-y-1">{items.map(renderItem)}</div>
    <div className="mt-3 space-y-1 border-t border-slate-200 pt-3">
      {renderItem({ id: 'about', label: t("ui.about.52d25a"), description: t("ui.version.project.and.open.source.licenses.6b4a37"), icon: <AtSign size={18}/> })}
      {renderItem({ id: 'feedback', label: t("ui.feedback.7a2bf1"), description: t("ui.send.feedback.to.the.developer.8c1e8f"), icon: <MessageSquareText size={18}/> })}
      {renderItem({ id: 'privacy', label: t("ui.privacy.and.data.d51db0"), description: 'Local data and open-source edition', icon: <ShieldCheck size={18}/> })}
    </div>
  </nav>;
};

const PROJECT_TOOLBAR_ITEMS: Record<ProjectToolbarActionId, { label: string; description: string; icon: React.ReactNode }> = {
  'filename-selection': { get label() { return t("ui.select.by.file.name.611d95"); }, get description() { return t("ui.organize.selected.media.into.a.selection.7d3786"); }, icon: <FileText size={17}/> },
  'select-media': { get label() { return t("ui.selection.8c8db6"); }, get description() { return t("ui.add.the.selected.images.or.videos.4d9146"); }, icon: <CheckCircle2 size={17}/> },
  'video-tools': { get label() { return t("ui.video.tools.d2442c"); }, get description() { return t("ui.extract.storyboard.frames.transcode.and.split.41243a"); }, icon: <Video size={17}/> },
  'image-tools': { get label() { return t("ui.image.tools.3c27a4"); }, get description() { return t("ui.convert.images.to.jpg.and.extract.0aa37b"); }, icon: <ImageIcon size={17}/> },
  photoshop: { get label() { return t("ui.open.in.photoshop.ed860c"); }, get description() { return t("ui.open.selected.images.raw.or.psd.d09621"); }, icon: <span className="flex h-[17px] w-[17px] items-center justify-center rounded border border-blue-400 text-[9px] font-bold text-blue-600">Ps</span> },
  'office-extract': { get label() { return t("ui.office.documents.3a80cd"); }, get description() { return t("ui.extract.document.images.and.access.extension.053439"); }, icon: <FileImage size={17}/> },
  'version-management': { get label() { return t("ui.version.history.79b622"); }, get description() { return t("ui.manage.media.versions.or.mark.folder.6f4142"); }, icon: <GitBranch size={17}/> },
};

const ProjectToolbarSettingsEditor = ({ value, onChange }: { value: AppConfig['projectToolbar']; onChange: (value: AppConfig['projectToolbar']) => void }) => {
  useLocale();
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
      <span className="min-w-0 flex-1"><span className="block text-sm font-bold text-slate-700">{t("ui.show.only.available.tools.41139e")}</span><span className="mt-1 block text-xs leading-5 text-slate-500">{t("ui.only.available.features.are.shown.when.97b321")}</span></span>
      <input type="checkbox" checked={value.onlyShowAvailable} onChange={event => onChange({ ...value, onlyShowAvailable: event.target.checked })}/>
    </label>
    {value.order.map((id, index) => {
      const item = PROJECT_TOOLBAR_ITEMS[id];
      const visible = !hidden.has(id);
      return <div key={id} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }} onDrop={event => { event.preventDefault(); if (draggedId) reorder(draggedId, id); setDraggedId(undefined); }} className={`flex items-center gap-3 border-b border-slate-200 px-3 py-3 last:border-b-0 ${draggedId === id ? 'opacity-60' : ''}`}>
        <button type="button" draggable onDragStart={event => { setDraggedId(id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id); }} onDragEnd={() => setDraggedId(undefined)} title={t("ui.drag.to.reorder.0e4e4a")} aria-label={t("ui.drag.value0.to.reorder.3bef28", { value0: item.label })} className="cursor-grab rounded p-1 text-slate-400 hover:bg-slate-100 active:cursor-grabbing"><GripVertical size={17}/></button>
        <span className={`shrink-0 ${visible ? 'text-blue-600' : 'text-slate-300'}`}>{item.icon}</span>
        <span className={`min-w-0 flex-1 ${visible ? '' : 'opacity-50'}`}><span className="block text-sm font-bold text-slate-700">{item.label}</span><span className="mt-0.5 block text-xs text-slate-400">{item.description}</span></span>
        <div className="flex shrink-0 items-center gap-1"><button type="button" disabled={index === 0} onClick={() => move(id, -1)} title={t("ui.move.up.f853a7")} aria-label={t("ui.move.value0.up.06dcd4", { value0: item.label })} className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-25"><ChevronUp size={15}/></button><button type="button" disabled={index === value.order.length - 1} onClick={() => move(id, 1)} title={t("ui.move.down.e75e8b")} aria-label={t("ui.move.value0.down.6426e9", { value0: item.label })} className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-25"><ChevronDown size={15}/></button></div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs font-medium text-slate-600"><input type="checkbox" checked={visible} onChange={() => toggle(id)}/>{t("ui.show.4e1449")}</label>
      </div>;
    })}
    <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-3 py-2.5"><span className="text-xs text-slate-400">{t("ui.drag.the.handles.on.the.left.b8967a")}</span><button type="button" onClick={() => onChange({ order: [...PROJECT_TOOLBAR_ACTION_IDS], hidden: [], onlyShowAvailable: false })} className="text-xs font-bold text-blue-600 hover:text-blue-700">{t("ui.reset.to.defaults.ba2e93")}</button></div>
  </div>;
};

const SdDriveHistorySettings = ({ value, videoToolsAvailable, videoToolsUnavailableMessage, onChange, onOpenVideoPanel }: { value: AppConfig['smartImport']; videoToolsAvailable: boolean; videoToolsUnavailableMessage: string; onChange: (value: AppConfig['smartImport']) => void; onOpenVideoPanel: (panel: 'split' | 'transcode') => void }) => {
  useLocale();
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
      title: localizedMessage("ui.clear.all.sd.card.history.70f33c"),
      message: localizedMessage("ui.all.recorded.device.paths.and.import.67b303"),
      confirmLabel: localizedMessage("ui.clear.history.17ac4a"),
      cancelLabel: localizedMessage("common.cancel"),
      tone: 'danger',
    })) return;
    onChange({ ...value, sdPath: '', sdPaths: [], sdDriveTypes: {}, sdDriveVideoActions: {}, sdDeviceIds: {}, sdDevices: [] });
  };
  return <div className="settings-group-card overflow-hidden rounded-xl border border-slate-200 bg-white">
    {!videoToolsAvailable && <div role="status" className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-xs font-bold text-amber-700">{t("message.2336b277cba3", { value0: videoToolsUnavailableMessage })}</div>}
    {entryCount ? <div className="divide-y divide-slate-200">
      {records.map(record => <div key={record.deviceId} className="px-4 py-3.5">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center">
          <div className="min-w-0"><p title={record.lastMountPath} className="truncate font-mono text-sm font-bold text-slate-700">{record.lastMountPath}</p><p className={`mt-1 text-xs ${record.enabled && record.confirmedAt > 0 ? 'text-emerald-600' : 'text-amber-600'}`}>{record.confirmedAt <= 0 ? t("ui.confirm.the.device.identity.again.in.ddcfc7") : record.enabled ? t("ui.enabled.matched.automatically.by.device.identity.19bbaf") : t("ui.history.only.not.read.automatically.28baab")}</p></div>
          <div className="flex flex-wrap items-center gap-3"><label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-600"><input type="checkbox" checked={record.enabled} onChange={event => setRecordEnabled(record.deviceId, event.target.checked)}/>{t("ui.enable.f4f0ea")}</label><select aria-label={t("ui.default.import.type.for.value0.93d631", { value0: record.lastMountPath })} value={record.type} onChange={event => setRecordType(record.deviceId, event.target.value as 'work' | 'broll')} className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-xs font-medium text-slate-600"><option value="work">{t("ui.original.media.2a53f2")}</option><option value="broll">{t("ui.behind.the.scenes.6bcb07")}</option></select></div>
          <button type="button" onClick={() => removeRecord(record.deviceId)} aria-label={t("ui.delete.history.for.value0.c54351", { value0: record.lastMountPath })} title={t("ui.delete.history.entry.b8cbdc")} className="inline-flex w-fit items-center gap-1.5 rounded-md border border-red-200 px-2.5 py-2 text-xs font-bold text-red-600 hover:bg-red-50"><Trash2 size={13}/>{t("ui.delete.2f9daa")}</button>
        </div>
        <div className="mt-3 grid gap-2 border-t border-slate-100 pt-3 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2.5"><label className={`inline-flex items-center gap-2 text-xs font-medium ${videoToolsAvailable ? 'cursor-pointer text-slate-700' : 'cursor-not-allowed text-slate-400'}`} title={!videoToolsAvailable ? videoToolsUnavailableMessage : undefined}><input type="checkbox" disabled={!videoToolsAvailable} checked={record.splitVideosOnImport} onChange={event => setRecordVideoAction(record.deviceId, 'splitVideosOnImport', event.target.checked)}/>{t("ui.split.videos.on.import.2db6f4")}</label><button type="button" disabled={!videoToolsAvailable} title={!videoToolsAvailable ? videoToolsUnavailableMessage : undefined} className="text-xs font-bold text-blue-600 hover:text-blue-700 disabled:cursor-not-allowed disabled:text-slate-400" onClick={() => onOpenVideoPanel('split')}>{t("ui.split.rules.952277")}</button></div>
          <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2.5"><label className={`inline-flex items-center gap-2 text-xs font-medium ${videoToolsAvailable ? 'cursor-pointer text-slate-700' : 'cursor-not-allowed text-slate-400'}`} title={!videoToolsAvailable ? videoToolsUnavailableMessage : undefined}><input type="checkbox" disabled={!videoToolsAvailable} checked={record.transcodeVideosOnImport} onChange={event => setRecordVideoAction(record.deviceId, 'transcodeVideosOnImport', event.target.checked)}/>{t("ui.transcode.videos.on.import.ecca40")}</label><button type="button" disabled={!videoToolsAvailable} title={!videoToolsAvailable ? videoToolsUnavailableMessage : undefined} className="text-xs font-bold text-blue-600 hover:text-blue-700 disabled:cursor-not-allowed disabled:text-slate-400" onClick={() => onOpenVideoPanel('transcode')}>{t("ui.transcoding.settings.9fa715")}</button></div>
        </div>
      </div>)}
      {legacyPaths.map(path => {
      const enabled = selectedPaths.includes(path);
      const videoActions = value.sdDriveVideoActions?.[path] || { splitVideosOnImport: false, transcodeVideosOnImport: false };
      return <div key={path} className="px-4 py-3.5">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center">
          <div className="min-w-0"><p title={path} className="truncate font-mono text-sm font-bold text-slate-700">{path}</p><p className="mt-1 text-xs text-amber-600">{t("ui.legacy.drive.record.the.settings.below.b8c721")}</p></div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-600"><input type="checkbox" checked={enabled} onChange={event => setLegacyEnabled(path, event.target.checked)}/>{t("ui.enable.f4f0ea")}</label>
            <select aria-label={t("ui.default.import.type.for.value0.93d631", { value0: path })} value={value.sdDriveTypes[path] || 'work'} onChange={event => setLegacyType(path, event.target.value as 'work' | 'broll')} className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-xs font-medium text-slate-600"><option value="work">{t("ui.original.media.2a53f2")}</option><option value="broll">{t("ui.behind.the.scenes.6bcb07")}</option></select>
          </div>
          <button type="button" onClick={() => removeLegacy(path)} aria-label={t("ui.delete.history.for.value0.c54351", { value0: path })} title={t("ui.delete.history.entry.b8cbdc")} className="inline-flex w-fit items-center gap-1.5 rounded-md border border-red-200 px-2.5 py-2 text-xs font-bold text-red-600 hover:bg-red-50"><Trash2 size={13}/>{t("ui.delete.2f9daa")}</button>
        </div>
        <div className="mt-3 grid gap-2 border-t border-slate-100 pt-3 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2.5"><label className={`inline-flex items-center gap-2 text-xs font-medium ${videoToolsAvailable ? 'cursor-pointer text-slate-700' : 'cursor-not-allowed text-slate-400'}`} title={!videoToolsAvailable ? videoToolsUnavailableMessage : undefined}><input type="checkbox" disabled={!videoToolsAvailable} checked={videoActions.splitVideosOnImport} onChange={event => setLegacyVideoAction(path, 'splitVideosOnImport', event.target.checked)}/>{t("ui.split.videos.on.import.2db6f4")}</label><button type="button" disabled={!videoToolsAvailable} title={!videoToolsAvailable ? videoToolsUnavailableMessage : undefined} className="text-xs font-bold text-blue-600 hover:text-blue-700 disabled:cursor-not-allowed disabled:text-slate-400" onClick={() => onOpenVideoPanel('split')}>{t("ui.split.rules.952277")}</button></div>
          <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2.5"><label className={`inline-flex items-center gap-2 text-xs font-medium ${videoToolsAvailable ? 'cursor-pointer text-slate-700' : 'cursor-not-allowed text-slate-400'}`} title={!videoToolsAvailable ? videoToolsUnavailableMessage : undefined}><input type="checkbox" disabled={!videoToolsAvailable} checked={videoActions.transcodeVideosOnImport} onChange={event => setLegacyVideoAction(path, 'transcodeVideosOnImport', event.target.checked)}/>{t("ui.transcode.videos.on.import.ecca40")}</label><button type="button" disabled={!videoToolsAvailable} title={!videoToolsAvailable ? videoToolsUnavailableMessage : undefined} className="text-xs font-bold text-blue-600 hover:text-blue-700 disabled:cursor-not-allowed disabled:text-slate-400" onClick={() => onOpenVideoPanel('transcode')}>{t("ui.transcoding.settings.9fa715")}</button></div>
        </div>
      </div>;
    })}</div> : <div className="px-4 py-8 text-center"><HardDrive size={26} className="mx-auto text-slate-300"/><p className="mt-3 text-sm font-medium text-slate-500">{t("ui.no.sd.card.devices.recorded.4f525c")}</p><p className="mt-1 text-xs text-slate-400">{t("ui.devices.appear.here.automatically.after.you.f00b35")}</p></div>}
    {entryCount > 0 && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3"><span className="text-xs text-slate-400">{t("message.4d4639659aa6", { count: entryCount })}</span><button type="button" onClick={() => void clear()} className="text-xs font-bold text-red-600 hover:text-red-700">{t("ui.clear.all.history.f75e72")}</button></div>}
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
  useLocale();
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
    <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><h3 className="text-base font-bold text-slate-800">{title}</h3><button type="button" onClick={onClose} aria-label={t("common.close")} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X size={18}/></button></header>
    <div className="min-h-0 overflow-y-auto p-5">{children}</div>
  </section>
</div>;
};

const SettingsPage = ({ activeSection, backupProjectFocus, onClearBackupProjectFocus, config, components, componentInstallPath, componentsLoading, onRefreshComponents, onComponentsChanged, onSave, onConfigRestored, getDefaultSettings }: { activeSection: BuiltInSettingsSection; backupProjectFocus?: WorkspaceProject | null; onClearBackupProjectFocus?: () => void; config: AppConfig; components: ComponentStatus[]; componentInstallPath: string; componentsLoading: boolean; onRefreshComponents: () => void | Promise<void>; onComponentsChanged: () => void | Promise<void>; onSave: (config: AppConfig) => boolean | Promise<boolean>; onConfigRestored: (config: AppConfig) => void; getDefaultSettings: () => AppConfig | Promise<AppConfig> }) => {
  const toast = useUserFacingToast();
  const onNotice = useCallback((message: string, duration?: number) => { toast.show(message, duration); }, [toast]);
  const appDialog = useAppDialog();
  const t = useTranslation();
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
    if (!await appDialog.confirm({ title: localizedMessage("ui.delete.category.value0.9537c4", { value0: name }), message: localizedMessage("ui.only.this.custom.category.will.be.c3a72e"), confirmLabel: localizedMessage("ui.delete.category.e6bd48"), tone: 'danger' })) return;
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
      title: localizedMessage("ui.choose.backup.type.113bc9"),
      message: localizedMessage("ui.choose.where.to.store.workspace.backups.f41c17"),
      choices: [
        { value: 'local', label: localizedMessage("ui.local.or.external.drive.5a15ed") },
        { value: 'nas', label: localizedMessage("ui.network.storage.nas.7a6122") },
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
      title: localizedMessage("ui.change.backup.type.0aa30f"),
      message: localizedMessage("ui.the.current.backup.destination.will.no.df7e3c"),
      confirmLabel: localizedMessage("ui.change.backup.type.219fbd"),
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
    if (!await appDialog.confirm({ title: localizedMessage("ui.clean.up.expired.backups.e532a5"), message: localizedMessage("ui.estimated.expired.snapshots.to.delete.value0.881292", { value0: expired, value1: formatStorageSize(reclaimable) }), confirmLabel: localizedMessage("ui.clean.up.expired.backups.b7614e"), tone: 'danger' })) return;
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
    if (!await appDialog.confirm({ title: localizedMessage("ui.restore.the.entire.workspace.f61982"), message: localizedMessage("ui.choose.an.empty.folder.to.restore.c02bd7"), confirmLabel: localizedMessage("ui.choose.restore.location.ae5354") })) return;
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
    if (!project || !await appDialog.confirm({ title: localizedMessage("ui.restore.project.value0.068662", { value0: project?.name || '' }), message: localizedMessage("ui.the.project.will.return.to.its.e281c5"), confirmLabel: localizedMessage("ui.restore.project.52a1d5") })) return;
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
      title: localizedMessage("ui.reset.settings.to.defaults.8a1edd"),
      message: localizedMessage("ui.keep.workspace.folders.and.component.settings.808c45"),
      confirmLabel: localizedMessage("ui.reset.settings.3b1473"),
    })) return;
    const defaults = await getDefaultSettings();
    patchSettings(current => ({ ...defaults, workspacePath: current.workspacePath.trim() || defaults.workspacePath, workspacePaths: normalizeWorkspacePaths(current.workspacePath, current.workspacePaths), componentSettings: current.componentSettings, componentSettingsRevisions: current.componentSettingsRevisions }));
  };
  return <section className="min-h-full w-full bg-slate-50"><div className="mx-auto w-full max-w-6xl space-y-10 px-8 py-10 lg:px-12">
    <h2 className="text-2xl font-bold text-slate-900">{SETTINGS_SECTION_LABELS[activeSection]}</h2>
    {activeSection === 'general' && <>
    <SettingsPageGroup title={t("ui.appearance.86a63f")}>
      <SettingsRow title={t('settings.language.title')} description={t('settings.language.description')}><div className="ml-auto max-w-sm"><LanguageSelector value={normalizeLanguage(draft.language)} save={language => saveCoordinatorRef.current!.enqueueMutation(current => ({ ...current, language }))}/></div></SettingsRow>
      <SettingsRow title={t("ui.color.theme.88906e")} description={t("ui.use.the.system.theme.light.mode.6a26b4")}><div className="ml-auto flex w-fit rounded-lg border border-slate-200 p-1">{([['system', t("ui.system.default.269bda")], ['light', t("ui.light.aa0819")], ['dark', t("ui.dark.a6b75d")]] as const).map(([theme, label]) => <button key={theme} onClick={() => update('theme', theme)} className={`rounded-md px-4 py-2 text-sm font-bold transition ${draft.theme === theme ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-800'}`}>{label}</button>)}</div></SettingsRow>
      <SettingsRow title={t("ui.open.inspiration.library.on.startup.f71182")} description={t("ui.automatically.open.the.inspiration.library.when.1bcf7d")}><SettingsToggle label={t("ui.open.inspiration.library.on.startup.f71182")} checked={draft.pinInspirationLibrary} onChange={checked => update('pinInspirationLibrary', checked)}/></SettingsRow>
      <SettingsRow title={t("ui.show.character.birthdays.28530d")} description={t("ui.show.character.birthday.reminders.on.the.40656c")}><SettingsToggle label={t("ui.show.character.birthdays.28530d")} checked={draft.birthdayEnabled} onChange={checked => update('birthdayEnabled', checked)}/></SettingsRow>
    </SettingsPageGroup>
    <SettingsPageGroup title={t("ui.file.browsing.ad064e")}>
      <SettingsRow title={t("ui.enable.version.tree.3a10b6")} description={t("ui.projects.with.version.data.open.their.04dbf2")}><SettingsToggle label={t("ui.enable.version.tree.3a10b6")} checked={draft.versionTreeEnabled} onChange={checked => update('versionTreeEnabled', checked)}/></SettingsRow>
      <SettingsRow title={t("ui.open.files.and.folders.9df542")} description={t("ui.single.click.mode.opens.items.immediately.d94f27")}><select value={draft.itemOpenMode} onChange={event => update('itemOpenMode', event.target.value as AppConfig['itemOpenMode'])} className="form-input ml-auto max-w-sm"><option value="single">{t("ui.single.click.to.open.default.996185")}</option><option value="double">{t("ui.double.click.to.open.1ad577")}</option></select></SettingsRow>
      <SettingsRow title={t("ui.image.rating.display.bce305")} description={t("ui.both.modes.read.and.write.the.82e564")}><select value={draft.favoriteDisplayMode} onChange={event => update('favoriteDisplayMode', event.target.value as AppConfig['favoriteDisplayMode'])} className="form-input ml-auto max-w-sm"><option value="binary">{t("ui.like.unlike.62a0cd")}</option><option value="stars">{t("ui.one.to.five.stars.7f4752")}</option></select></SettingsRow>
      <SettingsRow title={t("ui.default.folder.sort.order.e43a7e")} description=""><select value={draft.defaultFolderSort} onChange={event => update('defaultFolderSort', event.target.value as AppConfig['defaultFolderSort'])} className="form-input ml-auto max-w-sm"><option value="date">{t("ui.date.modified.newest.first.3e03c9")}</option><option value="name">{t("ui.file.name.a.z.fd9d22")}</option><option value="size">{t("ui.size.largest.first.465948")}</option></select></SettingsRow>
      <SettingsRow title={t("ui.folder.initial.filter.2705ea")} description={t("ui.show.an.a.z.index.in.f7d508")}><SettingsToggle label={t("ui.show.folder.initial.filter.650548")} checked={draft.folderAlphabetFilterEnabled} onChange={checked => update('folderAlphabetFilterEnabled', checked)}/></SettingsRow>
    </SettingsPageGroup>
    <section><h3 className="text-sm font-bold text-slate-800">{t("ui.project.toolbar.a0215c")}</h3><p className="mt-1 text-xs leading-5 text-slate-500">{t("ui.choose.and.reorder.the.project.toolbar.e9143f")}</p><ProjectToolbarSettingsEditor value={draft.projectToolbar} onChange={projectToolbar => update('projectToolbar', projectToolbar)}/></section>
    <SettingsPageGroup title={t("ui.settings.df3d58")}>
      <SettingsRow title={t("ui.reset.settings.3b1473")} description={t("ui.keep.workspace.folders.and.component.settings.7536bc")}><button type="button" onClick={() => void restoreDefaults()} className="dialog-secondary ml-auto flex w-fit items-center gap-2"><RotateCcw size={15}/>{t("ui.reset.settings.3b1473")}</button></SettingsRow>
    </SettingsPageGroup>
    </>}
    {activeSection === 'project' && <SettingsPageGroup title={t("ui.folder.name.presets.830272")}>
      <div className="px-4 py-3.5"><h4 className="text-sm font-bold text-slate-800">{t("ui.presets.and.order.ef97af")}</h4><p className="mt-1 text-xs leading-5 text-slate-500">{t("ui.choose.a.preset.when.creating.or.a160eb")}</p></div>
      {progressNamePresets.map((name, index) => editingProgressNamePreset === name ? <form key={name} className="flex items-start gap-2 bg-blue-50 px-4 py-3" onSubmit={event => { event.preventDefault(); saveProgressNamePreset(); }}><Pencil size={17} className="mt-2.5 shrink-0 text-blue-600"/><div className="min-w-0 flex-1"><input autoFocus value={editingProgressNamePresetValue} maxLength={24} onChange={event => { setEditingProgressNamePresetValue(event.target.value); setProgressNamePresetError(''); }} className="form-input"/>{progressNamePresetError && <p className="mt-1.5 text-xs text-red-500"><LocalizedText value={progressNamePresetError}/></p>}</div><button type="submit" className="dialog-primary shrink-0">{t("ui.save.a3030b")}</button><button type="button" onClick={() => { setEditingProgressNamePreset(''); setEditingProgressNamePresetValue(''); setProgressNamePresetError(''); }} title={t("common.cancel")} className="rounded-md p-2.5 text-slate-400 hover:bg-slate-200"><X size={16}/></button></form> : <div key={name} draggable onDragStart={event => { setDraggedProgressNamePreset(name); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', name); }} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }} onDrop={event => { event.preventDefault(); reorderProgressNamePreset(draggedProgressNamePreset || event.dataTransfer.getData('text/plain'), name); setDraggedProgressNamePreset(''); }} onDragEnd={() => setDraggedProgressNamePreset('')} className={`flex min-w-0 items-center gap-3 px-4 py-3 transition ${draggedProgressNamePreset === name ? 'bg-blue-50 opacity-60' : 'bg-white'}`}><span title={t("ui.drag.to.reorder.a80364")} className="cursor-grab text-slate-400 active:cursor-grabbing"><GripVertical size={17}/></span><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600"><GitBranch size={16}/></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-800">{name}</p><p className="mt-0.5 text-xs text-slate-400">{t("ui.use.as.the.folder.name.5e8c73")}</p></div><div className="flex shrink-0 items-center gap-1"><button type="button" disabled={index === 0} onClick={() => moveProgressNamePreset(name, -1)} title={t("ui.move.up.f853a7")} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-25"><ChevronUp size={15}/></button><button type="button" disabled={index === progressNamePresets.length - 1} onClick={() => moveProgressNamePreset(name, 1)} title={t("ui.move.down.e75e8b")} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-25"><ChevronDown size={15}/></button><button type="button" onClick={() => { setEditingProgressNamePreset(name); setEditingProgressNamePresetValue(name); setProgressNamePresetError(''); }} title={t("ui.edit.preset.e7edbe")} className="ml-1 rounded-md p-2 text-slate-400 hover:bg-blue-50 hover:text-blue-600"><Pencil size={15}/></button><button type="button" onClick={() => removeProgressNamePreset(name)} title={t("ui.delete.preset.28786d")} className="rounded-md p-2 text-slate-400 hover:bg-red-50 hover:text-red-500"><Trash2 size={15}/></button></div></div>)}
      {addingProgressNamePreset ? <form className="flex items-start gap-2 bg-slate-50 px-4 py-3" onSubmit={event => { event.preventDefault(); addProgressNamePreset(); }}><Plus size={17} className="mt-2.5 shrink-0 text-blue-600"/><div className="min-w-0 flex-1"><input autoFocus value={newProgressNamePreset} maxLength={24} onChange={event => { setNewProgressNamePreset(event.target.value); setProgressNamePresetError(''); }} placeholder={t("ui.enter.a.new.preset.name.6ea117")} className="form-input"/>{progressNamePresetError && <p className="mt-1.5 text-xs text-red-500"><LocalizedText value={progressNamePresetError}/></p>}</div><button type="submit" className="dialog-primary shrink-0">{t("ui.add.7a8a11")}</button><button type="button" onClick={() => { setAddingProgressNamePreset(false); setNewProgressNamePreset(''); setProgressNamePresetError(''); }} title={t("common.cancel")} className="rounded-md p-2.5 text-slate-400 hover:bg-slate-200"><X size={16}/></button></form> : <button type="button" onClick={() => setAddingProgressNamePreset(true)} className="flex w-full items-center gap-3 bg-slate-50 px-4 py-3 text-left text-sm font-bold text-blue-600 hover:bg-blue-50"><span className="flex h-8 w-8 items-center justify-center rounded-lg border border-dashed border-blue-300 bg-white"><Plus size={17}/></span>{t("ui.add.preset.0a8668")}</button>}
    </SettingsPageGroup>}
    {activeSection === 'project' && <>
    <SettingsPageGroup title={t("ui.new.project.0e1a70")}>
      <SettingsRow title={t("ui.create.a.planning.folder.for.new.2ecbc4")} description={t("ui.create.a.folder.named.in.new.3d5714")}><SettingsToggle label={t("ui.create.a.planning.folder.for.new.2ecbc4")} checked={draft.createPlanningFolder} onChange={checked => update('createPlanningFolder', checked)}/></SettingsRow>
    </SettingsPageGroup>
    <SettingsPageGroup title={t("ui.project.status.c85ca6")}>
      <SettingsRow title={t("ui.change.project.category.after.import.5a51d7")} description={t("ui.after.importing.work.media.into.an.0eed60")}><SettingsToggle label={t("ui.change.project.category.after.import.5a51d7")} checked={draft.smartImport.autoMoveProjectAfterSdImport} onChange={checked => update('smartImport', { ...draft.smartImport, autoMoveProjectAfterSdImport: checked })}/></SettingsRow>
    </SettingsPageGroup>
    <SettingsPageGroup title={t("ui.project.categories.33b163")}>
      <div className="px-4 py-3.5"><h4 className="text-sm font-bold text-slate-800">{t("ui.categories.and.order.7396c4")}</h4><p className="mt-1 text-xs leading-5 text-slate-500">{t("ui.drag.the.handles.or.use.the.140366")}</p></div>
      {projectCategories.map((name, index) => { const builtIn = (BUILT_IN_PROJECT_STATUSES as readonly string[]).includes(name); return <div key={name} draggable onDragStart={event => { setDraggedProjectCategory(name); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', name); }} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }} onDrop={event => { event.preventDefault(); reorderProjectCategory(draggedProjectCategory || event.dataTransfer.getData('text/plain'), name); setDraggedProjectCategory(''); }} onDragEnd={() => setDraggedProjectCategory('')} className={`flex min-w-0 items-center gap-3 px-4 py-3 transition ${draggedProjectCategory === name ? 'bg-blue-50 opacity-60' : 'bg-white'}`}>
        <span title={t("ui.drag.to.reorder.a80364")} className="cursor-grab text-slate-400 active:cursor-grabbing"><GripVertical size={17}/></span>
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${builtIn ? 'bg-blue-50 text-blue-600' : 'bg-violet-50 text-violet-600'}`}><Folder size={16}/></span>
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-800">{projectStatusLabel(name)}</p><p className="mt-0.5 text-xs text-slate-400">{builtIn ? t("ui.built.in.category.cannot.be.edited.0e231e") : t("ui.custom.category.23c6bb")}</p></div>
        <div className="flex shrink-0 items-center gap-1"><button type="button" disabled={index === 0} onClick={() => moveProjectCategory(name, -1)} title={t("ui.move.up.f853a7")} aria-label={t("ui.move.value0.up.7dcf22", { value0: projectStatusLabel(name) })} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-25"><ChevronUp size={15}/></button><button type="button" disabled={index === projectCategories.length - 1} onClick={() => moveProjectCategory(name, 1)} title={t("ui.move.down.e75e8b")} aria-label={t("ui.move.value0.down.db85e8", { value0: projectStatusLabel(name) })} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-25"><ChevronDown size={15}/></button>{builtIn ? <span title={t("ui.built.in.categories.cannot.be.deleted.bd43f0")} className="ml-1 flex h-8 w-8 items-center justify-center text-slate-300"><LockKeyhole size={14}/></span> : <button type="button" onClick={() => void removeProjectCategory(name)} title={t("ui.delete.category.e6bd48")} aria-label={t("ui.delete.category.value0.10de1a", { value0: projectStatusLabel(name) })} className="ml-1 rounded-md p-2 text-slate-400 hover:bg-red-50 hover:text-red-500"><Trash2 size={15}/></button>}</div>
      </div>; })}
      {addingProjectCategory ? <form className="flex items-start gap-2 bg-slate-50 px-4 py-3" onSubmit={event => { event.preventDefault(); addProjectCategory(); }}><Plus size={17} className="mt-2.5 shrink-0 text-blue-600"/><div className="min-w-0 flex-1"><input autoFocus value={newProjectCategory} maxLength={24} onChange={event => { setNewProjectCategory(event.target.value); setProjectCategoryError(''); }} placeholder={t("ui.enter.a.new.category.name.ca51d2")} className="form-input"/>{projectCategoryError && <p className="mt-1.5 text-xs text-red-500"><LocalizedText value={projectCategoryError}/></p>}</div><button type="submit" className="dialog-primary shrink-0">{t("ui.add.7a8a11")}</button><button type="button" onClick={() => { setAddingProjectCategory(false); setNewProjectCategory(''); setProjectCategoryError(''); }} title={t("common.cancel")} aria-label={t("ui.cancel.new.category.72792e")} className="rounded-md p-2.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700"><X size={16}/></button></form> : <button type="button" onClick={() => setAddingProjectCategory(true)} className="flex w-full items-center gap-3 bg-slate-50 px-4 py-3 text-left text-sm font-bold text-blue-600 hover:bg-blue-50"><span className="flex h-8 w-8 items-center justify-center rounded-lg border border-dashed border-blue-300 bg-white"><Plus size={17}/></span>{t("ui.add.category.351398")}</button>}
    </SettingsPageGroup>
    </>}
    {activeSection === 'privacy' && <PrivacySettings/>}
    {(activeSection === 'backup' || activeSection === 'storage') && <>
      <SettingsPageGroup title={t("ui.usage.89abe8")}>
        <StorageVolumeOverview sourceSignature={[...normalizeWorkspacePaths(draft.workspacePath, draft.workspacePaths), inspirationLibrarySettings.rootPath, draft.archive.targetPath, draft.backup.targetPath, draft.mediaCache.directory].join('\u0000')}/>
      </SettingsPageGroup>
      <SettingsPageGroup title={t("ui.workspace.folders.3db7b0")}>
      <SettingsRow title={t("ui.project.workspace.folders.768c29")} description={t("ui.read.projects.from.multiple.drives.new.52b55a")} align="start"><WorkspaceFoldersPicker primary={draft.workspacePath} values={draft.workspacePaths} onChange={(workspacePath, workspacePaths) => patchSettings(() => ({ workspacePath, workspacePaths }))}/></SettingsRow>
      <SettingsRow title={t("ui.inspiration.library.folder.042b84")} description={t("ui.saved.immediately.and.included.in.drive.0d23db")}><WorkspaceFolderPicker value={inspirationLibrarySettings.rootPath} onChange={rootPath => void updateInspirationLibraryRoot(rootPath)}/></SettingsRow>
      <SettingsRow title={t("ui.use.a.separate.archive.drive.a5d18e")} description={draft.archive.enabled ? (archiveStatus.state === 'connected' ? t("ui.archive.drive.connected.4f0f2f") : archiveStatus.state === 'offline' ? t("ui.archive.drive.is.offline.849602") : t("ui.choose.an.archive.drive.683059")) : t("ui.move.archived.projects.to.another.storage.18e846")}><SettingsToggle label={t("ui.use.a.separate.archive.drive.a5d18e")} checked={draft.archive.enabled} onChange={checked => { if (checked && !draft.archive.targetPath) void chooseArchiveTarget(); else update('archive', { ...draft.archive, enabled: checked }); }}/></SettingsRow>
      <SettingsRow title={t("ui.archive.drive.location.246944")} description={archiveStatus.freeBytes !== undefined ? t("ui.free.value0.value1.14e0b3", { value0: formatStorageSize(archiveStatus.freeBytes), value1: formatStorageSize(archiveStatus.totalBytes) }) : t("ui.choose.where.to.store.archived.projects.e90722")}><fieldset disabled={!draft.archive.enabled} className="flex min-w-0 gap-2 disabled:opacity-50"><input readOnly value={draft.archive.targetPath} placeholder={t("ui.no.archive.drive.selected.e517fc")} className="form-input min-w-0 flex-1"/><button type="button" onClick={() => void chooseArchiveTarget()} className="dialog-secondary shrink-0">{t("ui.choose.c11330")}</button><button type="button" onClick={() => void window.electronAPI.openArchiveTarget()} disabled={!draft.archive.targetPath} className="dialog-secondary shrink-0 disabled:opacity-45">{t("ui.open.c77124")}</button></fieldset></SettingsRow>
      </SettingsPageGroup>
      <SettingsPageGroup title={t("ui.backup.70e372")}>
      <SettingsRow title={t("ui.enable.workspace.backup.b7b56a")} description={!draft.backup.enabled ? t("ui.backups.are.disabled.32db22") : backupStatus.state === 'protected' ? t("ui.workspace.is.protected.9eadd9") : backupStatus.state === 'running' ? t("ui.backup.in.progress.53bfb3") : backupStatus.error || t("ui.backups.are.enabled.48e2b5")}><SettingsToggle label={t("ui.enable.workspace.backup.b7b56a")} checked={draft.backup.enabled} onChange={checked => { if (checked) void enableBackup(); else { setBackupTargetSetup(''); patchSettings(current => ({ backup: { ...current.backup, enabled: false } })); } }}/></SettingsRow>
      <SettingsRow title={t("ui.backup.type.2a29bf")} description={t("ui.choose.a.local.drive.external.drive.64df93")}><select disabled={!backupTargetConfigurable || Boolean(backupAction)} value={activeBackupTargetType} onChange={event => void switchBackupTargetType(event.target.value as AppConfig['backup']['targetType'])} className="form-input ml-auto max-w-sm disabled:opacity-50"><option value="local">{t("ui.local.or.external.drive.5a15ed")}</option><option value="nas">{t("ui.network.storage.nas.7a6122")}</option></select></SettingsRow>
      {activeBackupTargetType === 'local' && <SettingsRow title={t("ui.local.backup.location.faefc2")} description={t("ui.backups.pause.while.this.location.is.4c221b")}><fieldset disabled={!backupTargetConfigurable || Boolean(backupAction)} className="flex min-w-0 gap-2 disabled:opacity-50"><input readOnly value={draft.backup.targetType === 'local' ? draft.backup.targetPath : ''} placeholder={t("ui.no.backup.location.selected.83e635")} className="form-input min-w-0 flex-1"/><button type="button" onClick={() => void chooseBackupTarget()} className="dialog-secondary shrink-0">{t("ui.choose.c11330")}</button><button type="button" onClick={() => void window.electronAPI.openBackupTarget()} disabled={draft.backup.targetType !== 'local' || !draft.backup.targetPath} className="dialog-secondary shrink-0 disabled:opacity-45">{t("ui.open.c77124")}</button></fieldset></SettingsRow>}
      {activeBackupTargetType === 'nas' && <>
        <SettingsRow title={t("ui.nas.share.path.268c0b")} description={backupStatus.connection?.connected ? t("ui.nas.connected.4860e1") : t("ui.enter.a.network.share.path.accessible.547416")}><input value={nasPath} onChange={event => setNasPath(event.target.value)} placeholder="\\studio-nas\backup" className="form-input font-mono"/></SettingsRow>
        <SettingsRow title={t("ui.nas.credentials.e77335")} description={t("ui.passwords.are.stored.in.windows.credential.23137c")}><div className="grid gap-2 sm:grid-cols-2"><input value={nasUsername} onChange={event => setNasUsername(event.target.value)} autoComplete="username" placeholder={t("ui.username.1a3f06")} className="form-input"/><input type="password" value={nasPassword} onChange={event => setNasPassword(event.target.value)} autoComplete="new-password" placeholder={draft.backup.nas.credentialRef ? t("ui.saved.leave.blank.to.keep.unchanged.5c3c02") : t("ui.password.a621ab")} className="form-input"/></div></SettingsRow>
        <SettingsRow title={t("ui.save.and.test.nas.628a5b")} description={backupStatus.connection?.checkedAt ? t("ui.last.verified.value0.c5c4c9", { value0: new Date(backupStatus.connection.checkedAt).toLocaleString(getLocale()) }) : t("ui.save.the.settings.and.test.the.5d2bc0")}><div className="ml-auto flex w-fit gap-2"><button type="button" onClick={() => void saveNas()} disabled={!nasPath.trim() || Boolean(backupAction)} className="dialog-primary disabled:opacity-45">{backupAction === 'nas-save' ? t("ui.testing.3d7fed") : t("ui.save.and.test.a693d6")}</button><button type="button" onClick={() => void window.electronAPI.openBackupTarget()} disabled={Boolean(backupAction) || !draft.backup.enabled || draft.backup.targetType !== 'nas' || !draft.backup.targetPath} className="dialog-secondary disabled:opacity-45">{t("ui.open.c77124")}</button></div></SettingsRow>
        <SettingsRow title={t("ui.limit.nas.bandwidth.fa742a")} description={t("ui.prevent.backups.from.using.all.local.4a6dea")}><SettingsToggle label={t("ui.limit.nas.bandwidth.fa742a")} checked={draft.backup.nas.limitEnabled} onChange={checked => patchSettings(current => ({ backup: { ...current.backup, nas: { ...current.backup.nas, limitEnabled: checked } } }))}/></SettingsRow>
        {draft.backup.nas.limitEnabled && <SettingsRow title={t("ui.nas.bandwidth.limit.schedule.881fd7")} description={t("ui.set.the.bandwidth.limit.and.when.a015e7")}><div className="grid gap-2 sm:grid-cols-3"><input aria-label={t("ui.nas.bandwidth.limit.a3dc9a")} type="number" min="1" max="1000" value={draft.backup.nas.bandwidthLimitMBps} onChange={event => { const bandwidthLimitMBps = Math.max(1, Number(event.target.value) || 1); patchSettings(current => ({ backup: { ...current.backup, nas: { ...current.backup.nas, bandwidthLimitMBps } } })); }} className="form-input"/><input aria-label={t("ui.nas.limit.start.time.6cd897")} type="time" value={draft.backup.nas.limitStart} onChange={event => { const limitStart = event.target.value; patchSettings(current => ({ backup: { ...current.backup, nas: { ...current.backup.nas, limitStart } } })); }} className="form-input"/><input aria-label={t("ui.nas.limit.end.time.db308d")} type="time" value={draft.backup.nas.limitEnd} onChange={event => { const limitEnd = event.target.value; patchSettings(current => ({ backup: { ...current.backup, nas: { ...current.backup.nas, limitEnd } } })); }} className="form-input"/></div></SettingsRow>}
      </>}
      <SettingsRow title={t("ui.back.up.now.e5c63c")} description={backupStatus.latestAt ? t("ui.last.success.value0.snapshots.value1.6484f9", { value0: new Date(backupStatus.latestAt).toLocaleString(getLocale()), value1: backupStatus.snapshotCount || 0 }) : t("ui.create.a.backup.of.the.current.0730b5")}><button type="button" onClick={() => void runBackup()} disabled={!draft.backup.enabled || !draft.backup.targetPath || Boolean(backupAction)} className="dialog-primary ml-auto flex w-fit items-center gap-2 disabled:opacity-45">{backupAction === 'run' ? <Loader2 size={15} className="animate-spin"/> : <ShieldCheck size={15}/>}{t("ui.back.up.now.e5c63c")}</button></SettingsRow>
      <SettingsRow title={t("ui.snapshot.retention.535769")} description={t("ui.keep.historical.snapshots.or.only.the.e7cfe8")}><select value={draft.backup.mode} onChange={event => { const mode = event.target.value as AppConfig['backup']['mode']; patchSettings(current => ({ backup: { ...current.backup, mode } })); }} className="form-input ml-auto max-w-sm"><option value="history">{t("ui.keep.historical.snapshots.8c5c8d")}</option><option value="latest">{t("ui.keep.only.the.latest.snapshot.ce2345")}</option></select></SettingsRow>
      {draft.backup.mode === 'history' && <SettingsRow title={t("ui.historical.snapshot.retention.2066b3")} description={t("ui.snapshots.are.retained.automatically.on.a.9ba248")}><p className="text-sm text-slate-500">{t("ui.daily.for.7.days.weekly.for.532e3a")}</p></SettingsRow>}
      <SettingsRow title={t("ui.automatic.daily.backup.64b809")} description={t("ui.check.on.the.first.launch.each.68093c")}><SettingsToggle label={t("ui.automatic.daily.backup.64b809")} checked={draft.backup.automaticDaily} onChange={checked => patchSettings(current => ({ backup: { ...current.backup, automaticDaily: checked } }))}/></SettingsRow>
      <SettingsRow title={t("ui.back.up.after.import.2a5c19")} description={t("ui.back.up.the.current.workspace.after.6197f0")}><SettingsToggle label={t("ui.back.up.after.import.2a5c19")} checked={draft.backup.afterImport} onChange={checked => patchSettings(current => ({ backup: { ...current.backup, afterImport: checked } }))}/></SettingsRow>
      <SettingsRow title={t("ui.clean.up.expired.backups.b7614e")} description={t("ui.delete.snapshots.outside.the.retention.policy.6200ca")}><div className="ml-auto w-fit text-right"><p className="text-sm font-bold text-slate-700">{backupSpace.success ? t("ui.estimated.expired.snapshots.to.delete.value0.3f3ad5", { value0: backupSpace.expiredSnapshotCount || 0, value1: formatStorageSize(backupSpace.estimatedReclaimableBytes) }) : t("ui.connect.the.backup.location.to.see.3fba5e")}</p>{backupSpace.success && <p className="mt-1 text-xs text-slate-400">{t("message.f9535614e40a", { value0: formatStorageSize(backupSpace.actualBytes), value1: formatStorageSize(backupSpace.deduplicatedBytes) })}</p>}<button type="button" onClick={() => void cleanupBackup()} disabled={!backupSpace.success || Boolean(backupAction)} className="dialog-secondary mt-3 text-xs disabled:opacity-45">{t("ui.clean.up.expired.backups.b7614e")}</button></div></SettingsRow>
      <div ref={backupSnapshotsRef} className="divide-y divide-slate-200">
        {backupProjectFocus && <SettingsRow title={t("ui.project.backup.value0.c74419", { value0: backupProjectFocus.name })} description={t("ui.only.workspace.snapshots.containing.value0.are.d1888b", { value0: backupProjectFocus.name })}><button type="button" onClick={onClearBackupProjectFocus} className="dialog-secondary ml-auto block w-fit text-xs">{t("ui.view.all.snapshots.2f9a1c")}</button></SettingsRow>}
        <SettingsRow title={t("ui.backup.snapshots.eb428d")} description={backupProjectFocus ? t("ui.choose.a.snapshot.containing.this.project.57860e") : t("ui.verify.snapshots.or.restore.a.workspace.56c1df")} align="start"><div className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200">{visibleBackupSnapshots.map(snapshot => { const focusedProject = backupProjectFocus ? snapshot.projectItems?.find(project => project.name === backupProjectFocus.name) : undefined; return <div key={snapshot.id} className="p-3"><p className="text-sm font-bold text-slate-800">{new Date(snapshot.createdAt).toLocaleString(getLocale())}</p><p className="mt-1 text-xs text-slate-500">{t("message.2ad6ce5bcee3", { value0: snapshot.projects, value1: snapshot.files, value2: formatStorageSize(snapshot.bytes) })}</p><div className="mt-2 flex flex-wrap items-center gap-2"><button type="button" onClick={() => void verifyBackup(snapshot.id)} disabled={Boolean(backupAction)} className="dialog-secondary text-xs disabled:opacity-45">{t("ui.verify.154723")}</button>{focusedProject ? backupProjectFocus?.availability === 'missing' && <button type="button" onClick={() => void restoreProject(snapshot.id, focusedProject.id)} disabled={Boolean(backupAction)} className="dialog-secondary text-xs disabled:opacity-45">{t("ui.restore.this.project.c7552b")}</button> : <><button type="button" onClick={() => void restoreWorkspace(snapshot.id)} disabled={Boolean(backupAction)} className="dialog-secondary text-xs disabled:opacity-45">{t("ui.restore.workspace.3e3b3c")}</button>{Boolean(snapshot.projectItems?.length) && <><select value={restoreProjects[snapshot.id] || snapshot.projectItems?.[0]?.id || ''} onChange={event => setRestoreProjects(current => ({ ...current, [snapshot.id]: event.target.value }))} className="rounded-md border border-slate-300 bg-white px-2 py-2 text-xs">{snapshot.projectItems?.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><button type="button" onClick={() => { const selectedId = restoreProjects[snapshot.id] || snapshot.projectItems?.[0]?.id || ''; setRestoreProjects(current => ({ ...current, [snapshot.id]: selectedId })); void restoreProject(snapshot.id); }} disabled={Boolean(backupAction)} className="dialog-secondary text-xs disabled:opacity-45">{t("ui.restore.project.52a1d5")}</button></>}</>}</div></div>; })}{!visibleBackupSnapshots.length && <p className="p-4 text-center text-sm text-slate-500">{backupProjectFocus ? t("ui.no.backup.snapshots.are.available.for.6d81b6", { value0: backupProjectFocus.name }) : t("ui.no.backup.snapshots.available.26604a")}</p>}</div></SettingsRow>
      </div>
      </SettingsPageGroup>
      <SettingsPageGroup title={t("ui.cache.e3ca04")}>
        <MediaCacheSettings config={draft.mediaCache} onChange={mediaCache => update('mediaCache', mediaCache)}/>
        <InterfaceCacheSettings onNotice={onNotice}/>
        <SettingsRow title={t("ui.automatically.clean.up.deleted.project.data.834eb5")} description={t("ui.check.on.the.first.launch.each.f1c29f")}><SettingsToggle label={t("ui.automatically.clean.up.deleted.project.data.834eb5")} checked={draft.autoCleanupDeletedProjectData} onChange={checked => update('autoCleanupDeletedProjectData', checked)}/></SettingsRow>
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
    <SettingsPageGroup title={t("ui.video.browsing.d3b560")}>
      <SettingsRow title={t("ui.left.and.right.arrow.keys.a9b102")} description={t("ui.use.the.left.and.right.arrow.9fbd18")}><select value={videoPlaybackSettings.arrowKeyAction} onChange={event => updateVideoPlaybackSettings({ ...videoPlaybackSettings, arrowKeyAction: event.target.value as 'seek' | 'navigate' })} className="form-input ml-auto max-w-sm"><option value="seek">{t("ui.seek.backward.forward.5.seconds.default.d6b397")}</option><option value="navigate">{t("ui.previous.next.video.62b00b")}</option></select></SettingsRow>
      <SettingsRow title={t("ui.show.subtitles.by.default.b516b8")} description={t("ui.subtitles.are.still.discovered.and.listed.39304c")}><SettingsToggle label={t("ui.show.subtitles.by.default.b516b8")} checked={videoPlaybackSettings.subtitlesEnabled} onChange={checked => updateVideoPlaybackSettings({ ...videoPlaybackSettings, subtitlesEnabled: checked })}/></SettingsRow>
      <SettingsRow title={t("ui.preferred.subtitle.languages.929cc2")} description={t("ui.match.language.codes.in.order.separated.674274")}><input value={videoPlaybackSettings.subtitlePreferredLanguages.join(', ')} onChange={event => updateVideoPlaybackSettings({ ...videoPlaybackSettings, subtitlePreferredLanguages: event.target.value.split(',').map(value => value.trim().toLowerCase()).filter(Boolean).slice(0, 8) })} className="form-input ml-auto max-w-sm"/></SettingsRow>
      <SettingsRow title={t("ui.subtitle.font.size.229db9")} description={t("ui.set.the.default.subtitle.font.size.b35f3a")}><div className="ml-auto flex w-full max-w-sm items-center gap-3"><input type="range" min={MIN_SUBTITLE_FONT_SIZE} max={MAX_SUBTITLE_FONT_SIZE} step={1} value={videoPlaybackSettings.subtitleSize} onChange={event => updateVideoPlaybackSettings({ ...videoPlaybackSettings, subtitleSize: normalizeSubtitleFontSize(event.target.value) })} aria-label={t("ui.subtitle.font.size.229db9")} className="min-w-0 flex-1 accent-blue-500"/><output aria-live="polite" className="w-10 rounded-md border border-slate-300 bg-white px-2 py-1 text-center text-sm font-bold tabular-nums text-slate-700">{videoPlaybackSettings.subtitleSize}</output></div></SettingsRow>
      <SettingsRow title={t("ui.subtitle.style.d1e721")} description={t("ui.high.contrast.uses.stronger.outlines.and.dc8a86")}><select value={videoPlaybackSettings.subtitleStyle} onChange={event => updateVideoPlaybackSettings({ ...videoPlaybackSettings, subtitleStyle: event.target.value as AppConfig['videoPlayback']['subtitleStyle'] })} className="form-input ml-auto max-w-sm"><option value="standard">{t("ui.standard.6bea77")}</option><option value="high-contrast">{t("ui.high.contrast.8cf6bf")}</option></select></SettingsRow>

    </SettingsPageGroup>
    <SettingsPageGroup title={t("ui.video.shortcuts.e9cb29")}>
      <div className="px-4 py-3.5"><p className="text-xs leading-5 text-slate-500">{t("ui.click.edit.then.press.a.key.677bd3")}</p></div>
      {VIDEO_ACTIONS.map(action => {
        const recording = recordingShortcutAction === action.id;
        return <SettingsRow key={action.id} title={renderText(action.label)}><div className="ml-auto flex w-full max-w-md items-center gap-2"><div aria-label={t("ui.current.shortcut.for.value0.859d30", { value0: renderText(action.label) })} className="flex min-h-10 min-w-0 flex-1 flex-wrap items-center gap-1.5 rounded-md border border-slate-300 bg-slate-50 px-3 py-1.5">{shortcutBindings[action.id].map(chord => <kbd key={chord} className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-bold text-slate-700 shadow-sm">{formatVideoShortcutChord(chord)}</kbd>)}</div><button type="button" aria-label={t("ui.edit.shortcut.for.value0.40b9a3", { value0: renderText(action.label) })} aria-pressed={recording} onClick={() => setRecordingShortcutAction(current => current === action.id ? '' : action.id)} onKeyDown={event => captureShortcut(action.id, event)} onBlur={() => setRecordingShortcutAction(current => current === action.id ? '' : current)} className={`h-10 shrink-0 rounded-md px-3 text-xs font-bold ${recording ? 'bg-blue-600 text-white ring-2 ring-blue-300' : 'dialog-secondary'}`}>{recording ? t("ui.press.a.key.3f65b0") : t("ui.edit.37090f")}</button><button type="button" onClick={() => { updateVideoPlaybackSettings({ ...videoPlaybackSettings, shortcuts: { ...shortcutBindings, [action.id]: [...action.defaults] } }); setRecordingShortcutAction(''); }} className="dialog-secondary h-10 shrink-0 px-3 text-xs">{t("ui.reset.cb5d68")}</button></div></SettingsRow>;
      })}
      {shortcutConflicts.length > 0 && <div className="px-4 py-3.5"><p role="alert" className="rounded-md bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">{t("message.5658d6a763da", { value0: shortcutConflicts.map(item => `${item.chord}（${item.actions.join(' / ')}）`).join('；') })}</p></div>}
      <div className="p-4"><div className="rounded-lg border border-slate-200 bg-slate-50 p-3"><textarea aria-label={t("ui.import.and.export.video.shortcuts.009f83")} value={shortcutTransfer} onChange={event => setShortcutTransfer(event.target.value)} placeholder={t("ui.shortcut.json.a0a78b")} className="form-input h-28 w-full resize-y font-mono text-xs"/><div className="mt-2 flex flex-wrap gap-2"><button type="button" onClick={() => setShortcutTransfer(exportVideoShortcuts(shortcutBindings))} className="rounded bg-slate-700 px-3 py-1.5 text-xs font-bold text-white">{t("ui.export.configuration.429ea3")}</button><button type="button" onClick={() => { try { updateVideoPlaybackSettings({ ...videoPlaybackSettings, shortcuts: importVideoShortcuts(shortcutTransfer) }); onNotice('快捷键配置已导入'); } catch (error) { onNotice(error instanceof Error ? error.message : '快捷键配置无效', 5000); } }} className="rounded bg-blue-600 px-3 py-1.5 text-xs font-bold text-white">{t("ui.import.configuration.b48b65")}</button><button type="button" onClick={() => updateVideoPlaybackSettings({ ...videoPlaybackSettings, shortcuts: defaultVideoShortcutBindings() })} className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold">{t("ui.reset.all.6baa0e")}</button></div></div></div>
    </SettingsPageGroup>
    <SettingsPageGroup title={t("ui.video.trimming.11ca06")}>
      <SettingsRow title={t("ui.trim.export.mode.419414")} description={draft.videoTools.trim.exportMode === 'fast' ? t("ui.fast.export.preserves.quality.without.re.24012b") : t("ui.precise.export.re.encodes.the.selected.d51efc")}><select value={draft.videoTools.trim.exportMode} onChange={event => update('videoTools', { ...draft.videoTools, trim: { exportMode: event.target.value as AppConfig['videoTools']['trim']['exportMode'] } })} className="form-input ml-auto max-w-sm"><option value="fast">{t("ui.fast.export.default.121630")}</option><option value="exact">{t("ui.precise.export.eec2f3")}</option></select></SettingsRow>
    </SettingsPageGroup>
    </>}
    {activeSection === 'import' && <>
    <SettingsPageGroup title={t("ui.import.behavior.9fde40")}>
      <SettingsRow title={t("ui.generate.missing.jpgs.for.raw.files.953341")} description={t("ui.generate.a.jpg.when.a.raw.e9cb7d")}><SettingsToggle label={t("ui.generate.missing.jpgs.for.raw.files.953341")} checked={draft.importDefaults.generateJpgFromRaw} onChange={checked => update('importDefaults', { ...draft.importDefaults, generateJpgFromRaw: checked })}/></SettingsRow>
      <SettingsRow title={t("ui.delete.source.files.after.import.by.d5faa1")} description={t("ui.keep.source.files.when.disabled.each.1ef499")}><SettingsToggle label={t("ui.delete.source.files.after.import.by.d5faa1")} checked={draft.importDefaults.deleteSourceAfterImport} onChange={checked => update('importDefaults', { ...draft.importDefaults, deleteSourceAfterImport: checked })}/></SettingsRow>
    </SettingsPageGroup>
    <SettingsPageGroup title={t("ui.import.from.sd.card.48ca18")}>
      <SettingsRow title={t("ui.automatically.import.sd.cards.on.startup.f302f9")} description={t("ui.after.startup.check.identified.removable.sd.3cef03")}><SettingsToggle label={t("ui.automatically.import.sd.cards.on.startup.f302f9")} checked={draft.smartImport.autoStart} onChange={checked => update('smartImport', { ...draft.smartImport, autoStart: checked })}/></SettingsRow>
      <SettingsRow title={t("ui.import.date.range.9823bc")} description={t("ui.filter.media.from.physical.sd.cards.1111ec")}><select value={draft.smartImport.dateFilter} onChange={event => update('smartImport', { ...draft.smartImport, dateFilter: event.target.value as AppConfig['smartImport']['dateFilter'] })} className="form-input ml-auto max-w-sm"><option value="all">{t("ui.all.media.7970c4")}</option><option value="today">{t("ui.captured.today.4bdbd9")}</option><option value="today_yesterday">{t("ui.captured.today.or.yesterday.ba1de8")}</option></select></SettingsRow>
      <SettingsRow title={t("ui.recorded.sd.card.devices.24693b")} description={t("ui.set.the.import.type.and.video.7da8f1")} align="start"><SdDriveHistorySettings value={draft.smartImport} videoToolsAvailable={videoToolsAvailable} videoToolsUnavailableMessage={videoToolsUnavailableMessage} onChange={smartImport => update('smartImport', smartImport)} onOpenVideoPanel={setImportVideoPanel}/></SettingsRow>
    </SettingsPageGroup>
    {videoToolsAvailable && importVideoPanel === 'split' && <SettingsPanel title={t("ui.video.split.settings.650c76")} onClose={() => setImportVideoPanel(null)}><VideoSplitView embedded settingsOnly/></SettingsPanel>}
    {videoToolsAvailable && importVideoPanel === 'transcode' && <SettingsPanel title={t("ui.video.transcoding.settings.3441e0")} onClose={() => setImportVideoPanel(null)}><VideoTranscodeView embedded settingsOnly initialSettings={draft.videoTools.transcode} onSettingsChange={transcode => patchSettings(current => ({ videoTools: { ...current.videoTools, transcode } }))}/></SettingsPanel>}
    </>}
    {activeSection === 'about' && <AboutSettings/>}
    {activeSection === 'feedback' && <FeedbackSettings/>}
  </div></section>;
};

const FeedbackSettings = () => <SettingsPageGroup title="问题和建议"><SettingsRow title="GitHub Issues" description="在公开仓库报告问题；请先移除私人路径、照片和其他敏感信息。"><button type="button" className="dialog-secondary" onClick={() => void window.electronAPI.openExternal('https://github.com/akiyastudio/qingstudio/issues')}>打开问题列表</button></SettingsRow></SettingsPageGroup>;

const PrivacySettings = () => <SettingsPageGroup title="开源版与数据"><SettingsRow title="本地数据" description="项目和配置保存在本机；本版本未配置官方统计、崩溃上报或更新服务。" children={null}/><SettingsRow title="开源许可" description="主程序原创代码采用 Apache 2.0；第三方依赖适用各自许可证。" children={null}/><SettingsRow title="插件" description="本仓库不包含插件实现。自行安装的插件可能访问文件和网络，请审查其来源与权限。" children={null}/></SettingsPageGroup>;

const SoftwareLicenseSettings = () => {
  useLocale();
  const openExternal = (url: string) => window.electronAPI.openExternal(url);
  return (
    <SettingsPageGroup title={t("ui.third.party.software.and.runtimes.4085ff")}>
      {THIRD_PARTY_SOFTWARE_LICENSES.map(item => <SettingsRow key={`${item.group}-${item.name}`} title={item.name} description={`${renderText(item.group)} · ${renderText(item.version)} · ${renderText(item.purpose)}${item.note ? ` · ${renderText(item.note)}` : ''}`}><div className="ml-auto flex w-fit items-center gap-2"><span className="text-xs font-bold text-slate-500">{renderText(item.license)}</span><button type="button" onClick={() => openExternal(item.sourceUrl)} className="dialog-secondary inline-flex items-center gap-1.5 text-xs">{t("ui.source.a488e9")}<ExternalLink size={13}/></button><button type="button" onClick={() => openExternal(item.licenseUrl)} className="dialog-secondary inline-flex items-center gap-1.5 text-xs">{t("ui.license.310c62")}<ExternalLink size={13}/></button></div></SettingsRow>)}
    </SettingsPageGroup>
  );
};

const AboutSettings = () => <div className="space-y-10"><SettingsPageGroup title="照片流开源版"><SettingsRow title="版本" description={`${__APP_VERSION__} · Apache 2.0`} children={null}/><SettingsRow title="源码与更新" description="从 GitHub 获取源码和项目动态。"><button type="button" className="dialog-secondary" onClick={() => void window.electronAPI.openExternal('https://github.com/akiyastudio/qingstudio')}>打开源码仓库</button></SettingsRow></SettingsPageGroup><SoftwareLicenseSettings/></div>;

const MediaCacheSettings = ({ config, onChange }: { config: AppConfig['mediaCache']; onChange: (config: AppConfig['mediaCache']) => void }) => {
  useLocale();
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
    <SettingsRow title={t("ui.thumbnail.cache.limit.dd9c41")} description={t("ui.remove.the.least.recently.used.thumbnails.da5887")}><div className="ml-auto flex max-w-xs items-center gap-2"><input type="number" min={0} step={0.1} inputMode="decimal" value={capacityInput} onChange={event => setCapacityInput(event.target.value)} onBlur={commitCapacity} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} className="form-input"/><span className="text-sm text-slate-500">GB</span></div></SettingsRow>
    <SettingsRow title={t("ui.thumbnail.cache.folder.3d267a")} description={t("ui.storage.location.for.image.raw.and.ab24d9")}><div className="flex min-w-0 gap-2"><input readOnly value={info.path || config.directory || '默认应用缓存目录'} className="form-input min-w-0 flex-1 font-mono text-xs"/><button onClick={chooseDirectory} className="dialog-secondary shrink-0">{t("ui.choose.c11330")}</button></div></SettingsRow>
    <SettingsRow title={t("ui.automatically.clear.cache.older.than.30.521b39")} description={t("ui.check.on.the.first.launch.each.d00526")}><SettingsToggle label={t("ui.automatically.clear.cache.older.than.30.521b39")} checked={config.autoCleanup30Days} onChange={checked => onChange({ ...config, autoCleanup30Days: checked })}/></SettingsRow>
    <SettingsRow title={t("ui.current.thumbnail.cache.2b1935")} description={t("ui.value0.cached.files.value1.b6791e", { value0: sizeText, value1: info.fileCount })}><button onClick={clearAll} disabled={busy} className="ml-auto flex w-fit items-center gap-1.5 rounded-md border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50 disabled:opacity-50"><Trash2 size={14}/>{busy ? t("ui.cleaning.6dfddc") : t("ui.clear.cache.e32c07")}</button></SettingsRow>
  </>;
};

const InterfaceCacheSettings = ({ onNotice }: { onNotice: (message: string, duration?: number) => void }) => {
  useLocale();
  const appDialog = useAppDialog();
  const [busy, setBusy] = useState(false);
  const clear = async () => {
    if (busy || !await appDialog.confirm({
      title: localizedMessage("ui.clear.the.interface.cache.9231b6"),
      message: localizedMessage("ui.the.cache.is.managed.automatically.clear.0d9ea6"),
      confirmLabel: localizedMessage("ui.clean.up.cache.b2fd2e"),
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
  return <SettingsRow title={t("ui.interface.cache.70802b")} description={t("ui.usually.no.cleanup.is.needed.clear.8c4c0d")}><button type="button" disabled={busy} onClick={() => void clear()} className="dialog-secondary ml-auto flex w-fit items-center gap-2 disabled:opacity-50"><Trash2 size={14}/>{busy ? t("ui.cleaning.6dfddc") : t("ui.clear.interface.cache.6d825c")}</button></SettingsRow>;
};

export { WorkspaceSetupPage, SettingsNavigator, SettingsPage };
