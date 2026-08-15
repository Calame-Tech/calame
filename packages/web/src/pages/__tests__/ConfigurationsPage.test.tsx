// ConfigurationsPage component tests (Phase 3 #16).

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ConfigurationsPage from '../ConfigurationsPage.js';
import { makeProfile, makeServeStatus } from './testUtils.js';
import type { Configuration, NamedConnection, Profile } from '../../types/schema.js';

function renderPage({
  configurations = [] as Configuration[],
  connections = [] as NamedConnection[],
  profiles = [] as Profile[],
  serveStatus = makeServeStatus(),
  setView = vi.fn(),
  setConfigurations = vi.fn(),
  handleConfigurationSave = vi.fn(async () => true),
  handleConfigurationDelete = vi.fn(async () => {}),
} = {}) {
  render(
    <ConfigurationsPage
      setView={setView}
      configurations={configurations}
      setConfigurations={setConfigurations}
      handleConfigurationSave={handleConfigurationSave}
      handleConfigurationDelete={handleConfigurationDelete}
      connections={connections}
      profiles={profiles}
      serveStatus={serveStatus}
    />,
  );
  return { setView, setConfigurations, handleConfigurationSave, handleConfigurationDelete };
}

describe('ConfigurationsPage', () => {
  it('renders an empty state when there are no data profiles', () => {
    renderPage();
    expect(screen.getAllByText('Data Configurations').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('No Data Configurations')).toBeTruthy();
  });

  it('renders a card per configuration', () => {
    renderPage({
      configurations: [
        { name: 'sales', label: 'Sales' },
        { name: 'hr', label: 'Human Resources' },
      ],
    });
    expect(screen.getByText('Sales')).toBeTruthy();
    expect(screen.getByText('Human Resources')).toBeTruthy();
  });

  it('navigates to the detail view when clicking a configuration card', () => {
    const { setView } = renderPage({
      configurations: [{ name: 'sales', label: 'Sales' }],
    });
    fireEvent.click(screen.getByText('Sales'));
    expect(setView).toHaveBeenCalledWith({ page: 'config-detail', configName: 'sales' });
  });

  it('shows write and masking badges when the configuration has them, hides them otherwise', () => {
    const withToolsAndMasking: Configuration = {
      name: 'sales',
      label: 'Sales',
      sources: ['db1'],
      scopes: {
        db1: {
          kind: 'relational',
          selectedTables: { orders: ['id', 'total', 'email'] },
          tableOptions: {
            orders: {
              enabledTools: ['describe', 'query', 'write'],
              maxLimit: 100,
              filterableColumns: [],
              groupableColumns: [],
            },
          },
          columnMasking: {
            orders: {
              email: { maskingMode: 'hash' },
              total: { maskingMode: 'none' },
            },
          },
        },
      },
    };
    const plain: Configuration = { name: 'hr', label: 'Human Resources' };

    renderPage({ configurations: [withToolsAndMasking, plain] });

    expect(screen.getByText(/write on 1 table/)).toBeTruthy();
    expect(screen.getByText(/1 masked column/)).toBeTruthy();
  });

  it('shows which servers mount a configuration', () => {
    renderPage({
      configurations: [{ name: 'sales', label: 'Sales' }],
      profiles: [makeProfile({ configurations: ['sales'] })],
    });
    expect(screen.getByText(/Mounted by/)).toBeTruthy();
    expect(screen.getByText('Default')).toBeTruthy();
  });

  it('switches to the Graph view via the List | Graph toggle', () => {
    renderPage({
      configurations: [{ name: 'sales', label: 'Sales' }],
      profiles: [makeProfile({ configurations: ['sales'] })],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    // Graph legend replaces the card grid
    expect(screen.getByText('dashed = stopped')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(screen.queryByText('dashed = stopped')).toBeNull();
  });

  it('creates a new data profile and navigates to its detail view', () => {
    const { setView, setConfigurations, handleConfigurationSave } = renderPage();
    fireEvent.click(screen.getByText('+ New Data Configuration'));

    fireEvent.change(screen.getByPlaceholderText('Configuration name'), {
      target: { value: 'My Profile' },
    });
    fireEvent.change(screen.getByPlaceholderText('Display name'), {
      target: { value: 'My Profile' },
    });
    fireEvent.click(screen.getByText('Create'));

    expect(setConfigurations).toHaveBeenCalled();
    expect(handleConfigurationSave).toHaveBeenCalledWith({
      name: 'my-profile',
      label: 'My Profile',
    });
    expect(setView).toHaveBeenCalledWith({ page: 'config-detail', configName: 'my-profile' });
  });
});
