import zh from '../../electron/locales/zh-CN.json';
import { catalogs as registeredCatalogs, LANGUAGES, BASE_LANGUAGE } from './catalogs.generated';
export { LANGUAGES } from './catalogs.generated';

export type Locale = keyof typeof registeredCatalogs;
export type LanguagePreference = 'system' | Locale;
export type MessageKey = keyof typeof zh;
export type MessageParams = Record<string, string | number | boolean | null | undefined>;
const catalogs: Record<Locale, Record<string, string>> = registeredCatalogs;
let locale: Locale = 'zh-CN';
let preference: LanguagePreference = 'zh-CN';
const listeners = new Set<() => void>();
export const normalizeLanguage = (value: unknown, fallback: LanguagePreference = 'zh-CN'): LanguagePreference =>
  value === 'system' || LANGUAGES.some(language => language.id === value) ? value as LanguagePreference : fallback;
export const resolveLocale = (preference: LanguagePreference, systemLanguage: string): Locale => {
  if (preference !== 'system') return preference;
  return LANGUAGES.find(language => language.id.toLowerCase() === systemLanguage.toLowerCase())?.id
    ?? LANGUAGES.find(language => language.id.split('-')[0] === systemLanguage.toLowerCase().split('-')[0])?.id
    ?? BASE_LANGUAGE;
};
export const getLocale = () => locale;
export const subscribeLocale = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const setLanguage = (requested: LanguagePreference, systemLanguage = typeof navigator === 'undefined' ? 'zh-CN' : navigator.language) => {
  preference = requested;
  const next = resolveLocale(requested, systemLanguage);
  if (typeof document !== 'undefined') {
    if (Object.values(catalogs).some(catalog => catalog["ui.photoflow.cae155"] === document.title)) document.title = translate(next, "ui.photoflow.cae155");
    document.documentElement.lang = next;
    document.documentElement.dir = LANGUAGES.find(language => language.id === next)!.direction;
  }
  if (next === locale) return;
  locale = next;
  listeners.forEach(listener => listener());
};
const lookup = (catalog: Record<string, string>, key: string) => Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : undefined;
export const translate = (language: Locale, key: MessageKey, params: MessageParams = {}): string => {
  const category = typeof params.count === 'number' ? new Intl.PluralRules(language).select(params.count) : '';
  const pluralKey = category ? `${key}.${category}` : key;
  const template = lookup(catalogs[language], pluralKey) ?? lookup(catalogs[language], key) ?? lookup(catalogs['zh-CN'], pluralKey) ?? lookup(catalogs['zh-CN'], key);
  if (template === undefined) return catalogs[language]['errors.unknown'];
  return template.replace(/\{([A-Za-z][\w]*)\}/g, (token, name: string) => Object.prototype.hasOwnProperty.call(params, name) ? (params[name] == null || typeof params[name] === 'boolean' ? '' : String(params[name])) : token);
};
export const t = (key: MessageKey, params?: MessageParams) => translate(locale, key, params);
export const formatNumber = (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, options).format(value);
export const formatDate = (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? t('common.unknown') : new Intl.DateTimeFormat(locale, options ?? { dateStyle: 'medium', timeStyle: 'short' }).format(date);
};
export const formatRelativeTime = (value: number, unit: Intl.RelativeTimeFormatUnit) => new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(value, unit);

if (typeof window !== 'undefined') window.addEventListener('languagechange', () => { if (preference === 'system') setLanguage('system'); });
