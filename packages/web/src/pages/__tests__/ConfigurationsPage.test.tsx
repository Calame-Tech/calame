// ConfigurationsPage component tests (Phase 3 #16).

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ConfigurationsPage from '../ConfigurationsPage.js';
import type { Configuration } from '../../types/schema.js';

function renderPage({
  configurations = [] as Configuration[],
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
    />,
  );
  return { setView, setConfigurations, handleConfigurationSave, handleConfigurationDelete };
}

describe('ConfigurationsPage', () => {
  it('renders an empty state when there are no data profiles', () => {
    renderPage();
    expect(screen.getAllByText('Data Profiles').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('No data profiles')).toBeTruthy();
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

  it('creates a new data profile and navigates to its detail view', () => {
    const { setView, setConfigurations, handleConfigurationSave } = renderPage();
    fireEvent.click(screen.getByText('+ New Data Profile'));

    fireEvent.change(screen.getByPlaceholderText('Profile name'), {
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
