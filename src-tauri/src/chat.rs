// The chat terminals: claude.exe in a ConPTY, its output streamed to the renderer over one Channel per chat.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{ipc::Channel, AppHandle, Manager, State};
use crate::index::{self, Index};

const NO_CLAUDE: &str = "claude.exe not found in PATH. Install Claude Code and reopen Deck.";
// Under a frame, so typing still echoes at once.
const BATCH: Duration = Duration::from_millis(4);

struct Chat {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct Chats {
    live: Mutex<HashMap<String, Chat>>,
    picked: Mutex<HashSet<PathBuf>>,
}

impl Chats {
    pub fn kill_all(&self) {
        for chat in self.live.lock().unwrap().values_mut() {
            let _ = chat.killer.kill();
        }
    }

    pub fn is_live(&self, id: &str) -> bool {
        self.live.lock().unwrap().contains_key(id)
    }
}

#[derive(Deserialize)]
pub struct StartOptions {
    id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    #[serde(default)]
    resume: Value,
    #[serde(default)]
    group: Value,
    #[serde(default)]
    bypass: Value,
    #[serde(default)]
    admin: Value,
}

fn is_uuid(id: &str) -> bool {
    id.len() == 36 && id.char_indices().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() })
}

const fn is_size(n: u16) -> bool {
    n > 0 && n <= 1000
}

fn find_claude() -> Option<PathBuf> {
    let out = Command::new("where.exe").arg("claude").output().ok()?;
    String::from_utf8_lossy(&out.stdout).lines().filter(|line| !line.is_empty()).find_map(|entry| {
        let entry = Path::new(entry);
        if entry.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("exe")) {
            return Some(entry.to_path_buf());
        }
        let packaged = entry.parent()?.join("node_modules/@anthropic-ai/claude-code/bin/claude.exe");
        packaged.exists().then_some(packaged)
    })
}

// Same keys Electron's cleanEnv drops, so claude.exe never inherits a parent Claude Code session.
fn dropped(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    key.starts_with("CLAUDE") || key.starts_with("NPM_") || matches!(key.as_str(), "ELECTRON_RUN_AS_NODE" | "NO_COLOR" | "INIT_CWD")
}

// Outside the install folder: Program Files needs admin rights and an update or uninstall could remove it.
#[tauri::command]
pub fn folder_default(chats: tauri::State<Chats>) -> Result<PathBuf, String> {
    let folder = std::env::var_os("USERPROFILE").map(PathBuf::from).ok_or("No user folder.")?.join("Frugal Deck").join("Sessions");
    std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    chats.picked.lock().unwrap().insert(folder.clone());
    Ok(folder)
}

// Reads stop only at EOF, which ConPTY sends once the chat is removed and its pseudoconsole closes; until then the pipe must keep draining.
// ConPTY writes about a line per read, and each channel message is one script run in the page, so reads within BATCH go as one message.
fn pump(mut reader: Box<dyn Read + Send>, output: &Channel<Value>) {
    let (reads, batches) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        while let Ok(n @ 1..) = reader.read(&mut buf) {
            let _ = reads.send(buf[..n].to_vec());
        }
    });
    let mut pending = Vec::new();
    while let Ok(chunk) = batches.recv() {
        pending.extend_from_slice(&chunk);
        thread::sleep(BATCH);
        for chunk in batches.try_iter() {
            pending.extend_from_slice(&chunk);
        }
        // A character split across two reads waits for its tail.
        let cut = match std::str::from_utf8(&pending) {
            Err(error) if error.error_len().is_none() => error.valid_up_to(),
            _ => pending.len(),
        };
        if cut > 0 {
            let _ = output.send(Value::String(String::from_utf8_lossy(&pending[..cut]).into_owned()));
            pending.drain(..cut);
        }
    }
}

// Output arrives as strings on the channel and the exit as {exit}, so the exit never overtakes the last output.
// frugal: accounts, status line and Ctrl+G editor come in phase 4, administrator chats in phase 5.
#[tauri::command]
pub fn chat_start(app: AppHandle, chats: State<Chats>, index: State<Index>, options: StartOptions, output: Channel<Value>) -> Value {
    let resume = !matches!(options.resume, Value::Null | Value::Bool(false));
    // A resumed chat always runs in the folder the index recorded, never one sent by the renderer.
    let folder = if resume {
        index.session(&options.id).and_then(|session| session["cwd"].as_str().map(PathBuf::from))
    } else {
        options.cwd.filter(|cwd| chats.picked.lock().unwrap().contains(Path::new(cwd)) || index.has_cwd(cwd)).map(PathBuf::from)
    };
    let (Some(folder), true, true, true) = (folder, is_uuid(&options.id), is_size(options.cols), is_size(options.rows)) else {
        return json!({ "error": "Invalid request." });
    };
    if options.admin == Value::Bool(true) {
        return json!({ "error": "Administrator chats are not ported yet." });
    }
    let Some(claude) = find_claude() else {
        return json!({ "error": NO_CLAUDE });
    };
    let bypass = options.bypass == Value::Bool(true);
    let mut command = CommandBuilder::new(claude);
    for (key, _) in std::env::vars_os() {
        if dropped(&key.to_string_lossy()) {
            command.env_remove(key);
        }
    }
    command.env("FRUGAL_ROLES", "on");
    command.cwd(folder);
    let settings = if bypass { json!({ "skipDangerousModePermissionPrompt": true }) } else { json!({}) };
    command.args([if resume { "--resume" } else { "--session-id" }, &options.id, "--settings", &settings.to_string()]);
    if bypass {
        command.arg("--dangerously-skip-permissions");
    }

    let mut live = chats.live.lock().unwrap();
    if live.contains_key(&options.id) {
        return json!({ "error": "Invalid request." });
    }
    let size = PtySize { rows: options.rows, cols: options.cols, pixel_width: 0, pixel_height: 0 };
    let started = native_pty_system().openpty(size).map_err(|error| error.to_string()).and_then(|pair| {
        let reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
        let writer = pair.master.take_writer().map_err(|error| error.to_string())?;
        let child = pair.slave.spawn_command(command).map_err(|error| error.to_string())?;
        Ok((pair.master, reader, writer, child))
    });
    let (master, reader, writer, mut child) = match started {
        Ok(started) => started,
        Err(error) => return json!({ "error": format!("Failed to start Claude: {error}") }),
    };
    live.insert(options.id.clone(), Chat { master, writer, killer: child.clone_killer() });
    drop(live);
    if let Some(group) = options.group.as_str().filter(|group| !group.is_empty()) {
        index.set_group(options.id.clone(), group.to_owned());
    }
    index::changed(&app);

    let id = options.id;
    thread::spawn(move || {
        let reading = {
            let output = output.clone();
            thread::spawn(move || pump(reader, &output))
        };
        let code = child.wait().map_or(1, |status| status.exit_code());
        // Dropped outside the lock: closing the pseudoconsole waits for its output to drain.
        let chat = app.state::<Chats>().live.lock().unwrap().remove(&id);
        drop(chat);
        let _ = reading.join();
        let _ = output.send(json!({ "exit": code }));
    });
    json!({ "ok": true, "account": "main", "frugal": false })
}

#[tauri::command]
pub fn chat_input(chats: tauri::State<Chats>, id: String, data: String) {
    if let Some(chat) = chats.live.lock().unwrap().get_mut(&id) {
        let _ = chat.writer.write_all(data.as_bytes());
    }
}

#[tauri::command]
pub fn chat_resize(chats: tauri::State<Chats>, id: String, cols: u16, rows: u16) {
    if !is_size(cols) || !is_size(rows) {
        return;
    }
    if let Some(chat) = chats.live.lock().unwrap().get(&id) {
        let _ = chat.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
}

#[tauri::command]
pub fn chat_kill(chats: tauri::State<Chats>, id: String) {
    if let Some(chat) = chats.live.lock().unwrap().get_mut(&id) {
        let _ = chat.killer.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_ids_and_env() {
        assert!(is_uuid("0f8e2c1a-1b2c-4d3e-8f90-abcdefABCDEF"));
        assert!(!is_uuid("0f8e2c1a-1b2c-4d3e-8f90-abcdefABCDE"));
        assert!(!is_uuid("0f8e2c1a11b2c-4d3e-8f90-abcdefABCDEF"));
        assert!(dropped("ClaudeCode") && dropped("npm_config_x") && dropped("no_color"));
        assert!(!dropped("PATH") && !dropped("NO_COLORS"));
    }
}
