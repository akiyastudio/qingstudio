const WEB_IMAGE_DRAG_TYPES = new Set(['text/uri-list', 'text/html', 'text/plain']);
const MAX_BROWSER_IMAGE_URLS = 20;
const MAX_BROWSER_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_BROWSER_IMAGE_TOTAL_BYTES = 100 * 1024 * 1024;

type BrowserImageDragData = Pick<DataTransfer, 'types' | 'getData'>;
type BrowserProvidedFile = Pick<File, 'name' | 'type' | 'size' | 'arrayBuffer'>;

export type DroppedBrowserImageFile = { name: string; type: string; bytes: ArrayBuffer };

const normalizeRemoteImageUrl = (candidate: string) => {
  const value = candidate.trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (parsed.username || parsed.password) return '';
    return parsed.href;
  } catch {
    return '';
  }
};

const uriListCandidates = (value: string) => value
  .split(/\r?\n/u)
  .map(line => line.trim())
  .filter(line => line && !line.startsWith('#'));

const decodeHtmlUrl = (value: string) => value
  .replace(/&amp;/giu, '&')
  .replace(/&quot;/giu, '"')
  .replace(/&#39;/giu, "'")
  .replace(/&lt;/giu, '<')
  .replace(/&gt;/giu, '>');

const htmlImageCandidates = (html: string) => {
  if (!html.trim()) return [];
  if (typeof DOMParser !== 'undefined') {
    const document = new DOMParser().parseFromString(html, 'text/html');
    return Array.from(document.querySelectorAll('img[src]')).map(image => image.getAttribute('src') || '');
  }
  return Array.from(html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu))
    .map(match => decodeHtmlUrl(match[1] || match[2] || match[3] || ''));
};

const readDragData = (dataTransfer: BrowserImageDragData, type: string) => {
  try { return dataTransfer.getData(type) || ''; }
  catch { return ''; }
};

export const hasBrowserImageDragData = (dataTransfer: BrowserImageDragData) => {
  const types = Array.from(dataTransfer.types || []);
  if (types.some(type => type === 'text/uri-list' || type === 'text/html')) return true;
  if (!types.includes('text/plain')) return false;
  return Boolean(normalizeRemoteImageUrl(readDragData(dataTransfer, 'text/plain')));
};

export const extractBrowserImageUrls = (dataTransfer: BrowserImageDragData) => {
  const candidates = [
    ...uriListCandidates(readDragData(dataTransfer, 'text/uri-list')),
    ...htmlImageCandidates(readDragData(dataTransfer, 'text/html')),
    readDragData(dataTransfer, 'text/plain'),
  ];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeRemoteImageUrl(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
    if (urls.length >= MAX_BROWSER_IMAGE_URLS) break;
  }
  return urls;
};

export const hasImportableExternalDragData = (dataTransfer: BrowserImageDragData) => {
  const types = Array.from(dataTransfer.types || []);
  return types.includes('Files') || types.some(type => WEB_IMAGE_DRAG_TYPES.has(type)) && hasBrowserImageDragData(dataTransfer);
};

export const readBrowserProvidedImageFiles = async (files: BrowserProvidedFile[]) => {
  const images: DroppedBrowserImageFile[] = [];
  let totalBytes = 0;
  for (const file of files.slice(0, MAX_BROWSER_IMAGE_URLS)) {
    if (file.size > MAX_BROWSER_IMAGE_BYTES || totalBytes + file.size > MAX_BROWSER_IMAGE_TOTAL_BYTES) continue;
    try {
      const bytes = await file.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > MAX_BROWSER_IMAGE_BYTES || totalBytes + bytes.byteLength > MAX_BROWSER_IMAGE_TOTAL_BYTES) continue;
      totalBytes += bytes.byteLength;
      images.push({ name: file.name || '', type: file.type || '', bytes });
    } catch {
      // Some browsers advertise a virtual File but only expose its URL. The
      // caller falls back to the URL payload when no file bytes can be read.
    }
  }
  return images;
};
