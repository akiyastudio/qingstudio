const PROJECT_FILE_LIST_QUERY_MAX_LENGTH = 160;
const PROJECT_FILE_LIST_MAX_EXTENSIONS = 64;
const PROJECT_FILE_LIST_MAX_EXTENSION_LENGTH = 24;
const PROJECT_FILE_LIST_MAX_EXTENSION_BYTES = 2048;

const normalizeProjectFileListFilter = value => {
  const allowedKinds = new Set(['file', 'image', 'raw', 'video', 'shortcut']);
  const kinds = [...new Set((Array.isArray(value?.kinds) ? value.kinds : []).map(kind => String(kind).toLowerCase()).filter(kind => allowedKinds.has(kind)))].sort();
  const requestedExtensions = Array.isArray(value?.extensions) ? value.extensions : [];
  if (requestedExtensions.length > PROJECT_FILE_LIST_MAX_EXTENSIONS) throw new Error(`扩展名筛选最多 ${PROJECT_FILE_LIST_MAX_EXTENSIONS} 项`);
  const extensions = [...new Set(requestedExtensions.map(extension => String(extension).trim().toLowerCase()).filter(Boolean).map(extension => extension.startsWith('.') ? extension : `.${extension}`))].sort();
  if (extensions.some(extension => extension.length > PROJECT_FILE_LIST_MAX_EXTENSION_LENGTH || !/^\.[\p{L}\p{N}_+-]+$/u.test(extension))) throw new Error('扩展名筛选包含无效或过长项目');
  if (Buffer.byteLength(extensions.join(','), 'utf8') > PROJECT_FILE_LIST_MAX_EXTENSION_BYTES) throw new Error('扩展名筛选总长度过大');
  const query = String(value?.query || '').normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, PROJECT_FILE_LIST_QUERY_MAX_LENGTH).toLocaleLowerCase('zh-CN');
  return { query, kinds, extensions, signature: JSON.stringify({ query, kinds, extensions }) };
};

const projectFileListSessionMatches = (session, root, scope, filter) => Boolean(session
  && session.root === root && session.scope === scope && session.filterSignature === filter.signature);

const projectFileListEntryMatchesFilter = (name, kind, extension, filter) => (!filter.query || String(name).normalize('NFKC').toLocaleLowerCase('zh-CN').includes(filter.query))
  && (!filter.kinds.length || filter.kinds.includes(kind))
  && (!filter.extensions.length || filter.extensions.includes(extension));

module.exports = { normalizeProjectFileListFilter, projectFileListEntryMatchesFilter, projectFileListSessionMatches };
