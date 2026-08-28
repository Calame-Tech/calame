// Tenants (workspaces) page (Phase 3 #14). JSX moved verbatim from the
// `view.page === 'tenants'` branch of App.tsx.

import type { Dispatch, SetStateAction } from 'react';
import { useTranslations } from 'use-intl/react';
import { PageHeader } from '../components/ui/index.js';
import TenantManagement from '../components/TenantManagement.js';
import type { View } from '../router/index.js';

interface TenantsPageProps {
  setView: Dispatch<SetStateAction<View>>;
}

export default function TenantsPage({ setView }: TenantsPageProps) {
  const t = useTranslations('tenants.page');
  const tCommon = useTranslations('common');
  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumb={[
          { label: tCommon('dashboard'), onClick: () => setView({ page: 'dashboard' }) },
          { label: t('title') },
        ]}
        title={t('title')}
        description={t('description')}
      />
      <TenantManagement />
    </div>
  );
}
