# MCP Proxy Adapter — design spec

**Status:** draft v2 / design exploration (design-partner-driven — a prospect runs Graphiti's MCP server).
**Author:** design session, 2026-08-10. Revised same day after demand-alignment review.
**Scope of this doc:** the contract for a single new `SourceAdapter` that fronts *any* external MCP server and governs it, with **Graphiti as the first concrete instance**.

> **Demand note (read this before scoping).** The prospect's *stated* need is
> "use my data with AI, performantly" — unification/access, not governance.
> Governance is *our* differentiator on top, not his opening ask. The slicing
> in §9 therefore leads with a **read-only proxy** (his ask: query Graphiti
> memory alongside RAG docs in one governed place) and shows the approval
> gate second ("and this is why your CISO says yes"). Since he said
> "performant": measure and quote the proxy overhead in the demo (expected
> <50 ms locally).

---

## 0. One-line thesis

Calame already resolves tools through a pluggable `SourceAdapter` registry (relational + document + api today). Because every external tool the prospect cares about speaks **MCP**, we don't build one adapter per tool — we build **one adapter that proxies and governs an upstream MCP server**. Graphiti is just the first upstream URL. Governance (approval / audit / scoping / tenancy) is enforced *above* the adapter, so the new source inherits it for free.

## 1. Goals

- Register an external MCP server as a Calame Source of `type: 'mcp'`.
- Expose its upstream tools to the agent **through Calame**, not directly.
- Enforce, uniformly, the governance Calame already owns:
  - **Write approval** — designated upstream tools (e.g. `add_memory`, `add_triplet`) are held in the existing Pending Writes queue instead of executing.
  - **Tool allowlist / scoping** — only admin-selected upstream tools are registered; pass a namespace/group filter through config.
  - **Audit** — every proxied call logged via `onAuditLog`.
  - **Multi-tenant** — each workspace's profile carries its own upstream config (URL + creds + group), isolated by the existing tenant scoping.

## 2. Non-goals (explicit — do NOT build in v1)

- ❌ A **public plugin SDK** / third-party connector distribution. The interface stays internal. (Security + API-stability + support cost; premature.)
- ❌ **Fact-level PII masking with NER.** Upstream results are free text; Calame's PII engine is column/regex-shaped. v1 does pass-through (or coarse regex), and we are honest about it. NER-grade masking is a later slice.
- ❌ **Fine-grained node/edge governance** that would require talking to Neo4j/FalkorDB directly. v1 proxies the MCP surface only.
- ❌ Auto-classification of which upstream tools are "writes." v1 uses config + a name heuristic.

## 3. Where it plugs into existing seams

All of these already exist — see `packages/core/src/sources/`.

| Seam | File | Change |
|---|---|---|
| `SourceAdapter` interface | `sources/types.ts` | implement a new adapter; no interface change |
| `Capability` | `sources/types.ts` | reuse the already-reserved `'tools'` + `'write'` |
| `SourceSchema` union | `sources/types.ts` | **add** arm `{ kind: 'mcp'; server; tools }` |
| `ScopeSelection` union | `sources/types.ts` | **add** arm `{ kind: 'mcp'; allowedTools; writeTools }` |
| adapter registry | `sources/registry.ts` | register the new adapter under `type: 'mcp'` |
| MCP registration ctx | `sources/mcp-context.ts` | no change — `onWriteRequest` + `onAuditLog` already provided |
| adapter resolution | `routes/serve/registration.ts` (`resolveAdapter`) | **add** an arm for `scope.kind === 'mcp'` |
| approval payload | `serve/types.ts` (`PendingWriteQuery`) | **generalize** (see §6) |
| write executor | `cli/src/write-executor.ts` | **add** an arm that forwards an approved MCP-tool call upstream |

## 4. The adapter (concrete shape)

```ts
// mcp-proxy adapter — placement (core vs ee) decided in §12
const mcpProxyAdapter: SourceAdapter<McpProxyConfig, McpSourceSchema, 'tools' | 'write'> = {
  type: 'mcp',
  displayName: 'MCP server (proxy)',
  capabilities: ['tools', 'write'],
  configSchema,          // zod: { url, transport, headers?, groupId?, writeToolNames? }
  scopeSelectionSchema,  // zod: { kind:'mcp', allowedTools[], writeTools[] }

  async testConnection(config) {
    // connect as MCP client, call list_tools, assert reachable
  },

  async introspect(config): Promise<McpSourceSchema> {
    // connect as MCP client → list_tools → map to { kind:'mcp', server, tools:[{name,description,inputSchema,isWrite}] }
    // isWrite = config.writeToolNames?.includes(name) ?? /^(add|create|update|delete|set|put)_/.test(name)
  },

  registerMcpTools(ctx) {
    for (const tool of ctx.schema.tools) {
      if (!allowed(ctx.selection, tool.name)) continue;
      const isWrite = isWriteTool(ctx.selection, tool);
      ctx.server.registerTool(ns(ctx, tool.name), spec(tool), async (args) => {
        if (isWrite) {
          if (!ctx.onWriteRequest) return failClosed();          // no queue → no write tool
          const id = ctx.onWriteRequest({
            profileName: ctx.profileName,
            description: humanSummary(tool, args),
            // Reference, not config: the executor re-resolves the source at
            // approval time (see §6) — same lesson as write-queue v15.
            action: { kind: 'mcp-tool', sourceId: ctx.source.id, toolName: tool.name, args },
          });
          ctx.onAuditLog(auditEntry('write', tool.name, args, { queuedId: id }));
          return submittedForApproval(id);
        }
        const result = await upstreamClient(ctx.config).callTool(tool.name, args);
        ctx.onAuditLog(auditEntry('read', tool.name, args));
        return maybeMask(ctx, result);                            // v1: pass-through
      });
    }
  },
};
```

`config`, `schema`, `selection` are decrypted/validated by the host before `registerMcpTools` runs — same as every other adapter.

## 5. `add_memory` → approval flow (the money-shot, on memory)

```
agent ──calls──▶ Calame tool  graphiti_add_memory(args)
                    │
                    ├─ isWrite? yes → ctx.onWriteRequest({ action:{kind:'mcp-tool',
                    │                     sourceId, toolName:'add_memory', args } })
                    │                 returns queueId
                    └─ returns "Write request submitted for approval (id)"
                                            │
        admin ── Pending Writes ── sees description + toolName + args (not SQL)
                                            │  Approve
                                            ▼
        write-executor: action.kind === 'mcp-tool'
                    ├─ resolve Source by action.sourceId (decrypt config → url/headers)
                    │    └─ source gone/disabled → fail cleanly, nothing executes
                    └─ upstreamClient(resolvedConfig).callTool('add_memory', args)
                                            │
                                            ▼
                             fact enters the Graphiti graph
        audit: queue entry + execution both logged
```

Zero NER required. This is the demoable proof: *you keep control of what your agents commit to memory.*

## 6. The one real schema change: generalize `PendingWriteQuery`

Today (`serve/types.ts`) the queue entry is SQL-shaped: `sql`, `params`, `tableName`, `operation`, `connectionName`, `databaseType`. An `add_memory` write has none of those.

**Proposal — a discriminated `action` payload, keeping the SQL path unchanged:**

```ts
export type PendingWriteAction =
  | { kind: 'sql'; sql: string; params: unknown[]; tableName: string;
      operation: 'insert' | 'update' | 'delete';
      connectionName?: string; databaseType?: string }
  | { kind: 'mcp-tool'; sourceId: string;
      toolName: string; args: Record<string, unknown> };
```

**Why `sourceId` and not the upstream URL/creds:** storing config in the queue
row means an approval replays a **stale** URL or rotated credential — the exact
bug class write-queue v15 fixed for SQL (store `connectionName`, resolve at
execution). Same rule here: the row stores a *reference*; the executor resolves
`Source.configEncrypted` at approval time, and a vanished/disabled source fails
the approval cleanly without executing (reuse the existing test pattern).

```ts

export interface PendingWriteQuery {
  id: string; timestamp: string; profileName: string;
  description: string; status: 'pending' | 'approved' | 'rejected';
  tenantId?: string;
  action: PendingWriteAction;         // ← replaces the flat sql/params/... fields
  approvedBy?: string; approvedAt?: string;
  executionResult?: string; executionError?: string;
}
```

- **Migration — DECIDED: additive `action_json` column** (schema-version bump,
  guarded with `hasTable` like v15). Legacy columns stay and keep serving
  `kind:'sql'` rows unchanged — zero row rewrites, zero risk to the existing
  approval path. `kind:'mcp-tool'` rows use `action_json` and leave the SQL
  columns NULL. The in-memory `PendingWriteQuery.action` shape is synthesized
  at read time from whichever storage form the row has. (A full column
  consolidation can happen later if it ever earns its cost.)
- **Write executor** (`write-executor.ts`) gains one arm: `switch (action.kind)` → `'sql'` = today's pg/mysql/sqlite path; `'mcp-tool'` = resolve the Source by `sourceId`, decrypt its config, forward the call via the upstream MCP client. Secrets never touch the queue row.
- **UI** (`PendingQueries.tsx`): the details panel renders `toolName` + pretty-printed `args` for `mcp-tool` entries instead of the SQL/params block. `description` still drives the summary line. Small conditional, no new page.

This change is also **forward-useful**: any future non-SQL write (an HTTP POST adapter, another MCP server) reuses `kind: 'mcp-tool'` / a sibling arm.

## 7. Governance coverage in v1

| Control | v1 | How |
|---|---|---|
| Write approval | ✅ | `onWriteRequest` + `action:{kind:'mcp-tool'}` + executor arm |
| Tool allowlist / scoping | ✅ | only `selection.allowedTools` registered; `groupId` in config |
| Audit | ✅ | `onAuditLog` per call (read + write + execution) |
| Multi-tenant isolation | ✅ | per-profile Source config; existing tenant scoping on the queue |
| PII masking on reads | ⚠️ coarse | pass-through or regex; NER-grade later |
| Node/edge-level policy | ❌ later | needs direct graph access |

## 8. Security notes

- Upstream creds (bearer/headers) live **encrypted** in `Source.configEncrypted` (existing AES-GCM mechanism). The queue row stores only a `headersRef`, never the secret.
- Treat the upstream MCP server as **untrusted data**: cap response size, set call timeouts, validate/normalize tool outputs before returning to the agent.
- The upstream URL is **admin-configured, not agent-supplied** → SSRF risk is low, but still validate the URL and restrict schemes/hosts.
- Fail-closed: if `onWriteRequest` is absent, write tools are **not registered** — same rule as the relational adapter.

## 8b. Upstream MCP client lifecycle

Calame (an MCP *server*) becomes an MCP *client* toward the upstream. Rules:

- **Spike:** connect **on demand** per tool call (open → call → close), with a
  hard timeout (10 s default, configurable). Simple, stateless, no reconnect
  logic; the per-call handshake cost is acceptable and gets measured in the
  demo (see Demand note).
- **Hardened version:** one lazy persistent client per `(source, tenant)`,
  re-established on error, torn down when the profile stops. Never share a
  client across tenants.
- **Transport:** support `streamable-http` first (Graphiti's default), SSE if
  the partner's deployment needs it. `stdio` upstreams are out of scope
  (Calame may run in a container; spawning arbitrary processes is a security
  decision we are not taking here).
- **Schema staleness:** `introspect` snapshots `list_tools` at config time.
  The upstream can add/rename tools later — v1 answer is a "Refresh schema"
  button (same affordance as relational re-introspect), not auto-sync.
- **Trust boundary:** upstream responses are untrusted input — cap response
  size, normalize to text/JSON, strip anything that looks like tool-call
  injection before returning to the agent.

## 9. Slices (demo-first, schema-touch last)

**Slice 0 — read-only proxy. No queue change, no migration. THE first demo.**
Aligned with the prospect's actual ask (query his Graphiti memory alongside
RAG docs in one place):

1. `McpProxyConfig` = `{ url, headers? }` only.
2. `introspect` = connect + `list_tools`.
3. Register read-through for `search_nodes` / `search_memory_facts`
   (allowlist hardcoded for the spike), each call audited.
4. Demo: one Calame profile serving his PDFs (existing RAG) **and** his
   Graphiti memory, through one governed MCP endpoint + chat. Quote the
   measured proxy overhead.

Touches: new adapter + `SourceSchema`/`ScopeSelection` arms + `resolveAdapter`
arm + registry entry. **Nothing else.**

**Slice 1 — the approval gate (the governance money-shot).**
Shown second: "and this is why your CISO says yes."

1. Approval-gate **`add_memory` only** (hardcoded write set).
2. `action:{kind:'mcp-tool', sourceId}` through `onWriteRequest`;
   `action_json` column; executor arm resolves the source and forwards on
   approve; PendingQueries details panel renders toolName + args.
3. Demo: agent asks to remember something → held in Pending Writes →
   approve → it lands in the graph; a `search_*` recalls it.

No masking, no multi-source, no UI polish beyond the details conditional.
Everything else in §7 is a follow-up once the prospect confirms the shape.

## 10. Tests

- **Unit** — `introspect` maps `list_tools` → schema arm; `registerMcpTools` registers only allowed tools; a write tool routes to `onWriteRequest` and does **not** call upstream; a read tool forwards and logs.
- **Integration** — an in-process fake upstream MCP server: assert (a) read forwards + audits, (b) write queues (no upstream call), (c) approval → executor forwards the queued call upstream.
- Reuse the fail-closed test pattern from `serve-write-wiring.test.ts`.

## 11. Effort estimate (rough)

- **Slice 0** (types + registry arm + `resolveAdapter` arm + read-through
  adapter): small-medium, **no migration**.
- **Slice 1** (`PendingWriteAction` + `action_json` migration + executor arm +
  PendingQueries conditional): **the bulk** — touches the queue, the
  money-shot path.
- **Admin UI (previously omitted — real work):** AddSourceModal doesn't know
  a `mcp` source type (URL + headers form + test connection), and no page
  offers tool-allowlist scoping (ConfigurationDetailPage only has
  relational/document tabs). For the spike both are bypassed (source seeded
  via API/CLI, allowlist hardcoded); for the hardened version budget them
  explicitly.
- The adapter itself (MCP client, introspect, register): medium.

## 12. Placement (core vs ee)

Two defensible options; leaning **split**, to mirror the existing GTM:

- **Read proxy in `packages/` (Apache)** — the adoption magnet: "govern any
  MCP server" travels with the free core.
- **MCP write-approval in `ee/` (BUSL)** — the paid differentiator, exactly
  like the rest of the governance surface.

Decide at hardening time; the spike can live wherever iteration is fastest.

**Sequencing:** Slice 0 → demo → Slice 1 → demo → if confirmed, harden into the full §4–§8b. Do not build the public-plugin generalization; it emerges after the 2nd/3rd real upstream.
