//! "Réinitialiser le compte administrateur…" — local recovery for a forgotten
//! administrator account, reachable only from the native tray menu (see
//! [`crate::tray`]).
//!
//! Why it is safe to offer without a Calame login:
//!   - it is not a Tauri command and not an HTTP route: the webview (which
//!     shows the Calame server at `http://127.0.0.1:<port>`) has no way to
//!     trigger it, and neither has any other local process or browser;
//!   - it runs inside the desktop process of the logged-in Windows (or macOS/
//!     Linux) user and only ever touches that user's own data folder, resolved
//!     from that process's own environment exactly as the server does
//!     (`getPackagedDataDir()` in `packages/cli/src/config.ts`);
//!   - nothing changes before an explicit confirmation (default button:
//!     "Annuler") that lists what is lost and where the backup goes.
//!
//! The reset itself stops the Node sidecar (the only process using the
//! database), then renames the whole data folder to a dated sibling backup in
//! one `rename` call: `calame.db` (+ `-wal`/`-shm`), `.calame-secret` and the
//! rest move together or not at all. The sidecar is then restarted on an empty
//! folder, which brings the first-run administrator creation. Every session
//! disappears with the old database (`auth_sessions`) and the old process
//! (in-memory sessions), and the new secret makes old tokens unusable.
//! Nothing is deleted: putting the backup folder back restores everything.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::server;
use crate::state::AppState;

/// After killing the sidecar, Windows may keep `calame.db` locked for a
/// moment: retry the rename this many times, [`RENAME_RETRY_DELAY`] apart.
const RENAME_ATTEMPTS: u32 = 20;
const RENAME_RETRY_DELAY: Duration = Duration::from_millis(250);

/// Set while a reset dialog or operation is in progress, so a second click
/// on the tray item cannot start a concurrent one.
static IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Where the data folder is, as far as this desktop process can tell.
#[derive(Debug, PartialEq, Eq)]
enum DataDir {
    /// The default per-user folder the sidecar uses.
    Default(PathBuf),
    /// `CALAME_DATA_DIR` is set: the folder was chosen by hand, so it is
    /// never moved automatically (it may be shared or hold other files).
    Custom,
    /// No usable home/AppData environment variable.
    Unknown,
}

/// Mirrors `getPackagedDataDir()` in `packages/cli/src/config.ts`. The
/// sidecar inherits this process's environment, so both resolve the same
/// folder. `env` is a parameter so tests can exercise every platform rule.
fn resolve_data_dir(platform: &str, env: impl Fn(&str) -> Option<String>) -> DataDir {
    let var = |name: &str| env(name).filter(|value| !value.is_empty());
    if var("CALAME_DATA_DIR").is_some() {
        return DataDir::Custom;
    }
    let dir = match platform {
        "windows" => var("APPDATA")
            .map(PathBuf::from)
            .or_else(|| var("USERPROFILE").map(|home| Path::new(&home).join("AppData").join("Roaming")))
            .map(|app_data| app_data.join("Calame")),
        "macos" => var("HOME").map(|home| {
            Path::new(&home)
                .join("Library")
                .join("Application Support")
                .join("Calame")
        }),
        _ => var("XDG_DATA_HOME")
            .map(|xdg| Path::new(&xdg).join("calame"))
            .or_else(|| var("HOME").map(|home| Path::new(&home).join(".local").join("share").join("calame"))),
    };
    dir.map(DataDir::Default).unwrap_or(DataDir::Unknown)
}

/// UTC `YYYYMMDD-HHMMSS` for `secs` since the Unix epoch (civil-from-days,
/// H. Hinnant), to name the backup without pulling in a date crate.
fn timestamp(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}{:02}",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

/// A sibling of `data_dir` named `<name>-sauvegarde-<stamp>` that does not
/// exist yet (suffixed `-2`, `-3`… if needed). Being in the same parent
/// folder keeps the move a single same-volume rename.
fn backup_path(data_dir: &Path, stamp: &str) -> PathBuf {
    let name = data_dir
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Calame".to_string());
    let base = format!("{name}-sauvegarde-{stamp}");
    let mut candidate = data_dir.with_file_name(&base);
    let mut n = 2;
    while candidate.exists() {
        candidate = data_dir.with_file_name(format!("{base}-{n}"));
        n += 1;
    }
    candidate
}

/// Moves the whole data folder to `backup` in one rename, retrying while
/// the stopped sidecar's file handles are released. Either everything moved
/// or nothing did: a rename never leaves `calame.db` and `.calame-secret`
/// split between the two folders. Refuses a symlink/junction, whose target
/// may not belong to Calame.
fn move_data_dir(data_dir: &Path, backup: &Path, attempts: u32, delay: Duration) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(data_dir).map_err(|err| format!("{}: {err}", data_dir.display()))?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(format!("{} n'est pas un dossier ordinaire.", data_dir.display()));
    }
    let mut last_err = String::new();
    for attempt in 0..attempts.max(1) {
        if attempt > 0 {
            thread::sleep(delay);
        }
        match std::fs::rename(data_dir, backup) {
            Ok(()) => return Ok(()),
            Err(err) => last_err = err.to_string(),
        }
    }
    Err(last_err)
}

/// Tray entry point. Runs the dialogs and the reset on a background thread
/// (blocking dialogs must not run on the main thread, where tray events are
/// delivered).
pub fn reset_admin_account(app: AppHandle) {
    if IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || {
        run(&app);
        IN_PROGRESS.store(false, Ordering::SeqCst);
    });
}

fn run(app: &AppHandle) {
    let data_dir = match resolve_data_dir(std::env::consts::OS, |name| std::env::var(name).ok()) {
        DataDir::Default(dir) => dir,
        DataDir::Custom => {
            show(
                app,
                MessageDialogKind::Info,
                "Les données de Calame sont dans un dossier choisi à la main (variable CALAME_DATA_DIR). \
                 Calame ne le modifie pas automatiquement.\n\n\
                 Pour repartir de zéro : quittez Calame, sauvegardez ce dossier, puis sortez-en ensemble \
                 calame.db et .calame-secret avant de relancer Calame.",
            );
            return;
        }
        DataDir::Unknown => {
            show(
                app,
                MessageDialogKind::Error,
                "Impossible de trouver le dossier des données de Calame pour ce compte. Aucune donnée n'a été modifiée.",
            );
            return;
        }
    };

    if !data_dir.is_dir() {
        show(
            app,
            MessageDialogKind::Info,
            &format!(
                "Aucune donnée Calame n'existe pour ce compte ({}).\n\nAu prochain démarrage, Calame proposera de créer un compte administrateur.",
                data_dir.display()
            ),
        );
        return;
    }

    let stamp = timestamp(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
    let backup = backup_path(&data_dir, &stamp);

    let confirmed = app
        .dialog()
        .message(format!(
            "Repartir de zéro avec un nouveau compte administrateur ?\n\n\
             Calame va s'arrêter quelques secondes, puis redémarrer vide : vous créerez un nouveau compte \
             administrateur.\n\n\
             Ce qui disparaît de Calame : le compte administrateur, les utilisateurs, les connexions, les profils, \
             les jetons MCP, les conversations, les réglages et le journal d'audit. Toutes les sessions ouvertes \
             sont fermées.\n\n\
             Ce qui est conservé : rien n'est effacé. Le dossier actuel, y compris calame.db et .calame-secret, \
             est déplacé tel quel vers :\n{}\n\
             Vos bases de données et documents d'origine ne sont pas touchés.\n\n\
             Pour revenir en arrière : quittez Calame, puis remettez ce dossier à la place de :\n{}\n\n\
             Seules les données de votre compte utilisateur sur cet ordinateur sont concernées.",
            backup.display(),
            data_dir.display()
        ))
        .kind(MessageDialogKind::Warning)
        .title("Réinitialiser le compte administrateur")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Réinitialiser".to_string(),
            "Annuler".to_string(),
        ))
        .blocking_show();
    if !confirmed {
        return;
    }

    let log = |line: String| app.state::<AppState>().logs.push(format!("[recovery] {line}"));
    log(format!("moving {} to {}", data_dir.display(), backup.display()));

    // Stop the only process that opens the database before moving it.
    server::kill_child(app);
    let moved = move_data_dir(&data_dir, &backup, RENAME_ATTEMPTS, RENAME_RETRY_DELAY);
    // Restart in every case: on the empty folder after a successful move, on
    // the untouched data otherwise.
    server::restart(app.clone());

    match moved {
        Ok(()) => {
            log("data folder moved, server restarted".to_string());
            show(
                app,
                MessageDialogKind::Info,
                &format!(
                    "Calame redémarre sans données : créez votre nouveau compte administrateur.\n\n\
                     Vos anciennes données sont sauvegardées dans :\n{}",
                    backup.display()
                ),
            );
        }
        Err(err) => {
            log(format!("[error] moving the data folder: {err}"));
            show(
                app,
                MessageDialogKind::Error,
                &format!(
                    "La réinitialisation n'a pas pu se faire : aucune donnée n'a été modifiée et le compte \
                     existant est conservé.\n\nUn autre programme utilise peut-être le dossier {}. \
                     Fermez-le puis réessayez.\n\nDétail : {err}",
                    data_dir.display()
                ),
            );
        }
    }
}

fn show(app: &AppHandle, kind: MessageDialogKind, message: &str) {
    app.dialog()
        .message(message)
        .kind(kind)
        .title("Calame")
        .blocking_show();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn resolves_the_same_folders_as_the_server() {
        assert_eq!(
            resolve_data_dir("windows", env(&[("APPDATA", r"C:\Users\a\AppData\Roaming")])),
            DataDir::Default(Path::new(r"C:\Users\a\AppData\Roaming").join("Calame"))
        );
        assert_eq!(
            resolve_data_dir("windows", env(&[("USERPROFILE", r"C:\Users\a")])),
            DataDir::Default(Path::new(r"C:\Users\a").join("AppData").join("Roaming").join("Calame"))
        );
        assert_eq!(
            resolve_data_dir("macos", env(&[("HOME", "/Users/a")])),
            DataDir::Default(PathBuf::from("/Users/a/Library/Application Support/Calame"))
        );
        assert_eq!(
            resolve_data_dir("linux", env(&[("HOME", "/home/a"), ("XDG_DATA_HOME", "/x")])),
            DataDir::Default(PathBuf::from("/x/calame"))
        );
        assert_eq!(
            resolve_data_dir("linux", env(&[("HOME", "/home/a")])),
            DataDir::Default(PathBuf::from("/home/a/.local/share/calame"))
        );
    }

    #[test]
    fn never_targets_a_custom_or_unknown_folder() {
        assert_eq!(
            resolve_data_dir("windows", env(&[("APPDATA", r"C:\x"), ("CALAME_DATA_DIR", r"D:\shared")])),
            DataDir::Custom
        );
        assert_eq!(resolve_data_dir("windows", env(&[])), DataDir::Unknown);
        assert_eq!(resolve_data_dir("windows", env(&[("APPDATA", "")])), DataDir::Unknown);
    }

    #[test]
    fn formats_utc_timestamps() {
        assert_eq!(timestamp(0), "19700101-000000");
        assert_eq!(timestamp(1_792_431_296), "20261019-173456");
        assert_eq!(timestamp(951_782_400), "20000229-000000");
    }

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("calame-recovery-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn moves_database_and_secret_together_into_a_fresh_backup() {
        let root = temp_root("move");
        let data = root.join("Calame");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join("calame.db"), b"db").unwrap();
        std::fs::write(data.join(".calame-secret"), b"secret").unwrap();
        std::fs::create_dir_all(root.join("Calame-sauvegarde-s")).unwrap();

        let backup = backup_path(&data, "s");
        assert_eq!(backup, root.join("Calame-sauvegarde-s-2"));
        move_data_dir(&data, &backup, 1, Duration::ZERO).unwrap();

        assert!(!data.exists());
        assert_eq!(std::fs::read(backup.join("calame.db")).unwrap(), b"db");
        assert_eq!(std::fs::read(backup.join(".calame-secret")).unwrap(), b"secret");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_failed_move_leaves_everything_in_place() {
        let root = temp_root("fail");
        let data = root.join("Calame");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join("calame.db"), b"db").unwrap();
        std::fs::write(data.join(".calame-secret"), b"secret").unwrap();

        let unreachable = root.join("missing-parent").join("Calame-sauvegarde-s");
        assert!(move_data_dir(&data, &unreachable, 2, Duration::ZERO).is_err());
        assert!(data.join("calame.db").exists());
        assert!(data.join(".calame-secret").exists());
        assert!(move_data_dir(&root.join("absent"), &unreachable, 1, Duration::ZERO).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
