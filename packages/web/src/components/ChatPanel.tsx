import { useState, useRef, useEffect } from 'react';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
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

export default function ChatPanel({ selectedTables, activeProfiles }: ChatPanelProps) {
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [aiStatus, setAiStatus] = useState<AiStatus>({ configured: false });
  const [statusLoading, setStatusLoading] = useState(true);
  const [selectedProfile, setSelectedProfile] = useState<string | null>(
    activeProfiles[0] ?? null,
  );
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Load AI config status
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/ai-settings', { credentials: 'include' });
        const data = await res.json();
        if (data.success && data.config) {
          setAiStatus({
            configured: data.config.configured,
            provider: data.config.provider,
            model: data.config.model,
          });
        }
      } catch {
        // ignore
      } finally {
        setStatusLoading(false);
      }
    })();
  }, []);

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
  }, [chatMessages]);

  const canChat = aiStatus.configured && activeProfiles.length > 0;

  const handleChatSend = async () => {
    if (!chatInput.trim() || chatLoading || !canChat) return;

    const userMessage = chatInput.trim();
    setChatInput('');
    setChatMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    setChatLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          message: userMessage,
          ...(selectedProfile ? { profileName: selectedProfile } : {}),
          history: chatMessages,
          selectedTables: Object.fromEntries(
            Object.entries(selectedTables)
              .filter(([, cols]) => cols.size > 0)
              .map(([t, cols]) => [t, Array.from(cols)]),
          ),
        }),
      });
      const data = await res.json();

      if (data.success) {
        setChatMessages((prev) => [
          ...prev,
          { role: 'assistant', content: data.response },
        ]);
      } else {
        setChatMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `Error: ${data.message}` },
        ]);
      }
    } catch {
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: 'Error: could not reach the server.' },
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  const providerLabel =
    aiStatus.provider === 'openrouter'
      ? 'OpenRouter'
      : aiStatus.provider === 'custom'
        ? 'Custom'
        : 'Anthropic';

  return (
    <div>
      <h2 className="text-xl font-semibold mb-2">Chat with your database</h2>
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
          <label htmlFor="chat-profile-select" className="text-gray-400 shrink-0">
            Profile to test:
          </label>
          <select
            id="chat-profile-select"
            value={selectedProfile ?? ''}
            onChange={(e) => setSelectedProfile(e.target.value)}
            className="flex-1 px-3 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-gray-100 text-sm focus:outline-none focus:border-os-500"
          >
            {activeProfiles.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* AI Status */}
      {!statusLoading && activeProfiles.length > 0 && (
        aiStatus.configured ? (
          <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800/50 border border-gray-700/50 text-sm">
            <div className="w-2 h-2 rounded-full bg-green-500 shadow-lg shadow-green-500/30" />
            <span className="text-gray-400">
              Using <span className="text-gray-200 font-medium">{providerLabel}</span>
              {aiStatus.model && <span className="text-gray-500"> / {aiStatus.model}</span>}
            </span>
            <span className="text-gray-600 ml-auto text-xs">Configure in AI Settings</span>
          </div>
        ) : (
          <div className="mb-4 px-4 py-3 rounded-lg bg-amber-950/30 border border-amber-800/50 text-sm text-amber-400">
            AI is not configured. Go to <span className="font-medium">AI Settings</span> to set up
            a provider and API key.
          </div>
        )
      )}

      {/* Chat area */}
      <div
        className="rounded-lg border border-gray-700 bg-gray-800/30 flex flex-col"
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
                className={`max-w-[80%] px-4 py-2 rounded-lg text-sm whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'bg-os-700 text-white rounded-br-sm'
                    : 'bg-gray-700/50 text-gray-200 rounded-bl-sm'
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}

          {chatLoading && (
            <div className="flex justify-start">
              <div className="bg-gray-700/50 text-gray-400 px-4 py-2 rounded-lg rounded-bl-sm text-sm">
                <span className="inline-flex gap-1">
                  <span className="animate-bounce" style={{ animationDelay: '0ms' }}>
                    .
                  </span>
                  <span className="animate-bounce" style={{ animationDelay: '150ms' }}>
                    .
                  </span>
                  <span className="animate-bounce" style={{ animationDelay: '300ms' }}>
                    .
                  </span>
                </span>{' '}
                Querying your database...
              </div>
            </div>
          )}
        </div>

        {/* Input */}
        <div className="border-t border-gray-700 p-3 flex gap-2">
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
            disabled={!canChat || chatLoading}
            className="flex-1 px-3 py-2 rounded-lg bg-gray-900 border border-gray-700 text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:border-os-500 disabled:opacity-50"
          />
          <button
            onClick={handleChatSend}
            disabled={!canChat || !chatInput.trim() || chatLoading}
            className="px-4 py-2 bg-os-700 hover:bg-os-600 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
