// "Remote access — Copilot & ChatGPT" section on the MCP server detail page.
//
// Cloud AI platforms (Microsoft 365 Copilot via Copilot Studio, ChatGPT
// connectors) run in the cloud and can't reach an MCP server sitting on this
// machine. This component starts/stops the backend's embedded Cloudflare
// quick tunnel and walks the admin through wiring the resulting public URL
// into each platform. Mirrors ConnectClaudeDesktop.tsx's fetch/copy/error
// conventions.

import { useState, useCallback, useEffect } from 'react';
import { apiFetch, getCurrentTenant } from '../lib/api.js';
import { buildMcpUrl } from '../lib/mcp-url.js';
import HelpTip from './HelpTip.js';

interface TunnelStatus {
  success: boolean;
  running: boolean;
  url: string | null;
  startedAt: string | null;
  available: boolean;
  unavailableReason: string | null;
}

interface ExposeTunnelProps {
  profileName: string;
}

/** Copy-to-clipboard pill for a single URL value, with its own "Copied!" feedback. */
function CopyableUrl({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-900/60 border border-gray-700 hover:border-os-600 transition-all duration-200 group max-w-full"
    >
      <code className="text-sm text-os-400 font-mono truncate">{value}</code>
      <span className="text-xs text-gray-500 group-hover:text-os-400 transition-all duration-200 flex-shrink-0">
        {copied ? 'Copied!' : 'Copy'}
      </span>
    </button>
  );
}

export default function ExposeTunnel({ profileName }: ExposeTunnelProps) {
  const [status, setStatus] = useState<TunnelStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  const [copilotGuideOpen, setCopilotGuideOpen] = useState(false);
  const [chatGptGuideOpen, setChatGptGuideOpen] = useState(false);

  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const res = await apiFetch('/api/tunnel/status');
      const data = await res.json();
      if (data.success !== false) {
        setStatus(data);
      } else {
        setStatusError(data.message || 'Failed to check the tunnel status.');
      }
    } catch {
      setStatusError('Network error checking the tunnel status.');
    } finally {
      setStatusLoading(false);
    }
  }, []);

  // Fetched once on mount — no polling interval; the status is refreshed
  // explicitly after the start/stop calls resolve instead.
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleStart = async () => {
    setStarting(true);
    setStartError(null);
    try {
      const res = await apiFetch('/api/tunnel/start', { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        setStartError(data.message || 'Failed to open the tunnel.');
      }
    } catch {
      setStartError('Network error opening the tunnel.');
    } finally {
      setStarting(false);
      fetchStatus().catch(() => {});
    }
  };

  const handleStop = async () => {
    setStopping(true);
    setStopError(null);
    try {
      const res = await apiFetch('/api/tunnel/stop', { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        setStopError(data.message || 'Failed to stop the tunnel.');
      }
    } catch {
      setStopError('Network error stopping the tunnel.');
    } finally {
      setStopping(false);
      fetchStatus().catch(() => {});
    }
  };

  const tenant = getCurrentTenant();
  const mcpUrl =
    status?.running && status.url ? buildMcpUrl(status.url, profileName, tenant) : null;

  return (
    <div className="card-primary p-4">
      <div className="flex items-center gap-2 mb-1">
        <h4 className="text-sm font-semibold text-gray-300">Remote access — Copilot & ChatGPT</h4>
        <HelpTip
          content="Cloud AI platforms like Microsoft 365 Copilot and ChatGPT run in the cloud and can't reach a server on this machine directly. This opens a secure Cloudflare tunnel so they can connect to this MCP server over the public internet."
          position="right"
          size="xs"
        />
      </div>
      <p className="text-xs text-gray-600 mb-3">
        The public URL changes every time the tunnel restarts, and this machine needs to stay on and
        connected for it to keep working. Intended for evaluation — use a server deployment of
        Calame for production.
      </p>
      <p className="text-xs text-gray-600 mb-3">
        Privacy: your files and database never leave this machine — only the content of MCP requests
        and responses transits, encrypted, through Cloudflare&apos;s network (and every endpoint
        still requires your API token). For a setup where traffic terminates on your own
        infrastructure, use a server deployment. See docs/security-tunnel.md for the full threat
        model.
      </p>

      {statusLoading ? (
        <p className="text-sm text-gray-500">Checking tunnel status…</p>
      ) : statusError ? (
        <div className="p-3 rounded-lg bg-red-950/30 border border-red-800/50 text-red-400 text-sm">
          {statusError}
        </div>
      ) : status && !status.available ? (
        <p className="text-sm text-gray-500">
          {status.unavailableReason || 'Remote access is not available on this instance.'}
        </p>
      ) : status?.running && mcpUrl ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-green-500 shadow-lg shadow-green-500/30" />
            <span className="text-sm font-medium text-green-400">Tunnel active</span>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">MCP URL for this server</p>
            <CopyableUrl value={mcpUrl} />
          </div>
          <p className="text-xs text-gray-500">
            This endpoint still requires an API token — create one in the API Keys tab above.
          </p>
          {stopError && (
            <div className="p-3 rounded-lg bg-red-950/30 border border-red-800/50 text-red-400 text-sm">
              {stopError}
            </div>
          )}
          <button
            type="button"
            onClick={handleStop}
            disabled={stopping}
            className="px-4 py-2 rounded-lg bg-red-600/20 text-red-400 hover:bg-red-600/30 text-sm font-medium transition-all duration-200 disabled:opacity-50"
          >
            {stopping ? 'Stopping…' : 'Stop tunnel'}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <button
            type="button"
            onClick={handleStart}
            disabled={starting}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-os-700 hover:bg-os-600 text-white text-sm font-medium transition-all duration-200 disabled:opacity-50"
          >
            {starting && (
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            )}
            {starting ? 'Opening secure tunnel… (up to 30 s)' : 'Expose this server'}
          </button>
          {startError && (
            <div className="p-3 rounded-lg bg-red-950/30 border border-red-800/50 text-red-400 text-sm">
              {startError}
            </div>
          )}
        </div>
      )}

      {/* Step-by-step guides — always available so an admin can read ahead
          before starting the tunnel. Same disclosure pattern as
          ConnectClaudeDesktop's "Other clients / another machine". */}
      <div className="mt-3 pt-3 border-t border-white/5 space-y-3">
        <div>
          <button
            type="button"
            onClick={() => setCopilotGuideOpen((v) => !v)}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            aria-expanded={copilotGuideOpen}
          >
            Microsoft Copilot (Copilot Studio)
          </button>
          {copilotGuideOpen && (
            <ol className="mt-2 space-y-1.5 text-xs text-gray-500 list-decimal list-inside">
              <li>In Copilot Studio: Tools → Add a tool → New tool → Model Context Protocol.</li>
              <li>
                Paste the Server URL:
                {mcpUrl ? (
                  <div className="mt-1">
                    <CopyableUrl value={mcpUrl} />
                  </div>
                ) : (
                  <span className="text-gray-600"> start the tunnel above to get this URL.</span>
                )}
              </li>
              <li>Authentication: API key. Location: Query. Parameter name: token.</li>
              <li>
                Paste your Calame API token (create one in the API Keys tab above), then Create.
              </li>
              <li>Add the new tool to your agent.</li>
            </ol>
          )}
        </div>
        <div>
          <button
            type="button"
            onClick={() => setChatGptGuideOpen((v) => !v)}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            aria-expanded={chatGptGuideOpen}
          >
            ChatGPT (developer mode connectors)
          </button>
          {chatGptGuideOpen && (
            <ol className="mt-2 space-y-1.5 text-xs text-gray-500 list-decimal list-inside">
              <li>In ChatGPT: Settings → Connectors → Add custom connector.</li>
              <li>
                Paste the URL:
                {mcpUrl ? (
                  <div className="mt-1">
                    <CopyableUrl value={mcpUrl} />
                  </div>
                ) : (
                  <span className="text-gray-600"> start the tunnel above to get this URL.</span>
                )}
              </li>
              <li>
                ChatGPT has no separate auth field here — it requires the token in the URL itself:
                append &quot;?token=&lt;your token&gt;&quot; to the URL above.
              </li>
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
