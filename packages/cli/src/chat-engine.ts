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
 */
export async function createMcpChatTools(
  mcpUrl: string,
  bearerToken: string,
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

  const { tools: mcpTools } = await client.listTools();

  const tools: ToolDef[] = mcpTools.map((mcpTool) => ({
    name: mcpTool.name,
    description: mcpTool.description ?? '',
    parameters: mcpTool.inputSchema as Record<string, unknown>,
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const result = await client.callTool({ name: mcpTool.name, arguments: args });
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
// System prompt & chat turn execution
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  const today = new Date().toISOString().split('T')[0];
  return `You are a versatile AI assistant with direct access to a database through MCP tools.
Today's date is: ${today}

## GOLDEN RULE: Act first, ask later
- When the user asks about data, IMMEDIATELY call your tools to find the answer. Do NOT ask clarifying questions if you can figure it out yourself by exploring the data.
- If you need to find someone by name, search for them. If you need to understand the schema, call describe. If you need to cross-reference tables, chain multiple tool calls. Be resourceful and autonomous.
- NEVER ask the user for an ID, a column name, a date format, or any technical detail. Figure it out yourself by querying the data.
- "today" means ${today}. "this week" means the last 7 days. Always resolve dates yourself.
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

const FRIENDLY_ADDENDUM = `

## REGLE ABSOLUE — Mode langage naturel
Tu es en mode "langage naturel". Tu DOIS respecter ces regles sans exception :
- Ne mentionne JAMAIS de noms de colonnes, de champs, de tables, ni aucun terme technique lie a la base de donnees.
- Ne presente JAMAIS les donnees sous forme "champ: valeur", "colonne: valeur" ou liste de proprietes.
- Decris les informations comme si tu racontais quelque chose a quelqu'un de maniere fluide et humaine.
- Si l'utilisateur demande la structure, les colonnes, ou les champs, reformule en termes generaux le type d'informations disponibles sans jamais citer de noms techniques.
- Exemple INTERDIT : "First Name: Jean, Email: jean@example.com, Role: admin"
- Exemple CORRECT : "Jean est un administrateur, on peut le contacter a jean@example.com"`;

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

/** Execute a single chat turn with tool loop, supporting Anthropic, OpenRouter, and Custom (OpenAI-compatible) providers. */
export async function executeChatTurn(options: ChatTurnOptions): Promise<ChatTurnResult> {
  const { provider, apiKey, model, baseUrl, message, history, tools, systemPrompt } = options;

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
    return executeOpenAITurn(
      apiKey,
      effectiveModel,
      effectiveBaseUrl!,
      message,
      history,
      tools,
      systemPrompt,
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

  const anthropicTools = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));

  const messages: Array<{
    role: 'user' | 'assistant';
    content: string | Array<Record<string, unknown>>;
  }> = [];
  if (Array.isArray(history)) {
    for (const h of history) {
      messages.push(h as { role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> });
    }
  }
  messages.push({ role: 'user', content: message });

  let response = await anthropic.messages.create({
    model: model || 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: systemPrompt,
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
      system: systemPrompt,
      tools: anthropicTools as never,
      messages: messages as never,
    });
  }

  const assistantMessage = response.content
    .filter((b) => b.type === 'text')
    .map((b) => ('text' in b ? b.text : ''))
    .join('\n');

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

  const openaiMessages: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPrompt },
  ];
  if (Array.isArray(history)) {
    for (const h of history) {
      openaiMessages.push({ role: h.role, content: h.content });
    }
  }
  openaiMessages.push({ role: 'user', content: message });

  let completion = await openai.chat.completions.create({
    model,
    max_tokens: 4096,
    tools: openaiTools,
    messages: openaiMessages as never,
  });

  const MAX_TOOL_ROUNDS = 20;
  let toolRound = 0;
  while (completion.choices[0]?.finish_reason === 'tool_calls') {
    if (++toolRound > MAX_TOOL_ROUNDS) {
      return { success: true, response: 'Tool use limit reached. Please simplify your request.', toolResults };
    }
    const assistantMsg = completion.choices[0].message;
    openaiMessages.push(assistantMsg as unknown as Record<string, unknown>);

    const toolCalls = assistantMsg.tool_calls ?? [];
    for (const tc of toolCalls) {
      if (tc.type !== 'function') continue;
      const args = JSON.parse(tc.function.arguments || '{}');
      const result = await callTool(tc.function.name, args);
      toolResults.push({ tableName: tc.function.name, data: result });
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
    });
  }

  const assistantMessage = completion.choices[0]?.message?.content ?? '';
  return { success: true, response: assistantMessage, toolResults };
}
