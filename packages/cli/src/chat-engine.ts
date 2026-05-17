import crypto from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * Per-process secret used to authenticate internal chat→MCP calls.
 * This allows chat-only users (accessMode === 'chat') to call the MCP endpoint
 * without being blocked by the external MCP access check.
 */
export const INTERNAL_CHAT_SECRET = crypto.randomBytes(32).toString('hex');

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

export interface ChatTurnOptions {
  provider: 'anthropic' | 'openrouter' | 'custom';
  apiKey: string;
  model?: string;
  baseUrl?: string;
  message: string;
  history: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
  tools: ToolDef[];
  systemPrompt: string;
}

export interface ChatTurnResult {
  success: boolean;
  response: string;
  toolResults: Array<{ tableName: string; data: string }>;
}

export interface McpChatToolsResult {
  tools: ToolDef[];
  close: () => Promise<void>;
}

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
  const now = Date.now();
  const cached = toolSchemaCache.get(cacheKey);
  let mcpSchemas: ToolSchemaEntry['schemas'];

  if (cached && now - cached.ts < TOOL_SCHEMA_TTL_MS) {
    mcpSchemas = cached.schemas;
  } else {
    const { tools: mcpTools } = await client.listTools();
    mcpSchemas = mcpTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
    toolSchemaCache.set(cacheKey, { schemas: mcpSchemas, ts: now });
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
          if (values.length === 0) throw new Error('calc: cannot compute average of an empty array');
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
// Tool schema cache (TTL 30s) — avoids redundant listTools() calls per turn
// ---------------------------------------------------------------------------

interface ToolSchemaEntry {
  schemas: Array<{ name: string; description: string | undefined; inputSchema: Record<string, unknown> }>;
  ts: number;
}
const toolSchemaCache = new Map<string, ToolSchemaEntry>();
const TOOL_SCHEMA_TTL_MS = 30_000;

export function invalidateToolSchemaCache(profileName?: string): void {
  if (profileName) {
    toolSchemaCache.delete(profileName);
  } else {
    toolSchemaCache.clear();
  }
}

// ---------------------------------------------------------------------------
// System prompt & chat turn execution
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return `You are a versatile AI assistant with direct access to a database through MCP tools.

## GOLDEN RULE: Act first, ask later
- When the user asks about data, IMMEDIATELY call your tools to find the answer. Do NOT ask clarifying questions if you can figure it out yourself by exploring the data.
- If you need to find someone by name, search for them. If you need to understand the schema, call describe. If you need to cross-reference tables, chain multiple tool calls. Be resourceful and autonomous.
- NEVER ask the user for an ID, a column name, a date format, or any technical detail. Figure it out yourself by querying the data.
- "today" means the date provided in the system context. "this week" means the last 7 days. Always resolve dates yourself.
- Only ask the user a question if the data truly cannot resolve the ambiguity (e.g., two people with the exact same name).
- When the user refers to a concept in natural language (e.g., "in progress", "delivered"), you MUST map it to the actual database value. Database values often use snake_case, abbreviations, or codes (e.g., "en_cours" for "in progress", "livre" for "delivered"). If a filter returns 0 results and you expected some, the response will include the possible values — use them to retry immediately.
- The describe tool shows sample values for text columns. Call describe FIRST when you are unsure about the exact values to use in WHERE clauses.

## Your capabilities
- **Database access**: You have specific tools for specific tables. NOT every table has every tool — some tables may only have query, only aggregate, or only describe. You MUST only call tools that actually exist in your tool list.
- **General assistance**: You can also answer general questions, write content, explain concepts, do analysis, help with code, and anything a capable assistant can do — with or without database data.

## CRITICAL: Tool usage rules
- **ONLY call tools that are in your tool list.** Before calling any tool, verify it exists. If you have \`aggregate_orders\` but NOT \`query_orders\`, do NOT attempt to call \`query_orders\`. Do NOT assume a tool exists just because a table exists.
- When you only have partial access to a table (e.g. only aggregate), tell the user clearly what you CAN do with that table, and do it proactively. For example: "I can count and aggregate BugReport data but I cannot list individual rows. Here's what I found: ..."
- Use the \`list_tables\` tool if available to discover what tables and tools you have access to.
- When asked for "all columns", select them all without asking for confirmation.

## Multi-step queries
- Many questions require chaining multiple tool calls. For example, to find "how many orders did John deliver today", you should: (1) query the deliverers table to find John's ID, (2) query/aggregate the orders table using that ID and today's date. Do this automatically without asking the user for IDs or column names.
- Always start by exploring: call \`describe_<table>\` or \`list_tables\` if you are unsure about the schema, then proceed with the actual query.
- **2D cross-table pivot** ("by X and by Y" where X and Y are on different tables): use \`join_aggregate\` with \`group_by_column\` (one table) + \`group_by_secondary_column\` (the other). One call — never loop across dimensions.
- **Multi-hop joins** (A → B → C): \`join_aggregate\` auto-resolves up to 3 FK hops. Use it even when there is no direct FK between primary and join tables — the response includes \`join_path\` for transparency.
- **Temporal evolution** ("monthly vs last year"): combine \`compare_to: { period: "previous_year", date_column }\` with \`group_by_bucket: "month"\` in a single \`aggregate\` call.
- **Pagination**: if a GROUP BY returns more than the limit, add \`offset\` to aggregate/join_aggregate to get the next page.
- **Statistical distributions**: use \`aggregation: "median" | "stddev" | "variance" | "percentile"\` (with \`percentile_p\` for percentile, e.g. 0.95 for p95). PostgreSQL only.

## CRITICAL: row limits — what they actually mean
The default \`limit\` is 20 and the hard cap is 1000 (configurable per-table). These limits apply ONLY to the rows RETURNED to you, NOT to the rows the database SCANS.
- A table with 20,000 rows is NOT a problem. The database scans every row internally; you receive the aggregated result.
- \`COUNT(*)\` on 20,000 rows returns 1 row (\`{ "result": 20000 }\`), well under the limit.
- \`GROUP BY id_livreur\` on 20,000 colis with 50 distinct livreurs returns 50 rows — under the limit.
- NEVER refuse a question because "the table has too many rows". Use \`aggregate_<table>\` or \`join_aggregate\` and the database does the work for you.
- Reach for \`query_<table>\` only when the user genuinely wants individual rows listed. For counts, sums, averages, top-N, distributions → always aggregate.
- If you truly need more than 1000 grouped result rows (very rare), tell the user and suggest narrower filters; do not loop with \`offset\` for analytic questions when an aggregate would answer in one call.

## CRITICAL: data integrity
- NEVER invent, estimate, or approximate data. Every number in your response MUST come from a tool result received in this conversation.
- If a tool returns an error or no data, say so explicitly: "I was unable to retrieve this information."
- If you have not called a tool yet, do not answer data questions — call the tool first.

## Document / knowledge base tools (when available)
- If your tool list contains \`rag_search\`, \`rag_list_documents\`, \`rag_list_folders\`, \`rag_list_sources\`, or \`rag_get_document\` (possibly with a source-name prefix like \`mydocs_rag_search\`), you have access to a knowledge base of user-uploaded documents — notes, work logs, manuals, reports, meeting minutes, contracts, personal text content, etc.
- **Routing rule (CRITICAL)**: when the user asks about CONTENT that would naturally live in a file — what someone wrote, what happened on a date in a log, what a document says, anything described in free-form text — call \`rag_search\` FIRST. Do NOT default to database queries for textual content. Names of people, dates, or events in the question are NOT a signal that the answer is in a relational table; they may equally appear in uploaded documents.
- **When in doubt** (a "who/what/when" question with no obvious DB-vs-document signal): call \`rag_search\` in parallel with any plausible database lookup, then answer from whichever returned relevant content. A document hit beats an empty database result.
- Use \`rag_get_document\` to fetch the full text of a document the user references by name, or to expand on a chunk \`rag_search\` returned.
- Use \`rag_list_documents\` / \`rag_list_sources\` / \`rag_list_folders\` when the user asks "what files / documents / sources do I have?".
- The same data-integrity rule applies: NEVER invent content. If \`rag_search\` returns nothing relevant, say so plainly.

## CRITICAL: arithmetic
- You MUST NOT compute sums, averages, totals, min/max, products mentally. This includes TOTAL rows in tables.
- For totals over DB rows: prefer aggregate_<table> (SUM/AVG/COUNT in SQL).
- For totals over numbers already in the conversation (cited rows, user-provided lists): ALWAYS call the \`calc\` tool BEFORE writing the number.
- **TOTAL rows in Markdown tables**: if you display a table with a TOTAL row, you MUST call \`calc\` first to obtain the sum, then write it. Never type a TOTAL by adding numbers in your head.
- **Percentages**: if you compute X/Y*100, call \`calc\` with op=product or op=sum as needed — never compute percentages mentally.
- Never write "Total: X", "Sum: X", "Average: X", or any TOTAL cell unless X comes from a \`calc\` tool result or an \`aggregate_*\` tool result from this conversation.

## When the user asks about data
- Always use your tools to fetch real data. Never guess, invent rows, or use placeholder values.
- If you need to know the schema, call \`describe_<table>\` ONLY if that tool exists.
- For large results, summarize key findings and offer to dig deeper.

## When the user asks something general
- Answer directly using your own knowledge. No need to call any tool.
- If the question *might* involve data but is ambiguous, briefly ask whether they want you to pull from the database or answer generally.

## Combining both
- Many requests benefit from both: fetch the data, then analyze, format, draft an email, build a report, etc. Do both steps seamlessly.
- When writing reports or emails that reference data, always fetch the real data first, then compose your output using those results.

## Formatting
- Be concise. Use tables for tabular data, bullet points for lists.
- For large query results, highlight patterns and outliers rather than dumping raw rows.`;
}

// English-only on purpose: this is a system-prompt addendum the LLM follows
// at every turn, and English rules are applied more reliably than translated
// ones across the model spectrum (Mistral / Qwen / Gemini Flash). The LLM
// still answers in the user's input language — the rule is about FORMAT, not
// language.
const FRIENDLY_ADDENDUM = `

## ABSOLUTE RULE — natural-language presentation
This rule applies ONLY to the database's technical identifiers (column names, table names, schema names, SQL field names). It does NOT restrict the VALUES returned: first names, last names, labels, descriptions, business identifiers must be presented normally and in full.
Rules:
- NEVER mention technical column, field, or table names, or any SQL terminology.
- NEVER present data as "field: value", "column: value", or as a property list.
- Describe information in fluent natural language, as if you were telling someone a story.
- If the user asks for the structure, the columns, or the fields, reformulate in general terms the type of information available without citing any technical names.
- Always answer in the user's language (match the language they wrote in).
- FORBIDDEN example: "First Name: Jean, Email: jean@example.com, Role: admin"
- CORRECT example: "Jean Dupont is an administrator and can be reached at jean@example.com"`;

const SCOPED_ADDENDUM = `

## DATA SCOPING — CRITICAL
The data is ALREADY FILTERED for the current user. Every query you make automatically returns ONLY this user's data.
- NEVER ask the user for their ID, client number, email, or any identifier. You already have only their data.
- When the user says "my packages" or "my invoices", just call the query tool directly WITHOUT any filter on the identity column. The system handles it.
- If a query returns 0 results, it means the user genuinely has no data for that query — do NOT ask for an identifier.
- Treat ALL results as belonging to the current user. Present them naturally: "You have 3 packages" not "Client 1 has 3 packages".

## CROSS-TABLE LOOKUPS — CRITICAL
When the user asks about data in a related table (history, logs, audit, incidents, details...) that is not directly scoped, you MUST resolve the IDs yourself:
1. First query the scoped table to get the relevant IDs.
2. Then query the related table using those IDs as filters.
- NEVER ask the user for IDs — always fetch them yourself in step 1.
- Do this automatically, without confirmation, even if it requires multiple tool calls.`;

export function getDefaultSystemPrompt(responseMode?: 'friendly' | 'raw', options?: { scoped?: boolean }): string {
  const prompt = buildSystemPrompt();
  let result = prompt;
  if (responseMode !== 'raw') result += FRIENDLY_ADDENDUM;
  if (options?.scoped) result += SCOPED_ADDENDUM;
  return result;
}

export const MAX_HISTORY_EXCHANGES = 10;

export function trimHistory(
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>,
): Array<{ role: string; content: string | Array<Record<string, unknown>> }> {
  if (messages.length <= MAX_HISTORY_EXCHANGES * 2) return messages;
  return messages.slice(messages.length - MAX_HISTORY_EXCHANGES * 2);
}

export type StreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; name: string }
  | { type: 'tool_result'; name: string; ok: boolean }
  | { type: 'usage'; input: number; output: number; cacheRead?: number; cacheCreation?: number }
  | { type: 'done'; finalText: string }
  | { type: 'error'; message: string };

/** Execute a single chat turn with tool loop, supporting Anthropic, OpenRouter, and Custom (OpenAI-compatible) providers. */
export async function executeChatTurn(options: ChatTurnOptions): Promise<ChatTurnResult> {
  const { provider, apiKey, model, baseUrl, message, history: rawHistory, tools, systemPrompt } = options;
  const history = trimHistory(rawHistory);

  const callTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.handler(args);
  };

  const toolResults: Array<{ tableName: string; data: string }> = [];

  if (provider === 'anthropic') {
    return executeAnthropicTurn(apiKey, model, message, history, tools, systemPrompt, callTool, toolResults);
  } else {
    // openrouter or custom — both use OpenAI SDK
    const effectiveBaseUrl =
      provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : baseUrl;
    const effectiveModel =
      model || (provider === 'openrouter' ? 'anthropic/claude-sonnet-4' : 'default');
    const effectiveSystemPrompt = systemPrompt;
    return executeOpenAITurn(
      apiKey,
      effectiveModel,
      effectiveBaseUrl!,
      message,
      history,
      tools,
      effectiveSystemPrompt,
      callTool,
      toolResults,
    );
  }
}

async function executeAnthropicTurn(
  apiKey: string,
  model: string | undefined,
  message: string,
  history: Array<{ role: string; content: string | Array<Record<string, unknown>> }>,
  tools: ToolDef[],
  systemPrompt: string,
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  toolResults: Array<{ tableName: string; data: string }>,
): Promise<ChatTurnResult> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const anthropic = new Anthropic({ apiKey });

  const anthropicTools = tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as never,
    ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }));

  // Build system blocks: static prompt is cache-eligible; dynamic date is a separate block
  const today = new Date().toISOString().split('T')[0];
  const systemBlocks = [
    { type: 'text' as const, text: systemPrompt, cache_control: { type: 'ephemeral' as const } },
    { type: 'text' as const, text: `Today's date is: ${today}` },
  ];

  const messages: Array<{
    role: 'user' | 'assistant';
    content: string | Array<Record<string, unknown>>;
  }> = [];
  if (Array.isArray(history)) {
    for (const h of history) {
      if (h.role === 'assistant' && typeof h.content === 'string' && h.content.startsWith('Error:')) {
        continue;
      }
      messages.push(h as { role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> });
    }
  }
  messages.push({ role: 'user', content: message });

  let response = await anthropic.messages.create({
    model: model || 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: systemBlocks as never,
    tools: anthropicTools as never,
    messages: messages as never,
  });

  const MAX_TOOL_ROUNDS = 20;
  let toolRound = 0;
  while (response.stop_reason === 'tool_use') {
    if (++toolRound > MAX_TOOL_ROUNDS) {
      return { success: true, response: 'Tool use limit reached. Please simplify your request.', toolResults };
    }
    const toolUseBlocks = response.content.filter(
      (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
        b.type === 'tool_use',
    );

    const toolResultContents: Array<{
      type: 'tool_result';
      tool_use_id: string;
      content: string;
    }> = [];

    for (const toolUse of toolUseBlocks) {
      console.log(JSON.stringify({ component: 'chat', event: 'tool_call', name: toolUse.name }));
      const result = await callTool(toolUse.name, toolUse.input);
      toolResults.push({ tableName: toolUse.name, data: result });
      toolResultContents.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    messages.push({ role: 'assistant', content: response.content as never });
    messages.push({ role: 'user', content: toolResultContents as never });

    response = await anthropic.messages.create({
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemBlocks as never,
      tools: anthropicTools as never,
      messages: messages as never,
    });
  }

  const assistantMessage = response.content
    .filter((b) => b.type === 'text')
    .map((b) => ('text' in b ? b.text : ''))
    .join('\n');

  const usage = response.usage;
  console.log(JSON.stringify({ component: 'chat', provider: 'anthropic', usage }));

  return { success: true, response: assistantMessage, toolResults };
}

async function executeOpenAITurn(
  apiKey: string,
  model: string,
  baseUrl: string,
  message: string,
  history: Array<{ role: string; content: string | Array<Record<string, unknown>> }>,
  tools: ToolDef[],
  systemPrompt: string,
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  toolResults: Array<{ tableName: string; data: string }>,
): Promise<ChatTurnResult> {
  const OpenAI = (await import('openai')).default;
  const openai = new OpenAI({ apiKey: apiKey || 'not-needed', baseURL: baseUrl });

  const openaiTools = tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const today = new Date().toISOString().split('T')[0];
  const effectiveSystem = `${systemPrompt}\n\nToday's date: ${today}`;

  const openaiMessages: Array<Record<string, unknown>> = [
    { role: 'system', content: effectiveSystem },
  ];

  if (Array.isArray(history)) {
    for (const h of history) {
      // Skip assistant error messages — they pollute the model's context
      if (h.role === 'assistant' && typeof h.content === 'string' && h.content.startsWith('Error:')) {
        continue;
      }
      openaiMessages.push({ role: h.role, content: h.content });
    }
  }
  openaiMessages.push({ role: 'user', content: message });

  let completion = await openai.chat.completions.create({
    model,
    max_tokens: 4096,
    tools: openaiTools,
    messages: openaiMessages as never,
  } as never);

  const MAX_TOOL_ROUNDS = 20;
  let toolRound = 0;
  while (completion.choices[0]?.finish_reason === 'tool_calls') {
    if (++toolRound > MAX_TOOL_ROUNDS) {
      return { success: true, response: 'Tool use limit reached. Please simplify your request.', toolResults };
    }
    const assistantMsg = completion.choices[0].message;

    // Strip reasoning fields — they waste tokens and confuse subsequent rounds
    const { reasoning_content: _rc, provider_specific_fields: _psf, ...cleanMsg } =
      assistantMsg as typeof assistantMsg & { reasoning_content?: unknown; provider_specific_fields?: unknown };
    openaiMessages.push(cleanMsg as unknown as Record<string, unknown>);

    const toolCalls = assistantMsg.tool_calls ?? [];
    for (const tc of toolCalls) {
      if (tc.type !== 'function') continue;
      const args = JSON.parse(tc.function.arguments || '{}');
      // Strip namespace prefix added by some models (e.g. Gemini via OpenRouter: "default_api.query" → "query")
      const toolName = tc.function.name.includes('.') ? tc.function.name.split('.').pop()! : tc.function.name;
      console.log(JSON.stringify({ component: 'chat', event: 'tool_call', name: toolName }));
      const result = await callTool(toolName, args);
      toolResults.push({ tableName: toolName, data: result });
      openaiMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result,
      });
    }

    completion = await openai.chat.completions.create({
      model,
      max_tokens: 4096,
      tools: openaiTools,
      messages: openaiMessages as never,
      enable_thinking: false,
    } as never);
  }

  const assistantMessage = completion.choices[0]?.message?.content ?? '';

  const usage = completion.usage;
  console.log(JSON.stringify({ component: 'chat', provider: 'openai', usage }));

  return { success: true, response: assistantMessage, toolResults };
}

// ---------------------------------------------------------------------------
// Streaming chat turn
// ---------------------------------------------------------------------------

export async function* streamChatTurn(options: ChatTurnOptions): AsyncGenerator<StreamEvent> {
  const { provider, apiKey, model, baseUrl, message, history: rawHistory, tools, systemPrompt } = options;
  const history = trimHistory(rawHistory);
  const MAX_TOOL_ROUNDS = 20;

  const callTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.handler(args);
  };

  if (provider === 'anthropic') {
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const anthropic = new Anthropic({ apiKey });

      const today = new Date().toISOString().split('T')[0];
      const systemBlocks = [
        { type: 'text' as const, text: systemPrompt, cache_control: { type: 'ephemeral' as const } },
        { type: 'text' as const, text: `Today's date is: ${today}` },
      ];

      const anthropicTools = tools.map((t, i) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as never,
        ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
      }));

      const messages: Array<{
        role: 'user' | 'assistant';
        content: string | Array<Record<string, unknown>>;
      }> = [];
      if (Array.isArray(history)) {
        for (const h of history) {
          if (h.role === 'assistant' && typeof h.content === 'string' && h.content.startsWith('Error:')) {
            continue;
          }
          messages.push(h as { role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> });
        }
      }
      messages.push({ role: 'user', content: message });

      let fullText = '';
      let toolRound = 0;

      while (true) {
        const stream = anthropic.messages.stream({
          model: model || 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: systemBlocks as never,
          tools: anthropicTools as never,
          messages: messages as never,
        });

        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            yield { type: 'text_delta', delta: event.delta.text };
            fullText += event.delta.text;
          }
        }

        const msg = await stream.finalMessage();

        if (msg.stop_reason === 'tool_use') {
          if (++toolRound > MAX_TOOL_ROUNDS) {
            yield { type: 'done', finalText: fullText || 'Tool use limit reached. Please simplify your request.' };
            return;
          }

          const toolUseBlocks = msg.content.filter(
            (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
              b.type === 'tool_use',
          );

          const toolResultContents: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];

          for (const toolUse of toolUseBlocks) {
            console.log(JSON.stringify({ component: 'chat', event: 'tool_call', name: toolUse.name }));
            yield { type: 'tool_call', name: toolUse.name };
            let ok = true;
            let result = '';
            try {
              result = await callTool(toolUse.name, toolUse.input);
            } catch (err) {
              ok = false;
              result = err instanceof Error ? err.message : String(err);
            }
            yield { type: 'tool_result', name: toolUse.name, ok };
            toolResultContents.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
          }

          messages.push({ role: 'assistant', content: msg.content as never });
          messages.push({ role: 'user', content: toolResultContents as never });
          continue;
        }

        if (msg.usage) {
          const u = msg.usage as unknown as Record<string, number>;
          yield {
            type: 'usage',
            input: msg.usage.input_tokens,
            output: msg.usage.output_tokens,
            cacheRead: u['cache_read_input_tokens'],
            cacheCreation: u['cache_creation_input_tokens'],
          };
        }
        break;
      }

      yield { type: 'done', finalText: fullText };
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
    }
    return;
  }

  // openrouter or custom — both use OpenAI SDK
  try {
    const OpenAI = (await import('openai')).default;
    const effectiveBaseUrl = provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : baseUrl;
    const effectiveModel = model || (provider === 'openrouter' ? 'anthropic/claude-sonnet-4' : 'default');
    const openai = new OpenAI({ apiKey: apiKey || 'not-needed', baseURL: effectiveBaseUrl });

    const openaiTools = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const today = new Date().toISOString().split('T')[0];
    const effectiveSystem = `${systemPrompt}\n\nToday's date: ${today}`;

    const openaiMessages: Array<Record<string, unknown>> = [
      { role: 'system', content: effectiveSystem },
    ];

    if (Array.isArray(history)) {
      for (const h of history) {
        if (h.role === 'assistant' && typeof h.content === 'string' && h.content.startsWith('Error:')) {
          continue;
        }
        openaiMessages.push({ role: h.role, content: h.content });
      }
    }
    openaiMessages.push({ role: 'user', content: message });

    let fullText = '';
    let toolRound = 0;

    while (true) {
      let toolCallsAcc: Record<string, { name: string; argsStr: string }> = {};
      let finishReason: string | null | undefined = null;

      const stream = await openai.chat.completions.create({
        model: effectiveModel,
        max_tokens: 4096,
        tools: openaiTools,
        messages: openaiMessages as never,
        stream: true,
        stream_options: { include_usage: true },
      } as never) as unknown as AsyncIterable<Record<string, unknown>>;

      for await (const chunk of stream) {
        const choices = chunk['choices'] as Array<Record<string, unknown>> | undefined;
        const delta = choices?.[0]?.['delta'] as Record<string, unknown> | undefined;
        const chunkUsage = chunk['usage'] as { prompt_tokens: number; completion_tokens: number } | undefined;

        if (typeof delta?.['content'] === 'string' && delta['content']) {
          yield { type: 'text_delta', delta: delta['content'] };
          fullText += delta['content'];
        }

        if (Array.isArray(delta?.['tool_calls'])) {
          for (const tc of delta['tool_calls'] as Array<Record<string, unknown>>) {
            const idx = tc['index'] as number;
            if (!toolCallsAcc[idx]) toolCallsAcc[idx] = { name: '', argsStr: '' };
            const fn = tc['function'] as Record<string, unknown> | undefined;
            if (typeof fn?.['name'] === 'string') toolCallsAcc[idx].name += fn['name'];
            if (typeof fn?.['arguments'] === 'string') toolCallsAcc[idx].argsStr += fn['arguments'];
          }
        }

        if (chunkUsage) {
          yield { type: 'usage', input: chunkUsage.prompt_tokens, output: chunkUsage.completion_tokens };
        }

        const fr = choices?.[0]?.['finish_reason'];
        if (fr != null) finishReason = fr as string;
      }

      if (finishReason === 'tool_calls') {
        if (++toolRound > MAX_TOOL_ROUNDS) {
          yield { type: 'done', finalText: fullText || 'Tool use limit reached. Please simplify your request.' };
          return;
        }

        const assistantToolCalls = Object.values(toolCallsAcc).map((tc, idx) => ({
          id: `call_${idx}`,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.argsStr },
        }));

        openaiMessages.push({ role: 'assistant', content: null, tool_calls: assistantToolCalls });

        for (const tc of assistantToolCalls) {
          const rawName = tc.function.name;
          const toolName = rawName.includes('.') ? rawName.split('.').pop()! : rawName;
          console.log(JSON.stringify({ component: 'chat', event: 'tool_call', name: toolName }));
          yield { type: 'tool_call', name: toolName };
          let ok = true;
          let result = '';
          try {
            const args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
            result = await callTool(toolName, args);
          } catch (err) {
            ok = false;
            result = err instanceof Error ? err.message : String(err);
          }
          yield { type: 'tool_result', name: toolName, ok };
          openaiMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }

        toolCallsAcc = {};
        continue;
      }

      break;
    }

    yield { type: 'done', finalText: fullText };
  } catch (err) {
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
  }
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
