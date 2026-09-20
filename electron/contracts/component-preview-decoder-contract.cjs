const parsePreviewDecoders = (value, rpcMethods) => {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 16) throw new Error('previewDecoders must contain at most 16 decoders');
  const ids = new Set();
  return Object.freeze(value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['id', 'label', 'extensions', 'method', 'priority', 'thumbnailMethod'].includes(key)) || !/^[a-z0-9][a-z0-9.-]{0,79}$/.test(item.id) || ids.has(item.id) || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 160 || !rpcMethods.includes(item.method) || !Array.isArray(item.extensions) || !item.extensions.length || item.extensions.length > 64 || new Set(item.extensions).size !== item.extensions.length || item.extensions.some(ext => typeof ext !== 'string' || ext !== '*' && (!ext.startsWith('.') || ext.length < 2 || ext.length > 64 || /[\\/:*?"<>|\x00-\x20]/.test(ext) || ext !== ext.toLowerCase())) || item.priority !== undefined && (!Number.isInteger(item.priority) || item.priority < -100 || item.priority > 100)) throw new Error('Invalid preview decoder declaration');
    if (item.thumbnailMethod !== undefined && !rpcMethods.includes(item.thumbnailMethod)) throw new Error('Invalid thumbnail method');
    ids.add(item.id);
    return Object.freeze({ id: item.id, label: item.label, extensions: Object.freeze([...item.extensions]), method: item.method, priority: item.priority || 0, ...(item.thumbnailMethod ? { thumbnailMethod: item.thumbnailMethod } : {}) });
  }));
};
module.exports = { parsePreviewDecoders };
