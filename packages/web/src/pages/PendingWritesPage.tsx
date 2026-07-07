// Pending Writes page (Lot C — governance UX overhaul). Promotes the write
// approval queue out of the ServePanel "Pending" tab into a real top-level
// page, reachable from the sidebar's Govern section, the notification bell
// and the dashboard "pending approvals" tile.

import type { Dispatch, SetStateAction } from 'react';
import { PageHeader } from '../components/ui/index.js';
import PendingQueries from '../components/PendingQueries.js';
import type { View } from '../router/index.js';

interface PendingWritesPageProps {
  setView: Dispatch<SetStateAction<View>>;
  /** Called whenever the pending count changes, so the global sidebar badge
   * (owned by useAppData's poller) can be refreshed immediately instead of
   * waiting for its next 15s tick. */
  onCountChange?: () => void;
}

export default function PendingWritesPage({ setView, onCountChange }: PendingWritesPageProps) {
  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumb={[
          { label: 'Dashboard', onClick: () => setView({ page: 'dashboard' }) },
          { label: 'Pending Writes' },
        ]}
        title="Pending Writes"
        description="Write operations proposed by LLMs, awaiting human approval."
      />
      <PendingQueries onPendingCountChange={() => onCountChange?.()} />
    </div>
  );
}
