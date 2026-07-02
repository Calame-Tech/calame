// MCP servers list page (Phase 3 #14). JSX moved verbatim from the
// `view.page === 'mcp-list'` branch of App.tsx. The `handleSelectProfile`
// navigation callback moved here with it (it only needs `setView`).

import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { PageHeader } from '../components/ui/index.js';
import ServePanel from '../components/ServePanel.js';
import type { Config, Profile, ServeStatus } from '../types/schema.js';
import type { View } from '../router/index.js';

interface McpListPageProps {
  setView: Dispatch<SetStateAction<View>>;
  configWithProfileOptions: Config;
  selectedTables: Record<string, Set<string>>;
  profiles: Profile[];
  serveStatus: ServeStatus;
  fetchServeStatus: () => Promise<void>;
  handleProfileCreate: (name: string, label: string) => void;
  handleProfileDelete: (index: number) => Promise<void>;
  setPreviewProfile: Dispatch<SetStateAction<string | null>>;
}

export default function McpListPage({
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
  // Navigate to MCP detail from ServePanel
  const handleSelectProfile = useCallback((profileName: string) => {
    setView({ page: 'mcp-detail', profileName });
  }, []);

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumb={[
          { label: 'Dashboard', onClick: () => setView({ page: 'dashboard' }) },
          { label: 'MCP Servers' },
        ]}
        title="MCP Servers"
        description="Manage your MCP server profiles. Start, stop, and configure access for each profile."
      />
      <div className="mt-4">
        <ServePanel
          config={configWithProfileOptions}
          selectedTables={selectedTables}
          profiles={profiles}
          serveStatus={serveStatus}
          onServeAction={fetchServeStatus}
          onSelectProfile={handleSelectProfile}
          onBack={() => setView({ page: 'dashboard' })}
          onCreateProfile={(name, label) => {
            handleProfileCreate(name, label);
            setView({ page: 'mcp-detail', profileName: name });
          }}
          onDeleteProfile={handleProfileDelete}
          onPreviewProfile={(name) => setPreviewProfile(name)}
        />
      </div>
    </div>
  );
}
