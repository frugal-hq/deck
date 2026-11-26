// Frugal Deck's setup: a window in the Deck's style around the NSIS installer from `cargo tauri build`, which runs silently inside it.
// With --uninstall it is also the uninstaller Windows opens (installer.nsh copies it beside the Deck), with the data choices.
#![windows_subsystem = "windows"]

mod consolidation;
#[path = "../../src-tauri/src/i18n.rs"]
mod i18n;

use consolidation::*;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{webview::Color, AppHandle, Emitter, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

const NSIS: &[u8] = include_bytes!(env!("DECK_NSIS"));
const VERSION: &str = env!("DECK_VERSION");
const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Frugal Deck";
// ShellExecuteEx's error when the administrator prompt is refused.
const CANCELLED: i32 = 0x8007_04C7_u32 as i32;
// The Deck's "Keep transcripts" value in each account's settings.json (accounts.rs KEEP_DAYS).
const KEEP_DAYS: i64 = 3650;

// The install folder when this runs as the uninstaller, from --from (set by the copy in %TEMP%).
static UNINSTALL_FROM: OnceLock<PathBuf> = OnceLock::new();

fn folder() -> PathBuf {
    std::env::temp_dir().join("frugal-deck-setup")
}

fn write_nsis() -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(folder())?;
    let file = folder().join(format!("Frugal Deck_{VERSION}_x64-setup.exe"));
    std::fs::write(&file, NSIS)?;
    Ok(file)
}

// The install NSIS would update, per user first, with its version.
fn installed() -> Option<Value> {
    [("HKCU", "user"), ("HKLM", "machine")].into_iter().find_map(|(root, mode)| {
        let output = Command::new(system32("reg.exe")).args(["query", &format!("{root}\\{UNINSTALL_KEY}"), "/v", "DisplayVersion", "/reg:64"]).creation_flags(NO_WINDOW).output().ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        let version = text.lines().find(|line| line.contains("DisplayVersion"))?.split_whitespace().last()?.to_owned();
        output.status.success().then(|| json!({ "mode": mode, "version": version }))
    })
}

// The installer asks for administrator rights in its manifest, which CreateProcess refuses and ShellExecute prompts for.
fn run(file: &Path, args: &str) -> windows_core::Result<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows_core::{HSTRING, PCWSTR};
    let (file, args, dir) = (HSTRING::from(file), HSTRING::from(args), HSTRING::from(folder().as_path()));
    let mut info = SHELLEXECUTEINFOW {
        cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(args.as_ptr()),
        lpDirectory: PCWSTR(dir.as_ptr()),
        ..Default::default()
    };
    let mut code = 0;
    unsafe {
        ShellExecuteExW(&mut info)?;
        WaitForSingleObject(info.hProcess, INFINITE);
        let exit = GetExitCodeProcess(info.hProcess, &mut code);
        let _ = CloseHandle(info.hProcess);
        exit?;
    }
    Ok(code)
}

fn documents() -> Option<PathBuf> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{SHGetKnownFolderPath, FOLDERID_Documents, KF_FLAG_DEFAULT};
    unsafe {
        let path = SHGetKnownFolderPath(&FOLDERID_Documents, KF_FLAG_DEFAULT, None).ok()?;
        let text = path.to_string().ok();
        CoTaskMemFree(Some(path.0 as _));
        text.map(PathBuf::from)
    }
}

// The sessions the Deck started (chat.rs record_session); older ones count as Claude Code's.
fn deck_ids(home: &Path) -> HashSet<String> {
    std::fs::read_to_string(home.join(".frugal-deck").join("sessions.txt")).unwrap_or_default()
        .lines().map(|line| line.trim().to_owned()).filter(|line| !line.is_empty()).collect()
}

fn index_files(home: &Path) -> Vec<PathBuf> {
    let deck = home.join(".frugal-deck");
    ["deck.db", "deck.db-wal", "deck.db-shm", "sessions.txt"].iter().map(|name| deck.join(name)).collect()
}

// The Deck's settings: its own and the renderer's (ui.json), the WebView2 folder that holds localStorage, and the voice models.
fn settings_paths(home: &Path) -> Vec<PathBuf> {
    let deck = home.join(".frugal-deck");
    let mut paths = vec![deck.join("settings.json"), deck.join("ui.json")];
    if let Some(roaming) = std::env::var_os("APPDATA").map(PathBuf::from) {
        paths.push(roaming.join("hq.frugal.deck"));
        paths.push(roaming.join("frugal-deck"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        paths.push(local.join("hq.frugal.deck"));
    }
    paths
}

fn ui_file(home: &Path) -> PathBuf {
    home.join(".frugal-deck").join("ui.json")
}

// What an earlier install left, for the installer's notice and the uninstaller's choices.
fn data(home: &Path) -> Value {
    let ids = deck_ids(home);
    let (mut deck, mut claude) = ((0, 0), (0, 0));
    for (id, paths) in sessions(home) {
        let bytes: u64 = paths.iter().map(|p| size(p)).sum();
        let total = if ids.contains(&id) { &mut deck } else { &mut claude };
        *total = (total.0 + 1, total.1 + bytes);
    }
    let index = index_files(home);
    let groups = index[0].is_file().then(|| index.iter().map(|p| size(p)).sum::<u64>());
    let settings = settings_paths(home).iter().any(|p| p.exists());
    json!({
        "deck": { "count": deck.0, "bytes": deck.1 },
        "claude": { "count": claude.0, "bytes": claude.1 },
        "groups": groups.map(|bytes| json!({ "bytes": bytes })),
        "settings": settings,
        "language": read_json(&ui_file(home)).and_then(|ui| ui["language"].as_str().map(str::to_owned)),
    })
}

// The folders the installer picks by itself (MultiUser.nsh in installer.nsi): %LOCALAPPDATA%\Programs per user, Program Files for everyone.
fn folders() -> Value {
    let var = |name: &str| std::env::var(name).ok();
    json!({
        "user": var("LOCALAPPDATA").map(|dir| format!(r"{dir}\Programs\Frugal Deck")),
        "machine": var("ProgramFiles").map(|dir| format!(r"{dir}\Frugal Deck")),
        "programFiles": var("ProgramFiles"),
    })
}

#[tauri::command]
async fn info() -> Value {
    let uninstall = UNINSTALL_FROM.get().map(|dir| dir.to_string_lossy().into_owned());
    let home = home().ok();
    json!({
        "version": VERSION,
        "installed": installed(),
        "uninstall": uninstall,
        "data": home.as_ref().map(|h| data(h)),
        "folders": folders(),
        "consolidation": home.as_ref().is_some_and(|h| consolidation_file(h).is_file()),
        "opencode": {
            "installed": find_cli("opencode").is_some(),
            "accounts": home.as_ref().is_some_and(|h| frugal_accounts(h).iter().any(|a| a["kind"] == "opencode")),
        },
    })
}

// Same lookup as the Deck's chat.rs find_cli.
fn find_cli(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| {
        [format!("{name}.exe"), format!("{name}.cmd"), format!("{name}.bat")].into_iter().map(|name| dir.join(name)).find(|path| path.is_file())
    })
}

fn frugal_accounts(home: &Path) -> Vec<Value> {
    read_json(&home.join(".frugal/accounts.json")).and_then(|data| data["accounts"].as_array().cloned()).unwrap_or_default()
}

// Models that may train on data; frugal blocks them unless training is turned on (server.py TRAINING_MODELS).
const TRAINING_MODELS: &[&str] = &["big-pickle", "mimo", "flint", "iceman", "inkling", "nemotron"];

// Up to two free models from `opencode models opencode` as (account id, provider/model), skipping blocked ones
// and those an account already has by id or model.
fn pick_free_models(listing: &str, accounts: &[Value]) -> Vec<(String, String)> {
    let mut picked: Vec<(String, String)> = Vec::new();
    for line in listing.lines() {
        let Some(model) = line.split_whitespace().next().map(|m| m.strip_prefix("opencode/").unwrap_or(m)) else { continue };
        let lower = model.to_ascii_lowercase();
        let Some(base) = lower.strip_suffix("-free").or_else(|| lower.strip_suffix(":free")) else { continue };
        if model.starts_with('-') || model.contains('/') || TRAINING_MODELS.iter().any(|t| lower.contains(t)) { continue; }
        let slug = base.split(|c: char| !c.is_ascii_alphanumeric()).filter(|part| !part.is_empty()).collect::<Vec<_>>().join("-");
        let id = format!("oc-{slug}").chars().take(32).collect::<String>().trim_end_matches('-').to_owned();
        let full = format!("opencode/{model}");
        if slug.is_empty() || picked.iter().any(|(i, m)| *i == id || *m == full)
            || accounts.iter().any(|a| a["id"] == id.as_str() || a["model"] == full.as_str()) { continue; }
        picked.push((id, full));
        if picked.len() == 2 { break; }
    }
    picked
}

// Runs a command with its output appended to the setup's log; the last line of output is the error when it fails.
fn logged(command: &mut Command, timeout: Duration) -> Result<String, String> {
    std::fs::create_dir_all(folder()).map_err(|e| e.to_string())?;
    let log = folder().join("opencode.log");
    let file = std::fs::OpenOptions::new().create(true).append(true).open(&log).map_err(|e| e.to_string())?;
    let start_len = file.metadata().map(|m| m.len() as usize).unwrap_or(0);
    let out = file.try_clone().map_err(|e| e.to_string())?;
    let mut child = command.env("NO_COLOR", "1").stdin(Stdio::null()).stdout(out).stderr(file).creation_flags(NO_WINDOW).spawn().map_err(|e| e.to_string())?;
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { break status; }
        if start.elapsed() > timeout {
            let _ = child.kill();
            return Err(i18n::t("error.command-timed-out", &[]));
        }
        std::thread::sleep(Duration::from_millis(250));
    };
    let bytes = std::fs::read(&log).unwrap_or_default();
    let output = String::from_utf8_lossy(bytes.get(start_len..).unwrap_or_default()).into_owned();
    if status.success() { return Ok(output); }
    Err(output.lines().map(str::trim).filter(|line| !line.is_empty()).last().map(str::to_owned)
        .unwrap_or_else(|| i18n::t("account.error.command-exit", &[("code", &status.code().unwrap_or(1))])))
}

// Runs after the Deck and Import and clean, so frugal is in the store or the main account. Returns the account ids added.
#[tauri::command]
async fn install_opencode() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let home = home()?;
        let frugal = [home.join(".frugal-deck/store"), home.join(".claude")].iter().find_map(|dir| {
            let install = read_json(&dir.join("plugins/installed_plugins.json"))?;
            Some(PathBuf::from(install["plugins"]["frugal@frugal"][0]["installPath"].as_str()?)).filter(|dir| dir.is_dir())
        });
        let script = frugal.ok_or_else(|| i18n::t("error.install-frugal-first", &[]))?.join("accounts/server.py");
        if find_cli("opencode").is_none() {
            let npm = find_cli("npm").ok_or_else(|| i18n::t("error.install-node-first", &[]))?;
            logged(Command::new(npm).args(["install", "-g", "opencode-ai"]), Duration::from_secs(600))?;
        }
        // npm's global folder is on PATH wherever npm is; the fallback is the default one.
        let opencode = find_cli("opencode").unwrap_or_else(|| PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join(r"npm\opencode.cmd"));
        let listing = logged(Command::new(opencode).args(["models", "opencode"]), Duration::from_secs(120))?;
        let mut added = Vec::new();
        for (id, model) in pick_free_models(&listing, &frugal_accounts(&home)) {
            logged(Command::new("python").arg("-u").arg(&script).args(["add", "opencode", &id, &model]), Duration::from_secs(120))?;
            added.push(id);
        }
        Ok(json!({ "added": added, "accounts": frugal_accounts(&home).iter().any(|a| a["kind"] == "opencode") }))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn window_title(uninstalling: bool) -> String {
    i18n::t(if uninstalling { "setup.remove.title" } else { "setup.title" }, &[])
}

#[tauri::command]
fn set_language(window: WebviewWindow, language: String) -> Result<(), String> {
    i18n::set_language(&language);
    window.set_title(&window_title(UNINSTALL_FROM.get().is_some())).map_err(|error| error.to_string())
}

// The installer's choices go in ui.json, which the Deck reads into localStorage on its first start.
#[tauri::command]
fn set_ui(key: String, value: String) -> Result<(), String> {
    match key.as_str() {
        "language" if !value.is_empty() && value.len() <= 16 && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') => {}
        "language" => return Err(i18n::t("setup.error.unknown-language", &[])),
        "showExternal" if value == "true" || value == "false" => {}
        _ => return Err(i18n::t("setup.error.unknown-setting", &[])),
    }
    let file = ui_file(&home()?);
    let mut ui = read_json(&file).filter(Value::is_object).unwrap_or_else(|| json!({}));
    ui[&key] = json!(value);
    write_json(&file, &ui).map_err(|error| error.to_string())?;
    if key == "language" { i18n::set_language(&value); }
    Ok(())
}

// The folder picker; the chosen folder always ends in "Frugal Deck".
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder()).await.ok()??;
    let path = picked.into_path().ok()?;
    let path = if path.file_name().is_some_and(|name| name == "Frugal Deck") { path } else { path.join("Frugal Deck") };
    Some(path.to_string_lossy().into_owned())
}

// NSIS reads /D= to the end of the line, unquoted, so the path must be plain.
fn valid_folder(folder: &str) -> Result<(), String> {
    if folder.len() > 240 || folder.contains('"') || folder.chars().any(char::is_control) || !Path::new(folder).is_absolute() {
        return Err(i18n::t("setup.error.invalid-folder", &[]));
    }
    Ok(())
}

#[tauri::command]
async fn install(everyone: bool, open: bool, folder: Option<String>) -> Result<(), String> {
    if let Some(folder) = &folder { valid_folder(folder)?; }
    tauri::async_runtime::spawn_blocking(move || {
        let nsis = write_nsis().map_err(|error| error.to_string())?;
        // An existing install keeps its mode and folder; /R opens the Deck as the user once it is in place.
        let mode = if installed().is_some() { "" } else if everyone { " /AllUsers" } else { " /CurrentUser" };
        // /SETUP= lets installer.nsh copy this exe beside the Deck as its uninstaller.
        let setup = std::env::current_exe().map(|exe| format!(" /SETUP=\"{}\"", exe.display())).unwrap_or_default();
        // /D= must come last and unquoted; an existing install keeps its folder.
        let target = folder.filter(|_| installed().is_none()).map(|folder| format!(" /D={folder}")).unwrap_or_default();
        let result = run(&nsis, &format!("/S{mode}{}{setup}{target}", if open { " /R" } else { "" }));
        let _ = std::fs::remove_file(&nsis);
        match result {
            Ok(0) => Ok(()),
            Ok(code) => Err(i18n::t("setup.error.installer-exit", &[("code", &code)])),
            Err(error) if error.code().0 == CANCELLED => Err(i18n::t("error.administrator-permission-not-granted", &[])),
            Err(error) => Err(error.message()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

fn free_name(dir: &Path) -> PathBuf {
    let mut file = dir.join("Frugal Deck backup.zip");
    for n in 2.. {
        if !file.exists() { break; }
        file = dir.join(format!("Frugal Deck backup ({n}).zip"));
    }
    file
}

// Order: close the Deck, back up, remove the program, then the data. A failed backup or a refused administrator
// prompt stops before anything is deleted.
#[tauri::command(rename = "uninstall")]
async fn uninstall_command(app: AppHandle, deck: bool, claude: bool, groups: bool, settings: bool, backup: bool, restore: Option<bool>) -> Result<Value, String> {
    uninstall(app, deck, claude, groups, settings, backup, restore.unwrap_or(false)).await
}

async fn uninstall(app: AppHandle, deck: bool, claude: bool, groups: bool, settings: bool, backup: bool, restore: bool) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = home()?;
        let step = |name: &str| { let _ = app.emit("step", name); };

        step("close");
        let _ = Command::new(system32("taskkill.exe")).args(["/F", "/T", "/IM", "frugal-deck.exe"]).creation_flags(NO_WINDOW).status();
        std::thread::sleep(Duration::from_millis(500));

        if restore { restore_config()?; }

        let ids = deck_ids(&home);
        let doomed: Vec<PathBuf> = sessions(&home).into_iter()
            .filter(|(id, _)| if ids.contains(id) { deck } else { claude })
            .flat_map(|(_, paths)| paths).collect();

        let mut saved = None;
        if backup {
            step("backup");
            let dir = documents().unwrap_or_else(|| home.clone());
            let zip = free_name(&dir);
            // Paths relative to home, one per line, for tar -T: the Deck's folder (index, archive, settings) and the sessions to delete.
            let deck_dir = home.join(".frugal-deck");
            let mut list: Vec<String> = Vec::new();
            if deck_dir.exists() { list.push(".frugal-deck".into()); }
            list.extend(doomed.iter().filter(|p| !p.starts_with(&deck_dir)).filter_map(|p| p.strip_prefix(&home).ok()).map(|p| p.to_string_lossy().into_owned()));
            if !list.is_empty() {
                std::fs::create_dir_all(folder()).map_err(|e| e.to_string())?;
                let list_file = folder().join("backup-list.txt");
                create_zip(&home, &zip, &list_file, &list)?;
                saved = Some(zip.to_string_lossy().into_owned());
            }
        }

        if let Some(dir) = UNINSTALL_FROM.get() {
            step("program");
            let deck_exe = dir.join("frugal-deck.exe");
            match run(&dir.join("uninstall.exe"), "/S") {
                Ok(_) => {}
                Err(error) if error.code().0 == CANCELLED => return Err(i18n::t("setup.error.uninstall-permission-denied", &[])),
                Err(error) => return Err(i18n::t("setup.error.program-removal", &[("error", &error.message())])),
            }
            // uninstall.exe hands over to a copy of itself and exits at once, so wait for the Deck to be gone.
            let start = Instant::now();
            while deck_exe.exists() {
                if start.elapsed() > Duration::from_secs(120) {
                    return Err(i18n::t("setup.error.program-removal-timeout", &[]));
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        }

        step("data");
        let mut errors = Vec::new();
        for path in &doomed { remove(path, &mut errors); }
        // Project folders left empty go too; a project's memory/ or other files keep it.
        for dir in claude_dirs(&home) {
            for project in entries(&dir.join("projects")) { let _ = std::fs::remove_dir(project); }
        }
        if groups { for path in index_files(&home) { remove(&path, &mut errors); } }
        if settings { for path in settings_paths(&home) { remove(&path, &mut errors); } }
        // Only the Deck's own value; Claude Code goes back to deleting transcripts idle for 30 days.
        for dir in claude_dirs(&home) {
            let file = dir.join("settings.json");
            if let Some(mut config) = read_json(&file).filter(|c| c["cleanupPeriodDays"].as_i64() == Some(KEEP_DAYS)) {
                config.as_object_mut().unwrap().remove("cleanupPeriodDays");
                if let Err(error) = write_json(&file, &config) { errors.push(path_error(&file, error)); }
            }
        }
        if deck && claude { remove(&home.join(".frugal-deck").join("archive"), &mut errors); }
        let _ = std::fs::remove_dir(home.join(".frugal-deck"));

        step("done");
        Ok(json!({ "backup": saved, "errors": errors }))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn reveal(path: String) {
    let _ = Command::new("explorer.exe").raw_arg(format!("/select,\"{path}\"")).spawn();
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let uninstalling = args.iter().any(|arg| arg == "--uninstall");
    if uninstalling {
        match args.iter().position(|arg| arg == "--from").and_then(|i| args.get(i + 1)) {
            Some(dir) => { let _ = UNINSTALL_FROM.set(PathBuf::from(dir)); }
            // Started from the install folder: run from a copy in %TEMP%, so uninstall.exe can remove that folder.
            None => {
                if let Some(dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)) {
                    let copy = folder().join("Frugal Deck Uninstall.exe");
                    let copied = std::fs::create_dir_all(folder()).and_then(|_| std::fs::copy(std::env::current_exe().unwrap(), &copy));
                    if copied.is_ok() && Command::new(&copy).arg("--uninstall").arg("--from").arg(&dir).spawn().is_ok() {
                        return;
                    }
                    let _ = UNINSTALL_FROM.set(dir);
                }
            }
        }
    }
    // Without WebView2 this window cannot draw, so the plain installer or uninstaller runs (the installer installs WebView2 first).
    if tauri::webview_version().is_err() {
        if let Some(dir) = UNINSTALL_FROM.get() {
            let _ = run(&dir.join("uninstall.exe"), "");
        } else if let Ok(nsis) = write_nsis() {
            let _ = run(&nsis, "");
        }
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "setup", WebviewUrl::default())
                .title(window_title(uninstalling))
                .inner_size(600.0, 560.0)
                .resizable(false)
                .maximizable(false)
                .decorations(false)
                .center()
                .background_color(Color(0x14, 0x17, 0x1b, 0xff))
                .data_directory(folder().join("webview"))
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![info, consolidation::inventory, consolidation::consolidate, consolidation::restore, set_language, set_ui, pick_folder, install, install_opencode, uninstall_command, reveal, quit])
        .run(tauri::generate_context!())
        .expect("Frugal Deck Setup failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_free_unblocked_models() {
        let listing = "opencode/big-pickle-free\nopencode/gpt-5-nano\nopencode/mimo-v2-free\nopencode/glm-5.3-flash-free\n\nopencode/beam-free\nopencode/qwen:free\n";
        let accounts = [json!({ "id": "oc-glm-5-3-flash", "kind": "opencode" })];
        assert_eq!(pick_free_models(listing, &accounts), [
            ("oc-beam".to_owned(), "opencode/beam-free".to_owned()),
            ("oc-qwen".to_owned(), "opencode/qwen:free".to_owned()),
        ]);
        let accounts = [json!({ "id": "oc-glm-5.3-flash", "model": "opencode/glm-5.3-flash-free" }), json!({ "id": "oc-beam" })];
        assert_eq!(pick_free_models(listing, &accounts), [("oc-qwen".to_owned(), "opencode/qwen:free".to_owned())]);
        assert_eq!(pick_free_models("glm-5.3-flash-free\nError: unexpected\n", &[]), [("oc-glm-5-3-flash".to_owned(), "opencode/glm-5.3-flash-free".to_owned())]);
    }
}
