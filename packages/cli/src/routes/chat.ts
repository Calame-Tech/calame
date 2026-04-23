import type { Express } from 'express';
import type { AppState } from '../state.js';
import { createMcpChatTools, executeChatTurn, getDefaultSystemPrompt } from '../chat-engine.js';
import { validateSession } from '../session.js';
import { TokenRateLimiter } from '../rate-limiter.js';
import { parseCookies } from '../utils/cookies.js';

const chatLimiter = new TokenRateLimiter();
const CHAT_RPM = 30;

export function registerChatRoute(app: Express, state: AppState): void {
  app.post('/api/chat', async (req, res) => {
    try {
      const { message, history } = req.body;

      // Rate limit chat by session
      const cookies = parseCookies(req.headers.cookie ?? '');
      const sid = cookies['calame_session'] ?? req.ip ?? 'anon';
      const rl = chatLimiter.check(sid, CHAT_RPM);
      if (!rl.allowed) {
        res.status(429).json({ success: false, message: 'Too many messages. Please wait a moment.' });
        return;
      }

      // Use admin AI config (set via AI Settings panel)
      const aiConfig = state.aiConfigManager?.getConfig();
      if (!aiConfig || !state.aiConfigManager?.isConfigured()) {
        res.status(503).json({ success: false, message: 'AI chat is not configured. Go to AI Settings to set up a provider.' });
        return;
      }

      if (!state.serveMode) {
        res.status(503).json({ success: false, message: 'MCP server is not running. Start the server first.' });
        return;
      }

      const profileNames = Object.keys(state.serveProfiles);
      if (profileNames.length === 0) {
        res.status(503).json({ success: false, message: 'No profiles are being served.' });
        return;
      }
      const profileName = profileNames[0];
      const responseMode = state.serveProfiles[profileName]?.responseMode ?? 'friendly';

      // Get admin user ID from session to retrieve their MCP token
      const sessionId = cookies['calame_session'];
      const session = sessionId ? validateSession(sessionId) : null;

      if (!session?.userId) {
        res.status(401).json({ success: false, message: 'Admin session required.' });
        return;
      }

      const userManager = state.userManager;
      if (!userManager) {
        res.status(500).json({ success: false, message: 'User manager not initialized.' });
        return;
      }

      const adminToken = userManager.getUserToken(session.userId);
      if (!adminToken) {
        res.status(503).json({
          success: false,
          message: 'Cannot use chat without CALAME_SECRET_KEY. Set this environment variable to enable chat.',
        });
        return;
      }

      // Build the internal MCP URL from the current request
      const host = req.headers.host ?? `localhost:${req.socket.localPort ?? 4567}`;
      const protocol = req.secure ? 'https' : 'http';
      const mcpUrl = `${protocol}://${host}/mcp/${profileName}`;

      // Connect as MCP client — all security rules are inherited from the MCP server
      const { tools, close } = await createMcpChatTools(mcpUrl, adminToken);

      try {
        // LLM Router: classify the message before sending to the main LLM
        if (state.llmRouter) {
          const toolNames = tools.map((t: { name: string }) => t.name);
          const classifierResult = await state.llmRouter.classify(message as string, toolNames);
          if (state.llmRouter.shouldBlock(classifierResult)) {
            res.status(403).json({ success: false, message: state.llmRouter.getBlockMessage(classifierResult) });
            return;
          }
        }

        const result = await executeChatTurn({
          provider: aiConfig.provider,
          apiKey: aiConfig.apiKey,
          model: aiConfig.model,
          baseUrl: aiConfig.baseUrl,
          message,
          history: history ?? [],
          tools,
          systemPrompt: getDefaultSystemPrompt(responseMode),
        });

        res.json(result);
      } finally {
        await close();
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.error('Error', { component: 'chat', error: message });
      res.status(500).json({ success: false, message });
    }
  });
}
