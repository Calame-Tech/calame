// ServePanel component tests (Lot E — quick wins + dead-code cleanup).
//
// Covers the dashboard/list view only — the dead "detail view" branch
// (reachable only when `onSelectProfile` was not provided) was removed since
// the component's sole call site (McpListPage) always supplies it.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ServePanel from '../ServePanel.js';
import type { Config, Profile, ServeStatus } from '../../types/schema.js';

const config: Config = {
  serverName: 'calame',
  transport: 'streamable-http',
  clientTarget: 'claude-desktop',
  outputDir: '',
};

const serveStatus: ServeStatus = {
  active: false,
  port: 4567,
  profiles: [],
  profileStatuses: {},
  totalRequests: 0,
};

const profiles: Profile[] = [{ name: 'default', label: 'Default' }];

function renderPanel(overrides: Partial<React.ComponentProps<typeof ServePanel>> = {}) {
  const onSelectProfile = vi.fn();
  const onCreateProfile = vi.fn();
  render(
    <ServePanel
      config={config}
      selectedTables={{}}
      profiles={profiles}
      serveStatus={serveStatus}
      onSelectProfile={onSelectProfile}
      onCreateProfile={onCreateProfile}
      {...overrides}
    />,
  );
  return { onSelectProfile, onCreateProfile };
}

describe('ServePanel', () => {
  it('renders the profile list and navigates via onSelectProfile on card click', () => {
    const { onSelectProfile } = renderPanel();
    expect(screen.getByText('Default')).toBeTruthy();
    fireEvent.click(screen.getByText('Default'));
    expect(onSelectProfile).toHaveBeenCalledWith('default');
  });

  it('creates a new profile with a unique name', () => {
    const { onCreateProfile } = renderPanel();
    fireEvent.click(screen.getByText('New MCP Server'));
    fireEvent.change(screen.getByPlaceholderText('MCP name...'), {
      target: { value: 'My New Server' },
    });
    fireEvent.click(screen.getByText('Create'));
    expect(onCreateProfile).toHaveBeenCalledWith('my-new-server', 'My New Server');
  });

  it('blocks creation and shows an inline error when the slugified name already exists', () => {
    const { onCreateProfile } = renderPanel({
      profiles: [{ name: 'default', label: 'Default' }],
    });
    fireEvent.click(screen.getByText('New MCP Server'));
    fireEvent.change(screen.getByPlaceholderText('MCP name...'), {
      target: { value: 'Default' },
    });
    fireEvent.click(screen.getByText('Create'));
    expect(onCreateProfile).not.toHaveBeenCalled();
    expect(screen.getByText('A profile named "default" already exists.')).toBeTruthy();
  });
});
