/**
 * Messages showing a number use the translation plural rules, not "(s)"
 * (tester feedback: "1 éléments", "connectée(s)", "notification(s) non lue(s)").
 */
import { createTranslator } from 'use-intl';
import { describe, it, expect } from 'vitest';
import en from '../i18n/messages/en.json' with { type: 'json' };
import fr from '../i18n/messages/fr.json' with { type: 'json' };

const KEYS = [
  'aiSettings.assignment.selectedCount',
  'sources.configurationsPage.writeToolTitle',
  'sources.configurationsPage.maskedColumnsTitle',
  'dashboard.pipeline.sources.connected',
  'setupLogin.notificationsBell.ariaUnreadCount',
] as const;

function format(messages: typeof en, locale: 'en' | 'fr', key: string, count: number): string {
  const t = createTranslator({ locale, messages });
  return (t as unknown as (k: string, v: { count: number }) => string)(key, { count });
}

describe('count messages use plural rules', () => {
  it('formats singular and plural in French', () => {
    expect(KEYS.map((k) => format(fr, 'fr', k, 1))).toEqual([
      '1 sélectionné',
      'Outil d’écriture activé sur 1 table',
      '1 colonne masquée',
      '1 connectée',
      '1 notification non lue',
    ]);
    expect(KEYS.map((k) => format(fr, 'fr', k, 3))).toEqual([
      '3 sélectionnés',
      'Outil d’écriture activé sur 3 tables',
      '3 colonnes masquées',
      '3 connectées',
      '3 notifications non lues',
    ]);
  });

  it('formats singular and plural in English', () => {
    expect(KEYS.map((k) => format(en, 'en', k, 1))).toEqual([
      '1 selected',
      'Write tool enabled on 1 table',
      '1 column masked',
      '1 connected',
      '1 unread notification',
    ]);
    expect(format(en, 'en', KEYS[4], 2)).toBe('2 unread notifications');
  });

  it('no message with a count placeholder falls back to "(s)"', () => {
    for (const messages of [en, fr]) {
      const offenders: string[] = [];
      const walk = (node: unknown, path: string) => {
        if (typeof node === 'string') {
          if (node.includes('(s)') && /\{\w+/.test(node)) offenders.push(path);
        } else if (node && typeof node === 'object') {
          for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
        }
      };
      walk(messages, '');
      expect(offenders).toEqual([]);
    }
  });
});
