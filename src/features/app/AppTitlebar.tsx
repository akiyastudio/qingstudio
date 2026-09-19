import React, { type HTMLAttributes, type ReactNode, type RefObject, type WheelEventHandler } from 'react';
import { ChevronLeft, ChevronRight, Folder, GitBranch, Home, Lightbulb, PanelLeftClose, PanelLeftOpen, Pin, Search, Settings, X } from 'lucide-react';
import { ComponentIcon } from '../../components/ComponentIcon';
import type { ComponentPageInstance, ComponentStatus, ToolType, WorkspaceProject } from '../../types';
import type { BrowserPageInstance } from './workspace-tab-model';
import { DomainHealthBanner } from './DomainHealthBanner';
import { WindowControls } from './AppChrome';
import { NativeWorkspaceTabs } from './NativeWorkspaceTabs';
import type { WorkspaceWindowContext, WorkspaceWindowsAPI } from '../../platform/workspace-window-client';
import { componentTabId, inspirationTabId, projectTabId, workspaceToolTabId } from './useTitlebarTabOrder';

export type WorkspaceToolTab = { ownerPageId: string; projectId: string; projectPath: string; kind: 'version'; label: string; busy: boolean };

type AppTitlebarProps = {
  nativeWindowContext?: WorkspaceWindowContext | null;
  nativeWindowActions?: Pick<WorkspaceWindowsAPI, 'activate' | 'close' | 'reorder'>;
  onWindowError?: (message: string) => void;
  activeTab: ToolType;
  activePageId: string | null;
  activeComponentPageIdentity: string;
  sidebarCollapsed: boolean;
  renderedSidebarWidth: number;
  searchAllTabOpen: boolean;
  settingsTabOpen: boolean;
  pinInspirationLibrary: boolean;
  projectPages: BrowserPageInstance[];
  workspaceToolTabs: WorkspaceToolTab[];
  componentPages: ComponentPageInstance[];
  components: ComponentStatus[];
  titlebarTabsRef: RefObject<HTMLDivElement>;
  titlebarTabScroll: { overflow: boolean; canScrollLeft: boolean; canScrollRight: boolean };
  titlebarTabDragProps: (id: string) => HTMLAttributes<HTMLElement>;
  handleTitlebarTabWheel: WheelEventHandler<HTMLDivElement>;
  folderTabDropProps: HTMLAttributes<HTMLDivElement>;
  folderTabSourceDragActive: boolean;
  trailingContent: ReactNode;
  onSidebarCollapsedChange: () => void;
  onScrollTabs: (direction: -1 | 1) => void;
  onShowHome: () => void;
  onOpenSearch: () => void;
  onCloseSearch: () => void;
  onActivateInspiration: (pageId: string) => void;
  onCloseInspiration: (pageId: string) => void;
  onActivateProject: (pageId: string) => void;
  onCloseProject: (pageId: string) => void;
  onActivateWorkspaceTool: (tab: WorkspaceToolTab, project: WorkspaceProject) => void;
  onCloseWorkspaceTool: (tab: WorkspaceToolTab) => void;
  onActivateComponent: (page: ComponentPageInstance) => void;
  onCloseComponent: (page: ComponentPageInstance) => void;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
};

export const AppTitlebar = (props: AppTitlebarProps) => <header className="app-titlebar relative z-50 flex h-10 shrink-0 items-stretch border-b border-slate-200 bg-white">
  <div style={{ width: props.sidebarCollapsed ? 48 : props.renderedSidebarWidth + 1 }} className="app-titlebar-brand-region flex shrink-0 items-center border-r border-slate-200 px-2 transition-[width] duration-200">
    <button type="button" onClick={props.onSidebarCollapsedChange} aria-label={props.sidebarCollapsed ? '展开项目栏' : '折叠项目栏'} title={props.sidebarCollapsed ? '展开项目栏' : '折叠项目栏'} className="app-titlebar-control mr-1 rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900">
      {props.sidebarCollapsed ? <PanelLeftOpen size={17}/> : <PanelLeftClose size={17}/>}
    </button>
    <div title="拖动窗口" className={`flex min-w-0 items-center gap-2 px-1.5 py-1 ${props.sidebarCollapsed || props.renderedSidebarWidth < 190 ? 'hidden' : ''}`}>
      <img src="./app-logo.svg" className="brand-logo h-5 w-5 shrink-0" alt=""/>
      <span className="truncate text-sm font-bold text-slate-800">照片流</span>
    </div>
  </div>
  <div {...props.folderTabDropProps} data-folder-tab-drop-zone={props.folderTabSourceDragActive ? 'true' : undefined} aria-label="标签栏" className={`relative flex min-w-0 flex-1 transition-colors ${props.folderTabSourceDragActive ? 'app-titlebar-control bg-blue-50/70 ring-1 ring-inset ring-blue-400/70' : ''}`}>
    {props.titlebarTabScroll.overflow && <button type="button" aria-label="向左滚动标签" title="向左滚动标签" disabled={!props.titlebarTabScroll.canScrollLeft} onClick={() => props.onScrollTabs(-1)} className="app-titlebar-control titlebar-tab-scroll-button"><ChevronLeft size={15}/></button>}
    <div ref={props.titlebarTabsRef} onWheel={props.handleTitlebarTabWheel} aria-label="已打开的窗口" className="titlebar-tabs-scroll scrollbar-hide flex min-w-0 shrink items-end gap-0 overflow-x-auto px-2 pt-1.5">
      {props.nativeWindowContext ? <NativeWorkspaceTabs context={props.nativeWindowContext} actions={props.nativeWindowActions} onError={props.onWindowError || (() => undefined)}/> : <>
      <button type="button" {...props.titlebarTabDragProps('home')} title="主页" data-active-tab={props.activeTab === 'home'} onClick={props.onShowHome} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[92px] max-w-[180px] items-center gap-2 rounded-t-lg border px-3 text-xs font-medium transition ${props.activeTab === 'home' ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
        <Home size={14} className="shrink-0"/><span className="truncate">主页</span>
      </button>
      {props.searchAllTabOpen && <div {...props.titlebarTabDragProps('search-all')} title="全局搜索" data-active-tab={props.activeTab === 'search-all'} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[116px] max-w-[190px] items-center rounded-t-lg border text-xs font-medium transition ${props.activeTab === 'search-all' ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
        <button type="button" onClick={props.onOpenSearch} className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-3 text-left"><Search size={14} className="shrink-0"/><span className="truncate">全局搜索</span></button>
        <button type="button" data-tab-drag-ignore="true" aria-label="关闭全局搜索" title="关闭全局搜索" onClick={props.onCloseSearch} className="mr-1.5 rounded p-1 text-slate-400 opacity-70 hover:bg-slate-200 hover:text-slate-800 group-hover:opacity-100"><X size={13}/></button>
      </div>}
      {props.projectPages.filter(page => page.kind === 'inspiration').map(page => {
        const folderName = page.currentRelativePath.split('/').filter(Boolean).pop();
        const label = page.currentRelativePath ? `灵感库 · ${folderName || page.currentRelativePath}` : '灵感库';
        const pinnedRoot = props.pinInspirationLibrary && page.initialRelativePath === '';
        const isActive = props.activePageId === page.id && props.activeTab === 'inspiration';
        return <div key={page.id} {...props.titlebarTabDragProps(inspirationTabId(page.id))} title={label} data-active-tab={isActive} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[112px] max-w-[210px] items-center rounded-t-lg border text-xs font-medium transition ${isActive ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
          <button type="button" onClick={() => props.onActivateInspiration(page.id)} className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-3 text-left"><Lightbulb size={14} className="shrink-0"/><span className="min-w-0 flex-1 truncate">{label}</span></button>
          {pinnedRoot ? <span aria-label="灵感库已固定" title="灵感库已固定" className="mr-2 text-blue-500"><Pin size={12}/></span> : <button type="button" data-tab-drag-ignore="true" aria-label={`关闭 ${label}`} title={`关闭 ${label}`} onClick={() => props.onCloseInspiration(page.id)} className="mr-1.5 rounded p-1 text-slate-400 opacity-70 hover:bg-slate-200 hover:text-slate-800 group-hover:opacity-100"><X size={13}/></button>}
        </div>;
      })}
      {props.projectPages.filter(page => page.project).map(page => {
        const project = page.project!;
        const folderName = page.currentRelativePath.split('/').filter(Boolean).pop();
        const label = page.currentRelativePath ? `${project.name} · ${folderName || page.currentRelativePath}` : project.name;
        return <React.Fragment key={page.id}>
          <div {...props.titlebarTabDragProps(projectTabId(page.id))} title={label} data-active-tab={props.activePageId === page.id && props.activeTab === 'project'} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[120px] max-w-[220px] items-center rounded-t-lg border text-xs font-medium transition ${props.activePageId === page.id && props.activeTab === 'project' ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
            <button type="button" onClick={() => props.onActivateProject(page.id)} className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-3 text-left"><Folder size={14} className="shrink-0"/><span className="min-w-0 flex-1 truncate">{label}</span></button>
            <button type="button" data-tab-drag-ignore="true" aria-label={`关闭 ${label}`} title={`关闭 ${label}`} onClick={() => props.onCloseProject(page.id)} className="mr-1.5 rounded p-1 text-slate-400 opacity-70 hover:bg-slate-200 hover:text-slate-800 group-hover:opacity-100"><X size={13}/></button>
          </div>
          {props.workspaceToolTabs.filter(tab => tab.ownerPageId === page.id).map(tab => {
            const isActive = props.activePageId === tab.ownerPageId && props.activeTab === 'project-version';
            return <div key={`${tab.ownerPageId}:${tab.kind}`} {...props.titlebarTabDragProps(workspaceToolTabId(tab.ownerPageId, tab.kind))} title={tab.label} data-active-tab={isActive} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[128px] max-w-[230px] items-center rounded-t-lg border text-xs font-medium transition ${isActive ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
              <button type="button" onClick={() => props.onActivateWorkspaceTool(tab, project)} className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-3 text-left"><GitBranch size={14} className="shrink-0"/><span className="min-w-0 flex-1 truncate">{tab.label}</span></button>
              <button type="button" data-tab-drag-ignore="true" aria-label={`关闭 ${tab.label}`} title={`关闭 ${tab.label}`} onClick={() => props.onCloseWorkspaceTool(tab)} className="mr-1.5 rounded p-1 text-slate-400 opacity-70 hover:bg-slate-200 hover:text-slate-800 group-hover:opacity-100"><X size={13}/></button>
            </div>;
          })}
        </React.Fragment>;
      })}
      {props.componentPages.map(page => {
        const label = `${page.title} · ${page.projectName}`;
        const isActive = props.activeTab === 'component' && props.activeComponentPageIdentity === page.identity;
        return <div key={page.identity} {...props.titlebarTabDragProps(componentTabId(page.identity))} title={label} data-active-tab={isActive} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[128px] max-w-[230px] items-center rounded-t-lg border text-xs font-medium transition ${isActive ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
          <button type="button" onClick={() => props.onActivateComponent(page)} className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-3 text-left"><ComponentIcon src={page.iconUrl} size={14}/><span className="min-w-0 flex-1 truncate">{label}</span></button>
          <button type="button" data-tab-drag-ignore="true" aria-label={`关闭 ${page.title}`} title={`关闭 ${page.title}`} onClick={() => props.onCloseComponent(page)} className="mr-1.5 rounded p-1 text-slate-400 opacity-70 hover:bg-slate-200 hover:text-slate-800 group-hover:opacity-100"><X size={13}/></button>
        </div>;
      })}
      {props.settingsTabOpen && <div {...props.titlebarTabDragProps('settings')} title="设置" data-active-tab={props.activeTab === 'settings'} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[108px] max-w-[180px] items-center rounded-t-lg border text-xs font-medium transition ${props.activeTab === 'settings' ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}><button type="button" onClick={props.onOpenSettings} className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-3 text-left"><Settings size={14} className="shrink-0"/><span className="truncate">设置</span></button><button type="button" data-tab-drag-ignore="true" aria-label="关闭设置" title="关闭设置" onClick={props.onCloseSettings} className="mr-1.5 rounded p-1 text-slate-400 opacity-70 hover:bg-slate-200 hover:text-slate-800 group-hover:opacity-100"><X size={13}/></button></div>}
      </>}
    </div>
    {props.titlebarTabScroll.overflow && <button type="button" aria-label="向右滚动标签" title="向右滚动标签" disabled={!props.titlebarTabScroll.canScrollRight} onClick={() => props.onScrollTabs(1)} className="app-titlebar-control titlebar-tab-scroll-button"><ChevronRight size={15}/></button>}
    <div aria-label={props.folderTabSourceDragActive ? '标签栏空白区域' : '拖动窗口'} className={`${props.folderTabSourceDragActive ? 'app-titlebar-control' : 'app-window-drag-region'} min-w-8 flex-1`}/>
  </div>
  <DomainHealthBanner components={props.components}/>
  {props.trailingContent}
  <WindowControls/>
</header>;
