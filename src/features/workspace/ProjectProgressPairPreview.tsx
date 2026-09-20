import { useLocale } from "../../i18n/react";
import { t } from "../../i18n/runtime";
import { useState } from 'react';
import type { AppConfig, ProgressFolder } from '../../types';
import { ProgressPairPreview as SharedProgressPairPreview, type ProgressPairPreviewMode } from '../versioning/public';

export const ProgressPairPreview = ({ match, parentFolder, progressFolder, cacheConfig }: {
  match?: { source?: string; reference?: string };
  parentFolder: ProgressFolder;
  progressFolder: ProgressFolder;
  cacheConfig: AppConfig['mediaCache'];
}) => {
  useLocale();
  const [mode, setMode] = useState<ProgressPairPreviewMode>('side-by-side');
  const [swapped, setSwapped] = useState(false);
  const joinPath = (folderPath: string, name?: string) => name
    ? `${folderPath.replace(/[\\/]+$/, '')}${folderPath.includes('\\') ? '\\' : '/'}${name}`
    : '';
  return <SharedProgressPairPreview
    referencePath={joinPath(parentFolder.folderPath, match?.reference)}
    sourcePath={joinPath(progressFolder.folderPath, match?.source)}
    referenceLabel={match?.reference ? t("ui.previous.version.value0.1f74fd", { value0: match.reference }) : t("ui.previous.version.ffc5b2")}
    sourceLabel={match?.source ? t("ui.current.version.value0.319cee", { value0: match.source }) : t("ui.current.version.837bc9")}
    referenceMissing={!match?.reference}
    mode={mode}
    swapped={swapped}
    cacheConfig={cacheConfig}
    onModeChange={setMode}
    onSwappedChange={setSwapped}
  />;
};
