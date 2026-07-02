import crypto from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getCachedToolSchemas, setCachedToolSchemas } from './chat/tool-schema-cache.js';
import type { ToolDef, McpChatToolsResult } from './chat/types.js';

// Re-exports — preserve the public API of chat-engine.ts for existing consumers.
export type { ToolDef, ChatTurnOptions, ChatTurnResult, McpChatToolsResult } from './chat/types.js';
export { executeChatTurn, streamChatTurn } from './chat/router.js';
export type { StreamEvent } from './chat/router.js';
export { getDefaultSystemPrompt, trimHistory, MAX_HISTORY_EXCHANGES } from './chat/prompt.js';
export { invalidateToolSchemaCache } from './chat/tool-schema-cache.js';

/**
 * Per-process secret used to authenticate internal chat→MCP calls.
 * This allows chat-only users (accessMode === 'chat') to call the MCP endpoint
 * without being blocked by the external MCP access check.
 */
export const INTERNAL_CHAT_SECRET = crypto.randomBytes(32).toString('hex');

// ---------------------------------------------------------------------------
// MCP Client — connects to the internal MCP server as a client
// ---------------------------------------------------------------------------

/**
 * Create an MCP client that connects to the internal MCP endpoint.
 * Lists available tools and returns ToolDef[] with handlers that call tools via the MCP protocol.
 * The caller MUST call `close()` when done.
 *
 * Tool schemas are cached for TOOL_SCHEMA_TTL_MS (30s) per profileName (or mcpUrl as fallback)
 * to avoid redundant listTools() calls on every chat turn.
 */
export async function createMcpChatTools(
  mcpUrl: string,
  bearerToken: string,
  profileName?: string,
): Promise<McpChatToolsResult> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'X-Calame-Internal': INTERNAL_CHAT_SECRET,
      },
    },
  });

  const client = new Client({ name: 'calame-chat', version: '2.0.0' });
  await client.connect(transport);

  // Use cache key = profileName if provided, otherwise fall back to mcpUrl
  const cacheKey = profileName ?? mcpUrl;
  let mcpSchemas = getCachedToolSchemas(cacheKey);

  if (!mcpSchemas) {
    const { tools: mcpTools } = await client.listTools();
    mcpSchemas = mcpTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
    setCachedToolSchemas(cacheKey, mcpSchemas);
  }

  const tools: ToolDef[] = mcpSchemas.map((schema) => ({
    name: schema.name,
    description: schema.description ?? '',
    parameters: schema.inputSchema,
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const result = await client.callTool({ name: schema.name, arguments: args });
      // Extract text content from MCP tool result
      const texts = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!);
      return texts.join('\n');
    },
  }));

  return {
    tools,
    close: async () => {
      await client.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Native calc tool
// ---------------------------------------------------------------------------

/**
 * Create a native server-side arithmetic tool.
 * The LLM MUST use this tool for any arithmetic over numbers already cited in the conversation,
 * instead of computing mentally (which produces errors on large result sets).
 */
export function createCalcTool(): ToolDef {
  return {
    name: 'calc',
    description:
      'Perform arithmetic on a list of numbers. ' +
      'Use this tool for EVERY sum, average, min, max, count, or product over numbers already cited in the conversation. ' +
      'Do NOT compute totals mentally — always call this tool instead.',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['sum', 'avg', 'min', 'max', 'count', 'product'],
        },
        values: {
          type: 'array',
          items: { type: 'number' },
        },
      },
      required: ['op', 'values'],
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const op = args['op'] as string;
      const raw = args['values'];

      if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'number')) {
        throw new Error('calc: values must be an array of numbers');
      }
      const values = raw as number[];

      let result: number;
      switch (op) {
        case 'sum':
          result = values.reduce((acc, v) => acc + v, 0);
          break;
        case 'avg':
          if (values.length === 0)
            throw new Error('calc: cannot compute average of an empty array');
          result = values.reduce((acc, v) => acc + v, 0) / values.length;
          break;
        case 'min':
          if (values.length === 0) throw new Error('calc: cannot compute min of an empty array');
          result = Math.min(...values);
          break;
        case 'max':
          if (values.length === 0) throw new Error('calc: cannot compute max of an empty array');
          result = Math.max(...values);
          break;
        case 'count':
          result = values.length;
          break;
        case 'product':
          result = values.reduce((acc, v) => acc * v, 1);
          break;
        default:
          throw new Error(`calc: unknown operation "${op}"`);
      }

      return JSON.stringify({ result });
    },
  };
}

// ---------------------------------------------------------------------------
// LLM cache pre-warmer (local models only)
// ---------------------------------------------------------------------------

export interface WarmupConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  systemPrompt: string;
  tools: ToolDef[];
}

/**
 * Send a single dummy completion request to pre-populate the local model's KV cache.
 * This ensures the first real user message doesn't pay the full cold-start penalty
 * (~23s for 10K tokens). Only meaningful for local/custom providers (Ollama, LM Studio).
 * Fires and forgets — never throws.
 */
export async function warmupLlmCache(config: WarmupConfig): Promise<void> {
  try {
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey: config.apiKey || 'warmup', baseURL: config.baseUrl });

    const openaiTools = config.tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    await openai.chat.completions.create({
      model: config.model,
      max_tokens: 1,
      tools: openaiTools,
      messages: [
        { role: 'system', content: config.systemPrompt },
        { role: 'user', content: 'ping' },
      ],
    });
  } catch {
    // Warmup failure is silent — it's best-effort
  }
}
