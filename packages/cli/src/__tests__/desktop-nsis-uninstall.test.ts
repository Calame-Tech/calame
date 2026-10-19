// Static checks of the Windows NSIS uninstaller customisation of the desktop app
// (apps/desktop/src-tauri/windows). The installer itself can only be built and run on
// Windows; these tests pin the guarantees that can be read from the sources: the data
// option is wired into tauri.conf.json, deletion only happens when the box was ticked
// AND outside an update or a reinstall run by setup.exe, it targets the packaged dataDir of the current user only, and
// the French/English texts explain what is kept or lost.

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPackagedDataDir } from '../config.js';

const TAURI_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../apps/desktop/src-tauri',
);
const tauriConf = JSON.parse(fs.readFileSync(path.join(TAURI_DIR, 'tauri.conf.json'), 'utf8'));
const nsisConf = tauriConf.bundle.windows.nsis;
const hooks = fs.readFileSync(path.join(TAURI_DIR, nsisConf.installerHooks), 'utf8');

function readLangFile(file: string): string {
  return fs.readFileSync(path.join(TAURI_DIR, file), 'utf8');
}

function readLangStrings(file: string): Map<string, string> {
  const content = readLangFile(file);
  const strings = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = /^LangString (\w+) \$\{LANG_\w+\} "(.*)"$/.exec(line);
    if (match) strings.set(match[1], match[2]);
  }
  return strings;
}

function macroBody(name: string): string[] {
  const match = new RegExp(`!macro ${name}\\n([\\s\\S]*?)!macroend`).exec(hooks);
  expect(match, `${name} is defined`).not.toBeNull();
  return match![1].split('\n').map((line) => line.trim());
}

/**
 * Lines matching `pattern` in a macro, each with the conditions (`${If}`/`${AndIf}`/
 * `${OrIf}` lines) of every LogicLib block enclosing it.
 */
function guardedLines(name: string, pattern: RegExp): { line: string; conditions: string[] }[] {
  const stack: string[][] = [];
  const found: { line: string; conditions: string[] }[] = [];
  for (const line of macroBody(name)) {
    if (line.startsWith('${If}')) stack.push([line]);
    else if (line.startsWith('${AndIf}') || line.startsWith('${OrIf}')) stack.at(-1)!.push(line);
    else if (line.startsWith('${Else}')) stack.at(-1)!.push(line);
    else if (line.startsWith('${EndIf}')) stack.pop();
    else if (pattern.test(line)) found.push({ line, conditions: stack.flat() });
  }
  return found;
}

const DELETE_GUARD = ['${If} $DeleteAppDataCheckboxState = 1', '${AndIf} $UpdateMode <> 1'];
// setup.exe runs the previous uninstaller in place (`_?=$INSTDIR`, no /UPDATE) from its
// reinstall/upgrade page, while a normal uninstall runs from a %TEMP% copy.
const IN_PLACE = '$EXEDIR == $INSTDIR';

describe('desktop NSIS uninstaller: optional data deletion', () => {
  const originalPlatform = process.platform;
  const originalAppData = process.env.APPDATA;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
  });

  it('is wired into the per-user NSIS bundle', () => {
    expect(tauriConf.identifier).toBe('tech.calame.desktop');
    expect(tauriConf.bundle.targets).toContain('nsis');
    expect(nsisConf.installMode).toBe('currentUser');
    expect(nsisConf.installerHooks).toBe('windows/installer-hooks.nsh');
    expect(nsisConf.languages).toEqual(['French', 'English']);
    for (const lang of nsisConf.languages) {
      expect(fs.existsSync(path.join(TAURI_DIR, nsisConf.customLanguageFiles[lang]))).toBe(true);
    }
  });

  it('targets the folder the packaged server really uses on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.APPDATA = 'C:\\Users\\someone\\AppData\\Roaming';
    const dirname = getPackagedDataDir().split(/[\\/]/).at(-1);
    expect(hooks).toContain(`!define CALAME_DATA_DIRNAME "${dirname}"`);
    // Same user profile as the server (%APPDATA%), never every profile.
    expect(hooks).not.toMatch(/SetShellVarContext all/);
    expect(hooks).not.toMatch(/C:\\Users|\$PROFILE|\$DOCUMENTS/);
  });

  it('only renames or deletes data when the box was ticked, outside an update or reinstall', () => {
    const destructive = guardedLines('NSIS_HOOK_POSTUNINSTALL', /^(RMDir \/r|Rename|Delete)\b/i);
    const dataOps = destructive.filter(({ line }) =>
      /CALAME_DATA_DIRNAME|CalameDataTrash/.test(line),
    );
    expect(dataOps.map(({ line }) => line.split(' ')[0])).toEqual(['Rename', 'RMDir']);
    for (const { conditions } of dataOps) {
      expect(conditions.slice(0, 3)).toEqual([
        ...DELETE_GUARD,
        `\${AndIf} ${IN_PLACE.replace('==', '!=')}`,
      ]);
      // No ${OrIf} in the guard: either condition alone must not be enough.
      expect(conditions.some((c) => c.startsWith('${OrIf}'))).toBe(false);
    }
    // Nothing else: the template removes the install dir once the sidecar is stopped.
    expect(destructive.filter((op) => !dataOps.includes(op))).toEqual([]);
    expect(guardedLines('NSIS_HOOK_PREUNINSTALL', /^(RMDir|Rename|Delete)\b/i)).toEqual([]);
    expect(hooks).not.toMatch(/RMDir \/r "\$APPDATA\\\$\{CALAME_DATA_DIRNAME\}"/);
  });

  it('deletes calame.db and .calame-secret together or not at all', () => {
    const body = macroBody('NSIS_HOOK_POSTUNINSTALL').join('\n');
    const rename = body.indexOf('Rename "$APPDATA\\${CALAME_DATA_DIRNAME}" "$CalameDataTrash"');
    const errorsCheck = body.indexOf('${If} ${Errors}', rename);
    const rmdir = body.indexOf('RMDir /r "$CalameDataTrash"');
    expect(rename).toBeGreaterThan(-1);
    expect(body.lastIndexOf('ClearErrors', rename)).toBeGreaterThan(-1);
    expect(errorsCheck).toBeGreaterThan(rename);
    // The recursive delete is in the ${Else} branch of the rename error check.
    expect(body.slice(errorsCheck, rmdir)).toContain('${Else}');
    expect(body.slice(errorsCheck, rmdir)).toContain('$(calameDeleteDataLocked)');
  });

  it('stops the Node sidecar by its full path before the template deletes the install dir', () => {
    // PREUNINSTALL runs after the confirm page, before the template stops the app and
    // deletes $INSTDIR (node.exe included) and before POSTUNINSTALL touches the data.
    const stops = guardedLines('NSIS_HOOK_PREUNINSTALL', /Stop-Process/);
    expect(stops).toHaveLength(1);
    // In every mode: the install dir is deleted (or overwritten) in every mode.
    expect(stops[0].conditions).toEqual([]);
    const body = macroBody('NSIS_HOOK_PREUNINSTALL').join('\n');
    expect(body).toContain('$INSTDIR\\${CALAME_SIDECAR_EXE}');
    expect(body).toMatch(/Where-Object \{ \$\$_\.Path -ieq \$\$env:CALAME_UNINSTALL_SIDECAR \}/);
    expect(hooks).not.toMatch(/KillProcess|taskkill/i);
    expect(macroBody('NSIS_HOOK_POSTUNINSTALL').join('\n')).not.toContain('Stop-Process');
  });

  it('never deletes data when setup.exe runs the uninstaller for a reinstall or upgrade', () => {
    const body = macroBody('NSIS_HOOK_PREUNINSTALL');
    // First thing done: clear the choice (which also skips the template's own removal of
    // $APPDATA\${BUNDLEID}) and say why, before any confirmation is asked.
    expect(body.slice(0, 8).filter((line) => line && !line.startsWith(';'))).toEqual([
      `\${If} ${IN_PLACE}`,
      '${AndIf} $DeleteAppDataCheckboxState = 1',
      'StrCpy $DeleteAppDataCheckboxState 0',
      'MessageBox MB_OK|MB_ICONINFORMATION "$(calameDeleteDataReinstall)" /SD IDOK',
      '${EndIf}',
    ]);
    expect(body.indexOf('${EndIf}')).toBeLessThan(
      body.findIndex((line) => line.includes('calameDeleteDataConfirm')),
    );
  });

  it('asks for a second confirmation defaulting to No, and checks the data owner', () => {
    const body = macroBody('NSIS_HOOK_PREUNINSTALL').join('\n');
    expect(body).toContain(DELETE_GUARD.join('\n'));
    expect(body).toContain('ReadRegStr $0 HKCU "${UNINSTKEY}" "UninstallString"');
    expect(body).toMatch(
      /MessageBox MB_YESNO\|MB_ICONEXCLAMATION\|MB_DEFBUTTON2 "\$\(calameDeleteDataConfirm\)" \/SD IDNO IDYES/,
    );
    // Refusing (or a foreign profile) clears the choice, which also skips the Tauri
    // template's own removal of $APPDATA\${BUNDLEID}.
    expect(body.match(/StrCpy \$DeleteAppDataCheckboxState 0/g)).toHaveLength(3);
  });

  it('explains in French and English what is deleted and what keeping the data means', () => {
    const fr = readLangStrings(nsisConf.customLanguageFiles.French);
    const en = readLangStrings(nsisConf.customLanguageFiles.English);
    expect([...fr.keys()].sort()).toEqual([...en.keys()].sort());

    const used = [...hooks.matchAll(/\$\((\w+)\)/g)].map((m) => m[1]);
    for (const key of [...used, 'deleteAppData', 'appRunningOkKill', 'failedToKillApp']) {
      expect(fr.has(key), `French ${key}`).toBe(true);
    }
    for (const value of [...fr.values(), ...en.values()]) {
      // NSIS_MAX_STRLEN is 1024, paths are expanded at runtime.
      expect(value.length).toBeLessThan(850);
    }

    expect(fr.get('deleteAppData')).toBe('Supprimer aussi mes données Calame (compte et contenus)');
    expect(fr.get('calameUninstallConfirmTop')).toMatch(/conservées.*même compte administrateur/);
    const confirm = fr.get('calameDeleteDataConfirm')!;
    for (const text of ['$APPDATA\\Calame', 'calame.db', '.calame-secret', 'administrateur']) {
      expect(confirm).toContain(text);
    }
    expect(confirm).toMatch(/Non = tout conserver/);
    expect(en.get('calameDeleteDataConfirm')).toMatch(/No = keep everything/);
    expect(fr.get('calameDeleteDataReinstall')).toMatch(/n'ont pas été supprimées.*réinstallation/);
  });

  it('keeps the language files compilable by makensis', () => {
    for (const file of Object.values<string>(nsisConf.customLanguageFiles)) {
      const content = readLangFile(file);
      // tauri-bundler re-writes custom language files with its own BOM: a second one
      // would end up glued to the first LangString command.
      expect(content.startsWith('﻿'), `${file} has no BOM`).toBe(false);
      for (const line of content.split(/\r?\n/)) {
        if (!line.startsWith('LangString ')) continue;
        const match = /^LangString \w+ \$\{LANG_\w+\} "(.*)"$/.exec(line);
        expect(match, `${file}: ${line}`).not.toBeNull();
        // An inner `"` must be escaped as `$\"`, otherwise LangString gets too many parameters.
        expect(match![1].replace(/\$\\"/g, ''), `${file}: unescaped quote`).not.toContain('"');
      }
    }
  });
});
