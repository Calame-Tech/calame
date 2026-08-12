import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TunnelManager,
  type SpawnedTunnelProcess,
  type TunnelSpawnFn,
  type TunnelManagerDeps,
} from '../manager.js';
import type { CloudflaredResolution } from '../cloudflared-resolve.js';

// ---------------------------------------------------------------------------
// Fake child-process layer — never spawns a real cloudflared process. Mirrors
// the DI style used by the claude-desktop route tests (inject a fake
// collaborator, no vi.mock of node builtins).
// ---------------------------------------------------------------------------

class FakeStream {
  private listeners: Array<(chunk: Buffer | string) => void> = [];
  on(event: 'data', listener: (chunk: Buffer | string) => void): void {
    if (event === 'data') this.listeners.push(listener);
  }
  emit(chunk: string): void {
    for (const l of this.listeners) l(chunk);
  }
}

class FakeChild implements SpawnedTunnelProcess {
  stdout = new FakeStream();
  stderr = new FakeStream();
  kill = vi.fn(() => true);
  private errorListeners: Array<(err: Error) => void> = [];
  private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

  on(event: 'error' | 'exit', listener: (...args: never[]) => void): void {
    if (event === 'error') this.errorListeners.push(listener as (err: Error) => void);
    if (event === 'exit')
      this.exitListeners.push(
        listener as (code: number | null, signal: NodeJS.Signals | null) => void,
      );
  }
  emitError(err: Error): void {
    for (const l of this.errorListeners) l(err);
  }
  emitExit(code: number | null): void {
    for (const l of this.exitListeners) l(code, null);
  }
}

function availableResolution(overridePath = '/fake/cloudflared'): CloudflaredResolution {
  return { path: overridePath, available: true, unavailableReason: null };
}

function unavailableResolution(reason = 'cloudflared not found'): CloudflaredResolution {
  return { path: null, available: false, unavailableReason: reason };
}

describe('TunnelManager', () => {
  let children: FakeChild[];
  let spawnFn: TunnelSpawnFn;
  let spawnCalls: Array<{ command: string; args: string[] }>;

  beforeEach(() => {
    children = [];
    spawnCalls = [];
    spawnFn = (command, args) => {
      spawnCalls.push({ command, args });
      const child = new FakeChild();
      children.push(child);
      return child;
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeManager(overrides: Partial<TunnelManagerDeps> = {}): TunnelManager {
    return new TunnelManager({
      resolveCloudflaredPath: () => availableResolution(),
      getLocalPort: () => 4567,
      spawnFn,
      startTimeoutMs: 30_000,
      ringSize: 50,
      ...overrides,
    });
  }

  it('spawns cloudflared with the documented args and resolves once the URL appears on stdout', async () => {
    const manager = makeManager({ getLocalPort: () => 4567 });
    const startPromise = manager.start();

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toEqual({
      command: '/fake/cloudflared',
      args: ['tunnel', '--url', 'http://127.0.0.1:4567', '--no-autoupdate'],
    });

    children[0].stdout.emit(
      '2024-01-01T12:00:00Z INF |  https://random-words-1234.trycloudflare.com  |\n',
    );

    const result = await startPromise;
    expect(result).toEqual({ success: true, url: 'https://random-words-1234.trycloudflare.com' });

    const status = manager.getStatus();
    expect(status.running).toBe(true);
    expect(status.url).toBe('https://random-words-1234.trycloudflare.com');
    expect(status.startedAt).not.toBeNull();
    expect(new Date(status.startedAt as string).toString()).not.toBe('Invalid Date');
  });

  it('parses the URL from stderr just as well as stdout', async () => {
    const manager = makeManager();
    const startPromise = manager.start();
    children[0].stderr.emit('https://another-one.trycloudflare.com');
    const result = await startPromise;
    expect(result).toEqual({ success: true, url: 'https://another-one.trycloudflare.com' });
  });

  it('is idempotent: a second start() while running returns the same URL without spawning again', async () => {
    const manager = makeManager();
    const first = manager.start();
    children[0].stdout.emit('https://one.trycloudflare.com');
    await first;

    const second = await manager.start();
    expect(second).toEqual({ success: true, url: 'https://one.trycloudflare.com' });
    expect(spawnCalls).toHaveLength(1);
  });

  it('coalesces concurrent start() calls onto a single in-flight spawn', async () => {
    const manager = makeManager();
    const p1 = manager.start();
    const p2 = manager.start();
    children[0].stdout.emit('https://race.trycloudflare.com');

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ success: true, url: 'https://race.trycloudflare.com' });
    expect(r2).toEqual(r1);
    expect(spawnCalls).toHaveLength(1);
  });

  it('reports unavailable without spawning when cloudflared cannot be resolved', async () => {
    const manager = makeManager({
      resolveCloudflaredPath: () => unavailableResolution('no binary staged'),
    });
    const result = await manager.start();
    expect(result).toEqual({ success: false, message: 'no binary staged' });
    expect(spawnCalls).toHaveLength(0);
  });

  it('kills the process and fails with a captured output tail on timeout', async () => {
    vi.useFakeTimers();
    const manager = makeManager({ startTimeoutMs: 30_000, ringSize: 3 });
    const startPromise = manager.start();

    children[0].stdout.emit('line 1');
    children[0].stdout.emit('line 2');
    children[0].stdout.emit('line 3');
    children[0].stdout.emit('line 4');
    children[0].stdout.emit('line 5'); // no URL ever appears

    await vi.advanceTimersByTimeAsync(30_000);
    const result = await startPromise;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toContain('Timed out waiting for cloudflared');
      // Ring buffer trimmed to the last 3 lines only.
      expect(result.message).not.toContain('line 1');
      expect(result.message).not.toContain('line 2');
      expect(result.message).toContain('line 3');
      expect(result.message).toContain('line 4');
      expect(result.message).toContain('line 5');
    }
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    expect(manager.getStatus().running).toBe(false);
  });

  it('fails with a clear message when cloudflared exits before printing a URL', async () => {
    const manager = makeManager();
    const startPromise = manager.start();
    children[0].stdout.emit('some early diagnostic output');
    children[0].emitExit(1);

    const result = await startPromise;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toContain('exited before reporting a tunnel URL');
      expect(result.message).toContain('code 1');
    }
    expect(manager.getStatus().running).toBe(false);
  });

  it('fails cleanly when the spawn call itself throws', async () => {
    const throwingSpawn: TunnelSpawnFn = () => {
      throw new Error('ENOENT: spawn failed');
    };
    const manager = makeManager({ spawnFn: throwingSpawn });
    const result = await manager.start();
    expect(result).toEqual({
      success: false,
      message: 'Failed to spawn cloudflared: ENOENT: spawn failed',
    });
  });

  it('stop() kills the running process and is idempotent', async () => {
    const manager = makeManager();
    const startPromise = manager.start();
    children[0].stdout.emit('https://stoppable.trycloudflare.com');
    await startPromise;

    await manager.stop();
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    expect(manager.getStatus()).toMatchObject({ running: false, url: null, startedAt: null });

    // Calling stop() again with nothing running must not throw or re-kill.
    await manager.stop();
    expect(children[0].kill).toHaveBeenCalledTimes(1);
  });

  it('stop() before any start() is a safe no-op', async () => {
    const manager = makeManager();
    await expect(manager.stop()).resolves.toBeUndefined();
    expect(manager.getStatus().running).toBe(false);
  });

  it('getStatus() surfaces availability/unavailableReason from the resolver even while idle', () => {
    const manager = makeManager({
      resolveCloudflaredPath: () => unavailableResolution('no binary staged'),
    });
    const status = manager.getStatus();
    expect(status).toEqual({
      running: false,
      url: null,
      startedAt: null,
      available: false,
      unavailableReason: 'no binary staged',
    });
  });

  it('a fresh start() after stop() spawns a brand new process', async () => {
    const manager = makeManager();
    const first = manager.start();
    children[0].stdout.emit('https://first.trycloudflare.com');
    await first;
    await manager.stop();

    const second = manager.start();
    expect(spawnCalls).toHaveLength(2);
    children[1].stdout.emit('https://second.trycloudflare.com');
    const result = await second;
    expect(result).toEqual({ success: true, url: 'https://second.trycloudflare.com' });
  });
});
