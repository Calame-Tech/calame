import { describe, it, expect } from 'vitest';
import { mcpPortFromOrigin } from './mcp-url.js';

describe('mcpPortFromOrigin', () => {
  it('reads the explicit port', () => {
    expect(mcpPortFromOrigin('http://127.0.0.1:4567')).toBe(4567);
  });

  it('falls back to the scheme default port', () => {
    expect(mcpPortFromOrigin('https://calame.example.com')).toBe(443);
    expect(mcpPortFromOrigin('http://calame.example.com')).toBe(80);
  });

  it('returns 0 (unknown) for a missing or malformed origin', () => {
    expect(mcpPortFromOrigin(null)).toBe(0);
    expect(mcpPortFromOrigin(undefined)).toBe(0);
    expect(mcpPortFromOrigin('not a url')).toBe(0);
  });
});
