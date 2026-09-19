import type { ComponentHostAction, ComponentPageInstance, ComponentPageOpenScope, LogEntry, ProjectFileEntry, WorkspaceProject } from '../types';

export interface WorkspaceWindowPage {
  id: string;
  kind: 'project' | 'inspiration';
  projectId: string;
  project: WorkspaceProject | null;
  inspirationRootPath?: string;
  currentRelativePath: string;
  initialRelativePath: string;
  operation: 'import' | 'broll' | 'match' | null;
}
export interface WindowPanelTask {
  nativeTabId?: string;
  originKey?: string;
  key: string;
  ownerPageId: string;
  panelKind: string;
  title: string;
  state: 'idle' | 'running' | 'completed' | 'failed';
  progress: number;
  message: string;
  logs: LogEntry[];
  startedAt: number;
  updatedAt: number;
}
export type WorkspaceWindowSeed = {
  kind: 'home' | 'project' | 'inspiration' | 'component' | 'version' | 'settings' | 'search-all';
  label: string;
  key?: string;
  tabId?: string;
  page?: WorkspaceWindowPage;
  project?: WorkspaceProject;
  workspacePath?: string;
  action?: ComponentHostAction;
  scope?: ComponentPageOpenScope;
  settingsSection?: string;
  version?: { entry: ProjectFileEntry; progressId: string; progressVersionKey?: string };
  transfer?: { state?: Record<string, Record<string, unknown>>; componentPage?: ComponentPageInstance; sidebarCollapsed?: boolean };
};
export type NativeWorkspaceTab = { id: string; label: string; kind: WorkspaceWindowSeed['kind']; iconUrl?: string; active: boolean; pinned: boolean; ready: boolean };
export type WorkspaceWindowContext = { revision: number; id: string; windowId: number; root: boolean; visible: boolean; sharedTabs?: boolean; seed: WorkspaceWindowSeed; tabs: NativeWorkspaceTab[] };
export type WindowTabRequest = { token: string; action: 'open' | 'import' | 'export' | 'release' | 'rollback' | 'activate' | 'close' | 'reorder'; id?: string; index?: number; seed?: WorkspaceWindowSeed };
export type WindowPanelSnapshot = { revision: number; tasks: WindowPanelTask[] };
export interface WorkspaceWindowsAPI {
  publishTabs(tabs: NativeWorkspaceTab[]): Promise<void>;
  respondTabRequest(token: string, result?: unknown, error?: string): Promise<boolean>;
  onTabRequest(callback: (request: WindowTabRequest) => void): () => void;
  panels(): Promise<WindowPanelSnapshot>;
  updatePanels(tasks: WindowPanelTask[]): Promise<void>;
  restorePanel(ownerPageId: string, panelKind: string, nativeTabId?: string): Promise<boolean>;
  dismissPanel(nativeTabId: string, key: string): Promise<boolean>;
  onPanels(callback: (snapshot: WindowPanelSnapshot) => void): () => void;
  onRestorePanel(callback: (detail: { ownerPageId: string; panelKind: string }) => void): () => void;
  onDismissPanel(callback: (key: string) => void): () => void;
  context(): Promise<WorkspaceWindowContext>;
  ready(error?: string): Promise<void>;
  open(seed: WorkspaceWindowSeed, options?: { reuse?: boolean }): Promise<string>;
  activate(id: string): Promise<void>;
  update(label: string): Promise<void>;
  drop(id: string): Promise<{ moved: boolean }>;
  detach(id: string): Promise<void>;
  merge(): Promise<void>;
  reorder(id: string, index: number): Promise<void>;
  close(id: string): Promise<void>;
  respondClose(token: string, accepted: boolean): Promise<boolean>;
  onChanged(callback: (context: WorkspaceWindowContext) => void): () => void;
  onPrepareClose(callback: (request: { token: string; quit?: boolean }) => void): () => void;
}
