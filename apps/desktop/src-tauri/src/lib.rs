//! Tauri application entry point (see [`run`]). Ties together:
//!   - the shell/dialog/single-instance/updater/process plugins,
//!   - the [`state::AppState`] shared with the tray and server modules,
//!   - the sidecar lifecycle in [`server`] (spawn on startup, poll for
//!     health, navigate the splash window over once ready),
//!   - the tray icon in [`tray`],
//!   - the silent startup update check in [`updater`],
//!   - hide-instead-of-quit window behaviour, and
//!   - killing the sidecar on every exit path.

mod server;
mod state;
mod tray;
mod updater;

use tauri::{RunEvent, WindowEvent};

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_and_focus_main(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::default())
        .setup(|app| {
            tray::build(app.handle())?;
            server::launch(app.handle().clone());
            // Silent check: only surfaces a dialog if an update is actually
            // found (see `updater::check_for_updates`). Runs after the
            // server launch call, but doesn't block on it — the sidecar
            // spawn and health poll proceed independently on their own
            // threads.
            updater::check_for_updates(app.handle().clone(), false);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Keep running in the tray instead of exiting when the user
                // closes the window — the sidecar stays up, and "Ouvrir
                // Calame" (menu item, left tray click, or a second app
                // launch) brings the window back without restarting it.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Calame application");

    app.run(|app_handle, event| {
        // Covers every way the process can end: the tray's "Quitter" item
        // already kills the sidecar itself before calling `app.exit(0)`,
        // but ExitRequested/Exit also fire on paths we don't originate
        // (OS shutdown/logoff, etc). kill_child() is idempotent, so calling
        // it again here is harmless — this is the last line of defense
        // against an orphaned node.exe.
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            server::kill_child(app_handle);
        }
    });
}
