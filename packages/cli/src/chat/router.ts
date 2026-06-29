import { parseToolArguments, formatParseError } from '../tool-call-parser.js';
import { buildCategorySelectionPrompt, parseCategoryChoice, filterToolsByCategory } from '../tool-registry.js';
import type { ToolDef, ChatTurnOptions, ChatTurnResult } from './types.js';
import { trimHistory } from './prompt.js';

export type StreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; name: string }
  | { type: 'tool_result'; name: string; ok: boolean }
  | { type: 'usage'; input: number; output: number; cacheRead?: number; cacheCreation?: number }
  | { type: 'done'; finalText: string }
  | { type: 'error'; message: string };

/** Execute a single chat turn with tool loop, supporting Anthropic, OpenRouter, and Custom (OpenAI-compatible) providers. */
export async function executeChatTurn(options: ChatTurnOptions): Promise<ChatTurnResult> {
  const { provider, apiKey, model, baseUrl, message, history: rawHistory, tools, systemPrompt, twoStageRouting } = options;
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
    const effectiveTools = twoStageRouting
      ? await selectToolCategory(tools, message, apiKey, effectiveModel, effectiveBaseUrl!)
      : tools;
    return executeOpenAITurn(
      apiKey,
      effectiveModel,
      effectiveBaseUrl!,
      message,
      history,
      effectiveTools,
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

function getToolSchema(tools: ToolDef[], name: string): Record<string, unknown> | undefined {
  return tools.find((t) => t.name === name)?.parameters;
}

async function selectToolCategory(
  tools: ToolDef[],
  message: string,
  apiKey: string,
  model: string,
  baseUrl: string,
): Promise<ToolDef[]> {
  try {
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey: apiKey || 'not-needed', baseURL: baseUrl });
    const completion = await openai.chat.completions.create({
      model,
      max_tokens: 20,
      messages: [
        { role: 'system', content: buildCategorySelectionPrompt(tools) },
        { role: 'user', content: message },
      ],
    });
    const response = completion.choices[0]?.message?.content ?? '';
    console.log(JSON.stringify({ component: 'chat', event: 'category_selected', response: response.trim() }));
    const category = parseCategoryChoice(response);
    if (!category) return tools;
    const filtered = filterToolsByCategory(tools, category);
    return filtered.length > 0 ? filtered : tools;
  } catch {
    return tools;
  }
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
      // Strip namespace prefix added by some models (e.g. Gemini via OpenRouter: "default_api.query" → "query")
      const toolName = tc.function.name.includes('.') ? tc.function.name.split('.').pop()! : tc.function.name;
      console.log(JSON.stringify({ component: 'chat', event: 'tool_call', name: toolName }));
      const parseResult = parseToolArguments(tc.function.arguments || '{}', getToolSchema(tools, toolName));
      if (!parseResult.ok) {
        toolResults.push({ tableName: toolName, data: parseResult.error });
        openaiMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: formatParseError(tc.function.arguments, toolName, tools.map((t) => t.name), getToolSchema(tools, toolName)),
        });
        continue;
      }
      const result = await callTool(toolName, parseResult.args);
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
  const { provider, apiKey, model, baseUrl, message, history: rawHistory, tools, systemPrompt, twoStageRouting } = options;
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

    const activeTools = twoStageRouting
      ? await selectToolCategory(tools, message, apiKey, effectiveModel, effectiveBaseUrl!)
      : tools;

    const openaiTools = activeTools.map((t) => ({
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
          const parseResult = parseToolArguments(tc.function.arguments || '{}', getToolSchema(tools, toolName));
          if (!parseResult.ok) {
            ok = false;
            result = formatParseError(tc.function.arguments, toolName, tools.map((t) => t.name), getToolSchema(tools, toolName));
          } else {
            try {
              result = await callTool(toolName, parseResult.args);
            } catch (err) {
              ok = false;
              result = err instanceof Error ? err.message : String(err);
            }
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
