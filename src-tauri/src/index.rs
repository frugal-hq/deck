#![allow(dead_code)] // The organizer's writes (titles, model joins and workspaces) come with phase 4.

use rusqlite::{named_params, params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use notify::{RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager, State};
use crate::chat::Chats;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const CHUNK: usize = 1 << 20;
const BATCH: usize = 500;

fn text(value: &Value) -> Value {
    value.as_str().map_or(Value::Null, |s| json!(s))
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn whitespace(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

fn trim(s: &str) -> &str {
    s.trim_matches(whitespace)
}

fn collapse_ws(s: &str) -> String {
    s.split(whitespace).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
}

fn first_text(content: &Value) -> &Value {
    if content.is_string() { content } else {
        content.as_array().and_then(|a| a.iter().find(|b| b["type"] == "text"))
            .map_or(&Value::Null, |b| &b["text"])
    }
}

fn line_end(c: char) -> bool {
    matches!(c, '\r' | '\n' | '\u{2028}' | '\u{2029}')
}

fn goal_line(prompt: &str) -> Option<&str> {
    for (start, _) in std::iter::once((0, '\n')).chain(
        prompt.char_indices().filter(|(_, c)| line_end(*c)).map(|(i, c)| (i + c.len_utf8(), c))
    ) {
        if let Some(rest) = prompt[start..].strip_prefix("Goal:") {
            let tail = rest.trim_start_matches(whitespace);
            if let Some(line) = tail.split(line_end).next().filter(|s| !s.is_empty()) { return Some(line); }
            // JS \s* backtracks when the only possible .+ capture is whitespace.
            if let Some((i, _)) = rest.char_indices().rev().find(|(_, c)| !line_end(*c)) {
                return rest[i..].split(line_end).next();
            }
        }
    }
    None
}

fn find_between<'a>(s: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let rest = &s[s.find(open)? + open.len()..];
    Some(&rest[..rest.find(close)?])
}

fn strip_tags(mut s: &str) -> String {
    let mut out = String::new();
    while let Some(start) = s.find('<') {
        out.push_str(&s[..start]);
        s = &s[start..];
        if let Some(end) = s[1..].find('>').map(|i| i + 1).filter(|&i| i > 1) {
            out.push(' ');
            s = &s[end + 1..];
        } else {
            out.push('<');
            s = &s[1..];
        }
    }
    out + s
}

fn prompt_title(content: &Value) -> Option<String> {
    let prompt = first_text(content).as_str()?;
    let command = prompt.match_indices("<command-name>").find_map(|(i, _)| {
        find_between(&prompt[i..], "<command-name>", "</command-name>").filter(|s| !s.contains(line_end))
    });
    let args = find_between(prompt, "<command-args>", "</command-args>").unwrap_or("");
    let title = if let Some(goal) = goal_line(prompt) { goal.to_owned() }
        else if let Some(command) = command.filter(|s| !s.is_empty()) { format!("{command} {args}") }
        else { strip_tags(prompt) };
    let title = collapse_ws(&title);
    if title.is_empty() { None } else {
        // Rust strings replace the lone surrogate if JS's 120-unit slice splits a pair.
        Some(String::from_utf16_lossy(&title.encode_utf16().take(120).collect::<Vec<_>>()))
    }
}

#[derive(Debug, PartialEq)]
struct HandoffBlock { hash: String, goal: String }

fn starts(line: &str, prefix: &str) -> bool {
    line.trim_start_matches(whitespace).starts_with(prefix)
}

fn handoff_block(body: &Value) -> Option<HandoffBlock> {
    let body = body.as_str()?;
    let cut = ["</pasted_content", "</command-args"].iter().filter_map(|s| body.find(s)).min().unwrap_or(body.len());
    let lines: Vec<_> = body[..cut].split('\n').collect();
    let from = lines.iter().position(|s| starts(s, "Goal:"))?;
    let taken = &lines[from..];
    let taken = &taken[..taken.iter().skip(1).position(|s| starts(s, "```")).map_or(taken.len(), |i| i + 1)];
    if !taken.iter().any(|s| starts(s, "Done:")) || !taken.iter().any(|s| starts(s, "Pending:")) { return None; }
    let kept: Vec<_> = taken.iter().filter(|s| !starts(s, "Usage:")).map(|s| collapse_ws(s)).filter(|s| !s.is_empty()).collect();
    Some(HandoffBlock { hash: sha1_hex(kept.join("\n").as_bytes()), goal: trim(&kept[0][5..]).to_owned() })
}

fn next_block(body: &Value) -> Option<String> {
    let lines: Vec<_> = body.as_str()?.split('\n').collect();
    let from = lines.iter().rposition(|s| s.trim_start_matches(whitespace).strip_prefix("/frugal")
        .is_some_and(|rest| !rest.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_')))?;
    let taken = &lines[from..];
    let taken = &taken[..taken.iter().position(|s| starts(s, "```")).unwrap_or(taken.len())];
    if !taken.iter().any(|s| starts(s, "Goal:")) || !taken.iter().any(|s| starts(s, "Next step:")) { return None; }
    Some(trim(&taken.iter().filter(|s| !starts(s, "Usage:")).map(|s| s.trim_end_matches(whitespace)).collect::<Vec<_>>().join("\n")).to_owned())
}

#[derive(Debug, PartialEq)]
struct PickOrigin { parent: Option<String>, candidates: Vec<String> }

fn pick_origin(id: &str, hash: &Value, goal: &Value, at: &str, emissions: &[Value]) -> PickOrigin {
    let earlier: Vec<_> = emissions.iter().filter(|r| r["session_id"] != id && r["at"].as_str().is_some_and(|t| t < at)).collect();
    let exact: Vec<_> = earlier.iter().copied().filter(|r| &r["hash"] == hash).collect();
    let pool = if exact.is_empty() { earlier.into_iter().filter(|r| &r["goal"] == goal).collect() } else { exact };
    let latest = pool.iter().filter_map(|r| r["at"].as_str()).max();
    let mut top = Vec::new();
    for row in pool.iter().filter(|r| r["at"].as_str() == latest) {
        let id = row["session_id"].as_str().unwrap().to_owned();
        if !top.contains(&id) { top.push(id); }
    }
    if top.len() == 1 { PickOrigin { parent: top.pop(), candidates: vec![] } }
    else { PickOrigin { parent: None, candidates: top } }
}

fn context_tokens(usage: &Value) -> Value {
    let sum = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].iter()
        .filter_map(|k| usage[k].as_f64()).filter(|n| n.is_finite()).fold(0.0, |sum, n| sum + n);
    if sum.fract() == 0.0 && sum >= i64::MIN as f64 && sum < i64::MAX as f64 { json!(sum as i64) } else { json!(sum) }
}

fn sha1_hex(data: &[u8]) -> String {
    let mut h = [0x67452301u32, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 { msg.push(0); }
    msg.extend_from_slice(&(data.len() as u64 * 8).to_be_bytes());
    for chunk in msg.as_chunks::<64>().0 {
        let mut w = [0u32; 80];
        for (word, bytes) in w.iter_mut().zip(chunk.as_chunks::<4>().0) {
            *word = u32::from_be_bytes(*bytes);
        }
        for i in 16..80 { w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1); }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, word) in w.iter().enumerate() {
            let (f, k) = match i {
                0..20 => ((b & c) | ((!b) & d), 0x5a827999),
                20..40 => (b ^ c ^ d, 0x6ed9eba1),
                40..60 => ((b & c) | (b & d) | (c & d), 0x8f1bbcdc),
                _ => (b ^ c ^ d, 0xca62c1d6),
            };
            let next = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*word);
            (a, b, c, d, e) = (next, a, b.rotate_left(30), c, d);
        }
        for (value, add) in h.iter_mut().zip([a, b, c, d, e]) { *value = value.wrapping_add(add); }
    }
    h.iter().map(|n| format!("{n:08x}")).collect()
}

fn all(db: &Connection, sql: &str, params: impl rusqlite::Params) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = db.prepare(sql)?;
    let rows = stmt.query_map(params, |row| {
        let mut object = serde_json::Map::new();
        for (i, name) in row.as_ref().column_names().enumerate() {
            let value = match row.get_ref(i)? {
                rusqlite::types::ValueRef::Null => Value::Null,
                rusqlite::types::ValueRef::Integer(n) => json!(n),
                rusqlite::types::ValueRef::Real(n) => json!(n),
                _ => json!(row.get::<_, String>(i)?),
            };
            object.insert(name.to_owned(), value);
        }
        Ok(Value::Object(object))
    })?;
    rows.collect()
}

pub fn open_index(file: &str) -> Result<Connection> {
    if let Some(parent) = Path::new(file).parent().filter(|p| !p.as_os_str().is_empty()) { fs::create_dir_all(parent)?; }
    let db = Connection::open(file)?;
    // Another instance may hold deck.db: rusqlite already waits 5 s for its lock; WAL lets readers run beside a writer.
    db.query_row("PRAGMA journal_mode = WAL", [], |r| r.get::<_, String>(0))?;
    let stale = db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))? < 1;
    if stale { db.execute_batch("DROP TABLE IF EXISTS sessions")?; }
    db.execute_batch(r#"CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    file TEXT NOT NULL,
    size INTEGER NOT NULL,
    offset INTEGER NOT NULL,
    cwd TEXT,
    entrypoint TEXT,
    custom_title TEXT,
    ai_title TEXT,
    first_prompt TEXT,
    turns INTEGER NOT NULL,
    last_at TEXT,
    started_at TEXT,
    handoff_hash TEXT,
    handoff_goal TEXT
  )"#)?;
    db.execute_batch(r#"CREATE TABLE IF NOT EXISTS session_org (
    session_id TEXT PRIMARY KEY,
    pinned INTEGER NOT NULL,
    space TEXT,
    tags TEXT NOT NULL
  )"#)?;
    db.execute_batch(r#"CREATE TABLE IF NOT EXISTS session_auto (
    session_id TEXT PRIMARY KEY,
    topic TEXT,
    title TEXT
  )"#)?;
    db.execute_batch(r#"CREATE TABLE IF NOT EXISTS session_handoffs (
    session_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    goal TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (session_id, hash)
  )"#)?;
    db.execute_batch(r#"CREATE INDEX IF NOT EXISTS session_handoffs_hash ON session_handoffs (hash)"#)?;
    db.execute_batch(r#"CREATE INDEX IF NOT EXISTS session_handoffs_goal ON session_handoffs (goal)"#)?;
    db.execute_batch(r#"CREATE TABLE IF NOT EXISTS session_links (session_id TEXT PRIMARY KEY, parent_id TEXT, origin TEXT NOT NULL)"#)?;
    db.execute_batch(r#"CREATE TABLE IF NOT EXISTS session_group (session_id TEXT PRIMARY KEY, name TEXT NOT NULL)"#)?;
    db.execute_batch(r#"CREATE TABLE IF NOT EXISTS group_workspace (name TEXT PRIMARY KEY COLLATE NOCASE, workspace TEXT NOT NULL, origin TEXT NOT NULL)"#)?;
    db.execute_batch(r#"CREATE TABLE IF NOT EXISTS workspace_parent (name TEXT PRIMARY KEY COLLATE NOCASE, parent TEXT NOT NULL)"#)?;
    if stale { db.execute_batch("PRAGMA user_version = 1")?; }
    Ok(db)
}

fn read_lines(file: &str, start: u64, mut on_line: impl FnMut(&str)) -> std::io::Result<u64> {
    let mut file = fs::File::open(file)?;
    file.seek(SeekFrom::Start(start))?;
    let mut chunk = vec![0; CHUNK];
    let mut pending = Vec::new();
    let mut offset = start;
    loop {
        let n = file.read(&mut chunk)?;
        if n == 0 { break; }
        pending.extend_from_slice(&chunk[..n]);
        let mut from = 0;
        while let Some(end) = pending[from..].iter().position(|&b| b == b'\n').map(|i| i + from) {
            on_line(&String::from_utf8_lossy(&pending[from..end]));
            from = end + 1;
        }
        offset += from as u64;
        pending.drain(..from);
    }
    Ok(offset)
}

fn session_id(file: &str) -> String {
    let name = Path::new(file).file_name().unwrap_or_default().to_string_lossy();
    name.strip_suffix(".jsonl").unwrap_or(&name).to_owned()
}

fn apply_record(row: &mut Value, record: &Value, emissions: &mut Vec<Value>, handoffs: &mut Option<&mut Vec<Value>>) {
    if truthy(&record["isSidechain"]) { return; }
    let kind = record["type"].as_str().unwrap_or("");
    if kind == "custom-title" { row["custom_title"] = text(&record["customTitle"]); }
    if kind == "ai-title" { row["ai_title"] = text(&record["aiTitle"]); }
    if kind == "relocated" && record["relocatedCwd"].is_string() { row["cwd"] = record["relocatedCwd"].clone(); }
    if row["cwd"].is_null() { row["cwd"] = text(&record["cwd"]); }
    if row["entrypoint"].is_null() { row["entrypoint"] = text(&record["entrypoint"]); }
    let content = &record["message"]["content"];
    if kind == "user" && !truthy(&record["isMeta"]) && !truthy(&record["toolUseResult"]) {
        row["turns"] = json!(row["turns"].as_i64().unwrap() + 1);
        if row["first_prompt"].is_null() {
            row["first_prompt"] = json!(prompt_title(content));
            let block = handoff_block(first_text(content));
            row["handoff_hash"] = json!(block.as_ref().map(|b| &b.hash));
            row["handoff_goal"] = json!(block.as_ref().map(|b| &b.goal));
        }
    }
    if kind == "user" || kind == "assistant" {
        if record["timestamp"].is_string() { row["last_at"] = record["timestamp"].clone(); }
        if row["started_at"].is_null() { row["started_at"] = text(&record["timestamp"]); }
    }
    if kind == "assistant" {
        let blocks: Vec<_> = if content.is_string() { vec![content] } else {
            content.as_array().into_iter().flatten().filter(|b| b["type"] == "text").map(|b| &b["text"]).collect()
        };
        for body in &blocks {
            if let (Some(block), Some(at)) = (handoff_block(body), record["timestamp"].as_str()) {
                emissions.push(json!({"hash": block.hash, "goal": block.goal, "at": at}));
            }
        }
        if let Some(handoffs) = handoffs {
            if record["message"]["stop_reason"] == "end_turn" {
                handoffs.push(json!({"id": row["id"], "prompt": null}));
                for body in blocks {
                    if let Some(prompt) = next_block(body) {
                        handoffs.push(json!({"id": row["id"], "prompt": prompt, "tokens": context_tokens(&record["message"]["usage"])}));
                    }
                }
            }
        }
    }
}

pub fn sync_file(db: &Connection, file: &str, mut handoffs: Option<&mut Vec<Value>>) -> Result<bool> {
    let id = session_id(file);
    let size = fs::metadata(file)?.len();
    let mut row = all(db, "SELECT * FROM sessions WHERE id = ?", [&id])?.pop().unwrap_or(Value::Null);
    if row["size"].as_u64() == Some(size) { return Ok(false); }
    if row.is_null() || size < row["offset"].as_u64().unwrap() {
        db.execute("DELETE FROM session_handoffs WHERE session_id = ?", [&id])?;
        row = json!({"id": id, "file": file, "size": size, "offset": 0, "cwd": null, "entrypoint": null, "custom_title": null,
            "ai_title": null, "first_prompt": null, "turns": 0, "last_at": null, "started_at": null, "handoff_hash": null, "handoff_goal": null});
    }
    row["size"] = json!(size);
    let mut emissions = Vec::new();
    row["offset"] = json!(read_lines(file, row["offset"].as_u64().unwrap(), |line| {
        if let Ok(record) = serde_json::from_str::<Value>(line) {
            if record.is_object() || record.is_array() { apply_record(&mut row, &record, &mut emissions, &mut handoffs); }
        }
    })?);
    db.execute(r#"INSERT OR REPLACE INTO sessions (id, file, size, offset, cwd, entrypoint, custom_title, ai_title, first_prompt, turns, last_at, started_at, handoff_hash, handoff_goal)
    VALUES (:id, :file, :size, :offset, :cwd, :entrypoint, :custom_title, :ai_title, :first_prompt, :turns, :last_at, :started_at, :handoff_hash, :handoff_goal)"#, named_params! {
        ":id": row["id"].as_str(), ":file": row["file"].as_str(), ":size": row["size"].as_i64(), ":offset": row["offset"].as_i64(),
        ":cwd": row["cwd"].as_str(), ":entrypoint": row["entrypoint"].as_str(), ":custom_title": row["custom_title"].as_str(),
        ":ai_title": row["ai_title"].as_str(), ":first_prompt": row["first_prompt"].as_str(), ":turns": row["turns"].as_i64(),
        ":last_at": row["last_at"].as_str(), ":started_at": row["started_at"].as_str(), ":handoff_hash": row["handoff_hash"].as_str(),
        ":handoff_goal": row["handoff_goal"].as_str()
    })?;
    let mut save = db.prepare("INSERT OR IGNORE INTO session_handoffs (session_id, hash, goal, at) VALUES (?, ?, ?, ?)")?;
    for e in emissions { save.execute(params![id, e["hash"].as_str(), e["goal"].as_str(), e["at"].as_str()])?; }
    Ok(true)
}

pub fn remove_session(db: &Connection, file: &str) -> Result<()> {
    let id = session_id(file);
    db.execute("DELETE FROM session_handoffs WHERE session_id = ?", [&id])?;
    db.execute("DELETE FROM sessions WHERE id = ?", [&id])?;
    Ok(())
}

pub fn scan(db: &Connection, roots: &[String], mut on_batch: impl FnMut()) -> Result<()> {
    let mut seen = HashSet::new();
    let mut changed: usize = 0;
    let mut tx = db.unchecked_transaction()?;
    for root in roots.iter().filter(|r| Path::new(r).exists()) {
        for project in fs::read_dir(root)? {
            let project = project?;
            if !project.file_type()?.is_dir() { continue; }
            for entry in fs::read_dir(project.path())? {
                let entry = entry?;
                let file = entry.path().to_string_lossy().into_owned();
                if !entry.file_type()?.is_file() || !file.ends_with(".jsonl") || !seen.insert(session_id(&file)) { continue; }
                if !matches!(sync_file(&tx, &file, None), Ok(true)) { continue; }
                changed += 1;
                if changed.is_multiple_of(BATCH) {
                    tx.commit()?;
                    on_batch();
                    tx = db.unchecked_transaction()?;
                }
            }
        }
    }
    for row in all(&tx, "SELECT id, file FROM sessions", [])? {
        if !seen.contains(row["id"].as_str().unwrap()) { remove_session(&tx, row["file"].as_str().unwrap())?; }
    }
    tx.commit()?;
    Ok(())
}

pub struct ChatLinks {
    pub parents: HashMap<String, String>,
    pub ambiguous: Vec<(String, Vec<String>)>,
}

pub fn chat_links(db: &Connection) -> Result<ChatLinks> {
    let mut parents = HashMap::new();
    let mut ambiguous = Vec::new();
    for row in all(db, "SELECT id, handoff_hash AS hash, handoff_goal AS goal, started_at FROM sessions WHERE handoff_hash IS NOT NULL AND started_at IS NOT NULL", [])? {
        let id = row["id"].as_str().unwrap();
        let emissions = all(db, "SELECT session_id, hash, goal, at FROM session_handoffs WHERE hash = ? OR goal = ?", params![row["hash"].as_str(), row["goal"].as_str()])?;
        let origin = pick_origin(id, &row["hash"], &row["goal"], row["started_at"].as_str().unwrap(), &emissions);
        if let Some(parent) = origin.parent { parents.insert(id.to_owned(), parent); }
        else if !origin.candidates.is_empty() { ambiguous.push((id.to_owned(), origin.candidates)); }
    }
    for row in all(db, "SELECT session_id, parent_id FROM session_links", [])? {
        let id = row["session_id"].as_str().unwrap();
        ambiguous.retain(|(child, _)| child != id);
        if let Some(parent) = row["parent_id"].as_str() { parents.insert(id.to_owned(), parent.to_owned()); }
        else { parents.remove(id); }
    }
    Ok(ChatLinks { parents, ambiguous })
}

fn folder_key(path: &Path) -> String {
    let mut normalized = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                if normalized.file_name().is_some_and(|s| s != "..") { normalized.pop(); }
                else if !normalized.has_root() { normalized.push(".."); }
            }
            _ => normalized.push(part.as_os_str()),
        }
    }
    let mut key = normalized.to_string_lossy().to_lowercase();
    if !key.ends_with(std::path::MAIN_SEPARATOR) { key.push(std::path::MAIN_SEPARATOR); }
    key
}

pub fn list_index(db: &Connection) -> Result<Value> {
    let temp = folder_key(&std::env::temp_dir());
    let mut usable = HashMap::new();
    let mut sessions = Vec::new();
    for mut row in all(db, r#"SELECT id, file, cwd, COALESCE(NULLIF(custom_title, ''), NULLIF(a.title, ''), NULLIF(ai_title, ''), first_prompt, 'Untitled') AS title, last_at AS lastAt, started_at AS startedAt, turns, COALESCE(pinned, 0) AS pinned, space, COALESCE(tags, '[]') AS tags,
      CASE WHEN g.name = '' THEN NULL ELSE COALESCE(g.name, a.topic) END AS topic, NULLIF(g.name, '') AS userGroup, COALESCE(g.name = '', 0) AS noGroup, a.title AS autoTitle, NULLIF(custom_title, '') AS customTitle, NULLIF(ai_title, '') AS aiTitle, first_prompt AS firstPrompt
    FROM sessions LEFT JOIN session_org o ON o.session_id = id LEFT JOIN session_auto a ON a.session_id = id LEFT JOIN session_group g ON g.session_id = id
    WHERE turns > 0 AND cwd IS NOT NULL AND last_at IS NOT NULL AND COALESCE(entrypoint, '') <> 'sdk-cli'
    ORDER BY last_at DESC"#, [])? {
        let cwd = row["cwd"].as_str().unwrap();
        if !*usable.entry(cwd.to_owned()).or_insert_with(|| !folder_key(Path::new(cwd)).starts_with(&temp) && Path::new(cwd).exists()) { continue; }
        row["pinned"] = json!(row["pinned"] == 1);
        row["noGroup"] = json!(row["noGroup"] == 1);
        row["tags"] = serde_json::from_str(row["tags"].as_str().unwrap())?;
        sessions.push(row);
    }
    let listed: HashMap<_, _> = sessions.iter().map(|s| (s["id"].as_str().unwrap().to_owned(),
        json!({"id": s["id"], "title": s["title"], "cwd": s["cwd"], "lastAt": s["lastAt"]}))).collect();
    let ChatLinks { mut parents, ambiguous } = chat_links(db)?;
    let mut unresolved = Vec::new();
    for (id, candidates) in ambiguous {
        let Some(info) = listed.get(&id) else { continue };
        let kept: Vec<_> = candidates.into_iter().filter(|id| listed.contains_key(id)).collect();
        if kept.len() == 1 { parents.insert(id, kept[0].clone()); }
        else if !kept.is_empty() {
            let mut entry = info.clone();
            entry["candidates"] = json!(kept.iter().map(|id| &listed[id]).collect::<Vec<_>>());
            unresolved.push(entry);
        }
    }
    for session in &mut sessions {
        let id = session["id"].as_str().unwrap().to_owned();
        session["parentId"] = json!(parents.get(&id).filter(|p| listed.contains_key(*p)));
        let mut seen = HashSet::from([id.clone()]);
        let mut at = id;
        while let Some(next) = parents.get(&at).filter(|p| listed.contains_key(*p) && seen.insert((*p).clone())) { at = next.clone(); }
        session["chatId"] = json!(at);
    }
    let workspaces: serde_json::Map<_, _> = all(db, "SELECT name, workspace FROM group_workspace", [])?.into_iter()
        .map(|r| (r["name"].as_str().unwrap().to_owned(), r["workspace"].clone())).collect();
    let workspace_parents: serde_json::Map<_, _> = all(db, "SELECT name, parent FROM workspace_parent", [])?.into_iter()
        .map(|r| (r["name"].as_str().unwrap().to_owned(), r["parent"].clone())).collect();
    let model_workspaces: i64 = db.query_row("SELECT COUNT(*) AS n FROM group_workspace WHERE origin = 'model'", [], |r| r.get(0))?;
    let model_joins: i64 = db.query_row("SELECT COUNT(*) AS n FROM session_links WHERE origin = 'model'", [], |r| r.get(0))?;
    Ok(json!({"workspaces": workspaces, "workspaceParents": workspace_parents, "modelWorkspaces": model_workspaces,
        "sessions": sessions, "ambiguous": unresolved, "modelJoins": model_joins}))
}

pub fn list_sessions(db: &Connection) -> Result<Vec<Value>> {
    Ok(list_index(db)?["sessions"].as_array().unwrap().clone())
}

fn clean_organization(input: &Value) -> Option<Value> {
    let pinned = input["pinned"].as_bool()?;
    let space = trim(input["space"].as_str()?);
    let mut tags: Vec<String> = Vec::new();
    for tag in input["tags"].as_array()? {
        let tag = trim(tag.as_str()?).trim_start_matches('#');
        if tag.is_empty() { continue; }
        if let Some(old) = tags.iter_mut().find(|old| old.to_lowercase() == tag.to_lowercase()) { *old = tag.to_owned(); }
        else { tags.push(tag.to_owned()); }
    }
    Some(json!({"pinned": pinned, "space": if space.is_empty() { None } else { Some(space) }, "tags": tags}))
}

pub fn save_organization(db: &Connection, id: &str, input: &Value) -> Result<bool> {
    let Some(clean) = clean_organization(input) else { return Ok(false) };
    if db.query_row("SELECT 1 FROM sessions WHERE id = ?", [id], |_| Ok(())).optional()?.is_none() { return Ok(false); }
    let known: Option<String> = db.query_row("SELECT space FROM session_org WHERE space = ? COLLATE NOCASE LIMIT 1",
        [clean["space"].as_str()], |r| r.get(0)).optional()?;
    db.execute("INSERT OR REPLACE INTO session_org (session_id, pinned, space, tags) VALUES (?, ?, ?, ?)",
        params![id, clean["pinned"].as_bool(), known.as_deref().or(clean["space"].as_str()), clean["tags"].to_string()])?;
    Ok(true)
}

pub fn save_automatic(db: &Connection, rows: &Value) -> Result<()> {
    let tx = db.unchecked_transaction()?;
    {
        let mut save = tx.prepare(r#"INSERT INTO session_auto (session_id, topic, title) VALUES (?, ?, ?)
    ON CONFLICT (session_id) DO UPDATE SET topic = excluded.topic, title = COALESCE(excluded.title, title)"#)?;
        for row in rows.as_array().ok_or("automatic rows must be an array")? {
            let values = ["id", "topic", "title"].map(|key| match row.get(key) {
                Some(Value::Null) => Ok(rusqlite::types::Value::Null),
                Some(Value::String(s)) => Ok(rusqlite::types::Value::Text(s.clone())),
                Some(Value::Number(n)) => Ok(rusqlite::types::Value::Real(n.as_f64().unwrap())),
                _ => Err("unsupported SQLite parameter"),
            }).into_iter().collect::<std::result::Result<Vec<_>, _>>()?;
            save.execute(rusqlite::params_from_iter(values))?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn clear_auto_titles(db: &Connection) -> Result<()> {
    db.execute_batch("UPDATE session_auto SET title = NULL")?;
    Ok(())
}

pub struct LastLink { id: String, previous: Option<Value> }

fn reaches(db: &Connection, id: &str, from: Option<&str>) -> Result<bool> {
    let links = chat_links(db)?;
    let mut seen = HashSet::new();
    let mut at = from;
    while let Some(current) = at {
        if current == id { return Ok(true); }
        if !seen.insert(current) { break; }
        at = links.parents.get(current).map(String::as_str);
    }
    Ok(false)
}

pub fn save_link(db: &Connection, id: &str, parent: Option<&str>, origin: &str, last_link: &mut Option<LastLink>) -> Result<bool> {
    if let Some(parent) = parent {
        if parent == id || db.query_row("SELECT 1 FROM sessions WHERE id = ?", [parent], |_| Ok(())).optional()?.is_none() { return Ok(false); }
    }
    if db.query_row("SELECT 1 FROM sessions WHERE id = ?", [id], |_| Ok(())).optional()?.is_none() || reaches(db, id, parent)? { return Ok(false); }
    let previous = all(db, "SELECT parent_id, origin FROM session_links WHERE session_id = ?", [id])?.pop();
    db.execute("INSERT OR REPLACE INTO session_links (session_id, parent_id, origin) VALUES (?, ?, ?)", params![id, parent, origin])?;
    if origin == "user" { *last_link = Some(LastLink { id: id.to_owned(), previous }); }
    Ok(true)
}

pub fn undo_last_link(db: &Connection, last_link: &mut Option<LastLink>) -> Result<bool> {
    let Some(last) = last_link.as_ref() else { return Ok(false) };
    if let Some(previous) = &last.previous {
        db.execute("INSERT OR REPLACE INTO session_links (session_id, parent_id, origin) VALUES (?, ?, ?)",
            params![last.id, previous["parent_id"].as_str(), previous["origin"].as_str()])?;
    } else { db.execute("DELETE FROM session_links WHERE session_id = ?", [&last.id])?; }
    *last_link = None;
    Ok(true)
}

pub fn clear_model_links(db: &Connection) -> Result<()> {
    db.execute("DELETE FROM session_links WHERE origin = 'model'", [])?;
    Ok(())
}

fn is_uuid(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == b'-' } else { c.is_ascii_hexdigit() })
}

pub fn save_group(db: &Connection, id: &str, name: Option<&str>) -> Result<bool> {
    let clean = trim(name.unwrap_or(""));
    if !is_uuid(id) || clean.encode_utf16().count() > 40 { return Ok(false); }
    db.execute("INSERT OR REPLACE INTO session_group (session_id, name) VALUES (?, ?)", params![id, clean])?;
    Ok(true)
}

fn valid_ids(ids: &Value) -> bool {
    ids.as_array().is_some_and(|a| !a.is_empty() && a.iter().all(|id| id.as_str().is_some_and(is_uuid)))
}

pub fn rename_workspace(db: &Connection, from: &str, to: &str) -> Result<bool> {
    let (from, to) = (trim(from), trim(to));
    if from.is_empty() || to.is_empty() || from.encode_utf16().count() > 40 || to.encode_utf16().count() > 40 { return Ok(false); }
    let tx = db.unchecked_transaction()?;
    tx.execute("UPDATE group_workspace SET workspace = ?, origin = 'user' WHERE workspace = ? COLLATE NOCASE", params![to, from])?;
    tx.execute("UPDATE session_org SET space = ? WHERE space = ? COLLATE NOCASE", params![to, from])?;
    tx.execute("UPDATE OR REPLACE workspace_parent SET name = ? WHERE name = ? COLLATE NOCASE", params![to, from])?;
    tx.execute("UPDATE workspace_parent SET parent = ? WHERE parent = ? COLLATE NOCASE", params![to, from])?;
    tx.execute("DELETE FROM workspace_parent WHERE name = parent COLLATE NOCASE", [])?;
    tx.commit()?;
    Ok(true)
}

pub fn delete_workspace(db: &Connection, name: &str) -> Result<bool> {
    let name = trim(name);
    if name.is_empty() || name.encode_utf16().count() > 40 { return Ok(false); }
    let tx = db.unchecked_transaction()?;
    let up: Option<String> = tx.query_row("SELECT parent FROM workspace_parent WHERE name = ?", [name], |r| r.get(0)).optional()?;
    if let Some(up) = up.filter(|s| !s.is_empty()) {
        tx.execute("UPDATE workspace_parent SET parent = ? WHERE parent = ? COLLATE NOCASE", params![up, name])?;
    } else { tx.execute("DELETE FROM workspace_parent WHERE parent = ? COLLATE NOCASE", [name])?; }
    tx.execute("DELETE FROM workspace_parent WHERE name = ?", [name])?;
    tx.execute("DELETE FROM group_workspace WHERE workspace = ? COLLATE NOCASE", [name])?;
    tx.execute("UPDATE session_org SET space = NULL WHERE space = ? COLLATE NOCASE", [name])?;
    tx.commit()?;
    Ok(true)
}

pub fn save_workspace_parent(db: &Connection, name: &str, parent: &str) -> Result<bool> {
    let (name, parent) = (trim(name), trim(parent));
    if name.is_empty() || name.encode_utf16().count() > 40 || parent.encode_utf16().count() > 40 { return Ok(false); }
    if parent.is_empty() {
        db.execute("DELETE FROM workspace_parent WHERE name = ?", [name])?;
        return Ok(true);
    }
    let mut find = db.prepare("SELECT parent FROM workspace_parent WHERE name = ?")?;
    let mut seen = HashSet::new();
    let mut at = Some(parent.to_owned());
    while let Some(current) = at.filter(|s| !s.is_empty()) {
        if !seen.insert(current.to_lowercase()) { break; }
        if current.to_lowercase() == name.to_lowercase() { return Ok(false); }
        at = find.query_row([current], |r| r.get::<_, String>(0)).optional()?;
    }
    db.execute("INSERT OR REPLACE INTO workspace_parent (name, parent) VALUES (?, ?)", params![name, parent])?;
    Ok(true)
}

pub fn rename_group(db: &Connection, ids: &Value, from: &str, to: &str) -> Result<bool> {
    let (from, to) = (trim(from), trim(to));
    if !valid_ids(ids) || from.is_empty() || from.encode_utf16().count() > 500 || to.is_empty() || to.encode_utf16().count() > 40 { return Ok(false); }
    let tx = db.unchecked_transaction()?;
    for id in ids.as_array().unwrap() {
        tx.execute("INSERT OR REPLACE INTO session_group (session_id, name) VALUES (?, ?)", params![id.as_str(), to])?;
    }
    if tx.execute("UPDATE OR IGNORE group_workspace SET name = ? WHERE name = ?", params![to, from])? == 0 {
        tx.execute("DELETE FROM group_workspace WHERE name = ?", [from])?;
    }
    tx.commit()?;
    Ok(true)
}

pub fn delete_group(db: &Connection, ids: &Value, group: &str) -> Result<bool> {
    let group = trim(group);
    if !valid_ids(ids) || group.is_empty() || group.encode_utf16().count() > 500 { return Ok(false); }
    let tx = db.unchecked_transaction()?;
    let workspace: Option<String> = tx.query_row("SELECT workspace FROM group_workspace WHERE name = ?", [group], |r| r.get(0)).optional()?;
    for id in ids.as_array().unwrap() {
        tx.execute("INSERT OR REPLACE INTO session_group (session_id, name) VALUES (?, '')", [id.as_str()])?;
    }
    if let Some(workspace) = workspace.filter(|s| !s.is_empty()) {
        let mut place = tx.prepare(r#"INSERT INTO session_org (session_id, pinned, space, tags) VALUES (?, 0, ?, '[]')
    ON CONFLICT(session_id) DO UPDATE SET space = excluded.space WHERE session_org.space IS NULL OR session_org.space = ''"#)?;
        for id in ids.as_array().unwrap() { place.execute(params![id.as_str(), workspace])?; }
    }
    tx.execute("DELETE FROM group_workspace WHERE name = ?", [group])?;
    tx.commit()?;
    Ok(true)
}

pub fn save_workspace(db: &Connection, group: Option<&str>, workspace: Option<&str>) -> Result<bool> {
    let (Some(group), Some(workspace)) = (group, workspace) else { return Ok(false) };
    let (group, workspace) = (trim(group), trim(workspace));
    if group.is_empty() || group.encode_utf16().count() > 500 || workspace.encode_utf16().count() > 40 { return Ok(false); }
    if workspace.is_empty() { db.execute("DELETE FROM group_workspace WHERE name = ?", [group])?; }
    else { db.execute("INSERT OR REPLACE INTO group_workspace (name, workspace, origin) VALUES (?, ?, 'user')", params![group, workspace])?; }
    Ok(true)
}

pub fn save_model_workspaces(db: &Connection, rows: &Value) -> Result<()> {
    let tx = db.unchecked_transaction()?;
    {
        let mut save = tx.prepare(r#"INSERT INTO group_workspace (name, workspace, origin) VALUES (?, ?, 'model')
    ON CONFLICT(name) DO UPDATE SET workspace = excluded.workspace WHERE origin = 'model'"#)?;
        for row in rows.as_array().ok_or("workspace rows must be an array")? {
            let (Some(group), Some(workspace)) = (row["group"].as_str(), row["workspace"].as_str()) else { continue };
            let (group, workspace) = (trim(group), trim(workspace));
            if group.is_empty() || group.encode_utf16().count() > 500 || workspace.is_empty() || workspace.encode_utf16().count() > 40 { continue; }
            save.execute(params![group, workspace])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn clear_model_workspaces(db: &Connection) -> Result<()> {
    db.execute("DELETE FROM group_workspace WHERE origin = 'model'", [])?;
    Ok(())
}

// The indexer thread, as Electron's worker: scan, then the sidebar's edits and the watcher's changes in arrival order, each followed by a publish.
type Job = Box<dyn FnOnce(&Connection, &mut Option<LastLink>) -> Result<bool> + Send>;

enum Msg {
    Job(Job),
    Changed(PathBuf),
}

// frugal: the sidebar shows the newest sessions plus every organized one and every open chat, and never cuts a chat in half; the palette and resume use all of them.
const SIDEBAR_LIMIT: usize = 500;
// Past the newest 500, each topic and folder still keeps its newest few, so a busy project never hides a quieter one.
const PER_GROUP: usize = 20;
const DEBOUNCE: Duration = Duration::from_secs(1);

pub struct Index {
    state: Mutex<Value>,
    jobs: OnceLock<mpsc::Sender<Msg>>,
}

impl Default for Index {
    fn default() -> Self {
        let state = json!({ "indexing": true, "sessions": [], "error": null, "ambiguous": [], "modelJoins": 0, "workspaces": {}, "workspaceParents": {}, "modelWorkspaces": 0 });
        Index { state: Mutex::new(state), jobs: OnceLock::new() }
    }
}

impl Index {
    fn run(&self, job: impl FnOnce(&Connection, &mut Option<LastLink>) -> Result<bool> + Send + 'static) {
        if let Some(jobs) = self.jobs.get() {
            let _ = jobs.send(Msg::Job(Box::new(job)));
        }
    }

    pub fn session(&self, id: &str) -> Option<Value> {
        self.state.lock().unwrap()["sessions"].as_array()?.iter().find(|s| s["id"] == id).cloned()
    }

    pub fn has_cwd(&self, cwd: &str) -> bool {
        self.state.lock().unwrap()["sessions"].as_array().is_some_and(|all| all.iter().any(|s| s["cwd"] == cwd))
    }

    pub fn set_group(&self, id: String, name: String) {
        self.run(move |db, _| save_group(db, &id, Some(&name)));
    }
}

fn sidebar(index: &Value, live: impl Fn(&str) -> bool) -> Value {
    let sessions = index["sessions"].as_array().map(Vec::as_slice).unwrap_or_default();
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut early = |key: String| {
        let n = seen.entry(key).or_default();
        *n += 1;
        *n <= PER_GROUP
    };
    let mut chats = HashSet::new();
    for (i, s) in sessions.iter().enumerate() {
        let topic = early(format!("t:{}", s["topic"].as_str().unwrap_or_default()));
        let folder = early(format!("f:{}", s["cwd"].as_str().unwrap_or_default()));
        let organized = s["pinned"] == true || s["space"].as_str().is_some_and(|space| !space.is_empty()) || s["tags"].as_array().is_some_and(|tags| !tags.is_empty());
        if topic || folder || i < SIDEBAR_LIMIT || organized || live(s["id"].as_str().unwrap_or_default()) {
            chats.insert(s["chatId"].as_str().unwrap_or_default());
        }
    }
    let mut out: serde_json::Map<_, _> = index.as_object().into_iter().flatten().filter(|(key, _)| *key != "sessions").map(|(k, v)| (k.clone(), v.clone())).collect();
    out.insert("sessions".into(), json!(sessions.iter().filter(|s| chats.contains(s["chatId"].as_str().unwrap_or_default())).collect::<Vec<_>>()));
    Value::Object(out)
}

fn sidebar_of(app: &AppHandle) -> Value {
    let chats = app.state::<Chats>();
    let index = app.state::<Index>();
    let state = index.state.lock().unwrap();
    sidebar(&state, |id| chats.is_live(id))
}

// Also sent when the open chats change, so a new chat shows in the sidebar before its first turn is indexed.
pub fn changed(app: &AppHandle) {
    let _ = app.emit("sessions:changed", [sidebar_of(app)]);
}

fn publish(app: &AppHandle, next: Value) {
    {
        let index = app.state::<Index>();
        let mut state = index.state.lock().unwrap();
        state["error"] = Value::Null;
        for (key, value) in next.as_object().into_iter().flatten() {
            state[key] = value.clone();
        }
    }
    changed(app);
}

fn listed(db: &Connection, indexing: bool) -> Result<Value> {
    let mut index = list_index(db)?;
    index["indexing"] = json!(indexing);
    Ok(index)
}

pub fn start(app: AppHandle) {
    let (jobs, inbox) = mpsc::channel();
    let _ = app.state::<Index>().jobs.set(jobs.clone());
    thread::spawn(move || {
        if let Err(error) = index_loop(&app, jobs, inbox) {
            publish(&app, json!({ "indexing": false, "error": error.to_string() }));
        }
    });
}

// frugal: only the main account's sessions until accounts are ported in phase 4, and no handoff offers until handoff.js is.
fn index_loop(app: &AppHandle, jobs: mpsc::Sender<Msg>, inbox: mpsc::Receiver<Msg>) -> Result<()> {
    let home = PathBuf::from(std::env::var_os("USERPROFILE").ok_or("No user folder.")?);
    let roots = [home.join(".claude").join("projects")];
    let db = open_index(&home.join(".frugal-deck").join("deck.db").to_string_lossy())?;
    publish(app, listed(&db, true)?);
    let names: Vec<String> = roots.iter().map(|root| root.to_string_lossy().into_owned()).collect();
    scan(&db, &names, || {
        if let Ok(index) = listed(&db, true) {
            publish(app, index);
        }
    })?;
    publish(app, listed(&db, false)?);

    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        for path in event.map(|event| event.paths).unwrap_or_default() {
            let _ = jobs.send(Msg::Changed(path));
        }
    })?;
    for root in roots.iter().filter(|root| root.exists()) {
        watcher.watch(root, RecursiveMode::Recursive)?;
    }
    // Subagent transcripts live one level deeper and are not sessions.
    let session_file = |path: &Path| path.to_string_lossy().ends_with(".jsonl") && roots.iter().any(|root| path.strip_prefix(root).is_ok_and(|rel| rel.components().count() == 2));

    let mut last_link = None;
    let mut pending = HashSet::new();
    let mut due: Option<Instant> = None;
    loop {
        let msg = match due {
            Some(at) => inbox.recv_timeout(at.saturating_duration_since(Instant::now())),
            None => inbox.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match msg {
            Ok(Msg::Job(job)) => match job(&db, &mut last_link) {
                Ok(true) => publish(app, listed(&db, false)?),
                Ok(false) => {}
                Err(error) => publish(app, json!({ "error": error.to_string() })),
            },
            Ok(Msg::Changed(path)) if session_file(&path) => {
                pending.insert(path);
                due.get_or_insert_with(|| Instant::now() + DEBOUNCE);
            }
            Ok(Msg::Changed(_)) => {}
            Err(RecvTimeoutError::Timeout) => {
                due = None;
                for path in pending.drain() {
                    let file = path.to_string_lossy();
                    if sync_file(&db, &file, None).is_err() && !path.exists() {
                        remove_session(&db, &file)?;
                    }
                }
                publish(app, listed(&db, false)?);
            }
            Err(RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
}

#[tauri::command]
pub fn sessions_get(app: AppHandle) -> Value {
    sidebar_of(&app)
}

#[tauri::command]
pub fn sessions_all(index: State<Index>) -> Value {
    index.state.lock().unwrap()["sessions"].clone()
}

#[tauri::command]
pub fn sessions_organize(index: State<Index>, id: String, organization: Value) {
    index.run(move |db, _| save_organization(db, &id, &organization));
}

#[tauri::command]
pub fn sessions_set_group(index: State<Index>, id: String, name: Option<String>) {
    index.run(move |db, _| save_group(db, &id, name.as_deref()));
}

#[tauri::command]
pub fn sessions_set_workspace(index: State<Index>, group: Option<String>, workspace: Option<String>) {
    index.run(move |db, _| save_workspace(db, group.as_deref(), workspace.as_deref()));
}

#[tauri::command]
pub fn workspaces_set_parent(index: State<Index>, name: String, parent: String) {
    index.run(move |db, _| save_workspace_parent(db, &name, &parent));
}

// frugal: Electron also renames the workspace's or group's MCP settings; that comes with accounts in phase 4.
#[tauri::command]
pub fn workspaces_rename(index: State<Index>, from: String, to: String) {
    index.run(move |db, _| rename_workspace(db, &from, &to));
}

#[tauri::command]
pub fn workspaces_delete(index: State<Index>, name: String) {
    index.run(move |db, _| delete_workspace(db, &name));
}

#[tauri::command]
pub fn groups_rename(index: State<Index>, ids: Value, from: String, to: String) {
    index.run(move |db, _| rename_group(db, &ids, &from, &to));
}

#[tauri::command]
pub fn groups_delete(index: State<Index>, ids: Value, group: String) {
    index.run(move |db, _| delete_group(db, &ids, &group));
}

#[tauri::command]
pub fn workspaces_clear(index: State<Index>) {
    index.run(|db, _| clear_model_workspaces(db).map(|()| true));
}

#[tauri::command]
pub fn sessions_link(index: State<Index>, id: String, parent_id: Option<String>) {
    index.run(move |db, last_link| save_link(db, &id, parent_id.as_deref(), "user", last_link));
}

#[tauri::command]
pub fn sessions_undo_link(index: State<Index>) {
    index.run(|db, last_link| undo_last_link(db, last_link).map(|_| true));
}

#[tauri::command]
pub fn joins_clear(index: State<Index>) {
    index.run(|db, _| clear_model_links(db).map(|()| true));
}

#[tauri::command]
pub fn topics_restore_titles(index: State<Index>) {
    index.run(|db, _| clear_auto_titles(db).map(|()| true));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            loop {
                let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
                let path = std::env::temp_dir().join(format!("deck-index-{}-{stamp}", std::process::id()));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(e) => panic!("{e}"),
                }
            }
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let resolved = self.0.canonicalize().unwrap();
            assert_eq!(resolved.parent().unwrap(), std::env::temp_dir().canonicalize().unwrap());
            fs::remove_dir_all(resolved).unwrap();
        }
    }

    struct Fixture { db: Connection, dir: TempDir, cwd: String }
    fn id(n: impl std::fmt::Display) -> String { format!("00000000-0000-4000-8000-00000000000{n}") }
    fn line(record: Value) -> String { format!("{record}\n") }

    impl Fixture {
        fn new() -> Self {
            let dir = TempDir::new();
            fs::create_dir_all(dir.0.join("projects/p")).unwrap();
            let db = open_index(dir.0.join("nested/deck.db").to_str().unwrap()).unwrap();
            let cwd = std::env::home_dir().unwrap().to_string_lossy().into_owned();
            Self { db, dir, cwd }
        }
        fn file(&self, n: impl std::fmt::Display) -> String {
            self.dir.0.join("projects/p").join(format!("{}.jsonl", id(n))).to_string_lossy().into_owned()
        }
        fn user(&self, content: &str, timestamp: &str) -> String { self.user_extra(content, timestamp, json!({})) }
        fn user_extra(&self, content: &str, timestamp: &str, extra: Value) -> String {
            let mut record = json!({"type": "user", "cwd": self.cwd, "entrypoint": "cli", "timestamp": timestamp, "message": {"content": content}});
            record.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            line(record)
        }
        fn write(&self, n: impl std::fmt::Display, body: &str) { fs::write(self.file(n), body).unwrap(); }
        fn append(&self, n: impl std::fmt::Display, body: &str) {
            fs::OpenOptions::new().append(true).open(self.file(n)).unwrap().write_all(body.as_bytes()).unwrap();
        }
        fn sync(&self, n: impl std::fmt::Display) -> bool { sync_file(&self.db, &self.file(n), None).unwrap() }
        fn row(&self, n: impl std::fmt::Display) -> Value {
            all(&self.db, "SELECT * FROM sessions WHERE id = ?", [id(n)]).unwrap().pop().unwrap_or(Value::Null)
        }
        fn index(&self) -> Value { list_index(&self.db).unwrap() }
        fn session(&self, n: impl std::fmt::Display) -> Value {
            list_sessions(&self.db).unwrap().into_iter().find(|s| s["id"] == id(&n)).unwrap()
        }
        fn listed(&self) -> Vec<Value> { list_sessions(&self.db).unwrap().iter().map(|s| s["id"].clone()).collect() }
        fn scan(&self) {
            scan(&self.db, &[self.dir.0.join("projects").to_string_lossy().into_owned()], || {}).unwrap();
        }
        fn partial(&self) {
            save_group(&self.db, &id(1), Some(" Manual ")).unwrap();
            self.write(1, &(self.user("first nai\u{308}ve prompt", "2026-01-01T00:00:00Z") + "{\"type\":\"user\",\"cwd\""));
            self.sync(1);
        }
        fn finish_line(&self) {
            self.append(1, &(":\"x\"}\nnot json\nnull\n".to_owned() + &line(json!({"type": "something-new", "sessionId": id(1)}))
                + &self.user("second", "2026-01-02T00:00:00Z")));
            self.sync(1);
        }
        fn complete(&self) { self.partial(); self.finish_line(); }
        fn short(&self) {
            self.complete();
            self.write(1, &self.user("short", "2026-02-01T00:00:00Z"));
            self.sync(1);
        }
        fn filtered(&self) {
            self.short();
            self.write(2, &(self.user_extra("x", "2026-03-01T00:00:00Z", json!({"toolUseResult": {}}))
                + &self.user_extra("y", "2026-03-01T00:00:00Z", json!({"isMeta": true}))
                + &self.user_extra("z", "2026-03-01T00:00:00Z", json!({"isSidechain": true}))));
            self.write(3, &self.user_extra("sdk", "2026-03-02T00:00:00Z", json!({"entrypoint": "sdk-cli"})));
            self.write(4, &self.user_extra("gone", "2026-03-03T00:00:00Z", json!({"cwd": self.dir.0.join("missing")})));
            self.write(5, &self.user_extra("temp", "2026-03-04T00:00:00Z", json!({"cwd": self.dir.0})));
            self.write(6, &(self.user("recent", "2026-03-05T00:00:00Z") + &line(json!({"type": "relocated", "relocatedCwd": Path::new(&self.cwd).parent().unwrap()}))));
            self.scan();
        }
        fn seed_handoff(&self) {
            self.write(9, &(self.user("seed", "2026-03-31T00:00:00Z") + &line(json!({"type": "assistant", "timestamp": "2026-04-01T00:00:00Z",
                "message": {"content": [{"type": "text", "text": format!("Picking up:\n{HAND}")}]}}))));
            self.sync(9);
        }
        fn continuations(&self) {
            self.write(10, &(self.user(HAND, "2026-04-02T00:00:00Z") + &self.user("go on 10", "2026-04-03T00:00:00.000Z")));
            self.write(11, &(self.user(HAND, "2026-04-04T00:00:00Z") + &self.user("go on 11", "2026-04-05T00:00:00.000Z")));
            self.sync(10);
            self.sync(11);
        }
        fn joined(&self) { self.seed_handoff(); self.continuations(); }
    }

    const HAND: &str = "Goal: Fix the deck\nDone: built\nPending: reviewed";

    #[test]
    fn read_beside_other_instance_lock() {
        let dir = TempDir::new();
        let file = dir.0.join("deck.db");
        let (db, other) = (open_index(file.to_str().unwrap()).unwrap(), open_index(file.to_str().unwrap()).unwrap());
        other.execute_batch("BEGIN EXCLUSIVE").unwrap();
        assert_eq!(db.query_row("SELECT count(*) FROM sessions", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        other.execute_batch("ROLLBACK").unwrap();
    }

    // indexer.check.js:23-30: 4 assertions ported, 2 typed-input skips.
    #[test]
    fn group_before_transcript() {
        let f = Fixture::new();
        assert!(save_group(&f.db, &id(1), Some(" Manual ")).unwrap());
        assert_eq!(f.row(1), Value::Null);
        assert!(!save_group(&f.db, "not-a-uuid", Some("Deck")).unwrap());
        // Skipped indexer.check.js:27: numeric ID 1 cannot be passed to &str.
        // Skipped indexer.check.js:28: numeric name 1 cannot be passed to Option<&str>.
        assert!(!save_group(&f.db, &id(1), Some(&"x".repeat(41))).unwrap());
    }

    // indexer.check.js:31-38: 4 assertions ported.
    #[test]
    fn half_written_multibyte_prompt() {
        let f = Fixture::new();
        save_group(&f.db, &id(1), Some(" Manual ")).unwrap();
        f.write(1, &(f.user("first nai\u{308}ve prompt", "2026-01-01T00:00:00Z") + "{\"type\":\"user\",\"cwd\""));
        assert!(f.sync(1));
        assert_eq!(f.row(1)["turns"], 1);
        assert_eq!(f.row(1)["first_prompt"], "first nai\u{308}ve prompt");
        assert!(f.row(1)["offset"].as_u64().unwrap() < f.row(1)["size"].as_u64().unwrap());
    }

    // indexer.check.js:39-57: 13 assertions ported.
    #[test]
    fn completed_line_unknown_records_and_group_overrides() {
        let f = Fixture::new();
        f.partial();
        f.finish_line();
        assert_eq!(f.row(1)["turns"], 3);
        assert_eq!(f.row(1)["first_prompt"], "first nai\u{308}ve prompt");
        assert_eq!(f.row(1)["last_at"], "2026-01-02T00:00:00Z");
        assert_eq!(f.session(1)["userGroup"], "Manual");
        save_automatic(&f.db, &json!([{"id": id(1), "topic": "Automatic", "title": null}])).unwrap();
        assert_eq!(f.session(1)["topic"], "Manual");
        assert!(save_group(&f.db, &id(1), None).unwrap());
        assert_eq!(f.session(1)["userGroup"], Value::Null);
        assert_eq!(f.session(1)["topic"], Value::Null);
        assert_eq!(f.session(1)["noGroup"], true);
        assert!(save_group(&f.db, &id(1), Some("Manual")).unwrap());
        assert!(save_group(&f.db, &id(1), Some("  ")).unwrap());
        assert_eq!(f.session(1)["topic"], Value::Null);
        assert_eq!(f.session(1)["noGroup"], true);
    }

    // indexer.check.js:58-60: 1 assertions ported.
    #[test]
    fn same_size_skipped() {
        let f = Fixture::new();
        f.complete();
        assert!(!f.sync(1));
    }

    // indexer.check.js:61-65: 1 assertions ported.
    #[test]
    fn resume_records_do_not_bump_date() {
        let f = Fixture::new();
        f.complete();
        f.append(1, &(line(json!({"type": "mode", "mode": "x"})) + &line(json!({"type": "last-prompt", "timestamp": "2026-09-09T00:00:00Z"}))));
        f.sync(1);
        assert_eq!(f.row(1)["last_at"], "2026-01-02T00:00:00Z");
    }

    // indexer.check.js:66-73: 2 assertions ported.
    #[test]
    fn custom_title_beats_ai_and_last_custom_wins() {
        let f = Fixture::new();
        f.complete();
        f.append(1, &line(json!({"type": "ai-title", "aiTitle": "ai"})));
        f.sync(1);
        assert_eq!(f.session(1)["title"], "ai");
        f.append(1, &(line(json!({"type": "custom-title", "customTitle": "one"})) + &line(json!({"type": "custom-title", "customTitle": "two"}))));
        f.sync(1);
        assert_eq!(f.session(1)["title"], "two");
    }

    // indexer.check.js:74-80: 3 assertions ported.
    #[test]
    fn shrinking_file_restarts_index() {
        let f = Fixture::new();
        f.complete();
        f.append(1, &(line(json!({"type": "ai-title", "aiTitle": "ai"})) + &line(json!({"type": "custom-title", "customTitle": "one"}))
            + &line(json!({"type": "custom-title", "customTitle": "two"}))));
        f.sync(1);
        f.write(1, &f.user("short", "2026-02-01T00:00:00Z"));
        f.sync(1);
        assert_eq!(f.row(1)["turns"], 1);
        assert_eq!(f.row(1)["first_prompt"], "short");
        assert_eq!(f.row(1)["custom_title"], Value::Null);
    }

    // indexer.check.js:81-91: 3 assertions ported.
    #[test]
    fn listing_filters_turns_origins_and_folders() {
        let f = Fixture::new();
        f.filtered();
        assert_eq!(f.row(2)["turns"], 0);
        assert_eq!(f.listed(), vec![json!(id(6)), json!(id(1))]);
        assert_eq!(f.session(6)["cwd"], json!(Path::new(&f.cwd).parent().unwrap()));
    }

    // indexer.check.js:92-104: 8 assertions ported.
    #[test]
    fn scan_drops_missing_transcripts_and_prompt_titles() {
        let f = Fixture::new();
        f.filtered();
        assert!(save_group(&f.db, &id(6), Some("Kept")).unwrap());
        fs::remove_file(f.file(6)).unwrap();
        f.scan();
        assert_eq!(f.row(6), Value::Null);
        assert_eq!(all(&f.db, "SELECT name FROM session_group WHERE session_id = ?", [id(6)]).unwrap()[0]["name"], "Kept");
        assert_eq!(f.listed(), vec![json!(id(1))]);
        assert_eq!(prompt_title(&json!("<command-message>a</command-message>\n<command-name>/frugal</command-name>\n<command-args>code\nGoal: Move to the org\nDone:</command-args>")).as_deref(), Some("Move to the org"));
        assert_eq!(prompt_title(&json!("<command-name>/usage</command-name><command-args></command-args>")).as_deref(), Some("/usage"));
        assert_eq!(prompt_title(&json!([{"type": "image"}, {"type": "text", "text": "hello  world"}])).as_deref(), Some("hello world"));
        assert_eq!(prompt_title(&json!([{"type": "image"}])), None);
    }

    // indexer.check.js:105-131: 17 assertions ported, 1 typed-input skips.
    #[test]
    fn organization_validation_defaults_and_persistence() {
        let f = Fixture::new();
        f.filtered();
        assert!(!save_organization(&f.db, "nope", &json!({"pinned": false, "space": "", "tags": []})).unwrap());
        // Skipped indexer.check.js:107: numeric ID 123 cannot be passed to &str.
        assert!(!save_organization(&f.db, &id(1), &json!({"pinned": "x", "space": "", "tags": []})).unwrap());
        assert!(!save_organization(&f.db, &id(1), &json!({"pinned": true, "space": "", "tags": "a"})).unwrap());
        assert!(save_organization(&f.db, &id(1), &json!({"pinned": true, "space": " Work ", "tags": [" a ", "#a", "A", "b", ""]})).unwrap());
        let s = f.session(1);
        assert_eq!(s["pinned"], true);
        assert_eq!(s["space"], "Work");
        assert_eq!(s["tags"].as_array().unwrap().len(), 2);
        assert_eq!(s["tags"].as_array().unwrap().iter().filter(|t| t.as_str().unwrap().to_lowercase() == "a").count(), 1);
        assert!(s["tags"].as_array().unwrap().contains(&json!("b")));
        f.write(7, &f.user("no org", "2026-03-06T00:00:00Z"));
        f.sync(7);
        let unorg = f.session(7);
        assert_eq!(unorg["pinned"], false);
        assert_eq!(unorg["space"], Value::Null);
        assert_eq!(unorg["tags"], json!([]));
        assert!(save_organization(&f.db, &id(3), &json!({"pinned": false, "space": "work", "tags": []})).unwrap());
        assert_eq!(all(&f.db, "SELECT space FROM session_org WHERE session_id = ?", [id(3)]).unwrap()[0]["space"], "Work");
        f.append(1, &f.user("third", "2026-02-02T00:00:00Z"));
        f.sync(1);
        let s = f.session(1);
        assert_eq!(s["pinned"], true);
        assert_eq!(s["space"], "Work");
        assert_eq!(s["tags"].as_array().unwrap().len(), 2);
    }

    // indexer.check.js:132-152: 10 assertions ported.
    #[test]
    fn organizer_titles_preserve_topic_and_user_priority() {
        let f = Fixture::new();
        f.write(8, &f.user("original", "2026-03-07T00:00:00Z"));
        f.sync(8);
        assert_eq!(f.session(8)["topic"], Value::Null);
        save_automatic(&f.db, &json!([{"id": id(8), "topic": "Deck", "title": "Better title"}])).unwrap();
        assert_eq!(f.session(8)["topic"], "Deck");
        assert_eq!(f.session(8)["title"], "Better title");
        save_automatic(&f.db, &json!([{"id": id(8), "topic": "Other", "title": null}])).unwrap();
        assert_eq!(f.session(8)["topic"], "Other");
        assert_eq!(f.session(8)["title"], "Better title");
        clear_auto_titles(&f.db).unwrap();
        assert_eq!(f.session(8)["title"], "original");
        assert_eq!(f.session(8)["autoTitle"], Value::Null);
        assert_eq!(f.session(8)["topic"], "Other");
        save_automatic(&f.db, &json!([{"id": id(8), "topic": "Other", "title": "Better title"}])).unwrap();
        f.append(8, &line(json!({"type": "custom-title", "customTitle": "mine"})));
        f.sync(8);
        assert_eq!(f.session(8)["title"], "mine");
        assert_eq!(f.session(8)["topic"], "Other");
    }

    // indexer.check.js:153-180: 15 assertions ported.
    #[test]
    fn handoff_joins_share_chat_root() {
        let f = Fixture::new();
        f.seed_handoff();
        assert_eq!(f.row(9)["handoff_hash"], Value::Null);
        assert_eq!(f.row(9)["started_at"], "2026-03-31T00:00:00Z");
        assert_eq!(all(&f.db, "SELECT session_id, goal, at FROM session_handoffs", []).unwrap(),
            vec![json!({"session_id": id(9), "goal": "Fix the deck", "at": "2026-04-01T00:00:00Z"})]);
        f.continuations();
        assert_eq!(f.row(10)["handoff_hash"], f.row(11)["handoff_hash"]);
        assert_eq!(all(&f.db, "SELECT hash FROM session_handoffs", []).unwrap()[0]["hash"], f.row(10)["handoff_hash"]);
        assert_eq!(f.row(10)["started_at"], "2026-04-02T00:00:00Z");
        let links = chat_links(&f.db).unwrap();
        assert_eq!(links.parents.get(&id(10)), Some(&id(9)));
        assert_eq!(links.parents.get(&id(11)), Some(&id(9)));
        assert_eq!(links.ambiguous, vec![]);
        assert_eq!(f.session(10)["parentId"], id(9));
        assert_eq!(f.session(10)["chatId"], id(9));
        assert_eq!(f.session(11)["chatId"], id(9));
        assert_eq!(f.session(9)["parentId"], Value::Null);
        assert_eq!(f.session(9)["chatId"], id(9));
        assert_eq!(f.index()["modelJoins"], 0);
    }

    // indexer.check.js:181-186: 4 assertions ported.
    #[test]
    fn user_link_overrides_and_undo_restores_auto_join() {
        let f = Fixture::new();
        f.joined();
        let mut last = None;
        assert!(save_link(&f.db, &id(11), Some(&id(10)), "user", &mut last).unwrap());
        assert_eq!(f.session(11)["parentId"], id(10));
        assert!(undo_last_link(&f.db, &mut last).unwrap());
        assert_eq!(f.session(11)["parentId"], id(9));
    }

    // indexer.check.js:187-192: 4 assertions ported.
    #[test]
    fn null_parent_separates_and_undo_restores_auto_join() {
        let f = Fixture::new();
        f.joined();
        let mut last = None;
        assert!(save_link(&f.db, &id(11), None, "user", &mut last).unwrap());
        assert_eq!(f.session(11)["parentId"], Value::Null);
        assert!(undo_last_link(&f.db, &mut last).unwrap());
        assert_eq!(f.session(11)["parentId"], id(9));
    }

    // indexer.check.js:193-198: 4 assertions ported.
    #[test]
    fn cycles_and_self_links_rejected() {
        let f = Fixture::new();
        f.joined();
        let mut last = None;
        assert!(!save_link(&f.db, &id(9), Some(&id(11)), "user", &mut last).unwrap());
        assert!(!save_link(&f.db, &id(9), Some(&id(9)), "user", &mut last).unwrap());
        assert_eq!(all(&f.db, "SELECT COUNT(*) AS n FROM session_links WHERE session_id = ?", [id(9)]).unwrap()[0]["n"], 0);
        assert_eq!(f.session(11)["parentId"], id(9));
    }

    // indexer.check.js:199-209: 4 assertions ported.
    #[test]
    fn links_survive_file_restart() {
        let f = Fixture::new();
        f.joined();
        let mut last = None;
        f.write(12, &f.user("late chat", "2026-04-06T00:00:00Z"));
        f.sync(12);
        assert!(save_link(&f.db, &id(12), Some(&id(11)), "user", &mut last).unwrap());
        f.write(12, &f.user("late again", "2026-04-07T00:00:00Z"));
        f.sync(12);
        let kept = all(&f.db, "SELECT parent_id, origin FROM session_links WHERE session_id = ?", [id(12)]).unwrap();
        assert_eq!(kept[0]["parent_id"], id(11));
        assert_eq!(kept[0]["origin"], "user");
        assert_eq!(f.session(12)["parentId"], id(11));
    }

    // indexer.check.js:210-337: 97 assertions ported.
    #[test]
    fn model_workspaces_user_conflicts_and_workspace_group_edits() {
        let f = Fixture::new();
        assert_eq!(f.index()["workspaces"], json!({}));
        assert_eq!(f.index()["modelWorkspaces"], 0);
        assert!(!save_workspace(&f.db, Some(""), Some("Deck")).unwrap());
        assert!(!save_workspace(&f.db, Some(&"x".repeat(501)), Some("Deck")).unwrap());
        assert!(!save_workspace(&f.db, Some("Deck"), Some(&"x".repeat(41))).unwrap());
        assert!(!save_workspace(&f.db, None, Some("Deck")).unwrap());
        assert!(!save_workspace(&f.db, Some("Deck"), None).unwrap());
        assert!(save_workspace(&f.db, Some(" Support "), Some(" Mine ")).unwrap());
        save_model_workspaces(&f.db, &json!([{"group": "support", "workspace": "Wrong"}, {"group": "Plan", "workspace": "Deck"}])).unwrap();
        assert_eq!(f.index()["workspaces"], json!({"Support": "Mine", "Plan": "Deck"}));
        assert_eq!(f.index()["modelWorkspaces"], 1);
        save_model_workspaces(&f.db, &json!([{"group": "PLAN", "workspace": "Updated"}])).unwrap();
        assert_eq!(f.index()["workspaces"]["Plan"], "Updated");
        assert!(save_workspace(&f.db, Some("plan"), Some("User")).unwrap());
        save_model_workspaces(&f.db, &json!([{"group": "Plan", "workspace": "Wrong"}])).unwrap();
        assert_eq!(f.index()["workspaces"]["plan"], "User");
        save_model_workspaces(&f.db, &json!([{"group": "Other", "workspace": "Model"}])).unwrap();
        clear_model_workspaces(&f.db).unwrap();
        assert_eq!(f.index()["workspaces"], json!({"Support": "Mine", "plan": "User"}));
        assert_eq!(f.index()["modelWorkspaces"], 0);
        assert!(save_workspace(&f.db, Some("SUPPORT"), Some("  ")).unwrap());
        assert_eq!(f.index()["workspaces"], json!({"plan": "User"}));
        assert_eq!(all(&f.db, "PRAGMA user_version", []).unwrap()[0]["user_version"], 1);
        f.write("a", &f.user("alpha", "2026-05-01T00:00:00Z"));
        f.write("b", &f.user("beta", "2026-05-02T00:00:00Z"));
        f.write("c", &f.user("gamma", "2026-05-03T00:00:00Z"));
        f.write("d", &f.user("delta", "2026-05-04T00:00:00Z"));
        for n in ["a", "b", "c", "d"] { f.sync(n); }

        assert!(save_workspace(&f.db, Some("AlphaGroup"), Some("AlphaSpace")).unwrap());
        assert!(save_organization(&f.db, &id("a"), &json!({"pinned": false, "space": "AlphaSpace", "tags": []})).unwrap());
        assert!(save_group(&f.db, &id("a"), Some("AlphaGroup")).unwrap());
        assert!(delete_workspace(&f.db, "alphaspace").unwrap());
        assert!(!all(&f.db, "SELECT id FROM sessions WHERE id = ?", [id("a")]).unwrap().is_empty());
        assert_eq!(f.session("a")["space"], Value::Null);
        assert_eq!(f.session("a")["userGroup"], "AlphaGroup");
        assert!(all(&f.db, "SELECT 1 FROM group_workspace WHERE workspace = ? COLLATE NOCASE", ["AlphaSpace"]).unwrap().is_empty());

        assert!(save_workspace(&f.db, Some("BetaGroup"), Some("OldSpace")).unwrap());
        assert!(save_organization(&f.db, &id("b"), &json!({"pinned": false, "space": "OldSpace", "tags": []})).unwrap());
        assert!(rename_workspace(&f.db, "oldspace", "NewSpace").unwrap());
        assert_eq!(f.index()["workspaces"]["BetaGroup"], "NewSpace");
        assert_eq!(f.session("b")["space"], "NewSpace");
        assert_eq!(all(&f.db, "SELECT origin FROM group_workspace WHERE name = ?", ["BetaGroup"]).unwrap()[0]["origin"], "user");

        assert!(save_workspace_parent(&f.db, "PA", "PB").unwrap());
        assert_eq!(f.index()["workspaceParents"]["PA"], "PB");
        assert!(!save_workspace_parent(&f.db, "pb", "PA").unwrap());
        assert!(!save_workspace_parent(&f.db, "PA", "pa").unwrap());
        assert!(save_workspace_parent(&f.db, "PB", "PC").unwrap());
        assert!(!save_workspace_parent(&f.db, "PC", "PA").unwrap());
        assert!(rename_workspace(&f.db, "pb", "PBx").unwrap());
        assert_eq!(f.index()["workspaceParents"], json!({"PA": "PBx", "PBx": "PC"}));
        assert!(delete_workspace(&f.db, "PBx").unwrap());
        assert_eq!(f.index()["workspaceParents"], json!({"PA": "PC"}));
        assert!(delete_workspace(&f.db, "PC").unwrap());
        assert_eq!(f.index()["workspaceParents"], json!({}));

        assert!(save_group(&f.db, &id("a"), Some("Shared")).unwrap());
        assert!(save_group(&f.db, &id("b"), Some("Shared")).unwrap());
        assert!(save_group(&f.db, &id("c"), Some("Shared")).unwrap());
        assert!(save_workspace(&f.db, Some("Shared"), Some("KeepSpace")).unwrap());
        assert!(save_organization(&f.db, &id("b"), &json!({"pinned": false, "space": "", "tags": []})).unwrap());
        assert!(save_organization(&f.db, &id("c"), &json!({"pinned": true, "space": "OtherSpace", "tags": ["keep"]})).unwrap());
        assert!(delete_group(&f.db, &json!([id("a"), id("b"), id("c")]), "Shared").unwrap());
        assert_eq!(f.session("a")["space"], "KeepSpace");
        assert_eq!(f.session("b")["space"], "KeepSpace");
        assert_eq!(f.session("c")["space"], "OtherSpace");
        assert_eq!(f.session("c")["pinned"], true);
        assert_eq!(f.session("c")["tags"], json!(["keep"]));
        assert_eq!(f.session("a")["topic"], Value::Null);
        assert_eq!(f.session("a")["userGroup"], Value::Null);
        assert_eq!(f.session("a")["noGroup"], true);
        save_automatic(&f.db, &json!([{"id": id("a"), "topic": "AutoTopic", "title": null}])).unwrap();
        assert_eq!(f.session("a")["topic"], Value::Null);
        assert_eq!(f.session("a")["userGroup"], Value::Null);
        assert!(all(&f.db, "SELECT 1 FROM group_workspace WHERE name = ?", ["Shared"]).unwrap().is_empty());

        assert!(save_group(&f.db, &id("d"), Some("NoWs")).unwrap());
        assert_eq!(f.session("d")["space"], Value::Null);
        assert!(delete_group(&f.db, &json!([id("d")]), "NoWs").unwrap());
        assert_eq!(f.session("d")["space"], Value::Null);
        assert_eq!(f.session("d")["userGroup"], Value::Null);
        assert_eq!(f.session("d")["noGroup"], true);

        assert!(save_group(&f.db, &id("a"), Some("FromName")).unwrap());
        assert!(save_workspace(&f.db, Some("FromName"), Some("Ws1")).unwrap());
        assert!(rename_group(&f.db, &json!([id("a")]), "FromName", "ToName").unwrap());
        assert_eq!(f.session("a")["userGroup"], "ToName");
        assert_eq!(f.index()["workspaces"]["ToName"], "Ws1");
        assert!(f.index()["workspaces"].get("FromName").is_none());

        assert!(save_group(&f.db, &id("b"), Some("Source")).unwrap());
        assert!(save_workspace(&f.db, Some("Source"), Some("WsSource")).unwrap());
        assert!(save_workspace(&f.db, Some("Target"), Some("WsTarget")).unwrap());
        assert!(rename_group(&f.db, &json!([id("b")]), "Source", "Target").unwrap());
        assert_eq!(f.session("b")["userGroup"], "Target");
        assert_eq!(f.index()["workspaces"]["Target"], "WsTarget");
        assert!(f.index()["workspaces"].get("Source").is_none());

        assert!(save_group(&f.db, &id("c"), Some("mixed")).unwrap());
        assert!(save_workspace(&f.db, Some("mixed"), Some("WsCase")).unwrap());
        assert!(rename_group(&f.db, &json!([id("c")]), "mixed", "Mixed").unwrap());
        assert_eq!(f.session("c")["userGroup"], "Mixed");
        assert_eq!(f.index()["workspaces"]["Mixed"], "WsCase");
        assert_eq!(all(&f.db, "SELECT name FROM group_workspace WHERE name = ?", ["mixed"]).unwrap()[0]["name"], "Mixed");
        let gw = || all(&f.db, "SELECT name, workspace, origin FROM group_workspace ORDER BY name", []).unwrap();
        let sg = || all(&f.db, "SELECT session_id, name FROM session_group ORDER BY session_id", []).unwrap();
        let so = || all(&f.db, "SELECT session_id, pinned, space, tags FROM session_org ORDER BY session_id", []).unwrap();
        let snap = (gw(), sg(), so());
        assert!(!rename_group(&f.db, &json!([]), "ToName", "Other").unwrap());
        assert!(!rename_group(&f.db, &json!(["not-a-uuid"]), "ToName", "Other").unwrap());
        assert!(!rename_group(&f.db, &json!([id("a"), "not-a-uuid"]), "ToName", "Other").unwrap());
        assert!(!rename_group(&f.db, &json!([id("a"), 1]), "ToName", "Other").unwrap());
        assert!(!delete_group(&f.db, &json!([]), "ToName").unwrap());
        assert!(!delete_group(&f.db, &json!(["not-a-uuid"]), "ToName").unwrap());
        assert!(!delete_group(&f.db, &json!([id("a"), "x"]), "ToName").unwrap());
        assert_eq!(gw(), snap.0);
        assert_eq!(sg(), snap.1);
        assert_eq!(so(), snap.2);
    }

    // indexer.check.js:338-352: 1 assertions ported.
    #[test]
    fn live_end_turn_reports_prompt_and_context() {
        let f = Fixture::new();
        let file = f.dir.0.join("projects/p/00000000-0000-4000-8000-0000000000aa.jsonl");
        let file = file.to_str().unwrap();
        let reply = |stop, text| line(json!({"type": "assistant", "cwd": f.cwd, "timestamp": "2026-05-01T00:00:00Z",
            "message": {"stop_reason": stop, "usage": {"input_tokens": 5, "cache_read_input_tokens": 160000}, "content": [{"type": "text", "text": text}]}}));
        let block = "/frugal code\nGoal: Ship it\nNext step: Test";
        fs::write(file, f.user("go", "2026-05-01T00:00:00Z") + &reply("end_turn", block)).unwrap();
        sync_file(&f.db, file, None).unwrap();
        let mut live = Vec::new();
        fs::OpenOptions::new().append(true).open(file).unwrap().write_all(
            (reply("tool_use", block) + &reply("end_turn", "no block") + &reply("end_turn", &format!("Done.\n{block}"))).as_bytes()).unwrap();
        sync_file(&f.db, file, Some(&mut live)).unwrap();
        let id = "00000000-0000-4000-8000-0000000000aa";
        assert_eq!(live, vec![json!({"id": id, "prompt": null}), json!({"id": id, "prompt": null}), json!({"id": id, "prompt": block, "tokens": 160005})]);
    }

    const PLAIN: &str = "Goal: Ship the deck\nDone: indexed sessions\nPending: link chats to roots";
    const AT: &str = "2026-02-01T00:00:00Z";
    fn emission(session_id: &str, hash: &str, goal: &str, at: &str) -> Value {
        json!({"session_id": session_id, "hash": hash, "goal": goal, "at": at})
    }
    fn origin(emissions: &[Value]) -> PickOrigin { pick_origin("now", &json!("h1"), &json!("g1"), AT, emissions) }
    fn picked(parent: Option<&str>, candidates: &[&str]) -> PickOrigin {
        PickOrigin { parent: parent.map(str::to_owned), candidates: candidates.iter().map(|s| (*s).to_owned()).collect() }
    }

    // handoff.check.js:4-7: 2 assertions ported.
    #[test]
    fn non_text_is_not_handoff() {
        let _dir = TempDir::new();
        assert_eq!(handoff_block(&Value::Null), None);
        assert_eq!(handoff_block(&json!(42)), None);
    }

    // handoff.check.js:8-13: 2 assertions ported.
    #[test]
    fn fenced_handoff_with_frugal_line() {
        let _dir = TempDir::new();
        let fenced = ["Opening words.", "<command-name>/frugal</command-name>", "```", "Goal: Ship the deck", "Done: indexed sessions", "Pending: link chats to roots", "```", "coda"].join("\n");
        assert_eq!(handoff_block(&json!(fenced)), handoff_block(&json!(PLAIN)));
        assert_eq!(handoff_block(&json!(PLAIN)).unwrap().goal, "Ship the deck");
    }

    // handoff.check.js:14-16: 1 assertions ported.
    #[test]
    fn pasted_content_cuts_following_words() {
        let _dir = TempDir::new();
        assert_eq!(handoff_block(&json!(format!("<pasted_content>\n{PLAIN}</pasted_content>\nand honestly the tests too"))), handoff_block(&json!(PLAIN)));
    }

    // handoff.check.js:17-19: 1 assertions ported.
    #[test]
    fn command_args_closes_on_last_line() {
        let _dir = TempDir::new();
        assert_eq!(handoff_block(&json!("<command-args>\n".to_owned() + &PLAIN.replace("link chats to roots", "link chats to roots</command-args>"))).unwrap().hash, handoff_block(&json!(PLAIN)).unwrap().hash);
    }

    // handoff.check.js:20-22: 1 assertions ported.
    #[test]
    fn crlf_handoff_survives() {
        let _dir = TempDir::new();
        assert_eq!(handoff_block(&json!(PLAIN.replace('\n', "\r\n"))), handoff_block(&json!(PLAIN)));
    }

    // handoff.check.js:23-28: 2 assertions ported.
    #[test]
    fn usage_lines_do_not_change_hash() {
        let _dir = TempDir::new();
        let with_usage = ["Goal: Ship the deck", "Usage: 12 tokens", "Done: indexed sessions", "Pending: link chats to roots"].join("\n");
        let other_usage = ["Goal: Ship the deck", "Done: indexed sessions", "Usage: 40 tokens", "Pending: link chats to roots", "Usage: more"].join("\n");
        assert_eq!(handoff_block(&json!(with_usage)).unwrap().hash, handoff_block(&json!(PLAIN)).unwrap().hash);
        assert_eq!(handoff_block(&json!(other_usage)).unwrap().hash, handoff_block(&json!(PLAIN)).unwrap().hash);
    }

    // handoff.check.js:29-31: 1 assertions ported.
    #[test]
    fn whitespace_and_indentation_do_not_change_hash() {
        let _dir = TempDir::new();
        assert_eq!(handoff_block(&json!(["  Goal:   Ship   the deck ", "\tDone:\t indexed sessions", "\t Pending: link chats to roots"].join("\n"))).unwrap().hash, handoff_block(&json!(PLAIN)).unwrap().hash);
    }

    // handoff.check.js:32-39: 2 assertions ported.
    #[test]
    fn done_and_pending_both_required() {
        let _dir = TempDir::new();
        assert_eq!(handoff_block(&json!(PLAIN.replace("Pending: link chats to roots", "Later: link chats to roots"))), None);
        assert_eq!(handoff_block(&json!("Goal: Ship the deck")), None);
    }

    // handoff.check.js:40-42: 1 assertions ported.
    #[test]
    fn unique_exact_emitter_is_parent() {
        let _dir = TempDir::new();
        assert_eq!(origin(&[emission("a", "zz", "g1", "2026-01-09T00:00:00Z"), emission("b", "h1", "g1", "2026-01-10T00:00:00Z")]), picked(Some("b"), &[]));
    }

    // handoff.check.js:43-45: 1 assertions ported.
    #[test]
    fn exact_beats_goal_match() {
        let _dir = TempDir::new();
        assert_eq!(origin(&[emission("a", "h1", "g1", "2026-01-05T00:00:00Z"), emission("b", "zz", "g1", "2026-01-09T00:00:00Z")]), picked(Some("a"), &[]));
    }

    // handoff.check.js:46-48: 1 assertions ported.
    #[test]
    fn goal_match_when_no_hash_matches() {
        let _dir = TempDir::new();
        assert_eq!(origin(&[emission("a", "zz", "g1", "2026-01-10T00:00:00Z")]), picked(Some("a"), &[]));
    }

    // handoff.check.js:49-51: 1 assertions ported.
    #[test]
    fn future_and_self_emissions_ignored() {
        let _dir = TempDir::new();
        assert_eq!(origin(&[emission("a", "h1", "g1", AT), emission("now", "h1", "g1", "2026-01-01T00:00:00Z")]), picked(None, &[]));
    }

    // handoff.check.js:52-54: 1 assertions ported.
    #[test]
    fn latest_goal_match_wins() {
        let _dir = TempDir::new();
        assert_eq!(origin(&[emission("a", "zz", "g1", "2026-01-02T00:00:00Z"), emission("b", "zz", "g1", "2026-01-08T00:00:00Z")]), picked(Some("b"), &[]));
    }

    // handoff.check.js:55-57: 1 assertions ported.
    #[test]
    fn tied_matches_are_ambiguous() {
        let _dir = TempDir::new();
        assert_eq!(origin(&[emission("a", "zz", "g1", "2026-01-08T00:00:00Z"), emission("b", "zz", "g1", "2026-01-08T00:00:00Z")]), picked(None, &["a", "b"]));
    }

    // handoff.check.js:58-61: 2 assertions ported.
    #[test]
    fn no_origin_pool() {
        let _dir = TempDir::new();
        assert_eq!(origin(&[emission("a", "h1", "g1", "2026-03-01T00:00:00Z")]), picked(None, &[]));
        assert_eq!(origin(&[]), picked(None, &[]));
    }

    // handoff.check.js:62-68: 5 assertions ported.
    #[test]
    fn next_block_through_fence_without_usage() {
        let _dir = TempDir::new();
        let reply = ["Done for now.", "```", "/frugal code", "Goal: Ship handoff", "Done:", "- indexer", "Pending:", "- UI", "Next step: Wire the bar", "Usage: 160k (80%)", "```", "Bye"].join("\r\n");
        assert_eq!(next_block(&json!(reply)).as_deref(), Some("/frugal code\nGoal: Ship handoff\nDone:\n- indexer\nPending:\n- UI\nNext step: Wire the bar"));
        assert_eq!(next_block(&json!(reply.replace("Next step: Wire the bar", ""))), None);
        assert_eq!(next_block(&json!(reply.replace("/frugal code", "frugal code"))), None);
        assert_eq!(next_block(&json!(reply.replace("/frugal code", "/frugality"))), None);
        assert_eq!(next_block(&Value::Null), None);
    }

    // handoff.check.js:69-75: 3 assertions ported.
    #[test]
    fn unfenced_last_frugal_wins_and_context_tokens() {
        let _dir = TempDir::new();
        assert_eq!(next_block(&json!("Run /frugal first.\n/frugal\nGoal: g\nNext step: n")).as_deref(), Some("/frugal\nGoal: g\nNext step: n"));
        assert_eq!(context_tokens(&json!({"input_tokens": 3, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 150000, "output_tokens": 900})), 150103);
        assert_eq!(context_tokens(&Value::Null), 0);
    }

    #[test]
    fn sha1_node_vectors() {
        let _dir = TempDir::new();
        assert_eq!(sha1_hex(b""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(sha1_hex(&vec![b'a'; 1000]), "291e9a6c66994949b57ba5e650361e98fc36b1ba");
    }

    #[test]
    fn parsing_regressions_match_node() {
        let _dir = TempDir::new();
        assert_eq!(prompt_title(&json!("<x>Hello</x> <> <open")).as_deref(), Some("Hello <> <open"));
        assert_eq!(prompt_title(&json!("before\n Goal: indented\nDone: x")).as_deref(), Some("before Goal: indented Done: x"));
        assert_eq!(prompt_title(&json!("Goal:\n  Next line")).as_deref(), Some("Next line"));
        assert_eq!(prompt_title(&json!("Goal: <b>keep</b>")).as_deref(), Some("<b>keep</b>"));
        assert_eq!(prompt_title(&json!("<command-name>/x</command-name><command-args><b>keep</b></command-args>")).as_deref(), Some("/x <b>keep</b>"));
        assert_eq!(prompt_title(&json!("Goal:   \n")), None);
        assert_eq!(prompt_title(&json!("\u{feff} a \u{feff} b\u{85}c")).as_deref(), Some("a b\u{85}c"));
        assert_eq!(next_block(&json!("/frugal_more\nGoal: x\nNext step: y")), None);
        assert_eq!(next_block(&json!("/frugal\u{e9}\nGoal: x\nNext step: y")).as_deref(), Some("/frugal\u{e9}\nGoal: x\nNext step: y"));
        assert_eq!(handoff_block(&json!("Goal:Goal: x\nDone:\nPending:")), Some(HandoffBlock {
            hash: "58448cc8ed6355ea3c991d70ec09a00931b1a4ff".to_owned(), goal: "Goal: x".to_owned()
        }));
        assert_eq!(context_tokens(&json!({"input_tokens": 0.25, "cache_creation_input_tokens": 1.5, "cache_read_input_tokens": "3"})), json!(1.75));
        assert_eq!(clean_organization(&json!({"pinned": true, "space": "  ", "tags": [" a ", "#a", "A", "# b", "##", "B"]})),
            Some(json!({"pinned": true, "space": null, "tags": ["A", " b", "B"]})));
        assert_eq!(origin(&[emission("z", "h1", "g1", "2026-01-08T00:00:00Z"), emission("a", "h1", "g1", "2026-01-08T00:00:00Z"),
            emission("z", "h1", "g1", "2026-01-08T00:00:00Z")]), picked(None, &["z", "a"]));
        assert_eq!(prompt_title(&json!("\u{1f600}".repeat(61))).unwrap(), "\u{1f600}".repeat(60));
    }

    #[test]
    fn listing_shape_truthiness_and_ambiguity_regressions() {
        let f = Fixture::new();
        f.write(1, &f.user("original", "2026-01-01T00:00:00Z"));
        f.sync(1);
        assert_eq!(f.index(), json!({"workspaces": {}, "workspaceParents": {}, "modelWorkspaces": 0, "ambiguous": [], "modelJoins": 0,
            "sessions": [{"id": id(1), "file": f.file(1), "cwd": f.cwd, "title": "original", "lastAt": "2026-01-01T00:00:00Z",
                "startedAt": "2026-01-01T00:00:00Z", "turns": 1, "pinned": false, "space": null, "tags": [], "topic": null,
                "userGroup": null, "noGroup": false, "autoTitle": null, "customTitle": null, "aiTitle": null, "firstPrompt": "original",
                "parentId": null, "chatId": id(1)}]}));
        for value in [Value::Null, json!(false), json!(0), json!("")] {
            f.append(1, &f.user_extra("count", "2026-01-02T00:00:00Z", json!({"toolUseResult": value, "isMeta": value, "isSidechain": value})));
        }
        f.append(1, &f.user_extra("skip", "2026-01-03T00:00:00Z", json!({"isSidechain": "yes"})));
        f.append(1, &f.user_extra("skip", "2026-01-03T00:00:00Z", json!({"isMeta": []})));
        f.sync(1);
        assert_eq!(f.row(1)["turns"], 5);
        f.joined();
        f.write(8, &fs::read_to_string(f.file(9)).unwrap());
        f.sync(8);
        let info = |n| { let s = f.session(n); json!({"id": s["id"], "title": s["title"], "cwd": s["cwd"], "lastAt": s["lastAt"]}) };
        let ambiguous = f.index()["ambiguous"].clone();
        let child = ambiguous.as_array().unwrap().iter().find(|s| s["id"] == id(10)).unwrap();
        assert_eq!(child, &json!({"id": id(10), "title": "Fix the deck", "cwd": f.cwd, "lastAt": "2026-04-03T00:00:00.000Z", "candidates": [info(9), info(8)]}));
        assert_eq!(f.session(10)["parentId"], Value::Null);
        assert_eq!(f.session(10)["chatId"], id(10));
        f.db.execute("UPDATE sessions SET entrypoint = 'sdk-cli' WHERE id = ?", [id(8)]).unwrap();
        assert_eq!(f.session(10)["parentId"], id(9));
        assert_eq!(f.index()["ambiguous"], json!([]));
        let mut last = None;
        save_link(&f.db, &id(10), None, "user", &mut last).unwrap();
        assert_eq!(f.session(10)["parentId"], Value::Null);
        assert_eq!(folder_key(&f.dir.0.join("projects/../")), folder_key(&f.dir.0));
        assert_eq!(folder_key(&std::env::temp_dir().join(".")), folder_key(&std::env::temp_dir()));
    }

    #[test]
    fn failed_writes_roll_back_and_errors_surface() {
        let f = Fixture::new();
        f.short();
        save_group(&f.db, &id(1), Some("Group")).unwrap();
        save_workspace(&f.db, Some("Group"), Some("Old")).unwrap();
        save_organization(&f.db, &id(1), &json!({"pinned": true, "space": "Old", "tags": ["keep"]})).unwrap();
        save_workspace_parent(&f.db, "Old", "Parent").unwrap();
        let before = f.index();
        f.db.execute_batch("CREATE TEMP TRIGGER fail_rename BEFORE UPDATE ON workspace_parent BEGIN SELECT RAISE(ABORT, 'rename blocked'); END").unwrap();
        assert!(rename_workspace(&f.db, "Old", "New").unwrap_err().to_string().contains("rename blocked"));
        assert_eq!(f.index(), before);
        assert!(f.db.is_autocommit());
        f.db.execute_batch("DROP TRIGGER fail_rename; CREATE TEMP TRIGGER fail_place BEFORE INSERT ON session_org BEGIN SELECT RAISE(ABORT, 'place blocked'); END").unwrap();
        assert!(delete_group(&f.db, &json!([id(1)]), "Group").unwrap_err().to_string().contains("place blocked"));
        assert_eq!(f.index(), before);
        assert!(f.db.is_autocommit());
        f.db.execute_batch("DROP TRIGGER fail_place").unwrap();
        assert!(save_automatic(&f.db, &json!([{"id": id(1), "topic": "would change", "title": null}, {"id": true, "topic": "bad", "title": null}])).is_err());
        assert_eq!(f.index(), before);
        assert!(f.db.is_autocommit());
        assert!(sync_file(&f.db, &f.file("missing"), None).is_err());
        assert_eq!(f.index(), before);
        f.db.execute("UPDATE session_org SET tags = 'not JSON' WHERE session_id = ?", [id(1)]).unwrap();
        assert!(list_index(&f.db).is_err());
    }

    #[test]
    fn chunk_boundaries_and_scan_batches() {
        let f = Fixture::new();
        let file = f.dir.0.join("chunks");
        fs::write(&file, "x".repeat(CHUNK - 1) + "\u{e9}\npartial").unwrap();
        let mut lines = Vec::new();
        let offset = read_lines(file.to_str().unwrap(), 0, |line| lines.push(line.to_owned())).unwrap();
        assert_eq!(offset, CHUNK as u64 + 2);
        assert_eq!(lines, vec!["x".repeat(CHUNK - 1) + "\u{e9}"]);
        fs::OpenOptions::new().append(true).open(&file).unwrap().write_all(b" done\n").unwrap();
        lines.clear();
        assert_eq!(read_lines(file.to_str().unwrap(), offset, |line| lines.push(line.to_owned())).unwrap(), fs::metadata(&file).unwrap().len());
        assert_eq!(lines, vec!["partial done"]);
        for n in 0..=BATCH { f.write(n, &f.user("batch", "2026-01-01T00:00:00Z")); }
        let root = f.dir.0.join("projects").to_string_lossy().into_owned();
        let nested = f.dir.0.join("projects/p/subagents");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join("ignored.jsonl"), f.user("ignored", "2026-01-01T00:00:00Z")).unwrap();
        fs::write(f.dir.0.join("projects/ignored.jsonl"), f.user("ignored", "2026-01-01T00:00:00Z")).unwrap();
        let mut batches = 0;
        scan(&f.db, &[root.clone(), root.clone()], || batches += 1).unwrap();
        assert_eq!(batches, 1);
        assert_eq!(all(&f.db, "SELECT id, file FROM sessions", []).unwrap().len(), BATCH + 1);
        assert_eq!(f.row(0)["turns"], 1);
        batches = 0;
        scan(&f.db, &[root], || batches += 1).unwrap();
        assert_eq!(batches, 0);
    }

    #[test]
    fn migration_reindexes_sessions_preserving_user_tables() {
        let f = Fixture::new();
        f.short();
        save_organization(&f.db, &id(1), &json!({"pinned": true, "space": "Work", "tags": ["keep"]})).unwrap();
        save_workspace(&f.db, Some("Manual"), Some("Work")).unwrap();
        save_workspace_parent(&f.db, "Work", "Root").unwrap();
        let mut last = None;
        save_link(&f.db, &id(1), None, "user", &mut last).unwrap();
        f.db.execute_batch("DROP TABLE sessions; CREATE TABLE sessions (id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('legacy'); PRAGMA user_version = 0").unwrap();
        let file = f.dir.0.join("nested/deck.db");
        f.db.close().unwrap();
        let db = open_index(file.to_str().unwrap()).unwrap();
        assert!(all(&db, "SELECT id, file FROM sessions", []).unwrap().is_empty());
        assert_eq!(all(&db, "PRAGMA user_version", []).unwrap()[0]["user_version"], 1);
        assert_eq!(all(&db, "SELECT session_id, pinned, space, tags FROM session_org", []).unwrap(),
            vec![json!({"session_id": id(1), "pinned": 1, "space": "Work", "tags": "[\"keep\"]"})]);
        assert_eq!(all(&db, "SELECT session_id, name FROM session_group", []).unwrap(), vec![json!({"session_id": id(1), "name": "Manual"})]);
        assert_eq!(all(&db, "SELECT session_id, parent_id FROM session_links", []).unwrap(), vec![json!({"session_id": id(1), "parent_id": null})]);
        assert_eq!(list_index(&db).unwrap()["workspaces"], json!({"Manual": "Work"}));
        assert_eq!(list_index(&db).unwrap()["workspaceParents"], json!({"Work": "Root"}));
        db.close().unwrap();
    }

    #[test]
    fn undo_is_independent_and_restores_previous_override() {
        let f = Fixture::new();
        let other = Fixture::new();
        f.joined();
        other.joined();
        let (mut last, mut other_last) = (None, None);
        assert!(!undo_last_link(&f.db, &mut last).unwrap());
        save_link(&f.db, &id(11), None, "model", &mut last).unwrap();
        save_link(&f.db, &id(11), Some(&id(10)), "user", &mut last).unwrap();
        save_link(&other.db, &id(10), None, "user", &mut other_last).unwrap();
        assert!(undo_last_link(&f.db, &mut last).unwrap());
        assert_eq!(f.session(11)["parentId"], Value::Null);
        assert_eq!(f.index()["modelJoins"], 1);
        assert_eq!(other.session(10)["parentId"], Value::Null);
        assert!(!undo_last_link(&f.db, &mut last).unwrap());
        assert!(undo_last_link(&other.db, &mut other_last).unwrap());
        assert_eq!(other.session(10)["parentId"], id(9));
        clear_model_links(&f.db).unwrap();
        assert_eq!(f.session(11)["parentId"], id(9));
        assert_eq!(f.index()["modelJoins"], 0);
    }
    #[test]
    fn sidebar_keeps_newest_organized_live_and_whole_chats() {
        let mut sessions: Vec<Value> = (0..530).map(|i| {
            let group = if i < 500 { "x" } else { "y" };
            json!({"id": format!("s{i}"), "chatId": format!("s{i}"), "topic": group, "cwd": group, "pinned": false, "space": null, "tags": []})
        }).collect();
        sessions[525]["pinned"] = json!(true);
        sessions[526]["tags"] = json!(["t"]);
        sessions[528]["chatId"] = json!("s500");
        sessions[510]["chatId"] = json!("s529");
        let out = sidebar(&json!({"indexing": false, "sessions": sessions}), |id| id == "s527");
        let ids: Vec<&str> = out["sessions"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
        let dropped = ["s520", "s521", "s522", "s523", "s524"];
        assert_eq!(ids.len(), 525);
        assert!(dropped.iter().all(|id| !ids.contains(id)));
        assert_eq!(out["indexing"], false);
    }
}
