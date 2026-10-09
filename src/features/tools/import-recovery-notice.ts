import { t } from '../../i18n/runtime';

type ImportRecoveryResult = {
  success: boolean;
  error?: string;
  failures: Array<{ error: string; code?: string; stage?: string }>;
};

export const importRecoveryNotice = (result: ImportRecoveryResult): string | null => {
  // A missing receipt can be an interrupted staging operation. It is not proof
  // that media was imported, nor can a restart reconstruct the missing receipt.
  if (result.failures.some(failure => failure.code === 'IMPORT_RECEIPT_ABSENT')) {
    return t('importRecovery.missingReceipt');
  }
  if (result.failures.some(failure => ['IMPORT_RECEIPT_CORRUPT', 'IMPORT_RECEIPT_SESSION_MISMATCH'].includes(failure.code || ''))) {
    return t('importRecovery.invalidReceipt');
  }
  if (result.failures.some(failure => ['scan-staging-root', 'read-receipt'].includes(failure.stage || ''))) {
    return t('importRecovery.unreadable');
  }
  if (result.failures.length) {
    return t('importRecovery.relationshipFailure', { error: result.failures[0].error });
  }
  if (!result.success || result.error) return t('importRecovery.scanFailure', { error: result.error || t('errors.unknown') });
  return null;
};
