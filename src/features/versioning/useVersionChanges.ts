import { useEffect, useRef, useState } from 'react';
import { projectWorkspaceClient } from '../../platform/project-workspace-client';

const comparable = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();

export const useVersionChanges = (active: boolean, busy: boolean, workspacePath: string, projectName: string, projectId: string, refresh: () => Promise<unknown>) => {
  const latest = useRef(refresh);
  latest.current = refresh;
  const dirty = useRef(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    dirty.current = false;
    return projectWorkspaceClient.onWorkspaceVersionsChanged(change => {
      if (comparable(change.root) !== comparable(workspacePath)) return;
      if (change.projectId && change.projectId !== projectId) return;
      if (!change.projectId && change.projectName && comparable(change.projectName) !== comparable(projectName)) return;
      dirty.current = true;
      setRevision(value => value + 1);
    });
  }, [workspacePath, projectName, projectId]);
  useEffect(() => {
    if (!active || busy || !dirty.current) return;
    const timer = setTimeout(() => {
      dirty.current = false;
      void latest.current().catch(error => window.electronAPI.reportRendererError('同步版本信息失败', String(error)));
    }, 120);
    return () => clearTimeout(timer);
  }, [active, busy, revision, workspacePath, projectName, projectId]);
};
