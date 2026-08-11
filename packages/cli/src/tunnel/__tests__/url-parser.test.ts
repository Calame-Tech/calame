import { describe, it, expect } from 'vitest';
import { extractTunnelUrl } from '../url-parser.js';

describe('extractTunnelUrl', () => {
  it('extracts the URL from a realistic cloudflared quick-tunnel banner', () => {
    const output = [
      '2024-01-01T12:00:00Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account,',
      '2024-01-01T12:00:00Z INF is a quick way to experiment and try it out.',
      '2024-01-01T12:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
      '2024-01-01T12:00:00Z INF +--------------------------------------------------------------------------------------------+',
      '2024-01-01T12:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable): |',
      '2024-01-01T12:00:00Z INF |  https://random-words-1234.trycloudflare.com                                            |',
      '2024-01-01T12:00:00Z INF +--------------------------------------------------------------------------------------------+',
    ].join('\n');

    expect(extractTunnelUrl(output)).toBe('https://random-words-1234.trycloudflare.com');
  });

  it('extracts the URL when it appears alone on a single stdout chunk', () => {
    expect(extractTunnelUrl('https://tiny-fox-42.trycloudflare.com')).toBe(
      'https://tiny-fox-42.trycloudflare.com',
    );
  });

  it('returns null when no trycloudflare URL is present', () => {
    const output = [
      '2024-01-01T12:00:00Z INF Starting tunnel tunnel_id=abc-123',
      '2024-01-01T12:00:00Z INF Connection established',
    ].join('\n');
    expect(extractTunnelUrl(output)).toBeNull();
  });

  it('is case-insensitive on the scheme/host', () => {
    expect(extractTunnelUrl('HTTPS://Random-Words.TRYCLOUDFLARE.COM')).toBe(
      'HTTPS://Random-Words.TRYCLOUDFLARE.COM',
    );
  });

  it('does not match a bare hostname with no https scheme', () => {
    expect(extractTunnelUrl('random-words-1234.trycloudflare.com')).toBeNull();
  });

  it('does not match a look-alike domain', () => {
    expect(extractTunnelUrl('https://trycloudflare.com.evil.example/')).toBeNull();
  });

  it('ignores an --autoupdate-check log line that mentions cloudflared.com but not trycloudflare', () => {
    expect(extractTunnelUrl('2024-01-01T12:00:00Z INF Version 2026.7.3 (Checksum abc)')).toBeNull();
  });
});
