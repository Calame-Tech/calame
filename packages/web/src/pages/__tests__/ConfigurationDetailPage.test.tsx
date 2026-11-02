// ConfigurationDetailPage component tests (Phase 3 #16).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { screen, fireEvent } from '@testing-library/react';
import ConfigurationDetailPage from '../ConfigurationDetailPage.js';
import { useSession } from '../../context/SessionContext.js';
import { render, makeSession, installFetchMock, flushEffects } from './testUtils.js';
import { clearConfigurationDrafts } from '../../lib/configuration-draft.js';
import type { Configuration } from '../../types/schema.js';

vi.mock('../../context/SessionContext.js', () => ({
  useSession: vi.fn(),
}));

// The page lazily imports RagAccessSelector from the EE package — mock the
// module so the license boundary and heavy imports are avoided.
vi.mock('@calame-ee/rag-core/web', async () => {
  const { useEffect, useRef } = await vi.importActual<typeof import('react')>('react');
  type Selection = { sources: string[]; scopes: Record<string, unknown> };
  const picked: Selection = {
    sources: ['kb1'],
    scopes: {
      kb1: {
        kind: 'document',
        mode: 'allowList',
        allowedFolders: ['docs'],
        allowedDocuments: [],
      },
    },
  };
  return {
    KnowledgeBaseManager: () => <div>KB Manager (mock)</div>,
    // Embedded mode: reports its selection to the page instead of saving it.
    // Like the real selector, once edited it re-reports its selection when
    // its initial props change.
    RagAccessSelector: ({
      initialSources,
      onSelectionChange,
    }: {
      initialSources: string[];
      onSelectionChange?: (p: Selection) => void;
    }) => {
      const last = useRef<Selection | null>(null);
      useEffect(() => {
        if (last.current) onSelectionChange?.(last.current);
      }, [initialSources]);
      const report = (selection: Selection) => {
        last.current = selection;
        onSelectionChange?.(selection);
      };
      return (
        <div>
          Rag selector (mock)
          <button type="button" onClick={() => report(picked)}>
            Pick folder (mock)
          </button>
          <button type="button" onClick={() => report({ sources: [], scopes: {} })}>
            Clear selection (mock)
          </button>
        </div>
      );
    },
  };
});

const configurations: Configuration[] = [{ name: 'sales', label: 'Sales' }];

function renderPage(setView = vi.fn(), handleConfigurationSave = vi.fn(async () => true)) {
  render(
    <ConfigurationDetailPage
      view={{ page: 'config-detail', configName: 'sales' }}
      setView={setView}
      configurations={configurations}
      connections={[]}
      connectionSchemas={{}}
      piiDetections={null}
      scanning={false}
      globalMaskingRules={[]}
      handleScanPii={vi.fn()}
      handleConfigurationSave={handleConfigurationSave}
      handleConfigurationDelete={vi.fn(async () => {})}
      handleSchemaLoaded={vi.fn()}
      handlePiiOverride={vi.fn()}
      handleGlobalMaskingRulesChange={vi.fn()}
    />,
  );
  return setView;
}

describe('ConfigurationDetailPage', () => {
  beforeEach(() => {
    clearConfigurationDrafts();
    installFetchMock();
    vi.mocked(useSession).mockReturnValue(makeSession());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the configuration header with a disabled Knowledge tab when RAG is off', () => {
    renderPage();
    // Label appears in the breadcrumb and in the editable heading
    expect(screen.getAllByText('Sales').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('No databases connected yet.')).toBeTruthy();
    const kbTab = screen.getByText('Knowledge bases').closest('button');
    expect(kbTab?.getAttribute('aria-disabled')).toBe('true');
  });

  it('navigates back to the configurations list via the breadcrumb', () => {
    const setView = renderPage();
    fireEvent.click(screen.getByText('Data Configurations'));
    expect(setView).toHaveBeenCalledWith({ page: 'configurations' });
  });

  it('opens the Knowledge tab and mounts the lazy RagAccessSelector when RAG is on', async () => {
    vi.mocked(useSession).mockReturnValue(makeSession({ ragEnabled: true }));
    renderPage();
    fireEvent.click(screen.getByText('Knowledge bases'));
    expect(await screen.findByText('Rag selector (mock)')).toBeTruthy();
    await flushEffects();
  });

  it('has a single Save that persists the knowledge-base selection shown on screen', async () => {
    vi.mocked(useSession).mockReturnValue(makeSession({ ragEnabled: true }));
    const save = vi.fn(async (_config: Configuration) => true);
    renderPage(vi.fn(), save);
    fireEvent.click(screen.getByText('Knowledge bases'));
    fireEvent.click(await screen.findByText('Pick folder (mock)'));
    // Switching tabs keeps the unsaved selection (the selector stays mounted).
    fireEvent.click(screen.getByText('Databases'));

    const saveButtons = screen.getAllByRole('button', { name: 'Save changes' });
    expect(saveButtons).toHaveLength(1);
    expect(saveButtons[0]).not.toBeDisabled();
    fireEvent.click(saveButtons[0]!);
    await flushEffects();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toMatchObject({
      name: 'sales',
      sources: ['kb1'],
      scopes: { kb1: { kind: 'document', allowedFolders: ['docs'] } },
    });
  });

  it('disables Save until the configuration is edited, then enables it', () => {
    renderPage();
    const saveButton = screen.getByRole('button', { name: 'Save changes' });
    expect(saveButton).toBeDisabled();
    expect(saveButton.title).toBe('No changes');

    fireEvent.click(document.querySelector('h2')!);
    fireEvent.change(screen.getByDisplayValue('Sales'), { target: { value: 'Sales EMEA' } });

    const updatedButton = screen.getByRole('button', { name: 'Save changes' });
    expect(updatedButton).not.toBeDisabled();
  });

  it('confirms before leaving via the breadcrumb when there are unsaved changes', () => {
    const setView = renderPage();

    fireEvent.click(document.querySelector('h2')!);
    fireEvent.change(screen.getByDisplayValue('Sales'), { target: { value: 'Sales EMEA' } });

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByText('Dashboard'));
    expect(confirmSpy).toHaveBeenCalledWith('You have unsaved changes. Leave without saving?');
    expect(setView).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByText('Dashboard'));
    expect(setView).toHaveBeenCalledWith({ page: 'dashboard' });

    confirmSpy.mockRestore();
  });
  it('refuses an empty selection up front with a clear message, without calling the API', async () => {
    vi.mocked(useSession).mockReturnValue(makeSession({ ragEnabled: true }));
    const save = vi.fn(async (_config: Configuration) => true);
    renderPage(vi.fn(), save);
    fireEvent.click(screen.getByText('Knowledge bases'));
    fireEvent.click(await screen.findByText('Clear selection (mock)'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await flushEffects();

    expect(save).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Select at least one database table or knowledge base');
    expect(alert.textContent).not.toMatch(/console/i);

    // Selecting data again clears the message and the save goes through.
    fireEvent.click(screen.getByText('Pick folder (mock)'));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await flushEffects();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('never points to the console when the save fails', async () => {
    vi.mocked(useSession).mockReturnValue(makeSession({ ragEnabled: true }));
    renderPage(
      vi.fn(),
      vi.fn(async () => false),
    );
    fireEvent.click(screen.getByText('Knowledge bases'));
    fireEvent.click(await screen.findByText('Pick folder (mock)'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await flushEffects();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Save failed');
    expect(alert.textContent).not.toMatch(/console/i);
  });

  it('drops the unsaved-changes notice after deselecting, reselecting and saving', async () => {
    vi.mocked(useSession).mockReturnValue(makeSession({ ragEnabled: true }));
    // Saving updates the configurations, as useAppData does.
    function Stateful() {
      const [configs, setConfigs] = useState<Configuration[]>(configurations);
      return (
        <ConfigurationDetailPage
          view={{ page: 'config-detail', configName: 'sales' }}
          setView={vi.fn()}
          configurations={configs}
          connections={[]}
          connectionSchemas={{}}
          piiDetections={null}
          scanning={false}
          globalMaskingRules={[]}
          handleScanPii={vi.fn()}
          handleConfigurationSave={async (config) => {
            await Promise.resolve(); // the API round-trip
            setConfigs([config]);
            return true;
          }}
          handleConfigurationDelete={vi.fn(async () => {})}
          handleSchemaLoaded={vi.fn()}
          handlePiiOverride={vi.fn()}
          handleGlobalMaskingRulesChange={vi.fn()}
        />
      );
    }
    render(<Stateful />);
    fireEvent.click(screen.getByText('Knowledge bases'));
    fireEvent.click(await screen.findByText('Clear selection (mock)'));
    fireEvent.click(screen.getByText('Pick folder (mock)'));
    expect(screen.getByText(/Unsaved changes/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await flushEffects();
    await flushEffects();

    expect(screen.queryByText(/Unsaved changes/)).toBeNull();
    expect(screen.getByRole('button', { name: /Save|Saved/ })).toBeDisabled();
  });
});
