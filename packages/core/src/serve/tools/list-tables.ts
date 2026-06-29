import { snakeCaseToLabel } from '../response-formatter.js';
import { executeWithAudit } from '../middleware/audit.js';
import type { ToolContext, AccessibleTable } from '../tool-context.js';

// ---------------------------------------------------------------------------
// Generic `list_tables` — names + per-table tool list. Lighter than the
// catalogue (which is in the description of `aggregate`/`query`); kept for
// backward compatibility and quick discovery.
// ---------------------------------------------------------------------------

export function registerListTablesGeneric(ctx: ToolContext, accessible: AccessibleTable[]): void {
  const {
    server,
    executeQuery,
    dialect,
    onAuditLog,
    profileName,
    responseMode,
    wrapResponse,
    toolName,
  } = ctx;
  const friendly = responseMode === 'friendly';

  const tableList = accessible.map((at) => {
    const tools = ['describe', 'aggregate', 'query', 'write'].filter((t) =>
      at.enabledTools.includes(t),
    );
    return {
      name: friendly ? snakeCaseToLabel(at.table.name) : at.table.name,
      columns: at.visibleColumns.map((c) => (friendly ? snakeCaseToLabel(c.name) : c.name)),
      enabled: tools,
    };
  });

  // Tool descriptions are always English. They form the contract the LLM
  // reads on tools/list and English is both shorter (~30% fewer tokens than
  // French here) and the default training language for tool calling. The
  // `friendly` response mode still drives user-facing output (column labels,
  // payload shape).
  const desc =
    'List all tables you have access to. Call this first if you are unsure which tables exist. Detailed schema (column types, enums, FK relations) is available via describe or in the aggregate/query tool descriptions.';

  server.tool(toolName('list_tables'), desc, {}, async () =>
    executeWithAudit(
      {
        executeQuery,
        dialect,
        onAuditLog,
        profileName,
        toolName: toolName('list_tables'),
        toolArgs: {},
      },
      async () => {
        const text = wrapResponse(JSON.stringify(tableList, null, 2));
        return {
          content: [{ type: 'text' as const, text }],
          resultSummary: `${tableList.length} tables`,
          resultData: text,
        };
      },
    ),
  );
}
