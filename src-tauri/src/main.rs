#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod accounts;
mod chat;
mod elevated;
mod handoff;
mod index;
mod mcp;
mod organizer;
mod os;
mod statusline;
mod tasks;
mod voice;

use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{webview::Color, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

#[tauri::command]
fn window_action(window: WebviewWindow, action: String) -> tauri::Result<()> {
    match action.as_str() {
        "minimize" => window.minimize(),
        "maximize" if window.is_maximized()? => window.unmaximize(),
        "maximize" => window.maximize(),
        "close" => window.close(),
        _ => Ok(()),
    }
}

// Electron's window.json, in logical pixels.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy)]
struct Bounds {
    x: i64,
    y: i64,
    width: i64,
    height: i64,
    #[serde(default)]
    maximized: bool,
}

fn normal_bounds(window: &WebviewWindow) -> Option<Bounds> {
    let scale = window.scale_factor().ok()?;
    let (position, size) = (window.outer_position().ok()?.to_logical::<f64>(scale), window.inner_size().ok()?.to_logical::<f64>(scale));
    Some(Bounds { x: position.x.round() as i64, y: position.y.round() as i64, width: size.width.round() as i64, height: size.height.round() as i64, maximized: false })
}

fn main() {
    let args: Vec<String> = std::env::args_os().map(|arg| arg.to_string_lossy().into_owned()).collect();
    if args.get(1).is_some_and(|arg| arg == elevated::FLAG) {
        elevated::run_helper(&args);
        return;
    }
    if args.get(1).is_some_and(|arg| arg == "--edit") {
        statusline::edit(&std::env::var("DECK_EDIT_URL").unwrap_or_default(), args.get(2).map_or("", String::as_str));
        return;
    }
    tauri::Builder::default()
        .setup(|app| {
            statusline::write_editor(&app.path().app_data_dir()?)?;
            let home = std::path::PathBuf::from(std::env::var_os("USERPROFILE").ok_or("No user folder.")?);
            let codex_home = std::env::var_os("CODEX_HOME").filter(|s| !s.is_empty()).map(std::path::PathBuf::from).unwrap_or_else(|| home.join(".codex"));
            app.manage(Mutex::new(accounts::Accounts::new(home, codex_home)));
            let bounds_file = app.path().app_data_dir()?.join("window.json");
            // Missing or malformed file: the defaults. A rect no longer on any display keeps its size but is recentered.
            let saved = std::fs::read_to_string(&bounds_file).ok().and_then(|text| serde_json::from_str::<Bounds>(&text).ok()).filter(|b| b.width >= 400 && b.height >= 300);
            let on_screen = saved.is_some_and(|b| {
                app.available_monitors().unwrap_or_default().iter().any(|monitor| {
                    let (scale, area) = (monitor.scale_factor(), monitor.work_area());
                    let (x, y) = (f64::from(area.position.x) / scale, f64::from(area.position.y) / scale);
                    let (w, h) = (f64::from(area.size.width) / scale, f64::from(area.size.height) / scale);
                    (b.x as f64) < x + w && (b.x + b.width) as f64 > x && (b.y as f64) < y + h && (b.y + b.height) as f64 > y
                })
            });
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("src/renderer/index.html".into()));
            // Like Electron, a window with no saved position opens centered.
            builder = match saved.filter(|_| on_screen) {
                Some(b) => builder.position(b.x as f64, b.y as f64),
                None => builder.center(),
            };
            let window = builder
                .title("Frugal Deck")
                .inner_size(saved.map_or(1200.0, |b| b.width as f64), saved.map_or(800.0, |b| b.height as f64))
                .decorations(false)
                .background_color(Color(0x14, 0x17, 0x1b, 0xff))
                // Test runs open the window behind the one in use, so it never takes the keyboard.
                .focused(std::env::var_os("DECK_BACKGROUND").is_none())
                .initialization_script(include_str!("deck.js"))
                // WebView2's own drop handler would break the sidebar's HTML5 drag; os::serve_drop_paths gives drops their paths.
                .disable_drag_drop_handler()
                .on_navigation(|url| url.host_str() == Some("tauri.localhost"))
                .build()?;
            // Ctrl+R, Ctrl+F, F5 and the like belong to the terminal, not to a browser; copy and paste keys stay.
            window.with_webview(|webview| unsafe {
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                use windows_core::Interface;
                let Ok(core) = webview.controller().CoreWebView2() else { return };
                if let Ok(settings) = core.Settings().and_then(|settings| settings.cast::<ICoreWebView2Settings3>()) {
                    let _ = settings.SetAreBrowserAcceleratorKeysEnabled(false);
                }
                let _ = os::serve_drop_paths(&core);
            })?;
            // The bounds to restore are the last ones the window had while neither maximized nor minimized.
            let normal = Mutex::new(normal_bounds(&window));
            if saved.is_some_and(|b| b.maximized) {
                window.maximize()?;
            }
            let events = window.clone();
            let maximized = AtomicBool::new(false);
            window.on_window_event(move |event| {
                if let WindowEvent::Moved(_) | WindowEvent::Resized(_) = event {
                    if !events.is_maximized().unwrap_or(false) && !events.is_minimized().unwrap_or(false) {
                        if let Some(bounds) = normal_bounds(&events) {
                            *normal.lock().unwrap() = Some(bounds);
                        }
                    }
                }
                if let WindowEvent::CloseRequested { .. } = event {
                    // A failed save must never block closing.
                    if let Some(bounds) = *normal.lock().unwrap() {
                        let _ = std::fs::write(&bounds_file, json!(Bounds { maximized: events.is_maximized().unwrap_or(false), ..bounds }).to_string());
                    }
                }
                if let WindowEvent::Resized(_) = event {
                    let now = events.is_maximized().unwrap_or(false);
                    if maximized.swap(now, Ordering::Relaxed) != now {
                        let _ = events.emit("window:maximized", [now]);
                    }
                }
                if let WindowEvent::Focused(focused) = event {
                    os::save_memory(&events, !focused);
                    if *focused {
                        let _ = events.request_user_attention(None);
                    }
                }
            });
            os::save_memory(&window, !window.is_focused().unwrap_or(true));
            let meters = app.handle().clone();
            let edits = app.handle().clone();
            let bridge = statusline::create_status_bridge(
                move |id, value| { let _ = meters.emit("chat:meters", [json!(id), value]); },
                move |id, text| edits.emit("chat:edit", [json!(id), json!(text)]).is_ok(),
            )?;
            app.manage(bridge);
            index::start(app.handle().clone());
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(chat::Chats::default())
        .manage(elevated::Host::default())
        .manage(index::Index::default())
        .manage(organizer::Organizer::default())
        .invoke_handler(tauri::generate_handler![
            index::sessions_get,
            index::sessions_all,
            index::sessions_organize,
            index::sessions_set_group,
            index::sessions_set_workspace,
            index::workspaces_set_parent,
            index::workspaces_rename,
            index::workspaces_delete,
            index::groups_rename,
            index::groups_delete,
            index::workspaces_clear,
            index::sessions_link,
            index::sessions_undo_link,
            index::joins_clear,
            index::topics_restore_titles,
            accounts::accounts_get,
            accounts::settings_roles,
            accounts::settings_set_roles,
            accounts::accounts_rename,
            accounts::accounts_set_cap,
            accounts::accounts_set_primary,
            accounts::accounts_refresh,
            accounts::accounts_logout,
            accounts::accounts_remove,
            accounts::mcp_set,
            voice::voice_mode,
            voice::voice_status,
            voice::voice_prepare,
            voice::voice_transcribe,
            window_action,
            os::files_pick,
            os::folder_pick,
            os::files_thumbnail,
            os::files_save_pasted,
            os::link_open,
            os::window_attention,
            chat::folder_default,
            chat::chat_start,
            chat::chat_continue,
            chat::chat_switch_account,
            chat::accounts_login,
            chat::chat_input,
            chat::chat_resize,
            chat::chat_kill,
            tasks::chat_subagents,
            mcp::mcp_list,
            organizer::topics_estimate,
            organizer::topics_run,
            organizer::workspaces_estimate,
            organizer::workspaces_run,
            organizer::joins_estimate,
            organizer::joins_run,
            statusline::chat_save_edit
        ])
        .build(tauri::generate_context!())
        .expect("Frugal Deck failed to start")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<chat::Chats>().kill_all();
                app.state::<organizer::Organizer>().stop();
            }
        });
}
