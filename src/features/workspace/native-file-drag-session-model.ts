export type NativeFileDragTarget = {
  relativePath: string;
  label: string;
  element: HTMLElement;
};

export const nativeFileDragOwnerIdentity = (pageId: string, projectPath: string) => `${pageId}\n${projectPath}`;
export const nativeFileDragSessionMustReset = (previousIdentity: string, nextIdentity: string, active: boolean) => !active || previousIdentity !== nextIdentity;

export const tryStartNativeFileDrag = (send: () => void, onFailure: (error: unknown) => void) => {
  try {
    send();
    return true;
  } catch (error) {
    onFailure(error);
    return false;
  }
};

export const nativeFileDragTargetFromElement = ({
  element, surface, currentRelativePath, rootLabel, normalize,
}: {
  element: Element | null;
  surface: HTMLElement | null;
  currentRelativePath: string;
  rootLabel: string;
  normalize: (path: string) => string;
}): NativeFileDragTarget | null => {
  const entryTarget = element?.closest<HTMLElement>('[data-entry-path]');
  if (entryTarget) {
    if (entryTarget.dataset.dropCapable === 'false') return null;
    if (entryTarget.dataset.dropCapable !== 'true' && entryTarget.dataset.entryKind !== 'folder') return null;
    return { relativePath: normalize(entryTarget.dataset.entryPath || ''), label: entryTarget.title || entryTarget.dataset.entryPath || rootLabel, element: entryTarget };
  }
  const recursiveTarget = element?.closest<HTMLElement>('[data-recursive-folder-path]');
  if (recursiveTarget) {
    if (recursiveTarget.dataset.dropCapable === 'false' || recursiveTarget.dataset.recursiveFolderReadonly === 'true') return null;
    if (recursiveTarget.dataset.dropCapable !== 'true' && recursiveTarget.dataset.recursiveFolderReadonly !== 'false') return null;
    return { relativePath: normalize(recursiveTarget.dataset.recursiveFolderPath || ''), label: recursiveTarget.dataset.recursiveFolderLabel || recursiveTarget.dataset.recursiveFolderPath || rootLabel, element: recursiveTarget };
  }
  const containingSurface = element?.closest<HTMLElement>('[data-photoflow-file-surface="true"]');
  if (!surface || containingSurface !== surface) return null;
  const relativePath = normalize(currentRelativePath);
  return { relativePath, label: relativePath.split('/').pop() || rootLabel, element: surface };
};

export const nativeFileDragDecisionDetails = (
  reason: string,
  result: { clientX: number; clientY: number; insideWindow: boolean; started: boolean },
  targetSource = 'none',
) => JSON.stringify({ reason, targetSource, clientX: result.clientX, clientY: result.clientY, insideWindow: result.insideWindow, started: result.started });
