import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateExternalToken } from '../external-auth.js';
import type { ExternalAuthConfig } from '../external-auth.js';

// ---------------------------------------------------------------------------
// getNestedValue is tested indirectly via validateExternalToken
// ---------------------------------------------------------------------------

describe('validateExternalToken', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns { valid: false } when fetch throws (network error)', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network failure'));

    const config: ExternalAuthConfig = { validationUrl: 'https://auth.example.com/validate' };
    const result = await validateExternalToken('my-token', config);

    expect(result).toEqual({ valid: false });
  });

  it('returns { valid: false } when the external API responds with 401', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 401 }));

    const config: ExternalAuthConfig = { validationUrl: 'https://auth.example.com/validate' };
    const result = await validateExternalToken('bad-token', config);

    expect(result).toEqual({ valid: false });
  });

  it('returns { valid: false } when the external API responds with 403', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 403 }));

    const config: ExternalAuthConfig = { validationUrl: 'https://auth.example.com/validate' };
    const result = await validateExternalToken('bad-token', config);

    expect(result).toEqual({ valid: false });
  });

  it('returns { valid: true, email, name } on 200 OK with flat fields', async () => {
    const body = JSON.stringify({ email: 'alice@example.com', name: 'Alice' });
    vi.mocked(fetch).mockResolvedValue(new Response(body, { status: 200 }));

    const config: ExternalAuthConfig = { validationUrl: 'https://auth.example.com/validate' };
    const result = await validateExternalToken('good-token', config);

    expect(result.valid).toBe(true);
    expect(result.email).toBe('alice@example.com');
    expect(result.name).toBe('Alice');
  });

  it('sends the token using the default Authorization: Bearer header', async () => {
    const body = JSON.stringify({ email: 'alice@example.com', name: 'Alice' });
    vi.mocked(fetch).mockResolvedValue(new Response(body, { status: 200 }));

    const config: ExternalAuthConfig = { validationUrl: 'https://auth.example.com/validate' };
    await validateExternalToken('tok123', config);

    expect(fetch).toHaveBeenCalledWith(
      'https://auth.example.com/validate',
      expect.objectContaining({
        headers: { Authorization: 'Bearer tok123' },
      }),
    );
  });

  it('uses a custom header name when headerName is set', async () => {
    const body = JSON.stringify({ email: 'bob@example.com', name: 'Bob' });
    vi.mocked(fetch).mockResolvedValue(new Response(body, { status: 200 }));

    const config: ExternalAuthConfig = {
      validationUrl: 'https://auth.example.com/validate',
      headerName: 'X-API-Key',
      headerTemplate: '{token}',
    };
    await validateExternalToken('mykey', config);

    expect(fetch).toHaveBeenCalledWith(
      'https://auth.example.com/validate',
      expect.objectContaining({
        headers: { 'X-API-Key': 'mykey' },
      }),
    );
  });

  it('extracts email and name from nested paths using dot notation', async () => {
    const body = JSON.stringify({
      user: { profile: { email: 'nested@example.com', displayName: 'Nested User' } },
    });
    vi.mocked(fetch).mockResolvedValue(new Response(body, { status: 200 }));

    const config: ExternalAuthConfig = {
      validationUrl: 'https://auth.example.com/validate',
      emailField: 'user.profile.email',
      nameField: 'user.profile.displayName',
    };
    const result = await validateExternalToken('good-token', config);

    expect(result.valid).toBe(true);
    expect(result.email).toBe('nested@example.com');
    expect(result.name).toBe('Nested User');
  });

  it('returns undefined email/name when the fields are missing from the response', async () => {
    const body = JSON.stringify({ status: 'ok' });
    vi.mocked(fetch).mockResolvedValue(new Response(body, { status: 200 }));

    const config: ExternalAuthConfig = { validationUrl: 'https://auth.example.com/validate' };
    const result = await validateExternalToken('tok', config);

    expect(result.valid).toBe(true);
    expect(result.email).toBeUndefined();
    expect(result.name).toBeUndefined();
  });

  it('returns { valid: false } when fetch times out (AbortError)', async () => {
    vi.mocked(fetch).mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));

    const config: ExternalAuthConfig = { validationUrl: 'https://auth.example.com/validate' };
    const result = await validateExternalToken('tok', config);

    expect(result).toEqual({ valid: false });
  });

  it('includes rawResponse on successful validation', async () => {
    const payload = { email: 'user@corp.com', name: 'Corp User', roles: ['viewer'] };
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));

    const config: ExternalAuthConfig = { validationUrl: 'https://auth.example.com/validate' };
    const result = await validateExternalToken('tok', config);

    expect(result.valid).toBe(true);
    expect(result.rawResponse).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// Nested value helper — tested via validateExternalToken above, but also
// covered here with explicit dot-notation path cases.
// ---------------------------------------------------------------------------

describe('nested field extraction (via validateExternalToken)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('handles a path where an intermediate key is missing', async () => {
    const body = JSON.stringify({ other: 'field' });
    vi.mocked(fetch).mockResolvedValue(new Response(body, { status: 200 }));

    const config: ExternalAuthConfig = {
      validationUrl: 'https://auth.example.com/validate',
      emailField: 'missing.deep.email',
    };
    const result = await validateExternalToken('tok', config);

    expect(result.valid).toBe(true);
    expect(result.email).toBeUndefined();
  });

  it('returns undefined when a nested value is not a string', async () => {
    const body = JSON.stringify({ email: 42 });
    vi.mocked(fetch).mockResolvedValue(new Response(body, { status: 200 }));

    const config: ExternalAuthConfig = { validationUrl: 'https://auth.example.com/validate' };
    const result = await validateExternalToken('tok', config);

    expect(result.valid).toBe(true);
    expect(result.email).toBeUndefined();
  });
});
