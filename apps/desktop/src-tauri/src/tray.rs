//! System tray icon: menu ("Ouvrir Calame" / "Redémarrer le serveur" /
//! "Vérifier les mises à jour" / "Réinitialiser le compte administrateur…" /
//! "Quitter") and left-click-to-focus
//! behaviour. Once the main window is hidden (see the `CloseRequested`
//! handler in [`crate::run`]), the tray is the only way back into the app.

use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::{recovery, server, updater};

const MENU_OPEN: &str = "tray-open";
const MENU_RESTART: &str = "tray-restart";
const MENU_CHECK_UPDATES: &str = "tray-check-updates";
const MENU_RESET_ADMIN: &str = "tray-reset-admin";
const MENU_QUIT: &str = "tray-quit";

/// Builds and registers the system tray icon and its menu.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text(MENU_OPEN, "Ouvrir Calame")
        .text(MENU_RESTART, "Redémarrer le serveur")
        .text(MENU_CHECK_UPDATES, "Vérifier les mises à jour")
        .separator()
        // Native only: no Tauri command or HTTP route reaches this (see
        // `recovery`), and it asks for confirmation before changing anything.
        .text(MENU_RESET_ADMIN, "Réinitialiser le compte administrateur…")
        .separator()
        .text(MENU_QUIT, "Quitter")
        .build()?;

    let icon = app
        .default_window_icon()
        .cloned()
        .expect("app icon must be configured in tauri.conf.json");

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("Calame")
        .on_menu_event(|app, event| match event.id.as_ref() {
            MENU_OPEN => show_and_focus_main(app),
            MENU_RESTART => server::restart(app.clone()),
            MENU_CHECK_UPDATES => updater::check_for_updates(app.clone(), true),
            MENU_RESET_ADMIN => recovery::reset_admin_account(app.clone()),
            MENU_QUIT => {
                server::kill_child(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_and_focus_main(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/// Shows and focuses the main window. Used by the tray's "Ouvrir Calame"
/// item, a left tray-icon click, and a second app launch caught by the
/// single-instance plugin.
pub fn show_and_focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
