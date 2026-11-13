// The status line bridge: Claude Code posts its meters to a localhost URL, and the Deck answers with
// the user's own status-line command output, keeping the Ctrl+G edit route open.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::OsString;
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const CHAIN_TIMEOUT: Duration = Duration::from_millis(4000);

fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n >= i64::MIN as f64 && n < i64::MAX as f64 { json!(n as i64) } else { json!(n) }
}

fn percent(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite() && *n >= 0.0).map(|n| n.min(100.0))
}

// statusline.js:9-14.
fn limit(window: &Value) -> Value {
    match percent(&window["used_percentage"]) {
        None => Value::Null,
        Some(pct) => json!({
            "pct": number(pct),
            "resetsAt": window["resets_at"].as_f64().filter(|n| n.is_finite()).map(number).unwrap_or(Value::Null),
        }),
    }
}

// statusline.js:17-32. The first invocations of a session omit these fields or send null (Test 6).
pub fn read_meters(input: &Value) -> Value {
    let window = &input["context_window"];
    let used = window["used_percentage"].as_f64().filter(|n| n.is_finite());
    let size = window["context_window_size"].as_f64().filter(|n| n.is_finite());
    let context_tokens = match (used, size) {
        (Some(used), Some(size)) => number((used / 100.0 * size + 0.5).floor()),
        _ => Value::Null,
    };
    let finite = |value: &Value| value.as_f64().filter(|n| n.is_finite()).map(number).unwrap_or(Value::Null);
    let label = |value: &Value| value.as_str().filter(|s| !s.is_empty()).map_or(Value::Null, |s| json!(s));
    json!({
        "context": percent(&window["used_percentage"]).map(number).unwrap_or(Value::Null),
        "contextTokens": context_tokens,
        "contextSize": finite(&window["context_window_size"]),
        "inputTokens": finite(&window["total_input_tokens"]),
        "outputTokens": finite(&window["total_output_tokens"]),
        "fiveHour": limit(&input["rate_limits"]["five_hour"]),
        "sevenDay": limit(&input["rate_limits"]["seven_day"]),
        "model": label(&input["model"]["display_name"]),
        "effort": label(&input["effort"]["level"]),
        "cost": input["cost"]["total_cost_usd"].as_f64().filter(|n| n.is_finite() && *n >= 0.0).map(number).unwrap_or(Value::Null),
    })
}

// statusline.js:36-43: only the user-level setting; a project's settings.json is untrusted until Claude's
// trust dialog is accepted, and running its command here would bypass that dialog.
pub fn read_user_status_line(file: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(file).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let status_line = &value["statusLine"];
    (status_line["type"] == "command" && status_line["command"].is_string()).then(|| status_line.clone())
}

// statusline.js:47-54: Git Bash when installed, otherwise PowerShell.
fn find_chain_shell() -> (PathBuf, Vec<String>) {
    if let Ok(output) = Command::new("where.exe").arg("git").output() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(git) = stdout.lines().next().filter(|git| !git.is_empty()) {
            for relative in ["../bin/bash.exe", "../../bin/bash.exe"] {
                let bash = Path::new(git).parent().unwrap_or_else(|| Path::new(".")).join(relative);
                if bash.exists() { return (bash, vec!["-c".to_owned()]); }
            }
        }
    }
    (PathBuf::from("powershell.exe"), vec!["-NoProfile".to_owned(), "-Command".to_owned()])
}

#[derive(Clone)]
struct Chain { shell: PathBuf, args: Vec<String>, command: String, cwd: PathBuf, env: Vec<(OsString, OsString)> }

struct Client { id: String, chain: Option<Chain> }

struct PendingEdit { file: PathBuf, stream: TcpStream }

type OnMeters = Arc<dyn Fn(&str, Value) + Send + Sync>;
type OnEdit = Arc<dyn Fn(&str, &str) -> bool + Send + Sync>;

pub struct StatusBridge {
    port: u16,
    clients: Arc<Mutex<HashMap<String, Client>>>,
    edits: Arc<Mutex<HashMap<String, PendingEdit>>>,
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

// 24 random bytes as hex, without a crate: RandomState is seeded from the OS and SipHash mixes it.
fn token() -> String {
    let mut out = String::new();
    for i in 0..6u64 {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(i);
        hasher.write_u64(std::process::id() as u64);
        hasher.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
        hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
        out.push_str(&format!("{:016x}", hasher.finish()));
    }
    out
}

// statusline.js:62-105. The /edit route stays open while the Deck edits the file: save_edit ends it.
pub fn create_status_bridge(
    on_meters: impl Fn(&str, Value) + Send + Sync + 'static,
    on_edit: impl Fn(&str, &str) -> bool + Send + Sync + 'static,
) -> std::io::Result<StatusBridge> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    listener.set_nonblocking(true)?;
    let clients = Arc::new(Mutex::new(HashMap::new()));
    let edits = Arc::new(Mutex::new(HashMap::new()));
    let (on_meters, on_edit): (OnMeters, OnEdit) = (Arc::new(on_meters), Arc::new(on_edit));
    {
        let clients = clients.clone();
        let edits = edits.clone();
        thread::spawn(move || {
            loop {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let (clients, edits, on_meters, on_edit) = (clients.clone(), edits.clone(), on_meters.clone(), on_edit.clone());
                        thread::spawn(move || handle(stream, &clients, &edits, &on_meters, &on_edit));
                    }
                    Err(_) => thread::sleep(Duration::from_millis(5)),
                }
            }
        });
    }
    Ok(StatusBridge { port, clients, edits })
}

fn handle(mut stream: TcpStream, clients: &Mutex<HashMap<String, Client>>, edits: &Mutex<HashMap<String, PendingEdit>>, on_meters: &OnMeters, on_edit: &OnEdit) {
    let Some((head, body)) = read_request(&mut stream) else { return };
    let mut line = head.lines().next().unwrap_or("").split(' ');
    let method = line.next().unwrap_or("");
    let target = line.next().unwrap_or("");
    let (token, edit) = match target.strip_prefix('/') {
        Some(rest) => match rest.strip_suffix("/edit") {
            Some(token) => (token, true),
            None => (rest, false),
        },
        None => (target, false),
    };
    let client = if !token.is_empty() && token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        clients.lock().unwrap().get(token).map(|client| (client.id.clone(), client.chain.clone()))
    } else { None };
    let Some((id, chain)) = client.filter(|_| method == "POST") else {
        respond(&mut stream, 404, "");
        return;
    };
    if edit {
        let Ok(text) = std::fs::read_to_string(&body) else {
            respond(&mut stream, 400, "");
            return;
        };
        end_edit(edits, &id, None);
        edits.lock().unwrap().insert(id.clone(), PendingEdit { file: PathBuf::from(&body), stream });
        if !on_edit(&id, &text) { end_edit(edits, &id, None); }
        return;
    }
    let Ok(input) = serde_json::from_str::<Value>(&body) else {
        respond(&mut stream, 400, "");
        return;
    };
    on_meters(&id, read_meters(&input));
    let output = chain.map_or_else(String::new, |chain| run_chain(&chain, &body));
    respond(&mut stream, 200, &output);
}

fn read_request(stream: &mut TcpStream) -> Option<(String, String)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 { return None; }
        buf.extend_from_slice(&chunk[..n]);
        let Some(end) = buf.windows(4).position(|window| window == b"\r\n\r\n") else {
            if buf.len() > 65536 { return None; }
            continue;
        };
        let head = String::from_utf8_lossy(&buf[..end]).into_owned();
        let length = head.lines().skip(1).find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.trim().eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().unwrap_or(0))
        }).unwrap_or(0);
        let mut body = buf[end + 4..].to_vec();
        while body.len() < length {
            let n = stream.read(&mut chunk).ok()?;
            if n == 0 { break; }
            body.extend_from_slice(&chunk[..n]);
        }
        body.truncate(length);
        return Some((head, String::from_utf8_lossy(&body).into_owned()));
    }
}

fn respond(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        _ => "Not Found",
    };
    let _ = write!(stream, "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
}

fn end_edit(edits: &Mutex<HashMap<String, PendingEdit>>, id: &str, text: Option<&str>) {
    let Some(mut edit) = edits.lock().unwrap().remove(id) else { return };
    if let Some(text) = text { let _ = std::fs::write(&edit.file, text); }
    respond(&mut edit.stream, 200, "");
}

// statusline.js:56-60.
fn run_chain(chain: &Chain, body: &str) -> String {
    let mut command = Command::new(&chain.shell);
    command.args(&chain.args).arg(&chain.command).current_dir(&chain.cwd).env_clear().envs(chain.env.iter().cloned());
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let Ok(mut child) = command.spawn() else { return String::new() };
    if let Some(mut stdin) = child.stdin.take() { let _ = stdin.write_all(body.as_bytes()); }
    let reader = child.stdout.take().map(|mut stdout| thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    }));
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < CHAIN_TIMEOUT => thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    reader.map_or_else(String::new, |reader| reader.join().map_or_else(|_| String::new(), |out| String::from_utf8_lossy(&out).into_owned()))
}

impl StatusBridge {
    // statusline.js:94-101.
    pub fn register(&self, id: &str, cwd: &Path, env: &[(OsString, OsString)], status_line: Option<&Value>) -> Value {
        let token = token();
        let chain = status_line.map(|status_line| {
            let (shell, args) = find_chain_shell();
            Chain { shell, args, command: status_line["command"].as_str().unwrap_or("").to_owned(), cwd: cwd.to_path_buf(), env: env.to_vec() }
        });
        self.clients.lock().unwrap().insert(token.clone(), Client { id: id.to_owned(), chain });
        let url = format!("http://127.0.0.1:{}/{}", self.port, token);
        let command = format!("curl.exe -s -m 5 --noproxy 127.0.0.1 --data-binary \"@-\" {url}");
        let mut status_line = match status_line {
            Some(Value::Object(object)) => Value::Object(object.clone()),
            _ => json!({}),
        };
        status_line["type"] = json!("command");
        status_line["command"] = json!(command);
        json!({ "token": token, "statusLine": status_line, "editUrl": format!("{url}/edit") })
    }

    pub fn release(&self, token: &str) {
        self.clients.lock().unwrap().remove(token);
    }

    pub fn save_edit(&self, id: &str, text: Option<&str>) {
        end_edit(&self.edits, id, text);
    }

}

// main.js:591: a save writes the text back before the response ends; a cancel (text === null) ends it without writing.
#[tauri::command]
pub fn chat_save_edit(bridge: tauri::State<StatusBridge>, id: String, text: Option<String>) {
    bridge.save_edit(&id, text.as_deref());
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            loop {
                let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
                let path = std::env::temp_dir().join(format!("deck-status-{}-{stamp}", std::process::id()));
                match std::fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(e) => panic!("{e}"),
                }
            }
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let resolved = self.0.canonicalize().unwrap();
            assert_eq!(resolved.parent().unwrap(), std::env::temp_dir().canonicalize().unwrap());
            std::fs::remove_dir_all(resolved).unwrap();
        }
    }

    fn empty() -> Value {
        json!({ "context": null, "contextTokens": null, "contextSize": null, "inputTokens": null, "outputTokens": null,
            "fiveHour": null, "sevenDay": null, "model": null, "effort": null, "cost": null })
    }

    const FULL: &str = r#"{"context_window":{"used_percentage":34.5,"context_window_size":200000,"total_input_tokens":12000,"total_output_tokens":3456},"rate_limits":{"five_hour":{"used_percentage":67,"resets_at":1800000000},"seven_day":{"used_percentage":13}},"model":{"display_name":"Opus"},"effort":{"level":"high"},"cost":{"total_cost_usd":1.25}}"#;

    // statusline.check.js:18-35: 7 assertions ported.
    #[test]
    fn reads_meters() {
        let _dir = TempDir::new();
        assert_eq!(read_meters(&json!({})), empty());
        assert_eq!(read_meters(&Value::Null), empty());
        assert_eq!(read_meters(&json!({ "context_window": { "used_percentage": null }, "rate_limits": {} })), empty());
        assert_eq!(read_meters(&json!({ "context_window": { "used_percentage": "40" } })), empty());
        assert_eq!(read_meters(&json!({ "context_window": { "used_percentage": -1 } }))["context"], Value::Null);
        assert_eq!(read_meters(&json!({ "context_window": { "used_percentage": 130 } }))["context"], 100);
        assert_eq!(read_meters(&serde_json::from_str::<Value>(FULL).unwrap()), json!({
            "context": 34.5,
            "contextTokens": 69000,
            "contextSize": 200000,
            "inputTokens": 12000,
            "outputTokens": 3456,
            "fiveHour": { "pct": 67, "resetsAt": 1800000000 },
            "sevenDay": { "pct": 13, "resetsAt": null },
            "model": "Opus",
            "effort": "high",
            "cost": 1.25,
        }));
    }

    // statusline.check.js:37-55: 18 assertions ported, 4 skips.
    #[test]
    fn meters_ignore_non_numbers_and_missing_halves() {
        let _dir = TempDir::new();
        // Skipped statusline.check.js:38: undefined has no serde_json Value.
        assert_eq!(read_meters(&json!({ "context_window": { "used_percentage": null, "context_window_size": null, "total_input_tokens": null, "total_output_tokens": null } })), empty());
        assert_eq!(read_meters(&json!({ "context_window": { "used_percentage": "20", "context_window_size": "20", "total_input_tokens": "20", "total_output_tokens": "20" } })), empty());
        // Skipped statusline.check.js:38: NaN cannot be represented in serde_json::Value.
        // Skipped statusline.check.js:38: Infinity cannot be represented in serde_json::Value.
        // Skipped statusline.check.js:38: -Infinity cannot be represented in serde_json::Value.
        let meters = read_meters(&json!({ "model": { "display_name": "Opus" }, "effort": { "level": "high" }, "cost": { "total_cost_usd": 1.25 } }));
        assert_eq!(meters["model"], "Opus");
        assert_eq!(read_meters(&json!({ "effort": { "level": "high" } }))["effort"], "high");
        assert_eq!(read_meters(&json!({ "cost": { "total_cost_usd": 1.25 } }))["cost"], 1.25);
        assert_eq!(read_meters(&json!({ "model": {} }))["model"], Value::Null);
        assert_eq!(read_meters(&json!({ "model": { "display_name": null } }))["model"], Value::Null);
        assert_eq!(read_meters(&json!({ "model": { "display_name": 5 } }))["model"], Value::Null);
        assert_eq!(read_meters(&json!({ "effort": { "level": "high" } }))["cost"], Value::Null);
        assert_eq!(read_meters(&json!({ "effort": {} }))["effort"], Value::Null);
        assert_eq!(read_meters(&json!({ "effort": { "level": 3 } }))["effort"], Value::Null);
        assert_eq!(read_meters(&json!({ "cost": { "total_cost_usd": "1.25" } }))["cost"], Value::Null);
        assert_eq!(read_meters(&json!({ "cost": { "total_cost_usd": -1.25 } }))["cost"], Value::Null);
        assert_eq!(read_meters(&json!({ "context_window": { "context_window_size": 200000 } }))["contextTokens"], Value::Null);
        assert_eq!(read_meters(&json!({ "context_window": { "used_percentage": 20 } }))["contextTokens"], Value::Null);
        assert_eq!(read_meters(&json!({ "context_window": { "used_percentage": 33.3, "context_window_size": 101 } }))["contextTokens"], 34);
        assert_eq!(read_meters(&json!({ "context_window": { "used_percentage": 130, "context_window_size": 100 } }))["contextTokens"], 130);
        assert_eq!(read_meters(&json!({ "context_window": { "used_percentage": 0, "context_window_size": 100, "total_input_tokens": 0, "total_output_tokens": 0 } }))["inputTokens"], 0);
    }

    fn file(dir: &TempDir, text: &str) -> PathBuf {
        let target = dir.0.join(format!("{}.json", token()));
        std::fs::write(&target, text).unwrap();
        target
    }

    // statusline.check.js:63-68: 6 assertions ported.
    #[test]
    fn reads_only_a_user_command_status_line() {
        let dir = TempDir::new();
        assert_eq!(read_user_status_line(&dir.0.join("missing.json")), None);
        assert_eq!(read_user_status_line(&file(&dir, "{broken")), None);
        assert_eq!(read_user_status_line(&file(&dir, "null")), None);
        assert_eq!(read_user_status_line(&file(&dir, r#"{"statusLine":{"type":"other","command":"x"}}"#)), None);
        assert_eq!(read_user_status_line(&file(&dir, r#"{"statusLine":{"type":"command","command":5}}"#)), None);
        assert_eq!(read_user_status_line(&file(&dir, r#"{"statusLine":{"type":"command","command":"x","padding":2}}"#)),
            Some(json!({ "type": "command", "command": "x", "padding": 2 })));
    }

    fn request(url: &str, method: &str, body: Option<&str>) -> (u16, String) {
        let rest = url.strip_prefix("http://127.0.0.1:").unwrap();
        let (port, path) = rest.split_once('/').unwrap();
        let mut stream = TcpStream::connect(("127.0.0.1", port.parse::<u16>().unwrap())).unwrap();
        let body = body.unwrap_or("");
        let head = format!("{method} /{path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
        stream.write_all(head.as_bytes()).unwrap();
        stream.write_all(body.as_bytes()).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        let text = String::from_utf8_lossy(&response).into_owned();
        let status = text.split(' ').nth(1).and_then(|status| status.parse().ok()).unwrap_or(0);
        (status, text.split_once("\r\n\r\n").map_or_else(String::new, |(_, body)| body.to_owned()))
    }

    fn run_shell(shell: &Path, args: &[&str], command: &str, cwd: &Path, body: &str) -> String {
        let env: Vec<_> = std::env::vars_os().collect();
        run_chain(&Chain { shell: shell.to_path_buf(), args: args.iter().map(|arg| (*arg).to_owned()).collect(), command: command.to_owned(), cwd: cwd.to_path_buf(), env }, body)
    }

    // statusline.check.js:77-107: 13 assertions ported, 7 skips when Git Bash is missing.
    #[test]
    fn bridge_gates_requests_and_delivers_meters() {
        let seen = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
        let bridge = {
            let seen = seen.clone();
            create_status_bridge(move |id, meters| seen.lock().unwrap().push((id.to_owned(), meters)), |_, _| true).unwrap()
        };
        let dir = TempDir::new();
        let env: Vec<_> = std::env::vars_os().collect();
        let plain = bridge.register("a", &dir.0, &env, None);
        let mut keys: Vec<_> = plain["statusLine"].as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, vec!["command", "type"]);
        let command = plain["statusLine"]["command"].as_str().unwrap();
        let url = command.split(' ').last().unwrap();
        assert_eq!(request(&url.replace(plain["token"].as_str().unwrap(), "nope"), "POST", Some("{}")).0, 404);
        assert_eq!(request(url, "GET", None).0, 404);
        assert_eq!(request(url, "POST", Some("not json")).0, 400);
        assert_eq!(seen.lock().unwrap().len(), 0);

        let bash = Path::new("C:/Program Files/Git/bin/bash.exe");
        if bash.exists() {
            let full = serde_json::from_str::<Value>(FULL).unwrap();
            let body = serde_json::to_string(&full).unwrap();
            assert_eq!(run_shell(bash, &["-c"], command, &dir.0, &body), "");
            assert_eq!(seen.lock().unwrap().len(), 1);
            assert_eq!(seen.lock().unwrap()[0], ("a".to_owned(), read_meters(&full)));
            let _ = run_shell(Path::new("powershell.exe"), &["-NoProfile", "-Command"], command, &dir.0, &body);
            assert_eq!(seen.lock().unwrap().len(), 2);

            let chained = bridge.register("b", &dir.0, &env, Some(&json!({ "type": "command", "command": "read -r line; echo \"USER:${#line}\"", "padding": 3 })));
            assert_eq!(chained["statusLine"]["padding"], 3);
            let command = chained["statusLine"]["command"].as_str().unwrap();
            assert_eq!(run_shell(bash, &["-c"], command, &dir.0, &body).trim(), format!("USER:{}", body.len()));

            bridge.release(chained["token"].as_str().unwrap());
            assert_eq!(request(command.split(' ').last().unwrap(), "POST", Some("{}")).0, 404);
        } else {
            // Skipped statusline.check.js:93: Git Bash is not installed at C:/Program Files/Git/bin/bash.exe.
            // Skipped statusline.check.js:94-97: the delivery checks run through Git Bash.
            // Skipped statusline.check.js:100-105: the chained command runs through Git Bash.
        }
    }
}