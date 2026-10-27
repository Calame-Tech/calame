# OAuth 2.1 for MCP clients

Calame includes a minimal OAuth 2.1 authorization server, so that MCP clients
such as ChatGPT, Claude (claude.ai / Desktop), Cursor or VS Code can connect
to a profile without a pasted token. The implementation is in
`packages/cli/src/routes/oauth.ts`; registered clients are stored by
`packages/cli/src/oauth-clients.ts`.

## Flow

1. The client discovers the server through `/.well-known/oauth-protected-resource/mcp/<profile>`
   and `/.well-known/oauth-authorization-server`.
2. It registers itself with `POST /register` (Dynamic Client Registration,
   RFC 7591) and receives a public `client_id` (no client secret,
   `token_endpoint_auth_method: none`).
3. It opens `GET /authorize?profile=<profile>&client_id=…&redirect_uri=…&code_challenge=…`
   in the browser. What happens next depends on the profile's auth mode:
   `open` redirects back immediately, `calame` shows the email + password
   form (`POST /authorize`), `sso` and `oauth` redirect to the identity
   provider and come back on `/authorize/sso-callback` or
   `/authorize/oauth-callback`, `token` and `external` show a token form.
4. Calame redirects to the `redirect_uri` with a one-time authorization code.
5. The client exchanges the code at `POST /token` with its PKCE verifier
   (S256 only, mandatory) and gets the access token used on `/mcp/<profile>`.

Every step checks that the `client_id` is registered in the request's tenant
and that the `redirect_uri` is exactly one of its registered URIs. Errors are
answered as JSON and are **never redirected** to an unvalidated URI.

## Registered clients are persisted

Since the fix for clients lost on restart (0.8.6 → next release), registered
clients live in the SQLite table `oauth_clients` of `calame.db` (migration
v19): `client_id`, `tenant_id`, `redirect_uris` (JSON array), `client_name`,
`created_at` and `last_used_at` (nullable). The table is the source of truth:
every `/authorize`, `/token` and callback request reads it, so a client is
usable immediately after registration, and still after a restart, an update
or a re-creation of the container on the same data directory.

- **Tenant scope.** A client is only found under the tenant it was registered
  in (`getTenantId`, `default` unless the `X-Tenant-Id` header is set). The
  same `client_id` never resolves from another tenant.
- **`last_used_at`** is set only when an authorization code issued to the
  client is successfully redeemed at `POST /token` (PKCE and `redirect_uri`
  checks passed). Registration, `/authorize` hits and any failed attempt
  (unknown client, different `redirect_uri`, bad password, bad or expired
  code, wrong verifier) leave it untouched.

### What stays in memory

Authorization codes (valid **5 minutes**, single use) and pending SSO / OAuth
round-trips (valid **10 minutes**) are kept in memory only. They are lost on
restart: a user who was in the middle of a login simply starts the
authorization again from the client. Issued access tokens are not affected.

### Connectors registered before this fix

Clients registered by a version that kept them in memory (0.8.6 and earlier)
were lost at their last restart and cannot be recovered. Such a connector
fails with the "Unknown client_id" message below: **remove and recreate the
connector** in ChatGPT / Claude / the MCP client (or reconnect it if the
client offers to register again). Once re-registered, it survives restarts.

## Error messages

| Situation | Response (`400`, JSON) |
|---|---|
| `client_id` never registered on this server / tenant, or lost before persistence | `invalid_request` — "Unknown client_id: this OAuth client is not registered on this server (it may have been registered before a server restart or update). Reconnect, or remove and recreate, the connector in your MCP client to register it again." |
| Known client, `redirect_uri` not one of its registered URIs | `invalid_request` — "redirect_uri does not match registered client." |
| `client_id` missing | `invalid_request` — "client_id is required." |

In `calame` mode, `GET /authorize` rejects an unknown client (or a different
`redirect_uri`) **before** showing the login form, so nobody types a password
that cannot work. The server log records the cause (`unknown client_id
(connector must reconnect or be recreated)` or `redirect_uri differs from the
URIs registered for this client`) with the public `client_id`, the tenant and
the origin of the `redirect_uri` only — never its query string, a code, a
token, a password or a secret.

## Registration limits (`POST /register`)

The endpoint is public, so it is bounded. Checks run in this order and
nothing is written unless all of them pass.

1. **Rate limit**: 20 registrations per client IP and per minute (shared
   rate limiter). Over it: `429 too_many_requests` with `Retry-After`.
2. **Metadata** (`400`, RFC 7591 errors):
   - `redirect_uris` is required: a non-empty array of at most **10**
     strings, each at most **2048** characters → otherwise `invalid_redirect_uri`.
   - Each URI must be an absolute `https://` URL with a host. Plain `http://`
     is accepted only for the exact hosts `localhost`, `127.0.0.1` and
     `[::1]` (any port). Look-alike spellings (`127.1`, `0x7f000001`,
     `LOCALHOST`, `localhost.`, `localhost.example.com`, expanded IPv6…),
     other schemes, fragments (`#`), user credentials, whitespace, control
     characters and backslashes are refused → `invalid_redirect_uri`.
   - `client_name` is optional: a string of at most **200** characters
     without control characters → otherwise `invalid_client_metadata`.
   - The JSON body must be an object of at most **32 KiB** → otherwise
     `invalid_client_metadata`.
3. **Number of clients**: at most **200** registered clients per tenant.
   On each registration, in a single SQLite transaction (so concurrent
   registrations cannot exceed the cap):
   - never-used clients (`last_used_at` empty) older than **30 days** are
     deleted;
   - if the tenant is still full, the oldest never-used clients older than
     **1 hour** are deleted to make room;
   - a client that was used at least once is **never** purged, nor is a
     client registered less than an hour ago (it may be completing its first
     login). If nothing can be purged, the registration is refused with
     `503 temporarily_unavailable`; existing clients are kept.

Each refusal and each purge is logged with its reason and the tenant, without
the request body.

## Manual verification

Use a throwaway instance — a temporary data directory and a free port, never
an existing instance or its data (and never ports 8101 / 8120, which the
fixture script refuses).

```bash
export CALAME_DATA_DIR="$(mktemp -d)"
pnpm --filter calame exec tsx src/index.ts --port 4599   # terminal 1
```

In the browser, open `http://127.0.0.1:4599`, create the administrator, a
source and a profile named `demo` in auth mode `calame` (or `open`), and
start it. Then, in terminal 2:

```bash
# Invalid registrations: prints each RFC 7591 error.
node scripts/oauth-clients-fixture.mjs register-errors http://127.0.0.1:4599

# Register a client and print three /authorize links.
node scripts/oauth-clients-fixture.mjs register http://127.0.0.1:4599 demo "$CALAME_DATA_DIR/fixture.json"
```

Stop and restart the server (terminal 1, same `CALAME_DATA_DIR`), then print
the links again for the client registered before the restart:

```bash
node scripts/oauth-clients-fixture.mjs links http://127.0.0.1:4599 demo "$CALAME_DATA_DIR/fixture.json"
```

Open each link in the browser:

1. **Known client** — `calame`: the login form is shown, and logging in
   redirects to `http://127.0.0.1:33418/callback?code=…&state=fixture` (the
   page itself fails to load, which is expected; the address bar shows the
   redirect). `open`: the same redirect happens immediately.
2. **Different redirect_uri** — JSON `redirect_uri does not match registered client.`
3. **Unknown client_id** — JSON "Unknown client_id … recreate the connector",
   before any login form.

The registered row can be inspected with
`sqlite3 "$CALAME_DATA_DIR/calame.db" "SELECT * FROM oauth_clients"`.
Delete the temporary directory afterwards.

Automated coverage, in `packages/cli/src/routes/`:
`oauth.persistence.test.ts` (immediate recognition, restart on the same
database then authorize + token, `last_used_at`, tenant isolation, migration
v19 on an existing database), `oauth.client-errors.test.ts` (unknown client vs
different URI, early refusal in `calame` mode, logs without secrets, every
auth mode and `/token` with a persisted client) and `oauth.register.test.ts`
(validation, limits, cap, purge, concurrency).
