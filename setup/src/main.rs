// Frugal Deck's setup: a window in the Deck's style around the NSIS installer from `cargo tauri build`, which runs silently inside it.
#![windows_subsystem = "windows"]

use serde_json::{json, Value};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{webview::Color, AppHandle, WebviewUrl, WebviewWindowBuilder};

const NSIS: &[u8] = include_bytes!(env!("DECK_NSIS"));
const VERSION: &str = env!("DECK_VERSION");
const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Frugal Deck";
const NO_WINDOW: u32 = 0x0800_0000;
// ShellExecuteEx's error when the administrator prompt is refused.
const CANCELLED: i32 = 0x8007_04C7_u32 as i32;

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
    let reg = PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("System32\\reg.exe");
    [("HKCU", "user"), ("HKLM", "machine")].into_iter().find_map(|(root, mode)| {
        let output = Command::new(&reg).args(["query", &format!("{root}\\{UNINSTALL_KEY}"), "/v", "DisplayVersion", "/reg:64"]).creation_flags(NO_WINDOW).output().ok()?;
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

#[tauri::command]
fn info() -> Value {
    json!({ "version": VERSION, "installed": installed() })
}

#[tauri::command]
async fn install(everyone: bool, open: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let nsis = write_nsis().map_err(|error| error.to_string())?;
        // An existing install keeps its mode and folder; /R opens the Deck as the user once it is in place.
        let mode = if installed().is_some() { "" } else if everyone { " /AllUsers" } else { " /CurrentUser" };
        let result = run(&nsis, &format!("/S{mode}{}", if open { " /R" } else { "" }));
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

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

fn main() {
    // Without WebView2 this window cannot draw, so the plain installer runs, which installs WebView2 first.
    if tauri::webview_version().is_err() {
        if let Ok(nsis) = write_nsis() {
            let _ = run(&nsis, "");
        }
        return;
    }
    tauri::Builder::default()
        .setup(|app| {
            WebviewWindowBuilder::new(app, "setup", WebviewUrl::default())
                .title("Frugal Deck Setup")
                .inner_size(560.0, 440.0)
                .resizable(false)
                .maximizable(false)
                .decorations(false)
                .center()
                .background_color(Color(0x14, 0x17, 0x1b, 0xff))
                .data_directory(folder().join("webview"))
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![info, install, quit])
        .run(tauri::generate_context!())
        .expect("Frugal Deck Setup failed to start");
}
