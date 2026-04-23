/**
 * Redact credentials from a string before returning it to a client or writing
 * it to a log that may be surfaced in the UI. Database drivers (pg, mysql2)
 * occasionally echo the full DSN — including username and password — in their
 * error messages. Always pass driver error messages through this helper before
 * exposing them.
 *
 * Two formats are handled:
 *   1. URL-style DSN: `scheme://user:pass@host:port/db` → `scheme://***@host:port/db`
 *   2. libpq key=value DSN: `password=secret` → `password=***`
 */
export function redactSecrets(input: string): string {
	return input
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
		.replace(/\b(password|pwd|passwd)\s*=\s*('[^']*'|"[^"]*"|\S+)/gi, '$1=***');
}
