// The chat terminals: claude.exe in a ConPTY, its output streamed to the renderer over one Channel per chat.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, AppHandle, Emitter, Manager, State};
use crate::accounts::{self, Accounts, MAIN};
use crate::index::{self, Index};

pub const NO_CLAUDE: &str = "claude.exe not found in PATH. Install Claude Code and reopen Deck.";
// Under a frame, so typing still echoes at once.
const BATCH: Duration = Duration::from_millis(4);
// main.js IDLE_MS: a chat restarts only once Claude has been quiet this long.
const IDLE: Duration = Duration::from_millis(2000);
const INVALID: &str = "Invalid request.";

// Electron's chatInfo; a sign-in terminal has none.
struct Info {
    account: String,
    folder: PathBuf,
    bypass: bool,
    admin: bool,
    voice: bool,
}

// Shared with the pump. A switch mutes the old chat, so its last output and its exit never reach the restarted one.
struct Activity {
    muted: AtomicBool,
    last_output: Mutex<Instant>,
}

struct Chat {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    info: Option<Info>,
    activity: Arc<Activity>,
    exited: mpsc::Receiver<()>,
}

#[derive(Default)]
pub struct Chats {
    live: Mutex<HashMap<String, Chat>>,
    // Chats still starting, with their cancel flag; locked after live.
    launching: Mutex<HashMap<String, Arc<AtomicBool>>>,
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

    pub fn open_accounts(&self) -> HashSet<String> {
        self.live.lock().unwrap().values().filter_map(|chat| Some(chat.info.as_ref()?.account.clone())).collect()
    }

    pub fn pick(&self, folder: PathBuf) {
        self.picked.lock().unwrap().insert(folder);
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
    #[serde(default)]
    frugal: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinueOptions {
    id: String,
    from: String,
    account_id: String,
    #[serde(default)]
    prompt: Value,
    cols: u16,
    rows: u16,
    #[serde(default)]
    bypass: Value,
    #[serde(default)]
    admin: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchOptions {
    id: String,
    account_id: String,
    cols: u16,
    rows: u16,
    #[serde(default)]
    bypass: Value,
    #[serde(default)]
    admin: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginOptions {
    id: String,
    #[serde(default)]
    name: Value,
    account_id: Option<String>,
    cols: u16,
    rows: u16,
}

pub(crate) fn is_uuid(id: &str) -> bool {
    id.len() == 36 && id.char_indices().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() })
}

const fn is_size(n: u16) -> bool {
    n > 0 && n <= 1000
}

fn invalid() -> Value {
    json!({ "error": INVALID })
}

pub fn find_claude() -> Option<PathBuf> {
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
pub(crate) fn dropped(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    key.starts_with("CLAUDE") || key.starts_with("NPM_") || matches!(key.as_str(), "ELECTRON_RUN_AS_NODE" | "NO_COLOR" | "INIT_CWD")
}

pub fn clean_env() -> HashMap<String, String> {
    std::env::vars_os().filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?))).filter(|(key, _)| !dropped(key)).collect()
}

// FRUGAL_ROLES is read by frugal's accounts server, so the setting applies to chats started after it changes.
pub fn account_env(accounts: &Accounts, account: &Value) -> HashMap<String, String> {
    let mut env = clean_env();
    env.insert("FRUGAL_ROLES".into(), if accounts.roles() { "on" } else { "off" }.into());
    if account["id"] != MAIN {
        env.insert("CLAUDE_CONFIG_DIR".into(), account["configDir"].as_str().unwrap_or_default().into());
    }
    env
}

fn command(claude: PathBuf, env: HashMap<String, String>, cwd: &Path) -> CommandBuilder {
    let mut command = CommandBuilder::new(claude);
    command.env_clear();
    for (key, value) in env {
        command.env(key, value);
    }
    command.cwd(cwd);
    command
}

// A bypass or administrator change restarts the chat too, so it waits like an account change; a chat not yet indexed never restarts.
fn must_wait(indexed: bool, restart: bool, quiet: Duration) -> bool {
    indexed && restart && quiet < IDLE
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
fn pump(mut reader: Box<dyn Read + Send>, output: &Channel<Value>, activity: &Activity) {
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
        let cut = crate::elevated::utf8_cut(&pending);
        if cut > 0 {
            if !activity.muted.load(Ordering::Relaxed) {
                *activity.last_output.lock().unwrap() = Instant::now();
                let _ = output.send(Value::String(String::from_utf8_lossy(&pending[..cut]).into_owned()));
            }
            pending.drain(..cut);
        }
    }
}

// Output arrives as strings on the channel and the exit as {exit}, so the exit never overtakes the last output.
// on_exit runs after the terminal leaves the live chats and before {exit} is sent.
#[allow(clippy::too_many_arguments)]
fn spawn(app: &AppHandle, id: &str, command: CommandBuilder, (cols, rows): (u16, u16), info: Option<Info>, output: Channel<Value>, fail: &str, on_exit: impl FnOnce(&AppHandle, u32) + Send + 'static) -> Result<(), Value> {
    let chats = app.state::<Chats>();
    // Administrator chats wait on the UAC prompt; closing one there must not leave it running unseen.
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let live = chats.live.lock().unwrap();
        let mut launching = chats.launching.lock().unwrap();
        if live.contains_key(id) || launching.contains_key(id) {
            return Err(invalid());
        }
        launching.insert(id.to_owned(), cancelled.clone());
    }
    let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
    let started = if info.as_ref().is_some_and(|info| info.admin) {
        app.state::<crate::elevated::Host>().spawn(&command, size)
    } else {
        native_pty_system().openpty(size).map_err(|error| error.to_string()).and_then(|pair| {
            let reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
            let writer = pair.master.take_writer().map_err(|error| error.to_string())?;
            let child = pair.slave.spawn_command(command).map_err(|error| error.to_string())?;
            Ok((pair.master, reader, writer, child))
        })
    };
    let mut live = chats.live.lock().unwrap();
    chats.launching.lock().unwrap().remove(id);
    let (master, reader, writer, mut child) = started.map_err(|error| json!({ "error": format!("{fail}{error}") }))?;
    if cancelled.load(Ordering::Relaxed) {
        let _ = child.kill();
        return Err(json!({ "error": "The chat was closed before it started." }));
    }
    let activity = Arc::new(Activity { muted: AtomicBool::new(false), last_output: Mutex::new(Instant::now()) });
    let (done, exited) = mpsc::channel();
    live.insert(id.to_owned(), Chat { master, writer, killer: child.clone_killer(), info, activity: activity.clone(), exited });
    drop(live);

    let (app, id) = (app.clone(), id.to_owned());
    thread::spawn(move || {
        let reading = {
            let (output, activity) = (output.clone(), activity.clone());
            thread::spawn(move || pump(reader, &output, &activity))
        };
        let code = child.wait().map_or(1, |status| status.exit_code());
        let _ = done.send(());
        // A switch takes the chat out first, so the restart never reads as an exit.
        let chat = {
            let chats = app.state::<Chats>();
            let mut live = chats.live.lock().unwrap();
            if activity.muted.load(Ordering::Relaxed) { None } else { Some(live.remove(&id)) }
        };
        // Dropped outside the lock: closing the pseudoconsole waits for its output to drain.
        let replaced = chat.is_none();
        drop(chat);
        let _ = reading.join();
        if !replaced {
            on_exit(&app, code);
            let _ = output.send(json!({ "exit": code }));
        }
    });
    Ok(())
}

// main.js launchChat.
#[allow(clippy::too_many_arguments)]
fn launch(app: &AppHandle, id: &str, folder: PathBuf, size: (u16, u16), resume: bool, group: &Value, account: &Value, prompt: Option<&str>, bypass: bool, admin: bool, output: Channel<Value>) -> Value {
    let Some(claude) = find_claude() else {
        return json!({ "error": NO_CLAUDE });
    };
    let accounts = app.state::<Mutex<Accounts>>();
    let index = app.state::<Index>();
    let mut env = account_env(&accounts.lock().unwrap(), account);
    let session = index.session(id).unwrap_or_default();
    let dir = Path::new(account["configDir"].as_str().unwrap_or_default());
    let group = group.as_str().filter(|group| !group.is_empty());
    let prepared = (|| -> Result<Vec<Value>, Box<dyn std::error::Error>> {
        if account["id"] != MAIN {
            accounts::ensure_onboarded(dir)?;
        }
        if resume {
            accounts::share_transcript(Path::new(session["file"].as_str().unwrap_or_default()), dir)?;
        }
        let topic = group.or(session["topic"].as_str().filter(|topic| !topic.is_empty()));
        let workspaces = index.workspaces_of(&session["space"], topic, &folder.to_string_lossy());
        accounts.lock().unwrap().denied_servers(&folder, topic, &workspaces)
    })();
    let denied = match prepared {
        Ok(denied) => denied,
        Err(error) => return json!({ "error": format!("Failed to start Claude: {error}") }),
    };
    let bridge = app.state::<crate::statusline::StatusBridge>();
    let pairs: Vec<_> = env.iter().map(|(k, v)| (k.into(), v.into())).collect();
    let status = bridge.register(id, &folder, &pairs, crate::statusline::read_user_status_line(&dir.join("settings.json")).as_ref());
    let token = status["token"].as_str().unwrap_or_default().to_owned();
    // Quoted: Claude Code runs VISUAL through the shell, and the user folder may contain spaces.
    if let Ok(dir) = app.path().app_data_dir() {
        env.insert("VISUAL".into(), format!("\"{}\"", dir.join(crate::statusline::EDITOR).display()));
    }
    env.insert("DECK_EDIT_URL".into(), status["editUrl"].as_str().unwrap_or_default().into());
    let voice = crate::voice::anthropic_voice();
    // The Deck's own warning took the consent, so Claude Code's disclaimer is skipped (it reads this key from flag settings too).
    // Claude Code reads voice.enabled before voiceEnabled, and /voice off writes it to user settings. The mic button holds Space, so the mode is hold.
    let mut settings = json!({ "statusLine": status["statusLine"] });
    if voice {
        settings["voice"] = json!({ "enabled": true, "mode": "hold" });
    }
    if bypass {
        settings["skipDangerousModePermissionPrompt"] = json!(true);
    }
    if !denied.is_empty() {
        settings["deniedMcpServers"] = json!(denied);
    }
    let mut command = command(claude, env, &folder);
    command.args([if resume { "--resume" } else { "--session-id" }, id, "--settings", &settings.to_string()]);
    if let Some(prompt) = prompt {
        command.arg(prompt);
    }
    if bypass {
        command.arg("--dangerously-skip-permissions");
    }
    let info = Info { account: account["id"].as_str().unwrap_or_default().to_owned(), folder, bypass, admin, voice };
    let exit_token = token.clone();
    let exit_id = id.to_owned();
    if let Err(error) = spawn(app, id, command, size, Some(info), output, "Failed to start Claude: ", move |app, _| {
        let bridge = app.state::<crate::statusline::StatusBridge>();
        bridge.release(&exit_token);
        bridge.save_edit(&exit_id, None);
    }) {
        bridge.release(&token);
        return error;
    }
    if let Some(group) = group {
        index.set_group(id.to_owned(), group.to_owned());
    }
    index::changed(app);
    json!({ "ok": true, "account": account["id"] })
}

// An administrator chat waits on the UAC prompt, so starts run off the main thread.
#[tauri::command]
pub async fn chat_start(app: AppHandle, options: StartOptions, output: Channel<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || start(&app, options, output)).await.unwrap_or_else(|error| json!({ "error": error.to_string() }))
}

fn start(app: &AppHandle, options: StartOptions, output: Channel<Value>) -> Value {
    let (chats, index, accounts) = (app.state::<Chats>(), app.state::<Index>(), app.state::<Mutex<Accounts>>());
    let resume = !matches!(options.resume, Value::Null | Value::Bool(false));
    // A resumed chat always runs in the folder the index recorded, never one sent by the renderer.
    let folder = if resume {
        index.session(&options.id).and_then(|session| session["cwd"].as_str().map(PathBuf::from))
    } else {
        options.cwd.filter(|cwd| chats.picked.lock().unwrap().contains(Path::new(cwd)) || index.has_cwd(cwd)).map(PathBuf::from)
    };
    let (Some(folder), true, false, true, true) = (folder, is_uuid(&options.id), chats.is_live(&options.id), is_size(options.cols), is_size(options.rows)) else {
        return invalid();
    };
    let account = accounts.lock().unwrap().primary();
    let frugal = !resume && options.frugal == true && accounts::has_frugal(&account);
    let prompt = frugal.then_some("/frugal:frugal");
    let mut started = launch(app, &options.id, folder, (options.cols, options.rows), resume, &options.group, &account, prompt, options.bypass == true, options.admin == true, output);
    if started["ok"] == true {
        started["frugal"] = json!(frugal);
    }
    started
}

// A handoff continues in the folder its chat runs in, or the one the index recorded once it exits, on the account it ran on.
#[tauri::command]
pub async fn chat_continue(app: AppHandle, options: ContinueOptions, output: Channel<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || continue_chat(&app, options, output)).await.unwrap_or_else(|error| json!({ "error": error.to_string() }))
}

fn continue_chat(app: &AppHandle, o: ContinueOptions, output: Channel<Value>) -> Value {
    let (chats, index, accounts) = (app.state::<Chats>(), app.state::<Index>(), app.state::<Mutex<Accounts>>());
    let running = chats.live.lock().unwrap().get(&o.from).and_then(|chat| Some(chat.info.as_ref()?.folder.clone()));
    let folder = running.or_else(|| index.session(&o.from).and_then(|session| session["cwd"].as_str().map(PathBuf::from)));
    let account = accounts.lock().unwrap().claude_accounts().into_iter().find(|account| account["id"] == o.account_id);
    let text = index::trim(o.prompt.as_str().unwrap_or_default());
    // A leading dash would be read as a flag of claude.exe.
    let (Some(folder), Some(account), true, false, false, false, true, true) =
        (folder, account, is_uuid(&o.id), chats.is_live(&o.id), text.is_empty(), text.starts_with('-'), is_size(o.cols), is_size(o.rows)) else {
        return invalid();
    };
    launch(app, &o.id, folder, (o.cols, o.rows), false, &Value::Null, &account, Some(text), o.bypass == true, o.admin == true, output)
}

// Waits for the old claude.exe to exit, so it runs off the main thread.
#[tauri::command]
pub async fn chat_switch_account(app: AppHandle, options: SwitchOptions, output: Channel<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || switch_account(&app, options, output)).await.unwrap_or_else(|error| json!({ "error": error.to_string() }))
}

fn switch_account(app: &AppHandle, o: SwitchOptions, output: Channel<Value>) -> Value {
    let account = app.state::<Mutex<Accounts>>().lock().unwrap().claude_accounts().into_iter().find(|account| account["id"] == o.account_id);
    let session = app.state::<Index>().session(&o.id);
    let (bypass, admin) = (o.bypass == true, o.admin == true);
    let chats = app.state::<Chats>();
    let mut live = chats.live.lock().unwrap();
    let (Some(account), Some(chat), true, true) = (account, live.get(&o.id), is_size(o.cols), is_size(o.rows)) else {
        return invalid();
    };
    let Some(info) = &chat.info else {
        return invalid();
    };
    let account_id = account["id"].as_str().unwrap_or_default().to_owned();
    let moving = info.account != account_id;
    // Anthropic voice turns on at launch (Claude Code reads the voice setting only then), so a chat started without it restarts once.
    let flags_changed = bypass != info.bypass || admin != info.admin || (crate::voice::anthropic_voice() && !info.voice);
    if must_wait(session.is_some(), moving || flags_changed, chat.activity.last_output.lock().unwrap().elapsed()) {
        return json!({ "error": "Claude is working. Switch accounts when it is idle." });
    }
    // A bypass or administrator toggle restarts on the chat's own account, which is no reason to make it the primary.
    if moving || !flags_changed {
        let accounts = app.state::<Mutex<Accounts>>();
        let mut a = accounts.lock().unwrap();
        if let Err(error) = a.set_primary(&account_id).and_then(|()| accounts::publish(app, &mut a)) {
            return json!({ "error": error.to_string() });
        }
        drop(a);
        accounts::read_now(app, &account_id);
    }
    if !moving && !flags_changed {
        return json!({ "ok": true, "account": account_id });
    }
    let Some(session) = session else {
        return json!({ "error": "Send a first message before switching this chat. New chats will use this account." });
    };
    let mut chat = live.remove(&o.id).unwrap();
    chat.activity.muted.store(true, Ordering::Relaxed);
    drop(live);
    let _ = chat.killer.kill();
    let _ = chat.exited.recv();
    drop(chat);
    let _ = app.emit("chat:restarting", [&o.id]);
    let folder = session["cwd"].as_str().map(PathBuf::from).unwrap_or_default();
    let mut started = launch(app, &o.id, folder, (o.cols, o.rows), true, &Value::Null, &account, None, bypass, admin, output);
    if started["error"].is_string() {
        started["stopped"] = json!(true);
    }
    started
}

// accountId signs a known account in again; without it a new account is made from name.
#[tauri::command]
pub fn accounts_login(app: AppHandle, chats: State<Chats>, accounts: State<Mutex<Accounts>>, options: LoginOptions, output: Channel<Value>) -> Value {
    let o = options;
    if !is_uuid(&o.id) || chats.is_live(&o.id) || !is_size(o.cols) || !is_size(o.rows) {
        return invalid();
    }
    let Some(claude) = find_claude() else {
        return json!({ "error": NO_CLAUDE });
    };
    let a = accounts.lock().unwrap();
    let account = match &o.account_id {
        Some(id) => match a.claude_accounts().into_iter().find(|account| account["id"] == *id) {
            Some(account) => account,
            None => return invalid(),
        },
        None => match a.prepare_account(&o.name) {
            Ok(account) => account,
            Err(error) => return json!({ "error": error.to_string() }),
        },
    };
    let mut command = command(claude, account_env(&a, &account), &a.home);
    drop(a);
    command.args(["auth", "login"]);
    let existing = o.account_id.is_some();
    let result = spawn(&app, &o.id, command, (o.cols, o.rows), None, output, "", move |app, code| {
        let accounts = app.state::<Mutex<Accounts>>();
        let mut a = accounts.lock().unwrap();
        if existing {
            a.clear_emails();
            let _ = accounts::publish(app, &mut a);
        } else if code == 0 && a.finish_account(&account).unwrap_or(false) {
            let _ = accounts::publish(app, &mut a);
            drop(a);
            index::start(app.clone());
        }
    });
    result.map_or_else(|error| error, |()| json!({ "ok": true }))
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
    let mut live = chats.live.lock().unwrap();
    if let Some(chat) = live.get_mut(&id) {
        let _ = chat.killer.kill();
    }
    if let Some(cancelled) = chats.launching.lock().unwrap().get(&id) {
        cancelled.store(true, Ordering::Relaxed);
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

    #[test]
    fn restarts_wait_for_an_idle_indexed_chat() {
        let busy = Duration::from_millis(1999);
        let idle = Duration::from_millis(2000);
        assert!(must_wait(true, true, busy));
        assert!(!must_wait(true, true, idle));
        assert!(!must_wait(true, false, busy), "no restart: only the primary changes");
        assert!(!must_wait(false, true, busy), "not indexed: the switch is refused later instead");
    }
}
