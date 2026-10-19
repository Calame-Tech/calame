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

The MSI uninstaller is a separate WiX package and is not covered by these hooks.
