#!/usr/bin/env node
/**
 * Disposable fixtures for checking OAuth dynamic client registration by hand
 * (see docs/oauth.md, "Manual verification").
 *
 *   node scripts/oauth-clients-fixture.mjs register <baseUrl> <profile> <stateFile>
 *     Registers a client via POST /register, saves its client_id in <stateFile>
 *     and prints the browser links. Run it BEFORE restarting the instance.
 *
 *   node scripts/oauth-clients-fixture.mjs links <baseUrl> <profile> <stateFile>
 *     Prints the browser links again for the saved client (AFTER the restart).
 *
 *   node scripts/oauth-clients-fixture.mjs register-errors <baseUrl>
 *     Sends the invalid registrations and prints each RFC 7591 error.
 *
 * Only meant for a throwaway instance (temporary CALAME_DATA_DIR, free port).
 * It refuses ports 8101 and 8120. It never prints a code, token or password.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const REDIRECT_URI = 'http://127.0.0.1:33418/callback';
const FORBIDDEN_PORTS = new Set(['8101', '8120']);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`Invalid base URL: ${raw}`);
  }
  if (FORBIDDEN_PORTS.has(url.port)) fail(`Refusing port ${url.port}: use a throwaway instance.`);
  return url.origin;
}

async function register(baseUrl, body) {
  const res = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function authorizeUrl(baseUrl, profile, clientId, redirectUri) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(`${baseUrl}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', 'fixture');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('profile', profile);
  return url.toString();
}

function printLinks(baseUrl, profile, clientId) {
  console.log(`Registered client: ${clientId}\n`);
  console.log('1. Known client, registered redirect_uri (login form / redirect expected):');
  console.log(`   ${authorizeUrl(baseUrl, profile, clientId, REDIRECT_URI)}\n`);
  console.log('2. Known client, different redirect_uri ("redirect_uri does not match"):');
  console.log(`   ${authorizeUrl(baseUrl, profile, clientId, 'http://127.0.0.1:33418/other')}\n`);
  console.log('3. Unknown client_id ("Unknown client_id ... recreate the connector"):');
  console.log(
    `   ${authorizeUrl(baseUrl, profile, 'client_' + crypto.randomBytes(16).toString('hex'), REDIRECT_URI)}`,
  );
}

const INVALID_REGISTRATIONS = [
  ['missing redirect_uris', { client_name: 'fixture' }],
  ['empty redirect_uris', { redirect_uris: [] }],
  ['redirect_uris not an array', { redirect_uris: 'https://example.com/cb' }],
  ['non-string redirect URI', { redirect_uris: [42] }],
  ['relative URL', { redirect_uris: ['/callback'] }],
  ['forbidden scheme', { redirect_uris: ['javascript:alert(1)'] }],
  ['http outside loopback', { redirect_uris: ['http://example.com/cb'] }],
  ['look-alike loopback host', { redirect_uris: ['http://localhost.example.com/cb'] }],
  ['fragment', { redirect_uris: ['https://example.com/cb#x'] }],
  ['too many URIs', { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://e.com/${i}`) }],
  ['URI too long', { redirect_uris: [`https://example.com/${'a'.repeat(2048)}`] }],
  ['client_name not a string', { redirect_uris: [REDIRECT_URI], client_name: 1 }],
  ['client_name too long', { redirect_uris: [REDIRECT_URI], client_name: 'n'.repeat(201) }],
];

const [command, rawBaseUrl, profile, stateFile] = process.argv.slice(2);
if (!command || !rawBaseUrl) fail('Usage: see the header of scripts/oauth-clients-fixture.mjs');
const baseUrl = parseBaseUrl(rawBaseUrl);

if (command === 'register') {
  if (!profile || !stateFile) fail('register needs <profile> and <stateFile>.');
  const { status, json } = await register(baseUrl, {
    redirect_uris: [REDIRECT_URI],
    client_name: 'Calame OAuth fixture',
  });
  if (status !== 201 || !json?.client_id)
    fail(`Registration failed (${status}): ${JSON.stringify(json)}`);
  fs.writeFileSync(stateFile, JSON.stringify({ baseUrl, clientId: json.client_id }) + '\n');
  printLinks(baseUrl, profile, json.client_id);
} else if (command === 'links') {
  if (!profile || !stateFile) fail('links needs <profile> and <stateFile>.');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  printLinks(baseUrl, profile, saved.clientId);
} else if (command === 'register-errors') {
  for (const [label, body] of INVALID_REGISTRATIONS) {
    const { status, json } = await register(baseUrl, body);
    console.log(`${label}: ${status} ${json?.error} — ${json?.error_description}`);
  }
} else {
  fail(`Unknown command: ${command}`);
}
