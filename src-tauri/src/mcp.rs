// `claude mcp list` output: one server per health line, named and with its status.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use crate::accounts::{mcp_entry, mcp_scope, object, read_json, read_strict, run, write_json, Accounts};use crate::chat::{account_env, find_claude, NO_CLAUDE};

const CHECKING: &str = "Checking MCP server health";
// In the backup, the owner and place of the Deck's own servers, and the place of an account's user servers; account ids and folders never take them.
const DECK: &str = ":deck";
const USER: &str = "user";

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
    if !valid_name(name) || target.is_empty() || target.len() > 2000 { return None; }
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

fn valid_name(name: &str) -> bool {
    name.len() <= 64 && name.starts_with(|c: char| c.is_ascii_alphanumeric()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn backup_file(home: &Path) -> PathBuf { home.join(".frugal-deck/mcp-backup.json") }

// A .claude.json's servers by place: "user" for the top level, and each project folder for its local ones.
fn places(config: &Value) -> serde_json::Map<String, Value> {
    let mut places = serde_json::Map::new();
    if let Some(servers) = config["mcpServers"].as_object() { places.insert(USER.into(), json!(servers)); }
    for (folder, project) in config["projects"].as_object().into_iter().flatten() {
        if let Some(servers) = project["mcpServers"].as_object() { places.insert(folder.clone(), json!(servers)); }
    }
    places
}

// Adds or updates the owner's servers seen now, and returns the backed-up ones gone from their place: (place, name, config).
fn merge(backup: &mut Value, owner: &str, now: &serde_json::Map<String, Value>) -> Vec<(String, String, Value)> {
    for (place, servers) in now {
        for (name, config) in servers.as_object().into_iter().flatten() {
            let saved = object(object(backup).entry(owner).or_insert_with(|| json!({}))).entry(place.as_str()).or_insert_with(|| json!({}));
            object(saved).insert(name.clone(), config.clone());
        }
    }
    let mut gone = Vec::new();
    for (place, servers) in backup[owner].as_object().into_iter().flatten() {
        for (name, config) in servers.as_object().into_iter().flatten() {
            if now.get(place).and_then(|servers| servers.get(name)).is_none() { gone.push((place.clone(), name.clone(), config.clone())); }
        }
    }
    gone
}

// What the backup reads: each account's servers by place, or None when its file is unreadable, and the Deck's own.
fn sources(a: &Accounts) -> Vec<(String, Value, Option<serde_json::Map<String, Value>>)> {
    let mut sources: Vec<_> = a.labeled_accounts().iter().map(|account| {
        (account["id"].as_str().unwrap_or_default().to_owned(), account["name"].clone(), read_strict(&a.claude_json(account), json!({})).ok().map(|config| places(&config)))
    }).collect();
    sources.push((DECK.into(), json!("Deck"), Some(serde_json::Map::from_iter([(DECK.to_owned(), a.deck_servers())]))));
    sources
}

// Every Claude account's user and local servers and the Deck's own go into ~/.frugal-deck/mcp-backup.json, full config included,
// added or updated and never removed, so a server gone from its file can be put back. An unreadable file is skipped, so it never looks emptied.
fn backup(home: &Path, sources: Vec<(String, Value, Option<serde_json::Map<String, Value>>)>) -> Vec<Value> {
    let file = backup_file(home);
    let Ok(mut saved) = read_strict(&file, json!({})) else { return Vec::new() };
    let before = saved.clone();
    let mut removed = Vec::new();
    for (owner, account, now) in sources {
        let Some(now) = now else { continue };
        for (place, name, config) in merge(&mut saved, &owner, &now) {
            let target = match config["url"].as_str() {
                Some(url) => url.to_owned(),
                None => std::iter::once(&config["command"]).chain(config["args"].as_array().into_iter().flatten()).filter_map(Value::as_str).collect::<Vec<_>>().join(" "),
            };
            let folder = (place != USER && owner != DECK).then(|| place.clone());
            removed.push(json!({ "owner": owner, "account": account, "place": place, "name": name, "folder": folder, "target": target }));
        }
    }
    if saved != before { let _ = write_json(&file, &saved); }
    removed
}

// Puts a backed-up server back where it was: the Deck's list, or `claude mcp add-json` with its account, scope and folder.
#[tauri::command]
pub async fn mcp_restore(app: AppHandle, owner: String, place: String, name: String) -> std::result::Result<Value, ()> {
    Ok(tauri::async_runtime::spawn_blocking(move || match restore(&app.state::<Mutex<Accounts>>(), &owner, &place, &name) {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "error": error }),
    }).await.unwrap_or_else(|e| json!({ "error": e.to_string() })))
}

fn restore(accounts: &Mutex<Accounts>, owner: &str, place: &str, name: &str) -> std::result::Result<(), String> {
    let a = accounts.lock().unwrap();
    let config = read_json(&backup_file(&a.home), json!({}))[owner][place][name].clone();
    if !config.is_object() { return Err("It is no longer in the backup.".into()); }
    if owner == DECK { return a.add_deck_server(name, config).map_err(|e| e.to_string()); }
    if !valid_name(name) { return Err(format!("Add {name} back by hand with claude mcp add-json.")); }
    let account = a.labeled_accounts().into_iter().find(|account| account["id"] == owner).ok_or("That account is no longer in the Deck.")?;
    let env = account_env(&a, &account);
    let (scope, folder) = if place == USER { ("user", a.home.clone()) } else { ("local", PathBuf::from(place)) };
    drop(a);
    if !folder.is_dir() { return Err(format!("{} no longer exists.", folder.display())); }
    let claude = find_claude().ok_or(NO_CLAUDE)?;
    let mut command = Command::new(claude);
    command.env_clear().envs(&env).args(["mcp", "add-json", "-s", scope, name, &config.to_string()]).current_dir(&folder).stdin(Stdio::null());
    run(&mut command, Duration::from_secs(60)).map(drop).map_err(|e| e.to_string().trim().to_owned())
}

// Takes a server off where chats here get it: the Deck's list, or each account's user servers and this folder's local ones.
// It is backed up first, so it shows under Removed and can be restored. claude.ai connectors and plugin servers are removed where they were added.
#[tauri::command]
pub async fn mcp_remove(app: AppHandle, name: String, deck: bool, scope: Value) -> std::result::Result<Value, ()> {
    Ok(tauri::async_runtime::spawn_blocking(move || match remove(&app.state::<Mutex<Accounts>>(), &name, deck, &scope) {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "error": error }),
    }).await.unwrap_or_else(|e| json!({ "error": e.to_string() })))
}

fn remove(accounts: &Mutex<Accounts>, name: &str, deck: bool, scope: &Value) -> std::result::Result<(), String> {
    let scope = mcp_scope(scope).ok_or("Invalid folder.")?;
    let a = accounts.lock().unwrap();
    backup(&a.home, sources(&a));
    if deck { return a.remove_deck_server(name).map_err(|e| e.to_string()); }
    if !valid_name(name) { return Err(format!("Remove {name} where it was added.")); }
    let folder = scope["folder"].as_str();
    let mut jobs = Vec::new();
    for account in a.labeled_accounts() {
        let Ok(config) = read_strict(&a.claude_json(&account), json!({})) else { continue };
        if config["mcpServers"].get(name).is_some() { jobs.push((account_env(&a, &account), USER, a.home.clone())); }
        let Some(folder) = folder else { continue };
        if config["projects"].as_object().into_iter().flatten().any(|(place, project)| same_folder(place, folder) && project["mcpServers"].get(name).is_some()) {
            jobs.push((account_env(&a, &account), "local", PathBuf::from(folder)));
        }
    }
    drop(a);
    if jobs.is_empty() { return Err(format!("No account has {name} as its own server here. Remove it where it was added.")); }
    let claude = find_claude().ok_or(NO_CLAUDE)?;
    for (env, scope, folder) in jobs {
        let mut command = Command::new(&claude);
        command.env_clear().envs(&env).args(["mcp", "remove", "-s", scope, name]).current_dir(&folder).stdin(Stdio::null());
        run(&mut command, Duration::from_secs(60)).map_err(|e| e.to_string().trim().to_owned())?;
    }
    Ok(())
}

// .claude.json keys project folders with forward slashes; the Deck's have backslashes. Windows folders ignore case.
fn same_folder(a: &str, b: &str) -> bool {
    let plain = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
    plain(a) == plain(b)
}

fn expires(token: &Value) -> i64 { token["expiresAt"].as_i64().unwrap_or(0) }

// Puts each server's freshest MCP token (latest expiresAt) into every .credentials.json that lacks it or has an older one; returns which changed.
fn share(creds: &mut [Value]) -> (Vec<bool>, serde_json::Map<String, Value>) {
    let mut best = serde_json::Map::new();
    for c in creds.iter() {
        for (key, token) in c["mcpOAuth"].as_object().into_iter().flatten() {
            if token["accessToken"].as_str().is_some_and(|t| !t.is_empty()) && best.get(key).is_none_or(|known| expires(token) > expires(known)) { best.insert(key.clone(), token.clone()); }
        }
    }
    let changed = creds.iter_mut().map(|c| {
        let mut changed = false;
        for (key, token) in &best {
            let have = &c["mcpOAuth"][key];
            if have.is_null() || expires(have) < expires(token) {
                object(object(c).entry("mcpOAuth").or_insert_with(|| json!({}))).insert(key.clone(), token.clone());
                changed = true;
            }
        }
        changed
    }).collect();
    (changed, best)
}

// The Deck servers some account holds a live token for: a refresh token, or an access token not yet expired.
// `claude mcp list` never sees Deck servers, so this is the only status the panel has. frugal: a revoked token still counts until a chat fails.
fn signed_in(tokens: &serde_json::Map<String, Value>, servers: &Value, now: i64) -> Vec<String> {
    let url = |v: &Value| v.as_str().map(|u| u.trim_end_matches('/').to_owned());
    servers.as_object().into_iter().flatten().filter(|(name, config)| tokens.values().any(|t| {
        t["serverName"] == name.as_str() && url(&t["serverUrl"]).is_some() && url(&t["serverUrl"]) == url(&config["url"])
            && (t["refreshToken"].as_str().is_some_and(|r| !r.is_empty()) || !t["expiresAt"].is_i64() || expires(t) > now)
    })).map(|(name, _)| name.clone()).collect()
}

// One MCP sign-in serves every signed-in Claude account, delegates included. Runs on each listing and chat start, so a refreshed token reaches the others.
// frugal: a server that rotates refresh tokens can sign out an account that refreshed with an older copy at the same time; one new sign-in fixes all.
pub fn share_tokens(a: &Accounts) -> serde_json::Map<String, Value> {
    let (files, mut creds): (Vec<PathBuf>, Vec<Value>) = a.claude_accounts().iter()
        .map(|account| PathBuf::from(account["configDir"].as_str().unwrap_or_default()).join(".credentials.json"))
        .filter(|file| file.is_file())
        .filter_map(|file| read_strict(&file, json!({})).ok().filter(Value::is_object).map(|c| (file, c)))
        .unzip();
    let (changed, best) = share(&mut creds);
    for (i, changed) in changed.into_iter().enumerate() {
        if changed {
            let written = write_json(&files[i], &creds[i]);
            crate::debug_log!("mcp", "MCP tokens copied to {}: {}", files[i].display(), written.as_ref().map_or_else(|e| e.to_string(), |_| "ok".into()));
        }
    }
    best
}

// Which accounts load each server and whether delegates may get it: { name: { accountsOff: [ids], delegates?: bool } }.
#[tauri::command]
pub fn mcp_access_set(accounts: State<'_, Mutex<Accounts>>, changes: Value) -> Value {
    let id = |id: &Value| id.as_str().is_some_and(|id| !id.is_empty() && id.len() <= 100);
    let valid = |name: &String, change: &Value| !name.is_empty() && name.len() <= 200
        && change["accountsOff"].as_array().is_some_and(|ids| ids.len() <= 50 && ids.iter().all(id))
        && change.get("delegates").is_none_or(Value::is_boolean);
    let Some(changes) = changes.as_object().filter(|changes| changes.len() <= 500 && changes.iter().all(|(name, change)| valid(name, change))) else { return json!({ "error": "Invalid request." }) };
    match accounts.lock().unwrap().set_mcp_access(changes) {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "error": error.to_string() }),
    }
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
    let signed;
    let plugin;
    let (runs, folder, off, on, all, deck, sources, home, (accounts_off, no_delegate)) = {
        let a = accounts.lock().unwrap();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
        signed = signed_in(&share_tokens(&a), &a.deck_servers(), now);
        // Chats run the main account's frugal through --plugin-dir, so its server's command, which chats are allowed by, comes from that copy.
        plugin = a.claude_accounts().iter().find(|account| account["id"] == crate::accounts::MAIN).and_then(crate::accounts::frugal_dir);
        let runs: Vec<(Value, Value, HashMap<String, String>)> = a.labeled_accounts().iter().map(|account| (account["name"].clone(), account["id"].clone(), account_env(&a, account))).collect();
        let sources = sources(&a);
        let folder = if global { a.home.clone() } else { PathBuf::from(scope["folder"].as_str().unwrap_or_default()) };
        let list = |field: Option<Result<Value, _>>| field.and_then(Result::ok).unwrap_or_else(|| json!([]));
        (runs, folder, list((!global).then(|| a.mcp_off(&scope))), list((!global).then(|| a.mcp_on(&scope))), a.mcp_global(), a.deck_servers(), sources, a.home.clone(), a.mcp_access())
    };
    let removed = backup(&home, sources);
    let count = runs.len();
    let lists = thread::scope(|threads| {
        let (claude, folder, plugin) = (&claude, &folder, &plugin);
        let jobs: Vec<_> = runs.iter().map(|(name, id, env)| threads.spawn(move || {
            let mut command = Command::new(claude);
            command.env_clear().envs(env);
            if let Some(dir) = plugin {
                command.arg("--plugin-dir").arg(dir);
            }
            command.args(["mcp", "list"]).current_dir(folder).stdin(Stdio::null());
            (name.clone(), id.clone(), run(&mut command, Duration::from_secs(60)).map_err(|e| e.to_string()))
        })).collect();
        jobs.into_iter().map(|job| job.join().unwrap_or((Value::Null, Value::Null, Err("Listing failed.".into())))).collect::<Vec<_>>()
    });
    let mut servers: Vec<Value> = Vec::new();
    let mut learned = serde_json::Map::new();
    let mut error = None;
    for (account, id, listed) in lists {
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
                    let ids = known["accountIds"].as_array_mut().unwrap();
                    if !ids.contains(&id) { ids.push(id.clone()); }
                    object(&mut known["statuses"]).insert(account.as_str().unwrap_or_default().to_owned(), server["status"].clone());
                    if !connected(&known["status"]) && connected(&server["status"]) { known["status"] = server["status"].take(); }
                }
                None => {
                    server["accounts"] = json!([account.clone()]);
                    server["accountIds"] = json!([id.clone()]);
                    server["statuses"] = json!({ account.as_str().unwrap_or_default(): server["status"].clone() });
                    servers.push(server);
                }
            }
        }
    }
    if let (true, Some(error)) = (servers.is_empty(), error) { return json!({ "error": error }); }
    let _ = accounts.lock().unwrap().learn_mcp_targets(learned);
    json!({ "servers": servers, "off": off, "on": on, "global": all, "deck": deck, "accounts": count, "removed": removed, "accountsOff": accounts_off, "noDelegate": no_delegate, "signedIn": signed })
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

    #[test]
    fn backup_keeps_servers_gone_from_their_file() {
        let places = places(&json!({ "mcpServers": { "pylon": { "type": "http", "url": "https://p" } }, "projects": { "C:/a": { "mcpServers": { "drift": { "command": "npx", "args": ["drift"] } } }, "C:/b": {} } }));
        assert_eq!(places.keys().collect::<Vec<_>>(), ["user", "C:/a"]);
        let mut saved = json!({});
        assert!(merge(&mut saved, "main", &places).is_empty());
        let gone = merge(&mut saved, "main", &serde_json::Map::from_iter([(USER.to_owned(), json!({}))]));
        assert_eq!(gone.iter().map(|(place, name, _)| (place.as_str(), name.as_str())).collect::<Vec<_>>(), [("user", "pylon"), ("C:/a", "drift")]);
        assert_eq!(saved["main"]["C:/a"]["drift"]["args"], json!(["drift"]));
        let mut broken = json!({ "main": [1] });
        assert!(merge(&mut broken, "main", &places).is_empty());
        assert!(same_folder("C:/Users/Me/deck", "c:\\users\\me\\Deck\\"));
        assert!(!same_folder("C:/Users/Me/deck", "C:\\Users\\Me\\deck2"));
    }

    #[test]
    fn share_spreads_the_freshest_token() {
        let token = |at: i64| json!({ "accessToken": format!("t{at}"), "expiresAt": at });
        let mut creds = [
            json!({ "claudeAiOauth": {}, "mcpOAuth": { "pylon|a": token(5) } }),
            json!({ "mcpOAuth": { "pylon|a": token(9), "old|b": { "serverName": "old" } } }),
            json!({ "claudeAiOauth": {} }),
        ];
        let (changed, best) = share(&mut creds);
        assert_eq!(changed, [true, false, true]);
        let deck = json!({ "pylon": { "url": "https://p/" }, "old": { "url": "https://o" }, "air": { "command": "npx" } });
        let tokens = serde_json::Map::from_iter([("pylon|a".to_owned(), json!({ "serverName": "pylon", "serverUrl": "https://p", "accessToken": "x", "expiresAt": 9 }))]);
        assert_eq!(signed_in(&tokens, &deck, 5), ["pylon"]);
        assert!(signed_in(&tokens, &deck, 10).is_empty());
        assert!(best.get("old|b").is_none());
        assert_eq!(creds[0]["mcpOAuth"]["pylon|a"], token(9));
        assert_eq!(creds[2]["mcpOAuth"]["pylon|a"], token(9));
        assert!(creds[2]["mcpOAuth"].get("old|b").is_none());
        assert_eq!(creds[0]["claudeAiOauth"], json!({}));
        assert_eq!(share(&mut creds).0, [false, false, false]);
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