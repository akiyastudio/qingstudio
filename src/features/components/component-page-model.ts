import type { ComponentHostAction, ComponentPageInstance, ComponentStatus, WorkspaceProject } from '../../types';
import { componentRuntimeIsAvailable } from './component-availability-model';

export const componentPageIdentity = (componentId: string, pageId: string, workspacePath: string, projectId: string) =>
  `${componentId}\u001f${pageId}\u001f${workspacePath.replace(/\\/g, '/').toLowerCase()}\u001f${projectId}`;

export const ensureComponentPage = (
  pages: ComponentPageInstance[],
  action: ComponentHostAction,
  project: WorkspaceProject,
  workspacePath: string,
  insertAfterTabId = 'home',
): { pages: ComponentPageInstance[]; page: ComponentPageInstance; created: boolean } => {
  const identity = componentPageIdentity(action.componentId, action.pageId, workspacePath, project.id);
  const existing = pages.find(page => page.identity === identity);
  if (existing) return { pages, page: existing, created: false };
  const page: ComponentPageInstance = {
    identity,
    componentId: action.componentId,
    componentVersion: action.componentVersion,
    pageId: action.pageId,
    title: action.pageTitle,
    workspacePath,
    projectId: project.id,
    projectName: project.name,
    instanceId: '',
    insertAfterTabId,
    iconUrl: action.iconUrl,
  };
  return { pages: [...pages, page], page, created: true };
};

export const bindComponentPageInstance = (pages: ComponentPageInstance[], identity: string, instanceId: string) =>
  pages.map(page => page.identity === identity ? { ...page, instanceId } : page);

export const closeComponentPage = (pages: ComponentPageInstance[], identity: string) => pages.filter(page => page.identity !== identity);

export const componentPageIsAvailable = (page: ComponentPageInstance, components: ComponentStatus[]) => {
  const component = components.find(item => item.id === page.componentId);
  return Boolean(component && component.version === page.componentVersion && componentRuntimeIsAvailable(components, page.componentId));
};
export const componentPageActivationSucceeded = (result: { success?: boolean } | null | undefined) => result?.success === true;

export const closeProjectComponentPages = (pages: ComponentPageInstance[], workspacePath: string, projectId: string) => {
  const normalizedWorkspace = workspacePath.replace(/\\/g, '/').toLowerCase();
  return pages.filter(page => page.projectId !== projectId || page.workspacePath.replace(/\\/g, '/').toLowerCase() !== normalizedWorkspace);
};
