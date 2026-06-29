import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import LoginPage from '../components/LoginPage.js';
import SetupPage from '../components/SetupPage.js';
import ChatEntryPage from '../components/ChatEntryPage.js';
import SchemaExplorer from '../components/SchemaExplorer.js';
import SourcesPage from '../components/SourcesPage.js';

describe('App smoke tests', () => {
  it('LoginPage renders without error', () => {
    const { container } = render(<LoginPage onAdminLogin={() => {}} onUserLogin={() => {}} />);
    expect(container).toBeTruthy();
  });

  it('SetupPage renders without error', () => {
    const { container } = render(<SetupPage onSetupComplete={() => {}} />);
    expect(container).toBeTruthy();
  });

  it('ChatEntryPage renders without error', () => {
    const { container } = render(<ChatEntryPage profileName="default" />);
    expect(container).toBeTruthy();
  });

  it('SchemaExplorer renders without error', () => {
    const { container } = render(
      <SchemaExplorer schema={null} selectedTables={{}} onSelectionChange={() => {}} />,
    );
    expect(container).toBeTruthy();
  });

  it('SourcesPage renders databases tab without error', () => {
    const MockKB = vi.fn(() => null);
    const { container } = render(
      <SourcesPage
        currentTab="databases"
        onTabChange={() => {}}
        connections={[]}
        onConnectionsChange={() => {}}
        onSchemaLoaded={() => {}}
        ragEnabled={false}
        ragDisabledReason={null}
        KnowledgeBaseManagerComponent={MockKB}
      />,
    );
    expect(container).toBeTruthy();
    expect(screen.getByText('Sources')).toBeTruthy();
    expect(screen.queryAllByText('Databases').length).toBeGreaterThanOrEqual(1);
  });

  it('SourcesPage renders knowledge tab disabled when RAG is off', () => {
    const MockKB = vi.fn(() => null);
    const { container } = render(
      <SourcesPage
        currentTab="knowledge"
        onTabChange={() => {}}
        connections={[]}
        onConnectionsChange={() => {}}
        onSchemaLoaded={() => {}}
        ragEnabled={false}
        ragDisabledReason={null}
        KnowledgeBaseManagerComponent={MockKB}
      />,
    );
    expect(container).toBeTruthy();
    expect(screen.getByText('Knowledge bases')).toBeTruthy();
  });
});
