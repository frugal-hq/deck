// `claude mcp list` output: one server per health line, named and with its status.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use crate::accounts::{mcp_entry, mcp_scope, run, Accounts};
use crate::chat::{account_env, find_claude, NO_CLAUDE};

const CHECKING: &str = "Checking MCP server health";

// mcp.js:2-19: the name is everything through the separator; the status is after the last " - ".
pub fn parse_mcp_list(text: &str) -> Vec<Value> {
    let mut servers = Vec::new();
    for raw in text.split('\n') {
        let line = raw.trim();
        if line.is_empty() { continue; }
        if line.chars().take(CHECKING.chars().count()).collect::<String>().eq_ignore_ascii_case(CHECKING) { continue; }
        let Some(end) = line.char_indices().find_map(|(i, c)| (c != ':' && line[i + c.len_utf8()..].starts_with(": ")).then_some(i + c.len_utf8())) else { continue };
        let name = line[..end].trim();
        let rest = line[end + 2..].trim();
        let Some(dash) = rest.rfind(" - ") else { continue };
        let status = rest[dash + 3..].trim();
        if name.is_empty() || status.is_empty() { continue; }
        let mut target = rest[..dash].trim();
        let mut transport = if target.starts_with("https://") || target.starts_with("http://") { "http" } else { "stdio" };
        for (suffix, kind) in [(" (HTTP)", "http"), (" (SSE)", "sse")] {
            if let Some(stripped) = target.strip_suffix(suffix) { (target, transport) = (stripped, kind); }
        }
        servers.push(json!({ "name": name, "status": status, "target": target, "transport": transport }));
    }
    servers
}

// The allowlist entry `claude mcp list` shows for a server. frugal: a stdio command is split on spaces, so an argument with spaces never matches.
fn listed_entry(server: &Value) -> Option<Value> {
    let target = server["target"].as_str()?;
    let mut words = target.split_whitespace();
    mcp_entry(server["transport"].as_str()?, &json!({ "url": target, "command": words.next()?, "args": words.collect::<Vec<_>>() }))
}

// A Deck server as --mcp-config holds it, or None when it is not well formed.
// frugal: a stdio command is split on spaces, and env vars and headers are not offered; add them to the form if a server needs them.
pub fn server_config(server: &Value) -> Option<(String, Value)> {
    let name = server["name"].as_str()?;
    let target = server["target"].as_str()?.trim();
    let named = name.len() <= 64 && name.starts_with(|c: char| c.is_ascii_alphanumeric()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !named || target.is_empty() || target.len() > 2000 { return None; }
    let config = match server["transport"].as_str()? {
        transport @ ("http" | "sse") if (target.starts_with("https://") || target.starts_with("http://")) && !target.contains(char::is_whitespace) => json!({ "type": transport, "url": target }),
        "stdio" => {
            let mut words = target.split_whitespace();
            json!({ "type": "stdio", "command": words.next()?, "args": words.collect::<Vec<_>>() })
        }
        _ => return None,
    };
    Some((name.to_owned(), config))
}

#[tauri::command]
pub fn mcp_add(accounts: State<'_, Mutex<Accounts>>, server: Value) -> Value {
    let Some((name, config)) = server_config(&server) else { return json!({ "error": "Check the name and the URL or command." }) };
    match accounts.lock().unwrap().add_deck_server(&name, config) {
        Ok(()) => json!({ "ok": true, "name": name }),
        Err(error) => json!({ "error": error.to_string() }),
    }
}

// main.js:460-477. Every account's servers, unfiltered, merged by name with the accounts that have them; the global list runs in the home folder.
// The allowlist entries seen are kept for chat launches.
#[tauri::command]
pub async fn mcp_list(app: AppHandle, scope: Value) -> std::result::Result<Value, ()> {
    Ok(tauri::async_runtime::spawn_blocking(move || list(&app.state::<Mutex<Accounts>>(), &scope)).await.unwrap_or_else(|e| json!({ "error": e.to_string() })))
}

// Chats need Frugal's server's exact command to allow it, and only a listing shows it. It changes when the plugin moves or updates, so every start lists again.
pub fn learn_frugal(app: AppHandle) {
    thread::spawn(move || {
        let accounts = app.state::<Mutex<Accounts>>();
        list(&accounts, &json!({ "global": true }));
    });
}

pub fn list(accounts: &Mutex<Accounts>, scope: &Value) -> Value {
    let Some(scope) = mcp_scope(scope) else { return json!({ "error": "Invalid folder." }) };
    let Some(claude) = find_claude() else { return json!({ "error": NO_CLAUDE }) };
    let global = scope["global"] == true;
    let (runs, folder, off, on, all, deck) = {
        let a = accounts.lock().unwrap();
        let runs: Vec<(Value, HashMap<String, String>)> = a.labeled_accounts().into_iter().map(|account| { let env = account_env(&a, &account); (account["name"].clone(), env) }).collect();
        let folder = if global { a.home.clone() } else { PathBuf::from(scope["folder"].as_str().unwrap_or_default()) };
        let list = |field: Option<Result<Value, _>>| field.and_then(Result::ok).unwrap_or_else(|| json!([]));
        (runs, folder, list((!global).then(|| a.mcp_off(&scope))), list((!global).then(|| a.mcp_on(&scope))), a.mcp_global(), a.deck_servers())
    };
    let count = runs.len();
    let lists = thread::scope(|threads| {
        let (claude, folder) = (&claude, &folder);
        let jobs: Vec<_> = runs.iter().map(|(name, env)| threads.spawn(move || {
            let mut command = Command::new(claude);
            command.env_clear().envs(env).args(["mcp", "list"]).current_dir(folder).stdin(Stdio::null());
            (name.clone(), run(&mut command, Duration::from_secs(60)).map_err(|e| e.to_string()))
        })).collect();
        jobs.into_iter().map(|job| job.join().unwrap_or((Value::Null, Err("Listing failed.".into())))).collect::<Vec<_>>()
    });
    let mut servers: Vec<Value> = Vec::new();
    let mut learned = serde_json::Map::new();
    let mut error = None;
    for (account, listed) in lists {
        let out = match listed { Ok(out) => out, Err(e) => { error.get_or_insert(e.trim().to_owned()); continue; } };
        for mut server in parse_mcp_list(&String::from_utf8_lossy(&out)) {
            let name = server["name"].as_str().unwrap_or_default().to_owned();
            if let Some(entry) = listed_entry(&server) {
                let entries = learned.entry(name.clone()).or_insert_with(|| json!([])).as_array_mut().unwrap();
                if !entries.contains(&entry) { entries.push(entry); }
            }
            match servers.iter_mut().find(|known| known["name"] == name.as_str()) {
                Some(known) => {
                    let owners = known["accounts"].as_array_mut().unwrap();
                    if !owners.contains(&account) { owners.push(account.clone()); }
                    if !connected(&known["status"]) && connected(&server["status"]) { known["status"] = server["status"].take(); }
                }
                None => { server["accounts"] = json!([account.clone()]); servers.push(server); }
            }
        }
    }
    if let (true, Some(error)) = (servers.is_empty(), error) { return json!({ "error": error }); }
    let _ = accounts.lock().unwrap().learn_mcp_targets(learned);
    json!({ "servers": servers, "off": off, "on": on, "global": all, "deck": deck, "accounts": count })
}

// Windows prints "√ Connected" and others "✓ Connected"; a failure says "Failed to connect".
fn connected(status: &Value) -> bool { status.as_str().is_some_and(|s| s.contains("Connected")) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_config_rejects_bad_names_and_targets() {
        let server = |name: &str, transport: &str, target: &str| server_config(&json!({ "name": name, "transport": transport, "target": target }));
        assert_eq!(server("notion", "http", "https://mcp.notion.com/mcp"), Some(("notion".into(), json!({ "type": "http", "url": "https://mcp.notion.com/mcp" }))));
        assert_eq!(server("air", "stdio", " npx -y  airtable-mcp-server ").unwrap().1, json!({ "type": "stdio", "command": "npx", "args": ["-y", "airtable-mcp-server"] }));
        assert!(server("--help", "http", "https://x").is_none());
        assert!(server("a b", "http", "https://x").is_none());
        assert!(server("a", "http", "file:///c").is_none());
        assert!(server("a", "http", "https://x y").is_none());
        assert!(server("a", "ws", "https://x").is_none());
        assert!(server("a", "stdio", "   ").is_none());
    }

    // mcp.check.js:5-18: 1 assertion ported.
    #[test]
    fn parses_list_output() {
        let sample = [
            "Checking MCP server health...",
            "",
            "claude.ai Linear: https://mcp.linear.app/mcp - ✓ Connected",
            "plugin:frugal:accounts: python server.py - ✓ Connected",
            "pylon: https://x/mcp (HTTP) - ✗ Failed to connect",
            "Header line",
        ].join("\n");
        let servers = parse_mcp_list(&sample);
        assert_eq!(servers, vec![
            json!({ "name": "claude.ai Linear", "status": "✓ Connected", "target": "https://mcp.linear.app/mcp", "transport": "http" }),
            json!({ "name": "plugin:frugal:accounts", "status": "✓ Connected", "target": "python server.py", "transport": "stdio" }),
            json!({ "name": "pylon", "status": "✗ Failed to connect", "target": "https://x/mcp", "transport": "http" }),
        ]);
        let entries: Vec<_> = servers.iter().filter_map(listed_entry).collect();
        assert_eq!(entries, [json!({ "serverUrl": "https://mcp.linear.app/mcp" }), json!({ "serverCommand": ["python", "server.py"] }), json!({ "serverUrl": "https://x/mcp" })]);
    }
}