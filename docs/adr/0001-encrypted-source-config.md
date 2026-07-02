# ADR 0001 — Source configurations are encrypted at rest, keyed by the host

**Status:** Accepted (documents a decision implemented since the RAG integration; ADR added 2026-07-02, refactor plan #20)

## Context

RAG document sources (Google Drive, SharePoint, Notion, S3, HTTP, local folders…)
require credentials to reach the upstream system: OAuth service-account keys, API
tokens, connection secrets. These live inside each source's configuration object,
which must be persisted so sources survive restarts and background sync jobs can
run unattended.

Storing those configurations in plaintext inside `calame.db` (SQLite) would leak
every connected system's credentials to anyone who obtains a copy of the database
file — backups, misconfigured volumes, support bundles.

A second constraint is the dual-license architecture: the RAG feature lives in
BUSL-licensed `ee/` packages, while the host CLI is Apache-2.0. The EE packages
are optional at runtime (lazy-loaded, 501 degradation when absent), so key
management cannot live inside them.

## Decision

1. **Configurations are encrypted at rest.** The `rag_sources.config_encrypted`
   column stores the connector configuration as an **AES-256-GCM** blob
   (`iv:tag:ciphertext`, see `packages/cli/src/crypto.ts`). GCM gives
   confidentiality *and* integrity — a tampered blob fails authentication
   instead of decrypting to garbage.

2. **The host owns the key; EE code receives capabilities.** The Apache-side CLI
   derives a 32-byte key once at startup (`deriveKeyFromEnv()`):
   - `CALAME_ENCRYPTION_KEY` set → key = SHA-256 of its UTF-8 bytes (stable).
   - Unset in production → **hard failure at startup** (operator must set it).
   - Unset outside production → deterministic dev key + loud warning, so local
     setups and tests need no configuration.

   The RAG runtime (`packages/cli/src/rag-runtime.ts`) closes over that key and
   hands the EE packages `encryptConfig`/`decryptConfig` **functions** (plus the
   raw key for row-level storage helpers). EE code never reads the environment
   and never derives keys — it can only encrypt/decrypt what the host allows.

3. **Decrypted configurations stay in memory.** Plaintext configs exist only in
   the process while serving a request or running a sync job; they are never
   written back to disk, logged, or returned by any API (`/api/rag/sources`
   responses expose metadata, never the config).

## Consequences

- Reading `calame.db` alone does not yield credentials; an attacker needs the
  database **and** `CALAME_ENCRYPTION_KEY`.
- Losing the key means losing access to every stored source configuration —
  operators must treat the key like the database's password and back it up
  alongside their secrets manager. There is currently **no key-rotation
  mechanism**: rotating requires re-entering source configs.
- The dev fallback key is public knowledge (it is in the source code). Any
  non-production data encrypted with it must be considered plaintext.
- New connectors get encryption for free by storing everything they need inside
  their config object — but they MUST NOT invent side channels (files, extra
  tables, env vars) for credentials, or they silently bypass this decision.
- Tests can run without any key setup thanks to the dev fallback.

## Alternatives considered

- **Plaintext + filesystem permissions:** rejected — does not survive backup or
  volume-mount mistakes, and SQLite files travel easily.
- **OS keychain / KMS integration:** rejected for now — Calame is self-hosted
  first; requiring a cloud KMS would break the local-first story. The
  capability-passing design leaves room to swap `deriveKeyFromEnv` for a KMS
  fetch later without touching EE code.
- **Per-source keys:** rejected — adds a key-management table without changing
  the threat model (all keys would live next to the data anyway); the single
  env-provided key keeps operations simple.
- **Encrypting the whole SQLite file (SQLCipher):** rejected — heavier
  operational footprint, native-build friction, and it would encrypt data the
  product intentionally keeps queryable (audit log, profiles) at the cost of
  every read.
