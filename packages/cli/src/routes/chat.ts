import type { Express } from 'express';
import { z } from 'zod';
import type { AppState } from '../state.js';
import { createMcpChatTools, executeChatTurn, getDefaultSystemPrompt } from '../chat-engine.js';
import { isFrontierModel } from '../tool-registry.js';
import { validateSession } from '../session.js';
import { TokenRateLimiter } from '../rate-limiter.js';
import { parseCookies } from '../utils/cookies.js';
import { resolveAiSetting } from '../ai-resolver.js';

const chatLimiter = new TokenRateLimiter();
const CHAT_RPM = 30;

const chatSchema = z.object({
  message: z.string().min(1, 'message must not be empty').max(32_000, 'message too long'),
  profileName: z.string().min(1).optional(),
  aiSettingName: z.string().min(1).optional(),
  history: z
    .array(
      z.object({
        role: z.string(),
        content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
      }),
    )
    .optional(),
  selectedTables: z.record(z.string(), z.array(z.string())).optional(),
});

export function registerChatRoute(app: Express, state: AppState): void {
  app.post('/api/chat', async (req, res) => {
    try {
      // Validate request body
      const parsed = chatSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          message: parsed.error.issues[0]?.message ?? 'Invalid request body',
        });
        return;
      }
      const { message, profileName: requestedProfileName, aiSettingName, history } = parsed.data;

      // Rate limit chat by session
      const cookies = parseCookies(req.headers.cookie ?? '');
      const sid = cookies['calame_session'] ?? req.ip ?? 'anon';
      const rl = chatLimiter.check(sid, CHAT_RPM);
      if (!rl.allowed) {
        res.status(429).json({ success: false, message: 'Too many messages. Please wait a moment.' });
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

      // Resolve profileName: use the requested one if provided, otherwise fall back to first active profile.
      let profileName: string;
      if (requestedProfileName !== undefined) {
        if (!state.serveProfiles[requestedProfileName] || !state.activeProfileNames.has(requestedProfileName)) {
          res.status(404).json({
            success: false,
            message: `Profile "${requestedProfileName}" is not active.`,
          });
          return;
        }
        profileName = requestedProfileName;
      } else {
        // Backward-compat: pick first active profile
        profileName = profileNames[0];
      }

      // Resolve which AI setting to use for this turn (request param > profile default > global fallback).
      const aiResolution = resolveAiSetting(state, profileName, aiSettingName);
      if (!aiResolution.ok) {
        res.status(aiResolution.status).json({ success: false, message: aiResolution.message });
        return;
      }
      const aiConfig = aiResolution.setting;

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
      const { tools: mcpTools, close } = await createMcpChatTools(mcpUrl, adminToken, profileName);
      const tools = mcpTools;

      try {
        // LLM Router: classify the message before sending to the main LLM
        if (state.llmRouter) {
          const toolNames = tools.map((t: { name: string }) => t.name);
          const classifierResult = await state.llmRouter.classify(message, toolNames);
          if (state.llmRouter.shouldBlock(classifierResult)) {
            res
              .status(403)
              .json({ success: false, message: state.llmRouter.getBlockMessage(classifierResult) });
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
          twoStageRouting: !isFrontierModel(aiConfig.provider, aiConfig.model),
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
