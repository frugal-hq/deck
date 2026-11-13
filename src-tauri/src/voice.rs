// Local dictation, with the same pinned whisper.cpp files as Electron.
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

type Result<T> = std::result::Result<T, String>;
const RELEASE_URL: &str = "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip";
const RELEASE: (u64, &str) = (8928640, "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb");
const MAX_AUDIO: usize = 16000 * 2 * 600 + 44;
const MAX_BUFFER: usize = 16 * 1024 * 1024;
static ANTHROPIC_VOICE: AtomicBool = AtomicBool::new(false);
type Preparation = Arc<(Mutex<Option<Result<()>>>, Condvar)>;
static PREPARING: Mutex<Option<Preparation>> = Mutex::new(None);

fn model_info(name: &str) -> Result<(u64, &'static str)> {
    match name {
        "small" => Ok((487601967, "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b")),
        "medium" => Ok((1533763059, "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208")),
        "large-v3" => Ok((3095033483, "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2")),
        _ => Err("Unknown voice model.".into()),
    }
}

fn voice_dir(data: &Path) -> PathBuf {
    // Electron uses package.json's name, not Tauri's bundle identifier.
    data.join("frugal-deck").join("voice")
}

fn cli(dir: &Path) -> PathBuf { dir.join("bin").join("Release").join("whisper-cli.exe") }
fn model_file(dir: &Path, name: &str) -> PathBuf { dir.join(format!("ggml-{name}.bin")) }
fn model_url(name: &str) -> String { format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{name}.bin") }
fn directory(app: &AppHandle) -> Result<PathBuf> { app.path().data_dir().map(|p| voice_dir(&p)).map_err(|e| e.to_string()) }

fn status(dir: &Path, model: &str) -> Result<Value> {
    let (size, _) = model_info(model)?;
    let (cli, model) = (cli(dir).exists(), model_file(dir, model).exists());
    Ok(json!({"needs": if cli { 0 } else { RELEASE.0 } + if model { 0 } else { size }, "cli": cli, "model": model}))
}

fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW, Electron's windowsHide.
    }
    command
}

// Drain both pipes while enforcing execFile's per-stream maxBuffer and timeout.
fn run(command: &mut Command, timeout: Option<Duration>, mut progress: impl FnMut(&[u8])) -> Result<Vec<u8>> {
    let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let (send, receive) = mpsc::sync_channel(8);
    for (stderr, mut pipe) in [(false, Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>), (true, Box::new(child.stderr.take().unwrap()))] {
        let send = send.clone();
        thread::spawn(move || {
            let mut buf = [0; 8192];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => if send.send(Ok((stderr, buf[..n].to_vec()))).is_err() { break; },
                    Err(e) => { let _ = send.send(Err(e.to_string())); break; }
                }
            }
        });
    }
    drop(send);
    let started = Instant::now();
    let mut output = [Vec::new(), Vec::new()];
    let result = (|| {
        loop {
            if timeout.is_some_and(|t| started.elapsed() >= t) { return Err("The transcription timed out.".into()); }
            match receive.recv_timeout(Duration::from_millis(20)) {
                Ok(chunk) => {
                    let (stderr, chunk) = chunk?;
                    let out = &mut output[usize::from(stderr)];
                    if out.len() + chunk.len() > MAX_BUFFER { return Err("stdout or stderr maxBuffer length exceeded".into()); }
                    if !stderr { progress(&chunk); }
                    out.extend_from_slice(&chunk);
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
        // A child can close its pipes before exiting.
        loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                return if status.success() { Ok(std::mem::take(&mut output[0])) }
                    else { Err(format!("Command failed ({status}): {}{}", String::from_utf8_lossy(&output[0]), String::from_utf8_lossy(&output[1]))) };
            }
            if timeout.is_some_and(|t| started.elapsed() >= t) { return Err("The transcription timed out.".into()); }
            thread::sleep(Duration::from_millis(20));
        }
    })();
    if result.is_err() { let _ = child.kill(); let _ = child.wait(); }
    result
}

fn download(url: &str, file: &Path, expected: (u64, &str), on_bytes: &mut impl FnMut(u64)) -> Result<()> {
    let part = file.with_extension(format!("{}.part", file.extension().unwrap_or_default().to_string_lossy()));
    // Windows' .NET supplies HTTPS and streaming SHA-256 without another crate.
    let script = r#"$ErrorActionPreference = 'Stop'
$response = $null; $inputStream = $null; $out = $null; $hash = $null
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $response = [Net.WebRequest]::Create($env:FRUGAL_VOICE_URL).GetResponse()
    $inputStream = $response.GetResponseStream()
    $out = [IO.File]::Create($env:FRUGAL_VOICE_PART)
    $hash = [Security.Cryptography.SHA256]::Create()
    $buffer = New-Object byte[] 65536
    while (($n = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $out.Write($buffer, 0, $n)
        [void]$hash.TransformBlock($buffer, 0, $n, $buffer, 0)
        [Console]::WriteLine($n)
    }
    [void]$hash.TransformFinalBlock([byte[]]@(), 0, 0)
    [Console]::WriteLine(([BitConverter]::ToString($hash.Hash)).Replace('-', '').ToLowerInvariant())
} finally {
    if ($out) { $out.Dispose() }; if ($inputStream) { $inputStream.Dispose() }
    if ($response) { $response.Dispose() }; if ($hash) { $hash.Dispose() }
}"#;
    let result = (|| {
        let mut pending = Vec::new();
        let mut hash = String::new();
        let mut received = 0;
        run(command("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("FRUGAL_VOICE_URL", url).env("FRUGAL_VOICE_PART", &part), None, |chunk| {
                pending.extend_from_slice(chunk);
                while let Some(end) = pending.iter().position(|&b| b == b'\n') {
                    let line = String::from_utf8_lossy(&pending[..end]).trim().to_owned();
                    if let Ok(n) = line.parse::<u64>() { received += n; on_bytes(n); } else { hash = line; }
                    pending.drain(..=end);
                }
            })?;
        if received != expected.0 || hash != expected.1 { return Err("The download did not match its checksum.".into()); }
        fs::rename(&part, file).map_err(|e| e.to_string())
    })();
    if result.is_err() { let _ = fs::remove_file(&part); }
    result
}

fn prepare(dir: &Path, model: &str, mut progress: impl FnMut(u64, u64)) -> Result<()> {
    let total = status(dir, model)?["needs"].as_u64().unwrap();
    let mut received = 0;
    let mut on_bytes = |n| { received += n; progress(received, total); };
    let bin = dir.join("bin");
    fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    if !cli(dir).exists() {
        let zip = dir.join("whisper-bin-x64.zip");
        download(RELEASE_URL, &zip, RELEASE, &mut on_bytes)?;
        let tar = PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("System32").join("tar.exe");
        let extracted = run(command(tar).arg("-xf").arg(&zip).arg("-C").arg(&bin), None, |_| {});
        let removed = fs::remove_file(&zip).map_err(|e| e.to_string());
        extracted?;
        removed?;
        if !cli(dir).exists() { return Err("whisper-cli.exe was not in the download.".into()); }
    }
    let file = model_file(dir, model);
    if !file.exists() { download(&model_url(model), &file, model_info(model)?, &mut on_bytes)?; }
    Ok(())
}

fn valid_audio(wav: &[u8]) -> bool {
    wav.len() > 44 && wav.len() <= MAX_AUDIO && wav.get(..4) == Some(b"RIFF") && wav.get(8..12) == Some(b"WAVE")
}

fn normalize(text: &str) -> String {
    text.split(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
        .filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
}

fn transcribe(dir: &Path, options: &Value) -> Result<String> {
    let wav: Vec<u8> = options["audio"].as_array().ok_or("The recording is not valid audio.")?.iter()
        .map(|v| v.as_u64().filter(|&n| n <= 255).map(|n| n as u8).ok_or("The recording is not valid audio."))
        .collect::<std::result::Result<_, _>>()?;
    if !valid_audio(&wav) { return Err("The recording is not valid audio.".into()); }
    let model = options["model"].as_str().unwrap_or("");
    let language = options["language"].as_str().unwrap_or("");
    if model_info(model).is_err() || !matches!(language, "es" | "en" | "auto") { return Err("Unknown voice model or language.".into()); }
    if !cli(dir).exists() || !model_file(dir, model).exists() { return Err("The voice model is not downloaded.".into()); }
    // create_new reserves the recording; never overwrite an existing temporary file.
    let (file, mut out) = (0..).find_map(|n| {
        let file = std::env::temp_dir().join(format!("frugal-deck-{}-{}-{n}.wav", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        match fs::OpenOptions::new().write(true).create_new(true).open(&file) {
            Ok(out) => Some(Ok((file, out))),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => None,
            Err(e) => Some(Err(e.to_string())),
        }
    }).unwrap()?;
    let result: Result<String> = (|| {
        out.write_all(&wav).map_err(|e| e.to_string())?;
        drop(out);
        let threads = thread::available_parallelism().map_err(|e| e.to_string())?.get().min(12).to_string();
        let stdout = run(command(cli(dir)).arg("-m").arg(model_file(dir, model)).arg("-f").arg(&file)
            .args(["-l", language, "-t", &threads, "-nt", "-np"]), Some(Duration::from_secs(600)), |_| {})?;
        Ok(normalize(&String::from_utf8_lossy(&stdout)))
    })();
    let removed = fs::remove_file(&file).map_err(|e| e.to_string());
    let text = result?;
    removed?;
    Ok(text)
}

pub fn anthropic_voice() -> bool { ANTHROPIC_VOICE.load(Ordering::Relaxed) }

#[tauri::command]
pub fn voice_mode(mode: Value) { ANTHROPIC_VOICE.store(mode == "anthropic", Ordering::Relaxed); }

#[tauri::command]
pub fn voice_status(app: AppHandle, model: Value) -> Value {
    directory(&app).and_then(|dir| status(&dir, model.as_str().unwrap_or(""))).unwrap_or_else(|error| json!({"error": error}))
}

#[tauri::command]
pub async fn voice_prepare(app: AppHandle, model: Value) -> Value {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let (preparation, leader) = {
            let mut preparing = PREPARING.lock().unwrap();
            match preparing.as_ref() {
                Some(p) => (p.clone(), false),
                None => {
                    let p = Arc::new((Mutex::new(None), Condvar::new()));
                    *preparing = Some(p.clone());
                    (p, true)
                }
            }
        };
        let (result, ready) = &*preparation;
        if !leader {
            let mut result = result.lock().unwrap();
            while result.is_none() { result = ready.wait(result).unwrap(); }
            return result.clone().unwrap();
        }
        let prepared = directory(&app).and_then(|dir| prepare(&dir, model.as_str().unwrap_or(""), |received, total| {
            let _ = app.emit("voice:progress", [received, total]);
        }));
        *result.lock().unwrap() = Some(prepared.clone());
        *PREPARING.lock().unwrap() = None;
        ready.notify_all();
        prepared
    }).await.map_err(|e| e.to_string()).and_then(|r| r);
    match result { Ok(()) => json!({"ok": true}), Err(error) => json!({"error": format!("The voice download failed: {error}")}) }
}

#[tauri::command]
pub async fn voice_transcribe(app: AppHandle, options: Option<Value>) -> Value {
    let result = tauri::async_runtime::spawn_blocking(move || directory(&app).and_then(|dir| transcribe(&dir, &options.unwrap_or(Value::Null))))
        .await.map_err(|e| e.to_string()).and_then(|r| r);
    match result { Ok(text) => json!({"text": text}), Err(error) => json!({"error": format!("Transcription failed: {error}")}) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_models_and_status() {
        let dir = std::env::temp_dir().join(format!("frugal-voice-test-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&dir).unwrap();
        assert_eq!(voice_dir(&dir), dir.join("frugal-deck/voice"));
        assert_eq!(cli(&dir), dir.join("bin/Release/whisper-cli.exe"));
        assert_eq!(model_file(&dir, "small"), dir.join("ggml-small.bin"));
        assert_eq!(model_url("medium"), "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin");
        assert!(status(&dir, "../small").is_err());
        for (name, size) in [("small", 487601967), ("medium", 1533763059), ("large-v3", 3095033483)] {
            assert_eq!(status(&dir, name).unwrap(), json!({"needs": RELEASE.0 + size, "cli": false, "model": false}));
        }
        fs::create_dir_all(dir.join("bin/Release")).unwrap();
        fs::write(cli(&dir), []).unwrap();
        assert_eq!(status(&dir, "small").unwrap()["needs"], 487601967u64);
        fs::write(model_file(&dir, "small"), []).unwrap();
        assert_eq!(status(&dir, "small").unwrap(), json!({"needs": 0, "cli": true, "model": true}));
        fs::remove_file(cli(&dir)).unwrap();
        assert_eq!(status(&dir, "small").unwrap()["needs"], RELEASE.0);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn audio_validation_and_text_parsing() {
        let mut wav = vec![0; 45];
        assert!(!valid_audio(&wav));
        wav[..4].copy_from_slice(b"RIFF");
        wav[8..12].copy_from_slice(b"WAVE");
        assert!(valid_audio(&wav));
        assert!(!valid_audio(&wav[..44]));
        wav.resize(MAX_AUDIO, 0);
        assert!(valid_audio(&wav));
        wav.push(0);
        assert!(!valid_audio(&wav));
        assert_eq!(normalize(" \t hola\r\n mundo\u{a0}\u{feff} "), "hola mundo");
        assert_eq!(normalize(" a\u{85}b "), "a\u{85}b");
        assert_eq!(normalize("\r\n\t"), "");
        let dir = std::env::temp_dir();
        assert_eq!(transcribe(&dir, &Value::Null).unwrap_err(), "The recording is not valid audio.");
        wav.truncate(45);
        assert_eq!(transcribe(&dir, &json!({"audio": wav, "model": "../small", "language": "es"})).unwrap_err(), "Unknown voice model or language.");
        assert_eq!(transcribe(&dir, &json!({"audio": wav, "model": "small", "language": "fr"})).unwrap_err(), "Unknown voice model or language.");
    }

    #[test]
    fn download_verifies_before_rename_and_cleans_partial_files() {
        use std::net::TcpListener;
        let dir = std::env::temp_dir().join(format!("frugal-voice-download-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let file = dir.join("model.bin");
        let part = dir.join("model.bin.part");
        for (size, hash, valid) in [
            (3, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", true),
            (4, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", false),
            (3, "wrong", false),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/model", listener.local_addr().unwrap());
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 4096];
                stream.read(&mut request).unwrap();
                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc").unwrap();
            });
            let mut received = 0;
            let result = download(&url, &file, (size, hash), &mut |n| received += n);
            server.join().unwrap();
            assert_eq!(received, 3);
            assert!(!part.exists());
            if valid {
                result.unwrap();
                assert_eq!(fs::read(&file).unwrap(), b"abc");
            } else {
                assert_eq!(result.unwrap_err(), "The download did not match its checksum.");
                assert_eq!(fs::read(&file).unwrap(), b"abc");
            }
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
