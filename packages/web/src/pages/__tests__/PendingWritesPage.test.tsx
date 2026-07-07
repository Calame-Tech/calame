// PendingWritesPage component tests (Lot C — governance UX overhaul).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PendingWritesPage from '../PendingWritesPage.js';
import { installFetchMock, flushEffects } from './testUtils.js';

describe('PendingWritesPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the page header and the pending queries list', async () => {
    installFetchMock();
    render(<PendingWritesPage setView={vi.fn()} />);
    expect(screen.getAllByText('Pending Writes').length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByText('Write operations proposed by LLMs, awaiting human approval.'),
    ).toBeTruthy();
    await flushEffects();
  });

  it('navigates back to the dashboard via the breadcrumb', async () => {
    installFetchMock();
    const setView = vi.fn();
    render(<PendingWritesPage setView={setView} />);
    fireEvent.click(screen.getByText('Dashboard'));
    expect(setView).toHaveBeenCalledWith({ page: 'dashboard' });
    await flushEffects();
  });

  it('calls onCountChange when the pending count is fetched', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/write-queue/count')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, pending: 2 }),
          text: async () => '{}',
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, entries: [], total: 0 }),
        text: async () => '{}',
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const onCountChange = vi.fn();
    render(<PendingWritesPage setView={vi.fn()} onCountChange={onCountChange} />);
    await flushEffects();

    expect(onCountChange).toHaveBeenCalled();
  });
});
