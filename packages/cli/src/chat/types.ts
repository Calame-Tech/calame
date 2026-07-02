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
  twoStageRouting?: boolean;
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
