// "Connect your AI" section on the MCP server detail page (Phase D).
//
// Lets an admin one-click wire this MCP profile into their local Claude
// Desktop's claude_desktop_config.json (when Calame can detect + write it),
// and always offers a manual npx-based snippet for other clients or
// machines. Mirrors TokenManager.tsx's fetch/copy/error conventions.

import { useState, useCallback, useEffect } from 'react';
import { apiFetch, getCurrentTenant } from '../lib/api.js';
import HelpTip from './HelpTip.js';

interface ClaudeDesktopStatusEntry {
  key: string;
  profileName: string | null;
}

interface ClaudeDesktopStatus {
  success: boolean;
  supported: boolean;
  detected: boolean;
  configPath: string | null;
  entries: ClaudeDesktopStatusEntry[];
  message?: string;
}

interface ConnectClaudeDesktopProps {
  profileName: string;
}

export default function ConnectClaudeDesktop({ profileName }: ConnectClaudeDesktopProps) {
  const [status, setStatus] = useState<ClaudeDesktopStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectResult, setConnectResult] = useState<{ configPath: string } | null>(null);

  const [snippetOpen, setSnippetOpen] = useState(false);
  const [snippet, setSnippet] = useState<string | null>(null);
  const [snippetLoading, setSnippetLoading] = useState(false);
  const [snippetError, setSnippetError] = useState<string | null>(null);
  const [snippetCopied, setSnippetCopied] = useState(false);

  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const res = await apiFetch('/api/integrations/claude-desktop/status');
      const data = await res.json();
      if (data.success !== false) {
        setStatus(data);
      } else {
        setStatusError(data.message || 'Failed to check Claude Desktop status.');
      }
    } catch {
      setStatusError('Network error checking Claude Desktop status.');
    } finally {
      setStatusLoading(false);
    }
  }, []);

  // Fetched eagerly on mount — this section lives in the default-visible
  // "Exposed Data" tab of the MCP detail page, so mount time is effectively
  // "when the section becomes visible".
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const alreadyConnected = (status?.entries ?? []).some(
    (entry) => entry.profileName === profileName,
  );

  const handleConnect = async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      const tenant = getCurrentTenant();
      const body: { profileName: string; tenantId?: string } = { profileName };
      if (tenant !== 'default') body.tenantId = tenant;
      const res = await apiFetch('/api/integrations/claude-desktop/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setConnectResult({ configPath: data.configPath });
        fetchStatus().catch(() => {});
      } else {
        setConnectError(data.message || 'Failed to connect to Claude Desktop.');
      }
    } catch {
      setConnectError('Network error connecting to Claude Desktop.');
    } finally {
      setConnecting(false);
    }
  };

  const fetchSnippet = async () => {
    setSnippetLoading(true);
    setSnippetError(null);
    try {
      const tenant = getCurrentTenant();
      const params = new URLSearchParams({ profileName });
      if (tenant !== 'default') params.set('tenantId', tenant);
      const res = await apiFetch(`/api/integrations/claude-desktop/snippet?${params.toString()}`);
      const data = await res.json();
      if (data.success) {
        setSnippet(data.snippet ?? '');
      } else {
        setSnippetError(data.message || 'Failed to load the manual configuration snippet.');
      }
    } catch {
      setSnippetError('Network error loading the manual configuration snippet.');
    } finally {
      setSnippetLoading(false);
    }
  };

  const handleToggleSnippet = () => {
    const next = !snippetOpen;
    setSnippetOpen(next);
    if (next && snippet === null && !snippetLoading) {
      fetchSnippet().catch(() => {});
    }
  };

  const handleCopySnippet = () => {
    if (!snippet) return;
    navigator.clipboard.writeText(snippet).then(() => {
      setSnippetCopied(true);
      setTimeout(() => setSnippetCopied(false), 2000);
    });
  };

  return (
    <div className="card-primary p-4">
      <div className="flex items-center gap-2 mb-3">
        <h4 className="text-sm font-semibold text-gray-300">Connect your AI</h4>
        <HelpTip
          content="Wire this MCP server into Claude Desktop, or grab a manual snippet for other MCP clients."
          position="right"
          size="xs"
        />
      </div>

      {statusLoading ? (
        <p className="text-sm text-gray-500">Checking for Claude Desktop…</p>
      ) : statusError ? (
        <div className="p-3 rounded-lg bg-red-950/30 border border-red-800/50 text-red-400 text-sm">
          {statusError}
        </div>
      ) : status?.supported && status.detected ? (
        <div className="space-y-2">
          {connectResult ? (
            <div className="p-3 rounded-lg border border-green-700/30 bg-green-900/10">
              <p className="text-sm text-green-400 font-medium">
                Connected — restart Claude Desktop to see your tools.
              </p>
              <p className="text-xs text-gray-500 mt-1">{connectResult.configPath}</p>
            </div>
          ) : alreadyConnected ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-gray-500">Already connected to Claude Desktop</p>
              <button
                type="button"
                onClick={handleConnect}
                disabled={connecting}
                className="text-xs text-os-400 hover:text-os-300 transition-colors disabled:opacity-50 flex-shrink-0"
              >
                {connecting ? 'Reconfiguring…' : 'Reconfigure'}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleConnect}
              disabled={connecting}
              className="px-4 py-2 rounded-lg bg-os-700 hover:bg-os-600 text-white text-sm font-medium transition-all duration-200 disabled:opacity-50"
            >
              {connecting ? 'Connecting…' : 'Connect to Claude Desktop'}
            </button>
          )}
          {connectError && (
            <div className="p-3 rounded-lg bg-red-950/30 border border-red-800/50 text-red-400 text-sm">
              {connectError}
            </div>
          )}
        </div>
      ) : status?.supported ? (
        <p className="text-sm text-gray-500">Claude Desktop wasn&apos;t found on this machine.</p>
      ) : null}

      {/* Manual fallback — always available, secondary/collapsed by default.
          Only add the top divider when something rendered above it (i.e. not
          the "unsupported" case, which renders nothing else). */}
      <div
        className={
          statusLoading || statusError || status?.supported
            ? 'mt-3 pt-3 border-t border-white/5'
            : ''
        }
      >
        <button
          type="button"
          onClick={handleToggleSnippet}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          aria-expanded={snippetOpen}
        >
          Other clients / another machine
        </button>
        {snippetOpen && (
          <div className="mt-2 space-y-2">
            <p className="text-xs text-gray-600">
              Replace <code className="text-gray-500">&lt;YOUR-CALAME-HOST&gt;</code> and{' '}
              <code className="text-gray-500">&lt;TOKEN&gt;</code> with your Calame host and an API
              key.
            </p>
            {snippetLoading ? (
              <p className="text-xs text-gray-500">Loading…</p>
            ) : snippetError ? (
              <p className="text-xs text-red-400">{snippetError}</p>
            ) : snippet ? (
              <div className="relative">
                <pre className="p-3 rounded bg-gray-900 border border-gray-700 text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre">
                  {snippet}
                </pre>
                <button
                  type="button"
                  onClick={handleCopySnippet}
                  className="absolute top-2 right-2 px-2 py-1 text-xs rounded border border-gray-600 text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors"
                >
                  {snippetCopied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
