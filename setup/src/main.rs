// Frugal Deck's setup: a window in the Deck's style around the NSIS installer from `cargo tauri build`, which runs silently inside it.
// With --uninstall it is also the uninstaller Windows opens (installer.nsh copies it beside the Deck), with the data choices.
#![windows_subsystem = "windows"]

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{webview::Color, AppHandle, Emitter, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

const NSIS: &[u8] = include_bytes!(env!("DECK_NSIS"));
const VERSION: &str = env!("DECK_VERSION");
const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Frugal Deck";
const NO_WINDOW: u32 = 0x0800_0000;
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

fn system32(exe: &str) -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("System32").join(exe)
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

fn home() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE").map(PathBuf::from).ok_or_else(|| "No user folder.".to_owned())
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

// Claude Code's config folders: ~/.claude and the ~/.claude-<name> of other accounts.
fn claude_dirs(home: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(home) else { return Vec::new() };
    entries.flatten().filter(|entry| {
        let name = entry.file_name().to_string_lossy().into_owned();
        (name == ".claude" || name.starts_with(".claude-")) && entry.path().is_dir()
    }).map(|entry| entry.path()).collect()
}

fn entries(dir: &Path) -> impl Iterator<Item = PathBuf> {
    std::fs::read_dir(dir).into_iter().flatten().flatten().map(|entry| entry.path())
}

fn walk(dir: &Path, files: &mut Vec<PathBuf>) {
    for path in entries(dir) {
        if path.is_dir() { walk(&path, files) } else { files.push(path) }
    }
}

fn size(path: &Path) -> u64 {
    if path.is_dir() { entries(path).map(|p| size(&p)).sum() } else { std::fs::metadata(path).map_or(0, |m| m.len()) }
}

// Every session on disk by id: its transcript in an account's projects/<project>/, the <id>/ folder beside it
// (subagents, tool results) and the Deck's archive copy, ~/.frugal-deck/archive/<path relative to home>.gz.
fn sessions(home: &Path) -> HashMap<String, Vec<PathBuf>> {
    let mut found: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for dir in claude_dirs(home) {
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
    let mut copies = Vec::new();
    walk(&home.join(".frugal-deck").join("archive"), &mut copies);
    for path in copies {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if let Some(id) = name.strip_suffix(".jsonl.gz") { found.entry(id.to_owned()).or_default().push(path); }
    }
    found
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

fn read_json(file: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()
}

fn write_json(file: &Path, value: &Value) -> std::io::Result<()> {
    std::fs::create_dir_all(file.parent().unwrap())?;
    let temporary = file.with_extension("json.tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(temporary, file)
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
fn info() -> Value {
    let uninstall = UNINSTALL_FROM.get().map(|dir| dir.to_string_lossy().into_owned());
    json!({ "version": VERSION, "installed": installed(), "uninstall": uninstall, "data": home().map(|h| data(&h)).ok(), "folders": folders() })
}

// The installer's choices go in ui.json, which the Deck reads into localStorage on its first start.
#[tauri::command]
fn set_ui(key: String, value: String) -> Result<(), String> {
    match key.as_str() {
        "language" if !value.is_empty() && value.len() <= 16 && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') => {}
        "language" => return Err("Unknown language.".into()),
        "showExternal" if value == "true" || value == "false" => {}
        _ => return Err("Unknown setting.".into()),
    }
    let file = ui_file(&home()?);
    let mut ui = read_json(&file).filter(Value::is_object).unwrap_or_else(|| json!({}));
    ui[key] = json!(value);
    write_json(&file, &ui).map_err(|error| error.to_string())
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
        return Err("That install folder cannot be used.".into());
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
            Ok(code) => Err(format!("The installer stopped with code {code}.")),
            Err(error) if error.code().0 == CANCELLED => Err("Windows administrator permission was not granted.".to_owned()),
            Err(error) => Err(error.message()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

fn remove(path: &Path, errors: &mut Vec<String>) {
    let result = if path.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
    if let Err(error) = result {
        if error.kind() != std::io::ErrorKind::NotFound { errors.push(format!("{}: {error}", path.display())); }
    }
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
#[tauri::command]
async fn uninstall(app: AppHandle, deck: bool, claude: bool, groups: bool, settings: bool, backup: bool) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = home()?;
        let step = |name: &str| { let _ = app.emit("step", name); };

        step("close");
        let _ = Command::new(system32("taskkill.exe")).args(["/F", "/T", "/IM", "frugal-deck.exe"]).creation_flags(NO_WINDOW).status();
        std::thread::sleep(Duration::from_millis(500));

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
                std::fs::write(&list_file, list.join("\n")).map_err(|e| e.to_string())?;
                let output = Command::new(system32("tar.exe")).arg("-a").arg("-c").arg("-f").arg(&zip).arg("-C").arg(&home).arg("-T").arg(&list_file)
                    .creation_flags(NO_WINDOW).output().map_err(|e| format!("The backup could not start, so nothing was removed: {e}"))?;
                let _ = std::fs::remove_file(&list_file);
                if !output.status.success() {
                    let _ = std::fs::remove_file(&zip);
                    return Err(format!("The backup failed, so nothing was removed. {}", String::from_utf8_lossy(&output.stderr).trim()));
                }
                saved = Some(zip.to_string_lossy().into_owned());
            }
        }

        if let Some(dir) = UNINSTALL_FROM.get() {
            step("program");
            let deck_exe = dir.join("frugal-deck.exe");
            match run(&dir.join("uninstall.exe"), "/S") {
                Ok(_) => {}
                Err(error) if error.code().0 == CANCELLED => return Err("Windows administrator permission was not granted, so nothing was removed.".into()),
                Err(error) => return Err(format!("The program could not be removed, so no data was deleted: {}", error.message())),
            }
            // uninstall.exe hands over to a copy of itself and exits at once, so wait for the Deck to be gone.
            let start = Instant::now();
            while deck_exe.exists() {
                if start.elapsed() > Duration::from_secs(120) {
                    return Err("The program is still being removed, so no data was deleted. Run the uninstaller again later.".into());
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
                if let Err(error) = write_json(&file, &config) { errors.push(format!("{}: {error}", file.display())); }
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
                .title(if uninstalling { "Uninstall Frugal Deck" } else { "Frugal Deck Setup" })
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
        .invoke_handler(tauri::generate_handler![info, set_ui, pick_folder, install, uninstall, reveal, quit])
        .run(tauri::generate_context!())
        .expect("Frugal Deck Setup failed to start");
}
