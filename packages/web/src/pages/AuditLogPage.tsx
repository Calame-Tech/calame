// Audit Log page (Lot C — governance UX overhaul). Promotes the audit trail
// out of the per-profile ServePanel detail view into a real top-level page,
// with every profile available in the filter dropdown.

import type { Dispatch, SetStateAction } from 'react';
import { PageHeader } from '../components/ui/index.js';
import AuditLogViewer from '../components/AuditLogViewer.js';
import type { Profile } from '../types/schema.js';
import type { View } from '../router/index.js';

interface AuditLogPageProps {
  setView: Dispatch<SetStateAction<View>>;
  profiles: Profile[];
}

export default function AuditLogPage({ setView, profiles }: AuditLogPageProps) {
  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumb={[
          { label: 'Dashboard', onClick: () => setView({ page: 'dashboard' }) },
          { label: 'Audit Log' },
        ]}
        title="Audit Log"
        description="Every tool call served by your MCP servers."
      />
      <AuditLogViewer profiles={profiles} />
    </div>
  );
}
