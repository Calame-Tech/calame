# Validating the Windows uninstaller data option

Follow-up to a non-developer tester's report on 0.8.5: after uninstalling and
reinstalling the desktop app, the old administrator account came back
(`%APPDATA%\Calame` was left behind) with no visible way out.

## Where the data really is

| Path (per Windows user) | Content | Who writes it |
| --- | --- | --- |
| `%APPDATA%\Calame` | `calame.db` (+ `-wal`/`-shm`): accounts including the administrator, connections, conversations, settings; `.calame-secret`: key that encrypts stored credentials | Node server, `getPackagedDataDir()` in `packages/cli/src/config.ts` (`CALAME_PACKAGED=1` set by `apps/desktop/src-tauri/src/server.rs`) |
| `%APPDATA%\tech.calame.desktop`, `%LOCALAPPDATA%\tech.calame.desktop` | Tauri shell data (WebView2 profile, cache) | Tauri, from `identifier` in `tauri.conf.json` |

The account lives only in `%APPDATA%\Calame`, not in the folders named after the
Tauri identifier. A `CALAME_DATA_DIR` environment variable set by hand moves the
server data elsewhere; the uninstaller never touches such a custom folder.

## NSIS (`*-setup.exe`, per-user install)

The Tauri template draws an unchecked box on the uninstall confirm page and hides
it in update mode. `apps/desktop/src-tauri/windows/installer-hooks.nsh` and the
language files in `windows/nsis/` (wired through `bundle.windows.nsis` in
`tauri.conf.json`) make it:

- read **« Supprimer aussi mes données Calame (compte et contenus) »**, under a
  page text saying that data is kept by default and that reinstalling brings
  back the same administrator account;
- ask a second confirmation (default **Non**) listing what is lost, for the
  current Windows account only;
- refuse when the uninstaller does not run under the account that installed
  Calame (no per-user uninstall key in its `HKCU`, e.g. "Run as administrator"
  with another account);
- stop the Node sidecar (`<install dir>\node.exe`, matched by full path) right
  after the confirm page, before the template stops `calame-desktop.exe` and
  deletes the install dir;
- rename `%APPDATA%\Calame` then delete it, so that `calame.db` and
  `.calame-secret` go together; if the folder is still in use, nothing is
  deleted and a message says so;
- do nothing in `/UPDATE` (updater), silent (`/S`) or passive (`/P`) mode;
- do nothing when a `setup.exe` runs the previous uninstaller itself (choice
  "Désinstaller avant d'installer" or "Désinstaller" on its maintenance page):
  that uninstaller runs in place from the install dir, without `/UPDATE`, and
  the installation continues afterwards. The box is still drawn by the template
  there; if it is ticked, a message says the data was kept and that deletion is
  done from "Applications installées".

## Verification matrix

Executed on macOS (no Windows machine, no `makensis`): the static tests in
`packages/cli/src/__tests__/desktop-nsis-uninstall.test.ts` (wiring, dataDir
name, guards, confirmation, texts). **None of the rows below has been run yet;
they need a Windows 10/11 machine with an installer built by CI.**

| # | Scenario | Expected | Status |
| --- | --- | --- | --- |
| N1 | `tauri build` on Windows with the hooks and language files | NSIS compiles without error or missing-LangString warning | Windows required |
| N2 | Uninstall, box left unchecked | `%APPDATA%\Calame` (db + secret) and `tech.calame.desktop` folders kept | Windows required |
| N3 | Reinstall after N2 | Login page; the existing admin can sign in | Windows required |
| N4 | Uninstall, box ticked, answer **Non** | Everything kept, as in N2 | Windows required |
| N5 | Uninstall, box ticked, answer **Oui**, app open with a session | App and `node.exe` stopped; `%APPDATA%\Calame` and both `tech.calame.desktop` folders gone; install dir removed | Windows required |
| N6 | Reinstall after N5 | First-run admin creation (new bootstrap), new `.calame-secret` | Windows required |
| N7 | N5 while another process keeps `calame.db` open | "données conservées" message; `calame.db` and `.calame-secret` both still present | Windows required |
| N8 | Second Windows user with their own Calame data; first user uninstalls with deletion | Second user's `%APPDATA%\Calame` untouched | Windows required |
| N9 | Uninstaller started with "Run as administrator" under another account, box ticked | "pas le compte qui a installé Calame" message; no profile's data deleted | Windows required |
| N10 | In-app update (updater runs the installer with `/UPDATE`) | No checkbox, no deletion, same account after restart | Windows required |
| N11 | Install a newer `setup.exe` over the current one, default choice "Désinstaller avant d'installer", box ticked in the old uninstaller | Old uninstaller runs interactively (no `/UPDATE`); "réinstallation ou mise à jour" message, no second confirmation; `%APPDATA%\Calame` and `tech.calame.desktop` folders kept; same account after install | Windows required |
| N11b | Same as N11, box left unchecked | No message; data kept; same account after install | Windows required |
| N11c | Run the same version's `setup.exe` again, choose "Désinstaller" on the maintenance page, tick the box | Same as N11: data kept, message shown, installation continues | Windows required |
| N12 | Silent uninstall `uninstall.exe /S` | Data kept | Windows required |
| N13 | Page layout at 100 % and 150 % scaling, French and English Windows | Page text and checkbox fully visible, not overlapping | Windows required |

The MSI uninstaller is a separate WiX package and is not covered by these hooks:
see the next section.

## MSI (`*.msi`, per-machine install)

Tauri's default WiX template is kept; `apps/desktop/src-tauri/windows/wix/calame-uninstall-data.wxs`
(wired through `bundle.windows.wix.fragmentPaths` and `componentRefs` in
`tauri.conf.json`) installs `calame-uninstall-data.ps1` next to the app and:

- adds a **« Vos données Calame »** page to the full-UI removal path: run the
  `.msi` again (or `msiexec /i <fichier>.msi`), choose **Remove**, then this page
  shows the folder and Windows account concerned
  (`[AppDataFolder]Calame`, `[LogonUser]`), says that data is kept by default
  and that reinstalling brings back the same administrator account, and offers
  the unchecked box **« Supprimer aussi mes données Calame (compte et
  contenus) »** with the list of what is lost; the box is disabled when that
  account has no `%APPDATA%\Calame`;
- has no page, so always keeps the data, when the uninstall runs without full
  UI: **« Désinstaller » in Windows Settings / Programs and Features** (basic UI,
  where Windows Installer shows no custom dialog), `/passive`, `/quiet`, the
  in-app updater and the old product removed by a major upgrade;
- resolves the folder in the UI, which runs as the user who launched the
  uninstall, not as the account typing UAC credentials;
- deletes through a deferred custom action that impersonates that same user,
  conditioned on `REMOVE~="ALL" AND NOT UPGRADINGPRODUCTCODE`, the ticked box
  and the folder fixed by the page, scheduled before `RemoveFiles`
  (`Return="ignore"`: a failure never blocks the uninstall and keeps the data);
- in the script, checks that the folder is the running account's own
  `%APPDATA%\Calame` (otherwise exits), refuses a junction, stops only that
  account's `calame-desktop.exe` / `node.exe` started from the install dir,
  renames the folder then deletes it (if the rename fails, `calame.db` and
  `.calame-secret` are both kept), then removes the account's
  `tech.calame.desktop` folders in `%APPDATA%` and `%LOCALAPPDATA%`.

Known limits: the page text is French only (the rest of the MSI UI is the
template's English); the option exists only in MSIs built from this version on
(an uninstall uses the installed product's own MSI); a group policy forcing the
PowerShell execution policy can prevent the script from running, which keeps
the data; the deletion runs before the files are removed, so if the uninstall
then fails and rolls back, the app stays installed with its data deleted (a new
administrator bootstrap, never a half-deleted state).

## MSI verification matrix

Executed on macOS (no Windows machine, no WiX): the static tests in
`packages/cli/src/__tests__/desktop-msi-uninstall.test.ts` (wiring, dataDir
name, unchecked default, upgrade/removal guards, impersonation, owner check,
rename-then-delete, texts) and an XML well-formedness check of the fragment.
**None of the rows below has been run yet; they need a Windows 10/11 machine
with an MSI built by CI.**

| # | Scenario | Expected | Status |
| --- | --- | --- | --- |
| M1 | `tauri build` on Windows with the fragment | candle/light succeed (no unresolved reference, ICE errors) and the MSI contains `calame-uninstall-data.ps1` | Windows required |
| M2 | Uninstall from Windows Settings (« Désinstaller ») | No Calame page; `%APPDATA%\Calame` (db + secret) and `tech.calame.desktop` folders kept | Windows required |
| M3 | Reinstall after M2 | Login page; the existing admin can sign in | Windows required |
| M4 | Run the `.msi` again, Remove, box left unchecked | Page shown with the right path and account; everything kept | Windows required |
| M5 | Same, box ticked, app open with a session | App and `node.exe` stopped; `%APPDATA%\Calame` and both `tech.calame.desktop` folders gone; product removed | Windows required |
| M6 | Reinstall after M5 | First-run admin creation (new bootstrap), new `.calame-secret` | Windows required |
| M7 | M5 while another process keeps `calame.db` open | Uninstall completes; `calame.db` and `.calame-secret` both still present (MSI log: script exit code 5) | Windows required |
| M8 | Box ticked, then Back, untick, Next, Remove | Everything kept | Windows required |
| M9 | Account without `%APPDATA%\Calame` reaches the page | Box disabled, « rien ne sera supprimé » shown, nothing deleted | Windows required |
| M10 | Standard user launches the `.msi`, Remove, box ticked, UAC credentials of an admin account | Only the standard user's folders deleted; admin's profile untouched | Windows required |
| M11 | Second Windows user with their own Calame data; first user removes with deletion | Second user's `%APPDATA%\Calame` untouched | Windows required |
| M12 | `msiexec /x <code> /qn CALAME_DELETE_DATA=1 CALAME_DATA_DIR=<other user's folder>` from an elevated prompt | Script exits (code 3), nothing deleted | Windows required |
| M13 | Major upgrade: install a newer `.msi` over this one | No page, no deletion, same account after upgrade | Windows required |
| M14 | In-app update (updater runs the MSI in `/passive`) | No page, no deletion, same account after restart | Windows required |
| M15 | Page layout at 100 % and 150 % scaling | Texts and checkbox fully visible, not overlapping | Windows required |

## Native administrator reset (tray menu)

Decision: a native reset can be offered safely, but only from the tray menu, not from the login
page. The main window shows the Calame server at `http://127.0.0.1:<port>`, a remote origin for
Tauri: the capability in `apps/desktop/src-tauri/capabilities/default.json` has no `remote` entry
and the app registers no Tauri command (`invoke_handler`), so neither that page, a browser nor
another local process can reach native code. The tray menu is only reachable by the person using
the Windows session that runs Calame, i.e. the owner of `%APPDATA%\Calame`. The login page help
only describes the tray item (and the manual steps); it triggers nothing.

`apps/desktop/src-tauri/src/recovery.rs` (tray item **« Réinitialiser le compte administrateur… »**):

- resolves the folder like `getPackagedDataDir()` from the process's own environment (inherited by
  the Node sidecar); does nothing for a custom `CALAME_DATA_DIR` (help text only) or a missing folder;
- asks for confirmation (buttons « Réinitialiser » / « Annuler ») listing what disappears from
  Calame, that nothing is erased, where the backup goes and how to undo;
- stops the Node sidecar, then renames the whole folder to a sibling
  `Calame-sauvegarde-<AAAAMMJJ-HHMMSS>` (UTC) in a single `rename`, retried for ~5 s while Windows
  releases the database handles: `calame.db`, `-wal`/`-shm` and `.calame-secret` move together or
  not at all; a symlink/junction is refused;
- restarts the sidecar in every case: on an empty folder (first-run administrator creation, new
  `.calame-secret`, all sessions gone with the old `auth_sessions` table and the old process) or,
  if the rename failed, on the untouched data with an error dialog saying nothing changed.

The backup folder is not removed by the uninstallers' data option (which only deletes
`%APPDATA%\Calame`); it is deleted by hand once no longer needed.

Executed on macOS (no Rust toolchain on this machine, no Windows): the static tests in
`packages/cli/src/__tests__/desktop-native-recovery.test.ts` and the login help tests. The Rust
unit tests in `recovery.rs` (folder resolution, timestamp, move, failed move) need `cargo test` in
`apps/desktop/src-tauri`. **None of the rows below has been run yet.**

| # | Scenario | Expected | Status |
| --- | --- | --- | --- |
| R1 | `cargo test` and `tauri build` with `recovery.rs` | Compiles; unit tests pass | Rust toolchain required |
| R2 | Tray item, « Annuler » (or closing the dialog) | Nothing changes; server keeps running; same session | Windows required |
| R3 | Tray item, « Réinitialiser », with a session open | Server restarts; first-run admin creation; old session rejected; `%APPDATA%\Calame-sauvegarde-*` contains `calame.db` and `.calame-secret` | Windows required |
| R4 | After R3: quit, put the backup back as `%APPDATA%\Calame`, relaunch | Old administrator can sign in again | Windows required |
| R5 | R3 while another process keeps `calame.db` open | Error dialog "aucune donnée n'a été modifiée"; server back up on the old data | Windows required |
| R6 | `CALAME_DATA_DIR` set for the user | Info dialog only; folder untouched | Windows required |
| R7 | Second Windows user with their own Calame data; first user resets | Second user's `%APPDATA%\Calame` untouched | Windows required |
| R8 | Wrong password several times on the login page | No data change (no reset is ever triggered by a failed sign-in) | Windows required |
