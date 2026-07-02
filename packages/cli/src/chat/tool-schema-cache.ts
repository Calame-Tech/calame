// ---------------------------------------------------------------------------
// Tool schema cache (TTL 30s) — avoids redundant listTools() calls per turn
// ---------------------------------------------------------------------------

export interface ToolSchema {
  name: string;
  description: string | undefined;
  inputSchema: Record<string, unknown>;
}

interface ToolSchemaEntry {
  schemas: ToolSchema[];
  ts: number;
}
const toolSchemaCache = new Map<string, ToolSchemaEntry>();
export const TOOL_SCHEMA_TTL_MS = 30_000;

export function getCachedToolSchemas(
  cacheKey: string,
  now: number = Date.now(),
): ToolSchema[] | undefined {
  const cached = toolSchemaCache.get(cacheKey);
  if (cached && now - cached.ts < TOOL_SCHEMA_TTL_MS) {
    return cached.schemas;
  }
  return undefined;
}

export function setCachedToolSchemas(
  cacheKey: string,
  schemas: ToolSchema[],
  now: number = Date.now(),
): void {
  toolSchemaCache.set(cacheKey, { schemas, ts: now });
}

export function invalidateToolSchemaCache(profileName?: string): void {
  if (profileName) {
    toolSchemaCache.delete(profileName);
  } else {
    toolSchemaCache.clear();
  }
}
