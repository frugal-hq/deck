#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod accounts;
mod activity;
mod archive;
mod chat;
#[path = "../../setup/src/consolidation.rs"]
#[allow(dead_code)]
mod consolidation;
mod debug;
mod elevated;
mod handoff;
mod i18n;
mod index;
mod mcp;
mod organizer;
mod plugins;
mod os;
mod procs;
mod statusline;
mod tasks;
mod update;
mod voice;

use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{webview::Color, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

// The renderer's localStorage, mirrored by deck.js, so a reinstall or a cleared WebView2 folder gets it back.
fn ui_file() -> Option<std::path::PathBuf> {
    Some(std::path::PathBuf::from(std::env::var_os("USERPROFILE")?).join(".frugal-deck").join("ui.json"))
}

#[tauri::command]
fn ui_save(values: serde_json::Value) -> Result<(), String> {
    if !values.is_object() { return Err(crate::i18n::t("error.settings-not-object", &[])); }
    let file = ui_file().ok_or_else(|| crate::i18n::t("error.no-user-folder", &[]))?;
    let temporary = file.with_extension("json.tmp");
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&temporary, serde_json::to_vec_pretty(&values).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(temporary, file).map_err(|e| e.to_string())
}

#[tauri::command]
fn i18n_language(language: String) {
    i18n::set_language(&language);
}

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
            let home = std::path::PathBuf::from(std::env::var_os("USERPROFILE").ok_or_else(|| crate::i18n::t("error.no-user-folder", &[]))?);
            activity::init(app.handle().clone(), home.clone());
            let codex_home = std::env::var_os("CODEX_HOME").filter(|s| !s.is_empty()).map(std::path::PathBuf::from).unwrap_or_else(|| home.join(".codex"));
            let ui = ui_file().and_then(|file| std::fs::read_to_string(file).ok())
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok()).filter(|v| v.is_object()).unwrap_or_default();
            if let Some(tag) = ui["language"].as_str() { i18n::set_language(tag); }
            debug::init(app.handle().clone(), ui["debugLog"] == "true");
            procs::watch(app.handle().clone());
            let accounts = accounts::Accounts::new(home, codex_home);
            if let Err(error) = accounts.migrate_deck_servers() {
                debug_log!("mcp", "Failed to migrate Deck MCP servers: {error}");
            }
            // Also covers accounts added to the Frugal pool outside the Deck.
            let _ = accounts.apply_keep_transcripts();
            app.manage(Mutex::new(accounts));
            accounts::watch_caps(app.handle().clone());
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
                .initialization_script(format!("window.__deckUi = {ui};
{}", include_str!("deck.js")))
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
                    if events.is_minimized().unwrap_or(false) {
                    } else if !events.is_maximized().unwrap_or(false) {
                        if let Some(bounds) = normal_bounds(&events) {
                            *normal.lock().unwrap() = Some(bounds);
                        }
                    } else if let Ok(Some(monitor)) = events.current_monitor() {
                        // A maximized window moved to another display (Win+Shift+arrow, a snap drag) must reopen there:
                        // its normal rect, still on the old display, is centered on the new one's work area.
                        let (scale, area) = (monitor.scale_factor(), monitor.work_area());
                        let (x, y) = (f64::from(area.position.x) / scale, f64::from(area.position.y) / scale);
                        let (w, h) = (f64::from(area.size.width) / scale, f64::from(area.size.height) / scale);
                        if let Some(b) = normal.lock().unwrap().as_mut() {
                            let (cx, cy) = ((b.x + b.width / 2) as f64, (b.y + b.height / 2) as f64);
                            if cx < x || cx >= x + w || cy < y || cy >= y + h {
                                b.x = (x + (w - b.width as f64).max(0.0) / 2.0).round() as i64;
                                b.y = (y + (h - b.height as f64).max(0.0) / 2.0).round() as i64;
                            }
                        }
                    }
                }
                // Also on losing focus and on destroy: an installer ends the Deck with no close request, and it was saved only then.
                if let WindowEvent::CloseRequested { .. } | WindowEvent::Focused(false) | WindowEvent::Destroyed = event {
                    // A failed save must never block closing.
                    if let Some(bounds) = *normal.lock().unwrap() {
                        let _ = std::fs::write(&bounds_file, json!(Bounds { maximized: events.is_maximized().unwrap_or_else(|_| maximized.load(Ordering::Relaxed)), ..bounds }).to_string());
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
                // main.js statusBridge: a chat's limits are its account's reading, shown in the usage panel.
                move |id, value| {
                    if let Some(account) = meters.state::<chat::Chats>().account_of(id) {
                        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs_f64() * 1000.0;
                        let accounts = meters.state::<Mutex<accounts::Accounts>>();
                        let mut accounts = accounts.lock().unwrap();
                        if accounts.save_reading(&account, &value, at).unwrap_or(false) { let _ = accounts::publish(&meters, &mut accounts); }
                    }
                    let _ = meters.emit("chat:meters", [json!(id), value]);
                },
                move |id, text| edits.emit("chat:edit", [json!(id), json!(text)]).is_ok(),
            )?;
            app.manage(bridge);
            index::start(app.handle().clone());
            mcp::learn_frugal(app.handle().clone());
            archive::start(app.handle().clone(), std::path::PathBuf::from(std::env::var_os("USERPROFILE").ok_or_else(|| crate::i18n::t("error.no-user-folder", &[]))?));
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(chat::Chats::default())
        .manage(elevated::Host::default())
        .manage(index::Index::default())
        .manage(organizer::Organizer::default())
        .invoke_handler(tauri::generate_handler![
            ui_save,
            i18n_language,
            debug::debug_set,
            debug::debug_lines,
            activity::activity_list,
            activity::activity_add,
            debug::debug_clear,
            debug::debug_log,
            debug::debug_reveal,
            index::sessions_get,
            index::sessions_all,
            index::import_sessions,
            index::sessions_search,
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
            index::sessions_set_archived,
            index::sessions_undo_link,
            index::joins_clear,
            index::topics_restore_titles,
            accounts::accounts_get,
            accounts::account_cli,
            accounts::install_cli,
            accounts::settings_roles,
            accounts::settings_set_roles,
            accounts::settings_mouse,
            accounts::settings_set_mouse,
            accounts::settings_keep_transcripts,
            accounts::settings_set_keep_transcripts,
            accounts::accounts_rename,
            accounts::accounts_set_cap,
            accounts::accounts_set_primary,
            accounts::accounts_refresh,
            accounts::accounts_order,
            accounts::accounts_set_order,
            accounts::accounts_logout,
            accounts::accounts_remove,
            accounts::mcp_set,
            voice::voice_mode,
            os::permissions_set,
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
            consolidation::inventory,
            consolidation::consolidate,
            chat::folder_default,
            chat::chat_start,
            chat::chat_continue,
            chat::chat_switch_account,
            chat::accounts_login,
            chat::chat_input,
            chat::chat_resize,
            chat::chat_kill,
            chat::chat_processes,
            chat::chat_process_kill,
            procs::perf_get,
            procs::perf_set,
            procs::perf_set_idle,
            procs::perf_machine,
            procs::perf_profile,
            chat::chat_recorded_sessions,
            tasks::chat_subagents,
            tasks::tasks_all,
            mcp::mcp_list,
            mcp::mcp_add,
            mcp::mcp_restore,
            mcp::mcp_remove,
            mcp::mcp_access_set,
            plugins::plugins_list,
            plugins::plugins_set,
            plugins::auto_picks_clear,
            plugins::plugin_find,
            plugins::plugin_install,
            plugins::plugins_update,
            plugins::recommend,
            chat::mcp_login,
            organizer::topics_estimate,
            organizer::topics_run,
            organizer::search_ai,
            organizer::mcp_from_prompt,
            organizer::perf_suggest,
            organizer::workspaces_estimate,
            organizer::workspaces_run,
            organizer::joins_estimate,
            organizer::joins_run,
            statusline::chat_save_edit,
            update::update_check,
            update::update_pick,
            update::update_install,
            update::update_frugal,
            update::update_frugal_source
        ])
        .build(tauri::generate_context!())
        .expect("Frugal Deck failed to start")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                debug_log!("deck", "exit");
                app.state::<chat::Chats>().kill_all();
                app.state::<organizer::Organizer>().stop();
            }
        });
}
