// Knowledge page (Phase 3 #14). JSX moved verbatim from the
// `view.page === 'knowledge'` branch of App.tsx — the legacy alias for the
// sources/knowledge tab.

import type { Dispatch, SetStateAction } from 'react';
import SourcesPageComponent from '../components/SourcesPage.js';
import type { DatabaseSchema, NamedConnection } from '../types/schema.js';
import type { View } from '../router/index.js';
import { useSession } from '../context/SessionContext.js';
import { KnowledgeBaseManager } from './lazy.js';

interface KnowledgePageProps {
  setView: Dispatch<SetStateAction<View>>;
  connections: NamedConnection[];
  setConnections: Dispatch<SetStateAction<NamedConnection[]>>;
  handleSchemaLoaded: (connectionName: string, schema: DatabaseSchema) => void;
}

export default function KnowledgePage({
  setView,
  connections,
  setConnections,
  handleSchemaLoaded,
}: KnowledgePageProps) {
  const { ragEnabled, ragDisabledReason } = useSession();

  return (
    <SourcesPageComponent
      currentTab="knowledge"
      onTabChange={(tab) => setView({ page: 'sources', tab })}
      connections={connections}
      onConnectionsChange={setConnections}
      onSchemaLoaded={handleSchemaLoaded}
      ragEnabled={ragEnabled}
      ragDisabledReason={ragDisabledReason}
      KnowledgeBaseManagerComponent={KnowledgeBaseManager}
    />
  );
}
