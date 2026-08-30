// Locale detection + persistence. Mirrors the load/save error-swallowing
// pattern used for layout prefs in lib/graph-order.ts.

export type Locale = 'en' | 'fr';

export const LOCALES: Locale[] = ['en', 'fr'];
export const DEFAULT_LOCALE: Locale = 'en';

const STORAGE_KEY = 'calame-locale';

function isLocale(v: unknown): v is Locale {
  return v === 'en' || v === 'fr';
}

/** Loads the user's saved locale choice, or null when absent/corrupt. */
export function loadLocale(): Locale | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isLocale(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function saveLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Storage full / unavailable — persistence is best-effort.
  }
}

/** Detects the browser's preferred locale, falling back to {@link DEFAULT_LOCALE}. */
export function detectLocale(): Locale {
  const lang = typeof navigator !== 'undefined' ? navigator.language : undefined;
  return lang?.toLowerCase().startsWith('fr') ? 'fr' : DEFAULT_LOCALE;
}

/** Saved choice takes precedence over browser detection. */
export function resolveInitialLocale(): Locale {
  return loadLocale() ?? detectLocale();
}
