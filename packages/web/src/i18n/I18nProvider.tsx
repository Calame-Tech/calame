// Locale context (i18n foundation). Owns the active locale and lets any
// component switch it — mirrors the createContext + hook + provider
// convention from context/SessionContext.tsx.

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { IntlProvider } from 'use-intl/react';
import { type Locale, resolveInitialLocale, saveLocale } from './locale.js';
import en from './messages/en.json' with { type: 'json' };
import fr from './messages/fr.json' with { type: 'json' };

const MESSAGES: Record<Locale, typeof en> = { en, fr };

/** Everything exposed by {@link useLocale}. */
export interface I18nState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nState | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(resolveInitialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    saveLocale(next);
  }, []);

  const value = useMemo<I18nState>(() => ({ locale, setLocale }), [locale, setLocale]);

  return (
    <I18nContext.Provider value={value}>
      <IntlProvider locale={locale} messages={MESSAGES[locale]}>
        {children}
      </IntlProvider>
    </I18nContext.Provider>
  );
}

/** Access the active locale and its setter. Throws when used outside an {@link I18nProvider}. */
export function useLocale(): I18nState {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useLocale must be used within an I18nProvider');
  }
  return ctx;
}
