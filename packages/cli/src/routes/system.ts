/**
 * Native folder picker — lets the UI ask the machine running the Calame
 * server to show its OS folder-browse dialog, instead of requiring the user
 * to type an absolute path by hand (e.g. when configuring a local-folder RAG
 * source). Correct for the desktop app (UI and server are the same machine)
 * and for anyone running the server on their own workstation; on a headless
 * server deployment there is no display to show a dialog on, so the picker
 * fails gracefully and the UI falls back to manual path entry.
 *
 * Deliberately NOT implemented via Tauri's JS dialog plugin: the desktop
 * app's window navigates away from its bundled asset to the Node sidecar's
 * `http://127.0.0.1:<port>` (see apps/desktop/src-tauri/src/server.rs) and
 * `dangerousRemoteDomainIpcAccess` is not configured, so the Tauri IPC
 * bridge is not reliably available on the page the user actually sees.
 * Shelling out to a native OS dialog from the same Node process that already
 * serves the UI works identically in the desktop app, a plain browser
 * pointed at a local dev server, or a server deployment reached from the
 * same machine — no IPC bridge dependency at all.
 *
 * The child-process layer is injected via `SystemRouteDeps.execFileFn`
 * specifically so tests can exercise every branch without ever spawning a
 * real dialog — mirrors the DI style already used by tunnel/manager.ts's
 * `spawnFn` (inject a fake collaborator, no `vi.mock`).
 */

import type { Express, Request, Response } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppState } from '../state.js';

export interface ExecFileResult {
  stdout: string;
}

export type ExecFileFn = (
  command: string,
  args: string[],
  options: { timeout: number },
) => Promise<ExecFileResult>;

const execFileAsync = promisify(execFile);

function defaultExecFileFn(
  command: string,
  args: string[],
  options: { timeout: number },
): Promise<ExecFileResult> {
  // `command` is always one of a fixed set of OS dialog binaries (never user
  // input — see pickFolderWindows/Mac/Linux below) and `args` is a static
  // template with no request-derived values interpolated.
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
  return execFileAsync(command, args, options);
}

export interface SystemRouteDeps {
  /** Injectable child-process execFile — defaults to `child_process.execFile`. Tests supply a fake. */
  execFileFn?: ExecFileFn;
}

/**
 * A folder-browse dialog on the SelectedPath property. `-STA` is required —
 * FolderBrowserDialog (WinForms) throws outside a single-threaded apartment.
 * No user input is interpolated into this script, so it's a static constant
 * passed via `-EncodedCommand` (base64 UTF-16LE) — that sidesteps quoting
 * entirely rather than needing to escape anything.
 */
const WINDOWS_PICKER_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select a folder for Calame to read'
$dialog.ShowNewFolderButton = $false
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
$dialog.Dispose()
`;

// Generous timeout — this is a human browsing a dialog, not a fast op.
const PICKER_TIMEOUT_MS = 5 * 60 * 1000;

async function pickFolderWindows(execFileFn: ExecFileFn): Promise<string | null> {
  const encoded = Buffer.from(WINDOWS_PICKER_SCRIPT, 'utf16le').toString('base64');
  const { stdout } = await execFileFn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
    { timeout: PICKER_TIMEOUT_MS },
  );
  const selected = stdout.trim();
  return selected.length > 0 ? selected : null;
}

async function pickFolderMac(execFileFn: ExecFileFn): Promise<string | null> {
  try {
    const { stdout } = await execFileFn('osascript', ['-e', 'POSIX path of (choose folder)'], {
      timeout: PICKER_TIMEOUT_MS,
    });
    const selected = stdout.trim();
    return selected.length > 0 ? selected : null;
  } catch (err: unknown) {
    // osascript exits non-zero with "User canceled." on Cancel — a clean
    // cancel, not a failure.
    if (err instanceof Error && /user canceled/i.test(err.message)) return null;
    throw err;
  }
}

async function pickFolderLinux(execFileFn: ExecFileFn): Promise<string | null> {
  try {
    const { stdout } = await execFileFn(
      'zenity',
      ['--file-selection', '--directory', '--title=Select a folder for Calame to read'],
      { timeout: PICKER_TIMEOUT_MS },
    );
    const selected = stdout.trim();
    return selected.length > 0 ? selected : null;
  } catch (err: unknown) {
    // zenity exits 1 on both "Cancel" and "not installed", with no reliable
    // way to tell them apart from the exit code alone. Re-throw only when
    // the binary itself is missing (ENOENT) so the UI can show a clear
    // "install zenity" message; treat every other non-zero exit as Cancel.
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('No folder-picker available (zenity is not installed).');
    }
    return null;
  }
}

export function registerSystemRoute(
  app: Express,
  state: AppState,
  deps: SystemRouteDeps = {},
): void {
  const execFileFn = deps.execFileFn ?? defaultExecFileFn;

  /**
   * POST /api/system/pick-folder — opens a native OS folder-browse dialog on
   * the machine running this server and returns the selected absolute path.
   * `{ path: null }` means the user cancelled — not an error.
   */
  app.post('/api/system/pick-folder', async (_req: Request, res: Response) => {
    try {
      let path: string | null;
      if (process.platform === 'win32') {
        path = await pickFolderWindows(execFileFn);
      } else if (process.platform === 'darwin') {
        path = await pickFolderMac(execFileFn);
      } else if (process.platform === 'linux') {
        path = await pickFolderLinux(execFileFn);
      } else {
        res.status(501).json({
          error: `No folder picker available on platform "${process.platform}". Enter the path manually.`,
        });
        return;
      }
      res.json({ path });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.logger?.warn(`Folder picker failed: ${message}`, { component: 'system' });
      res.status(500).json({ error: `Folder picker unavailable: ${message}` });
    }
  });
}
