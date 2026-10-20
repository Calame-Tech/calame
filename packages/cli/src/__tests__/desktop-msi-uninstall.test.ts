// Static checks of the Windows MSI uninstaller customisation of the desktop app
// (apps/desktop/src-tauri/windows/wix). The MSI can only be built (WiX 3) and run on
// Windows; these tests pin what can be read from the sources: the fragment is wired into
// tauri.conf.json, the data option is unchecked by default and only reachable from the
// full-UI Remove path, deletion never runs during an upgrade or a partial removal, it
// impersonates the user who launched the uninstall and only targets that user's packaged
// dataDir, and calame.db and .calame-secret are deleted together or not at all.

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
const wixConf = tauriConf.bundle.windows.wix;
const fragmentPath = path.join(TAURI_DIR, wixConf.fragmentPaths[0]);
const fragment = fs.readFileSync(fragmentPath, 'utf8');
const script = fs.readFileSync(
  path.join(path.dirname(fragmentPath), 'calame-uninstall-data.ps1'),
  'utf8',
);

/** Attributes of every `<tag ...>` element of the fragment (XML comments excluded). */
function elements(tag: string): Record<string, string>[] {
  const xml = fragment.replace(/<!--[\s\S]*?-->/g, '');
  return [...xml.matchAll(new RegExp(`<${tag}\\b([^>]*?)/?>`, 'g'))].map((match) =>
    Object.fromEntries(
      [...match[1].matchAll(/(\w+)="([^"]*)"/g)].map((attr) => [attr[1], attr[2]]),
    ),
  );
}

function decode(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

const deleteAction = () => elements('CustomAction').find((ca) => ca.Id === 'CalameRemoveUserData');
const deleteCondition = () =>
  /<Custom Action="CalameRemoveUserData"[^>]*>([^<]*)<\/Custom>/.exec(fragment)?.[1] ?? '';

describe('desktop MSI uninstaller: optional data deletion', () => {
  const originalPlatform = process.platform;
  const originalAppData = process.env.APPDATA;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
  });

  it('is wired into the MSI bundle through a fragment, keeping the Tauri template', () => {
    expect(tauriConf.bundle.targets).toContain('msi');
    expect(wixConf.fragmentPaths).toEqual(['windows/wix/calame-uninstall-data.wxs']);
    // A component of the fragment must be referenced, or the linker drops the fragment.
    expect(wixConf.componentRefs).toEqual(['CalameUninstallDataScript']);
    expect(elements('Component').map((c) => c.Id)).toEqual(['CalameUninstallDataScript']);
    expect(elements('File')[0].Source).toBe('$(sys.SOURCEFILEDIR)calame-uninstall-data.ps1');
    // Default template and a single MSI language: release artifacts are unchanged.
    expect(wixConf.template).toBeUndefined();
    expect(wixConf.language).toBeUndefined();
  });

  it('targets the folder the packaged server really uses on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.APPDATA = 'C:\\Users\\someone\\AppData\\Roaming';
    const dirname = getPackagedDataDir().split(/[\\/]/).at(-1);
    expect(elements('DirectorySearch')[0].Path).toBe(`[AppDataFolder]${dirname}`);
    expect(script).toContain(`$DataDirName = '${dirname}'`);
    expect(script).toContain(`$BundleId = '${tauriConf.identifier}'`);
    // Per-user folders of the running account only, never another profile.
    expect(fragment).not.toMatch(/CommonAppDataFolder|C:\\Users|ProfilesFolder/);
    expect(script).not.toMatch(/C:\\Users|\$env:(APPDATA|LOCALAPPDATA|USERPROFILE)|Get-ChildItem/);
  });

  it('leaves the box unchecked by default and only fixes the folder from the dialog', () => {
    const props = Object.fromEntries(elements('Property').map((p) => [p.Id, p]));
    expect(props.CALAME_DELETE_DATA).toEqual({ Id: 'CALAME_DELETE_DATA', Secure: 'yes' });
    expect(props.CALAME_DATA_DIR).toEqual({ Id: 'CALAME_DATA_DIR', Secure: 'yes' });
    expect(fragment).not.toMatch(/<SetProperty\b/);

    const checkbox = elements('Control').find((c) => c.Id === 'DeleteCheckBox')!;
    expect(checkbox).toMatchObject({
      Type: 'CheckBox',
      Property: 'CALAME_DELETE_DATA',
      CheckBoxValue: '1',
      Text: 'Supprimer aussi mes données Calame (compte et contenus)',
    });

    const publishes = elements('Publish');
    const setters = publishes.filter((p) => p.Property === 'CALAME_DATA_DIR');
    expect(setters.map((p) => [p.Dialog, p.Control, p.Value])).toEqual([
      ['CalameRemoveDataDlg', 'Next', '[AppDataFolder]Calame'],
      ['CalameRemoveDataDlg', 'Next', '{}'],
    ]);
    // Only reachable from the Remove button of the maintenance page.
    expect(publishes.filter((p) => p.Value === 'CalameRemoveDataDlg')).toEqual([
      expect.objectContaining({ Dialog: 'MaintenanceTypeDlg', Control: 'RemoveButton' }),
      expect.objectContaining({ Dialog: 'VerifyReadyDlg', Control: 'Back' }),
    ]);
  });

  it('only deletes on a full removal, never during an upgrade', () => {
    const condition = deleteCondition();
    for (const part of [
      'REMOVE~="ALL"',
      'NOT UPGRADINGPRODUCTCODE',
      'CALAME_DELETE_DATA="1"',
      'CALAME_DATA_DIR',
    ]) {
      expect(condition).toContain(part);
    }
    // Every part is required.
    expect(condition.split(' AND ')).toHaveLength(4);
    expect(condition).not.toMatch(/\bOR\b/);
    // The only custom action, run in the execute sequence only.
    expect(elements('CustomAction')).toHaveLength(1);
    expect(fragment).not.toMatch(/InstallUISequence|AdminExecuteSequence/);
  });

  it('runs as the user who launched the uninstall and reports its failures', () => {
    const action = deleteAction()!;
    // Return="check": a failing script stops the uninstall instead of hiding it.
    expect(action).toMatchObject({ Execute: 'deferred', Impersonate: 'yes', Return: 'check' });
    expect(decode(action.ExeCommand)).toBe(
      '"[SystemFolder]WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive ' +
        '-ExecutionPolicy Bypass -File "[INSTALLDIR]calame-uninstall-data.ps1" ' +
        '-InstallDir "[INSTALLDIR]." -DataDir "[CALAME_DATA_DIR]"',
    );
    // Before RemoveFiles: the script and node.exe are still in the install dir.
    expect(fragment).toMatch(/<Custom Action="CalameRemoveUserData" Before="RemoveFiles">/);
  });

  it('passes the script by a path still resolved during a full removal', () => {
    const action = deleteAction()!;
    // [#file] formats to "" when its component is being removed (always, with REMOVE="ALL"):
    // powershell would then get an empty -File and nothing would ever be deleted.
    expect(action.ExeCommand).not.toMatch(/\[[#!$]/);
    // The path names the file the fragment really installs, in the directory it installs it to.
    const file = elements('File').find((f) => f.Id === 'CalameUninstallDataScript')!;
    const fileName = path.basename(file.Source.replace('$(sys.SOURCEFILEDIR)', ''));
    expect(fs.existsSync(path.join(path.dirname(fragmentPath), fileName))).toBe(true);
    expect(fragment).toMatch(
      /<DirectoryRef Id="INSTALLDIR">\s*<Component Id="CalameUninstallDataScript"/,
    );
    expect(decode(action.ExeCommand)).toContain(`-File "[INSTALLDIR]${fileName}"`);
    expect(action.Directory).toBe('INSTALLDIR');
    // Only one Custom scheduling, in the execute sequence, before the files are removed.
    expect(fragment.match(/<Custom Action=/g)).toHaveLength(1);
    expect(script).toMatch(/exits non-zero without deleting anything/);
  });

  it('checks again that the folder is the running account’s own data folder', () => {
    const checkIndex = script.indexOf(
      'if ((Get-NormalizedPath $DataDir) -ne (Get-NormalizedPath $expected)) { exit 3 }',
    );
    expect(script).toContain("$appData = [Environment]::GetFolderPath('ApplicationData')");
    expect(script).toContain('$expected = Join-Path $appData $DataDirName');
    expect(checkIndex).toBeGreaterThan(-1);
    // Nothing is stopped, renamed or removed before that check.
    expect(script.slice(0, checkIndex)).not.toMatch(/Stop-Process|Rename-Item|Remove-Item/);
    expect(script).toMatch(/ReparsePoint\) \{ exit 4 \}/);
  });

  it('stops only this account’s app and server started from the install dir', () => {
    expect(script).toContain(`-Filter "Name = 'calame-desktop.exe' OR Name = 'node.exe'"`);
    expect(script).toContain(
      '$_.ExecutablePath.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase)',
    );
    expect(script).toContain('-MethodName GetOwnerSid');
    expect(script).toContain('.Sid -eq $me');
    expect(script.indexOf('Stop-Process')).toBeLessThan(script.indexOf('Rename-Item'));
    expect(script).not.toMatch(/taskkill|Stop-Process -Name/i);
  });

  it('deletes calame.db and .calame-secret together or not at all', () => {
    const rename = script.indexOf('Rename-Item -LiteralPath $expected -NewName $trashName');
    const remove = script.indexOf('Remove-Item -LiteralPath (Join-Path $appData $trashName)');
    expect(rename).toBeGreaterThan(-1);
    expect(remove).toBeGreaterThan(rename);
    expect(script.slice(rename, remove)).toMatch(/catch \{\s*exit 5\s*\}/);
    // The data folder itself is never removed in place.
    expect(script).not.toMatch(/Remove-Item -LiteralPath \$expected/);
  });

  it('explains in French what is kept, what is lost and for which account', () => {
    const texts = Object.fromEntries(elements('Control').map((c) => [c.Id, c.Text]));
    expect(texts.KeepText).toMatch(/conservées.*même compte administrateur/);
    expect(texts.PathText).toBe(
      'Dossier de données du compte Windows [LogonUser] : [AppDataFolder]Calame',
    );
    for (const text of ['calame.db', '.calame-secret', 'administrateur', 'ce compte Windows']) {
      expect(texts.LostText).toContain(text);
    }
    expect(texts.NotFoundText).toMatch(/rien ne sera supprimé/);
    // Without data for this account, the box cannot be ticked.
    expect(fragment).toMatch(/<Condition Action="disable">NOT CALAME_DATA_FOUND<\/Condition>/);
  });
});
