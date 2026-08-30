// Metrics page (Phase 3 #14). JSX moved verbatim from the
// `view.page === 'metrics'` branch of App.tsx.

import type { Dispatch, SetStateAction } from 'react';
import { useTranslations } from 'use-intl/react';
import { PageHeader } from '../components/ui/index.js';
import MetricsDashboard from '../components/MetricsDashboard.js';
import type { View } from '../router/index.js';

interface MetricsPageProps {
  setView: Dispatch<SetStateAction<View>>;
}

export default function MetricsPage({ setView }: MetricsPageProps) {
  const t = useTranslations('metrics');
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
      <MetricsDashboard />
    </div>
  );
}
