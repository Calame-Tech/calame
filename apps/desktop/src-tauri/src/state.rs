//! Shared application state: the currently running sidecar process handle,
//! the port it was told to listen on, and a small ring buffer of its recent
//! stdout/stderr output (surfaced in the startup-failure dialog).

use std::collections::VecDeque;
use std::sync::Mutex;

use tauri_plugin_shell::process::CommandChild;

/// Number of most recent sidecar log lines kept for diagnostics.
const LOG_CAPACITY: usize = 50;

/// Rolling buffer of the sidecar's last [`LOG_CAPACITY`] stdout/stderr lines.
#[derive(Default)]
pub struct LogRing(Mutex<VecDeque<String>>);

impl LogRing {
    pub fn push(&self, line: impl Into<String>) {
        let mut lines = self.0.lock().unwrap();
        if lines.len() >= LOG_CAPACITY {
            lines.pop_front();
        }
        lines.push_back(line.into());
    }

    /// Returns the last `n` lines (oldest first), joined with newlines.
    pub fn tail(&self, n: usize) -> String {
        let lines = self.0.lock().unwrap();
        let skip = lines.len().saturating_sub(n);
        lines.iter().skip(skip).cloned().collect::<Vec<_>>().join("\n")
    }
}

/// Tauri-managed state shared between the setup code, the tray menu, and the
/// background health-poll thread.
#[derive(Default)]
pub struct AppState {
    /// The currently running Node sidecar, if any. Taken out (and killed) on
    /// every exit path and before every restart, so it never dangles.
    pub child: Mutex<Option<CommandChild>>,
    /// The port the sidecar was launched with, remembered so "Redémarrer le
    /// serveur" can reuse it instead of picking a new one.
    pub port: Mutex<Option<u16>>,
    /// Recent sidecar output, used to explain a startup failure.
    pub logs: LogRing,
}
