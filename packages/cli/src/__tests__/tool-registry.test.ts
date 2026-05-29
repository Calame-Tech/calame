import { describe, it, expect } from 'vitest';
import {
  categorizeToolName,
  buildCategorySelectionPrompt,
  filterToolsByCategory,
  parseCategoryChoice,
  isFrontierModel,
} from '../tool-registry.js';
import type { ToolDef } from '../chat-engine.js';

function makeTool(name: string): ToolDef {
  return { name, description: '', parameters: {}, handler: async () => '' };
}

const ALL_TOOLS: ToolDef[] = [
  makeTool('list_tables'),
  makeTool('describe'),
  makeTool('query'),
  makeTool('aggregate'),
  makeTool('join_aggregate'),
  makeTool('calc'),
  makeTool('write'),
];

describe('categorizeToolName', () => {
  it('maps known tools to correct category', () => {
    expect(categorizeToolName('list_tables')).toBe('explore');
    expect(categorizeToolName('describe')).toBe('explore');
    expect(categorizeToolName('query')).toBe('query');
    expect(categorizeToolName('aggregate')).toBe('query');
    expect(categorizeToolName('join_aggregate')).toBe('query');
    expect(categorizeToolName('calc')).toBe('compute');
    expect(categorizeToolName('write')).toBe('write');
  });

  it('applies prefix heuristics for unknown tool names', () => {
    expect(categorizeToolName('describe_users')).toBe('explore');
    expect(categorizeToolName('list_views')).toBe('explore');
    expect(categorizeToolName('write_orders')).toBe('write');
    expect(categorizeToolName('insert_record')).toBe('write');
    expect(categorizeToolName('delete_row')).toBe('write');
  });

  it('defaults to query for unrecognized tool names', () => {
    expect(categorizeToolName('unknown_tool')).toBe('query');
  });
});

describe('filterToolsByCategory', () => {
  it('returns only tools matching the given category', () => {
    const result = filterToolsByCategory(ALL_TOOLS, 'explore');
    expect(result.map((t) => t.name)).toEqual(['list_tables', 'describe']);
  });

  it('returns query tools', () => {
    const result = filterToolsByCategory(ALL_TOOLS, 'query');
    expect(result.map((t) => t.name)).toEqual(['query', 'aggregate', 'join_aggregate']);
  });

  it('returns compute tools', () => {
    const result = filterToolsByCategory(ALL_TOOLS, 'compute');
    expect(result.map((t) => t.name)).toEqual(['calc']);
  });

  it('returns write tools', () => {
    const result = filterToolsByCategory(ALL_TOOLS, 'write');
    expect(result.map((t) => t.name)).toEqual(['write']);
  });

  it('returns empty array when no tools match', () => {
    const result = filterToolsByCategory([makeTool('query')], 'compute');
    expect(result).toEqual([]);
  });
});

describe('parseCategoryChoice', () => {
  it('parses a valid CATEGORY: response', () => {
    expect(parseCategoryChoice('CATEGORY:query')).toBe('query');
    expect(parseCategoryChoice('CATEGORY:explore')).toBe('explore');
    expect(parseCategoryChoice('CATEGORY:compute')).toBe('compute');
    expect(parseCategoryChoice('CATEGORY:write')).toBe('write');
  });

  it('is case-insensitive', () => {
    expect(parseCategoryChoice('category:QUERY')).toBe('query');
    expect(parseCategoryChoice('CATEGORY:Query')).toBe('query');
  });

  it('extracts CATEGORY from a longer response', () => {
    expect(parseCategoryChoice('The user wants data. CATEGORY:query')).toBe('query');
  });

  it('returns null for unknown category names', () => {
    expect(parseCategoryChoice('CATEGORY:analytics')).toBeNull();
  });

  it('returns null when no CATEGORY: token present', () => {
    expect(parseCategoryChoice('I will use the query tool')).toBeNull();
    expect(parseCategoryChoice('')).toBeNull();
  });
});

describe('buildCategorySelectionPrompt', () => {
  it('contains tool names in the prompt', () => {
    const prompt = buildCategorySelectionPrompt(ALL_TOOLS);
    expect(prompt).toContain('list_tables');
    expect(prompt).toContain('calc');
    expect(prompt).toContain('CATEGORY:');
  });

  it('lists only categories that have at least one tool', () => {
    const tools = [makeTool('query')];
    const prompt = buildCategorySelectionPrompt(tools);
    expect(prompt).toContain('- query:');
    expect(prompt).not.toContain('- compute:');
    expect(prompt).not.toContain('- explore:');
  });
});

describe('isFrontierModel', () => {
  it('returns true for anthropic provider regardless of model', () => {
    expect(isFrontierModel('anthropic')).toBe(true);
    expect(isFrontierModel('anthropic', 'claude-sonnet-4')).toBe(true);
  });

  it('returns true for GPT models on openrouter/custom', () => {
    expect(isFrontierModel('openrouter', 'gpt-4o')).toBe(true);
    expect(isFrontierModel('custom', 'gpt-3.5-turbo')).toBe(true);
  });

  it('returns true for Claude models on openrouter', () => {
    expect(isFrontierModel('openrouter', 'anthropic/claude-sonnet-4')).toBe(true);
  });

  it('returns false for local models', () => {
    expect(isFrontierModel('custom', 'qwen2.5-7b-instruct')).toBe(false);
    expect(isFrontierModel('custom', 'deepseek-r1')).toBe(false);
    expect(isFrontierModel('custom', 'mistral-nemo')).toBe(false);
  });

  it('returns false when no model provided for non-anthropic provider', () => {
    expect(isFrontierModel('custom')).toBe(false);
    expect(isFrontierModel('openrouter')).toBe(false);
  });
});
