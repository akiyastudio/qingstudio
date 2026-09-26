export type FileOperationNotificationResult = {
  taskNotificationOwned?: boolean;
  success?: boolean;
};

/**
 * Operation ids also identify synchronous, silent operations such as rename,
 * so they cannot determine notification ownership. Main/IPC code sets this
 * flag only after a visible BackgroundTask has actually been established.
 *
 * A committed result that a BackgroundTask already reported must not be
 * repeated by the page. A *failure* is different: reported file-operation
 * failures are the ones users must not miss, and the task card is an optional
 * secondary surface that can be minimised, dismissed, or never rendered in the
 * host the user is looking at. Losing the only error message is far worse than
 * showing the same failure twice, so failures always stay page-owned.
 */
export const pageOwnsFileOperationNotification = (result: FileOperationNotificationResult | null | undefined) => {
  if (result?.taskNotificationOwned !== true) return true;
  return result.success !== true;
};
