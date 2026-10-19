// Static checks of the desktop app's native "Réinitialiser le compte administrateur…" tray
// item (apps/desktop/src-tauri/src/recovery.rs). The Rust unit tests in that file cover the
// folder resolution and the move itself (`cargo test`, needs a Rust toolchain); these tests
// pin the guarantees readable from the sources: the reset is only reachable from the native
// tray menu (no Tauri command, no IPC for the remote webview), it asks for confirmation
// before stopping the server or moving anything, it moves the whole data folder in one
// rename (calame.db and .calame-secret together), and it targets the server's dataDir.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TAURI_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../apps/desktop/src-tauri',
);
const SRC_DIR = path.join(TAURI_DIR, 'src');
const read = (file: string) => fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
const recovery = read('recovery.rs');
const runBody = /\nfn run\(app: &AppHandle\) \{([\s\S]*?)\n\}\n/.exec(recovery)?.[1] ?? '';

describe('desktop native admin recovery', () => {
  it('is not callable from the webview: no Tauri command, no IPC for remote pages', () => {
    for (const file of fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.rs'))) {
      const source = read(file);
      expect(source, file).not.toMatch(/#\[tauri::command\]/);
      expect(source, file).not.toMatch(/invoke_handler/);
    }
    const capabilitiesDir = path.join(TAURI_DIR, 'capabilities');
    for (const file of fs.readdirSync(capabilitiesDir)) {
      const capability = JSON.parse(fs.readFileSync(path.join(capabilitiesDir, file), 'utf8'));
      // The main window shows http://127.0.0.1:<port>; without `remote`, it gets no IPC.
      expect(capability.remote, file).toBeUndefined();
    }
  });

  it('is wired to a tray menu item only', () => {
    const tray = read('tray.rs');
    expect(tray).toContain('.text(MENU_RESET_ADMIN, "Réinitialiser le compte administrateur…")');
    expect(tray).toContain('MENU_RESET_ADMIN => recovery::reset_admin_account(app.clone()),');
    const callers = fs
      .readdirSync(SRC_DIR)
      .filter((f) => f !== 'recovery.rs' && read(f).includes('reset_admin_account'));
    expect(callers).toEqual(['tray.rs']);
  });

  it('confirms before stopping the server or moving data, with Annuler as the way out', () => {
    expect(runBody).not.toBe('');
    const confirm = runBody.indexOf(
      '.blocking_show();\n    if !confirmed {\n        return;\n    }',
    );
    const kill = runBody.indexOf('server::kill_child(app);');
    const move = runBody.indexOf('move_data_dir(&data_dir, &backup');
    const restart = runBody.indexOf('server::restart(app.clone());');
    expect(confirm).toBeGreaterThan(0);
    expect(kill).toBeGreaterThan(confirm);
    expect(move).toBeGreaterThan(kill);
    expect(restart).toBeGreaterThan(move);
    expect(runBody).toContain('MessageDialogButtons::OkCancelCustom(');
    expect(runBody).toContain('"Annuler".to_string()');
    // Nothing is mutated on the early-return paths (custom/unknown/missing folder).
    expect(runBody.slice(0, confirm)).not.toMatch(/kill_child|rename|remove_|move_data_dir/);
  });

  it('explains what is lost, what is kept and how to undo it', () => {
    for (const text of [
      'le compte administrateur, les utilisateurs',
      'Toutes les sessions ouvertes',
      "rien n'est effacé",
      'calame.db et .calame-secret',
      'Pour revenir en arrière',
      "Vos bases de données et documents d'origine ne sont pas touchés",
      "aucune donnée n'a été modifiée",
    ]) {
      expect(recovery).toContain(text);
    }
  });

  it('moves the whole folder in one rename and never deletes it', () => {
    expect(recovery).toMatch(/std::fs::rename\(data_dir, backup\)/);
    expect(recovery.split('#[cfg(test)]')[0]).not.toMatch(/remove_dir|remove_file/);
    expect(recovery).toContain('file_type().is_symlink()');
  });

  it('resolves the same folder as getPackagedDataDir() and leaves CALAME_DATA_DIR alone', () => {
    expect(recovery).toContain(
      'if var("CALAME_DATA_DIR").is_some() {\n        return DataDir::Custom;',
    );
    expect(recovery).toContain('"windows" => var("APPDATA")');
    expect(recovery).toContain('.join("Calame")');
    expect(recovery).toContain('.join("Application Support")');
    expect(recovery).toContain('Path::new(&xdg).join("calame")');
    expect(recovery).toContain('.join(".local").join("share").join("calame")');
  });
});
