// Connections page (Phase 3 #14). JSX moved verbatim from the
// `view.page === 'connections'` branch of App.tsx — the legacy alias for the
// sources/databases tab.

import type { Dispatch, SetStateAction } from 'react';
import SourcesPageComponent from '../components/SourcesPage.js';
import type { DatabaseSchema, NamedConnection } from '../types/schema.js';
import type { View } from '../router/index.js';
import { useSession } from '../context/SessionContext.js';
import { KnowledgeBaseManager } from './lazy.js';

interface ConnectionsPageProps {
  view: Extract<View, { page: 'connections' }>;
  setView: Dispatch<SetStateAction<View>>;
  connections: NamedConnection[];
  setConnections: Dispatch<SetStateAction<NamedConnection[]>>;
  handleSchemaLoaded: (connectionName: string, schema: DatabaseSchema) => void;
}

export default function ConnectionsPage({
  view,
  setView,
  connections,
  setConnections,
  handleSchemaLoaded,
}: ConnectionsPageProps) {
  const { ragEnabled, ragDisabledReason } = useSession();

  return (
    <SourcesPageComponent
      currentTab="databases"
      onTabChange={(tab) => setView({ page: 'sources', tab, backTo: view.backTo })}
      connections={connections}
      onConnectionsChange={setConnections}
      onSchemaLoaded={handleSchemaLoaded}
      editConnectionName={view.editConnectionName}
      ragEnabled={ragEnabled}
      ragDisabledReason={ragDisabledReason}
      KnowledgeBaseManagerComponent={KnowledgeBaseManager}
    />
  );
}
