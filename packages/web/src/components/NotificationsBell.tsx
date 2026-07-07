import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '../lib/api.js';
import type { View } from '../router/index.js';

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  createdAt: string;
  readAt?: string;
}

interface NotificationsBellProps {
  /** Navigates the app to a full `View` — used to jump straight to the
   * pending-writes page when a write_queue.pending notification is clicked. */
  onNavigate?: (view: View) => void;
}

const POLL_INTERVAL_MS = 30_000;
const BELL_ICON_PATH =
  'M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0';

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  return `${diffDay}d ago`;
}

/**
 * Sidebar notification bell — polls `/api/notifications?unread=1&limit=10`
 * every 30s for the unread badge count, and lets the user open a small
 * dropdown with the 10 most recent unread notifications.
 */
export default function NotificationsBell({ onNavigate }: NotificationsBellProps) {
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [open, setOpen] = useState(false);
  // Panel anchor, computed from the bell's screen position when opening. The
  // panel is rendered in a body portal with `position: fixed` — an absolute
  // dropdown inside the sidebar gets clipped by the <aside>'s overflow-y-auto.
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const fetchUnread = useCallback(async () => {
    try {
      const res = await apiFetch('/api/notifications?unread=1&limit=10', {
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success !== false) {
        setNotifications(data.notifications ?? []);
        setUnreadCount(data.unreadCount ?? 0);
      }
    } catch {
      // Silently fail — the bell just won't update this cycle.
    }
  }, []);

  useEffect(() => {
    fetchUnread();
    const interval = setInterval(fetchUnread, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchUnread]);

  // Close the dropdown on outside click (the panel lives in a body portal,
  // so "outside" means outside BOTH the bell container and the panel) and on
  // window resize (the fixed anchor would drift).
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleResize = () => setOpen(false);
    document.addEventListener('mousedown', handleClick);
    window.addEventListener('resize', handleResize);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      window.removeEventListener('resize', handleResize);
    };
  }, [open]);

  const handleToggle = () => {
    setOpen((prev) => {
      if (!prev && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        // Open to the right of the bell, bottom-aligned with it; clamp so a
        // short viewport never pushes the panel off-screen at the top.
        setAnchor({
          left: rect.right + 8,
          bottom: Math.max(8, window.innerHeight - rect.bottom),
        });
      }
      return !prev;
    });
  };

  const handleMarkAllRead = async () => {
    try {
      await apiFetch('/api/notifications/read-all', {
        method: 'POST',
        credentials: 'include',
      });
      await fetchUnread();
    } catch {
      // Silently fail
    }
  };

  const handleItemClick = (n: NotificationItem) => {
    // Fire-and-forget — the dropdown closes immediately, no need to await.
    apiFetch(`/api/notifications/${n.id}/read`, {
      method: 'POST',
      credentials: 'include',
    }).catch(() => {});
    if (n.type === 'write_queue.pending') {
      onNavigate?.({ page: 'pending-writes' });
    }
    setOpen(false);
    fetchUnread();
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={handleToggle}
        aria-label="Notifications"
        aria-expanded={open}
        className="relative flex-shrink-0 p-1.5 rounded-lg text-gray-400 hover:text-gray-100 hover:bg-white/5 transition-colors"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="w-5 h-5"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d={BELL_ICON_PATH} />
        </svg>
        {unreadCount > 0 && (
          <span
            aria-label={`${unreadCount} unread notifications`}
            className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[1rem] h-4 px-1 rounded-full bg-red-500 text-[10px] font-semibold text-white"
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open &&
        anchor &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: 'fixed', left: anchor.left, bottom: anchor.bottom }}
            className="w-72 max-h-96 overflow-y-auto rounded-lg border border-gray-800 bg-gray-900 shadow-xl z-50"
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
              <span className="text-sm font-medium text-gray-200">Notifications</span>
              <button
                type="button"
                onClick={handleMarkAllRead}
                className="text-xs text-os-400 hover:text-os-300"
              >
                Tout marquer lu
              </button>
            </div>
            {notifications.length === 0 ? (
              <div className="p-4 text-sm text-gray-500 text-center">No new notifications.</div>
            ) : (
              <ul>
                {notifications.map((n) => (
                  <li key={n.id} className="border-b border-gray-800/60 last:border-b-0">
                    <button
                      type="button"
                      onClick={() => handleItemClick(n)}
                      className="w-full text-left px-3 py-2 hover:bg-white/5 transition-colors"
                    >
                      <p className="text-sm text-gray-200">{n.title}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{n.body}</p>
                      <p className="text-[10px] text-gray-600 mt-1">
                        {formatRelativeTime(n.createdAt)}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
