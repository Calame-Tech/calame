import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCachedToolSchemas,
  setCachedToolSchemas,
  invalidateToolSchemaCache,
  TOOL_SCHEMA_TTL_MS,
  type ToolSchema,
} from '../tool-schema-cache.js';

const sampleSchemas: ToolSchema[] = [
  { name: 'query_orders', description: 'Query orders', inputSchema: { type: 'object' } },
];

describe('tool-schema-cache', () => {
  beforeEach(() => {
    invalidateToolSchemaCache();
  });

  it('getCachedToolSchemas returns undefined for an unknown key', () => {
    expect(getCachedToolSchemas('unknown-key')).toBeUndefined();
  });

  it('returns the cached schemas within the TTL and undefined at the expiry boundary', () => {
    setCachedToolSchemas('key-ttl', sampleSchemas, 1000);
    expect(getCachedToolSchemas('key-ttl', 1000 + TOOL_SCHEMA_TTL_MS - 1)).toEqual(sampleSchemas);
    expect(getCachedToolSchemas('key-ttl', 1000 + TOOL_SCHEMA_TTL_MS)).toBeUndefined();
  });

  it('invalidateToolSchemaCache(key) removes one entry', () => {
    setCachedToolSchemas('key-a', sampleSchemas, 1000);
    setCachedToolSchemas('key-b', sampleSchemas, 1000);
    invalidateToolSchemaCache('key-a');
    expect(getCachedToolSchemas('key-a', 1000)).toBeUndefined();
    expect(getCachedToolSchemas('key-b', 1000)).toEqual(sampleSchemas);
  });

  it('invalidateToolSchemaCache() clears all entries', () => {
    setCachedToolSchemas('key-a', sampleSchemas, 1000);
    setCachedToolSchemas('key-b', sampleSchemas, 1000);
    invalidateToolSchemaCache();
    expect(getCachedToolSchemas('key-a', 1000)).toBeUndefined();
    expect(getCachedToolSchemas('key-b', 1000)).toBeUndefined();
  });
});
