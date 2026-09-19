import { useEffect, useRef, useState } from 'react';
import type { ComponentContribution, ComponentPageOpenScope, WorkspaceProject } from '../../types';
import { componentWorkspacePanelId, PANEL_LAYOUT_CHANGED_EVENT } from '../../contracts/workspace-panels';
import { WorkspacePanelHeader } from '../workspace/WorkspacePanelHeader';

export const ComponentFolderPanelSurface = ({ contribution, project, workspacePath, scope, active, open, pinned, width, order, onClose, onTogglePinned }: {
  contribution: ComponentContribution; project: WorkspaceProject; workspacePath: string; scope: ComponentPageOpenScope;
  active: boolean; open: boolean; pinned: boolean; width: number; order: number; onClose: () => void; onTogglePinned: () => void;
}) => {
  const panelId = componentWorkspacePanelId(contribution.componentId, contribution.contributionId);
  const [instanceId, setInstanceId] = useState(''); const instanceRef = useRef(''); const generation = useRef(0);
  const mounted = useRef(true); const wanted = useRef(open && active); wanted.current = open && active;
  const [error, setError] = useState(''); const [retry, setRetry] = useState(0);
  const [info, setInfo] = useState({ title: contribution.title, subtitle: contribution.description || contribution.label });
  const surface = useRef<HTMLDivElement>(null); const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    if (!open || !active) return;
    let cancelled = false; const request = ++generation.current; setError('');
    void window.electronAPI.openComponentContribution({ componentId: contribution.componentId, contributionId: contribution.contributionId, type: contribution.type, workspacePath, projectId: project.id, projectName: project.name, projectStatus: project.status, ...scope }).then(result => {
      if (cancelled || request !== generation.current) { if (result.page?.instanceId && result.page.instanceId !== instanceRef.current && (!mounted.current || !wanted.current)) void window.electronAPI.closeComponentPage(result.page.instanceId).catch(() => undefined); return; }
      if (!result.success || !result.page) { setError('无法打开面板，请重试。'); return; }
      instanceRef.current = result.page.instanceId; setInstanceId(result.page.instanceId);
      if (result.page.panelInfo) setInfo(result.page.panelInfo);
    }).catch(() => { if (!cancelled) setError('无法打开面板，请重试。'); });
    return () => { cancelled = true; };
  }, [active, open, scopeKey, project.id, project.name, project.status, workspacePath, contribution.componentId, contribution.componentVersion, contribution.contributionId, retry]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current += 1; if (instanceRef.current) void window.electronAPI.closeComponentPage(instanceRef.current).catch(() => undefined); }; }, []);
  useEffect(() => {
    if (!instanceId) return;
    return window.electronAPI.onComponentPanelInfoChanged(value => { if (value.instanceId === instanceId) setInfo(value.info); });
  }, [instanceId]);
  // Only a replaced/unmounted instance should be hidden during cleanup.
  // Metadata, width and order changes remeasure the same visible body.
  useEffect(() => () => {
    if (instanceId) void window.electronAPI.setComponentPageBounds(instanceId, { x: 0, y: 0, width: 0, height: 0 }).catch(() => undefined);
  }, [instanceId]);
  useEffect(() => {
    if (!instanceId) return;
    if (!active || !open || !surface.current) { void window.electronAPI.setComponentPageBounds(instanceId, { x: 0, y: 0, width: 0, height: 0 }).catch(() => undefined); return; }
    let frame = 0;
    const update = () => { frame = 0; const rect = surface.current?.getBoundingClientRect(); if (rect) void window.electronAPI.setComponentPageBounds(instanceId, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }).catch(() => undefined); };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule); observer.observe(surface.current);
    window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true); window.addEventListener(PANEL_LAYOUT_CHANGED_EVENT, schedule); schedule();
    return () => { observer.disconnect(); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); window.removeEventListener(PANEL_LAYOUT_CHANGED_EVENT, schedule); cancelAnimationFrame(frame); };
  }, [active, open, instanceId, width, order, info.title, info.subtitle, error]);
  if (!open || !active) return null;
  return <section data-workspace-panel={panelId} aria-label={contribution.label} className="flex min-h-0 shrink-0 flex-col bg-slate-50" style={{ width, order }}>
    <WorkspacePanelHeader id={panelId} label={contribution.label} title={info.title} subtitle={info.subtitle} pinned={pinned} onTogglePinned={onTogglePinned} onClose={onClose}/>
    {error ? <div role="alert" className="p-3 text-sm text-red-600">{error}<button onClick={() => setRetry(value => value + 1)} className="ml-2 rounded border px-2 py-1">重试</button></div> : <div ref={surface} data-component-view-host className="min-h-0 flex-1">{!instanceId && <p role="status" className="p-3 text-sm text-slate-500">正在打开面板…</p>}</div>}
  </section>;
};
