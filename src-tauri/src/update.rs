// Updates: a newer installer in the build folder this exe was built from, the latest GitHub release, or a picked file.
// The installer runs silently (NSIS /S keeps the install's mode and folder, /R opens the Deck again) and the Deck quits so it can be replaced.
// frugal: releases are not signed; tauri-plugin-updater with a minisign key would reject a tampered installer.

use serde_json::{json, Value};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Manager, WebviewWindow};
use crate::accounts::{self, Accounts, MAIN};
use tauri_plugin_dialog::DialogExt;

const RELEASES: &str = "https://api.github.com/repos/frugal-hq/deck/releases/latest";
const DOWNLOADS: &str = "https://github.com/frugal-hq/deck/releases/download/";
// The NSIS installer cargo tauri build makes; the styled setup around it has another name.
const SUFFIX: &str = "_x64-setup.exe";
const NO_WINDOW: u32 = 0x0800_0000;
const FRUGAL_REPO: &str = "frugal-hq/frugal";

// Windows ships curl.exe, so no HTTP client is compiled in.
fn curl() -> Command {
    let mut command = Command::new(crate::elevated::system32().join("curl.exe"));
    command.creation_flags(NO_WINDOW);
    command
}

fn newer(tag: &str, current: &str) -> bool {
    let parts = |version: &str| version.trim_start_matches('v').split('.').map(|part| part.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    parts(tag) > parts(current)
}

// Where cargo tauri build puts the installer, on the computer this exe was built on.
fn build_folder() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("target/release/bundle/nsis")
}

// The installer copies the exe with its build time, and the bundle step follows it by seconds, so a later build is newer.
fn local_build() -> Option<Value> {
    let folder = build_folder();
    let exe = std::env::current_exe().ok()?.metadata().ok()?.modified().ok()?;
    let (path, built) = std::fs::read_dir(folder)
        .ok()?
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(SUFFIX))
        .filter_map(|entry| Some((entry.path(), entry.metadata().ok()?.modified().ok()?)))
        .max_by_key(|(_, built)| *built)?;
    let newer = built > exe + Duration::from_secs(60);
    let built = built.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
    newer.then(|| json!({ "path": path, "built": built }))
}

fn latest_release() -> Result<Option<Value>, String> {
    let output = curl().args(["-fsSL", "--max-time", "15", "-A", "frugal-deck", "-H", "Accept: application/vnd.github+json", RELEASES]).output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    let release: Value = serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())?;
    let tag = release["tag_name"].as_str().unwrap_or_default();
    if !newer(tag, env!("CARGO_PKG_VERSION")) {
        return Ok(None);
    }
    let url = release["assets"].as_array().into_iter().flatten().filter_map(|asset| asset["browser_download_url"].as_str()).find(|url| url.starts_with(DOWNLOADS) && url.ends_with(SUFFIX));
    Ok(Some(json!({ "version": tag.trim_start_matches('v'), "url": url, "page": release["html_url"] })))
}

fn main_account(app: &AppHandle) -> Option<(Value, std::collections::HashMap<String, String>, PathBuf)> {
    let accounts = app.state::<Mutex<Accounts>>();
    let accounts = accounts.lock().unwrap();
    let main = accounts.claude_accounts().into_iter().find(|account| account["id"] == MAIN)?;
    let env = crate::chat::account_env(&accounts, &main);
    Some((main, env, accounts.home.clone()))
}

// Chats allow frugal's server by the command of the copy they load, which moves with each install; listed before returning,
// so a chat restarted right after an update gets the new command.
fn relearn(app: &AppHandle) {
    crate::mcp::list(&app.state::<Mutex<Accounts>>(), &json!({ "global": true }));
}

fn config_dir(main: &Value) -> &Path {
    Path::new(main["configDir"].as_str().unwrap_or_default())
}

// Where the account installs frugal from, as Claude Code records it: { source: "github", repo } or { source: "directory", path }.
fn frugal_source(config_dir: &Path) -> Value {
    std::fs::read(config_dir.join("plugins/known_marketplaces.json")).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()).map_or(Value::Null, |known| known["frugal"]["source"].clone())
}

// A folder with uncommitted changes would install work in progress to every chat. No git, or not a repository: allowed.
fn dirty(path: &str) -> Option<String> {
    let output = Command::new("git").args(["-C", path, "status", "--porcelain"]).creation_flags(NO_WINDOW).stdin(Stdio::null()).output().ok()?;
    (output.status.success() && !output.stdout.is_empty()).then(|| format!("The folder {path} has uncommitted changes. Commit or discard them, then try again."))
}

// The newest frugal its source offers (the folder's plugin.json, or the repository's on GitHub), whether it is newer than the
// installed one, and whether the folder has uncommitted changes, which an update would refuse.
fn frugal_latest(source: &Value, installed: &str) -> Value {
    let manifest = match source["source"].as_str() {
        Some("directory") => source["path"].as_str().and_then(|path| std::fs::read(Path::new(path).join(".claude-plugin/plugin.json")).ok()),
        Some("github") => source["repo"].as_str().filter(|repo| repo.split('/').count() == 2 && repo.chars().all(|c| c.is_ascii_alphanumeric() || "/._-".contains(c))).and_then(|repo| {
            // The API, not raw.githubusercontent.com: raw files stay cached for 5 minutes after a push.
            let url = format!("https://api.github.com/repos/{repo}/contents/.claude-plugin/plugin.json");
            let output = curl().args(["-fsSL", "--max-time", "15", "-A", "frugal-deck", "-H", "Accept: application/vnd.github.raw", &url]).output().ok()?;
            output.status.success().then_some(output.stdout)
        }),
        _ => None,
    };
    // plugin.json may start with a byte order mark, which serde_json rejects.
    let version = manifest.and_then(|bytes| serde_json::from_str::<Value>(String::from_utf8_lossy(&bytes).trim_start_matches('\u{feff}')).ok()).map_or(Value::Null, |manifest| manifest["version"].clone());
    let changed = source["source"] == "directory" && source["path"].as_str().and_then(dirty).is_some();
    json!({ "version": version, "newer": version.as_str().is_some_and(|version| newer(version, installed)), "dirty": changed })
}

// `claude plugin` commands on the main account.
fn claude_plugin(app: &AppHandle) -> Result<(Value, impl Fn(&[&str]) -> Result<Vec<u8>, String>), String> {
    let (main, env, home) = main_account(app).ok_or("The main account is not set up.")?;
    let claude = crate::chat::find_claude().ok_or(crate::chat::NO_CLAUDE)?;
    Ok((main, move |args: &[&str]| {
        let mut command = Command::new(&claude);
        command.env_clear().envs(&env).args(args).current_dir(&home).stdin(Stdio::null());
        accounts::run(&mut command, Duration::from_secs(300)).map_err(|error| error.to_string().trim().to_owned())
    }))
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        let remote = latest_release();
        let (frugal, source) = main_account(&app).map_or((Value::Null, Value::Null), |(main, _, _)| (accounts::frugal_install(&main)["version"].clone(), frugal_source(config_dir(&main))));
        let latest = frugal.as_str().map_or(Value::Null, |installed| frugal_latest(&source, installed));
        let folder = Some(build_folder()).filter(|folder| folder.is_dir());
        json!({ "version": env!("CARGO_PKG_VERSION"), "local": local_build(), "remote": remote.as_ref().ok().cloned().flatten(), "error": remote.err(), "buildFolder": folder,
                "frugal": frugal, "frugalSource": source, "frugalLatest": latest })
    })
    .await
    .unwrap_or_default()
}

// Chats on every account load the main account's frugal (--plugin-dir), so updating it there reaches them all.
// Returns Claude Code's own last line, such as `Plugin "frugal" updated from 0.27.7 to 0.28.0`.
#[tauri::command]
pub async fn update_frugal(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (main, step) = claude_plugin(&app)?;
        let source = frugal_source(config_dir(&main));
        if let Some(error) = source["path"].as_str().filter(|_| source["source"] == "directory").and_then(dirty) {
            return Err(error);
        }
        step(&["plugin", "marketplace", "update", "frugal"])?;
        let output = step(&["plugin", "update", "frugal@frugal"])?;
        relearn(&app);
        let output = String::from_utf8_lossy(&output);
        let last = output.lines().map(|line| line.trim_start_matches(|c: char| !c.is_alphanumeric())).filter(|line| !line.is_empty()).last().unwrap_or_default();
        Ok(last.split(" Restart").next().unwrap_or_default().trim_end_matches('.').to_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

// Switches the main account between frugal on GitHub and a folder that holds its marketplace, such as a clone of the repo; returns the new source, or "" when no folder was picked.
// Removing the marketplace uninstalls frugal and wipes its plugin data (per-session markers only), so it is added and installed again; a failed add puts the old source back.
#[tauri::command]
pub async fn update_frugal_source(app: AppHandle, window: WebviewWindow, github: bool) -> Result<String, String> {
    let folder = if github {
        None
    } else {
        let picked = tauri::async_runtime::spawn_blocking(move || window.dialog().file().set_parent(&window).blocking_pick_folder()).await.map_err(|error| error.to_string())?;
        match picked.and_then(|folder| folder.into_path().ok()) {
            Some(folder) => Some(folder),
            None => return Ok(String::new()),
        }
    };
    tauri::async_runtime::spawn_blocking(move || {
        let target = match &folder {
            Some(folder) => {
                let manifest: Value = std::fs::read(folder.join(".claude-plugin/marketplace.json")).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
                if manifest["name"] != "frugal" {
                    return Err("That folder does not hold frugal's marketplace.".to_owned());
                }
                let path = folder.to_string_lossy().into_owned();
                if let Some(error) = dirty(&path) {
                    return Err(error);
                }
                path
            }
            None => FRUGAL_REPO.to_owned(),
        };
        let (main, step) = claude_plugin(&app)?;
        let old = frugal_source(config_dir(&main));
        let old = ["repo", "path", "url"].iter().find_map(|key| old[*key].as_str()).map(str::to_owned);
        step(&["plugin", "marketplace", "remove", "frugal"])?;
        if let Err(error) = step(&["plugin", "marketplace", "add", &target]) {
            if let Some(old) = old {
                if step(&["plugin", "marketplace", "add", &old]).is_ok() {
                    let _ = step(&["plugin", "install", "frugal@frugal"]);
                }
            }
            return Err(error);
        }
        step(&["plugin", "install", "frugal@frugal"])?;
        relearn(&app);
        Ok(target)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn update_pick(window: WebviewWindow) -> Option<PathBuf> {
    let file = tauri::async_runtime::spawn_blocking(move || window.dialog().file().set_parent(&window).add_filter("Installer", &["exe"]).blocking_pick_file()).await;
    file.ok()??.into_path().ok()
}

// A release download, or an installer file on this computer.
fn installer(source: &str) -> Result<PathBuf, String> {
    if let Some(name) = source.strip_prefix(DOWNLOADS).and_then(|rest| rest.rsplit('/').next()).filter(|name| name.ends_with(SUFFIX) && !name.contains(['\\', '/', '?'])) {
        let folder = std::env::temp_dir().join("frugal-deck-update");
        std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
        let file = folder.join(name);
        let output = curl().args(["-fsSL", "--max-time", "600", "-A", "frugal-deck", "-o"]).arg(&file).arg(source).output().map_err(|error| error.to_string())?;
        return if output.status.success() { Ok(file) } else { Err(String::from_utf8_lossy(&output.stderr).trim().to_owned()) };
    }
    let file = PathBuf::from(source);
    if file.is_absolute() && file.is_file() && file.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("exe")) {
        Ok(file)
    } else {
        Err("That is not an installer.".to_owned())
    }
}

#[tauri::command]
pub async fn update_install(app: AppHandle, source: String) -> Result<(), String> {
    let file = tauri::async_runtime::spawn_blocking(move || installer(&source)).await.map_err(|error| error.to_string())??;
    // Returns once Windows has started it, after its administrator prompt, so a refused prompt keeps the Deck open.
    tauri::async_runtime::spawn_blocking(move || launch(&file)).await.map_err(|error| error.to_string())?.map_err(|error| error.message())?;
    app.exit(0);
    Ok(())
}

// The installer asks for administrator rights in its manifest, which CreateProcess refuses and ShellExecute prompts for.
// It starts outside the Deck's folder, so nothing holds the folder while the exe is replaced.
fn launch(file: &Path) -> windows_core::Result<()> {
    use windows::Win32::UI::Shell::{ShellExecuteExW, SHELLEXECUTEINFOW};
    use windows_core::{HSTRING, PCWSTR};
    let (file, args, folder) = (HSTRING::from(file), HSTRING::from("/S /R"), HSTRING::from(std::env::temp_dir().as_path()));
    let mut info = SHELLEXECUTEINFOW { cbSize: size_of::<SHELLEXECUTEINFOW>() as u32, lpFile: PCWSTR(file.as_ptr()), lpParameters: PCWSTR(args.as_ptr()), lpDirectory: PCWSTR(folder.as_ptr()), ..Default::default() };
    unsafe { ShellExecuteExW(&mut info) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions() {
        assert!(newer("v0.2.0", "0.1.0"));
        assert!(newer("0.10.0", "0.9.9"));
        assert!(!newer("v0.1.0", "0.1.0"));
        assert!(!newer("", "0.1.0"));
    }

    #[test]
    fn takes_only_release_installers() {
        assert!(installer("https://example.com/Frugal Deck_0.2.0_x64-setup.exe").is_err());
        assert!(installer("relative.exe").is_err());
        assert!(installer(&format!("{DOWNLOADS}v0.2.0/notes.txt")).is_err());
    }
}
