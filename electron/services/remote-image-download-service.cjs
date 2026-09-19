const MAX_REMOTE_IMAGE_COUNT = 20;
const MAX_REMOTE_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_DROPPED_IMAGE_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_REMOTE_IMAGE_REDIRECTS = 5;
const REMOTE_IMAGE_TIMEOUT_MS = 30_000;

const CONTENT_TYPE_EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/gif', '.gif'], ['image/webp', '.webp'],
  ['image/bmp', '.bmp'], ['image/tiff', '.tiff'], ['image/avif', '.avif'], ['image/heic', '.heic'], ['image/heif', '.heif'],
]);

const detectImageExtension = buffer => {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')) return '.gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  if (buffer.length >= 2 && buffer.subarray(0, 2).toString('ascii') === 'BM') return '.bmp';
  if (buffer.length >= 4 && (buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])))) return '.tiff';
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii').toLowerCase();
    if (brand === 'avif' || brand === 'avis') return '.avif';
    if (new Set(['heic', 'heix', 'hevc', 'hevx']).has(brand)) return '.heic';
    if (brand === 'mif1' || brand === 'msf1') return '.heif';
  }
  return '';
};

const normalizeRemoteImageUrl = candidate => {
  let parsed;
  try { parsed = new URL(String(candidate || '').trim()); }
  catch { throw new Error('网页图片地址无效'); }
  if (!new Set(['http:', 'https:']).has(parsed.protocol) || parsed.username || parsed.password) throw new Error('只支持公开的 HTTP(S) 网页图片地址');
  return parsed;
};

const createPrivateAddressBlockList = net => {
  if (!net?.BlockList) return null;
  const list = new net.BlockList();
  for (const [address, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4],
  ]) list.addSubnet(address, prefix, 'ipv4');
  for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) list.addSubnet(address, prefix, 'ipv6');
  return list;
};

const assertPublicRemoteHost = async (url, { lookup, net }) => {
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) throw new Error('不能从本机或局域网地址导入网页图片');
  if (typeof lookup !== 'function' || !net?.isIP) return;
  const addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error('无法解析网页图片地址');
  const blockList = createPrivateAddressBlockList(net);
  const privateAddress = addresses.some(entry => {
    const family = Number(entry.family) === 6 || entry.family === 'ipv6' ? 'ipv6' : 'ipv4';
    return blockList?.check(entry.address, family) || (family === 'ipv6' && entry.address.toLowerCase().startsWith('::ffff:') && blockList?.check(entry.address.slice(7), 'ipv4'));
  });
  if (privateAddress) throw new Error('不能从本机或局域网地址导入网页图片');
};

const responseBufferWithLimit = async response => {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_IMAGE_BYTES) throw new Error('网页图片超过 25 MB，无法导入');
  if (!response.body) throw new Error('网页图片响应没有内容');
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_REMOTE_IMAGE_BYTES) {
      await response.body.cancel?.().catch(() => undefined);
      throw new Error('网页图片超过 25 MB，无法导入');
    }
    chunks.push(bytes);
  }
  if (!total) throw new Error('网页图片内容为空');
  return Buffer.concat(chunks, total);
};

const fetchRemoteImage = async (initialUrl, dependencies) => {
  const { fetch, lookup, net } = dependencies;
  if (typeof fetch !== 'function') throw new Error('当前运行环境不支持下载网页图片');
  let url = normalizeRemoteImageUrl(initialUrl);
  for (let redirectCount = 0; redirectCount <= MAX_REMOTE_IMAGE_REDIRECTS; redirectCount += 1) {
    await assertPublicRemoteHost(url, { lookup, net });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_IMAGE_TIMEOUT_MS);
    try {
      const response = await fetch(url.href, {
        credentials: 'include', redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8', 'User-Agent': 'PhotoFlow/BrowserImageImport' },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new Error('网页图片重定向地址无效');
        if (redirectCount === MAX_REMOTE_IMAGE_REDIRECTS) throw new Error('网页图片重定向次数过多');
        url = normalizeRemoteImageUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) throw new Error(`网页图片下载失败（HTTP ${response.status}）`);
      const buffer = await responseBufferWithLimit(response);
      const detectedExtension = detectImageExtension(buffer);
      const contentType = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
      const declaredExtension = CONTENT_TYPE_EXTENSIONS.get(contentType) || '';
      if (!detectedExtension) throw new Error(declaredExtension ? '网页图片格式损坏或不受支持' : '拖入的网址返回的不是受支持图片');
      return { buffer, extension: detectedExtension, finalUrl: url };
    } catch (error) {
      if (controller.signal.aborted) throw new Error('下载网页图片超时');
      if (error instanceof Error && /^网页图片|^拖入的网址|^只支持/u.test(error.message)) throw error;
      const detail = error?.cause?.message || error?.message || String(error);
      throw new Error(`无法下载网页图片：${detail}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('网页图片重定向次数过多');
};

const safeRemoteImageName = (url, extension, index) => {
  let basename = '';
  try { basename = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || ''); }
  catch { basename = ''; }
  const originalStem = basename.replace(/\.[^.]*$/u, '');
  let stem = originalStem.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').replace(/[. ]+$/u, '').trim();
  if (!stem || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem)) stem = `网页图片${index + 1}`;
  stem = stem.slice(0, 120).replace(/[. ]+$/u, '') || `网页图片${index + 1}`;
  return `${stem}${extension}`;
};

const safeDroppedImageName = (candidate, extension, index) => {
  let basename = String(candidate || '').split(/[\\/]/u).pop() || '';
  const originalStem = basename.replace(/\.[^.]*$/u, '');
  let stem = originalStem.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').replace(/[. ]+$/u, '').trim();
  if (!stem || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem)) stem = `网页图片${index + 1}`;
  stem = stem.slice(0, 120).replace(/[. ]+$/u, '') || `网页图片${index + 1}`;
  return `${stem}${extension}`;
};

const uniqueTemporaryPath = (directory, filename, reservedNames, { fs, path }) => {
  const parsed = path.parse(filename);
  let candidate = filename;
  let suffix = 1;
  while (reservedNames.has(candidate.toLowerCase()) || fs.existsSync(path.join(directory, candidate))) candidate = `${parsed.name} (${suffix++})${parsed.ext}`;
  reservedNames.add(candidate.toLowerCase());
  return path.join(directory, candidate);
};

const downloadRemoteImages = async (urls, temporaryDirectory, dependencies) => {
  const uniqueUrls = Array.from(new Set((Array.isArray(urls) ? urls : []).map(value => String(value || '').trim()).filter(Boolean)));
  if (!uniqueUrls.length) throw new Error('没有可导入的网页图片地址');
  if (uniqueUrls.length > MAX_REMOTE_IMAGE_COUNT) throw new Error(`一次最多导入 ${MAX_REMOTE_IMAGE_COUNT} 张网页图片`);
  await dependencies.fs.promises.mkdir(temporaryDirectory, { recursive: true });
  const downloadedPaths = [];
  const reservedNames = new Set();
  for (let index = 0; index < uniqueUrls.length; index += 1) {
    const downloaded = await fetchRemoteImage(uniqueUrls[index], dependencies);
    const filename = safeRemoteImageName(downloaded.finalUrl, downloaded.extension, index);
    const target = uniqueTemporaryPath(temporaryDirectory, filename, reservedNames, dependencies);
    await dependencies.fs.promises.writeFile(target, downloaded.buffer, { flag: 'wx', mode: 0o600 });
    downloadedPaths.push(target);
  }
  return downloadedPaths;
};

const droppedImageBuffer = value => {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new Error('浏览器没有提供可读取的图片内容');
};

const stageDroppedImageFiles = async (files, temporaryDirectory, dependencies) => {
  if (!Array.isArray(files) || !files.length) throw new Error('浏览器没有提供可导入的图片内容');
  if (files.length > MAX_REMOTE_IMAGE_COUNT) throw new Error(`一次最多导入 ${MAX_REMOTE_IMAGE_COUNT} 张网页图片`);
  await dependencies.fs.promises.mkdir(temporaryDirectory, { recursive: true });
  const stagedPaths = [];
  const reservedNames = new Set();
  let totalBytes = 0;
  for (let index = 0; index < files.length; index += 1) {
    const buffer = droppedImageBuffer(files[index]?.bytes);
    if (!buffer.length) throw new Error('浏览器提供的图片内容为空');
    if (buffer.length > MAX_REMOTE_IMAGE_BYTES) throw new Error('网页图片超过 25 MB，无法导入');
    totalBytes += buffer.length;
    if (totalBytes > MAX_DROPPED_IMAGE_TOTAL_BYTES) throw new Error('本次拖入的网页图片总大小超过 100 MB');
    const extension = detectImageExtension(buffer);
    if (!extension) throw new Error('浏览器提供的内容不是受支持图片');
    const filename = safeDroppedImageName(files[index]?.name, extension, index);
    const target = uniqueTemporaryPath(temporaryDirectory, filename, reservedNames, dependencies);
    await dependencies.fs.promises.writeFile(target, buffer, { flag: 'wx', mode: 0o600 });
    stagedPaths.push(target);
  }
  return stagedPaths;
};

module.exports = {
  MAX_DROPPED_IMAGE_TOTAL_BYTES,
  MAX_REMOTE_IMAGE_BYTES,
  MAX_REMOTE_IMAGE_COUNT,
  assertPublicRemoteHost,
  detectImageExtension,
  downloadRemoteImages,
  fetchRemoteImage,
  normalizeRemoteImageUrl,
  safeDroppedImageName,
  safeRemoteImageName,
  stageDroppedImageFiles,
};
