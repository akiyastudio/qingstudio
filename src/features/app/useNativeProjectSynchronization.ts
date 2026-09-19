import { useEffect, useRef } from 'react';
import type { WorkspaceProject } from '../../types';

const normalizedPath = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
export const useNativeProjectSynchronization = (enabled: boolean, project: WorkspaceProject | WorkspaceProject[] | null | undefined, workspacePath: string, onRefresh: (project: WorkspaceProject) => void) => {
  const projects = Array.isArray(project) ? project : project ? [project] : [];
  const latest = useRef({ projects, onRefresh });
  latest.current = { projects, onRefresh };
  const signature = [...new Set(projects.map(project => `${project.workspacePath || workspacePath}\0${project.id}`))].sort().join('\n');
  useEffect(() => {
    if (!enabled || !signature) return;
    let disposed = false, generation = 0;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const request = ++generation;
      const roots = [...new Set(latest.current.projects.map(project => project.workspacePath || workspacePath).filter(Boolean))];
      await Promise.all(roots.map(async root => {
        const result = await window.electronAPI.getWorkspaceProjects(root);
        if (disposed || request !== generation || !result.success) return;
        const catalog = new Map(result.statuses.flatMap(group => group.projects).map(project => [project.id, project]));
        const previousProjects = new Map(latest.current.projects.filter(project => normalizedPath(project.workspacePath || workspacePath) === normalizedPath(root)).map(project => [project.id, project]));
        for (const previous of previousProjects.values()) {
          const next = catalog.get(previous.id);
          const updated: WorkspaceProject = next ? { ...next, workspacePath: root } : { ...previous, availability: 'missing' };
          if (JSON.stringify(previous) !== JSON.stringify(updated)) latest.current.onRefresh(updated);
        }
      }));
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { void refresh().catch(error => window.electronAPI.reportRendererError('跨窗口刷新项目失败', String(error))); }, 80); };
    const unsubscribe = window.electronAPI.onWorkspaceProjectsChanged(change => { if (latest.current.projects.some(project => normalizedPath(change.root) === normalizedPath(project.workspacePath || workspacePath))) schedule(); });
    schedule();
    return () => { disposed = true; clearTimeout(timer); unsubscribe(); };
  }, [enabled, signature, workspacePath]);
};
