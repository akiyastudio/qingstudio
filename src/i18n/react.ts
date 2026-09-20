import { useCallback, useSyncExternalStore } from 'react';
import { getLocale, subscribeLocale, translate, type MessageKey, type MessageParams } from './runtime';

export const useLocale = () => useSyncExternalStore(subscribeLocale, getLocale, getLocale);
export const useTranslation = () => {
  const locale = useLocale();
  return useCallback((key: MessageKey, params?: MessageParams) => translate(locale, key, params), [locale]);
};
