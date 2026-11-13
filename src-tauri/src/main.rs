#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod accounts;
mod chat;
mod handoff;
mod index;
mod mcp;
mod organizer;
mod statusline;
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

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let home = std::path::PathBuf::from(std::env::var_os("USERPROFILE").ok_or("No user folder.")?);
            let codex_home = std::env::var_os("CODEX_HOME").filter(|s| !s.is_empty()).map(std::path::PathBuf::from).unwrap_or_else(|| home.join(".codex"));
            app.manage(Mutex::new(accounts::Accounts::new(home, codex_home)));
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("src/renderer/index.html".into()))
                .title("Frugal Deck")
                .inner_size(1200.0, 800.0)
                .decorations(false)
                .background_color(Color(0x14, 0x17, 0x1b, 0xff))
                // Test runs open the window behind the one in use, so it never takes the keyboard.
                .focused(std::env::var_os("DECK_BACKGROUND").is_none())
                .initialization_script(include_str!("deck.js"))
                // WebView2's own drop handler would break the sidebar's HTML5 drag; file drop paths come back in phase 6.
                .disable_drag_drop_handler()
                .on_navigation(|url| url.host_str() == Some("tauri.localhost"))
                .build()?;
            // Ctrl+R, Ctrl+F, F5 and the like belong to the terminal, not to a browser; copy and paste keys stay.
            window.with_webview(|webview| unsafe {
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                use windows_core::Interface;
                if let Ok(settings) = webview.controller().CoreWebView2().and_then(|core| core.Settings()).and_then(|settings| settings.cast::<ICoreWebView2Settings3>()) {
                    let _ = settings.SetAreBrowserAcceleratorKeysEnabled(false);
                }
            })?;
            let events = window.clone();
            let maximized = AtomicBool::new(false);
            window.on_window_event(move |event| {
                if let WindowEvent::Resized(_) = event {
                    let now = events.is_maximized().unwrap_or(false);
                    if maximized.swap(now, Ordering::Relaxed) != now {
                        let _ = events.emit("window:maximized", [now]);
                    }
                }
            });
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
        .manage(chat::Chats::default())
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
            chat::folder_default,
            chat::chat_start,
            chat::chat_continue,
            chat::chat_switch_account,
            chat::accounts_login,
            chat::chat_input,
            chat::chat_resize,
            chat::chat_kill,
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
