import { describe, it, expect } from 'vitest';
import { isPrivateIPv4, isPrivateIPv6, isPrivateOrLocalHost, SsrfBlockedError } from './ssrf.js';

// ---------------------------------------------------------------------------
// isPrivateIPv4 — table-driven
// ---------------------------------------------------------------------------

describe('isPrivateIPv4', () => {
  const blocked: string[] = [
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '127.255.255.255',
    '169.254.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.255.255',
    '198.18.0.1',
    '198.19.255.255',
  ];

  const allowed: string[] = [
    '1.1.1.1',
    '8.8.8.8',
    '13.107.42.14',
    '34.120.0.1',
    '52.0.0.1',
    '54.239.28.85',
    '76.76.21.21',
    '99.86.0.1',
    '203.0.113.1', // TEST-NET-3 (not blocked by spec but not private)
    '198.51.100.1', // TEST-NET-2 (not blocked)
    '255.255.255.255',
  ];

  it.each(blocked)('returns true for blocked IP %s', (ip) => {
    expect(isPrivateIPv4(ip)).toBe(true);
  });

  it.each(allowed)('returns false for allowed IP %s', (ip) => {
    expect(isPrivateIPv4(ip)).toBe(false);
  });

  it('returns false for non-IP strings', () => {
    expect(isPrivateIPv4('not-an-ip')).toBe(false);
    expect(isPrivateIPv4('999.999.999.999')).toBe(false);
    expect(isPrivateIPv4('1.2.3')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPrivateIPv6 — table-driven
// ---------------------------------------------------------------------------

describe('isPrivateIPv6', () => {
  const blocked: string[] = [
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:192.168.1.1',
    '::ffff:169.254.169.254',
    'fe80::1',
    'fe80::abcd:1',
    'fc00::1',
    'fd00::1',
    'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  ];

  const allowed: string[] = [
    '2001:db8::1',
    '2606:4700::1',
    '2607:f8b0:4004:800::200e',
    '2804:802:1234:5678::1',
  ];

  it.each(blocked)('returns true for blocked IPv6 %s', (ip) => {
    expect(isPrivateIPv6(ip)).toBe(true);
  });

  it.each(allowed)('returns false for allowed IPv6 %s', (ip) => {
    expect(isPrivateIPv6(ip)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPrivateOrLocalHost — combined
// ---------------------------------------------------------------------------

describe('isPrivateOrLocalHost', () => {
  it('blocks private IPs', () => {
    expect(isPrivateOrLocalHost('127.0.0.1')).toBe(true);
    expect(isPrivateOrLocalHost('10.0.0.1')).toBe(true);
    expect(isPrivateOrLocalHost('192.168.1.1')).toBe(true);
    expect(isPrivateOrLocalHost('169.254.169.254')).toBe(true);
    expect(isPrivateOrLocalHost('::1')).toBe(true);
    expect(isPrivateOrLocalHost('fe80::1')).toBe(true);
    expect(isPrivateOrLocalHost('fc00::1')).toBe(true);
  });

  it('blocks hostnames', () => {
    expect(isPrivateOrLocalHost('localhost')).toBe(true);
    expect(isPrivateOrLocalHost('myhost.local')).toBe(true);
    expect(isPrivateOrLocalHost('db.internal')).toBe(true);
    expect(isPrivateOrLocalHost('LOCALHOST')).toBe(true);
  });

  it('allows public IPs', () => {
    expect(isPrivateOrLocalHost('8.8.8.8')).toBe(false);
    expect(isPrivateOrLocalHost('1.1.1.1')).toBe(false);
    expect(isPrivateOrLocalHost('2001:db8::1')).toBe(false);
  });

  it('allows public hostnames', () => {
    expect(isPrivateOrLocalHost('api.example.com')).toBe(false);
    expect(isPrivateOrLocalHost('cdn.cloudflare.com')).toBe(false);
  });

  it('handles IPv6 bracket notation', () => {
    expect(isPrivateOrLocalHost('[::1]')).toBe(true);
    expect(isPrivateOrLocalHost('[fe80::1]')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SsrfBlockedError
// ---------------------------------------------------------------------------

describe('SsrfBlockedError', () => {
  it('extends Error', () => {
    const err = new SsrfBlockedError('blocked');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('blocked');
  });
});
