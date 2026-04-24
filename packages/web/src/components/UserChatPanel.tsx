import { useState, useRef, useEffect } from 'react';
import type { AccessMode } from '../types/schema.js';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
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
  const [chatLoading, setChatLoading] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [chatMessages]);

  // Reset messages when profile changes
  useEffect(() => {
    setChatMessages([]);
  }, [selectedProfile]);

  const handleChatSend = async () => {
    if (!chatInput.trim() || chatLoading || !selectedProfile) return;

    const userMessage = chatInput.trim();
    setChatInput('');
    setChatMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    setChatLoading(true);

    try {
      const res = await fetch('/api/auth/user-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          message: userMessage,
          history: chatMessages,
          profileName: selectedProfile,
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
                </span>
                {' '}Thinking...
              </div>
            </div>
          )}
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
            placeholder="Ask about your data..."
            disabled={chatLoading}
            className="input-editorial flex-1 text-sm disabled:opacity-50"
          />
          <button
            onClick={handleChatSend}
            disabled={!chatInput.trim() || chatLoading}
            className="px-4 py-2 bg-os-700 hover:bg-os-600 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
