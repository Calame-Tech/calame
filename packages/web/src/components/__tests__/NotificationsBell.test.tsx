// NotificationsBell component tests.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import NotificationsBell from '../NotificationsBell.js';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function installFetchMock(notifications: unknown[], unreadCount: number) {
  const mock = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/notifications/read-all')) {
      return jsonResponse({ success: true });
    }
    if (/\/api\/notifications\/[^/]+\/read/.test(url)) {
      return jsonResponse({ success: true });
    }
    if (url.includes('/api/notifications')) {
      return jsonResponse({ success: true, notifications, unreadCount });
    }
    return jsonResponse({ success: true });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('NotificationsBell', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the unread badge with the count from the API', async () => {
    installFetchMock(
      [
        {
          id: 'n1',
          type: 'write_queue.pending',
          title: 'Write pending',
          body: 'INSERT on users',
          createdAt: new Date().toISOString(),
        },
      ],
      3,
    );

    render(<NotificationsBell />);
    await flushEffects();

    expect(await screen.findByText('3')).toBeInTheDocument();
  });

  it('shows no badge when there are no unread notifications', async () => {
    installFetchMock([], 0);

    render(<NotificationsBell />);
    await flushEffects();

    expect(screen.queryByLabelText(/unread notifications/)).not.toBeInTheDocument();
  });

  it('opens the dropdown on click and lists notifications, and marks all read', async () => {
    const fetchMock = installFetchMock(
      [
        {
          id: 'n1',
          type: 'write_queue.pending',
          title: 'Write pending',
          body: 'INSERT on users',
          createdAt: new Date().toISOString(),
        },
      ],
      1,
    );

    render(<NotificationsBell />);
    await flushEffects();

    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));

    expect(await screen.findByText('Write pending')).toBeInTheDocument();
    expect(screen.getByText('INSERT on users')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/notifications/read-all'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('clicking a write_queue.pending item navigates to pending-writes and marks it read', async () => {
    const fetchMock = installFetchMock(
      [
        {
          id: 'n1',
          type: 'write_queue.pending',
          title: 'Write pending',
          body: 'INSERT on users',
          createdAt: new Date().toISOString(),
        },
      ],
      1,
    );
    const onNavigate = vi.fn();

    render(<NotificationsBell onNavigate={onNavigate} />);
    await flushEffects();

    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    fireEvent.click(await screen.findByText('Write pending'));

    expect(onNavigate).toHaveBeenCalledWith({ page: 'pending-writes' });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/notifications/n1/read'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
    // The dropdown closes after the click.
    expect(screen.queryByText('Write pending')).not.toBeInTheDocument();
  });

  it('clicking a non-write-queue item marks it read without navigating', async () => {
    const fetchMock = installFetchMock(
      [
        {
          id: 'n2',
          type: 'other.event',
          title: 'Something happened',
          body: 'Details',
          createdAt: new Date().toISOString(),
        },
      ],
      1,
    );
    const onNavigate = vi.fn();

    render(<NotificationsBell onNavigate={onNavigate} />);
    await flushEffects();

    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    fireEvent.click(await screen.findByText('Something happened'));

    expect(onNavigate).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/notifications/n2/read'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });
});
