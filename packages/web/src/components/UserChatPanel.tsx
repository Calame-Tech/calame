import { useState, useRef, useEffect } from 'react';
import type { AccessMode } from '../types/schema.js';
import { useChatStream } from '../hooks/useChatStream.js';
import type { UsageInfo } from '../hooks/useChatStream.js';
import MarkdownMessage from './MarkdownMessage.js';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  usage?: UsageInfo;
}

interface UserProfile {
  profileName: string;
  accessMode: AccessMode;
}

interface UserChatPanelProps {
  profiles: UserProfile[];
}

export default function UserChatPanel({ profiles }: UserChatPanelProps) {
  const chatProfiles = profiles.filter(
    (p) => p.accessMode === 'chat' || p.accessMode === 'both',
  );

  const [selectedProfile, setSelectedProfile] = useState(chatProfiles[0]?.profileName ?? '');
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const { isStreaming, currentText, toolStatus, error: streamError, send, abort } = useChatStream();

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [chatMessages, currentText]);

  // Reset messages when profile changes
  useEffect(() => {
    setChatMessages([]);
  }, [selectedProfile]);

  const handleChatSend = async () => {
    if (!chatInput.trim() || isStreaming || !selectedProfile) return;

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
      history: chatMessages,
      profileName: selectedProfile,
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

  if (chatProfiles.length === 0) return null;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <h2 className="heading-md">Chat with your database</h2>
        {chatProfiles.length > 1 && (
          <select
            value={selectedProfile}
            onChange={(e) => setSelectedProfile(e.target.value)}
            className="input-editorial text-sm"
          >
            {chatProfiles.map((p) => (
              <option key={p.profileName} value={p.profileName}>
                {p.profileName}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="card-primary flex flex-col flex-1 min-h-0">
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
                    {msg.streaming && !msg.content ? (
                      <span className="inline-flex gap-1 items-center h-4">
                        <span className="w-1 h-1 rounded-full bg-gray-400 animate-bounce [animation-delay:-0.3s]" />
                        <span className="w-1 h-1 rounded-full bg-gray-400 animate-bounce [animation-delay:-0.15s]" />
                        <span className="w-1 h-1 rounded-full bg-gray-400 animate-bounce" />
                      </span>
                    ) : (
                      <MarkdownMessage content={msg.content} />
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
          <textarea
            rows={1}
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleChatSend();
              }
            }}
            placeholder="Ask about your data..."
            disabled={isStreaming}
            className="input-editorial flex-1 text-sm disabled:opacity-50 resize-none overflow-hidden"
            style={{ minHeight: '38px', maxHeight: '160px' }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
            }}
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
              disabled={!chatInput.trim() || isStreaming}
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
