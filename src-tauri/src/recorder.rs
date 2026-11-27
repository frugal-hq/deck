// Screen recording into Videos\Frugal Deck: an MP4, the microphone as a WAV, and key frames a chat can read.
use base64::Engine;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11RenderTargetView, ID3D11ShaderResourceView, ID3D11Texture2D, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
    D3D11_BOX, D3D11_CPU_ACCESS_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_RESOURCE_MISC_GENERATE_MIPS, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder, VideoSettingsSubType};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, GraphicsCaptureItemType, MinimumUpdateIntervalSettings,
    SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

type Result<T> = std::result::Result<T, String>;
type Queue = Arc<Mutex<VecDeque<f32>>>;
// A finished key frame for the writer thread: file, size, RGB, and the thumbnail to write with the first one.
type Job = (PathBuf, u32, u32, Vec<u8>, Option<(u32, u32, Vec<u8>)>);
const RATE: u64 = 48000;
const MAX_KEY_FRAMES: usize = 120;
const MAX_CHAT_FRAMES: usize = 20;
static SESSION: Mutex<Option<Session>> = Mutex::new(None);

fn t(key: &str) -> String { crate::i18n::t(key, &[]) }
fn text(e: impl std::fmt::Display) -> String { e.to_string() }
fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }

struct Session {
    id: String,
    started: u64,
    kind: &'static str,
    mic: bool,
    system: bool,
    shared: Arc<Shared>,
    // None while the session is being stopped.
    parts: Option<Parts>,
}

struct Parts {
    control: CaptureControl<Recorder, String>,
    threads: Vec<JoinHandle<()>>,
    writer: JoinHandle<()>,
}

struct Shared {
    app: AppHandle,
    folder: PathBuf,
    origin: Instant,
    // The first frame: video, audio and key frame times count from it.
    video_start: OnceLock<Instant>,
    stop: AtomicBool,
    ended: AtomicBool,
    // Milliseconds since origin of the last mouse press, plus one; 0 for none.
    click: AtomicU64,
    encoder: Mutex<Option<VideoEncoder>>,
    frames: Mutex<Vec<KeyFrame>>,
    writer: Mutex<Option<mpsc::Sender<Job>>>,
    pointer: Mutex<Pointer>,
    levels: u32,
    game: bool,
}

const RING_MS: u64 = 450;

#[derive(Clone, Copy, Debug, PartialEq)]
struct Press {
    button: &'static str,
    at: (i32, i32),
    ms: u64,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
struct ClickEvent {
    ms: u64,
    button: &'static str,
    x: i32,
    y: i32,
    up_ms: u64,
    up_x: i32,
    up_y: i32,
    // The capture's screen top-left at the press.
    #[serde(skip)]
    origin: (i32, i32),
}

// Screen physical pixels, milliseconds since Shared::origin.
#[derive(Default)]
struct Pointer {
    pos: (i32, i32),
    // The capture's screen top-left, updated per frame.
    origin: (i32, i32),
    press: Option<Press>,
    recent: Vec<Press>,
    events: Vec<ClickEvent>,
    // The last press, release, or tick with a button held.
    active: Option<u64>,
}

impl Pointer {
    // True on a new press.
    fn update(&mut self, button: Option<&'static str>, now: u64) -> bool {
        let (x, y) = self.pos;
        if button.is_some() || self.press.is_some() { self.active = Some(now); }
        match (self.press, button) {
            (None, Some(button)) => {
                let press = Press { button, at: (x, y), ms: now };
                self.press = Some(press);
                self.recent.retain(|p| now.saturating_sub(p.ms) < RING_MS);
                self.recent.push(press);
                self.events.push(ClickEvent { ms: now, button, x, y, up_ms: now, up_x: x, up_y: y, origin: self.origin });
                true
            }
            (Some(_), None) => {
                self.press = None;
                if let Some(e) = self.events.last_mut() { (e.up_ms, e.up_x, e.up_y) = (now, x, y); }
                false
            }
            _ => false,
        }
    }
}

// Into video time and target pixels.
fn click_events(events: &[ClickEvent], start: u64, levels: u32) -> Vec<ClickEvent> {
    events.iter().map(|e| {
        let ((ox, oy), at) = (e.origin, |v: i32, o: i32| (v - o) >> levels);
        ClickEvent { ms: e.ms.saturating_sub(start), up_ms: e.up_ms.saturating_sub(start), x: at(e.x, ox), y: at(e.y, oy), up_x: at(e.up_x, ox), up_y: at(e.up_y, oy), ..e.clone() }
    }).collect()
}

fn color(button: &str) -> [u8; 3] { if button == "right" { [96, 165, 250] } else { [245, 184, 61] } }

// Drawing on a BGRA image with rows bottom to top, at top-down (x, y).
fn blend(bgra: &mut [u8], (w, h): (usize, usize), x: i32, y: i32, rgb: [u8; 3], alpha: f32) {
    if x < 0 || y < 0 || x as usize >= w || y as usize >= h { return; }
    let i = ((h - 1 - y as usize) * w + x as usize) * 4;
    for (p, v) in bgra[i..i + 3].iter_mut().zip([rgb[2], rgb[1], rgb[0]]) {
        *p = (f32::from(*p) * (1.0 - alpha) + f32::from(v) * alpha).round() as u8;
    }
}

fn ring(bgra: &mut [u8], size: (usize, usize), (cx, cy): (i32, i32), radius: f32, width: f32, rgb: [u8; 3], alpha: f32) {
    let r = (radius + width).ceil() as i32;
    for dy in -r..=r {
        for dx in -r..=r {
            if ((dx as f32).hypot(dy as f32) - radius).abs() <= width / 2.0 { blend(bgra, size, cx + dx, cy + dy, rgb, alpha); }
        }
    }
}

fn rect(bgra: &mut [u8], size: (usize, usize), a: (i32, i32), b: (i32, i32), width: i32, rgb: [u8; 3], outline: f32, fill: f32) {
    let (x0, x1, y0, y1) = (a.0.min(b.0), a.0.max(b.0), a.1.min(b.1), a.1.max(b.1));
    for y in y0.max(0)..=y1.min(size.1 as i32 - 1) {
        for x in x0.max(0)..=x1.min(size.0 as i32 - 1) {
            let edge = x - x0 < width || x1 - x < width || y - y0 < width || y1 - y < width;
            blend(bgra, size, x, y, rgb, if edge { outline } else { fill });
        }
    }
}

fn smooth(value: f32, target: f32, dt: f32, tau: f32) -> f32 { value + (target - value) * (1.0 - (-dt / tau).exp()) }

// The crop's center on one axis, keeping a size/z crop inside the frame.
fn clamp_center(center: f32, size: f32, z: f32) -> f32 { let half = size / z / 2.0; center.clamp(half, size - half) }

// Bilinear: the (w/z x h/z) crop around a top-down center, stretched over the whole bottom-to-top image.
fn zoom_frame(src: &[u8], out: &mut [u8], (w, h): (usize, usize), z: f32, (cx, cy): (f32, f32)) {
    let (left, top) = (cx - w as f32 / z / 2.0, cy - h as f32 / z / 2.0);
    let at = |x: usize, y: usize| ((h - 1 - y) * w + x) * 4;
    let axis = |start: f32, o: usize, n: usize| {
        let s = (start + (o as f32 + 0.5) / z - 0.5).clamp(0.0, (n - 1) as f32);
        (s as usize, (s as usize + 1).min(n - 1), s.fract())
    };
    for oy in 0..h {
        let (y0, y1, fy) = axis(top, oy, h);
        for ox in 0..w {
            let (x0, x1, fx) = axis(left, ox, w);
            let (a, b, c, d, o) = (at(x0, y0), at(x1, y0), at(x0, y1), at(x1, y1), at(ox, oy));
            for i in 0..4 {
                let p = |k: usize| f32::from(src[k + i]);
                out[o + i] = ((p(a) * (1.0 - fx) + p(b) * fx) * (1.0 - fy) + (p(c) * (1.0 - fx) + p(d) * fx) * fy).round() as u8;
            }
        }
    }
}

struct Zoom {
    z: f32,
    center: (f32, f32),
    last: Option<Instant>,
    copy: Vec<u8>,
}

fn monitor_origin(monitor: &Monitor) -> (i32, i32) {
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFO};
    let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
    let _ = unsafe { GetMonitorInfoW(HMONITOR(monitor.as_raw_hmonitor()), &mut info) };
    (info.rcMonitor.left, info.rcMonitor.top)
}

fn window_origin(hwnd: isize) -> Option<(i32, i32)> {
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    let mut rect = windows::Win32::Foundation::RECT::default();
    unsafe { DwmGetWindowAttribute(HWND(hwnd as _), DWMWA_EXTENDED_FRAME_BOUNDS, &mut rect as *mut _ as _, size_of_val(&rect) as u32) }.ok()?;
    Some((rect.left, rect.top))
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
struct KeyFrame {
    ms: u64,
    reason: String,
    file: String,
}

#[derive(Debug, PartialEq)]
enum Source {
    Monitor(usize),
    Window(isize),
    Region(usize, [u32; 4]),
}

#[derive(Debug, PartialEq)]
struct Options {
    source: Source,
    mic: bool,
    mic_device: Option<String>,
    system: bool,
    fps: u32,
    height: u32,
    clicks: bool,
    zoom: bool,
    game: bool,
    app: Option<u32>,
    mic_gain: f32,
    system_gain: f32,
}

fn parse_options(options: &Value, monitors: &[(u32, u32)], window_exists: impl Fn(isize) -> bool) -> Result<Options> {
    let invalid = || t("error.invalid-request");
    let fps = options["fps"].as_u64().filter(|f| matches!(f, 30 | 60)).ok_or_else(invalid)? as u32;
    let height = options["height"].as_u64().filter(|h| matches!(h, 720 | 1080 | 1440 | 2160)).ok_or_else(invalid)? as u32;
    let (Some(mic), Some(system)) = (options["mic"].as_bool(), options["system"].as_bool()) else { return Err(invalid()) };
    let flag = |key: &str| match &options[key] { Value::Null => Ok(false), Value::Bool(on) => Ok(*on), _ => Err(invalid()) };
    let (clicks, zoom, game) = (flag("clicks")?, flag("zoom")?, flag("game")?);
    let app = match &options["app"] {
        Value::Null => None,
        pid => Some(pid.as_u64().filter(|&p| p > 0).and_then(|p| u32::try_from(p).ok()).ok_or_else(invalid)?),
    };
    let gain = |key: &str| match &options[key] {
        Value::Null => Ok(1.0),
        value => value.as_f64().filter(|g| [1.0, 1.5, 2.0, 2.5, 3.0].contains(g)).map(|g| g as f32).ok_or_else(invalid),
    };
    let (mic_gain, system_gain) = (gain("micGain")?, gain("systemGain")?);
    let mic_device = match &options["micDevice"] {
        Value::Null => None,
        Value::String(id) if !id.is_empty() => Some(id.clone()),
        _ => return Err(invalid()),
    };
    let monitor = || -> Result<(usize, (u32, u32))> {
        let index = options["monitor"].as_u64().ok_or_else(invalid)? as usize;
        monitors.get(index).map(|&size| (index, size)).ok_or_else(|| t("error.recorder-no-source"))
    };
    let source = match options["kind"].as_str() {
        Some("monitor") => Source::Monitor(monitor()?.0),
        Some("window") => {
            let hwnd = options["hwnd"].as_i64().filter(|&h| h != 0).ok_or_else(invalid)? as isize;
            if !window_exists(hwnd) { return Err(t("error.recorder-no-source")); }
            Source::Window(hwnd)
        }
        Some("region") => {
            let (index, (width, height)) = monitor()?;
            let [x, y, w, h] = ["x", "y", "width", "height"].map(|key| options["rect"][key].as_u64().and_then(|v| u32::try_from(v).ok()));
            let (Some(x), Some(y), Some(w), Some(h)) = (x, y, w, h) else { return Err(invalid()) };
            if w < 16 || h < 16 || u64::from(x) + u64::from(w) > u64::from(width) || u64::from(y) + u64::from(h) > u64::from(height) {
                return Err(invalid());
            }
            Source::Region(index, [x, y, w, h])
        }
        _ => return Err(invalid()),
    };
    let fps = if game { 60 } else { fps };
    Ok(Options { source, mic, mic_device, system, fps, height, clicks: clicks && !game, zoom: zoom && !game, game, app: app.filter(|_| system), mic_gain, system_gain })
}

// GPU mipmaps halve the size per level: the smallest level k at or under the height limit, as (k, width, height), all even.
fn target_size(width: u32, height: u32, limit: u32) -> (u32, u32, u32) {
    let (width, height) = (width & !1, height & !1);
    let k = (0..31).find(|&k| height >> k <= limit).unwrap_or(0);
    (k, (width >> k) & !1, (height >> k) & !1)
}

fn root() -> Result<PathBuf> {
    use windows::Win32::UI::Shell::{FOLDERID_Videos, SHGetKnownFolderPath, KF_FLAG_CREATE};
    unsafe {
        let path = SHGetKnownFolderPath(&FOLDERID_Videos, KF_FLAG_CREATE, None).map_err(text)?;
        let videos = path.to_string();
        windows::Win32::System::Com::CoTaskMemFree(Some(path.0 as _));
        Ok(PathBuf::from(videos.map_err(text)?).join("Frugal Deck"))
    }
}

// Ids come from the renderer: only a folder directly under the root.
fn folder_of(root: &Path, id: &str) -> Result<PathBuf> {
    let mut parts = Path::new(id).components();
    let single = matches!((parts.next(), parts.next()), (Some(Component::Normal(name)), None) if name == id);
    let folder = root.join(id);
    if single && !id.contains(['/', '\\', ':']) && folder.is_dir() { Ok(folder) } else { Err(t("error.recorder-not-found")) }
}

fn local_id() -> String {
    let time = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    format!("{:04}-{:02}-{:02} {:02}-{:02}-{:02}", time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute, time.wSecond)
}

fn clock(ms: u64) -> String { format!("{}:{:02}", ms / 60000, ms / 1000 % 60) }

fn select_frames(frames: &[KeyFrame]) -> Vec<usize> {
    let even = |list: Vec<usize>, n: usize| -> Vec<usize> {
        if list.len() <= n { list } else { (0..n).map(|i| list[i * list.len() / n]).collect() }
    };
    if frames.len() <= MAX_CHAT_FRAMES { return (0..frames.len()).collect(); }
    let (events, intervals): (Vec<usize>, Vec<usize>) = (0..frames.len()).partition(|&i| frames[i].reason != "interval");
    let mut chosen = if events.len() >= MAX_CHAT_FRAMES { even(events, MAX_CHAT_FRAMES) } else {
        let rest = MAX_CHAT_FRAMES - events.len();
        events.into_iter().chain(even(intervals, rest)).collect()
    };
    chosen.sort_by_key(|&i| (frames[i].ms, i));
    chosen
}

fn file_name(file: &str) -> &str { Path::new(file).file_name().and_then(|n| n.to_str()).unwrap_or(file) }

fn timeline(recorded: &str, duration: u64, frames: &[&KeyFrame], speech: &[(u64, u64, String)]) -> String {
    let mut out = format!("# Screen recording\n\nRecorded {recorded}, {} long. The attached images are its key frames, in this order. Speech is the user's microphone, transcribed locally.\n\n", clock(duration));
    if speech.is_empty() { out.push_str("No speech transcript.\n"); }
    let mut events: Vec<(u64, String)> = frames.iter().enumerate()
        .map(|(n, f)| (f.ms, format!("[{}] Image {} ({}): {}", clock(f.ms), n + 1, f.reason, file_name(&f.file)))).collect();
    events.extend(speech.iter().map(|(start, end, said)| (*start, format!("[{}-{}] User says: {said}", clock(*start), clock(*end)))));
    events.sort_by_key(|(ms, _)| *ms);
    for (_, line) in events { out.push_str(&line); out.push('\n'); }
    out
}

// Mic speech transcribed elsewhere, in epoch ms, into video time.
fn voice_segments(segments: &Value, video_start: u64) -> Result<Vec<(u64, u64, String)>> {
    let invalid = || t("error.invalid-request");
    let list = segments.as_array().filter(|l| l.len() <= 5000).ok_or_else(invalid)?;
    list.iter().map(|s| {
        let (Some(start), Some(end), Some(said)) = (s["start"].as_u64(), s["end"].as_u64(), s["text"].as_str()) else { return Err(invalid()) };
        if start > end || said.trim().is_empty() || said.chars().count() > 4000 { return Err(invalid()); }
        Ok((start.saturating_sub(video_start), end.saturating_sub(video_start), said.trim().to_owned()))
    }).collect()
}

// 16 kHz mono 16-bit PCM, what whisper-cli reads.
fn wav_header(data: u32) -> Vec<u8> {
    [b"RIFF".as_slice(), &(36 + data).to_le_bytes(), b"WAVEfmt ", &16u32.to_le_bytes(), &1u16.to_le_bytes(), &1u16.to_le_bytes(),
        &16000u32.to_le_bytes(), &32000u32.to_le_bytes(), &2u16.to_le_bytes(), &16u16.to_le_bytes(), b"data", &data.to_le_bytes()].concat()
}

fn key_reason(first: bool, click: bool, since_last: u64, difference: f64) -> Option<&'static str> {
    if first { Some("start") }
    else if click { Some("click") }
    else if since_last >= 1000 && difference > 10.0 { Some("change") }
    else if since_last >= 10_000 { Some("interval") }
    else { None }
}

// 32x18 mean grays of a BGRA image.
fn signature(bgra: &[u8], width: usize, height: usize) -> Vec<u8> {
    let (mut sum, mut count) = (vec![0u32; 32 * 18], vec![0u32; 32 * 18]);
    for y in (0..height).step_by(4) {
        for x in (0..width).step_by(4) {
            let (p, cell) = (&bgra[(y * width + x) * 4..], y * 18 / height * 32 + x * 32 / width);
            sum[cell] += (u32::from(p[2]) * 299 + u32::from(p[1]) * 587 + u32::from(p[0]) * 114) / 1000;
            count[cell] += 1;
        }
    }
    sum.iter().zip(&count).map(|(s, n)| (s / n.max(&1)) as u8).collect()
}

fn difference(a: &[u8], b: &[u8]) -> f64 {
    a.iter().zip(b).map(|(x, y)| f64::from(x.abs_diff(*y))).sum::<f64>() / a.len().max(1) as f64
}

// Nearest-neighbour RGB copy of a bottom-to-top BGRA image, at most `max` wide.
fn downscale(bgra: &[u8], width: usize, height: usize, max: usize) -> (u32, u32, Vec<u8>) {
    let (w, h) = if width <= max { (width, height) } else { (max, (height * max / width).max(1)) };
    let mut out = Vec::with_capacity(w * h * 3);
    for y in 0..h {
        let row = height - 1 - y * height / h;
        for x in 0..w {
            let p = &bgra[(row * width + x * width / w) * 4..];
            out.extend_from_slice(&[p[2], p[1], p[0]]);
        }
    }
    (w as u32, h as u32, out)
}

fn encode_png(width: u32, height: u32, color: png::ColorType, data: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(color);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header().map_err(text)?.write_image_data(data).map_err(text)?;
    Ok(out)
}

struct Gpu {
    work: ID3D11Texture2D,
    view: ID3D11ShaderResourceView,
    clear: ID3D11RenderTargetView,
    staging: ID3D11Texture2D,
}

// Created and used only on the capture thread.
unsafe impl Send for Gpu {}

impl Gpu {
    fn new(device: &ID3D11Device, size: (u32, u32), levels: u32, target: (u32, u32)) -> windows::core::Result<Self> {
        let mut desc = D3D11_TEXTURE2D_DESC {
            Width: size.0,
            Height: size.1,
            MipLevels: levels + 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: D3D11_RESOURCE_MISC_GENERATE_MIPS.0 as u32,
        };
        let (mut work, mut view, mut clear, mut staging) = (None, None, None, None);
        unsafe {
            device.CreateTexture2D(&desc, None, Some(&mut work))?;
            let work = work.as_ref().unwrap();
            device.CreateShaderResourceView(work, None, Some(&mut view))?;
            device.CreateRenderTargetView(work, None, Some(&mut clear))?;
            desc = D3D11_TEXTURE2D_DESC { Width: target.0, Height: target.1, MipLevels: 1, Usage: D3D11_USAGE_STAGING, BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32, MiscFlags: 0, ..desc };
            device.CreateTexture2D(&desc, None, Some(&mut staging))?;
        }
        Ok(Self { work: work.unwrap(), view: view.unwrap(), clear: clear.unwrap(), staging: staging.unwrap() })
    }
}

#[derive(Default)]
struct Keys {
    saved: usize,
    last_check: u64,
    last_saved: u64,
    click: u64,
    signature: Vec<u8>,
}

struct Recorder {
    shared: Arc<Shared>,
    crop: (u32, u32),
    size: (u32, u32),
    levels: u32,
    target: (u32, u32),
    gpu: Option<Gpu>,
    // The target-size frame, BGRA rows bottom to top as the encoder takes them.
    buffer: Vec<u8>,
    keys: Keys,
    clicks: bool,
    game: bool,
    window: Option<isize>,
    // The capture's screen top-left.
    origin: (i32, i32),
    zoom: Option<Zoom>,
}

impl Recorder {
    fn frame(&mut self, frame: &mut Frame) -> Result<()> {
        let start = *self.shared.video_start.get_or_init(Instant::now);
        let ((ww, wh), (tw, th), (x, y)) = (self.size, self.target, self.crop);
        if self.gpu.is_none() { self.gpu = Some(Gpu::new(frame.device(), self.size, self.levels, self.target).map_err(text)?); }
        let gpu = self.gpu.as_ref().unwrap();
        // A window that changes size keeps the encoder's size: the top-left part that fits, the rest black.
        let (w, h) = (frame.width().saturating_sub(x).min(ww), frame.height().saturating_sub(y).min(wh));
        if w == 0 || h == 0 { return Ok(()); }
        let row = tw as usize * 4;
        self.buffer.resize(row * th as usize, 0);
        // frugal: send_frame_buffer copies every frame through the CPU; encoding the GPU surface directly is the upgrade.
        unsafe {
            let context = frame.device_context();
            if (w, h) != (ww, wh) { context.ClearRenderTargetView(&gpu.clear, &[0.0, 0.0, 0.0, 1.0]); }
            context.CopySubresourceRegion(&gpu.work, 0, 0, 0, 0, frame.as_raw_texture(), 0, Some(&D3D11_BOX { left: x, top: y, front: 0, right: x + w, bottom: y + h, back: 1 }));
            if self.levels > 0 { context.GenerateMips(&gpu.view); }
            context.CopySubresourceRegion(&gpu.staging, 0, 0, 0, 0, &gpu.work, self.levels, Some(&D3D11_BOX { left: 0, top: 0, front: 0, right: tw, bottom: th, back: 1 }));
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            context.Map(&gpu.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).map_err(text)?;
            let pitch = mapped.RowPitch as usize;
            let pixels = std::slice::from_raw_parts(mapped.pData as *const u8, pitch * (th as usize - 1) + row);
            for (r, out) in self.buffer.chunks_exact_mut(row).rev().enumerate() { out.copy_from_slice(&pixels[r * pitch..r * pitch + row]); }
            context.Unmap(&gpu.staging, 0);
        }
        if !self.game { self.overlay(); }
        let timestamp = frame.timestamp().map_err(text)?.Duration;
        if let Some(encoder) = self.shared.encoder.lock().unwrap().as_mut() { encoder.send_frame_buffer(&self.buffer, timestamp).map_err(text)?; }
        self.key_frame(start);
        Ok(())
    }

    // Click highlights, then the zoom, so highlights zoom with the content.
    fn overlay(&mut self) {
        if let Some(origin) = self.window.and_then(window_origin) { self.origin = origin; }
        let now = self.shared.origin.elapsed().as_millis() as u64;
        let (pos, press, recent, active) = {
            let mut pointer = self.shared.pointer.lock().unwrap();
            pointer.origin = self.origin;
            (pointer.pos, pointer.press, pointer.recent.clone(), pointer.active)
        };
        let (origin, levels, size) = (self.origin, self.levels, (self.target.0 as usize, self.target.1 as usize));
        let target = |(x, y): (i32, i32)| ((x - origin.0) >> levels, (y - origin.1) >> levels);
        if self.clicks {
            let width = (2 >> levels).max(1);
            for p in recent.iter().filter(|p| now.saturating_sub(p.ms) < RING_MS) {
                let t = now.saturating_sub(p.ms) as f32 / RING_MS as f32;
                ring(&mut self.buffer, size, target(p.at), ((12.0 + 14.0 * t) / (1 << levels) as f32).max(8.0), width as f32, color(p.button), 0.9 * (1.0 - t));
            }
            let dragged = |p: &Press| (pos.0 - p.at.0).pow(2) + (pos.1 - p.at.1).pow(2) > 64;
            if let Some(p) = press.filter(dragged) { rect(&mut self.buffer, size, target(p.at), target(pos), width, color(p.button), 0.9, 0.15); }
        }
        let Some(zoom) = self.zoom.as_mut() else { return };
        // frugal: upscaling the target-size frame loses detail; cropping the full-resolution work texture on the GPU is the upgrade.
        // frugal: WGC sends frames only on change, so a zoom-out on a static screen waits for the next change.
        let at = Instant::now();
        let dt = zoom.last.map_or(0.0, |last| (at - last).as_secs_f32());
        zoom.last = Some(at);
        let goal = if active.is_some_and(|a| now.saturating_sub(a) < 3000) { 2.0 } else { 1.0 };
        zoom.z = smooth(zoom.z, goal, dt, 0.25).clamp(1.0, 2.0);
        let (px, py) = target(pos);
        let (w, h) = (size.0 as f32, size.1 as f32);
        zoom.center = (clamp_center(smooth(zoom.center.0, px as f32, dt, 0.2), w, zoom.z), clamp_center(smooth(zoom.center.1, py as f32, dt, 0.2), h, zoom.z));
        if zoom.z > 1.01 {
            zoom.copy.clone_from(&self.buffer);
            zoom_frame(&zoom.copy, &mut self.buffer, size, zoom.z, zoom.center);
        }
    }

    fn key_frame(&mut self, start: Instant) {
        let (shared, keys) = (&self.shared, &mut self.keys);
        let now = shared.origin.elapsed().as_millis() as u64;
        // Past the first frames a long recording keeps one every 10 s at most, so key frames cover its end too.
        let spaced = keys.saved < MAX_KEY_FRAMES || now >= keys.last_saved + 10_000;
        if keys.saved >= MAX_KEY_FRAMES * 5 || !spaced || (self.game && keys.saved > 0) || (keys.saved > 0 && now < keys.last_check + 500) { return; }
        keys.last_check = now;
        let (tw, th) = (self.target.0 as usize, self.target.1 as usize);
        let signature = signature(&self.buffer, tw, th);
        let click = shared.click.load(Ordering::Relaxed);
        let click_due = click != keys.click && now >= click - 1 + 250;
        let Some(reason) = key_reason(keys.saved == 0, click_due, now - keys.last_saved, difference(&signature, &keys.signature)) else { return };
        if click_due { keys.click = click; }
        let ms = start.elapsed().as_millis() as u64;
        let file = format!("frames/{ms:08}.png");
        let (w, h, rgb) = downscale(&self.buffer, tw, th, 1280);
        let thumb = (keys.saved == 0).then(|| downscale(&self.buffer, tw, th, 320));
        if let Some(writer) = shared.writer.lock().unwrap().as_ref() {
            let _ = writer.send((shared.folder.join("frames").join(format!("{ms:08}.png")), w, h, rgb, thumb));
        }
        shared.frames.lock().unwrap().push(KeyFrame { ms, reason: reason.into(), file });
        keys.saved += 1;
        keys.last_saved = now;
        keys.signature = signature;
    }
}

impl GraphicsCaptureApiHandler for Recorder {
    type Flags = Self;
    type Error = String;

    fn new(ctx: Context<Self>) -> Result<Self> { Ok(ctx.flags) }

    fn on_frame_arrived(&mut self, frame: &mut Frame, _: InternalCaptureControl) -> Result<()> {
        self.frame(frame).inspect_err(|error| {
            crate::debug_log!("recorder", "Recording failed: {error}");
            ended(&self.shared);
        })
    }

    fn on_closed(&mut self) -> Result<()> {
        ended(&self.shared);
        Ok(())
    }
}

// The source closed or failed: stop on another thread, since stopping joins the capture thread.
fn ended(shared: &Arc<Shared>) {
    if shared.ended.swap(true, Ordering::Relaxed) { return; }
    let shared = shared.clone();
    thread::spawn(move || {
        if let Some(result) = stop(Some(&shared)) {
            let id = match result {
                Ok(item) => item["id"].clone(),
                Err(error) => { crate::debug_log!("recorder", "Stopping failed: {error}"); Value::Null }
            };
            let _ = shared.app.emit("recorder:state", [json!({"recording": false, "started": null, "closed": true, "id": id})]);
        }
    });
}

struct Snapshot(mpsc::Sender<Result<(u32, u32, Vec<u8>)>>);

impl GraphicsCaptureApiHandler for Snapshot {
    type Flags = mpsc::Sender<Result<(u32, u32, Vec<u8>)>>;
    type Error = String;

    fn new(ctx: Context<Self::Flags>) -> Result<Self> { Ok(Self(ctx.flags)) }

    fn on_frame_arrived(&mut self, frame: &mut Frame, control: InternalCaptureControl) -> Result<()> {
        let (width, height) = (frame.width(), frame.height());
        let pixels = frame.buffer().map_err(text).map(|buffer| buffer.as_nopadding_buffer(&mut Vec::new()).to_vec());
        let _ = self.0.send(pixels.map(|p| (width, height, p)));
        control.stop();
        Ok(())
    }
}

fn watch_clicks(shared: &Shared) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VIRTUAL_KEY, VK_LBUTTON, VK_RBUTTON};
    let down = |key: VIRTUAL_KEY| unsafe { GetAsyncKeyState(i32::from(key.0)) } < 0;
    while !shared.stop.load(Ordering::Relaxed) {
        let button = if down(VK_LBUTTON) { Some("left") } else if down(VK_RBUTTON) { Some("right") } else { None };
        let now = shared.origin.elapsed().as_millis() as u64;
        let mut pos = windows::Win32::Foundation::POINT::default();
        let mut pointer = shared.pointer.lock().unwrap();
        if unsafe { windows::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut pos) }.is_ok() { pointer.pos = (pos.x, pos.y); }
        if pointer.update(button, now) { shared.click.store(now + 1, Ordering::Relaxed); }
        drop(pointer);
        thread::sleep(Duration::from_millis(15));
    }
}

fn format() -> wasapi::WaveFormat { wasapi::WaveFormat::new(32, 32, wasapi::SampleType::Float, RATE as usize, 2, None) }

// One process tree's output; process loopback takes only event-driven shared mode.
fn app_loopback(pid: u32) -> std::result::Result<wasapi::AudioClient, wasapi::WasapiError> {
    let mut client = wasapi::AudioClient::new_application_loopback_client(pid, true)?;
    client.initialize_client(&format(), wasapi::Direction::Capture, wasapi::StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 }, None)?;
    Ok(client)
}

// The microphone, the default output in loopback, or one app's output, as 48 kHz stereo f32.
fn record_audio(shared: &Shared, queue: &Queue, device: Option<String>, loopback: bool, app: Option<u32>) {
    let result = (|| -> std::result::Result<(), Box<dyn std::error::Error>> {
        wasapi::initialize_mta().ok()?;
        let (client, event) = match app {
            Some(pid) => { let client = app_loopback(pid)?; let event = client.set_get_eventhandle()?; (client, Some(event)) }
            None => {
                let enumerator = wasapi::DeviceEnumerator::new()?;
                let device = match device {
                    Some(id) => enumerator.get_device(&id)?,
                    None => enumerator.get_default_device(if loopback { wasapi::Direction::Render } else { wasapi::Direction::Capture })?,
                };
                let mut client = device.get_iaudioclient()?;
                client.initialize_client(&format(), wasapi::Direction::Capture, wasapi::StreamMode::PollingShared { autoconvert: true, buffer_duration_hns: 2_000_000 }, None)?;
                (client, None)
            }
        };
        let capture = client.get_audiocaptureclient()?;
        client.start_stream()?;
        let mut bytes = VecDeque::new();
        while !shared.stop.load(Ordering::Relaxed) {
            match &event {
                Some(event) => {
                    if event.wait_for_event(100).is_err() { continue; }
                    while capture.get_next_packet_size()?.unwrap_or(0) > 0 { capture.read_from_device_to_deque(&mut bytes)?; }
                }
                None => {
                    thread::sleep(Duration::from_millis(10));
                    capture.read_from_device_to_deque(&mut bytes)?;
                }
            }
            let mut queue = queue.lock().unwrap();
            while bytes.len() >= 4 {
                let sample: Vec<u8> = bytes.drain(..4).collect();
                queue.push_back(f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]));
            }
        }
        client.stop_stream()?;
        Ok(())
    })();
    if let Err(error) = result { crate::debug_log!("recorder", "Audio capture failed: {error}"); }
}

// A 16 kHz mono WAV from 48 kHz stereo: pairs averaged, one sample per 3 kept; the header goes in at the end.
struct Wav {
    name: &'static str,
    out: Option<BufWriter<File>>,
    bytes: u32,
    sum: f32,
    count: u32,
}

impl Wav {
    fn create(folder: &Path, name: &'static str) -> Result<Self> {
        let mut out = BufWriter::new(File::create(folder.join(name)).map_err(text)?);
        out.write_all(&wav_header(0)).map_err(text)?;
        Ok(Self { name, out: Some(out), bytes: 0, sum: 0.0, count: 0 })
    }

    // Padded with silence to n stereo frames.
    fn push(&mut self, stereo: &[f32], n: usize) {
        let Some(out) = self.out.as_mut() else { return };
        let mut written = Ok(());
        for i in 0..n {
            let pair = stereo.get(i * 2..i * 2 + 2).unwrap_or(&[0.0, 0.0]);
            self.sum += (pair[0] + pair[1]) / 2.0;
            self.count += 1;
            if self.count == 3 {
                written = written.and_then(|_| out.write_all(&(((self.sum / 3.0).clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes()));
                self.bytes += 2;
                (self.sum, self.count) = (0.0, 0);
            }
        }
        if let Err(error) = written { crate::debug_log!("recorder", "{} failed: {error}", self.name); self.out = None; }
    }

    fn finish(self) {
        let Some(out) = self.out else { return };
        let result = out.into_inner().map_err(text).and_then(|mut file| {
            file.seek(SeekFrom::Start(0)).and_then(|_| file.write_all(&wav_header(self.bytes))).map_err(text)
        });
        if let Err(error) = result { crate::debug_log!("recorder", "{} failed: {error}", self.name); }
    }
}

// The encoder's audio clock counts samples, so it gets exactly the wall clock's worth, silence included.
fn mix(shared: &Arc<Shared>, sources: Vec<(bool, f32, Queue)>, mut mic_wav: Option<Wav>, mut system_wav: Option<Wav>) {
    let mut sent = 0u64;
    while !shared.stop.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(10));
        let Some(start) = shared.video_start.get() else {
            for (_, _, queue) in &sources { queue.lock().unwrap().clear(); }
            continue;
        };
        let n = (start.elapsed().as_micros() as u64 * RATE / 1_000_000).saturating_sub(sent) as usize;
        if n == 0 { continue; }
        let mut mixed = vec![0.0f32; n * 2];
        for (is_mic, gain, queue) in &sources {
            let mut queue = queue.lock().unwrap();
            let excess = queue.len().saturating_sub((n + RATE as usize / 5) * 2);
            queue.drain(..excess);
            let take = queue.len().min(n * 2);
            let samples: Vec<f32> = queue.drain(..take).map(|s| s * gain).collect();
            for (m, s) in mixed.iter_mut().zip(&samples) { *m += s; }
            if let Some(wav) = if *is_mic { mic_wav.as_mut() } else { system_wav.as_mut() } { wav.push(&samples, n); }
        }
        // frugal: hard clip on boost; a soft limiter is the upgrade.
        let bytes: Vec<u8> = mixed.iter().flat_map(|s| ((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes()).collect();
        if let Some(encoder) = shared.encoder.lock().unwrap().as_mut() {
            if let Err(error) = encoder.send_audio_buffer(&bytes, 0) {
                crate::debug_log!("recorder", "Audio encoding failed: {error}");
                ended(shared);
                break;
            }
        }
        sent += n as u64;
    }
    mic_wav.into_iter().chain(system_wav).for_each(Wav::finish);
}

fn write_frames(jobs: mpsc::Receiver<Job>, thumb: PathBuf) {
    for (file, width, height, rgb, small) in jobs {
        let mut result = encode_png(width, height, png::ColorType::Rgb, &rgb).and_then(|png| fs::write(&file, png).map_err(text));
        if let Some((w, h, rgb)) = small {
            result = result.and(encode_png(w, h, png::ColorType::Rgb, &rgb).and_then(|png| fs::write(&thumb, png).map_err(text)));
        }
        if let Err(error) = result { crate::debug_log!("recorder", "Key frame failed: {error}"); }
    }
}

fn capture<T: TryInto<GraphicsCaptureItemType> + Send + 'static>(item: T, fps: u32, recorder: Recorder) -> Result<CaptureControl<Recorder, String>> {
    Recorder::start_free_threaded(Settings::new(item, CursorCaptureSettings::WithCursor, DrawBorderSettings::Default, SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Custom(Duration::from_millis(1000 / u64::from(fps))), DirtyRegionSettings::Default, ColorFormat::Bgra8, recorder))
        .map_err(text)
}

fn window_size(hwnd: isize) -> Result<(u32, u32)> {
    let item: GraphicsCaptureItemType = Window::from_raw_hwnd(hwnd as _).try_into().map_err(|_| t("error.recorder-no-source"))?;
    let GraphicsCaptureItemType::Window((item, _)) = item else { return Err(t("error.recorder-no-source")) };
    let size = item.Size().map_err(text)?;
    Ok((size.Width.max(0) as u32, size.Height.max(0) as u32))
}

fn launch(app: AppHandle, options: &Options, monitors: &[Monitor], folder: &Path, size: (u32, u32), crop: (u32, u32)) -> Result<(Arc<Shared>, Parts)> {
    let (levels, tw, th) = target_size(size.0, size.1, options.height);
    fs::create_dir(folder.join("frames")).map_err(text)?;
    let encoder = VideoEncoder::new(VideoSettingsBuilder::new(tw, th).sub_type(VideoSettingsSubType::H264).frame_rate(options.fps)
            // About 0.125 bits per pixel: 1080p30 at 7.8 Mbps instead of the crate's fixed 15.
            .bitrate((tw * th * options.fps / 8).max(1_000_000) * if options.game { 2 } else { 1 }),
        AudioSettingsBuilder::default().disabled(!options.mic && !options.system), ContainerSettingsBuilder::default(), folder.join("recording.mp4")).map_err(text)?;
    let mic_wav = if options.mic { Some(Wav::create(folder, "mic.wav")?) } else { None };
    let system_wav = if options.system { Some(Wav::create(folder, "system.wav")?) } else { None };
    let (send, receive) = mpsc::channel();
    let thumb = folder.join("thumb.png");
    let writer = thread::spawn(move || write_frames(receive, thumb));
    let (window, origin) = match options.source {
        Source::Window(hwnd) => (Some(hwnd), window_origin(hwnd).unwrap_or_default()),
        Source::Monitor(index) | Source::Region(index, _) => { let (x, y) = monitor_origin(&monitors[index]); (None, (x + crop.0 as i32, y + crop.1 as i32)) }
    };
    let shared = Arc::new(Shared {
        app, folder: folder.to_path_buf(), origin: Instant::now(), video_start: OnceLock::new(), stop: AtomicBool::new(false), ended: AtomicBool::new(false),
        click: AtomicU64::new(0), encoder: Mutex::new(Some(encoder)), frames: Mutex::new(Vec::new()), writer: Mutex::new(Some(send)),
        pointer: Mutex::new(Pointer { origin, ..Pointer::default() }), levels, game: options.game,
    });
    let mut threads = Vec::new();
    if !options.game { let shared = shared.clone(); threads.push(thread::spawn(move || watch_clicks(&shared))); }
    if options.mic || options.system {
        let mut sources = Vec::new();
        for (on, is_mic, gain) in [(options.mic, true, options.mic_gain), (options.system, false, options.system_gain)] {
            if !on { continue; }
            let queue = Queue::default();
            sources.push((is_mic, gain, queue.clone()));
            let (shared, device, app) = (shared.clone(), options.mic_device.clone().filter(|_| is_mic), options.app.filter(|_| !is_mic));
            threads.push(thread::spawn(move || record_audio(&shared, &queue, device, !is_mic, app)));
        }
        let shared = shared.clone();
        threads.push(thread::spawn(move || mix(&shared, sources, mic_wav, system_wav)));
    }
    let zoom = options.zoom.then(|| Zoom { z: 1.0, center: (tw as f32 / 2.0, th as f32 / 2.0), last: None, copy: Vec::new() });
    let recorder = Recorder { shared: shared.clone(), crop, size, levels, target: (tw, th), gpu: None, buffer: Vec::new(), keys: Keys::default(),
        clicks: options.clicks, game: options.game, window, origin, zoom };
    let control = match options.source {
        Source::Window(hwnd) => capture(Window::from_raw_hwnd(hwnd as _), options.fps, recorder),
        Source::Monitor(index) | Source::Region(index, _) => capture(monitors[index], options.fps, recorder),
    };
    match control {
        Ok(control) => Ok((shared, Parts { control, threads, writer })),
        Err(error) => {
            shared.stop.store(true, Ordering::Relaxed);
            threads.into_iter().for_each(|t| { let _ = t.join(); });
            drop(shared.encoder.lock().unwrap().take());
            drop(shared.writer.lock().unwrap().take());
            let _ = writer.join();
            Err(error)
        }
    }
}

fn start(app: AppHandle, options: &Value) -> Result<Value> {
    let _ = wasapi::initialize_mta();
    let mut session = SESSION.lock().unwrap();
    if session.is_some() { return Err(t("error.recorder-busy")); }
    let monitors = Monitor::enumerate().map_err(text)?;
    let sizes = monitors.iter().map(|m| Ok((m.width().map_err(text)?, m.height().map_err(text)?))).collect::<Result<Vec<_>>>()?;
    let options = parse_options(options, &sizes, |hwnd| unsafe { windows::Win32::UI::WindowsAndMessaging::IsWindow(Some(HWND(hwnd as _))).as_bool() })?;
    if let Some(id) = &options.mic_device { wasapi::DeviceEnumerator::new().and_then(|e| e.get_device(id)).map_err(text)?; }
    // The client is not Send: tried here to fail early, opened again on the audio thread.
    if let Some(pid) = options.app { app_loopback(pid).map_err(text)?; }
    let (kind, crop, size) = match options.source {
        Source::Monitor(index) => ("monitor", (0, 0), sizes[index]),
        Source::Region(_, [x, y, w, h]) => ("region", (x, y), (w, h)),
        Source::Window(hwnd) => ("window", (0, 0), window_size(hwnd)?),
    };
    let size = (size.0 & !1, size.1 & !1);
    if size.0 < 16 || size.1 < 16 { return Err(t("error.recorder-no-source")); }
    let root = root()?;
    fs::create_dir_all(&root).map_err(text)?;
    let id = local_id();
    let folder = root.join(&id);
    match fs::create_dir(&folder) {
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Err(t("error.recorder-busy")),
        result => result.map_err(text)?,
    }
    let started = now_ms();
    let (shared, parts) = launch(app.clone(), &options, &monitors, &folder, size, crop).inspect_err(|_| { let _ = fs::remove_dir_all(&folder); })?;
    *session = Some(Session { id, started, kind, mic: options.mic, system: options.system, shared, parts: Some(parts) });
    let _ = app.emit("recorder:state", [json!({"recording": true, "started": started})]);
    Ok(json!({"ok": true}))
}

// None when there is nothing to stop; `only` limits it to that session.
fn stop(only: Option<&Arc<Shared>>) -> Option<Result<Value>> {
    let (parts, shared, started, kind, mic, system) = {
        let mut session = SESSION.lock().unwrap();
        let s = session.as_mut().filter(|s| s.parts.is_some() && only.is_none_or(|o| Arc::ptr_eq(o, &s.shared)))?;
        (s.parts.take().unwrap(), s.shared.clone(), s.started, s.kind, s.mic, s.system)
    };
    let result = (|| {
        if let Err(error) = parts.control.stop() { crate::debug_log!("recorder", "Capture ended with: {error}"); }
        shared.stop.store(true, Ordering::Relaxed);
        parts.threads.into_iter().for_each(|t| { let _ = t.join(); });
        let duration = shared.video_start.get().map_or(0, |s| s.elapsed().as_millis() as u64);
        // Epoch ms of the first frame, which video and key frame times count from.
        let video_start = shared.video_start.get().map_or(started, |s| now_ms().saturating_sub(s.elapsed().as_millis() as u64));
        let encoded = shared.encoder.lock().unwrap().take().map_or(Ok(()), |e| e.finish().map_err(text));
        drop(shared.writer.lock().unwrap().take());
        let _ = parts.writer.join();
        let frames = shared.frames.lock().unwrap().clone();
        fs::write(shared.folder.join("frames.json"), serde_json::to_vec(&frames).map_err(text)?).map_err(text)?;
        if !shared.game {
            let start = shared.video_start.get().map_or(0, |s| s.duration_since(shared.origin).as_millis() as u64);
            let clicks = click_events(&shared.pointer.lock().unwrap().events, start, shared.levels);
            fs::write(shared.folder.join("clicks.json"), serde_json::to_vec(&clicks).map_err(text)?).map_err(text)?;
        }
        fs::write(shared.folder.join("meta.json"), json!({"started": started, "videoStart": video_start, "duration": duration, "kind": kind, "hasMic": mic, "hasSystem": system}).to_string()).map_err(text)?;
        encoded?;
        item(&shared.folder).ok_or_else(|| t("error.recorder-not-found"))
    })();
    *SESSION.lock().unwrap() = None;
    Some(result)
}

fn item(folder: &Path) -> Option<Value> {
    let video = folder.join("recording.mp4");
    let size = fs::metadata(&video).ok()?.len();
    let meta: Value = serde_json::from_slice(&fs::read(folder.join("meta.json")).ok()?).ok()?;
    let frames = fs::read(folder.join("frames.json")).ok().and_then(|b| serde_json::from_slice::<Vec<Value>>(&b).ok()).map_or(0, |f| f.len());
    let thumbnail = fs::read(folder.join("thumb.png")).ok().map(|png| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)));
    Some(json!({"id": folder.file_name()?.to_str()?, "video": video, "folder": folder, "started": meta["started"], "duration": meta["duration"],
        "size": size, "thumbnail": thumbnail, "frames": frames, "hasMic": meta["hasMic"].as_bool().unwrap_or(false),
        "hasSystem": meta["hasSystem"].as_bool().unwrap_or(false)}))
}

fn for_chat(app: &AppHandle, id: &str, model: Option<String>, language: Option<String>) -> Result<Value> {
    let folder = folder_of(&root()?, id)?;
    let meta: Value = fs::read(folder.join("meta.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).ok_or_else(|| t("error.recorder-not-found"))?;
    let frames: Vec<KeyFrame> = serde_json::from_slice(&fs::read(folder.join("frames.json")).map_err(|_| t("error.recorder-not-found"))?).map_err(text)?;
    let chosen: Vec<&KeyFrame> = select_frames(&frames).into_iter().map(|i| &frames[i]).collect();
    let wav = folder.join("mic.wav");
    let (transcribed, speech) = match (model, language) {
        (Some(model), Some(language)) if wav.exists() => (true, crate::voice::transcribe_segments(app, &wav, &model, &language)?),
        _ => (false, Vec::new()),
    };
    // The id is the local start time, "YYYY-MM-DD HH-MM-SS".
    let recorded = id.split_once(' ').map_or(id.to_owned(), |(day, time)| format!("{day} {}", time.replace('-', ":")));
    let file = folder.join("timeline.md");
    fs::write(&file, timeline(&recorded, meta["duration"].as_u64().unwrap_or(0), &chosen, &speech)).map_err(text)?;
    let mut files = vec![file];
    files.extend(chosen.iter().map(|f| folder.join("frames").join(file_name(&f.file))));
    Ok(json!({"files": files, "transcript": transcribed}))
}

async fn blocking(work: impl FnOnce() -> Result<Value> + Send + 'static) -> Value {
    match tauri::async_runtime::spawn_blocking(work).await.map_err(text).and_then(|r| r) { Ok(value) => value, Err(error) => json!({"error": error}) }
}

#[tauri::command]
pub async fn recorder_sources() -> Value {
    blocking(|| {
        let _ = wasapi::initialize_mta();
        let monitors: Vec<Value> = Monitor::enumerate().map_err(text)?.iter().enumerate()
            .map(|(index, m)| json!({"index": index, "name": m.name().unwrap_or_default(), "width": m.width().unwrap_or(0), "height": m.height().unwrap_or(0)})).collect();
        let own = std::process::id();
        let windows: Vec<Value> = Window::enumerate().map_err(text)?.into_iter().filter_map(|w| {
            let title = w.title().ok().filter(|t| !t.trim().is_empty())?;
            let pid = w.process_id().ok().filter(|&pid| pid != own)?;
            Some(json!({"hwnd": w.as_raw_hwnd() as isize, "title": title, "process": w.process_name().unwrap_or_default(), "pid": pid}))
        }).collect();
        let devices = wasapi::DeviceEnumerator::new().and_then(|e| e.get_device_collection(wasapi::Direction::Capture)).map_err(text)?;
        let mics: Vec<Value> = (&devices).into_iter().filter_map(|d| {
            let d = d.ok()?;
            Some(json!({"id": d.get_id().ok()?, "name": d.get_friendlyname().unwrap_or_default()}))
        }).collect();
        Ok(json!({"monitors": monitors, "windows": windows, "mics": mics}))
    }).await
}

#[tauri::command]
pub async fn recorder_snapshot(monitor: usize) -> Value {
    blocking(move || {
        let item = Monitor::enumerate().map_err(text)?.into_iter().nth(monitor).ok_or_else(|| t("error.recorder-no-source"))?;
        let (send, receive) = mpsc::channel();
        let control = Snapshot::start_free_threaded(Settings::new(item, CursorCaptureSettings::WithoutCursor, DrawBorderSettings::Default,
            SecondaryWindowSettings::Default, MinimumUpdateIntervalSettings::Default, DirtyRegionSettings::Default, ColorFormat::Bgra8, send)).map_err(text)?;
        let frame = receive.recv_timeout(Duration::from_secs(5)).map_err(text);
        let _ = control.stop();
        let (width, height, mut pixels) = frame??;
        for p in pixels.chunks_exact_mut(4) { p.swap(0, 2); p[3] = 255; }
        let png = encode_png(width, height, png::ColorType::Rgba, &pixels)?;
        Ok(json!({"png": base64::engine::general_purpose::STANDARD.encode(png), "width": width, "height": height}))
    }).await
}

#[tauri::command]
pub async fn recorder_start(app: AppHandle, options: Value) -> Value { blocking(move || start(app, &options)).await }

#[tauri::command]
pub async fn recorder_stop(app: AppHandle) -> Value {
    blocking(move || {
        let result = stop(None).ok_or_else(|| t("error.recorder-not-recording"))?;
        let _ = app.emit("recorder:state", [json!({"recording": false, "started": null})]);
        Ok(json!({"recording": result?}))
    }).await
}

#[tauri::command]
pub async fn recorder_state() -> Value {
    match SESSION.lock().unwrap().as_ref().filter(|s| s.parts.is_some()) {
        Some(s) => json!({"recording": true, "started": s.started}),
        None => json!({"recording": false, "started": null}),
    }
}

#[tauri::command]
pub async fn recorder_list() -> Value {
    blocking(|| {
        let mut items: Vec<Value> = fs::read_dir(root()?).map(|dir| dir.filter_map(|e| item(&e.ok()?.path())).collect()).unwrap_or_default();
        items.sort_by_key(|i| std::cmp::Reverse(i["started"].as_u64().unwrap_or(0)));
        Ok(json!({"recordings": items}))
    }).await
}

#[tauri::command]
pub async fn recorder_delete(id: String) -> Value {
    blocking(move || {
        let folder = folder_of(&root()?, &id)?;
        if SESSION.lock().unwrap().as_ref().is_some_and(|s| s.id == id) { return Err(t("error.recorder-busy")); }
        fs::remove_dir_all(folder).map_err(text)?;
        Ok(json!({"ok": true}))
    }).await
}

#[tauri::command]
pub async fn recorder_reveal(app: AppHandle, id: String) -> Value {
    blocking(move || {
        app.opener().reveal_item_in_dir(folder_of(&root()?, &id)?.join("recording.mp4")).map_err(text)?;
        Ok(json!({"ok": true}))
    }).await
}

#[tauri::command]
pub async fn recorder_for_chat(app: AppHandle, id: String, model: Option<String>, language: Option<String>) -> Value {
    blocking(move || for_chat(&app, &id, model, language)).await
}

#[tauri::command]
pub async fn recorder_voice(id: String, segments: Value) -> Value {
    blocking(move || {
        let folder = folder_of(&root()?, &id)?;
        let meta: Value = fs::read(folder.join("meta.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).ok_or_else(|| t("error.recorder-not-found"))?;
        let video_start = meta["videoStart"].as_u64().or_else(|| meta["started"].as_u64()).unwrap_or(0);
        fs::write(folder.join("voice.json"), serde_json::to_vec(&voice_segments(&segments, video_start)?).map_err(text)?).map_err(text)?;
        Ok(json!({"ok": true}))
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(ms: u64, reason: &str) -> KeyFrame { KeyFrame { ms, reason: reason.into(), file: format!("frames/{ms:08}.png") } }

    #[test]
    fn target_sizes_pick_the_mip_level() {
        assert_eq!(target_size(3840, 2160, 1080), (1, 1920, 1080));
        assert_eq!(target_size(2560, 1440, 1080), (1, 1280, 720));
        assert_eq!(target_size(1920, 1080, 720), (1, 960, 540));
        assert_eq!(target_size(1366, 768, 1080), (0, 1366, 768));
        assert_eq!(target_size(1367, 769, 1080), (0, 1366, 768));
        assert_eq!(target_size(3001, 1999, 720), (2, 750, 498));
        assert_eq!(target_size(1920, 1080, 1080), (0, 1920, 1080));
    }

    #[test]
    fn frame_selection() {
        let few: Vec<KeyFrame> = (0..20).map(|i| frame(i * 1000, "interval")).collect();
        assert_eq!(select_frames(&few), (0..20).collect::<Vec<_>>());
        // 5 events among 40 intervals: every event, then 15 evenly spaced intervals.
        let mut mixed: Vec<KeyFrame> = (0..45).map(|i| frame(i * 1000, if i % 9 == 0 { "click" } else { "interval" })).collect();
        mixed[0].reason = "start".into();
        let chosen = select_frames(&mixed);
        assert_eq!(chosen.len(), 20);
        assert!(chosen.windows(2).all(|w| mixed[w[0]].ms < mixed[w[1]].ms));
        assert_eq!(chosen.iter().filter(|&&i| mixed[i].reason != "interval").count(), 5);
        // 30 events: 20 of them evenly, the first kept, no intervals.
        let busy: Vec<KeyFrame> = (0..40).map(|i| frame(i * 1000, if i < 30 { "change" } else { "interval" })).collect();
        let chosen = select_frames(&busy);
        assert_eq!(chosen.len(), 20);
        assert_eq!(chosen[0], 0);
        assert!(chosen.iter().all(|&i| i < 30));
    }

    #[test]
    fn timeline_render() {
        let (a, b) = (frame(0, "start"), frame(75_500, "click"));
        let text = timeline("2026-11-27 14:03:05", 125_000, &[&a, &b], &[(1240, 3900, "Open the menu".into())]);
        assert_eq!(text, "# Screen recording\n\nRecorded 2026-11-27 14:03:05, 2:05 long. The attached images are its key frames, in this order. Speech is the user's microphone, transcribed locally.\n\n[0:00] Image 1 (start): 00000000.png\n[0:01-0:03] User says: Open the menu\n[1:15] Image 2 (click): 00075500.png\n");
        let text = timeline("x", 0, &[&a], &[]);
        assert!(text.ends_with("locally.\n\nNo speech transcript.\n[0:00] Image 1 (start): 00000000.png\n"));
    }

    #[test]
    fn wav_header_is_16k_mono_pcm() {
        let header = wav_header(32000);
        assert_eq!(header.len(), 44);
        assert_eq!(&header[..4], b"RIFF");
        assert_eq!(header[4..8], (32036u32).to_le_bytes());
        assert_eq!(&header[8..16], b"WAVEfmt ");
        assert_eq!(header[24..28], 16000u32.to_le_bytes());
        assert_eq!(header[34..36], 16u16.to_le_bytes());
        assert_eq!(&header[36..40], b"data");
        assert_eq!(header[40..44], 32000u32.to_le_bytes());
    }

    #[test]
    fn ids_must_be_folders_under_the_root() {
        let root = std::env::temp_dir().join(format!("frugal-recorder-test-{}", std::process::id()));
        fs::create_dir_all(root.join("2026-11-27 14-03-05")).unwrap();
        fs::write(root.join("file"), "").unwrap();
        assert_eq!(folder_of(&root, "2026-11-27 14-03-05").unwrap(), root.join("2026-11-27 14-03-05"));
        for id in ["", ".", "..", "../x", "2026-11-27 14-03-05/", "a\\b", "C:", "C:\\Windows", "/tmp", "missing", "file"] {
            assert_eq!(folder_of(&root, id).unwrap_err(), "The recording is no longer on disk.", "{id}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn options_validation() {
        let monitors = [(1920, 1080), (2560, 1440)];
        let ok = |options: Value| parse_options(&options, &monitors, |hwnd| hwnd == 42);
        let base = json!({"kind": "monitor", "monitor": 1, "mic": true, "micDevice": null, "system": false, "fps": 60, "height": 1080});
        assert_eq!(ok(base.clone()).unwrap(), Options { source: Source::Monitor(1), mic: true, mic_device: None, system: false, fps: 60, height: 1080,
            clicks: false, zoom: false, game: false, app: None, mic_gain: 1.0, system_gain: 1.0 });
        let with = |key: &str, value: Value| { let mut o = base.clone(); o[key] = value; ok(o) };
        assert_eq!(with("micDevice", json!("{0.0.1}")).unwrap().mic_device.as_deref(), Some("{0.0.1}"));
        for height in [720, 1440, 2160] { assert_eq!(with("height", json!(height)).unwrap().height, height); }
        assert!(with("clicks", json!(true)).unwrap().clicks);
        assert!(with("zoom", json!(true)).unwrap().zoom);
        for (key, value) in [("fps", json!(24)), ("height", json!(480)), ("kind", json!("tab")), ("mic", json!("yes")), ("micDevice", json!(3)), ("monitor", json!(-1)),
            ("clicks", json!("yes")), ("zoom", json!(1)), ("game", json!("on")), ("app", json!(0)), ("app", json!(-4)), ("app", json!("12")), ("app", json!(1u64 << 33))] {
            assert_eq!(with(key, value).unwrap_err(), "Invalid request.", "{key}");
        }
        let mut game = base.clone();
        game["fps"] = json!(30);
        (game["game"], game["clicks"], game["zoom"]) = (json!(true), json!(true), json!(true));
        let game = ok(game).unwrap();
        assert_eq!((game.fps, game.clicks, game.zoom, game.game), (60, false, false, true));
        assert_eq!(with("app", json!(1234)).unwrap().app, None);
        let mut app = base.clone();
        (app["system"], app["app"]) = (json!(true), json!(1234));
        assert_eq!(ok(app).unwrap().app, Some(1234));
        assert_eq!(with("monitor", json!(2)).unwrap_err(), "The screen or window to record is no longer available.");
        let mut window = base.clone();
        window["kind"] = json!("window");
        window["hwnd"] = json!(42);
        assert_eq!(ok(window.clone()).unwrap().source, Source::Window(42));
        window["hwnd"] = json!(7);
        assert_eq!(ok(window).unwrap_err(), "The screen or window to record is no longer available.");
        let region = |x: u64, y: u64, w: u64, h: u64| { let mut o = base.clone(); o["kind"] = json!("region"); o["monitor"] = json!(0); o["rect"] = json!({"x": x, "y": y, "width": w, "height": h}); ok(o) };
        assert_eq!(region(100, 50, 1820, 1030).unwrap().source, Source::Region(0, [100, 50, 1820, 1030]));
        for (x, y, w, h) in [(101, 50, 1820, 1030), (0, 0, 15, 100), (0, 0, 100, 15), (0, 1000, 100, 100)] {
            assert_eq!(region(x, y, w, h).unwrap_err(), "Invalid request.");
        }
    }

    #[test]
    fn key_frame_reasons() {
        assert_eq!(key_reason(true, true, 0, 99.0), Some("start"));
        assert_eq!(key_reason(false, true, 600, 0.0), Some("click"));
        assert_eq!(key_reason(false, false, 999, 50.0), None);
        assert_eq!(key_reason(false, false, 1000, 10.5), Some("change"));
        assert_eq!(key_reason(false, false, 9999, 10.0), None);
        assert_eq!(key_reason(false, false, 10_000, 0.0), Some("interval"));
    }

    // BGRA of top-down (x, y) in a bottom-to-top image.
    fn pixel(bgra: &[u8], (w, h): (usize, usize), x: usize, y: usize) -> [u8; 4] {
        let i = ((h - 1 - y) * w + x) * 4;
        bgra[i..i + 4].try_into().unwrap()
    }

    #[test]
    fn pointer_records_presses() {
        let mut p = Pointer { pos: (500, 300), origin: (100, 50), ..Pointer::default() };
        assert!(!p.update(None, 10));
        assert_eq!(p.active, None);
        assert!(p.update(Some("left"), 20));
        p.pos = (700, 301);
        assert!(!p.update(Some("left"), 35));
        assert!(!p.update(None, 50));
        assert_eq!(p.active, Some(50));
        assert!(p.press.is_none());
        assert_eq!(p.recent, [Press { button: "left", at: (500, 300), ms: 20 }]);
        assert!(p.update(Some("right"), 600));
        assert_eq!(p.recent.len(), 1);
        let events = click_events(&p.events, 15, 1);
        assert_eq!(events[0], ClickEvent { ms: 5, button: "left", x: 200, y: 125, up_ms: 35, up_x: 300, up_y: 125, origin: (100, 50) });
        assert_eq!((events[1].ms, events[1].button, events[1].up_ms), (585, "right", 585));
        assert_eq!(serde_json::to_value(&events[0]).unwrap(), json!({"ms": 5, "button": "left", "x": 200, "y": 125, "up_ms": 35, "up_x": 300, "up_y": 125}));
    }

    #[test]
    fn gains_parsed() {
        let base = json!({"kind": "monitor", "monitor": 0, "mic": true, "system": true, "fps": 30, "height": 1080});
        let with = |key: &str, value: Value| { let mut o = base.clone(); o[key] = value; parse_options(&o, &[(1920, 1080)], |_| false) };
        let plain = parse_options(&base, &[(1920, 1080)], |_| false).unwrap();
        assert_eq!((plain.mic_gain, plain.system_gain), (1.0, 1.0));
        assert_eq!(with("micGain", json!(2.5)).unwrap().mic_gain, 2.5);
        assert_eq!(with("systemGain", json!(3)).unwrap().system_gain, 3.0);
        for (key, value) in [("micGain", json!(4.0)), ("systemGain", json!(4.0)), ("micGain", json!(0.5)), ("systemGain", json!("2"))] {
            assert_eq!(with(key, value).unwrap_err(), "Invalid request.", "{key}");
        }
    }

    #[test]
    fn drawing_is_bottom_to_top() {
        let size = (3, 2);
        let mut bgra = vec![0u8; 3 * 2 * 4];
        blend(&mut bgra, size, 0, 0, [200, 100, 50], 1.0);
        blend(&mut bgra, size, 2, 1, [200, 100, 50], 0.5);
        blend(&mut bgra, size, 3, 0, [255; 3], 1.0);
        blend(&mut bgra, size, -1, 0, [255; 3], 1.0);
        assert_eq!(&bgra[12..16], &[50, 100, 200, 0]);
        assert_eq!(&bgra[8..12], &[25, 50, 100, 0]);
        assert_eq!(bgra.iter().map(|&b| u32::from(b)).sum::<u32>(), 350 + 175);
    }

    #[test]
    fn ring_and_rect() {
        let size = (40, 40);
        let mut bgra = vec![0u8; 40 * 40 * 4];
        ring(&mut bgra, size, (20, 10), 8.0, 2.0, [245, 184, 61], 1.0);
        assert_eq!(pixel(&bgra, size, 28, 10), [61, 184, 245, 0]);
        assert_eq!(pixel(&bgra, size, 20, 2), [61, 184, 245, 0]);
        assert_eq!(pixel(&bgra, size, 20, 10), [0; 4]);
        assert_eq!(pixel(&bgra, size, 20, 30), [0; 4]);
        let mut bgra = vec![0u8; 40 * 40 * 4];
        rect(&mut bgra, size, (30, 35), (10, 5), 2, [100, 200, 0], 1.0, 0.5);
        assert_eq!(pixel(&bgra, size, 10, 5), [0, 200, 100, 0]);
        assert_eq!(pixel(&bgra, size, 29, 34), [0, 200, 100, 0]);
        assert_eq!(pixel(&bgra, size, 20, 20), [0, 100, 50, 0]);
        assert_eq!(pixel(&bgra, size, 9, 20), [0; 4]);
        rect(&mut bgra, size, (-50, -50), (100, 100), 2, [1, 1, 1], 1.0, 1.0);
    }

    #[test]
    fn zoom_math() {
        assert_eq!(smooth(1.0, 2.0, 0.0, 0.25), 1.0);
        assert!((smooth(0.0, 1.0, 0.25, 0.25) - (1.0 - (-1.0f32).exp())).abs() < 1e-6);
        assert!((smooth(1.0, 2.0, 10.0, 0.25) - 2.0).abs() < 1e-6);
        assert_eq!(clamp_center(0.0, 100.0, 2.0), 25.0);
        assert_eq!(clamp_center(100.0, 100.0, 2.0), 75.0);
        assert_eq!(clamp_center(60.0, 100.0, 2.0), 60.0);
        assert_eq!(clamp_center(10.0, 100.0, 1.0), 50.0);
        let size = (4, 4);
        let mut src = vec![0u8; 4 * 4 * 4];
        for y in 0..4 { for x in 0..4 { let i = ((3 - y) * 4 + x) * 4; src[i] = x as u8 * 20; src[i + 1] = y as u8 * 20; src[i + 3] = 255; } }
        let mut out = vec![0u8; src.len()];
        zoom_frame(&src, &mut out, size, 1.0, (2.0, 2.0));
        assert_eq!(out, src);
        zoom_frame(&src, &mut out, size, 2.0, (2.0, 2.0));
        assert_eq!(pixel(&out, size, 0, 0), [15, 15, 0, 255]);
        assert_eq!(pixel(&out, size, 3, 0), [45, 15, 0, 255]);
        assert_eq!(pixel(&out, size, 0, 3), [15, 45, 0, 255]);
    }
}
