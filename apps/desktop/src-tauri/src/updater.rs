//! App update check against the GitHub release feed configured in
//! `tauri.conf.json` (`plugins.updater`). Two call sites: once silently at
//! startup (see [`crate::run`]), and once interactively from the tray's
//! "Vérifier les mises à jour" item (see [`crate::tray`]).

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

use crate::state::AppState;

/// Checks for an update and, if `interactive` is `true`, reports the result
/// (including "already up to date" and errors) via native dialogs. When
/// `false` (the silent startup check), only a found update is surfaced —
/// everything else is logged to [`AppState::logs`] and swallowed, since a
/// dev build with no signed release context is expected to fail the check.
pub fn check_for_updates(app: AppHandle, interactive: bool) {
    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(updater) => updater,
            Err(err) => {
                log_error(&app, &format!("building the updater: {err}"));
                if interactive {
                    show_error_dialog(&app, &format!("Impossible de vérifier les mises à jour.\n\n{err}"));
                }
                return;
            }
        };

        match updater.check().await {
            Ok(Some(update)) => prompt_install(app, update, interactive).await,
            Ok(None) => {
                if interactive {
                    show_info_dialog(&app, "Calame est à jour.");
                }
            }
            Err(err) => {
                log_error(&app, &format!("checking for updates: {err}"));
                if interactive {
                    show_error_dialog(&app, &format!("Impossible de vérifier les mises à jour.\n\n{err}"));
                }
            }
        }
    });
}

/// Asks the user whether to install `update` now; on confirmation, downloads
/// and installs it (logging progress to [`AppState::logs`]) then offers to
/// relaunch. `interactive` only controls whether errors are dialoged — the
/// initial ask and the relaunch prompt always show, since finding an update
/// is itself something the user needs to act on.
async fn prompt_install(app: AppHandle, update: tauri_plugin_updater::Update, interactive: bool) {
    let version = update.version.clone();
    let should_install = app
        .dialog()
        .message(format!("Mise à jour {version} disponible — installer maintenant ?"))
        .kind(MessageDialogKind::Info)
        .title("Calame")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Installer".to_string(),
            "Plus tard".to_string(),
        ))
        .blocking_show();

    if !should_install {
        return;
    }

    let progress_app = app.clone();
    let result = update
        .download_and_install(
            move |chunk_len, total_len| {
                let state = progress_app.state::<AppState>();
                match total_len {
                    Some(total) => state.logs.push(format!("[updater] downloaded {chunk_len}/{total} bytes")),
                    None => state.logs.push(format!("[updater] downloaded {chunk_len} bytes")),
                }
            },
            {
                let done_app = app.clone();
                move || done_app.state::<AppState>().logs.push("[updater] download finished, installing")
            },
        )
        .await;

    match result {
        Ok(()) => {
            let should_relaunch = app
                .dialog()
                .message("Calame a été mis à jour. Redémarrer maintenant ?")
                .kind(MessageDialogKind::Info)
                .title("Calame")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Redémarrer".to_string(),
                    "Plus tard".to_string(),
                ))
                .blocking_show();
            if should_relaunch {
                app.restart();
            }
        }
        Err(err) => {
            log_error(&app, &format!("installing update {version}: {err}"));
            if interactive {
                show_error_dialog(&app, &format!("Échec de l'installation de la mise à jour.\n\n{err}"));
            }
        }
    }
}

/// Records an updater failure to the shared log ring, matching the sidecar's
/// own `[error]`-tagged log lines (see [`crate::server`]).
fn log_error(app: &AppHandle, message: &str) {
    eprintln!("Calame: updater error: {message}");
    app.state::<AppState>().logs.push(format!("[updater] [error] {message}"));
}

/// Shows a blocking native info dialog.
fn show_info_dialog(app: &AppHandle, message: &str) {
    app.dialog()
        .message(message)
        .kind(MessageDialogKind::Info)
        .title("Calame")
        .blocking_show();
}

/// Shows a blocking native error dialog.
fn show_error_dialog(app: &AppHandle, message: &str) {
    app.dialog()
        .message(message)
        .kind(MessageDialogKind::Error)
        .title("Calame")
        .blocking_show();
}
