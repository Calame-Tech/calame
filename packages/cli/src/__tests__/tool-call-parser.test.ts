import { describe, it, expect } from 'vitest';
import { parseToolArguments, formatParseError } from '../tool-call-parser.js';

describe('parseToolArguments', () => {
  it('parses valid JSON using strict parser', () => {
    const result = parseToolArguments('{"table": "users"}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parser).toBe('strict');
      expect(result.args).toEqual({ table: 'users' });
    }
  });

  it('repairs JSON with trailing comma', () => {
    const result = parseToolArguments('{"table": "users",}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parser).toBe('json_repair');
      expect(result.args).toEqual({ table: 'users' });
    }
  });

  it('repairs JSON with single quotes', () => {
    const result = parseToolArguments("{'table': 'users'}");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parser).toBe('json_repair');
      expect(result.args).toEqual({ table: 'users' });
    }
  });

  it('repairs JSON with unquoted key', () => {
    const result = parseToolArguments('{table: "users"}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parser).toBe('json_repair');
      expect(result.args).toEqual({ table: 'users' });
    }
  });

  it('extracts JSON from markdown code block', () => {
    const result = parseToolArguments('```json\n{"table":"users"}\n```');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parser).toBe('markdown_extract');
      expect(result.args).toEqual({ table: 'users' });
    }
  });

  it('extracts JSON from Hermes tool_call format', () => {
    const result = parseToolArguments(
      '<tool_call>{"name":"query","arguments":{"table":"users"}}</tool_call>',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parser).toBe('hermes');
      expect(result.args).toEqual({ table: 'users' });
    }
  });

  it('extracts JSON from XML arguments tag', () => {
    const result = parseToolArguments('<arguments>{"table":"users"}</arguments>');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parser).toBe('xml');
      expect(result.args).toEqual({ table: 'users' });
    }
  });

  it('extracts JSON embedded in prose text', () => {
    const result = parseToolArguments('Let me call query: {"table": "users"}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parser).toBe('json_extract');
      expect(result.args).toEqual({ table: 'users' });
    }
  });

  it('parses empty string as empty args via strict', () => {
    const result = parseToolArguments('');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parser).toBe('strict');
      expect(result.args).toEqual({});
    }
  });

  it('returns ParseFailure for plain prose with no JSON', () => {
    const result = parseToolArguments('I will query the users table');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempted.length).toBeGreaterThan(0);
    }
  });

  it('fuzzy-matches param name to expected key in schema', () => {
    // "aggegation" (missing 'r') vs "aggregation": levenshtein=1, similarity=0.909
    const schema = {
      properties: {
        aggregation: { type: 'string' },
      },
    };
    const result = parseToolArguments('{"aggegation": "count"}', schema);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args).toHaveProperty('aggregation', 'count');
      expect(result.args).not.toHaveProperty('aggegation');
    }
  });

  it('coerces string to integer via schema type', () => {
    const schema = {
      properties: {
        limit: { type: 'integer' },
      },
    };
    const result = parseToolArguments('{"limit": "10"}', schema);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args).toEqual({ limit: 10 });
    }
  });

  it('coerces string "true" to boolean via schema type', () => {
    const schema = {
      properties: {
        active: { type: 'boolean' },
      },
    };
    const result = parseToolArguments('{"active": "true"}', schema);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args).toEqual({ active: true });
    }
  });
});

describe('formatParseError', () => {
  it('includes the tool name in the error message', () => {
    const message = formatParseError('bad input', 'query_tool', ['query_tool', 'other_tool']);
    expect(message).toContain('query_tool');
  });

  it('includes available tools in the error message', () => {
    const message = formatParseError('bad input', 'query_tool', ['query_tool', 'list_tables']);
    expect(message).toContain('list_tables');
  });

  it('truncates raw input longer than 200 characters', () => {
    const longRaw = 'x'.repeat(300);
    const message = formatParseError(longRaw, 'query_tool', ['query_tool']);
    const rawLine = message.split('\n').find((line) => line.startsWith('You wrote:'));
    expect(rawLine).toBeDefined();
    const rawValue = rawLine!.replace('You wrote: ', '');
    expect(rawValue.length).toBeLessThanOrEqual(203); // 200 chars + '...'
  });
});
