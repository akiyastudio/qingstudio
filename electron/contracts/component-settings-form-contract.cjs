const SETTINGS_FORM_SCHEMA_VERSION = 1;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const FIELD_TYPES = new Set(['toggle', 'select', 'text', 'number', 'range']);

const plainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exactText = (value, label, maxLength) => {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maxLength) throw new Error(`Invalid ${label}`);
  return value;
};
const optionalText = (value, label, maxLength) => value === undefined ? '' : exactText(value, label, maxLength);
const identifier = (value, label) => {
  const normalized = exactText(value, label, 80);
  if (!IDENTIFIER.test(normalized)) throw new Error(`Invalid ${label}`);
  return normalized;
};
const rejectUnknown = (value, allowed, label) => {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown) throw new Error(`Unknown ${label} field: ${unknown}`);
};
const finiteNumber = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid ${label}`);
  return value;
};

const parseOption = value => {
  if (!plainObject(value)) throw new Error('Invalid settings form option');
  rejectUnknown(value, ['value', 'label', 'description'], 'settings form option');
  const option = {
    value: exactText(value.value, 'settings form option value', 128),
    label: exactText(value.label, 'settings form option label', 120),
  };
  const description = optionalText(value.description, 'settings form option description', 240);
  return Object.freeze({ ...option, ...(description ? { description } : {}) });
};

const parseField = value => {
  if (!plainObject(value)) throw new Error('Invalid settings form field');
  const type = exactText(value.type, 'settings form field type', 32);
  if (!FIELD_TYPES.has(type)) throw new Error(`Unsupported settings form field type: ${type}`);
  const common = ['type', 'id', 'label', 'description', 'default'];
  const allowed = type === 'select' ? [...common, 'options']
    : type === 'text' ? [...common, 'placeholder', 'maxLength']
      : ['number', 'range'].includes(type) ? [...common, 'min', 'max', 'step', 'suffix'] : common;
  rejectUnknown(value, allowed, 'settings form field');
  const field = {
    type,
    id: identifier(value.id, 'settings form field id'),
    label: exactText(value.label, 'settings form field label', 120),
  };
  const description = optionalText(value.description, 'settings form field description', 360);
  if (type === 'toggle') {
    if (typeof value.default !== 'boolean') throw new Error('Toggle settings fields require a boolean default');
    return Object.freeze({ ...field, ...(description ? { description } : {}), default: value.default });
  }
  if (type === 'select') {
    if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 32) throw new Error('Select settings fields require 2-32 options');
    const options = value.options.map(parseOption);
    if (new Set(options.map(option => option.value)).size !== options.length) throw new Error('Select settings field option values must be unique');
    if (typeof value.default !== 'string' || !options.some(option => option.value === value.default)) throw new Error('Select settings field default must reference an option');
    return Object.freeze({ ...field, ...(description ? { description } : {}), default: value.default, options: Object.freeze(options) });
  }
  if (type === 'text') {
    const maxLength = value.maxLength === undefined ? 500 : finiteNumber(value.maxLength, 'settings form text maxLength');
    if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 4000) throw new Error('Settings form text maxLength must be 1-4000');
    if (typeof value.default !== 'string' || value.default.length > maxLength) throw new Error('Text settings field default is invalid');
    const placeholder = optionalText(value.placeholder, 'settings form text placeholder', 240);
    return Object.freeze({ ...field, ...(description ? { description } : {}), default: value.default, maxLength, ...(placeholder ? { placeholder } : {}) });
  }
  const min = finiteNumber(value.min, 'settings form numeric minimum');
  const max = finiteNumber(value.max, 'settings form numeric maximum');
  const step = value.step === undefined ? 1 : finiteNumber(value.step, 'settings form numeric step');
  const defaultValue = finiteNumber(value.default, 'settings form numeric default');
  if (!(min < max) || step <= 0 || defaultValue < min || defaultValue > max) throw new Error('Invalid settings form numeric range');
  const suffix = optionalText(value.suffix, 'settings form numeric suffix', 40);
  return Object.freeze({ ...field, ...(description ? { description } : {}), default: defaultValue, min, max, step, ...(suffix ? { suffix } : {}) });
};

const parseComponentSettingsForm = value => {
  if (!plainObject(value)) throw new Error('Invalid component settings form');
  rejectUnknown(value, ['schemaVersion', 'groups', 'help', 'notices', 'preferenceScope'], 'component settings form');
  const help = value.help === undefined ? [] : value.help;
  if (!Array.isArray(help) || help.length > 16) throw new Error('Invalid settings help');
  const parsedHelp = help.map(item => {
    if (!plainObject(item)) throw new Error('Invalid settings help item');
    rejectUnknown(item, ['title', 'description'], 'settings help');
    return Object.freeze({ title: exactText(item.title, 'settings help title', 160), description: exactText(item.description, 'settings help description', 2000) });
  });
  if (value.preferenceScope !== undefined && value.preferenceScope !== 'videoPlayback') throw new Error('Invalid settings preference scope');
  const notices = value.notices === undefined ? [] : value.notices;
  if (!Array.isArray(notices) || notices.length > 64) throw new Error('Invalid settings notices');
  const parsedNotices = notices.map(notice => {
    if (!plainObject(notice)) throw new Error('Invalid settings notice');
    rejectUnknown(notice, ['title', 'description', 'license', 'sourceUrl', 'licenseUrl'], 'settings notice');
    const result = { title: exactText(notice.title, 'notice title', 160), description: exactText(notice.description, 'notice description', 4000), license: exactText(notice.license, 'notice license', 160) };
    for (const key of ['sourceUrl', 'licenseUrl']) {
      const text = exactText(notice[key], 'notice URL', 2048);
      const url = new URL(text);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid settings notice URL');
      result[key] = text;
    }
    return Object.freeze(result);
  });
  if (value.schemaVersion !== SETTINGS_FORM_SCHEMA_VERSION) throw new Error(`Unsupported component settings form schemaVersion: ${value.schemaVersion}`);
  if (!Array.isArray(value.groups) || (!value.groups.length && !parsedNotices.length && !parsedHelp.length) || value.groups.length > 12) throw new Error('Component settings form groups must be a bounded array');
  const groupIds = new Set(); const fieldIds = new Set(); let fieldCount = 0;
  const groups = value.groups.map(group => {
    if (!plainObject(group)) throw new Error('Invalid component settings form group');
    rejectUnknown(group, ['id', 'title', 'description', 'fields'], 'component settings form group');
    const id = identifier(group.id, 'settings form group id');
    if (groupIds.has(id)) throw new Error('Component settings form group ids must be unique');
    groupIds.add(id);
    if (!Array.isArray(group.fields) || group.fields.length < 1 || group.fields.length > 24) throw new Error('Component settings form fields must be a bounded array');
    const fields = group.fields.map(parseField);
    for (const field of fields) {
      if (fieldIds.has(field.id)) throw new Error('Component settings form field ids must be unique');
      fieldIds.add(field.id); fieldCount += 1;
    }
    const description = optionalText(group.description, 'settings form group description', 360);
    return Object.freeze({ id, title: exactText(group.title, 'settings form group title', 120), ...(description ? { description } : {}), fields: Object.freeze(fields) });
  });
  if (fieldCount > 64) throw new Error('Component settings form may declare at most 64 fields');
  if (value.preferenceScope === 'videoPlayback') {
    for (const field of groups.flatMap(group => group.fields)) {
      const options = { hdrMode: ['auto', 'sdr', 'tone-map', 'hdr-passthrough'], toneMapping: ['auto', 'bt2390', 'reinhard', 'mobius', 'hable'] }[field.id];
      if (options ? field.type !== 'select' || field.options.some(option => !options.includes(option.value)) : field.id !== 'targetPeakNits' || !['range', 'number'].includes(field.type) || field.min < 100 || field.max > 4000) throw new Error('Invalid video playback preference field');
    }
  }
  return Object.freeze({ schemaVersion: SETTINGS_FORM_SCHEMA_VERSION, groups: Object.freeze(groups), ...(parsedHelp.length ? { help: Object.freeze(parsedHelp) } : {}), ...(parsedNotices.length ? { notices: Object.freeze(parsedNotices) } : {}), ...(value.preferenceScope ? { preferenceScope: value.preferenceScope } : {}) });
};

const fieldMap = form => new Map(form.groups.flatMap(group => group.fields).map(field => [field.id, field]));
const validFieldValue = (field, value) => {
  if (field.type === 'toggle') return typeof value === 'boolean';
  if (field.type === 'select') return typeof value === 'string' && field.options.some(option => option.value === value);
  if (field.type === 'text') return typeof value === 'string' && value.length <= field.maxLength;
  return typeof value === 'number' && Number.isFinite(value) && value >= field.min && value <= field.max;
};
const normalizeComponentSettingsFormValues = (form, settings) => {
  const source = plainObject(settings) ? settings : {};
  return Object.freeze(Object.fromEntries([...fieldMap(form)].map(([id, field]) => [id, validFieldValue(field, source[id]) ? source[id] : field.default])));
};
const validateComponentSettingsFormPatch = (form, patch) => {
  if (!plainObject(patch) || !Object.keys(patch).length || Object.keys(patch).length > 64) throw new Error('Settings form patch must be a bounded object');
  const fields = fieldMap(form); const normalized = {};
  for (const [id, value] of Object.entries(patch)) {
    const field = fields.get(id);
    if (!field || !validFieldValue(field, value)) throw new Error(`Invalid settings form value: ${id}`);
    normalized[id] = value;
  }
  return Object.freeze(normalized);
};

module.exports = {
  SETTINGS_FORM_SCHEMA_VERSION,
  parseComponentSettingsForm,
  normalizeComponentSettingsFormValues,
  validateComponentSettingsFormPatch,
};
