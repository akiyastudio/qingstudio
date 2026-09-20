import { useState } from 'react';
import { LANGUAGES, normalizeLanguage, setLanguage, type LanguagePreference } from './runtime';
import { useTranslation } from './react';

export const LanguageSelector = ({ value, save }: { value: LanguagePreference; save: (language: LanguagePreference) => Promise<boolean> }) => {
  const t = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const change = async (language: LanguagePreference) => {
    setBusy(true); setError(false);
    try { if (await save(language)) setLanguage(language); else setError(true); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  return <div className="flex min-w-0 flex-col gap-1">
    <select aria-label={t('settings.language.title')} value={normalizeLanguage(value)} disabled={busy} onChange={event => void change(normalizeLanguage(event.target.value))} className="form-input min-w-40 max-w-full">
      <option value="system">{t('settings.language.system')}</option>
      {LANGUAGES.map(language => <option key={language.id} value={language.id} lang={language.id}>{language.name}</option>)}
    </select>
    {error && <span role="alert" className="text-xs text-red-600">{t('settings.language.saveFailed')}</span>}
  </div>;
};
