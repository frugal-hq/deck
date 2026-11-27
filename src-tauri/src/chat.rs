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
use crate::procs::Job;

pub fn no_claude() -> String { crate::i18n::t("error.no-claude", &[]) }
// Under a frame, so typing still echoes at once.
const BATCH: Duration = Duration::from_millis(4);
// main.js IDLE_MS: a chat restarts only once Claude has been quiet this long.
const IDLE: Duration = Duration::from_millis(2000);

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
    job: Option<Job>,
    remote: Option<Arc<crate::elevated::Link>>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    info: Option<Info>,
    activity: Arc<Activity>,
    exited: mpsc::Receiver<()>,
}

impl Chat {
    fn kill(&mut self) {
        if !self.job.take().is_some_and(Job::terminate) {
            let _ = self.killer.kill();
        }
    }
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
        let mut live = self.live.lock().unwrap();
        for chat in live.values_mut() {
            chat.kill();
        }
        for cancelled in self.launching.lock().unwrap().values() {
            cancelled.store(true, Ordering::Relaxed);
        }
    }

    // Administrator chats have no job here: the elevated helper sweeps its own.
    pub fn end_idle(&self) {
        for job in self.live.lock().unwrap().values_mut().filter_map(|chat| chat.job.as_mut()) {
            job.end_idle();
        }
    }

    pub fn is_live(&self, id: &str) -> bool {
        self.live.lock().unwrap().contains_key(id)
    }

    pub fn open_accounts(&self) -> HashSet<String> {
        self.live.lock().unwrap().values().filter_map(|chat| Some(chat.info.as_ref()?.account.clone())).collect()
    }

    pub fn account_of(&self, id: &str) -> Option<String> {
        Some(self.live.lock().unwrap().get(id)?.info.as_ref()?.account.clone())
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
    // The user asked for it: restart even with nothing changed, and stop a turn in progress.
    #[serde(default)]
    restart: bool,
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
    argv: Option<Vec<String>>,
    #[serde(default)]
    env: HashMap<String, String>,
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
    json!({ "error": crate::i18n::t("error.invalid-request", &[]) })
}

pub fn find_claude() -> Option<PathBuf> {
    let mut command = Command::new("where.exe");
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x0800_0000); }
    let out = command.arg("claude").output().map(|out| out.stdout).unwrap_or_default();
    String::from_utf8_lossy(&out).lines().filter(|line| !line.is_empty()).find_map(|entry| {
        let entry = Path::new(entry);
        if entry.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("exe")) {
            return Some(entry.to_path_buf());
        }
        let packaged = entry.parent()?.join("node_modules/@anthropic-ai/claude-code/bin/claude.exe");
        packaged.exists().then_some(packaged)
    }).or_else(|| {
        // The native installer puts claude.exe here and leaves PATH alone (code.claude.com/docs/en/troubleshoot-install).
        let native = PathBuf::from(std::env::var_os("USERPROFILE")?).join(".local").join("bin").join("claude.exe");
        native.exists().then_some(native)
    })
}

pub(crate) fn find_cli(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| {
        let names = if cfg!(windows) { vec![format!("{name}.exe"), format!("{name}.cmd"), format!("{name}.bat")] } else { vec![name.to_owned()] };
        names.into_iter().map(|name| dir.join(name)).find(|path| path.is_file())
    }).or_else(|| {
        // The agy installer adds this folder to PATH, but a running Deck keeps the PATH it started with.
        let agy = PathBuf::from(std::env::var_os("LOCALAPPDATA").filter(|_| name == "agy")?).join("agy").join("bin").join("agy.exe");
        agy.is_file().then_some(agy)
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
pub(crate) fn claude_env(accounts: &Accounts, config_dir: Option<&Path>) -> HashMap<String, String> {
    let mut env = clean_env();
    env.insert("FRUGAL_ROLES".into(), if accounts.roles() { "on" } else { "off" }.into());
    if let Some(dir) = config_dir {
        env.insert("CLAUDE_CONFIG_DIR".into(), dir.to_string_lossy().into_owned());
    }
    env
}

pub fn account_env(accounts: &Accounts, account: &Value) -> HashMap<String, String> {
    claude_env(accounts, (account["id"] != MAIN).then(|| Path::new(accounts::string(&account["configDir"]))))
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

fn login_command(exe: PathBuf, args: &[String], env: HashMap<String, String>, cwd: &Path) -> Result<CommandBuilder, Value> {
    let shim = cfg!(windows) && exe.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    if shim && std::iter::once(exe.to_string_lossy().as_ref()).chain(args.iter().map(String::as_str))
        .any(|s| s.contains(['&', '|', '<', '>', '^', '%', '!', '"', '\r', '\n'])) { return Err(invalid()); }
    let mut cmd = if shim {
        let mut cmd = command(PathBuf::from("cmd.exe"), env, cwd);
        cmd.args(["/d", "/c", "call"]);
        cmd.arg(exe);
        cmd
    } else { command(exe, env, cwd) };
    cmd.args(args);
    Ok(cmd)
}

// A bypass or administrator change restarts the chat too, so it waits like an account change; a chat not yet indexed never restarts.
fn must_wait(indexed: bool, restart: bool, quiet: Duration) -> bool {
    indexed && restart && quiet < IDLE
}

// Outside the install folder: Program Files needs admin rights and an update or uninstall could remove it.
#[tauri::command]
pub fn folder_default(chats: tauri::State<Chats>) -> Result<PathBuf, String> {
    let folder = std::env::var_os("USERPROFILE").map(PathBuf::from).ok_or_else(|| crate::i18n::t("error.no-user-folder", &[]))?.join("Frugal Deck").join("Sessions");
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
fn spawn(app: &AppHandle, id: &str, command: CommandBuilder, (cols, rows): (u16, u16), info: Option<Info>, output: Channel<Value>, fail: bool, on_exit: impl FnOnce(&AppHandle, u32) + Send + 'static) -> Result<(), Value> {
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
            .map(|(master, reader, writer, child, link)| (master, reader, writer, child, None, Some(link)))
    } else {
        native_pty_system().openpty(size).map_err(|error| error.to_string()).and_then(|pair| {
            let reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
            let writer = pair.master.take_writer().map_err(|error| error.to_string())?;
            let job = Job::new();
            let child = pair.slave.spawn_command(command).map_err(|error| error.to_string())?;
            let job = job.and_then(|job| job.attach(child.as_ref()));
            Ok((pair.master, reader, writer, child, job, None))
        })
    };
    let mut live = chats.live.lock().unwrap();
    chats.launching.lock().unwrap().remove(id);
    let (master, reader, writer, mut child, job, remote) = started.map_err(|error| json!({ "error": if fail { crate::i18n::t("error.claude-start-failed", &[("error", &error)]) } else { error } }))?;
    if cancelled.load(Ordering::Relaxed) {
        if !job.is_some_and(Job::terminate) {
            let _ = child.kill();
        }
        return Err(json!({ "error": crate::i18n::t("error.chat-closed-before-start", &[]) }));
    }
    let activity = Arc::new(Activity { muted: AtomicBool::new(false), last_output: Mutex::new(Instant::now()) });
    let (done, exited) = mpsc::channel();
    live.insert(id.to_owned(), Chat { job, remote, master, writer, killer: child.clone_killer(), info, activity: activity.clone(), exited });
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
        let mut chat = {
            let chats = app.state::<Chats>();
            let mut live = chats.live.lock().unwrap();
            if activity.muted.load(Ordering::Relaxed) { None } else { Some(live.remove(&id)) }
        };
        // Dropped outside the lock: closing the pseudoconsole waits for its output to drain.
        let replaced = chat.is_none();
        crate::debug_log!("chat", "{id}: process exited with {code}{}", if replaced { ", replaced by an account switch" } else { "" });
        if let Some(job) = chat.as_mut().and_then(|chat| chat.as_mut()).and_then(|chat| chat.job.take()) {
            job.terminate();
        }
        drop(chat);
        let _ = reading.join();
        if !replaced {
            on_exit(&app, code);
            let _ = output.send(json!({ "exit": code }));
        }
    });
    Ok(())
}

fn record_session(id: &str) {
    use std::io::Write;
    let Some(home) = std::env::var_os("USERPROFILE") else { return };
    let file = PathBuf::from(home).join(".frugal-deck").join("sessions.txt");
    let _ = std::fs::OpenOptions::new().create(true).append(true).open(file).and_then(|mut f| writeln!(f, "{id}"));
}

#[tauri::command]
pub fn chat_recorded_sessions() -> Vec<String> {
    let Some(home) = std::env::var_os("USERPROFILE") else { return vec![] };
    let file = PathBuf::from(home).join(".frugal-deck").join("sessions.txt");
    std::fs::read_to_string(file).unwrap_or_default().lines().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

fn chat_plugin_dirs(accounts: &Accounts, account: &Value, states: &Value, picked: Option<&[String]>) -> Vec<PathBuf> {
    let store = accounts.store_dir();
    let installed = accounts::read_json(&store.join("plugins/installed_plugins.json"), json!({}));
    let settings = accounts::read_json(&store.join("settings.json"), json!({}));
    let mut dirs: Vec<_> = accounts.chat_frugal_dir(account).into_iter().collect();
    dirs.extend(crate::plugins::shared_plugin_dirs(&installed, &settings, states, picked));
    dirs
}

// main.js launchChat. The place is the session whose chat sets the group and workspace, the source chat's for a handoff.
#[allow(clippy::too_many_arguments)]
fn launch(app: &AppHandle, id: &str, place: &str, folder: PathBuf, size: (u16, u16), resume: bool, group: &Value, account: &Value, prompt: Option<&str>, bypass: bool, admin: bool, output: Channel<Value>) -> Value {
    let Some(claude) = find_claude() else {
        return json!({ "error": no_claude() });
    };
    let accounts = app.state::<Mutex<Accounts>>();
    let index = app.state::<Index>();
    let (mut env, mouse) = { let a = accounts.lock().unwrap(); (account_env(&a, account), a.mouse()) };
    // Claude Code's fullscreen renderer takes mouse clicks; forcing it also overrides the sticky auto-disable that chats killed while starting leave behind.
    if mouse {
        env.insert("CLAUDE_CODE_NO_FLICKER".into(), "1".into());
    }
    let session = index.session(id).unwrap_or_default();
    let dir = Path::new(account["configDir"].as_str().unwrap_or_default());
    let group = group.as_str().filter(|group| !group.is_empty());
    let prepared = (|| -> Result<_, Box<dyn std::error::Error>> {
        // A folder removed since its sessions ran comes back empty, so they resume and new chats start there.
        std::fs::create_dir_all(&folder)?;
        if account["id"] != MAIN {
            accounts::ensure_onboarded(dir)?;
        }
        if resume {
            let mut file = PathBuf::from(session["file"].as_str().unwrap_or_default());
            if crate::archive::is_copy(&file.to_string_lossy()) {
                let home = accounts.lock().unwrap().home.clone();
                file = crate::archive::restore(&home, &file)?;
            }
            accounts::share_transcript(&file, dir)?;
        }
        let (chat_topic, space) = index.chat_place(place);
        let topic = group.or(chat_topic.as_deref());
        let workspaces = index.workspaces_of(&space, topic, &folder.to_string_lossy());
        let picked = crate::plugins::auto_picks(app, &folder, topic, workspaces.first().map(String::as_str), prompt, resume);
        let accounts = accounts.lock().unwrap();
        let settings = accounts.load();
        let (auto_on, auto_delegates): (Vec<_>, Vec<_>) = accounts::array(&settings["mcpAuto"]).iter().filter_map(Value::as_str).filter(|name| !accounts::is_frugal(name)).map(str::to_owned)
            .partition(|name| picked.as_ref().is_some_and(|picked| picked.contains(name)));
        crate::mcp::share_tokens(&accounts);
        let (allowed, denied, mcp, delegate_only) = accounts.chat_mcp(account["id"].as_str().unwrap_or_default(), &folder, topic, &workspaces, (&auto_on, &auto_delegates))?;
        let plugin_dirs = chat_plugin_dirs(&accounts, account, &settings["pluginStates"], picked.as_deref());
        let store_settings = accounts::read_json(&accounts.store_dir().join("settings.json"), json!({}));
        let enabled = crate::plugins::chat_enabled_plugins(&settings["pluginStates"], picked.as_deref(), &store_settings, &accounts::read_json(&dir.join("settings.json"), json!({})));
        Ok((allowed, denied, mcp, delegate_only, topic.map(str::to_owned), workspaces.first().map(|w| w.to_string()), plugin_dirs, enabled))
    })();
    let (allowed, denied, deck_mcp, delegate_only, deck_group, deck_workspace, plugin_dirs, enabled_plugins) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => return json!({ "error": crate::i18n::t("error.claude-start-failed", &[("error", &error)]) }),
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
    // Read by frugal's commits skill to offer a per-group or per-workspace choice.
    env.insert("FRUGAL_DECK".into(), "1".into());
    // Delegates also get delegate-only Deck configs, while the chat's --mcp-config stays limited to its own servers.
    let mut deck_servers = deck_mcp.as_ref().map_or(json!({}), |config| config["mcpServers"].clone());
    for (name, config) in accounts.lock().unwrap().deck_servers().as_object().into_iter().flatten() {
        if delegate_only.contains(&json!(name)) { deck_servers[name] = config.clone(); }
    }
    env.insert("FRUGAL_DECK_MCP".into(), json!({ "mcpServers": deck_servers, "allowed": allowed, "denied": denied, "delegateOnly": delegate_only }).to_string());
    if let Some(group) = deck_group {
        env.insert("DECK_GROUP".into(), group);
    }
    if let Some(workspace) = deck_workspace {
        env.insert("DECK_WORKSPACE".into(), workspace);
    }
    let voice = crate::voice::anthropic_voice();
    // The Deck's own warning took the consent, so Claude Code's disclaimer is skipped (it reads this key from flag settings too).
    // Claude Code reads voice.enabled before voiceEnabled, and /voice off writes it to user settings. The mic button holds Space, so the mode is hold.
    // Always set: an empty allowlist turns every server off.
    let mut settings = json!({ "statusLine": status["statusLine"], "allowedMcpServers": allowed });
    settings["enabledPlugins"] = enabled_plugins;
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
    // --mcp-config takes several values, so it goes before the other flags and never next to the prompt.
    if let Some(config) = deck_mcp {
        command.args(["--mcp-config", &config.to_string()]);
    }
    command.args([if resume { "--resume" } else { "--session-id" }, id, "--settings", &settings.to_string()]);
    // A chat opened in the Deck belongs to the Deck.
    if let Err(error) = crate::index::mark_deck_session(id) {
        crate::debug_log!("chat", "{id}: could not mark Deck session: {error}");
    }
    for dir in plugin_dirs {
        command.arg("--plugin-dir");
        command.arg(dir);
    }
    // The uninstaller tells sessions started here from Claude Code's own by this list.
    if !resume { record_session(id); }
    if let Some(prompt) = prompt {
        command.arg(prompt);
    }
    if bypass {
        command.arg("--dangerously-skip-permissions");
    }
    crate::debug_log!("chat", "{id}: claude {} in {} on {}, bypass {bypass}, admin {admin}", if resume { "--resume" } else { "--session-id" }, folder.display(), account["id"]);
    let info = Info { account: account["id"].as_str().unwrap_or_default().to_owned(), folder, bypass, admin, voice };
    let exit_token = token.clone();
    let exit_id = id.to_owned();
    if let Err(error) = spawn(app, id, command, size, Some(info), output, true, move |app, _| {
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
    let (account, frugal) = {
        let accounts = accounts.lock().unwrap();
        let account = accounts.primary();
        let frugal = !resume && options.frugal == true && accounts.chat_frugal_dir(&account).is_some();
        (account, frugal)
    };
    let prompt = frugal.then_some("/frugal:frugal");
    // Reopening an archived session brings its whole chat back to the sidebar.
    if let Some(chat) = index.session(&options.id).filter(|s| resume && s["archived"] == true).map(|s| s["chatId"].clone()) {
        let ids: Vec<Value> = index.get("sessions").as_array().into_iter().flatten().filter(|s| s["chatId"] == chat).map(|s| s["id"].clone()).collect();
        let ids = Value::Array(ids);
        index.run(move |db, _| crate::index::save_archived(db, &ids, false));
    }
    let mut started = launch(app, &options.id, &options.id, folder, (options.cols, options.rows), resume, &options.group, &account, prompt, options.bypass == true, options.admin == true, output);
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
    launch(app, &o.id, &o.from, folder, (o.cols, o.rows), false, &Value::Null, &account, Some(text), o.bypass == true, o.admin == true, output)
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
    if !o.restart && must_wait(session.is_some(), moving || flags_changed, chat.activity.last_output.lock().unwrap().elapsed()) {
        return json!({ "error": crate::i18n::t("error.claude-busy-switch", &[]) });
    }
    // A bypass or administrator toggle restarts on the chat's own account, which is no reason to make it the primary.
    if moving || (!flags_changed && !o.restart) {
        let accounts = app.state::<Mutex<Accounts>>();
        let mut a = accounts.lock().unwrap();
        if let Err(error) = a.set_primary(&account_id).and_then(|()| accounts::publish(app, &mut a)) {
            return json!({ "error": error.to_string() });
        }
        drop(a);
        accounts::read_now(app, &account_id);
    }
    if !moving && !flags_changed && !o.restart {
        return json!({ "ok": true, "account": account_id });
    }
    let Some(session) = session else {
        // A chat with no message yet has nothing to resume; it keeps running as it started.
        if o.restart && !moving && !flags_changed {
            return json!({ "ok": true, "account": account_id });
        }
        return json!({ "error": crate::i18n::t("error.switch-needs-first-message", &[]) });
    };
    let mut chat = live.remove(&o.id).unwrap();
    chat.activity.muted.store(true, Ordering::Relaxed);
    drop(live);
    chat.kill();
    let _ = chat.exited.recv();
    drop(chat);
    let _ = app.emit("chat:restarting", [&o.id]);
    let folder = session["cwd"].as_str().map(PathBuf::from).unwrap_or_default();
    let mut started = launch(app, &o.id, &o.id, folder, (o.cols, o.rows), true, &Value::Null, &account, None, bypass, admin, output);
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
    if let Some(argv) = o.argv {
        if !argv.first().is_some_and(|s| matches!(s.as_str(), "codex" | "grok" | "opencode" | "claude" | "agy")) ||
            argv.iter().any(|s| s.contains('\0')) || o.env.iter().any(|(key, value)| !matches!(key.as_str(), "CLAUDE_CONFIG_DIR" | "CODEX_HOME" |
                "GROK_HOME" | "XDG_DATA_HOME" | "USERPROFILE" | "HOME" | "AGY_CLI_FORCE_FILE_TOKEN_STORAGE") || value.contains('\0')) {
            return invalid();
        }
        let Some(exe) = find_cli(&argv[0]) else { return json!({"error": crate::i18n::t("error.not-found-in-path", &[("name", &argv[0])])}); };
        let mut env = clean_env();
        env.extend(o.env);
        let cmd = match login_command(exe, &argv[1..], env, &accounts.lock().unwrap().home) {
            Ok(cmd) => cmd,
            Err(error) => return error,
        };
        return spawn(&app, &o.id, cmd, (o.cols, o.rows), None, output, false, |_, _| {})
            .map_or_else(|error| error, |()| json!({"ok": true}));
    }
    let Some(claude) = find_claude().or_else(|| find_cli("claude")) else {
        return json!({ "error": no_claude() });
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
    let command = match login_command(claude, &["auth".into(), "login".into()], account_env(&a, &account), &a.home) {
        Ok(command) => command,
        Err(error) => return error,
    };
    drop(a);
    let existing = o.account_id.is_some();
    let login_id = o.id.clone();
    let result = spawn(&app, &o.id, command, (o.cols, o.rows), None, output, false, move |app, code| {
        let accounts = app.state::<Mutex<Accounts>>();
        let mut a = accounts.lock().unwrap();
        if existing {
            a.clear_emails();
            let _ = accounts::publish(app, &mut a);
        } else {
            let result = if code == 0 { a.finish_account(&account).map_err(|e| e.to_string()) } else { Ok(false) };
            let error = match result {
                Ok(true) => {
                    let _ = accounts::publish(app, &mut a);
                    drop(a);
                    index::start(app.clone());
                    None
                },
                Ok(false) => Some("Sign-in did not finish.".to_owned()),
                Err(error) => Some(error),
            };
            let _ = app.emit("account-login-finished", [json!({"id": login_id, "error": error})]);
        }
    });
    result.map_or_else(|error| error, |()| json!({ "ok": true }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpLoginOptions {
    id: String,
    account_id: String,
    folder: Option<String>,
    deck_server: Option<String>,
    cols: u16,
    rows: u16,
}

// An MCP server's sign-in window: Claude Code on the account, opening /mcp. A Deck server is the only server loaded, the way chats load it,
// so its token is the one chats use. frugal: if /mcp alone leaves a session in the account's history, pass --session-id and delete it on exit.
#[tauri::command]
pub fn mcp_login(app: AppHandle, chats: State<Chats>, accounts: State<Mutex<Accounts>>, options: McpLoginOptions, output: Channel<Value>) -> Value {
    let o = options;
    if !is_uuid(&o.id) || chats.is_live(&o.id) || !is_size(o.cols) || !is_size(o.rows) {
        return invalid();
    }
    let Some(claude) = find_claude() else {
        return json!({ "error": no_claude() });
    };
    let a = accounts.lock().unwrap();
    let Some(account) = a.claude_accounts().into_iter().find(|account| account["id"] == o.account_id.as_str()) else {
        return invalid();
    };
    let folder = match &o.folder {
        Some(folder) if accounts::mcp_scope(&json!({ "folder": folder })).is_some() => PathBuf::from(folder),
        Some(_) => return invalid(),
        None => a.home.clone(),
    };
    let mut command = command(claude, account_env(&a, &account), &folder);
    if let Some(name) = &o.deck_server {
        let config = a.deck_servers()[name.as_str()].clone();
        if !config.is_object() {
            return invalid();
        }
        command.args(["--mcp-config", &json!({ "mcpServers": { name.as_str(): config } }).to_string(), "--strict-mcp-config"]);
    }
    drop(a);
    command.arg("/mcp");
    spawn(&app, &o.id, command, (o.cols, o.rows), None, output, false, |_, _| {}).map_or_else(|error| error, |()| json!({ "ok": true }))
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
        chat.kill();
    }
    if let Some(cancelled) = chats.launching.lock().unwrap().get(&id) {
        cancelled.store(true, Ordering::Relaxed);
    }
}

async fn process_request(app: AppHandle, id: String, target: Option<(u32, Option<u64>)>) -> Result<Value, String> {
    if !is_uuid(&id) || target.is_some_and(|(pid, _)| pid == 0) {
        return Err(crate::i18n::t("error.invalid-chat-or-pid", &[]));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let chats = app.state::<Chats>();
        let remote = {
            let mut live = chats.live.lock().map_err(|error| error.to_string())?;
            let chat = live.get_mut(&id).ok_or_else(|| crate::i18n::t("error.chat-not-live", &[]))?;
            if let Some(job) = &mut chat.job {
                return match target {
                    Some((pid, started_ms)) => job.kill(pid, started_ms),
                    None => job.processes(),
                };
            }
            chat.remote.clone().ok_or_else(|| crate::i18n::t("error.chat-no-process-job", &[]))?
        };
        remote.process_request(target)
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn chat_processes(app: AppHandle, id: String) -> Result<Value, String> {
    process_request(app, id, None).await
}

#[tauri::command]
pub async fn chat_process_kill(app: AppHandle, id: String, pid: u32, started_ms: Option<u64>) -> Result<Value, String> {
    process_request(app, id, Some((pid, started_ms))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{string, tests::TempDir, write_json};

    #[test]
    fn chat_plugins_use_the_store_and_only_fall_back_to_the_chat_accounts_frugal() {
        let temp = TempDir::new();
        let accounts = Accounts::new(temp.0.clone(), temp.0.join(".codex"));
        let main = accounts.primary();
        let side = accounts.prepare_account(&json!("Side")).unwrap();
        let main_dir = Path::new(string(&main["configDir"]));
        let side_dir = Path::new(string(&side["configDir"]));
        let install = |config: &Path, entries: &[(&str, &str)]| {
            let plugins: serde_json::Map<_, _> = entries.iter().map(|&(id, name)| {
                let path = config.join("plugins/cache").join(name);
                std::fs::create_dir_all(&path).unwrap();
                (id.to_owned(), json!([{"installPath": path}]))
            }).collect();
            write_json(&config.join("plugins/installed_plugins.json"), &json!({"plugins": plugins})).unwrap();
            write_json(&config.join("settings.json"), &json!({"enabledPlugins": {"other@m": true}})).unwrap();
        };
        let dirs = |account: &Value| chat_plugin_dirs(&accounts, account, &Value::Null, None);
        assert!(dirs(&main).is_empty());
        install(main_dir, &[("frugal@frugal", "main-frugal"), ("other@m", "main-other")]);
        assert!(dirs(&side).is_empty());
        assert_eq!(dirs(&main), [main_dir.join("plugins/cache/main-frugal")]);
        install(side_dir, &[("frugal@frugal", "side-frugal"), ("other@m", "side-other")]);
        assert_eq!(dirs(&side), [side_dir.join("plugins/cache/side-frugal")]);
        std::fs::write(side_dir.join(".credentials.json"), r#"{"claudeAiOauth":{"accessToken":"t"}}"#).unwrap();
        assert!(accounts.finish_account(&side).unwrap());
        accounts.set_primary(string(&side["id"])).unwrap();
        let store = temp.0.join(".frugal-deck/store");
        install(&store, &[("frugal@frugal", "deck-frugal"), ("other@m", "deck-other"), ("disabled@m", "disabled")]);
        let expected = [store.join("plugins/cache/deck-frugal"), store.join("plugins/cache/deck-other")];
        assert_eq!(accounts.primary()["id"], side["id"]);
        assert_eq!(dirs(&accounts.primary()), expected);
        assert_eq!(dirs(&main), expected);
    }

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
