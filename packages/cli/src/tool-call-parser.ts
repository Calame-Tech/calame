export type ParserName = 'strict' | 'markdown_extract' | 'hermes' | 'xml' | 'json_repair' | 'json_extract';

export interface ParseSuccess {
  ok: true;
  args: Record<string, unknown>;
  parser: ParserName;
}

export interface ParseFailure {
  ok: false;
  error: string;
  attempted: ParserName[];
}

export type ParseResult = ParseSuccess | ParseFailure;

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

function normalizeArgs(
  args: Record<string, unknown>,
  schema?: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema) return args;

  const properties = (schema['properties'] as Record<string, Record<string, unknown>> | undefined) ?? {};
  const expectedKeys = Object.keys(properties);
  if (expectedKeys.length === 0) return args;

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (expectedKeys.includes(key)) {
      result[key] = value;
      continue;
    }

    let bestMatch: string | null = null;
    let bestScore = 0;
    for (const expected of expectedKeys) {
      const score = similarity(key, expected);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = expected;
      }
    }

    const targetKey = bestMatch !== null && bestScore >= 0.7 ? bestMatch : key;
    result[targetKey] = value;
  }

  for (const [expectedKey, propSchema] of Object.entries(properties)) {
    if (!(expectedKey in result)) continue;
    const propType = (propSchema as Record<string, unknown>)['type'];
    const raw = result[expectedKey];

    if ((propType === 'number' || propType === 'integer') && typeof raw === 'string') {
      const coerced = Number(raw);
      if (!Number.isNaN(coerced)) result[expectedKey] = coerced;
    } else if (propType === 'boolean' && typeof raw === 'string') {
      const lower = raw.toLowerCase();
      if (['true', 'yes', '1'].includes(lower)) result[expectedKey] = true;
      else if (['false', 'no', '0'].includes(lower)) result[expectedKey] = false;
    } else if (propType === 'array' && typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) result[expectedKey] = parsed;
      } catch {
        // leave as-is
      }
    }
  }

  return result;
}

function repairJson(raw: string): string {
  let s = raw.trim();

  s = s.replace(/,\s*([}\]])/g, '$1');
  s = s.replace(/'/g, '"');
  s = s.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)(\s*:)/g, '$1"$2"$3');

  return s;
}

function extractFirstObject(text: string): string | null {
  let start = -1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function tryStrictParse(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function parseToolArguments(raw: string, schema?: Record<string, unknown>): ParseResult {
  const attempted: ParserName[] = [];
  const normalized = (args: Record<string, unknown>, parser: ParserName): ParseSuccess => ({
    ok: true,
    args: normalizeArgs(args, schema),
    parser,
  });

  // strict
  attempted.push('strict');
  const strictInput = raw.trim() === '' ? '{}' : raw;
  const strictResult = tryStrictParse(strictInput);
  if (strictResult !== null) return normalized(strictResult, 'strict');

  // markdown_extract
  attempted.push('markdown_extract');
  const markdownMatch = raw.match(/```(?:json|yaml)?\s*\n?([\s\S]*?)\n?```/);
  if (markdownMatch) {
    const inner = markdownMatch[1].trim();
    const parsed = tryStrictParse(inner);
    if (parsed !== null) return normalized(parsed, 'markdown_extract');
  }

  // hermes
  attempted.push('hermes');
  const hermesMatch = raw.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
  if (hermesMatch) {
    const inner = hermesMatch[1].trim();
    const parsed = tryStrictParse(inner);
    if (parsed !== null) {
      const args =
        (parsed['arguments'] as Record<string, unknown> | undefined) ??
        (parsed['parameters'] as Record<string, unknown> | undefined) ??
        parsed;
      return normalized(args, 'hermes');
    }
  }

  // xml
  attempted.push('xml');
  const xmlMatch = raw.match(/<arguments>([\s\S]*?)<\/arguments>/);
  if (xmlMatch) {
    const inner = xmlMatch[1].trim();
    const parsed = tryStrictParse(inner);
    if (parsed !== null) return normalized(parsed, 'xml');
  }

  // json_repair
  attempted.push('json_repair');
  const repaired = repairJson(raw);
  const repairedResult = tryStrictParse(repaired);
  if (repairedResult !== null) return normalized(repairedResult, 'json_repair');

  // json_extract
  attempted.push('json_extract');
  const extracted = extractFirstObject(raw);
  if (extracted !== null) {
    const strictExtracted = tryStrictParse(extracted);
    if (strictExtracted !== null) return normalized(strictExtracted, 'json_extract');
    const repairedExtracted = tryStrictParse(repairJson(extracted));
    if (repairedExtracted !== null) return normalized(repairedExtracted, 'json_extract');
  }

  return {
    ok: false,
    error: `Failed to parse tool arguments after trying all strategies.`,
    attempted,
  };
}

export function formatParseError(
  raw: string,
  toolName: string,
  availableTools: string[],
  schema?: Record<string, unknown>,
): string {
  const properties =
    schema && typeof schema['properties'] === 'object' && schema['properties'] !== null
      ? (schema['properties'] as Record<string, unknown>)
      : {};

  const exampleEntries = Object.keys(properties)
    .map((k) => `"${k}": "..."`)
    .join(', ');
  const expectedFormat = `{${exampleEntries ? ' ' + exampleEntries + ' ' : ''}}`;

  const truncated = raw.length > 200 ? raw.slice(0, 200) + '...' : raw;
  const toolsList = availableTools.join(', ');

  return [
    `Tool call parse failed for tool "${toolName}".`,
    `Expected JSON format: ${expectedFormat}`,
    `You wrote: ${truncated}`,
    `Available tools: ${toolsList}`,
    `Please respond with valid JSON arguments only, no prose.`,
  ].join('\n');
}
