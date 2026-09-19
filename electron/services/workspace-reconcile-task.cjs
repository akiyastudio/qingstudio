const createWorkspaceReconcileTask = ({ backgroundTasks, getWatchedWorkspacePath, getProjects, reconcileWorkspaceCatalog, writeLog }) => {
  let generation = 0;
  const runningByRoot = new Map();
  const run = async (root, restartTask = null) => {
    const runGeneration = generation;
    if (getWatchedWorkspacePath() !== root) {
      if (restartTask?.id) throw new Error('工作区当前未处于可对账状态');
      return undefined;
    }
    const existing = runningByRoot.get(root);
    if (existing?.generation === runGeneration) {
      if (restartTask?.id) throw new Error('工作区当前未处于可对账状态');
      return existing.promise;
    }
    const token = { generation: runGeneration, promise: null };
    runningByRoot.set(root, token);
    token.promise = (async () => {
      try {
        return await backgroundTasks.run({
          ...(restartTask?.id ? { id: restartTask.id } : {}),
          type: 'workspace-reconcile',
          title: '工作区文件与数据库对账',
          dedupeKey: `workspace-reconcile:${root}:${runGeneration}`,
          cancellable: false,
          // Repository calls already coordinate their own database transactions;
          // a task-wide writer would block every foreground project operation.
          resources: [],
          metadata: { root, generation: runGeneration },
        }, async task => {
          task.report(5, '正在读取项目目录');
          const previousProjectsSnapshot = JSON.stringify(getProjects(root) || []);
          const catalog = await reconcileWorkspaceCatalog(root, { signal: task.signal, priority: -10, preemptible: true });
          const catalogChanged = previousProjectsSnapshot !== JSON.stringify(catalog.projects || []);
          task.report(95, '项目目录核对完成');
          writeLog('info', 'Periodic workspace reconciliation completed', { root, projects: catalog.projects.length, catalogChanged });
          return catalog;
        });
      } catch (error) {
        if (error?.code !== 'DATABASE_PREEMPTED' && error?.code !== 'TASK_CANCELLED') {
          writeLog('warn', 'Periodic workspace reconciliation deferred', { root, error: error.message || String(error) });
        }
        if (restartTask?.id) throw error;
        return undefined;
      } finally {
        if (runningByRoot.get(root) === token) runningByRoot.delete(root);
      }
    })();
    return token.promise;
  };
  backgroundTasks.registerTypeRestartFactory('workspace-reconcile', task => run(task.metadata?.root, task), {
    canRestart: task => Boolean(task.metadata?.root), autoRestart: true, autoRestartDelayMs: 5000,
  });
  return { run, reset: () => { generation += 1; } };
};

module.exports = { createWorkspaceReconcileTask };
