// The tasks panel of a chat: its subagent transcripts and frugal's delegate jobs, polled every few seconds (main.js chat:subagents).

use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

// A transcript written to within this window still reads as running.
const RUNNING_MS: f64 = 30_000.0;
// A job whose server was killed never logs its end; past delegate's longest timeout it is no longer running.
const STALE_S: f64 = 2100.0;

#[derive(Default)]
struct Cache {
    // A transcript is parsed again only after it changes.
    agents: HashMap<PathBuf, Value>,
    jobs: (f64, Vec<Value>),
    saved: Option<HashSet<String>>,
}

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(Mutex::default);

fn ms(time: SystemTime) -> f64 {
    time.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64() * 1000.0
}

// JSON.stringify writes whole numbers without ".0".
fn num(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9e15 { json!(n as i64) } else { json!(n) }
}

// String.slice counts UTF-16 units.
fn utf16_prefix(text: &str, units: usize) -> String {
    let mut n = 0;
    text.chars().take_while(|c| { n += c.len_utf16(); n <= units }).collect()
}

#[tauri::command]
pub async fn chat_subagents(app: AppHandle, id: String, cwd: String) -> Vec<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        // has_root, like Node's isAbsolute, also takes a rooted path without a drive.
        if !crate::chat::is_uuid(&id) || !Path::new(&cwd).has_root() {
            return Vec::new();
        }
        let session = app.state::<crate::index::Index>().session(&id).filter(|session| session["cwd"] == cwd.as_str());
        let (home, accounts) = {
            let accounts = app.state::<Mutex<crate::accounts::Accounts>>();
            let a = accounts.lock().unwrap();
            (a.home.clone(), if session.is_some() { Vec::new() } else { a.claude_accounts() })
        };
        let mut folders = Vec::new();
        if let Some(session) = &session {
            folders.extend(Path::new(session["file"].as_str().unwrap_or_default()).parent().map(Path::to_path_buf));
        }
        // Polled every few seconds: the folder sweep only runs for a chat the index does not know yet.
        for account in accounts {
            let root = Path::new(account["configDir"].as_str().unwrap_or_default()).join("projects");
            for entry in fs::read_dir(root).into_iter().flatten().flatten() {
                if entry.file_type().is_ok_and(|kind| kind.is_dir() || kind.is_symlink()) && !folders.contains(&entry.path()) {
                    folders.push(entry.path());
                }
            }
        }
        let jobs = home.join(".frugal").join("jobs.jsonl");
        let history = home.join(".frugal-deck").join("tasks.jsonl");
        collect(&mut CACHE.lock().unwrap(), &id, &cwd, &folders, &jobs, &history)
    })
    .await
    .unwrap_or_default()
}

fn collect(cache: &mut Cache, id: &str, cwd: &str, folders: &[PathBuf], jobs_file: &Path, tasks_file: &Path) -> Vec<Value> {
    let now = ms(SystemTime::now());
    // preserve_order: like a JS Map, a key set again keeps its first position.
    let mut agents = Map::new();
    for folder in folders {
        let Ok(entries) = fs::read_dir(folder.join(id).join("subagents")) else { continue };
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let Some(key) = file_name.to_str().filter(|name| name.len() > 12 && name.starts_with("agent-") && name.ends_with(".jsonl")) else { continue };
            if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
                continue;
            }
            let file = entry.path();
            let Some(updated_at) = fs::metadata(&file).and_then(|meta| meta.modified()).ok().map(ms) else { continue };
            if agents.get(key).and_then(|agent: &Value| agent["updatedAt"].as_f64()).is_some_and(|seen| seen >= updated_at) {
                continue;
            }
            let mut task = match cache.agents.get(&file) {
                Some(info) if info["updatedAt"].as_f64() == Some(updated_at) => info.clone(),
                _ => {
                    let Ok(info) = read_agent(&file, &key[6..key.len() - 6], updated_at) else { continue };
                    cache.agents.insert(file, info.clone());
                    info
                }
            };
            // frugal: running is guessed from mtime, and a subagent that failed still reads as done.
            task["running"] = json!(now - updated_at < RUNNING_MS);
            agents.insert(key.to_owned(), task);
        }
    }
    for job in delegate_jobs(&mut cache.jobs, jobs_file) {
        // A server started without the session id in its env only logs the folder.
        let other = match job["session"].as_str() {
            Some(session) if !session.is_empty() => session != id,
            _ => job["cwd"] != cwd,
        };
        if other {
            continue;
        }
        let start = job["start"].as_f64();
        let status = if job["status"] == "running" && start.is_some_and(|start| now / 1000.0 - start > STALE_S) { json!("failed") } else { job["status"].clone() };
        let mut task = Map::new();
        task.insert("name".into(), job["id"].clone());
        // JSON.stringify drops undefined fields, so a field the job never logged stays out.
        for (key, from) in [("description", "brief"), ("model", "model"), ("account", "account"), ("cost", "cost")] {
            if let Some(value) = job.get(from) {
                task.insert(key.into(), value.clone());
            }
        }
        let running = status == "running";
        task.insert("status".into(), status);
        task.insert("running".into(), json!(running));
        task.insert("updatedAt".into(), job["end"].as_f64().or(start).map_or(Value::Null, |time| num(time * 1000.0)));
        agents.insert(job["id"].as_str().unwrap_or_default().to_owned(), Value::Object(task));
    }
    let tasks: Vec<Value> = agents
        .into_iter()
        .map(|(key, mut task)| {
            if task["status"].is_null() {
                task["status"] = json!(if task["running"] == true { "running" } else { "done" });
            }
            task["key"] = json!(format!("{id}:{key}"));
            task
        })
        .collect();
    save_history(&mut cache.saved, id, cwd, &tasks, tasks_file);
    tasks
}

fn read_agent(file: &Path, name: &str, updated_at: f64) -> std::io::Result<Value> {
    let (mut name, mut description, mut prompt, mut model, mut tokens) = (name.to_owned(), String::new(), String::new(), Value::Null, 0.0);
    for line in BufReader::new(fs::File::open(file)?).split(b'\n') {
        let Ok(record) = serde_json::from_slice::<Value>(&line?) else { continue };
        if !record.is_object() {
            continue;
        }
        if let Some(agent) = record["agentName"].as_str().filter(|agent| !agent.is_empty()) {
            name = agent.to_owned();
        }
        if let (true, Some(text)) = (description.is_empty(), record["description"].as_str()) {
            description = text.to_owned();
        }
        let message = &record["message"];
        if message["model"].is_string() {
            model = message["model"].clone();
        }
        for key in ["input_tokens", "output_tokens", "cache_creation_input_tokens"] {
            tokens += message["usage"][key].as_f64().unwrap_or_default();
        }
        if prompt.is_empty() && record["type"] == "user" {
            let text = match &message["content"] {
                Value::String(text) => text.clone(),
                Value::Array(parts) => parts.iter().filter(|part| part["type"] == "text").map(|part| part["text"].as_str().unwrap_or_default()).collect::<Vec<_>>().join("\n"),
                _ => String::new(),
            };
            prompt = text.trim().lines().next().unwrap_or_default().to_owned();
        }
    }
    let description = if description.is_empty() { prompt } else { description };
    Ok(json!({ "name": name, "description": utf16_prefix(&description, 80), "model": model, "tokens": num(tokens), "updatedAt": num(updated_at) }))
}

// Written by frugal's delegate tool: a line when each brief starts and one when it ends.
fn delegate_jobs<'a>(jobs: &'a mut (f64, Vec<Value>), file: &Path) -> &'a [Value] {
    let mtime = fs::metadata(file).and_then(|meta| meta.modified()).ok().map(ms);
    if let (Some(mtime), Ok(bytes)) = (mtime.filter(|mtime| *mtime != jobs.0), fs::read(file)) {
        let mut by_id = Map::new();
        for line in String::from_utf8_lossy(&bytes).split('\n') {
            let Ok(job) = serde_json::from_str::<Value>(line) else { continue };
            if let Some(id) = job["id"].as_str().map(str::to_owned) {
                by_id.insert(id, job);
            }
        }
        *jobs = (mtime, by_id.into_iter().map(|(_, job)| job).collect());
    }
    &jobs.1
}

// Finished tasks of every chat, one JSON line each, to look back on what ran, where and what it cost.
fn save_history(saved: &mut Option<HashSet<String>>, chat: &str, cwd: &str, tasks: &[Value], file: &Path) {
    let saved = saved.get_or_insert_with(|| {
        let bytes = fs::read(file).unwrap_or_default();
        String::from_utf8_lossy(&bytes).split('\n').filter_map(|line| Some(serde_json::from_str::<Value>(line).ok()?["key"].as_str()?.to_owned())).collect()
    });
    let mut lines = String::new();
    for task in tasks {
        // JS throws on an invalid date; that task is left out instead.
        let (Some(key), Some(at), Some(fields)) = (task["key"].as_str(), task["updatedAt"].as_f64(), task.as_object()) else { continue };
        if task["running"] == true || !saved.insert(key.to_owned()) {
            continue;
        }
        let mut line = Map::new();
        line.insert("at".into(), json!(crate::elevated::iso(at as u64)));
        line.insert("chat".into(), json!(chat));
        line.insert("cwd".into(), json!(cwd));
        line.extend(fields.clone());
        lines.push_str(&Value::Object(line).to_string());
        lines.push('\n');
    }
    if !lines.is_empty() {
        let _ = fs::OpenOptions::new().append(true).create(true).open(file).and_then(|mut out| out.write_all(lines.as_bytes()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0f8e2c1a-1b2c-4d3e-8f90-abcdefabcdef";

    #[test]
    fn lists_subagents_and_jobs_and_saves_finished_ones() {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("deck-tasks-{}-{stamp}", std::process::id()));
        let dir = root.join("project").join(ID).join("subagents");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("agent-x.jsonl"), [
            r#"{"agentName":"scout","message":{"model":"claude-haiku","usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":1}}}"#,
            r#"{"type":"user","message":{"content":[{"type":"text","text":"  Find the bug\r\nmore"}],"usage":{"input_tokens":4}}}"#,
            "not json",
        ].join("\n")).unwrap();
        let y = dir.join("agent-y.jsonl");
        fs::write(&y, format!(r#"{{"description":"{}"}}"#, "😀".repeat(50))).unwrap();
        fs::File::options().write(true).open(&y).unwrap().set_modified(UNIX_EPOCH + std::time::Duration::from_secs(60)).unwrap();
        fs::write(dir.join("notes.jsonl"), "").unwrap();
        let jobs = root.join("jobs.jsonl");
        fs::write(&jobs, [
            format!(r#"{{"id":"j1","session":"{ID}","brief":"Fix","model":"m","account":"a","cost":0.5,"status":"running","start":1000}}"#),
            r#"{"id":"j2","cwd":"C:\\other","status":"done","start":1}"#.into(),
            format!(r#"{{"id":"j1","session":"{ID}","brief":"Fix it","model":"m","account":"a","cost":0.5,"status":"running","start":1000}}"#),
        ].join("\n")).unwrap();
        let history = root.join("tasks.jsonl");
        let mut cache = Cache::default();

        let tasks = collect(&mut cache, ID, "C:\\work", &[root.join("project")], &jobs, &history);
        let keys: Vec<_> = tasks.iter().map(|task| task["key"].as_str().unwrap().to_owned()).collect();
        assert_eq!(keys, [format!("{ID}:agent-x.jsonl"), format!("{ID}:agent-y.jsonl"), format!("{ID}:j1")]);
        let x = &tasks[0];
        assert_eq!((&x["name"], &x["description"], &x["model"], &x["tokens"]), (&json!("scout"), &json!("Find the bug"), &json!("claude-haiku"), &json!(20)));
        assert_eq!((&x["running"], &x["status"]), (&json!(true), &json!("running")));
        assert_eq!(tasks[1]["description"], "😀".repeat(40));
        assert_eq!((&tasks[1]["name"], &tasks[1]["status"], &tasks[1]["updatedAt"]), (&json!("y"), &json!("done"), &json!(60_000)));
        let j1 = tasks[2].as_object().unwrap();
        assert_eq!(j1.keys().collect::<Vec<_>>(), ["name", "description", "model", "account", "cost", "status", "running", "updatedAt", "key"]);
        assert_eq!((&j1["description"], &j1["status"], &j1["running"], &j1["updatedAt"]), (&json!("Fix it"), &json!("failed"), &json!(false), &json!(1_000_000)));

        // A second poll answers from the caches and saves nothing twice.
        assert_eq!(collect(&mut cache, ID, "C:\\work", &[root.join("project")], &jobs, &history), tasks);
        let saved = fs::read_to_string(&history).unwrap();
        let lines: Vec<Value> = saved.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1].as_object().unwrap().keys().take(4).collect::<Vec<_>>(), ["at", "chat", "cwd", "name"]);
        assert_eq!((&lines[1]["at"], &lines[1]["chat"], &lines[1]["key"]), (&json!("1970-01-01T00:16:40.000Z"), &json!(ID), &json!(format!("{ID}:j1"))));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn slices_like_javascript() {
        assert_eq!(utf16_prefix("ab😀c", 3), "ab");
        assert_eq!(num(5.0).to_string(), "5");
        assert_eq!(num(1.5).to_string(), "1.5");
    }
}
