/**
 * Lifecycle manager for the "Expose for Copilot / ChatGPT" cloudflared quick
 * tunnel: spawns `cloudflared tunnel --url http://127.0.0.1:<port>`, parses
 * the public `https://*.trycloudflare.com` URL it prints once the tunnel is
 * up (see `./url-parser.ts`), and tracks the child process so it can be
 * stopped again (idempotently) — including on server shutdown, see
 * `../shutdown.ts`.
 *
 * One instance lives on `AppState.tunnelManager` (see `../state.ts`), created
 * lazily by `../routes/tunnel.ts`. The child-process layer is injected via
 * `TunnelManagerDeps.spawnFn` specifically so tests can exercise `start()` /
 * `stop()` / the timeout path without ever spawning a real `cloudflared`
 * process — mirrors the DI style used by the claude-desktop route tests
 * (inject a fake collaborator into the constructor / state, no `vi.mock`).
 *
 * Security note: the tunnel URL alone is safe to log at `info` level — MCP
 * endpoints behind it stay bearer-token protected, and the URL itself never
 * carries a token. Never append `req.headers.authorization` or a minted token
 * to any log line involving this URL.
 */

import { spawn as nodeSpawn } from 'child_process';
import type { Logger } from '../logger.js';
import { extractTunnelUrl } from './url-parser.js';
import type { CloudflaredResolution } from './cloudflared-resolve.js';

/** Minimal shape of a spawned cloudflared process — satisfied by Node's real
 *  `ChildProcess`, and easy to fake in tests without a real subprocess. */
export interface SpawnedTunnelProcess {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type TunnelSpawnFn = (command: string, args: string[]) => SpawnedTunnelProcess;

function defaultSpawnFn(command: string, args: string[]): SpawnedTunnelProcess {
  // `command` is never user-controllable: the only caller is TunnelManager.start(),
  // which passes the cloudflared binary path resolved from local configuration
  // (CALAME_CLOUDFLARED_PATH set by the desktop app / packaged sibling / dev
  // cache — see ./cloudflared-resolve.ts), and `args` is a fixed template around
  // the numeric server port. No HTTP request input ever reaches this call.
  // nosemgrep: javascript.lang.security.detect-child-process
  return nodeSpawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

export interface TunnelStatus {
  running: boolean;
  url: string | null;
  startedAt: string | null;
  available: boolean;
  unavailableReason: string | null;
}

export type TunnelStartResult =
  | { success: true; url: string }
  | { success: false; message: string };

export interface TunnelManagerDeps {
  /** Resolves the cloudflared binary path fresh on every call (env/config can't change at runtime, but re-resolving is cheap and keeps this decoupled from a snapshot taken at construction time). */
  resolveCloudflaredPath: () => CloudflaredResolution;
  /** The local port the tunnel should forward `http://127.0.0.1:<port>` to. */
  getLocalPort: () => number;
  /** Injectable child-process spawn — defaults to `child_process.spawn`. Tests supply a fake. */
  spawnFn?: TunnelSpawnFn;
  logger?: Logger;
  /** Max time to wait for cloudflared to report a URL before killing it and failing. Default 30000ms per the API contract. */
  startTimeoutMs?: number;
  /** Number of recent output lines to retain for diagnostics. Default 50. */
  ringSize?: number;
}

const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_RING_SIZE = 50;

export class TunnelManager {
  private readonly resolveCloudflaredPathFn: () => CloudflaredResolution;
  private readonly getLocalPort: () => number;
  private readonly spawnFn: TunnelSpawnFn;
  private readonly logger?: Logger;
  private readonly startTimeoutMs: number;
  private readonly ringSize: number;

  private child: SpawnedTunnelProcess | null = null;
  private url: string | null = null;
  private startedAt: string | null = null;
  private ring: string[] = [];
  // Serializes concurrent start() calls (e.g. a double-click) onto the same
  // in-flight attempt instead of racing two cloudflared spawns.
  private startInFlight: Promise<TunnelStartResult> | null = null;

  constructor(deps: TunnelManagerDeps) {
    this.resolveCloudflaredPathFn = deps.resolveCloudflaredPath;
    this.getLocalPort = deps.getLocalPort;
    this.spawnFn = deps.spawnFn ?? defaultSpawnFn;
    this.logger = deps.logger;
    this.startTimeoutMs = deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.ringSize = deps.ringSize ?? DEFAULT_RING_SIZE;
  }

  /** Contract: GET /api/tunnel/status body (minus `success`). */
  getStatus(): TunnelStatus {
    const resolution = this.resolveCloudflaredPathFn();
    return {
      running: this.child !== null && this.url !== null,
      url: this.url,
      startedAt: this.startedAt,
      available: resolution.available,
      unavailableReason: resolution.unavailableReason,
    };
  }

  /** Last ~`ringSize` output lines (stdout+stderr interleaved), newest last. */
  getOutputTail(): string {
    return this.ring.join('\n');
  }

  private pushOutputLine(line: string): void {
    if (line.length === 0) return;
    this.ring.push(line);
    if (this.ring.length > this.ringSize) this.ring.shift();
  }

  /**
   * Start the tunnel. Idempotent: if already running, resolves immediately
   * with the current URL rather than spawning a second cloudflared process.
   */
  async start(): Promise<TunnelStartResult> {
    if (this.child && this.url) {
      return { success: true, url: this.url };
    }
    if (this.startInFlight) return this.startInFlight;

    const resolution = this.resolveCloudflaredPathFn();
    if (!resolution.path) {
      return {
        success: false,
        message: resolution.unavailableReason ?? 'cloudflared binary is not available.',
      };
    }

    this.startInFlight = this.spawnAndWaitForUrl(resolution.path);
    try {
      return await this.startInFlight;
    } finally {
      this.startInFlight = null;
    }
  }

  private spawnAndWaitForUrl(cloudflaredPath: string): Promise<TunnelStartResult> {
    return new Promise((resolve) => {
      const port = this.getLocalPort();
      const args = ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'];
      this.ring = [];

      let child: SpawnedTunnelProcess;
      try {
        child = this.spawnFn(cloudflaredPath, args);
      } catch (err) {
        resolve({
          success: false,
          message: `Failed to spawn cloudflared: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const tail = this.getOutputTail();
        this.killChild(child);
        this.child = null;
        resolve({
          success: false,
          message: `Timed out waiting for cloudflared to report a tunnel URL after ${this.startTimeoutMs}ms.\n${tail}`,
        });
      }, this.startTimeoutMs);

      const onChunk = (chunk: Buffer | string): void => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) this.pushOutputLine(line);

        if (settled) return;
        const foundUrl = extractTunnelUrl(text);
        if (foundUrl) {
          settled = true;
          clearTimeout(timer);
          this.url = foundUrl;
          this.startedAt = new Date().toISOString();
          // Safe to log at info: the URL never carries the bearer token —
          // see module docstring.
          this.logger?.info(`Tunnel is up: ${foundUrl}`, { component: 'tunnel' });
          resolve({ success: true, url: foundUrl });
        }
      };
      child.stdout?.on('data', onChunk);
      child.stderr?.on('data', onChunk);

      child.on('error', (err: Error) => {
        if (settled) {
          this.child = null;
          this.url = null;
          this.startedAt = null;
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.child = null;
        resolve({ success: false, message: `cloudflared process error: ${err.message}` });
      });

      child.on('exit', (code) => {
        this.logger?.info(`cloudflared exited (code ${code ?? 'null'})`, { component: 'tunnel' });
        this.child = null;
        this.url = null;
        this.startedAt = null;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({
            success: false,
            message: `cloudflared exited before reporting a tunnel URL (code ${code ?? 'null'}).\n${this.getOutputTail()}`,
          });
        }
      });

      this.child = child;
    });
  }

  private killChild(child: SpawnedTunnelProcess): void {
    try {
      child.kill();
    } catch {
      // Best-effort — the process may already be gone.
    }
  }

  /** Stop the tunnel. Idempotent — a no-op when nothing is running. */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.url = null;
    this.startedAt = null;
    if (!child) return;
    this.killChild(child);
  }
}
