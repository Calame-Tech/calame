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
        description="Liste de tous les workspaces (tenants) découverts sur cette instance. Les workspaces sont créés implicitement lors de la première écriture avec un identifiant donné."
      />
      <TenantManagement />
    </div>
  );
}
