// Shared lazy-loaded EE components (Phase 3 #14). Lazy declarations used by a
// single page live in that page's file; this module holds the ones shared by
// several pages so the same `lazy()` instance (and its loaded chunk) is reused.

import { lazy } from 'react';

/**
 * Lazy-loaded KnowledgeBaseManager from the ee package. The import is deferred
 * at runtime so the main bundle stays lean and the RAG chunk is only loaded when
 * the user explicitly navigates to the "Bases de connaissance" view.
 */
export const KnowledgeBaseManager = lazy(() =>
  import('@calame-ee/rag-core/web')
    .then((m) => ({ default: m.KnowledgeBaseManager }))
    .catch(() => ({
      default: function RagUnavailable() {
        return (
          <div className="p-6 text-sm text-gray-400 text-center">
            Les fonctionnalités RAG ne sont pas disponibles sur cette instance.
          </div>
        );
      },
    })),
);
