export type BatchRenameToken = 'text' | 'original' | 'sequence' | 'letter' | 'datetime' | 'replace';
export type BatchRenamePart = {
  id: string;
  type: BatchRenameToken;
  value: string;
  caseMode: 'preserve' | 'upper' | 'lower';
  sequenceStart: number;
  sequenceDigits: number;
  letterCase: 'upper' | 'lower';
  dateSource: 'created' | 'modified';
  dateFormat: string;
  find: string;
  replace: string;
};

export const BATCH_RENAME_PREFERENCES_KEY = 'photoflow:batch-rename-rules-v1';
export const createBatchRenamePart = (type: BatchRenameToken = 'text'): BatchRenamePart => ({
  id: `rename-part-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  type,
  value: '',
  caseMode: 'preserve',
  sequenceStart: 1,
  sequenceDigits: 2,
  letterCase: 'upper',
  dateSource: 'modified',
  dateFormat: 'YYYYMMDD_HHmmss',
  find: '',
  replace: ''
});

const defaultParts = () => [createBatchRenamePart('text'), createBatchRenamePart('sequence')];
const tokens: readonly string[] = ['text', 'original', 'sequence', 'letter', 'datetime', 'replace'];
const dateFormats = ['YYYYMMDD_HHmmss', 'YYYYMMDD', 'HHmmss', 'DDMMYYYY_HHmmss', 'DDMMYYYY'];

export const readBatchRenameParts = (storage?: Pick<Storage, 'getItem'>): BatchRenamePart[] => {
  try {
    const saved = JSON.parse((storage ?? window.localStorage).getItem(BATCH_RENAME_PREFERENCES_KEY) || 'null');
    if (!Array.isArray(saved) || !saved.length) return defaultParts();
    return saved.map((value: unknown) => {
      if (!value || typeof value !== 'object') throw new Error('Invalid rename rule');
      const part = value as Record<string, unknown>;
      if (typeof part.type !== 'string' || !tokens.includes(part.type)) throw new Error('Invalid rename rule type');
      const result = createBatchRenamePart(part.type as BatchRenameToken);
      for (const key of ['value', 'find', 'replace'] as const) {
        if (typeof part[key] === 'string') result[key] = part[key];
      }
      if (part.caseMode === 'preserve' || part.caseMode === 'upper' || part.caseMode === 'lower') result.caseMode = part.caseMode;
      if (typeof part.sequenceStart === 'number' && Number.isFinite(part.sequenceStart) && part.sequenceStart >= 0) result.sequenceStart = part.sequenceStart;
      if (typeof part.sequenceDigits === 'number' && Number.isInteger(part.sequenceDigits) && part.sequenceDigits >= 1 && part.sequenceDigits <= 6) result.sequenceDigits = part.sequenceDigits;
      if (part.letterCase === 'upper' || part.letterCase === 'lower') result.letterCase = part.letterCase;
      if (part.dateSource === 'created' || part.dateSource === 'modified') result.dateSource = part.dateSource;
      if (typeof part.dateFormat === 'string' && dateFormats.includes(part.dateFormat)) result.dateFormat = part.dateFormat;
      return result;
    });
  } catch {
    return defaultParts();
  }
};

export const writeBatchRenameParts = (parts: BatchRenamePart[], storage?: Pick<Storage, 'setItem'>) => {
  // Clearing transient dialog state after submission must not erase the last format.
  if (!parts.length) return;
  try {
    const rules = parts.map(({ id: _id, ...rule }) => rule);
    (storage ?? window.localStorage).setItem(BATCH_RENAME_PREFERENCES_KEY, JSON.stringify(rules));
  } catch { /* Preferences are optional when storage is unavailable. */ }
};
