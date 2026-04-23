/**
 * Parse a raw Cookie header string into a key/value record.
 * Handles undefined input gracefully and trims whitespace from both keys and values.
 */
export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const [key, ...rest] = pair.split('=');
    if (key) cookies[key.trim()] = rest.join('=').trim();
  }
  return cookies;
}
