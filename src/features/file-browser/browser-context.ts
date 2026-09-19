export type FileBrowserKind = 'project' | 'inspiration';

export interface FileBrowserCapabilities {
  projectWorkflows: boolean;
  gatherToProject: boolean;
  watchRootDirectly: boolean;
  rootRelativeFileEvents: boolean;
  previewOnlyOnMediaClick: boolean;
}

export interface FileBrowserContext {
  kind: FileBrowserKind;
  title: string;
  rootFilterLabel: string;
  capabilities: FileBrowserCapabilities;
}

export const PROJECT_FILE_BROWSER_CONTEXT: FileBrowserContext = Object.freeze({
  kind: 'project',
  title: '项目',
  rootFilterLabel: '当前项目',
  capabilities: Object.freeze({
    projectWorkflows: true,
    gatherToProject: false,
    watchRootDirectly: false,
    rootRelativeFileEvents: false,
    previewOnlyOnMediaClick: false,
  }),
});

export const INSPIRATION_FILE_BROWSER_CONTEXT: FileBrowserContext = Object.freeze({
  kind: 'inspiration',
  title: '灵感库',
  rootFilterLabel: '全部文件',
  capabilities: Object.freeze({
    projectWorkflows: false,
    gatherToProject: true,
    watchRootDirectly: true,
    rootRelativeFileEvents: true,
    previewOnlyOnMediaClick: true,
  }),
});
