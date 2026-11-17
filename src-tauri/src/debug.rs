// Debug log: off until Settings > Debug turns it on. Each line goes to a ring the Settings console reads,
// to that console live as debug:line, and to ~/.frugal-deck/debug.log, so a crash or a restart keeps it.
// Times are UTC, like the timestamps in Claude Code transcripts, so the two line up.

use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;

static ON: AtomicBool = AtomicBool::new(false);
static APP: OnceLock<AppHandle> = OnceLock::new();
static LINES: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
const KEEP: usize = 2000;
// frugal: past this size the file starts over at the next launch; rotate to debug.log.1 if older lines turn out to matter.
const MAX_FILE: u64 = 5 * 1024 * 1024;

// Formats only when the log is on, so an off log costs one atomic read.
#[macro_export]
macro_rules! debug_log {
    ($area:expr, $($arg:tt)*) => { if $crate::debug::on() { $crate::debug::write($area, &format!($($arg)*)); } };
}

fn file() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("USERPROFILE")?).join(".frugal-deck").join("debug.log"))
}

pub fn on() -> bool {
    ON.load(Ordering::Relaxed)
}

pub fn init(app: AppHandle, on: bool) {
    let _ = APP.set(app);
    if let Some(file) = file() {
        let _ = std::fs::create_dir_all(file.parent().unwrap());
        if file.metadata().is_ok_and(|m| m.len() > MAX_FILE) { let _ = std::fs::remove_file(file); }
    }
    set(on);
}

fn set(on: bool) {
    if on {
        ON.store(true, Ordering::Relaxed);
        write("debug", &format!("log on, Frugal Deck {}", env!("CARGO_PKG_VERSION")));
    } else if ON.swap(false, Ordering::Relaxed) {
        write("debug", "log off");
    }
}

fn stamp() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
    let s = ms / 1000;
    format!("{:02}:{:02}:{:02}.{:03}Z", s / 3600 % 24, s / 60 % 60, s % 60, ms % 1000)
}

pub fn write(area: &str, text: &str) {
    let line = format!("{} {area:<7} {}", stamp(), text.replace(['\r', '\n'], " "));
    {
        let mut lines = LINES.lock().unwrap();
        if lines.len() == KEEP { lines.pop_front(); }
        lines.push_back(line.clone());
    }
    if let Some(file) = file() {
        let _ = std::fs::OpenOptions::new().create(true).append(true).open(file).and_then(|mut f| writeln!(f, "{line}"));
    }
    if let Some(app) = APP.get() { let _ = app.emit("debug:line", [&line]); }
}

#[tauri::command]
pub fn debug_set(on: bool) {
    set(on);
}

#[tauri::command]
pub fn debug_lines() -> Vec<String> {
    LINES.lock().unwrap().iter().cloned().collect()
}

#[tauri::command]
pub fn debug_clear() {
    LINES.lock().unwrap().clear();
    if let Some(file) = file() { let _ = std::fs::remove_file(file); }
}

// The renderer's own lines: clicks, tab changes, handoff decisions, errors.
#[tauri::command]
pub fn debug_log(area: String, text: String) {
    if on() { write(&area.chars().take(12).collect::<String>(), &text.chars().take(2000).collect::<String>()); }
}

// Shows debug.log in Explorer, or its folder before anything was written.
#[tauri::command]
pub fn debug_reveal(app: AppHandle) {
    let Some(file) = file() else { return };
    let _ = if file.exists() { app.opener().reveal_item_in_dir(&file) } else { app.opener().open_path(file.parent().unwrap().to_string_lossy(), None::<&str>) };
}
