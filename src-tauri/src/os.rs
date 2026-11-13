// File dialogs, thumbnails, pasted images, links and the taskbar: the renderer's calls into Windows.

use base64::Engine;
use std::path::{Path, PathBuf};
use tauri::{image::Image, AppHandle, Manager, UserAttentionType, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use crate::chat::Chats;
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2, ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2};
use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
use windows_core::{Interface, HSTRING, PWSTR};

// Dialogs block until closed, so they wait on a blocking thread, not on the main one they are drawn by.
#[tauri::command]
pub async fn files_pick(window: WebviewWindow) -> Vec<PathBuf> {
    let files = tauri::async_runtime::spawn_blocking(move || window.dialog().file().set_parent(&window).blocking_pick_files()).await;
    files.ok().flatten().unwrap_or_default().into_iter().filter_map(|file| file.into_path().ok()).collect()
}

#[tauri::command]
pub async fn folder_pick(window: WebviewWindow) -> Option<PathBuf> {
    let app = window.app_handle().clone();
    let folder = tauri::async_runtime::spawn_blocking(move || window.dialog().file().set_parent(&window).blocking_pick_folder()).await.ok()??.into_path().ok()?;
    app.state::<Chats>().pick(folder.clone());
    Some(folder)
}

// The Ctrl+G panel's previews: the Windows shell thumbnail, or the file's icon when it has none.
#[tauri::command]
pub async fn files_thumbnail(file: String) -> Option<String> {
    if !Path::new(&file).is_absolute() {
        return None;
    }
    let png = tauri::async_runtime::spawn_blocking(move || {
        use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
        // Pool threads are reused, so every init is paired with an uninit once the shell objects are dropped.
        let com = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        let png = shell_image(&file);
        if com.is_ok() {
            unsafe { CoUninitialize() };
        }
        png
    }).await.ok()??;
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)))
}

fn shell_image(file: &str) -> Option<Vec<u8>> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_RESIZETOFIT};
    unsafe {
        let factory: IShellItemImageFactory = SHCreateItemFromParsingName(&HSTRING::from(file), None).ok()?;
        // Without SIIGBF_THUMBNAILONLY the shell falls back to the file's icon.
        let bitmap = factory.GetImage(SIZE { cx: 96, cy: 96 }, SIIGBF_RESIZETOFIT).ok()?;
        let mut info = BITMAP::default();
        let mut pixels = Vec::new();
        let mut size = (0, 0);
        if GetObjectW(bitmap.into(), size_of::<BITMAP>() as i32, Some(&mut info as *mut _ as _)) != 0 && info.bmWidth > 0 && info.bmHeight > 0 {
            size = (info.bmWidth as u32, info.bmHeight as u32);
            let mut header = BITMAPINFO::default();
            header.bmiHeader = BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: info.bmWidth,
                biHeight: -info.bmHeight,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            };
            pixels = vec![0u8; (size.0 * size.1 * 4) as usize];
            let dc = GetDC(None);
            if GetDIBits(dc, bitmap, 0, size.1, Some(pixels.as_mut_ptr().cast()), &mut header, DIB_RGB_COLORS) != size.1 as i32 {
                pixels.clear();
            }
            ReleaseDC(None, dc);
        }
        let _ = DeleteObject(bitmap.into());
        if pixels.is_empty() {
            return None;
        }
        // Photos come back with no alpha at all: all zero means opaque, not invisible.
        let opaque = pixels.chunks_exact(4).all(|pixel| pixel[3] == 0);
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            if opaque {
                pixel[3] = 255;
            }
        }
        let mut png = Vec::new();
        let mut encoder = png::Encoder::new(&mut png, size.0, size.1);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header().ok()?.write_image_data(&pixels).ok()?;
        Some(png)
    }
}

const PASTED_TYPES: [(&str, &str); 4] = [("image/png", "png"), ("image/jpeg", "jpg"), ("image/gif", "gif"), ("image/webp", "webp")];

// A pasted screenshot has no file, so it gets one Claude Code can read through @"path".
// frugal: these stay in the temp folder; clean them up at start once they pile up.
#[tauri::command]
pub fn files_save_pasted(bytes: Vec<u8>, kind: String) -> Option<PathBuf> {
    let (_, extension) = PASTED_TYPES.iter().find(|(name, _)| *name == kind)?;
    if bytes.is_empty() {
        return None;
    }
    let mut id = [0u8; 16];
    getrandom::fill(&mut id).ok()?;
    let hex: String = id.iter().map(|byte| format!("{byte:02x}")).collect();
    let dir = std::env::temp_dir().join("frugal-deck");
    std::fs::create_dir_all(&dir).ok()?;
    let file = dir.join(format!("pasted-{}-{}-{}-{}-{}.{extension}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..]));
    std::fs::write(&file, bytes).ok()?;
    Some(file)
}

// Opened by Windows, these run code: a click only shows them in Explorer.
const RUNS: [&str; 22] = ["exe", "com", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msi", "msp", "scr", "hta", "lnk", "url", "reg", "cpl", "jar", "appref-ms"];

fn runs(file: &Path) -> bool {
    file.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| RUNS.iter().any(|run| run.eq_ignore_ascii_case(ext)))
}

// A terminal link like src/main.rs:12:5 names the file, not the position.
fn strip_position(mut text: &str) -> &str {
    while let Some((head, tail)) = text.rsplit_once(':') {
        if tail.is_empty() || !tail.bytes().all(|byte| byte.is_ascii_digit()) {
            break;
        }
        text = head;
    }
    text
}

fn resolve(url: &str, cwd: Option<&str>, home: &Path) -> Option<PathBuf> {
    if url.get(..5).is_some_and(|scheme| scheme.eq_ignore_ascii_case("file:")) {
        return tauri::Url::parse(url).ok()?.to_file_path().ok();
    }
    Some(cwd.map_or(home, Path::new).join(strip_position(url)))
}

// The renderer is not trusted with the protocol: only web links and existing files reach the OS.
#[tauri::command]
pub fn link_open(app: AppHandle, url: String, cwd: Option<String>) {
    let opener = app.opener();
    if url.get(..7).is_some_and(|s| s.eq_ignore_ascii_case("http://")) || url.get(..8).is_some_and(|s| s.eq_ignore_ascii_case("https://")) {
        let _ = opener.open_url(url, None::<&str>);
        return;
    }
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default();
    let Some(file) = resolve(&url, cwd.as_deref(), &home).filter(|file| file.exists()) else { return };
    let _ = if runs(&file) { opener.reveal_item_in_dir(&file) } else { opener.open_path(file.to_string_lossy(), None::<&str>) };
}

// File objects carry no path in WebView2, and its own drop handler would break the sidebar's HTML5 drag. deck.js posts
// a drop's files to the host, which answers with their paths in the same order (null for one it cannot read).
// frugal: Tauri's IPC handler also gets the message and logs a console error for it.
pub unsafe fn serve_drop_paths(core: &ICoreWebView2) -> windows_core::Result<()> {
    let handler = WebMessageReceivedEventHandler::create(Box::new(|sender, args| {
        let (Some(sender), Some(args)) = (sender, args) else { return Ok(()) };
        let mut text = PWSTR::null();
        if args.TryGetWebMessageAsString(&mut text).is_err() || take_pwstr(text) != "deck:drop" {
            return Ok(());
        }
        let objects = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>()?.AdditionalObjects()?;
        let mut count = 0;
        objects.Count(&mut count)?;
        let paths: Vec<Option<String>> = (0..count)
            .map(|i| {
                let file = objects.GetValueAtIndex(i).ok()?.cast::<ICoreWebView2File>().ok()?;
                let mut path = PWSTR::null();
                file.Path(&mut path).ok()?;
                Some(take_pwstr(path))
            })
            .collect();
        sender.PostWebMessageAsJson(&HSTRING::from(serde_json::json!({ "dropped": paths }).to_string()))
    }));
    let mut token = 0;
    core.add_WebMessageReceived(&handler, &mut token)
}

// While the window is in the background WebView2 may trim its memory; chats keep streaming, only slower to repaint after.
pub fn save_memory(window: &WebviewWindow, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL};
    let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
    let _ = window.with_webview(move |webview| unsafe {
        if let Ok(core) = webview.controller().CoreWebView2().and_then(|core| core.cast::<ICoreWebView2_19>()) {
            let _ = core.SetMemoryUsageTargetLevel(level);
        }
    });
}

const DOT: u32 = 16;

// An amber dot for the taskbar button, drawn as pixels so no image file ships for it.
fn attention_dot() -> Vec<u8> {
    let mut pixels = vec![0u8; (DOT * DOT * 4) as usize];
    for (i, pixel) in pixels.chunks_exact_mut(4).enumerate() {
        let (x, y) = ((i as u32 % DOT) as f32, (i as u32 / DOT) as f32);
        if (x - 7.5).powi(2) + (y - 7.5).powi(2) <= 36.0 {
            pixel.copy_from_slice(&[0xf0, 0xb4, 0x3c, 0xff]);
        }
    }
    pixels
}

// Chats that finished or ask something in a tab you are not looking at: the taskbar button flashes until the window
// is focused and keeps a dot while any is unseen. A count that is not a u32 fails to deserialize and changes nothing.
#[tauri::command]
pub fn window_attention(window: WebviewWindow, count: u32) -> tauri::Result<()> {
    if count == 0 {
        window.request_user_attention(None)?;
    } else if !window.is_focused()? {
        window.request_user_attention(Some(UserAttentionType::Informational))?;
    }
    window.set_overlay_icon((count > 0).then(|| Image::new_owned(attention_dot(), DOT, DOT)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_links() {
        let home = Path::new(r"C:\Users\me");
        assert_eq!(resolve("src/main.rs:12:5", Some(r"C:\repo"), home), Some(PathBuf::from(r"C:\repo\src/main.rs")));
        assert_eq!(resolve("notes.md:3", None, home), Some(PathBuf::from(r"C:\Users\me\notes.md")));
        assert_eq!(resolve(r"D:\a.txt", Some(r"C:\repo"), home), Some(PathBuf::from(r"D:\a.txt")));
        assert_eq!(resolve("file:///C:/a%20b.txt", None, home), Some(PathBuf::from(r"C:\a b.txt")));
        assert_eq!(strip_position("a:b"), "a:b");
        assert_eq!(strip_position("a:"), "a:");
        assert!(runs(Path::new(r"C:\x\Setup.EXE")) && runs(Path::new("app.appref-ms")));
        assert!(!runs(Path::new("readme.md")) && !runs(Path::new(".bat")));
    }

    #[test]
    fn draws_the_dot() {
        let dot = attention_dot();
        let at = |x: u32, y: u32| &dot[((y * DOT + x) * 4) as usize..][..4];
        assert_eq!(at(7, 7), [0xf0, 0xb4, 0x3c, 0xff]);
        assert_eq!(at(0, 0), [0, 0, 0, 0]);
        assert_eq!(at(15, 8), [0, 0, 0, 0]);
        assert_eq!(at(13, 8), [0xf0, 0xb4, 0x3c, 0xff]);
    }
}
