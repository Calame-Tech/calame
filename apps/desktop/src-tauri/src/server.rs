//! Lifecycle of the bundled Node sidecar that serves the Calame web app:
//! picking a port, resolving the packaged resources (identically under
//! `tauri dev` and in a bundled install), spawning/killing the process, and
//! polling it for readiness before switching the splash window over to the
//! real UI.

use std::net::TcpListener;
use std::thread;
use std::time::{Duration, Instant};

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::state::AppState;

/// Preferred port for the Calame server; falls back to an OS-assigned free
/// port (see [`pick_port`]) if something else on the machine already holds
/// it.
const PREFERRED_PORT: u16 = 4567;

const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(500);
const HEALTH_POLL_TIMEOUT: Duration = Duration::from_secs(30);

/// Picks the port the sidecar should listen on: [`PREFERRED_PORT`] if free,
/// otherwise an ephemeral port handed out by the OS. This only *tests*
/// availability — the probing listener is dropped immediately so the
/// sidecar can bind the same port right after.
fn pick_port() -> u16 {
    if TcpListener::bind(("127.0.0.1", PREFERRED_PORT)).is_ok() {
        return PREFERRED_PORT;
    }
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .expect("failed to bind an ephemeral port for the Calame server")
}

/// Resolves the bundled server entry point and web asset directory.
///
/// Uses `BaseDirectory::Resource`, which Tauri resolves relative to
/// `src-tauri/` under `tauri dev` and relative to the installed app's
/// resource directory in a bundled build — the same relative path
/// (`resources/server/...`, matching `bundle.resources` in
/// `tauri.conf.json`) resolves correctly in both.
fn resolve_server_paths(app: &AppHandle) -> Result<(String, String), String> {
    let server_js = app
        .path()
        .resolve("resources/server/server.mjs", BaseDirectory::Resource)
        .map_err(|err| format!("resolving resources/server/server.mjs: {err}"))?;
    let web_dist = app
        .path()
        .resolve("resources/server/web", BaseDirectory::Resource)
        .map_err(|err| format!("resolving resources/server/web: {err}"))?;
    Ok((
        server_js.to_string_lossy().into_owned(),
        web_dist.to_string_lossy().into_owned(),
    ))
}

/// Spawns the `node` sidecar against `port`, wiring its stdout/stderr into
/// the shared [`AppState::logs`] ring buffer for later diagnostics.
fn spawn_sidecar(app: &AppHandle, port: u16) -> Result<CommandChild, String> {
    let (server_js, web_dist) = resolve_server_paths(app)?;
    let version = app.package_info().version.to_string();

    let command = app
        .shell()
        .sidecar("node")
        .map_err(|err| format!("resolving the node sidecar binary: {err}"))?
        .args([server_js, "--port".to_string(), port.to_string()])
        .env("CALAME_PACKAGED", "1")
        .env("CALAME_WEB_DIST", web_dist)
        .env("CALAME_VERSION", version);

    let (mut rx, child) = command
        .spawn()
        .map_err(|err| format!("spawning the node sidecar: {err}"))?;

    let log_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            let state = log_app.state::<AppState>();
            match event {
                CommandEvent::Stdout(bytes) => state
                    .logs
                    .push(format!("[stdout] {}", String::from_utf8_lossy(&bytes).trim_end())),
                CommandEvent::Stderr(bytes) => state
                    .logs
                    .push(format!("[stderr] {}", String::from_utf8_lossy(&bytes).trim_end())),
                CommandEvent::Error(err) => state.logs.push(format!("[error] {err}")),
                CommandEvent::Terminated(payload) => {
                    state.logs.push(format!("[terminated] {payload:?}"));
                    *state.child.lock().unwrap() = None;
                }
                _ => {}
            }
        }
    });

    Ok(child)
}

/// Kills the currently tracked sidecar, if any. Idempotent and safe to call
/// from every exit path (tray "Quitter", `RunEvent::ExitRequested`,
/// `RunEvent::Exit`, or right before a restart) — never leaves an orphaned
/// `node.exe` behind.
pub fn kill_child(app: &AppHandle) {
    let state = app.state::<AppState>();
    let child = state.child.lock().unwrap().take();
    if let Some(child) = child {
        let _ = child.kill();
    }
}

/// Spawns the sidecar for `port`, stores it in state, and kicks off the
/// background health poll that will navigate the main window once the
/// server is ready (or report the failure otherwise).
fn spawn_and_monitor(app: AppHandle, port: u16) {
    match spawn_sidecar(&app, port) {
        Ok(child) => {
            *app.state::<AppState>().child.lock().unwrap() = Some(child);
            poll_health_then_navigate(app, port);
        }
        Err(err) => {
            eprintln!("Calame: failed to start the server sidecar: {err}");
            show_error_dialog(&app, &format!("Impossible de démarrer le serveur Calame.\n\n{err}"));
        }
    }
}

/// First launch: pick a port, remember it in state, then spawn + monitor.
pub fn launch(app: AppHandle) {
    let port = pick_port();
    *app.state::<AppState>().port.lock().unwrap() = Some(port);
    spawn_and_monitor(app, port);
}

/// "Redémarrer le serveur": kill the current sidecar, reuse the port it was
/// launched with (falling back to picking a fresh one if state somehow has
/// none yet), and go through the same spawn + health-poll + navigate
/// sequence as the initial launch.
pub fn restart(app: AppHandle) {
    kill_child(&app);
    let port = {
        let state = app.state::<AppState>();
        let stored: Option<u16> = *state.port.lock().unwrap();
        stored.unwrap_or_else(pick_port)
    };
    spawn_and_monitor(app, port);
}

/// Polls `GET /health` on a background thread every
/// [`HEALTH_POLL_INTERVAL`] for up to [`HEALTH_POLL_TIMEOUT`]. On success,
/// navigates the main window from the splash screen to the running server;
/// on timeout, leaves the splash up and shows an error dialog with the
/// sidecar's recent output.
fn poll_health_then_navigate(app: AppHandle, port: u16) {
    thread::spawn(move || {
        let health_url = format!("http://127.0.0.1:{port}/health");
        let deadline = Instant::now() + HEALTH_POLL_TIMEOUT;
        let healthy = loop {
            if matches!(ureq::get(&health_url).call(), Ok(response) if response.status() == 200) {
                break true;
            }
            if Instant::now() >= deadline {
                break false;
            }
            thread::sleep(HEALTH_POLL_INTERVAL);
        };

        if healthy {
            let app_url = format!("http://127.0.0.1:{port}/");
            let nav_app = app.clone();
            let _ = app.run_on_main_thread(move || navigate_main_window(&nav_app, &app_url));
        } else {
            let tail = app.state::<AppState>().logs.tail(20);
            let dialog_app = app.clone();
            let _ = app.run_on_main_thread(move || {
                let details = if tail.is_empty() {
                    "Aucune sortie du serveur n'a été capturée.".to_string()
                } else {
                    tail
                };
                show_error_dialog(
                    &dialog_app,
                    &format!("Le serveur Calame n'a pas répondu après 30 secondes.\n\n{details}"),
                );
            });
        }
    });
}

/// Switches the main window (still showing the splash screen) over to the
/// now-healthy server, and brings it to the front.
fn navigate_main_window(app: &AppHandle, url: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Ok(target) = Url::parse(url) {
        let _ = window.navigate(target);
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// Shows a blocking native error dialog. Must be called from the main
/// thread (e.g. via [`tauri::AppHandle::run_on_main_thread`]).
fn show_error_dialog(app: &AppHandle, message: &str) {
    app.dialog()
        .message(message)
        .kind(MessageDialogKind::Error)
        .title("Calame")
        .blocking_show();
}
