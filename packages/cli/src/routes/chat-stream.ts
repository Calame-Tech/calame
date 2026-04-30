import type { Express } from 'express';
import { z } from 'zod';
import type { AppState } from '../state.js';
import { createMcpChatTools, streamChatTurn, getDefaultSystemPrompt } from '../chat-engine.js';
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

export function registerChatStreamRoute(app: Express, state: AppState): void {
  app.post('/api/chat/stream', async (req, res) => {
    let close: (() => Promise<void>) | null = null;

    try {
      const parsed = chatSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          message: parsed.error.issues[0]?.message ?? 'Invalid request body',
        });
        return;
      }
      const { message, profileName: requestedProfileName, aiSettingName, history } = parsed.data;

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
        profileName = profileNames[0];
      }

      const aiResolution = resolveAiSetting(state, profileName, aiSettingName);
      if (!aiResolution.ok) {
        res.status(aiResolution.status).json({ success: false, message: aiResolution.message });
        return;
      }
      const aiConfig = aiResolution.setting;

      const responseMode = state.serveProfiles[profileName]?.responseMode ?? 'friendly';

      const userManager = state.userManager;
      if (!userManager) {
        res.status(500).json({ success: false, message: 'User manager not initialized.' });
        return;
      }

      // Dual auth: admin session cookie OR user session cookie OR Bearer token
      const adminSessionId = cookies['calame_session'];
      const userSessionId = cookies['calame_user_session'];
      const adminSession = adminSessionId ? validateSession(adminSessionId) : null;
      const userSession = !adminSession && userSessionId ? validateSession(userSessionId) : null;
      const resolvedSession = adminSession ?? userSession;

      let mcpBearerToken: string | null = null;

      if (resolvedSession?.userId) {
        const token = userManager.getUserToken(resolvedSession.userId);
        if (!token) {
          res.status(503).json({
            success: false,
            message: 'Cannot use chat without CALAME_SECRET_KEY. Set this environment variable to enable chat.',
          });
          return;
        }
        mcpBearerToken = token;
      } else {
        const authHeader = req.headers.authorization ?? '';
        const match = authHeader.match(/^Bearer\s+(.+)$/i);
        if (!match) {
          res.status(401).json({ success: false, message: 'Authentication required.' });
          return;
        }
        const tokenValue = match[1];
        const tokenUser = userManager.verifyToken(tokenValue);
        if (!tokenUser) {
          res.status(401).json({ success: false, message: 'Invalid token.' });
          return;
        }
        mcpBearerToken = tokenValue;
      }

      const host = req.headers.host ?? `localhost:${req.socket.localPort ?? 4567}`;
      const protocol = req.secure ? 'https' : 'http';
      const mcpUrl = `${protocol}://${host}/mcp/${profileName}`;

      const { tools: mcpTools, close: closeFn } = await createMcpChatTools(mcpUrl, mcpBearerToken, profileName);
      close = closeFn;
      const tools = mcpTools;

      if (state.llmRouter) {
        const toolNames = tools.map((t: { name: string }) => t.name);
        const classifierResult = await state.llmRouter.classify(message, toolNames);
        if (state.llmRouter.shouldBlock(classifierResult)) {
          res.status(403).json({ success: false, message: state.llmRouter.getBlockMessage(classifierResult) });
          return;
        }
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      let aborted = false;
      req.on('close', () => {
        aborted = true;
      });

      const generator = streamChatTurn({
        provider: aiConfig.provider,
        apiKey: aiConfig.apiKey,
        model: aiConfig.model,
        baseUrl: aiConfig.baseUrl,
        message,
        history: history ?? [],
        tools,
        systemPrompt: getDefaultSystemPrompt(responseMode),
      });

      for await (const event of generator) {
        if (aborted) break;
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }

      res.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`);
        res.end();
      } catch {
        // Response may already be closed
      }
    } finally {
      if (close) {
        await close().catch(() => {});
      }
    }
  });
}
