#![allow(dead_code)] // Status-line callers arrive in a later phase-4 slice.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use crate::index::{trim, truthy};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
pub const MAIN: &str = "main";
const FRESH_MS: f64 = 5.0 * 60.0 * 1000.0;

fn now() -> f64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0 }

fn read_strict(file: &Path, fallback: Value) -> Result<Value> {
    match fs::read(file) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(fallback),
        Err(e) => Err(e.into()),
    }
}

fn read_json(file: &Path, fallback: Value) -> Value { read_strict(file, fallback.clone()).unwrap_or(fallback) }

fn write_json(file: &Path, data: &Value) -> Result<()> {
    fs::create_dir_all(file.parent().ok_or("No parent folder.")?)?;
    let mut temporary = file.as_os_str().to_owned();
    temporary.push(".tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(data)?)?;
    fs::rename(temporary, file)?;
    Ok(())
}

fn object(value: &mut Value) -> &mut serde_json::Map<String, Value> {
    if !value.is_object() { *value = json!({}); }
    value.as_object_mut().unwrap()
}

fn array(value: &Value) -> &[Value] { value.as_array().map_or(&[], Vec::as_slice) }
fn string(value: &Value) -> &str { value.as_str().unwrap_or("") }
fn coalesce(value: &Value, fallback: Value) -> Value { if value.is_null() { fallback } else { value.clone() } }

fn resolve(path: &Path) -> Result<PathBuf> {
    let mut resolved = PathBuf::new();
    for part in std::path::absolute(path)?.components() {
        match part {
            Component::CurDir => {},
            Component::ParentDir => { resolved.pop(); },
            _ => resolved.push(part.as_os_str()),
        }
    }
    Ok(resolved)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 32 && id.bytes().enumerate().all(|(i, c)| c.is_ascii_lowercase() || c.is_ascii_digit() || (i > 0 && c == b'-'))
}

// Home and Codex home are explicit so none of the core or tests consult the real user's files.
pub struct Accounts {
    pub home: PathBuf,
    codex_home: PathBuf,
    emails: HashMap<String, Value>,
}

impl Accounts {
    pub fn new(home: PathBuf, codex_home: PathBuf) -> Self { Self { home, codex_home, emails: HashMap::new() } }
    fn settings_file(&self) -> PathBuf { self.home.join(".frugal-deck/settings.json") }
    fn frugal_file(&self) -> PathBuf { self.home.join(".frugal/accounts.json") }
    fn load(&self) -> Value { read_json(&self.settings_file(), json!({})) }
    fn save(&self, settings: &Value) -> Result<()> { write_json(&self.settings_file(), settings) }

    fn frugal_accounts(&self) -> Vec<Value> {
        let data = read_json(&self.frugal_file(), json!({}));
        let entries = &data["accounts"];
        let list = if entries.is_null() { vec![] } else if entries.is_array() { array(entries).to_vec() } else { vec![entries.clone()] };
        list.into_iter().filter(|v| v.is_object() || v.is_array()).collect()
    }

    fn is_account_dir(&self, dir: &Value) -> bool {
        let Some(dir) = dir.as_str().and_then(|s| resolve(Path::new(s)).ok()) else { return false; };
        dir.parent().is_some_and(|p| p.to_string_lossy().to_lowercase() == self.home.to_string_lossy().to_lowercase()) &&
            dir.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_prefix(".claude-")).is_some_and(|n|
                !n.is_empty() && n.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-')))
    }

    pub fn claude_accounts(&self) -> Vec<Value> {
        let mut found = vec![json!({"id": MAIN, "name": "Main", "configDir": self.home.join(".claude")})];
        let mut add = |id: &Value, name: &Value, dir: &Value| {
            let Some(id) = id.as_str().filter(|id| valid_id(id)) else { return; };
            if !self.is_account_dir(dir) { return; }
            let dir = resolve(Path::new(string(dir))).unwrap();
            if found.iter().any(|a| a["id"] == id || string(&a["configDir"]).to_lowercase() == dir.to_string_lossy().to_lowercase()) { return; }
            found.push(json!({"id": id, "name": if truthy(name) { name.clone() } else { json!(id) }, "configDir": dir}));
        };
        for a in array(&self.load()["accounts"]) { add(&a["id"], &a["name"], &a["configDir"]); }
        for a in self.frugal_accounts() {
            if a["kind"] == "claude" && a["enabled"] != false { add(&a["id"], &a["id"], &a["config_dir"]); }
        }
        found
    }

    pub fn primary(&self) -> Value {
        let list = self.claude_accounts();
        list.iter().find(|a| a["id"] == self.load()["primary"]).unwrap_or(&list[0]).clone()
    }
    pub fn set_primary(&self, id: &str) -> Result<()> { let mut s = self.load(); object(&mut s).insert("primary".into(), json!(id)); self.save(&s) }
    pub fn roles(&self) -> bool { self.load()["roles"] != false }
    pub fn set_roles(&self, on: bool) -> Result<()> { let mut s = self.load(); object(&mut s).insert("roles".into(), json!(on)); self.save(&s) }

    fn mcp_key(scope: &Value) -> Result<String> {
        for kind in ["workspace", "group"] {
            if truthy(&scope[kind]) { return Ok(format!("{kind}:{}", scope[kind].as_str().ok_or("Invalid scope.")?.to_lowercase())); }
        }
        let resolved = resolve(Path::new(scope["folder"].as_str().ok_or("Invalid folder.")?))?.to_string_lossy().into_owned();
        Ok(if cfg!(windows) { resolved.to_lowercase() } else { resolved })
    }
    pub fn mcp_off(&self, scope: &Value) -> Result<Value> {
        let s = self.load();
        Ok(coalesce(&s["mcpOff"][Self::mcp_key(scope)?], json!([])))
    }
    pub fn set_mcp_off(&self, scope: &Value, names: &Value) -> Result<()> {
        let mut s = self.load();
        let key = Self::mcp_key(scope)?;
        let map = object(object(&mut s).entry("mcpOff").or_insert_with(|| json!({})));
        if array(names).is_empty() { map.remove(&key); } else { map.insert(key, names.clone()); }
        self.save(&s)
    }
    // main.js:317-321: off for the folder, the chat's group, or any workspace it sits in.
    pub fn denied_servers(&self, folder: &Path, topic: Option<&str>, workspaces: &[String]) -> Result<Vec<Value>> {
        let mut scopes = vec![json!({"folder": folder})];
        scopes.extend(topic.map(|topic| json!({"group": topic})));
        scopes.extend(workspaces.iter().map(|workspace| json!({"workspace": workspace})));
        let mut names: Vec<Value> = Vec::new();
        for scope in &scopes {
            for name in array(&self.mcp_off(scope)?) { if !names.contains(name) { names.push(name.clone()); } }
        }
        Ok(names.into_iter().map(|name| json!({"serverName": name})).collect())
    }
    pub fn rename_mcp_scope(&self, kind: &str, from: &str, to: &str) -> Result<()> {
        let old = json!({kind: from});
        let names = self.mcp_off(&old)?;
        if array(&names).is_empty() || from.to_lowercase() == to.to_lowercase() { return Ok(()); }
        let new = json!({kind: to});
        let mut merged = array(&self.mcp_off(&new)?).to_vec();
        for name in array(&names) { if !merged.contains(name) { merged.push(name.clone()); } }
        self.set_mcp_off(&new, &json!(merged))?;
        self.set_mcp_off(&old, &json!([]))
    }

    fn signed_in_email(&mut self, account: &Value) -> Value {
        let id = string(&account["id"]);
        self.emails.entry(id.to_owned()).or_insert_with(|| {
            let dir = if id == MAIN { self.home.clone() } else { PathBuf::from(string(&account["configDir"])) };
            read_json(&dir.join(".claude.json"), json!({}))["oauthAccount"]["emailAddress"].clone()
        }).clone()
    }
    pub fn clear_emails(&mut self) { self.emails.clear(); }

    pub fn snapshot(&mut self, at: f64) -> Value {
        let s = self.load();
        let mut list = self.claude_accounts();
        for a in &mut list {
            let id = string(&a["id"]).to_owned();
            let signed_in = is_signed_in(a);
            a["name"] = coalesce(&s["labels"][&id], a["name"].clone());
            a["signedIn"] = json!(signed_in);
            a["email"] = if signed_in { self.signed_in_email(a) } else { Value::Null };
            a["limits"] = s["readings"][&id].clone();
            a["caps"] = account_caps(&id, &s);
            a["capsApply"] = json!(self.caps_apply(&id));
        }
        for i in 0..list.len() {
            let email = string(&list[i]["email"]).to_lowercase();
            list[i]["sameLogin"] = json!(list.iter().enumerate().filter(|(j, a)| *j != i && !email.is_empty() && string(&a["email"]).to_lowercase() == email).map(|(_, a)| a["name"].clone()).collect::<Vec<_>>());
        }
        let others: Vec<Value> = self.frugal_accounts().iter().filter(|e| e["kind"] != "claude" && e["enabled"] != false && e["id"].is_string()).map(|e| {
            let id = string(&e["id"]);
            json!({"id": id, "name": coalesce(&s["labels"][id], json!(id.strip_prefix("oc-").unwrap_or(id))),
                "kind": if e["kind"].is_null() { "".to_owned() } else { js_string(&e["kind"]) },
                "model": if e["model"].is_string() { e["model"].clone() } else { Value::Null },
                "exhaustedUntil": if number(&e["exhausted_until"]) > at / 1000.0 { e["exhausted_until"].clone() } else { Value::Null },
                "usedToday": if e["day"] == local_day(at) && e["used"].is_number() { e["used"].clone() } else { json!(0) },
                "limits": if e["kind"] == "codex" { codex_limits(&self.codex_home) } else { Value::Null },
                "caps": account_caps(id, &s), "capsApply": self.caps_apply(id)})
        }).collect();
        json!({"primary": self.primary()["id"], "accounts": list, "others": others})
    }

    pub fn rename_account(&self, id: &str, name: &Value) -> Result<bool> {
        let clean = slice_utf16(trim(string(name)), 24);
        if clean.is_empty() || !self.claude_accounts().iter().chain(self.frugal_accounts().iter()).any(|a| a["id"] == id) { return Ok(false); }
        let mut s = self.load();
        object(object(&mut s).entry("labels").or_insert_with(|| json!({}))).insert(id.into(), json!(clean));
        self.save(&s)?;
        Ok(true)
    }
    fn caps_apply(&self, id: &str) -> &'static str {
        match self.frugal_accounts().iter().find(|e| e["id"] == id) {
            None => "not-delegate",
            Some(e) if e["kind"] == "claude" || e["kind"] == "codex" => "ok",
            _ => "no-reading",
        }
    }
    fn cap_reading(&self, entry: &Value, settings: &Value) -> Value {
        if entry["kind"] == "codex" { codex_limits(&self.codex_home) } else { settings["readings"][string(&entry["id"])].clone() }
    }
    pub fn apply_account_caps(&self, id: &str, reading: &Value, at: f64) {
        if self.caps_apply(id) != "ok" { return; }
        let s = self.load();
        let file = self.frugal_file();
        let _ = with_frugal_lock(&file, || {
            let mut data = read_strict(&file, Value::Null)?;
            let Some(entry) = data["accounts"].as_array_mut().and_then(|a| a.iter_mut().find(|e| e["id"] == id)) else { return Ok(()); };
            let limits = if reading.is_null() { self.cap_reading(entry, &s) } else { reading.clone() };
            if limits.is_null() { return Ok(()); }
            let until = cap_exhausted_until(&limits, &account_caps(id, &s), &entry["exhausted_until"], at);
            if until.is_null() { return Ok(()); }
            entry["exhausted_until"] = until;
            write_json(&file, &data)
        }); // An unreadable accounts.json is left alone.
    }
    pub fn apply_codex_caps(&self) {
        for e in self.frugal_accounts().iter().filter(|e| e["kind"] == "codex") { self.apply_account_caps(string(&e["id"]), &Value::Null, now()); }
    }
    pub fn set_account_cap(&self, id: &str, field: &str, value: &Value) -> Result<bool> {
        let n = number(value);
        if !matches!(field, "fiveHour" | "sevenDay") || self.caps_apply(id) != "ok" || !n.is_finite() { return Ok(false); }
        let n = ((n / 5.0 + 0.5).floor() * 5.0).clamp(0.0, 100.0);
        let mut s = self.load();
        let mut caps = account_caps(id, &s);
        caps[field] = json!(n);
        object(object(&mut s).entry("caps").or_insert_with(|| json!({}))).insert(id.into(), caps);
        self.save(&s)?;
        self.apply_account_caps(id, &Value::Null, now());
        Ok(true)
    }
    pub fn save_reading(&self, id: &str, meters: &Value, at: f64) -> Result<bool> {
        if !truthy(&meters["fiveHour"]) && !truthy(&meters["sevenDay"]) { return Ok(false); }
        let mut s = self.load();
        let previous = &s["readings"][id];
        let reading = json!({"fiveHour": coalesce(&meters["fiveHour"], previous["fiveHour"].clone()),
            "sevenDay": coalesce(&meters["sevenDay"], previous["sevenDay"].clone()), "at": at});
        object(object(&mut s).entry("readings").or_insert_with(|| json!({}))).insert(id.into(), reading.clone());
        self.save(&s)?;
        self.apply_account_caps(id, &reading, at);
        Ok(true)
    }

    pub fn prepare_account(&self, name: &Value) -> Result<Value> {
        let clean = slice_utf16(trim(string(name)), 40);
        let mut id = String::new();
        for c in clean.to_lowercase().chars() {
            if c.is_ascii_lowercase() || c.is_ascii_digit() { id.push(c); }
            else if !id.ends_with('-') { id.push('-'); }
        }
        let id: String = id.trim_matches('-').chars().take(32).collect();
        if !valid_id(&id) { return Err("Use letters or numbers in the account name.".into()); }
        if self.claude_accounts().iter().chain(self.frugal_accounts().iter()).any(|a| a["id"] == id) { return Err(format!("An account named {id} already exists.").into()); }
        let dir = self.home.join(format!(".claude-{id}"));
        fs::create_dir_all(dir.join("projects"))?;
        Ok(json!({"id": id, "name": clean, "configDir": dir}))
    }
    pub fn finish_account(&self, account: &Value) -> Result<bool> {
        if !is_signed_in(account) { return Ok(false); }
        ensure_onboarded(Path::new(string(&account["configDir"])))?;
        let mut s = self.load();
        let mut list = array(&s["accounts"]).to_vec();
        list.push(account.clone());
        object(&mut s).insert("accounts".into(), json!(list));
        self.save(&s)?;
        let _ = join_frugal_pool(account, &self.frugal_file());
        Ok(true)
    }
    pub fn remove_account(&mut self, id: &str) -> Result<bool> {
        let Some(a) = self.claude_accounts().into_iter().find(|a| a["id"] == id) else { return Ok(false); };
        if id == MAIN || !self.is_account_dir(&a["configDir"]) { return Ok(false); }
        let dir = Path::new(string(&a["configDir"]));
        if dir.exists() {
            if dir.join("projects").exists() { move_missing(&dir.join("projects"), &self.home.join(".claude/projects"))?; }
            remove_tree(dir)?;
        }
        leave_frugal_pool(id, &self.frugal_file())?;
        let mut s = self.load();
        let kept: Vec<Value> = array(&s["accounts"]).iter().filter(|a| a["id"] != id).cloned().collect();
        let map = object(&mut s);
        map.insert("accounts".into(), json!(kept));
        for key in ["labels", "readings", "caps"] { object(map.entry(key).or_insert_with(|| json!({}))).remove(id); }
        if map.get("primary").is_some_and(|p| p == id) { map.remove("primary"); }
        self.save(&s)?;
        self.emails.remove(id);
        Ok(true)
    }

    // The lock is held only to pick and save, never while /usage runs.
    pub fn refresh_readings(accounts: &Mutex<Self>, claude: &Path, env: &HashMap<String, String>, open: &HashSet<String>, only: Option<&str>) -> Result<bool> {
        let (stale, home) = {
            let mut a = accounts.lock().unwrap();
            a.clear_emails();
            let s = a.load();
            let stale: Vec<Value> = a.claude_accounts().into_iter().filter(|a| {
                let id = string(&a["id"]);
                id != MAIN && if let Some(only) = only.filter(|s| !s.is_empty()) { id == only } else { !open.contains(id) }
            }).filter(|a| now() - s["readings"][string(&a["id"])]["at"].as_f64().unwrap_or(0.0) >= FRESH_MS).collect();
            (stale, a.home.clone())
        };
        let home = &home;
        let results = thread::scope(|scope| {
            let jobs: Vec<_> = stale.iter().map(|a| scope.spawn(move || {
                let mut command = Command::new(claude);
                command.args(["-p", "/usage", "--no-session-persistence", "--output-format", "json"])
                    .env_clear().envs(env).env("CLAUDE_CONFIG_DIR", string(&a["configDir"])).current_dir(home);
                run(&mut command, Duration::from_secs(60)).ok().and_then(|out| serde_json::from_slice::<Value>(&out).ok())
                    .map(|v| parse_usage(string(&v["result"]), now()))
            })).collect();
            jobs.into_iter().map(|j| j.join().unwrap_or(None)).collect::<Vec<_>>()
        });
        let a = accounts.lock().unwrap();
        for (account, reading) in stale.iter().zip(results) {
            if let Some(reading) = reading { let _ = a.save_reading(string(&account["id"]), &reading, now()); }
        }
        Ok(!stale.is_empty())
    }
}

fn slice_utf16(s: &str, count: usize) -> String { String::from_utf16_lossy(&s.encode_utf16().take(count).collect::<Vec<_>>()) }
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|v| if v.is_null() { String::new() } else { js_string(v) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        _ => v.to_string(),
    }
}
fn number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0, Value::Bool(b) => if *b { 1.0 } else { 0.0 },
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let s = trim(s);
            if s.is_empty() { return 0.0; }
            for (prefix, radix) in [("0x", 16), ("0b", 2), ("0o", 8)] {
                if s.to_ascii_lowercase().starts_with(prefix) { return u64::from_str_radix(&s[2..], radix).map_or(f64::NAN, |n| n as f64); }
            }
            s.parse().unwrap_or(f64::NAN)
        }
        Value::Array(_) => number(&json!(js_string(v))),
        _ => f64::NAN,
    }
}

fn cap_of(v: &Value) -> f64 { v.as_f64().filter(|n| n.is_finite() && (0.0..=100.0).contains(n)).unwrap_or(100.0) }
fn account_caps(id: &str, s: &Value) -> Value { json!({"fiveHour": cap_of(&s["caps"][id]["fiveHour"]), "sevenDay": cap_of(&s["caps"][id]["sevenDay"])}) }

pub fn cap_exhausted_until(reading: &Value, caps: &Value, previous: &Value, at: f64) -> Value {
    let mut until: Option<f64> = None;
    for field in ["fiveHour", "sevenDay"] {
        let window = &reading[field];
        if !window["pct"].as_f64().is_some_and(|n| n.is_finite() && n >= cap_of(&caps[field])) { continue; }
        let reset = reset_unix(&window["resetsAt"], at);
        until = Some(until.map_or(reset, |old| old.max(reset)));
    }
    until.filter(|n| *n > previous.as_f64().unwrap_or(0.0)).map_or(Value::Null, |n| json!(n))
}

pub fn has_frugal(account: &Value) -> bool {
    let data = read_json(&Path::new(string(&account["configDir"])).join("plugins/installed_plugins.json"), json!({}));
    let plugins = &data["plugins"]["frugal@frugal"];
    plugins.as_array().is_some_and(|a| !a.is_empty()) || plugins.as_str().is_some_and(|s| !s.is_empty())
}
fn is_signed_in(a: &Value) -> bool { Path::new(string(&a["configDir"])).join(".credentials.json").exists() }

pub fn ensure_onboarded(dir: &Path) -> Result<()> {
    let file = dir.join(".claude.json");
    let mut config = read_strict(&file, json!({}))?;
    if config["hasCompletedOnboarding"] != true { object(&mut config).insert("hasCompletedOnboarding".into(), json!(true)); write_json(&file, &config)?; }
    Ok(())
}

fn with_frugal_lock<T>(file: &Path, work: impl FnOnce() -> Result<T>) -> Result<T> {
    let lock = file.parent().ok_or("No parent folder.")?.join("files.lock");
    fs::create_dir_all(lock.parent().unwrap())?;
    let mut handle = None;
    for _ in 0..500 {
        match fs::OpenOptions::new().write(true).create_new(true).open(&lock) {
            Ok(file) => { handle = Some(file); break; },
            Err(_) => {
                if fs::metadata(&lock).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|d| d > Duration::from_secs(10)) { let _ = fs::remove_file(&lock); }
                thread::sleep(Duration::from_millis(10));
            }
        }
    }
    let result = work();
    if handle.is_some() { drop(handle); let _ = fs::remove_file(lock); }
    result
}

fn join_frugal_pool(a: &Value, file: &Path) -> Result<()> {
    with_frugal_lock(file, || {
        let mut data = read_strict(file, json!({"accounts": []}))?;
        let mut entries = array(&data["accounts"]).to_vec();
        if !data["accounts"].is_null() && !data["accounts"].is_array() { return Err("Invalid accounts list.".into()); }
        entries.push(json!({"id": a["id"], "kind": "claude", "enabled": true, "used": 0, "day": "", "config_dir": a["configDir"]}));
        object(&mut data).insert("accounts".into(), json!(entries));
        write_json(file, &data)
    })
}
fn leave_frugal_pool(id: &str, file: &Path) -> Result<()> {
    with_frugal_lock(file, || {
        let mut data = read_strict(file, Value::Null)?;
        let entries = array(&data["accounts"]);
        if !data["accounts"].is_null() && !data["accounts"].is_array() { return Err("Invalid accounts list.".into()); }
        let kept: Vec<Value> = entries.iter().filter(|e| !(e["kind"] == "claude" && e["id"] == id)).cloned().collect();
        if kept.len() != entries.len() { data["accounts"] = json!(kept); write_json(file, &data)?; }
        Ok(())
    })
}

// Junctions are directory reparse points on Windows; never descend into them during moves or deletes.
fn remove_tree(dir: &Path) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let meta = fs::symlink_metadata(entry.path())?;
        if meta.is_symlink() {
            #[cfg(windows)]
            { use std::os::windows::fs::FileTypeExt; if meta.file_type().is_symlink_dir() { fs::remove_dir(entry.path())?; } else { fs::remove_file(entry.path())?; } }
            #[cfg(not(windows))]
            fs::remove_file(entry.path())?;
        } else if meta.is_dir() { remove_tree(&entry.path())?; }
        else { fs::remove_file(entry.path())?; }
    }
    fs::remove_dir(dir)?;
    Ok(())
}
fn move_missing(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let meta = fs::symlink_metadata(entry.path())?;
        if meta.is_symlink() { continue; }
        let target = to.join(entry.file_name());
        if !target.exists() { fs::rename(entry.path(), target)?; }
        else if meta.is_dir() { move_missing(&entry.path(), &target)?; }
    }
    Ok(())
}

pub fn share_transcript(file: &Path, dir: &Path) -> Result<()> {
    let parent = file.parent().ok_or("No project folder.")?;
    let source = fs::canonicalize(parent)?;
    let projects = dir.join("projects");
    let target = projects.join(parent.file_name().ok_or("No project name.")?);
    fs::create_dir_all(&projects)?;
    if !target.exists() {
        #[cfg(windows)]
        {
            // PowerShell's native Junction support needs no symlink privilege. Paths are data, never shell text.
            let mut command = Command::new("powershell.exe");
            let source = source.to_string_lossy();
            let source = if let Some(unc) = source.strip_prefix("\\\\?\\UNC\\") { format!("\\\\{unc}") }
                else { source.strip_prefix("\\\\?\\").unwrap_or(&source).to_owned() };
            command.args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:DECK_JUNCTION -Target $env:DECK_SOURCE | Out-Null"])
                .env("DECK_JUNCTION", &target).env("DECK_SOURCE", source);
            run(&mut command, Duration::from_secs(60))?;
        }
        #[cfg(not(windows))]
        std::os::unix::fs::symlink(&source, &target)?;
        return Ok(());
    }
    if fs::canonicalize(&target)?.to_string_lossy().to_lowercase() == source.to_string_lossy().to_lowercase() { return Ok(()); }
    let link = target.join(file.file_name().ok_or("No transcript name.")?);
    if !link.exists() { fs::hard_link(file, link)?; }
    Ok(())
}

fn names(dir: &Path) -> Vec<String> {
    let mut entries: Vec<String> = fs::read_dir(dir).into_iter().flatten().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    entries.sort(); entries.reverse(); entries
}
fn newest_rollout(dir: &Path) -> Option<PathBuf> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dir).ok()? {
        let entry = entry.ok()?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("rollout-") && name.ends_with(".jsonl") { files.push((entry.metadata().ok()?.modified().ok()?, entry.path())); }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.first().map(|(_, p)| p.clone())
}
pub fn codex_limits(home: &Path) -> Value {
    let read = || -> Result<Value> {
        let sessions = home.join("sessions");
        let mut file = None;
        'years: for y in names(&sessions) { for m in names(&sessions.join(&y)) { for d in names(&sessions.join(&y).join(&m)) {
            file = newest_rollout(&sessions.join(&y).join(&m).join(d));
            if file.is_some() { break 'years; }
        } } }
        let Some(file) = file else { return Ok(Value::Null); };
        let at = fs::metadata(&file)?.modified()?.duration_since(UNIX_EPOCH)?.as_secs_f64() * 1000.0;
        let mut limits = Value::Null;
        for line in fs::read_to_string(file)?.lines().filter(|s| s.contains("\"rate_limits\"")) {
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                let candidate = coalesce(&v["payload"]["rate_limits"], v["rate_limits"].clone());
                if !candidate.is_null() { limits = candidate; }
            }
        }
        if !truthy(&limits) { return Ok(Value::Null); }
        let mut result = json!({"fiveHour": null, "sevenDay": null, "at": at});
        for key in ["primary", "secondary"] {
            let window = &limits[key];
            let field = if window["window_minutes"] == 300 { "fiveHour" } else if window["window_minutes"] == 10080 { "sevenDay" } else { continue; };
            result[field] = json!({"pct": window.get("used_percent").map_or(f64::NAN, number), "resetsAt": if window["resets_at"].is_number() { window["resets_at"].clone() } else { Value::Null }});
        }
        Ok(result)
    };
    read().unwrap_or(Value::Null)
}

// UCRT's local-time conversion follows the Windows time zone, including DST, like JavaScript Date.
#[repr(C)]
#[derive(Default)]
struct Tm { sec: i32, min: i32, hour: i32, day: i32, month: i32, year: i32, weekday: i32, yearday: i32, dst: i32 }
unsafe extern "C" {
    fn _localtime64_s(out: *mut Tm, time: *const i64) -> i32;
    fn _mktime64(time: *mut Tm) -> i64;
    fn _mkgmtime64(time: *mut Tm) -> i64;
}
fn local_time(at: f64) -> Tm { let mut t = Tm::default(); unsafe { _localtime64_s(&mut t, &((at / 1000.0).floor() as i64)); } t }
fn local_stamp(year: i32, month: i32, day: i32, hour: i32, min: i32) -> i64 {
    unsafe { _mktime64(&mut Tm { year: year - 1900, month, day, hour, min, dst: -1, ..Tm::default() }) }
}
fn local_day(at: f64) -> String { let t = local_time(at); format!("{:04}-{:02}-{:02}", t.year + 1900, t.month + 1, t.day) }
const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
fn digits<'a>(text: &mut &'a str, min: usize, max: usize) -> Option<i32> {
    let len = text.bytes().take(max).take_while(u8::is_ascii_digit).count();
    if len < min { return None; }
    let n = text[..len].parse().ok()?; *text = &text[len..]; Some(n)
}
fn parse_reset(text: &str, at: f64) -> Value {
    let read = || -> Option<i64> {
        let month = MONTHS.iter().position(|m| text.starts_with(m))? as i32;
        let mut rest = text.get(3..)?.strip_prefix(' ')?;
        let day = digits(&mut rest, 1, 2)?;
        rest = rest.strip_prefix(", ")?;
        let mut hour = digits(&mut rest, 1, 2)? % 12;
        let min = if let Some(r) = rest.strip_prefix(':') { rest = r; digits(&mut rest, 2, 2)? } else { 0 };
        if rest.starts_with("pm") { hour += 12; } else if !rest.starts_with("am") { return None; }
        let year = local_time(at).year + 1900;
        let mut reset = local_stamp(year, month, day, hour, min);
        if (reset as f64) < at / 1000.0 - 86400.0 {
            let t = local_time(reset as f64 * 1000.0);
            reset = local_stamp(t.year + 1901, t.month, t.day, t.hour, t.min);
        }
        Some(reset)
    };
    read().map_or(Value::Null, |n| json!(n))
}
pub fn parse_usage(text: &str, at: f64) -> Value {
    let read = |label: &str| -> Value {
        for line in text.lines() {
            let Some(rest) = line.strip_prefix(label).and_then(|s| s.strip_prefix(':')) else { continue; };
            let mut rest = rest.trim_start_matches(crate::index::whitespace);
            let Some(pct) = digits(&mut rest, 1, usize::MAX) else { continue; };
            let Some(rest) = rest.strip_prefix("% used") else { continue; };
            if rest.is_empty() { return json!({"pct": pct, "resetsAt": null}); }
            if let Some((_, reset)) = rest.split_once("resets ").filter(|(_, s)| !s.is_empty()) {
                return json!({"pct": pct, "resetsAt": parse_reset(reset, at)});
            }
        }
        Value::Null
    };
    json!({"fiveHour": read("Current session"), "sevenDay": read("Current week (all models)")})
}

fn reset_unix(value: &Value, at: f64) -> f64 {
    let fallback = (at / 1000.0).floor() + 3600.0;
    if value.is_null() || value == "" { return fallback; }
    if let Some(n) = value.as_f64().filter(|n| n.is_finite()) { return (if n > 1e12 { n / 1000.0 } else { n }).floor(); }
    let parse = || -> Option<f64> {
        let mut rest = value.as_str()?;
        let year = digits(&mut rest, 4, 4)?;
        rest = rest.strip_prefix('-')?; let month = digits(&mut rest, 2, 2)?;
        rest = rest.strip_prefix('-')?; let day = digits(&mut rest, 2, 2)?;
        let date_only = rest.is_empty();
        let (mut hour, mut min, mut sec) = (0, 0, 0);
        if !date_only {
            rest = rest.strip_prefix('T').or_else(|| rest.strip_prefix(' '))?;
            hour = digits(&mut rest, 2, 2)?;
            rest = rest.strip_prefix(':')?; min = digits(&mut rest, 2, 2)?;
            if let Some(r) = rest.strip_prefix(':') { rest = r; sec = digits(&mut rest, 2, 2)?; }
            if let Some(r) = rest.strip_prefix('.') { rest = r; let len = rest.bytes().take_while(u8::is_ascii_digit).count(); if len == 0 { return None; } rest = &rest[len..]; }
        }
        if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 24 || min > 59 || sec > 59 { return None; }
        let mut tm = Tm { year: year - 1900, month: month - 1, day, hour, min, sec, dst: -1, ..Tm::default() };
        if !date_only && rest.is_empty() { return Some(unsafe { _mktime64(&mut tm) } as f64); }
        let mut offset = 0;
        if !rest.is_empty() && rest != "Z" {
            let sign = if rest.starts_with('+') { 1 } else if rest.starts_with('-') { -1 } else { return None; };
            rest = &rest[1..]; let h = digits(&mut rest, 2, 2)?;
            rest = rest.strip_prefix(':').unwrap_or(rest); let m = digits(&mut rest, 2, 2)?;
            if !rest.is_empty() || h > 23 || m > 59 { return None; }
            offset = sign * (h * 3600 + m * 60);
        }
        Some(unsafe { _mkgmtime64(&mut tm) } as f64 - offset as f64)
    };
    parse().unwrap_or(fallback)
}

// execFile's bounded output and timeout: drain both pipes concurrently so a full pipe never deadlocks the child.
pub fn run(command: &mut Command, timeout: Duration) -> Result<Vec<u8>> {
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let overflow = Arc::new(AtomicBool::new(false));
    let reader = |pipe: Box<dyn Read + Send>| {
        let overflow = overflow.clone();
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe.take(1024 * 1024 + 1).read_to_end(&mut bytes);
            if bytes.len() > 1024 * 1024 { overflow.store(true, Ordering::Relaxed); }
            result.map(|_| bytes)
        })
    };
    let stdout = reader(Box::new(child.stdout.take().unwrap()));
    let stderr = reader(Box::new(child.stderr.take().unwrap()));
    let start = Instant::now();
    let status = loop {
        if start.elapsed() >= timeout || overflow.load(Ordering::Relaxed) { let _ = child.kill(); break child.wait(); }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(e) => { let _ = child.kill(); let _ = child.wait(); break Err(e); }
        }
    };
    let out = stdout.join().map_err(|_| "stdout reader failed")??;
    let err = stderr.join().map_err(|_| "stderr reader failed")??;
    if start.elapsed() >= timeout { return Err("Command timed out.".into()); }
    if overflow.load(Ordering::Relaxed) { return Err("Command output exceeded maxBuffer.".into()); }
    if !status?.success() { return Err(String::from_utf8_lossy(&err).into_owned().into()); }
    Ok(out)
}

pub fn publish(app: &AppHandle, accounts: &mut Accounts) -> Result<()> {
    accounts.apply_codex_caps();
    app.emit("accounts:changed", [accounts.snapshot(now())])?;
    Ok(())
}

#[tauri::command]
pub fn accounts_get(accounts: State<Mutex<Accounts>>) -> Value { accounts.lock().unwrap().snapshot(now()) }
#[tauri::command]
pub fn settings_roles(accounts: State<Mutex<Accounts>>) -> bool { accounts.lock().unwrap().roles() }
#[tauri::command]
pub fn settings_set_roles(app: AppHandle, accounts: State<Mutex<Accounts>>, on: Value) -> std::result::Result<(), String> {
    let Some(on) = on.as_bool() else { return Ok(()); };
    let mut a = accounts.lock().unwrap();
    a.set_roles(on).and_then(|()| publish(&app, &mut a)).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn accounts_rename(app: AppHandle, accounts: State<Mutex<Accounts>>, id: String, name: Value) -> std::result::Result<(), String> {
    let mut a = accounts.lock().unwrap();
    if a.rename_account(&id, &name).map_err(|e| e.to_string())? { publish(&app, &mut a).map_err(|e| e.to_string())?; }
    Ok(())
}
#[tauri::command]
pub fn accounts_set_cap(app: AppHandle, accounts: State<Mutex<Accounts>>, id: String, field: String, value: Value) -> std::result::Result<(), String> {
    let mut a = accounts.lock().unwrap();
    if a.set_account_cap(&id, &field, &value).map_err(|e| e.to_string())? { publish(&app, &mut a).map_err(|e| e.to_string())?; }
    Ok(())
}
#[tauri::command]
pub fn accounts_set_primary(app: AppHandle, accounts: State<Mutex<Accounts>>, id: String) -> std::result::Result<Value, String> {
    let mut a = accounts.lock().unwrap();
    if !a.claude_accounts().iter().any(|a| a["id"] == id) { return Ok(json!({"error": "Invalid request."})); }
    a.set_primary(&id).and_then(|()| publish(&app, &mut a)).map_err(|e| e.to_string())?;
    read_now(&app, &id);
    Ok(json!({"ok": true}))
}

// main.js:404-408: the account a chat moves to shows its limits now instead of after its first turn; the main account has no -p reading.
pub fn read_now(app: &AppHandle, id: &str) {
    let Some(claude) = crate::chat::find_claude() else { return; };
    let (app, id) = (app.clone(), id.to_owned());
    thread::spawn(move || {
        let accounts = app.state::<Mutex<Accounts>>();
        if Accounts::refresh_readings(&accounts, &claude, &crate::chat::clean_env(), &HashSet::new(), Some(&id)).unwrap_or(false) {
            let _ = publish(&app, &mut accounts.lock().unwrap());
        }
    });
}

// Electron's `refreshing`: held by accounts:refresh, awaited by accounts:remove.
static REFRESHING: Mutex<()> = Mutex::new(());

#[tauri::command]
pub async fn accounts_refresh(app: AppHandle) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let Some(claude) = crate::chat::find_claude() else { return; };
        let Ok(_running) = REFRESHING.try_lock() else { return; };
        let open = app.state::<crate::chat::Chats>().open_accounts();
        let accounts = app.state::<Mutex<Accounts>>();
        if Accounts::refresh_readings(&accounts, &claude, &crate::chat::clean_env(), &open, None).unwrap_or(false) {
            let _ = publish(&app, &mut accounts.lock().unwrap());
        }
    }).await;
}

const IN_USE: &str = "Close the chats on this account first, then open Accounts in the top bar.";
fn find_account(accounts: &Mutex<Accounts>, id: &str) -> Option<Value> { accounts.lock().unwrap().claude_accounts().into_iter().find(|a| a["id"] == id) }

#[tauri::command]
pub async fn accounts_logout(app: AppHandle, id: String) -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        let accounts = app.state::<Mutex<Accounts>>();
        let account = find_account(&accounts, &id);
        let claude = crate::chat::find_claude();
        let Some(account) = account else { return json!({"error": "Invalid request."}); };
        let Some(claude) = claude else { return json!({"error": crate::chat::NO_CLAUDE}); };
        if app.state::<crate::chat::Chats>().open_accounts().contains(&id) { return json!({"error": IN_USE}); }
        let mut command = Command::new(claude);
        {
            let a = accounts.lock().unwrap();
            command.args(["auth", "logout"]).env_clear().envs(crate::chat::account_env(&a, &account)).current_dir(&a.home);
        }
        let result = run(&mut command, Duration::from_secs(30)).map_or_else(|e| json!({"error": format!("Sign out failed: {e}")}), |_| json!({"ok": true}));
        let mut a = accounts.lock().unwrap();
        a.clear_emails();
        let _ = publish(&app, &mut a);
        result
    }).await.unwrap_or_else(|e| json!({"error": e.to_string()}))
}

// A usage reading still running on this account would write sessions/ and projects/ back after the delete, so it is awaited first.
// The sign-in goes with the folder, so no claude auth logout is needed.
#[tauri::command]
pub async fn accounts_remove(app: AppHandle, id: String) -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        let accounts = app.state::<Mutex<Accounts>>();
        if id == MAIN || find_account(&accounts, &id).is_none() { return json!({"error": "Invalid request."}); }
        if app.state::<crate::chat::Chats>().open_accounts().contains(&id) { return json!({"error": IN_USE}); }
        drop(REFRESHING.lock());
        let mut a = accounts.lock().unwrap();
        let result = match a.remove_account(&id) {
            Ok(true) => json!({"ok": true}),
            Ok(false) => json!({"error": "Invalid request."}),
            Err(e) => json!({"error": format!("Delete failed: {e}")}),
        };
        let _ = publish(&app, &mut a);
        drop(a);
        crate::index::start(app.clone());
        result
    }).await.unwrap_or_else(|e| json!({"error": e.to_string()}))
}

pub(crate) fn mcp_scope(input: &Value) -> Option<Value> {
    let folder = input["folder"].as_str()?;
    if !Path::new(folder).is_absolute() || !Path::new(folder).is_dir() { return None; }
    for kind in ["group", "workspace"] {
        if let Some(v) = input.get(kind) {
            if !v.as_str().is_some_and(|s| !s.is_empty() && s.encode_utf16().count() <= 200) { return None; }
        }
    }
    Some(if truthy(&input["workspace"]) { json!({"folder": folder, "workspace": input["workspace"]}) }
        else if truthy(&input["group"]) { json!({"folder": folder, "group": input["group"]}) } else { json!({"folder": folder}) })
}
#[tauri::command]
pub fn mcp_set(app: AppHandle, accounts: State<Mutex<Accounts>>, scope: Value, names: Value) -> std::result::Result<Value, String> {
    let Some(scope) = mcp_scope(&scope) else { return Ok(json!({"error": "Invalid folder."})); };
    if !names.as_array().is_some_and(|a| a.len() <= 200 && a.iter().all(|n| n.as_str().is_some_and(|s| s.encode_utf16().count() <= 200))) {
        return Ok(json!({"error": "Invalid list."}));
    }
    let mut a = accounts.lock().unwrap();
    a.set_mcp_off(&scope, &names).and_then(|()| publish(&app, &mut a)).map_err(|e| e.to_string())?;
    Ok(json!({"ok": true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            loop {
                let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
                let path = std::env::temp_dir().join(format!("deck-accounts-{}-{stamp}", std::process::id()));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(e) => panic!("{e}"),
                }
            }
        }
        fn accounts(&self) -> Accounts { Accounts::new(self.0.clone(), self.0.join(".codex")) }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let resolved = self.0.canonicalize().unwrap();
            assert_eq!(resolved.parent().unwrap(), std::env::temp_dir().canonicalize().unwrap());
            remove_tree(&resolved).unwrap();
        }
    }

    // accounts.js:469-476: all 3 inline usage assertions.
    #[test]
    fn usage_and_year_rollover() {
        let at = local_stamp(2026, 10, 9, 12, 0) as f64 * 1000.0;
        let usage = parse_usage("Current session: 9% used · resets Nov 9, 3:10pm (America/Lima)\nCurrent week (all models): 95% used · resets Nov 9, 11pm (America/Lima)", at);
        assert_eq!(usage, json!({"fiveHour": {"pct": 9, "resetsAt": local_stamp(2026, 10, 9, 15, 10)}, "sevenDay": {"pct": 95, "resetsAt": local_stamp(2026, 10, 9, 23, 0)}}));
        assert_eq!(parse_usage("Current session: 0% used · resets Jan 2, 12am (X)", at)["fiveHour"]["resetsAt"], local_stamp(2027, 0, 2, 0, 0));
        assert_eq!(parse_usage("breakdown only", at), json!({"fiveHour": null, "sevenDay": null}));
    }

    // accounts.js:478-492: all 3 inline Codex assertions.
    #[test]
    fn codex_readings_skip_malformed_lines() {
        let dir = TempDir::new();
        let day = dir.0.join("sessions/2026/11/09");
        fs::create_dir_all(&day).unwrap();
        fs::write(day.join("rollout-a.jsonl"), [
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"other\"}}",
            "{\"type\":\"event_msg\",\"payload\":{\"rate_limits\":",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"rate_limits\":{\"limit_id\":\"codex\",\"primary\":{\"used_percent\":4.0,\"window_minutes\":300,\"resets_at\":1794255884},\"secondary\":{\"used_percent\":39.0,\"window_minutes\":10080,\"resets_at\":1794417951},\"credits\":{}}}}"
        ].join("\n")).unwrap();
        let limits = codex_limits(&dir.0);
        assert_eq!(limits["fiveHour"], json!({"pct": 4.0, "resetsAt": 1794255884}));
        assert_eq!(limits["sevenDay"], json!({"pct": 39.0, "resetsAt": 1794417951}));
        let empty = TempDir::new();
        assert_eq!(codex_limits(&empty.0), Value::Null);
    }

    // accounts.js:494-516,533-552: all 12 inline sharing, move and deletion assertions.
    #[test]
    fn sharing_moves_and_deletion_preserve_transcripts() {
        let dir = TempDir::new();
        let source = dir.0.join("a/projects/slug");
        fs::create_dir_all(&source).unwrap();
        let file = source.join("one.jsonl");
        fs::write(&file, "x").unwrap();
        let fresh = dir.0.join("b");
        share_transcript(&file, &fresh).unwrap();
        assert!(fs::symlink_metadata(fresh.join("projects/slug")).unwrap().is_symlink(), "missing folder becomes a junction");
        share_transcript(&file, &fresh).unwrap();
        let taken = dir.0.join("c");
        fs::create_dir_all(taken.join("projects/slug")).unwrap();
        fs::write(taken.join("projects/slug/own.jsonl"), "keep").unwrap();
        share_transcript(&file, &taken).unwrap();
        share_transcript(&file, &taken).unwrap();
        assert!(fs::symlink_metadata(taken.join("projects/slug")).unwrap().is_dir(), "real folder is kept");
        assert_eq!(fs::read_to_string(taken.join("projects/slug/own.jsonl")).unwrap(), "keep");
        fs::OpenOptions::new().append(true).open(&file).unwrap().write_all(b"y").unwrap();
        assert_eq!(fs::read_to_string(taken.join("projects/slug/one.jsonl")).unwrap(), "xy", "hard link follows appends");
        share_transcript(&file, &dir.0.join("a")).unwrap();
        assert_eq!(names(&source), ["one.jsonl"], "own account is untouched");
        fs::create_dir_all(taken.join("projects/slug/one/subagents")).unwrap();
        fs::create_dir(source.join("one")).unwrap();
        fs::write(taken.join("projects/slug/one/subagents/agent.jsonl"), "sub").unwrap();
        fs::create_dir(taken.join("projects/other")).unwrap();
        fs::write(taken.join("projects/other/two.jsonl"), "two").unwrap();
        move_missing(&taken.join("projects"), &dir.0.join("a/projects")).unwrap();
        assert_eq!(fs::read_to_string(source.join("own.jsonl")).unwrap(), "keep", "own chat moves");
        assert_eq!(fs::read_to_string(source.join("one/subagents/agent.jsonl")).unwrap(), "sub", "folders merge");
        assert_eq!(fs::read_to_string(dir.0.join("a/projects/other/two.jsonl")).unwrap(), "two", "new project moves");
        move_missing(&fresh.join("projects"), &dir.0.join("a/projects")).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "xy", "junction is skipped");
        fs::write(fresh.join("own.txt"), "x").unwrap();
        remove_tree(&fresh).unwrap();
        assert!(!fresh.exists(), "account folder is gone");
        assert_eq!(fs::read_to_string(&file).unwrap(), "xy", "junction target survives");
        remove_tree(&taken).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "xy", "hard-linked transcript survives");
    }

    // accounts.js:518-531: all 6 inline pool and lock assertions.
    #[test]
    fn pool_preserves_fields_and_releases_lock_on_failure() {
        let dir = TempDir::new();
        let pool = dir.0.join("frugal/accounts.json");
        write_json(&pool, &json!({"opencode_allow_training": true, "accounts": [{"id": "old", "kind": "grok"}]})).unwrap();
        join_frugal_pool(&json!({"id": "new", "configDir": "c"}), &pool).unwrap();
        assert_eq!(read_strict(&pool, Value::Null).unwrap(), json!({"opencode_allow_training": true, "accounts": [{"id": "old", "kind": "grok"}, {"id": "new", "kind": "claude", "enabled": true, "used": 0, "day": "", "config_dir": "c"}]}));
        assert!(!dir.0.join("frugal/files.lock").exists(), "lock is released");
        fs::write(&pool, "{broken").unwrap();
        assert!(join_frugal_pool(&json!({"id": "x", "configDir": "c"}), &pool).is_err());
        assert_eq!(fs::read_to_string(&pool).unwrap(), "{broken", "unreadable pool is untouched");
        assert!(!dir.0.join("frugal/files.lock").exists(), "lock is released on failure");
        write_json(&pool, &json!({"accounts": [{"id": "new", "kind": "claude"}, {"id": "new", "kind": "grok"}]})).unwrap();
        leave_frugal_pool("new", &pool).unwrap();
        assert_eq!(read_strict(&pool, Value::Null).unwrap()["accounts"], json!([{"id": "new", "kind": "grok"}]), "only the Claude entry leaves");
    }

    // accounts.js:554: the inline account-dir assertion, with home injected into a temp dir.
    #[test]
    fn account_dirs_are_immediate_children_only() {
        let home = TempDir::new();
        let root = TempDir::new();
        let a = home.accounts();
        assert!(!a.is_account_dir(&json!(root.0.join(".claude-x"))) && !a.is_account_dir(&json!(home.0)) && a.is_account_dir(&json!(home.0.join(".claude-x"))));
        for dir in [json!(false), json!(home.0.join(".claude-")), json!(home.0.join("nested/.claude-x")), json!(home.0.join(".claude-x/../other"))] { assert!(!a.is_account_dir(&dir)); }
    }

    // accounts.js:50-78,199-214,292-310,351-365,410-425: supplemental lifecycle and snapshot coverage.
    #[test]
    fn lifecycle_preserves_settings_pool_and_main_transcripts() {
        let dir = TempDir::new();
        let mut a = dir.accounts();
        let account = a.prepare_account(&json!("  Work Account!  ")).unwrap();
        assert_eq!(account["id"], "work-account");
        assert!(!a.finish_account(&account).unwrap());
        let config = PathBuf::from(string(&account["configDir"]));
        fs::write(config.join(".credentials.json"), "token").unwrap();
        write_json(&config.join(".claude.json"), &json!({"keep": 1, "oauthAccount": {"emailAddress": "Work@Example.com"}})).unwrap();
        assert!(a.finish_account(&account).unwrap());
        assert_eq!(read_json(&config.join(".claude.json"), Value::Null)["keep"], 1);
        assert_eq!(read_json(&config.join(".claude.json"), Value::Null)["hasCompletedOnboarding"], true);
        assert!(a.prepare_account(&json!("Work Account!")).is_err());
        a.set_primary("work-account").unwrap();
        a.rename_account("work-account", &json!("  Renamed  ")).unwrap();
        a.save_reading("work-account", &json!({"fiveHour": {"pct": 10}}), 42.0).unwrap();
        a.set_account_cap("work-account", "fiveHour", &json!(53)).unwrap();
        a.set_roles(false).unwrap();
        let snapshot = a.snapshot(1000.0);
        assert_eq!(snapshot["primary"], "work-account");
        assert_eq!(snapshot["accounts"][1]["name"], "Renamed");
        assert_eq!(snapshot["accounts"][1]["email"], "Work@Example.com");
        assert!(!a.roles());
        fs::create_dir_all(config.join("projects/slug")).unwrap();
        fs::write(config.join("projects/slug/chat.jsonl"), "preserve").unwrap();
        assert!(!a.remove_account(MAIN).unwrap());
        assert!(a.remove_account("work-account").unwrap());
        assert_eq!(fs::read_to_string(dir.0.join(".claude/projects/slug/chat.jsonl")).unwrap(), "preserve");
        assert_eq!(a.claude_accounts().len(), 1);
        assert_eq!(a.primary()["id"], MAIN);
        assert!(!a.roles());
        for key in ["labels", "caps", "readings"] { assert!(a.load()[key].get("work-account").is_none()); }
        assert!(a.frugal_accounts().is_empty());
    }

    // accounts.js:235-289: supplemental caps, reset units, fallback and partial-reading coverage.
    #[test]
    fn caps_extend_only_and_partial_readings_merge() {
        let dir = TempDir::new();
        let a = dir.accounts();
        let at = 1794250000000.0;
        let reading = json!({"fiveHour": {"pct": 50, "resetsAt": 1794255884}, "sevenDay": {"pct": 95, "resetsAt": "2026-11-11T17:25:51Z"}});
        assert_eq!(cap_exhausted_until(&reading, &json!({"fiveHour": 50, "sevenDay": 90}), &Value::Null, at), json!(1794417951.0));
        assert_eq!(cap_exhausted_until(&reading, &json!({"fiveHour": 50, "sevenDay": 90}), &json!(1794417951), at), Value::Null);
        assert_eq!(reset_unix(&json!(1794417951000_i64), at), 1794417951.0);
        assert_eq!(reset_unix(&json!("bad"), at), at / 1000.0 + 3600.0);
        assert_eq!(reset_unix(&Value::Null, at), at / 1000.0 + 3600.0);
        assert!(!a.save_reading("x", &json!({}), at).unwrap());
        assert!(a.save_reading("x", &reading, at).unwrap());
        a.save_reading("x", &json!({"fiveHour": {"pct": 1}}), at + 1.0).unwrap();
        assert_eq!(a.load()["readings"]["x"]["sevenDay"], reading["sevenDay"]);
        assert!(!a.set_account_cap(MAIN, "fiveHour", &json!(0)).unwrap());
        write_json(&a.frugal_file(), &json!({"accounts": [{"id": "x", "kind": "claude"}], "keep": true})).unwrap();
        assert!(!a.set_account_cap("x", "bad", &json!(0)).unwrap());
        assert!(!a.set_account_cap("x", "fiveHour", &json!("bad")).unwrap());
        for (input, expected) in [(json!("52.5"), 55.0), (json!(-1), 0.0), (json!(102), 100.0), (Value::Null, 0.0)] {
            assert!(a.set_account_cap("x", "fiveHour", &input).unwrap());
            assert_eq!(a.load()["caps"]["x"]["fiveHour"], json!(expected));
        }
        assert_eq!(read_json(&a.frugal_file(), Value::Null)["keep"], true);
    }

    // accounts.js:24-31,305-310,315-348,368-377: supplemental malformed-file safety.
    #[test]
    fn strict_writes_never_replace_unreadable_state() {
        let dir = TempDir::new();
        let a = dir.accounts();
        let config = dir.0.join(".claude-x");
        fs::create_dir(&config).unwrap();
        fs::write(config.join(".claude.json"), "{broken").unwrap();
        assert!(ensure_onboarded(&config).is_err());
        assert_eq!(fs::read_to_string(config.join(".claude.json")).unwrap(), "{broken");
        fs::write(config.join(".credentials.json"), "token").unwrap();
        assert!(a.finish_account(&json!({"id": "x", "configDir": config})).is_err());
        assert!(!a.settings_file().exists());
        write_json(&a.frugal_file(), &json!({"accounts": []})).unwrap();
        fs::write(a.frugal_file(), "{broken").unwrap();
        assert!(leave_frugal_pool("x", &a.frugal_file()).is_err());
        assert_eq!(fs::read_to_string(a.frugal_file()).unwrap(), "{broken");
    }

    // accounts.js:80-99: supplemental MCP scopes, merge order and unrelated-setting preservation.
    #[test]
    fn mcp_scopes_merge_and_case_only_renames_preserve_settings() {
        let dir = TempDir::new();
        let a = dir.accounts();
        a.set_roles(false).unwrap();
        a.set_mcp_off(&json!({"group": "Old"}), &json!(["a", "b"])).unwrap();
        a.set_mcp_off(&json!({"group": "New"}), &json!(["b", "c"])).unwrap();
        a.rename_mcp_scope("group", "OLD", "New").unwrap();
        assert_eq!(a.mcp_off(&json!({"group": "new"})).unwrap(), json!(["b", "c", "a"]));
        assert_eq!(a.mcp_off(&json!({"group": "old"})).unwrap(), json!([]));
        a.rename_mcp_scope("group", "new", "NEW").unwrap();
        assert_eq!(a.mcp_off(&json!({"group": "new"})).unwrap(), json!(["b", "c", "a"]));
        a.set_mcp_off(&json!({"workspace": "Old", "group": "New"}), &json!(["w"])).unwrap();
        a.rename_mcp_scope("workspace", "Old", "Next").unwrap();
        assert_eq!(a.mcp_off(&json!({"workspace": "next"})).unwrap(), json!(["w"]));
        assert!(!a.roles());
        assert!(mcp_scope(&json!({"folder": dir.0, "group": null})).is_none());
        assert!(mcp_scope(&json!({"folder": dir.0})).is_some());
    }

    // accounts.js:38-70,102-114,199-219: supplemental discovery, snapshot and email-cache coverage.
    #[test]
    fn discovery_snapshot_and_email_cache_match_account_sources() {
        let dir = TempDir::new();
        let outside = TempDir::new();
        let mut a = dir.accounts();
        let at = local_stamp(2026, 10, 9, 12, 0) as f64 * 1000.0;
        let work = dir.0.join(".claude-work");
        a.save(&json!({"primary": "unknown", "accounts": [
            {"id": "work", "name": "Work", "configDir": work},
            {"id": "alias", "configDir": work},
            {"id": "invalid/id", "configDir": dir.0.join(".claude-invalid")},
            {"id": "outside", "configDir": outside.0.join(".claude-outside")}
        ], "labels": {"work": "Label", "oc-api": "API"}})).unwrap();
        write_json(&a.frugal_file(), &json!({"accounts": [
            {"id": "work", "kind": "claude", "config_dir": work},
            {"id": "other", "kind": "claude", "config_dir": dir.0.join(".claude-other")},
            {"id": "off", "kind": "claude", "enabled": false, "config_dir": dir.0.join(".claude-off")},
            {"id": "oc-api", "kind": "grok", "model": "model", "used": 3, "day": local_day(at), "exhausted_until": at / 1000.0 + 60.0},
            {"id": "oc-codex", "kind": "codex", "used": 9, "day": "old"},
            {"id": "disabled", "kind": "grok", "enabled": false}
        ]})).unwrap();
        assert_eq!(a.claude_accounts().iter().map(|v| string(&v["id"])).collect::<Vec<_>>(), ["main", "work", "other"]);
        assert_eq!(a.primary()["id"], MAIN);
        for config in [dir.0.join(".claude"), work.clone()] {
            fs::create_dir_all(&config).unwrap();
            fs::write(config.join(".credentials.json"), "token").unwrap();
        }
        write_json(&dir.0.join(".claude.json"), &json!({"oauthAccount": {"emailAddress": "same@example.com"}})).unwrap();
        write_json(&work.join(".claude.json"), &json!({"oauthAccount": {"emailAddress": "Same@Example.com"}})).unwrap();
        let snapshot = a.snapshot(at);
        assert_eq!(snapshot["accounts"][0]["sameLogin"], json!(["Label"]));
        assert_eq!(snapshot["accounts"][1]["sameLogin"], json!(["Main"]));
        assert_eq!(snapshot["accounts"][2]["email"], Value::Null);
        assert_eq!(snapshot["others"].as_array().unwrap().len(), 2);
        assert_eq!(snapshot["others"][0]["usedToday"], 3);
        assert_eq!(snapshot["others"][0]["capsApply"], "no-reading");
        assert_eq!(snapshot["others"][1]["usedToday"], 0);
        assert_eq!(snapshot["others"][1]["limits"], Value::Null);
        write_json(&work.join(".claude.json"), &json!({"oauthAccount": {"emailAddress": "new@example.com"}})).unwrap();
        assert_eq!(a.snapshot(at)["accounts"][1]["email"], "Same@Example.com");
        a.clear_emails();
        assert_eq!(a.snapshot(at)["accounts"][1]["email"], "new@example.com");
        fs::remove_file(work.join(".credentials.json")).unwrap();
        assert_eq!(a.snapshot(at)["accounts"][1]["email"], Value::Null);
        assert!(!has_frugal(&a.claude_accounts()[1]));
        write_json(&work.join("plugins/installed_plugins.json"), &json!({"plugins": {"frugal@frugal": [{}]}})).unwrap();
        assert!(has_frugal(&a.claude_accounts()[1]));
        assert!(!a.rename_account("unknown", &json!("x")).unwrap());
        assert!(!a.rename_account("work", &json!(false)).unwrap());
        assert!(!a.rename_account("work", &json!("   ")).unwrap());
    }

    // accounts.js:139-190,264-265: supplemental Codex date order, last reading and cap enforcement.
    #[test]
    fn codex_uses_newest_day_and_last_rate_limit_and_applies_caps() {
        let dir = TempDir::new();
        let a = dir.accounts();
        let older = a.codex_home.join("sessions/2026/10/31/rollout-old.jsonl");
        let newer = a.codex_home.join("sessions/2026/11/01/rollout-new.jsonl");
        for file in [&older, &newer] { fs::create_dir_all(file.parent().unwrap()).unwrap(); }
        fs::write(&older, "{\"rate_limits\":{\"primary\":{\"used_percent\":99,\"window_minutes\":300}}}").unwrap();
        fs::write(&newer, [
            json!({"rate_limits": {"primary": {"used_percent": 1, "window_minutes": 300}}}).to_string(),
            json!({"payload": {"rate_limits": {"primary": {"used_percent": "60", "window_minutes": 300, "resets_at": 1794255884}}}}).to_string(),
            "{\"rate_limits\":".into(),
            json!({"payload": {"rate_limits": null}}).to_string()
        ].join("\n")).unwrap();
        assert_eq!(codex_limits(&a.codex_home)["fiveHour"], json!({"pct": 60.0, "resetsAt": 1794255884}));
        write_json(&a.frugal_file(), &json!({"accounts": [{"id": "codex", "kind": "codex"}], "keep": 2})).unwrap();
        a.set_account_cap("codex", "fiveHour", &json!(50)).unwrap();
        a.apply_codex_caps();
        assert_eq!(read_json(&a.frugal_file(), Value::Null)["accounts"][0]["exhausted_until"], json!(1794255884.0));
        assert_eq!(read_json(&a.frugal_file(), Value::Null)["keep"], 2);
    }

    // accounts.js:442-459: supplemental execFile arguments/env/cwd, open/only/fresh filters and failure preservation.
    #[test]
    fn refresh_reads_only_stale_selected_accounts_and_preserves_failed_readings() {
        let dir = TempDir::new();
        let mut a = dir.accounts();
        for name in ["one", "two"] {
            let account = a.prepare_account(&json!(name)).unwrap();
            fs::write(Path::new(string(&account["configDir"])).join(".credentials.json"), "token").unwrap();
            a.finish_account(&account).unwrap();
        }
        let claude = dir.0.join("fake-claude.cmd");
        fs::write(&claude, "@echo off\r\nif not \"%~1\"==\"-p\" exit /b 9\r\nif not \"%~2\"==\"/usage\" exit /b 9\r\nif not \"%~3\"==\"--no-session-persistence\" exit /b 9\r\nif not \"%~4\"==\"--output-format\" exit /b 9\r\nif not \"%~5\"==\"json\" exit /b 9\r\necho %CD%>\"%CLAUDE_CONFIG_DIR%\\probe\"\r\necho {\"result\":\"Current session: 30%% used\"}\r\n").unwrap();
        let mut env = HashMap::from([("USERPROFILE".into(), dir.0.to_string_lossy().into_owned()), ("CODEX_HOME".into(), a.codex_home.to_string_lossy().into_owned())]);
        if let Ok(root) = std::env::var("SystemRoot") { env.insert("SystemRoot".into(), root); }
        let open = HashSet::from(["one".to_owned()]);
        let a = Mutex::new(a);
        let load = || a.lock().unwrap().load();
        assert!(Accounts::refresh_readings(&a, &claude, &env, &open, None).unwrap());
        assert_eq!(load()["readings"]["two"]["fiveHour"]["pct"], 30);
        assert!(load()["readings"]["one"].is_null());
        assert_eq!(fs::read_to_string(dir.0.join(".claude-two/probe")).unwrap().trim(), dir.0.to_string_lossy());
        assert!(Accounts::refresh_readings(&a, &claude, &env, &open, Some("one")).unwrap());
        assert_eq!(load()["readings"]["one"]["fiveHour"]["pct"], 30);
        assert!(!Accounts::refresh_readings(&a, &claude, &env, &open, Some("one")).unwrap());
        a.lock().unwrap().save_reading("one", &json!({"fiveHour": {"pct": 7}}), 1.0).unwrap();
        fs::write(&claude, "@exit /b 9\r\n").unwrap();
        assert!(Accounts::refresh_readings(&a, &claude, &env, &open, Some("one")).unwrap());
        assert_eq!(load()["readings"]["one"]["fiveHour"]["pct"], 7);
    }

    #[test]
    fn denied_servers_merge_folder_group_and_workspaces_once() {
        let dir = TempDir::new();
        let a = dir.accounts();
        let folder = dir.0.join("work");
        a.set_mcp_off(&json!({"folder": folder}), &json!(["a", "b"])).unwrap();
        a.set_mcp_off(&json!({"group": "Topic"}), &json!(["b", "c"])).unwrap();
        a.set_mcp_off(&json!({"workspace": "Space"}), &json!(["d", "a"])).unwrap();
        a.set_mcp_off(&json!({"workspace": "Other"}), &json!(["e"])).unwrap();
        let names = |list: Vec<Value>| list.iter().map(|v| v["serverName"].clone()).collect::<Vec<_>>();
        assert_eq!(names(a.denied_servers(&folder, Some("topic"), &["SPACE".into()]).unwrap()), ["a", "b", "c", "d"]);
        assert_eq!(names(a.denied_servers(&folder, None, &[]).unwrap()), ["a", "b"]);
        assert!(a.denied_servers(&dir.0, None, &[]).unwrap().is_empty());
    }
}
