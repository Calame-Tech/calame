/**
 * Extract the public tunnel URL cloudflared's "quick tunnel" mode prints to
 * stdout/stderr once the tunnel is up, e.g.:
 *
 *   2024-01-01T12:00:00Z INF +--------------------------------------------------------------------------------------------+
 *   2024-01-01T12:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable): |
 *   2024-01-01T12:00:00Z INF |  https://random-words-1234.trycloudflare.com                                            |
 *   2024-01-01T12:00:00Z INF +--------------------------------------------------------------------------------------------+
 *
 * Kept as a pure string->string|null function (no process/stream knowledge)
 * so it can be unit tested directly against captured real-world output
 * samples, independent of `./manager.ts`'s child-process plumbing.
 */

// Quick tunnel hostnames are a few random dictionary words joined by hyphens,
// e.g. "random-words-1234" — the exact shape isn't documented/guaranteed by
// Cloudflare, so this matches broadly (letters, digits, hyphens) rather than
// pinning down a strict word count.
const TRYCLOUDFLARE_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;

/** Returns the first `https://*.trycloudflare.com` URL found in `text`, or `null`. */
export function extractTunnelUrl(text: string): string | null {
  const match = TRYCLOUDFLARE_URL_RE.exec(text);
  return match ? match[0] : null;
}
