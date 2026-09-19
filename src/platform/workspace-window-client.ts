import type { WorkspaceWindowContext, WorkspaceWindowPage, WorkspaceWindowSeed } from '../contracts/workspace-windows';
import type { AppConfig } from '../types';
export type { WorkspaceWindowSeed, NativeWorkspaceTab, WorkspaceWindowContext, WindowPanelSnapshot, WorkspaceWindowsAPI } from '../contracts/workspace-windows';

let initialContext: WorkspaceWindowContext | null = null;
let initialStartup: { config: AppConfig; privacyConsentRequired: boolean } | null = null;
let localOpen: ((seed: WorkspaceWindowSeed, reuse: boolean) => unknown) | null = null;
export const setLocalWorkspaceTabOpener = (open: typeof localOpen) => { localOpen = open; };
export const initializeWorkspaceWindow = async () => {
  const api = window.electronAPI;
  if (!api?.workspaceWindows) return;
  initialContext = await api.workspaceWindows.context();
  if (initialContext.root) return;
  // The application is already running. Read current authoritative settings
  // before the first render; startup migrations and defaults belong to the root.
  if (api.apiContractVersion !== 1 || typeof api.getPrivacyConsentState !== 'function') throw new Error('组件版本不一致，请重启软件');
  const [config, consent] = await Promise.all([api.loadConfig(), api.getPrivacyConsentState()]);
  if (!config) throw new Error('无法读取设置，请重新打开标签页');
  initialStartup = { config, privacyConsentRequired: consent.privacyNoticeVersion !== consent.currentPrivacyNoticeVersion || consent.termsVersion !== consent.currentTermsVersion };
};
export const workspaceWindowContext = () => initialContext;
export const workspaceWindowStartup = () => initialStartup;
export const openNativeWorkspaceTab = (seed: WorkspaceWindowSeed, reuse = true) => {
  if (localOpen) { void Promise.resolve(localOpen(seed, reuse)).catch(error => window.dispatchEvent(new CustomEvent('photoflow:window-error', { detail: String(error.message || error) }))); return; }
  void window.electronAPI.workspaceWindows?.open(seed, { reuse }).catch(error => window.dispatchEvent(new CustomEvent('photoflow:window-error', { detail: String(error.message || error) })));
};
export const nativeProjectSeed = (page: Omit<WorkspaceWindowPage, 'id'>): WorkspaceWindowSeed => ({
  kind: page.kind, label: page.project?.name || '灵感库',
  key: `${page.kind}:${page.project?.workspacePath || page.inspirationRootPath || ''}:${page.projectId}:${page.currentRelativePath}`,
  page: { ...page, id: crypto.randomUUID() },
});
