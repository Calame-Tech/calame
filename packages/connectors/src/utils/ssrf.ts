// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Calame Tech inc.

/**
 * SSRF guards shared across connectors.
 *
 * These helpers classify hosts/IPs as private, loopback, link-local, CGNAT,
 * benchmarking, or cloud-metadata ranges so outbound fetches can be blocked
 * before they reach internal infrastructure. They also provide
 * `assertResolvedHostSafe`, which resolves a hostname via DNS and rejects the
 * request if ANY resolved address falls in a blocked range — the core defense
 * against DNS-rebinding attacks where an allowlisted hostname maps to an
 * internal IP.
 */

import net from 'node:net';
import dns from 'node:dns/promises';

/**
 * Returns `true` when `ip` (a dotted-quad IPv4 string) is in a private,
 * loopback, link-local, CGNAT, benchmarking, or unspecified range.
 *
 * Blocked ranges:
 *   - 0.0.0.0/8           (unspecified / "this network")
 *   - 10.0.0.0/8          (RFC 1918 private)
 *   - 100.64.0.0/10       (CGNAT / shared address space)
 *   - 127.0.0.0/8         (loopback)
 *   - 169.254.0.0/16      (link-local, incl. 169.254.169.254 cloud metadata)
 *   - 172.16.0.0/12       (RFC 1918 private)
 *   - 192.168.0.0/16      (RFC 1918 private)
 *   - 198.18.0.0/15       (benchmarking)
 */
export function isPrivateIPv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [, a, b, c, d] = m.map(Number);
  if ([a, b, c, d].some((o) => o > 255)) return false;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

/**
 * Expand an IPv6 string (including `::` compression and embedded IPv4 tails
 * like `::ffff:127.0.0.1`) into its eight 16-bit groups. Returns null when the
 * string is not a well-formed IPv6 address.
 */
export function expandIPv6(ip: string): number[] | null {
  let v6 = ip;
  const v4 = ip.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [, prefix, a, b, c, d] = v4;
    if ([a, b, c, d].map(Number).some((o) => o > 255)) return null;
    const hi = ((Number(a) << 8) | Number(b)).toString(16);
    const lo = ((Number(c) << 8) | Number(d)).toString(16);
    v6 = `${prefix}${hi}:${lo}`;
  }
  const halves = v6.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = halves.length === 2 ? Array(Math.max(8 - head.length - tail.length, 0)).fill('0') : [];
  const parts = [...head, ...fill, ...tail];
  if (parts.length !== 8) return null;
  const groups = parts.map((g) => parseInt(g || '0', 16));
  if (groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

/**
 * Returns `true` when `ip` (an IPv6 string) is loopback (`::1`), unspecified
 * (`::`), an IPv4-mapped address pointing at a private IPv4, link-local
 * (`fe80::/10`), or unique-local (`fc00::/7`).
 */
export function isPrivateIPv6(ip: string): boolean {
  const g = expandIPv6(ip);
  if (!g) return false;
  if (g.every((x) => x === 0)) return true;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return isPrivateIPv4(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
  }
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  return false;
}

/**
 * Returns `true` when `host` is a name or IP that must never be reached by an
 * outbound connector fetch: localhost / `*.local` / `*.internal` names, or any
 * IPv4/IPv6 address in a private/loopback/link-local/metadata range.
 */
export function isPrivateOrLocalHost(host: string): boolean {
  const clean = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (clean === 'localhost' || clean.endsWith('.local') || clean.endsWith('.internal')) return true;
  const v = net.isIP(clean);
  if (v === 4) return isPrivateIPv4(clean);
  if (v === 6) return isPrivateIPv6(clean);
  return false;
}

/** Thrown by `assertResolvedHostSafe` when a host targets a blocked range. */
export class SsrfBlockedError extends Error {}

/**
 * Resolve `hostname` and throw `SsrfBlockedError` if it — or ANY address it
 * resolves to — is private/local. This is the anti-DNS-rebinding check: it
 * must be called immediately before each outbound fetch, after the static
 * allowlist check, so a hostname that passes the allowlist but resolves to an
 * internal IP is still blocked.
 */
export async function assertResolvedHostSafe(hostname: string): Promise<void> {
  if (isPrivateOrLocalHost(hostname)) throw new SsrfBlockedError('blocked');
  if (net.isIP(hostname)) return;
  let records: { address: string }[];
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    // DNS resolution failed — skip the rebinding check.
    // The static allowlist check (if any) still applies.
    return;
  }
  for (const r of records) if (isPrivateOrLocalHost(r.address)) throw new SsrfBlockedError('blocked');
}
