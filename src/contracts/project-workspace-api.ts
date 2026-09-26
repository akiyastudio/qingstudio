import type { IElectronAPI } from '../types';

export type ProjectWorkspaceApiKey =
  | 'onShellNewFileTypesChanged' | 'onWorkspaceVersionsChanged'
  | 'addInspirationToProject' | 'adoptVersionTreeFolder' | 'browseFinalVersions' | 'browseProjectFiles'
  | 'browseProjectShortcutPreview' | 'cancelBackgroundTask' | 'cancelListProjectFiles' | 'cancelMediaThumbnail'
  | 'cancelProjectFileCut' | 'cancelRecentProjectFiles' | 'chooseBrollSourceFiles' | 'chooseImportSourceFiles'
  | 'chooseProjectImportFiles' | 'chooseWorkspaceDirectory' | 'commitVersionBatch' | 'copyProjectEntryPath'
  | 'createProjectFolder' | 'createProjectShellNewFile' | 'createVersionGraphEdge' | 'deleteVersionGraphEdge'
  | 'executeManualSelection' | 'exportFinalVersions' | 'extractOfficeImages' | 'extractScreenshotMainImages'
  | 'finalizeSdImportedProjects' | 'getCursorScreenPoint' | 'getFileIcon' | 'getFinalVersionSummary'
  | 'getDrives' | 'getMediaMetadata' | 'getMediaOriginal' | 'getMediaRating' | 'getMediaRatings' | 'getMediaThumbnail' | 'getProjectVideoTimelineFrames'
  | 'getPathForFile' | 'getPhotoshopStatus' | 'getProgressFolders' | 'getProgressFoldersSnapshot' | 'getProjectContents'
  | 'getProjectEntryDetails' | 'getProjectFileClipboardStatus' | 'getProjectFileDetails' | 'getShellNewFileTypes'
  | 'getVersionBatchOperations' | 'getWorkspaceProjects' | 'importBroll'
  | 'importProgressFiles' | 'importProjectFiles' | 'inspectProjectToolSources' | 'listProjectFiles' | 'listWorkspaceFolders'
  | 'listRecentProjectFiles' | 'moveWorkspaceProject' | 'onBackgroundTaskChanged' | 'onProjectFileDragEnd'
  | 'onProjectFileOperationProgress' | 'onThumbnailStateChanged' | 'onWorkspaceFilesChanged' | 'openMediaVersion'
  | 'openProjectEntriesInPhotoshop' | 'openProjectEntry' | 'openWorkspaceProject' | 'preflightManualSelection'
  | 'projectFileOperation' | 'registerProgressFolder' | 'registerProgressWithGraph' | 'renameProgressFolder'
  | 'registerVersionBaseline' | 'replaceVersionGraphEdgeSource' | 'resolveProjectShortcut'
  | 'retryVersionBatchOperations' | 'searchProjectFiles' | 'setMediaRating' | 'setWindowFullscreen'
  | 'startProgressTracking' | 'startProjectFileDrag' | 'trackTelemetry' | 'trashWorkspaceProject'
  | 'cancelProjectVideoTrim' | 'onProjectVideoTrimProgress' | 'trimProjectVideo' | 'unregisterProgressFolder' | 'unwatchFileRoot' | 'updateProgressFolder' | 'updateProgressRelation' | 'watchFileRoot';

export type ProjectWorkspaceApi = Pick<IElectronAPI, ProjectWorkspaceApiKey>;
