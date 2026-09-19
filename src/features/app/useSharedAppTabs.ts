import { useRef, useState } from 'react';
import type { ComponentHostAction, ComponentPageInstance, ComponentPageOpenScope, ToolType, WorkspaceProject } from '../../types';
import type { WorkspaceWindowContext, WorkspaceWindowPage, WorkspaceWindowSeed } from '../../contracts/workspace-windows';
import { componentTabId, inspirationTabId, projectTabId } from './useTitlebarTabOrder';
import { useSharedWindowTabs, type SharedWindowTab } from './useSharedWindowTabs';

type ComponentHost = {
  open: (action: ComponentHostAction, project: WorkspaceProject, root: string, after?: string, scope?: ComponentPageOpenScope) => Promise<boolean>;
  activate: (page: ComponentPageInstance) => Promise<boolean>; deactivate: () => Promise<unknown>;
  close: (page: ComponentPageInstance) => Promise<unknown>; adopt: (page: ComponentPageInstance) => void; release: (page: ComponentPageInstance) => void;
  getPages: () => ComponentPageInstance[];
};
export const useSharedAppTabs = (props: {
  context: WorkspaceWindowContext | null; seed?: WorkspaceWindowSeed;
  projectPages: WorkspaceWindowPage[]; componentPages: ComponentPageInstance[]; componentHost: ComponentHost;
  activeTab: ToolType; activePageId: string | null; activeComponentId: string;
  selectedProject: WorkspaceProject | null;
  settingsOpen: boolean; settingsSection: string; searchOpen: boolean; workspacePath: string;
  sidebarCollapsed: boolean; runningPageIds: Set<string>;
  setActiveTab: (value: ToolType) => void; setSelectedProject: (project: WorkspaceProject | null) => void;
  setSettingsOpen: (value: boolean) => void; setSettingsSection: (value: string) => void; setSearchOpen: (value: boolean) => void;
  createPage: (page: WorkspaceWindowPage) => string; activatePage: (id: string) => void; releasePage: (id: string) => void;
  onError: (message: string) => void;
}) => {
  const initialVersionId = props.seed?.tabId || props.seed?.key || 'version-initial';
  const [versions, setVersions] = useState<Array<{ id: string; seed: WorkspaceWindowSeed }>>(() => props.seed?.kind === 'version' ? [{ id: initialVersionId, seed: props.seed }] : []);
  const [activeVersionId, setActiveVersionId] = useState(initialVersionId);
  const componentSeeds = useRef<WorkspaceWindowSeed[]>(props.seed?.kind === 'component' ? [props.seed] : []);
  const ensureCapacity = () => {
    if (props.projectPages.length + props.componentPages.length + versions.length + Number(props.settingsOpen) + Number(props.searchOpen) + Number(Boolean(props.context?.root)) >= 48) throw new Error('打开的标签页过多，请先关闭一些标签页');
  };
  const home = () => { props.setSelectedProject(null); props.setActiveTab('home'); };
  const activateNeighbor = (id: string) => {
    const index = entries.findIndex(entry => entry.id === id), remaining = entries.filter(entry => entry.id !== id);
    const next = remaining[Math.min(Math.max(0, index), remaining.length - 1)];
    if (next) void next.activate(); else home();
  };
  const activatePage = (page: WorkspaceWindowPage) => {
    props.activatePage(page.id); props.setSelectedProject(page.project); props.setActiveTab(page.kind);
  };
  const releasePage = (page: WorkspaceWindowPage) => {
    props.releasePage(page.id);
    if (props.activePageId === page.id && props.activeTab === page.kind) {
      activateNeighbor(page.kind === 'project' ? projectTabId(page.id) : inspirationTabId(page.id));
    }
  };
  const closeVersion = (id: string) => {
    setVersions(current => current.filter(tab => tab.id !== id));
    if (props.activeTab === 'project-version' && activeVersionId === id) activateNeighbor(id);
  };
  const resolveVersionSeed = (seed: WorkspaceWindowSeed): WorkspaceWindowSeed => {
    const project = props.projectPages.find(page => page.projectId === seed.project?.id)?.project || (props.selectedProject?.id === seed.project?.id ? props.selectedProject : null) || seed.project;
    if (!project || project === seed.project || !seed.version) return seed;
    const version = project.path === seed.project?.path ? seed.version : { ...seed.version, entry: { ...seed.version.entry, path: `${project.path.replace(/[\\/]+$/, '')}/${seed.version.entry.relativePath}` } };
    return { ...seed, project, version };
  };
  const open = async (seed: WorkspaceWindowSeed, reuse: boolean): Promise<string> => {
    if (seed.kind === 'project' || seed.kind === 'inspiration') {
      if (!seed.page) throw new Error('标签页缺少目录信息');
      const existing = reuse && props.projectPages.find(page => page.kind === seed.page!.kind && page.projectId === seed.page!.projectId && page.currentRelativePath === seed.page!.currentRelativePath
        && (page.project?.workspacePath || page.inspirationRootPath) === (seed.page!.project?.workspacePath || seed.page!.inspirationRootPath));
      const page = existing || seed.page;
      if (!existing) { ensureCapacity(); if (props.projectPages.some(candidate => candidate.id === page.id)) throw new Error('目标窗口已有此标签页'); props.createPage(page); }
      activatePage(page);
      return page.kind === 'project' ? projectTabId(page.id) : inspirationTabId(page.id);
    }
    if (seed.kind === 'component') {
      const transferred = seed.transfer?.componentPage;
      const previous = props.componentPages.find(page => page.componentId === seed.action?.componentId && page.pageId === seed.action.pageId && page.projectId === seed.project?.id && page.workspacePath === seed.workspacePath);
      if (!previous) ensureCapacity();
      if (transferred) props.componentHost.adopt(transferred);
      else {
        if (!seed.action || !seed.project) throw new Error('组件页面缺少上下文');
        if (!await props.componentHost.open(seed.action, seed.project, seed.workspacePath || props.workspacePath, 'home', seed.scope)) throw new Error('组件页面未能打开');
      }
      componentSeeds.current = [seed, ...componentSeeds.current].slice(0, 128);
      props.setSelectedProject(seed.scope?.contentKind === 'inspiration' ? null : seed.project || null); props.setActiveTab('component');
      const opened = transferred || props.componentHost.getPages().find(page => page.componentId === seed.action?.componentId && page.pageId === seed.action.pageId && page.projectId === seed.project?.id);
      if (!opened) throw new Error('组件页面未能注册到当前窗口');
      return componentTabId(opened.identity);
    }
    if (seed.kind === 'version') {
      const existing = reuse && versions.find(tab => tab.seed.key && tab.seed.key === seed.key);
      const id = existing ? existing.id : seed.tabId || `version:${crypto.randomUUID()}`;
      if (!existing) { ensureCapacity(); setVersions(current => [...current, { id, seed }]); }
      setActiveVersionId(id); props.setSelectedProject(seed.project || null); props.setActiveTab('project-version'); return id;
    }
    if (seed.kind === 'settings') {
      if (!props.settingsOpen) ensureCapacity();
      props.setSettingsOpen(true); props.setSettingsSection(seed.settingsSection || props.settingsSection); props.setActiveTab('settings'); return 'settings';
    }
    if (seed.kind === 'search-all') { if (!props.searchOpen) ensureCapacity(); props.setSearchOpen(true); props.setActiveTab('search-all'); return 'search-all'; }
    home(); return 'home';
  };
  const entries: SharedWindowTab[] = [
    ...(props.context?.root ? [{ id: 'home', label: '主页', kind: 'home' as const, active: props.activeTab === 'home', pinned: true,
      seed: () => ({ kind: 'home' as const, label: '主页' }), activate: home, close: home, release: home }] : []),
    ...props.projectPages.map(page => ({
      id: page.kind === 'project' ? projectTabId(page.id) : inspirationTabId(page.id), pageId: page.id,
      label: (page.project?.name || '灵感库') + (page.currentRelativePath ? ` · ${page.currentRelativePath.split('/').filter(Boolean).pop()}` : ''),
      kind: page.kind, active: props.activePageId === page.id && props.activeTab === page.kind,
      seed: () => ({ kind: page.kind, label: page.project?.name || '灵感库', page: { ...page, initialRelativePath: page.currentRelativePath } }),
      activate: () => activatePage(page), close: () => releasePage(page), release: () => releasePage(page),
    })),
    ...versions.map(tab => ({ id: tab.id, label: tab.seed.label, kind: 'version' as const,
      active: props.activeTab === 'project-version' && activeVersionId === tab.id, seed: () => ({ ...resolveVersionSeed(tab.seed), tabId: tab.id }),
      activate: () => { setActiveVersionId(tab.id); props.setSelectedProject(resolveVersionSeed(tab.seed).project || null); props.setActiveTab('project-version'); }, close: () => closeVersion(tab.id), release: () => closeVersion(tab.id) })),
    ...props.componentPages.map(page => ({ id: componentTabId(page.identity), label: `${page.title} · ${page.projectName}`, kind: 'component' as const, iconUrl: page.iconUrl,
      active: props.activeTab === 'component' && props.activeComponentId === page.identity,
      seed: async () => {
        const cached = componentSeeds.current.find(seed => seed.transfer?.componentPage?.identity === page.identity || seed.action?.componentId === page.componentId && seed.action.pageId === page.pageId && seed.project?.id === page.projectId && seed.workspacePath === page.workspacePath);
        if (cached) return { ...cached, transfer: { componentPage: page } };
        const catalog = await window.electronAPI.getWorkspaceProjects(page.workspacePath);
        const project = catalog.statuses.flatMap(group => group.projects).find(project => project.id === page.projectId);
        return { kind: 'component' as const, label: page.title, project, workspacePath: page.workspacePath, transfer: { componentPage: page } };
      },
      activate: () => { props.setActiveTab('component'); return props.componentHost.activate(page); }, prepare: () => props.componentHost.deactivate(),
      close: async () => { await props.componentHost.close(page); if (props.activeTab === 'component' && props.activeComponentId === page.identity) activateNeighbor(componentTabId(page.identity)); },
      release: () => { props.componentHost.release(page); if (props.activeTab === 'component' && props.activeComponentId === page.identity) activateNeighbor(componentTabId(page.identity)); },
    })),
    ...(props.searchOpen ? [{ id: 'search-all', label: '全局搜索', kind: 'search-all' as const, active: props.activeTab === 'search-all',
      seed: () => ({ kind: 'search-all' as const, label: '全局搜索' }), activate: () => props.setActiveTab('search-all'),
      close: () => { props.setSearchOpen(false); if (props.activeTab === 'search-all') activateNeighbor('search-all'); }, release: () => { props.setSearchOpen(false); if (props.activeTab === 'search-all') activateNeighbor('search-all'); } }] : []),
    ...(props.settingsOpen ? [{ id: 'settings', label: '设置', kind: 'settings' as const, active: props.activeTab === 'settings',
      seed: () => ({ kind: 'settings' as const, label: '设置', settingsSection: props.settingsSection }), activate: () => props.setActiveTab('settings'),
      close: () => { props.setSettingsOpen(false); if (props.activeTab === 'settings') activateNeighbor('settings'); }, release: () => { props.setSettingsOpen(false); if (props.activeTab === 'settings') activateNeighbor('settings'); } }] : []),
  ];
  const windowTabs = useSharedWindowTabs({ context: props.context, entries, open, onError: props.onError, sidebarCollapsed: props.sidebarCollapsed, runningPageIds: props.runningPageIds });
  const resolvedVersions = versions.map(tab => ({ ...tab, seed: resolveVersionSeed(tab.seed) }));
  return { ...windowTabs, versions: resolvedVersions, activeVersionId, closeVersion };
};
