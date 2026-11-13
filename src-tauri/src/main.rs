#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod chat;

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{webview::Color, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

// Startup reads answer what Electron's main answers before the index and settings load; later phases port each one.
#[tauri::command]
fn sessions_get() -> Value {
    json!({ "indexing": false, "sessions": [], "error": null, "ambiguous": [], "modelJoins": 0, "workspaces": {}, "workspaceParents": {}, "modelWorkspaces": 0 })
}

#[tauri::command]
fn sessions_all() -> Value {
    json!([])
}

#[tauri::command]
fn accounts_get() -> Value {
    json!({ "primary": null, "accounts": [], "others": [] })
}

#[tauri::command]
fn settings_roles() -> bool {
    true
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

fn main() {
    tauri::Builder::default()
        .setup(|app| {
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
            Ok(())
        })
        .manage(chat::Chats::default())
        .invoke_handler(tauri::generate_handler![
            sessions_get,
            sessions_all,
            accounts_get,
            settings_roles,
            window_action,
            chat::folder_default,
            chat::chat_start,
            chat::chat_input,
            chat::chat_resize,
            chat::chat_kill
        ])
        .build(tauri::generate_context!())
        .expect("Frugal Deck failed to start")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<chat::Chats>().kill_all();
            }
        });
}
