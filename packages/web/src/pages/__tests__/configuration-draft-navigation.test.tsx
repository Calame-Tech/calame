// Captain feedback on tester point #11 (Data config): in an existing data
// configuration, a knowledge base checked and "disable direct document
// reading" turned on WITHOUT saving must survive a detour through Sources
// (the page unmounts), be shown as unsaved, and be saved or discarded
// explicitly — never leaking into another account or configuration.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { screen, fireEvent } from '@testing-library/react';
import ConfigurationDetailPage from '../ConfigurationDetailPage.js';
import { useSession } from '../../context/SessionContext.js';
import { clearConfigurationDrafts } from '../../lib/configuration-draft.js';
import { setCurrentTenant } from '../../lib/api.js';
import { render, makeSession, installFetchMock, flushEffects } from './testUtils.js';
import type { Configuration, ScopeSelection } from '../../types/schema.js';

vi.mock('../../context/SessionContext.js', () => ({
  useSession: vi.fn(),
}));

// Embedded RagAccessSelector stand-in: shows the selection it was seeded
// with and reports an edit (source checked + direct reading disabled).
vi.mock('@calame-ee/rag-core/web', () => ({
  KnowledgeBaseManager: () => <div>KB Manager (mock)</div>,
  RagAccessSelector: ({
    initialSources,
    initialScopes,
    onSelectionChange,
  }: {
    initialSources: string[];
    initialScopes: Record<string, ScopeSelection>;
    onSelectionChange?: (p: { sources: string[]; scopes: Record<string, unknown> }) => void;
  }) => (
    <div>
      <p>seeded: {initialSources.join(',') || 'none'}</p>
      <p>
        direct reading:{' '}
        {Object.values(initialScopes).some(
          (s) => s.kind === 'document' && s.directFetchDisabled === true,
        )
          ? 'disabled'
          : 'enabled'}
      </p>
      <button
        type="button"
        onClick={() =>
          onSelectionChange?.({
            sources: ['kb1'],
            scopes: {
              kb1: {
                kind: 'document',
                mode: 'allowList',
                allowedFolders: [],
                allowedDocuments: [],
                directFetchDisabled: true,
              },
            },
          })
        }
      >
        Check kb1 and disable direct reading (mock)
      </button>
    </div>
  ),
}));

const CONFIGURATIONS: Configuration[] = [
  { name: 'sales', label: 'Sales' },
  { name: 'support', label: 'Support' },
];
// Server-side configurations, updated by a successful save (like useAppData).
let stored: Configuration[] = CONFIGURATIONS;

function Harness({
  configName,
  save,
}: {
  configName: string;
  save: (c: Configuration) => Promise<boolean>;
}) {
  const [configurations, setConfigurations] = useState(stored);
  return (
    <ConfigurationDetailPage
      view={{ page: 'config-detail', configName }}
      setView={vi.fn()}
      configurations={configurations}
      connections={[]}
      connectionSchemas={{}}
      piiDetections={null}
      scanning={false}
      globalMaskingRules={[]}
      handleScanPii={vi.fn()}
      handleConfigurationSave={async (config) => {
        const ok = await save(config);
        if (ok) {
          stored = stored.map((c) => (c.name === config.name ? config : c));
          setConfigurations(stored);
        }
        return ok;
      }}
      handleConfigurationDelete={vi.fn(async () => {})}
      handleSchemaLoaded={vi.fn()}
      handlePiiOverride={vi.fn()}
      handleGlobalMaskingRulesChange={vi.fn()}
    />
  );
}

function renderPage(configName = 'sales', save = vi.fn(async (_c: Configuration) => true)) {
  const result = render(<Harness configName={configName} save={save} />);
  return { ...result, save };
}

async function editKnowledgeTab() {
  fireEvent.click(screen.getByText('Knowledge bases'));
  fireEvent.click(await screen.findByText('Check kb1 and disable direct reading (mock)'));
  await flushEffects();
}

const UNSAVED = /Unsaved changes/;

describe('Data configuration draft across navigation', () => {
  beforeEach(() => {
    clearConfigurationDrafts();
    stored = CONFIGURATIONS;
    setCurrentTenant('default');
    installFetchMock();
    vi.mocked(useSession).mockReturnValue(
      makeSession({ ragEnabled: true, currentUser: { email: 'alice@example.com', role: 'admin' } }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the unsaved knowledge selection and setting after leaving and coming back', async () => {
    const first = renderPage();
    expect(screen.queryByText(UNSAVED)).toBeNull();
    await editKnowledgeTab();
    expect(screen.getByText(UNSAVED)).toBeTruthy();

    // Navigate to Sources: the page unmounts. Nothing was saved.
    first.unmount();
    expect(first.save).not.toHaveBeenCalled();

    const back = renderPage();
    await flushEffects();
    // Back on the Knowledge tab, seeded with the unsaved selection.
    expect(await screen.findByText('seeded: kb1')).toBeTruthy();
    expect(screen.getByText('direct reading: disabled')).toBeTruthy();
    expect(screen.getByText(UNSAVED)).toBeTruthy();

    // Saving persists exactly the restored edit, then drops the draft.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await flushEffects();
    expect(back.save).toHaveBeenCalledTimes(1);
    expect(back.save.mock.calls[0]![0]).toMatchObject({
      name: 'sales',
      sources: ['kb1'],
      scopes: { kb1: { kind: 'document', directFetchDisabled: true } },
    });
    back.unmount();

    renderPage();
    await flushEffects();
    expect(screen.queryByText(UNSAVED)).toBeNull();
  });

  it('discards the draft on explicit "Discard changes"', async () => {
    const first = renderPage();
    await editKnowledgeTab();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    await flushEffects();
    expect(screen.queryByText(UNSAVED)).toBeNull();
    first.unmount();

    renderPage();
    await flushEffects();
    expect(screen.queryByText(UNSAVED)).toBeNull();
    expect(screen.queryByText('seeded: kb1')).toBeNull();
  });

  it('never restores a draft into another configuration, account or workspace', async () => {
    const first = renderPage();
    await editKnowledgeTab();
    expect(screen.getByText(UNSAVED)).toBeTruthy();
    first.unmount();

    // Another configuration of the same account.
    const other = renderPage('support');
    await flushEffects();
    expect(other.container.textContent).not.toMatch(UNSAVED);
    other.unmount();

    // Same configuration, another account.
    vi.mocked(useSession).mockReturnValue(
      makeSession({ ragEnabled: true, currentUser: { email: 'bob@example.com', role: 'admin' } }),
    );
    const bob = renderPage();
    await flushEffects();
    expect(bob.container.textContent).not.toMatch(UNSAVED);
    bob.unmount();

    // Same account and configuration, another workspace.
    vi.mocked(useSession).mockReturnValue(
      makeSession({ ragEnabled: true, currentUser: { email: 'alice@example.com', role: 'admin' } }),
    );
    setCurrentTenant('acme');
    const acme = renderPage();
    await flushEffects();
    expect(acme.container.textContent).not.toMatch(UNSAVED);
  });

  it('drops every draft when the session ends', async () => {
    const first = renderPage();
    await editKnowledgeTab();
    first.unmount();
    // SessionProvider calls this on logout / lost session.
    clearConfigurationDrafts();
    const again = renderPage();
    await flushEffects();
    expect(again.container.textContent).not.toMatch(UNSAVED);
  });
});
