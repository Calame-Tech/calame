import type { ToolDef } from './chat-engine.js';

export type ToolCategory = 'explore' | 'query' | 'compute' | 'write';

const ALL_CATEGORIES: ToolCategory[] = ['explore', 'query', 'compute', 'write'];

const CATEGORY_DESCRIPTIONS: Record<ToolCategory, string> = {
  explore: 'Discover tables, columns, schema structure and sample values',
  query: 'Retrieve rows, compute aggregates and analytics across tables',
  compute: 'Arithmetic calculations (sum, avg, min, max, count, product)',
  write: 'Insert, update or delete records (requires approval)',
};

const TOOL_CATEGORY_MAP: Record<string, ToolCategory> = {
  list_tables: 'explore',
  describe: 'explore',
  query: 'query',
  aggregate: 'query',
  join_aggregate: 'query',
  calc: 'compute',
  write: 'write',
};

export function categorizeToolName(name: string): ToolCategory {
  if (name in TOOL_CATEGORY_MAP) return TOOL_CATEGORY_MAP[name];
  if (/^describe|^list/.test(name)) return 'explore';
  if (/^write|^insert|^update|^delete/.test(name)) return 'write';
  if (/^calc/.test(name)) return 'compute';
  return 'query';
}

export function buildCategorySelectionPrompt(tools: ToolDef[]): string {
  const byCategory = new Map<ToolCategory, string[]>();
  for (const tool of tools) {
    const cat = categorizeToolName(tool.name);
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(tool.name);
  }

  const lines = ['Choose the most relevant tool category for the user request.\n'];
  for (const cat of ALL_CATEGORIES) {
    const toolNames = byCategory.get(cat);
    if (!toolNames) continue;
    lines.push(`- ${cat}: ${CATEGORY_DESCRIPTIONS[cat]} (${toolNames.join(', ')})`);
  }
  lines.push('\nReply with exactly one line: CATEGORY:<name>');
  lines.push('Valid values: ' + [...byCategory.keys()].join(', '));
  return lines.join('\n');
}

export function filterToolsByCategory(tools: ToolDef[], category: ToolCategory): ToolDef[] {
  return tools.filter((t) => categorizeToolName(t.name) === category);
}

export function parseCategoryChoice(response: string): ToolCategory | null {
  const match = response.match(/CATEGORY:(\w+)/i);
  if (!match) return null;
  const cat = match[1].toLowerCase();
  if ((ALL_CATEGORIES as string[]).includes(cat)) return cat as ToolCategory;
  return null;
}

export function isFrontierModel(provider: string, model?: string): boolean {
  if (provider === 'anthropic') return true;
  if (!model) return false;
  return /gpt-4|gpt-3\.5|claude/i.test(model);
}
