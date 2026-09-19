import { useState } from 'react';
import type { AppConfig, ProgressFolder } from '../../types';
import { ProgressPairPreview as SharedProgressPairPreview, type ProgressPairPreviewMode } from '../versioning/public';

export const ProgressPairPreview = ({ match, parentFolder, progressFolder, cacheConfig }: {
  match?: { source?: string; reference?: string };
  parentFolder: ProgressFolder;
  progressFolder: ProgressFolder;
  cacheConfig: AppConfig['mediaCache'];
}) => {
  const [mode, setMode] = useState<ProgressPairPreviewMode>('side-by-side');
  const [swapped, setSwapped] = useState(false);
  const joinPath = (folderPath: string, name?: string) => name
    ? `${folderPath.replace(/[\\/]+$/, '')}${folderPath.includes('\\') ? '\\' : '/'}${name}`
    : '';
  return <SharedProgressPairPreview
    referencePath={joinPath(parentFolder.folderPath, match?.reference)}
    sourcePath={joinPath(progressFolder.folderPath, match?.source)}
    referenceLabel={match?.reference ? `上一版本 · ${match.reference}` : '上一版本'}
    sourceLabel={match?.source ? `当前版本 · ${match.source}` : '当前版本'}
    referenceMissing={!match?.reference}
    mode={mode}
    swapped={swapped}
    cacheConfig={cacheConfig}
    onModeChange={setMode}
    onSwappedChange={setSwapped}
  />;
};
