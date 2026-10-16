import { describe, it, expect } from 'vitest';
import { buildMcpUrl, resolveMcpOrigin } from '../mcp-url.js';

function req(protocol: string, host: string | undefined) {
  return { protocol, get: () => host };
}

describe('resolveMcpOrigin', () => {
  it('keeps protocol, host and port from the request', () => {
    expect(resolveMcpOrigin(req('http', '127.0.0.1:4567'))).toBe('http://127.0.0.1:4567');
    expect(resolveMcpOrigin(req('https', 'calame.example.com'))).toBe('https://calame.example.com');
  });

  it('composes with buildMcpUrl into the full MCP endpoint', () => {
    const origin = resolveMcpOrigin(req('https', 'calame.example.com:8443'))!;
    expect(buildMcpUrl(origin, 'prod', 'acme')).toBe(
      'https://calame.example.com:8443/mcp/acme/prod',
    );
  });

  it('falls back to the configured listening port without a Host header', () => {
    expect(resolveMcpOrigin(req('http', undefined), 4567)).toBe('http://localhost:4567');
  });

  it('returns null rather than inventing an address when nothing is known', () => {
    expect(resolveMcpOrigin(req('http', undefined))).toBeNull();
    expect(resolveMcpOrigin(req('http', undefined), 0)).toBeNull();
  });
});
