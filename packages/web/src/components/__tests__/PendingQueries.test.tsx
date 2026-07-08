// PendingQueries component tests (Lot E — quick wins).
//
// Covers: (a) two-step confirmation before approving delete/update entries
// (insert stays a direct one-click approve), (b) the profileName link calling
// onNavigateToProfile, (c) the updated empty state copy for the pending tab.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PendingQueries from '../PendingQueries.js';
import type { PendingWriteQuery } from '../../types/schema.js';

function makeEntry(overrides: Partial<PendingWriteQuery> = {}): PendingWriteQuery {
  return {
    id: 'q1',
    tableName: 'orders',
    operation: 'insert',
    status: 'pending',
    description: 'Insert a row',
    sql: 'INSERT INTO orders ...',
    params: [],
    profileName: 'default',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function installFetch(entries: PendingWriteQuery[]) {
  const mock = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/write-queue/count')) {
      return jsonResponse({ success: true, pending: entries.length });
    }
    if (url.includes('/approve') || url.includes('/reject')) {
      return jsonResponse({ success: true });
    }
    if (url.includes('/api/write-queue')) {
      return jsonResponse({ success: true, entries, total: entries.length });
    }
    return jsonResponse({ success: true });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('PendingQueries', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the updated empty state copy for the pending tab', async () => {
    installFetch([]);
    render(<PendingQueries />);
    await waitFor(() => {
      expect(screen.getByText(/No pending writes\./)).toBeTruthy();
    });
    expect(screen.getByText('write', { selector: 'code' })).toBeTruthy();
  });

  it('approves an insert entry directly on the first click (no confirmation)', async () => {
    const entry = makeEntry({ operation: 'insert' });
    const fetchMock = installFetch([entry]);
    render(<PendingQueries />);
    await waitFor(() => expect(screen.getByText('Approve')).toBeTruthy());

    fireEvent.click(screen.getByText('Approve'));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/q1/approve'))).toBe(
        true,
      );
    });
  });

  it('requires a second confirming click before approving a delete entry', async () => {
    const entry = makeEntry({ operation: 'delete' });
    const fetchMock = installFetch([entry]);
    render(<PendingQueries />);
    await waitFor(() => expect(screen.getByText('Approve')).toBeTruthy());

    // First click arms the confirmation — no approve call yet.
    fireEvent.click(screen.getByText('Approve'));
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/q1/approve'))).toBe(
      false,
    );
    expect(screen.getByText('Confirm Approve')).toBeTruthy();

    // Second click actually approves.
    fireEvent.click(screen.getByText('Confirm Approve'));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/q1/approve'))).toBe(
        true,
      );
    });
  });

  it('requires a second confirming click before approving an update entry', async () => {
    const entry = makeEntry({ operation: 'update' });
    installFetch([entry]);
    render(<PendingQueries />);
    await waitFor(() => expect(screen.getByText('Approve')).toBeTruthy());

    fireEvent.click(screen.getByText('Approve'));
    expect(screen.getByText('Confirm Approve')).toBeTruthy();
  });

  it('calls onNavigateToProfile when the profile name link is clicked', async () => {
    const entry = makeEntry();
    installFetch([entry]);
    const onNavigateToProfile = vi.fn();
    render(<PendingQueries onNavigateToProfile={onNavigateToProfile} />);

    await waitFor(() => expect(screen.getByText('default')).toBeTruthy());
    fireEvent.click(screen.getByText('default'));
    expect(onNavigateToProfile).toHaveBeenCalledWith('default');
  });

  it('renders the profile name as plain text (no button) when onNavigateToProfile is not provided', async () => {
    const entry = makeEntry();
    installFetch([entry]);
    render(<PendingQueries />);

    await waitFor(() => expect(screen.getByText('default')).toBeTruthy());
    const el = screen.getByText('default');
    expect(el.tagName).not.toBe('BUTTON');
  });
});
