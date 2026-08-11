// Prevents an additional console window from appearing on Windows in
// release builds. Keep it in debug builds so eprintln!/println! diagnostics
// (sidecar logs, startup failures) stay visible when running from a shell.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    calame_desktop_lib::run();
}
