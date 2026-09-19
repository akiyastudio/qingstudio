import type { MediaMetadataField, ProjectFileEntry } from '../../types';
import { projectWorkspaceClient } from '../../platform/project-workspace-client';

const OFFICE_OPEN_XML_EXTENSIONS = new Set([
  '.docx', '.docm', '.dotx', '.dotm',
  '.pptx', '.pptm', '.potx', '.potm', '.ppsx', '.ppsm', '.ppam',
  '.xlsx', '.xlsm', '.xltx', '.xltm', '.xlam', '.xlsb',
]);
const SCREENSHOT_MAIN_IMAGE_EXTENSIONS = new Set(['.bmp', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp']);
const PHOTOSHOP_DOCUMENT_EXTENSIONS = new Set(['.psd', '.psb']);
const METADATA_GROUP_PRIORITY = ['ExifIFD', 'ExifIFD1', 'IFD0', 'Composite', 'QuickTime', 'Track1', 'XMP', 'File', 'System', '其他'];
const captureDateTimeRequestCache = new Map<string, Promise<string | undefined>>();

export const isOfficeOpenXmlEntry = (entry: ProjectFileEntry) => entry.kind === 'file' && OFFICE_OPEN_XML_EXTENSIONS.has(entry.extension.toLocaleLowerCase());
export const isScreenshotMainImageEntry = (entry: ProjectFileEntry) => entry.kind === 'image' && SCREENSHOT_MAIN_IMAGE_EXTENSIONS.has(entry.extension.toLocaleLowerCase());
export const isPhotoshopOpenEntry = (entry: ProjectFileEntry) => entry.kind === 'image'
  || entry.kind === 'raw'
  || entry.kind === 'file' && PHOTOSHOP_DOCUMENT_EXTENSIONS.has(entry.extension.toLocaleLowerCase());

export const pickMetadataValue = (fields: readonly MediaMetadataField[], ...names: string[]) => {
  for (const name of names) {
    const matches = fields.filter(field => field.name === name);
    const preferred = [...matches].sort((left, right) => {
      const leftRank = METADATA_GROUP_PRIORITY.indexOf(left.group);
      const rightRank = METADATA_GROUP_PRIORITY.indexOf(right.group);
      return (leftRank < 0 ? 999 : leftRank) - (rightRank < 0 ? 999 : rightRank);
    })[0];
    if (preferred?.value) return preferred.value;
  }
  return undefined;
};

const formatCaptureDate = (value?: string) => {
  const source = value?.trim();
  if (!source) return undefined;
  const parts = source.match(/^(\d{4})[:-](\d{2})[:-](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (parts) {
    const [, yearText, monthText, dayText, hourText = '00', minuteText = '00', secondText = '00'] = parts;
    const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
    const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText);
    const maximumDay = year > 0 && month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > maximumDay || hour > 23 || minute > 59 || second > 59) return undefined;
  }
  return source.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(/([+-]\d{2}):?(\d{2})$/, ' $1:$2');
};

export const pickCaptureDate = (fields: readonly MediaMetadataField[], ...names: string[]) => {
  for (const name of names) {
    const formatted = formatCaptureDate(pickMetadataValue(fields, name));
    if (formatted) return formatted;
  }
  return undefined;
};

export const formatShutterSpeed = (value?: string) => {
  if (!value) return undefined;
  if (/\//.test(value)) return value;
  const seconds = Number(value.replace(/\s*s(?:ec(?:onds?)?)?$/i, '').trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return value;
  if (seconds < 1) return `1/${Math.max(1, Math.round(1 / seconds))} 秒`;
  return `${Number(seconds.toFixed(3))} 秒`;
};

export const requestCaptureDateTime = (entry: ProjectFileEntry) => {
  const cacheKey = `${entry.path}|${entry.updatedAt}`;
  const cached = captureDateTimeRequestCache.get(cacheKey);
  if (cached) return cached;
  const request = projectWorkspaceClient.getMediaMetadata(entry.path).then(result => {
    if (!result.success) { captureDateTimeRequestCache.delete(cacheKey); return undefined; }
    return pickCaptureDate(result.fields, 'DateTimeOriginal', 'CreateDate', 'MediaCreateDate', 'TrackCreateDate', 'CreationDate', 'FileModifyDate');
  }).catch(error => {
    captureDateTimeRequestCache.delete(cacheKey);
    throw error;
  });
  if (captureDateTimeRequestCache.size >= 256) captureDateTimeRequestCache.delete(captureDateTimeRequestCache.keys().next().value as string);
  captureDateTimeRequestCache.set(cacheKey, request);
  return request;
};
