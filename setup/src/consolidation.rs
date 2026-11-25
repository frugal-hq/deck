use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::os::windows::fs::MetadataExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) const NO_WINDOW: u32 = 0x0800_0000;

pub(crate) fn system32(exe: &str) -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("System32").join(exe)
}

pub(crate) fn home() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE").map(PathBuf::from).ok_or_else(|| "No user folder.".to_owned())
}

// Claude Code's config folders: ~/.claude and the ~/.claude-<name> of other accounts.
pub(crate) fn claude_dirs(home: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(home) else { return Vec::new() };
    entries.flatten().filter(|entry| {
        let name = entry.file_name().to_string_lossy().into_owned();
        (name == ".claude" || name.starts_with(".claude-")) && entry.path().is_dir()
    }).map(|entry| entry.path()).collect()
}

pub(crate) fn entries(dir: &Path) -> impl Iterator<Item = PathBuf> {
    std::fs::read_dir(dir).into_iter().flatten().flatten().map(|entry| entry.path())
}

fn walk(dir: &Path, files: &mut Vec<PathBuf>) {
    for path in entries(dir) {
        if plain_metadata(&path).is_ok_and(|metadata| metadata.is_dir()) { walk(&path, files) } else { files.push(path) }
    }
}

pub(crate) fn size(path: &Path) -> u64 {
    plain_metadata(path).map_or(0, |metadata| if metadata.is_dir() { dir_size(path) } else { metadata.len() })
}

// DirEntry::metadata comes with the directory listing on Windows, so old plugin caches with millions of files
// are not stat-ed one by one. Reparse points count as 0, like plain_metadata.
fn dir_size(dir: &Path) -> u64 {
    std::fs::read_dir(dir).into_iter().flatten().flatten().map(|entry| match entry.metadata() {
        Ok(metadata) if metadata.file_attributes() & 0x400 != 0 => 0,
        Ok(metadata) if metadata.is_dir() => dir_size(&entry.path()),
        Ok(metadata) => metadata.len(),
        Err(_) => 0,
    }).sum()
}

// Every session on disk by id: its transcript in an account's projects/<project>/, the <id>/ folder beside it
// (subagents, tool results) and the Deck's archive copy, ~/.frugal-deck/archive/<path relative to home>.gz.
pub(crate) fn sessions(home: &Path) -> HashMap<String, Vec<PathBuf>> {
    let mut found: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for dir in claude_dirs(home) {
        sessions_in(&dir, &mut found);
    }
    let mut copies = Vec::new();
    walk(&home.join(".frugal-deck").join("archive"), &mut copies);
    for path in copies {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if let Some(id) = name.strip_suffix(".jsonl.gz") { found.entry(id.to_owned()).or_default().push(path); }
    }
    found
}

fn sessions_in(dir: &Path, found: &mut HashMap<String, Vec<PathBuf>>) {
    for project in entries(&dir.join("projects")).filter(|p| p.is_dir()) {
        for path in entries(&project) {
            if path.extension().is_some_and(|e| e == "jsonl") && path.is_file() {
                let id = path.file_stem().unwrap().to_string_lossy().into_owned();
                let paths = found.entry(id).or_default();
                let beside = path.with_extension("");
                if beside.is_dir() { paths.push(beside); }
                paths.push(path);
            }
        }
    }
}

pub(crate) fn read_json(file: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()
}

pub(crate) fn write_json(file: &Path, value: &Value) -> std::io::Result<()> {
    std::fs::create_dir_all(file.parent().unwrap())?;
    let temporary = file.with_extension("json.tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(temporary, file)
}

pub(crate) fn consolidation_file(home: &Path) -> PathBuf {
    home.join(".frugal-deck").join("consolidation.json")
}

const INSTALLED_PLUGINS: &str = "plugins/installed_plugins.json";
const KNOWN_MARKETPLACES: &str = "plugins/known_marketplaces.json";
const PLUGIN_CACHE: &str = "plugins/cache";
static CONSOLIDATION: Mutex<()> = Mutex::new(());

fn store_dir(home: &Path) -> PathBuf {
    home.join(".frugal-deck/store")
}

fn desktop_config() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|dir| PathBuf::from(dir).join("Claude/claude_desktop_config.json"))
}

fn account_label(dir: &Path, config: &Value) -> String {
    config["oauthAccount"]["emailAddress"].as_str().filter(|email| !email.is_empty())
        .map(str::to_owned).unwrap_or_else(|| dir.file_name().unwrap().to_string_lossy().into_owned())
}

fn same_path(left: &Path, right: &Path) -> bool {
    path_parts(left) == path_parts(right)
}

fn path_parts(path: &Path) -> Vec<String> {
    use std::path::{Component, Prefix};
    let mut normalized = Vec::new();
    for component in path.components() {
        match component {
            Component::ParentDir if matches!(normalized.last(), Some(Component::Normal(_))) => { normalized.pop(); }
            Component::ParentDir if path.has_root() => {}
            Component::CurDir => {}
            _ => normalized.push(component),
        }
    }
    normalized.into_iter().map(|component| {
        if let Component::Prefix(prefix) = component {
            if let Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) = prefix.kind() {
                return char::from(drive).to_ascii_lowercase().to_string();
            }
        }
        component.as_os_str().to_string_lossy().to_lowercase()
    }).collect()
}

fn registered(accounts: &Value, dir: &Path) -> bool {
    accounts["accounts"].as_array().into_iter().flatten().any(|account| {
        account["configDir"].as_str().is_some_and(|path| same_path(Path::new(path), dir))
    })
}

fn dotted_version(version: &str) -> Option<Vec<u64>> {
    if !version.bytes().all(|byte| byte == b'.' || byte.is_ascii_digit()) { return None; }
    let mut parts = version.split('.').map(str::parse).collect::<Result<Vec<u64>, _>>().ok()?;
    while parts.last() == Some(&0) { parts.pop(); }
    Some(parts)
}

fn newer_version(candidate: &str, current: &str) -> bool {
    match (dotted_version(candidate), dotted_version(current)) {
        (Some(candidate), Some(current)) => candidate > current,
        _ => candidate != current,
    }
}

fn version_order(left: &str, right: &str) -> std::cmp::Ordering {
    match (dotted_version(left), dotted_version(right)) {
        (Some(left), Some(right)) => left.cmp(&right),
        (None, None) => left.cmp(right),
        (left, right) => left.is_some().cmp(&right.is_some()),
    }
}

type Places = BTreeMap<String, Vec<Value>>;

fn group_inventory(kind: &str, store: &Places, accounts: &Places) -> Vec<Value> {
    store.keys().chain(accounts.keys()).collect::<BTreeSet<_>>().into_iter().map(|name| {
        let stored = store.get(name).map_or(&[][..], Vec::as_slice);
        let outside = accounts.get(name).map_or(&[][..], Vec::as_slice);
        let store_version = stored.iter().filter_map(|place| place["version"].as_str()).max_by(|a, b| version_order(a, b));
        let newer = outside.iter().filter_map(|place| place["version"].as_str())
            .any(|version| store_version.map_or(!stored.is_empty(), |current| newer_version(version, current)));
        let (status, action) = if stored.is_empty() { ("not in store", "import") }
            else if newer { ("newer in account", "import") }
            else { ("in store", "remove") };
        let action = if !outside.is_empty() && outside.iter().all(|place| place["scope"] == "desktop") {
            "keep"
        } else { action };
        json!({ "kind": kind, "name": name, "store_version": store_version,
            "places": stored.iter().chain(outside).collect::<Vec<_>>(), "status": status, "action": action })
    }).collect()
}

fn plugin_places(dir: &Path, account: &str, places: &mut Places) -> Value {
    let installed = read_json(&dir.join(INSTALLED_PLUGINS)).unwrap_or_default();
    let settings = read_json(&dir.join("settings.json")).unwrap_or_default();
    let plugins = installed["plugins"].as_object();
    let enabled = settings["enabledPlugins"].as_object();
    for name in plugins.into_iter().flat_map(Map::keys).chain(enabled.into_iter().flat_map(Map::keys)).collect::<BTreeSet<_>>() {
        let mut found = false;
        for entry in installed["plugins"][name].as_array().into_iter().flatten() {
            let mut place = json!({ "account": account, "dir": dir, "scope": entry["scope"].as_str().unwrap_or("user"),
                "version": entry["version"].as_str() });
            if let Some(path) = entry["projectPath"].as_str() { place["projectPath"] = json!(path); }
            if let Some(enabled) = settings["enabledPlugins"][name].as_bool() { place["enabled"] = json!(enabled); }
            places.entry(name.clone()).or_default().push(place);
            found = true;
        }
        if !found {
            places.entry(name.clone()).or_default().push(json!({ "account": account, "dir": dir, "scope": "user",
                "version": null, "enabled": settings["enabledPlugins"][name].as_bool() }));
        }
    }
    installed
}

fn mcp_places(servers: &Value, dir: &Path, account: &str, scope: &str, project: Option<&str>, places: &mut Places) {
    for (name, server) in servers.as_object().into_iter().flatten() {
        let detail: Map<String, Value> = ["type", "url", "command"].into_iter()
            .filter_map(|key| server[key].as_str().map(|value| (key.to_owned(), json!(value)))).collect();
        let mut place = json!({ "account": account, "dir": dir, "scope": scope, "detail": detail });
        if let Some(project) = project { place["projectPath"] = json!(project); }
        places.entry(name.clone()).or_default().push(place);
    }
}

fn cache_dirs(dir: &Path) -> impl Iterator<Item = PathBuf> {
    entries(&dir.join(PLUGIN_CACHE)).filter(|path| path.is_dir())
        .flat_map(|market| entries(&market).filter(|path| path.is_dir()))
        .flat_map(|plugin| entries(&plugin).filter(|path| path.is_dir()))
}

fn cache_referenced(installed: &Value, dir: &Path, cache: &Path) -> bool {
    installed["plugins"].as_object().into_iter().flat_map(Map::values)
        .flat_map(|entries| entries.as_array().into_iter().flatten())
        .any(|entry| entry_uses_cache(entry, dir, cache))
}

fn entry_uses_cache(entry: &Value, dir: &Path, cache: &Path) -> bool {
    entry["installPath"].as_str().is_some_and(|path| path_parts(&dir.join(path)).starts_with(&path_parts(cache)))
}

#[tauri::command]
pub(crate) async fn inventory() -> Value {
    let (mut store_plugins, mut plugins, mut store_mcp, mut mcp) = (Places::new(), Places::new(), Places::new(), Places::new());
    let (mut accounts, mut copies, mut transcripts) = (Vec::new(), Vec::new(), Vec::new());
    if let Ok(home) = home() {
        let store = store_dir(&home);
        let known_accounts = read_json(&home.join(".frugal/accounts.json")).unwrap_or_default();
        let mut found_sessions = sessions(&home);
        sessions_in(&store, &mut found_sessions);
        let mut dirs = claude_dirs(&home);
        dirs.sort();
        for dir in std::iter::once(store.clone()).chain(dirs) {
            let config = read_json(&dir.join(".claude.json")).unwrap_or_default();
            let is_store = dir == store;
            let account = if is_store { "Deck store".to_owned() } else { account_label(&dir, &config) };
            let installed = plugin_places(&dir, &account, if is_store { &mut store_plugins } else { &mut plugins });
            let places = if is_store { &mut store_mcp } else { &mut mcp };
            mcp_places(&config["mcpServers"], &dir, &account, "user", None, places);
            for (project, config) in config["projects"].as_object().into_iter().flatten() {
                mcp_places(&config["mcpServers"], &dir, &account, "project", Some(project), places);
            }
            if !is_store && config["oauthAccount"].is_object() {
                let registered = registered(&known_accounts, &dir);
                accounts.push(json!({ "kind": "account", "name": dir.file_name(), "account": account, "dir": dir,
                    "registered": registered, "action": if registered { "keep" } else { "import" } }));
            }
            let (count, bytes) = found_sessions.values().fold((0, 0), |(count, bytes), paths| {
                let mut paths = paths.iter().filter(|path| path.starts_with(&dir)).peekable();
                (count + usize::from(paths.peek().is_some()), bytes + paths.map(|path| size(path)).sum::<u64>())
            });
            if dir.is_dir() {
                transcripts.push(json!({ "kind": "sessions", "name": dir, "account": account, "dir": dir,
                    "count": count, "bytes": bytes, "action": "keep" }));
            }
            for path in cache_dirs(&dir).filter(|path| !cache_referenced(&installed, &dir, path)) {
                // No size: walking millions of cached files took minutes.
                copies.push(json!({ "kind": "copy", "name": path, "account": account, "dir": dir, "action": "remove" }));
            }
        }
    }
    if let Some(file) = desktop_config() {
        if let Some(config) = read_json(&file) {
            mcp_places(&config["mcpServers"], file.parent().unwrap(), "Claude Desktop", "desktop", None, &mut mcp);
        }
    }
    json!({ "plugins": group_inventory("plugin", &store_plugins, &plugins), "mcp": group_inventory("mcp", &store_mcp, &mcp),
        "accounts": accounts, "copies": copies, "sessions": transcripts })
}

pub(crate) fn remove(path: &Path, errors: &mut Vec<String>) {
    let result = if path.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
    if let Err(error) = result {
        if error.kind() != std::io::ErrorKind::NotFound { errors.push(format!("{}: {error}", path.display())); }
    }
}

fn path_error(path: &Path, error: impl std::fmt::Display) -> String {
    format!("{}: {error}", path.display())
}

fn plain_metadata(path: &Path) -> std::io::Result<fs::Metadata> {
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(std::io::Error::new(ErrorKind::InvalidInput, "Reparse point"));
    }
    Ok(metadata)
}

fn safe_relative<'a>(home: &Path, path: &'a Path) -> Result<&'a Path, String> {
    let relative = path.strip_prefix(home).map_err(|_| path_error(path, "Outside the user folder"))?;
    let mut current = home.to_path_buf();
    for component in relative.components() {
        let name = component.as_os_str().to_string_lossy();
        if !matches!(component, std::path::Component::Normal(_)) || name.contains([':', '\r', '\n'])
            || name.ends_with(['.', ' ']) {
            return Err(path_error(path, "Unsafe path"));
        }
        current.push(component);
        match plain_metadata(&current) {
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(path_error(&current, error)),
        }
    }
    if relative.as_os_str().is_empty() { return Err(path_error(path, "Expected a path below the user folder")); }
    Ok(relative)
}

fn load_config(home: &Path, path: &Path) -> Result<Value, String> {
    safe_relative(home, path)?;
    match fs::metadata(path) {
        Ok(_) => read_json(path).filter(Value::is_object).ok_or_else(|| path_error(path, "Expected a JSON object")),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(path_error(path, error)),
    }
}

fn config_map<'a>(config: &'a Value, key: &str) -> Result<Option<&'a Map<String, Value>>, String> {
    config.get(key).map(|value| value.as_object().ok_or_else(|| format!("{key} must be a JSON object"))).transpose()
}

fn put_config_key(config: &mut Value, key: &str, name: &str, value: Value) -> Result<(), String> {
    if config_map(config, key)?.is_none() { config[key] = json!({}); }
    config[key][name] = value;
    Ok(())
}

fn drop_config_key(config: &mut Value, key: &str, name: &str) -> Result<Option<Value>, String> {
    config_map(config, key)?;
    Ok(config.get_mut(key).and_then(Value::as_object_mut).and_then(|map| map.remove(name)))
}

fn installed_config(home: &Path, dir: &Path) -> Result<Value, String> {
    let file = dir.join(INSTALLED_PLUGINS);
    let config = load_config(home, &file)?;
    for entries in config_map(&config, "plugins")?.into_iter().flat_map(Map::values) {
        if !entries.as_array().is_some_and(|entries| entries.iter().all(|entry| {
            entry.is_object() && entry["installPath"].as_str().is_some_and(|path| !path.is_empty())
        })) {
            return Err(path_error(&file, "Expected plugin installation entries"));
        }
    }
    Ok(config)
}

fn cache_suffix<'a>(dir: &Path, path: &'a Path) -> Option<&'a Path> {
    let root = dir.join(PLUGIN_CACHE);
    let suffix = path.strip_prefix(root).ok()?;
    (suffix.components().count() == 3 && suffix.components().all(|part| matches!(part, std::path::Component::Normal(_))))
        .then_some(suffix)
}

fn cache_for_plugin(market: &str, plugin: &str, version: &str) -> Result<PathBuf, String> {
    let mut path = PathBuf::new();
    for part in [market, plugin, version] {
        let mut components = Path::new(part).components();
        if components.next() != Some(std::path::Component::Normal(part.as_ref())) || components.next().is_some() {
            return Err(format!("Invalid plugin cache component: {part}"));
        }
        path.push(part);
    }
    Ok(path)
}

#[derive(Default)]
struct ConsolidationEdit {
    account: String,
    writes: Vec<(PathBuf, Value)>,
    copies: Vec<(PathBuf, PathBuf)>,
    removals: Vec<PathBuf>,
}

fn plan_plugin(home: &Path, dirs: &[PathBuf], name: &str, import: bool) -> Result<Vec<ConsolidationEdit>, String> {
    let store = store_dir(home);
    let mut saved = if import { installed_config(home, &store)? } else { Value::Null };
    let store_entries = saved["plugins"][name].as_array();
    let store_version = store_entries.into_iter().flatten().filter_map(|entry| entry["version"].as_str())
        .max_by(|a, b| version_order(a, b));
    let mut source: Option<(PathBuf, Value)> = None;
    let mut edits = Vec::new();
    for dir in dirs {
        let mut edit = ConsolidationEdit { account: account_label(dir, &read_json(&dir.join(".claude.json")).unwrap_or_default()), ..Default::default() };
        let mut installed = installed_config(home, dir)?;
        if let Some(removed) = drop_config_key(&mut installed, "plugins", name)? {
            let removed = removed.as_array().unwrap();
            for entry in removed {
                if let Some(version) = entry["version"].as_str().filter(|_| import) {
                    if store_version.is_none_or(|current| newer_version(version, current))
                        && source.as_ref().is_none_or(|(_, entry)| version_order(version, entry["version"].as_str().unwrap()).is_gt()) {
                        source = Some((dir.clone(), entry.clone()));
                    }
                }
            }
            for cache in cache_dirs(dir) {
                if removed.iter().any(|entry| entry_uses_cache(entry, dir, &cache)) {
                    edit.removals.push(cache);
                }
            }
            edit.writes.push((dir.join(INSTALLED_PLUGINS), installed));
        }
        let file = dir.join("settings.json");
        let mut settings = load_config(home, &file)?;
        if drop_config_key(&mut settings, "enabledPlugins", name)?.is_some() {
            edit.writes.push((file, settings));
        }
        if !edit.writes.is_empty() { edits.push(edit); }
    }
    if import {
        let mut edit = ConsolidationEdit { account: "Deck store".into(), ..Default::default() };
        if let Some((dir, mut entry)) = source {
            let (plugin, market) = name.rsplit_once('@').ok_or("Expected a plugin name with a marketplace")?;
            let suffix = cache_for_plugin(market, plugin, entry["version"].as_str().unwrap())?;
            let destination = store.join(PLUGIN_CACHE).join(&suffix);
            safe_relative(home, &destination)?;
            if destination.is_dir() {
                inspect_tree(&destination).map_err(|error| path_error(&destination, error))?;
            } else {
                let source = entry["installPath"].as_str().map(|path| dir.join(path)).ok_or("Plugin has no installPath")?;
                if !same_path(&source, &dir.join(PLUGIN_CACHE).join(&suffix)) || !source.is_dir() {
                    return Err(path_error(&source, "Plugin cache version directory is missing or outside the expected location"));
                }
                edit.copies.push((source, destination.clone()));
            }
            entry["scope"] = json!("user");
            entry["installPath"] = json!(destination);
            entry.as_object_mut().unwrap().remove("projectPath");
            put_config_key(&mut saved, "plugins", name, json!([entry]))?;
            saved["version"] = json!(2);
            edit.writes.push((store.join(INSTALLED_PLUGINS), saved));

            let location = Path::new("plugins/marketplaces").join(market);
            let destination = store.join(&location);
            safe_relative(home, &destination)?;
            let file = store.join(KNOWN_MARKETPLACES);
            let mut known = load_config(home, &file)?;
            if known.get(market).is_none() || !destination.is_dir() {
                let source = load_config(home, &dir.join(KNOWN_MARKETPLACES))?;
                let mut marketplace = known.get(market).or_else(|| source.get(market)).filter(|entry| entry.is_object())
                    .cloned().ok_or_else(|| format!("Missing marketplace entry for {market}"))?;
                marketplace["installLocation"] = json!(destination);
                if known.get(market) != Some(&marketplace) {
                    known[market] = marketplace;
                    edit.writes.push((file, known));
                }
                let source = dir.join(location);
                if !destination.is_dir() {
                    if !source.is_dir() { return Err(path_error(&source, "Marketplace directory is missing")); }
                    edit.copies.push((source, destination));
                }
            }
        } else if !store_entries.is_some_and(|entries| !entries.is_empty()) {
            return Err("Plugin has no installed entry to import".into());
        }
        let file = store.join("settings.json");
        let mut settings = load_config(home, &file)?;
        if settings["enabledPlugins"][name] != true {
            put_config_key(&mut settings, "enabledPlugins", name, json!(true))?;
            edit.writes.push((file, settings));
        }
        edits.insert(0, edit);
    }
    Ok(edits)
}

fn plan_mcp(home: &Path, dirs: &[PathBuf], name: &str, import: bool) -> Result<Vec<ConsolidationEdit>, String> {
    let mut source = None;
    let mut edits = Vec::new();
    for dir in dirs {
        let file = dir.join(".claude.json");
        let mut config = load_config(home, &file)?;
        let account = account_label(dir, &config);
        let mut removed = Vec::new();
        removed.extend(drop_config_key(&mut config, "mcpServers", name)?);
        config_map(&config, "projects")?;
        if let Some(projects) = config.get_mut("projects").and_then(Value::as_object_mut) {
            for project in projects.values_mut() {
                removed.extend(drop_config_key(project, "mcpServers", name)?);
            }
        }
        if !removed.is_empty() {
            if source.is_none() { source = removed.into_iter().find(Value::is_object); }
            edits.push(ConsolidationEdit { account, writes: vec![(file, config)], ..Default::default() });
        }
    }
    if import {
        let file = store_dir(home).join(".claude.json");
        let mut config = load_config(home, &file)?;
        if !config_map(&config, "mcpServers")?.is_some_and(|servers| servers.contains_key(name)) {
            let server = source.or_else(|| {
                let desktop = read_json(&desktop_config()?)?;
                desktop["mcpServers"][name].as_object().map(|server| Value::Object(server.clone()))
            }).ok_or("MCP server has no configuration to import")?;
            put_config_key(&mut config, "mcpServers", name, server)?;
            edits.insert(0, ConsolidationEdit { account: "Deck store".into(), writes: vec![(file, config)], ..Default::default() });
        }
    }
    Ok(edits)
}

fn plan_account(home: &Path, dirs: &[PathBuf], name: &str) -> Result<Vec<ConsolidationEdit>, String> {
    let dir = dirs.iter().find(|dir| dir.file_name().is_some_and(|folder| folder == name)).ok_or("Unknown account")?;
    let config = load_config(home, &dir.join(".claude.json"))?;
    if !config["oauthAccount"].is_object() { return Err("Account is signed out".into()); }
    let file = home.join(".frugal/accounts.json");
    let mut accounts = load_config(home, &file)?;
    if registered(&accounts, dir) { return Ok(Vec::new()); }
    let id = name.strip_prefix(".claude-").unwrap_or("main");
    let account = account_label(dir, &config);
    if accounts.get("accounts").is_none() { accounts["accounts"] = json!([]); }
    let entries = accounts["accounts"].as_array_mut().ok_or("accounts must be a JSON array")?;
    if id.is_empty() || entries.iter().any(|entry| entry["id"] == id) {
        return Err(format!("Account ID is already in use or empty: {id}"));
    }
    entries.push(json!({ "id": id, "name": account, "configDir": dir }));
    Ok(vec![ConsolidationEdit { account, writes: vec![(file, accounts)], ..Default::default() }])
}

fn plan_consolidation(home: &Path, dirs: &[PathBuf], kind: &str, name: &str, action: &str) -> Result<Vec<ConsolidationEdit>, String> {
    match (kind, action) {
        ("plugin", "remove" | "import") => plan_plugin(home, dirs, name, action == "import"),
        ("mcp", "remove" | "import") => plan_mcp(home, dirs, name, action == "import"),
        ("account", "import") => plan_account(home, dirs, name),
        ("copy" | "sessions", "remove") => plan_file_removal(home, dirs, kind, name),
        _ => Err(format!("Invalid action for {kind}: {action}")),
    }
}

fn plan_file_removal(home: &Path, dirs: &[PathBuf], kind: &str, name: &str) -> Result<Vec<ConsolidationEdit>, String> {
    let store = store_dir(home);
    let path = Path::new(name);
    safe_relative(home, path)?;
    let dir = dirs.iter().chain(std::iter::once(&store)).find(|dir| {
        if kind == "copy" { cache_suffix(dir, path).is_some() } else { dir.as_path() == path }
    }).ok_or("Unknown account or cache path")?;
    let removals = if kind == "copy" {
        if cache_referenced(&installed_config(home, dir)?, dir, path) { return Err("Plugin cache is in use".into()); }
        if !path.is_dir() { return Err("Plugin cache directory is missing".into()); }
        vec![path.to_path_buf()]
    } else {
        let mut found = sessions(home);
        sessions_in(&store, &mut found);
        found.into_values().flatten().filter(|path| path.starts_with(dir)).collect()
    };
    let account = if dir == &store { "Deck store".into() } else { account_label(dir, &read_json(&dir.join(".claude.json")).unwrap_or_default()) };
    Ok(vec![ConsolidationEdit { account, removals, ..Default::default() }])
}

fn validate_edits(home: &Path, edits: &[ConsolidationEdit]) -> Result<(), String> {
    for edit in edits {
        for (path, _) in &edit.writes {
            safe_relative(home, path)?;
            safe_relative(home, &path.with_extension("json.tmp"))?;
        }
        for (source, target) in &edit.copies {
            safe_relative(home, source)?;
            safe_relative(home, target)?;
            inspect_tree(source).map_err(|error| path_error(source, error))?;
        }
        for path in &edit.removals {
            safe_relative(home, path)?;
            inspect_tree(path).map_err(|error| path_error(path, error))?;
        }
    }
    Ok(())
}

fn inspect_tree(path: &Path) -> std::io::Result<()> {
    if plain_metadata(path)?.is_dir() {
        for entry in fs::read_dir(path)? { inspect_tree(&entry?.path())?; }
    }
    Ok(())
}

fn copy_tree(source: &Path, destination: &Path) -> std::io::Result<()> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source = entry.path();
        let target = destination.join(entry.file_name());
        if plain_metadata(&source)?.is_dir() {
            fs::create_dir(&target)?;
            copy_tree(&source, &target)?;
        } else {
            fs::copy(&source, &target)?;
        }
    }
    Ok(())
}

fn copy_directory(home: &Path, source: &Path, destination: &Path) -> Result<(), String> {
    safe_relative(home, source)?;
    safe_relative(home, destination)?;
    fs::create_dir_all(destination.parent().unwrap()).map_err(|error| path_error(destination, error))?;
    let scratch = consolidation_scratch(home)?;
    if let Err(error) = copy_tree(source, &scratch).and_then(|()| fs::rename(&scratch, destination)) {
        let mut errors = vec![path_error(destination, error)];
        remove(&scratch, &mut errors);
        return Err(errors.join("\n"));
    }
    Ok(())
}

fn consolidation_scratch(home: &Path) -> Result<PathBuf, String> {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_nanos();
    let path = home.join(".frugal-deck/backups").join(format!(".consolidate-{}-{stamp}", std::process::id()));
    safe_relative(home, &path)?;
    fs::create_dir(&path).map_err(|error| path_error(&path, error))?;
    Ok(path)
}

pub(crate) fn create_zip(home: &Path, zip: &Path, list_file: &Path, list: &[String]) -> Result<(), String> {
    fs::write(list_file, list.join("\n")).map_err(|error| path_error(list_file, error))?;
    let output = Command::new(system32("tar.exe")).arg("-a").arg("-c").arg("-f").arg(zip)
        .arg("-C").arg(home).arg("-T").arg(list_file).creation_flags(NO_WINDOW).output();
    let _ = fs::remove_file(list_file);
    let output = output.map_err(|error| format!("The backup could not start, so nothing was removed: {error}"))?;
    if !output.status.success() {
        let _ = fs::remove_file(zip);
        return Err(format!("The backup failed, so nothing was removed. {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(())
}

fn cache_in_store(home: &Path, path: &Path) -> Option<PathBuf> {
    let name = path.strip_prefix(home).ok()?.components().next()?.as_os_str().to_str()?;
    if name != ".claude" && !name.starts_with(".claude-") { return None; }
    let suffix = cache_suffix(&home.join(name), path)?;
    Some(store_dir(home).join(PLUGIN_CACHE).join(suffix))
}

fn usable_cache(home: &Path, path: &Path) -> bool {
    safe_relative(home, path).is_ok() && path.is_dir() && inspect_tree(path).is_ok()
}

fn consolidation_manifest(home: &Path) -> Result<Value, String> {
    let file = consolidation_file(home);
    let mut manifest = load_config(home, &file)?;
    if manifest.get("backups").is_none() { manifest["backups"] = json!([]); }
    if !manifest["backups"].is_array() { return Err(path_error(&file, "Expected a backups array")); }
    Ok(manifest)
}

fn save_consolidation_json(home: &Path, file: &Path, value: &Value) -> Result<(), String> {
    safe_relative(home, file)?;
    safe_relative(home, &file.with_extension("json.tmp"))?;
    write_json(file, value).map_err(|error| path_error(file, error))
}

#[tauri::command]
pub(crate) async fn consolidate(actions: Value) -> Result<Value, String> {
    let _lock = CONSOLIDATION.lock().map_err(|error| error.to_string())?;
    let home = home()?;
    let mut dirs = claude_dirs(&home);
    dirs.sort();
    let mut errors = Vec::new();
    let mut plans = Vec::new();
    let mut seen = HashSet::new();
    for item in actions.as_array().ok_or("Expected an array of consolidation actions")? {
        let (Some(kind), Some(name), Some(action)) = (item["kind"].as_str(), item["name"].as_str(), item["action"].as_str()) else {
            errors.push("Every consolidation action needs a kind, name and action".to_owned());
            continue;
        };
        if action == "keep" && matches!(kind, "plugin" | "mcp" | "account" | "copy" | "sessions") { continue; }
        if !seen.insert((kind, name)) {
            errors.push(format!("{kind} {name}: Duplicate action"));
            continue;
        }
        match plan_consolidation(&home, &dirs, kind, name, action).and_then(|edits| {
            validate_edits(&home, &edits)?;
            Ok(edits)
        }) {
            Ok(edits) => plans.push((kind, name, action, edits)),
            Err(error) => errors.push(format!("{kind} {name}: {error}")),
        }
    }
    // Imports establish store references before checking the selected orphan copies again.
    plans.sort_by_key(|(kind, _, _, _)| *kind == "copy");
    let store_removals: HashSet<_> = plans.iter().flat_map(|(_, _, _, edits)| edits)
        .flat_map(|edit| &edit.removals).filter(|path| path.starts_with(store_dir(&home))).collect();
    let store_copies: HashSet<_> = plans.iter().flat_map(|(_, _, _, edits)| edits)
        .flat_map(|edit| edit.copies.iter().map(|(_, target)| target)).collect();
    let mut archived = BTreeSet::new();
    let mut created = BTreeSet::new();
    let mut changes = Vec::new();
    for (kind, name, action, edits) in &plans {
        for edit in edits {
            let mut paths = Vec::new();
            for (path, _) in &edit.writes {
                let relative = safe_relative(&home, path)?;
                paths.push(relative);
                if path.exists() { archived.insert(path.clone()); }
                else { created.insert(path.clone()); }
            }
            for (_, target) in &edit.copies {
                paths.push(safe_relative(&home, target)?);
                if !target.exists() { created.insert(target.clone()); }
            }
            for path in &edit.removals {
                paths.push(safe_relative(&home, path)?);
                let same_in_store = cache_in_store(&home, path).is_some_and(|store_path| {
                    !store_removals.contains(&store_path) && (usable_cache(&home, &store_path) || store_copies.contains(&store_path))
                });
                // Old plugin copies are unused downloads with up to millions of files: zipping them stalled the setup.
                if *kind != "copy" && !same_in_store { archived.insert(path.clone()); }
            }
            if !paths.is_empty() {
                let action = if *action == "import" && *kind != "account" && !paths[0].starts_with(".frugal-deck/store") {
                    "remove"
                } else { action };
                changes.push(json!({ "action": action, "kind": kind, "name": name, "account": edit.account, "paths": paths }));
            }
        }
    }
    if plans.iter().any(|(kind, _, _, _)| *kind == "mcp") {
        if let Some(file) = desktop_config().filter(|path| path.is_file()) {
            if let Ok(relative) = safe_relative(&home, &file) {
                changes.push(json!({ "action": "keep", "kind": "mcp", "name": "Claude Desktop", "account": "Claude Desktop", "paths": [relative] }));
                archived.insert(file);
            }
        }
    }
    if changes.is_empty() {
        return Ok(json!({ "zip": null, "applied": plans.len(), "errors": errors }));
    }

    let mut manifest = consolidation_manifest(&home)?;
    let backup_dir = home.join(".frugal-deck/backups");
    safe_relative(&home, &backup_dir)?;
    fs::create_dir_all(&backup_dir).map_err(|error| path_error(&backup_dir, error))?;
    let created_at = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_secs();
    let (zip, list_file) = (created_at..).map(|second| {
        let zip = backup_dir.join(format!("consolidate-{second}.zip"));
        let list = zip.with_extension("txt");
        (zip, list)
    }).find(|(zip, list)| !zip.exists() && !list.exists()).unwrap();
    let zip_relative = safe_relative(&home, &zip)?;
    safe_relative(&home, &list_file)?;
    let mut list = Vec::new();
    for path in &archived {
        inspect_tree(path).map_err(|error| path_error(path, error))?;
        let relative = safe_relative(&home, path)?;
        list.push(format!("./{}", relative.to_string_lossy().replace('\\', "/")));
    }
    create_zip(&home, &zip, &list_file, &list)?;
    manifest["backups"].as_array_mut().unwrap().push(json!({ "zip": zip_relative, "created": created_at, "changes": changes }));
    save_consolidation_json(&home, &consolidation_file(&home), &manifest)?;

    let mut applied = 0;
    for (kind, name, action, _) in plans {
        let result = (|| {
            for edit in plan_consolidation(&home, &dirs, kind, name, action)? {
                for (source, target) in edit.copies {
                    if !created.contains(&target) { return Err(path_error(&target, "Unplanned copy")); }
                    copy_directory(&home, &source, &target)?;
                }
                for (file, config) in edit.writes {
                    if !archived.contains(&file) && !created.contains(&file) { return Err(path_error(&file, "File was not backed up")); }
                    save_consolidation_json(&home, &file, &config)?;
                }
                for path in edit.removals {
                    safe_relative(&home, &path)?;
                    if let Some(dir) = dirs.iter().find(|dir| cache_suffix(dir, &path).is_some()) {
                        if cache_referenced(&installed_config(&home, dir)?, dir, &path) { continue; }
                    }
                    let mut errors = Vec::new();
                    if archived.contains(&path) {
                        remove(&path, &mut errors);
                    } else {
                        if kind != "copy" && !cache_in_store(&home, &path).is_some_and(|store_path| usable_cache(&home, &store_path)) {
                            return Err(path_error(&path, "Path was not backed up"));
                        }
                        // Stage the removal so it cannot leave a partial cache at its original path.
                        let scratch = consolidation_scratch(&home)?;
                        let moved = fs::rename(&path, scratch.join("cache"));
                        remove(&scratch, &mut errors);
                        moved.map_err(|error| path_error(&path, error))?;
                    }
                    if !errors.is_empty() { return Err(errors.join("\n")); }
                }
            }
            Ok(())
        })();
        match result {
            Ok(()) => applied += 1,
            Err(error) => errors.push(format!("{kind} {name}: {error}")),
        }
    }
    Ok(json!({ "zip": zip, "applied": applied, "errors": errors }))
}

#[tauri::command]
pub(crate) async fn restore() -> Result<(), String> { restore_config() }

pub(crate) fn restore_config() -> Result<(), String> {
    let _lock = CONSOLIDATION.lock().map_err(|error| error.to_string())?;
    let home = home()?;
    let file = consolidation_file(&home);
    let mut manifest = consolidation_manifest(&home)?;
    while let Some(backup) = manifest["backups"].as_array_mut().unwrap().pop() {
        let zip = home.join(backup["zip"].as_str().ok_or("Backup has no zip path")?);
        let backup_dir = home.join(".frugal-deck/backups");
        if zip.parent() != Some(backup_dir.as_path()) || zip.extension().is_none_or(|ext| ext != "zip") {
            return Err(path_error(&zip, "Invalid backup path"));
        }
        safe_relative(&home, &zip)?;
        let mut caches = Vec::new();
        let mut command = Command::new(system32("tar.exe"));
        command.arg("-x").arg("-f").arg(&zip).arg("-C").arg(&home).creation_flags(NO_WINDOW);
        for change in backup["changes"].as_array().ok_or("Backup has no changes array")? {
            for path in change["paths"].as_array().ok_or("Change has no paths array")? {
                let path = home.join(path.as_str().ok_or("Expected a backup path")?);
                let relative = safe_relative(&home, &path)?;
                if change["action"] == "keep" && change["account"] == "Claude Desktop" {
                    command.arg("--exclude").arg(relative.to_string_lossy().replace('\\', "/"));
                } else if let Some(store_path) = cache_in_store(&home, &path) {
                    caches.push((path, store_path));
                }
            }
        }
        let output = command.output().map_err(|error| path_error(&zip, error))?;
        if !output.status.success() { return Err(path_error(&zip, String::from_utf8_lossy(&output.stderr).trim())); }
        for (path, store_path) in caches {
            if !path.is_dir() && store_path.is_dir() { copy_directory(&home, &store_path, &path)?; }
        }
        if !manifest["backups"].as_array().unwrap().is_empty() { save_consolidation_json(&home, &file, &manifest)?; }
    }
    let mut errors = Vec::new();
    remove(&file, &mut errors);
    if errors.is_empty() { Ok(()) } else { Err(errors.join("\n")) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plugin_inventory(store: Option<&str>, account: &str) -> Value {
        let name = "example@market".to_owned();
        let stored = store.map(|version| {
            Places::from([(name.clone(), vec![json!({ "account": "Deck store", "scope": "user", "version": version })])])
        }).unwrap_or_default();
        let outside = Places::from([(name, vec![json!({ "account": "dev@example.com", "scope": "project", "version": account })])]);
        group_inventory("plugin", &stored, &outside).remove(0)
    }

    #[test]
    fn in_store() {
        let row = plugin_inventory(Some("1.10.0"), "1.9");
        assert_eq!(row["status"], "in store");
        assert_eq!(row["action"], "remove");
        assert_eq!(row["store_version"], "1.10.0");
        assert_eq!(row["places"].as_array().unwrap().len(), 2);
        assert_eq!(plugin_inventory(Some("1.10.0"), "1.10")["status"], "in store");
    }

    #[test]
    fn newer_in_account() {
        for (store, account) in [("1.9", "1.10"), ("release", "nightly")] {
            let row = plugin_inventory(Some(store), account);
            assert_eq!(row["status"], "newer in account");
            assert_eq!(row["action"], "import");
        }
    }

    #[test]
    fn not_in_store() {
        let row = plugin_inventory(None, "2");
        assert_eq!(row["status"], "not in store");
        assert_eq!(row["action"], "import");
        assert!(row["store_version"].is_null());
    }

    #[test]
    fn desktop_only() {
        let mut places = Places::new();
        mcp_places(&json!({ "example": { "type": "http", "url": "https://example.test",
            "headers": { "Authorization": "secret" }, "env": { "API_KEY": "secret" } } }),
            Path::new("Claude"), "Claude Desktop", "desktop", None, &mut places);
        let row = group_inventory("mcp", &Places::new(), &places).remove(0);
        assert_eq!(row["status"], "not in store");
        assert_eq!(row["action"], "keep");
        assert_eq!(row["places"][0]["detail"], json!({ "type": "http", "url": "https://example.test" }));
    }
}
