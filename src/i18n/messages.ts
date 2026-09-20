import { createLegacyParser } from './legacy-parser';
import { catalogs } from './catalogs.generated';
import { t, type MessageKey, type MessageParams } from './runtime';

/** Serializable display text. Identifiers and params never contain executable markup. */
export type LocalizedParams = Record<string, MessageParams[string] | LocalizedMessage>;
export interface LocalizedMessage { messageKey: MessageKey; params?: LocalizedParams; parameterMessages?: Record<string, MessageKey> }
export interface StructuredNotice extends LocalizedMessage { severity: 'info' | 'success' | 'warning' | 'error'; persistent?: boolean }
const renderNestedMessage = (message: LocalizedMessage, depth: number): string => {
  if (depth > 8) return t('errors.unknown');
  const params = Object.fromEntries(Object.entries(message.params ?? {}).map(([name, value]) => [name, value !== null && typeof value === 'object' ? renderNestedMessage(value, depth + 1) : value]));
  return t(message.messageKey, { ...params, ...Object.fromEntries(Object.entries(message.parameterMessages ?? {}).map(([name, key]) => [name, t(key)])) });
};
export const renderMessage = (message: LocalizedMessage) => renderNestedMessage(message, 0);
export const legacyNoticeMessage = createLegacyParser(catalogs) as (source: string) => LocalizedMessage | undefined;

const ERROR_KEYS: Record<string, MessageKey> = {
  FILE_NOT_FOUND: 'errors.fileNotFound', ENOENT: 'errors.fileNotFound', EPERM: 'errors.permissionDenied', EACCES: 'errors.permissionDenied',
  EBUSY: 'errors.busy', SQLITE_BUSY: 'errors.busy', SQLITE_LOCKED: 'errors.busy', DOMAIN_BACKPRESSURE: 'errors.busy',
  ENOSPC: 'errors.noSpace', EROFS: 'errors.readOnly', SQLITE_READONLY: 'errors.readOnly',
  SQLITE_CORRUPT: 'errors.databaseCorrupt', SQLITE_IOERR: 'errors.databaseIo', CONFIG_CONCURRENT_EDIT: 'errors.conflict',
};
export const errorNotice = (code: string): StructuredNotice => ({
  messageKey: Object.prototype.hasOwnProperty.call(ERROR_KEYS, code) ? ERROR_KEYS[code] : 'errors.unknown', severity: 'error', persistent: ['SQLITE_CORRUPT', 'SQLITE_IOERR'].includes(code),
});

export type LocalizedText = string | LocalizedMessage;
export const localizedMessage = (messageKey: MessageKey, params?: LocalizedParams): LocalizedMessage => ({ messageKey, ...(params ? { params } : {}) });
export const renderText = (value: LocalizedText | undefined): string => { if (typeof value !== 'string') return value ? renderMessage(value) : ''; const message = legacyNoticeMessage(value); return message ? renderMessage(message) : value; };


/** Locale-independent identity for repeated notices. */
export const sameLocalizedMessage = (left: LocalizedMessage, right: LocalizedMessage, depth = 0): boolean => {
  if (left === right) return true;
  if (depth > 8 || left.messageKey !== right.messageKey) return false;
  const leftParams = left.params ?? {}, rightParams = right.params ?? {};
  const keys = Object.keys(leftParams).sort();
  const rightKeys = Object.keys(rightParams).sort();
  if (keys.length !== rightKeys.length || keys.some((key, index) => key !== rightKeys[index])) return false;
  for (const key of keys) {
    const a = leftParams[key], b = rightParams[key];
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') { if (!sameLocalizedMessage(a, b, depth + 1)) return false; }
    else if (!Object.is(a, b)) return false;
  }
  const leftMessages = left.parameterMessages ?? {}, rightMessages = right.parameterMessages ?? {};
  const messageKeys = Object.keys(leftMessages).sort();
  const rightMessageKeys = Object.keys(rightMessages).sort();
  return messageKeys.length === rightMessageKeys.length && messageKeys.every((key, index) => key === rightMessageKeys[index] && leftMessages[key] === rightMessages[key]);
};
