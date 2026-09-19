export type FileOperationNotificationResult = {
  taskNotificationOwned?: boolean;
};

/**
 * Operation ids also identify synchronous, silent operations such as rename,
 * so they cannot determine notification ownership. Main/IPC code sets this
 * flag only after a visible BackgroundTask has actually been established.
 */
export const pageOwnsFileOperationNotification = (result: FileOperationNotificationResult | null | undefined) =>
  result?.taskNotificationOwned !== true;
