// Tester feedback #04: the dashboard servers table names the access mode in
// plain words instead of printing the raw enum value ("token").
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTranslator } from 'use-intl';
import ServersTable from '../ServersTable.js';
import { I18nProvider } from '../../../i18n/I18nProvider.js';
import type { Profile, ServeStatus } from '../../../types/schema.js';
import en from '../../../i18n/messages/en.json' with { type: 'json' };
import fr from '../../../i18n/messages/fr.json' with { type: 'json' };

const PROFILES: Profile[] = [
  { name: 'p1', label: 'Équipe', authMode: 'token' },
  { name: 'p2', label: 'Public' },
];
const STATUS = { active: true, port: 4567, profiles: ['p1'] } as ServeStatus;

function renderTable() {
  render(
    <ServersTable setView={vi.fn()} profiles={PROFILES} serveStatus={STATUS} recentActivity={[]} />,
    { wrapper: I18nProvider },
  );
}

describe('ServersTable — access column', () => {
  afterEach(() => localStorage.clear());

  describe('in French', () => {
    beforeEach(() => localStorage.setItem('calame-locale', 'fr'));

    it('translates the auth mode and the column header', () => {
      renderTable();
      expect(screen.getByRole('columnheader', { name: 'Accès' })).toBeInTheDocument();
      expect(screen.getByText('Clé API')).toBeInTheDocument();
      expect(screen.getByText('Ouvert')).toBeInTheDocument();
      expect(screen.queryByText('token')).not.toBeInTheDocument();
    });
  });

  describe('in English', () => {
    beforeEach(() => localStorage.setItem('calame-locale', 'en'));

    it('translates the auth mode and the column header', () => {
      renderTable();
      expect(screen.getByRole('columnheader', { name: 'Access' })).toBeInTheDocument();
      expect(screen.getByText('API Key')).toBeInTheDocument();
      expect(screen.getByText('Open')).toBeInTheDocument();
      expect(screen.queryByText('token')).not.toBeInTheDocument();
    });
  });
});

describe('dashboard and chat counters', () => {
  it('labels server cards with words, not ON / OFF', () => {
    for (const [locale, messages, on, off] of [
      ['fr', fr, 'Actif', 'Arrêté'],
      ['en', en, 'Running', 'Stopped'],
    ] as const) {
      const t = createTranslator({ locale, messages, namespace: 'dashboard.pipeline' });
      expect(t('mcpServers.on')).toBe(on);
      expect(t('mcpServers.off')).toBe(off);
    }
  });

  it('agrees token and active-server counts with the number', () => {
    const tFr = createTranslator({ locale: 'fr', messages: fr });
    const tEn = createTranslator({ locale: 'en', messages: en });
    expect(tFr('chat.usage.tokens', { count: 1 })).toBe('1 jeton');
    expect(tFr('chat.usage.tokens', { count: 3 })).toBe('3 jetons');
    expect(tEn('chat.usage.tokens', { count: 1 })).toBe('1 token');
    expect(tEn('chat.usage.tokens', { count: 3 })).toBe('3 tokens');
    expect(tFr('dashboard.pipeline.mcpServers.activeSuffix', { count: 1 })).toBe('· 1 actif');
    expect(tFr('dashboard.pipeline.mcpServers.activeSuffix', { count: 2 })).toBe('· 2 actifs');
  });
});
