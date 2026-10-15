// Sources page (Phase 3 #14). JSX moved verbatim from the
// `view.page === 'sources'` branch of App.tsx. The inner component is the
// existing components/SourcesPage (aliased to avoid the name clash).

import type { Dispatch, SetStateAction } from 'react';
import SourcesPageComponent from '../components/SourcesPage.js';
import type { DatabaseSchema, NamedConnection } from '../types/schema.js';
import type { View } from '../router/index.js';
import { useSession } from '../context/SessionContext.js';
import { KnowledgeBaseManager } from './lazy.js';

interface SourcesPageProps {
  view: Extract<View, { page: 'sources' }>;
  setView: Dispatch<SetStateAction<View>>;
  connections: NamedConnection[];
  setConnections: Dispatch<SetStateAction<NamedConnection[]>>;
  handleSchemaLoaded: (connectionName: string, schema: DatabaseSchema) => void;
}

export default function SourcesPage({
  view,
  setView,
  connections,
  setConnections,
  handleSchemaLoaded,
}: SourcesPageProps) {
  const { ragEnabled, ragDisabledReason } = useSession();

  return (
    <SourcesPageComponent
      currentTab={view.tab ?? 'databases'}
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
