import type { ProgressFolder } from '../../types';
import type { VersionRelationKind } from '../versioning/public';

export type CompareMatch = { source: string; reference: string; target: string; confidence: string; distance: number };

export type ProgressSetupDraft = {
  mode: 'create' | 'import' | 'mark';
  mediaKind: 'image' | 'video';
  relation: 'root' | 'branch';
  relationKind: VersionRelationKind;
  parentProgressId: string;
  versionKey: string;
  progressName: string;
  trackingEnabled: boolean;
  deleteSourceAfterImport: boolean;
  sourcePaths: string[];
  renameSources: boolean;
  copyMissingFromParent: boolean;
  workflowInputProgressIds: string[];
  targetRelativePath?: string;
  existingProgressId?: string;
  preserveFolderName?: boolean;
  contextLocked?: boolean;
  openEditorAfterCreate?: boolean;
};

export type ProgressCompareConfirmation = {
  sourceMode: 'import' | 'mark';
  progressFolder: ProgressFolder;
  parentFolder: ProgressFolder;
  matches: CompareMatch[];
  suggestions: CompareMatch[];
  acceptedSources: string[];
  unmatchedSources: string[];
  unmatchedReferences: string[];
  renameSources: boolean;
  copyMissingFromParent: boolean;
  reconcileExisting?: boolean;
  trackingRefreshMode?: 'establish' | 'refresh';
  enableTrackingOnCommit?: boolean;
  incrementalSources?: string[];
};
