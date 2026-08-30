import { useTranslations } from 'use-intl/react';
import { useLocale } from '../i18n/I18nProvider.js';
import { LOCALES, type Locale } from '../i18n/locale.js';

/** Language settings panel — switches the active locale instantly, no save step. */
export default function LanguageSettings() {
  const { locale, setLocale } = useLocale();
  const t = useTranslations('settings.tabs.language');
  const tLang = useTranslations('language');

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-gray-100">{t('label')}</h3>
        <p className="text-sm text-gray-400 mt-1">{t('description')}</p>
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-300">{tLang('label')}</label>
        <select
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
          className="input-editorial text-sm"
        >
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {tLang(l)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
