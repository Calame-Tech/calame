// ConfigurationDetailPage component tests (Phase 3 #16).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ConfigurationDetailPage from '../ConfigurationDetailPage.js';
import { useSession } from '../../context/SessionContext.js';
import { makeSession, installFetchMock, flushEffects } from './testUtils.js';
import type { Configuration } from '../../types/schema.js';

vi.mock('../../context/SessionContext.js', () => ({
  useSession: vi.fn(),
}));

// The page lazily imports RagAccessSelector from the EE package — mock the
// module so the license boundary and heavy imports are avoided.
vi.mock('@calame-ee/rag-core/web', () => ({
  KnowledgeBaseManager: () => <div>KB Manager (mock)</div>,
  RagAccessSelector: () => <div>Rag selector (mock)</div>,
}));

const configurations: Configuration[] = [{ name: 'sales', label: 'Sales' }];

function renderPage(setView = vi.fn()) {
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
      handleConfigurationSave={vi.fn(async () => true)}
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
    fireEvent.click(screen.getByText('Data Profiles'));
    expect(setView).toHaveBeenCalledWith({ page: 'configurations' });
  });

  it('opens the Knowledge tab and mounts the lazy RagAccessSelector when RAG is on', async () => {
    vi.mocked(useSession).mockReturnValue(makeSession({ ragEnabled: true }));
    renderPage();
    fireEvent.click(screen.getByText('Knowledge bases'));
    expect(await screen.findByText('Rag selector (mock)')).toBeTruthy();
    await flushEffects();
  });
});
