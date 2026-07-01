// Metrics page (Phase 3 #14). JSX moved verbatim from the
// `view.page === 'metrics'` branch of App.tsx.

import type { Dispatch, SetStateAction } from 'react';
import { PageHeader } from '../components/ui/index.js';
import MetricsDashboard from '../components/MetricsDashboard.js';
import type { View } from '../router/index.js';

interface MetricsPageProps {
  setView: Dispatch<SetStateAction<View>>;
}

export default function MetricsPage({ setView }: MetricsPageProps) {
  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumb={[
          { label: 'Dashboard', onClick: () => setView({ page: 'dashboard' }) },
          { label: 'Metrics' },
        ]}
        title="Metrics"
        description="Request volume, tool usage, and performance over time."
      />
      <MetricsDashboard />
    </div>
  );
}
