import type { Express, Request } from 'express';
import type { TLSSocket } from 'node:tls';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { AppState } from '../state.js';
import { INTERNAL_CHAT_SECRET } from '../chat-engine.js';
import { validateSession } from '../session.js';
import { parseCookies } from '../utils/cookies.js';
import { buildMcpPath } from '../utils/mcp-url.js';
import { redactSecrets } from '../sanitize.js';

/**
 * Deterministic MCP probe — `POST /api/serve/mcp-probe`.
 *
 * Connects to a served profile's MCP endpoint over the transport external
 * clients actually use (Streamable HTTP on `/mcp/<profile>`), performs the
 * `initialize` handshake, then `tools/list`. No LLM provider is involved and
 * no tool is called: success proves the endpoint is reachable, accepts the
 * credentials and speaks MCP — not that every tool or source works.
 */

export type McpProbeErrorCategory =
  | 'config'
  | 'auth'
  | 'unreachable'
  | 'timeout'
  | 'protocol'
  | 'backend';

export type McpProbeStage = 'preflight' | 'initialize' | 'list_tools';

export interface McpProbeError {
  category: McpProbeErrorCategory;
  stage: McpProbeStage;
  message: string;
  action: string;
  /** Redacted technical detail, kept for diagnosis. */
  detail?: string;
  /** HTTP status returned by the MCP endpoint, when there was one. */
  httpStatus?: number;
}

export interface McpProbeOptions {
  /** Per-request timeout for initialize and tools/list. */
  timeoutMs?: number;
  /** Origin of the local MCP endpoint. Defaults to the socket the request came in on. */
  resolveOrigin?: (req: Request) => string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

const probeSchema = z.object({
  profileName: z.string().min(1).optional(),
});

/**
 * Origin of this very server, taken from the local end of the socket rather
 * than the Host header so a forged header cannot redirect the admin token.
 */
function localOrigin(req: Request): string {
  const socket = req.socket;
  const protocol = (socket as TLSSocket).encrypted ? 'https' : 'http';
  let address = socket.localAddress ?? '127.0.0.1';
  if (address.startsWith('::ffff:')) address = address.slice(7);
  if (address === '::' || address === '0.0.0.0') address = '127.0.0.1';
  const host = address.includes(':') ? `[${address}]` : address;
  return `${protocol}://${host}:${socket.localPort ?? 4567}`;
}

/** Strip bearer tokens and query-string tokens on top of DSN credentials. */
export function redactProbeDetail(input: string, secrets: string[] = []): string {
  let out = redactSecrets(input)
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***')
    .replace(/([?&](?:token|access_token|api_key|key)=)[^&\s"']+/gi, '$1***');
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('***');
  }
  return out.length > 500 ? `${out.slice(0, 500)}…` : out;
}

function errorCode(err: unknown): string | undefined {
  const cause = (err as { cause?: { code?: unknown } } | undefined)?.cause;
  const code = cause?.code ?? (err as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Map a failure raised by the MCP client into a category with an actionable hint. */
export function classifyMcpProbeError(
  err: unknown,
  stage: Exclude<McpProbeStage, 'preflight'>,
  secrets: string[] = [],
): McpProbeError {
  const raw = err instanceof Error ? err.message : String(err);
  const detail = redactProbeDetail(raw, secrets);
  const base = { stage, detail };

  if (err instanceof StreamableHTTPError && err.code !== undefined && err.code > 0) {
    const httpStatus = err.code;
    if (httpStatus === 401 || httpStatus === 403) {
      return {
        ...base,
        httpStatus,
        category: 'auth',
        message: `The MCP endpoint refused the credentials (HTTP ${httpStatus}).`,
        action:
          'Check the profile authentication mode and that your account or token has access to this MCP profile.',
      };
    }
    if (httpStatus === 404 || httpStatus === 503) {
      return {
        ...base,
        httpStatus,
        category: 'unreachable',
        message: `The MCP endpoint is not serving this profile (HTTP ${httpStatus}).`,
        action: 'Start the MCP server and make sure this profile is active.',
      };
    }
    if (httpStatus >= 500) {
      return {
        ...base,
        httpStatus,
        category: 'backend',
        message: `The MCP endpoint failed with a server error (HTTP ${httpStatus}).`,
        action: 'Check the profile sources and the server logs, then retry.',
      };
    }
    return {
      ...base,
      httpStatus,
      category: 'protocol',
      message: `The MCP endpoint rejected the request (HTTP ${httpStatus}).`,
      action: 'Check that the URL points to a Calame MCP endpoint, then retry.',
    };
  }

  if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
    return {
      ...base,
      category: 'timeout',
      message: `The MCP endpoint did not answer in time during ${stage}.`,
      action: 'Check that the profile sources are reachable, then retry.',
    };
  }

  const code = errorCode(err);
  if (
    code &&
    ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN'].includes(code)
  ) {
    return {
      ...base,
      category: 'unreachable',
      message: `The MCP endpoint could not be reached (${code}).`,
      action: 'Start the MCP server, then retry.',
    };
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return {
      ...base,
      category: 'timeout',
      message: 'The connection to the MCP endpoint timed out.',
      action: 'Check that the MCP server is running, then retry.',
    };
  }
  if (err instanceof TypeError && /fetch failed/i.test(raw)) {
    return {
      ...base,
      category: 'unreachable',
      message: 'The MCP endpoint could not be reached.',
      action: 'Start the MCP server, then retry.',
    };
  }

  if (err instanceof McpError || err instanceof StreamableHTTPError || err instanceof SyntaxError) {
    return {
      ...base,
      category: 'protocol',
      message: `The MCP endpoint returned an invalid MCP response during ${stage}.`,
      action: 'Check that the profile is served by this Calame version, then retry.',
    };
  }
  // zod validation failures on malformed JSON-RPC payloads.
  if (err instanceof Error && err.name === 'ZodError') {
    return {
      ...base,
      category: 'protocol',
      message: `The MCP endpoint returned an invalid MCP response during ${stage}.`,
      action: 'Check that the profile is served by this Calame version, then retry.',
    };
  }

  return {
    ...base,
    category: 'backend',
    message: `The MCP test failed unexpectedly during ${stage}.`,
    action: 'Check the server logs, then retry.',
  };
}

function preflight(message: string, action: string): McpProbeError {
  return { category: 'config', stage: 'preflight', message, action };
}

export function registerMcpProbeRoute(
  app: Express,
  state: AppState,
  options: McpProbeOptions = {},
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const resolveOrigin = options.resolveOrigin ?? localOrigin;

  app.post('/api/serve/mcp-probe', async (req, res) => {
    const parsed = probeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: preflight(
          parsed.error.issues[0]?.message ?? 'Invalid request body.',
          'Send a JSON body with an optional "profileName".',
        ),
      });
      return;
    }

    if (!state.serveMode) {
      res.status(409).json({
        success: false,
        error: preflight(
          'The MCP server is not running.',
          'Start the MCP server from the Serve page, then retry.',
        ),
      });
      return;
    }

    const activeNames = Object.keys(state.serveProfiles).filter((name) =>
      state.activeProfileNames.has(name),
    );
    const profileName = parsed.data.profileName ?? activeNames[0];
    if (!profileName || !activeNames.includes(profileName)) {
      res.status(409).json({
        success: false,
        error: preflight(
          profileName
            ? `Profile "${profileName}" is not active.`
            : 'No MCP profile is being served.',
          'Activate the profile on the Serve page, then retry.',
        ),
      });
      return;
    }

    const profile = state.serveProfiles[profileName];
    let bearerToken = '';
    if (profile?.authMode === 'open') {
      bearerToken = profile.token ?? '';
    } else {
      // The admin middleware already validated this session.
      const sessionId = parseCookies(req.headers.cookie ?? '')['calame_session'];
      const userId = sessionId ? validateSession(sessionId)?.userId : undefined;
      const token = userId ? state.userManager?.getUserToken(userId) : null;
      if (!token) {
        res.status(409).json({
          success: false,
          error: preflight(
            'No MCP token is available for your account, so the protected endpoint cannot be tested.',
            'Set CALAME_SECRET_KEY on the server and restart it, or switch the profile to open access.',
          ),
        });
        return;
      }
      bearerToken = token;
    }

    const endpoint = buildMcpPath(profileName);
    const headers: Record<string, string> = { 'X-Calame-Internal': INTERNAL_CHAT_SECRET };
    if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
    const secrets = [bearerToken, INTERNAL_CHAT_SECRET];

    const client = new Client({ name: 'calame-mcp-probe', version: '1.0.0' });
    const startedAt = Date.now();
    let stage: Exclude<McpProbeStage, 'preflight'> = 'initialize';
    try {
      const transport = new StreamableHTTPClientTransport(new URL(endpoint, resolveOrigin(req)), {
        requestInit: { headers },
      });
      await client.connect(transport, { timeout: timeoutMs });
      stage = 'list_tools';
      const { tools } = await client.listTools(undefined, { timeout: timeoutMs });
      const serverInfo = client.getServerVersion();
      res.json({
        success: true,
        profileName,
        endpoint,
        transport: 'streamable-http',
        protocolVersion: transport.protocolVersion ?? null,
        serverInfo: serverInfo ? { name: serverInfo.name, version: serverInfo.version } : null,
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description ?? '' })),
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      const error = classifyMcpProbeError(err, stage, secrets);
      res.status(error.category === 'timeout' ? 504 : 502).json({
        success: false,
        profileName,
        endpoint,
        error,
      });
    } finally {
      await client.close().catch(() => {});
    }
  });
}
