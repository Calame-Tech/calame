/**
 * External token validation module.
 *
 * Used when a ServeProfile has authMode === 'external'.
 * Calame calls a company-provided URL with the user's token and trusts the
 * response to determine identity.
 */

export interface ExternalAuthConfig {
  validationUrl: string;
  /** Default: 'Authorization' */
  headerName?: string;
  /** Default: 'Bearer {token}' */
  headerTemplate?: string;
  /** JSON path to the email field in the response. Default: 'email' */
  emailField?: string;
  /** JSON path to the display name field in the response. Default: 'name' */
  nameField?: string;
}

export interface ExternalAuthResult {
  valid: boolean;
  email?: string;
  name?: string;
  rawResponse?: Record<string, unknown>;
}

/**
 * Validate a token against an external API.
 * Sends the token to the validation URL and parses the response.
 *
 * Returns { valid: false } on any network error, timeout, or non-2xx response.
 */
export async function validateExternalToken(
  token: string,
  config: ExternalAuthConfig,
): Promise<ExternalAuthResult> {
  // Validate URL scheme to prevent SSRF (only allow http/https)
  try {
    const parsedUrl = new URL(config.validationUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return { valid: false };
    }
  } catch {
    return { valid: false };
  }

  const headerName = config.headerName ?? 'Authorization';
  const headerTemplate = config.headerTemplate ?? 'Bearer {token}';
  const headerValue = headerTemplate.replace('{token}', token);

  try {
    const res = await fetch(config.validationUrl, {
      method: 'GET',
      headers: { [headerName]: headerValue },
      signal: AbortSignal.timeout(10000), // 10s timeout
    });

    if (!res.ok) {
      return { valid: false };
    }

    const data = (await res.json()) as Record<string, unknown>;

    const emailField = config.emailField ?? 'email';
    const nameField = config.nameField ?? 'name';

    // Support nested fields with dot notation: "user.email"
    const email = getNestedValue(data, emailField);
    const name = getNestedValue(data, nameField);

    return {
      valid: true,
      email: typeof email === 'string' ? email : undefined,
      name: typeof name === 'string' ? name : undefined,
      rawResponse: data,
    };
  } catch {
    return { valid: false };
  }
}

/** Get a nested value from an object using dot notation: "user.profile.email" */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}
