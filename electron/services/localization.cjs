const registry = require('../locales/registry.json');
const catalogs = Object.fromEntries(registry.languages.map(language => {
  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language.id)) throw new Error('Invalid locale id');
  return [language.id, require('../locales/' + language.id + '.json')];
}));
const isSupportedLocale = value => typeof value === 'string' && Object.hasOwn(catalogs, value);
const { createLegacyParser } = require('../locales/legacy-parser.generated.cjs');
const parseLegacyText = createLegacyParser(catalogs, registry.baseLanguage);
const lookup = (catalog, key) => Object.hasOwn(catalog, key) ? catalog[key] : undefined;
let locale = 'zh-CN';
const normalizeLanguage = (value, fallback = 'zh-CN') => value === 'system' || isSupportedLocale(value) ? value : fallback;
const resolveLocale = (preference, systemLanguage = '') => preference !== 'system' ? normalizeLanguage(preference) : registry.languages.find(language => language.id.toLowerCase() === systemLanguage.toLowerCase())?.id ?? registry.languages.find(language => language.id.split('-')[0] === systemLanguage.toLowerCase().split('-')[0])?.id ?? registry.baseLanguage;
const setLanguage = (preference, systemLanguage = 'zh-CN') => { locale = resolveLocale(normalizeLanguage(preference), systemLanguage); };
const getLocale = () => locale;
const t = (key, params = {}, language = locale) => {
  const catalog = catalogs[language] || catalogs['zh-CN'];
  const plural = typeof params.count === 'number' ? key + '.' + new Intl.PluralRules(language).select(params.count) : key;
  const template = lookup(catalog, plural) ?? lookup(catalog, key) ?? lookup(catalogs['zh-CN'], plural) ?? lookup(catalogs['zh-CN'], key) ?? catalogs['zh-CN']['errors.unknown'];
  return template.replace(/\{([A-Za-z][\w]*)\}/g, (token, name) => Object.hasOwn(params, name) ? (params[name] == null || typeof params[name] === 'boolean' ? '' : String(params[name])) : token);
};
const renderText = value => {
  if (typeof value !== 'string') return value;
  const message = parseLegacyText(value);
  return message ? t(message.messageKey, { ...message.params, ...Object.fromEntries(Object.entries(message.parameterMessages || {}).map(([name, key]) => [name, t(key)])) }) : value;
};
const localizeDialogOptions = options => {
  if (!options || typeof options !== 'object') return options;
  const localized = { ...options };
  for (const key of ['title', 'message', 'detail', 'buttonLabel', 'checkboxLabel']) if (typeof options[key] === 'string') localized[key] = renderText(options[key]);
  if (Array.isArray(options.buttons)) localized.buttons = options.buttons.map(renderText);
  if (Array.isArray(options.filters)) localized.filters = options.filters.map(filter => ({ ...filter, name: renderText(filter.name) }));
  return localized;
};
module.exports = { renderText, localizeDialogOptions, isSupportedLocale, normalizeLanguage, resolveLocale, setLanguage, getLocale, t };
