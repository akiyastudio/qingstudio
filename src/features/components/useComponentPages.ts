import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentContribution, ComponentHostAction, ComponentPageInstance, ComponentPageOpenScope, ComponentStatus, WorkspaceProject } from '../../types';
import { bindComponentPageInstance, closeComponentPage, closeProjectComponentPages, componentPageActivationSucceeded, componentPageIsAvailable, ensureComponentPage } from './component-page-model';
import { useUserFacingToast } from '../app/useUserFacingToast';

type ComponentHostBrowserPage = { id: string; projectId: string; kind: 'project' | 'inspiration'; project?: WorkspaceProject | null };

export const componentHostCatalogKey = (components: ComponentStatus[]) => components
  .map(component => [component.id, component.version, component.installed ? 1 : 0, component.enabled === false ? 0 : 1, component.compatible ? 1 : 0, component.runtimeAvailable === false ? 0 : 1, component.status || '', [...(component.capabilities || [component.capability]).filter(Boolean)].sort().join(',')].join(':'))
  .sort()
  .join('|');

export const useComponentPages = ({ browserPages, components, onProjectFallback, onHomeFallback, initialPage, catalogReady = true }: {
  browserPages: ComponentHostBrowserPage[];
  components: ComponentStatus[];
  onProjectFallback: (page: ComponentHostBrowserPage) => void;
  onHomeFallback: () => void;
  initialPage?: ComponentPageInstance;
  catalogReady?: boolean;
}) => {
  const toast = useUserFacingToast();
  const [actions, setActions] = useState<ComponentHostAction[]>([]);
  const [contributions, setContributions] = useState<ComponentContribution[]>([]);
  const [pages, setPages] = useState<ComponentPageInstance[]>(initialPage ? [initialPage] : []);
  const pagesRef = useRef<ComponentPageInstance[]>(initialPage ? [initialPage] : []);
  const [activeIdentity, setActiveIdentity] = useState(initialPage?.identity || '');
  const activeIdentityRef = useRef(initialPage?.identity || '');
  const activationGeneration = useRef(0);
  const openGenerations = useRef(new Map<string, number>());
  const inflightOpens = useRef(new Map<string, Promise<boolean>>());
  const inflightOwners = useRef(new Map<string, symbol>());
  const inflightFingerprints = useRef(new Map<string, string>());
  const openScopes = useRef(new Map<string, { workspacePath: string; projectId: string }>());
  const reopenRequests = useRef(new Map<string, () => Promise<boolean>>());
  const catalogKey = componentHostCatalogKey(components);

  useEffect(() => {
    let active = true;
    void window.electronAPI.getComponentHostActions().then(result => { if (active) setActions(result.success ? result.actions || [] : []); })
      .catch(() => { if (active) setActions([]); });
    return () => { active = false; };
  }, [catalogKey]);
  useEffect(() => { let active = true; void window.electronAPI.getComponentContributions().then(result => { if (active) setContributions(result.success ? result.contributions || [] : []); }).catch(() => { if (active) setContributions([]); }); return () => { active = false; }; }, [catalogKey]);
  useEffect(() => { activeIdentityRef.current = activeIdentity; }, [activeIdentity]);
  useEffect(() => { pagesRef.current=pages; }, [pages]);

  useEffect(() => {
    if (!catalogReady) return;
    const unavailablePages = pages.filter(page => !componentPageIsAvailable(page, components));
    if (!unavailablePages.length) return;
    unavailablePages.forEach(page => {openGenerations.current.set(page.identity, (openGenerations.current.get(page.identity) || 0) + 1);reopenRequests.current.delete(page.identity);});
    unavailablePages.forEach(page => { if (page.instanceId) void window.electronAPI.closeComponentPage(page.instanceId).catch(() => undefined); });
    setPages(current => current.filter(page => componentPageIsAvailable(page, components)));
    const activeUnavailable = unavailablePages.find(page => page.identity === activeIdentity);
    if (activeUnavailable) {
      activeIdentityRef.current = ''; setActiveIdentity('');
      const browserPage = browserPages.find(candidate => candidate.projectId === activeUnavailable.projectId);
      if (browserPage) onProjectFallback(browserPage); else onHomeFallback();
    }
  }, [activeIdentity, browserPages, components, onHomeFallback, onProjectFallback, pages, catalogReady]);

  const deactivate = useCallback(() => { activationGeneration.current += 1; activeIdentityRef.current = ''; return window.electronAPI.activateComponentPage({ instanceId: '' }).catch(() => ({ success: false })); }, []);
  const activate = useCallback(async (page: ComponentPageInstance) => {
    const identity=page.identity;const intent=++activationGeneration.current;let expectedGeneration=intent;activeIdentityRef.current=identity;setActiveIdentity(identity);const stillIntended=(generation=expectedGeneration)=>activationGeneration.current===generation&&activeIdentityRef.current===identity;
    let candidate=page;
    if(!candidate.instanceId){const inflight=inflightOpens.current.get(identity);if(inflight)await inflight;if(!stillIntended())return false;candidate=pagesRef.current.find(item=>item.identity===identity)||candidate;if(!candidate.instanceId){const retry=reopenRequests.current.get(identity);if(!retry)return false;const retryPromise=retry();const retryGeneration=activationGeneration.current;expectedGeneration=retryGeneration;if(!stillIntended(retryGeneration))return false;if(!await retryPromise||!stillIntended(retryGeneration))return false;candidate=pagesRef.current.find(item=>item.identity===identity)||candidate;if(!candidate.instanceId)return false;}}
    if(!stillIntended())return false;const generation = expectedGeneration;
    const result = await window.electronAPI.activateComponentPage({ instanceId: candidate.instanceId }).catch(() => ({ success: false }));
    if (generation !== activationGeneration.current) return false;
    if (componentPageActivationSucceeded(result)) { activeIdentityRef.current = page.identity; setActiveIdentity(page.identity); return true; }
    if (candidate.instanceId) void window.electronAPI.closeComponentPage(candidate.instanceId).catch(() => undefined);
    setPages(current => closeComponentPage(current, page.identity));
    setActiveIdentity(current => { const next = current === page.identity ? '' : current; activeIdentityRef.current = next; return next; });
    toast.show('组件页已失效，请重新打开', { tone: 'warning', dedupeKey: 'component-page-stale' });
    const browserPage = browserPages.find(candidate => candidate.projectId === page.projectId);
    if (browserPage) onProjectFallback(browserPage); else onHomeFallback();
    return false;
  }, [browserPages, onHomeFallback, onProjectFallback, toast]);
  const open = useCallback((action: ComponentHostAction, project: WorkspaceProject, workspacePath: string, insertAfterTabId = 'home', scope?: ComponentPageOpenScope) => {
    const ensured = ensureComponentPage(pages, action, project, workspacePath, insertAfterTabId);
    const fingerprint = JSON.stringify({ workspacePath, projectId: project.id, scope: scope || null });
    const inflight = inflightOpens.current.get(ensured.page.identity);
    if (inflight && inflightFingerprints.current.get(ensured.page.identity) === fingerprint) return inflight;
    if (inflight) inflightOpens.current.delete(ensured.page.identity);
    const generation = (openGenerations.current.get(ensured.page.identity) || 0) + 1;
    const activationToken = ++activationGeneration.current;
    openGenerations.current.set(ensured.page.identity, generation);
    openScopes.current.set(ensured.page.identity, { workspacePath, projectId: project.id });
    reopenRequests.current.set(ensured.page.identity,()=>open(action,project,workspacePath,insertAfterTabId,scope));
    setPages(current => {const next=ensureComponentPage(current, action, project, workspacePath, insertAfterTabId).pages;pagesRef.current=next;return next;});
    activeIdentityRef.current = ensured.page.identity;
    setActiveIdentity(ensured.page.identity);
    const owner = Symbol(ensured.page.identity);
    const operation = (async () => {
      const result = await window.electronAPI.openComponentPage({ componentId: action.componentId, pageId: action.pageId, workspacePath, projectId: project.id, projectName: project.name, projectStatus: project.status, ...scope })
        .catch(error => ({ success: false, page: undefined, error: error instanceof Error ? error.message : String(error) }));
      if (generation !== openGenerations.current.get(ensured.page.identity) || activationToken !== activationGeneration.current || activeIdentityRef.current !== ensured.page.identity) {
        if (result.page?.instanceId) void window.electronAPI.closeComponentPage(result.page.instanceId).catch(() => undefined);
        return false;
      }
      if (!result.success || !result.page) {
        if (ensured.created) setPages(current => closeComponentPage(current, ensured.page.identity));
        setActiveIdentity(current => { const next = activationToken === activationGeneration.current && current === ensured.page.identity && ensured.created ? '' : current; activeIdentityRef.current = next; return next; });
        toast.show(`打开组件页失败：${result.error || '未知错误'}`, { tone: 'error', dedupeKey: `component-page-open:${action.componentId}:${action.pageId}` }); return false;
      }
      pagesRef.current=bindComponentPageInstance(pagesRef.current,ensured.page.identity,result.page.instanceId);setPages(current => {const next=bindComponentPageInstance(current,ensured.page.identity,result.page!.instanceId);pagesRef.current=next;return next;});
      return true;
    })().finally(() => { if (inflightOwners.current.get(ensured.page.identity) === owner) { inflightOpens.current.delete(ensured.page.identity); inflightOwners.current.delete(ensured.page.identity); inflightFingerprints.current.delete(ensured.page.identity); openScopes.current.delete(ensured.page.identity); } });
    inflightOpens.current.set(ensured.page.identity, operation);
    inflightOwners.current.set(ensured.page.identity, owner);
    inflightFingerprints.current.set(ensured.page.identity, fingerprint);
    return operation;
  }, [pages, toast]);
  const close = useCallback(async (page: ComponentPageInstance) => {
    openGenerations.current.set(page.identity, (openGenerations.current.get(page.identity) || 0) + 1);
    inflightOpens.current.delete(page.identity); inflightOwners.current.delete(page.identity); inflightFingerprints.current.delete(page.identity); openScopes.current.delete(page.identity);reopenRequests.current.delete(page.identity);
    activationGeneration.current += 1;
    setPages(current => closeComponentPage(current, page.identity));
    if (activeIdentityRef.current === page.identity) {
      activeIdentityRef.current = ''; setActiveIdentity('');
      const browserPage = browserPages.find(candidate => candidate.projectId === page.projectId);
      if (browserPage) onProjectFallback(browserPage); else onHomeFallback();
    }
    if (page.instanceId) await window.electronAPI.closeComponentPage(page.instanceId).catch(() => undefined);
  }, [browserPages, onHomeFallback, onProjectFallback]);
  const disposeProject = useCallback((workspacePath: string, projectId: string) => {
    for (const page of pages) if (page.projectId === projectId && page.workspacePath.replace(/\\/g, '/').toLocaleLowerCase() === workspacePath.replace(/\\/g, '/').toLocaleLowerCase()) { openGenerations.current.set(page.identity, (openGenerations.current.get(page.identity) || 0) + 1); inflightOpens.current.delete(page.identity);reopenRequests.current.delete(page.identity); }
    for (const [identity, scope] of openScopes.current) if (scope.projectId === projectId && scope.workspacePath.replace(/\\/g, '/').toLocaleLowerCase() === workspacePath.replace(/\\/g, '/').toLocaleLowerCase()) { openGenerations.current.set(identity, (openGenerations.current.get(identity) || 0) + 1); inflightOpens.current.delete(identity); openScopes.current.delete(identity);reopenRequests.current.delete(identity); }
    activationGeneration.current += 1;
    void window.electronAPI.closeProjectComponentPages(workspacePath, projectId).catch(() => undefined);
    setPages(current => closeProjectComponentPages(current, workspacePath, projectId));
    const activePage = pages.find(candidate => candidate.identity === activeIdentityRef.current);
    if (activePage?.projectId === projectId && activePage.workspacePath.replace(/\\/g, '/').toLocaleLowerCase() === workspacePath.replace(/\\/g, '/').toLocaleLowerCase()) { activeIdentityRef.current = ''; setActiveIdentity(''); }
  }, [pages]);
  const adopt = (page: ComponentPageInstance) => {
    if (pagesRef.current.some(candidate => candidate.identity === page.identity)) throw new Error('当前窗口已有同一组件页面');
    setPages(current => { const next = [...current, page]; pagesRef.current = next; return next; });
    activeIdentityRef.current = page.identity; setActiveIdentity(page.identity);
  };
  const release = (page: ComponentPageInstance) => {
    setPages(current => { const next = closeComponentPage(current, page.identity); pagesRef.current = next; return next; });
    reopenRequests.current.delete(page.identity);
    if (activeIdentityRef.current === page.identity) { activeIdentityRef.current = ''; setActiveIdentity(''); }
  };
  return { actions, contributions, pages, activeIdentity, activate, deactivate, open, close, disposeProject, adopt, release, getPages: () => pagesRef.current };
};
