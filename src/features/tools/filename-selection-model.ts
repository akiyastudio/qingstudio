export type FilenameSelectionSourceFolder = {
  name: string;
  relativePath: string;
};

const normalizeRelativePath = (value: string | undefined) => String(value || '')
  .trim()
  .replace(/\\/g, '/')
  .replace(/^\.\//, '')
  .replace(/\/+$/, '');

export const resolveFilenameSelectionSource = (
  folders: FilenameSelectionSourceFolder[],
  configuredPath: string | undefined,
  defaultFolderName: 'raw' | 'mov',
) => {
  if (configuredPath !== undefined && !normalizeRelativePath(configuredPath)) return '';
  const requested = normalizeRelativePath(configuredPath) || defaultFolderName;
  const requestedKey = requested.toLocaleLowerCase();
  return folders.find(folder => normalizeRelativePath(folder.relativePath).toLocaleLowerCase() === requestedKey)?.relativePath
    || folders.find(folder => !normalizeRelativePath(folder.relativePath).includes('/') && folder.name.toLocaleLowerCase() === requestedKey)?.relativePath
    || '';
};

export const filenameSelectionOutputName = (sourceRelativePath: string) => {
  const sourceName = normalizeRelativePath(sourceRelativePath).split('/').filter(Boolean).at(-1) || '';
  if (!sourceName) return '';
  if (sourceName.toLocaleLowerCase() === 'raw') return '图片选片';
  if (sourceName.toLocaleLowerCase() === 'mov') return '视频选片';
  return `${sourceName}_选片`;
};

export const createFilenameSelectionTaskOwnership = () => {
  let generation = 0;
  let phase: 'idle' | 'preflight' | 'confirm' | 'copy' | 'cancelling' = 'idle';
  let operationId = '';
  return {
    begin: () => { phase = 'preflight'; operationId = ''; return ++generation; },
    invalidate: () => {
      const staleOperationId = operationId;
      generation += 1;
      phase = 'idle';
      operationId = '';
      return staleOperationId;
    },
    setPhase: (requestGeneration: number, nextPhase: typeof phase) => {
      if (requestGeneration === generation) phase = nextPhase;
    },
    setOperation: (requestGeneration: number, nextOperationId: string) => {
      if (requestGeneration === generation) operationId = nextOperationId;
    },
    isCurrent: (requestGeneration: number) => requestGeneration === generation,
    finish: (requestGeneration: number) => {
      if (requestGeneration !== generation) return false;
      phase = 'idle';
      operationId = '';
      return true;
    },
    getSnapshot: () => ({ generation, phase, operationId }),
  };
};
