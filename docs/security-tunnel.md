# Security model — "Expose for Copilot / ChatGPT" tunnel

The Remote access card on an MCP server's detail page can open a [Cloudflare
quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
so cloud AI platforms (Microsoft Copilot Studio, ChatGPT connectors) — which
can only reach MCP servers over public HTTPS — can talk to a Calame instance
running on a workstation. This page documents exactly who can see what, so you
can make an informed call.

## Who sees what

| Party                                    | Sees                                                                                          | Notes                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **This machine**                         | Everything                                                                                    | Files, databases and the Calame store never leave it. Nothing is uploaded anywhere by the tunnel itself.                                                                                                                                                                    |
| **The AI provider** (Microsoft / OpenAI) | The content of every MCP exchange: the questions their models ask and the data Calame returns | Inherent to the use case — this is true with or without a tunnel. Whoever is not comfortable with this should not connect that provider at all.                                                                                                                             |
| **Cloudflare**                           | The content of MCP requests/responses _in transit_                                            | The tunnel is a reverse proxy: TLS from the AI provider terminates on Cloudflare's edge, then traffic re-enters an encrypted tunnel down to `cloudflared` on this machine. Cloudflare relays and does not store the payloads, but it is technically positioned to see them. |
| **Anyone else on the internet**          | Nothing usable                                                                                | The URL is unguessable and rotates on every tunnel restart, and every `/mcp/*` endpoint rejects requests without a valid bearer token (verified: 401 through the tunnel without a token).                                                                                   |

## What the tunnel does NOT change

- **Authentication.** The tunnel changes _reachability_, not auth. All MCP
  endpoints require an API token (revocable at any time from the Tokens page).
- **Data at rest.** Documents, databases and Calame's own store stay on the
  machine. Only query results flow out — to the AI provider you chose to
  connect, via Cloudflare.
- **Write governance.** Pending-write approval, audit log, PII masking and
  scoping apply identically through the tunnel.

## Deliberate limits of this mode

- The public URL is ephemeral (rotates each tunnel restart) and the machine
  must stay on — this is an **evaluation mode**, not a production setup.
- The tunnel binary is Cloudflare's own open-source `cloudflared`
  (Apache-2.0), pinned and shipped with the desktop app; it makes only
  _outbound_ connections (no inbound port is opened on the machine or its
  network).

## The production answer

For production — or whenever a transport intermediary is not acceptable —
deploy Calame on your own infrastructure with `docker-compose.prod.yml`
behind your own domain and reverse proxy. TLS then terminates on **your**
server: no transport third party at all, and the only external party that
sees request content is the AI provider you connect — which is your trust
decision to make, per provider, per profile.
