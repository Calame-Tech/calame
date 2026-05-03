import { useState, useRef, useEffect } from 'react';
import DarkSelect from './ui/DarkSelect.js';
import { useChatStream } from '../hooks/useChatStream.js';
import type { UsageInfo } from '../hooks/useChatStream.js';
import MarkdownMessage from './MarkdownMessage.js';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  usage?: UsageInfo;
}

interface ChatPanelProps {
  selectedTables: Record<string, Set<string>>;
  activeProfiles: string[];
}

interface AiStatus {
  configured: boolean;
  provider?: string;
  model?: string;
}

interface AiSettingMeta {
  name: string;
  label: string;
  provider: string;
  configured: boolean;
}

export default function ChatPanel({ selectedTables, activeProfiles }: ChatPanelProps) {
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [aiStatus, setAiStatus] = useState<AiStatus>({ configured: false });
  const [statusLoading, setStatusLoading] = useState(true);
  const [allAiSettings, setAllAiSettings] = useState<AiSettingMeta[]>([]);
  const [profileMeta, setProfileMeta] = useState<Record<string, { aiSettings?: Array<{ name: string; label: string }> }>>({});
  const [selectedProfile, setSelectedProfile] = useState<string | null>(
    activeProfiles[0] ?? null,
  );
  const [selectedAi, setSelectedAi] = useState<string | undefined>(undefined);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const { isStreaming, currentText, toolStatus, error: streamError, send, abort } = useChatStream();

  // Load AI config status + the full list of AI settings (for the per-MCP picker)
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/ai-settings', { credentials: 'include' });
        const data = await res.json();
        if (data.success) {
          setAllAiSettings((data.settings ?? []) as AiSettingMeta[]);
          if (data.config) {
            setAiStatus({
              configured: data.config.configured,
              provider: data.config.provider,
              model: data.config.model,
            });
          }
        }
      } catch {
        // ignore
      } finally {
        setStatusLoading(false);
      }
    })();
  }, []);

  // Load each active profile's allowed AI settings (cached client-side)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: typeof profileMeta = {};
      await Promise.all(
        activeProfiles.map(async (name) => {
          try {
            const res = await fetch(`/api/chat-profile/${encodeURIComponent(name)}`, {
              credentials: 'include',
            });
            const data = await res.json();
            if (data.success && data.profile) {
              next[name] = { aiSettings: data.profile.aiSettings };
            }
          } catch {
            // ignore
          }
        }),
      );
      if (!cancelled) setProfileMeta(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProfiles]);

  // Compute the AI settings the user can pick from for the currently selected MCP
  const profileAiSettings: Array<{ name: string; label: string }> | undefined = selectedProfile
    ? profileMeta[selectedProfile]?.aiSettings
    : undefined;

  // Reset the AI selection when the profile changes
  useEffect(() => {
    setSelectedAi(profileAiSettings?.[0]?.name);
  }, [selectedProfile, profileAiSettings]);

  // Sync selectedProfile when activeProfiles changes (e.g. MCP server stopped mid-session)
  useEffect(() => {
    if (selectedProfile && !activeProfiles.includes(selectedProfile)) {
      setSelectedProfile(activeProfiles[0] ?? null);
    } else if (!selectedProfile && activeProfiles.length > 0) {
      setSelectedProfile(activeProfiles[0]);
    }
  }, [activeProfiles, selectedProfile]);

  // Auto-scroll only the chat messages container, not the whole page
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [chatMessages, currentText]);

  const canChat = aiStatus.configured && activeProfiles.length > 0;

  const handleChatSend = async () => {
    if (!chatInput.trim() || isStreaming || !canChat) return;

    const userMessage = chatInput.trim();
    setChatInput('');

    // Push user message + assistant placeholder
    setChatMessages((prev) => [
      ...prev,
      { role: 'user', content: userMessage },
      { role: 'assistant', content: '', streaming: true },
    ]);

    const body: Record<string, unknown> = {
      message: userMessage,
      ...(selectedProfile ? { profileName: selectedProfile } : {}),
      ...(selectedAi ? { aiSettingName: selectedAi } : {}),
      history: chatMessages,
      selectedTables: Object.fromEntries(
        Object.entries(selectedTables)
          .filter(([, cols]) => cols.size > 0)
          .map(([t, cols]) => [t, Array.from(cols)]),
      ),
    };

    await send(
      body,
      (text) => {
        setChatMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = { ...copy[copy.length - 1], content: text };
          return copy;
        });
      },
      (finalText, usageInfo) => {
        setChatMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = {
            role: 'assistant',
            content: finalText || `Error: ${streamError ?? 'could not reach the server.'}`,
            streaming: false,
            usage: usageInfo ?? undefined,
          };
          return copy;
        });
      },
    );
  };

  const providerLabel =
    aiStatus.provider === 'openrouter'
      ? 'OpenRouter'
      : aiStatus.provider === 'custom'
        ? 'Custom'
        : 'Anthropic';

  return (
    <div>
      <h2 className="heading-md mb-2">Chat with your database</h2>
      <p className="text-sm text-gray-400 mb-4">
        Ask questions in natural language. The AI will query your database using the MCP tools and
        answer.
      </p>

      {/* MCP profile selector */}
      {statusLoading ? (
        <div className="text-sm text-gray-500 mb-4">Loading...</div>
      ) : activeProfiles.length === 0 ? (
        <div className="mb-4 px-4 py-3 rounded-lg bg-amber-950/30 border border-amber-800/50 text-sm text-amber-400">
          No active MCP server. Start an MCP server first to use the chat.
        </div>
      ) : activeProfiles.length === 1 ? (
        <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800/50 border border-gray-700/50 text-sm">
          <div className="w-2 h-2 rounded-full bg-green-500 shadow-lg shadow-green-500/30" />
          <span className="text-gray-400">
            Testing against:{' '}
            <code className="text-gray-200 font-medium">{activeProfiles[0]}</code>
          </span>
        </div>
      ) : (
        <div className="mb-4 flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-800/50 border border-gray-700/50 text-sm">
          <span className="text-gray-400 shrink-0">Profile to test:</span>
          <DarkSelect
            ariaLabel="Profile to test"
            value={selectedProfile ?? ''}
            options={activeProfiles.map((name) => ({ value: name, label: name }))}
            onChange={(v) => setSelectedProfile(v)}
            className="flex-1"
          />
        </div>
      )}

      {/* AI Status / picker */}
      {!statusLoading && activeProfiles.length > 0 && (
        aiStatus.configured ? (
          profileAiSettings && profileAiSettings.length > 1 ? (
            <div className="mb-4 flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-800/50 border border-gray-700/50 text-sm">
              <span className="text-gray-400 shrink-0">AI:</span>
              <DarkSelect
                ariaLabel="AI provider"
                value={selectedAi ?? ''}
                options={profileAiSettings.map((s) => ({ value: s.name, label: s.label }))}
                onChange={(v) => setSelectedAi(v || undefined)}
                className="flex-1"
              />
              <span className="text-gray-600 text-xs">{profileAiSettings.length} available</span>
            </div>
          ) : (
            <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800/50 border border-gray-700/50 text-sm">
              <div className="w-2 h-2 rounded-full bg-green-500 shadow-lg shadow-green-500/30" />
              <span className="text-gray-400">
                Using{' '}
                <span className="text-gray-200 font-medium">
                  {profileAiSettings?.[0]?.label ?? providerLabel}
                </span>
                {aiStatus.model && !profileAiSettings?.[0] && (
                  <span className="text-gray-500"> / {aiStatus.model}</span>
                )}
              </span>
              <span className="text-gray-600 ml-auto text-xs">
                {allAiSettings.length > 1
                  ? 'Assign more in the MCP detail page'
                  : 'Configure in AI Settings'}
              </span>
            </div>
          )
        ) : (
          <div className="mb-4 px-4 py-3 rounded-lg bg-amber-950/30 border border-amber-800/50 text-sm text-amber-400">
            AI is not configured. Go to <span className="font-medium">AI Settings</span> to set up
            a provider and API key.
          </div>
        )
      )}

      {/* Chat area */}
      <div
        className="card-primary flex flex-col"
        style={{ height: '400px' }}
      >
        {/* Messages */}
        <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-4 space-y-3">
          {chatMessages.length === 0 && (
            <div className="text-center text-gray-500 text-sm mt-16">
              <p className="mb-2">Ask anything about your data</p>
              <div className="space-y-1 text-xs text-gray-600">
                <p>&quot;How many rows are in the users table?&quot;</p>
                <p>&quot;Show me the 5 most recent orders&quot;</p>
                <p>&quot;What tables are available?&quot;</p>
              </div>
            </div>
          )}

          {chatMessages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] px-4 py-2 rounded-lg text-sm ${
                  msg.role === 'user'
                    ? 'bg-os-700 text-white rounded-br-sm whitespace-pre-wrap'
                    : 'bg-gray-700/50 text-gray-200 rounded-bl-sm'
                }`}
              >
                {msg.role === 'user' ? (
                  msg.content
                ) : (
                  <>
                    {msg.streaming && !msg.content && !currentText ? (
                      <span className="inline-flex gap-1 items-center h-4">
                        <span className="w-1 h-1 rounded-full bg-gray-400 animate-bounce [animation-delay:-0.3s]" />
                        <span className="w-1 h-1 rounded-full bg-gray-400 animate-bounce [animation-delay:-0.15s]" />
                        <span className="w-1 h-1 rounded-full bg-gray-400 animate-bounce" />
                      </span>
                    ) : (
                      <MarkdownMessage content={msg.content || (msg.streaming ? currentText : '')} />
                    )}
                    {msg.streaming && toolStatus && (
                      <p className="text-xs text-gray-500 mt-1 italic">{toolStatus}</p>
                    )}
                    {!msg.streaming && msg.usage && (
                      <span className="text-xs text-zinc-500 mt-1 block">
                        {(msg.usage.input + msg.usage.output).toLocaleString()} tokens
                        {msg.usage.cacheRead
                          ? ` · cache ${Math.round((msg.usage.cacheRead / msg.usage.input) * 100)}%`
                          : ''}
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Input */}
        <div className="border-t border-white/5 p-3 flex gap-2">
          <input
            type="text"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleChatSend();
              }
            }}
            placeholder={
              activeProfiles.length === 0
                ? 'Start an MCP server first'
                : aiStatus.configured
                  ? 'Ask about your data...'
                  : 'Configure AI in Settings first'
            }
            disabled={!canChat || isStreaming}
            className="input-editorial flex-1 text-sm disabled:opacity-50"
          />
          {isStreaming ? (
            <button
              onClick={abort}
              className="px-4 py-2 bg-red-700 hover:bg-red-600 rounded-lg text-sm font-medium transition-colors"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={handleChatSend}
              disabled={!canChat || !chatInput.trim() || isStreaming}
              className="px-4 py-2 bg-os-700 hover:bg-os-600 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
