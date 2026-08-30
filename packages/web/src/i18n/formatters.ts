// Locale-aware date formatting, built on Intl — replaces the hardcoded
// 'en-US' calls scattered across components.

import type { Locale } from './locale.js';

export function formatDate(date: Date | number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}
