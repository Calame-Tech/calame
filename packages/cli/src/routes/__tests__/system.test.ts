import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Express, Request, Response } from 'express';
import { registerSystemRoute } from '../system.js';
import { AppState } from '../../state.js';
import type { ExecFileFn } from '../system.js';

// ---------------------------------------------------------------------------
// Minimal "captured app" harness — same pattern used across this repo's
// route tests: grab the registered handler and invoke it directly, no HTTP
// server. `execFileFn` is injected per-test so no real dialog ever spawns
// and no `child_process` mocking is needed (mirrors tunnel/manager.ts's DI
// style for the same reason).
// ---------------------------------------------------------------------------

function makeCapturedApp(): {
  app: Express;
  post: Map<string, (req: Request, res: Response) => unknown>;
} {
  const post = new Map<string, (req: Request, res: Response) => unknown>();
  const app = {
    post: vi.fn((path: string, handler: (req: Request, res: Response) => unknown) =>
      post.set(path, handler),
    ),
  } as unknown as Express;
  return { app, post };
}

interface FakeResponse {
  statusCode: number;
  body: unknown;
  res: Response;
}

function makeRes(): FakeResponse {
  const r: FakeResponse = { statusCode: 200, body: undefined, res: {} as Response };
  (r.res as unknown as { status: (s: number) => Response }).status = (s: number) => {
    r.statusCode = s;
    return r.res;
  };
  (r.res as unknown as { json: (b: unknown) => Response }).json = (b: unknown) => {
    r.body = b;
    return r.res;
  };
  return r;
}

async function callPickFolder(execFileFn: ExecFileFn) {
  const { app, post } = makeCapturedApp();
  registerSystemRoute(app, new AppState(), { execFileFn });
  const handler = post.get('/api/system/pick-folder');
  if (!handler) throw new Error('POST /api/system/pick-folder was not registered');
  const res = makeRes();
  await handler({} as Request, res.res);
  return res;
}

describe('POST /api/system/pick-folder', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform });
  }

  it('win32: returns the selected path and invokes powershell.exe with -STA', async () => {
    setPlatform('win32');
    const execFileFn = vi.fn(async () => ({ stdout: 'C:\\data\\kb\\produit\n' }));

    const res = await callPickFolder(execFileFn);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ path: 'C:\\data\\kb\\produit' });
    expect(execFileFn).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-STA', '-EncodedCommand']),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it('win32: empty stdout means the user cancelled — not an error', async () => {
    setPlatform('win32');
    const execFileFn = vi.fn(async () => ({ stdout: '' }));

    const res = await callPickFolder(execFileFn);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ path: null });
  });

  it('darwin: returns the selected path via osascript', async () => {
    setPlatform('darwin');
    const execFileFn = vi.fn(async () => ({ stdout: '/Users/me/data/kb\n' }));

    const res = await callPickFolder(execFileFn);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ path: '/Users/me/data/kb' });
    expect(execFileFn).toHaveBeenCalledWith(
      'osascript',
      ['-e', 'POSIX path of (choose folder)'],
      expect.anything(),
    );
  });

  it('darwin: "User canceled." is treated as a clean cancel, not a 500', async () => {
    setPlatform('darwin');
    const execFileFn = vi.fn(async () => {
      throw new Error('execution error: User canceled. (-128)');
    });

    const res = await callPickFolder(execFileFn);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ path: null });
  });

  it('darwin: a real failure still surfaces as a 500', async () => {
    setPlatform('darwin');
    const execFileFn = vi.fn(async () => {
      throw new Error('osascript: command not found');
    });

    const res = await callPickFolder(execFileFn);

    expect(res.statusCode).toBe(500);
  });

  it('linux: returns the selected path via zenity', async () => {
    setPlatform('linux');
    const execFileFn = vi.fn(async () => ({ stdout: '/home/me/data/kb\n' }));

    const res = await callPickFolder(execFileFn);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ path: '/home/me/data/kb' });
  });

  it('linux: a non-zero exit (Cancel) resolves to path: null, not an error', async () => {
    setPlatform('linux');
    const execFileFn = vi.fn(async () => {
      throw new Error('Command failed with exit code 1');
    });

    const res = await callPickFolder(execFileFn);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ path: null });
  });

  it('linux: a missing zenity binary (ENOENT) surfaces a clear 500, not a silent cancel', async () => {
    setPlatform('linux');
    const execFileFn = vi.fn(async () => {
      const err = new Error('spawn zenity ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    const res = await callPickFolder(execFileFn);

    expect(res.statusCode).toBe(500);
    expect((res.body as { error: string }).error).toContain('zenity is not installed');
  });

  it('unsupported platform: returns 501 without ever calling execFileFn', async () => {
    setPlatform('freebsd');
    const execFileFn = vi.fn();

    const res = await callPickFolder(execFileFn);

    expect(res.statusCode).toBe(501);
    expect(execFileFn).not.toHaveBeenCalled();
  });
});
