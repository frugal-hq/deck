// ~/.frugal-deck/activity.jsonl: account logins, MCP sign-ins and plugin changes, one JSON line each, shown live in Settings > Activity.
// What changes outside the Deck (a delegate's login, Claude Code asking for an MCP sign-in, a plugin update) is found by comparing snapshots.
// frugal: changes made while the Deck is closed are not logged; persist the last snapshot to catch them.

use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

static APP: OnceLock<AppHandle> = OnceLock::new();
static FILE: OnceLock<PathBuf> = OnceLock::new();
static WRITE: Mutex<()> = Mutex::new(());
const SHOWN: usize = 300;
const MAX_FILE: u64 = 2 * 1024 * 1024;

pub fn log(kind: &str, text: &str) {
    let Some(file) = FILE.get() else { return };
    let at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let entry = json!({ "at": at, "kind": kind, "text": text });
    {
        let _guard = WRITE.lock().unwrap();
        // Over the cap the file starts again and the old one is kept once.
        if std::fs::metadata(file).is_ok_and(|m| m.len() > MAX_FILE) { let _ = std::fs::rename(file, file.with_extension("jsonl.old")); }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file) { let _ = writeln!(f, "{entry}"); }
    }
    if let Some(app) = APP.get() { let _ = app.emit("activity", [entry]); }
}

#[tauri::command]
pub fn activity_list() -> Vec<Value> {
    let text = FILE.get().and_then(|file| std::fs::read_to_string(file).ok()).unwrap_or_default();
    let entries: Vec<Value> = text.lines().filter_map(|line| serde_json::from_str(line).ok()).collect();
    entries[entries.len().saturating_sub(SHOWN)..].to_vec()
}

// Results only the window sees: Import and clean, and chats left on their old settings.
#[tauri::command]
pub fn activity_add(kind: String, text: String) {
    if matches!(kind.as_str(), "clean" | "states") && !text.trim().is_empty() && text.len() <= 4000 { log(&kind, &text); }
}

#[derive(Default)]
struct Snapshot {
    logged_in: BTreeMap<String, bool>,
    // By account id: the servers in its mcp-needs-auth-cache.json; an account without the file is left out.
    needs_auth: BTreeMap<String, BTreeSet<String>>,
    plugins: BTreeMap<String, String>,
}

fn read(file: &Path) -> Option<Value> { serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok() }

// Frugal's accounts.json lists every account, the main one included; a Claude account is logged in while its .credentials.json holds a claude.ai token.
fn snapshot(home: &Path) -> Snapshot {
    let mut s = Snapshot::default();
    for account in read(&home.join(".frugal/accounts.json")).unwrap_or_default()["accounts"].as_array().into_iter().flatten() {
        let Some(id) = account["id"].as_str() else { continue };
        let dir = account["config_dir"].as_str().map(PathBuf::from);
        let claude_token = || dir.as_ref().is_some_and(|dir| crate::accounts::has_claude_token(dir));
        s.logged_in.insert(id.to_owned(), account["needs_login"] != true && (account["kind"] != "claude" || claude_token()));
        if let Some(cache) = dir.and_then(|dir| read(&dir.join("mcp-needs-auth-cache.json"))) {
            s.needs_auth.insert(id.to_owned(), cache.as_object().map(|names| names.keys().cloned().collect()).unwrap_or_default());
        }
    }
    for (name, installs) in read(&home.join(".frugal-deck/store/plugins/installed_plugins.json")).unwrap_or_default()["plugins"].as_object().into_iter().flatten() {
        if let Some(version) = installs[0]["version"].as_str() { s.plugins.insert(name.clone(), version.to_owned()); }
    }
    s
}

fn changes(old: &Snapshot, new: &Snapshot) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    for (id, &now) in &new.logged_in {
        match old.logged_in.get(id) {
            None => out.push(("account", format!("{id} added{}", if now { "" } else { ", logged out" }))),
            Some(&was) if was != now => out.push(("account", format!("{id} {}", if now { "logged in" } else { "logged out" }))),
            _ => {}
        }
    }
    for id in old.logged_in.keys().filter(|id| !new.logged_in.contains_key(*id)) { out.push(("account", format!("{id} removed"))); }
    // Only accounts in both, so a cache file Claude Code deletes or creates whole never floods the log.
    for (id, names) in &new.needs_auth {
        let Some(was) = old.needs_auth.get(id) else { continue };
        for name in names.difference(was) { out.push(("mcp", format!("{name} needs sign-in in {id}"))); }
        for name in was.difference(names) { out.push(("mcp", format!("{name} connects again in {id}"))); }
    }
    for (name, version) in &new.plugins {
        match old.plugins.get(name) {
            None => out.push(("plugin", format!("{name} {version} added to the store"))),
            Some(was) if was != version => out.push(("plugin", format!("{name} updated from {was} to {version}"))),
            _ => {}
        }
    }
    for name in old.plugins.keys().filter(|name| !new.plugins.contains_key(*name)) { out.push(("plugin", format!("{name} removed from the store"))); }
    out
}

pub fn init(app: AppHandle, home: PathBuf) {
    let _ = FILE.set(home.join(".frugal-deck/activity.jsonl"));
    let _ = APP.set(app);
    std::thread::spawn(move || {
        let mut last = snapshot(&home);
        loop {
            std::thread::sleep(Duration::from_secs(20));
            let now = snapshot(&home);
            for (kind, text) in changes(&last, &now) { log(kind, &text); }
            last = now;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changes_name_what_moved() {
        let set = |names: &[&str]| names.iter().map(|n| n.to_string()).collect::<BTreeSet<_>>();
        let map = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<BTreeMap<_, _>>();
        let old = Snapshot {
            logged_in: [("main".into(), true), ("x5".into(), true), ("gone".into(), true)].into(),
            needs_auth: [("main".into(), set(&["a", "b"]))].into(),
            plugins: map(&[("frugal@frugal", "0.30.4"), ("old@m", "1")]),
        };
        let new = Snapshot {
            logged_in: [("main".into(), true), ("x5".into(), false), ("sm".into(), true)].into(),
            needs_auth: [("main".into(), set(&["b", "c"])), ("sm".into(), set(&["z"]))].into(),
            plugins: map(&[("frugal@frugal", "0.30.5"), ("new@m", "2")]),
        };
        let texts: Vec<_> = changes(&old, &new).into_iter().map(|(_, text)| text).collect();
        assert_eq!(texts, [
            "sm added", "x5 logged out", "gone removed",
            "c needs sign-in in main", "a connects again in main",
            "frugal@frugal updated from 0.30.4 to 0.30.5", "new@m 2 added to the store", "old@m removed from the store",
        ]);
        assert!(changes(&new, &new).is_empty());
    }
}
