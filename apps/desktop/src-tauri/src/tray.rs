//! System tray icon: menu ("Ouvrir Calame" / "Redémarrer le serveur" /
//! "Quitter") and left-click-to-focus behaviour. Once the main window is
//! hidden (see the `CloseRequested` handler in [`crate::run`]), the tray is
//! the only way back into the app.

use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::server;

const MENU_OPEN: &str = "tray-open";
const MENU_RESTART: &str = "tray-restart";
const MENU_QUIT: &str = "tray-quit";

/// Builds and registers the system tray icon and its menu.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text(MENU_OPEN, "Ouvrir Calame")
        .text(MENU_RESTART, "Redémarrer le serveur")
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
