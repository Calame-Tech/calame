// Tenants (workspaces) page (Phase 3 #14). JSX moved verbatim from the
// `view.page === 'tenants'` branch of App.tsx.

import type { Dispatch, SetStateAction } from 'react';
import { PageHeader } from '../components/ui/index.js';
import TenantManagement from '../components/TenantManagement.js';
import type { View } from '../router/index.js';

interface TenantsPageProps {
  setView: Dispatch<SetStateAction<View>>;
}

export default function TenantsPage({ setView }: TenantsPageProps) {
  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumb={[
          { label: 'Dashboard', onClick: () => setView({ page: 'dashboard' }) },
          { label: 'Workspaces' },
        ]}
        title="Workspaces"
        description="List of all workspaces discovered on this instance. Workspaces are created implicitly the first time a write uses a given identifier."
      />
      <TenantManagement />
    </div>
  );
}
