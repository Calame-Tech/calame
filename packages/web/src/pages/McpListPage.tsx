// MCP servers list page (Phase 3 #14). JSX moved verbatim from the
// `view.page === 'mcp-list'` branch of App.tsx. The `handleSelectProfile`
// navigation callback moved here with it (it only needs `setView`).

import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslations } from 'use-intl/react';
import { PageHeader } from '../components/ui/index.js';
import ServePanel from '../components/ServePanel.js';
import type { Config, Configuration, Profile, ServeStatus } from '../types/schema.js';
import type { View } from '../router/index.js';

interface McpListPageProps {
  /** Data configuration to preselect in the creation form (guided configuration → server step). */
  prefillConfiguration?: string;
  configurations?: Configuration[];
  setView: Dispatch<SetStateAction<View>>;
  configWithProfileOptions: Config;
  selectedTables: Record<string, Set<string>>;
  profiles: Profile[];
  serveStatus: ServeStatus;
  fetchServeStatus: () => Promise<void>;
  handleProfileCreate: (name: string, label: string, configurations?: string[]) => void;
  handleProfileDelete: (index: number) => Promise<void>;
  setPreviewProfile: Dispatch<SetStateAction<string | null>>;
}

export default function McpListPage({
  prefillConfiguration,
  configurations = [],
  setView,
  configWithProfileOptions,
  selectedTables,
  profiles,
  serveStatus,
  fetchServeStatus,
  handleProfileCreate,
  handleProfileDelete,
  setPreviewProfile,
}: McpListPageProps) {
  const t = useTranslations('mcpList');
  const tCommon = useTranslations('common');

  // Navigate to MCP detail from ServePanel
  const handleSelectProfile = useCallback((profileName: string) => {
    setView({ page: 'mcp-detail', profileName });
  }, []);

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
      <div className="mt-4">
        <ServePanel
          config={configWithProfileOptions}
          selectedTables={selectedTables}
          profiles={profiles}
          serveStatus={serveStatus}
          onServeAction={fetchServeStatus}
          onSelectProfile={handleSelectProfile}
          prefillConfigurationLabel={
            prefillConfiguration
              ? (configurations.find((c) => c.name === prefillConfiguration)?.label ??
                prefillConfiguration)
              : undefined
          }
          onCreateProfile={(name, label, withPrefill) => {
            handleProfileCreate(
              name,
              label,
              withPrefill && prefillConfiguration ? [prefillConfiguration] : undefined,
            );
            setView({ page: 'mcp-detail', profileName: name });
          }}
          onDeleteProfile={handleProfileDelete}
          onPreviewProfile={(name) => setPreviewProfile(name)}
          onOpenAiSettings={() => setView({ page: 'settings', initialTab: 'ai' })}
        />
      </div>
    </div>
  );
}
